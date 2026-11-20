import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, open, lstat, mkdir, rename, unlink, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const native = { timeout: 30000, maxBuffer: 65536,
  env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } };

/** Ticket 47: native remedies on a whole disk image outlast the bounded checks (minutes for a large Gradle/Docker disk). */
const remedy = { ...native, timeout: 1_800_000, maxBuffer: 4 * 1024 * 1024 };

/** The ext4 superblock of an own, private image (never followed, aliased or foreign). */
async function superblock(raw: string): Promise<Buffer> {
  const file = await open(raw, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new Error('UNSAFE_FILESYSTEM_IMAGE');
    const header = Buffer.alloc(1024);
    const { bytesRead } = await file.read(header, 0, header.length, 1024);
    if (bytesRead !== 1024 || header.readUInt16LE(0x38) !== 0xef53 || header.readUInt32LE(0x18) > 2) throw new Error('UNSUPPORTED_FILESYSTEM');
    return header;
  } finally { await file.close(); }
}

/** Geometry is a capacity check, never a substitute for a complete filesystem check. */
async function filesystemBytes(raw: string): Promise<bigint> {
  const header = await superblock(raw);
  const high = (header.readUInt32LE(0x60) & 0x80) ? BigInt(header.readUInt32LE(0x150)) : 0n;
  return (BigInt(header.readUInt32LE(4)) + (high << 32n)) * (1024n << BigInt(header.readUInt32LE(0x18)));
}

/** Ticket 47: journal facts of an ext4 image (`has_journal` compat 0x4; `needs_recovery` incompat 0x4: a journal not yet replayed). */
export async function journalState(raw: string): Promise<{ journal: boolean; needsRecovery: boolean }> {
  const header = await superblock(raw);
  return { journal: (header.readUInt32LE(0x5c) & 0x4) !== 0, needsRecovery: (header.readUInt32LE(0x60) & 0x4) !== 0 };
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
    // Ticket 47: a journaled root stopped abruptly is consistent only after its journal is replayed (as the guest kernel does at mount).
    // The replay touches THIS private copy only; a read-only check of the unreplayed image would refuse a healthy disk.
    // Exit 1 only says the copy was modified (the replay itself); the full read-only check below decides.
    if ((await journalState(raw)).needsRecovery) {
      await run('/usr/bin/e2fsck', ['-E', 'journal_only', '-p', raw], native).catch((error: { code?: unknown }) => { if (error.code !== 1) throw error; });
    }
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

/** Ticket 47: the result of an operator disk remedy. `refused` leaves the preserved disk exactly as it was (detail says why). */
export type DiskRemedyOutcome = { status: 'applied' | 'refused'; detail: string };
const stampOf = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
const identityKeys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'] as const;

/** The own, private qcow2 root disk of `size` (no backing/data file), with its identity to prove it did not change meanwhile. */
async function ownDisk(disk: string, size: bigint) {
  const info = await lstat(disk, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.uid !== BigInt(process.getuid?.() ?? -1) || (info.mode & 0o077n)) {
    throw new Error('UNSAFE_ROOT_DISK');
  }
  const facts = JSON.parse((await run('/usr/bin/qemu-img', ['info', '-f', 'qcow2', '--output=json', disk], native)).stdout);
  if (facts.format !== 'qcow2' || facts['backing-filename'] || facts['format-specific']?.data?.['data-file'] || BigInt(facts['virtual-size']) !== size) {
    throw new Error('ROOT_DISK_GEOMETRY_MISMATCH');
  }
  return info;
}

async function privateFile(path: string) {
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
}

async function syncPath(path: string) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Publishes `candidate` as the root disk; the current one (if any) is set aside under `kept`, never deleted. */
async function swapDisk(directory: string, disk: string, candidate: string, kept: string, before: Awaited<ReturnType<typeof ownDisk>> | null) {
  if (before) {
    const after = await lstat(disk, { bigint: true });
    for (const key of identityKeys) if (after[key] !== before[key]) throw new Error('ROOT_DISK_CHANGED_DURING_REMEDY');
    await lstat(kept).then(() => { throw new Error('KEPT_DISK_NAME_TAKEN'); }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rename(disk, kept);
  }
  await rename(candidate, disk);
  await syncPath(directory);
}

/**
 * Ticket 47 (`--remedy repair-disk`, operator decision; call only under the environment lifecycle lock after the previous boot's cessation
 * was confirmed): `e2fsck -f -p` (preen: only the repairs e2fsck itself classifies as safe; it refuses, exit 4, whatever needs a human
 * answer) on a raw copy of the preserved disk, a full read-only re-check, then the repaired copy becomes the root disk. The original disk
 * is never modified: it is kept as `root.qcow2.damaged-<stamp>`. The e2fsck output is kept in `disk-repair-<stamp>/e2fsck-p.log`.
 */
export async function repairPreservedDisk(directory: string, disk: string, size: bigint, now = new Date()): Promise<DiskRemedyOutcome> {
  const stamp = stampOf(now);
  const work = join(directory, `disk-repair-${stamp}`);
  const raw = join(work, 'repair.ext4');
  try {
    const before = await ownDisk(disk, size);
    await run('/usr/bin/qemu-img', ['check', '-f', 'qcow2', disk], native);
    await mkdir(work, { mode: 0o700 });
    await run('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', disk, raw], remedy);
    await privateFile(raw);
    let exit = 0;
    let output = '';
    try { output = (await run('/usr/bin/e2fsck', ['-f', '-p', raw], remedy)).stdout; }
    catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown };
      exit = typeof failure.code === 'number' ? failure.code : 8;
      output = typeof failure.stdout === 'string' ? failure.stdout : '';
    }
    await writeFile(join(work, 'e2fsck-p.log'), output.slice(0, 1024 * 1024), { mode: 0o600, flag: 'wx' });
    // 1/2: errors corrected. 4: preen refused (needs a human answer). 8+: operational failure. Nothing is applied unless corrected or clean.
    if (exit > 2) {
      await unlink(raw);
      return { status: 'refused', detail: `e2fsck -p exit ${exit} (${exit === 4 ? 'needs a manual check' : 'operational error'}); the preserved disk is unchanged; see ${basename(work)}/e2fsck-p.log or use --remedy replace-disk` };
    }
    await checkFilesystem(raw, size);
    const candidate = join(work, 'root.qcow2');
    await run('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', raw, candidate], remedy);
    await privateFile(candidate);
    await unlink(raw);
    const kept = `root.qcow2.damaged-${stamp}`;
    await swapDisk(directory, disk, candidate, join(directory, kept), before);
    return { status: 'applied', detail: `e2fsck -p exit ${exit}; original kept as ${kept}` };
  } catch (error) {
    await unlink(raw).catch(() => {});
    return { status: 'refused', detail: `repair not applied (${error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'native step failed'}); the preserved disk is unchanged` };
  }
}

/**
 * Ticket 47 (`--remedy replace-disk`, operator decision; same preconditions as the repair): a NEW root disk for the same environment, built
 * from the pinned template exactly as a preparation builds it. /workspace and /artifacts are host directories of the environment (shared
 * into the guest), not part of the root disk, so they are kept as they are; what lived only on the root (JDK, caches, Docker images) is lost.
 * The discarded disk is kept as `root.qcow2.replaced-<stamp>`.
 */
export async function replacePreservedDisk(directory: string, disk: string, template: string | { base: string }, size: bigint, now = new Date()): Promise<DiskRemedyOutcome> {
  const stamp = stampOf(now);
  const work = join(directory, `disk-replace-${stamp}`);
  const raw = join(work, 'rootfs.ext4');
  try {
    let before: Awaited<ReturnType<typeof ownDisk>> | null = null;
    try { before = await lstat(disk, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (before && (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1))) throw new Error('UNSAFE_ROOT_DISK');
    await mkdir(work, { mode: 0o700 });
    const candidate = join(work, 'root.qcow2');
    // Ticket 44: an environment created from a prepared environment base is replaced by a new copy of THAT base (same declared stack).
    if (typeof template === 'string') await buildRootDisk(template, raw, candidate, size);
    else await copyBaseDisk(template.base, candidate, size);
    const kept = `root.qcow2.replaced-${stamp}`;
    await swapDisk(directory, disk, candidate, join(directory, kept), before);
    const from = typeof template === 'string' ? 'the pinned template' : 'the environment base it was created from';
    return { status: 'applied', detail: before ? `new root disk from ${from}; /workspace and /artifacts kept; discarded disk kept as ${kept}`
      : `new root disk from ${from} (no disk was present); /workspace and /artifacts kept` };
  } catch (error) {
    await unlink(raw).catch(() => {});
    return { status: 'refused', detail: `replacement not applied (${error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'native step failed'}); the preserved disk is unchanged` };
  }
}

/** A standalone qcow2 root disk of `size` from the pinned ext4 template (shared by preparation and the replace remedy). */
export async function buildRootDisk(template: string, raw: string, disk: string, size: bigint): Promise<void> {
  await growFilesystemCopy(template, raw, size);
  // Standalone copy: no temporary overlay, backing file or deletion-on-close dependency.
  await run('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', raw, disk], native);
  const info = JSON.parse((await run('/usr/bin/qemu-img', ['info', '-f', 'qcow2', '--output=json', disk], native)).stdout);
  if (BigInt(info['virtual-size']) > size) throw new Error('BASE_DISK_EXCEEDS_CONFIGURED_CAPACITY');
  await run('/usr/bin/qemu-img', ['resize', '-f', 'qcow2', disk, size.toString()], native);
  const file = await open(disk, 'r+');
  try { await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
  // Only the successful new intermediate is disposable.
  await unlink(raw);
}

/**
 * Ticket 44: a Work's own standalone qcow2 root disk of `size` copied from a prepared environment base disk (no backing file, overlay or
 * data file: the base can be kept, checked or set aside without touching the environments created from it). The base is only read.
 */
export async function copyBaseDisk(base: string, disk: string, size: bigint): Promise<void> {
  const source = await lstat(base);
  if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1 || source.uid !== process.getuid?.() || (source.mode & 0o077)) throw new Error('UNSAFE_ENVIRONMENT_BASE');
  const facts = JSON.parse((await run('/usr/bin/qemu-img', ['info', '-f', 'qcow2', '--output=json', base], native)).stdout);
  if (facts.format !== 'qcow2' || facts['backing-filename'] || facts['format-specific']?.data?.['data-file'] || BigInt(facts['virtual-size']) !== size) {
    throw new Error('ENVIRONMENT_BASE_GEOMETRY_MISMATCH');
  }
  await run('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'qcow2', base, disk], remedy);
  const copied = JSON.parse((await run('/usr/bin/qemu-img', ['info', '-f', 'qcow2', '--output=json', disk], native)).stdout);
  if (copied.format !== 'qcow2' || copied['backing-filename'] || BigInt(copied['virtual-size']) !== size) throw new Error('ENVIRONMENT_DISK_GEOMETRY_MISMATCH');
  const file = await open(disk, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
}
