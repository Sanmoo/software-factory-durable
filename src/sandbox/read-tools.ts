import { z } from 'zod';
import { connect, listen, protocolVersion, type Envelope } from '../protocol/index.js';
import type { createRecords } from '../records/index.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const contextSchema = z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
  role: z.enum(['standards', 'spec']), environmentRef: identifier, bootRef: identifier, phaseId: identifier });
export type ToolContext = z.infer<typeof contextSchema>;
const callSchema = z.strictObject({ name: z.literal('read'), path: z.string().min(1).max(4096), callId: identifier });
export type ReadCall = z.infer<typeof callSchema>;
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), display: z.string(), reference: z.strictObject({ workId: identifier, id: z.uuid() }),
    truncated: z.boolean() }),
  z.strictObject({ status: z.literal('failure'), code: z.string() }),
]);
export type ReadResult = z.infer<typeof resultSchema>;
// Only the already-running native VM owner supplies this boundary. Never projected to a worker.
type GuestOwner = { exec(argv: string[], options: { stdout: 'buffer'; stderr: 'ignore' }):
  PromiseLike<{ exitCode: number; stdoutBuffer: Buffer }> };
const readBytes = 16384;
const failure = (code: string): ReadResult => ({ status: 'failure', code });
function sameContext(left: ToolContext | undefined, right: ToolContext): boolean {
  return !!left && Object.keys(right).every(key => left[key as keyof ToolContext] === right[key as keyof ToolContext]);
}
function envelope(messageId: string, kind: string, payload: Envelope['payload'], replyTo: string | null = null): Envelope {
  return { protocol_version: protocolVersion, controller_run_id: null, message_id: messageId, reply_to: replyTo, kind, payload };
}

/** Trusted composition in the existing per-Work VM owner only. The host allocates a
 * private endpoint within this boot's directory, and binds one reviewer invocation.
 * current() reads host authority, not request data. Closing/revoking never boots or
 * adopts a VM. This read-only slice does not implement Builder tools or SDK read. */
export async function serveReadTools(options: { endpoint: string; context: ToolContext; current(): ToolContext | undefined;
  records: Awaited<ReturnType<typeof createRecords>>; vm: GuestOwner }): Promise<{ endpoint: string; close(): Promise<void> }> {
  const bound = Object.freeze(contextSchema.parse(options.context));
  let closed = false;
  const valid = () => !closed && sameContext(options.current(), bound);
  async function executeTool(context: ToolContext, call: ReadCall): Promise<ReadResult> {
    if (!sameContext(context, bound) || !valid()) return failure('STALE_TOOL_CONTEXT');
    // Lexical selection is not a symlink jail: any symlink is resolved ONLY in
    // the guest by the existing VM. No host fs/exec fallback exists here.
    if (!/^\/(workspace|artifacts)\/[^\0]*$/.test(call.path) || call.path.split('/').includes('..')) return failure('READ_PATH_DENIED');
    try {
      const { phaseId: _phaseId, ...captureContext } = bound;
      const output = await options.records.openOutput({ ...captureContext, callId: call.callId });
      if (!valid()) { await output.finish(); return failure('STALE_TOOL_CONTEXT'); }
      // argv only, never host execution or caller-provided shell; cap collection
      // before the Records boundary. Discard guest error text rather than leak it.
      let result: { exitCode: number; stdoutBuffer: Buffer };
      try {
        result = await options.vm.exec(['/usr/bin/head', '-c', String(readBytes + 1), '--', call.path],
          { stdout: 'buffer', stderr: 'ignore' });
      } catch {
        // Records has no abort operation: close the empty capture, do not leak an
        // open handle or mistake it for evidence of a successful guest read.
        await output.finish();
        return failure('PROTECTED_READ_UNAVAILABLE');
      }
      if (result.exitCode !== 0) { await output.finish(); return failure('GUEST_READ_FAILED'); }
      await output.write(result.stdoutBuffer);
      const filteredRecords = await output.finish();
      if (!valid()) return failure('STALE_TOOL_CONTEXT');
      return { status: 'success', display: filteredRecords.display, reference: filteredRecords.reference,
        truncated: filteredRecords.truncated || result.stdoutBuffer.length > readBytes };
    } catch { return failure('PROTECTED_READ_UNAVAILABLE'); }
  }
  const server = await listen(options.endpoint, { async message(request, channel) {
    const parsed = z.strictObject({ context: contextSchema, call: callSchema }).safeParse(request.payload);
    const result = request.kind !== 'execute-tool' || !parsed.success || request.message_id !== parsed.data.call.callId
      ? failure('INVALID_TOOL_CALL') : await executeTool(parsed.data.context, parsed.data.call);
    await channel.send(envelope(request.message_id, 'tool-result', result, request.message_id));
  } }, 'local-operator');
  let closing: Promise<void> | undefined;
  return { endpoint: options.endpoint, close() { closed = true; return closing ??= server.close(); } };
}

/** Host constructs this projection with its binding. Model input is ONLY the call;
 * changing a role/boot in a wire message never changes the owner's binding. */
export async function connectReadTools(endpoint: string, context: ToolContext): Promise<{
  executeTool(call: ReadCall): Promise<ReadResult>; close(): void;
}> {
  const bound = Object.freeze(contextSchema.parse(context));
  const channel = await connect(endpoint, 'local-operator');
  const messages = channel.messages[Symbol.asyncIterator]();
  let closed = false;
  let busy = false;
  return {
    async executeTool(input) {
      if (closed) return failure('TOOL_CHANNEL_CLOSED');
      if (busy) return failure('TOOL_CALL_IN_PROGRESS');
      const call = callSchema.safeParse(input);
      if (!call.success) return failure('INVALID_TOOL_CALL');
      busy = true;
      try {
        await channel.send(envelope(call.data.callId, 'execute-tool', { context: bound, call: call.data }));
        const response = await messages.next();
        if (response.done || response.value.kind !== 'tool-result' || response.value.reply_to !== call.data.callId) throw new Error('TOOL_CHANNEL_CLOSED');
        return resultSchema.parse(response.value.payload);
      } catch { closed = true; channel.close(); return failure('TOOL_CHANNEL_CLOSED'); }
      finally { busy = false; }
    },
    close() { closed = true; channel.close(); },
  };
}
