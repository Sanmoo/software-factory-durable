import type { GitHubTicketRef, JiraTicketRef, TicketRef } from '../../issue-tracker/index.js';
import type {
  AccessDependencies,
  ConfiguredRepository,
  JiraOriginTracker,
  SourceTriage,
  TicketSource,
  TriageCandidateView,
  TriageRequest,
  TriageSourcePollView,
  TriageSourceRef,
} from '../types.js';
import { ticketKey } from '../rules/admission.js';
import {
  evaluateTriage,
  isTerminalTriageState,
  triageHoldNextStep,
  type TriageDecision,
  type TriageEvaluationInput,
  type TriageLabelEvent,
  type TriageRoles,
} from '../rules/triage.js';
import { indexedWork } from './admission.js';
import type { Session } from './store.js';
import { liveTriageRequests, requestTriage, ticketTriageRequests, transitionTriageRequest } from './triage-requests.js';

// Spec #68 §4-§5 (ticket #71): discovery of Triage requests. In a source with Triage on, each round lists the Tickets carrying
// `needs-triage`, re-reads each of them (and each Ticket of a live request) by ID and applies the pure rule: create a request in `queued`,
// suspend it on a label conflict, return it to the queue, or end it `abandoned`. It only reads the tracker: no comment, label or Work.

type GitHubSource = Extract<TicketSource, { tracker: 'github' }>;
type JiraSource = Extract<TicketSource, { tracker: 'jira' }>;
type Unread = { kind: 'unavailable'; observedAt: string; code: string; nextStep: string };
type Facts<T extends TicketRef> = { kind: 'observed'; observedAt: string; ticket: T; open: boolean; inSource: boolean; labels: string[] } | Unread;
type History = { kind: 'observed'; events: TriageLabelEvent[] } | { kind: 'unavailable'; code: string };
/** One source with Triage as discovery reads it: the origin-specific reads behind the same round. */
type Origin<T extends TicketRef> = {
  ref: TriageSourceRef;
  triage: SourceTriage;
  roles: TriageRoles;
  caseSensitive: boolean;
  /** `discover: false` stops NEW requests of the source; its live requests keep being tracked. */
  discover: boolean;
  list(): Promise<{ kind: 'observed'; observedAt: string; candidates: T[] } | Unread>;
  read(ticket: T): Promise<Facts<T>>;
  history(ticket: T): Promise<History>;
};

const triageSourceKey = (source: TriageSourceRef) =>
  source.tracker === 'jira' ? `jira:${encodeURIComponent(source.siteId)}:${encodeURIComponent(source.projectId)}` : `github:${source.repository.toLowerCase()}`;
const refOf = (source: TicketSource): TriageSourceRef =>
  source.tracker === 'jira' ? { tracker: 'jira', siteId: source.siteId, projectId: source.projectId } : { tracker: 'github', repository: source.repository };
const unread = (code: string, nextStep: string): Unread => ({ kind: 'unavailable', observedAt: new Date().toISOString(), code, nextStep });
/** Unexpected adapter exceptions are explicit failures of that observation, never an empty result. */
const guarded = <T>(read: () => Promise<T>): Promise<T | Unread> =>
  read().catch(() => unread('POLLING_QUERY_FAILED', 'Unexpected failure while observing the Ticket source; nothing is concluded from it.'));
const historyOf = (observation: { kind: 'observed'; events: TriageLabelEvent[] } | { kind: 'unavailable'; code: string } | undefined): History => {
  if (!observation) return { kind: 'unavailable', code: 'LABEL_HISTORY_NOT_COMPOSED' };
  if (observation.kind === 'unavailable') return { kind: 'unavailable', code: observation.code };
  return { kind: 'observed', events: observation.events.map(({ eventId, action, label }) => ({ eventId, action, label })) };
};

function githubOrigin(access: AccessDependencies, source: GitHubSource, triage: SourceTriage, scope: ConfiguredRepository): Origin<GitHubTicketRef> {
  const { tracker } = access;
  const same = (a: GitHubTicketRef, b: GitHubTicketRef) => a.repositoryId === b.repositoryId && a.issueId === b.issueId && a.number === b.number;
  return {
    ref: refOf(source),
    triage,
    roles: { ...triage, admission: scope.label },
    caseSensitive: false,
    discover: source.discover,
    list: () => guarded(() => tracker.listCandidates({ ...scope, label: triage.needsTriage })),
    async read(ticket) {
      const facts = await guarded(() => tracker.readTicket(ticket));
      if (facts.kind !== 'observed') return unread(facts.code, facts.nextStep);
      if (!same(facts.ticket, ticket)) return unread('TICKET_IDENTITY_MISMATCH', 'The re-read issue does not carry the listed identity; nothing is concluded.');
      return {
        kind: 'observed',
        observedAt: facts.observedAt,
        ticket: facts.ticket,
        open: facts.state === 'open' && !facts.pullRequest,
        inSource: true,
        labels: facts.labels.map(label => label.name),
      };
    },
    history: async ticket => historyOf(await guarded(async () => tracker.readLabelHistory?.(ticket))),
  };
}

function jiraOrigin(tracker: JiraOriginTracker, source: JiraSource, triage: SourceTriage): Origin<JiraTicketRef> {
  return {
    ref: refOf(source),
    triage,
    roles: { ...triage, admission: source.label },
    caseSensitive: true,
    discover: source.discover,
    list: () =>
      guarded(() =>
        tracker.listCandidates({ tracker: 'jira', siteId: source.siteId, url: source.url, projectId: source.projectId, label: triage.needsTriage }),
      ),
    async read(ticket) {
      const facts = await guarded(() => tracker.readTicket(ticket));
      if (facts.kind !== 'observed') return unread(facts.code, facts.nextStep);
      return {
        kind: 'observed',
        observedAt: facts.observedAt,
        ticket: facts.ticket,
        open: facts.statusCategory !== 'done',
        inSource: facts.projectId === source.projectId,
        labels: facts.labels,
      };
    },
    history: async ticket => historyOf(await guarded(async () => tracker.readLabelHistory?.(ticket))),
  };
}

const latestOf = (request: TriageRequest | undefined): TriageEvaluationInput['latest'] =>
  request ? { state: request.state, endCode: request.end?.code ?? null, application: request.authorization.application } : null;
const stateView = (request: TriageRequest): 'queued' | 'suspended' | 'abandoned' | 'tracked' =>
  request.state === 'queued' || request.state === 'suspended' || request.state === 'abandoned' ? request.state : 'tracked';

/** An unread Ticket concludes nothing: a live request is kept as it is, and no request is created. */
function unreadView(ticket: TicketRef, facts: Unread, latest: TriageRequest | undefined): TriageCandidateView {
  if (latest && !isTerminalTriageState(latest.state))
    return { ticket, observedAt: facts.observedAt, outcome: stateView(latest), triage_request_id: latest.triage_request_id };
  return {
    ticket,
    observedAt: facts.observedAt,
    outcome: 'held',
    holds: [
      {
        code: 'TRIAGE_TICKET_READ_UNAVAILABLE',
        observedCode: facts.code,
        nextStep: `The Ticket could not be re-read; nothing is concluded. ${facts.nextStep}`,
      },
    ],
  };
}

export function createTriageDiscovery(deps: { session: Session; access: AccessDependencies }) {
  const { session, access } = deps;
  const configured = (access.sources ?? []).filter(source => source.triage !== undefined);
  const views = new Map<string, TriageSourcePollView>(
    configured.map(source => [
      triageSourceKey(refOf(source)),
      {
        source: refOf(source),
        needsTriage: source.triage!.needsTriage,
        state: source.triage!.available ? ('pending' as const) : ('not-available' as const),
        observedAt: null,
        ...(source.triage!.available
          ? {}
          : {
              code: 'TRIAGE_PREREQUISITES_MISSING',
              nextStep:
                'The Host lacks a Triage prerequisite (see `doctor`): no request is created or investigated and none is abandoned; needs-triage still suspends admission.',
            }),
        candidates: null,
      },
    ]),
  );

  async function decide<T extends TicketRef>(origin: Origin<T>, facts: Extract<Facts<T>, { kind: 'observed' }>, latest: TriageRequest | undefined) {
    const input: TriageEvaluationInput = {
      roles: origin.roles,
      caseSensitive: origin.caseSensitive,
      facts: { open: facts.open, inSource: facts.inSource, labels: facts.labels, hasWork: (await indexedWork(session, facts.ticket)) !== undefined },
      latest: latestOf(latest),
      history: { kind: 'not-read' },
    };
    const first = evaluateTriage(input);
    // The origin's history is read only when a request could be created (never for a Ticket that cannot be triaged anyway).
    return first.action === 'read-history' ? evaluateTriage({ ...input, history: await origin.history(facts.ticket) }) : first;
  }

  /** A new request for the Ticket; discovery off, a concurrent creation or a Work found by the commit create none. */
  async function create<T extends TicketRef>(
    origin: Origin<T>,
    facts: Extract<Facts<T>, { kind: 'observed' }>,
    latest: TriageRequest | undefined,
    decision: Extract<TriageDecision, { action: 'create' }>,
  ): Promise<TriageCandidateView> {
    const base = { ticket: facts.ticket, observedAt: facts.observedAt };
    if (!origin.discover)
      return {
        ...base,
        outcome: 'held',
        holds: [{ code: 'SOURCE_DISCOVERY_DISABLED', nextStep: 'Discovery is off for this source: no new Triage request is created.' }],
      };
    const result = await requestTriage(session, {
      ticket: facts.ticket,
      source: origin.ref,
      after: latest?.triage_request_id ?? null,
      authorization: { label: origin.triage.needsTriage, observedAt: facts.observedAt, application: decision.application },
    });
    if (result.kind === 'work-exists')
      return { ...base, outcome: 'held', holds: [{ code: 'TRIAGE_WORK_EXISTS', nextStep: triageHoldNextStep.TRIAGE_WORK_EXISTS }] };
    return {
      ...base,
      outcome: result.kind === 'requested' ? 'requested' : stateView(result.request),
      triage_request_id: result.request.triage_request_id,
    };
  }

  /** A waiting request follows its Ticket: `suspended` on a conflict, back to `queued`, or `abandoned`. Revalidated in the commit. */
  async function move(
    base: { ticket: TicketRef; observedAt: string },
    request: TriageRequest,
    decision: Extract<TriageDecision, { action: 'suspend' | 'requeue' | 'abandon' }>,
  ): Promise<TriageCandidateView> {
    const change =
      decision.action === 'suspend'
        ? { to: 'suspended' as const, event: 'suspended', code: 'TRIAGE_LABEL_CONFLICT', labels: decision.labels }
        : decision.action === 'requeue'
          ? // Ticket #77: a request suspended at its publication keeps its recorded Verdict; it resumes publishing and calls no model.
            request.verdict
            ? { to: 'publishing' as const, event: 'publication-resumed' }
            : { to: 'queued' as const, event: 'requeued' }
          : { to: 'abandoned' as const, event: 'abandoned', code: decision.code };
    const result = await transitionTriageRequest(session, request.triage_request_id, { from: [request.state], ...change });
    const now = result.kind === 'applied' ? result.request : request;
    return {
      ...base,
      outcome: stateView(now),
      triage_request_id: request.triage_request_id,
      ...(change.code ? { code: change.code } : {}),
      ...(decision.action === 'suspend' ? { labels: decision.labels } : {}),
    };
  }

  /** One Ticket of the round: a fresh read by ID, the rule, and its single durable effect. `null`: nothing to show for it. */
  async function evaluate<T extends TicketRef>(origin: Origin<T>, ticket: T): Promise<TriageCandidateView | null> {
    const latest = (await ticketTriageRequests(session, ticket)).at(-1);
    const facts = await origin.read(ticket);
    if (facts.kind !== 'observed') return unreadView(ticket, facts, latest);
    const base = { ticket: facts.ticket, observedAt: facts.observedAt };
    const decision = await decide(origin, facts, latest);
    switch (decision.action) {
      case 'none':
      case 'read-history':
        return null;
      case 'keep':
        return { ...base, outcome: stateView(latest!), triage_request_id: latest!.triage_request_id, ...suspensionOf(latest!) };
      case 'hold':
        return {
          ...base,
          outcome: 'held',
          holds: [
            {
              code: decision.code,
              nextStep: triageHoldNextStep[decision.code],
              ...(decision.labels ? { labels: decision.labels } : {}),
              ...(decision.observedCode ? { observedCode: decision.observedCode } : {}),
            },
          ],
        };
      case 'create':
        return create(origin, facts, latest, decision);
      default:
        return move(base, latest!, decision);
    }
  }
  const suspensionOf = (request: TriageRequest) => (request.suspension ? { code: request.suspension.code, labels: request.suspension.labels } : {});

  /** One round of one source: the Tickets listed with `needs-triage` plus the Tickets of its live requests, each evaluated once. */
  async function round<T extends TicketRef>(origin: Origin<T>): Promise<void> {
    const key = triageSourceKey(origin.ref);
    const base = { source: origin.ref, needsTriage: origin.triage.needsTriage };
    if (!origin.triage.available) return;
    const listing = await origin.list();
    if (listing.kind !== 'observed') {
      views.set(key, {
        ...base,
        state: 'unavailable',
        observedAt: listing.observedAt,
        code: listing.code,
        nextStep: `Listing unavailable; absence of Tickets or labels is not concluded and no request is moved. ${listing.nextStep}`,
        candidates: null,
      });
      return;
    }
    const tickets = new Map<string, T>(listing.candidates.map(ticket => [ticketKey(ticket), ticket]));
    for (const request of await liveTriageRequests(session))
      if (triageSourceKey(request.source) === key && !tickets.has(ticketKey(request.ticket))) tickets.set(ticketKey(request.ticket), request.ticket as T);
    const candidates: TriageCandidateView[] = [];
    for (const ticket of tickets.values()) {
      const view = await evaluate(origin, ticket);
      if (view) candidates.push(view);
    }
    views.set(key, { ...base, state: 'observed', observedAt: listing.observedAt, candidates });
  }

  const githubSource = (repository: string) =>
    configured.find((source): source is GitHubSource => source.tracker === 'github' && source.repository.toLowerCase() === repository.toLowerCase());

  return {
    views: (): TriageSourcePollView[] => [...views.values()],
    /** The `triage` block of the GitHub source of a repository, available or not (`needs-triage` suspends admission in both cases). */
    githubTriage: (repository: string): SourceTriage | undefined => githubSource(repository)?.triage,
    /**
     * Spec #68 §2: a source that lost its `triage` block no longer authorizes its requests; every live one ends `abandoned`, whatever its
     * state, and nothing of it is published. A block that is configured but not available on this Host abandons nothing.
     */
    async sweep(): Promise<void> {
      const authorized = new Set(configured.map(source => triageSourceKey(refOf(source))));
      for (const request of await liveTriageRequests(session))
        if (!authorized.has(triageSourceKey(request.source)))
          await transitionTriageRequest(session, request.triage_request_id, {
            from: [request.state],
            to: 'abandoned',
            event: 'abandoned',
            code: 'TRIAGE_SOURCE_REMOVED',
          });
    },
    async github(scope: ConfiguredRepository): Promise<void> {
      const source = githubSource(scope.repository);
      if (source?.triage) await round(githubOrigin(access, source, source.triage, scope));
    },
    async jira(source: JiraSource): Promise<void> {
      const tracker = access.trackers?.jira;
      if (source.triage && tracker) await round(jiraOrigin(tracker, source, source.triage));
    },
  };
}
export type TriageDiscovery = ReturnType<typeof createTriageDiscovery>;
