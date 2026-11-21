import type { BootLedgerEntry, Impediment, OriginObservation } from '../types.js';
export type { BootLedgerEntry } from '../types.js';

// Pure rules of v2 ticket 09 (V2-10, V2-12, V2-13, V2-14): the clock of one boot of a sandbox that declares a maximum boot duration, the
// notice that asks the working session for its work in progress before the boot is swapped, and the limit against loops of boots that
// publish nothing. No I/O, clock or randomness: callers supply every fact. A sandbox that declares no boot duration never rotates.

/** Offsets from the start of a boot, in milliseconds of the caller's monotonic clock. */
export type BootSchedule = {
  /** The rotation margin is crossed: the swap is due at the next return of the call in flight (V2-13). */ marginAtMs: number;
  /** Half the margin is left: a call that has not returned is interrupted by the sandbox (V2-13). */ interruptAtMs: number;
  /** The maximum duration: the service ends the boot; whatever the gate did not accept by now is lost. */ endAtMs: number };

/**
 * V2-12: maximum duration and rotation margin come from the declared capability (the adapter's profile), never from which sandbox it
 * is. This clock is the BOOT's: it is not the Execution timeout, which keeps running across a swap.
 */
export function bootSchedule(bootDuration: { maxSeconds: number; rotationMarginSeconds: number } | null | undefined): BootSchedule | null {
  if (!bootDuration) return null;
  const endAtMs = bootDuration.maxSeconds * 1000;
  const margin = Math.min(endAtMs, Math.max(0, bootDuration.rotationMarginSeconds * 1000));
  return { marginAtMs: endAtMs - margin, interruptAtMs: endAtMs - Math.floor(margin / 2), endAtMs };
}

/**
 * V2-13: the swap notice, delivered as its own activation of the SAME Builder session before the boot ends. It asks only for the work
 * in progress on `origin`; the preservation gate decides afterwards, and only then is the boot replaced.
 */
export function swapNoticePrompt(input: { branch: string; push: string; secondsLeft: number; interrupted: boolean; pullRequest: boolean }): string {
  return [
    'Factory notice (planned boot swap): this environment reached its rotation margin and will be REPLACED by a new one. You continue afterwards, in this same session, ' +
      `in the new environment. This environment keeps NO disk: whatever is not on the Work branch ${input.branch} on origin when it ends is lost.`,
    ...(input.interrupted ? ['The call that was running was interrupted by the Factory because it did not return in time: its effects may have happened in part. ' +
      'Inspect the state before committing; do not repeat it here.'] : []),
    `You have about ${Math.max(0, Math.floor(input.secondsLeft))} seconds. Publish your work in progress NOW, in /workspace/checkout, and end your turn; the Factory checks by itself. ` +
      'It accepts only: no uncommitted change, no untracked file that is not ignored, no stash, and HEAD equal to the tip of the Work branch on origin.',
    '- Commit what belongs to the work as work in progress (a WIP commit is fine), delete or ignore what is disposable, and apply or drop every stash.',
    `- Then publish with exactly this command, ALONE as its own bash call (any other push is refused): ${input.push}`,
    '- If origin moved (the push is rejected as non-fast-forward), fetch and integrate the remote tip first, then push again with the same command.',
    '- If nothing is pending and HEAD is already the tip on origin, just end your turn.',
    input.pullRequest ? '- Do not open, close or edit pull requests here.' : '- No pull request is needed to publish work in progress; do not open one here.',
    'This procedure does not authorize committing secrets, credentials or data that must not be versioned. If the work cannot be published safely, do not commit it: ' +
      'say what blocks it as your final message and end your turn.',
    'Do not continue the implementation, do not start long commands, do not ask questions and do not hand off for review in this activation. ' +
      'Ignored files, installed packages, caches and Docker data will not exist in the new environment.',
  ].join('\n');
}

/** What the session reads when its work continues in the new boot, after the fixed new-boot notice. */
export const swapContinuationPrompt = (input: { interrupted: boolean }) => ['continue',
  'Factory continuation of the SAME session after a planned boot swap: your work in progress was published and confirmed, the earlier environment ended and you are now in the ' +
    'new one described by the notice above. Continue the work where you left it; rebuild what you need (dependencies, caches, containers).',
  ...(input.interrupted ? ['A call was interrupted before the swap: inspect the current state before repeating it, and prefer a form of it that fits in one boot.'] : []),
].join('\n');

/** V2-14: the diagnostic of the block, "sem progresso entre boots". */
export const noProgressCode = 'NO_PROGRESS_BETWEEN_BOOTS';
/** How many boots of the Work the ledger keeps (the rule reads the last two). */
export const bootLedgerLimit = 16;

/** The ledger after one more ended boot: order kept, one entry per boot (a repeated record replaces it), oldest dropped. */
export function rememberBoot(ledger: readonly BootLedgerEntry[] | null | undefined, entry: BootLedgerEntry): BootLedgerEntry[] {
  return [...(ledger ?? []).filter(item => item.boot !== entry.boot), entry].slice(-bootLedgerLimit);
}

const known = (tip: OriginObservation) => tip.state !== 'unknown';
const same = (from: OriginObservation, to: OriginObservation) => from.state === 'present' && to.state === 'present' ? from.sha === to.sha : from.state === to.state;
/**
 * Whether a boot ended in a way that returns by itself (the planned swap, the loss answered by a substitute) having published nothing:
 * the Work branch tip on `origin`, as Control read it when the boot started and when it ended, did not move. An unread tip proves
 * nothing. A boot that ended by an ordinary return of control (`end`: an external wait with the gate accepted, a completion, a failure
 * with its own treatment) is not part of an automatic sequence of boots and never counts.
 */
const withoutProgress = (entry: BootLedgerEntry) => entry.end !== 'end' && known(entry.startTip) && known(entry.endTip) && same(entry.startTip, entry.endTip);

/**
 * V2-14: two consecutive boots of the same Work ended with no new commit published between them block instead of a third boot. The
 * boots are the Work's, across its Executions. Covers the indivisible call longer than a boot.
 */
export function bootLoopDecision(ledger: readonly BootLedgerEntry[] | null | undefined): { outcome: 'proceed' } | { outcome: 'blocked'; code: typeof noProgressCode; boots: [string, string]; tip: string | null } {
  const [first, second] = (ledger ?? []).slice(-2);
  if (!first || !second || !withoutProgress(first) || !withoutProgress(second)) return { outcome: 'proceed' };
  return { outcome: 'blocked', code: noProgressCode, boots: [first.boot, second.boot], tip: second.endTip.state === 'present' ? second.endTip.sha : null };
}

export function noProgressImpediment(input: { boots: readonly [string, string]; tip: string | null; branch: string; workId?: string }, since: string): Impediment {
  return { code: noProgressCode, scope: 'work', since,
    nextStep: `No progress between boots (sem progresso entre boots): the last two boots of this Work (${input.boots[0]}, ${input.boots[1]}) each ended by a planned swap or a loss ` +
      `without any new commit published on ${input.branch} (${input.tip ? `still at ${input.tip}` : 'the branch does not exist on origin'}), so no third boot was started. ` +
      'The usual cause is a single step longer than one boot. Inspect the Work (`factory show`, `factory logs`), change what makes the step indivisible or the boot duration of the ' +
      `sandbox profile, then let the Work try again with \`factory resume ${input.workId ?? '<work>'} --request-id <id>\` (it returns as one operational recovery and the sequence of ` +
      'boots is counted from zero), or cancel it.' };
}
