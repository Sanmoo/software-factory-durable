import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The Factory's own versioned Builder skill pack (spec §6.3): distributed with the Factory, never a personal profile or registry. */
export const builderSkillPack = Object.freeze({ id: 'factory-skills-v1' as const, seedName: 'factory/skill-pack/factory-skills-v1',
  guestDirectory: '/artifacts/factory/skill-pack/factory-skills-v1',
  directory: fileURLToPath(new URL('../../../assets/skill-pack/factory-skills-v1', import.meta.url)) });

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const relative = z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).refine(path => !path.split('/').some(part => part === '..' || part === '.'));
const manifestSchema = z.object({ id: z.literal(builderSkillPack.id), version: z.string(), guestDirectory: z.literal(builderSkillPack.guestDirectory),
  skills: z.array(z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), path: relative, description: z.string().min(1).max(1024), modelInvocation: z.boolean() })).min(1),
  prompts: z.array(z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), path: relative, description: z.string().min(1).max(1024) })).min(1),
  credits: relative, licenses: z.array(z.object({ license: z.string() })).min(1),
  files: z.array(z.object({ path: relative, sha256, change: z.enum(['verbatim', 'adapted', 'factory-own']),
    origin: z.object({ package: z.string(), license: z.string() }).passthrough() })).min(1) });
export type SkillPackManifest = z.infer<typeof manifestSchema>;
export type LoadedSkillPack = { id: typeof builderSkillPack.id; version: string; manifestSha256: string; manifest: SkillPackManifest;
  prompts: { name: string; description: string; content: string; path: string }[] };

const strip = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, '');
async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(directory, path));
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('WORKER_SKILL_PACK_DRIFT');
    if (info.isDirectory()) result.push(...await listFiles(directory, path));
    else result.push(path);
  }
  return result;
}

/** Verifies the exact file set and every hash against the manifest before anything is offered to the SDK; drift refuses the start. */
export async function loadSkillPack(directory = builderSkillPack.directory): Promise<LoadedSkillPack> {
  try {
    const bytes = await readFile(join(directory, 'manifest.json'));
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    const listed = manifest.files.map(file => file.path).sort();
    if (JSON.stringify(listed) !== JSON.stringify((await listFiles(directory)).filter(path => path !== 'manifest.json').sort())) throw new Error('WORKER_SKILL_PACK_DRIFT');
    for (const file of manifest.files) {
      if (createHash('sha256').update(await readFile(join(directory, file.path))).digest('hex') !== file.sha256) throw new Error('WORKER_SKILL_PACK_DRIFT');
    }
    for (const entry of [...manifest.skills, ...manifest.prompts]) if (!listed.includes(entry.path)) throw new Error('WORKER_SKILL_PACK_DRIFT');
    const prompts = await Promise.all(manifest.prompts.map(async prompt => ({ name: prompt.name, description: prompt.description, path: prompt.path,
      content: strip(await readFile(join(directory, prompt.path), 'utf8')) })));
    return { id: manifest.id, version: manifest.version, manifestSha256: createHash('sha256').update(bytes).digest('hex'), manifest, prompts };
  } catch { throw new Error('WORKER_SKILL_PACK_DRIFT'); }
}
