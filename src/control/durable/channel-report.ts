import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';
import type { ChannelReport } from '../../contracts/index.js';
import { mergeEffects } from '../rules/channel-report.js';
import { works } from './admission.js';

/**
 * v2 ticket 11 (V2-21): Control's durable record of what the sandbox reported about the tool channel of an Execution's boot. The
 * indeterminate effects go on the Execution they happened in (the package of a substitute session reads them from there). A channel that
 * could not be recovered leaves no impediment (Operator decision 6): the dispatch ends the Execution under that code, which is transient.
 * Idempotent: reading the same report again adds nothing.
 */
export async function recordChannelReport(session: Session, work_id: string, executionId: string, boot: string, report: ChannelReport) {
  if (report.indeterminateEffects.length === 0) return 'empty' as const;
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution?.executionId === executionId ? work.execution : work?.previousExecutions?.find(item => item.executionId === executionId);
    if (!work || !execution) return 'stale' as const;
    const recordedAt = new Date().toISOString();
    execution.indeterminateEffects = mergeEffects(execution.indeterminateEffects ?? [], report, { executionId, boot, recordedAt });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Final review, standards 4: the sandbox's channel record of a boot could not be read (or its content not recorded). Never silent and
 * never "nothing happened": the fact is on the Work's history, once per Execution, boot and code, and the substitute's package says it.
 */
export async function recordChannelReportUnread(session: Session, work_id: string, executionId: string, boot: string, code: string) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work) return 'stale' as const;
    const detail = `${boot}:${code}`.slice(0, 256);
    if (!work.history.some(item => item.event === 'channel-report-unread' && item.executionId === executionId && item.detail === detail)) {
      work.history.push({ at: new Date().toISOString(), event: 'channel-report-unread', origin: 'controller-dispatch', executionId, detail });
    }
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}
