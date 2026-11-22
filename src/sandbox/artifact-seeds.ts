import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readConfined } from './confined.js';

/** Trusted, read-only Factory material (e.g. the versioned skill pack) copied ONCE per environment under /artifacts/<name>. */
export type ArtifactSeed = { name: string; directory: string };
/** `replaced` (ticket 50): where the divergent copy was set aside (relative to /artifacts) when the operator decided to recreate the seed. */
type SeedResult =
  | { status: 'success'; seeds: { name: string; manifestSha256: string; reused: boolean; replaced?: string }[] }
  /** `detail` (ticket 50): the divergent seed file (`<seed>/<path>`), so the operator can inspect it before deciding. */
  | { status: 'failure' | 'indeterminate'; code: string; detail?: string };

const seedName = /^factory\/[a-z0-9-]+\/[a-z0-9][a-z0-9.-]{0,63}$/;
const relative = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine(path => !path.split('/').some(part => part === '.' || part === '..'));
const manifestSchema = z.object({
  files: z
    .array(z.object({ path: relative, sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1)
    .max(1024),
});
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
class SeedFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Calendar stamp of a set-aside copy: sortable, filesystem and seed-name safe. */
const stamp = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'z')
    .toLowerCase();

/** The first file of an existing copy that differs from the manifest (`manifest.json` itself first), or null when the copy is intact. */
async function divergence(target: string, manifest: Buffer, files: readonly { path: string; sha256: string }[]): Promise<string | null> {
  try {
    const copy = await readConfined(target, 'manifest.json', 1024 * 1024);
    if (!copy?.equals(manifest)) return 'manifest.json';
    for (const file of files) {
      const bytes = await readConfined(target, file.path, 16 * 1024 * 1024);
      if (!bytes || sha(bytes) !== file.sha256) return file.path;
    }
    return null;
  } catch (error) {
    if (error instanceof Error && error.message === 'CONFINED_PATH_UNSAFE') return '(unsafe path: symlink or hard link inside the copy)';
    throw error;
  }
}

/** Every existing component of artifacts/<name> must be a real directory (no symlink), so nothing is written or read outside /artifacts. */
async function components(artifacts: string, name: string): Promise<boolean> {
  let path = artifacts;
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
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
export async function seedArtifacts(
  artifacts: string,
  seeds: readonly ArtifactSeed[],
  /** Ticket 50: seeds the operator explicitly decided to recreate: a divergent copy is set aside (kept, renamed) and a fresh one written. */
  options: { recreate?: readonly string[]; now?: () => Date } = {},
): Promise<SeedResult> {
  const result: { name: string; manifestSha256: string; reused: boolean; replaced?: string }[] = [];
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
      let replaced: string | undefined;
      if (await components(artifacts, seed.name)) {
        const diverged = await divergence(target, manifest, files);
        if (diverged === null) {
          result.push({ name: seed.name, manifestSha256, reused: true });
          continue;
        }
        if (!options.recreate?.includes(seed.name)) return { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT', detail: `${seed.name}/${diverged}` };
        // Operator decision: the divergent copy is never deleted or merged; it is renamed aside (same parent, never followed) for inspection.
        replaced = `${seed.name}.divergent-${stamp(options.now?.() ?? new Date())}`;
        await rename(target, join(artifacts, replaced));
      }
      for (const prefix of ['factory', seed.name.split('/').slice(0, 2).join('/')]) {
        if (!(await components(artifacts, prefix))) await mkdir(join(artifacts, prefix), { mode: 0o700 });
      }
      await mkdir(target, { mode: 0o700 });
      for (const file of files) {
        let parent = target;
        for (const part of dirname(file.path) === '.' ? [] : dirname(file.path).split('/')) {
          parent = join(parent, part);
          await mkdir(parent, { mode: 0o700 }).catch(async error => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(parent)).isDirectory()) throw error;
          });
        }
        await writeFile(join(target, file.path), file.bytes, { flag: 'wx', mode: 0o600 });
      }
      await writeFile(join(target, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
      result.push({ name: seed.name, manifestSha256, reused: false, ...(replaced ? { replaced } : {}) });
    }
    return { status: 'success', seeds: result };
  } catch (error) {
    if (error instanceof SeedFailure) return { status: 'failure', code: error.code };
    if (error instanceof Error && error.message === 'CONFINED_PATH_UNSAFE') return { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' };
    return { status: 'indeterminate', code: 'ARTIFACT_SEED_UNAVAILABLE' };
  }
}
