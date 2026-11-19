import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectStorage } from '../platform/host/index.js';
import { inspectGuestAssets, type GuestAssetPin } from './guest-assets.js';
import { configurationSchema, environmentIdentityChanges, type SandboxConfiguration } from './configuration.js';
import { buildRootDisk } from './filesystem.js';
import { cleanupRequested } from './cleanup-records.js';

export type EnvironmentRef = string & { readonly environmentRef: unique symbol };
export type PrepareResult = { status: 'success'; environment: EnvironmentRef } |
  /** `detail` (ticket 50): what the operator must see to decide (e.g. the changed environment identity fields, the divergent seed file). */
  { status: 'failure' | 'indeterminate'; code: string; detail?: string };

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('PRIVATE_ENVIRONMENT_DIRECTORY_REQUIRED');
  }
}

async function durableJson(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}

async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Adapter-owned resource metadata, not a second authority for Work/Execution state. */
export async function prepareEnvironment(root: string, pin: GuestAssetPin | undefined,
  workId: string, configuration: SandboxConfiguration): Promise<PrepareResult> {
  if (typeof workId !== 'string' || !workId || workId.length > 512) return { status: 'failure', code: 'WORK_ID_INVALID' };
  const checks = await inspectGuestAssets(pin);
  if (!pin || checks.some(check => check.status !== 'ok')) return { status: 'failure', code: 'GUEST_ASSETS_INVALID' };
  const canonicalRoot = await realpath(root);
  const environments = join(canonicalRoot, 'environments');
  await mkdir(environments, { recursive: true, mode: 0o700 });
  await privateDirectory(environments);
  const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
  const directory = join(environments, environment);
  const identity = { version: 1, workId, environment, configuration, guestAssets: pin };
  const existing = async (): Promise<PrepareResult> => {
    await privateDirectory(directory);
    if (await cleanupRequested(directory)) return { status: 'failure', code: 'ENVIRONMENT_CLEANUP_PENDING' };
    try {
      const previous = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
      const recorded = configurationSchema.safeParse(previous?.configuration);
      if (previous?.version !== 1 || previous.workId !== workId || previous.environment !== environment || !recorded.success ||
          typeof previous.guestAssets?.directory !== 'string' || typeof previous.guestAssets?.manifestSha256 !== 'string') {
        return { status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH', detail: 'environment owner record does not match this Work' };
      }
      // Ticket 50: only the disk/profile identity (profile, disk size, guest assets) binds a prepared environment; guest memory/vCPU and host
      // admission settings come from the current configuration at each boot.
      const changes = environmentIdentityChanges({ configuration: recorded.data, guestAssets: previous.guestAssets }, { configuration, guestAssets: pin });
      if (changes.length) return { status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH', detail: changes.join('; ') };
      const ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
      if (ready.environment !== environment) return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE' };
      const disk = await lstat(join(directory, 'root.qcow2'));
      if (!disk.isFile() || disk.nlink !== 1 || disk.uid !== process.getuid?.() || (disk.mode & 0o077) !== 0) {
        return { status: 'indeterminate', code: 'ENVIRONMENT_DISK_UNSAFE' };
      }
      await privateDirectory(join(directory, 'workspace'));
      await privateDirectory(join(directory, 'artifacts'));
      return { status: 'success', environment };
    } catch { return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE' }; }
  };
  // Reuse needs no new allocation. Never turn an incomplete existing preparation
  // into permission to retry native effects, even after pressure recovers.
  try { await lstat(directory); return existing(); }
  catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e; }
  const manifest = JSON.parse(await readFile(join(pin.directory, 'manifest.json'), 'utf8'));
  const source = join(pin.directory, manifest.assets.rootfs);
  const sourceInfo = await lstat(source);
  const size = BigInt(configuration.diskGiB) * 1073741824n;
  if (BigInt(sourceInfo.size) > size) return { status: 'failure', code: 'BASE_DISK_EXCEEDS_CONFIGURED_CAPACITY' };
  const storage = await inspectStorage(environments);
  // Conservative space for the raw candidate and standalone conversion, not a quota.
  const required = 2n * size + BigInt(configuration.minFreeSpaceGiB) * 1073741824n;
  if (!storage || storage.unsuitable || BigInt(storage.availableBytes) < required) {
    return { status: 'failure', code: 'INSUFFICIENT_STORAGE_FOR_PREPARATION' };
  }
  // Known admission refusals above create no per-Work intent to strand. Atomic
  // mkdir still selects one initializer if another caller raced admission.
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    return existing();
  }
  // Identity remains durable before every native disk effect. Admission is only
  // a point-in-time check; later I/O failures stay incomplete, never auto-repaired.
  await durableJson(join(directory, 'owner.json'), identity);
  await syncDirectory(directory);
  await syncDirectory(environments);
  try {
    await mkdir(join(directory, 'workspace'), { mode: 0o700 });
    await mkdir(join(directory, 'artifacts'), { mode: 0o700 });
    // Only the successful new intermediate is disposable; failed preparations
    // retain their candidate and are never adopted/retried automatically.
    try { await buildRootDisk(source, join(directory, 'rootfs-preparing.ext4'), join(directory, 'root.qcow2'), size); }
    catch (error) {
      if (error instanceof Error && error.message === 'BASE_DISK_EXCEEDS_CONFIGURED_CAPACITY') return { status: 'failure', code: 'BASE_DISK_EXCEEDS_CONFIGURED_CAPACITY' };
      throw error;
    }
    await durableJson(join(directory, 'ready.json'), { environment });
    await syncDirectory(directory);
    return { status: 'success', environment };
  } catch {
    return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE' };
  }
}
