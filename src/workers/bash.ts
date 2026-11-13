import { createBashTool, type ToolDefinition } from '#factory-pi';
import type { ToolContext, ToolProjection } from '../sandbox/index.js';

/** Native Bash with COMPLETE remote operations. Native host temp spill is expected;
 * its path is NOT guest-readable. Selective guest copy remains explicitly OPEN.
 */
export function builderBash(context: ToolContext, sandbox: ToolProjection, onCritical: () => void = () => {}): ToolDefinition {
  let failed = false;
  let timeoutFailure = false;
  const critical = () => { failed = true; onCritical(); };
  const native = (callId: string) => createBashTool('/workspace', {
    exposeSessionEnvironment: false,
    // Replace, never inherit the SDK's parent environment clone. Owner independently
    // selects EMPTY env and /workspace, regardless of this untrusted callback input.
    spawnHook: ({ command }) => ({ command, cwd: '/workspace', env: {} }),
    operations: { async exec(command, _cwd, options) {
      if (failed) throw new Error('BASH_INVOCATION_REVOKED');
      if (options.signal?.aborted) { critical(); throw new Error('aborted'); }
      const result = await sandbox.executeTool(context, { name: 'bash', command, callId,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }) }, options.onData, options.signal);
      if (result.status === 'failure') {
        if (!['BASH_ROLE_DENIED', 'INVALID_TOOL_CALL'].includes(result.code)) critical();
        if (options.signal?.aborted) throw new Error('aborted');
        if (result.code === 'BASH_TIMEOUT_EFFECTS_UNKNOWN') { timeoutFailure = true; throw new Error(`timeout: ${options.timeout}`); }
        throw new Error(result.code);
      }
      if (result.format !== 'text' || result.exitCode === undefined) { critical(); throw new Error('BASH_RESULT_UNAVAILABLE'); }
      return { exitCode: result.exitCode };
    } },
  });
  return { name: 'bash', label: 'bash',
    description: 'Run Bash in the bound Builder guest with empty environment and fixed /workspace cwd. UTF-8 text only; binary output unsupported. Host fullOutputPath is protected host metadata, not a guest path. Timeout/abort requests do not prove physical cessation.',
    parameters: native('schema-only').parameters,
    async execute(callId, args, signal, onUpdate) {
      if (context.role !== 'builder') throw new Error('BASH_ROLE_DENIED');
      if (failed) throw new Error('BASH_INVOCATION_REVOKED');
      const input = args as { command: string; timeout?: number };
      if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout * 1000 > 2147483647)) {
        throw new Error('Invalid timeout: must be finite, positive and within native timer range');
      }
      try { return await native(callId).execute(callId, input, signal, onUpdate); }
      catch {
        critical();
        if (signal?.aborted) throw new Error('Command aborted (effects unknown)');
        if (timeoutFailure) throw new Error(`Command timed out after ${input.timeout} seconds (effects unknown)`);
        throw new Error('BASH_EFFECTS_OR_CAPTURE_UNKNOWN');
      }
    },
  };
}
