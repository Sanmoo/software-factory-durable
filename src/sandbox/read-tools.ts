import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { boundConditionalEditTools, boundWriteTools, writeCallSchema, type WriteCall } from './write-tools.js';
import { boundBashTools, bashCallSchema, bashProgressSchema, type BashCall, type BashProgress } from './bash-tools.js';
import { connect, listen, protocolVersion, type Envelope } from '../protocol/index.js';
import type { TextOutput, RawOutput } from '../records/index.js';
import { contextSchema, referenceSchema, readResultSchema, type ToolContext, type ReadResult, type GuestOwner, type ReadBinding } from './tool-binding.js';
export { contextSchema } from './tool-binding.js';
export type { ToolContext, ReadResult, GuestOwner, ReadBinding } from './tool-binding.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const pageCall = z.strictObject({ name: z.literal('read'), operation: z.literal('page'), reference: referenceSchema,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), callId: identifier });
const readCallSchema = z.union([
  z.strictObject({ name: z.literal('read'), operation: z.literal('capture'), path: z.string().min(1).max(4096), callId: identifier }),
  pageCall, pageCall.extend({ format: z.literal('raw') }),
]);
export type ReadCall = z.infer<typeof readCallSchema>;
const editSourceBinding = { name: z.literal('edit-source'), path: z.string().min(1).max(4096), callId: identifier };
const editSourceVersion = { ...editSourceBinding, reference: referenceSchema, sourceVersion: z.uuid() };
const editSourceCallSchema = z.union([
  z.strictObject({ ...editSourceBinding, operation: z.literal('capture') }),
  z.strictObject({ ...editSourceVersion, operation: z.literal('page'), offset: z.number().int().nonnegative().max(8192) }),
  z.strictObject({ ...editSourceVersion, operation: z.literal('release') }),
  z.strictObject({ ...editSourceVersion, operation: z.literal('commit'), replacement: z.string() }),
]);
export type EditSourceCall = z.infer<typeof editSourceCallSchema>;
const callSchema = z.union([readCallSchema, writeCallSchema, bashCallSchema, editSourceCallSchema]);
export type ToolCall = ReadCall | WriteCall | BashCall | EditSourceCall;
export interface ToolProjection { executeTool(context: ToolContext, call: ToolCall, onData?: (data: Buffer) => void | Promise<void>, signal?: AbortSignal): Promise<ReadResult> }
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
// Closed edit-source mode shares the SAME stdout/read loop with legacy read.
// Only FD acquisition/authorization changes; no filesystem writes. Trusted guest
// TCB prerequisite, not a coherent snapshot or continuous-root guarantee.
const guestEditSourceProgram = guestReadProgram.replace('fd = None', 'fd = None\nfds = []').replace(
  '    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)',
  `    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts[1:]):
        raise ValueError()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    def authorize_parent(parent):
        target = os.readlink("/proc/self/fd/" + str(parent))
        if (not stat.S_ISDIR(os.fstat(parent).st_mode) or not target.isprintable()
                or target.endswith(" (deleted)")
                or not (target in ("/workspace", "/artifacts") or target.startswith(("/workspace/", "/artifacts/")))
                or any(part in ("", ".", "..") for part in target.split("/")[1:])):
            raise ValueError()
    base = os.open("/", flags)
    fds.append(base)
    parent = os.open(parts[1], flags, dir_fd=base)
    fds.append(parent)
    authorize_parent(parent)
    for leaf in parts[2:-1]:
        authorize_parent(parent)
        parent = os.open(leaf, flags, dir_fd=parent)
        fds.append(parent)
        authorize_parent(parent)
    authorize_parent(parent)
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)`,
).replace('    while True:', '    authorize_parent(parent)\n    while True:').replace(
  '        os.close(fd)', '        os.close(fd)\n    for parent in reversed(fds):\n        os.close(parent)',
);
const failure = (code: string): ReadResult => ({ status: 'failure', code });
function sameContext(left: ToolContext, right: ToolContext): boolean {
  return Object.keys(right).every(key => left[key as keyof ToolContext] === right[key as keyof ToolContext]);
}
function envelope(messageId: string, kind: string, payload: unknown, replyTo: string | null = null): Envelope {
  return { protocol_version: protocolVersion, controller_run_id: null, message_id: messageId, reply_to: replyTo, kind,
    payload: z.record(z.string(), z.json()).parse(payload) };
}

/** Private component of the existing owner. Authority is a host snapshot with a
 * revocation signal, never a guest file, handshake claim, Records fact or current() callback. */
export async function serveReadTools(options: ReadBinding & { vm: GuestOwner }) {
  const bound = Object.freeze(contextSchema.parse(options.context));
  const imageSourceMaxBytes = options.imageSourceMaxBytes === undefined ? undefined
    : z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(options.imageSourceMaxBytes);
  // Snapshot trusted policy before first await. Call schemas cannot override it.
  const editSourceMaxBytes = options.editSourceMaxBytes === undefined ? undefined
    : z.number().int().nonnegative().max(8192).parse(options.editSourceMaxBytes);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  let mutationRevoked = false;
  const valid = () => !signal.aborted && !mutationRevoked;
  const captures = new Map<string, 'text' | 'raw'>();
  // Context/phase/owner lifetime are implicit in this private closure. Technical
  // hashes are not grants. Capture does not reserve or authorize mutation.
  const versions = new Map<string, { path: string; reference: { workId: string; id: string }; bytes: number; digest: string }>();
  let pendingSources = 0;
  signal.addEventListener('abort', () => { versions.clear(); }, { once: true });
  const details = (format: 'text' | 'raw') => format === 'raw'
    ? { format: 'raw' as const, encoding: 'base64' as const, imageSourceMaxBytes: imageSourceMaxBytes! }
    : { format: 'text' as const, encoding: 'base64' as const };
  const write = boundWriteTools({ ...options, signal }, valid, () => { mutationRevoked = true; });
  const commit = boundConditionalEditTools({ ...options, signal }, valid, () => { mutationRevoked = true; });
  const bash = boundBashTools({ ...options, signal }, valid, () => { mutationRevoked = true; });
  async function executeTool(context: ToolContext, call: ToolCall, progress: (frame: BashProgress) => Promise<void>): Promise<ReadResult> {
    if (call.name === 'bash') return bash(context, call, progress);
    if (call.name === 'write') return write(context, call);
    const editSource = call.name === 'edit-source';
    if (!editSource && bound.role === 'builder') return failure('READ_ROLE_DENIED');
    if (!sameContext(context, bound) || !valid()) return failure('STALE_TOOL_CONTEXT');
    if (editSource && (bound.role !== 'builder' || editSourceMaxBytes === undefined)) return failure('EDIT_SOURCE_DENIED');
    if (editSource && call.operation !== 'capture') {
      const version = versions.get(call.sourceVersion);
      if (!version || version.path !== call.path || version.reference.id !== call.reference.id ||
          version.reference.workId !== call.reference.workId) return failure('EDIT_SOURCE_VERSION_DENIED');
      if (call.operation === 'commit') {
        if (Buffer.byteLength(call.replacement) > 8192 || Buffer.byteLength(JSON.stringify(call)) > 49152)
          return failure('EDIT_SOURCE_PAYLOAD_TOO_LARGE');
        // Reservation is synchronous and precedes the FIRST await. Pages,
        // releases and competing channels can no longer find this version.
        versions.delete(call.sourceVersion);
        try {
          const page = await options.records.read({ reference: version.reference, offset: 0, limit: 8192 });
          if (!valid()) return failure('STALE_TOOL_CONTEXT');
          if (page.state !== 'complete' || page.bytes !== version.bytes || page.nextOffset !== version.bytes ||
              page.data.length !== version.bytes || createHash('sha256').update(page.data).digest('hex') !== version.digest)
            throw new Error('protected source unavailable');
        } catch {
          mutationRevoked = true;
          return failure('PROTECTED_EDIT_SOURCE_UNAVAILABLE');
        }
        return commit(context, { name: 'edit-source', operation: 'commit', path: version.path, callId: call.callId,
          replacement: call.replacement, expectedBytes: version.bytes, expectedDigest: version.digest });
      }
      if (call.operation === 'release') {
        versions.delete(call.sourceVersion);
        return { status: 'success', format: 'text', encoding: 'base64', reference: version.reference,
          bytes: version.bytes, data: '', nextOffset: 0, sourceVersion: call.sourceVersion };
      }
      try {
        const page = await options.records.read({ reference: version.reference, offset: call.offset, limit: 8192 });
        if (!valid() || versions.get(call.sourceVersion) !== version) return failure('EDIT_SOURCE_VERSION_DENIED');
        if (page.state !== 'complete' || page.bytes !== version.bytes || call.offset > page.bytes ||
            page.nextOffset !== call.offset + page.data.length || page.nextOffset > page.bytes ||
            (call.offset === 0 && (page.nextOffset !== page.bytes || createHash('sha256').update(page.data).digest('hex') !== version.digest))) {
          versions.delete(call.sourceVersion);
          return failure('PROTECTED_READ_UNAVAILABLE');
        }
        return { status: 'success', format: 'text', encoding: 'base64', reference: version.reference, sourceVersion: call.sourceVersion,
          bytes: page.bytes, data: page.data.toString('base64'), nextOffset: page.nextOffset };
      } catch { versions.delete(call.sourceVersion); return failure('PROTECTED_READ_UNAVAILABLE'); }
    }
    if (editSource && versions.size + pendingSources >= 32) return failure('EDIT_SOURCE_LIMIT');
    if (editSource) pendingSources++;
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
      if (!/^\/(workspace|artifacts)\/[^\0]*$/.test(call.path) || call.path.split('/').includes('..') ||
          (editSource && (call.path.split('/').slice(1).some(part => part === '' || part === '.') || /[\x00-\x1f\x7f]/.test(call.path)))) return failure('READ_PATH_DENIED');
      const { phaseId: _phaseId, ...captureContext } = bound;
      let output: TextOutput | RawOutput = await options.records.openOutput({ ...captureContext, callId: call.callId }, { format: 'text', preserveBOM: true });
      let format: 'text' | 'raw' = 'text';
      let completed = false;
      const commandLifetime = new AbortController();
      try {
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        // Guest-only argv, with real SDK pipe/backpressure. Never accumulate the source.
        const sourceHash = createHash('sha256');
        const protectedHash = createHash('sha256');
        let sourceBytes = 0;
        let protectedBytes = 0;
        const append = async (data: Buffer) => {
          const text = await output.write(data);
          if (editSource) {
            if (typeof text !== 'string') throw new Error('EDIT_SOURCE_NOT_TEXT');
            protectedHash.update(text, 'utf8'); protectedBytes += Buffer.byteLength(text);
          }
        };
        const process = options.vm.exec(['/usr/bin/python3', '-I', '-S', '-c', editSource ? guestEditSourceProgram : guestReadProgram, call.path], { stdout: 'pipe', stderr: 'ignore',
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
          const imageCandidate = pngOrJpeg || otherImage;
          if (imageCandidate && (editSource || imageSourceMaxBytes === undefined)) return false;
          if (imageCandidate) {
            await output.abort();
            output = await options.records.openOutput({ ...captureContext, callId: call.callId }, { format: 'raw', maxBytes: imageSourceMaxBytes! });
          }
          return imageCandidate ? 'raw' : 'text';
        };
        for await (const chunk of process.output()) {
          if (!valid()) return failure('STALE_TOOL_CONTEXT');
          if (chunk.stream !== 'stdout') continue;
          let data = chunk.data;
          if (editSource) {
            sourceBytes += data.length;
            // Every original stdout FD byte, not the decoded input or excerpt.
            sourceHash.update(data);
            if (sourceBytes > editSourceMaxBytes! || data.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 || byte === 127))
              return failure('EDIT_SOURCE_NOT_LOSSLESS');
          }
          if (!inspected) {
            const take = Math.min(12 - prefix.length, data.length);
            prefix = Buffer.concat([prefix, data.subarray(0, take)]);
            data = data.subarray(take);
            if (prefix.length < 12) continue;
            const routed = await routePrefix();
            if (!routed) return failure('READ_BINARY_UNSUPPORTED');
            format = routed;
            await append(prefix); inspected = true;
          }
          for (let offset = 0; offset < data.length; offset += 65536) await append(data.subarray(offset, offset + 65536));
        }
        if (!inspected) {
          const routed = await routePrefix();
          if (!routed) return failure('READ_BINARY_UNSUPPORTED');
          format = routed;
          await append(prefix);
        }
        const result = await process.result;
        if (result.exitCode !== 0) return failure(format === 'raw' ? 'PROTECTED_READ_UNAVAILABLE' : 'GUEST_READ_FAILED');
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        const capture = await output.finish();
        if (!valid()) return failure('STALE_TOOL_CONTEXT');
        if (editSource) {
          if (!('tail' in capture)) return failure('EDIT_SOURCE_NOT_LOSSLESS');
          protectedHash.update(capture.tail, 'utf8'); protectedBytes += Buffer.byteLength(capture.tail);
          const digest = sourceHash.digest('hex');
          if (sourceBytes !== protectedBytes || protectedBytes !== capture.bytes || digest !== protectedHash.digest('hex'))
            return failure('EDIT_SOURCE_NOT_LOSSLESS');
          const sourceVersion = randomUUID();
          versions.set(sourceVersion, { path: call.path, reference: capture.reference, bytes: capture.bytes, digest });
          completed = true;
          return { status: 'success', format: 'text', encoding: 'base64', reference: capture.reference, bytes: capture.bytes,
            sourceVersion, data: '', nextOffset: 0 };
        }
        captures.set(capture.reference.id, format); completed = true;
        return { status: 'success', ...details(format), reference: capture.reference, bytes: capture.bytes, data: '', nextOffset: 0 };
      } finally {
        commandLifetime.abort();
        if (!completed) await output.abort();
      }
    } catch { return failure('PROTECTED_READ_UNAVAILABLE'); }
    finally { if (editSource) pendingSources--; }
  }
  const active = new Set<Promise<void>>();
  const server = await listen(options.endpoint, { async message(request, channel) {
    const task = (async () => {
      const parsed = z.strictObject({ context: contextSchema, call: callSchema }).safeParse(request.payload);
      const result = request.kind !== 'execute-tool' || !parsed.success || request.message_id !== parsed.data.call.callId
        ? failure('INVALID_TOOL_CALL') : await executeTool(parsed.data.context, parsed.data.call, async frame => {
          await channel.send(envelope(request.message_id, 'tool-progress', frame, request.message_id));
        });
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
    async executeTool(input: ToolCall, onData?: (data: Buffer) => void | Promise<void>, signal?: AbortSignal): Promise<ReadResult> {
      if (closed) return failure('TOOL_CHANNEL_CLOSED');
      if (busy) return failure('TOOL_CALL_IN_PROGRESS');
      const call = callSchema.safeParse(input);
      if (!call.success) return failure('INVALID_TOOL_CALL');
      busy = true;
      const abort = () => { closed = true; channel.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) throw new Error('aborted');
        await channel.send(envelope(call.data.callId, 'execute-tool', { context: bound, call: call.data }));
        let sequence = 0;
        let bytes = 0;
        while (true) {
          const response = await messages.next();
          if (response.done || response.value.reply_to !== call.data.callId || response.value.message_id !== call.data.callId ||
              response.value.controller_run_id !== null) throw new Error('TOOL_CHANNEL_CLOSED');
          if (response.value.kind === 'tool-progress') {
            if (call.data.name !== 'bash' || !onData) throw new Error('INVALID_TOOL_PROGRESS');
            const frame = bashProgressSchema.parse(response.value.payload);
            const chunk = Buffer.from(frame.data, 'base64');
            if (Object.keys(frame.context).length !== Object.keys(bound).length ||
                Object.keys(bound).some(key => bound[key as keyof ToolContext] !== frame.context[key]) || frame.sequence !== sequence++ ||
                chunk.length > 24576 || chunk.toString('base64') !== frame.data ||
                frame.bytes !== bytes + chunk.length || !Number.isSafeInteger(frame.bytes)) throw new Error('INVALID_TOOL_PROGRESS');
            bytes = frame.bytes;
            await onData(chunk);
            continue;
          }
          if (response.value.kind !== 'tool-result') throw new Error('TOOL_CHANNEL_CLOSED');
          const result = readResultSchema.parse(response.value.payload);
          if (call.data.name === 'bash' && result.status === 'success' && (result.format !== 'text' ||
              result.exitCode === undefined || result.progressFrames !== sequence || result.bytes !== bytes ||
              result.reference.workId !== bound.workId || result.data !== '' || result.nextOffset !== 0)) throw new Error('INVALID_TOOL_RESULT');
          return result;
        }
      } catch { closed = true; channel.close(); return failure('TOOL_CHANNEL_CLOSED'); }
      finally { signal?.removeEventListener('abort', abort); busy = false; }
    },
    close() { closed = true; channel.close(); },
  };
}
