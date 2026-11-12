import { constants, type BigIntStats } from 'node:fs';
import { open, opendir, lstat, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectStorage } from '../platform/host/index.js';
import { ownedEnvironment } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';

type Measured<T> = ({ status: 'observed' } & T) | { status: 'unavailable' } | { status: 'absent' };
export type StorageObservation = {
  configuredVirtualBytes: string; minFreeBytes: string;
  disk: Measured<{ virtualBytes: string; allocatedBytes: string }>;
  workspace: Measured<{ logicalBytes: string; allocatedBytes: string }>;
  artifacts: Measured<{ logicalBytes: string; allocatedBytes: string }>;
  filesystem: Measured<{ availableBytes: string }>;
};
const unavailable = { status: 'unavailable' } as const;
const nofollow = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const missing = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT';
async function measured<T>(fn: () => Promise<T>, removed: boolean, target?: string): Promise<Measured<T>> {
  try { return { status: 'observed', ...await fn() }; }
  catch (e) {
    // A disappearing child or unavailable /proc hierarchy is not an absent tree.
    if (removed && target && missing(e)) {
      try { await lstat(target); } catch (rootError) { if (missing(rootError)) return { status: 'absent' }; }
    }
    return unavailable;
  }
}

async function diskUsage(path: string) {
  const file = await open(path, nofollow);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) ||
        (before.mode & 0o077n)) throw new Error('UNSAFE_DISK_METRIC');
    const header = Buffer.alloc(32);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 32 || header.readUInt32BE(0) !== 0x514649fb || ![2, 3].includes(header.readUInt32BE(4))) {
      throw new Error('UNAVAILABLE_DISK_METRIC');
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid ||
        after.nlink !== 1n || after.mode !== before.mode || named.dev !== after.dev || named.ino !== after.ino ||
        !named.isFile()) throw new Error('CHANGED_DISK_METRIC');
    // Header capacity is not the qcow file length. Allocation is a per-file
    // st_blocks observation, NOT exclusive/reclaimable space on CoW filesystems.
    return { virtualBytes: header.readBigUInt64BE(24).toString(), allocatedBytes: (after.blocks * 512n).toString() };
  } finally { await file.close(); }
}

function stableDirectory(a: BigIntStats, b: BigIntStats) {
  return ['dev', 'ino', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'].every(k =>
    a[k as keyof BigIntStats] === b[k as keyof BigIntStats]);
}
async function treeUsage(path: string) {
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  for (const line of mounts.split('\n')) {
    const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
    if (mount === path || mount?.startsWith(`${path}/`)) throw new Error('MOUNTED_USAGE_UNAVAILABLE');
  }
  const root = await open(path, nofollow | constants.O_DIRECTORY);
  const seen = new Set<string>();
  let entries = 0, logical = 0n, allocated = 0n;
  const deadline = Date.now() + 250;
  let rootInfo: BigIntStats;
  try { rootInfo = await root.stat({ bigint: true }); }
  catch (e) { await root.close(); throw e; }
  const own = (s: BigIntStats) => {
    if (s.uid !== BigInt(process.getuid!()) || s.dev !== rootInfo.dev) throw new Error('FOREIGN_USAGE_UNAVAILABLE');
    const key = `${s.dev}:${s.ino}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  };
  const walk = async (fd: FileHandle, depth: number): Promise<void> => {
    if (depth > 32 || Date.now() > deadline) throw new Error('USAGE_BUDGET_EXCEEDED');
    const before = await fd.stat({ bigint: true });
    if (!before.isDirectory() || !own(before)) return;
    allocated += before.blocks * 512n;
    // Enumerate a pinned directory FD; every child directory is opened NOFOLLOW
    // relative to that FD. Guest rename/symlink races cannot redirect the walk
    // through an untrusted pathname ancestor into host/control/another Work.
    const dir = await opendir(`/proc/self/fd/${fd.fd}`);
    for await (const entry of dir) {
      if (++entries > 10000 || Date.now() > deadline) throw new Error('USAGE_BUDGET_EXCEEDED');
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('/')) throw new Error('INVALID_USAGE_ENTRY');
      const child = `/proc/self/fd/${fd.fd}/${entry.name}`;
      const info = await lstat(child, { bigint: true });
      if (info.isSymbolicLink()) { // Count only this inode's allocation, never its target.
        if (own(info)) allocated += info.blocks * 512n;
        continue;
      }
      if (info.isDirectory()) {
        const next = await open(child, nofollow | constants.O_DIRECTORY);
        try {
          const current = await next.stat({ bigint: true });
          if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('CHANGED_USAGE_DIRECTORY');
          await walk(next, depth + 1);
        } finally { await next.close(); }
      } else if (info.isFile()) {
        if (own(info)) { logical += info.size; allocated += info.blocks * 512n; }
      } else throw new Error('SPECIAL_USAGE_UNAVAILABLE');
    }
    if (!stableDirectory(before, await fd.stat({ bigint: true }))) throw new Error('CHANGED_USAGE_DIRECTORY');
  };
  try {
    await walk(root, 0);
    const named = await lstat(path, { bigint: true });
    if (!named.isDirectory() || named.dev !== rootInfo.dev || named.ino !== rootInfo.ino) throw new Error('CHANGED_USAGE_ROOT');
    return { logicalBytes: logical.toString(), allocatedBytes: allocated.toString() };
  }
  finally { await root.close(); }
}

/** Public observation only, never a prerequisite/authority for lifecycle effects.
 * Complete bounded samples or explicit unavailable; not quotas or atomic snapshots.
 * Unique regular-file inode sizes; directory/symlink inode allocation included,
 * symlink target data excluded.
 */
export async function observeStorage(root: string, environment: EnvironmentRef, removed: boolean): Promise<StorageObservation | undefined> {
  try {
    const { directory, owner } = await ownedEnvironment(root, environment);
    const [disk, workspace, artifacts, filesystem] = await Promise.all([
      measured(() => diskUsage(join(directory, 'root.qcow2')), removed, join(directory, 'root.qcow2')),
      measured(() => treeUsage(join(directory, 'workspace')), removed, join(directory, 'workspace')),
      measured(() => treeUsage(join(directory, 'artifacts')), removed, join(directory, 'artifacts')),
      measured(async () => {
        const storage = await inspectStorage(directory);
        if (!storage || storage.unsuitable) throw new Error('STORAGE_UNAVAILABLE');
        return { availableBytes: storage.availableBytes };
      }, false),
    ]);
    return { configuredVirtualBytes: (BigInt(owner.configuration.diskGiB) * 1073741824n).toString(),
      minFreeBytes: (BigInt(owner.configuration.minFreeSpaceGiB) * 1073741824n).toString(), disk, workspace, artifacts, filesystem };
  } catch { return undefined; }
}
