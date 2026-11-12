import { lstat, mkdir, open, opendir, readFile, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupAuthorizationSchema, cleanupRequestSchema, cleanupRuntime, removedSchema, runtimeRemovalSchema } from './cleanup-records.js';
import { currentSchema, metadata, observeBootEnvironment, ownedEnvironment, privateDirectory, type BootRef } from './lifecycle.js';
import { publishCleanupRecord } from './cleanup-publication.js';
import type { EnvironmentRef } from './prepare.js';

export type ResourceRemoval = { resource: 'disk' | 'workspace' | 'artifacts' | 'runtime';
  status: 'removed' | 'absent' | 'refused' | 'failed' };
export type RemoveResult = { status: 'success'; resources: ResourceRemoval[] } |
  { status: 'failure' | 'partial' | 'indeterminate'; code: string; resources: ResourceRemoval[] };
const bootPattern = /^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isMissing = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT';
class UnsafeResource extends Error {}

async function syncDirectory(path: string) {
  await privateDirectory(path);
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function safeTree(path: string, device: number): Promise<void> {
  const directory = await opendir(path);
  for await (const entry of directory) {
    const child = join(path, entry.name);
    const info = await lstat(child);
    if (info.uid !== process.getuid?.() || info.dev !== device || (info.isFile() && info.nlink !== 1)) throw new UnsafeResource();
    // Unlink child symlinks themselves, never walk their targets.
    if (info.isDirectory() && !info.isSymbolicLink()) await safeTree(child, device);
  }
}

async function deleteResource(path: string, directory: boolean): Promise<ResourceRemoval['status']> {
  try {
    let info;
    try { info = await lstat(path); }
    catch (e) { if (!isMissing(e)) throw e; await syncDirectory(dirname(path)); return 'absent'; }
    if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) ||
        (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw new UnsafeResource();
    // Reject mount aliases, including same-device bind mounts, before recursive rm.
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    for (const line of mounts.split('\n')) {
      const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (mount === path || mount?.startsWith(`${path}/`)) throw new UnsafeResource();
    }
    if (directory) { await safeTree(path, info.dev); await rm(path, { recursive: true }); }
    else await unlink(path);
    await syncDirectory(dirname(path));
    return 'removed';
  } catch (e) { return e instanceof UnsafeResource ? 'refused' : 'failed'; }
}

async function knownBoots(directory: string, environment: EnvironmentRef): Promise<string[]> {
  const current = await metadata(join(directory, 'current.json'), currentSchema);
  if (current.environment !== environment) throw new Error('FOREIGN_CURRENT');
  const names = (await readdir(directory)).filter(name => name.startsWith('boot-')).sort();
  if (!names.includes(current.boot) || names.some(name => !bootPattern.test(name))) throw new Error('UNKNOWN_BOOT_RECORD');
  return names;
}

async function retainRuntimeOwner(directory: string, runtime: string, environment: EnvironmentRef, boot: string) {
  await privateDirectory(runtime);
  const info = await lstat(runtime, { bigint: true });
  const expected = runtimeRemovalSchema.parse({ version: 1, environment, boot,
    dev: info.dev.toString(), ino: info.ino.toString(), birthtimeNs: info.birthtimeNs.toString(), uid: info.uid.toString() });
  const evidence = join(directory, `runtime-cleanup-${boot}.json`);
  let retained = false;
  try {
    const previous = await metadata(evidence, runtimeRemovalSchema, { durable: true });
    if (JSON.stringify(previous) !== JSON.stringify(expected)) throw new UnsafeResource();
    retained = true;
  } catch (e) { if (e instanceof UnsafeResource) throw e; }
  let ownerPresent = true;
  try { await lstat(join(runtime, 'owner.json')); }
  catch (e) { if (!isMissing(e)) throw e; ownerPresent = false; }
  if (ownerPresent) {
    const own = await metadata(join(runtime, 'owner.json'), currentSchema);
    if (own.environment !== environment || own.boot !== boot) throw new UnsafeResource();
  } else if (!retained) throw new Error('RUNTIME_OWNERSHIP_UNCONFIRMED');
  // Evidence survives the subtree deletion. A recreated directory cannot use it.
  await publishCleanupRecord(evidence, expected, runtimeRemovalSchema);
}

/** Trusted host operation only. Caller has preserved evidence and ended Work;
 * these assertions are NOT credentials or a worker-projected cancellation API. */
export async function removeEnvironment(root: string, environment: EnvironmentRef, cleanup: unknown): Promise<RemoveResult> {
  const parsed = cleanupAuthorizationSchema.safeParse(cleanup);
  if (!parsed.success) return { status: 'failure', code: 'CLEANUP_AUTHORIZATION_INVALID', resources: [] };
  const resources: ResourceRemoval[] = [];
  const unknown = (): RemoveResult => ({ status: 'indeterminate', code: 'ENVIRONMENT_REMOVAL_UNCONFIRMED', resources });
  try {
    const { directory, owner } = await ownedEnvironment(root, environment);
    if (owner.workId !== parsed.data.workId) return { status: 'failure', code: 'CLEANUP_WORK_MISMATCH', resources };
    const lock = join(directory, 'lifecycle-lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'EEXIST') return { status: 'indeterminate', code: 'ENVIRONMENT_LIFECYCLE_BUSY', resources };
      throw e;
    }
    try {
      const boots = await knownBoots(directory, environment);
      const assertStopped = async () => {
        if (JSON.stringify(await knownBoots(directory, environment)) !== JSON.stringify(boots)) throw new Error('BOOT_INVENTORY_CHANGED');
        for (const boot of boots) {
          if (!(await observeBootEnvironment(root, environment, boot as BootRef)).cessationConfirmed) throw new Error('CESSATION_UNCONFIRMED');
        }
      };
      await assertStopped();
      const request = cleanupRequestSchema.parse({ ...parsed.data, version: 1, environment, boots });
      const requestPath = join(directory, 'cleanup-request.json');
      await publishCleanupRecord(requestPath, request, cleanupRequestSchema);
      const targets = [ ['disk', 'root.qcow2', false], ['workspace', 'workspace', true], ['artifacts', 'artifacts', true] ] as const;
      for (const [resource, name, tree] of targets) {
        await assertStopped();
        resources.push({ resource, status: await deleteResource(join(directory, name), tree) });
      }
      const canonical = await realpath(root);
      let runtimeStatus: ResourceRemoval['status'] = 'absent';
      for (const boot of boots) {
        await assertStopped();
        const runtime = cleanupRuntime(canonical, boot);
        try { await lstat(runtime); }
        catch (e) {
          if (!isMissing(e)) throw e;
          await syncDirectory(join(canonical, 'r'));
          continue;
        }
        try {
          await privateDirectory(join(canonical, 'r'));
          await retainRuntimeOwner(directory, runtime, environment, boot);
          const status = await deleteResource(runtime, true);
          if (status === 'failed' || status === 'refused') runtimeStatus = status;
          else if (runtimeStatus === 'absent') runtimeStatus = status;
        } catch (e) { runtimeStatus = e instanceof UnsafeResource ? 'refused' : 'failed'; }
      }
      resources.push({ resource: 'runtime', status: runtimeStatus });
      if (resources.some(r => r.status === 'failed' || r.status === 'refused')) return { status: 'partial', code: 'ENVIRONMENT_REMOVAL_PARTIAL', resources };
      await assertStopped();
      const marker = removedSchema.parse({ version: 1, environment, workId: owner.workId, boots });
      const markerPath = join(directory, 'removed.json');
      await publishCleanupRecord(markerPath, marker, removedSchema);
      return { status: 'success', resources };
    } finally { await rmdir(lock); }
  } catch { return unknown(); }
}
