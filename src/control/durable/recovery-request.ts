import { availableOf, counterOf, exhaustionCodes, exhaustionImpediment, initialBudget } from '../rules/budget.js';
import { bootCapacityWait, recoveryBackoff, recoveryRequest } from '../rules/recovery.js';
import type { WorkRecord } from './admission.js';

/**
 * Inside a commit (ticket 26, spec §4.4): an interrupted Execution whose failure is a transient operational one returns the Work to its SAME
 * queue position as ONE pending operational recovery, with the persisted wait derived from the recoveries already consumed. A repeated
 * request keeps the pending one (no earlier deadline, no second unit); an exhausted counter becomes the visible impediment at once.
 */
export function applyRecoveryRequest(work: WorkRecord, input: { executionId: string | null; code: string; at: string; serviceSeconds?: number | null; reason?: string }) {
  // Assign then read back: the stored record, never the detached value `??=` returns.
  if (!work.budget) work.budget = initialBudget({}, work.repository.repository, input.at);
  const budget = work.budget;
  const pending = work.pendingRecovery;
  const decision = recoveryRequest({ pending: pending ? { notBeforeMs: pending.notBefore ? Date.parse(pending.notBefore) : null, requestedAtMs: Date.parse(pending.requestedAt) } : null,
    consumed: budget.recoveries.consumed, requestedAtMs: Date.parse(input.at), serviceSeconds: input.serviceSeconds ?? null });
  const reason = input.reason ?? `interrupted:${input.code}`;
  if (decision.kind === 'keep') {
    work.history.push({ at: input.at, event: 'recovery-wait-kept', origin: 'controller-recovery', executionId: input.executionId, detail: `${reason.slice(0, 160)}; notBefore ${pending!.notBefore}` });
  } else {
    work.pendingRecovery = { ...(pending ?? { reason, requestedAt: input.at, executionId: input.executionId }), notBefore: new Date(decision.notBeforeMs).toISOString(),
      waitSeconds: decision.waitSeconds, attempt: decision.attempt };
    work.history.push(decision.kind === 'fill'
      ? { at: input.at, event: 'recovery-wait-kept', origin: 'controller-recovery', executionId: input.executionId, detail: `${reason.slice(0, 160)}; notBefore ${work.pendingRecovery.notBefore}` }
      : { at: input.at, event: 'recovery-requested', origin: 'controller-budget', executionId: input.executionId, detail: `${reason.slice(0, 160)}; wait ${decision.waitSeconds}s` });
  }
  if (availableOf(budget.recoveries) === 0 && !work.impediments.some(item => item.code === exhaustionCodes.recoveries)) {
    work.impediments.push(exhaustionImpediment('recoveries', work.work_id, input.at));
    work.history.push({ at: input.at, event: 'budget-exhausted', origin: 'controller-budget', executionId: null,
      detail: `recoveries:${budget.recoveries.consumed}/${budget.recoveries.limit + budget.recoveries.granted}` });
  }
  work.queue = { ...work.queue, pending: true };
  return decision.kind === 'keep' ? 'already-open' as const : 'requested' as const;
}

/**
 * Inside a commit (ticket 48): a Builder budget end WITH Host-observed progress returns the Work to its SAME queue position as ONE pending
 * continuation, charged to the Work's own `continuations` counter (not `recoveries`) and without a wait (nothing failed). Exhausted
 * continuations become the visible CONTINUATION_LIMIT_REACHED impediment at once, with `factory grant <work> --continuations <n>` as its exit.
 */
export function applyContinuationRequest(work: WorkRecord, input: { executionId: string; code: string; at: string; detail: string }) {
  if (!work.budget) work.budget = initialBudget({}, work.repository.repository, input.at);
  const counter = counterOf(work.budget, 'continuations');
  if (work.pendingRecovery) {
    work.history.push({ at: input.at, event: 'recovery-wait-kept', origin: 'controller-recovery', executionId: input.executionId, detail: `budget-continuation:${input.code}; pending kept` });
  } else {
    work.pendingRecovery = { reason: `budget-continuation:${input.code}`, requestedAt: input.at, executionId: input.executionId, notBefore: input.at, waitSeconds: 0,
      attempt: counter.consumed, kind: 'budget-continuation' };
    work.history.push({ at: input.at, event: 'continuation-requested', origin: 'controller-budget', executionId: input.executionId,
      detail: `${input.detail}; continuations ${counter.consumed}/${counter.limit + counter.granted}`.slice(0, 512) });
  }
  if (availableOf(counter) === 0 && !work.impediments.some(item => item.code === exhaustionCodes.continuations)) {
    work.impediments.push(exhaustionImpediment('continuations', work.work_id, input.at));
    work.history.push({ at: input.at, event: 'budget-exhausted', origin: 'controller-budget', executionId: null,
      detail: `continuations:${counter.consumed}/${counter.limit + counter.granted}` });
  }
  work.queue = { ...work.queue, pending: true };
}

/**
 * Inside a commit (ticket 50): a boot/preparation refused for lack of host memory/storage, with nothing started, keeps the Work's queue position
 * behind a persisted capacity wait that grows while the refusals repeat (reset by the next operational boot). No budget unit is touched.
 */
export function applyBootDeferral(work: WorkRecord, input: { executionId: string; code: string; detail?: string | null; at: string }) {
  const attempt = work.bootDeferral ? work.bootDeferral.attempt + 1 : 0;
  const waitSeconds = bootCapacityWait(attempt);
  const notBefore = new Date(Date.parse(input.at) + waitSeconds * 1000).toISOString();
  work.bootDeferral = { code: input.code, executionId: input.executionId, requestedAt: input.at, notBefore, waitSeconds, attempt,
    ...(input.detail ? { detail: input.detail.slice(0, 512) } : {}) };
  work.history.push({ at: input.at, event: 'boot-deferred', origin: 'controller-recovery', executionId: input.executionId,
    detail: `${input.code}${input.detail ? ` (${input.detail.slice(0, 256)})` : ''}; capacity wait ${waitSeconds}s (attempt ${attempt + 1}); nothing started, nothing charged` });
  work.queue = { ...work.queue, pending: true };
}

/** Ticket 50: whether the persisted capacity wait of a Work still runs at `nowMs` (calendar). */
export const bootDeferralRunning = (work: Pick<WorkRecord, 'bootDeferral'>, nowMs: number) =>
  recoveryBackoff(work.bootDeferral?.notBefore ? Date.parse(work.bootDeferral.notBefore) : null, nowMs);

/** Whether the persisted recovery wait of a Work still runs at `nowMs` (calendar). */
export const backoffRunning = (work: Pick<WorkRecord, 'pendingRecovery'>, nowMs: number) =>
  recoveryBackoff(work.pendingRecovery?.notBefore ? Date.parse(work.pendingRecovery.notBefore) : null, nowMs);
