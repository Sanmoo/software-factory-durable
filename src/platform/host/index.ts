import { access, constants, statfs, lstat, realpath, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function controllerPaths(root: string) {
  const canonicalRoot = await realpath(root);
  for (const directory of ['data', 'run', 'environments']) {
    const info = await lstat(join(canonicalRoot, directory));
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error('PRIVATE_INSTALLATION_REQUIRED');
    }
  }
  const storagePath = join(canonicalRoot, 'data', 'control.sqlite');
  const lockPath = join(canonicalRoot, 'data', 'control.lock');
  for (const path of [storagePath, lockPath]) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new Error('UNSAFE_CONTROL_PATH');
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
  const locks = await readFile('/proc/locks', 'utf8');
  const owns = locks.split('\n').some(line => {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE' || fields[4] !== String(process.pid)) return false;
    const [majorHex, minorHex, inode] = fields[5]?.split(':') ?? [];
    if (!majorHex || !minorHex || inode !== String(lock.ino)) return false;
    const major = BigInt(`0x${majorHex}`), minor = BigInt(`0x${minorHex}`);
    const device = (minor & 0xffn) | ((major & 0xfffn) << 8n) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);
    return device === lock.dev;
  });
  if (!owns) throw new Error('CONTROLLER_LOCK_REQUIRED');
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
