import { availableOf, exhaustionCodes, exhaustionImpediment, initialBudget } from '../rules/budget.js';
import { recoveryBackoff, recoveryRequest } from '../rules/recovery.js';
import type { WorkRecord } from './admission.js';

/**
 * Inside a commit (ticket 26, spec §4.4): an interrupted Execution whose failure is a transient operational one returns the Work to its SAME
 * queue position as ONE pending operational recovery, with the persisted wait derived from the recoveries already consumed. A repeated
 * request keeps the pending one (no earlier deadline, no second unit); an exhausted counter becomes the visible impediment at once.
 */
export function applyRecoveryRequest(work: WorkRecord, input: { executionId: string | null; code: string; at: string; serviceSeconds?: number | null; reason?: string }) {
  const budget = work.budget ??= initialBudget({}, work.repository.repository, input.at);
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

/** Whether the persisted recovery wait of a Work still runs at `nowMs` (calendar). */
export const backoffRunning = (work: Pick<WorkRecord, 'pendingRecovery'>, nowMs: number) =>
  recoveryBackoff(work.pendingRecovery?.notBefore ? Date.parse(work.pendingRecovery.notBefore) : null, nowMs);
