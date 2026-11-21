import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { metadata, ownerSchema, privateDirectory } from './lifecycle.js';

export type RuntimeListing = {
  environments: { environment: string; workId: string | null }[];
  cache: { repositoryId: number | null; state: 'idle' | 'preparing' | 'unknown' }[];
  unknown: string[];
};
const environmentName = /^env-[a-f0-9]{64}$/;
/** Sockets the controller (`control.sock`) and doctor (`factory.sock`) own in run/. */
const ownSockets = ['control.sock', 'factory.sock'];
const cacheState = z.object({ state: z.string() });
const listing = async (path: string) =>
  readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });

/**
 * Ticket 26 (spec §5.2 boot step 3): read-only host inventory of the installation's own runtime resources, taken by the composition after the
 * exclusive lock and before the storage opens, even when every previous adapter/owner is dead. Environments carry the attribution read from
 * their own private metadata (no-follow, bounded) — null when unreadable or not derived from its Work identity; the per-repository host Git
 * cache states tell where an interrupted fetch/clone may still run; anything else is reported as unknown, never ignored. Nothing is created,
 * changed, executed or followed; no guest-writable tree is read.
 */
export async function inventoryRuntime(root: string): Promise<RuntimeListing> {
  const canonical = await realpath(root);
  const environments: RuntimeListing['environments'] = [];
  const unknown: string[] = [];
  const parent = join(canonical, 'environments');
  for (const name of (await listing(parent)).sort()) {
    if (!environmentName.test(name)) {
      unknown.push(`environments/${name}`);
      continue;
    }
    let workId: string | null = null;
    try {
      await privateDirectory(join(parent, name));
      const owner = await metadata(join(parent, name, 'owner.json'), ownerSchema);
      if (owner.environment === name && `env-${createHash('sha256').update(owner.workId).digest('hex')}` === name) workId = owner.workId;
    } catch {
      workId = null;
    }
    environments.push({ environment: name, workId });
  }
  const cache: RuntimeListing['cache'] = [];
  const git = join(canonical, 'cache', 'git');
  for (const name of (await listing(git)).sort()) {
    const match = /^([0-9]{1,20})\.state\.json$/.exec(name);
    if (!match) continue; // bare caches, locks and transient files are the cache layout itself, never activity
    let state: 'idle' | 'preparing' | 'unknown' = 'unknown';
    try {
      const info = await lstat(join(git, name));
      if (info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && info.size <= 4096) {
        const parsed = cacheState.safeParse(JSON.parse(await readFile(join(git, name), 'utf8')));
        state = parsed.success ? (parsed.data.state === 'idle' ? 'idle' : 'preparing') : 'unknown';
      }
    } catch {
      state = 'unknown';
    }
    cache.push({ repositoryId: Number(match[1]), state });
  }
  // Own endpoints (an obsolete socket is inert: no process listens through a file) are known; anything else in run/ is unknown, never ignored.
  for (const name of (await listing(join(canonical, 'run'))).sort()) {
    if (ownSockets.includes(name)) {
      const info = await lstat(join(canonical, 'run', name)).catch(() => null);
      if (info?.isSocket() && info.uid === process.getuid?.()) continue;
    }
    unknown.push(`run/${name}`);
  }
  return { environments, cache, unknown };
}
