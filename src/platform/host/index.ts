export { workerBootstrapSchema, workerLaunchSchema, type WorkerLaunch } from './worker-bootstrap.js';
// Private composition on an existing fixed child channel; no public tool/reader.
export { createSecretPublisher, createOwnerSecretReceiver, deliverSchema } from './worker-secret-ipc.js';
// Same fixed child channel: one ask_user notification per Builder activation and its Control ACK.
// Ticket 11: confined Host reads of preserved Builder sessions (runtime tree, never guest paths).
export { copyPreservedSession, launchToolNames, observePreservedSession, readSessionFile, sessionRefSchema, sessionFileLimits, type HostSessionRef } from './worker-session-file.js';
export { createQuestionSender, serveQuestionRelay, workerQuestionSchema, type WorkerQuestionRequest, type QuestionRelayAck } from './worker-question-ipc.js';
import { access, constants, statfs, stat, lstat, realpath, open, readdir, readFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
export { planWorkerLaunch, launchWorker, prepareReviewerContinuation, workerOwnerEndpoint, workerRuntimeDirectory, unitState, type WorkerBootHost } from './worker-launch.js';

/** A refused installation path, with the relative path that caused it (diagnosable; never repaired). */
export class InstallationPathError extends Error {
  constructor(readonly code: 'PRIVATE_INSTALLATION_REQUIRED' | 'UNSAFE_CONTROL_PATH', readonly path: string) { super(code); }
}
/** Stable cause of a start refusal for operator diagnostics: an upper-case code from this codebase, and the relative path when known. */
export function startFailureCause(error: unknown): { cause: string; path?: string } {
  const message = error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message) ? error.message
    : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code) ? `FS_${error.code}` : 'UNEXPECTED';
  return { cause: message, ...(error instanceof InstallationPathError ? { path: error.path } : {}) };
}
export async function controllerPaths(root: string) {
  const canonicalRoot = await realpath(root);
  for (const directory of ['data', 'run', 'environments']) {
    const info = await lstat(join(canonicalRoot, directory));
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new InstallationPathError('PRIVATE_INSTALLATION_REQUIRED', directory);
    }
  }
  const storagePath = join(canonicalRoot, 'data', 'control.sqlite');
  const lockPath = join(canonicalRoot, 'data', 'control.lock');
  for (const path of [storagePath, lockPath]) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new InstallationPathError('UNSAFE_CONTROL_PATH', path === lockPath ? 'data/control.lock' : 'data/control.sqlite');
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return { root: canonicalRoot, storagePath, lockPath, endpoint: join(canonicalRoot, 'run', 'control.sock') };
}

export async function prepareControllerLock(lockPath: string): Promise<void> {
  const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  await file.close();
}

/** Linux proof that this very process, after flock's no-fork exec, owns the stable lock. */
export async function verifyControllerLock(lockPath: string): Promise<void> {
  const lock = await lstat(lockPath, { bigint: true });
  const sameFile = (s: BigIntStats) => s.isFile() && s.dev === lock.dev && s.ino === lock.ino &&
    s.nlink === 1n && s.uid === BigInt(process.getuid?.() ?? -1) && !(s.mode & 0o077n);
  if (!sameFile(lock)) throw new Error('CONTROLLER_LOCK_REQUIRED');
  // Btrfs st_dev is per-subvolume and may differ from the superblock device in
  // /proc/locks. Correlate the lock-bearing inherited FD with the canonical file
  // via stat in the SAME namespace, not by dropping the device/identity check.
  // stat(fdpath) does not open/close/duplicate the inherited lock descriptor.
  for (const fd of await readdir('/proc/self/fd')) {
    if (!/^[0-9]+$/.test(fd)) continue;
    const path = `/proc/self/fd/${fd}`;
    try {
      if (!sameFile(await stat(path, { bigint: true }))) continue;
      const info = await readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
      if (info.match(/^ino:\s+([0-9]+)$/m)?.[1] !== String(lock.ino)) continue;
      const owns = info.split('\n').some(line => {
        if (!line.startsWith('lock:')) return false;
        const fields = line.slice(5).trim().split(/\s+/);
        return fields[1] === 'FLOCK' && fields[2] === 'ADVISORY' && fields[3] === 'WRITE' &&
          fields[4] === String(process.pid) && fields[5]?.split(':')[2] === String(lock.ino) &&
          fields[6] === '0' && fields[7] === 'EOF';
      });
      if (owns && sameFile(await stat(path, { bigint: true })) && sameFile(await lstat(lockPath, { bigint: true }))) return;
    } catch { /* Closed/reused/inaccessible FD is not ownership evidence. */ }
  }
  throw new Error('CONTROLLER_LOCK_REQUIRED');
}

export async function controllerRuntimeInventory(root: string): Promise<'empty' | 'unknown'> {
  // No environment/worker layout exists in this increment. Never treat pre-existing resources as reconciled.
  const environments = await readdir(join(root, 'environments'));
  const runtime = await readdir(join(root, 'run'));
  return environments.length === 0 && runtime.every(name => name === 'control.sock') ? 'empty' : 'unknown';
}

export async function canAccess(path: string, mode = constants.R_OK): Promise<boolean> {
  try { await access(path, mode); return true; } catch { return false; }
}

export function versionOf(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.status !== 0 || result.error) return undefined;
  // Never return arbitrary command output or the inherited environment.
  return result.stdout.split('\n')[0]?.match(/\b\d+(?:\.\d+)*(?:[-+][\w.-]+)?\b/)?.[0];
}

export async function inspectStorage(path: string) {
  try {
    const fs = await statfs(path, { bigint: true });
    return { type: `0x${fs.type.toString(16)}`, availableBytes: (fs.bavail * fs.bsize).toString(),
      // Known remote/ephemeral filesystems cannot satisfy the persistent local storage contract.
      unsuitable: [0x6969n, 0xff534d42n, 0x01021994n, 0x858458f6n].includes(fs.type) };
  } catch { return undefined; }
}
