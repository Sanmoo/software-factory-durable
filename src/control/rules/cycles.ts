// Ticket 25 pure rules (spec §3.3 invariants 1/7/9, §4.1, §11.3, §12.3): withdrawal of authorization, cancellation, PR closed without merge,
// reopen, resume and explicit new cycles. No I/O, clock or storage: callers pass the facts and the instant.
import type { CancellationView, ExecutionView, Impediment, WorkView } from '../types.js';
import type { TicketFacts } from './admission.js';
import { evaluateEntry } from './admission.js';

export const cycleImpediments = {
  /** Label removed or issue closed was observed: no new activation until an explicit `resume` and a confirming read (spec §4.1). */
  withdrawn: 'AUTHORIZATION_WITHDRAWN',
  /** `resume` accepted; the next complete read of the Ticket must confirm the current authorization before anything starts. */
  resumePending: 'AUTHORIZATION_RESUME_PENDING',
  /** A new cycle starts suspended until its first complete authorization read (it was not admitted by polling). */
  notConfirmed: 'AUTHORIZATION_NOT_CONFIRMED',
  cancelled: 'WORK_CANCELLED',
  closedUnmerged: 'PULL_REQUEST_CLOSED_UNMERGED',
  /** The own PR was reopened: continuing still needs `resume` (reopen never grants resume, scope or budget). */
  resumeRequired: 'RESUME_REQUIRED',
} as const;

type Work = Pick<WorkView, 'result' | 'impediments' | 'execution' | 'previousExecutions' | 'cancellation' | 'closure' | 'delivery' | 'publication' | 'authorization'>;
const executions = (work: Pick<Work, 'execution' | 'previousExecutions'>) => [...(work.previousExecutions ?? []), ...(work.execution ? [work.execution] : [])];
/** An Execution that may still act or still holds capacity: reserved/started/held, or ended with its Slot held (cessation not confirmed). */
export const occupying = (execution: ExecutionView) => execution.slot.held || execution.state === 'reserved' || execution.state === 'started';
export const hasImpediment = (work: Pick<Work, 'impediments'>, code: string) => work.impediments.some(item => item.code === code);

/**
 * One complete re-read of the Ticket against its configured label. `withdrawn`: the issue is closed or the label is absent (never inferred
 * from an absence in a listing); `authorized`: open + label; `unknown` (unavailable, identity drift, pull request...): nothing concluded.
 */
export function authorizationFacts(input: { configuredLabel: string | undefined; ticket: Parameters<typeof evaluateEntry>[0]['listed']; facts: TicketFacts }):
  { kind: 'authorized' } | { kind: 'withdrawn'; codes: string[] } | { kind: 'unknown'; code: string } {
  if (input.facts.kind !== 'observed') return { kind: 'unknown', code: input.facts.code };
  if (input.configuredLabel === undefined) return { kind: 'unknown', code: 'REPOSITORY_NOT_CONFIGURED' };
  const decision = evaluateEntry({ configuredLabel: input.configuredLabel, listed: input.ticket, facts: input.facts });
  if (decision.authorized) return { kind: 'authorized' };
  return confirmedWithdrawal(decision.holds.map(hold => hold.code));
}
/**
 * Jira ticket 04: one complete re-read by ID of a Jira Work's Card against its ORIGIN source (site + project recorded at admission, label of
 * the source in force). Label absent in a complete read = withdrawn (`LABEL_NOT_PRESENT`, same rule as GitHub); the Card moved to another
 * project, a source no longer configured or an unavailable read conclude nothing. The destination is never re-routed here.
 */
export function jiraAuthorizationFacts(input: { source: { projectId: string; label: string } | undefined;
  observation: { kind: 'observed'; projectId: string; labels: string[] } | { kind: 'unavailable'; code: string } }):
  { kind: 'authorized' } | { kind: 'withdrawn'; codes: string[] } | { kind: 'unknown'; code: string } {
  if (input.observation.kind !== 'observed') return { kind: 'unknown', code: input.observation.code };
  if (!input.source) return { kind: 'unknown', code: 'JIRA_SOURCE_NOT_CONFIGURED' };
  if (input.observation.projectId !== input.source.projectId) return { kind: 'unknown', code: 'JIRA_PROJECT_CHANGED' };
  return input.observation.labels.includes(input.source.label) ? { kind: 'authorized' } : { kind: 'withdrawn', codes: ['LABEL_NOT_PRESENT'] };
}
/** Review MED: only a CONFIRMED observation withdraws (issue closed, label absent in a complete read); any other code is transient. */
export function confirmedWithdrawal(codes: string[]): { kind: 'withdrawn'; codes: string[] } | { kind: 'unknown'; code: string } {
  const confirmed = codes.filter(code => code === 'TICKET_NOT_OPEN' || code === 'LABEL_NOT_PRESENT');
  return confirmed.length ? { kind: 'withdrawn', codes: confirmed } : { kind: 'unknown', code: codes[0] ?? 'AUTHORIZATION_UNKNOWN' };
}

export type AuthorizationChange = { add: Impediment[]; remove: string[]; events: { event: 'authorization-withdrawn' | 'authorization-restored-observed' | 'authorization-confirmed' |
  'resume-confirmed' | 'resume-not-confirmed'; detail: string }[]; withdrawal: NonNullable<Work['authorization']['withdrawal']> | null; state: 'authorized' | 'withdrawn' };

/**
 * What one observation changes on a CURRENT open Work. A withdrawal suspends next activations (the active Execution is not cut); a restored
 * label/reopened issue is only recorded: the suspension stays until `resume` (spec §4.1). Only the authorization impediments are touched.
 */
export function authorizationChange(work: Pick<Work, 'impediments' | 'authorization'>, observed: { kind: 'authorized' } | { kind: 'withdrawn'; codes: string[] }, at: string,
  /** When the read STARTED (review LOW): a read begun before a `resume` commit never confirms it. Default: `at`. */
  readStartedAt = at): AuthorizationChange {
  const withdrawn = hasImpediment(work, cycleImpediments.withdrawn);
  const previous = work.authorization.withdrawal ?? null;
  const change: AuthorizationChange = { add: [], remove: [], events: [], withdrawal: previous, state: withdrawn ? 'withdrawn' : 'authorized' };
  if (observed.kind === 'withdrawn') {
    change.state = 'withdrawn';
    for (const code of [cycleImpediments.resumePending, cycleImpediments.notConfirmed]) if (hasImpediment(work, code)) {
      change.remove.push(code);
      if (code === cycleImpediments.resumePending) change.events.push({ event: 'resume-not-confirmed', detail: observed.codes.join(',') });
    }
    if (!withdrawn) {
      change.add.push({ code: cycleImpediments.withdrawn, scope: 'work', since: at, nextStep: `The Ticket no longer authorizes work (${observed.codes.join(', ')}). ` +
        'No new activation starts; an activity already running may conclude/publish. Restoring the label or reopening the issue is NOT enough: ' +
        '`factory resume <work>` is required, and the current authorization is re-read before anything starts.' });
      change.events.push({ event: 'authorization-withdrawn', detail: observed.codes.join(',') });
      change.withdrawal = { observedAt: at, codes: [...observed.codes], restoredObservedAt: null };
    } else if (previous?.restoredObservedAt) change.withdrawal = { ...previous, restoredObservedAt: null };
    return change;
  }
  if (withdrawn) {
    // Restoration is observed and kept visible, never a trigger.
    if (!previous?.restoredObservedAt) {
      change.events.push({ event: 'authorization-restored-observed', detail: 'label present and issue open; suspension kept until `factory resume`' });
      change.withdrawal = { ...(previous ?? { observedAt: at, codes: [] }), restoredObservedAt: at };
    }
    return change;
  }
  const pending = work.impediments.find(item => item.code === cycleImpediments.resumePending);
  if (pending && (pending.since === undefined || readStartedAt > pending.since)) { change.remove.push(cycleImpediments.resumePending); change.events.push({ event: 'resume-confirmed', detail: 'authorized' }); }
  if (hasImpediment(work, cycleImpediments.notConfirmed)) { change.remove.push(cycleImpediments.notConfirmed); change.events.push({ event: 'authorization-confirmed', detail: 'authorized' }); }
  if (change.remove.length) change.withdrawal = null;
  return change;
}

/** `cancel`: allowed for an open or closed-unmerged current cycle; a cancelled one is already satisfied; a delivered one is never cancelled. */
export function cancelDecision(work: Pick<Work, 'result'> | null, current: boolean): { kind: 'accept' } | { kind: 'already' } | { kind: 'refuse'; code: string } {
  if (!work) return { kind: 'refuse', code: 'WORK_NOT_FOUND' };
  if (!current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (work.result === 'delivered') return { kind: 'refuse', code: 'WORK_DELIVERED' };
  if (work.result === 'cancelled') return { kind: 'already' };
  return { kind: 'accept' };
}

/**
 * Inside a commit: a cancellation is `ceased` once no own Execution can still act or holds capacity. Its queue work is dropped and no
 * operational recovery is pending (a cancelled cycle never resumes). Returns whether it changed.
 */
export function settleCancellation(work: Pick<WorkView, 'cancellation' | 'execution' | 'previousExecutions' | 'queue' | 'pendingRecovery'>, at: string): boolean {
  const cancellation: CancellationView | null | undefined = work.cancellation;
  if (!cancellation) return false;
  work.queue = { ...work.queue, pending: false };
  work.pendingRecovery = null;
  if (cancellation.state === 'ceased' || executions(work).some(occupying)) return false;
  Object.assign(cancellation, { state: 'ceased', ceasedAt: at, nextStep: 'Cancelled and every own activity ceased (artifacts, branch and pull request preserved). ' +
    '`factory new <owner/repo#number>` may start another cycle; a confirmed merge of the own PR would still be recorded as delivery.' });
  return true;
}

/** `resume` (spec §11.3): lifts ONLY the suspension of a withdrawn authorization or of a reopened PR; never revives cancelled/delivered. */
export function resumeDecision(work: Work | null, current: boolean): { kind: 'accept'; remove: string[] } | { kind: 'already'; code: string } | { kind: 'refuse'; code: string } {
  if (!work) return { kind: 'refuse', code: 'WORK_NOT_FOUND' };
  if (!current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (work.result === 'cancelled') return { kind: 'refuse', code: 'WORK_CANCELLED' };
  if (work.result === 'delivered') return { kind: 'refuse', code: 'WORK_DELIVERED' };
  if (work.result === 'closed-unmerged') return { kind: 'refuse', code: 'PULL_REQUEST_CLOSED_REOPEN_REQUIRED' };
  const remove = [cycleImpediments.withdrawn, cycleImpediments.resumeRequired].filter(code => hasImpediment(work, code));
  if (remove.length) return { kind: 'accept', remove };
  if (hasImpediment(work, cycleImpediments.resumePending)) return { kind: 'already', code: 'RESUME_PENDING_AUTHORIZATION_READ' };
  // Spec §11.3: resume during an activity informs it is active, never launches a second Builder.
  if (work.execution && occupying(work.execution)) return { kind: 'already', code: 'EXECUTION_ACTIVE' };
  return { kind: 'refuse', code: 'NOTHING_TO_RESUME' };
}

/** `reopen`: only the Work's OWN pull request closed without merge, once per closure (an unsettled effect is never repeated). */
export function reopenDecision(work: Work | null, current: boolean, ownPullRequest: boolean): { kind: 'accept' } | { kind: 'already'; code: string } | { kind: 'refuse'; code: string } {
  if (!work) return { kind: 'refuse', code: 'WORK_NOT_FOUND' };
  if (!current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (work.result !== 'closed-unmerged') return { kind: 'refuse', code: work.result === 'delivered' ? 'WORK_DELIVERED' : work.result === 'cancelled' ? 'WORK_CANCELLED' : 'PULL_REQUEST_NOT_CLOSED_UNMERGED' };
  if (!ownPullRequest || !work.closure) return { kind: 'refuse', code: 'OWN_PULL_REQUEST_UNKNOWN' };
  const reopen = work.closure.reopen;
  if (reopen && (reopen.state === 'intended' || reopen.state === 'attempted')) return { kind: 'already', code: 'REOPEN_PENDING' };
  return { kind: 'accept' };
}

/**
 * `new <ticket>` (spec §4.1): only after delivery or a cancellation whose cessation is confirmed (no Slot held, no own activity), never while
 * the cycle is open/closed-unmerged (cancel first). A cancelled cycle's own PR that may still be open, or a publication not yet reconciled,
 * requires the operator's explicit decision; nothing is adopted, closed or replaced. The Ticket must authorize work NOW (fresh read: label
 * present + issue open); an unavailable read never authorizes.
 */
export function newCycleDecision(predecessor: Work | null, input: { keepPredecessorPullRequest: boolean; ownPullRequest: boolean;
  /** The fresh complete Ticket read taken when the command is accepted (supervisor decision): only a current authorization admits a cycle. */
  authorization: ReturnType<typeof authorizationFacts> }):
  { kind: 'accept' } | { kind: 'refuse'; code: string } {
  if (!predecessor) return { kind: 'refuse', code: 'TICKET_NOT_KNOWN' };
  if (predecessor.result === 'open' || predecessor.result === 'closed-unmerged') return { kind: 'refuse', code: 'CYCLE_STILL_CURRENT' };
  if (executions(predecessor).some(occupying)) return { kind: 'refuse', code: 'PREDECESSOR_CESSATION_UNCONFIRMED' };
  if (predecessor.result === 'cancelled') {
    if (predecessor.cancellation?.state !== 'ceased') return { kind: 'refuse', code: 'PREDECESSOR_CESSATION_UNCONFIRMED' };
    const publication = predecessor.publication?.state;
    if (publication === 'awaiting-discovery' || publication === 'requested') return { kind: 'refuse', code: 'PREDECESSOR_PUBLICATION_NOT_RECONCILED' };
    const lastOutcome = predecessor.delivery?.observations.at(-1)?.outcome;
    if (input.ownPullRequest && lastOutcome !== 'closed-unmerged' && !input.keepPredecessorPullRequest) return { kind: 'refuse', code: 'PREDECESSOR_PULL_REQUEST_OPEN' };
  }
  if (input.authorization.kind === 'withdrawn') return { kind: 'refuse', code: 'TICKET_NOT_AUTHORIZED' };
  if (input.authorization.kind === 'unknown') return { kind: 'refuse', code: 'AUTHORIZATION_READ_UNAVAILABLE' };
  return { kind: 'accept' };
}
