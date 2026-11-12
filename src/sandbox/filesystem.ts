import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, open, lstat, mkdir, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const native = { timeout: 30000, maxBuffer: 65536,
  env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } };

/** Geometry is a capacity check, never a substitute for a complete filesystem check. */
async function filesystemBytes(raw: string): Promise<bigint> {
  const file = await open(raw, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new Error('UNSAFE_FILESYSTEM_IMAGE');
    const header = Buffer.alloc(1024);
    const { bytesRead } = await file.read(header, 0, header.length, 1024);
    const log = header.readUInt32LE(0x18);
    if (bytesRead !== 1024 || header.readUInt16LE(0x38) !== 0xef53 || log > 2) throw new Error('UNSUPPORTED_FILESYSTEM');
    const high = (header.readUInt32LE(0x60) & 0x80) ? BigInt(header.readUInt32LE(0x150)) : 0n;
    return (BigInt(header.readUInt32LE(4)) + (high << 32n)) * (1024n << BigInt(log));
  } finally { await file.close(); }
}

/** New, private per-environment copy only. Never mutate the pinned template or repair preserved data. */
export async function growFilesystemCopy(source: string, raw: string, size: bigint): Promise<void> {
  await copyFile(source, raw, constants.COPYFILE_EXCL);
  const file = await open(raw, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || BigInt(info.size) > size) {
      throw new Error('INCOMPATIBLE_FILESYSTEM_COPY');
    }
    await file.chmod(0o600);
    await file.truncate(Number(size));
  } finally { await file.close(); }
  // No host mount, privileged helper, scripts or repair flags. Nonzero is a refusal.
  await run('/usr/bin/e2fsck', ['-f', '-n', raw], native);
  await run('/usr/bin/resize2fs', [raw], native);
  await checkFilesystem(raw, size);
}

export async function checkFilesystem(raw: string, size: bigint): Promise<void> {
  await run('/usr/bin/e2fsck', ['-f', '-n', raw], native);
  if (await filesystemBytes(raw) !== size) throw new Error('FILESYSTEM_CAPACITY_MISMATCH');
}

/** Call only while holding the environment lifecycle lock, after any prior boot ceased. */
export async function checkDiskFilesystem(directory: string, disk: string, size: bigint): Promise<boolean> {
  try {
    const before = await lstat(disk, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o077n)) return false;
    const info = JSON.parse((await run('/usr/bin/qemu-img', ['info', '-f', 'qcow2', '--output=json', disk], native)).stdout);
    if (info.format !== 'qcow2' || info['backing-filename'] || info['format-specific']?.data?.['data-file'] ||
        BigInt(info['virtual-size']) !== size) return false;
    await run('/usr/bin/qemu-img', ['check', '-f', 'qcow2', disk], native);
    const snapshot = join(directory, `filesystem-check-${randomUUID()}`);
    await mkdir(snapshot, { mode: 0o700 });
    const raw = join(snapshot, 'snapshot.ext4');
    await run('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', disk, raw], native);
    // The parser never mounts/repairs the preserved disk; it checks a private copy.
    const file = await open(raw, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { await file.chmod(0o600); } finally { await file.close(); }
    await checkFilesystem(raw, size);
    const after = await lstat(disk, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'] as const) {
      if (after[key] !== before[key]) return false;
    }
    await unlink(raw);
    await rmdir(snapshot);
    return true;
  } catch { return false; } // Keep failed snapshots, never auto-repair or launch.
}
