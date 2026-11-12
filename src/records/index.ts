import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import { z } from 'zod';

// A single delimiter absent from all registered values prevents replacement
// text plus adjacent output from synthesizing another known secret.
const redactionMarker = '█';
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const contextSchema = z.strictObject({
  workId: identifier, executionId: identifier, invocationId: identifier,
  role: z.enum(['builder', 'standards', 'spec']), environmentRef: identifier, bootRef: identifier, callId: identifier,
});
export type OutputContext = z.infer<typeof contextSchema>;
const referenceSchema = z.strictObject({ workId: identifier, id: z.uuid() });
const captureSchema = z.strictObject({ version: z.literal(1), context: contextSchema, reference: referenceSchema, startedAt: z.iso.datetime() });
export type OutputReference = z.infer<typeof referenceSchema>;
export const outputLimits = Object.freeze({ chunkBytes: 65536, pageBytes: 65536, excerptBytes: 4096,
  secretCharacters: 4096, secretCount: 128 });
export class RecordsError extends Error {
  constructor() { super('PROTECTED_CAPTURE_UNAVAILABLE'); }
}

async function privateDirectory(path: string, create = false) {
  if (create) {
    let created = false;
    try { await mkdir(path, { mode: 0o700 }); created = true; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    if (created) {
      const parent = await open(dirname(path), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
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
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    validate();
    await rename(temporary, destination);
    renamed = true;
    validate();
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    validate();
  } catch (error) {
    // Only our exclusive temporary file and our published destination; never
    // recursively clean a capture or touch another capture's artifacts.
    if (renamed) await unlink(destination);
    throw error;
  } finally {
    if (created) {
      try { await unlink(temporary); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
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
  } finally { await file.close(); }
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
    } finally { active.delete(value); }
  }
  return visit(event, 0);
}

/** Host-only evidence storage. root must already be private and outside every guest mount. */
export async function createRecords({ root }: { root: string }) {
  try { await privateDirectory(root); root = await realpath(root); }
  catch { throw new RecordsError(); }
  const secrets: string[] = [];
  function filter(input: string, final: boolean): { text: string; pending: string } {
    const retain = final ? 0 : Math.max(0, ...secrets.map(secret => secret.length - 1));
    const end = Math.max(0, input.length - retain);
    let cursor = 0;
    let text = '';
    while (cursor < end) {
      const secret = secrets.find(secret => input.startsWith(secret, cursor));
      if (secret) { text += redactionMarker; cursor += secret.length; }
      else { text += input[cursor]; cursor++; }
    }
    // Do not split a surrogate pair when the retained boundary bisects UTF-16.
    if (!final && text.length && /[\uD800-\uDBFF]$/.test(text)) { text = text.slice(0, -1); cursor--; }
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
  const records = {
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
      } catch { throw new RecordsError(); }
    },
    registerSecret(value: string) {
      if (typeof value !== 'string' || !value || value.includes(redactionMarker) || value.length > outputLimits.secretCharacters) throw new RecordsError();
      if (secrets.includes(value)) return;
      if (secrets.length >= outputLimits.secretCount) throw new RecordsError();
      secrets.push(value); secrets.sort((a, b) => b.length - a.length);
    },
    async openOutput(input: OutputContext) {
      let file: FileHandle | undefined;
      try {
        const context = contextSchema.parse(input);
        // Identities cannot be redacted without changing their meaning. Reject
        // secret-bearing metadata before even choosing a filesystem destination.
        if (Object.values(context).some(value => secrets.some(secret => value.includes(secret)))) throw new RecordsError();
        const reference = { workId: context.workId, id: randomUUID() };
        const capture = safeMetadata({ version: 1, context, reference, startedAt: new Date().toISOString() });
        const workDirectory = join(root, context.workId);
        await privateDirectory(workDirectory, true);
        const evidence = join(workDirectory, 'evidence');
        await privateDirectory(evidence, true);
        const directory = join(evidence, reference.id);
        await privateDirectory(directory, true);
        await atomicJson(directory, 'capture.json', capture);
        file = await open(join(directory, 'output'), 'wx', 0o600);
        const handle = file;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let pending = '';
        let state: 'open' | 'closed' | 'failed' = 'open';
        let busy = false;
        let bytes = 0;
        let excerpt = '';
        let excerptBytes = 0;
        let truncated = false;
        function validateOpen() {
          if (state !== 'open') throw new RecordsError();
        }
        async function fail(): Promise<never> {
          if (state === 'closed') throw new RecordsError();
          state = 'failed'; pending = '';
          try { await handle.close(); } catch { /* No raw fallback, including error diagnostics. */ }
          // Do not await finish here: it can itself be calling fail. Publication
          // rechecks invalidation around rename/sync and removes a renamed marker.
          try { await unlink(join(directory, 'complete.json')); } catch { /* Never recursively remove. */ }
          throw new RecordsError();
        }
        async function append(text: string) {
          const data = Buffer.from(text);
          await handle.writeFile(data);
          bytes += data.length;
          if (truncated) return;
          for (const character of text) {
            const length = Buffer.byteLength(character);
            if (excerptBytes + length > outputLimits.excerptBytes) { truncated = true; break; }
            excerpt += character; excerptBytes += length;
          }
        }
        return {
          reference,
          async write(chunk: Uint8Array): Promise<string> {
            if (state !== 'open' || busy) return fail();
            busy = true;
            try {
              if (!(chunk instanceof Uint8Array) || chunk.byteLength > outputLimits.chunkBytes) return await fail();
              const result = filter(pending + decoder.decode(chunk, { stream: true }), false);
              pending = result.pending;
              await append(result.text);
              if (state !== 'open') return await fail();
              return result.text;
            } catch { return await fail(); }
            finally { busy = false; }
          },
          async finish() {
            if (state !== 'open' || busy) return fail();
            busy = true;
            try {
              const result = filter(pending + decoder.decode(), true);
              pending = '';
              await append(result.text);
              validateOpen();
              await handle.sync(); await handle.close();
              validateOpen();
              await atomicJson(directory, 'complete.json', safeMetadata({ version: 1, bytes, finishedAt: new Date().toISOString() }), validateOpen);
              validateOpen();
              state = 'closed';
              return { reference, tail: result.text, bytes, excerpt, truncated,
                display: truncated ? `${excerpt}\n[DISPLAY TRUNCATED; protected output available by reference]` : excerpt };
            } catch { return await fail(); }
            finally { busy = false; }
          },
        };
      } catch {
        try { await file?.close(); } catch { /* Capture remains incomplete. */ }
        throw new RecordsError();
      }
    },
    async read({ reference, offset, limit }: { reference: OutputReference; offset: number; limit: number }) {
      try {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > outputLimits.pageBytes) throw new RecordsError();
        const directory = await location(reference);
        // Missing/corrupt correlation metadata is not an absent output or a
        // complete uncorrelated result, even when the output file survived.
        try {
          const capture = captureSchema.parse(await privateJson(join(directory, 'capture.json')));
          if (capture.reference.workId !== reference.workId || capture.reference.id !== reference.id || capture.context.workId !== reference.workId) throw new RecordsError();
        } catch { throw new RecordsError(); }
        const outputPath = join(directory, 'output');
        const info = await lstat(outputPath);
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new RecordsError();
        let state: 'complete' | 'partial' = 'partial';
        try {
          const complete = z.strictObject({ version: z.literal(1), bytes: z.number().int().nonnegative(), finishedAt: z.iso.datetime() })
            .parse(await privateJson(join(directory, 'complete.json')));
          if (complete.bytes !== info.size) throw new RecordsError();
          state = 'complete';
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        const file = await open(outputPath, 'r');
        try {
          const data = Buffer.alloc(limit);
          const { bytesRead } = await file.read(data, 0, limit, offset);
          return { state, data: data.subarray(0, bytesRead), nextOffset: offset + bytesRead, bytes: info.size };
        } finally { await file.close(); }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return { state: 'absent' as const, data: Buffer.alloc(0), nextOffset: offset, bytes: 0 };
        }
        throw new RecordsError();
      }
    },
  };
  return records;
}
