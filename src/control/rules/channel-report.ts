import type { ChannelReport } from '../../contracts/index.js';
import type { Impediment, IndeterminateEffectRecord } from '../types.js';

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
export function mergeEffects(recorded: readonly IndeterminateEffectRecord[], report: ChannelReport, context: { executionId: string; boot: string; recordedAt: string }): IndeterminateEffectRecord[] {
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

/** The visible impediment of a Work whose Execution lost its tool channel for good with the environment alive. Not transient: never retried by itself. */
export function channelUnrecoverableImpediment(unrecoverable: NonNullable<ChannelReport['unrecoverable']>, context: { workId: string; boot: string; effects: number }): Impediment {
  return { code: channelUnrecoverableCode, scope: 'work', since: unrecoverable.at,
    nextStep: `The tool channel to the environment of boot ${context.boot} dropped and could not be re-established in ${unrecoverable.attempts} attempts while the service ` +
      `reported the environment alive. ${context.effects === 0 ? 'No started tool call was left without a result.'
        : `${context.effects} tool call(s) were left without a result: their effects may have happened and their processes may still be running until the boot ends (see the Execution's indeterminate effects in \`factory show ${context.workId}\`).`} ` +
      `Nothing is retried automatically. Inspect the Execution and the network between this host and the sandbox service; \`factory cancel ${context.workId}\` ends the Work.` };
}
