import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';
import { works } from './admission.js';
import { lossDetail, recordLossOn } from '../rules/loss.js';
import type { LossRecord } from '../types.js';

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
    // The boot is one the Execution lost: its environment ended by itself, or (Operator decision 6) the Execution ended as a failure on
    // that boot and Control ended it while it was alive and unreachable.
    const lostBoot = known?.environmentEnd?.boot === loss.boot || (known?.end?.outcome === 'failure' && known.dispatch.boot === loss.boot);
    if (!known || !lostBoot) return 'stale' as const;
    if (work.losses?.some(item => item.executionId === loss.executionId && item.boot === loss.boot)) return 'recorded' as const;
    work.losses = recordLossOn(work.losses, loss);
    work.history.push({ at: loss.at, event: 'loss-recorded', origin: 'controller-dispatch', executionId: loss.executionId, detail: lossDetail(loss) });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}
