import { randomUUID } from 'node:crypto';
import type { CodeRepository } from '../../code-repository/index.js';
import type { EnvironmentRef } from '../../sandbox/index.js';
import type { CleanupPorts, ConfiguredRepository } from '../types.js';
import { markersOutcome, branchOutcome, cleanupEligibility, decideMerge, environmentOutcomes, explicitCancelledCleanup, explicitPending, ownPullRequestOf, planCleanup, selectPending } from '../rules/delivery.js';
import { consumeExplicitCleanup, recordCleanupIntent, recordCleanupResult, recordMergeObservation, recordPreservation, recordSweep } from './delivery.js';
import { dropExplicitResources, preserveSessions } from './retention.js';
import { retentionProtections } from '../rules/retention.js';
import { readForgotten, type WorkRecord } from './admission.js';
import { recordForgottenMerge } from './forget.js';
import type { Session } from './store.js';

/** At most this many own pull request reads per cycle (each one GitHub request); the rest are read on later cycles. */
const readsPerCycle = 8;

/**
 * Ticket 17 delivery desk, run in the existing owner loop (no daemon/scheduler): (1) reads the linked own pull request of open Works and
 * records a confirmed merge as delivery, interrupting an activity still running; (2) sweeps the cleanup of delivered Works: at the first
 * cycle of each owner process (boot sweep after reconciliation), right after delivery/cessation, and then every `retrySeconds` (daily)
 * for what is still pending. Each sweep revalidates eligibility and ownership before any effect; one resource's failure never stops another.
 */
export function createDeliveryDesk(deps: { session: Session; repository: CodeRepository; repositories: ConfiguredRepository[]; cleanup?: CleanupPorts | undefined;
  running(work_id: string): boolean; interrupt(work_id: string): Promise<unknown>; readWorks(): Promise<WorkRecord[]>; stopped(): boolean; now?: () => number;
  /** Ticket 30 (review MED): the Work's retention protections NOW (open Question, unsettled effect, activity…), checked before an explicit plan acts. */
  protections?(work: WorkRecord): Promise<string[]> }) {
  const now = deps.now ?? Date.now;
  const retryMs = (deps.cleanup?.retrySeconds ?? 86400) * 1000;
  // Works swept by THIS owner process (memory only): a restart sweeps every pending cleanup once more (boot sweep).
  const swept = new Set<string>();
  const configured = (repository: string) => deps.repositories.find(scope => scope.repository.toLowerCase() === repository.toLowerCase());

  // In-memory failures of this owner (bounded): one Work's unexpected failure is recorded here and never stops the cycle.
  const failures: { at: string; work_id: string | null; step: string; code: string }[] = [];
  const failed = (work_id: string | null, step: string, error: unknown) => {
    failures.push({ at: new Date().toISOString(), work_id, step, code: error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'UNEXPECTED_FAILURE' });
    failures.splice(0, Math.max(0, failures.length - 50));
  };

  async function observeMerges(works: WorkRecord[]) {
    if (!deps.repository.readOwnMerge) return;
    // Least recently read first (never-read first): a bounded number of reads per cycle reaches every Work in turn. Ticket 25: cancelled cycles
    // and own PRs closed without merge are still read (a human may reopen and merge: a confirmed merge always delivers); reading never
    // reopens, resumes or replaces anything.
    // A cancelled Work whose own PR was observed closed without merge is no longer read (review MED-HIGH).
    const candidates = works.filter(work => (work.result === 'open' || work.result === 'closed-unmerged' ||
        (work.result === 'cancelled' && work.delivery?.observations.at(-1)?.outcome !== 'closed-unmerged')) && ownPullRequestOf(work) && configured(work.repository.repository))
      .sort((a, b) => (a.delivery?.lastReadAt ?? '').localeCompare(b.delivery?.lastReadAt ?? ''));
    for (const work of candidates.slice(0, readsPerCycle)) {
      if (deps.stopped()) return;
      try { await observeOne(work); } catch (error) { failed(work.work_id, 'merge-observation', error); }
    }
  }
  async function observeOne(work: WorkRecord) {
    const own = ownPullRequestOf(work)!;
    const scope = configured(work.repository.repository)!;
    const observation = await deps.repository.readOwnMerge!({ repo: scope, repositoryId: work.repository.repositoryId, number: own.number,
      pullRequestId: own.pullRequestId, nodeId: own.nodeId }).catch(() => ({ kind: 'unavailable' as const, code: 'DELIVERY_READ_FAILED', observedAt: null }));
    const decision = observation.kind === 'observed'
      ? decideMerge(own, { repositoryId: work.repository.repositoryId, branch: work.branch, base: work.repository.base }, observation.pullRequest)
      : { outcome: 'unavailable' as const, reasons: [observation.code] };
    const recorded = await recordMergeObservation(deps.session, work.work_id, { own, observedAt: observation.observedAt, decision });
    // Merge during an activity is still delivery; the activity is interrupted so the agent takes no new action (its commits already refuse).
    if (recorded.kind === 'delivered' && (recorded.duringActivity || deps.running(work.work_id))) await deps.interrupt(work.work_id).catch(() => {});
  }

  /**
   * Ticket 31 (review MED): the own PR of a FORGOTTEN cancelled cycle is still read from its memory watch, least recently read first, within the
   * same bound per cycle; a confirmed merge delivers the memory (spec §12.3). Reading never reopens, resumes or replaces anything.
   */
  async function observeForgotten() {
    if (!deps.repository.readOwnMerge) return;
    const watched = (await readForgotten(deps.session)).filter(item => item.watch?.state === 'watching' && configured(item.repository.repository))
      .sort((a, b) => (a.watch!.lastReadAt ?? '').localeCompare(b.watch!.lastReadAt ?? ''));
    for (const memory of watched.slice(0, readsPerCycle)) {
      if (deps.stopped()) return;
      try {
        const own = memory.watch!.pullRequest;
        const observation = await deps.repository.readOwnMerge({ repo: configured(memory.repository.repository)!, repositoryId: memory.repository.repositoryId, number: own.number,
          pullRequestId: own.pullRequestId, nodeId: own.nodeId }).catch(() => ({ kind: 'unavailable' as const, code: 'DELIVERY_READ_FAILED' }));
        await recordForgottenMerge(deps.session, memory.work_id, observation.kind === 'observed'
          ? decideMerge(own, { repositoryId: memory.repository.repositoryId, branch: memory.watch!.branch, base: memory.repository.base }, observation.pullRequest)
          : { outcome: 'unavailable', reasons: [observation.code] });
      } catch (error) { failed(memory.work_id, 'forgotten-merge-observation', error); }
    }
  }

  async function sweep(work: WorkRecord) {
    const scope = configured(work.repository.repository);
    // An explicit plan confirmed earlier is revalidated at execution: if the Work's details/resources are needed now, it is dropped, never executed.
    const planned = work.cleanup?.explicit && !work.cleanup.explicit.consumed ? work.cleanup.explicit : null;
    if (planned) {
      // Without the composed reader (no Questions), the Work-level protections still apply (activity, effects, cessation, recovery…).
      const current = deps.protections ? await deps.protections(work) : retentionProtections(work, { running: deps.running(work.work_id), questions: [] });
      const needed = current.filter(reason => reason !== 'CLEANUP_PENDING' && reason !== 'DETAIL_REMOVAL_UNSETTLED');
      if (needed.length) { await dropExplicitResources(deps.session, work.work_id, planned.planId, `BECAME_PROTECTED:${needed.join(',')}`.slice(0, 256), now()); return; }
    }
    const eligibility = cleanupEligibility(work, deps.running(work.work_id));
    const plan = planCleanup(work, { repositoryConfigured: scope !== undefined });
    const view = await recordSweep(deps.session, work.work_id, { eligibility, planned: plan.resources, protected: plan.protected });
    if (view === 'stale' || !eligibility.eligible) return;
    swept.add(work.work_id);
    // Ticket 30: under an explicit plan, a resource already attempted after its confirmation (e.g. an intent lost by a crash, now indeterminate)
    // is not attempted again: no implicit retry of an operator decision.
    const explicit = view.explicit && !view.explicit.consumed ? view.explicit : null;
    const pending = explicit ? explicitPending(view.resources, explicit) : selectPending(view.resources);
    const cleanup = deps.cleanup;
    const disposition = explicitCancelledCleanup(work) ? 'cancelled' as const : 'delivered' as const;
    for (const environment of [...new Set(pending.flatMap(item => item.environment ? [item.environment] : []))]) {
      if (deps.stopped() || !cleanup) break;
      if (!view.evidence.some(item => item.environment === environment && item.state !== 'failed')) {
        // Evidence that sustains retained records leaves the environment BEFORE anything in it may be removed.
        const preserved = await cleanup.preserve({ workId: work.work_id, environment: environment as EnvironmentRef })
          .catch(() => ({ status: 'failed' as const, code: 'EVIDENCE_PRESERVATION_FAILED' }));
        if (await recordPreservation(deps.session, work.work_id, environment, preserved) === 'stale' || preserved.status === 'failed') continue;
      }
      // Ticket 30 (spec §12.1/§12.3): the recorded Builder sessions of this environment's Executions are retained details (30 days after the
      // merge, or until explicit cleanup): they are copied to the Records area BEFORE their runtime directories may be removed.
      if (cleanup.details && await preserveSessions(deps.session, cleanup.details, work, environment) !== 'preserved') continue;
      const ids = pending.filter(item => item.environment === environment).map(item => item.id);
      const effectId = randomUUID();
      if (await recordCleanupIntent(deps.session, work.work_id, ids, effectId) !== 'recorded') continue;
      // Host assertions for the Sandbox (not credentials): delivered, revalidated now, evidence preserved. Sandbox re-proves ownership/cessation.
      const removal = await cleanup.remove({ environment: environment as EnvironmentRef, cleanup: { workId: work.work_id, workDisposition: disposition, confirmed: true, evidencePreserved: true } })
        .catch(() => ({ status: 'indeterminate' as const, code: 'SANDBOX_REMOVE_UNAVAILABLE', resources: [] }));
      const outcomes = environmentOutcomes(removal);
      await recordCleanupResult(deps.session, work.work_id, effectId, Object.fromEntries(pending.filter(item => item.environment === environment)
        .map(item => [item.id, outcomes[item.kind as keyof typeof outcomes]])));
    }
    const branch = pending.find(item => item.kind === 'remote-branch');
    const merge = work.delivery?.merge;
    const own = ownPullRequestOf(work);
    if (!deps.stopped() && branch && scope && merge && own && work.branch && deps.repository.cleanupBranch && work.result === 'delivered') await sweepBranch(work, branch, scope, merge);
    // v2 ticket 12 (V2-02 Remover): the Work's loss marker refs, delivered or cancelled; never its branch nor its pull request.
    const markers = pending.find(item => item.kind === 'lost-markers');
    if (!deps.stopped() && markers && scope && deps.repository.cleanupLostMarkers) await sweepMarkers(work, markers, scope);
    if (explicit && !deps.stopped()) await consumeExplicitCleanup(deps.session, work.work_id, explicit.planId);
  }
  async function sweepBranch(work: WorkRecord, branch: { id: string }, scope: ConfiguredRepository, merge: NonNullable<NonNullable<WorkRecord['delivery']>['merge']>) {
    const effectId = randomUUID();
    if (await recordCleanupIntent(deps.session, work.work_id, [branch.id], effectId) !== 'recorded') return;
    const result = await deps.repository.cleanupBranch!({ repo: scope, repositoryId: work.repository.repositoryId, branch: work.branch!, base: work.repository.base,
      expectedTip: merge.headSha, pullRequest: { number: merge.number, pullRequestId: merge.pullRequestId } }, { effectId })
      .catch(() => ({ outcome: 'indeterminate' as const, code: 'BRANCH_CLEANUP_UNAVAILABLE', observedAt: '', tip: null, revocation: 'unknown', nextStep: '', effectId }));
    await recordCleanupResult(deps.session, work.work_id, effectId, { [branch.id]: branchOutcome(result) });
  }

  async function sweepMarkers(work: WorkRecord, markers: { id: string }, scope: ConfiguredRepository) {
    const effectId = randomUUID();
    if (await recordCleanupIntent(deps.session, work.work_id, [markers.id], effectId) !== 'recorded') return;
    const result = await deps.repository.cleanupLostMarkers!({ repo: scope, repositoryId: work.repository.repositoryId, workId: work.work_id }, { effectId })
      .catch(() => ({ outcome: 'indeterminate' as const, code: 'LOST_MARKER_CLEANUP_UNAVAILABLE' }));
    await recordCleanupResult(deps.session, work.work_id, effectId, { [markers.id]: markersOutcome(result) });
  }

  return {
    view: () => ({ failures: [...failures] }),
    /** Never throws: the question desk and the dispatcher run after it in the same owner cycle. */
    async cycle() {
      if (deps.stopped()) return;
      let works: WorkRecord[];
      try { works = await deps.readWorks(); } catch (error) { failed(null, 'read-works', error); return; }
      await observeMerges(works);
      await observeForgotten().catch(error => failed(null, 'forgotten-merge-observation', error));
      try { works = await deps.readWorks(); } catch (error) { failed(null, 'read-works', error); return; }
      for (const work of works) {
        if (deps.stopped()) return;
        const cleanup = work.cleanup;
        const explicit = Boolean(cleanup?.explicit && !cleanup.explicit.consumed);
        if (!cleanup || (work.result !== 'delivered' && !explicitCancelledCleanup(work)) || (cleanup.state === 'complete' && !explicit)) continue;
        // Ticket 30: a confirmed explicit plan is swept at the next cycle (once).
        const due = explicit || cleanup.state === 'waiting' || !swept.has(work.work_id) || cleanup.lastSweepAt === null || now() - Date.parse(cleanup.lastSweepAt) >= retryMs;
        if (!due) continue;
        // One Work's unexpected failure never stops the others; its records stay as they are (no result is invented).
        try { await sweep(work); } catch (error) { failed(work.work_id, 'cleanup-sweep', error); }
      }
    },
  };
}
