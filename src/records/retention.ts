import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

// Ticket 30 (spec §12.1/§12.3/§12.4): the OPERATIONAL details of a Work in the host-only Records area `<root>/<work>/`, which alone expire:
// - logs: tool/command output captures in `evidence/<uuid>/` — a raw capture (not a Records event envelope) whose call id is a tool call id;
// - sessions: agent session copies `sessions/<execution>[--rv-<16 hex>].jsonl`.
// Everything else history needs is KEPT until explicit history deletion (ticket 31) and never listed as a target (supervisor decision): Records
// event envelopes (start receipts, review opinions and their forwards, mutation intents/results, Question requests…), Host gate evidence
// (`probe-*`/`handoff-*` outputs), ticket 17's preserved evidence (`manifest.json`) and any capture of unknown kind (fail-closed). Nothing is
// followed (no symlink) or created outside the Work's own directories; an unexpected entry is reported, never removed.

export type RecordsDetail = {
  id: string;
  kind: 'log' | 'session';
  executionId: string | null;
  bytes: number;
  state: 'complete' | 'partial';
  /** Sessions: content hash at listing (removal re-checks it). */ sha256?: string | null;
};
export type RecordsInventory = {
  completeness: 'complete' | 'incomplete';
  observedAt: string;
  items: RecordsDetail[];
  evidence: number;
  /** Captures kept until explicit history deletion, by class (`record:<event kind>`, `host-evidence`, `unknown-kind`). */ kept: Record<string, number>;
  unknown: string[];
};
export type RecordsRemoval = { outcome: 'removed' | 'absent' | 'refused' | 'failed' | 'indeterminate'; code: string | null };

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** `<execution>.jsonl` (the recorded Builder session) or `<execution>--rv-<16 hex>.jsonl` (another agent session of the same boot). */
const sessionName = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,127}?)(--rv-[0-9a-f]{16})?\.jsonl$/;
const captureFiles = ['capture.json', 'complete.json', 'output'];
/** The capture's own files, including a temporary its atomic publication may have left after a crash. */
const ownCaptureFile = (name: string) => captureFiles.includes(name) || /^(capture|complete)\.json-[0-9a-f-]{36}\.tmp$/.test(name);
const listLimit = 20000;
const captureMeta = z.object({
  reference: z.object({ workId: z.string(), id: z.string() }),
  context: z.object({ workId: z.string(), executionId: z.string(), callId: z.string() }),
});
/** Tool call ids of agent tool executions (the SDK's UUIDs); reserved Records/Host call ids never match. */
const toolCallId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const envelopeLimit = 65536;
const temporarySession = /^\.([a-zA-Z0-9][a-zA-Z0-9_-]{0,160})\.[0-9a-f-]{36}\.tmp$/;

/**
 * Class of one capture (fail-closed): `log` only for a raw tool-call output; a Records event envelope (`{version, context, recordedAt, event}`
 * with this capture's context) is `record:<event kind>`; Host probe/handoff outputs are `host-evidence`; anything else is `unknown-kind`.
 */
async function captureClass(directory: string, meta: z.infer<typeof captureMeta>, outputBytes: number): Promise<string> {
  const callId = meta.context.callId;
  if (/^(probe|handoff)-/.test(callId)) return 'host-evidence';
  const head = Buffer.alloc(Math.min(outputBytes, envelopeLimit));
  if (head.length) {
    const handle = await open(join(directory, 'output'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
  }
  if (head.subarray(0, 12).toString() === '{"version":1') {
    try {
      const value = JSON.parse(head.toString('utf8')) as { context?: { callId?: unknown }; event?: { kind?: unknown } };
      if (value.context?.callId === callId && value.event && typeof value.event === 'object')
        return `record:${typeof value.event.kind === 'string' ? value.event.kind.slice(0, 64) : callId.slice(0, 64)}`;
    } catch {
      return 'unknown-kind';
    }
    return 'unknown-kind';
  }
  return toolCallId.test(callId) ? 'log' : 'unknown-kind';
}
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
class Unsafe extends Error {}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Unsafe();
  return info;
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function regularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new Unsafe();
  return info;
}
async function hashFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.readableWebStream()) hash.update(chunk as Uint8Array);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
/** Canonical root and the Work directory; `null` work directory = it does not exist under an intact root (nothing of this Work there). */
async function workDirectory(root: string, workId: string): Promise<{ root: string; directory: string | null }> {
  if (!identifier.test(workId)) throw new Unsafe();
  const canonical = await realpath(root);
  await privateDirectory(canonical);
  const directory = join(canonical, workId);
  try {
    await privateDirectory(directory);
  } catch (error) {
    if (missing(error)) return { root: canonical, directory: null };
    throw error;
  }
  return { root: canonical, directory };
}

/**
 * Inventory of one Work's details. `complete` only when every entry was classified under an intact private Records area; an unreadable
 * capture or an unexpected entry makes it `incomplete` (absence is then never concluded from it).
 */
export async function listDetails(root: string, workId: string): Promise<RecordsInventory> {
  const observedAt = new Date().toISOString();
  const result: RecordsInventory = { completeness: 'complete', observedAt, items: [], evidence: 0, kept: {}, unknown: [] };
  let directory: string | null;
  try {
    ({ directory } = await workDirectory(root, workId));
  } catch {
    return { ...result, completeness: 'incomplete' };
  }
  if (!directory) return result;
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch {
    return { ...result, completeness: 'incomplete' };
  }
  for (const name of names) {
    if (name === 'evidence') await listEvidence(join(directory, name), workId, result);
    else if (name === 'sessions') await listSessions(join(directory, name), result);
    else {
      result.unknown.push(name);
      result.completeness = 'incomplete';
    }
  }
  return result;
}
async function listEvidence(path: string, workId: string, result: RecordsInventory) {
  let names: string[];
  try {
    await privateDirectory(path);
    names = (await readdir(path)).sort();
  } catch {
    result.completeness = 'incomplete';
    return;
  }
  if (names.length > listLimit) {
    result.completeness = 'incomplete';
    return;
  }
  for (const name of names) {
    const directory = join(path, name);
    try {
      if (!z.uuid().safeParse(name).success) throw new Unsafe();
      await privateDirectory(directory);
      const entries = await readdir(directory);
      if (entries.includes('manifest.json')) {
        result.evidence++;
        continue;
      }
      if (!entries.includes('capture.json') || entries.some(entry => !ownCaptureFile(entry))) throw new Unsafe();
      const meta = captureMeta.parse(JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')));
      if (meta.reference.id !== name || meta.reference.workId !== workId || meta.context.workId !== workId) throw new Unsafe();
      let bytes = 0,
        output = 0;
      for (const entry of entries) {
        const size = (await regularFile(join(directory, entry))).size;
        bytes += size;
        if (entry === 'output') output = size;
      }
      const kind = entries.includes('output') ? await captureClass(directory, meta, output) : 'unknown-kind';
      if (kind !== 'log') {
        result.kept[kind] = (result.kept[kind] ?? 0) + 1;
        continue;
      }
      result.items.push({
        id: `log:${name}`,
        kind: 'log',
        executionId: meta.context.executionId,
        bytes,
        state: entries.includes('complete.json') ? 'complete' : 'partial',
      });
    } catch {
      result.unknown.push(`evidence/${name}`);
      result.completeness = 'incomplete';
    }
  }
}
async function listSessions(path: string, result: RecordsInventory) {
  let names: string[];
  try {
    await privateDirectory(path);
    names = (await readdir(path)).sort();
  } catch {
    result.completeness = 'incomplete';
    return;
  }
  for (const name of names) {
    const match = sessionName.exec(name);
    try {
      // A temporary of an interrupted copy is the copy's own leftover (repaired by the next preservation), never a detail or unknown.
      if (temporarySession.test(name)) {
        const info = await lstat(join(path, name));
        if (info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.()) continue;
      }
      if (!match) throw new Unsafe();
      const info = await sessionFile(path, name);
      result.items.push({
        id: `session:${match[1]}${match[2] ?? ''}`,
        kind: 'session',
        executionId: match[1]!,
        bytes: info.size,
        state: 'complete',
        sha256: await hashFile(join(path, name)),
      });
    } catch {
      result.unknown.push(`sessions/${name}`);
      result.completeness = 'incomplete';
    }
  }
}
/** A session copy: a regular file of this uid; a second link is accepted only to its own leftover temporary (crash between link and unlink). */
async function sessionFile(directory: string, name: string) {
  const info = await lstat(join(directory, name));
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Unsafe();
  if (info.nlink === 1) return info;
  if (info.nlink !== 2 || !(await leftovers(directory, name, info.ino)).length) throw new Unsafe();
  return info;
}
/** Own temporaries of `name` that are hard links to `ino` (the published copy). */
async function leftovers(directory: string, name: string, ino: number) {
  const base = name.replace(/\.jsonl$/, '');
  const found: string[] = [];
  for (const entry of await readdir(directory)) {
    const match = temporarySession.exec(entry);
    if (!match || match[1] !== base) continue;
    const info = await lstat(join(directory, entry));
    if (info.isFile() && !info.isSymbolicLink() && info.ino === ino) found.push(entry);
  }
  return found;
}

/**
 * Copies a recorded session (bytes already verified against its recorded hash by the caller) into `<root>/<work>/sessions/<execution>.jsonl`:
 * a new private file, synced, published by an exclusive hard link (never overwriting). An existing identical copy is `already`.
 */
export async function preserveSessionCopy(
  root: string,
  workId: string,
  executionId: string,
  data: Buffer,
  sha256: string,
): Promise<{ status: 'preserved' | 'already'; sha256: string; bytes: number } | { status: 'failed'; code: string }> {
  if (!identifier.test(workId) || !identifier.test(executionId) || createHash('sha256').update(data).digest('hex') !== sha256)
    return { status: 'failed', code: 'SESSION_COPY_INVALID' };
  let temporary: string | undefined;
  try {
    const canonical = await realpath(root);
    await privateDirectory(canonical);
    for (const path of [join(canonical, workId), join(canonical, workId, 'sessions')]) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      await privateDirectory(path);
    }
    const directory = join(canonical, workId, 'sessions');
    const final = join(directory, `${executionId}.jsonl`);
    // Idempotent repair of an interrupted copy: a published copy still linked to its temporary (crash between link and unlink) is verified and
    // its temporary unlinked; an unpublished temporary (crash before link) is discarded. Never a reason to block forever.
    try {
      const info = await sessionFile(directory, `${executionId}.jsonl`);
      if ((await hashFile(final)) !== sha256) return { status: 'failed', code: 'SESSION_COPY_CONFLICT' };
      for (const entry of info.nlink === 2 ? await leftovers(directory, `${executionId}.jsonl`, info.ino) : []) await unlink(join(directory, entry));
      await syncDirectory(directory);
      return { status: 'already', sha256, bytes: data.length };
    } catch (error) {
      if (!missing(error)) throw error;
    }
    for (const entry of await readdir(directory)) if (temporarySession.exec(entry)?.[1] === executionId) await unlink(join(directory, entry));
    temporary = join(directory, `.${executionId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, final);
    await unlink(temporary);
    temporary = undefined;
    await syncDirectory(directory);
    return { status: 'preserved', sha256, bytes: data.length };
  } catch {
    if (temporary) await unlink(temporary).catch(() => {});
    return { status: 'failed', code: 'SESSION_PRESERVATION_FAILED' };
  }
}

/**
 * Confined removal of ONE detail of this Work. A log directory must hold only its capture files (a preserved-evidence directory or any other
 * entry is refused); a session copy is removed only while its content hash is the recorded one. Absence is concluded only under the intact
 * Work directory. A partial removal is `failed` (what remains stays visible in the next inventory).
 */
export async function removeRecordsDetail(
  root: string,
  workId: string,
  item: { id: string; kind: 'log' | 'session' },
  expectedSha256: string | null,
): Promise<RecordsRemoval> {
  let directory: string | null;
  try {
    ({ directory } = await workDirectory(root, workId));
  } catch {
    return { outcome: 'failed', code: 'RECORDS_AREA_UNAVAILABLE' };
  }
  if (!directory) return { outcome: 'absent', code: 'WORK_RECORDS_ABSENT' };
  if (item.kind === 'log') {
    const id = item.id.startsWith('log:') ? item.id.slice(4) : '';
    if (!z.uuid().safeParse(id).success) return { outcome: 'refused', code: 'DETAIL_ID_INVALID' };
    const path = join(directory, 'evidence', id);
    let removed = false;
    try {
      try {
        await privateDirectory(path);
      } catch (error) {
        if (missing(error)) {
          await privateDirectory(join(directory, 'evidence')).catch(() => {});
          return { outcome: 'absent', code: null };
        }
        throw error;
      }
      const entries = await readdir(path);
      if (!entries.includes('capture.json') || entries.some(entry => !ownCaptureFile(entry))) return { outcome: 'refused', code: 'NOT_A_LOG_CAPTURE' };
      const meta = captureMeta.parse(JSON.parse(await readFile(join(path, 'capture.json'), 'utf8')));
      if (meta.reference.id !== id || meta.context.workId !== workId) return { outcome: 'refused', code: 'CAPTURE_NOT_OWN' };
      let output = 0;
      for (const entry of entries) {
        const size = (await regularFile(join(path, entry))).size;
        if (entry === 'output') output = size;
      }
      // Revalidated at removal: only a tool/command output capture; records history needs (and unknown kinds) are never removed here.
      if (!entries.includes('output') || (await captureClass(path, meta, output)) !== 'log') return { outcome: 'refused', code: 'NOT_A_LOG_CAPTURE' };
      // The completion marker first, so an interrupted removal is never a complete capture again; capture.json last.
      const order = ['complete.json', ...entries.filter(name => !captureFiles.includes(name)), 'output', 'capture.json'].filter(name => entries.includes(name));
      for (const entry of order) {
        await unlink(join(path, entry));
        removed = true;
      }
      await rmdir(path);
      await syncDirectory(join(directory, 'evidence'));
      return { outcome: 'removed', code: null };
    } catch (error) {
      return error instanceof Unsafe
        ? { outcome: 'refused', code: 'LOG_UNSAFE' }
        : { outcome: 'failed', code: removed ? 'LOG_REMOVAL_PARTIAL' : 'LOG_REMOVAL_FAILED' };
    }
  }
  const name = item.id.startsWith('session:') ? item.id.slice(8) : '';
  if (!sessionName.test(`${name}.jsonl`) || !expectedSha256) return { outcome: 'refused', code: 'DETAIL_ID_INVALID' };
  const sessions = join(directory, 'sessions');
  const path = join(sessions, `${name}.jsonl`);
  try {
    let info;
    try {
      info = await sessionFile(sessions, `${name}.jsonl`);
    } catch (error) {
      if (missing(error)) return { outcome: 'absent', code: null };
      throw error;
    }
    if ((await hashFile(path)) !== expectedSha256) return { outcome: 'refused', code: 'SESSION_CHANGED' };
    for (const entry of info.nlink === 2 ? await leftovers(sessions, `${name}.jsonl`, info.ino) : []) await unlink(join(sessions, entry));
    await unlink(path);
    await syncDirectory(sessions);
    return { outcome: 'removed', code: null };
  } catch (error) {
    return error instanceof Unsafe ? { outcome: 'refused', code: 'SESSION_UNSAFE' } : { outcome: 'failed', code: 'SESSION_REMOVAL_FAILED' };
  }
}
