import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type LockPackage = { version?: string; optional?: boolean; link?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/**
 * Fails early when node_modules is not what package-lock.json pins: every non-optional locked package
 * must be installed at its locked version (dev ones included: the test SDKs are dev dependencies).
 * Returns the problems; an empty list means the tree matches.
 */
export async function checkInstalledDependencies(root: string): Promise<string[]> {
  const problems: string[] = [];
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as { packages?: Record<string, LockPackage> };
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const packages = lock.packages ?? {};
  const locked = packages[''] ?? {};
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const pinned = locked[field]?.[name];
      if (pinned !== spec) problems.push(`package.json ${field}.${name}=${spec} is not in package-lock.json (lockfile: ${pinned ?? 'absent'})`);
    }
  }
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/') || entry.link) continue;
    let installed: string | undefined;
    try {
      installed = (JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')) as { version?: string }).version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (installed === undefined) {
      if (!entry.optional) problems.push(`${path}: missing (lockfile ${entry.version})`);
    } else if (installed !== entry.version) problems.push(`${path}: installed ${installed}, lockfile ${entry.version}`);
  }
  return problems;
}
