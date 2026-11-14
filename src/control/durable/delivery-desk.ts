import { randomUUID } from 'node:crypto';
import type { CodeRepository } from '../../code-repository/index.js';
import type { EnvironmentRef } from '../../sandbox/index.js';
import type { CleanupPorts, ConfiguredRepository } from '../types.js';
import { branchOutcome, cleanupEligibility, decideMerge, environmentOutcomes, ownPullRequestOf, planCleanup, selectPending } from '../rules/delivery.js';
import { recordCleanupIntent, recordCleanupResult, recordMergeObservation, recordPreservation, recordSweep } from './delivery.js';
import type { WorkRecord } from './admission.js';
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
  running(work_id: string): boolean; interrupt(work_id: string): Promise<unknown>; readWorks(): Promise<WorkRecord[]>; stopped(): boolean; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const retryMs = (deps.cleanup?.retrySeconds ?? 86400) * 1000;
  // Works swept by THIS owner process (memory only): a restart sweeps every pending cleanup once more (boot sweep).
  const swept = new Set<string>();
  const configured = (repository: string) => deps.repositories.find(scope => scope.repository.toLowerCase() === repository.toLowerCase());

  async function observeMerges() {
    if (!deps.repository.readPullRequest) return;
    let reads = 0;
    for (const work of await deps.readWorks()) {
      if (deps.stopped() || reads >= readsPerCycle) return;
      const own = work.result === 'open' ? ownPullRequestOf(work as { publication?: unknown }) : null;
      const scope = configured(work.repository.repository);
      if (!own || !scope) continue;
      reads++;
      const observation = await deps.repository.readPullRequest({ repo: scope, repositoryId: work.repository.repositoryId, number: own.number,
        pullRequestId: own.pullRequestId, nodeId: own.nodeId }).catch(() => ({ kind: 'unavailable' as const, code: 'DELIVERY_READ_FAILED', observedAt: null }));
      const decision = observation.kind === 'observed'
        ? decideMerge(own, { repositoryId: work.repository.repositoryId, branch: work.branch ?? own.headRef, base: work.repository.base }, observation.pullRequest)
        : { outcome: 'unavailable' as const, reasons: [observation.code] };
      const recorded = await recordMergeObservation(deps.session, work.work_id, { own, observedAt: observation.observedAt, decision });
      // Merge during an activity is still delivery; the activity is interrupted so the agent takes no new action (its commits already refuse).
      if (recorded.kind === 'delivered' && (recorded.duringActivity || deps.running(work.work_id))) await deps.interrupt(work.work_id).catch(() => {});
    }
  }

  async function sweep(work: WorkRecord) {
    const scope = configured(work.repository.repository);
    const eligibility = cleanupEligibility(work, deps.running(work.work_id));
    const plan = planCleanup(work, { repositoryConfigured: scope !== undefined });
    const view = await recordSweep(deps.session, work.work_id, { eligibility, planned: plan.resources, protected: plan.protected });
    if (view === 'stale' || !eligibility.eligible) return;
    swept.add(work.work_id);
    const pending = selectPending(view.resources);
    const cleanup = deps.cleanup;
    for (const environment of [...new Set(pending.flatMap(item => item.environment ? [item.environment] : []))]) {
      if (deps.stopped() || !cleanup) break;
      if (!view.evidence.some(item => item.environment === environment && item.state !== 'failed')) {
        // Evidence that sustains retained records leaves the environment BEFORE anything in it may be removed.
        const preserved = await cleanup.preserve({ workId: work.work_id, environment: environment as EnvironmentRef })
          .catch(() => ({ status: 'failed' as const, code: 'EVIDENCE_PRESERVATION_FAILED' }));
        if (await recordPreservation(deps.session, work.work_id, environment, preserved) === 'stale' || preserved.status === 'failed') continue;
      }
      const ids = pending.filter(item => item.environment === environment).map(item => item.id);
      const effectId = randomUUID();
      if (await recordCleanupIntent(deps.session, work.work_id, ids, effectId) !== 'recorded') continue;
      // Host assertions for the Sandbox (not credentials): delivered, revalidated now, evidence preserved. Sandbox re-proves ownership/cessation.
      const removal = await cleanup.remove({ environment: environment as EnvironmentRef, cleanup: { workId: work.work_id, workDisposition: 'delivered', confirmed: true, evidencePreserved: true } })
        .catch(() => ({ status: 'indeterminate' as const, code: 'SANDBOX_REMOVE_UNAVAILABLE', resources: [] }));
      const outcomes = environmentOutcomes(removal);
      await recordCleanupResult(deps.session, work.work_id, effectId, Object.fromEntries(pending.filter(item => item.environment === environment)
        .map(item => [item.id, outcomes[item.kind as keyof typeof outcomes]])));
    }
    const branch = pending.find(item => item.kind === 'remote-branch');
    const merge = work.delivery?.merge;
    const own = ownPullRequestOf(work as { publication?: unknown });
    if (deps.stopped() || !branch || !scope || !merge || !own || !work.branch || !deps.repository.cleanupBranch) return;
    const effectId = randomUUID();
    if (await recordCleanupIntent(deps.session, work.work_id, [branch.id], effectId) !== 'recorded') return;
    const result = await deps.repository.cleanupBranch({ repo: scope, repositoryId: work.repository.repositoryId, branch: work.branch, base: work.repository.base,
      expectedTip: merge.headSha, pullRequest: { number: merge.number, pullRequestId: merge.pullRequestId } }, { effectId })
      .catch(() => ({ outcome: 'indeterminate' as const, code: 'BRANCH_CLEANUP_UNAVAILABLE', observedAt: '', tip: null, revocation: 'unknown', nextStep: '', effectId }));
    await recordCleanupResult(deps.session, work.work_id, effectId, { [branch.id]: branchOutcome(result) });
  }

  return {
    async cycle() {
      if (deps.stopped()) return;
      await observeMerges();
      for (const work of await deps.readWorks()) {
        if (deps.stopped()) return;
        const cleanup = work.cleanup;
        if (work.result !== 'delivered' || !cleanup || cleanup.state === 'complete') continue;
        const due = cleanup.state === 'waiting' || !swept.has(work.work_id) || cleanup.lastSweepAt === null || now() - Date.parse(cleanup.lastSweepAt) >= retryMs;
        if (!due) continue;
        // One Work's unexpected failure never stops the others; its records stay as they are (no result is invented).
        await sweep(work).catch(() => {});
      }
    },
  };
}
