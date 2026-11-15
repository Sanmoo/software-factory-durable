import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CleanupOutcome, CleanupView, DeliveryView, EvidencePreservation, MergeObservation, OwnPullRequestIdentity, PlannedCleanupResource } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { cleanupNextStep, cleanupState, concluded, deliveryNextStep, mergePlan, ownPullRequestOf, recoverLostIntents, retryable, type MergeDecision } from '../rules/delivery.js';
import { ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

// Durable commits of ticket 17 (spec §3.4/§12.3). Remote reads and cleanup effects happen OUTSIDE these commits; each commit re-checks the
// Work, its result and the resource it records. Intent is committed before every effect and its result after it.

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const history = (work: WorkRecord, event: Extract<WorkRecord['history'][number], { origin: 'controller-delivery' }>['event'], detail: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-delivery', detail: detail.slice(0, 512) });
const activeExecutionId = (work: WorkRecord) => work.execution && (work.execution.state === 'reserved' || work.execution.state === 'started') ? work.execution.executionId : null;
const initialCleanup = (at: string): CleanupView => ({ state: 'waiting', eligibility: { eligible: false, reasons: ['NOT_EVALUATED'], checkedAt: at }, evidence: [], resources: [],
  protected: [], sweeps: 0, lastSweepAt: null, nextStep: 'Cleanup is evaluated after delivery: it needs confirmed cessation and preserved evidence first.' });

export type MergeRecord = { kind: 'delivered'; duringActivity: string | null } | { kind: 'observed'; outcome: MergeObservation['outcome'] } | { kind: 'stale' };

/**
 * Records one read of the own pull request. A confirmed merge (decided by `decideMerge` on the linked own identity) makes the Work
 * `delivered` in the SAME commit as: the merge facts, the Ticket's minimal memory (result + mergeConfirmed, consumed by own-dependency
 * evaluation), the removal from the queue and the start of the separate cleanup dimension. An Execution still active is recorded as
 * `duringActivity` (the caller interrupts it); every later agent-facing commit refuses a Work that is not open.
 */
export async function recordMergeObservation(session: Session, work_id: string, input: { own: OwnPullRequestIdentity; observedAt: string | null;
  decision: MergeDecision | { outcome: 'unavailable'; reasons: string[] } }): Promise<MergeRecord> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const key = work ? ticketKey(work.ticket) : '';
    if (!work || work.result !== 'open' || index.tickets[key]?.current !== work_id || ownPullRequestOf(work)?.pullRequestId !== input.own.pullRequestId) return { kind: 'stale' as const };
    const at = new Date().toISOString();
    const delivery: DeliveryView = work.delivery ?? { state: 'watching', pullRequest: copy(input.own), observations: [], merge: null, nextStep: '' };
    const { decision } = input;
    const reasons = decision.outcome === 'merged' ? [] : decision.reasons;
    const last = delivery.observations.at(-1);
    const repeated = last?.outcome === decision.outcome && JSON.stringify(last.reasons) === JSON.stringify(reasons);
    if (!repeated) {
      delivery.observations = [...delivery.observations, { at, observedAt: input.observedAt, outcome: decision.outcome, reasons }].slice(-20);
      if (decision.outcome !== 'merged') history(work, 'delivery-observed', `#${input.own.number}:${decision.outcome}${reasons.length ? `:${reasons.join(',')}` : ''}`);
    }
    if (decision.outcome === 'merged') {
      const during = activeExecutionId(work);
      delivery.state = 'delivered';
      delivery.merge = { ...decision.merge, confirmedAt: at, observedAt: input.observedAt ?? at, duringActivity: during };
      work.result = 'delivered';
      work.queue = { ...work.queue, pending: false };
      const cycles = index.memory?.[key]?.cycles ?? [];
      const remembered = cycles.some(item => item.work_id === work_id) ? cycles.map(item => item.work_id === work_id ? { ...item, result: 'delivered' as const, mergeConfirmed: true } : item)
        : [...cycles, { work_id, cycle: work.cycle, result: 'delivered' as const, mergeConfirmed: true }];
      index.memory = { ...(index.memory ?? {}), [key]: { cycles: remembered } };
      work.cleanup = initialCleanup(at);
      history(work, 'delivery-confirmed', `#${decision.merge.number}:${decision.merge.mergeCommitSha}${during ? `:during:${during}` : ''}`);
    }
    delivery.lastReadAt = at;
    delivery.nextStep = deliveryNextStep(delivery.state, decision.outcome);
    work.delivery = delivery;
    return decision.outcome === 'merged' ? { kind: 'delivered' as const, duringActivity: delivery.merge!.duringActivity } : { kind: 'observed' as const, outcome: decision.outcome };
  }, BACKGROUND_CONTEXT);
}

async function onDelivered<T>(session: Session, work_id: string, change: (work: WorkRecord, cleanup: CleanupView) => T): Promise<T | 'stale'> {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work || work.result !== 'delivered' || work.delivery?.state !== 'delivered' || !work.cleanup) return 'stale' as const;
    const result = change(work, work.cleanup);
    work.cleanup.state = cleanupState({ eligible: work.cleanup.eligibility.eligible, resources: work.cleanup.resources });
    work.cleanup.nextStep = cleanupNextStep(work.cleanup);
    return result;
  }, BACKGROUND_CONTEXT);
}

/**
 * One cleanup evaluation (a sweep): eligibility revalidated now, the plan recomputed from the current records and merged into the recorded
 * resources (results kept, lost intents become indeterminate), protected targets listed. `lastSweepAt` only advances when eligible.
 */
export async function recordSweep(session: Session, work_id: string, input: { eligibility: { eligible: boolean; reasons: string[] }; planned: PlannedCleanupResource[];
  protected: { target: string; reason: string }[] }): Promise<CleanupView | 'stale'> {
  return onDelivered(session, work_id, (work, cleanup) => {
    const at = new Date().toISOString();
    const changed = JSON.stringify(cleanup.eligibility.reasons) !== JSON.stringify(input.eligibility.reasons);
    cleanup.eligibility = { ...input.eligibility, checkedAt: at };
    cleanup.resources = mergePlan(recoverLostIntents(cleanup.resources, at), input.planned);
    cleanup.protected = copy(input.protected);
    if (input.eligibility.eligible) { cleanup.sweeps++; cleanup.lastSweepAt = at; }
    if (changed || input.eligibility.eligible) history(work, 'cleanup-evaluated', input.eligibility.eligible ? `eligible:${cleanup.resources.filter(item => !concluded(item.state)).length} pending`
      : `waiting:${input.eligibility.reasons.join(',')}`);
    return copy({ ...cleanup, state: cleanupState({ eligible: cleanup.eligibility.eligible, resources: cleanup.resources }) });
  });
}

/** Preservation outcome of one own environment's evidence; a preserved reference is never replaced or downgraded. */
export async function recordPreservation(session: Session, work_id: string, environment: string, result: EvidencePreservation) {
  return onDelivered(session, work_id, (work, cleanup) => {
    const existing = cleanup.evidence.find(item => item.environment === environment);
    if (existing && existing.state !== 'failed') return 'kept' as const;
    const entry = { environment, state: result.status, at: new Date().toISOString(), code: result.status === 'failed' ? result.code : null,
      reference: result.status === 'preserved' ? copy(result.reference) : null };
    cleanup.evidence = [...cleanup.evidence.filter(item => item.environment !== environment), entry];
    history(work, 'evidence-preserved', `${environment}:${result.status}${result.status === 'preserved' ? `:${result.reference.id}` : result.status === 'failed' ? `:${result.code}` : ''}`);
    return 'recorded' as const;
  });
}

/**
 * Durable intent BEFORE an effect on the named own resources. Refused unless the Work is still delivered, the latest evaluation is eligible,
 * every resource is planned and still pending, and (environment resources) its evidence is preserved or proven absent.
 */
export async function recordCleanupIntent(session: Session, work_id: string, ids: string[], effectId: string): Promise<'recorded' | 'refused' | 'stale'> {
  return onDelivered(session, work_id, (work, cleanup) => {
    const resources = ids.map(id => cleanup.resources.find(item => item.id === id));
    // Only automatically retryable resources: refused/kept wait for an operator decision (never a fresh write attempt).
    if (!cleanup.eligibility.eligible || !ids.length || resources.some(item => !item || !retryable(item.state))) return 'refused' as const;
    if (resources.some(item => item!.environment && !cleanup.evidence.some(entry => entry.environment === item!.environment && entry.state !== 'failed'))) return 'refused' as const;
    const at = new Date().toISOString();
    for (const item of resources) item!.attempts = [...item!.attempts, { effectId, intentAt: at, resultAt: null, outcome: 'intended' as const, code: null }].slice(-20);
    history(work, 'cleanup-intended', `${effectId}:${ids.join(',')}`);
    return 'recorded' as const;
  });
}

/** Result of one effect, per resource; only the attempt with this effect id is completed (a stale result changes nothing). */
export async function recordCleanupResult(session: Session, work_id: string, effectId: string, outcomes: Record<string, { outcome: CleanupOutcome; code: string | null }>) {
  return onDelivered(session, work_id, (work, cleanup) => {
    const at = new Date().toISOString();
    const recorded: string[] = [];
    for (const [id, result] of Object.entries(outcomes)) {
      const item = cleanup.resources.find(resource => resource.id === id);
      const attempt = item?.attempts.at(-1);
      if (!item || !attempt || attempt.effectId !== effectId || attempt.outcome !== 'intended') continue;
      Object.assign(attempt, { resultAt: at, outcome: result.outcome, code: result.code });
      item.state = result.outcome;
      recorded.push(`${item.kind}:${result.outcome}`);
    }
    if (recorded.length) history(work, 'cleanup-result', `${effectId}:${recorded.join(',')}`);
    return recorded.length ? 'recorded' as const : 'stale' as const;
  });
}
