// Spec #68 §10 (ticket #80): what the operator sees of the Triage requests, as pure views over the durable records. Metadata only:
// nothing here reads the Ticket, a session file or the Verdict text, so no view built here can carry them. The clock, the limits and
// the observations are arguments.
import type {
  CostEstimate,
  TokenUsage,
  TriageAttempt,
  TriageAttemptUsage,
  TriageAttemptView,
  TriageAuthorshipImpediment,
  TriageCapacityView,
  TriageCleanupItem,
  TriageCleanupPlan,
  TriageDetailsView,
  TriageDetailView,
  TriageHeldView,
  TriageRequest,
  TriageSourcePollView,
  TriageStatusView,
  TriageSummaryView,
  UsageAggregate,
  UsageObservation,
} from '../types.js';
import { ticketLabel } from './admission.js';
import { combineAggregates } from './inspection.js';
import {
  holdsTriageCapacity,
  isTerminalTriageState,
  triageImpediments,
  triageRequestStates,
  type TriageBudget,
  type TriageImpediment,
  type TriageRequestState,
} from './triage.js';

export type TriageOpenImpediment = TriageImpediment | TriageAuthorshipImpediment;
/** How the recorded instants (ISO 8601) are read and written; the caller's calendar, never an ambient one. */
export type TriageCalendar = { ms(instant: string): number; instant(ms: number): string };
/** What the views need beside the records: the limits of this Control (null: none composed), the instant and the queue order. */
export type TriageViewFacts = { budget: TriageBudget | null; now: number; retentionDays: number; queue: readonly string[]; calendar: TriageCalendar };

const dayMs = 86_400_000;
const attemptsOf = (request: TriageRequest) => request.attempts ?? [];

/** The ambiguous-authorship Impediment of a request, open only while it is still `publishing` (ticket #77). */
const authorshipImpediments = (request: TriageRequest): TriageAuthorshipImpediment[] =>
  request.state === 'publishing' && request.publication?.impediment
    ? [{ ...request.publication.impediment, scope: 'triage-request', triage_request_id: request.triage_request_id }]
    : [];
/**
 * The open Impediments of one request: retained capacity (whatever its state) and ambiguous authorship of a publication effect. These
 * are the only two; a `failed` request is terminal and never one.
 */
export const triageRequestImpediments = (request: TriageRequest): TriageOpenImpediment[] => [...triageImpediments(request), ...authorshipImpediments(request)];

/** The Triage capacity in use: attempts still open, and ended attempts whose stop is not confirmed. Neither is a Slot. */
export function triageCapacity(requests: readonly TriageRequest[], configured: number | null): TriageCapacityView {
  const holding = requests.flatMap(attemptsOf).filter(holdsTriageCapacity);
  return { configured, investigating: holding.filter(attempt => !attempt.end).length, retained: holding.filter(attempt => attempt.end).length };
}
export function triageStateCounts(requests: readonly TriageRequest[]): Record<TriageRequestState, number> {
  const counts = Object.fromEntries(triageRequestStates.map(state => [state, 0])) as Record<TriageRequestState, number>;
  for (const request of requests) counts[request.state]++;
  return counts;
}

/** Investigation time the request spent: its ended attempts as recorded, the open one up to `now`. Waiting in the queue costs nothing. */
const attemptMs = (attempt: TriageAttempt, facts: TriageViewFacts) =>
  attempt.end ? (attempt.end.spentMs ?? 0) : facts.now - facts.calendar.ms(attempt.startedAt);
const spentMs = (request: TriageRequest, facts: TriageViewFacts) =>
  attemptsOf(request).reduce((sum, attempt) => sum + Math.max(0, attemptMs(attempt, facts)), 0);
function capacityOf(request: TriageRequest): TriageSummaryView['capacity'] {
  const holding = attemptsOf(request).filter(holdsTriageCapacity);
  if (holding.some(attempt => !attempt.end)) return 'investigating';
  return holding.length ? 'retained' : 'none';
}
/** A published Verdict is a link to its comment; one not (or never) published is only "recorded". Its text is in neither. */
function verdictOf(request: TriageRequest): TriageSummaryView['verdict'] {
  if (!request.verdict) return { state: 'none', link: null };
  const comment = request.intended?.find(effect => effect.kind === 'comment' && effect.status === 'confirmed');
  return comment ? { state: 'published', link: comment.reference ?? null } : { state: 'recorded', link: null };
}

const reapply = (request: TriageRequest) => `To request another Triage, remove and reapply ${request.authorization.label} on the Ticket.`;
function queuedStep(request: TriageRequest, facts: TriageViewFacts) {
  const position = facts.queue.indexOf(request.triage_request_id) + 1;
  const used = attemptsOf(request).length;
  const again = used ? ` Its next attempt is a new session (${used} attempt(s) spent, the balance is kept).` : '';
  return `In the single queue${position ? ` (position ${position})` : ''}; it starts when a unit of Triage capacity is free.${again} Nothing to do.`;
}
function publishingStep(request: TriageRequest) {
  const hold = request.publication?.hold;
  const last = hold ? ` The latest pass could not go on (${hold.code}); it is retried at every poll.` : '';
  return `The Verdict is recorded; the Factory writes it on the Ticket and confirms each effect by reading it back.${last} Nothing to do.`;
}
const stateSteps: Record<TriageRequestState, (request: TriageRequest, facts: TriageViewFacts) => string> = {
  queued: queuedStep,
  investigating: () => 'A Triager is investigating; the attempt ends with a recorded Verdict or by its budget. Nothing to do.',
  suspended: request =>
    `needs-triage sits beside another state label (${request.suspension?.labels.join(', ') ?? 'unknown'}): a person must leave a single state label on the Ticket. ` +
    'Removing only the conflicting label returns this request to the queue with its balance; nothing is written to the Ticket meanwhile.',
  publishing: publishingStep,
  concluded: () => 'The Verdict is published on the Ticket. Nothing to do.',
  abandoned: request => `Ended without applying an outcome (${request.end?.code ?? 'ABANDONED'}). ${reapply(request)}`,
  failed: request =>
    `Ended without a Verdict (${request.end?.code ?? 'FAILED'}); nothing was written to the Ticket and this is not an Impediment. ${reapply(request)}`,
};

/** One request as the lists show it. */
/** Attempts and investigation time, used and left; what is left is unknown (null) to a Control without Triage limits. */
function balanceOf(request: TriageRequest, facts: TriageViewFacts): Pick<TriageSummaryView, 'attempts' | 'investigation'> {
  const used = attemptsOf(request).length;
  const spent = spentMs(request, facts);
  if (!facts.budget) return { attempts: { used, total: null }, investigation: { spentMs: spent, remainingMs: null } };
  return {
    attempts: { used, total: facts.budget.attempts },
    investigation: { spentMs: spent, remainingMs: Math.max(0, facts.budget.investigationMs - spent) },
  };
}
const endOf = (request: TriageRequest): Pick<TriageSummaryView, 'endCode' | 'endedAt'> =>
  request.end ? { endCode: request.end.code, endedAt: request.end.at } : { endCode: null, endedAt: null };
export function triageSummary(request: TriageRequest, facts: TriageViewFacts): TriageSummaryView {
  const impediments = triageRequestImpediments(request);
  return {
    triage_request_id: request.triage_request_id,
    ticket: ticketLabel(request.ticket),
    url: request.ticket.url,
    ordinal: request.ordinal,
    state: request.state,
    outcome: request.verdict?.outcome ?? null,
    ...endOf(request),
    requestedAt: request.requestedAt,
    lastEventAt: request.timeline.at(-1)?.at ?? request.requestedAt,
    ...balanceOf(request, facts),
    capacity: capacityOf(request),
    verdict: verdictOf(request),
    impediments: impediments.map(item => item.ref),
    nextStep: impediments[0]?.nextStep ?? stateSteps[request.state](request, facts),
  };
}

/** Calls per MCP server, from the per-tool counts of the session (`mcp__<server>__<tool>`): the use of a Profile is derived, not stored. */
function mcpCalls(toolCalls: Record<string, number> | null | undefined): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const [name, count] of Object.entries(toolCalls ?? {})) {
    const server = /^mcp__(.+?)__/.exec(name)?.[1];
    if (server) calls[server] = (calls[server] ?? 0) + count;
  }
  return calls;
}
function stopOf(end: NonNullable<TriageAttempt['end']>): NonNullable<TriageAttemptView['stop']> {
  const { cessation } = end;
  return {
    confirmed: cessation.cessationConfirmed,
    code: cessation.cessationConfirmed ? cessation.evidence : cessation.code,
    observedAt: end.cessationObservedAt ?? end.at,
  };
}
type AttemptEndView = Pick<TriageAttemptView, 'endedAt' | 'code' | 'spentMs' | 'capacity' | 'stop' | 'toolCalls' | 'transcript'>;
const openAttempt: AttemptEndView = {
  endedAt: null,
  code: null,
  spentMs: null,
  capacity: 'investigating',
  stop: null,
  toolCalls: null,
  transcript: 'not-recorded',
};
/** How an attempt ended; an ended attempt whose stop is not confirmed still holds its unit of Triage capacity. */
function attemptEnd(end: TriageAttempt['end']): AttemptEndView {
  if (!end) return openAttempt;
  return {
    endedAt: end.at,
    code: end.code,
    spentMs: end.spentMs ?? null,
    capacity: end.cessation.cessationConfirmed ? 'released' : 'retained',
    stop: stopOf(end),
    toolCalls: end.toolCalls ?? null,
    transcript: end.transcript ? 'recorded' : 'not-recorded',
  };
}
export function triageAttemptView(attempt: TriageAttempt): TriageAttemptView {
  const ended = attemptEnd(attempt.end);
  return {
    attempt: attempt.attempt,
    ordinal: attempt.ordinal,
    startedAt: attempt.startedAt,
    ...ended,
    release: attempt.release ?? null,
    skillPack: attempt.skillPack ? { id: attempt.skillPack.id, version: attempt.skillPack.version } : null,
    clones: attempt.clones.map(clone => ({ repository: clone.repository, commit: clone.commit, at: clone.at })),
    mcp: { active: attempt.mcpProfiles ?? null, calls: mcpCalls(ended.toolCalls) },
  };
}

/** Why the local details of a request may not be removed now: it is not over, an attempt of it still runs, or an Impediment is open. */
export function triageDetailProtections(request: TriageRequest): string[] {
  const protections: string[] = [];
  if (!isTerminalTriageState(request.state)) protections.push('TRIAGE_REQUEST_NOT_TERMINAL');
  if (attemptsOf(request).some(attempt => !attempt.end)) protections.push('TRIAGE_ATTEMPT_OPEN');
  if (triageRequestImpediments(request).length) protections.push('TRIAGE_IMPEDIMENT_OPEN');
  return protections;
}
function detailsState(request: TriageRequest, protections: string[], due: boolean): TriageDetailsView['state'] {
  const removal = request.details?.removal;
  if (removal?.removedAt) return removal.origin === 'retention' ? 'expired' : 'removed';
  if (removal) return 'removing';
  if (protections.length) return 'protected';
  return due ? 'eligible' : 'retained';
}
/**
 * The local details (session transcripts, Verdict text) of a request: kept for `retentionDays` counted from its terminal state, and
 * protected while it is not terminal or has an open Impediment. Once removed, the metadata and the published link stay.
 */
export function triageDetailsView(request: TriageRequest, facts: Pick<TriageViewFacts, 'now' | 'retentionDays' | 'calendar'>): TriageDetailsView {
  const dueMs = request.end ? facts.calendar.ms(request.end.at) + facts.retentionDays * dayMs : null;
  const protections = triageDetailProtections(request);
  return {
    state: detailsState(request, protections, dueMs !== null && facts.now >= dueMs),
    dueAt: dueMs === null ? null : facts.calendar.instant(dueMs),
    protections,
    removedAt: request.details?.removal?.removedAt ?? null,
    plan: request.details?.plan ?? null,
  };
}

/** The request an operator names: by its id, or by a Ticket reference (`owner/repo#n`, Jira key), which is the Ticket's latest one. */
export function resolveTriageRequest(requests: readonly TriageRequest[], reference: string): TriageRequest | undefined {
  const wanted = reference.toLowerCase();
  return requests.find(request => request.triage_request_id === wanted) ?? requests.findLast(request => ticketLabel(request.ticket).toLowerCase() === wanted);
}

const detailLimitations = [
  'Metadata only: the Ticket text, tool arguments and results and the Verdict text are never part of this view.',
  'The session transcript and the Verdict text are read only by `factory triage transcript <id>`.',
];
function verdictRecordOf(request: TriageRequest): TriageDetailView['request']['verdictRecord'] {
  const { verdict } = request;
  if (!verdict) return null;
  const { outcome, category, component, attempt, recordedAt, textBytes } = verdict;
  return { outcome, category, component, attempt, recordedAt, textBytes };
}
function publicationOf(request: TriageRequest): TriageDetailView['request']['publication'] {
  const { publication } = request;
  return publication ? { mode: publication.mode, startedAt: publication.startedAt, hold: publication.hold } : null;
}
/** The detail of one request with its timeline, its effects and the other requests of the same Ticket (`family`, oldest first). */
export function triageDetail(request: TriageRequest, family: readonly TriageRequest[], facts: TriageViewFacts): TriageDetailView {
  const others = (later: boolean) =>
    family
      .filter(item => item.triage_request_id !== request.triage_request_id && item.ordinal > request.ordinal === later)
      .map(item => triageSummary(item, facts));
  const later = others(true);
  return {
    kind: 'triage',
    request: {
      ...triageSummary(request, facts),
      source: request.source,
      authorization: { label: request.authorization.label, observedAt: request.authorization.observedAt },
      suspension: request.suspension,
      verdictRecord: verdictRecordOf(request),
      effects: (request.intended ?? []).map((effect, index) => ({ ...effect, index })),
      publication: publicationOf(request),
      attemptRecords: attemptsOf(request).map(triageAttemptView),
      timeline: request.timeline,
      details: triageDetailsView(request, facts),
    },
    latest: later.length === 0,
    previous: others(false),
    later,
    impediments: triageRequestImpediments(request),
    limitations: detailLimitations,
  };
}

/** Tickets the latest Triage rounds hold without a live request (state-label conflict and the like): what TR-03 shows in the CLI. */
export function triageHeld(sources: readonly TriageSourcePollView[]): TriageHeldView[] {
  return sources.flatMap(source =>
    (source.candidates ?? []).flatMap(candidate =>
      candidate.outcome === 'held'
        ? [
            {
              ticket: ticketLabel(candidate.ticket),
              observedAt: candidate.observedAt,
              holds: candidate.holds.map(hold => ({ code: hold.code, nextStep: hold.nextStep, ...(hold.labels ? { labels: hold.labels } : {}) })),
            },
          ]
        : [],
    ),
  );
}

/** The Triage section of `status`. */
export function triageStatus(requests: readonly TriageRequest[], configured: number | null, held: number): TriageStatusView {
  const impediments = requests.flatMap(triageRequestImpediments);
  const states = triageStateCounts(requests);
  return {
    capacity: triageCapacity(requests, configured),
    queued: states.queued,
    states,
    intervention: {
      requests: new Set(impediments.map(item => item.triage_request_id)).size,
      impediments: impediments.map(item => ({ ref: item.ref, code: item.code, triage_request_id: item.triage_request_id })),
    },
    held,
    nextStep: impediments.length
      ? '`factory triages` lists each Impediment with its next step; `factory triage <id>` shows one request.'
      : '`factory triages` lists the requests; nothing needs the operator.',
  };
}

const sumTokens = (items: TokenUsage[]): TokenUsage =>
  items.reduce(
    (sum, item) => ({
      input: sum.input + item.input,
      output: sum.output + item.output,
      cacheRead: sum.cacheRead + item.cacheRead,
      cacheWrite: sum.cacheWrite + item.cacheWrite,
      total: sum.total + item.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
/** Tokens of one attempt from its session observation. Not measurable (no session, removed, unreadable) is `unavailable`, never a zero. */
export function triageAttemptUsage(attempt: string, observation: UsageObservation | null): TriageAttemptUsage {
  if (observation?.state !== 'read')
    return { attempt, measurement: 'unavailable', code: observation?.code ?? 'TRIAGE_DETAILS_NOT_COMPOSED', entries: 0, tokens: null, cost: null };
  const costs = observation.entries.map(entry => entry.cost);
  const cost: CostEstimate | null = costs.every(item => item !== null)
    ? { total: Math.round(costs.reduce((sum, item) => sum + item, 0) * 1e9) / 1e9, unit: 'sdk-catalog-estimate', currency: null }
    : null;
  return {
    attempt,
    measurement: observation.malformed > 0 ? 'partial' : 'complete',
    code: observation.malformed > 0 ? 'USAGE_ENTRIES_UNREADABLE' : null,
    entries: observation.entries.length,
    tokens: sumTokens(observation.entries.map(entry => entry.tokens)),
    cost,
  };
}
/** Total of attempts (one request, or every request of a page): only measured attempts are summed. */
export function triageUsageTotal(attempts: readonly TriageAttemptUsage[]): UsageAggregate {
  return combineAggregates(
    attempts.map(item => ({
      measurement: item.measurement,
      activities: 1,
      measured: item.measurement === 'unavailable' ? 0 : 1,
      unavailable: item.measurement === 'unavailable' ? 1 : 0,
      tokens: item.tokens,
      cost: item.cost,
    })),
  );
}

const keptAfterCleanup = ['the request record, its timeline and codes', 'the attempts and their counts', 'the link of the published Verdict'];
/** The plan of losses of an early removal: what is on disk and in the storage now, and what stays whatever is removed. */
export function triageCleanupPlan(input: { planId: string; request_id: string; at: string; items: TriageCleanupItem[]; id: string }): TriageCleanupPlan {
  return {
    planId: input.planId,
    request_id: input.request_id,
    createdAt: input.at,
    state: 'planned',
    items: input.items,
    kept: keptAfterCleanup,
    nextStep: input.items.length
      ? `Nothing was removed. To remove these details for good: factory triage cleanup-confirm ${input.id} ${input.planId}`
      : 'Nothing to remove: no transcript and no Verdict text are kept for this request.',
  };
}
