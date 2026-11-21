import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';
import { readWork, works, type WorkRecord } from './admission.js';
import { confirmedAt, lossDetail, markerOf, recordLossOn } from '../rules/loss.js';
import { readOriginTip } from './origin-read.js';
import type { AccessDependencies, ExecutionView, LossRecord } from '../types.js';

/**
 * v2 ticket 12 (V2-17): the durable, visible record of a loss on the WORK: the Execution and boot that died, the last commit confirmed
 * on `origin`, what the activation consumed, the session kept as evidence and whether a loss marker ref exists (Control's own read).
 * Written once per Execution and boot, with its history event, after the end of the Execution was recorded.
 */
export async function recordLoss(session: Session, work_id: string, loss: LossRecord) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work) return 'stale' as const;
    const known = [...work.previousExecutions, ...(work.execution ? [work.execution] : [])].find(item => item.executionId === loss.executionId);
    // The boot is one the Execution lost: its environment ended by itself, or the Execution ended on that boot (a failure, a timeout, a
    // stop) and Control ended the boot with work the preservation check did not find on `origin`. The caller decides that it is a loss.
    const lostBoot = known?.environmentEnd?.boot === loss.boot || (Boolean(known?.end) && known?.dispatch.boot === loss.boot);
    if (!known || !lostBoot) return 'stale' as const;
    if (work.losses?.some(item => item.executionId === loss.executionId && item.boot === loss.boot)) return 'recorded' as const;
    work.losses = recordLossOn(work.losses, loss);
    work.history.push({ at: loss.at, event: 'loss-recorded', origin: 'controller-dispatch', executionId: loss.executionId, detail: lossDetail(loss) });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * V2-16/V2-17: builds and records the loss of the environment of `execution`. Both facts about `origin` are Control's own reads: the Work
 * branch tip (the last commit that survived) and the listing of the Work's loss marker refs. A marker ref is recorded for the substitute
 * to reuse; it never becomes the confirmed commit and never satisfies the preservation gate. Used by the dispatch (a boot it saw end or
 * ended itself) and by the boot reconciliation (a boot that ended with the controller down, which nobody could inspect).
 */
export async function recordLossFrom(deps: { session: Session; access: Pick<AccessDependencies, 'repositories' | 'repository'> }, work: WorkRecord,
  execution: Pick<ExecutionView, 'executionId' | 'invocationId' | 'request'>, { environment, boot }: { environment: string | null; boot: string },
  observed: { reason: string | null; terminatedAt: string | null }, executionMs: number | null, cause?: LossRecord['cause']): Promise<{ outcome: 'recorded' | 'stale'; marker: LossRecord['marker']['state'] }> {
  const branch = execution.request.branch;
  const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
  const origin = await readOriginTip(deps.access, work, branch);
  const read = !configured ? { state: 'unknown' as const, code: 'REPOSITORY_NOT_CONFIGURED' }
    : !deps.access.repository.readLostMarkers ? { state: 'unknown' as const, code: 'LOST_MARKER_READ_NOT_COMPOSED' }
      : await deps.access.repository.readLostMarkers({ repo: configured, repositoryId: work.repository.repositoryId, workId: work.work_id })
        .catch(() => ({ state: 'unknown' as const, code: 'LOST_MARKER_READ_FAILED' }));
  const current = (await readWork(deps.session, work.work_id)) ?? work;
  const loss: LossRecord = { at: new Date().toISOString(), executionId: execution.executionId, boot, environment, ...(cause ? { cause } : {}),
    reason: observed.reason?.slice(0, 512) ?? null, terminatedAt: observed.terminatedAt,
    confirmed: confirmedAt({ branch, origin, preservation: current.preservation ?? null }), consumption: { executionMs },
    session: { invocationId: execution.invocationId, disposition: 'conserved-as-evidence' as const }, marker: markerOf({ workId: work.work_id, boot, read }) };
  return { outcome: await recordLoss(deps.session, work.work_id, loss), marker: loss.marker.state };
}
