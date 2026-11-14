import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readConfined } from './confined.js';

/** Trusted, read-only Factory material (e.g. the versioned skill pack) copied ONCE per environment under /artifacts/<name>. */
export type ArtifactSeed = { name: string; directory: string };
type SeedResult = { status: 'success'; seeds: { name: string; manifestSha256: string; reused: boolean }[] } | { status: 'failure' | 'indeterminate'; code: string };

const seedName = /^factory\/[a-z0-9-]+\/[a-z0-9][a-z0-9.-]{0,63}$/;
const relative = z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).refine(path => !path.split('/').some(part => part === '.' || part === '..'));
const manifestSchema = z.object({ files: z.array(z.object({ path: relative, sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(1024) });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
class SeedFailure extends Error { constructor(readonly code: string) { super(code); } }

/** Every existing component of artifacts/<name> must be a real directory (no symlink), so nothing is written or read outside /artifacts. */
async function components(artifacts: string, name: string): Promise<boolean> {
  let path = artifacts;
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SeedFailure('ARTIFACT_SEED_PATH_UNSAFE');
    if (index === parts.length - 1) return true;
  }
  return false;
}

/**
 * Versions are never overwritten. Reuse requires the manifest AND every listed file of the existing copy to match (confined reads, no
 * symlink/hard link followed); otherwise ARTIFACT_SEED_VERSION_CONFLICT. A new copy writes exactly the manifest's files, exclusively.
 * The guest may still edit the copy later (no immutability against hostile code); the controller never reads it back.
 */
export async function seedArtifacts(artifacts: string, seeds: readonly ArtifactSeed[]): Promise<SeedResult> {
  const result: { name: string; manifestSha256: string; reused: boolean }[] = [];
  try {
    artifacts = await realpath(artifacts);
    for (const seed of seeds) {
      if (!seedName.test(seed.name)) return { status: 'failure', code: 'ARTIFACT_SEED_INVALID' };
      const manifest = await readFile(join(seed.directory, 'manifest.json'));
      const parsed = manifestSchema.safeParse(JSON.parse(manifest.toString('utf8')));
      if (!parsed.success) return { status: 'failure', code: 'ARTIFACT_SEED_INVALID' };
      const files = await Promise.all(parsed.data.files.map(async file => ({ ...file, bytes: await readFile(join(seed.directory, file.path)) })));
      if (files.some(file => sha(file.bytes) !== file.sha256)) return { status: 'failure', code: 'ARTIFACT_SEED_SOURCE_DRIFT' };
      const manifestSha256 = sha(manifest);
      const target = join(artifacts, seed.name);
      if (await components(artifacts, seed.name)) {
        const copy = await readConfined(target, 'manifest.json', 1024 * 1024);
        if (!copy?.equals(manifest)) return { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' };
        for (const file of files) {
          const bytes = await readConfined(target, file.path, 16 * 1024 * 1024);
          if (!bytes || sha(bytes) !== file.sha256) return { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' };
        }
        result.push({ name: seed.name, manifestSha256, reused: true });
        continue;
      }
      for (const prefix of ['factory', seed.name.split('/').slice(0, 2).join('/')]) {
        if (!await components(artifacts, prefix)) await mkdir(join(artifacts, prefix), { mode: 0o700 });
      }
      await mkdir(target, { mode: 0o700 });
      for (const file of files) {
        let parent = target;
        for (const part of dirname(file.path) === '.' ? [] : dirname(file.path).split('/')) {
          parent = join(parent, part);
          await mkdir(parent, { mode: 0o700 }).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(parent)).isDirectory()) throw error; });
        }
        await writeFile(join(target, file.path), file.bytes, { flag: 'wx', mode: 0o600 });
      }
      await writeFile(join(target, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
      result.push({ name: seed.name, manifestSha256, reused: false });
    }
    return { status: 'success', seeds: result };
  } catch (error) {
    if (error instanceof SeedFailure) return { status: 'failure', code: error.code };
    if (error instanceof Error && error.message === 'CONFINED_PATH_UNSAFE') return { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' };
    return { status: 'indeterminate', code: 'ARTIFACT_SEED_UNAVAILABLE' };
  }
}
