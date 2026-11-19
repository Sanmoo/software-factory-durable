import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { BootRef, EnvironmentRef } from '../../sandbox/index.js';
import type { ExecutionPorts, ExecutionView, RecoveryRecord, RecoveryView, RuntimeInventory, StartObservation } from '../types.js';
import type { QuestionObservation } from '../../workers/index.js';
import { blockedRequestReference } from '../../contracts/index.js';
import { classifyOverrun, overrunNotExcludedImpediment, timeoutImpediment } from '../rules/budget.js';
import { blockedRequestImpediment, blockedRequestToken, blockedStartImpediment, blockingStartRefusal, classifyInterruption, isBootCapacityRefusal, recoveryImpediment, reviewerRetryLimitCode, reviewerRetryLimitImpediment,
  startDecision } from '../rules/recovery.js';
import { applyBootDeferral } from './recovery-request.js';
import { interruptedEnd, questionRecordFound, recoveredQuestionDecision } from '../rules/questions.js';
import { readWork, ticketIndex, works, type WorkRecord } from './admission.js';
import { applyConfirmedCessation, consumeReservation, reofferUnlessCompleted, releaseReservation, settleCancelled, slots } from './execution.js';
import { intactRequest, questions, recordQuestionDocument } from './questions.js';
import { pendingReviewerReservations, settleReviewerReservations } from './review-recovery.js';
import type { Session } from './store.js';

// Ticket 26 (spec §5.2-5.4/§11.4): boot reconciliation of interrupted Executions — own survivors are stopped, never adopted; the start is
// established from durable evidence (receipt) only after the host confirmed cessation; capacity and budget follow the proven facts.

type Inventory = 'empty' | 'unknown' | RuntimeInventory;
/** Ticket 27: reads of the Records question facet per reconciliation while it is transiently unavailable. */
const questionObservationAttempts = 3;
type Cessation = RecoveryRecord['cessation'];
export type RecoveryDeps = { session: Session; ports: ExecutionPorts; controllerRunId: string; inventory: Inventory; live(executionId: string): boolean };

/** An Execution that still needs reconciliation: it may hold a Slot, a reservation or an activity whose cessation was never confirmed. */
export function unsettled(execution: ExecutionView | null | undefined): execution is ExecutionView {
  if (!execution || execution.state === 'released') return false;
  if (execution.state === 'ended') return execution.slot.held || execution.end?.cessation !== 'confirmed';
  return true;
}

const listedEnvironment = (inventory: Inventory, workId: string) =>
  typeof inventory === 'object' ? inventory.environments.find(item => item.workId === workId)?.environment ?? null : null;

/** The environment's current boot (published before any manager actuation) observed by the host; an active one is stopped, never adopted. */
async function observeCurrent(ports: ExecutionPorts['sandbox'], environment: EnvironmentRef, reason: string, prefix: string): Promise<Cessation> {
  if (!ports.observe) return { result: 'unconfirmed', basis: 'observe-not-composed', environment, boot: null };
  const observed = await ports.observe({ environment }).catch(() => null);
  if (!observed) return { result: 'unconfirmed', basis: 'observe-failed', environment, boot: null };
  if (observed.condition === 'not-booted') return { result: 'confirmed', basis: `${prefix}never-booted`, environment, boot: null };
  if (observed.cessationConfirmed) return { result: 'confirmed', basis: `${prefix}current-boot-${observed.condition}`, environment, boot: observed.boot ?? null };
  // Indeterminate: e.g. a preparation that never completed (its host subprocesses may have outlived the controller).
  if (!observed.boot) return { result: 'unconfirmed', basis: `${prefix}observed-${observed.condition}`, environment, boot: null };
  return stopBoot(ports, environment, observed.boot, reason);
}
async function stopBoot(ports: ExecutionPorts['sandbox'], environment: EnvironmentRef, boot: BootRef, reason: string): Promise<Cessation> {
  const stopped = await ports.stop({ environment, boot, reason }).catch(() => ({ status: 'indeterminate' as const, cessationConfirmed: false as const, code: 'STOP_UNAVAILABLE' }));
  return stopped.cessationConfirmed ? { result: 'confirmed', basis: 'sandbox-stop', environment, boot }
    : { result: 'unconfirmed', basis: `sandbox-stop:${'code' in stopped ? stopped.code : 'UNCONFIRMED'}`, environment, boot };
}

/**
 * Host cessation of the Execution's own activity (spec §5.4): boot/VMM/worker/subprocesses live in the boot's supervised group, so the
 * Sandbox host stop/observe path is the proof — never a PID, an abort, a closed channel or an expired token. Works without the old owner.
 * A preparation in flight (`reserved`) is never ASSUMED ceased: its host subprocesses run outside any supervised group, so cessation needs
 * the host evidence that none can still run — no own environment yet, or an environment observed complete (its disk work finished before
 * `ready`), and the repository's Git cache not left in preparation (its git commands run under the cache's own lock).
 */
export async function ceaseOwn(ports: ExecutionPorts['sandbox'], execution: ExecutionView, inventory: Inventory, work: Pick<WorkRecord, 'work_id' | 'repository'>, reason: string): Promise<Cessation> {
  const phase = execution.dispatch.phase;
  if (phase === 'reserved') {
    if (inventory === 'unknown') return { result: 'unconfirmed', basis: 'preparation:runtime-inventory-unknown', environment: null, boot: null };
    const cache = typeof inventory === 'object' ? inventory.cache.find(item => item.repositoryId === work.repository.repositoryId) : undefined;
    if (cache && cache.state !== 'idle') return { result: 'unconfirmed', basis: 'preparation:git-cache-not-reconciled', environment: null, boot: null };
    const listed = listedEnvironment(inventory, work.work_id) as EnvironmentRef | null;
    if (!listed) return { result: 'confirmed', basis: 'preparation:no-environment', environment: null, boot: null };
    return observeCurrent(ports, listed, reason, 'preparation:');
  }
  const environment = execution.dispatch.environment as EnvironmentRef | null;
  if (!environment) return { result: 'unconfirmed', basis: 'environment-not-recorded', environment: null, boot: null };
  const boot = execution.dispatch.boot as BootRef | null;
  // Start may have been in flight without its boot recorded: observe the environment's current boot.
  return boot ? stopBoot(ports, environment, boot, reason) : observeCurrent(ports, environment, reason, '');
}

/** Whether the start decision needs the receipt facet of Workers.observe (activation was requested, no start confirmed). */
const needsReceipt = (execution: ExecutionView) => !execution.start && !['reserved', 'prepared', 'booted'].includes(execution.dispatch.phase);

export async function observeReceipt(ports: ExecutionPorts, workId: string, execution: ExecutionView): Promise<StartObservation | null> {
  if (!ports.workers.observeStart) return null;
  return ports.workers.observeStart({ workId, executionId: execution.executionId, invocationId: execution.invocationId })
    .catch(() => ({ kind: 'uncertain' as const, code: 'START_OBSERVATION_FAILED' }));
}

const addImpediment = (work: WorkRecord, impediment: WorkRecord['impediments'][number]) => {
  if (!work.impediments.some(item => item.code === impediment.code)) work.impediments.push(impediment);
};

/** A start discovered after the fact was not measured by any live clock: its duration is a lower bound and an overrun cannot be excluded. */
function boundDiscoveredDuration(work: WorkRecord, execution: ExecutionView, recordedAt: string, now: string) {
  const timing = execution.timing;
  if (!timing || timing.duration) return;
  timing.startedAt ??= recordedAt;
  const estimate = Date.parse(now) - Date.parse(timing.startedAt);
  const provenMs = timing.lastActivity?.elapsedMs ?? 0;
  timing.duration = { kind: 'lower-bound', provenMs, calendarEstimateMs: Number.isFinite(estimate) && estimate >= 0 ? estimate : null, reconciledAt: now };
  const overrun = classifyOverrun({ timeoutSeconds: timing.timeoutSeconds, measuredMs: null, lowerBoundMs: provenMs });
  timing.overrun = overrun;
  if (overrun === 'proven') {
    timing.timeout ??= { reachedAt: now, elapsedMs: provenMs, evidence: 'lower-bound' };
    addImpediment(work, timeoutImpediment(timing.timeoutSeconds!, now, 'lower-bound'));
  } else if (overrun === 'not-excludable') addImpediment(work, overrunNotExcludedImpediment(timing.timeoutSeconds!, now));
  work.history.push({ at: now, event: 'duration-reconciled', origin: 'controller-clock', executionId: execution.executionId, detail: `lower-bound:${provenMs}ms:${overrun}` });
}

/**
 * ONE commit settling an interrupted Execution after the host observation (spec §3.4 "Confirmar efeito/cessação"): the recorded old evidence
 * is incorporated explicitly; a complete receipt confirms the start and its single consumption; proven non-start releases the reservation; an
 * uncertain start keeps it; the Slot is released only with confirmed cessation; a transient failure becomes ONE operational recovery.
 */
export async function settleInterruption(session: Session, input: { work_id: string; executionId: string; cessation: Cessation; observation: StartObservation | null;
  trigger: RecoveryRecord['trigger']; controllerRunId: string;
  /** Ticket 28: receipt observations of reviewer retry attempts whose recoveries reservation is outstanding (by invocation). */
  reviewerReceipts?: Record<string, StartObservation>;
  /** Ticket 27: the Builder's preserved `ask_user` request of this invocation (Records), when its notification/ACK may have been lost. */
  question?: QuestionObservation | null }): Promise<RecoveryRecord['decision'] | 'stale'> {
  return session.commit(async tx => {
    const document = await tx.doc(works, input.work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== input.executionId || !unsettled(execution)) return 'stale' as const;
    const now = new Date().toISOString();
    let questionNote: string | null = input.question ? input.question.kind === 'question' ? `found:${input.question.request.questionId}` : input.question.kind === 'absent' ? 'absent'
      : `${questionRecordFound(input.question.code) ? 'found' : 'unresolved'}:${input.question.code}` : null;
    const found: RecoveryRecord['found'] = { state: execution.state, phase: execution.dispatch.phase, held: execution.held?.code ?? null,
      end: execution.end ? `${execution.end.outcome}:${execution.end.code ?? ''}` : null, origin: execution.timing?.origin ?? null };
    const record = (start: RecoveryRecord['start'], decision: RecoveryRecord['decision'], code: string | null) => {
      // Assigned as a new array: a doc value assigned then mutated in place is not what the commit persists.
      execution.recovery = [...(execution.recovery ?? []), { at: now, controllerRunId: input.controllerRunId, trigger: input.trigger, found, cessation: input.cessation, start, decision, code,
        ...(questionNote ? { question: questionNote } : {}) }];
      work.history.push({ at: now, event: 'execution-reconciled', origin: 'controller-recovery', executionId: execution.executionId,
        detail: `${decision}${code ? `:${code}` : ''}; cessation ${input.cessation.result} (${input.cessation.basis}); start ${start.kind}` });
      // Ticket 25: a cancelled Work is never requeued by its reconciliation; its cancellation ceases once nothing of it can act.
      settleCancelled(work, now);
      return decision;
    };
    const preActivation = ['reserved', 'prepared', 'booted'].includes(execution.dispatch.phase) && !execution.start;
    if (input.cessation.result !== 'confirmed') {
      // Local uncertainty: this Work keeps its Slot and is blocked; independents with proven capacity may proceed. Before the activation
      // request no worker can have started, so only that case releases the reservation (proven non-start); otherwise it is kept.
      addImpediment(work, recoveryImpediment('RECOVERY_CESSATION_UNCONFIRMED', input.cessation.basis, now));
      if (preActivation) releaseReservation(work, execution, now);
      if (execution.state !== 'ended' && execution.state !== 'held') {
        execution.state = 'held';
        execution.held = { code: 'RECOVERY_CESSATION_UNCONFIRMED', phase: execution.dispatch.phase, at: now, nextStep: 'Cessation of the own activity is not confirmed; no substitute starts.' };
      }
      return record({ kind: preActivation ? 'not-started' : 'uncertain', detail: 'cessation-unconfirmed' }, 'kept', 'RECOVERY_CESSATION_UNCONFIRMED');
    }
    // This boot's host evidence confirms the cessation: an earlier unconfirmed-cessation block is lifted (the evidence is in `recovery[]`).
    work.impediments = work.impediments.filter(item => item.code !== 'RECOVERY_CESSATION_UNCONFIRMED');
    // Ticket 28: an outstanding reviewer retry reservation follows the same start evidence — a receipt consumes it once, a complete listing
    // without one releases it; an uncertain start keeps it and blocks the Work for a decision (never consumed or released by guess).
    const reviewerSettlement = settleReviewerReservations(work, execution, { cessation: 'confirmed', receipt: invocationId => {
      const seen = input.reviewerReceipts?.[invocationId];
      if (seen?.kind === 'receipt') return seen.receipt.invocationId === invocationId && seen.receipt.executionId === execution.executionId
        ? { kind: 'receipt', id: seen.receipt.id } : { kind: 'uncertain', code: 'START_RECEIPT_MISMATCH' };
      return seen?.kind === 'absent' ? { kind: 'absent' } : { kind: 'uncertain', code: seen?.kind === 'uncertain' ? seen.code : 'START_RECEIPT_OBSERVATION_NOT_COMPOSED' };
    } });
    const keptReviewer = reviewerSettlement.find(item => item.outcome === 'kept');
    if (keptReviewer) addImpediment(work, recoveryImpediment('RECOVERY_START_UNCERTAIN', `reviewer retry ${keptReviewer.invocationId}`, now));
    const observed = input.observation;
    // A discovered receipt must be THIS Execution's (identity of the invocation the Control reserved), never another one's.
    const matching = observed?.kind === 'receipt' && observed.receipt.workId === input.work_id && observed.receipt.executionId === execution.executionId &&
      observed.receipt.invocationId === execution.invocationId;
    let start = startDecision({ confirmed: execution.start, phase: execution.dispatch.phase, cessation: 'confirmed',
      observation: observed === null ? null : observed.kind === 'receipt' ? (matching ? { kind: 'receipt', receiptId: observed.receipt.id } : { kind: 'uncertain', code: 'START_RECEIPT_MISMATCH' })
        : observed.kind === 'absent' ? { kind: 'absent' } : { kind: 'uncertain', code: observed.code } });
    // Ticket 27: a preserved ask_user request (or a found record) proves a worker ran: never "not started" by the missing receipt alone.
    const askedEvidence = input.question?.kind === 'question' || (input.question?.kind === 'uncertain' && questionRecordFound(input.question.code));
    if (start.kind === 'not-started' && askedEvidence) start = { kind: 'uncertain', code: 'QUESTION_WITHOUT_START_RECEIPT' };
    const occupancy = await tx.doc(slots);
    if (start.kind === 'not-started') {
      // Cessation confirmed and nothing started: Slot and reservation free, the Work keeps its queue position.
      delete occupancy.held[execution.executionId];
      execution.slot = { ...execution.slot, held: false, releasedAt: now };
      releaseReservation(work, execution, now);
      const code = execution.held?.code ?? null;
      execution.state = 'released';
      execution.held ??= { code: 'INTERRUPTED_BEFORE_START', phase: execution.dispatch.phase, at: now, nextStep: `No worker started (${start.basis}); the reservation was released without consumption.` };
      work.queue = { ...work.queue, pending: true };
      work.history.push({ at: now, event: 'slot-released', origin: 'controller-dispatch', executionId: execution.executionId });
      const classified = classifyInterruption(code);
      if (classified.kind === 'blocking') {
        // Ticket 50: a refused boot/preparation keeps its code and the Sandbox's detail, with the explicit operator retry as its exit.
        if (blockingStartRefusal(classified.code)) {
          const detail = execution.held?.detail ?? null;
          execution.blockedStart = { code: classified.code, detail, at: now, cessation: input.cessation.result, retry: null };
          addImpediment(work, blockedStartImpediment(work.work_id, classified.code, detail, now));
        } else addImpediment(work, recoveryImpediment('RECOVERY_BLOCKED', classified.code, now));
        return record({ kind: 'not-started', detail: start.basis }, 'blocked', classified.code);
      }
      // Ticket 50: lack of host memory/storage passes on its own: same queue position behind a persisted capacity wait, nothing charged.
      if (isBootCapacityRefusal(code)) applyBootDeferral(work, { executionId: execution.executionId, code: code!, at: now });
      return record({ kind: 'not-started', detail: start.basis }, 'requeued', code);
    }
    if (start.kind === 'uncertain') {
      // The reservation stays (never consumed or released by guess); the capacity is free (cessation confirmed); blocked for a decision.
      if (execution.state !== 'ended' || !execution.end) {
        execution.state = 'ended';
        execution.end = { at: now, outcome: 'failure', code: start.code, cessation: 'confirmed' };
        reofferUnlessCompleted(work, execution.executionId, 'failure', now);
      }
      execution.end.cessation = 'confirmed';
      execution.dispatch.phase = 'stopped';
      delete occupancy.held[execution.executionId];
      execution.slot = { ...execution.slot, held: false, releasedAt: now };
      work.history.push({ at: now, event: 'slot-released', origin: 'controller-dispatch', executionId: execution.executionId });
      addImpediment(work, recoveryImpediment('RECOVERY_START_UNCERTAIN', start.code, now));
      return record({ kind: 'uncertain', detail: start.code }, 'blocked', start.code);
    }
    if (start.source === 'receipt-discovered') {
      // "Recibo completo sincronizado confirma início e consumo único mesmo sem notificação".
      execution.start = { receiptId: start.receiptId, confirmedAt: now };
      work.history.push({ at: now, event: 'execution-started', origin: 'controller-dispatch', executionId: execution.executionId, detail: `${start.receiptId}:receipt-discovered` });
      consumeReservation(work, execution, now);
      boundDiscoveredDuration(work, execution, observed?.kind === 'receipt' ? observed.recordedAt : now, now);
    }
    const startRecord: RecoveryRecord['start'] = { kind: 'confirmed', detail: `${start.source}:${start.receiptId}` };
    settleInterruptedReviews(execution, now);
    let decision: RecoveryRecord['decision'];
    let code: string | null;
    if (execution.state === 'ended' && execution.end) {
      // The end was recorded earlier (with ticket 11's scope handling) but its cessation was not confirmed then.
      code = execution.end.outcome === 'failure' ? execution.end.code ?? 'CONTROLLER_CRASH' : execution.end.outcome;
      decision = execution.end.outcome === 'stopped' ? 'administrative-continuation' : execution.end.outcome === 'failure' ? 'operational-recovery' : 'settled';
    } else {
      // A Question recorded by this Execution (durable before its ACK) is the end: the Work waits for its answer, never a recovery.
      let questionId: string | null = null;
      for (const id of work.questions ?? []) {
        const question = (await tx.doc(questions, id, null)).question;
        if (question?.executionId === execution.executionId && question.workId === work.work_id) { questionId = id; break; }
      }
      // Ticket 27 (spec §5.5 "ACK perdido recupera ... solicitação íntegra com mesma identidade; conteúdo perdido bloqueia"): ONLY a positive
      // finding of the request the worker preserved changes the ordinary path. An intact one the Control never recorded is recorded NOW with
      // its own identity and content (unless it was refused live: that refusal stands); a found record that is not intact blocks (nothing
      // invented); a transient read failure keeps the ordinary recovery (noted in recovery[]).
      let lostQuestion: string | null = null;
      let lostRecords: { questionId: string | null; records: string[] } = { questionId: null, records: [] };
      let recovered = false;
      if (!questionId && input.question) {
        const seen = input.question;
        const document = seen.kind === 'question' ? await tx.doc(questions, seen.request.questionId, null) : null;
        const known = document?.question ?? null;
        const decided = recoveredQuestionDecision({ workId: work.work_id, executionId: execution.executionId,
          observation: seen.kind === 'question' ? { kind: 'question', questionId: seen.request.questionId, sha256: seen.request.sha256, intact: intactRequest(seen.request, work.work_id),
            refused: execution.questionRefusals?.find(item => item.questionId === seen.request.questionId)?.code ?? null } : seen,
          existing: known ? { workId: known.workId, executionId: known.executionId, sha256: known.content.sha256 } : null, result: work.result });
        if (seen.kind === 'question') lostRecords = { questionId: seen.request.questionId, records: [seen.request.reference.id] };
        if (decided.kind === 'block') lostQuestion = decided.code;
        else if (decided.kind === 'skip') questionNote = `not-recorded:${decided.code}`;
        else if (decided.kind === 'honor-refusal') questionNote = `refused-live:${decided.code}`;
        else if (decided.kind === 'bind') questionId = known!.questionId;
        else if (decided.kind === 'record' && seen.kind === 'question') {
          const recorded = recordQuestionDocument(document!, work, { executionId: execution.executionId, invocationId: execution.invocationId, request: seen.request,
            from: 'records-recovery', now });
          if (recorded.kind !== 'refused') { questionId = seen.request.questionId; recovered = true; questionNote = `recorded:${questionId}`; } else lostQuestion = recorded.code;
        }
      }
      const ended = interruptedEnd({ questionId, recovered, trigger: input.trigger, blocked: lostQuestion, heldCode: execution.held?.code ?? null });
      // Ticket 41: when the chosen end IS the block, the lost request keeps a stable reference, the one an explicit operator override must name
      // (nothing of it is reconstructed). An earlier operator decision on this Execution is never replaced.
      if (lostQuestion && ended.outcome === 'failure' && ended.code === lostQuestion && !execution.blockedRequest?.override) {
        execution.blockedRequest = { reference: blockedRequestReference(blockedRequestToken({ invocationId: execution.invocationId, records: lostRecords.records,
          executionId: execution.executionId }), lostQuestion), code: lostQuestion, ...lostRecords, at: now, override: null };
      }
      const outcome = ended.outcome;
      code = outcome === 'question' ? 'question' : ended.code ?? 'CONTROLLER_CRASH';
      execution.state = 'ended';
      execution.end = { at: now, outcome, code: outcome === 'question' ? null : code, cessation: 'confirmed', ...(ended.questionId ? { questionId: ended.questionId } : {}) };
      reofferUnlessCompleted(work, execution.executionId, outcome, now);
      decision = outcome === 'stopped' ? 'administrative-continuation' : outcome === 'failure' ? 'operational-recovery' : 'settled';
    }
    // Shared with the live release (ticket 11 scope consumption/requeue, question/timeout/stop positions, ONE operational recovery).
    applyConfirmedCessation(work, execution, occupancy);
    if (execution.end.outcome === 'failure') {
      const classified = classifyInterruption(execution.end.code);
      // Ticket 41 (idempotence): a block the operator already overrode is never re-blocked by a later settlement; its recovery stays pending.
      if (classified.kind === 'blocking' && execution.blockedRequest?.override && execution.blockedRequest.code === classified.code) {
        return record(startRecord, 'operational-recovery', classified.code);
      }
      if (classified.kind === 'blocking') {
        const lost = execution.blockedRequest && !execution.blockedRequest.override && execution.blockedRequest.code === classified.code ? execution.blockedRequest : null;
        // Ticket 51: REVIEWER_RETRY_LIMIT names its two operator decisions (new review round, cancel).
        addImpediment(work, lost ? blockedRequestImpediment(work.work_id, lost.reference, lost.code, now) : classified.code === reviewerRetryLimitCode
          ? reviewerRetryLimitImpediment(work.work_id, now) : recoveryImpediment('RECOVERY_BLOCKED', classified.code, now));
        return record(startRecord, 'blocked', classified.code);
      }
    }
    return record(startRecord, decision, code);
  }, BACKGROUND_CONTEXT);
}

/**
 * Reviewers share the Execution's boot (spec §5.6): its confirmed cessation is theirs. A round interrupted before both opinions were incorporated
 * keeps every complete opinion already recorded; a reviewer still requested/started is recorded failed (`EXECUTION_INTERRUPTED`, cessation
 * `boot-ceased`) — never adopted, re-delivered or concluded green. Partial recovery of a round is ticket 28; the Work recovers through the queue.
 */
function settleInterruptedReviews(execution: ExecutionView, now: string) {
  for (const round of execution.review?.rounds ?? []) {
    if (round.state !== 'reviewing') continue;
    for (const reviewer of Object.values(round.reviewers)) {
      if (reviewer.state === 'requested' || reviewer.state === 'started' || reviewer.cessation === 'unconfirmed') {
        Object.assign(reviewer, { state: reviewer.state === 'ended' ? reviewer.state : 'failed', endedAt: reviewer.endedAt ?? now,
          failure: reviewer.failure ?? { code: 'EXECUTION_INTERRUPTED' }, cessation: 'boot-ceased' });
      }
    }
    if (!round.reasons.includes('EXECUTION_INTERRUPTED')) round.reasons = [...round.reasons, 'EXECUTION_INTERRUPTED'];
  }
}

/** Cessation + receipt observation + settlement of ONE interrupted Execution (boot reconciliation or an administrative stop before its start). */
export async function reconcileExecution(deps: Omit<RecoveryDeps, 'live'>, work: WorkRecord, trigger: RecoveryRecord['trigger'], cessation?: Cessation) {
  const execution = work.execution!;
  const ceased = cessation ?? await ceaseOwn(deps.ports.sandbox, execution, deps.inventory, work, 'controller recovery: own survivor stopped, not adopted');
  const observation = ceased.result === 'confirmed' && needsReceipt(execution) ? await observeReceipt(deps.ports, work.work_id, execution) : null;
  // Ticket 28: the start receipt of each reviewer retry still holding a recoveries reservation (only after confirmed cessation).
  const reviewerReceipts: Record<string, StartObservation> = {};
  if (ceased.result === 'confirmed' && deps.ports.workers.observeStart) {
    for (const pending of pendingReviewerReservations(execution).slice(0, 8)) {
      reviewerReceipts[pending.invocationId] = await deps.ports.workers.observeStart({ workId: work.work_id, executionId: execution.executionId, invocationId: pending.invocationId })
        .catch(() => ({ kind: 'uncertain' as const, code: 'START_OBSERVATION_FAILED' }));
    }
  }
  // Ticket 27: the Builder's preserved ask_user request (only after confirmed cessation, when no end was recorded: a lost notification/ACK).
  // A 'booted' phase is observed too: a lost start receipt never hides a preserved question. Transient read failures are retried (bounded).
  let asked: QuestionObservation | null = null;
  if (ceased.result === 'confirmed' && !execution.end && deps.ports.workers.observeQuestion && !['reserved', 'prepared'].includes(execution.dispatch.phase)) {
    for (let attempt = 0; attempt < questionObservationAttempts; attempt++) {
      asked = await deps.ports.workers.observeQuestion({ workId: work.work_id, executionId: execution.executionId, invocationId: execution.invocationId })
        .catch(() => ({ kind: 'uncertain' as const, code: 'QUESTION_OBSERVATION_FAILED' }));
      if (asked.kind !== 'uncertain' || questionRecordFound(asked.code)) break;
    }
  }
  return { cessation: ceased, decision: await settleInterruption(deps.session, { work_id: work.work_id, executionId: execution.executionId, cessation: ceased, observation,
    trigger, controllerRunId: deps.controllerRunId, reviewerReceipts, question: asked }) };
}

/**
 * Boot reconciliation (spec §5.2 steps 3-5) with the dispatch barrier still closed: every interrupted Execution of the authority, then a sweep of
 * the listed own environments (a survivor of a settled Work is stopped, never adopted), unknown resources and Slots without a current
 * Execution. Returns what keeps dispatch globally closed and the repositories whose host Git cache was being prepared.
 */
export async function reconcileBoot(deps: RecoveryDeps): Promise<RecoveryView> {
  const at = new Date().toISOString();
  const index = await deps.session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  const known = new Map<string, WorkRecord>();
  let reconciled = 0, ceased = 0, unconfirmed = 0;
  for (const id of index?.order ?? []) {
    const work = await readWork(deps.session, id) ?? null;
    if (!work) continue;
    known.set(id, work);
    if (!unsettled(work.execution) || deps.live(work.execution.executionId)) continue;
    const { cessation } = await reconcileExecution(deps, work, 'boot');
    reconciled++;
    if (cessation.result === 'confirmed') ceased++; else unconfirmed++;
  }
  const global: string[] = [];
  const listed = typeof deps.inventory === 'object' ? deps.inventory : null;
  for (const entry of listed?.environments ?? []) {
    const owner = entry.workId ? known.get(entry.workId) : undefined;
    if (!owner) { global.push(`UNKNOWN_RESOURCE:environment:${entry.environment}`); continue; }
    const current = await readWork(deps.session, owner.work_id) ?? owner;
    if (unsettled(current.execution)) continue; // its reconciliation above kept the Work's Slot/impediment
    if (!deps.ports.sandbox.observe) { global.push(`ENVIRONMENT_OBSERVATION_NOT_COMPOSED:${entry.environment}`); continue; }
    const environment = entry.environment as EnvironmentRef;
    const observed = await deps.ports.sandbox.observe({ environment }).catch(() => null);
    if (observed?.cessationConfirmed) continue;
    // An active own boot without a current Execution is a survivor: stopped, never adopted. Unconfirmed activity is never free capacity.
    const stopped = observed?.boot ? await deps.ports.sandbox.stop({ environment, boot: observed.boot, reason: 'controller recovery: survivor without Execution stopped' })
      .catch(() => null) : null;
    if (stopped?.cessationConfirmed) { ceased++; continue; }
    global.push(`UNACCOUNTED_ACTIVITY:${entry.environment}`);
  }
  for (const item of listed?.unknown ?? []) global.push(`UNKNOWN_RESOURCE:${item}`);
  for (const item of listed?.cache ?? []) if (item.repositoryId === null && item.state !== 'idle') global.push('UNKNOWN_RESOURCE:cache');
  const occupancy = await deps.session.snapshot(slots, BACKGROUND_CONTEXT);
  for (const [executionId, workId] of Object.entries(occupancy?.held ?? {})) {
    const execution = (await readWork(deps.session, workId))?.execution;
    if (execution?.executionId !== executionId || !execution.slot.held) global.push(`SLOT_WITHOUT_CURRENT_EXECUTION:${executionId}`);
  }
  return { at, inventory: typeof deps.inventory === 'object' ? 'listed' : deps.inventory, reconciled, ceased, unconfirmed, global,
    cachePreparing: (listed?.cache ?? []).filter(item => item.state !== 'idle').map(item => item.repositoryId),
    cache: (listed?.cache ?? []).filter(item => item.state !== 'idle').map(item => ({ repositoryId: item.repositoryId, state: item.state, nextStep: item.nextStep ?? null })) };
}
