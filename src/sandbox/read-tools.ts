import { z } from 'zod';
import { connect, listen, protocolVersion, type Envelope } from '../protocol/index.js';
import type { createRecords } from '../records/index.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const contextSchema = z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
  role: z.enum(['standards', 'spec']), environmentRef: identifier, bootRef: identifier, phaseId: identifier });
export type ToolContext = z.infer<typeof contextSchema>;
const referenceSchema = z.strictObject({ workId: identifier, id: z.uuid() });
const callSchema = z.discriminatedUnion('operation', [
  z.strictObject({ name: z.literal('read'), operation: z.literal('capture'), path: z.string().min(1).max(4096), callId: identifier }),
  z.strictObject({ name: z.literal('read'), operation: z.literal('page'), reference: referenceSchema,
    offset: z.number().int().nonnegative(), callId: identifier }),
]);
export type ReadCall = z.infer<typeof callSchema>;
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), reference: referenceSchema, bytes: z.number().int().nonnegative(),
    data: z.string(), nextOffset: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal('failure'), code: z.string() }),
]);
export type ReadResult = z.infer<typeof resultSchema>;
export interface ToolProjection { executeTool(context: ToolContext, call: ReadCall): Promise<ReadResult> }
// Structural external VM boundary; the only production supplier is adapter.ts's existing instance.
export type GuestOwner = { exec(argv: string[], options: { stdout: 'pipe'; stderr: 'ignore'; signal: AbortSignal; windowBytes: number }): {
  output(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: Buffer }>;
  result: Promise<{ exitCode: number }>;
} };
export type ReadBinding = { endpoint: string; context: ToolContext; signal: AbortSignal;
  records: Awaited<ReturnType<typeof createRecords>> };
const failure = (code: string): ReadResult => ({ status: 'failure', code });
function sameContext(left: ToolContext, right: ToolContext): boolean {
  return Object.keys(right).every(key => left[key as keyof ToolContext] === right[key as keyof ToolContext]);
}
function envelope(messageId: string, kind: string, payload: Envelope['payload'], replyTo: string | null = null): Envelope {
  return { protocol_version: protocolVersion, controller_run_id: null, message_id: messageId, reply_to: replyTo, kind, payload };
}

/** Private component of the existing owner. Authority is a host snapshot with a
 * revocation signal, never a guest file, handshake claim, Records fact or current() callback. */
export async function serveReadTools(options: ReadBinding & { vm: GuestOwner }) {
  const bound = Object.freeze(contextSchema.parse(options.context));
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const valid = () => !signal.aborted;
  const captures = new Set<string>();
  async function executeTool(context: ToolContext, call: ReadCall): Promise<ReadResult> {
    if (!sameContext(context, bound) || !valid()) return failure('STALE_TOOL_CONTEXT');
    try {
      if (call.operation === 'page') {
        if (call.reference.workId !== bound.workId || !captures.has(call.reference.id)) return failure('READ_REFERENCE_DENIED');
        const page = await options.records.read({ reference: call.reference, offset: call.offset, limit: 24576 });
        if (page.state !== 'complete') return failure('PROTECTED_READ_UNAVAILABLE');
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        return { status: 'success', reference: call.reference, bytes: page.bytes, data: page.data.toString('base64'), nextOffset: page.nextOffset };
      }
      if (!/^\/(workspace|artifacts)\/[^\0]*$/.test(call.path) || call.path.split('/').includes('..')) return failure('READ_PATH_DENIED');
      const { phaseId: _phaseId, ...captureContext } = bound;
      const output = await options.records.openOutput({ ...captureContext, callId: call.callId });
      let completed = false;
      const commandLifetime = new AbortController();
      try {
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        // Guest-only argv, with real SDK pipe/backpressure. Never accumulate the source.
        const process = options.vm.exec(['/bin/cat', '--', call.path], { stdout: 'pipe', stderr: 'ignore',
          signal: AbortSignal.any([signal, commandLifetime.signal]), windowBytes: 65536 });
        // Observe rejection immediately, even when the stream itself fails first.
        void process.result.catch(() => {});
        let prefix = Buffer.alloc(0);
        let inspected = false;
        const image = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)) ||
          (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
        for await (const chunk of process.output()) {
          if (!valid()) return failure('STALE_TOOL_CONTEXT');
          if (chunk.stream !== 'stdout') continue;
          let data = chunk.data;
          if (!inspected) {
            const take = Math.min(12 - prefix.length, data.length);
            prefix = Buffer.concat([prefix, data.subarray(0, take)]);
            data = data.subarray(take);
            if (prefix.length < 12) continue;
            if (image(prefix)) return failure('READ_BINARY_UNSUPPORTED');
            await output.write(prefix); inspected = true;
          }
          for (let offset = 0; offset < data.length; offset += 65536) await output.write(data.subarray(offset, offset + 65536));
        }
        if (!inspected) {
          if (image(prefix)) return failure('READ_BINARY_UNSUPPORTED');
          await output.write(prefix);
        }
        const result = await process.result;
        if (result.exitCode !== 0) return failure('GUEST_READ_FAILED');
        const capture = await output.finish(); completed = true;
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        captures.add(capture.reference.id);
        return { status: 'success', reference: capture.reference, bytes: capture.bytes, data: '', nextOffset: 0 };
      } finally {
        commandLifetime.abort();
        if (!completed) { try { await output.finish(); } catch { /* Failed/partial capture never becomes an SDK source. */ } }
      }
    } catch { return failure('PROTECTED_READ_UNAVAILABLE'); }
  }
  const active = new Set<Promise<void>>();
  const server = await listen(options.endpoint, { async message(request, channel) {
    const task = (async () => {
      const parsed = z.strictObject({ context: contextSchema, call: callSchema }).safeParse(request.payload);
      const result = request.kind !== 'execute-tool' || !parsed.success || request.message_id !== parsed.data.call.callId
        ? failure('INVALID_TOOL_CALL') : await executeTool(parsed.data.context, parsed.data.call);
      await channel.send(envelope(request.message_id, 'tool-result', result, request.message_id));
    })();
    active.add(task);
    try { await task; } finally { active.delete(task); }
  }, closed() { lifetime.abort(); } }, { kind: 'worker-tool', binding: bound });
  let closing: Promise<void> | undefined;
  return { endpoint: options.endpoint, close() {
    lifetime.abort();
    return closing ??= (async () => { await server.close(); await Promise.allSettled([...active]); })();
  } };
}

/** Private boot-owner collection. Invocation revocation never owns VM shutdown;
 * the adapter closes this collection before disposing its existing VM. */
export async function serveReadToolBindings(bindings: readonly ReadBinding[], vm: GuestOwner) {
  const owners: Awaited<ReturnType<typeof serveReadTools>>[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.all(owners.map(owner => owner.close())).then(() => {});
  const add = async (binding: ReadBinding) => {
    if (closing || binding.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
    const owner = await serveReadTools({ ...binding, vm });
    if (closing || binding.signal.aborted) { await owner.close(); throw new Error('STALE_TOOL_CONTEXT'); }
    owners.push(owner);
  };
  try {
    for (const binding of bindings) await add(binding);
  } catch (error) {
    await close();
    throw error;
  }
  return { close, add };
}

/** One invocation-bound channel, kept alive across native access/stream operations. */
export async function connectReadTools(endpoint: string, context: ToolContext) {
  const bound = Object.freeze(contextSchema.parse(context));
  const channel = await connect(endpoint, { kind: 'worker-tool', binding: bound });
  const messages = channel.messages[Symbol.asyncIterator]();
  let closed = false;
  let busy = false;
  return {
    async executeTool(input: ReadCall): Promise<ReadResult> {
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
