import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import { z } from 'zod';

// A single delimiter absent from all registered values prevents replacement
// text plus adjacent output from synthesizing another known secret.
const redactionMarker = '█';
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const contextSchema = z.strictObject({
  workId: identifier,
  executionId: identifier,
  invocationId: identifier,
  role: z.enum(['builder', 'standards', 'spec']),
  environmentRef: identifier,
  bootRef: identifier,
  callId: identifier,
});
export type OutputContext = z.infer<typeof contextSchema>;
const referenceSchema = z.strictObject({ workId: identifier, id: z.uuid() });
const captureSchema = z.strictObject({ version: z.literal(1), context: contextSchema, reference: referenceSchema, startedAt: z.iso.datetime() });
const rawCaptureSchema = captureSchema.extend({
  version: z.literal(2),
  format: z.literal('raw'),
  maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type OutputReference = z.infer<typeof referenceSchema>;
export type RawOutputOptions = { format: 'raw'; maxBytes: number };
// Explicit file-read opt-in only; legacy evidence/event text keeps consuming BOM.
export type FileTextOutputOptions = { format: 'text'; preserveBOM: true };
type TextCompletion = { reference: OutputReference; tail: string; bytes: number; excerpt: string; truncated: boolean; display: string };
type RawCompletion = { version: 2; format: 'raw'; reference: OutputReference; bytes: number };
type OutputChannel<T, C> = { reference: OutputReference; abort(): Promise<void>; write(chunk: Uint8Array): Promise<T>; finish(): Promise<C> };
export type TextOutput = OutputChannel<string, TextCompletion>;
export type RawOutput = OutputChannel<void, RawCompletion>;
type ReadRequest = { reference: OutputReference; offset: number; limit: number };
export type TextProjectionRequest = { context: OutputContext; reference: OutputReference; expectedBytes: number; signal?: AbortSignal };
export type TextProjection = {
  readonly state: 'pending' | 'streaming' | 'complete' | 'failed';
  chunks: AsyncGenerator<Buffer, void, unknown>;
  /** Point-in-time EOF, same-instance filter revision and signal check; not authorization or a filesystem snapshot. */
  assertCompleteAndCurrent(): void;
};
type OutputPage =
  | { state: 'complete' | 'partial'; data: Buffer<ArrayBuffer>; nextOffset: number; bytes: number }
  | { state: 'absent'; data: Buffer<ArrayBuffer>; nextOffset: number; bytes: number };
type RawPage = OutputPage & { version: 2; format: 'raw' };
/** Ticket 17 preserved-evidence manifest (records/preserve.ts), checked by shape only (its files are not re-hashed by a listing). */
const manifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal('environment-evidence'),
  label: z.string().max(256),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).passthrough()),
  totalBytes: z.number().int().nonnegative(),
});
type FoundCapture = { reference: OutputReference; context: OutputContext; state: 'complete' | 'partial'; format: 'text' | 'raw' };
/** Upper bound of the captures one `find` lists for a Work (bounded host read; beyond it the result is incomplete). */
const findLimit = 20000;
export { preserveEvidence, type PreservedEvidence, type Preservation } from './preserve.js';
export const outputLimits = Object.freeze({ chunkBytes: 65536, pageBytes: 65536, excerptBytes: 4096, secretCharacters: 4096, secretCount: 128 });
export class RecordsError extends Error {
  constructor() {
    super('PROTECTED_CAPTURE_UNAVAILABLE');
  }
}

async function privateDirectory(path: string, create = false) {
  if (create) {
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (created) {
      const parent = await open(dirname(path), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new RecordsError();
}
async function atomicJson(directory: string, name: string, value: unknown, validate = () => {}) {
  const temporary = join(directory, `${name}-${randomUUID()}.tmp`);
  const destination = join(directory, name);
  let renamed = false;
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    validate();
    await rename(temporary, destination);
    renamed = true;
    validate();
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    validate();
  } catch (error) {
    // Only our exclusive temporary file and our published destination; never
    // recursively clean a capture or touch another capture's artifacts.
    if (renamed) await unlink(destination);
    throw error;
  } finally {
    if (created) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }
}

async function privateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > outputLimits.chunkBytes) throw new RecordsError();
    // A bounded read remains bounded even if the file grows after stat.
    const data = Buffer.alloc(outputLimits.chunkBytes + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > outputLimits.chunkBytes) throw new RecordsError();
    return JSON.parse(data.toString('utf8', 0, length));
  } finally {
    await file.close();
  }
}

// Snapshot only bounded, plain JSON data before recursive schema validation,
// redaction or serialization. No entries/keys array for a caller-sized object,
// no getters/toJSON calls, and no copies of unbounded strings or containers.
type JsonEvent = z.infer<ReturnType<typeof z.json>>;
function boundedEvent(event: unknown): JsonEvent {
  let nodes = 0;
  let stringBytes = 0;
  const active = new WeakSet<object>();
  function string(value: string) {
    if (value.length > outputLimits.chunkBytes) throw new RecordsError();
    stringBytes += Buffer.byteLength(value);
    if (stringBytes > outputLimits.chunkBytes) throw new RecordsError();
    return value;
  }
  function visit(value: unknown, depth: number): JsonEvent {
    if (++nodes > 8192 || depth > 32) throw new RecordsError();
    if (typeof value === 'string') return string(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object' || types.isProxy(value) || active.has(value)) throw new RecordsError();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 8192) throw new RecordsError();
        const result: JsonEvent[] = [];
        for (let i = 0; i < value.length; i++) {
          const item = Object.getOwnPropertyDescriptor(value, String(i));
          if (!item || !('value' in item)) throw new RecordsError();
          result.push(visit(item.value, depth + 1));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new RecordsError();
      const result: Record<string, JsonEvent> = Object.create(null);
      for (const key in value) {
        const item = Object.getOwnPropertyDescriptor(value, key);
        if (!item) continue;
        if (!('value' in item)) throw new RecordsError();
        result[string(key)] = visit(item.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  }
  return visit(event, 0);
}

/** Host-only evidence storage. root must already be private and outside every guest mount. */
export async function createRecords({ root }: { root: string }) {
  let rootIdentity: { dev: number; ino: number };
  try {
    await privateDirectory(root);
    root = await realpath(root);
    const info = await lstat(root);
    rootIdentity = { dev: info.dev, ino: info.ino };
  } catch {
    throw new RecordsError();
  }
  /** The Records root is still the private directory this instance opened (same identity, owner, mode): absence below it means something. */
  async function rootIntact(): Promise<boolean> {
    try {
      await privateDirectory(root);
      const info = await lstat(root);
      return !info.isSymbolicLink() && info.dev === rootIdentity.dev && info.ino === rootIdentity.ino;
    } catch {
      return false;
    }
  }
  const secrets: string[] = [];
  const encodedSecrets: Buffer[] = [];
  let registryRevision = 0;
  // Only active raw captures, not another evidence ledger. Entries also fence
  // read() while a revoked finish is withdrawing a raced completion marker.
  const activeRaw = new Map<string, () => void>();

  function openOutput(input: OutputContext): Promise<TextOutput>;
  function openOutput(input: OutputContext, options: RawOutputOptions): Promise<RawOutput>;
  function openOutput(input: OutputContext, options: FileTextOutputOptions): Promise<TextOutput>;
  function openOutput(input: OutputContext, options?: RawOutputOptions | FileTextOutputOptions): Promise<TextOutput | RawOutput> {
    return openCapture(input, options);
  }
  function read(input: ReadRequest & { format: 'raw' }): Promise<RawPage>;
  function read(input: ReadRequest): Promise<OutputPage>;
  async function read(input: ReadRequest & { format?: 'raw' }): Promise<OutputPage | RawPage> {
    const page = await readPage(input);
    return input.format === 'raw' ? { ...page, version: 2, format: 'raw' } : page;
  }

  function filter(input: string, final: boolean): { text: string; pending: string } {
    const retain = final ? 0 : Math.max(0, ...secrets.map(secret => secret.length - 1));
    const end = Math.max(0, input.length - retain);
    let cursor = 0;
    let text = '';
    while (cursor < end) {
      const secret = secrets.find(secret => input.startsWith(secret, cursor));
      if (secret) {
        text += redactionMarker;
        cursor += secret.length;
      } else {
        text += input[cursor];
        cursor++;
      }
    }
    // Do not split a surrogate pair when the retained boundary bisects UTF-16.
    if (!final && text.length && /[\uD800-\uDBFF]$/.test(text)) {
      text = text.slice(0, -1);
      cursor--;
    }
    return { text, pending: input.slice(cursor) };
  }
  function safeMetadata<T>(value: T): T {
    const text = JSON.stringify(value);
    if (secrets.some(secret => text.includes(secret))) throw new RecordsError();
    return value;
  }
  async function location(reference: OutputReference) {
    const work = identifier.parse(reference.workId);
    const id = z.string().uuid().parse(reference.id);
    const workDirectory = join(root, work);
    await privateDirectory(workDirectory);
    const evidence = join(workDirectory, 'evidence');
    await privateDirectory(evidence);
    const directory = join(evidence, id);
    await privateDirectory(directory);
    return directory;
  }
  async function openCapture(input: OutputContext, options?: RawOutputOptions | FileTextOutputOptions): Promise<TextOutput | RawOutput> {
    let file: FileHandle | undefined;
    const raw = options?.format === 'raw';
    const revision = registryRevision;
    let releaseActive = () => {};
    let maxBytes = 0;
    let preserveBOM = false;
    function validateRegistry() {
      if (raw && revision !== registryRevision) throw new RecordsError();
    }
    try {
      if (raw)
        maxBytes = z.strictObject({ format: z.literal('raw'), maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).parse(options).maxBytes;
      else if (options !== undefined) preserveBOM = z.strictObject({ format: z.literal('text'), preserveBOM: z.literal(true) }).parse(options).preserveBOM;
      const context = contextSchema.parse(input);
      // Identities cannot be redacted without changing their meaning. Reject
      // secret-bearing metadata before even choosing a filesystem destination.
      if (Object.values(context).some(value => secrets.some(secret => value.includes(secret)))) throw new RecordsError();
      const reference = { workId: context.workId, id: randomUUID() };
      const capture = safeMetadata(
        raw
          ? { version: 2, format: 'raw', maxBytes, context, reference, startedAt: new Date().toISOString() }
          : { version: 1, context, reference, startedAt: new Date().toISOString() },
      );
      const workDirectory = join(root, context.workId);
      await privateDirectory(workDirectory, true);
      const evidence = join(workDirectory, 'evidence');
      await privateDirectory(evidence, true);
      const directory = join(evidence, reference.id);
      await privateDirectory(directory, true);
      validateRegistry();
      await atomicJson(directory, 'capture.json', safeMetadata(capture), validateRegistry);
      validateRegistry();
      file = await open(join(directory, 'output'), 'wx', 0o600);
      const handle = file;
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBOM });
      let pending = '';
      let rawPending: Buffer = Buffer.alloc(0);
      let received = 0;
      let state: 'open' | 'closed' | 'failed' = 'open';
      let busy = false;
      let withdrawn = false;
      function releaseFailed() {
        if (state === 'failed' && withdrawn) releaseActive();
      }
      let bytes = 0;
      let excerpt = '';
      let excerptBytes = 0;
      let truncated = false;
      function validateOpen() {
        validateRegistry();
        if (state !== 'open') throw new RecordsError();
      }
      async function invalidate(): Promise<void> {
        withdrawn = false;
        state = 'failed';
        pending = '';
        rawPending = Buffer.alloc(0);
        if (raw) activeRaw.set(reference.id, revokeRaw);
        try {
          await handle.close();
        } catch {
          /* No raw fallback, including error diagnostics. */
        }
        // Do not await finish here: it can itself be calling fail. Publication
        // rechecks invalidation around rename/sync and removes a renamed marker.
        try {
          await unlink(join(directory, 'complete.json'));
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new RecordsError();
        }
        withdrawn = true;
        if (!busy) releaseActive();
      }
      async function fail(): Promise<never> {
        if (state !== 'closed') await invalidate();
        throw new RecordsError();
      }
      async function appendRaw(data: Buffer) {
        validateOpen();
        if (!Number.isSafeInteger(bytes + data.length) || bytes + data.length > maxBytes) throw new RecordsError();
        await handle.writeFile(data);
        validateOpen();
        bytes += data.length;
      }
      async function append(text: string) {
        const data = Buffer.from(text);
        await handle.writeFile(data);
        bytes += data.length;
        if (truncated) return;
        for (const character of text) {
          const length = Buffer.byteLength(character);
          if (excerptBytes + length > outputLimits.excerptBytes) {
            truncated = true;
            break;
          }
          excerpt += character;
          excerptBytes += length;
        }
      }
      let aborting: Promise<void> | undefined;
      function revokeRaw() {
        // invalidate() closes state before its first await. Keep the read fence
        // until any busy publication has observed that state and withdrawn.
        void (aborting ??= invalidate()).catch(() => {
          /* Protected failure; keep fence. */
        });
      }
      if (raw) {
        activeRaw.set(reference.id, revokeRaw);
        releaseActive = () => {
          activeRaw.delete(reference.id);
        };
        validateOpen();
      }
      const channel = {
        reference,
        // Failure/revocation discards buffered filter state and withdraws completion,
        // including a finish whose publication raced with the caller's revocation.
        abort() {
          return (aborting ??= invalidate());
        },
        async write(chunk: Uint8Array): Promise<string> {
          if (state !== 'open' || busy) return fail();
          busy = true;
          try {
            if (!(chunk instanceof Uint8Array) || chunk.byteLength > outputLimits.chunkBytes) return await fail();
            validateOpen();
            if (raw) {
              // Count caller input BEFORE concat/allocation/append, including
              // retained bytes. This budget is not a global reservation.
              if (!Number.isSafeInteger(received + chunk.byteLength) || received + chunk.byteLength > maxBytes) return await fail();
              received += chunk.byteLength;
              const data = Buffer.concat([rawPending, chunk]);
              if (encodedSecrets.some(secret => data.includes(secret))) return await fail();
              const retain = Math.max(0, ...encodedSecrets.map(secret => secret.length - 1));
              const end = Math.max(0, data.length - retain);
              // Copy only the bounded tail, not the full backing allocation.
              rawPending = Buffer.from(data.subarray(end));
              await appendRaw(data.subarray(0, end));
              return '';
            }
            const result = filter(pending + decoder.decode(chunk, { stream: true }), false);
            pending = result.pending;
            await append(result.text);
            if (state !== 'open') return await fail();
            return result.text;
          } catch {
            return await fail();
          } finally {
            busy = false;
            releaseFailed();
          }
        },
        async finish() {
          if (state !== 'open' || busy) return fail();
          busy = true;
          try {
            validateOpen();
            const result = raw ? { text: '', pending: '' } : filter(pending + decoder.decode(), true);
            pending = '';
            if (raw) {
              await appendRaw(rawPending);
              rawPending = Buffer.alloc(0);
            } else await append(result.text);
            validateOpen();
            await handle.sync();
            await handle.close();
            validateOpen();
            await atomicJson(
              directory,
              'complete.json',
              safeMetadata(
                raw ? { version: 2, format: 'raw', bytes, finishedAt: new Date().toISOString() } : { version: 1, bytes, finishedAt: new Date().toISOString() },
              ),
              validateOpen,
            );
            validateOpen();
            state = 'closed';
            releaseActive();
            return {
              reference,
              tail: result.text,
              bytes,
              excerpt,
              truncated,
              display: truncated ? `${excerpt}\n[DISPLAY TRUNCATED; protected output available by reference]` : excerpt,
            };
          } catch {
            return await fail();
          } finally {
            busy = false;
            releaseFailed();
          }
        },
      };
      if (raw)
        return {
          reference,
          abort: channel.abort,
          async write(chunk) {
            await channel.write(chunk);
          },
          async finish() {
            const result = await channel.finish();
            return { version: 2, format: 'raw', reference, bytes: result.bytes };
          },
        };
      return channel;
    } catch {
      releaseActive();
      try {
        await file?.close();
      } catch {
        /* Capture remains incomplete. */
      }
      throw new RecordsError();
    }
  }
  // Technical projection only: the host still authorizes owner/phase/reference.
  // No capture is created and the existing matcher and bounded reader are reused.
  function projectText(input: TextProjectionRequest): TextProjection {
    const revision = registryRevision;
    const { expectedBytes, signal } = input;
    let state: TextProjection['state'] = 'pending';
    // Snapshot identities before the first await; invalid input fails on iteration.
    const context = contextSchema.safeParse(input.context);
    const reference = referenceSchema.safeParse(input.reference);
    function validate() {
      if (revision !== registryRevision || signal?.aborted || state === 'failed') throw new RecordsError();
    }
    async function* stream(): AsyncGenerator<Buffer, void, unknown> {
      let pending = '';
      // Preserve the persisted BOM exactly; capture already applied its BOM policy.
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      try {
        validate();
        if (!context.success || !reference.success || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new RecordsError();
        state = 'streaming';
        let offset = 0;
        do {
          validate();
          const limit = Math.min(outputLimits.pageBytes, Math.max(1, expectedBytes - offset));
          const page = await readPage({ reference: reference.data, offset, limit, context: context.data });
          validate();
          if (
            page.state !== 'complete' ||
            page.bytes !== expectedBytes ||
            page.data.length > limit ||
            page.nextOffset !== offset + page.data.length ||
            page.nextOffset > expectedBytes ||
            (offset < expectedBytes && page.data.length === 0)
          )
            throw new RecordsError();
          offset = page.nextOffset;
          const result = filter(pending + decoder.decode(page.data, { stream: true }), false);
          pending = result.pending;
          const bytes = Buffer.from(result.text);
          for (let start = 0; start < bytes.length; start += outputLimits.pageBytes) {
            validate();
            yield bytes.subarray(start, start + outputLimits.pageBytes);
            validate();
          }
        } while (offset < expectedBytes);
        const tail = Buffer.from(filter(pending + decoder.decode(), true).text);
        pending = '';
        if (tail.length) {
          validate();
          yield tail;
          validate();
        }
        // Recheck completion/count after the last consumer suspension. This is
        // not a filesystem snapshot or a promise against same-size host tampering.
        validate();
        const end = await readPage({ reference: reference.data, offset: expectedBytes, limit: 1, context: context.data });
        validate();
        if (end.state !== 'complete' || end.bytes !== expectedBytes || end.nextOffset !== expectedBytes || end.data.length !== 0) throw new RecordsError();
        state = 'complete';
      } catch {
        state = 'failed';
        throw new RecordsError();
      } finally {
        pending = '';
        if (state !== 'complete') state = 'failed';
      }
    }
    const chunks = stream();
    const close = chunks.return.bind(chunks);
    const interrupt = chunks.throw.bind(chunks);
    // Generator finally does not run when closed before the first next().
    chunks.return = value => {
      if (state !== 'complete') state = 'failed';
      return close(value);
    };
    chunks.throw = error => {
      if (state !== 'complete') state = 'failed';
      return interrupt(error);
    };
    return {
      chunks,
      get state() {
        if (state !== 'complete' && (revision !== registryRevision || signal?.aborted)) state = 'failed';
        return state;
      },
      assertCompleteAndCurrent() {
        // Completion is historical. This guard neither rereads the source nor
        // changes that state when a later registration/abort makes it stale.
        if (state !== 'complete') throw new RecordsError();
        validate();
      },
    };
  }
  async function readPage({ reference, offset, limit, format, context }: ReadRequest & { format?: 'raw'; context?: OutputContext }): Promise<OutputPage> {
    const readRevision = registryRevision;
    try {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > outputLimits.pageBytes) throw new RecordsError();
      const directory = await location(reference);
      // Missing/corrupt correlation metadata is not an absent output or a
      // complete uncorrelated result, even when the output file survived.
      let raw = false;
      let captureBudget = Number.MAX_SAFE_INTEGER;
      try {
        const capture = z.union([captureSchema, rawCaptureSchema]).parse(await privateJson(join(directory, 'capture.json')));
        if (context && Object.keys(contextSchema.shape).some(key => capture.context[key as keyof OutputContext] !== context[key as keyof OutputContext]))
          throw new RecordsError();
        raw = capture.version === 2;
        if (capture.version === 2) captureBudget = capture.maxBytes;
        if (raw !== (format === 'raw')) throw new RecordsError();
        if (capture.reference.workId !== reference.workId || capture.reference.id !== reference.id || capture.context.workId !== reference.workId)
          throw new RecordsError();
      } catch {
        throw new RecordsError();
      }
      const outputPath = join(directory, 'output');
      const info = await lstat(outputPath);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new RecordsError();
      if (
        raw &&
        (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > captureBudget || !Number.isSafeInteger(offset + limit) || offset > info.size)
      )
        throw new RecordsError();
      let state: 'complete' | 'partial' = 'partial';
      try {
        const complete = z
          .union([
            z.strictObject({ version: z.literal(1), bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), finishedAt: z.iso.datetime() }),
            z.strictObject({
              version: z.literal(2),
              format: z.literal('raw'),
              bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              finishedAt: z.iso.datetime(),
            }),
          ])
          .parse(await privateJson(join(directory, 'complete.json')));
        if ((complete.version === 2) !== raw || complete.bytes !== info.size) throw new RecordsError();
        state = 'complete';
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (raw && (state !== 'complete' || activeRaw.has(reference.id)))
        return { state: 'partial', data: Buffer.alloc(0), nextOffset: offset, bytes: info.size };
      const file = await open(outputPath, 'r');
      try {
        const data = Buffer.alloc(limit);
        const { bytesRead } = await file.read(data, 0, limit, offset);
        if (raw) {
          if (activeRaw.has(reference.id) || readRevision !== registryRevision)
            return { state: 'partial', data: Buffer.alloc(0), nextOffset: offset, bytes: info.size };
          // An abort of an already completed channel may have started and
          // withdrawn its marker while this read awaited the data syscall.
          try {
            await privateJson(join(directory, 'complete.json'));
          } catch {
            return { state: 'partial', data: Buffer.alloc(0), nextOffset: offset, bytes: info.size };
          }
          if (activeRaw.has(reference.id) || readRevision !== registryRevision)
            return { state: 'partial', data: Buffer.alloc(0), nextOffset: offset, bytes: info.size };
        }
        return { state, data: data.subarray(0, bytesRead), nextOffset: offset + bytesRead, bytes: info.size };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { state: 'absent' as const, data: Buffer.alloc(0), nextOffset: offset, bytes: 0 };
      }
      throw new RecordsError();
    }
  }
  /**
   * Ticket 26 (`read(selection)` with filters): the captures of ONE Work whose recorded correlation matches the selection, with their state.
   * Unreadable/corrupt capture metadata or an over-limit listing makes the result `incomplete` — never proof of absence.
   */
  async function find(selection: {
    workId: string;
    executionId?: string;
    invocationId?: string;
    callId?: string;
    role?: OutputContext['role'];
    id?: string;
    after?: string;
    limit?: number;
  }): Promise<{
    completeness: 'complete' | 'incomplete';
    captures: FoundCapture[];
    next: string | null;
    /** Ticket 17 preserved-evidence folders examined (known Factory-owned non-captures: never logs, never a reason for `incomplete`). */ preservedEvidence: number;
  }> {
    // Ticket 29 paging: `after` (a capture id) and `limit` page the Work's captures in id order; `next` is the last id examined when more remain.
    // `id` looks one capture up directly; `role` filters by the recorded role. A paged call has no listing cap (it reads at most `limit` matches).
    const filter = z
      .strictObject({
        workId: identifier,
        executionId: identifier.optional(),
        invocationId: identifier.optional(),
        callId: identifier.optional(),
        role: contextSchema.shape.role.optional(),
        id: z.uuid().optional(),
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(findLimit).optional(),
      })
      .safeParse(selection);
    if (!filter.success) throw new RecordsError();
    const { id: only, after, limit, ...correlation } = filter.data;
    const evidence = join(root, correlation.workId, 'evidence');
    let names: string[];
    try {
      for (const path of [join(root, correlation.workId), evidence]) await privateDirectory(path);
      names = await readdir(evidence);
    } catch (error) {
      // No evidence of this Work proves absence ONLY under an intact Records root (ticket 26 review): otherwise nothing is proven.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && (await rootIntact()))
        return { completeness: 'complete', captures: [], next: null, preservedEvidence: 0 };
      return { completeness: 'incomplete', captures: [], next: null, preservedEvidence: 0 };
    }
    const paged = only !== undefined || after !== undefined || limit !== undefined;
    if (!paged && names.length > findLimit) return { completeness: 'incomplete', captures: [], next: null, preservedEvidence: 0 };
    let preservedEvidence = 0;
    let candidates = names.sort();
    if (only !== undefined) candidates = candidates.filter(name => name === only);
    if (after !== undefined) candidates = candidates.filter(name => name > after);
    let completeness: 'complete' | 'incomplete' = 'complete';
    const captures: FoundCapture[] = [];
    let next: string | null = null;
    for (const [index, name] of candidates.entries()) {
      if (limit !== undefined && captures.length >= limit) {
        next = candidates[index - 1] ?? null;
        break;
      }
      if (!z.uuid().safeParse(name).success) {
        completeness = 'incomplete';
        continue;
      }
      try {
        const directory = join(evidence, name);
        await privateDirectory(directory);
        // Ticket 29: ticket 17's preserved-evidence folder (exactly `manifest.json` + `files/`, a valid environment-evidence manifest) is a
        // known Factory-owned non-capture. A folder interrupted before its manifest, another kind or an extra entry stays unknown (incomplete).
        const entries = await readdir(directory);
        if (entries.includes('manifest.json') && !entries.includes('capture.json')) {
          if (entries.length !== 2 || !entries.includes('files')) throw new RecordsError();
          await privateDirectory(join(directory, 'files'));
          manifestSchema.parse(await privateJson(join(directory, 'manifest.json')));
          preservedEvidence++;
          continue;
        }
        const capture = z.union([captureSchema, rawCaptureSchema]).parse(await privateJson(join(directory, 'capture.json')));
        if (capture.reference.id !== name || capture.reference.workId !== correlation.workId || capture.context.workId !== correlation.workId) {
          completeness = 'incomplete';
          continue;
        }
        const { workId: _workId, ...wanted } = correlation;
        if (Object.entries(wanted).some(([key, value]) => value !== undefined && capture.context[key as keyof OutputContext] !== value)) continue;
        let state: 'complete' | 'partial' = 'partial';
        try {
          await privateJson(join(directory, 'complete.json'));
          state = 'complete';
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            completeness = 'incomplete';
            continue;
          }
        }
        // Ticket 29: the capture format, so inspection never displays a raw capture as text.
        captures.push({ reference: capture.reference, context: capture.context, state, format: capture.version === 2 ? 'raw' : 'text' });
      } catch {
        completeness = 'incomplete';
      }
    }
    return { completeness: completeness === 'complete' && (await rootIntact()) ? 'complete' : 'incomplete', captures, next, preservedEvidence };
  }
  const records = {
    openOutput,
    read,
    projectText,
    find,
    async record(context: OutputContext, event: unknown): Promise<OutputReference> {
      try {
        const parsed = z.json().parse(boundedEvent(event));
        context = contextSchema.parse(context);
        // Escape only after filtering string values/keys: a newline or quote in
        // a secret must not evade filtering by becoming a JSON escape sequence.
        function redact(value: JsonEvent, depth = 0): JsonEvent {
          if (depth > 32) throw new RecordsError();
          if (typeof value === 'string') return filter(value, true).text;
          if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
          if (value && typeof value === 'object') {
            const result: Record<string, JsonEvent> = Object.create(null);
            for (const [key, item] of Object.entries(value)) {
              const filtered = filter(key, true).text;
              if (Object.hasOwn(result, filtered)) throw new RecordsError();
              result[filtered] = redact(item, depth + 1);
            }
            return result;
          }
          return value;
        }
        const encoded = Buffer.from(JSON.stringify({ version: 1, context, recordedAt: new Date().toISOString(), event: redact(parsed) }));
        // A collision with structural/correlation metadata cannot be redacted
        // without corrupting the record. Refuse it rather than publish bad JSON.
        if (encoded.length > outputLimits.chunkBytes || filter(encoded.toString(), true).text !== encoded.toString()) throw new RecordsError();
        const output = await records.openOutput(context);
        await output.write(encoded);
        return (await output.finish()).reference;
      } catch {
        throw new RecordsError();
      }
    },
    /**
     * Spec §12.2: a short text that leaves the capture path (a description kept in a host record, shown or put into a prompt) through the
     * SAME matcher as every capture: each known secret becomes the redaction marker. No capture is created.
     */
    filterText(value: string): string {
      if (typeof value !== 'string' || value.length > outputLimits.chunkBytes) throw new RecordsError();
      return filter(value, true).text;
    },
    registerSecret(value: string) {
      if (typeof value !== 'string' || !value || value.includes(redactionMarker) || value.length > outputLimits.secretCharacters) throw new RecordsError();
      if (secrets.includes(value)) return;
      if (secrets.length >= outputLimits.secretCount) throw new RecordsError();
      // New registration/rotation invalidates every active raw snapshot BEFORE
      // returning. No larger matcher window can be installed after a prefix was
      // flushed. Old completed captures are not retroactively reclassified.
      registryRevision++;
      for (const invalidate of activeRaw.values()) invalidate();
      encodedSecrets.push(Buffer.from(value, 'utf8'));
      secrets.push(value);
      secrets.sort((a, b) => b.length - a.length);
    },
  };
  return records;
}
export { listDetails, preserveSessionCopy, removeRecordsDetail, type RecordsDetail, type RecordsInventory, type RecordsRemoval } from './retention.js';
export { forgetWorkRecords, inspectWorkRecords, type RecordsForget, type RecordsTree } from './forget.js';
