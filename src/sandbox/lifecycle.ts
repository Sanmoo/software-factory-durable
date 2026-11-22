import { unitState } from '../platform/host/index.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, readdir, realpath, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configurationSchema } from './configuration.js';
import { environmentBaseRecordSchema } from './environment-base.js';
import { cleanupRequestSchema, cleanupRuntime, removedSchema } from './cleanup-records.js';
import type { EnvironmentRef } from './prepare.js';

export type BootRef = string & { readonly bootRef: unique symbol };
export type Observation = {
  /** `not-booted` (ticket 26): an owned, prepared environment that never published a boot, so no manager unit was ever started for it. */
  condition: 'active' | 'stopped' | 'removed' | 'not-booted' | 'indeterminate';
  cessationConfirmed: boolean;
  consumption: 'unavailable';
  /** Ticket 26: the boot an observation WITHOUT an explicit boot correlated (the environment's published current boot); null when none. */
  boot?: BootRef | null;
};

const environmentRef = z.string().regex(/^env-[a-f0-9]{64}$/);
const bootRef = z.string().regex(/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const ownerSchema = z.strictObject({
  version: z.literal(1), workId: z.string().min(1).max(512), environment: environmentRef,
  configuration: configurationSchema,
  guestAssets: z.strictObject({ directory: z.string(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  /** Ticket 44: the environment base this environment's root disk was copied from (absent: generic guest, before ticket 44). */
  environmentBase: environmentBaseRecordSchema.optional(),
});
const readySchema = z.strictObject({ environment: environmentRef });
export const currentSchema = z.strictObject({ version: z.literal(1), environment: environmentRef, boot: bootRef });
export const identitySchema = z.strictObject({ version: z.literal(1), environment: environmentRef, boot: bootRef,
  unit: z.string(), hostBoot: z.uuid(), configuration: configurationSchema });
export const startedSchema = z.strictObject({ version: z.literal(1), boot: bootRef,
  unit: z.string(), invocation: z.string().regex(/^[a-f0-9]{32}$/), cgroup: z.string(),
  cgroupNamespace: z.string().regex(/^cgroup:\[[0-9]+\]$/),
  mountNamespace: z.string().regex(/^mnt:\[[0-9]+\]$/) });
export const startupFailureCodeSchema = z.enum([
  'GUEST_READINESS_TIMEOUT', 'SDK_START_DISABLED', 'GUEST_PROFILE_NOT_OPERATIONAL',
  'GUEST_ASSETS_INVALID', 'ADAPTER_RUNTIME_MISMATCH', 'VMM_IDENTITY_UNAVAILABLE', 'VMM_SUPERVISION_MISMATCH',
  'ENOENT', 'EACCES', 'EPERM', 'ENAMETOOLONG', 'EADDRINUSE', 'ENOSPC', 'EIO', 'EINVAL',
  'EMFILE', 'ENFILE', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UNCLASSIFIED_STARTUP_FAILURE',
]);
export const startupFailureSchema = z.strictObject({ version: z.literal(1), boot: bootRef,
  phase: z.enum(['runtime', 'assets', 'sdk-import', 'vm-create', 'vm-start', 'guest-profile', 'operational-evidence']),
  code: startupFailureCodeSchema });
export type StartupFailure = Pick<z.infer<typeof startupFailureSchema>, 'phase' | 'code'>;
const operationalSchema = z.strictObject({ version: z.literal(1), boot: bootRef,
  session: z.string().min(1).max(256), vmmPid: z.number().int().positive().max(2147483647),
  vmmStartTicks: z.string().regex(/^[0-9]{1,20}$/) });
const metadataLimit = 65536;

export async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('PRIVATE_ENVIRONMENT_DIRECTORY_REQUIRED');
  }
}

export async function metadata<T>(path: string, schema: z.ZodType<T>, options?: { durable: true }): Promise<T> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() ||
        (before.mode & 0o077) || before.size > metadataLimit) throw new Error('UNSAFE_RESOURCE_METADATA');
    const buffer = Buffer.alloc(metadataLimit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('RESOURCE_METADATA_CHANGED');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    const parsed = schema.parse(JSON.parse(text));
    if (options?.durable) {
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const parent = await directory.stat();
        if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) {
          throw new Error('PRIVATE_ENVIRONMENT_DIRECTORY_REQUIRED');
        }
        // A readable existing record may belong to a publisher whose sync failed
        // or is still pending. Establish our own barrier on this validated FD.
        await file.sync();
        await directory.sync();
        const published = await lstat(path);
        const current = await file.stat();
        if (!published.isFile() || published.nlink !== 1 || published.dev !== before.dev || published.ino !== before.ino ||
            current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
          throw new Error('RESOURCE_METADATA_CHANGED');
        }
      } finally { await directory.close(); }
    }
    return parsed;
  } finally { await file.close(); }
}

export async function ownedEnvironment(root: string, environment: EnvironmentRef) {
  environmentRef.parse(environment);
  const parent = join(await realpath(root), 'environments');
  const directory = join(parent, environment);
  await privateDirectory(parent);
  await privateDirectory(directory);
  const owner = await metadata(join(directory, 'owner.json'), ownerSchema);
  const ready = await metadata(join(directory, 'ready.json'), readySchema);
  const expected = `env-${createHash('sha256').update(owner.workId).digest('hex')}`;
  if (owner.environment !== environment || ready.environment !== environment || expected !== environment) {
    throw new Error('ENVIRONMENT_OWNERSHIP_MISMATCH');
  }
  return { directory, owner };
}

export async function supervisionHierarchy(started: Pick<z.infer<typeof startedSchema>, 'cgroupNamespace' | 'mountNamespace'>) {
  const root = '/sys/fs/cgroup';
  if (await readlink('/proc/self/ns/cgroup') !== started.cgroupNamespace ||
      await readlink('/proc/self/ns/mnt') !== started.mountNamespace) throw new Error('SUPERVISION_NAMESPACE_CHANGED');
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (await statfs(root)).type !== 0x63677270) {
    throw new Error('CGROUP_V2_UNAVAILABLE');
  }
  // The root capability file and a full-root cgroup2 mount distinguish an absent
  // owned group from a missing/foreign supervision hierarchy.
  await readFile(join(root, 'cgroup.controllers'), 'utf8');
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  const fullRoot = mounts.split('\n').some(line => {
    const [left, right] = line.split(' - ');
    const fields = left?.split(' ');
    return fields?.[3] === '/' && fields[4] === root && right?.split(' ')[0] === 'cgroup2';
  });
  if (!fullRoot) throw new Error('CGROUP_V2_ROOT_UNAVAILABLE');
}

export { unitState } from '../platform/host/index.js';

export function processStartTicks(value: string) {
  const end = value.lastIndexOf(') ');
  if (end < 0) throw new Error('INVALID_PROCESS_OBSERVATION');
  const ticks = value.slice(end + 2).split(' ')[19];
  if (!ticks || !/^[0-9]{1,20}$/.test(ticks)) throw new Error('INVALID_PROCESS_OBSERVATION');
  return ticks;
}

/** Read-only ownership observation. Missing evidence is never confirmed cessation. */
export async function observeBootEnvironment(root: string, environment: EnvironmentRef, boot?: BootRef): Promise<Observation> {
  const unknown: Observation = { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable' };
  try {
    const { directory } = await ownedEnvironment(root, environment);
    if (boot === undefined) {
      const current = await metadata(join(directory, 'current.json'), currentSchema);
      if (current.environment !== environment) return unknown;
      boot = current.boot as BootRef;
    }
    bootRef.parse(boot);
    const path = join(directory, boot);
    await privateDirectory(path);
    const identity = await metadata(join(path, 'identity.json'), identitySchema);
    const unit = `factory-sandbox-${boot}.service`;
    const hostBoot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (identity.environment !== environment || identity.boot !== boot || identity.unit !== unit || identity.hostBoot !== hostBoot) return unknown;
    const started = await metadata(join(path, 'started.json'), startedSchema);
    const cgroup = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`;
    if (started.boot !== boot || started.unit !== unit || started.cgroup !== cgroup) return unknown;
    await supervisionHierarchy(started);
    const state = await unitState(unit);
    if (state.InvocationID && state.InvocationID !== started.invocation) return unknown;
    if (state.ActiveState === 'active') {
      if (state.InvocationID !== started.invocation || state.ControlGroup !== cgroup) return unknown;
      const operational = await metadata(join(path, 'operational.json'), operationalSchema);
      if (operational.boot !== boot) return unknown;
      const statPath = `/proc/${operational.vmmPid}/stat`;
      const before = processStartTicks(await readFile(statPath, 'utf8'));
      const group = (await readFile(`/proc/${operational.vmmPid}/cgroup`, 'utf8')).trim();
      const after = processStartTicks(await readFile(statPath, 'utf8'));
      if (before !== operational.vmmStartTicks || after !== before || group !== `0::${cgroup}`) return unknown;
      return { condition: 'active', cessationConfirmed: false, consumption: 'unavailable' };
    }
    if (state.ActiveState !== 'inactive' && state.ActiveState !== 'failed') return unknown;
    if (state.ControlGroup && state.ControlGroup !== cgroup) return unknown;
    try {
      const events = await readFile(`/sys/fs/cgroup${cgroup}/cgroup.events`, 'utf8');
      if (!/(?:^|\n)populated 0(?:\n|$)/.test(events)) return unknown;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return unknown;
      // A group that still exists but lacks readable events is unavailable, not empty.
      try { await lstat(`/sys/fs/cgroup${cgroup}`); return unknown; }
      catch (groupError) {
        if (!(groupError instanceof Error && 'code' in groupError && groupError.code === 'ENOENT')) return unknown;
      }
      await supervisionHierarchy(started);
    }
    return { condition: 'stopped', cessationConfirmed: true, consumption: 'unavailable' };
  } catch { return unknown; }
}

/**
 * Ticket 26: the boot currently published for an owned, prepared environment. `current.json` is renamed into place (and the directory
 * synced) BEFORE any manager actuation, so its absence proves that no unit was ever started for this environment. `undefined`: unknown.
 */
export async function currentBoot(root: string, environment: EnvironmentRef): Promise<BootRef | null | undefined> {
  try {
    const { directory } = await ownedEnvironment(root, environment);
    try {
      const current = await metadata(join(directory, 'current.json'), currentSchema);
      return current.environment === environment ? current.boot as BootRef : undefined;
    } catch (error) {
      // A boot directory or an unrenamed `current-<boot>.json` without the published current boot never reached systemd-run.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      return undefined;
    }
  } catch { return undefined; }
}

/** Removal evidence is not cessation by itself: verify every recorded boot and absence. */
export async function observeEnvironment(root: string, environment: EnvironmentRef, boot?: BootRef): Promise<Observation> {
  const unknown: Observation = { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable' };
  try {
    const { directory, owner } = await ownedEnvironment(root, environment);
    let removed;
    try { removed = await metadata(join(directory, 'removed.json'), removedSchema); }
    catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) return unknown;
      return observeBootEnvironment(root, environment, boot);
    }
    const request = await metadata(join(directory, 'cleanup-request.json'), cleanupRequestSchema);
    const current = await metadata(join(directory, 'current.json'), currentSchema);
    const inventory = (await readdir(directory)).filter(name => name.startsWith('boot-')).sort();
    if (current.environment !== environment || !removed.boots.includes(current.boot) ||
        JSON.stringify(inventory) !== JSON.stringify(removed.boots)) return unknown;
    if (removed.environment !== environment || removed.workId !== owner.workId || request.environment !== environment ||
        request.workId !== owner.workId || JSON.stringify(removed.boots) !== JSON.stringify(request.boots) ||
        (boot !== undefined && !removed.boots.includes(boot))) return unknown;
    for (const ref of removed.boots) {
      if (!(await observeBootEnvironment(root, environment, ref as BootRef)).cessationConfirmed) return unknown;
    }
    const canonical = await realpath(root);
    const paths = ['root.qcow2', 'workspace', 'artifacts'].map(name => join(directory, name));
    paths.push(...removed.boots.map(ref => cleanupRuntime(canonical, ref)));
    for (const path of paths) {
      try { await lstat(path); return unknown; }
      catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) return unknown; }
    }
    return { condition: 'removed', cessationConfirmed: true, consumption: 'unavailable' };
  } catch { return unknown; }
}
