import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';
import { works } from './admission.js';
import type { BootLedgerEntry, BootNoticeRecord, BootSwapRecord } from '../types.js';
import { bootLoopDecision, noProgressImpediment, rememberBoot } from '../rules/boot-rotation.js';

// v2 ticket 09 (V2-10, V2-13, V2-14): the durable trace of a planned boot swap and the Work's ledger of ended boots. Every step is
// recorded with the Execution it belongs to; an activation is recorded BEFORE its launch. Nothing here decides a swap: `rules/boot-rotation`
// does, and the dispatch applies it.

const open = (swaps: BootSwapRecord[] | undefined) => {
  const last = swaps?.at(-1);
  return last && !last.outcome ? last : null;
};

/** The swap became due and the working session yielded: the record every later step of this swap completes. */
export async function beginSwap(
  session: Session,
  work_id: string,
  executionId: string,
  input: { fromBoot: string; yieldedInvocationId: string; interrupted: boolean },
) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.state !== 'started' || execution.dispatch.boot !== input.fromBoot)
      return 'stale' as const;
    const at = new Date().toISOString();
    execution.swaps = [
      ...(execution.swaps ?? []),
      { fromBoot: input.fromBoot, dueAt: at, yieldedInvocationId: input.yieldedInvocationId, interrupted: input.interrupted },
    ];
    work.history.push({
      at,
      event: 'boot-swap-due',
      origin: 'controller-dispatch',
      executionId,
      detail: `${input.fromBoot}${input.interrupted ? ':call-interrupted' : ''}`,
    });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** The swap notice activation: its invocation before the launch, then how it ended. */
export async function recordSwapNotice(session: Session, work_id: string, executionId: string, notice: NonNullable<BootSwapRecord['notice']>) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = work?.execution?.executionId === executionId ? work.execution : null;
    const swap = open(execution?.swaps);
    if (!work || !execution || !swap || (swap.notice && swap.notice.invocationId !== notice.invocationId)) return 'stale' as const;
    if (!swap.notice)
      work.history.push({ at: new Date().toISOString(), event: 'boot-swap-notice', origin: 'controller-dispatch', executionId, detail: notice.invocationId });
    swap.notice = { ...swap.notice, ...notice };
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** How a swap that did not reach a new boot ended (`lost`, `blocked`, `held`, `failed`). */
export async function endSwap(
  session: Session,
  work_id: string,
  executionId: string,
  outcome: { status: 'lost' | 'blocked' | 'held' | 'failed'; code: string | null },
) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = work?.execution?.executionId === executionId ? work.execution : null;
    const swap = open(execution?.swaps);
    if (!work || !execution || !swap) return 'stale' as const;
    const at = new Date().toISOString();
    swap.outcome = { at, ...outcome };
    work.history.push({
      at,
      event: 'boot-swap-ended',
      origin: 'controller-dispatch',
      executionId,
      detail: `${swap.fromBoot}:${outcome.status}${outcome.code ? `:${outcome.code}` : ''}`.slice(0, 512),
    });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * The new boot started (the old one's cessation was confirmed before it was even requested): the Execution now refers to it. Same Work,
 * Execution, Slot, clock and budget charge; nothing is admitted or consumed.
 */
export async function completeSwap(session: Session, work_id: string, executionId: string, input: { fromBoot: string; toBoot: string; commit: string }) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = work?.execution?.executionId === executionId ? work.execution : null;
    const swap = open(execution?.swaps);
    if (!work || !execution || !swap || execution.state !== 'started' || execution.dispatch.boot !== input.fromBoot || swap.fromBoot !== input.fromBoot)
      return 'stale' as const;
    const at = new Date().toISOString();
    execution.dispatch.boot = input.toBoot as typeof execution.dispatch.boot;
    execution.dispatch.updatedAt = at;
    swap.outcome = { at, status: 'swapped', code: null, commit: input.commit, toBoot: input.toBoot };
    work.history.push({ at, event: 'boot-swapped', origin: 'controller-dispatch', executionId, detail: `${input.fromBoot}->${input.toBoot}:${input.commit}` });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * The activation that continues the SAME session in the new boot, recorded before its launch: it becomes the Execution's Builder
 * invocation, the new boot becomes the last one the session saw (V2-11) and the fixed notice it starts with is on the record.
 */
export async function recordSwapContinuation(
  session: Session,
  work_id: string,
  executionId: string,
  input: { boot: string; invocationId: string; bootNotice: BootNoticeRecord | null },
) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = work?.execution?.executionId === executionId ? work.execution : null;
    const swap = execution?.swaps?.at(-1);
    if (!work || !execution || !swap || swap.outcome?.toBoot !== input.boot || execution.dispatch.boot !== input.boot || execution.state !== 'started')
      return 'stale' as const;
    swap.continuation = { invocationId: input.invocationId };
    execution.invocationId = input.invocationId;
    execution.sessionBoot = input.boot;
    if (input.bootNotice) execution.bootNotice = input.bootNotice;
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * V2-14: one ended boot enters the Work's ledger, and the limit against loops is decided in the same commit: two consecutive boots ended
 * by a swap or a loss with no new commit on `origin` block the Work ("sem progresso entre boots") instead of a third boot.
 */
export async function recordBootEnd(session: Session, work_id: string, entry: BootLedgerEntry, branch: string) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work) return 'stale' as const;
    work.bootLedger = rememberBoot(work.bootLedger, entry);
    work.history.push({
      at: entry.at,
      event: 'boot-ended',
      origin: 'controller-dispatch',
      executionId: entry.executionId,
      detail: `${entry.boot}:${entry.begin}->${entry.end}:${entry.startTip.state === 'present' ? entry.startTip.sha : entry.startTip.state}..${entry.endTip.state === 'present' ? entry.endTip.sha : entry.endTip.state}`,
    });
    const decision = bootLoopDecision(work.bootLedger);
    if (decision.outcome === 'blocked' && !work.impediments.some(item => item.code === decision.code)) {
      work.impediments.push(noProgressImpediment({ boots: decision.boots, tip: decision.tip, branch, workId: work_id }, entry.at));
      work.history.push({
        at: entry.at,
        event: 'boot-loop-blocked',
        origin: 'controller-dispatch',
        executionId: entry.executionId,
        detail: `${decision.boots.join(',')}:${decision.tip ?? 'absent'}`,
      });
    }
    return decision;
  }, BACKGROUND_CONTEXT);
}

/**
 * Operator decision 5, extended to the swap (final review, should-fix 5): the service refused the start of the swap's NEW boot for
 * capacity. Nothing started and the work is on `origin`: the Execution waits and tries again by itself. The cause is on the swap and on
 * the Work's history; no impediment, no operational recovery.
 */
export async function recordSwapStartWait(
  session: Session,
  work_id: string,
  executionId: string,
  input: { code: string; detail: string | null; attempt: number; waitSeconds: number },
) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = work?.execution?.executionId === executionId ? work.execution : null;
    const swap = open(execution?.swaps);
    if (!work || !execution || !swap || execution.state !== 'started') return 'stale' as const;
    const at = new Date().toISOString();
    swap.startWait = { code: input.code, detail: input.detail?.slice(0, 512) ?? null, attempt: input.attempt, waitSeconds: input.waitSeconds, at };
    work.history.push({
      at,
      event: 'boot-deferred',
      origin: 'controller-recovery',
      executionId,
      detail:
        `${input.code}${input.detail ? ` (${input.detail.slice(0, 256)})` : ''}; planned swap waits ${input.waitSeconds}s (attempt ${input.attempt + 1}); nothing started, nothing charged`.slice(
          0,
          512,
        ),
    });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}
