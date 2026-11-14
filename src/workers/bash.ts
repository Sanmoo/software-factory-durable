import { randomUUID } from 'node:crypto';
import { createBashTool, type BashOperations, type ToolDefinition } from '#factory-pi';
import { z } from 'zod';
import type { ToolContext, ToolProjection, ReadResult } from '../sandbox/index.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const copyReply = z.strictObject({ status: z.literal('success'), format: z.literal('text'),
  reference: z.strictObject({ workId: z.string(), id: z.uuid() }), bytes: count.max(8192),
  nextOffset: count.max(8192), encoding: z.literal('base64'), data: z.string().max(10924) });
const copyMetadata = z.strictObject({
  path: z.string().regex(/^\/artifacts\/factory-output-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/),
  bytes: count, sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
function copiedPath(reply: ReadResult, workId: string) {
  try {
    const result = copyReply.parse(reply);
    const bytes = Buffer.from(result.data, 'base64');
    if (result.reference.workId !== workId || bytes.toString('base64') !== result.data ||
        bytes.length !== result.bytes || result.nextOffset !== bytes.length) throw new Error('BASH_COPY_METADATA_INVALID');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const metadata = copyMetadata.parse(JSON.parse(text));
    // Owner emits exactly this canonical small object. Reject duplicate/extra keys,
    // whitespace, alternate encodings and partial pages. metadata.bytes describes
    // the WHOLE refiltered file, NOT these small protocol metadata bytes.
    if (text !== JSON.stringify(metadata)) throw new Error('BASH_COPY_METADATA_INVALID');
    return metadata.path;
  } catch { throw new Error('BASH_COPY_METADATA_INVALID'); }
}

/** Only the final native formatter's footer is eligible, never stdout markers.
 * The SDK remains the formatter/truncator; this checks its closed v3 grammar. */
function guestPresentation(result: Awaited<ReturnType<ReturnType<typeof createBashTool>['execute']>>, path: string) {
  const details = result.details;
  const truncation = details?.truncation;
  const host = details?.fullOutputPath;
  if (!truncation?.truncated || !host || result.content.length !== 1 || result.content[0]?.type !== 'text') {
    throw new Error('BASH_NATIVE_FOOTER_UNAVAILABLE');
  }
  const text = result.content[0].text;
  const structured = result.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) throw new Error('BASH_NATIVE_FOOTER_UNAVAILABLE');
  const exitCode = (structured as { exit_code?: number }).exit_code;
  if (!Number.isInteger(exitCode)) throw new Error('BASH_NATIVE_FOOTER_UNAVAILABLE');
  const status = exitCode === 0 ? '' : `\n\nCommand exited with code ${exitCode}`;
  const end = text.length - status.length;
  if (!text.endsWith(status) || !text.slice(0, end).endsWith(`. Full output: ${host}]`)) throw new Error('BASH_NATIVE_FOOTER_UNAVAILABLE');
  const start = text.lastIndexOf('\n\n[Showing ', end);
  const footer = text.slice(start, end);
  const prefix = footer.slice(0, -(`. Full output: ${host}]`.length));
  const first = truncation.totalLines - truncation.outputLines + 1;
  const last = truncation.totalLines;
  let valid: boolean;
  if (truncation.lastLinePartial) {
    valid = /^\n\n\[Showing last [0-9.]+(?:B|KB|MB) of line [0-9]+ \(line is [0-9.]+(?:B|KB|MB)\)$/.test(prefix) && prefix.includes(` of line ${last} `);
  } else if (truncation.truncatedBy === 'lines') {
    valid = prefix === `\n\n[Showing lines ${first}-${last} of ${last}`;
  } else {
    valid = prefix.startsWith(`\n\n[Showing lines ${first}-${last} of ${last} (`) &&
      /^\n\n\[Showing lines [0-9]+-[0-9]+ of [0-9]+ \([0-9.]+(?:B|KB|MB) limit\)$/.test(prefix);
  }
  if (start < 0 || !valid) throw new Error('BASH_NATIVE_FOOTER_UNAVAILABLE');
  const pathStart = end - host.length - 1;
  return { ...result, content: [{ ...result.content[0], text: text.slice(0, pathStart) + path + text.slice(pathStart + host.length) }],
    details: { ...details, fullOutputPath: path },
    structuredContent: { ...structured, ...('full_output_path' in structured ? { full_output_path: path } : {}) } };
}

// Private optional capability extension only: upstream SDK types remain truthful.
type DrainAwareOptions = Parameters<BashOperations['exec']>[2] & {
  onDataAsync?: (data: Buffer) => Promise<void>;
};

/** Native Bash with COMPLETE remote operations. Only explicit trusted Host policy
 * copies completed native-truncated output. Host spill remains private SDK state. */
export type BashObservation = { command: string; exitCode: number | null; output: { workId: string; id: string } | null; code: string | null };
export function builderBash(context: ToolContext, sandbox: ToolProjection, onCritical: () => void = () => {}, copyOutput = false,
  /** Ticket 13: the Host's own record of each completed (or lost) Bash result, the only source of gate evidence. */
  observe?: (callId: string, observation: BashObservation) => void): ToolDefinition {
  const copyEnabled = copyOutput === true;
  let failed = false;
  let timeoutFailure = false;
  const critical = () => { failed = true; onCritical(); };
  const native = (completed?: (result: Extract<ReadResult, { status: 'success' }>) => void) => createBashTool('/workspace', {
    exposeSessionEnvironment: false,
    // Replace, never inherit the SDK's parent environment clone. Owner independently
    // selects EMPTY env and /workspace, regardless of this untrusted callback input.
    spawnHook: ({ command }) => ({ command, cwd: '/workspace', env: {} }),
    operations: { async exec(command, _cwd, options: DrainAwareOptions) {
      if (typeof options.onDataAsync !== 'function') throw new Error('BASH_ASYNC_CAPTURE_REQUIRED');
      if (failed) throw new Error('BASH_INVOCATION_REVOKED');
      if (options.signal?.aborted) { critical(); throw new Error('aborted'); }
      const result = await sandbox.executeTool(context, { name: 'bash', command, callId: randomUUID(),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }) }, options.onDataAsync, options.signal);
      if (result.status === 'failure') {
        if (!['BASH_ROLE_DENIED', 'INVALID_TOOL_CALL'].includes(result.code)) critical();
        if (options.signal?.aborted) throw new Error('aborted');
        if (result.code === 'BASH_TIMEOUT_EFFECTS_UNKNOWN') { timeoutFailure = true; throw new Error(`timeout: ${options.timeout}`); }
        throw new Error(result.code);
      }
      if (result.format !== 'text' || result.exitCode === undefined) { critical(); throw new Error('BASH_RESULT_UNAVAILABLE'); }
      completed?.(result);
      return { exitCode: result.exitCode };
    } },
  });
  const definition = native();
  // Fixed host composition: the shared channel admits one tool at a time.
  return { name: 'bash', label: 'bash',
    executionMode: 'sequential',
    description: 'Run Bash in the bound Builder guest with empty environment and fixed /workspace cwd. UTF-8 text only; binary output unsupported. With explicit Host policy, completed native-truncated output is copied to a generated guest artifact; otherwise fullOutputPath is protected host metadata, not a guest path. With that policy, native Read is confined to copies published by this invocation. Timeout/abort requests do not prove physical cessation.',
    parameters: definition.parameters,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    async execute(callId, args, signal, onUpdate) {
      if (context.role !== 'builder') throw new Error('BASH_ROLE_DENIED');
      if (failed) throw new Error('BASH_INVOCATION_REVOKED');
      const input = args as { command: string; timeout?: number };
      if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout * 1000 > 2147483647)) {
        throw new Error('Invalid timeout: must be finite, positive and within native timer range');
      }
      // Private per-execute completion slot; neither model callId/args/context nor
      // another concurrent callback can choose this source reference.
      let completed: Extract<ReadResult, { status: 'success' }> | undefined;
      let observed = false;
      const record = (code: string | null) => {
        if (observed || !observe) return;
        observed = true;
        observe(callId, { command: input.command, exitCode: completed && 'exitCode' in completed ? completed.exitCode ?? null : null, output: completed ? { ...completed.reference } : null, code: completed ? null : code });
      };
      try {
        const result = await native(value => { completed = value; record(null); }).execute(callId, input, signal, onUpdate);
        if (!copyEnabled || result.details?.truncation?.truncated !== true) return result;
        if (!completed || signal?.aborted || failed) throw new Error('BASH_COPY_UNAVAILABLE');
        const reply = await sandbox.executeTool(context, { name: 'bash', operation: 'copy-output',
          reference: completed.reference, callId: randomUUID() }, undefined, signal);
        if (signal?.aborted || failed) throw new Error('BASH_COPY_UNAVAILABLE');
        return guestPresentation(result, copiedPath(reply, context.workId));
      }
      catch {
        record('BASH_EFFECTS_OR_CAPTURE_UNKNOWN');
        critical();
        if (signal?.aborted) throw new Error('Command aborted (effects unknown)');
        if (timeoutFailure) throw new Error(`Command timed out after ${input.timeout} seconds (effects unknown)`);
        throw new Error('BASH_EFFECTS_OR_CAPTURE_UNKNOWN');
      }
    },
  };
}
