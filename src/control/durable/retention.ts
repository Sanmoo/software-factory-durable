import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ControlInput, ControlReceipt, DetailInventory, DetailPorts, DetailRemoval, DetailRemovalView, ExplicitCleanupPlan, PlannedCleanupResource,
  PreservedSessionView, RetentionEvent, RetentionView } from '../types.js';
import { concluded, ownEnvironments } from '../rules/delivery.js';
import { classifyDetails, defaultRetentionDays, explicitPlanNextStep, planBasis, planExplicitCleanup, retentionDeadline, retentionNextStep, retentionProtections, retentionState,
  revalidateItem, type DetailDecision, type PlanFacts } from '../rules/retention.js';
import { requests, works, type WorkRecord } from './admission.js';
import { initialCleanup } from './delivery.js';
import type { Session } from './store.js';

// Ticket 30 durable commits (spec §12.3/§12.4): every detail removal records its intent BEFORE the effect and its result after it; each commit
// re-checks the Work. Records I/O (inventory, preservation, removal) happens OUTSIDE the commits.

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
type CleanupInput = Extract<ControlInput, { operation: 'cleanup-plan' | 'cleanup-confirm' }>;
type CleanupReceipt = Extract<ControlReceipt, { operation: 'cleanup-plan' | 'cleanup-confirm' }>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const removalsKept = 500;
const plansKept = 10;
const history = (work: WorkRecord, event: RetentionEvent, detail: string, at = new Date().toISOString(), origin: 'controller-retention' | 'local-cli' = 'controller-retention') =>
  work.history.push({ at, event, origin, detail: detail.slice(0, 512) });

/** The Work's retention view, created on first use (records written before ticket 30 have none). */
export function retentionOf(work: WorkRecord, days = work.retention?.days ?? defaultRetentionDays): RetentionView {
  work.retention ??= { class: work.result === 'delivered' ? 'delivered' : 'undelivered', days, dueAt: dueAtOf(work, days), protections: [], state: 'retained', inventory: null,
    sessions: [], removals: [], removed: { logs: 0, sessions: 0, bytes: 0 }, plans: [], sweeps: 0, lastSweepAt: null, nextStep: '' };
  return work.retention;
}
/** Deadline of the Work's details (ISO), from its confirmed merge instant. */
export function dueAtMsOf(work: WorkRecord, days: number): number | null {
  const confirmedAt = work.delivery?.merge?.confirmedAt;
  return retentionDeadline(work, confirmedAt ? Date.parse(confirmedAt) : null, days);
}
const dueAtOf = (work: WorkRecord, days: number) => { const ms = dueAtMsOf(work, days); return ms === null ? null : new Date(ms).toISOString(); };
function refresh(work: WorkRecord, view: RetentionView, input: { now: number; protections: string[] }) {
  view.class = work.result === 'delivered' ? 'delivered' : 'undelivered';
  view.dueAt = dueAtOf(work, view.days);
  view.protections = [...input.protections];
  const remaining = view.inventory ? view.inventory.logs + view.inventory.sessions : 1;
  view.state = retentionState({ class: view.class, dueAtMs: dueAtMsOf(work, view.days), now: input.now, protections: view.protections, remaining,
    explicit: view.removals.some(item => item.origin === 'explicit' && (item.outcome === 'removed' || item.outcome === 'absent')) });
  view.nextStep = retentionNextStep(view);
}
async function onWork<T>(session: Session, work_id: string, change: (work: WorkRecord, tx: Tx) => T | Promise<T>): Promise<T | 'stale'> {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work) return 'stale' as const;
    return change(work, tx);
  }, BACKGROUND_CONTEXT);
}

/** Preservation result of one recorded Builder session (a preserved copy is never replaced or downgraded). */
export async function recordSessionPreservation(session: Session, work_id: string, entry: PreservedSessionView) {
  return onWork(session, work_id, work => {
    const view = retentionOf(work);
    const existing = view.sessions.find(item => item.id === entry.id);
    if (existing?.state === 'preserved') return 'kept' as const;
    view.sessions = [...view.sessions.filter(item => item.id !== entry.id), copy(entry)];
    history(work, 'details-preserved', `${entry.id}:${entry.state}${entry.code ? `:${entry.code}` : ''}`, entry.at);
    return 'recorded' as const;
  });
}

/**
 * Before an environment is removed (spec §12.1 "antes de remover ambiente preservar o que sustenta registros retidos"): every recorded Builder
 * session of the Work's Executions in that environment is copied to the Records area. `lost` (already gone) is recorded and does not block;
 * a failed copy blocks the removal of that environment.
 */
export async function preserveSessions(session: Session, details: DetailPorts, work: WorkRecord, environment: string): Promise<'preserved' | 'failed'> {
  const executions = [...work.previousExecutions, ...(work.execution ? [work.execution] : [])].filter(item => item.dispatch.environment === environment);
  type Result = Awaited<ReturnType<DetailPorts['preserveSession']>>;
  const done = (id: string) => work.retention?.sessions.some(item => item.id === id && (item.state === 'preserved' || item.state === 'lost'));
  const preserve = async (execution: { executionId: string }, role: 'builder' | 'reviewer', name: string, source: { ref: string; sha256: string; bytes: number }) => {
    const id = `session:${name}`;
    if (done(id)) return 'preserved' as const;
    const result: Result = await details.preserveSession({ workId: work.work_id, executionId: execution.executionId, ...(role === 'reviewer' ? { name } : {}), session: source })
      .catch((): Result => ({ status: 'failed', code: 'SESSION_PRESERVATION_FAILED' }));
    const base = { id, role, executionId: execution.executionId, sourceRef: source.ref, at: new Date().toISOString() };
    await recordSessionPreservation(session, work.work_id, result.status === 'preserved' || result.status === 'already'
      ? { ...base, sha256: result.sha256, bytes: result.bytes, state: 'preserved', code: null }
      : { ...base, sha256: source.sha256, bytes: source.bytes, state: result.status, code: 'code' in result ? result.code : null });
    return result.status === 'failed' ? 'failed' as const : 'preserved' as const;
  };
  for (const execution of executions) {
    const recorded = execution.end?.session;
    if (recorded && await preserve(execution, 'builder', execution.executionId, recorded) === 'failed') return 'failed';
    // Supervisor decision (ticket 30): the other agent sessions of the same boot (reviewers) are retained details too, copied first as well.
    if (!execution.dispatch.boot || !details.runtimeSessions) continue;
    let found: { ref: string; sha256: string; bytes: number }[];
    try { found = await details.runtimeSessions({ boot: execution.dispatch.boot }); } catch { return 'failed'; }
    for (const source of found.filter(item => item.ref !== recorded?.ref)) {
      const name = `${execution.executionId}--rv-${createHash('sha256').update(source.ref).digest('hex').slice(0, 16)}`;
      if (await preserve(execution, 'reviewer', name, source) === 'failed') return 'failed';
    }
  }
  return 'preserved';
}

/**
 * One retention evaluation of a Work (a sweep): lost intents become indeterminate, an indeterminate removal absent from a COMPLETE inventory is
 * concluded `absent`, the inventory summary, protections, deadline and state are recorded. Returns the eligible details (delivered, past the
 * deadline fixed by the confirmed merge, unprotected, not in use).
 */
export async function recordRetentionSweep(session: Session, work_id: string, input: { days: number; now: number; facts: Pick<PlanFacts, 'running' | 'questions'>;
  inventory: DetailInventory | null }): Promise<{ eligible: DetailDecision[]; view: RetentionView } | 'stale'> {
  return onWork(session, work_id, work => {
    const at = new Date(input.now).toISOString();
    const view = retentionOf(work, input.days);
    view.days = input.days;
    for (const item of view.removals) if (item.outcome === 'intended') Object.assign(item, { outcome: 'indeterminate', resultAt: at, code: 'RESULT_NOT_RECORDED' });
    for (const plan of view.plans) for (const item of plan.items) if (item.state === 'intended') Object.assign(item, { state: 'indeterminate', code: 'RESULT_NOT_RECORDED' });
    if (input.inventory?.completeness === 'complete') {
      const present = new Set(input.inventory.items.map(item => item.id));
      for (const item of view.removals) if (item.outcome === 'indeterminate' && !present.has(item.id)) {
        Object.assign(item, { outcome: 'absent', code: 'ABSENT_IN_COMPLETE_INVENTORY', resultAt: at });
        count(view, item);
      }
    }
    if (input.inventory) view.inventory = { completeness: input.inventory.completeness, observedAt: input.inventory.observedAt, evidence: input.inventory.evidence,
      unknown: input.inventory.unknown.length, logs: input.inventory.items.filter(item => item.kind === 'log').length,
      sessions: input.inventory.items.filter(item => item.kind === 'session').length, bytes: input.inventory.items.reduce((sum, item) => sum + item.bytes, 0) };
    const protections = retentionProtections(work, input.facts);
    const before = view.sweeps === 0 ? 'first' : JSON.stringify([view.state, view.class, view.protections]);
    view.sweeps++; view.lastSweepAt = at;
    refresh(work, view, { now: input.now, protections });
    const decisions = input.inventory && input.inventory.completeness === 'complete' ? classifyDetails(work, input.inventory, { protections, now: input.now, dueAtMs: dueAtMsOf(work, input.days) }) : [];
    // An item whose removal result is unknown is never removed again implicitly; the operator decides through an explicit plan.
    const unsettled = new Set(view.removals.filter(item => item.outcome === 'indeterminate' || item.outcome === 'failed' || item.outcome === 'refused').map(item => item.id));
    const eligible = decisions.filter(item => item.decision === 'eligible' && !unsettled.has(item.item.id));
    // History only when the evaluation changed or something becomes removable (a daily sweep of an unchanged Work adds nothing).
    if (eligible.length || before !== JSON.stringify([view.state, view.class, view.protections])) {
      history(work, 'retention-evaluated', `${view.state}:${view.class}:${eligible.length} eligible${protections.length ? `:protected:${protections.join(',')}` : ''}`, at);
    }
    return { eligible, view: copy(view) };
  });
}
const count = (view: RetentionView, item: DetailRemovalView) => {
  if (item.outcome !== 'removed' && item.outcome !== 'absent') return;
  if (item.kind === 'log') view.removed.logs++; else view.removed.sessions++;
  if (item.outcome === 'removed') view.removed.bytes += item.bytes;
};

/**
 * Durable intent BEFORE removing the given details. Refused (nothing recorded) unless `recheck(work)` — the current rule evaluated on the record
 * inside this commit — still allows every one of them.
 */
export async function recordDetailIntent(session: Session, work_id: string, items: { id: string; kind: 'log' | 'session'; executionId: string | null; bytes: number }[],
  origin: { kind: 'retention' | 'explicit'; request_id: string | null; planId: string | null }, recheck: (work: WorkRecord) => string | null):
  Promise<{ kind: 'recorded'; effects: Record<string, string> } | { kind: 'refused'; code: string } | 'stale'> {
  return onWork(session, work_id, work => {
    const code = recheck(work);
    if (code) return { kind: 'refused' as const, code };
    const view = retentionOf(work);
    const at = new Date().toISOString();
    const effects: Record<string, string> = {};
    for (const item of items) {
      if (view.removals.some(entry => entry.id === item.id && entry.outcome === 'intended')) return { kind: 'refused' as const, code: 'REMOVAL_ALREADY_INTENDED' };
      effects[item.id] = randomUUID();
      view.removals.push({ effectId: effects[item.id]!, id: item.id, kind: item.kind, executionId: item.executionId, bytes: item.bytes, origin: origin.kind,
        request_id: origin.request_id, planId: origin.planId, intentAt: at, resultAt: null, outcome: 'intended', code: null });
    }
    view.removals = view.removals.slice(-removalsKept);
    const plan = origin.planId ? view.plans.find(entry => entry.planId === origin.planId) : undefined;
    for (const item of plan?.items ?? []) if (effects[item.id]) item.state = 'intended';
    history(work, 'detail-removal-intended', `${origin.kind}${origin.planId ? `:${origin.planId}` : ''}:${items.length}:${items.slice(0, 8).map(item => item.id).join(',')}`, at);
    return { kind: 'recorded' as const, effects };
  });
}

/** Results of removals, per detail; only the attempt with this effect id is completed (a stale result changes nothing). */
export async function recordDetailResults(session: Session, work_id: string, results: { effectId: string; result: DetailRemoval }[], now: number) {
  return onWork(session, work_id, work => {
    const view = retentionOf(work);
    const at = new Date().toISOString();
    const recorded: string[] = [];
    for (const { effectId, result } of results) {
      const item = view.removals.find(entry => entry.effectId === effectId);
      if (!item || item.outcome !== 'intended') continue;
      Object.assign(item, { outcome: result.outcome, code: result.code, resultAt: at });
      count(view, item);
      const plan = item.planId ? view.plans.find(entry => entry.planId === item.planId) : undefined;
      const planned = plan?.items.find(entry => entry.id === item.id && entry.state === 'intended');
      if (planned) Object.assign(planned, { state: result.outcome, code: result.code });
      recorded.push(`${item.id}:${result.outcome}`);
    }
    for (const plan of view.plans) if (plan.state === 'confirmed' && plan.items.every(item => item.state !== 'planned' && item.state !== 'intended')) {
      plan.state = 'executed'; plan.nextStep = explicitPlanNextStep(plan);
    }
    if (view.inventory) {
      for (const entry of results) {
        const item = view.removals.find(removal => removal.effectId === entry.effectId);
        if (item && (entry.result.outcome === 'removed' || entry.result.outcome === 'absent')) {
          if (item.kind === 'log') view.inventory.logs = Math.max(0, view.inventory.logs - 1); else view.inventory.sessions = Math.max(0, view.inventory.sessions - 1);
          view.inventory.bytes = Math.max(0, view.inventory.bytes - item.bytes);
        }
      }
    }
    refresh(work, view, { now, protections: view.protections });
    if (recorded.length) history(work, 'detail-removal-result', `${recorded.length}:${recorded.slice(0, 8).join(',')}`, at);
    return recorded.length ? 'recorded' as const : 'stale' as const;
  });
}

/** Plan items settled by the execution-time revalidation without any effect (dropped: needed/active now; absent: already gone). */
export async function settlePlanItems(session: Session, work_id: string, planId: string, updates: { id: string; state: 'dropped' | 'absent'; code: string }[], now: number) {
  return onWork(session, work_id, work => {
    const view = retentionOf(work);
    const plan = view.plans.find(entry => entry.planId === planId);
    if (!plan || plan.state !== 'confirmed') return 'stale' as const;
    const at = new Date().toISOString();
    for (const update of updates) {
      const item = plan.items.find(entry => entry.id === update.id && entry.state === 'planned');
      if (!item) continue;
      Object.assign(item, { state: update.state, code: update.code });
      history(work, 'cleanup-item-dropped', `${planId}:${update.id}:${update.state}:${update.code}`, at);
    }
    if (plan.items.every(item => item.state !== 'planned' && item.state !== 'intended')) { plan.state = 'executed'; plan.nextStep = explicitPlanNextStep(plan); }
    refresh(work, view, { now, protections: view.protections });
    return 'recorded' as const;
  });
}

/** Deduplicated "Aceitar comando" (same identity + content → recorded receipt; other content → conflict), as ticket 25 does. */
async function command(session: Session, input: CleanupInput, decide: (tx: Tx) => Promise<CleanupReceipt>): Promise<CleanupReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return copy(request.receipt) as CleanupReceipt;
    }
    const receipt = await decide(tx);
    request.input = input;
    request.receipt = receipt;
    return copy(receipt);
  }, BACKGROUND_CONTEXT);
}
const receiptOf = (input: CleanupInput, outcome: CleanupReceipt['outcome'], reason: string | null, plan: ExplicitCleanupPlan | null): CleanupReceipt =>
  ({ kind: 'durable', request_id: input.request_id, operation: input.operation, work_id: input.work_id, outcome, reason, plan: plan ? copy(plan) : null });

/**
 * `cleanup-plan` (spec §12.4): the plan of losses of the selection, computed from the CURRENT facts (inventory read just before), is recorded and
 * waits for confirmation; an older unconfirmed plan of the Work is superseded. Nothing is removed and nothing else changes.
 */
export async function acceptCleanupPlan(session: Session, input: CleanupInput & { operation: 'cleanup-plan' }, facts: (work: WorkRecord) => PlanFacts) {
  return command(session, input, async tx => {
    const work = (await tx.doc(works, input.work_id, null)).work;
    if (!work) return receiptOf(input, 'not-applied', 'WORK_NOT_FOUND', null);
    const current = facts(work);
    const computed = planExplicitCleanup(work, input.select, current);
    const at = new Date().toISOString();
    const view = retentionOf(work);
    for (const plan of view.plans) if (plan.state === 'planned') { plan.state = 'superseded'; plan.nextStep = explicitPlanNextStep(plan); }
    const plan: ExplicitCleanupPlan = { planId: randomUUID(), request_id: input.request_id, work_id: work.work_id, createdAt: at, select: [...new Set(input.select)], state: 'planned',
      confirmedBy: null, confirmedAt: null, basis: planBasis(work, current), ...computed, nextStep: '' };
    plan.nextStep = explicitPlanNextStep(plan);
    view.plans = [...view.plans, plan].slice(-plansKept);
    history(work, 'cleanup-planned', `${input.request_id}:${plan.planId}:${plan.items.length} item(s):${plan.refusals.length} refused`, at, 'local-cli');
    return receiptOf(input, 'accepted', plan.items.length ? null : 'NOTHING_TO_REMOVE', plan);
  });
}

/**
 * `cleanup-confirm`: the plan is revalidated NOW (spec §12.4 "plano antigo não permite apagar recurso agora ativo/necessário"): an item the current
 * facts no longer allow is dropped with its reason, never removed. Detail items are then executed by the retention desk (revalidated again per item);
 * own resources are handed to the resource cleanup as ONE explicit sweep (environment of a cancelled Work; fresh attempt of a delivered Work's
 * refused/kept/failed resources).
 */
export async function acceptCleanupConfirm(session: Session, input: CleanupInput & { operation: 'cleanup-confirm' }, facts: (work: WorkRecord) => PlanFacts) {
  return command(session, input, async tx => {
    const work = (await tx.doc(works, input.work_id, null)).work;
    if (!work) return receiptOf(input, 'not-applied', 'WORK_NOT_FOUND', null);
    const view = retentionOf(work);
    const plan = view.plans.find(item => item.planId === input.plan_id);
    if (!plan) return receiptOf(input, 'not-applied', 'PLAN_NOT_FOUND', null);
    if (plan.state === 'superseded') return receiptOf(input, 'not-applied', 'PLAN_SUPERSEDED', plan);
    if (plan.state !== 'planned') return receiptOf(input, 'already-satisfied', 'PLAN_ALREADY_CONFIRMED', plan);
    const current = facts(work);
    const at = new Date().toISOString();
    const obsolete = planBasis(work, current) !== plan.basis;
    const dropped: string[] = [];
    for (const item of plan.items) {
      const code = revalidateItem(work, item, current);
      if (code) { Object.assign(item, { state: 'dropped' as const, code }); dropped.push(`${item.id}:${code}`); }
    }
    // An own resource is still a planned resource of the Work (ownership), not concluded (a removed/absent one is not removed again).
    const resources = plan.items.filter(item => item.state === 'planned' && (item.kind === 'environment' || item.kind === 'remote-branch'));
    for (const item of resources) {
      const known = work.cleanup?.resources.find(entry => entry.id === item.id);
      const planned = current.plannedResources.some(entry => entry.id === item.id);
      if ((known && concluded(known.state)) || (!known && !planned)) { Object.assign(item, { state: 'dropped' as const, code: known ? 'ALREADY_CONCLUDED' : 'NOT_OWN_RESOURCE' }); continue; }
      item.state = 'handed-to-cleanup';
    }
    const handed = plan.items.filter(item => item.state === 'handed-to-cleanup');
    if (handed.length) {
      work.cleanup ??= initialCleanup(at);
      // Delivered: refused/kept/failed/indeterminate become ONE fresh revalidated attempt (the operator's decision); never forced.
      for (const resource of work.cleanup.resources) if (handed.some(item => item.id === resource.id) && !concluded(resource.state)) resource.state = 'pending';
      work.cleanup.explicit = { request_id: input.request_id, planId: plan.planId, at, consumed: false, resources: handed.map(item => item.id) };
      history(work, 'cleanup-explicit-resources', `${plan.planId}:${handed.map(item => item.id).join(',')}`, at);
    }
    plan.state = plan.items.some(item => item.state === 'planned') ? 'confirmed' : 'executed';
    plan.confirmedBy = input.request_id; plan.confirmedAt = at;
    plan.nextStep = explicitPlanNextStep(plan);
    history(work, 'cleanup-confirmed', `${input.request_id}:${plan.planId}${obsolete ? ':obsolete-plan-revalidated' : ''}`, at, 'local-cli');
    for (const item of dropped) history(work, 'cleanup-item-dropped', `${plan.planId}:${item}`, at);
    const left = plan.items.filter(item => item.state === 'planned' || item.state === 'handed-to-cleanup').length;
    return receiptOf(input, left ? 'accepted' : 'not-applied', left ? (obsolete ? 'PLAN_OBSOLETE_REVALIDATED' : null) : 'NOTHING_LEFT_AFTER_REVALIDATION', plan);
  });
}

/** Own resources the resource cleanup would plan now for this Work (environment kinds, and the remote branch of a delivered Work). */
export const plannedResourcesOf = (work: WorkRecord, planned: PlannedCleanupResource[]) =>
  planned.filter(item => item.environment === null || ownEnvironments(work).includes(item.environment)).map(item => ({ id: item.id, kind: item.kind, target: item.target }));
