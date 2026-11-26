// Spec #68 §4-§5 (ticket #71): pure rules of the Triage request from `needs-triage` up to `queued`. No I/O, clock, storage or tracker
// types: callers pass the observed facts. A decision here never writes to the tracker and never creates a Work.

/** The seven states of a Triage request (spec §5). There is no retry state: between attempts the request is `queued` again. */
export const triageRequestStates = ['queued', 'investigating', 'suspended', 'publishing', 'concluded', 'abandoned', 'failed'] as const;
export type TriageRequestState = (typeof triageRequestStates)[number];
export const terminalTriageStates = ['concluded', 'abandoned', 'failed'] as const satisfies readonly TriageRequestState[];
export const isTerminalTriageState = (state: TriageRequestState) => (terminalTriageStates as readonly TriageRequestState[]).includes(state);

const transitions: Record<TriageRequestState, readonly TriageRequestState[]> = {
  queued: ['investigating', 'suspended', 'abandoned', 'failed'],
  investigating: ['queued', 'publishing', 'abandoned', 'failed'],
  // `publishing`: a request suspended with its Verdict recorded goes back to its publication, never to another investigation (#77).
  suspended: ['queued', 'publishing', 'abandoned'],
  publishing: ['concluded', 'suspended', 'abandoned'],
  concluded: [],
  abandoned: [],
  failed: [],
};
/** Whether a request may move from one state to another. A terminal state never moves; every live state may end `abandoned`. */
export const triageTransitionAllowed = (from: TriageRequestState, to: TriageRequestState) => transitions[from].includes(to);

/** The five state labels of one source: the four of its `triage` block plus the admission label of its destination (`ready-for-agent`). */
export type TriageRoles = { needsTriage: string; needsInfo: string; readyForHuman: string; wontfix: string; admission: string };
/** GitHub label names are case-insensitive; Jira labels are case-sensitive. */
const sameLabel = (caseSensitive: boolean) => (a: string, b: string) => (caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());

/** `needs-triage` present on a source with Triage: admission by the admission label is suspended (spec §4.3). */
export function suspendsAdmission(roles: Pick<TriageRoles, 'needsTriage'>, labels: readonly string[], caseSensitive: boolean): boolean {
  const same = sameLabel(caseSensitive);
  return labels.some(label => same(label, roles.needsTriage));
}

/**
 * The other state labels present beside `needs-triage`, as the Ticket spells them (empty: no conflict, or no `needs-triage`). The Factory
 * never chooses a winner among them.
 */
export function stateLabelConflict(roles: TriageRoles, labels: readonly string[], caseSensitive: boolean): string[] {
  if (!suspendsAdmission(roles, labels, caseSensitive)) return [];
  const same = sameLabel(caseSensitive);
  return [roles.needsInfo, roles.readyForHuman, roles.wontfix, roles.admission].flatMap(role => labels.filter(label => same(label, role)));
}

/** One label change of the Ticket's history (GitHub timeline, Jira changelog), in the order the origin reports. */
export type TriageLabelEvent = { eventId: string; action: 'added' | 'removed'; label: string };
/** The application of `needs-triage` a request was born from: the latest `added` event then (`null`: the history shows none). */
export type TriageLabelApplication = { eventId: string };
export function latestLabelApplication(events: readonly TriageLabelEvent[], label: string, caseSensitive: boolean): TriageLabelApplication | null {
  const same = sameLabel(caseSensitive);
  const found = events.findLast(event => event.action === 'added' && same(event.label, label));
  return found ? { eventId: found.eventId } : null;
}

export type TriageHoldCode =
  | 'TRIAGE_TICKET_NOT_OPEN'
  | 'TRIAGE_TICKET_LEFT_SOURCE'
  | 'TRIAGE_WORK_EXISTS'
  | 'TRIAGE_LABEL_CONFLICT'
  | 'TRIAGE_REAPPLICATION_REQUIRED'
  | 'TRIAGE_LABEL_HISTORY_UNAVAILABLE';
/** Why a live request ended `abandoned` by discovery (the operator's cancellation and the publication add their own codes later). */
export type TriageWithdrawalCode = 'NEEDS_TRIAGE_REMOVED' | 'TICKET_CLOSED' | 'WORK_EXISTS' | 'TICKET_LEFT_SOURCE' | 'TRIAGE_SOURCE_REMOVED';
export type TriageDecision =
  | { action: 'none' }
  | { action: 'keep' }
  | { action: 'read-history' }
  | { action: 'create'; application: TriageLabelApplication | null }
  | { action: 'hold'; code: TriageHoldCode; labels?: string[]; observedCode?: string }
  | { action: 'suspend'; labels: string[] }
  | { action: 'requeue' }
  | { action: 'abandon'; code: TriageWithdrawalCode };

export type TriageEvaluationInput = {
  roles: TriageRoles;
  caseSensitive: boolean;
  /** A FRESH read of the Ticket by ID plus the local fact of a Work in any state (active, Delivered, cancelled or forgotten). */
  facts: { open: boolean; inSource: boolean; labels: readonly string[]; hasWork: boolean };
  /** The Ticket's latest request, if any. `endCode`: why it ended. */
  latest: { state: TriageRequestState; endCode: string | null; application: TriageLabelApplication | null } | null;
  history: { kind: 'not-read' } | { kind: 'unavailable'; code: string } | { kind: 'observed'; events: readonly TriageLabelEvent[] };
};

/** Why the Ticket cannot be triaged whatever its labels' history says, as the code that ends a live request. */
function ineligible(input: TriageEvaluationInput): TriageWithdrawalCode | null {
  const { facts } = input;
  if (!facts.inSource) return 'TICKET_LEFT_SOURCE';
  if (!facts.open) return 'TICKET_CLOSED';
  if (facts.hasWork) return 'WORK_EXISTS';
  return suspendsAdmission(input.roles, facts.labels, input.caseSensitive) ? null : 'NEEDS_TRIAGE_REMOVED';
}
const holdOf: Record<Exclude<TriageWithdrawalCode, 'NEEDS_TRIAGE_REMOVED' | 'TRIAGE_SOURCE_REMOVED'>, TriageHoldCode> = {
  TICKET_LEFT_SOURCE: 'TRIAGE_TICKET_LEFT_SOURCE',
  TICKET_CLOSED: 'TRIAGE_TICKET_NOT_OPEN',
  WORK_EXISTS: 'TRIAGE_WORK_EXISTS',
};

/** A request waiting in `queued` or `suspended` follows the Ticket; one being investigated or published is never moved by discovery. */
function evaluateLive(input: TriageEvaluationInput, state: TriageRequestState): TriageDecision {
  if (state !== 'queued' && state !== 'suspended') return { action: 'keep' };
  const withdrawn = ineligible(input);
  if (withdrawn) return { action: 'abandon', code: withdrawn };
  const labels = stateLabelConflict(input.roles, input.facts.labels, input.caseSensitive);
  if (labels.length) return state === 'queued' ? { action: 'suspend', labels } : { action: 'keep' };
  return state === 'suspended' ? { action: 'requeue' } : { action: 'keep' };
}

/**
 * A new request: the first of the Ticket, or one with evidence that `needs-triage` was withdrawn and applied again since the latest one
 * (the Control observed the withdrawal itself, or the origin's history shows a later application). Two reads with the label present are
 * never evidence. The history is read before every creation, so each request records the application it consumed.
 */
function evaluateNew(input: TriageEvaluationInput): TriageDecision {
  const { history, latest } = input;
  if (history.kind === 'not-read') return { action: 'read-history' };
  if (history.kind === 'unavailable') return { action: 'hold', code: 'TRIAGE_LABEL_HISTORY_UNAVAILABLE', observedCode: history.code };
  const application = latestLabelApplication(history.events, input.roles.needsTriage, input.caseSensitive);
  const reapplied = application !== null && application.eventId !== latest?.application?.eventId;
  if (latest && latest.endCode !== 'NEEDS_TRIAGE_REMOVED' && !reapplied) return { action: 'hold', code: 'TRIAGE_REAPPLICATION_REQUIRED' };
  return { action: 'create', application };
}

/** What discovery does with one Ticket of a source where Triage is on, from a fresh read of it. */
export function evaluateTriage(input: TriageEvaluationInput): TriageDecision {
  const { latest } = input;
  if (latest && !isTerminalTriageState(latest.state)) return evaluateLive(input, latest.state);
  const withdrawn = ineligible(input);
  if (withdrawn === 'NEEDS_TRIAGE_REMOVED' || withdrawn === 'TRIAGE_SOURCE_REMOVED') return { action: 'none' };
  if (withdrawn) return { action: 'hold', code: holdOf[withdrawn] };
  const labels = stateLabelConflict(input.roles, input.facts.labels, input.caseSensitive);
  if (labels.length) return { action: 'hold', code: 'TRIAGE_LABEL_CONFLICT', labels };
  return evaluateNew(input);
}

/** What the operator reads beside a hold; nothing of it is ever written to the Ticket. */
export const triageHoldNextStep: Record<TriageHoldCode, string> = {
  TRIAGE_TICKET_NOT_OPEN: 'Only an open Ticket is triaged; reopen it if a Triage is intended.',
  TRIAGE_TICKET_LEFT_SOURCE: 'The Ticket is no longer in the project of this source; it is not triaged from here.',
  TRIAGE_WORK_EXISTS: 'The Ticket already has a Work (active, Delivered or cancelled); it is never triaged.',
  TRIAGE_LABEL_CONFLICT:
    'needs-triage sits beside another state label: the Factory neither triages nor admits, chooses no winner and writes nothing to the Ticket. ' +
    'A person must leave a single state label.',
  TRIAGE_REAPPLICATION_REQUIRED:
    'The latest Triage request of this Ticket is over and needs-triage was not applied again since; remove and reapply the label to request another Triage.',
  TRIAGE_LABEL_HISTORY_UNAVAILABLE: "The Ticket's label history could not be read completely; no request is created on a guess. The next poll reads it again.",
};

/**
 * Ticket #75: an attempt holds Triage capacity from its start until the environment CONFIRMED its cessation, whatever became of its
 * request (a request abandoned while investigating is terminal at once; its attempt is not over).
 */
export const holdsTriageCapacity = (attempt: { end: { cessation: { cessationConfirmed: boolean } } | null }) => !attempt.end?.cessation.cessationConfirmed;
/** Ticket #75: why an attempt that ended without a recorded Verdict ended, from what its session reported. */
export function attemptEndCode(completion: { status: 'failure'; code: string } | { status: 'completed' | 'interrupted'; closedBy: string | null }): string {
  if (completion.status === 'failure') return completion.code;
  if (completion.closedBy === 'provider') return 'TRIAGER_PROVIDER_UNAVAILABLE';
  if (completion.closedBy) return 'TRIAGER_MODEL_BUDGET_EXHAUSTED';
  return completion.status === 'completed' ? 'TRIAGER_ENDED_WITHOUT_VERDICT' : 'TRIAGER_INTERRUPTED';
}

// ---- Ticket #76 (spec §5): the budget of a request, the Triage capacity and the retained capacity ----
/** The two installation limits of one request (`triager.investigationMinutes`, `triager.attempts`); the third axis is the model's, per attempt. */
export type TriageBudget = { investigationMs: number; attempts: number };
/** What the rules read of an attempt record: the investigation time it spent and how its stop was answered (`end: null` = still open). */
export type TriageAttemptFacts = { end: { at: string; code: string; spentMs?: number; cessation: { cessationConfirmed: boolean; code?: string } } | null };
/** The investigation clock ran out during the attempt, or no time is left for another one. */
export const triageTimeExhausted = 'TRIAGE_INVESTIGATION_TIME_EXHAUSTED';
/** The last attempt of the request ended without a Verdict. */
export const triageAttemptsExhausted = 'TRIAGE_ATTEMPTS_EXHAUSTED';
/** A session the release profile itself refuses: another attempt would be refused alike, so it is not a transient failure. */
const permanentAttemptCodes: readonly string[] = ['WORKER_MODEL_MISMATCH', 'WORKER_THINKING_LEVEL_UNSUPPORTED', 'WORKER_MODEL_UNAVAILABLE'];

/**
 * What a request has left. Only the time of its attempts is spent (`end.spentMs` of each ended one, `openMs` for the one still open): the
 * queue costs nothing, and the balance is read from the durable attempts, so a restart of the Control gives nothing back.
 */
export function triageBalance(budget: TriageBudget, attempts: readonly TriageAttemptFacts[], openMs = 0): { attemptsLeft: number; remainingMs: number } {
  const spent = attempts.reduce((sum, attempt) => sum + Math.max(0, attempt.end ? (attempt.end.spentMs ?? 0) : openMs), 0);
  return { attemptsLeft: Math.max(0, budget.attempts - attempts.length), remainingMs: Math.max(0, budget.investigationMs - spent) };
}

/**
 * What becomes of a request still `investigating` when its latest attempt (the last of `attempts`) ended without a Verdict: back to the
 * queue for a new session when the end was transient and both attempts and time are left, `failed` otherwise, with the code of the axis
 * that ran out (the attempt keeps its own end code). Nothing of this is ever written to the Ticket.
 */
export function afterAttemptWithoutVerdict(budget: TriageBudget, attempts: readonly TriageAttemptFacts[]): { to: 'queued' } | { to: 'failed'; code: string } {
  const code = attempts.at(-1)?.end?.code ?? 'TRIAGE_ATTEMPT_FAILED';
  const balance = triageBalance(budget, attempts);
  if (code === triageTimeExhausted || balance.remainingMs <= 0) return { to: 'failed', code: triageTimeExhausted };
  if (permanentAttemptCodes.includes(code)) return { to: 'failed', code };
  if (balance.attemptsLeft <= 0) return { to: 'failed', code: triageAttemptsExhausted };
  return { to: 'queued' };
}

/**
 * The queued requests to start now, in arrival order, while a unit of Triage capacity is free. `held`: the attempts holding a unit in the
 * whole installation (`holdsTriageCapacity`). A queued request whose own earlier attempt is not confirmed stopped is passed over: its
 * next session never starts before that confirmation. Slots are not consulted: the capacity is independent of them.
 */
export function triageStarts(input: {
  capacity: number;
  held: number;
  queue: readonly { triage_request_id: string; attempts?: readonly TriageAttemptFacts[] | undefined }[];
}): string[] {
  const free = Math.max(0, input.capacity - input.held);
  return input.queue
    .filter(request => !request.attempts?.some(holdsTriageCapacity))
    .slice(0, free)
    .map(request => request.triage_request_id);
}

/** An open obstacle of a Triage request the operator must know of. `ref` is what the intervention commands name. */
export type TriageImpediment = {
  ref: string;
  code: 'TRIAGE_CAPACITY_RETAINED';
  scope: 'installation';
  triage_request_id: string;
  attempt: string;
  since: string;
  /** What the environment last answered to the stop. */
  observed: string;
  nextStep: string;
};
/**
 * The retained capacity of a request: every ENDED attempt whose stop the environment did not confirm, whatever the state of the request.
 * Derived from the attempt records, so it opens with the unconfirmed stop and closes with the confirmation, never apart from them.
 */
export function triageImpediments(request: {
  triage_request_id: string;
  attempts?: readonly (TriageAttemptFacts & { attempt: string })[] | undefined;
}): TriageImpediment[] {
  return (request.attempts ?? []).flatMap(attempt => {
    if (!attempt.end || attempt.end.cessation.cessationConfirmed) return [];
    const observed = attempt.end.cessation.code ?? 'INVESTIGATION_STOP_UNCONFIRMED';
    return {
      ref: attempt.attempt,
      code: 'TRIAGE_CAPACITY_RETAINED' as const,
      scope: 'installation' as const,
      triage_request_id: request.triage_request_id,
      attempt: attempt.attempt,
      since: attempt.end.at,
      observed,
      nextStep:
        `The stop of Triager attempt ${attempt.attempt} is not confirmed (${observed}); it keeps one unit of Triage capacity and no Slot. ` +
        'The Factory asks again at every reconciliation and at every start. If the attempt is known to be over, as a last resort: ' +
        `factory triage release ${request.triage_request_id} --attempt ${attempt.attempt} --reason "..."`,
    };
  });
}
