import type { ConfiguredRepository, DetailInventory, DetailPorts, DetailRemoval, QuestionView, RetentionStatus } from '../types.js';
import { planCleanup } from '../rules/delivery.js';
import { classifyDetails, defaultRetentionDays, retentionProtections, revalidateItem, type PlanFacts } from '../rules/retention.js';
import type { WorkRecord } from './admission.js';
import { dueAtMsOf, plannedResourcesOf, recordDetailIntent, recordDetailResults, recordRetentionSweep, settlePlanItems } from './retention.js';
import type { Session } from './store.js';

const batch = 50;

/**
 * Ticket 30 retention desk, in the existing owner loop (no daemon): the FIRST cycle of an owner process runs after the boot reconciliation
 * (the boot sweep), then one sweep every `sweepSeconds` (daily). Each sweep re-reads every Work and its Records inventory and removes only
 * the eligible details of delivered Works (past the deadline fixed by the confirmed merge, unprotected, not in use), intent before effect and
 * result after it; nothing is retried implicitly. Confirmed explicit plans are executed item by item after a fresh revalidation.
 */
export function createRetentionDesk(deps: { session: Session; details?: DetailPorts | undefined; repositories: ConfiguredRepository[]; days?: number | undefined;
  sweepSeconds?: number | undefined; readWorks(): Promise<WorkRecord[]>; readQuestions(work: WorkRecord): Promise<QuestionView[]>; running(work_id: string): boolean;
  /** False while the boot reconciliation has not settled the installation: nothing is swept before it. */
  settled(): boolean; stopped(): boolean; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const days = deps.days ?? defaultRetentionDays;
  const sweepMs = (deps.sweepSeconds ?? 86400) * 1000;
  let lastSweep: number | null = null;
  let sweeps = 0;
  let lastSweepAt: string | null = null;
  const failures: { at: string; work_id: string | null; step: string; code: string }[] = [];
  const failed = (work_id: string | null, step: string, error: unknown) => {
    failures.push({ at: new Date().toISOString(), work_id, step, code: error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'UNEXPECTED_FAILURE' });
    failures.splice(0, Math.max(0, failures.length - 50));
  };
  const configured = (repository: string) => deps.repositories.some(scope => scope.repository.toLowerCase() === repository.toLowerCase());
  const inventory = async (work_id: string): Promise<DetailInventory | null> => deps.details ? deps.details.list({ workId: work_id }).catch(() => null) : null;

  /** Facts of a plan or revalidation, read just before the commit that uses them. */
  async function factsOf(work: WorkRecord, withInventory: boolean): Promise<PlanFacts> {
    return { running: deps.running(work.work_id), questions: await deps.readQuestions(work), inventory: withInventory ? await inventory(work.work_id) : null,
      repositoryConfigured: configured(work.repository.repository),
      plannedResources: plannedResourcesOf(work, planCleanup(work, { repositoryConfigured: configured(work.repository.repository) }).resources) };
  }

  async function remove(work: WorkRecord, items: { id: string; kind: 'log' | 'session'; executionId: string | null; bytes: number }[],
    origin: { kind: 'retention' | 'explicit'; request_id: string | null; planId: string | null }, recheck: (work: WorkRecord) => string | null) {
    for (let index = 0; index < items.length && !deps.stopped(); index += batch) {
      const slice = items.slice(index, index + batch);
      const intent = await recordDetailIntent(deps.session, work.work_id, slice, origin, recheck);
      if (intent === 'stale' || intent.kind !== 'recorded') return;
      const results: { effectId: string; result: DetailRemoval }[] = [];
      for (const item of slice) {
        const expectedSha256 = item.kind === 'session' ? work.retention?.sessions.find(entry => entry.executionId === item.executionId && entry.state === 'preserved')?.sha256 ?? null : null;
        const result = item.kind === 'session' && !expectedSha256 ? { outcome: 'refused' as const, code: 'SESSION_NOT_RECORDED' }
          : await deps.details!.remove({ workId: work.work_id, item, expectedSha256 }).catch(() => ({ outcome: 'indeterminate' as const, code: 'DETAIL_REMOVAL_UNAVAILABLE' }));
        results.push({ effectId: intent.effects[item.id]!, result });
      }
      await recordDetailResults(deps.session, work.work_id, results, now());
    }
  }

  async function sweepWork(work: WorkRecord) {
    const facts = await factsOf(work, true);
    const recorded = await recordRetentionSweep(deps.session, work.work_id, { days, now: now(), facts, inventory: facts.inventory });
    if (recorded === 'stale' || !recorded.eligible.length || !deps.details) return;
    const instant = now();
    const running = deps.running(work.work_id);
    // Revalidated inside the intent commit against the record as it is then (delivery, deadline, protections, use).
    const ids = new Set(recorded.eligible.map(item => item.item.id));
    await remove(work, recorded.eligible.map(item => item.item), { kind: 'retention', request_id: null, planId: null }, current => {
      const protections = retentionProtections(current, { running, questions: facts.questions });
      const decisions = classifyDetails(current, { items: recorded.eligible.map(item => item.item) }, { protections, now: instant, dueAtMs: dueAtMsOf(current, days) });
      return decisions.every(item => item.decision === 'eligible' && ids.has(item.item.id)) ? null : 'RETENTION_REVALIDATION_REFUSED';
    });
  }

  async function executePlans(works: WorkRecord[]) {
    for (const work of works) {
      for (const plan of work.retention?.plans ?? []) {
        if (deps.stopped() || plan.state !== 'confirmed' || !deps.details) continue;
        const pending = plan.items.filter(item => item.state === 'planned' && (item.kind === 'log' || item.kind === 'session'));
        if (!pending.length) continue;
        const facts = await factsOf(work, true);
        // Revalidated per item NOW (spec §12.4): needed/active/absent items are settled without any effect, never removed by the old plan.
        const settle: { id: string; state: 'dropped' | 'absent'; code: string }[] = [];
        const allowed: { id: string; kind: 'log' | 'session'; executionId: string | null; bytes: number }[] = [];
        for (const item of pending) {
          const complete = facts.inventory?.completeness === 'complete';
          const present = complete ? facts.inventory!.items.find(entry => entry.id === item.id) : undefined;
          const code = !complete ? 'INVENTORY_INCOMPLETE' : revalidateItem(work, item, facts);
          if (code) settle.push({ id: item.id, state: 'dropped', code });
          else if (!present) settle.push({ id: item.id, state: 'absent', code: 'ABSENT_IN_COMPLETE_INVENTORY' });
          else allowed.push({ id: item.id, kind: item.kind as 'log' | 'session', executionId: present.executionId, bytes: present.bytes });
        }
        if (settle.length) await settlePlanItems(deps.session, work.work_id, plan.planId, settle, now());
        if (!allowed.length) continue;
        await remove(work, allowed, { kind: 'explicit', request_id: plan.confirmedBy, planId: plan.planId }, current => {
          for (const item of pending.filter(entry => allowed.some(candidate => candidate.id === entry.id))) { const code = revalidateItem(current, item, facts); if (code) return code; }
          return null;
        });
      }
    }
  }

  return {
    view: (): { failures: typeof failures; status: Omit<RetentionStatus, 'works' | 'details' | 'removed' | 'unsettled'> } =>
      ({ failures: [...failures], status: { sweeps, lastSweepAt, days: deps.details ? days : null } }),
    /** Never throws: the desks and the dispatcher after it run in the same owner cycle. */
    async cycle() {
      if (deps.stopped() || !deps.settled()) return;
      let works: WorkRecord[];
      try { works = await deps.readWorks(); } catch (error) { failed(null, 'read-works', error); return; }
      try { await executePlans(works); } catch (error) { failed(null, 'explicit-cleanup', error); }
      if (lastSweep !== null && now() - lastSweep < sweepMs) return;
      lastSweep = now();
      try { works = await deps.readWorks(); } catch (error) { failed(null, 'read-works', error); return; }
      for (const work of works) {
        if (deps.stopped()) return;
        try { await sweepWork(work); } catch (error) { failed(work.work_id, 'retention-sweep', error); }
      }
      sweeps++; lastSweepAt = new Date(now()).toISOString();
    },
  };
}
