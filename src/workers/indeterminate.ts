/**
 * v2 ticket 11 (V2-21): a tool call whose channel to the environment dropped after it started. The sandbox reconnected, ended the call's
 * process and answered with one of these codes instead of ending the invocation. Only a sandbox that recovers a dropped channel emits
 * them; under any other sandbox a lost channel still ends the session (the MVP rule).
 *
 * It is neither a success nor "not executed": the session gets a tool error whose text says the effect may have happened, and goes on.
 */
const what: Record<string, string> = {
  BASH_RESULT_INDETERMINATE: 'this command was running',
  WRITE_RESULT_INDETERMINATE: 'this file was being written',
  EDIT_SOURCE_RESULT_INDETERMINATE: 'this edit was being applied',
};
export const isIndeterminateResult = (code: string): boolean => Object.hasOwn(what, code);

/** The model-visible text of an indeterminate result. */
export function indeterminateResultText(code: string): string {
  return `RESULT INDETERMINATE (${code}): the connection to the environment dropped while ${what[code] ?? 'this call was running'}. ` +
    'It started and its effects may have happened, completely or in part; it is not confirmed as executed and not confirmed as not executed. ' +
    'Its process was ended and whatever it printed after the drop is lost. Do not assume the outcome either way: inspect the current state ' +
    '(files, Git, the external system it touches) before deciding whether to repeat it, and do not repeat an effect that is not safe to apply twice.';
}
