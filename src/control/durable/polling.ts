import { randomUUID } from 'node:crypto';
import type { DependencyGraphObservation, GitHubTicketRef, JiraLinkTypesObservation, JiraTicketRef, TicketRef } from '../../issue-tracker/index.js';
import type { EnvironmentDeclarationObservation } from '../../contracts/index.js';
import type { WorkEnvironment } from '../types.js';
import type {
  AccessDependencies,
  CandidateView,
  ConfiguredRepository,
  DependencyEvaluation,
  JiraSourcePollView,
  PollingClock,
  PollingView,
  RepositoryPollView,
  TicketSource,
} from '../types.js';
import { evaluateEntry, evaluatePublication, pollDelaySeconds, type Hold, type PublicationFacts } from '../rules/admission.js';
import { evaluateDependencies, type OwnCycleFacts } from '../rules/dependencies.js';
import type { AdmissionEvidence, AdmissionResult, WorkRecord } from './admission.js';
import { admittedJiraEvaluation, evaluateJiraTicket, evaluateJiraWork, type JiraCandidateEvaluation } from './jira-evaluation.js';

const maxTimer = 2 ** 31 - 1;

/** One FRESH native dependency read + evaluation of a GitHub Ticket for the given attempt (polling round or dispatch attempt). GitHub only:
 * another origin's blockers are never judged by the native blocked_by graph. */
export async function evaluateWorkDependencies(
  tracker: AccessDependencies['tracker'],
  ownCycles: (issueIds: number[]) => Promise<Record<number, OwnCycleFacts>>,
  ticket: GitHubTicketRef,
  attemptId: string,
): Promise<{ evaluation: DependencyEvaluation; graph: DependencyGraphObservation }> {
  let graph: DependencyGraphObservation;
  try {
    graph = await tracker.readDependencyGraph(ticket);
  } catch {
    graph = {
      kind: 'observed',
      source: 'github-rest',
      observedAt: new Date().toISOString(),
      root: ticket,
      completeness: 'incomplete',
      principals: [],
      nodes: [],
      limitations: [],
      problems: [
        {
          code: 'DEPENDENCY_READ_UNAVAILABLE',
          issueId: ticket.issueId,
          repository: ticket.repository,
          observedCode: 'POLLING_QUERY_FAILED',
          nextStep: 'Unexpected failure while reading native dependencies; nothing is concluded. Inspect controller logs; polling retries with backoff.',
        },
      ],
    };
  }
  const own = await ownCycles(graph.nodes.map(node => node.issueId).filter(id => id !== ticket.issueId));
  const result = evaluateDependencies({ graph: { rootIssueId: ticket.issueId, nodes: graph.nodes, problems: graph.problems }, own });
  return {
    graph,
    evaluation: {
      evaluationId: randomUUID(),
      attemptId,
      source: 'github-rest',
      observedAt: graph.observedAt,
      evaluatedAt: new Date().toISOString(),
      principals: graph.principals,
      completeness: result.completeness,
      conclusion: result.conclusion,
      blockers: result.blockers,
      cycles: result.cycles,
      shared: result.shared,
      reasons: result.reasons,
      limitations: graph.limitations,
    },
  };
}
export const systemClock: PollingClock = {
  monotonic: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>(resolve => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => {
          signal.removeEventListener('abort', stop);
          resolve();
        },
        Math.min(Math.max(ms, 0), maxTimer),
      );
      const stop = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', stop, { once: true });
    }),
};

type Unavailable = { kind: 'unavailable'; observedAt: string; code: string; waitSeconds?: number; nextStep: string };
type RepositoryState = { scope: ConfiguredRepository; dueAt: number; failures: number; view: RepositoryPollView };
type JiraSource = Extract<TicketSource, { tracker: 'jira' }>;
type SourceState = { source: JiraSource; dueAt: number; failures: number; view: JiraSourcePollView };

/**
 * Jira ticket 04: the polling round whose evaluation may release a Work. GitHub: the round of its destination repository (native graph);
 * Jira: the round of its ORIGIN source (site + project recorded at admission), never the GitHub round of the destination.
 */
export function attemptKey(work: Pick<WorkRecord, 'ticket' | 'repository' | 'authorization'>): string {
  if (work.ticket.tracker !== 'jira') return work.repository.repository.toLowerCase();
  return jiraSourceKey({ siteId: work.ticket.siteId, projectId: work.authorization.source === 'jira-rest' ? work.authorization.basis.projectId : '' });
}
const jiraSourceKey = (source: { siteId: string; projectId: string }) => `jira:${encodeURIComponent(source.siteId)}:${encodeURIComponent(source.projectId)}`;
/** Jira failures that count as a failed round for backoff (transient), like GitHub's. */
const jiraTransient = new Set(['POLLING_QUERY_FAILED', 'JIRA_UNAVAILABLE', 'JIRA_TIMEOUT', 'JIRA_TRANSPORT_UNAVAILABLE', 'JIRA_RATE_LIMITED']);

/** The larger of two service-indicated waits; an absent one neither shortens nor opens a wait. */
const widerWait = (current: number | undefined, next: number | undefined) => (next === undefined ? current : Math.max(current ?? 0, next));
/** Whether a Jira evaluation failed on a transient observation (a failed round for backoff). */
const jiraTransientIn = (reasons: readonly { observedCode?: string | undefined }[]) =>
  reasons.some(reason => reason.observedCode && jiraTransient.has(reason.observedCode));
/** What an unread observation contributes to its round: the service-indicated wait and, for a transient code, a failed round (backoff). */
function unavailableSignals(
  facts: { kind: 'observed' } | { kind: 'unavailable'; code: string; waitSeconds?: number | undefined },
  transientCodes: ReadonlySet<string>,
): { waitSeconds?: number; failed?: true } {
  if (facts.kind !== 'unavailable') return {};
  return {
    ...(facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}),
    ...(transientCodes.has(facts.code) ? { failed: true as const } : {}),
  };
}
type JiraTracker = NonNullable<NonNullable<AccessDependencies['trackers']>['jira']>;
type ObservedBlockers = Extract<NonNullable<JiraCandidateEvaluation['blockers']>, { kind: 'observed' }>;

/**
 * Single sequential polling loop in the existing owner (no scheduler/broker). Each cycle visits due repositories one at a time, so
 * queries never overlap; the next wait honours service-indicated waits and backoff. Admission itself is the durable commit in admission.ts.
 */
export function createPoller(deps: {
  access: AccessDependencies;
  intervalSeconds: number;
  clock: PollingClock;
  paused(): Promise<boolean>;
  indexed(ticket: TicketRef): Promise<string | undefined>;
  admit(evidence: AdmissionEvidence): Promise<AdmissionResult>;
  pending(repositoryId: number): Promise<{ work_id: string; ticket: TicketRef; environment?: WorkEnvironment | undefined }[]>;
  /** Jira ticket 04: open pending Works admitted from one Jira source; and the presentation update of a Work whose Card key changed. */
  pendingJira?(source: {
    siteId: string;
    projectId: string;
  }): Promise<{ work_id: string; ticket: TicketRef; repository: { repository: string }; environment?: WorkEnvironment | undefined }[]>;
  presentation?(work_id: string, fresh: JiraTicketRef): Promise<unknown>;
  /** Jira ticket 05: once per Jira source round, after its admissions: the round's evaluated Cards (notices on the Card, reconciliation). */
  noticeImpediments?(source: JiraSource, candidates: JiraCandidateEvaluation[]): Promise<unknown>;
  /** Ticket 44: record a read of the environment declaration on a pending Work not pinned yet. */
  recordEnvironment?(work_id: string, observation: EnvironmentDeclarationObservation): Promise<unknown>;
  ownCycles(issueIds: number[]): Promise<Record<number, OwnCycleFacts>>;
  record(work_id: string, evaluation: DependencyEvaluation): Promise<unknown>;
  /** Called after every completed polling iteration (same loop; no scheduler). */
  afterCycle?(): Promise<void>;
}) {
  const { tracker, repository } = deps.access;
  const interval = deps.intervalSeconds;
  const repositories: RepositoryState[] = deps.access.repositories.map(scope => ({
    scope,
    dueAt: 0,
    failures: 0,
    view: {
      repository: scope.repository,
      label: scope.label,
      state: 'pending',
      observedAt: null,
      completeness: null,
      absenceProven: false,
      consecutiveFailures: 0,
      nextPollInSeconds: null,
      candidates: null,
    },
  }));
  const sources: SourceState[] = (deps.access.sources ?? []).flatMap(source =>
    source.tracker === 'jira'
      ? [
          {
            source,
            dueAt: 0,
            failures: 0,
            view: {
              tracker: 'jira' as const,
              siteId: source.siteId,
              projectId: source.projectId,
              label: source.label,
              discover: source.discover,
              state: 'pending' as const,
              observedAt: null,
              completeness: null,
              absenceProven: false as const,
              consecutiveFailures: 0,
              nextPollInSeconds: null,
              candidates: null,
            },
          },
        ]
      : [],
  );
  // Jira ticket 04: GitHub identity of each executable repository, from its latest complete listing in this owner run (destination of a Jira Work).
  const repositoryIds = new Map<string, number>();
  let state: PollingView['state'] = repositories.length ? 'starting' : 'disabled';
  let cycles = 0;
  let lastCycleAt: string | null = null;
  // Polling round per repository; only evaluations of the current round may release a dispatch (in memory: a restart makes none current).
  const attempts = new Map<string, string>();
  // Unexpected adapter exceptions are explicit failures of that observation, never empty/green results.
  const guarded = async <T>(repo: string, read: () => Promise<T>): Promise<T | Unavailable> => {
    try {
      return await read();
    } catch {
      return {
        kind: 'unavailable',
        observedAt: new Date().toISOString(),
        code: 'POLLING_QUERY_FAILED',
        nextStep: `Unexpected failure while observing ${repo}; nothing is concluded from it. Inspect controller logs; polling retries with backoff.`,
      };
    }
  };

  // Transient/unexpected failures of per-candidate reads count as a failed cycle for backoff, like a failed listing.
  const transient = new Set(['POLLING_QUERY_FAILED', 'GITHUB_TRANSPORT_UNAVAILABLE', 'GITHUB_QUERY_FAILED', 'GITHUB_READ_FAILED']);
  type Pending = { ref: GitHubTicketRef; configured: ConfiguredRepository; ticket: GitHubTicketRef; observedAt: string; label: { id: number; name: string } };
  type Outcome = { view: CandidateView; waitSeconds?: number; failed?: boolean };
  // v1 (no sources): every executable repository discovers. v2: only a GitHub source with `discover: true` admits new Tickets; the round
  // still lists and re-evaluates the repository, so Works already admitted keep being tracked.
  const discovers = (configured: ConfiguredRepository) =>
    !deps.access.sources ||
    deps.access.sources.some(
      source => source.tracker === 'github' && source.discover && source.repository.toLowerCase() === configured.repository.toLowerCase(),
    );
  const held = (ref: TicketRef, holds: Hold[], observedAt = new Date().toISOString()): CandidateView => ({ ticket: ref, observedAt, outcome: 'held', holds });

  /** Phase 1: index, pause, configured repository and current Ticket facts. Authorized candidates wait for the shared publication read. */
  async function entry(ref: GitHubTicketRef): Promise<Outcome | { pending: Pending }> {
    const existing = await deps.indexed(ref);
    if (existing) return { view: { ticket: ref, observedAt: new Date().toISOString(), outcome: 'existing', work_id: existing } };
    if (await deps.paused())
      return {
        view: held(ref, [{ code: 'GLOBAL_PAUSE', nextStep: 'Global pause holds new admissions; tracking continues. Unpause to admit on the next poll.' }]),
      };
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === ref.repository.toLowerCase());
    if (configured && !discovers(configured))
      return {
        view: held(ref, [
          {
            code: 'SOURCE_DISCOVERY_DISABLED',
            nextStep:
              'This repository is not a GitHub Ticket source with discovery on; add `{tracker: github, repository, discover: true}` to ticketSources to admit new Tickets.',
          },
        ]),
      };
    if (!configured) {
      const result = evaluateEntry({ configuredLabel: undefined, listed: ref, facts: { kind: 'unavailable', code: 'NOT_READ', nextStep: '' } });
      return { view: held(ref, result.authorized ? [] : result.holds) };
    }
    const facts = await guarded(configured.repository, () => tracker.readTicket(ref));
    const decision = evaluateEntry({ configuredLabel: configured.label, listed: ref, facts });
    if (decision.authorized && facts.kind === 'observed')
      return { pending: { ref, configured, ticket: facts.ticket, observedAt: facts.observedAt, label: decision.label } };
    return { view: held(ref, decision.authorized ? [] : decision.holds, facts.observedAt), ...unavailableSignals(facts, transient) };
  }

  /**
   * Ticket 44: ONE read of `.factory/environment.yaml` at the base tip per configured repository per round, shared by the Works admitted and
   * re-evaluated in that round. A repository port that cannot read it yields `unavailable` (the Work never starts on a guess).
   */
  const environmentReads = new Map<string, Promise<EnvironmentDeclarationObservation>>();
  const readEnvironment = (configured: ConfiguredRepository, attemptId: string) => {
    const key = `${attemptId}:${configured.repository.toLowerCase()}`;
    let read = environmentReads.get(key);
    if (!read) {
      read = repository.readEnvironmentDeclaration
        ? repository.readEnvironmentDeclaration({ repo: configured, base: configured.base }).catch(() => ({
            kind: 'unavailable' as const,
            observedAt: new Date().toISOString(),
            code: 'POLLING_QUERY_FAILED',
            nextStep: 'Unexpected failure while reading the environment declaration; polling retries.',
          }))
        : Promise.resolve({
            kind: 'unavailable' as const,
            observedAt: new Date().toISOString(),
            code: 'ENVIRONMENT_READ_NOT_COMPOSED',
            nextStep: 'This installation cannot read repository environment declarations; no Work starts without one.',
          });
      for (const old of environmentReads.keys()) if (!old.startsWith(`${attemptId}:`)) environmentReads.delete(old);
      environmentReads.set(key, read);
    }
    return read;
  };

  /** Phase 2: ONE pull request listing per configured repository per cycle, shared by every authorized candidate, then admission. */
  async function publish(pending: Pending[], attemptId: string): Promise<Map<Pending, Outcome>> {
    const outcomes = new Map<Pending, Outcome>();
    const groups = new Map<ConfiguredRepository, Pending[]>();
    for (const item of pending) groups.set(item.configured, [...(groups.get(item.configured) ?? []), item]);
    for (const [configured, items] of groups) {
      const publication = await guarded(configured.repository, () =>
        repository.findPublication({ repo: configured, issueNumbers: items.map(item => item.ref.number), knownBranches: [] }),
      );
      for (const item of items) {
        const issue = publication.kind === 'observed' ? publication.issues[String(item.ref.number)] : undefined;
        const facts: PublicationFacts =
          publication.kind !== 'observed'
            ? publication
            : !issue
              ? { kind: 'unavailable', code: 'PUBLICATION_NOT_REPORTED', nextStep: 'The adapter did not report this Ticket; nothing is concluded.' }
              : issue.completeness === 'incomplete'
                ? {
                    kind: 'unavailable',
                    code: issue.code,
                    nextStep: issue.nextStep,
                    ...(issue.waitSeconds !== undefined ? { waitSeconds: issue.waitSeconds } : {}),
                  }
                : { kind: 'observed', repositoryId: publication.repositoryId, candidates: issue.candidates };
        const decision = evaluatePublication({ facts, ownBranches: [] });
        if (!decision.clear || publication.kind !== 'observed') {
          outcomes.set(item, {
            view: held(item.ref, decision.clear ? [] : decision.holds, publication.observedAt),
            ...(facts.kind === 'unavailable' && facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}),
            ...(facts.kind === 'unavailable' && transient.has(facts.code) ? { failed: true } : {}),
          });
          continue;
        }
        const environment = await readEnvironment(configured, attemptId);
        const admitted = await deps.admit({
          ticket: item.ticket,
          repository: { repository: configured.repository, repositoryId: item.ticket.repositoryId, base: configured.base },
          observedAt: item.observedAt,
          label: item.label,
          publication: { observedAt: publication.observedAt, limitations: publication.limitations },
          environment,
        });
        outcomes.set(
          item,
          admitted.kind === 'paused'
            ? { view: held(item.ref, [{ code: 'GLOBAL_PAUSE', nextStep: 'Pause committed before admission; unpause to admit on the next poll.' }]) }
            : { view: { ticket: item.ref, observedAt: new Date().toISOString(), outcome: admitted.kind, work_id: admitted.work_id } },
        );
      }
    }
    return outcomes;
  }

  /**
   * Ticket 44: a pending Work whose declaration is missing/invalid/unread is re-read each round until it is pinned (then never again).
   * Returns what that read contributes to the round (a service-indicated wait, a transient failure).
   */
  async function refreshEnvironment(
    work: { work_id: string; environment?: WorkEnvironment | undefined },
    configured: ConfiguredRepository | undefined,
    attemptId: string,
  ): Promise<{ waitSeconds: number | undefined; failed: boolean }> {
    if (!configured || !deps.recordEnvironment || !work.environment || work.environment.state === 'pinned') return { waitSeconds: undefined, failed: false };
    const observation = await readEnvironment(configured, attemptId);
    await deps.recordEnvironment(work.work_id, observation);
    if (observation.kind !== 'unavailable') return { waitSeconds: undefined, failed: false };
    return { waitSeconds: observation.waitSeconds, failed: transient.has(observation.code) };
  }

  /**
   * Phase 3: fresh native dependency evaluation of every open pending Work of the repository, in FIFO order, recorded durably with the
   * round's attempt id. Tracking continues while paused. A wait window stops the round; the rest stay not current (held).
   */
  async function dependencies(repositoryId: number, attemptId: string, configured: ConfiguredRepository): Promise<{ waitSeconds?: number; failed: boolean }> {
    let waitSeconds: number | undefined;
    let failed = false;
    for (const work of await deps.pending(repositoryId)) {
      if (waitSeconds !== undefined) break;
      // The GitHub round evaluates only Works whose Ticket ORIGIN is GitHub; a Work of another origin in this destination is never judged here.
      if (work.ticket.tracker !== 'github') continue;
      const ticket = work.ticket;
      const refreshed = await refreshEnvironment(work, configured, attemptId);
      waitSeconds = widerWait(waitSeconds, refreshed.waitSeconds);
      if (refreshed.failed) failed = true;
      const { evaluation, graph } = await evaluateWorkDependencies(tracker, deps.ownCycles, ticket, attemptId);
      await deps.record(work.work_id, evaluation);
      for (const problem of graph.problems) {
        waitSeconds = widerWait(waitSeconds, problem.waitSeconds);
        if (problem.observedCode && transient.has(problem.observedCode)) failed = true;
      }
    }
    return { ...(waitSeconds !== undefined ? { waitSeconds } : {}), failed };
  }

  async function cycle(entry_: RepositoryState) {
    const attemptId = randomUUID();
    attempts.set(entry_.scope.repository.toLowerCase(), attemptId);
    const listing = await guarded(entry_.scope.repository, () => tracker.listCandidates(entry_.scope));
    let delay: number;
    if (listing.kind !== 'observed') {
      entry_.failures++;
      delay = pollDelaySeconds({
        intervalSeconds: interval,
        outcome: 'unavailable',
        consecutiveFailures: entry_.failures,
        ...(listing.waitSeconds !== undefined ? { waitSeconds: listing.waitSeconds } : {}),
      });
      entry_.view = {
        repository: entry_.scope.repository,
        label: entry_.scope.label,
        state: 'unavailable',
        observedAt: listing.observedAt,
        completeness: 'incomplete',
        absenceProven: false,
        code: listing.code,
        ...(listing.waitSeconds !== undefined ? { waitSeconds: listing.waitSeconds } : {}),
        nextStep: `Listing unavailable; absence of Tickets, labels or pull requests is not concluded. ${listing.nextStep}`,
        consecutiveFailures: entry_.failures,
        nextPollInSeconds: delay,
        candidates: null,
      };
    } else {
      const slots: (Outcome | { pending: Pending } | { notEvaluated: TicketRef })[] = [];
      let waitSeconds: number | undefined;
      const wait = (outcome: Outcome) => {
        if (outcome.waitSeconds !== undefined) waitSeconds = Math.max(waitSeconds ?? 0, outcome.waitSeconds);
      };
      for (const ref of listing.candidates) {
        if (waitSeconds !== undefined) {
          slots.push({ notEvaluated: ref });
          continue;
        }
        const result = await entry(ref);
        if ('view' in result) wait(result);
        slots.push(result);
      }
      const pending = slots.flatMap(slot => ('pending' in slot ? [slot.pending] : []));
      const published = pending.length && waitSeconds === undefined ? await publish(pending, attemptId) : new Map<Pending, Outcome>();
      for (const outcome of published.values()) wait(outcome);
      const outcomes: Outcome[] = slots.map(slot =>
        'notEvaluated' in slot
          ? {
              view: {
                ticket: slot.notEvaluated,
                observedAt: new Date().toISOString(),
                outcome: 'not-evaluated',
                reason: 'GitHub wait window open; evaluated on a later poll.',
              },
            }
          : 'pending' in slot
            ? (published.get(slot.pending) ?? {
                view: {
                  ticket: slot.pending.ref,
                  observedAt: new Date().toISOString(),
                  outcome: 'not-evaluated',
                  reason: 'GitHub wait window open; evaluated on a later poll.',
                },
              })
            : slot,
      );
      let failed = outcomes.some(outcome => outcome.failed);
      if (waitSeconds === undefined) {
        const evaluated = await dependencies(listing.repositoryId, attemptId, entry_.scope);
        if (evaluated.waitSeconds !== undefined) waitSeconds = evaluated.waitSeconds;
        failed ||= evaluated.failed;
      }
      entry_.failures = failed ? entry_.failures + 1 : 0;
      delay = pollDelaySeconds({
        intervalSeconds: interval,
        outcome: failed ? 'unavailable' : 'observed',
        consecutiveFailures: entry_.failures,
        ...(waitSeconds !== undefined ? { waitSeconds } : {}),
      });
      repositoryIds.set(entry_.scope.repository.toLowerCase(), listing.repositoryId);
      entry_.view = {
        repository: entry_.scope.repository,
        label: entry_.scope.label,
        state: 'observed',
        observedAt: listing.observedAt,
        completeness: 'complete',
        absenceProven: false,
        ...(waitSeconds !== undefined ? { code: 'GITHUB_WAIT_WINDOW', waitSeconds } : failed ? { code: 'CANDIDATE_EVALUATION_FAILED' } : {}),
        consecutiveFailures: entry_.failures,
        nextPollInSeconds: delay,
        candidates: outcomes.map(outcome => outcome.view),
      };
    }
    entry_.dueAt = deps.clock.monotonic() + delay * 1000;
  }

  const executable = () => deps.access.repositories.map(scope => scope.repository);
  const waitOf = (reasons: readonly { waitSeconds?: number }[]) =>
    reasons.reduce<number | undefined>((max, reason) => (reason.waitSeconds === undefined ? max : Math.max(max ?? 0, reason.waitSeconds)), undefined);
  /** What a Jira evaluation's reasons contribute to the Card's outcome: the longest wait and a transient failure. */
  const jiraSignals = (reasons: readonly { waitSeconds?: number; observedCode?: string | undefined }[]) => {
    const waitSeconds = waitOf(reasons);
    return { ...(waitSeconds !== undefined ? { waitSeconds } : {}), ...(jiraTransientIn(reasons) ? { failed: true } : {}) };
  };

  /**
   * Jira ticket 04, one listed Card: index -> pause -> FRESH re-read by ID with the CURRENT source configuration (label, components ->
   * destination, visible blockers) -> admission of an eligible Card to its single revalidated destination. Refusals create nothing and
   * write nothing to Jira (impediment notices are ticket 05's); index and pause are checked again inside the admission commit.
   */
  async function jiraEntry(
    source: JiraSource,
    ref: JiraTicketRef,
    attemptId: string,
    catalogue: () => Promise<JiraLinkTypesObservation>,
  ): Promise<Outcome & { evaluated?: JiraCandidateEvaluation }> {
    const tracker = deps.access.trackers!.jira!;
    const existing = await deps.indexed(ref);
    if (existing) {
      await deps.presentation?.(existing, ref);
      return { view: { ticket: ref, observedAt: new Date().toISOString(), outcome: 'existing', work_id: existing } };
    }
    if (await deps.paused())
      return {
        view: held(ref, [{ code: 'GLOBAL_PAUSE', nextStep: 'Global pause holds new admissions; tracking continues. Unpause to admit on the next poll.' }]),
      };
    let evaluated;
    try {
      evaluated = await evaluateJiraTicket({ tracker, source, authorizedRepositories: executable(), ticket: ref, catalogue });
    } catch {
      return {
        view: held(ref, [
          {
            code: 'JIRA_TICKET_UNVERIFIABLE',
            observedCode: 'POLLING_QUERY_FAILED',
            nextStep: 'Unexpected failure while re-reading the Card; nothing is concluded. Polling retries with backoff.',
          },
        ]),
        failed: true,
      };
    }
    const { evaluation, ticket, observedAt } = evaluated;
    if (evaluation.decision === 'not-candidate')
      return {
        evaluated,
        view: held(
          ticket,
          [
            {
              code: 'LABEL_NOT_PRESENT',
              nextStep: `The Card no longer carries the entry label "${source.label}" in its project; nothing is admitted and nothing is commented.`,
            },
          ],
          observedAt,
        ),
      };
    if (evaluation.decision !== 'eligible')
      return {
        evaluated,
        view: held(
          ticket,
          evaluation.reasons.map(reason => ({ ...reason })),
          observedAt,
        ),
        ...jiraSignals(evaluation.reasons),
      };
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === evaluation.repository.toLowerCase())!;
    const repositoryId = repositoryIds.get(configured.repository.toLowerCase());
    const blockers = evaluated.blockers;
    if (repositoryId === undefined || blockers?.kind !== 'observed')
      return {
        view: held(
          ticket,
          [
            {
              code: 'DESTINATION_NOT_OBSERVED',
              nextStep: `The GitHub identity of ${configured.repository} was not observed by its polling in this run yet; the Card is admitted on a later poll.`,
            },
          ],
          observedAt,
        ),
      };
    return admitJiraCard(source, evaluated, configured, repositoryId, blockers, attemptId);
  }

  /** Jira ticket 04: admission of an eligible Card to its revalidated destination, with the round's environment read and visible blockers. */
  async function admitJiraCard(
    source: JiraSource,
    evaluated: JiraCandidateEvaluation,
    configured: ConfiguredRepository,
    repositoryId: number,
    blockers: ObservedBlockers,
    attemptId: string,
  ): Promise<Outcome & { evaluated?: JiraCandidateEvaluation }> {
    const { ticket, observedAt } = evaluated;
    const environment = await readEnvironment(configured, attemptId);
    const admitted = await deps.admit({
      ticket,
      repository: { repository: configured.repository, repositoryId, base: configured.base },
      observedAt,
      environment,
      dependencies: admittedJiraEvaluation(blockers, attemptId),
      authorization: {
        source: 'jira-rest',
        basis: {
          sourceConfigured: true,
          siteId: source.siteId,
          projectId: source.projectId,
          label: { name: source.label },
          route: {
            componentIds: source.routes
              .filter(
                route => route.repository.toLowerCase() === configured.repository.toLowerCase() && (evaluated.components ?? []).includes(route.componentId),
              )
              .map(route => route.componentId),
            repository: configured.repository,
          },
          blockers: {
            observedAt: blockers.observedAt,
            coverage: 'visible',
            blockers: structuredClone(blockers.blockers),
            limitations: [...blockers.limitations],
          },
        },
      },
    });
    return admitted.kind === 'paused'
      ? { view: held(ticket, [{ code: 'GLOBAL_PAUSE', nextStep: 'Pause committed before admission; unpause to admit on the next poll.' }]) }
      : // An admitted Card is passed to the notices too: eligible withdraws an unsent impediment notice (ticket 05).
        { evaluated, view: { ticket, observedAt: new Date().toISOString(), outcome: admitted.kind, work_id: admitted.work_id } };
  }

  const notices = (source: JiraSource, candidates: JiraCandidateEvaluation[]) => deps.noticeImpediments?.(source, candidates).catch(() => undefined);

  /** Jira ticket 04: one round of a Jira source (listing + admissions when discovery is on; re-evaluation of its pending Works always). */
  async function jiraCycle(entry_: SourceState) {
    const { source } = entry_;
    const attemptId = randomUUID();
    attempts.set(jiraSourceKey(source), attemptId);
    const base = {
      tracker: 'jira' as const,
      siteId: source.siteId,
      projectId: source.projectId,
      label: source.label,
      discover: source.discover,
      absenceProven: false as const,
    };
    const tracker = deps.access.trackers?.jira;
    const unavailable = (code: string, nextStep: string, observedAt: string, waitSeconds?: number) => {
      entry_.failures++;
      const delay = pollDelaySeconds({
        intervalSeconds: interval,
        outcome: 'unavailable',
        consecutiveFailures: entry_.failures,
        ...(waitSeconds !== undefined ? { waitSeconds } : {}),
      });
      entry_.view = {
        ...base,
        state: 'unavailable',
        observedAt,
        completeness: 'incomplete',
        code,
        ...(waitSeconds !== undefined ? { waitSeconds } : {}),
        nextStep,
        consecutiveFailures: entry_.failures,
        nextPollInSeconds: delay,
        candidates: null,
      };
      entry_.dueAt = deps.clock.monotonic() + delay * 1000;
    };
    if (!tracker) {
      unavailable('JIRA_TRACKER_NOT_COMPOSED', 'This installation has no Jira adapter composed; nothing is read from the source.', new Date().toISOString());
      return;
    }
    let types: Promise<JiraLinkTypesObservation> | undefined;
    const catalogue = () =>
      (types ??= tracker.readLinkTypes(source.siteId).catch(() => ({
        kind: 'unavailable' as const,
        source: 'jira-rest' as const,
        observedAt: new Date().toISOString(),
        siteId: source.siteId,
        completeness: 'incomplete' as const,
        code: 'POLLING_QUERY_FAILED',
        nextStep: 'Unexpected failure while reading the link types.',
      })));
    const discovered = source.discover
      ? await jiraDiscovery(source, tracker, attemptId, catalogue)
      : { kind: 'observed' as const, observedAt: null, candidates: null, evaluatedCards: [], waitSeconds: undefined, failed: false };
    if (discovered.kind !== 'observed') {
      const { listing } = discovered;
      unavailable(
        listing.code,
        `Listing unavailable; absence of Cards or labels is not concluded. ${listing.nextStep}`,
        listing.observedAt,
        listing.waitSeconds,
      );
      // Reconciliation of earlier notices still runs (a safe read); nothing new is evaluated.
      await notices(source, []);
      return;
    }
    // Ticket 05: impediment notices of this round's evaluated Cards, after the admissions (one pass at a time, never overlapping).
    await notices(source, discovered.evaluatedCards);
    const pending = await jiraPending(source, tracker, attemptId, catalogue, discovered.waitSeconds);
    settleJiraRound(entry_, base, {
      ...pending,
      failed: discovered.failed || pending.failed,
      observedAt: discovered.observedAt,
      candidates: discovered.candidates,
    });
  }

  /** Jira ticket 04: the listing of a discovering source and the admission of its Cards, one at a time until Jira asks to wait. */
  async function jiraDiscovery(source: JiraSource, tracker: JiraTracker, attemptId: string, catalogue: () => Promise<JiraLinkTypesObservation>) {
    const listing = await guarded(source.siteId, () =>
      tracker.listCandidates({ tracker: 'jira', siteId: source.siteId, url: source.url, projectId: source.projectId, label: source.label }),
    );
    if (listing.kind !== 'observed') return { kind: 'unavailable' as const, listing };
    let waitSeconds: number | undefined;
    let failed = false;
    const candidates: CandidateView[] = [];
    const evaluatedCards: JiraCandidateEvaluation[] = [];
    for (const ref of listing.candidates) {
      if (waitSeconds !== undefined) {
        candidates.push({
          ticket: ref,
          observedAt: new Date().toISOString(),
          outcome: 'not-evaluated',
          reason: 'Jira asked to wait; evaluated on a later poll.',
        });
        continue;
      }
      const outcome = await jiraEntry(source, ref, attemptId, catalogue);
      if (outcome.evaluated) evaluatedCards.push(outcome.evaluated);
      waitSeconds = widerWait(waitSeconds, outcome.waitSeconds);
      failed ||= Boolean(outcome.failed);
      candidates.push(outcome.view);
    }
    return { kind: 'observed' as const, observedAt: listing.observedAt, candidates, evaluatedCards, waitSeconds, failed };
  }

  /** Pending Works of a Jira source: a FRESH visible-blockers evaluation of this round (tracking continues while paused or with discovery off). */
  async function jiraPending(
    source: JiraSource,
    tracker: JiraTracker,
    attemptId: string,
    catalogue: () => Promise<JiraLinkTypesObservation>,
    waitSeconds: number | undefined,
  ): Promise<{ waitSeconds: number | undefined; failed: boolean }> {
    let failed = false;
    for (const work of (await deps.pendingJira?.(source)) ?? []) {
      if (waitSeconds !== undefined) break;
      if (work.ticket.tracker !== 'jira') continue;
      const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
      const refreshed = await refreshEnvironment(work, configured, attemptId);
      waitSeconds = widerWait(waitSeconds, refreshed.waitSeconds);
      if (refreshed.failed) failed = true;
      const evaluation = await reevaluateJiraWork(source, tracker, work.work_id, work.ticket, attemptId, catalogue);
      waitSeconds = widerWait(waitSeconds, waitOf(evaluation.reasons));
      if (jiraTransientIn(evaluation.reasons)) failed = true;
    }
    return { waitSeconds, failed };
  }

  /** One pending Jira Work: its fresh evaluation, the presentation update of a Card re-read, and the durable record of the evaluation. */
  async function reevaluateJiraWork(
    source: JiraSource,
    tracker: JiraTracker,
    work_id: string,
    ticket: JiraTicketRef,
    attemptId: string,
    catalogue: () => Promise<JiraLinkTypesObservation>,
  ) {
    const { observation, evaluation } = await evaluateJiraWork({ tracker, ticket, attemptId, catalogue, linkTypes: source.linkTypes ?? [] });
    if (observation.kind === 'observed') await deps.presentation?.(work_id, observation.ticket);
    await deps.record(work_id, evaluation);
    return evaluation;
  }

  /** The observed view of a completed Jira source round and its next due time (backoff on a failed round, a service-indicated wait). */
  function settleJiraRound(
    entry_: SourceState,
    base: Pick<JiraSourcePollView, 'tracker' | 'siteId' | 'projectId' | 'label' | 'discover' | 'absenceProven'>,
    round: { waitSeconds: number | undefined; failed: boolean; observedAt: string | null; candidates: CandidateView[] | null },
  ) {
    const { waitSeconds, failed } = round;
    entry_.failures = failed ? entry_.failures + 1 : 0;
    const delay = pollDelaySeconds({
      intervalSeconds: interval,
      outcome: failed ? 'unavailable' : 'observed',
      consecutiveFailures: entry_.failures,
      ...(waitSeconds !== undefined ? { waitSeconds } : {}),
    });
    entry_.view = {
      ...base,
      state: 'observed',
      observedAt: round.observedAt,
      completeness: entry_.source.discover ? 'complete' : null,
      ...(waitSeconds !== undefined ? { code: 'JIRA_WAIT_WINDOW', waitSeconds } : failed ? { code: 'CANDIDATE_EVALUATION_FAILED' } : {}),
      consecutiveFailures: entry_.failures,
      nextPollInSeconds: delay,
      candidates: round.candidates,
    };
    entry_.dueAt = deps.clock.monotonic() + delay * 1000;
  }

  /** One pass over repositories or sources: each due one polls in turn, stopping at a signal. */
  async function pollDue<T extends { dueAt: number }>(entries: T[], signal: AbortSignal, poll: (entry: T) => Promise<void>) {
    for (const entry of entries) {
      if (signal.aborted) break;
      if (entry.dueAt <= deps.clock.monotonic()) await poll(entry);
    }
  }

  return {
    /** Current polling round of a Work's evaluation source (see `attemptKey`); null before its first round in this owner run. */
    currentAttempt(work: Pick<WorkRecord, 'ticket' | 'repository' | 'authorization'>): string | null {
      return attempts.get(attemptKey(work)) ?? null;
    },
    view(): PollingView {
      const now = deps.clock.monotonic();
      const due = (view: { state: string }, dueAt: number) => (view.state === 'pending' ? null : Math.max(0, Math.ceil((dueAt - now) / 1000)));
      return {
        state,
        intervalSeconds: interval,
        cycles,
        lastCycleAt,
        source: 'in-memory-observation',
        repositories: repositories.map(entry => ({ ...entry.view, nextPollInSeconds: due(entry.view, entry.dueAt) })),
        ...(sources.length ? { sources: sources.map(entry => ({ ...entry.view, nextPollInSeconds: due(entry.view, entry.dueAt) })) } : {}),
      };
    },
    /** Resolves when signalled; rejects only for durable-authority failures (never for remote observation failures). */
    async run(signal: AbortSignal): Promise<void> {
      if (!repositories.length) {
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      try {
        while (!signal.aborted) {
          state = 'polling';
          await pollDue(repositories, signal, cycle);
          // Jira sources after the GitHub repositories: a destination's GitHub identity is then observed in this iteration.
          await pollDue(sources, signal, jiraCycle);
          cycles++;
          lastCycleAt = new Date().toISOString();
          if (!signal.aborted && deps.afterCycle) await deps.afterCycle();
          if (signal.aborted) break;
          state = 'sleeping';
          await deps.clock.sleep(
            Math.max(0, Math.min(...repositories.map(entry => entry.dueAt), ...sources.map(entry => entry.dueAt)) - deps.clock.monotonic()),
            signal,
          );
        }
      } finally {
        state = 'stopped';
      }
    },
  };
}
