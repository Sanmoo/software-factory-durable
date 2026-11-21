// Ticket 29 (spec §12.1): model usage of ONE preserved Pi session (JSONL v3), as the SDK itself recorded it per assistant message, usage
// entry, compaction or branch summary. Read-only; the SDK's cost is its catalog-price estimate, never an invoice; no price is computed here.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { readSessionFile, sessionFileLimits, workerRuntimeDirectory } from '../platform/host/index.js';

export type SessionTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
export type SessionUsageEntry = {
  id: string;
  provider: string | null;
  model: string | null;
  outcome: 'ok' | 'error' | 'aborted' | 'other';
  tokens: SessionTokens;
  cost: number | null;
};
/** `integrity`: `verified` = the bytes match the hash recorded for this session; `unverified` = no hash was recorded (reviewer sessions). */
export type SessionUsage =
  | { state: 'read'; sessionId: string; entries: SessionUsageEntry[]; malformed: number; integrity?: 'verified' | 'unverified' }
  | { state: 'lost' | 'unavailable' | 'altered'; code: string };

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown) => (typeof value === 'string' && value.length <= 256 ? value : null);

/** Usage entries of a session file's content. An entry that carries a usage object we cannot read is counted as `malformed` (a gap). */
export function sessionUsage(data: Buffer, sessionId: string): Extract<SessionUsage, { state: 'read' }> {
  const entries: SessionUsageEntry[] = [];
  let malformed = 0;
  const lines = data.toString('utf8').split('\n');
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformed++;
      continue;
    }
    if (!value || typeof value !== 'object') {
      malformed++;
      continue;
    }
    const message = value.type === 'message' && value.message && typeof value.message === 'object' ? (value.message as Record<string, unknown>) : null;
    const usage = (
      message?.role === 'assistant'
        ? message.usage
        : value.type === 'usage' || value.type === 'compaction' || value.type === 'branch_summary'
          ? value.usage
          : undefined
    ) as Record<string, unknown> | undefined;
    if (usage === undefined) continue;
    const id = text(value.id);
    const input = count(usage?.input),
      output = count(usage?.output),
      cacheRead = count(usage?.cacheRead),
      cacheWrite = count(usage?.cacheWrite);
    if (!id || input === null || output === null || cacheRead === null || cacheWrite === null) {
      malformed++;
      continue;
    }
    const total = count(usage.totalTokens) ?? input + output + cacheRead + cacheWrite;
    const cost = usage.cost && typeof usage.cost === 'object' ? count((usage.cost as Record<string, unknown>).total) : null;
    const stop = message ? message.stopReason : undefined;
    entries.push({
      id,
      provider: text(message?.provider ?? value.provider),
      model: text(message?.model ?? value.model),
      outcome: stop === 'error' ? 'error' : stop === 'aborted' ? 'aborted' : message ? 'ok' : 'other',
      tokens: { input, output, cacheRead, cacheWrite, total },
      cost,
    });
  }
  return { state: 'read', sessionId, entries, malformed };
}

/**
 * Reads a session by its recorded Builder `ref` (hash-checked) or a reviewer's recorded absolute `file`, bound to ONE boot of the Work: the
 * session must lie in that boot's runtime tree (`boot`, from the Execution record). A path outside it, with `..`, or not normalized is foreign:
 * `unavailable`, never measured. A reviewer session has no recorded hash: it is read but `unverified` (never complete).
 */
/** The JSONL v3 header id of a session's first line, or null. */
function sessionHeader(data: Buffer): { id: string } | null {
  const end = data.indexOf(0x0a);
  try {
    const value = JSON.parse(data.subarray(0, end < 0 ? data.length : end).toString('utf8')) as Record<string, unknown>;
    return value.type === 'session' && value.version === 3 && typeof value.id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value.id) ? { id: value.id } : null;
  } catch {
    return null;
  }
}

/**
 * Ticket 30: usage of a Records session copy `<root>/<workId>/sessions/<name>.jsonl` (preserved before its environment was removed), read
 * confined (private directories, no-follow, regular single-link file of this uid, bounded) and verified against the hash retention recorded.
 */
export async function observeSessionCopyUsage(root: string, copy: { workId: string; name: string; sha256: string }): Promise<SessionUsage> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(copy.workId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}(--rv-[0-9a-f]{16})?$/.test(copy.name)) {
    return { state: 'unavailable', code: 'SESSION_COPY_NAME_INVALID' };
  }
  let file;
  try {
    if ((await realpath(root)) !== root) return { state: 'unavailable', code: 'SESSION_ROOT_NOT_CANONICAL' };
    for (const directory of [join(root, copy.workId), join(root, copy.workId, 'sessions')]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) return { state: 'unavailable', code: 'SESSION_COPY_PATH_UNSAFE' };
    }
    file = await open(join(root, copy.workId, 'sessions', `${copy.name}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { state: 'lost', code: 'SESSION_COPY_MISSING' }
      : { state: 'unavailable', code: 'SESSION_COPY_PATH_UNSAFE' };
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      info.size === 0 ||
      info.size > sessionFileLimits.maxBytes
    ) {
      return { state: 'unavailable', code: 'SESSION_COPY_UNSAFE' };
    }
    const data = await file.readFile();
    if (data.length !== info.size || createHash('sha256').update(data).digest('hex') !== copy.sha256)
      return { state: 'altered', code: 'SESSION_COPY_HASH_MISMATCH' };
    const header = sessionHeader(data);
    if (!header) return { state: 'unavailable', code: 'SESSION_HEADER_INVALID' };
    return { ...sessionUsage(data, header.id), integrity: 'verified' };
  } catch {
    return { state: 'unavailable', code: 'SESSION_COPY_UNREADABLE' };
  } finally {
    await file.close().catch(() => {});
  }
}

/** Cache of hash-verified observations keyed by the file identity (ref, recorded hash, inode, size, mtime): a changed file is read again. */
export type SessionUsageCache = Map<string, SessionUsage>;
export async function observeSessionUsage(
  root: string,
  session: { ref: string; sha256: string } | { file: string },
  boot: string | null,
  cache?: SessionUsageCache,
): Promise<SessionUsage> {
  let ref: string;
  if ('ref' in session) ref = session.ref;
  else {
    if (!isAbsolute(session.file) || normalize(session.file) !== session.file) return { state: 'unavailable', code: 'SESSION_FILE_NOT_NORMALIZED' };
    ref = relative(root, session.file).split(sep).join('/');
  }
  if (ref.split('/').some(part => part === '..' || part === '.' || part === '')) return { state: 'unavailable', code: 'SESSION_NOT_OF_EXECUTION' };
  let runtime: string;
  try {
    if (!boot) throw new Error('NO_BOOT');
    runtime = relative(root, workerRuntimeDirectory(root, boot)).split(sep).join('/');
  } catch {
    return { state: 'unavailable', code: 'SESSION_BOOT_UNKNOWN' };
  }
  if (!ref.startsWith(`${runtime}/`)) return { state: 'unavailable', code: 'SESSION_NOT_OF_EXECUTION' };
  const info = 'sha256' in session && cache ? await lstat(join(root, ref)).catch(() => null) : null;
  const key = info && 'sha256' in session ? `${ref}:${session.sha256}:${info.ino}:${info.size}:${info.mtimeMs}` : null;
  const cached = key ? cache!.get(key) : undefined;
  if (cached) return cached;
  const read = await readSessionFile(root, ref);
  if (read.state === 'lost') return { state: 'lost', code: read.code };
  if (read.state !== 'read') return { state: 'unavailable', code: read.code };
  if ('sha256' in session && read.sha256 !== session.sha256) return { state: 'altered', code: 'SESSION_HASH_MISMATCH' };
  const result: SessionUsage = { ...sessionUsage(read.data, read.sessionId), integrity: 'sha256' in session ? 'verified' : 'unverified' };
  if (key && cache) {
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
  }
  return result;
}
