import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Trusted, read-only Factory material (e.g. the versioned skill pack) copied ONCE per environment under /artifacts/<name>. */
export type ArtifactSeed = { name: string; directory: string };
type SeedResult = { status: 'success'; seeds: { name: string; manifestSha256: string; reused: boolean }[] } | { status: 'failure' | 'indeterminate'; code: string };

const seedName = /^factory\/[a-z0-9-]+\/[a-z0-9][a-z0-9.-]{0,63}$/;
async function regularTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('ARTIFACT_SEED_UNSAFE');
  if (info.isDirectory()) for (const name of await readdir(path)) await regularTree(join(path, name));
}

/**
 * Versions are never overwritten: an existing copy is reused only when its manifest bytes are identical. The guest may still edit the copy
 * (no immutability against hostile code is promised); the controller never reads it back.
 */
export async function seedArtifacts(artifacts: string, seeds: readonly ArtifactSeed[]): Promise<SeedResult> {
  const result: { name: string; manifestSha256: string; reused: boolean }[] = [];
  try {
    for (const seed of seeds) {
      if (!seedName.test(seed.name)) return { status: 'failure', code: 'ARTIFACT_SEED_INVALID' };
      await regularTree(seed.directory);
      const manifest = await readFile(join(seed.directory, 'manifest.json'));
      const manifestSha256 = createHash('sha256').update(manifest).digest('hex');
      const target = join(artifacts, seed.name);
      const present = await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
      if (present) {
        const copy = await readFile(join(target, 'manifest.json')).catch(() => undefined);
        if (!copy || !copy.equals(manifest)) return { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' };
        result.push({ name: seed.name, manifestSha256, reused: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(seed.directory, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      result.push({ name: seed.name, manifestSha256, reused: false });
    }
    return { status: 'success', seeds: result };
  } catch { return { status: 'indeterminate', code: 'ARTIFACT_SEED_UNAVAILABLE' }; }
}
