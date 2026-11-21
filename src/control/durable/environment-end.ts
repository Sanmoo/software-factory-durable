import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';
import { works } from './admission.js';

/**
 * v2 ticket 10 (V2-15): Control's durable record that the sandbox confirmed the end of the environment of an Execution's boot, with the
 * reason the sandbox observed. Written before the end of the Execution; the loss record (ticket 12) and the consumption (ticket 14) read it.
 */
export async function recordEnvironmentEnd(session: Session, work_id: string, executionId: string, boot: string, observed: { reason: string | null; terminatedAt: string | null }) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution?.executionId === executionId ? document.work.execution : null;
    if (!execution) return 'stale' as const;
    execution.environmentEnd ??= { at: new Date().toISOString(), boot, reason: observed.reason?.slice(0, 512) ?? null, terminatedAt: observed.terminatedAt };
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}
