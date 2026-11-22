import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { workerRuntimeDirectory, inspectStorage, inspectMemory } from '../platform/host/index.js';
import { bootMemoryAllows } from './capacity.js';
import { inspectGuestAssets, type GuestAssetPin } from './guest-assets.js';
import { environmentIdentityChanges, type SandboxConfiguration } from './configuration.js';
import type { EnvironmentRef } from './prepare.js';
import { checkDiskFilesystem, repairPreservedDisk, replacePreservedDisk } from './filesystem.js';
import { readGuestStop, type GuestStop } from './guest-shutdown.js';
import { cleanupRequested } from './cleanup-records.js';
import {
  currentSchema,
  identitySchema,
  metadata,
  observeEnvironment,
  ownedEnvironment,
  privateDirectory,
  startupFailureSchema,
  supervisionHierarchy,
  type BootRef,
  type StartupFailure,
} from './lifecycle.js';

export type StartResult =
  | {
      status: 'success';
      boot: BootRef;
      /** Ticket 47: how the environment's previous boot was stopped (clean = its root was left read-only; forced otherwise), recorded with this boot. */
      previousStop?: GuestStop & { boot: BootRef };
      /** Ticket 47: the operator's disk remedy requested with this start and what it did. */
      remedy?: StartRemedyOutcome;
      /** v2 ticket 06: Factory material the adapter wrote into the guest of THIS boot (an adapter without a persistent disk seeds every boot). */
      seeds?: { name: string; manifestSha256: string; reused: boolean }[];
      /**
       * v2 ticket 08 (Operator decision 3D): what an adapter without a persistent disk re-sent into `/artifacts` of THIS boot from the
       * collection of an earlier one: the `spec/<version>` and `instructions/<version>` directories written (`from` = the boot that collected
       * them, null = nothing to send), and the earlier boots that ended before their collection (`lost`: the versions they wrote are gone).
       * Absent on the first boot of an environment and on adapters that keep the disk.
       */
      artifacts?: { restored: string[]; from: BootRef | null; lost: BootRef[] };
    }
  /** `detail` (ticket 50): what the operator must see to decide (e.g. the changed environment identity fields). */
  | { status: 'failure' | 'indeterminate'; code: string; boot?: BootRef; failure?: StartupFailure; detail?: string };
const run = promisify(execFile);
/** Ticket 47: explicit operator remedies for a preserved disk that fails its check (`START_PRESERVED_DISK_CHECK_REQUIRED`). */
export type DiskRemedy = 'repair-disk' | 'replace-disk';
export type StartRemedyOutcome = { remedy: DiskRemedy; outcome: 'applied' | 'not-needed'; detail: string };

async function workAreasUnsafe(directory: string) {
  try {
    for (const name of ['workspace', 'artifacts']) await privateDirectory(join(directory, name));
    return false;
  } catch {
    return true;
  }
}

/** The pinned ext4 template (already verified against the pin by the caller). */
async function templateOf(pin: GuestAssetPin) {
  const manifest = JSON.parse(await readFile(join(pin.directory, 'manifest.json'), 'utf8')) as { assets: { rootfs: string } };
  return join(pin.directory, manifest.assets.rootfs);
}

/** Fixed SDK 0.14 socket composition; no caller-provided mounts or free flags. */
export function bootRuntimePaths(root: string, boot: BootRef) {
  identitySchema.shape.boot.parse(boot);
  // Lossless UUID encoding: a short private directory for this boot, never shared.
  const directory = workerRuntimeDirectory(root, boot);
  const sockets = {
    virtioSocketPath: join(directory, 'v'),
    virtioFsSocketPath: join(directory, 'f'),
    virtioSshSocketPath: join(directory, 'h'),
    virtioIngressSocketPath: join(directory, 'i'),
    netSocketPath: join(directory, 'n'),
  };
  const sessions = join(directory, 's');
  const sessionSocket = join(sessions, '00000000-0000-4000-8000-000000000000.sock');
  if ([...Object.values(sockets), sessionSocket].some(path => Buffer.byteLength(path) > 107)) {
    throw new Error('SANDBOX_RUNTIME_PATH_TOO_LONG');
  }
  return { directory, sockets, sessions, temporary: join(directory, 't'), cache: join(directory, 'c') };
}

export async function durableJson(path: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 65536) throw new Error('RESOURCE_RECORD_TOO_LARGE');
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function failedStart(status: 'failure' | 'indeterminate', code: string, boot: BootRef, path: string, detail?: string): Promise<StartResult> {
  let failure: StartupFailure | undefined;
  try {
    const record = await metadata(join(path, 'failure.json'), startupFailureSchema);
    if (record.boot === boot) failure = { phase: record.phase, code: record.code };
  } catch {
    /* Missing, unsafe or uncorrelated evidence is not a diagnosis. */
  }
  return { status, code, boot, ...(failure ? { failure } : {}), ...(detail ? { detail: detail.slice(0, 512) } : {}) };
}

/** A new boot requires prior cessation and a read-only full filesystem check. */
export async function startEnvironment(
  root: string,
  pin: GuestAssetPin | undefined,
  environment: EnvironmentRef,
  configuration: SandboxConfiguration,
  /** Ticket 24: free-memory admission of this boot (default: this guest alone against the current observation). */
  admitMemory: () => Promise<boolean> = async () => bootMemoryAllows({ availableBytes: (await inspectMemory())?.availableBytes, configuration }),
  /** Ticket 47: the operator's explicit disk remedy for THIS start only (applied only if the preserved disk still fails its check). */
  diskRemedy?: DiskRemedy,
): Promise<StartResult> {
  let boot: BootRef | undefined;
  try {
    const { directory, owner } = await ownedEnvironment(root, environment);
    // Ticket 50: only the disk/profile identity binds the environment; memory/vCPU and host admission settings are this boot's (identity.json).
    const changes = environmentIdentityChanges(owner, { configuration, guestAssets: owner.guestAssets }).filter(change => !change.startsWith('guest assets'));
    if (changes.length) return { status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH', detail: changes.join('; ') };
    if (!pin || pin.directory !== owner.guestAssets.directory || pin.manifestSha256 !== owner.guestAssets.manifestSha256) {
      return { status: 'failure', code: 'GUEST_ASSET_PIN_MISMATCH', detail: environmentIdentityChanges(owner, { configuration, guestAssets: pin }).join('; ') };
    }
    const lock = join(directory, 'lifecycle-lock');
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return { status: 'indeterminate', code: 'ENVIRONMENT_LIFECYCLE_BUSY' };
      }
      throw error;
    }
    try {
      if (await cleanupRequested(directory)) return { status: 'failure', code: 'ENVIRONMENT_CLEANUP_PENDING' };
      let previous;
      try {
        previous = await metadata(join(directory, 'current.json'), currentSchema);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (previous) {
        if (previous.environment !== environment) throw new Error('ENVIRONMENT_OWNERSHIP_MISMATCH');
        const observed = await observeEnvironment(root, environment, previous.boot as BootRef);
        if (!observed.cessationConfirmed) return { status: 'indeterminate', code: 'PREVIOUS_BOOT_NOT_STOPPED', boot: previous.boot as BootRef };
      }
      const disk = join(directory, 'root.qcow2');
      let diskSafe = true;
      try {
        for (const name of ['workspace', 'artifacts']) await privateDirectory(join(directory, name));
        const diskInfo = await lstat(disk);
        if (!diskInfo.isFile() || diskInfo.isSymbolicLink() || diskInfo.nlink !== 1 || diskInfo.uid !== process.getuid?.() || diskInfo.mode & 0o077)
          throw new Error('UNSAFE_ROOT_DISK');
      } catch (error) {
        // Ticket 47: a missing/unsafe preserved disk is replaceable by the operator's decision (the discarded one is set aside, never deleted).
        if (previous && diskRemedy === 'replace-disk' && !(await workAreasUnsafe(directory))) diskSafe = false;
        else if (previous) return await failedStart('failure', 'PRESERVED_DISK_CHECK_REQUIRED', previous.boot as BootRef, join(directory, previous.boot));
        else throw error;
      }
      const canonicalRoot = await realpath(root);
      const candidateBoot = `boot-${randomUUID()}` as BootRef;
      let runtime;
      try {
        runtime = bootRuntimePaths(canonicalRoot, candidateBoot);
      } catch {
        return { status: 'failure', code: 'SANDBOX_RUNTIME_PATH_TOO_LONG' };
      }
      const storage = await inspectStorage(directory);
      const size = BigInt(configuration.diskGiB) * 1073741824n;
      if (!storage || storage.unsuitable || BigInt(storage.availableBytes) < size + BigInt(configuration.minFreeSpaceGiB) * 1073741824n) {
        return { status: 'failure', code: 'INSUFFICIENT_STORAGE_FOR_BOOT' };
      }
      // Ticket 24: the host's free memory must cover this guest, the other own boots still launching and the floor NOW; refused, never retried.
      if (!(await admitMemory())) return { status: 'failure', code: 'INSUFFICIENT_MEMORY_FOR_BOOT' };
      if ((await inspectGuestAssets(pin)).some(check => check.status !== 'ok')) return { status: 'failure', code: 'GUEST_ASSETS_INVALID' };
      let remedy: StartRemedyOutcome | undefined;
      const check = diskSafe ? await checkDiskFilesystem(directory, disk, size) : { ok: false as const, reason: 'root disk: missing or unsafe' };
      if (!check.ok) {
        if (!previous) return { status: 'failure', code: 'ROOT_FILESYSTEM_CHECK_FAILED', detail: check.reason };
        const refused = (detail?: string) =>
          failedStart('failure', 'PRESERVED_DISK_CHECK_REQUIRED', previous.boot as BootRef, join(directory, previous.boot), detail);
        // Ticket 55: the refusal says which step refused and why (a timed-out copy is not a damaged disk).
        if (!diskRemedy) return await refused(`preserved disk check: ${check.reason}`);
        // Ticket 47: the operator's explicit remedy, applied only now: under the lifecycle lock, after the previous boot's cessation was
        // confirmed and the disk check failed again. Room for a whole copy of the disk is required, like a preparation.
        if (BigInt(storage.availableBytes) < 2n * size + BigInt(configuration.minFreeSpaceGiB) * 1073741824n)
          return { status: 'failure', code: 'INSUFFICIENT_STORAGE_FOR_BOOT' };
        const outcome =
          diskRemedy === 'repair-disk'
            ? await repairPreservedDisk(directory, disk, size)
            : await replacePreservedDisk(
                directory,
                disk,
                owner.environmentBase
                  ? { base: join(await realpath(root), 'environment-bases', `base-${owner.environmentBase.key}`, 'base.qcow2') }
                  : await templateOf(pin),
                size,
              );
        if (outcome.status !== 'applied') return await refused(`${diskRemedy}: ${outcome.detail}`);
        const recheck = await checkDiskFilesystem(directory, disk, size);
        if (!recheck.ok) return await refused(`${diskRemedy} applied (${outcome.detail}) but the disk still fails the check: ${recheck.reason}`);
        remedy = { remedy: diskRemedy, outcome: 'applied', detail: outcome.detail };
      } else if (diskRemedy) remedy = { remedy: diskRemedy, outcome: 'not-needed', detail: 'the preserved disk passed the check; nothing was changed' };
      if (previous && !(await observeEnvironment(root, environment, previous.boot as BootRef)).cessationConfirmed) {
        return { status: 'indeterminate', code: 'PREVIOUS_BOOT_NOT_STOPPED', boot: previous.boot as BootRef };
      }
      const previousStop = previous
        ? { boot: previous.boot as BootRef, ...(await readGuestStop(join(directory, previous.boot), previous.boot as BootRef)) }
        : undefined;
      const namespaces = { cgroupNamespace: await readlink('/proc/self/ns/cgroup'), mountNamespace: await readlink('/proc/self/ns/mnt') };
      await supervisionHierarchy(namespaces);
      boot = candidateBoot;
      const path = join(directory, boot);
      const unit = `factory-sandbox-${boot}.service`;
      await mkdir(path, { mode: 0o700 });
      await durableJson(join(path, 'identity.json'), {
        version: 1,
        environment,
        boot,
        unit,
        hostBoot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
        configuration,
      });
      const runtimeParent = dirname(runtime.directory);
      await mkdir(runtimeParent, { recursive: true, mode: 0o700 });
      await privateDirectory(runtimeParent);
      // Exclusive creation, never adopt an old runtime or expose another boot to SDK GC.
      await mkdir(runtime.directory, { mode: 0o700 });
      for (const path of [runtime.temporary, runtime.cache, runtime.sessions]) await mkdir(path, { mode: 0o700 });
      await durableJson(join(runtime.directory, 'owner.json'), { version: 1, environment, boot });
      await syncDirectory(runtimeParent);
      // Publish intent before manager actuation. A failed/ambiguous launch never permits a blind retry.
      const next = join(directory, `current-${boot}.json`);
      await durableJson(next, { version: 1, environment, boot });
      await rename(next, join(directory, 'current.json'));
      await syncDirectory(directory);
      const uid = process.getuid?.();
      await run(
        'systemd-run',
        [
          '--user',
          `--unit=${unit}`,
          '--slice=app.slice',
          '--service-type=exec',
          '--property=Restart=no',
          '--property=KillMode=mixed',
          '--property=SendSIGKILL=yes',
          `--property=TimeoutStopSec=${configuration.shutdownGraceSeconds}s`,
          '--property=UMask=0077',
          '--property=StandardOutput=null',
          '--property=StandardError=null',
          '/usr/bin/env',
          '-i',
          `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
          'LANG=C',
          'LC_ALL=C',
          `XDG_RUNTIME_DIR=/run/user/${uid}`,
          `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
          `TMPDIR=${runtime.temporary}`,
          `XDG_CACHE_HOME=${runtime.cache}`,
          `GONDOLIN_SESSIONS_DIR=${runtime.sessions}`,
          'NODE_DISABLE_COMPILE_CACHE=1',
          process.execPath,
          fileURLToPath(new URL('../entrypoints/adapter.js', import.meta.url)),
          canonicalRoot,
          environment,
          boot,
        ],
        { timeout: 10000, maxBuffer: 16384 },
      );
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const observed = await observeEnvironment(root, environment, boot);
        if (observed.condition === 'active') return { status: 'success', boot, ...(previousStop ? { previousStop } : {}), ...(remedy ? { remedy } : {}) };
        if (observed.cessationConfirmed) return await failedStart('failure', 'BOOT_ENDED_BEFORE_OPERATIONAL_CONFIRMATION', boot, path);
        await delay(250);
      }
      return await failedStart('indeterminate', 'BOOT_OPERATIONAL_STATE_UNCONFIRMED', boot, path);
    } finally {
      await rmdir(lock);
    }
  } catch {
    return { status: 'indeterminate', code: 'ENVIRONMENT_START_UNCONFIRMED', ...(boot ? { boot } : {}) };
  }
}
