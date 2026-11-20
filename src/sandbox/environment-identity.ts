import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '../contracts/index.js';
import { cleanupRequested } from './cleanup-records.js';
import { environmentIdentityChanges, type SandboxConfiguration } from './configuration.js';
import { metadata, ownerSchema, privateDirectory } from './lifecycle.js';

const environmentName = /^env-[a-f0-9]{64}$/;

/**
 * Ticket 50 (`doctor`, before a restart): the prepared environments still retained by the installation (no cleanup requested) whose disk/profile
 * identity the given configuration and guest asset pin would invalidate (`environmentIdentityChanges`). Read-only: owner records are read with
 * no-follow bounded reads; nothing is created, changed or removed. Offline the Work states are not known, so every retained environment counts
 * (open Works' environments are among them).
 */
export async function environmentIdentityDiagnostic(root: string, configuration: Pick<SandboxConfiguration, 'profile' | 'diskGiB'>,
  guestAssets: { directory: string; manifestSha256: string } | undefined): Promise<Diagnostic> {
  const affected: string[] = [];
  const unreadable: string[] = [];
  let retained = 0;
  const parent = join(await realpath(root).catch(() => root), 'environments');
  const names = await readdir(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  for (const name of names.filter(item => environmentName.test(item)).sort()) {
    const directory = join(parent, name);
    try {
      await privateDirectory(directory);
      if (await cleanupRequested(directory)) continue;
      const owner = await metadata(join(directory, 'owner.json'), ownerSchema);
      retained++;
      const changes = environmentIdentityChanges(owner, { configuration, guestAssets });
      if (changes.length) affected.push(`work ${owner.workId} (${name.slice(0, 16)}): ${changes.join(', ')}`);
    } catch { unreadable.push(name.slice(0, 16)); }
  }
  const unread = unreadable.length ? ` Unreadable owner records (not evaluated): ${unreadable.join(', ')}.` : '';
  if (!affected.length) {
    return { id: 'environment-identity', status: 'ok', message: `${retained} retained prepared environment(s) keep their disk/profile identity under this ` +
      `configuration; guest memory/vCPU changes apply at each next boot.${unread}`,
    nextStep: 'Nothing to do; changing sandbox.memoryMiB or sandbox.vcpus never requires a new environment.' };
  }
  return { id: 'environment-identity', status: 'unverified',
    message: `WARNING: this configuration changes the disk/profile identity of ${affected.length} of ${retained} retained prepared environment(s); after a restart ` +
      `their Works refuse preparation with ENVIRONMENT_CONFIGURATION_MISMATCH and need a NEW environment (cancel + new cycle loses the environment and unpublished work): ` +
      `${affected.slice(0, 20).join('; ')}${affected.length > 20 ? `; and ${affected.length - 20} more` : ''}.${unread}`,
    nextStep: 'Before restarting: restore sandbox.profile/sandbox.diskGiB (or the release guest assets) to keep those environments, or accept that each listed ' +
      'open Work needs `factory cancel <work>` + `factory new <owner/repo#number>`. Only profile, disk size and guest assets bind an environment; a changed repository environment declaration (ticket 44) only applies to new environments.' };
}
