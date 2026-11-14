import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { BootRef, EnvironmentRef } from '../../sandbox/index.js';
import type { ExecutionPorts, ExecutionView, RecoveryRecord, RecoveryView, RuntimeInventory, StartObservation } from '../types.js';
import { classifyOverrun, overrunNotExcludedImpediment, timeoutImpediment } from '../rules/budget.js';
import { classifyInterruption, recoveryImpediment, startDecision } from '../rules/recovery.js';
import { readWork, ticketIndex, works, type WorkRecord } from './admission.js';
import { consumeReservation, releaseReservation, slots } from './execution.js';
import { questions } from './questions.js';
import { applyRecoveryRequest } from './recovery-request.js';
import type { Session } from './store.js';

// Ticket 26 (spec §5.2-5.4/§11.4): boot reconciliation of interrupted Executions — own survivors are stopped, never adopted; the start is
// established from durable evidence (receipt) only after the host confirmed cessation; capacity and budget follow the proven facts.

type Inventory = 'empty' | 'unknown' | RuntimeInventory;
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

/**
 * Host cessation of the Execution's own activity (spec §5.4): boot/VMM/worker/subprocesses live in the boot's supervised group, so the
 * Sandbox host stop/observe path is the proof — never a PID, an abort, a closed channel or an expired token. Works without the old owner.
 */
export async function ceaseOwn(ports: ExecutionPorts['sandbox'], execution: ExecutionView, inventory: Inventory, workId: string, reason: string): Promise<Cessation> {
  const phase = execution.dispatch.phase;
  // Preparation is recorded BEFORE any start: an Execution still at `reserved` never booted anything (host subprocesses of an interrupted
  // preparation are covered by the Sandbox's own non-adoption and, for the Git cache, by the cache inventory).
  if (phase === 'reserved') return { result: 'confirmed', basis: 'no-boot-before-preparation-recorded', environment: listedEnvironment(inventory, workId), boot: null };
  const environment = execution.dispatch.environment as EnvironmentRef | null;
  if (!environment) return { result: 'unconfirmed', basis: 'environment-not-recorded', environment: null, boot: null };
  let boot = execution.dispatch.boot as BootRef | null;
  if (!boot) {
    // Start may have been in flight: the environment's current boot (published before any manager actuation) tells what could run.
    if (!ports.observe) return { result: 'unconfirmed', basis: 'observe-not-composed', environment, boot: null };
    const observed = await ports.observe({ environment }).catch(() => null);
    if (!observed) return { result: 'unconfirmed', basis: 'observe-failed', environment, boot: null };
    if (observed.condition === 'not-booted') return { result: 'confirmed', basis: 'never-booted', environment, boot: null };
    if (observed.cessationConfirmed) return { result: 'confirmed', basis: `current-boot-${observed.condition}`, environment, boot: observed.boot ?? null };
    if (!observed.boot) return { result: 'unconfirmed', basis: `observed-${observed.condition}`, environment, boot: null };
    boot = observed.boot;
  }
  const stopped = await ports.stop({ environment, boot, reason }).catch(() => ({ status: 'indeterminate' as const, cessationConfirmed: false as const, code: 'STOP_UNAVAILABLE' }));
  return stopped.cessationConfirmed ? { result: 'confirmed', basis: 'sandbox-stop', environment, boot }
    : { result: 'unconfirmed', basis: `sandbox-stop:${'code' in stopped ? stopped.code : 'UNCONFIRMED'}`, environment, boot };
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
  trigger: RecoveryRecord['trigger']; controllerRunId: string }): Promise<RecoveryRecord['decision'] | 'stale'> {
  return session.commit(async tx => {
    const document = await tx.doc(works, input.work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== input.executionId || !unsettled(execution)) return 'stale' as const;
    const now = new Date().toISOString();
    const found: RecoveryRecord['found'] = { state: execution.state, phase: execution.dispatch.phase, held: execution.held?.code ?? null,
      end: execution.end ? `${execution.end.outcome}:${execution.end.code ?? ''}` : null, origin: execution.timing?.origin ?? null };
    const record = (start: RecoveryRecord['start'], decision: RecoveryRecord['decision'], code: string | null) => {
      (execution.recovery ??= []).push({ at: now, controllerRunId: input.controllerRunId, trigger: input.trigger, found, cessation: input.cessation, start, decision, code });
      work.history.push({ at: now, event: 'execution-reconciled', origin: 'controller-recovery', executionId: execution.executionId,
        detail: `${decision}${code ? `:${code}` : ''}; cessation ${input.cessation.result} (${input.cessation.basis}); start ${start.kind}` });
      return decision;
    };
    if (input.cessation.result !== 'confirmed') {
      // Local uncertainty: this Work keeps its Slot and reservation and is blocked; independents with proven capacity may proceed.
      addImpediment(work, recoveryImpediment('RECOVERY_CESSATION_UNCONFIRMED', input.cessation.basis, now));
      if (execution.state !== 'ended' && execution.state !== 'held') {
        execution.state = 'held';
        execution.held = { code: 'RECOVERY_CESSATION_UNCONFIRMED', phase: execution.dispatch.phase, at: now, nextStep: 'Cessation of the own boot is not confirmed; no substitute starts.' };
      }
      return record({ kind: 'uncertain', detail: 'cessation-unconfirmed' }, 'kept', 'RECOVERY_CESSATION_UNCONFIRMED');
    }
    const observed = input.observation;
    // A discovered receipt must be THIS Execution's (identity of the invocation the Control reserved), never another one's.
    const matching = observed?.kind === 'receipt' && observed.receipt.workId === input.work_id && observed.receipt.executionId === execution.executionId &&
      observed.receipt.invocationId === execution.invocationId;
    const start = startDecision({ confirmed: execution.start, phase: execution.dispatch.phase, cessation: 'confirmed',
      observation: observed === null ? null : observed.kind === 'receipt' ? (matching ? { kind: 'receipt', receiptId: observed.receipt.id } : { kind: 'uncertain', code: 'START_RECEIPT_MISMATCH' })
        : observed.kind === 'absent' ? { kind: 'absent' } : { kind: 'uncertain', code: observed.code } });
    // Cessation confirmed: the capacity is free whatever the start decision.
    const occupancy = await tx.doc(slots);
    delete occupancy.held[execution.executionId];
    execution.slot = { ...execution.slot, held: false, releasedAt: now };
    if (start.kind === 'not-started') {
      releaseReservation(work, execution, now);
      const code = execution.held?.code ?? null;
      execution.state = 'released';
      execution.held ??= { code: 'INTERRUPTED_BEFORE_START', phase: execution.dispatch.phase, at: now, nextStep: `No worker started (${start.basis}); the reservation was released without consumption.` };
      work.queue = { ...work.queue, pending: true };
      work.history.push({ at: now, event: 'slot-released', origin: 'controller-dispatch', executionId: execution.executionId });
      const classified = classifyInterruption(code);
      if (classified.kind === 'blocking') {
        addImpediment(work, recoveryImpediment('RECOVERY_BLOCKED', classified.code, now));
        return record({ kind: 'not-started', detail: start.basis }, 'blocked', classified.code);
      }
      return record({ kind: 'not-started', detail: start.basis }, 'requeued', code);
    }
    execution.dispatch.phase = 'stopped';
    if (start.kind === 'uncertain') {
      // The reservation stays (never consumed or released by guess); the Work is blocked for an explicit decision.
      if (execution.state === 'ended' && execution.end) execution.end.cessation = 'confirmed';
      else { execution.state = 'ended'; execution.end = { at: now, outcome: 'failure', code: start.code, cessation: 'confirmed' }; }
      addImpediment(work, recoveryImpediment('RECOVERY_START_UNCERTAIN', start.code, now));
      work.history.push({ at: now, event: 'slot-released', origin: 'controller-dispatch', executionId: execution.executionId });
      return record({ kind: 'uncertain', detail: start.code }, 'blocked', start.code);
    }
    if (start.source === 'receipt-discovered') {
      // "Recibo completo sincronizado confirma início e consumo único mesmo sem notificação".
      execution.start = { receiptId: start.receiptId, confirmedAt: now };
      work.history.push({ at: now, event: 'execution-started', origin: 'controller-dispatch', executionId: execution.executionId, detail: `${start.receiptId}:receipt-discovered` });
      consumeReservation(work, execution, now);
      boundDiscoveredDuration(work, execution, observed?.kind === 'receipt' ? observed.recordedAt : now, now);
    }
    work.history.push({ at: now, event: 'slot-released', origin: 'controller-dispatch', executionId: execution.executionId });
    const startRecord: RecoveryRecord['start'] = { kind: 'confirmed', detail: `${start.source}:${start.receiptId}` };
    if (execution.state === 'ended' && execution.end) {
      // The end was recorded earlier but the cessation was not confirmed then: only the cessation is settled now.
      execution.end.cessation = 'confirmed';
      const outcome = execution.end.outcome;
      if (outcome === 'question' || outcome === 'timeout' || outcome === 'stopped') work.queue = { ...work.queue, pending: true };
      if (outcome === 'failure') return settleFailure(work, execution, execution.end.code ?? 'CONTROLLER_CRASH', now, startRecord, record);
      return record(startRecord, outcome === 'stopped' ? 'administrative-continuation' : 'settled', outcome);
    }
    // A Question recorded by this Execution (durable before its ACK) is the end: the Work waits for its answer, never a recovery.
    for (const id of work.questions ?? []) {
      const question = (await tx.doc(questions, id, null)).question;
      if (question?.executionId !== execution.executionId || question.workId !== work.work_id) continue;
      execution.state = 'ended';
      execution.end = { at: now, outcome: 'question', code: null, cessation: 'confirmed', questionId: id };
      work.queue = { ...work.queue, pending: true };
      return record(startRecord, 'settled', 'question');
    }
    execution.state = 'ended';
    if (input.trigger === 'administrative-stop') {
      execution.end = { at: now, outcome: 'stopped', code: 'ADMINISTRATIVE_STOP', cessation: 'confirmed' };
      work.queue = { ...work.queue, pending: true };
      return record(startRecord, 'administrative-continuation', 'ADMINISTRATIVE_STOP');
    }
    const code = execution.held?.code ?? 'CONTROLLER_CRASH';
    execution.end = { at: now, outcome: 'failure', code, cessation: 'confirmed' };
    return settleFailure(work, execution, code, now, startRecord, record);
  }, BACKGROUND_CONTEXT);
}

function settleFailure(work: WorkRecord, execution: ExecutionView, code: string, now: string, start: RecoveryRecord['start'],
  record: (start: RecoveryRecord['start'], decision: RecoveryRecord['decision'], code: string | null) => RecoveryRecord['decision']) {
  const classified = classifyInterruption(code);
  if (classified.kind === 'blocking') {
    addImpediment(work, recoveryImpediment('RECOVERY_BLOCKED', classified.code, now));
    return record(start, 'blocked', classified.code);
  }
  applyRecoveryRequest(work, { executionId: execution.executionId, code, at: now });
  return record(start, 'operational-recovery', code);
}

/** Cessation + receipt observation + settlement of ONE interrupted Execution (boot reconciliation or an administrative stop before its start). */
export async function reconcileExecution(deps: Omit<RecoveryDeps, 'live'>, work: WorkRecord, trigger: RecoveryRecord['trigger'], cessation?: Cessation) {
  const execution = work.execution!;
  const ceased = cessation ?? await ceaseOwn(deps.ports.sandbox, execution, deps.inventory, work.work_id, 'controller recovery: own survivor stopped, not adopted');
  const observation = ceased.result === 'confirmed' && needsReceipt(execution) ? await observeReceipt(deps.ports, work.work_id, execution) : null;
  return { cessation: ceased, decision: await settleInterruption(deps.session, { work_id: work.work_id, executionId: execution.executionId, cessation: ceased, observation,
    trigger, controllerRunId: deps.controllerRunId }) };
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
    cachePreparing: (listed?.cache ?? []).filter(item => item.state !== 'idle').map(item => item.repositoryId) };
}
