import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
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
  ref: z
    .string()
    .max(1024)
    .refine(value => {
      const parts = value.split('/');
      return (
        parts.length === 6 &&
        parts[0] === 'r' &&
        segment.test(parts[1]!) &&
        /^w-[A-Za-z0-9]{1,64}$/.test(parts[2]!) &&
        parts[3] === 'profile' &&
        parts[4] === 'sessions' &&
        fileName.test(parts[5]!)
      );
    }),
  sessionId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(sessionFileLimits.maxBytes),
  format: z.literal('pi-session-jsonl-v3'),
  profile: z.strictObject({
    sdkProfile: z.string().min(1).max(128),
    providerId: z.string().min(1).max(128),
    modelId: z.string().min(1).max(128),
    skillPack: z.string().max(64).nullable(),
    tools: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(16),
  }),
});
export type HostSessionRef = z.infer<typeof sessionRefSchema>;

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('SESSION_PATH_UNSAFE');
}
type Read = { state: 'read'; data: Buffer; sha256: string; sessionId: string } | { state: 'lost' | 'unsafe' | 'invalid'; code: string };
type Opaque = { state: 'read'; data: Buffer; sha256: string } | { state: 'lost' | 'unsafe' | 'invalid'; code: string };
/**
 * Ticket 30: confined read of one file of the runtime tree under `root` (relative 6-part `ref`), with the same no-follow/private-path rules,
 * WITHOUT interpreting its content (an empty or non-session file is still read; size bound 64 MiB). Used to keep other agents' session files.
 */
export async function readConfinedFile(root: string, ref: string, options: { allowEmpty?: boolean } = {}): Promise<Opaque> {
  if (!isAbsolute(root) || ref.split('/').length !== 6 || ref.split('/').some(part => !part || part === '.' || part === '..'))
    return { state: 'unsafe', code: 'SESSION_REF_INVALID' };
  try {
    if ((await realpath(root)) !== root) return { state: 'unsafe', code: 'SESSION_ROOT_NOT_CANONICAL' };
  } catch {
    return { state: 'unsafe', code: 'SESSION_ROOT_UNAVAILABLE' };
  }
  const path = join(root, ref);
  let file;
  try {
    let directory = root;
    for (const part of ref.split('/').slice(0, -1)) {
      directory = join(directory, part);
      await privateDirectory(directory);
    }
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    return code === 'ENOENT' ? { state: 'lost', code: 'SESSION_FILE_MISSING' } : { state: 'unsafe', code: 'SESSION_PATH_UNSAFE' };
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o022) return { state: 'unsafe', code: 'SESSION_FILE_UNSAFE' };
    if ((info.size === 0 && !options.allowEmpty) || info.size > sessionFileLimits.maxBytes) return { state: 'invalid', code: 'SESSION_FILE_SIZE' };
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size || (await file.stat()).size !== info.size) return { state: 'invalid', code: 'SESSION_FILE_CHANGED' };
    return { state: 'read', data, sha256: createHash('sha256').update(data).digest('hex') };
  } catch {
    return { state: 'invalid', code: 'SESSION_FILE_UNREADABLE' };
  } finally {
    await file.close().catch(() => {});
  }
}
/** Reads one preserved session file under `root` (relative `ref`), confined as described above, and requires its Builder session header. */
export async function readSessionFile(root: string, ref: string): Promise<Read> {
  const read = await readConfinedFile(root, ref);
  if (read.state !== 'read') return read;
  const header = sessionHeader(read.data);
  if (!header) return { state: 'invalid', code: 'SESSION_HEADER_INVALID' };
  return { ...read, sessionId: header.id };
}

/** The JSONL v3 header of a Factory Builder session (`cwd` is the guest workspace), or null. */
export function sessionHeader(data: Buffer): { id: string } | null {
  const end = data.indexOf(0x0a);
  try {
    const value: unknown = JSON.parse(data.subarray(0, end < 0 ? data.length : end).toString('utf8'));
    const parsed = z
      .object({ type: z.literal('session'), version: z.literal(3), id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/), cwd: z.literal('/workspace') })
      .safeParse(value);
    return parsed.success ? { id: parsed.data.id } : null;
  } catch {
    return null;
  }
}

/** `ref` of a session file that must lie directly in `sessionsDirectory`, itself under `root`; null when it does not. */
export function sessionRefOf(root: string, sessionsDirectory: string, file: string): string | null {
  if (!isAbsolute(file) || dirname(file) !== sessionsDirectory || !fileName.test(basename(file))) return null;
  const ref = relative(root, file);
  return ref.startsWith('..') || isAbsolute(ref) || ref.split(sep).length !== 6 ? null : ref.split(sep).join('/');
}

/**
 * The Builder tool set a launch policy must produce (the same rule `worker-session` applies). The owner DERIVES it from the launch, so a
 * session profile never depends on the worker's own claim.
 */
export function launchToolNames(launch: {
  context: { role: string };
  skillPack?: string | undefined;
  copyOutput?: boolean | undefined;
  editSourceMaxBytes?: number | undefined;
  handoff: boolean;
}): string[] {
  return [
    'write',
    'bash',
    'ask_user',
    ...(launch.copyOutput === true || launch.skillPack !== undefined ? ['read'] : []),
    ...(launch.editSourceMaxBytes !== undefined ? ['edit'] : []),
    ...(launch.handoff ? ['handoff'] : []),
  ].sort();
}

/**
 * Owner side, after a Builder worker ended: the identity of the session it preserved, observed by the owner from its own sessions directory
 * (never the worker's claim alone). The profile is entirely the launch's (SDK profile, provider/model, pack and the tool set DERIVED from the
 * policy); the worker's reported set is only cross-checked, and a contradiction withholds the observation.
 */
export async function observePreservedSession(
  root: string,
  sessionsDirectory: string,
  file: unknown,
  toolsClaimed: unknown,
  launch: {
    context: { role: string };
    profile: { id: string; providerId: string; modelId: string };
    skillPack?: string | undefined;
    copyOutput?: boolean | undefined;
    editSourceMaxBytes?: number | undefined;
    handoff?: unknown;
  },
): Promise<HostSessionRef | undefined> {
  if (
    launch.context.role !== 'builder' ||
    typeof file !== 'string' ||
    !Array.isArray(toolsClaimed) ||
    toolsClaimed.length > 16 ||
    toolsClaimed.some(tool => typeof tool !== 'string' || !/^[a-z_]{1,32}$/.test(tool))
  )
    return undefined;
  const ref = sessionRefOf(root, sessionsDirectory, file);
  if (!ref) return undefined;
  const read = await readSessionFile(root, ref);
  if (read.state !== 'read') return undefined;
  // The tool set comes from the launch policy; a worker claim that contradicts it means the observation cannot be trusted.
  const tools = launchToolNames({ ...launch, context: launch.context, handoff: launch.handoff !== undefined });
  if (JSON.stringify([...new Set(toolsClaimed as string[])].sort()) !== JSON.stringify(tools)) return undefined;
  return sessionRefSchema.parse({
    ref,
    sessionId: read.sessionId,
    sha256: read.sha256,
    bytes: read.data.length,
    format: 'pi-session-jsonl-v3',
    profile: {
      sdkProfile: launch.profile.id,
      providerId: launch.profile.providerId,
      modelId: launch.profile.modelId,
      skillPack: launch.skillPack ?? null,
      tools,
    },
  });
}

/**
 * Owner side, before a continued Builder worker exists: re-read the preserved session (identity, hash and size must be exactly the observed
 * ones) and copy it exclusively into the new worker's private sessions directory. The original is never appended to or overwritten.
 */
export async function copyPreservedSession(
  root: string,
  sessionsDirectory: string,
  expected: { ref: string; sha256: string; sessionId: string; bytes: number },
) {
  const read = await readSessionFile(root, expected.ref);
  if (read.state !== 'read' || read.sha256 !== expected.sha256 || read.sessionId !== expected.sessionId || read.data.length !== expected.bytes)
    throw new Error('WORKER_SESSION_UNAVAILABLE');
  const copy = join(sessionsDirectory, expected.ref.split('/').at(-1)!);
  const handle = await open(copy, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(read.data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { file: copy, sha256: read.sha256, sessionId: read.sessionId };
}

/**
 * Acceptance finding A7: which invocation a worker directory `w-<id>` was created for. Only a worker that RETURNS reports its session
 * file (the owner then observes it); one whose boot was lost never does, and its session would be attributable to nobody. The owner
 * writes this record in the private worker directory before the worker process exists; it is written once and never replaced.
 */
const launchRecordName = 'launch.json';
const launchRecordSchema = z.strictObject({
  version: z.literal(1),
  workId: z.string().min(1).max(128),
  executionId: z.string().min(1).max(128),
  invocationId: z.string().min(1).max(128),
  role: z.enum(['builder', 'standards', 'spec']),
});
export type WorkerLaunchRecord = Omit<z.infer<typeof launchRecordSchema>, 'version'>;
export async function recordWorkerLaunch(directory: string, launch: WorkerLaunchRecord) {
  const data = JSON.stringify(
    launchRecordSchema.parse({ version: 1, workId: launch.workId, executionId: launch.executionId, invocationId: launch.invocationId, role: launch.role }),
  );
  const handle = await open(join(directory, launchRecordName), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Not a regular single-link file of this uid, not group/world-writable, of 1 to 4096 bytes. */
const unsafeLaunchRecord = (info: Stats) =>
  !info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || Boolean(info.mode & 0o022) || info.size === 0 || info.size > 4096;
/** The launch record of one worker directory, read no-follow (a private regular single-link file of this uid, bounded), or null. */
async function readWorkerLaunch(directory: string): Promise<WorkerLaunchRecord | null> {
  let file;
  try {
    await privateDirectory(directory);
    file = await open(join(directory, launchRecordName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await file.stat();
    if (unsafeLaunchRecord(info)) return null;
    const parsed = launchRecordSchema.safeParse(JSON.parse((await file.readFile()).toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => {});
  }
}
/** The launch record is the Builder launch of exactly this invocation. */
const builderLaunchOf = (launch: WorkerLaunchRecord | null, invocation: { workId: string; executionId: string; invocationId: string }) =>
  launch !== null &&
  launch.role === 'builder' &&
  launch.workId === invocation.workId &&
  launch.executionId === invocation.executionId &&
  launch.invocationId === invocation.invocationId;
/** The `ref` of every session file of one worker's sessions directory, in name order (an unreadable directory has none). */
async function sessionRefsIn(root: string, sessions: string): Promise<string[]> {
  const refs: string[] = [];
  for (const name of (await readdir(sessions).catch(() => [] as string[])).filter(file => fileName.test(file)).sort()) {
    const ref = sessionRefOf(root, sessions, join(sessions, name));
    if (ref) refs.push(ref);
  }
  return refs;
}
/**
 * The `ref` of the ONE session file a Builder invocation wrote in the runtime tree of its boot (`runtime`, under `root`), found by the
 * launch record of its worker directory. Never a guess: no record of that invocation, no session file or more than one names nothing.
 * `lost` = the runtime tree of the boot no longer exists.
 */
export async function sessionRefOfInvocation(
  root: string,
  runtime: string,
  invocation: { workId: string; executionId: string; invocationId: string },
): Promise<{ state: 'found'; ref: string } | { state: 'lost' | 'unavailable'; code: string }> {
  let workers: string[];
  try {
    workers = (await readdir(runtime)).filter(name => /^w-[A-Za-z0-9]{1,64}$/.test(name)).sort();
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { state: 'lost', code: 'SESSION_FILE_MISSING' }
      : { state: 'unavailable', code: 'SESSION_PATH_UNSAFE' };
  }
  const refs: string[] = [];
  for (const worker of workers) {
    const launch = await readWorkerLaunch(join(runtime, worker));
    if (!builderLaunchOf(launch, invocation)) continue;
    refs.push(...(await sessionRefsIn(root, join(runtime, worker, 'profile', 'sessions'))));
  }
  if (refs.length > 1) return { state: 'unavailable', code: 'SESSION_AMBIGUOUS' };
  return refs.length ? { state: 'found', ref: refs[0]! } : { state: 'unavailable', code: 'SESSION_NOT_RECORDED' };
}
