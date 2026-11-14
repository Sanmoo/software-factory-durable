import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

/**
 * Ticket 11 (spec §5.5/§6.1): confined Host access to a Builder session preserved by its boot owner (Pi SessionManager JSONL v3) under the
 * installation's private runtime tree `<root>/r/<boot>/w-<id>/profile/sessions/<file>.jsonl`. This tree is host-only (never mounted into a
 * guest). Every directory from the root down must be a private (0700-like) real directory of this uid; the file is opened no-follow and must
 * be a regular single-link file of this uid, not group/world-writable (the SDK writes it with the process umask; the private directories keep
 * it unreadable to others), within the size bound, whose first line is the session header. Nothing is repaired or followed.
 */
export const sessionFileLimits = Object.freeze({ maxBytes: 64 * 1024 * 1024 });
const segment = /^[A-Za-z0-9_-]{1,128}$/;
const fileName = /^[A-Za-z0-9._-]{1,200}\.jsonl$/;
export const sessionRefSchema = z.strictObject({
  ref: z.string().max(1024).refine(value => { const parts = value.split('/'); return parts.length === 6 && parts[0] === 'r' && segment.test(parts[1]!) && /^w-[A-Za-z0-9]{1,64}$/.test(parts[2]!) &&
    parts[3] === 'profile' && parts[4] === 'sessions' && fileName.test(parts[5]!); }),
  sessionId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive().max(sessionFileLimits.maxBytes),
  format: z.literal('pi-session-jsonl-v3'),
  profile: z.strictObject({ sdkProfile: z.string().min(1).max(128), providerId: z.string().min(1).max(128), modelId: z.string().min(1).max(128),
    skillPack: z.string().max(64).nullable(), tools: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(16) }),
});
export type HostSessionRef = z.infer<typeof sessionRefSchema>;

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('SESSION_PATH_UNSAFE');
}
type Read = { state: 'read'; data: Buffer; sha256: string; sessionId: string } | { state: 'lost' | 'unsafe' | 'invalid'; code: string };
/** Reads one preserved session file under `root` (relative `ref`), confined as described above. */
export async function readSessionFile(root: string, ref: string): Promise<Read> {
  if (!isAbsolute(root) || ref.split('/').length !== 6 || ref.split('/').some(part => !part || part === '.' || part === '..')) return { state: 'unsafe', code: 'SESSION_REF_INVALID' };
  try {
    if (await realpath(root) !== root) return { state: 'unsafe', code: 'SESSION_ROOT_NOT_CANONICAL' };
  } catch { return { state: 'unsafe', code: 'SESSION_ROOT_UNAVAILABLE' }; }
  const path = join(root, ref);
  let file;
  try {
    let directory = root;
    for (const part of ref.split('/').slice(0, -1)) { directory = join(directory, part); await privateDirectory(directory); }
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    return code === 'ENOENT' ? { state: 'lost', code: 'SESSION_FILE_MISSING' } : { state: 'unsafe', code: 'SESSION_PATH_UNSAFE' };
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o022)) return { state: 'unsafe', code: 'SESSION_FILE_UNSAFE' };
    if (info.size === 0 || info.size > sessionFileLimits.maxBytes) return { state: 'invalid', code: 'SESSION_FILE_SIZE' };
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size || (await file.stat()).size !== info.size) return { state: 'invalid', code: 'SESSION_FILE_CHANGED' };
    const header = sessionHeader(data);
    if (!header) return { state: 'invalid', code: 'SESSION_HEADER_INVALID' };
    return { state: 'read', data, sha256: createHash('sha256').update(data).digest('hex'), sessionId: header.id };
  } catch { return { state: 'invalid', code: 'SESSION_FILE_UNREADABLE' }; } finally { await file.close().catch(() => {}); }
}

/** The JSONL v3 header of a Factory Builder session (`cwd` is the guest workspace), or null. */
export function sessionHeader(data: Buffer): { id: string } | null {
  const end = data.indexOf(0x0a);
  try {
    const value: unknown = JSON.parse(data.subarray(0, end < 0 ? data.length : end).toString('utf8'));
    const parsed = z.object({ type: z.literal('session'), version: z.literal(3), id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/), cwd: z.literal('/workspace') }).safeParse(value);
    return parsed.success ? { id: parsed.data.id } : null;
  } catch { return null; }
}

/** `ref` of a session file that must lie directly in `sessionsDirectory`, itself under `root`; null when it does not. */
export function sessionRefOf(root: string, sessionsDirectory: string, file: string): string | null {
  if (!isAbsolute(file) || dirname(file) !== sessionsDirectory || !fileName.test(basename(file))) return null;
  const ref = relative(root, file);
  return ref.startsWith('..') || isAbsolute(ref) || ref.split(sep).length !== 6 ? null : ref.split(sep).join('/');
}

/**
 * Owner side, after a Builder worker ended: the identity of the session it preserved, observed by the owner from its own sessions directory
 * (never the worker's claim alone). The profile is the launch's (SDK profile, provider/model, pack) plus the worker's exact tool set.
 */
export async function observePreservedSession(root: string, sessionsDirectory: string, file: unknown, tools: unknown,
  launch: { context: { role: string }; profile: { id: string; providerId: string; modelId: string }; skillPack?: string | undefined }): Promise<HostSessionRef | undefined> {
  if (launch.context.role !== 'builder' || typeof file !== 'string' || !Array.isArray(tools) || tools.length > 16 || tools.some(tool => typeof tool !== 'string' || !/^[a-z_]{1,32}$/.test(tool))) return undefined;
  const ref = sessionRefOf(root, sessionsDirectory, file);
  if (!ref) return undefined;
  const read = await readSessionFile(root, ref);
  if (read.state !== 'read') return undefined;
  return sessionRefSchema.parse({ ref, sessionId: read.sessionId, sha256: read.sha256, bytes: read.data.length, format: 'pi-session-jsonl-v3',
    profile: { sdkProfile: launch.profile.id, providerId: launch.profile.providerId, modelId: launch.profile.modelId, skillPack: launch.skillPack ?? null,
      tools: [...new Set(tools as string[])].sort() } });
}

/**
 * Owner side, before a continued Builder worker exists: re-read the preserved session (identity, hash and size must be exactly the observed
 * ones) and copy it exclusively into the new worker's private sessions directory. The original is never appended to or overwritten.
 */
export async function copyPreservedSession(root: string, sessionsDirectory: string, expected: { ref: string; sha256: string; sessionId: string; bytes: number }) {
  const read = await readSessionFile(root, expected.ref);
  if (read.state !== 'read' || read.sha256 !== expected.sha256 || read.sessionId !== expected.sessionId || read.data.length !== expected.bytes) throw new Error('WORKER_SESSION_UNAVAILABLE');
  const copy = join(sessionsDirectory, expected.ref.split('/').at(-1)!);
  const handle = await open(copy, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(read.data); await handle.sync(); } finally { await handle.close(); }
  return { file: copy, sha256: read.sha256, sessionId: read.sessionId };
}
