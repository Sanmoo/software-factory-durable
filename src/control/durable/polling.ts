import { randomUUID } from 'node:crypto';
import type { DependencyGraphObservation, TicketRef } from '../../issue-tracker/index.js';
import type { AccessDependencies, CandidateView, ConfiguredRepository, DependencyEvaluation, PollingClock, PollingView, RepositoryPollView } from '../types.js';
import { evaluateEntry, evaluatePublication, pollDelaySeconds, type Hold, type PublicationFacts } from '../rules/admission.js';
import { evaluateDependencies, type OwnCycleFacts } from '../rules/dependencies.js';
import type { AdmissionEvidence, AdmissionResult } from './admission.js';

const maxTimer = 2 ** 31 - 1;

/** One FRESH native dependency read + evaluation of a Ticket for the given attempt (polling round or dispatch attempt). */
export async function evaluateWorkDependencies(tracker: AccessDependencies['tracker'], ownCycles: (issueIds: number[]) => Promise<Record<number, OwnCycleFacts>>,
  ticket: TicketRef, attemptId: string): Promise<{ evaluation: DependencyEvaluation; graph: DependencyGraphObservation }> {
  let graph: DependencyGraphObservation;
  try { graph = await tracker.readDependencyGraph(ticket); } catch {
    graph = { kind: 'observed', source: 'github-rest', observedAt: new Date().toISOString(), root: ticket, completeness: 'incomplete', principals: [], nodes: [],
      limitations: [], problems: [{ code: 'DEPENDENCY_READ_UNAVAILABLE', issueId: ticket.issueId, repository: ticket.repository, observedCode: 'POLLING_QUERY_FAILED',
        nextStep: 'Unexpected failure while reading native dependencies; nothing is concluded. Inspect controller logs; polling retries with backoff.' }] };
  }
  const own = await ownCycles(graph.nodes.map(node => node.issueId).filter(id => id !== ticket.issueId));
  const result = evaluateDependencies({ graph: { rootIssueId: ticket.issueId, nodes: graph.nodes, problems: graph.problems }, own });
  return { graph, evaluation: { evaluationId: randomUUID(), attemptId, source: 'github-rest', observedAt: graph.observedAt, evaluatedAt: new Date().toISOString(),
    principals: graph.principals, completeness: result.completeness, conclusion: result.conclusion, blockers: result.blockers, cycles: result.cycles,
    shared: result.shared, reasons: result.reasons, limitations: graph.limitations } };
}
export const systemClock: PollingClock = {
  monotonic: () => performance.now(),
  sleep: (ms, signal) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, Math.min(Math.max(ms, 0), maxTimer));
    const stop = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', stop, { once: true });
  }),
};

type Unavailable = { kind: 'unavailable'; observedAt: string; code: string; waitSeconds?: number; nextStep: string };
type RepositoryState = { scope: ConfiguredRepository; dueAt: number; failures: number; view: RepositoryPollView };

/**
 * Single sequential polling loop in the existing owner (no scheduler/broker). Each cycle visits due repositories one at a time, so
 * queries never overlap; the next wait honours service-indicated waits and backoff. Admission itself is the durable commit in admission.ts.
 */
export function createPoller(deps: {
  access: AccessDependencies; intervalSeconds: number; clock: PollingClock;
  paused(): Promise<boolean>; indexed(ticket: TicketRef): Promise<string | undefined>; admit(evidence: AdmissionEvidence): Promise<AdmissionResult>;
  pending(repositoryId: number): Promise<{ work_id: string; ticket: TicketRef }[]>;
  ownCycles(issueIds: number[]): Promise<Record<number, OwnCycleFacts>>;
  record(work_id: string, evaluation: DependencyEvaluation): Promise<unknown>;
  /** Called after every completed polling iteration (same loop; no scheduler). */
  afterCycle?(): Promise<void>;
}) {
  const { tracker, repository } = deps.access;
  const interval = deps.intervalSeconds;
  const repositories: RepositoryState[] = deps.access.repositories.map(scope => ({ scope, dueAt: 0, failures: 0,
    view: { repository: scope.repository, label: scope.label, state: 'pending', observedAt: null, completeness: null, absenceProven: false,
      consecutiveFailures: 0, nextPollInSeconds: null, candidates: null } }));
  let state: PollingView['state'] = repositories.length ? 'starting' : 'disabled';
  let cycles = 0;
  let lastCycleAt: string | null = null;
  // Polling round per repository; only evaluations of the current round may release a dispatch (in memory: a restart makes none current).
  const attempts = new Map<string, string>();
  // Unexpected adapter exceptions are explicit failures of that observation, never empty/green results.
  const guarded = async <T>(repo: string, read: () => Promise<T>): Promise<T | Unavailable> => {
    try { return await read(); } catch {
      return { kind: 'unavailable', observedAt: new Date().toISOString(), code: 'POLLING_QUERY_FAILED',
        nextStep: `Unexpected failure while observing ${repo}; nothing is concluded from it. Inspect controller logs; polling retries with backoff.` };
    }
  };

  // Transient/unexpected failures of per-candidate reads count as a failed cycle for backoff, like a failed listing.
  const transient = new Set(['POLLING_QUERY_FAILED', 'GITHUB_TRANSPORT_UNAVAILABLE', 'GITHUB_QUERY_FAILED', 'GITHUB_READ_FAILED']);
  type Pending = { ref: TicketRef; configured: ConfiguredRepository; ticket: TicketRef; observedAt: string; label: { id: number; name: string } };
  type Outcome = { view: CandidateView; waitSeconds?: number; failed?: boolean };
  const held = (ref: TicketRef, holds: Hold[], observedAt = new Date().toISOString()): CandidateView => ({ ticket: ref, observedAt, outcome: 'held', holds });

  /** Phase 1: index, pause, configured repository and current Ticket facts. Authorized candidates wait for the shared publication read. */
  async function entry(ref: TicketRef): Promise<Outcome | { pending: Pending }> {
    const existing = await deps.indexed(ref);
    if (existing) return { view: { ticket: ref, observedAt: new Date().toISOString(), outcome: 'existing', work_id: existing } };
    if (await deps.paused()) return { view: held(ref, [{ code: 'GLOBAL_PAUSE', nextStep: 'Global pause holds new admissions; tracking continues. Unpause to admit on the next poll.' }]) };
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === ref.repository.toLowerCase());
    if (!configured) {
      const result = evaluateEntry({ configuredLabel: undefined, listed: ref, facts: { kind: 'unavailable', code: 'NOT_READ', nextStep: '' } });
      return { view: held(ref, result.authorized ? [] : result.holds) };
    }
    const facts = await guarded(configured.repository, () => tracker.readTicket(ref));
    const decision = evaluateEntry({ configuredLabel: configured.label, listed: ref, facts });
    if (decision.authorized && facts.kind === 'observed') return { pending: { ref, configured, ticket: facts.ticket, observedAt: facts.observedAt, label: decision.label } };
    return { view: held(ref, decision.authorized ? [] : decision.holds, facts.observedAt),
      ...(facts.kind === 'unavailable' && facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}),
      ...(facts.kind === 'unavailable' && transient.has(facts.code) ? { failed: true } : {}) };
  }

  /** Phase 2: ONE pull request listing per configured repository per cycle, shared by every authorized candidate, then admission. */
  async function publish(pending: Pending[]): Promise<Map<Pending, Outcome>> {
    const outcomes = new Map<Pending, Outcome>();
    const groups = new Map<ConfiguredRepository, Pending[]>();
    for (const item of pending) groups.set(item.configured, [...(groups.get(item.configured) ?? []), item]);
    for (const [configured, items] of groups) {
      const publication = await guarded(configured.repository, () => repository.findPublication({ repo: configured, issueNumbers: items.map(item => item.ref.number), knownBranches: [] }));
      for (const item of items) {
        const issue = publication.kind === 'observed' ? publication.issues[String(item.ref.number)] : undefined;
        const facts: PublicationFacts = publication.kind !== 'observed'
          ? publication
          : !issue ? { kind: 'unavailable', code: 'PUBLICATION_NOT_REPORTED', nextStep: 'The adapter did not report this Ticket; nothing is concluded.' }
          : issue.completeness === 'incomplete' ? { kind: 'unavailable', code: issue.code, nextStep: issue.nextStep, ...(issue.waitSeconds !== undefined ? { waitSeconds: issue.waitSeconds } : {}) }
          : { kind: 'observed', repositoryId: publication.repositoryId, candidates: issue.candidates };
        const decision = evaluatePublication({ facts, ownBranches: [] });
        if (!decision.clear || publication.kind !== 'observed') {
          outcomes.set(item, { view: held(item.ref, decision.clear ? [] : decision.holds, publication.observedAt),
            ...(facts.kind === 'unavailable' && facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}),
            ...(facts.kind === 'unavailable' && transient.has(facts.code) ? { failed: true } : {}) });
          continue;
        }
        const admitted = await deps.admit({ ticket: item.ticket, repository: { repository: configured.repository, repositoryId: item.ticket.repositoryId, base: configured.base },
          observedAt: item.observedAt, label: item.label, publication: { observedAt: publication.observedAt, limitations: publication.limitations } });
        outcomes.set(item, admitted.kind === 'paused'
          ? { view: held(item.ref, [{ code: 'GLOBAL_PAUSE', nextStep: 'Pause committed before admission; unpause to admit on the next poll.' }]) }
          : { view: { ticket: item.ref, observedAt: new Date().toISOString(), outcome: admitted.kind, work_id: admitted.work_id } });
      }
    }
    return outcomes;
  }

  /**
   * Phase 3: fresh native dependency evaluation of every open pending Work of the repository, in FIFO order, recorded durably with the
   * round's attempt id. Tracking continues while paused. A wait window stops the round; the rest stay not current (held).
   */
  async function dependencies(repositoryId: number, attemptId: string): Promise<{ waitSeconds?: number; failed: boolean }> {
    let waitSeconds: number | undefined;
    let failed = false;
    for (const work of await deps.pending(repositoryId)) {
      if (waitSeconds !== undefined) break;
      const { evaluation, graph } = await evaluateWorkDependencies(tracker, deps.ownCycles, work.ticket, attemptId);
      await deps.record(work.work_id, evaluation);
      for (const problem of graph.problems) {
        if (problem.waitSeconds !== undefined) waitSeconds = Math.max(waitSeconds ?? 0, problem.waitSeconds);
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
      delay = pollDelaySeconds({ intervalSeconds: interval, outcome: 'unavailable', consecutiveFailures: entry_.failures, ...(listing.waitSeconds !== undefined ? { waitSeconds: listing.waitSeconds } : {}) });
      entry_.view = { repository: entry_.scope.repository, label: entry_.scope.label, state: 'unavailable', observedAt: listing.observedAt, completeness: 'incomplete',
        absenceProven: false, code: listing.code, ...(listing.waitSeconds !== undefined ? { waitSeconds: listing.waitSeconds } : {}),
        nextStep: `Listing unavailable; absence of Tickets, labels or pull requests is not concluded. ${listing.nextStep}`,
        consecutiveFailures: entry_.failures, nextPollInSeconds: delay, candidates: null };
    } else {
      const slots: (Outcome | { pending: Pending } | { notEvaluated: TicketRef })[] = [];
      let waitSeconds: number | undefined;
      const wait = (outcome: Outcome) => { if (outcome.waitSeconds !== undefined) waitSeconds = Math.max(waitSeconds ?? 0, outcome.waitSeconds); };
      for (const ref of listing.candidates) {
        if (waitSeconds !== undefined) { slots.push({ notEvaluated: ref }); continue; }
        const result = await entry(ref);
        if ('view' in result) wait(result);
        slots.push(result);
      }
      const pending = slots.flatMap(slot => 'pending' in slot ? [slot.pending] : []);
      const published = pending.length && waitSeconds === undefined ? await publish(pending) : new Map<Pending, Outcome>();
      for (const outcome of published.values()) wait(outcome);
      const outcomes: Outcome[] = slots.map(slot => 'notEvaluated' in slot
        ? { view: { ticket: slot.notEvaluated, observedAt: new Date().toISOString(), outcome: 'not-evaluated', reason: 'GitHub wait window open; evaluated on a later poll.' } }
        : 'pending' in slot ? published.get(slot.pending) ?? { view: { ticket: slot.pending.ref, observedAt: new Date().toISOString(), outcome: 'not-evaluated', reason: 'GitHub wait window open; evaluated on a later poll.' } }
        : slot);
      let failed = outcomes.some(outcome => outcome.failed);
      if (waitSeconds === undefined) {
        const evaluated = await dependencies(listing.repositoryId, attemptId);
        if (evaluated.waitSeconds !== undefined) waitSeconds = evaluated.waitSeconds;
        failed ||= evaluated.failed;
      }
      entry_.failures = failed ? entry_.failures + 1 : 0;
      delay = pollDelaySeconds({ intervalSeconds: interval, outcome: failed ? 'unavailable' : 'observed', consecutiveFailures: entry_.failures, ...(waitSeconds !== undefined ? { waitSeconds } : {}) });
      entry_.view = { repository: entry_.scope.repository, label: entry_.scope.label, state: 'observed', observedAt: listing.observedAt, completeness: 'complete',
        absenceProven: false, ...(waitSeconds !== undefined ? { code: 'GITHUB_WAIT_WINDOW', waitSeconds } : failed ? { code: 'CANDIDATE_EVALUATION_FAILED' } : {}),
        consecutiveFailures: entry_.failures, nextPollInSeconds: delay, candidates: outcomes.map(outcome => outcome.view) };
    }
    entry_.dueAt = deps.clock.monotonic() + delay * 1000;
  }

  return {
    /** Current polling round of a configured repository; null before its first round in this owner run. */
    currentAttempt(repository: string): string | null { return attempts.get(repository.toLowerCase()) ?? null; },
    view(): PollingView {
      const now = deps.clock.monotonic();
      return { state, intervalSeconds: interval, cycles, lastCycleAt, source: 'in-memory-observation',
        repositories: repositories.map(entry => ({ ...entry.view, nextPollInSeconds: entry.view.state === 'pending' ? null : Math.max(0, Math.ceil((entry.dueAt - now) / 1000)) })) };
    },
    /** Resolves when signalled; rejects only for durable-authority failures (never for remote observation failures). */
    async run(signal: AbortSignal): Promise<void> {
      if (!repositories.length) {
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
        return;
      }
      try {
        while (!signal.aborted) {
          state = 'polling';
          for (const entry of repositories) {
            if (signal.aborted) break;
            if (entry.dueAt <= deps.clock.monotonic()) await cycle(entry);
          }
          cycles++;
          lastCycleAt = new Date().toISOString();
          if (!signal.aborted && deps.afterCycle) await deps.afterCycle();
          if (signal.aborted) break;
          state = 'sleeping';
          await deps.clock.sleep(Math.max(0, Math.min(...repositories.map(entry => entry.dueAt)) - deps.clock.monotonic()), signal);
        }
      } finally { state = 'stopped'; }
    },
  };
}
