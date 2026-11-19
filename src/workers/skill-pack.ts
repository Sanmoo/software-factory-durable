import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { factorySkillPackIds, type FactorySkillPackId } from '../contracts/index.js';

/** The Factory's own versioned Builder skill packs (spec §6.3): distributed with the Factory, never a personal profile or registry.
 * A published version is never edited in place; a change is a new version (v1 = ticket 09, v2 = ticket 10 ask_user/resume,
 * v3 = ticket 12: v2 plus the review handoff and the Factory commit identity rule; v4 = ticket 11: v3 plus continue/recovery
 * context, authorized scope changes and instruction precedence; v5 = ticket 13: v4 plus repeated review rounds with treatments of listed
 * findings and Host-evidenced gates; v6 = ticket 14: v5 plus the direct publication of a Factory-requested publish-only activation and the
 * short Summary/Validation/Risk PR body; v7 = ticket 34: v6 plus `not-adopted` (never `fixed`) for a finding the reviewed content already
 * satisfies; v8 = ticket 46: v7 plus generous build/test Bash timeouts and Bash for files over the edit/write limits). */
const pack = <T extends string>(id: T) => Object.freeze({ id, seedName: `factory/skill-pack/${id}`, guestDirectory: `/artifacts/factory/skill-pack/${id}`,
  directory: fileURLToPath(new URL(`../../../assets/skill-pack/${id}`, import.meta.url)) });
export const skillPacks = Object.freeze(Object.fromEntries(factorySkillPackIds.map(id => [id, pack(id)]))) as { readonly [K in FactorySkillPackId]: ReturnType<typeof pack<K>> };
export type SkillPackId = FactorySkillPackId;
export const skillPackIds = factorySkillPackIds as unknown as [SkillPackId, ...SkillPackId[]];
/** Alias used by the ticket 12 compositions. */
export const builderSkillPacks = skillPacks;
/** Default Builder pack. */
export const builderSkillPack = skillPacks['factory-skills-v2'];

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const relative = z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).refine(path => !path.split('/').some(part => part === '..' || part === '.'));
const manifestSchema = z.object({ id: z.enum(skillPackIds), version: z.string(), guestDirectory: z.string(),
  skills: z.array(z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), path: relative, description: z.string().min(1).max(1024), modelInvocation: z.boolean() })).min(1),
  prompts: z.array(z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), path: relative, description: z.string().min(1).max(1024) })).min(1),
  credits: relative, licenses: z.array(z.object({ license: z.string() })).min(1),
  /** Session protocols the pack's texts define (a pack without `continuation` cannot continue a preserved session). */
  capabilities: z.strictObject({ continuation: z.boolean().optional() }).optional(),
  files: z.array(z.object({ path: relative, sha256, change: z.enum(['verbatim', 'adapted', 'factory-own']),
    origin: z.object({ package: z.string(), license: z.string() }).passthrough() })).min(1) });
export type SkillPackManifest = z.infer<typeof manifestSchema>;
export type LoadedSkillPack = { id: SkillPackId; version: string; manifestSha256: string; manifest: SkillPackManifest;
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

/** Exact guest paths of the files of a pack version as seeded (`<guestDirectory>/<manifest path>`, manifest included), from the verified Host copy. */
export async function skillPackGuestFiles(id: SkillPackId): Promise<string[]> {
  const pack = await loadSkillPack(skillPacks[id].directory);
  if (pack.id !== id) throw new Error('WORKER_SKILL_PACK_DRIFT');
  return ['manifest.json', ...pack.manifest.files.map(file => file.path)].map(path => `${skillPacks[id].guestDirectory}/${path}`);
}

/** Verifies the exact file set and every hash against the manifest before anything is offered to the SDK; drift refuses the start. */
export async function loadSkillPack(directory: string = builderSkillPack.directory, expected?: SkillPackId): Promise<LoadedSkillPack> {
  try {
    const bytes = await readFile(join(directory, 'manifest.json'));
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    // Identity and guest location must be exactly those of the declared version (and of the expected one, when given).
    if ((expected !== undefined && manifest.id !== expected) || manifest.guestDirectory !== skillPacks[manifest.id].guestDirectory) throw new Error('WORKER_SKILL_PACK_DRIFT');
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

/** Whether this pack version's texts define the `continue` protocol (spec §5.5: continue a preserved compatible session). */
export async function skillPackContinues(id: SkillPackId): Promise<boolean> {
  const loaded = await loadSkillPack(skillPacks[id].directory, id);
  return loaded.manifest.capabilities?.continuation === true;
}
