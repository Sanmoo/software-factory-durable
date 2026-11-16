import type { ConfiguredRepository, DetailInventory, DetailPorts, DetailRemoval, QuestionView, RetentionStatus, StorageScrub } from '../types.js';
import { planCleanup } from '../rules/delivery.js';
import { classifyDetails, defaultRetentionDays, retentionProtections, revalidateItem, type PlanFacts } from '../rules/retention.js';
import type { WorkRecord } from './admission.js';
import { dueAtMsOf, plannedResourcesOf, recordDetailIntent, recordDetailResults, recordRetentionSweep, settlePlanItems } from './retention.js';
import type { Session } from './store.js';
import { questions as questionDocs } from './questions.js';
import { beginForget, contentRequestIds, finishForget, recordScrub, settleLostForget } from './forget.js';
import { readForgotten, requests } from './admission.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
type Removable = { id: string; kind: 'log' | 'session'; executionId: string | null; bytes: number; sha256?: string | null };

const batch = 50;

/**
 * Ticket 30 retention desk, in the existing owner loop (no daemon): the FIRST cycle of an owner process runs after the boot reconciliation
 * (the boot sweep), then one sweep every `sweepSeconds` (daily). Each sweep re-reads every Work and its Records inventory and removes only
 * the eligible details of delivered Works (past the deadline fixed by the confirmed merge, unprotected, not in use), intent before effect and
 * result after it; nothing is retried implicitly. Confirmed explicit plans are executed item by item after a fresh revalidation.
 */
export function createRetentionDesk(deps: { session: Session; details?: DetailPorts | undefined;
  /** D-07: the controller storage's scrub (absent: forgotten Works stay `pending`, shown by status). */ storage?: StorageScrub | undefined;
  repositories: ConfiguredRepository[]; days?: number | undefined;
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

  /** Review LOW: the Work's Questions as the intent commit sees them, and whether an activity runs NOW (not values read before the commit). */
  async function commitFacts(work: WorkRecord, tx: Tx): Promise<Pick<PlanFacts, 'running' | 'questions'>> {
    const found: QuestionView[] = [];
    for (const id of work.questions ?? []) { const question = (await tx.doc(questionDocs, id, null)).question; if (question) found.push(question); }
    return { running: deps.running(work.work_id), questions: found };
  }

  async function remove(work: WorkRecord, items: Removable[],
    origin: { kind: 'retention' | 'explicit'; request_id: string | null; planId: string | null }, recheck: (work: WorkRecord, tx: Tx) => Promise<string | null>) {
    for (let index = 0; index < items.length && !deps.stopped(); index += batch) {
      const slice = items.slice(index, index + batch);
      const intent = await recordDetailIntent(deps.session, work.work_id, slice, origin, recheck);
      if (intent === 'stale' || intent.kind !== 'recorded') return;
      const results: { effectId: string; result: DetailRemoval }[] = [];
      for (const item of slice) {
        // A session copy is removed only while it still has the hash the inventory (or the confirmed plan) saw.
        const expectedSha256 = item.kind === 'session' ? item.sha256 ?? null : null;
        const result = item.kind === 'session' && !expectedSha256 ? { outcome: 'refused' as const, code: 'SESSION_HASH_UNKNOWN' }
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
    // Revalidated inside the intent commit against the record, its Questions and the activity as they are then (delivery, deadline, protections, use).
    const ids = new Set(recorded.eligible.map(item => item.item.id));
    await remove(work, recorded.eligible.map(item => item.item), { kind: 'retention', request_id: null, planId: null }, async (current, tx) => {
      const protections = retentionProtections(current, await commitFacts(current, tx));
      const decisions = classifyDetails(current, { items: recorded.eligible.map(item => item.item) }, { protections, now: instant, dueAtMs: dueAtMsOf(current, days) });
      return decisions.every(item => item.decision === 'eligible' && ids.has(item.item.id)) ? null : 'RETENTION_REVALIDATION_REFUSED';
    });
  }

  /**
   * Ticket 31: confirmed `forget` plans, FIRST in the cycle (no retention removal changes the Records tree between a confirmation and its
   * deletion). Each is revalidated in its intent commit against a fresh Records inspection; then the whole Records area is deleted and the
   * result commit keeps only the minimal memory. A `removing` plan this process does not hold was cut by a crash: indeterminate, never retried.
   */
  const inFlight = new Set<string>();
  async function executeForgets(works: WorkRecord[]) {
    for (const work of works) {
      if (deps.stopped()) return;
      const plans = work.forget?.plans ?? [];
      if (plans.some(plan => plan.state === 'removing' && plan.effect?.outcome === 'intended' && !inFlight.has(plan.effect.effectId))) await settleLostForget(deps.session, work.work_id, inFlight);
      const plan = plans.find(item => item.state === 'confirmed');
      if (!plan || !deps.details) continue;
      const details = deps.details;
      const tree = details.inspectTree ? await details.inspectTree({ workId: work.work_id }).catch(() => null) : null;
      const facts = (current: WorkRecord) => ({ running: deps.running(current.work_id), tree, repositoryConfigured: configured(current.repository.repository) });
      const intent = await beginForget(deps.session, work.work_id, plan.planId, facts);
      if (intent === 'stale' || intent.kind !== 'removing') continue;
      inFlight.add(intent.effectId);
      try {
        const result = details.forget ? await details.forget({ workId: work.work_id }).catch(() => ({ outcome: 'indeterminate' as const, code: 'RECORDS_FORGET_UNAVAILABLE', files: 0, bytes: 0 }))
          : { outcome: 'refused' as const, code: 'RECORDS_FORGET_NOT_COMPOSED', files: 0, bytes: 0 };
        // Content-bearing request receipts that exist (read before the commit, so none is created by looking).
        const current = await deps.readQuestions(work);
        const candidates = contentRequestIds(work, current);
        const existing: string[] = [];
        for (const id of candidates) if ((await deps.session.snapshot(requests, id, BACKGROUND_CONTEXT))?.input) existing.push(id);
        await finishForget(deps.session, work.work_id, plan.planId, intent.effectId, result, existing);
      } finally { inFlight.delete(intent.effectId); }
    }
  }

  /**
   * D-07: after a committed forget, the controller storage is scrubbed so the deleted records do not stay in SQLite free pages or the WAL:
   * VACUUM (rebuilds every page from the live rows only), then `wal_checkpoint(TRUNCATE)` (old page images in the WAL are cut), then the result
   * is recorded and the WAL truncated again. It runs in the owner, which holds the canonical-storage flock, on its single connection's serial
   * queue: no transaction runs beside it. A new forget (or the first cycle of an owner run, e.g. after a crash mid-VACUUM) is attempted at once; a
   * failed attempt is re-attempted once per sweep period. Until then the memory says `pending`.
   */
  let scrubTried = false;
  async function scrubForgotten() {
    if (!deps.storage) return;
    const pending = (await readForgotten(deps.session)).filter(memory => memory.scrub?.state !== 'scrubbed');
    if (!pending.length) return;
    const fresh = pending.some(memory => !memory.scrub || memory.scrub.attempts === 0);
    const last = Math.max(0, ...pending.map(memory => memory.scrub?.lastAttemptAt ? Date.parse(memory.scrub.lastAttemptAt) : 0));
    if (scrubTried && !fresh && now() - last < sweepMs) return;
    scrubTried = true;
    const result = await deps.storage.vacuum();
    await recordScrub(deps.session, pending.map(memory => memory.work_id), result, new Date(now()).toISOString());
    if (result.outcome !== 'scrubbed') { failed(null, 'storage-scrub', new Error(result.code)); return; }
    // The result commit itself only rewrote the minimal memory; its WAL frames are cut too.
    const tail = await deps.storage.checkpoint();
    if (tail.outcome !== 'scrubbed') failed(null, 'storage-scrub-checkpoint', new Error(tail.code));
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
        const allowed: Removable[] = [];
        for (const item of pending) {
          const complete = facts.inventory?.completeness === 'complete';
          const present = complete ? facts.inventory!.items.find(entry => entry.id === item.id) : undefined;
          const code = !complete ? 'INVENTORY_INCOMPLETE' : revalidateItem(work, item, facts);
          if (code) settle.push({ id: item.id, state: 'dropped', code });
          else if (!present) settle.push({ id: item.id, state: 'absent', code: 'ABSENT_IN_COMPLETE_INVENTORY' });
          else allowed.push({ id: item.id, kind: item.kind as 'log' | 'session', executionId: present.executionId, bytes: present.bytes, sha256: item.sha256 ?? null });
        }
        if (settle.length) await settlePlanItems(deps.session, work.work_id, plan.planId, settle, now());
        if (!allowed.length) continue;
        await remove(work, allowed, { kind: 'explicit', request_id: plan.confirmedBy, planId: plan.planId }, async (current, tx) => {
          const live = { ...facts, ...await commitFacts(current, tx) };
          for (const item of pending.filter(entry => allowed.some(candidate => candidate.id === entry.id))) { const code = revalidateItem(current, item, live); if (code) return code; }
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
      // No detail ports composed (e.g. a development controller without execution): no retention at all, nothing written to any Work.
      if (deps.stopped() || !deps.settled() || !deps.details) return;
      let works: WorkRecord[];
      try { works = await deps.readWorks(); } catch (error) { failed(null, 'read-works', error); return; }
      try { await executeForgets(works); } catch (error) { failed(null, 'forget', error); }
      try { await scrubForgotten(); } catch (error) { failed(null, 'storage-scrub', error); }
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
