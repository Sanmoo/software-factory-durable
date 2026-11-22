import type { ChannelReport } from '../../contracts/index.js';
import type { IndeterminateEffectRecord } from '../types.js';

/**
 * v2 ticket 11 (V2-21), pure: what Control keeps of a sandbox's channel report. Control decides from the declared capability and the
 * report only; it never learns which sandbox is behind them.
 */
/** The Work-scoped reason of an Execution whose tool channel could not be re-established while its environment was alive. */
export const channelUnrecoverableCode = 'SANDBOX_CHANNEL_UNRECOVERABLE';
/** Effects kept per Execution. A report beyond it keeps the earliest ones: the record is evidence for a person, not a log. */
export const indeterminateEffectsLimit = 64;

/**
 * The Execution's record after a report: effects already recorded are kept as they were (first record wins, by call), new ones are
 * appended in the report's order, up to the limit. `executionId` of the record is always the Execution Control read the report for.
 */
export function mergeEffects(
  recorded: readonly IndeterminateEffectRecord[],
  report: ChannelReport,
  context: { executionId: string; boot: string; recordedAt: string },
): IndeterminateEffectRecord[] {
  const merged = [...recorded];
  for (const effect of report.indeterminateEffects) {
    if (merged.length >= indeterminateEffectsLimit) break;
    if (merged.some(item => item.boot === context.boot && item.callId === effect.callId)) continue;
    merged.push({ ...effect, executionId: context.executionId, boot: context.boot, recordedAt: context.recordedAt });
  }
  return merged;
}

/** The end code of a failed Execution: a channel that could not be recovered names itself instead of the worker failure it caused. */
export function failureCodeAfter(code: string, report: ChannelReport | null): string {
  return report?.unrecoverable ? channelUnrecoverableCode : code;
}

/**
 * Operator decision 6: a channel that could not be recovered leaves no impediment. The Execution's failure is transient: its boot is ended
 * and the Work retries on a new boot through one operational recovery. Where the sandbox has no persistent disk, ending a boot that was
 * alive and unreachable loses what it held and `origin` does not: this is the reason recorded on that loss.
 */
export function channelLossReason(unrecoverable: NonNullable<ChannelReport['unrecoverable']>): string {
  return `${channelUnrecoverableCode}: the tool channel could not be re-established in ${unrecoverable.attempts} attempts with the environment alive; Control ended the boot`;
}
