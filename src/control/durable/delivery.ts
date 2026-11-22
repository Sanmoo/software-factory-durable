import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CleanupOutcome, CleanupView, DeliveryView, EvidencePreservation, MergeObservation, OwnPullRequestIdentity, PlannedCleanupResource } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { cleanupNextStep, cleanupState, concluded, deliveryNextStep, explicitCancelledCleanup, explicitPending, mergePlan, ownPullRequestOf, recoverLostIntents, retryable,
  type MergeDecision } from '../rules/delivery.js';
import { ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';
import { rememberResult } from './cycles.js';
import { desireJiraLink } from './jira-links.js';

// Durable commits of ticket 17 (spec §3.4/§12.3). Remote reads and cleanup effects happen OUTSIDE these commits; each commit re-checks the
// Work, its result and the resource it records. Intent is committed before every effect and its result after it.

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const history = (work: WorkRecord, event: Extract<WorkRecord['history'][number], { origin: 'controller-delivery' }>['event'], detail: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-delivery', detail: detail.slice(0, 512) });
const activeExecutionId = (work: WorkRecord) => work.execution && (work.execution.state === 'reserved' || work.execution.state === 'started') ? work.execution.executionId : null;
export const initialCleanup = (at: string): CleanupView => ({ state: 'waiting', eligibility: { eligible: false, reasons: ['NOT_EVALUATED'], checkedAt: at }, evidence: [], resources: [],
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
    // Ticket 25: a cancelled cycle and an own PR closed without merge are still watched: a confirmed merge always prevails as delivery.
    // Review HIGH: merge always wins for the Work that OWNS the PR, current or not (a cancelled predecessor whose PR was kept by `new`).
    const watched = (work?.result === 'open' || work?.result === 'closed-unmerged') ? index.tickets[key]?.current === work_id : work?.result === 'cancelled';
    if (!work || !watched || ownPullRequestOf(work)?.pullRequestId !== input.own.pullRequestId) {
      // Review MED-HIGH: every read advances lastReadAt, so a Work that cannot be recorded never sorts first again (no starvation).
      if (work?.delivery) work.delivery.lastReadAt = new Date().toISOString();
      return { kind: 'stale' as const };
    }
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
      // Ticket 30: an explicit cleanup already recorded for the cancelled cycle keeps its per-resource results (never re-planned from zero).
      work.cleanup = work.cleanup ? { ...work.cleanup, explicit: null, eligibility: { eligible: false, reasons: ['NOT_EVALUATED'], checkedAt: at } } : initialCleanup(at);
      // The cancellation (if any) stays recorded as history: delivery prevails without erasing it (spec §12.3).
      history(work, 'delivery-confirmed', `#${decision.merge.number}:${decision.merge.mergeCommitSha}${during ? `:during:${during}` : ''}${work.cancellation ? `:cancel-requested:${work.cancellation.request_id}` : ''}`);
    } else if (decision.outcome === 'closed-unmerged' && work.result === 'open') {
      // Ticket 25 (spec §4.1/§12.3): closed without merge is NOT delivery and proves nothing about a running activity (not interrupted). The
      // cycle stays current with its counters; nothing is reopened, replaced or resumed automatically.
      work.result = 'closed-unmerged';
      work.closure = { observedAt: at, pullRequest: input.own.number, reopen: null,
        nextStep: 'Own pull request closed without merge: not delivered. Continue: `factory reopen <work>` then `factory resume <work>`; abandon: `factory cancel <work>` then `factory new`.' };
      if (!work.impediments.some(item => item.code === 'PULL_REQUEST_CLOSED_UNMERGED')) work.impediments.push({ code: 'PULL_REQUEST_CLOSED_UNMERGED', scope: 'work', since: at, nextStep: work.closure.nextStep });
      work.history.push({ at, event: 'pull-request-closed-unmerged', origin: 'controller-cycles', detail: `#${input.own.number}${activeExecutionId(work) ? `:active:${activeExecutionId(work)}` : ''}` });
      rememberResult(index, work);
      // Jira ticket 08 (spec §5): the same link of the Work only changes its title; closure is never delivery.
      await desireJiraLink(tx, { work, url: input.own.url, desired: 'closed-unmerged' });
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
    // Ticket 30: or a cancelled Work under an operator-confirmed explicit cleanup not yet swept.
    if (!work || !work.cleanup || (!explicitCancelledCleanup(work) && (work.result !== 'delivered' || work.delivery?.state !== 'delivered'))) return 'stale' as const;
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
    // Ticket 30: an explicit plan names the resources it may touch; nothing else is newly planned under it.
    if (cleanup.explicit && !cleanup.explicit.consumed) input = { ...input, planned: input.planned.filter(item => cleanup.explicit!.resources.includes(item.id)) };
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
    const explicit = cleanup.explicit && !cleanup.explicit.consumed ? explicitPending(cleanup.resources, cleanup.explicit).map(item => item.id) : [];
    if (!cleanup.eligibility.eligible || !ids.length || resources.some(item => !item || (!retryable(item.state) && !explicit.includes(item.id)))) return 'refused' as const;
    if (resources.some(item => item!.environment && !cleanup.evidence.some(entry => entry.environment === item!.environment && entry.state !== 'failed'))) return 'refused' as const;
    const at = new Date().toISOString();
    for (const item of resources) item!.attempts = [...item!.attempts, { effectId, intentAt: at, resultAt: null, outcome: 'intended' as const, code: null }].slice(-20);
    history(work, 'cleanup-intended', `${effectId}:${ids.join(',')}`);
    return 'recorded' as const;
  });
}

/** Ticket 30: the explicit plan was swept once (its attempts recorded): it is never repeated implicitly. */
export async function consumeExplicitCleanup(session: Session, work_id: string, planId: string) {
  return onDelivered(session, work_id, (work, cleanup) => {
    if (!cleanup.explicit || cleanup.explicit.planId !== planId || cleanup.explicit.consumed) return 'stale' as const;
    cleanup.explicit.consumed = true;
    work.history.push({ at: new Date().toISOString(), event: 'cleanup-explicit-resources', origin: 'controller-retention', detail: `${planId}:swept`.slice(0, 512) });
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
