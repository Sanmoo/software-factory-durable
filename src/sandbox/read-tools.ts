import { z } from 'zod';
import { connect, listen, protocolVersion, type Envelope } from '../protocol/index.js';
import type { TextOutput, RawOutput, createRecords } from '../records/index.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const contextSchema = z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
  role: z.enum(['standards', 'spec']), environmentRef: identifier, bootRef: identifier, phaseId: identifier });
export type ToolContext = z.infer<typeof contextSchema>;
const referenceSchema = z.strictObject({ workId: identifier, id: z.uuid() });
const pageCall = z.strictObject({ name: z.literal('read'), operation: z.literal('page'), reference: referenceSchema,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), callId: identifier });
const callSchema = z.union([
  z.strictObject({ name: z.literal('read'), operation: z.literal('capture'), path: z.string().min(1).max(4096), callId: identifier }),
  pageCall, pageCall.extend({ format: z.literal('raw') }),
]);
export type ReadCall = z.infer<typeof callSchema>;
const successSchema = z.strictObject({ status: z.literal('success'), reference: referenceSchema,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), encoding: z.literal('base64'),
  data: z.string().max(32768).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  nextOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const readResultSchema = z.union([
  successSchema.extend({ format: z.literal('text') }),
  successSchema.extend({ format: z.literal('raw'), imageSourceMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ status: z.literal('failure'), code: z.string().min(1).max(128) }),
]);
export type ReadResult = z.infer<typeof readResultSchema>;
export interface ToolProjection { executeTool(context: ToolContext, call: ReadCall): Promise<ReadResult> }
// Structural external VM boundary; the only production supplier is adapter.ts's existing instance.
export type GuestOwner = { exec(argv: string[], options: { stdout: 'pipe'; stderr: 'ignore'; signal: AbortSignal; windowBytes: number }): {
  output(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: Buffer }>;
  result: Promise<{ exitCode: number }>;
} };
export type ReadBinding = { endpoint: string; context: ToolContext; signal: AbortSignal;
  records: Awaited<ReturnType<typeof createRecords>>; imageSourceMaxBytes?: number };
// Guest-only constant program. Trusted kernel/proc/mount roots and interpreter/stdlib
// are profile prerequisites, NOT established by this helper. Frozen runtime remains
// unqualified. This authorizes the opened regular FD's resolved target at check time;
// it is not beneath-root traversal, no-magic-links, immutable content or continuous
// membership enforcement. Never execute this body on the host.
const guestReadProgram = `import os, stat, sys
fd = None
try:
    path = sys.argv[1]
    if (len(sys.argv) != 2 or not 0 < len(path) <= 4096
            or not path.startswith(("/workspace/", "/artifacts/"))
            or not path.isprintable() or ".." in path.split("/")):
        raise ValueError()
    if (os.O_RDONLY != 0 or os.O_NONBLOCK <= 0 or os.O_CLOEXEC <= 0
            or os.O_NONBLOCK & os.O_CLOEXEC):
        raise ValueError()
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise ValueError()
    target = os.readlink("/proc/self/fd/" + str(fd))
    if (not target.startswith(("/workspace/", "/artifacts/"))
            or not target.isprintable() or target.endswith(" (deleted)")
            or any(part in ("", ".", "..") for part in target.split("/")[1:])):
        raise ValueError()
    while True:
        data = os.read(fd, 65536)
        if not data:
            break
        while data:
            written = os.write(1, data)
            if written <= 0:
                raise OSError()
            data = data[written:]
except BaseException:
    sys.exit(1)
finally:
    if fd is not None:
        os.close(fd)
`;
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
  const imageSourceMaxBytes = options.imageSourceMaxBytes === undefined ? undefined
    : z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(options.imageSourceMaxBytes);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const valid = () => !signal.aborted;
  const captures = new Map<string, 'text' | 'raw'>();
  const details = (format: 'text' | 'raw') => format === 'raw'
    ? { format: 'raw' as const, encoding: 'base64' as const, imageSourceMaxBytes: imageSourceMaxBytes! }
    : { format: 'text' as const, encoding: 'base64' as const };
  async function executeTool(context: ToolContext, call: ReadCall): Promise<ReadResult> {
    if (!sameContext(context, bound) || !valid()) return failure('STALE_TOOL_CONTEXT');
    try {
      if (call.operation === 'page') {
        if (call.reference.workId !== bound.workId || !captures.has(call.reference.id)) return failure('READ_REFERENCE_DENIED');
        const format = captures.get(call.reference.id)!;
        if ((format === 'raw') !== ('format' in call && call.format === 'raw')) return failure('READ_REFERENCE_DENIED');
        const request = { reference: call.reference, offset: call.offset, limit: 24576 };
        const page = format === 'raw' ? await options.records.read({ ...request, format: 'raw' }) : await options.records.read(request);
        if (page.state !== 'complete' || (format === 'raw' && (call.offset > page.bytes || page.nextOffset > page.bytes ||
            page.nextOffset !== call.offset + page.data.length))) return failure('PROTECTED_READ_UNAVAILABLE');
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        return { status: 'success', ...details(format), reference: call.reference, bytes: page.bytes, data: page.data.toString('base64'), nextOffset: page.nextOffset };
      }
      if (!/^\/(workspace|artifacts)\/[^\0]*$/.test(call.path) || call.path.split('/').includes('..')) return failure('READ_PATH_DENIED');
      const { phaseId: _phaseId, ...captureContext } = bound;
      let output: TextOutput | RawOutput = await options.records.openOutput({ ...captureContext, callId: call.callId });
      let format: 'text' | 'raw' = 'text';
      let completed = false;
      const commandLifetime = new AbortController();
      try {
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        // Guest-only argv, with real SDK pipe/backpressure. Never accumulate the source.
        const process = options.vm.exec(['/usr/bin/python3', '-I', '-S', '-c', guestReadProgram, call.path], { stdout: 'pipe', stderr: 'ignore',
          signal: AbortSignal.any([signal, commandLifetime.signal]), windowBytes: 65536 });
        // Observe rejection immediately, even when the stream itself fails first.
        void process.result.catch(() => {});
        let prefix = Buffer.alloc(0);
        let inspected = false;
        // Existing coarse magic routes capture format ONLY; native Workers MIME
        // detection of completed protected bytes remains authoritative.
        const routePrefix = async (): Promise<'text' | 'raw' | false> => {
          const pngOrJpeg = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
          const otherImage = /^GIF8[79]a/.test(prefix.toString('ascii', 0, 6)) ||
            (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP');
          if (otherImage || (pngOrJpeg && imageSourceMaxBytes === undefined)) return false;
          if (pngOrJpeg) {
            await output.abort();
            output = await options.records.openOutput({ ...captureContext, callId: call.callId }, { format: 'raw', maxBytes: imageSourceMaxBytes! });
          }
          return pngOrJpeg ? 'raw' : 'text';
        };
        for await (const chunk of process.output()) {
          if (!valid()) return failure('STALE_TOOL_CONTEXT');
          if (chunk.stream !== 'stdout') continue;
          let data = chunk.data;
          if (!inspected) {
            const take = Math.min(12 - prefix.length, data.length);
            prefix = Buffer.concat([prefix, data.subarray(0, take)]);
            data = data.subarray(take);
            if (prefix.length < 12) continue;
            const routed = await routePrefix();
            if (!routed) return failure('READ_BINARY_UNSUPPORTED');
            format = routed;
            await output.write(prefix); inspected = true;
          }
          for (let offset = 0; offset < data.length; offset += 65536) await output.write(data.subarray(offset, offset + 65536));
        }
        if (!inspected) {
          const routed = await routePrefix();
          if (!routed) return failure('READ_BINARY_UNSUPPORTED');
          format = routed;
          await output.write(prefix);
        }
        const result = await process.result;
        if (result.exitCode !== 0) return failure(format === 'raw' ? 'PROTECTED_READ_UNAVAILABLE' : 'GUEST_READ_FAILED');
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        const capture = await output.finish();
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        captures.set(capture.reference.id, format); completed = true;
        return { status: 'success', ...details(format), reference: capture.reference, bytes: capture.bytes, data: '', nextOffset: 0 };
      } finally {
        commandLifetime.abort();
        if (!completed) await output.abort();
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
  function close() {
    // Publish the single cleanup promise before abort dispatch can re-enter close.
    closing ??= Promise.resolve().then(async () => {
      try { await server.close(); } finally { await Promise.allSettled([...active]); }
    });
    lifetime.abort();
    return closing;
  }
  signal.addEventListener('abort', () => { void close().catch(() => {}); }, { once: true });
  // Covers an already-revoked binding and revocation during listen/chmod awaits.
  if (signal.aborted) await close();
  return { endpoint: options.endpoint, close };
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
        return readResultSchema.parse(response.value.payload);
      } catch { closed = true; channel.close(); return failure('TOOL_CHANNEL_CLOSED'); }
      finally { busy = false; }
    },
    close() { closed = true; channel.close(); },
  };
}
