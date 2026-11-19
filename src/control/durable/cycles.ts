import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AccessDependencies, ConfiguredRepository, ControlInput, ControlReceipt, CycleEvent, ForgottenWork, Impediment, WorkView } from '../types.js';
import type { IssueTracker } from '../../issue-tracker/index.js';
import { ticketKey } from '../rules/admission.js';
import { initialBudget } from '../rules/budget.js';
import { authorizationChange, authorizationFacts, cancelDecision, cycleImpediments, hasImpediment, newCycleDecision, occupying, reopenDecision, resumeDecision,
  settleCancellation } from '../rules/cycles.js';
import { decideMerge, ownPullRequestOf } from '../rules/delivery.js';
import { newReviewRoundDecision, overrideBlockedRecoveryDecision, positiveResolution, retryBlockedStartDecision, reviewerRetryLimitCode } from '../rules/recovery.js';
import { readForgotten, readWork, readWorks, requests, ticketIndex, works, type WorkRecord } from './admission.js';
import { questions } from './questions.js';
import { applyRecoveryRequest } from './recovery-request.js';
import type { Session } from './store.js';

// Ticket 25 durable commits and the cycle desk (spec §3.4 "Aceitar comando", "Interromper/cancelar", "Confirmar efeito"; §4.1; §11.3; §12.3).
// Remote reads/effects happen OUTSIDE the commits; every commit re-checks the Work, its cycle and the occurrence it records.

type CycleInput = Extract<ControlInput, { operation: 'cancel' | 'resume' | 'reopen' | 'new' }>;
type Receipt = Extract<ControlReceipt, { operation: 'cancel' | 'resume' | 'reopen' | 'new' }>;
type Index = { tickets: Record<string, { current: string; previous: string[] }>; memory?: Record<string, { cycles: { work_id: string; cycle: number; result: WorkView['result']; mergeConfirmed: boolean }[] }>;
  forgotten?: Record<string, ForgottenWork> };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const history = (work: WorkRecord, event: CycleEvent,
  origin: 'controller-cycles' | 'local-cli', detail: string, at = new Date().toISOString()) => work.history.push({ at, event, origin, detail: detail.slice(0, 512) });
const addImpediment = (work: WorkRecord, impediment: Impediment) => { if (!hasImpediment(work, impediment.code)) work.impediments.push(impediment); };
const removeImpediments = (work: WorkRecord, codes: string[]) => { work.impediments = work.impediments.filter(item => !codes.includes(item.code)); };
/** The Ticket's explicit minimal memory (spec §12.4) follows the cycle's result in the same commit. */
export function rememberResult(index: Index, work: WorkRecord) {
  const key = ticketKey(work.ticket);
  const cycles = index.memory?.[key]?.cycles ?? [];
  const entry = { work_id: work.work_id, cycle: work.cycle, result: work.result, mergeConfirmed: work.result === 'delivered' && Boolean(work.delivery?.merge) };
  index.memory = { ...(index.memory ?? {}), [key]: { cycles: cycles.some(item => item.work_id === work.work_id) ? cycles.map(item => item.work_id === work.work_id ? entry : item) : [...cycles, entry] } };
}

/** Deduplicated "Aceitar comando": same identity + content returns the recorded receipt; same identity + other content is a conflict. */
async function command(session: Session, input: CycleInput, decide: (tx: Parameters<Parameters<Session['commit']>[0]>[0]) => Promise<Receipt>): Promise<Receipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return copy(request.receipt) as Receipt;
    }
    const receipt = await decide(tx);
    request.input = input;
    request.receipt = receipt;
    return copy(receipt);
  }, BACKGROUND_CONTEXT);
}
const receiptOf = (input: CycleInput, work_id: string | null, outcome: Receipt['outcome'], reason: string | null, created: string | null = null): Receipt =>
  ({ kind: 'durable', request_id: input.request_id, operation: input.operation, work_id, outcome, reason, created });

/**
 * `cancel <work>` (spec §3.4 "Interromper/cancelar", §12.3): in ONE commit the prohibition (result `cancelled`, impediment, queue work dropped,
 * Ticket memory) and the stop intent are durable BEFORE anything is interrupted. The caller then withdraws credentials and requests the stop;
 * the Slot is released only by the confirmed cessation. Branch, PR, artifacts and GitHub are never touched.
 */
export async function acceptCancel(session: Session, input: CycleInput & { operation: 'cancel' }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const decision = cancelDecision(work, work ? index.tickets[ticketKey(work.ticket)]?.current === work.work_id : false);
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', 'ALREADY_CANCELLED');
    const at = new Date().toISOString();
    const active = work!.execution && occupying(work!.execution) ? work!.execution.executionId : null;
    work!.result = 'cancelled';
    work!.cancellation = { request_id: input.request_id, requestedAt: at, state: 'stopping', ceasedAt: null, executionId: active,
      nextStep: 'Cancellation recorded: credentials are withdrawn and the stop requested; the Slot is released only after the confirmed cessation. Nothing on GitHub is undone.' };
    addImpediment(work!, { code: cycleImpediments.cancelled, scope: 'work', since: at, nextStep: 'Cancelled by the operator: no new action, publication or renewal. ' +
      '`factory new <owner/repo#number>` starts another cycle once cessation is confirmed.' });
    history(work!, 'cancel-requested', 'local-cli', `${input.request_id}${active ? `:active:${active}` : ''}`, at);
    // Ticket 51: a cancel of a Work stopped by REVIEWER_RETRY_LIMIT IS the operator's decision on it (the other one is a new review round).
    const execution = work!.execution;
    if (execution && !execution.reviewRetryLimit && (execution.end ? execution.end.code === reviewerRetryLimitCode : execution.held?.code === reviewerRetryLimitCode)) {
      execution.reviewRetryLimit = { decision: 'cancel', request_id: input.request_id, operator: { kind: 'local-administrator' }, at };
      work!.history.push({ at, event: 'review-retry-limit-decided', origin: 'local-cli', executionId: execution.executionId, detail: `${input.request_id}:cancel` });
    }
    if (settleCancellation(work!, at)) history(work!, 'cancellation-ceased', 'controller-cycles', 'no own activity was running', at);
    rememberResult(index, work!);
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/** `resume <work>`: removes ONLY the suspension codes it answers and leaves a pending-read impediment; never touches any other impediment. */
export async function acceptResume(session: Session, input: CycleInput & { operation: 'resume' }, facts: { running(work_id: string): boolean } = { running: () => false }) {
  if ('override_blocked_recovery' in input) return acceptBlockedRecoveryOverride(session, input, facts);
  if ('new_review_round' in input) return acceptNewReviewRound(session, input, facts);
  if ('retry_blocked_start' in input) return acceptBlockedStartRetry(session, input, facts);
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const decision = resumeDecision(work, work ? index.tickets[ticketKey(work.ticket)]?.current === work.work_id : false);
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', decision.code);
    const at = new Date().toISOString();
    removeImpediments(work!, decision.remove);
    addImpediment(work!, { code: cycleImpediments.resumePending, scope: 'work', since: at, nextStep: 'Resume accepted: the next complete read of the Ticket must ' +
      'show it open with the configured label; then the Work re-enters its queue position. Other impediments still apply.' });
    history(work!, 'resume-accepted', 'local-cli', `${input.request_id}:${decision.remove.join(',')}`, at);
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/**
 * Ticket 41: `resume <work> --override-blocked-recovery <reference>` — ONE commit (deduplicated by request identity) revalidates the block
 * against the durable facts (exact reference, confirmed cessation, no activity/Slot, no Question bound by a later complete read), records the
 * operator's decision on the blocked request with history, lifts ONLY that `RECOVERY_BLOCKED` and opens ONE operational recovery through
 * ticket 26's ordinary path (persisted wait; one `recoveries` unit at the confirmed start; exhaustion is the usual impediment). Nothing of the
 * lost request is reconstructed and nothing is launched here: the Work re-enters its queue position and the dispatcher revalidates everything.
 */
async function acceptBlockedRecoveryOverride(session: Session, input: Extract<CycleInput, { override_blocked_recovery: string }>, facts: { running(work_id: string): boolean }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const execution = work?.execution ?? null;
    const bound: { questionId: string; executionId: string; invocationId: string }[] = [];
    if (work && execution?.blockedRequest) for (const id of work.questions ?? []) {
      const question = (await tx.doc(questions, id, null)).question;
      if (question) bound.push({ questionId: question.questionId, executionId: question.executionId, invocationId: question.invocationId });
    }
    const blocked = execution?.blockedRequest;
    const decision = overrideBlockedRecoveryDecision({
      work: work ? { result: work.result, current: index.tickets[ticketKey(work.ticket)]?.current === work.work_id, impediments: work.impediments } : null,
      execution: execution ? { state: execution.state, slotHeld: execution.slot.held, end: execution.end ?? null, blockedRequest: blocked } : null,
      reference: input.override_blocked_recovery, running: facts.running(input.work_id), cancelling: Boolean(work?.cancellation), pendingRecovery: Boolean(work?.pendingRecovery),
      resolved: Boolean(blocked && execution && positiveResolution({ blocked, executionId: execution.executionId, invocationId: execution.invocationId, questions: bound,
        recovery: execution.recovery ?? [] })) });
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', decision.code);
    const at = new Date().toISOString();
    removeImpediments(work!, ['RECOVERY_BLOCKED']);
    work!.history.push({ at, event: 'blocked-recovery-overridden', origin: 'local-cli', executionId: execution!.executionId,
      detail: `${input.request_id}:${input.override_blocked_recovery}`.slice(0, 512) });
    // No recovery was pending (revalidated above), so this opens exactly one new request.
    applyRecoveryRequest(work!, { executionId: execution!.executionId, code: decision.code, at, reason: `operator-override:${input.override_blocked_recovery}` });
    // Assigned as a new object: a doc value assigned then mutated in place is not what the commit persists.
    execution!.blockedRequest = { ...execution!.blockedRequest!, override: { request_id: input.request_id, operator: { kind: 'local-administrator' }, at,
      reference: input.override_blocked_recovery, recoveryRequest: 'requested' } };
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/**
 * Ticket 51: `resume <work> --new-review-round` — ONE commit (deduplicated by request identity) revalidates that the Work is blocked by
 * REVIEWER_RETRY_LIMIT after confirmed cessation (no activity, no Slot, no pending recovery), records the operator's decision with history,
 * lifts ONLY that `RECOVERY_BLOCKED` and opens ONE operational recovery through ticket 26's ordinary path (persisted wait; one `recoveries` unit
 * at the confirmed start). Nothing is launched here; the recovery's Builder hands off again and the new round follows ticket 28's rules.
 */
async function acceptNewReviewRound(session: Session, input: Extract<CycleInput, { new_review_round: true }>, facts: { running(work_id: string): boolean }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const execution = work?.execution ?? null;
    const decision = newReviewRoundDecision({
      work: work ? { result: work.result, current: index.tickets[ticketKey(work.ticket)]?.current === work.work_id, impediments: work.impediments } : null,
      execution: execution ? { state: execution.state, slotHeld: execution.slot.held, held: execution.held ?? null, end: execution.end ?? null,
        reviewRetryLimit: execution.reviewRetryLimit ?? null } : null,
      running: facts.running(input.work_id), cancelling: Boolean(work?.cancellation), pendingRecovery: Boolean(work?.pendingRecovery) });
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', decision.code);
    const at = new Date().toISOString();
    removeImpediments(work!, ['RECOVERY_BLOCKED']);
    // Assigned as a new object: a doc value assigned then mutated in place is not what the commit persists.
    execution!.reviewRetryLimit = { decision: 'new-review-round', request_id: input.request_id, operator: { kind: 'local-administrator' }, at };
    work!.history.push({ at, event: 'review-retry-limit-decided', origin: 'local-cli', executionId: execution!.executionId, detail: `${input.request_id}:new-review-round` });
    applyRecoveryRequest(work!, { executionId: execution!.executionId, code: reviewerRetryLimitCode, at, reason: 'operator-new-review-round' });
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/** Ticket 50: the artifact seed (`factory/<kind>/<version>`) named by a seed-conflict detail (`<seed>/<file>`), if any. */
const seedOfDetail = (detail: string | null) => {
  const parts = (detail ?? '').split('/');
  return parts.length >= 3 && parts[0] === 'factory' ? [parts.slice(0, 3).join('/')] : [];
};

/**
 * Ticket 50: `resume <work> --retry-blocked-start <code> [--remedy <name>]` — the GENERIC operator exit of a recovery blocked by a refused
 * boot/preparation (ticket 47 reuses it for START_PRESERVED_DISK_CHECK_REQUIRED). ONE commit (deduplicated by request identity) revalidates the
 * block against the durable facts (exact code, the refused Execution released after confirmed cessation, nothing started, no Slot/activity),
 * records the operator's decision on that Execution with history, lifts ONLY that `RECOVERY_BLOCKED` and requests ONE operational recovery
 * through ticket 26's ordinary path (persisted wait; one `recoveries` unit at the confirmed start; an already pending one is kept, never a
 * second). A remedy is recorded for the NEXT preparation/boot only. Nothing is launched here.
 */
async function acceptBlockedStartRetry(session: Session, input: Extract<CycleInput, { retry_blocked_start: string }>, facts: { running(work_id: string): boolean }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const execution = work?.execution ?? null;
    const remedy = input.remedy ?? null;
    const refusal = execution?.blockedStart;
    const decision = retryBlockedStartDecision({
      work: work ? { result: work.result, current: index.tickets[ticketKey(work.ticket)]?.current === work.work_id, impediments: work.impediments } : null,
      execution: execution ? { state: execution.state, started: Boolean(execution.start), slotHeld: execution.slot.held,
        blockedStart: refusal ? { code: refusal.code, cessation: refusal.cessation, retry: refusal.retry } : undefined } : null,
      code: input.retry_blocked_start, remedy, running: facts.running(input.work_id), cancelling: Boolean(work?.cancellation) });
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', decision.code);
    const seeds = remedy === 'recreate-artifact-seed' ? seedOfDetail(refusal!.detail) : [];
    if (remedy === 'recreate-artifact-seed' && !seeds.length) return receiptOf(input, input.work_id, 'not-applied', 'SEED_NOT_IDENTIFIED');
    const at = new Date().toISOString();
    removeImpediments(work!, ['RECOVERY_BLOCKED']);
    work!.history.push({ at, event: 'blocked-start-retried', origin: 'local-cli', executionId: execution!.executionId,
      detail: `${input.request_id}:${decision.code}${remedy ? `:${remedy}${remedy === 'recreate-artifact-seed' ? `:${seeds.join(',')}` : ''}` : ''}`.slice(0, 512) });
    const opened = applyRecoveryRequest(work!, { executionId: execution!.executionId, code: decision.code, at, reason: `operator-retry:${decision.code}` });
    work!.startRemedy = remedy ? { remedy, request_id: input.request_id, executionId: execution!.executionId, at, seeds } : null;
    // Assigned as a new object: a doc value assigned then mutated in place is not what the commit persists.
    execution!.blockedStart = { ...refusal!, retry: { request_id: input.request_id, operator: { kind: 'local-administrator' }, at, code: decision.code, remedy,
      recoveryRequest: opened } };
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/** `reopen <work>`: the reopen effect is INTENDED here; the cycle desk observes, sends at most once and confirms (an ACK is not the effect). */
export async function acceptReopen(session: Session, input: CycleInput & { operation: 'reopen' }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const decision = reopenDecision(work, work ? index.tickets[ticketKey(work.ticket)]?.current === work.work_id : false, work ? ownPullRequestOf(work) !== null : false);
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', decision.code);
    const at = new Date().toISOString();
    const effectId = randomUUID();
    work!.closure!.reopen = { effectId, request_id: input.request_id, intendedAt: at, state: 'intended', sendingAt: null, attempt: null, observation: null, settledAt: null };
    work!.closure!.nextStep = 'Reopen intended: the own pull request is observed and reopened at most once; confirming it does not resume the Work (`factory resume`).';
    history(work!, 'reopen-intended', 'local-cli', `${input.request_id}:${effectId}`, at);
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/**
 * `new <owner/repo#number>` (spec §4.1): a NEW Work for the Ticket with predecessor, cycle + 1, its own budget, branch and environment, in the
 * same commit as the index (current/previous) and the Ticket memory, only when a fresh Ticket read at acceptance shows it authorized; it
 * waits for its first dependency evaluation; nothing of the predecessor (PR, branch, environment) is adopted, closed or removed.
 */
export async function acceptNewCycle(session: Session, input: CycleInput & { operation: 'new' },
  deps: { configured(repository: string): ConfiguredRepository | undefined; tracker: Pick<IssueTracker, 'readTicket'> }) {
  // Supervisor decision: a FRESH complete read of the Ticket when the command is accepted (outside the commit); a replay of the same
  // request returns its recorded receipt whatever this read says.
  const sameTicket = (ticket: { repository: string; number: number }) => ticket.repository.toLowerCase() === input.ticket.repository.toLowerCase() && ticket.number === input.ticket.number;
  // The Ticket's CURRENT cycle (as the commit finds it). Ticket 31: a forgotten current cycle is known by its minimal memory only.
  const snapshot = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  let current: (Pick<WorkRecord, 'work_id' | 'ticket' | 'repository'> & { result: WorkRecord['result'] }) | null = null;
  for (const entry of Object.values(snapshot?.tickets ?? {})) {
    const candidate = snapshot?.forgotten?.[entry.current] ?? await readWork(session, entry.current);
    if (candidate && sameTicket(candidate.ticket)) { current = candidate; break; }
  }
  if (current && (current.result === 'open' || current.result === 'closed-unmerged')) current = null;
  let authorization: ReturnType<typeof authorizationFacts> = { kind: 'unknown', code: 'TICKET_NOT_READ' };
  // Review LOW: the new cycle's authorization basis is the FRESH read (its label as observed now), never one copied or invented.
  let freshLabel: { id: number; name: string } | null = null;
  if (current) {
    const facts = await deps.tracker.readTicket(current.ticket).catch(() => ({ kind: 'unavailable' as const, code: 'TICKET_READ_FAILED', nextStep: '' }));
    const configuredLabel = deps.configured(current.repository.repository)?.label;
    authorization = authorizationFacts({ configuredLabel, ticket: current.ticket, facts });
    if (facts.kind === 'observed') freshLabel = facts.labels.find(item => item.name === configuredLabel) ?? null;
  }
  const observedAt = new Date().toISOString();
  const limits = deps.configured;
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    let predecessor: WorkRecord | null = null;
    let key: string | null = null;
    let forgotten: ForgottenWork | null = null;
    for (const [entryKey, entry] of Object.entries(index.tickets)) {
      // Ticket 31: a forgotten current cycle has no Work record; its minimal memory stands for it (ended, ceased, no own PR left open).
      const memory = index.forgotten?.[entry.current];
      if (memory) { if (sameTicket(memory.ticket)) { forgotten = memory; predecessor = predecessorOf(memory); key = entryKey; break; } continue; }
      const work = (await tx.doc(works, entry.current, null)).work;
      if (work && sameTicket(work.ticket)) { predecessor = work; key = entryKey; break; }
    }
    const decision = newCycleDecision(predecessor, { keepPredecessorPullRequest: input.keepPredecessorPullRequest, ownPullRequest: predecessor ? ownPullRequestOf(predecessor) !== null : false,
      // The read must be of THIS predecessor's Ticket (it may have changed between the read and the commit).
      authorization: predecessor && current?.work_id === predecessor.work_id ? authorization : { kind: 'unknown', code: 'TICKET_NOT_READ' } });
    if (decision.kind === 'refuse') return receiptOf(input, predecessor?.work_id ?? null, 'not-applied', decision.code);
    const configured = limits(predecessor!.repository.repository);
    if (!configured) return receiptOf(input, predecessor!.work_id, 'not-applied', 'REPOSITORY_NOT_CONFIGURED');
    if (forgotten && !freshLabel) return receiptOf(input, predecessor!.work_id, 'not-applied', 'AUTHORIZATION_READ_UNAVAILABLE');
    const at = new Date().toISOString();
    const work_id = randomUUID();
    const document = await tx.doc(works, work_id, null);
    if (document.work) throw new Error('WORK_IDENTITY_COLLISION');
    const sequence = index.admissionSequence + 1;
    const previous = predecessor!;
    document.work = {
      work_id, cycle: previous.cycle + 1, predecessor: previous.work_id, ticket: copy(previous.ticket), repository: copy(previous.repository), result: 'open',
      authorization: { ...copy(previous.authorization), state: 'authorized', observedAt, tracking: 'New cycle requested explicitly; authorization confirmed by a fresh complete Ticket read at acceptance and tracked by every later read.',
        lastObservedAt: observedAt, withdrawal: null,
        ...(forgotten && freshLabel ? { source: 'github-rest' as const, basis: { repositoryConfigured: true as const, issueState: 'open' as const, label: { ...freshLabel } },
          publication: { observedAt, completeness: 'complete' as const, associatedPullRequests: 0 as const,
            limitations: [`Predecessor ${forgotten.work_id} was forgotten (history deleted); only its minimal memory remained.`] } } : {}) },
      queue: { category: 'normal', sequence, pending: true },
      impediments: [{ code: 'DEPENDENCIES_NOT_EVALUATED', scope: 'work', since: at, nextStep: 'Native blocked_by evaluation must complete before any dispatch; the next polling round evaluates it.' }],
      dependencies: { latest: null, lastComplete: null }, execution: null, branch: null, pullRequest: null, previousExecutions: [], questions: [], inputs: { cursor: null }, admittedAt: at,
      budget: initialBudget(configured, previous.repository.repository, at), correction: null, pendingRecovery: null,
      history: [{ at, event: 'cycle-created', origin: 'local-cli', detail: `${input.request_id}:predecessor:${previous.work_id}:cycle:${previous.cycle + 1}${input.keepPredecessorPullRequest ? ':predecessor-pr-kept' : ''}` }],
    };
    index.admissionSequence = sequence;
    const entry = index.tickets[key!]!;
    index.tickets[key!] = { current: work_id, previous: [...entry.previous, entry.current] };
    index.order.push(work_id);
    rememberResult(index, document.work);
    if (!forgotten) history(previous, 'successor-created', 'local-cli', `${input.request_id}:${work_id}`, at);
    return receiptOf(input, previous.work_id, 'accepted', null, work_id);
  });
}

/**
 * Ticket 31: the predecessor facts `newCycleDecision` needs, from a forgotten cycle's minimal memory. `forget` required it ended (cessation
 * confirmed, no activity, no own PR left open), so nothing else is invented.
 */
function predecessorOf(memory: ForgottenWork): WorkRecord {
  const at = memory.forgottenAt;
  return { work_id: memory.work_id, cycle: memory.cycle, predecessor: memory.predecessor, ticket: copy(memory.ticket), repository: copy(memory.repository), result: memory.result,
    // Decision facts only (never copied into the new cycle: its authorization comes from the fresh read).
    authorization: { state: 'authorized', source: 'github-rest', observedAt: at, basis: { repositoryConfigured: true, issueState: 'open', label: memory.label ?? { id: 0, name: '' } },
      publication: { observedAt: at, completeness: 'complete', associatedPullRequests: 0, limitations: [] }, tracking: 'forgotten-memory' },
    cancellation: memory.result === 'cancelled' ? { request_id: memory.request_id, requestedAt: at, state: 'ceased', ceasedAt: at, executionId: null, nextStep: '' } : null,
    queue: { category: 'normal', sequence: memory.sequence, pending: false }, impediments: [], dependencies: { latest: null, lastComplete: null }, execution: null, branch: null,
    pullRequest: null, publication: null, previousExecutions: [], questions: [], inputs: { cursor: null }, budget: null, correction: null, pendingRecovery: null, admittedAt: at, history: [] };
}

/** One complete authorization read of a CURRENT open Work (cycle desk or dispatch revalidation). Unknown reads are never recorded as change. */
export async function recordAuthorization(session: Session, work_id: string, observed: { kind: 'authorized' } | { kind: 'withdrawn'; codes: string[] },
  readStartedAt?: string): Promise<'recorded' | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id) return 'stale' as const;
    const at = new Date().toISOString();
    const change = authorizationChange(work, observed, at, readStartedAt ?? at);
    removeImpediments(work, change.remove);
    for (const item of change.add) addImpediment(work, item);
    for (const event of change.events) history(work, event.event, 'controller-cycles', event.detail, at);
    work.authorization = { ...work.authorization, state: change.state, lastObservedAt: at, withdrawal: change.withdrawal };
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** Commit right before the reopen request is sent: an intent WITHOUT it provably never reached GitHub. */
async function beginReopen(session: Session, work_id: string, effectId: string): Promise<'sending' | 'stale'> {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const reopen = work?.closure?.reopen;
    if (!work || reopen?.effectId !== effectId || reopen.state !== 'intended' || reopen.sendingAt) return 'stale' as const;
    const at = new Date().toISOString();
    if (work.result !== 'closed-unmerged') {
      // Review LOW-MED: cancelled (or otherwise ended) before sending: provably never sent; settled, never sent later.
      Object.assign(reopen, { state: 'not-applied', attempt: { at, outcome: 'not-sent', code: work.result === 'cancelled' ? 'WORK_CANCELLED' : 'WORK_NOT_CLOSED_UNMERGED' }, settledAt: at });
      history(work, 'reopen-not-applied', 'controller-cycles', `${effectId}:not-sent:${work.result}`, at);
      return 'stale' as const;
    }
    reopen.sendingAt = at;
    return 'sending' as const;
  }, BACKGROUND_CONTEXT);
}

/** Records the attempt and/or the independent observation of a reopen; `open` confirms it (result open, RESUME_REQUIRED), `closed` settles it not applied. */
async function recordReopen(session: Session, work_id: string, effectId: string, input: { attempt?: { outcome: string; code: string | null }; observed?: 'open' | 'closed-unmerged' | 'other' }) {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, work_id, null)).work;
    const reopen = work?.closure?.reopen;
    if (!work || reopen?.effectId !== effectId || (reopen.state !== 'intended' && reopen.state !== 'attempted')) return 'stale' as const;
    const at = new Date().toISOString();
    if (input.attempt) {
      reopen.attempt = { at, ...input.attempt };
      reopen.state = 'attempted';
      history(work, 'reopen-attempted', 'controller-cycles', `${effectId}:${input.attempt.outcome}${input.attempt.code ? `:${input.attempt.code}` : ''}`, at);
    }
    if (input.observed === 'open' && work.result !== 'closed-unmerged') {
      // Review LOW-MED: sent, then the Work was cancelled: the effect is reconciled (confirmed); the cycle is NOT revived.
      Object.assign(reopen, { state: 'confirmed', observation: { at, outcome: 'open' }, settledAt: at });
      history(work, 'reopen-confirmed', 'controller-cycles', `${effectId}:${work.result}:cycle-not-revived`, at);
    } else if (input.observed === 'open' && work.result === 'closed-unmerged') {
      Object.assign(reopen, { state: 'confirmed', observation: { at, outcome: 'open' }, settledAt: at });
      work.result = 'open';
      removeImpediments(work, [cycleImpediments.closedUnmerged]);
      addImpediment(work, { code: cycleImpediments.resumeRequired, scope: 'work', since: at, nextStep: 'The own pull request is open again. Reopening grants no resume, scope or budget: ' +
        '`factory resume <work>` (current requirements re-read), then the usual commands (repair, update-scope, grant) decide any new activity.' });
      work.closure!.nextStep = 'Reopened and confirmed by observation; the Work stays suspended until `factory resume`.';
      history(work, 'reopen-confirmed', 'controller-cycles', effectId, at);
      rememberResult(index, work);
    } else if (input.observed === 'closed-unmerged' && reopen.attempt?.outcome === 'applied') {
      // Review MED (as ticket 16 MED 2): GitHub's applied response is the primary evidence; a contrary read may lag. Uncertain: re-read later.
      reopen.observation = { at, outcome: 'closed-unmerged-contradicting-applied' };
    } else if (input.observed === 'closed-unmerged' && (reopen.state === 'attempted' || reopen.sendingAt)) {
      // Sent (or possibly sent) and still closed: never resent implicitly; another `factory reopen` is a new decision.
      Object.assign(reopen, { state: 'not-applied', observation: { at, outcome: 'closed-unmerged' }, settledAt: at });
      work.closure!.nextStep = 'The reopen was not applied (still closed). Nothing is repeated automatically: inspect GitHub and decide (`factory reopen` again, or `factory cancel`).';
      history(work, 'reopen-not-applied', 'controller-cycles', effectId, at);
    }
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Ticket 25 cycle desk, in the existing owner loop (no daemon/scheduler), BEFORE the dispatcher tick: (1) a bounded number of complete Ticket
 * re-reads of current open Works, least recently observed first, recording withdrawal/restoration/confirmations; (2) the reopen effects the
 * operator intended: observe first (a human reopen needs no write), send at most once, then observe again and confirm.
 */
export function createCycleDesk(deps: { session: Session; access: AccessDependencies; readWorks(): Promise<WorkRecord[]>; stopped(): boolean; readsPerCycle?: number }) {
  const readsPerCycle = deps.readsPerCycle ?? 8;
  const configured = (repository: string) => deps.access.repositories.find(scope => scope.repository.toLowerCase() === repository.toLowerCase());
  const failures: { at: string; work_id: string; step: string }[] = [];
  const failed = (work_id: string, step: string) => { failures.push({ at: new Date().toISOString(), work_id, step }); failures.splice(0, Math.max(0, failures.length - 50)); };

  /** One read; returns the decision that was recorded (null when nothing could be concluded). */
  async function observeAuthorization(work: WorkRecord) {
    const scope = configured(work.repository.repository);
    let facts;
    const startedAt = new Date().toISOString();
    try { facts = await deps.access.tracker.readTicket(work.ticket); } catch { return null; }
    const observed = authorizationFacts({ configuredLabel: scope?.label, ticket: work.ticket, facts });
    if (observed.kind === 'unknown') return null;
    await recordAuthorization(deps.session, work.work_id, observed, startedAt);
    return observed;
  }
  async function observeOwn(work: WorkRecord) {
    const own = ownPullRequestOf(work);
    const scope = configured(work.repository.repository);
    if (!own || !scope || !deps.access.repository.readOwnMerge) return null;
    const read = await deps.access.repository.readOwnMerge({ repo: scope, repositoryId: work.repository.repositoryId, number: own.number, pullRequestId: own.pullRequestId, nodeId: own.nodeId })
      .catch(() => null);
    if (!read || read.kind !== 'observed') return null;
    const decision = decideMerge(own, { repositoryId: work.repository.repositoryId, branch: work.branch, base: work.repository.base }, read.pullRequest);
    return decision.outcome === 'open' || decision.outcome === 'closed-unmerged' ? decision.outcome : 'other' as const;
  }
  async function reopen(work: WorkRecord) {
    const effect = work.closure?.reopen;
    if (!effect) return;
    const observed = await observeOwn(work);
    if (observed === null) return; // nothing concluded: kept for a later cycle
    if (observed !== 'closed-unmerged' || effect.state === 'attempted' || effect.sendingAt) { await recordReopen(deps.session, work.work_id, effect.effectId, { observed }); return; }
    if (work.result !== 'closed-unmerged') { await beginReopen(deps.session, work.work_id, effect.effectId); return; } // settles it, nothing sent
    const scope = configured(work.repository.repository)!;
    const own = ownPullRequestOf(work)!;
    if (!deps.access.repository.reopenPullRequest) { await recordReopen(deps.session, work.work_id, effect.effectId, { attempt: { outcome: 'not-sent', code: 'REOPEN_NOT_COMPOSED' } }); return; }
    if (await beginReopen(deps.session, work.work_id, effect.effectId) !== 'sending') return; // re-checks cancellation in the sending commit
    const result = await deps.access.repository.reopenPullRequest({ repo: scope, number: own.number, nodeId: own.nodeId }, { effectId: effect.effectId })
      .catch(() => ({ kind: 'unknown' as const, code: 'REOPEN_UNAVAILABLE' }));
    await recordReopen(deps.session, work.work_id, effect.effectId, { attempt: { outcome: result.kind, code: 'code' in result ? result.code : null } });
    const after = await observeOwn(work);
    if (after !== null) await recordReopen(deps.session, work.work_id, effect.effectId, { observed: after });
  }

  return {
    view: () => ({ failures: [...failures] }),
    /** Never throws: the question desk and the dispatcher run after it in the same owner cycle. */
    async cycle() {
      if (deps.stopped()) return;
      let all: WorkRecord[];
      try { all = await deps.readWorks(); } catch { return; }
      const tracked = all.filter(work => work.result === 'open' && configured(work.repository.repository))
        .sort((a, b) => (a.authorization.lastObservedAt ?? '').localeCompare(b.authorization.lastObservedAt ?? ''));
      for (const work of tracked.slice(0, readsPerCycle)) {
        if (deps.stopped()) return;
        try { await observeAuthorization(work); } catch { failed(work.work_id, 'authorization'); }
      }
      for (const work of all.filter(item => (item.result === 'closed-unmerged' || item.result === 'cancelled') && (item.closure?.reopen?.state === 'intended' || item.closure?.reopen?.state === 'attempted'))) {
        if (deps.stopped()) return;
        try { await reopen(work); } catch { failed(work.work_id, 'reopen'); }
      }
    },
  };
}
