import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { GuestAssetPin } from './guest-assets.js';
import { ownedEnvironment } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';

/** One own persistent environment and the guest asset pin/profile its disk was prepared with (`null`: unreadable or not owned). */
export type EnvironmentDependency = { environment: string; workId: string | null; guestAssets: GuestAssetPin | null; profile: string | null };

/**
 * Ticket 33 (spec §11.4): read-only listing of the persistent environments of an installation and the assets their disks depend on. Disks
 * are never migrated and dependent assets never removed; a release whose pin differs cannot boot them (GUEST_ASSET_PIN_MISMATCH).
 * Host paths only (no VM, unit or Gondolin owner involved).
 */
export async function environmentDependencies(root: string): Promise<EnvironmentDependency[]> {
  const parent = join(await realpath(root), 'environments');
  let names: string[];
  try {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ENVIRONMENTS_UNSAFE');
    names = (await readdir(parent)).sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const result: EnvironmentDependency[] = [];
  for (const name of names) {
    try {
      const { owner } = await ownedEnvironment(root, name as EnvironmentRef);
      result.push({ environment: name, workId: owner.workId, guestAssets: owner.guestAssets as GuestAssetPin, profile: owner.configuration.profile });
    } catch {
      result.push({ environment: name, workId: null, guestAssets: null, profile: null });
    }
  }
  return result;
}
