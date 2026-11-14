import { createHash, webcrypto } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Diagnostic } from '../contracts/index.js';

/**
 * Self-contained release (spec §11.1/§14, ticket 32): the release tree `releases/<id>/` of a canonical installation root carries
 * `release-manifest.json` with every distributed entry (path/type/mode/size/sha256 or relative link) and the pins of its private
 * Node, runtime dependencies, private SDK profiles, skill packs and the guest assets kept under `assets/guest/<manifest-sha256>/`.
 * The manifest proves INTEGRITY of the distributed set (accidental change/corruption, wrong extraction), not authenticity:
 * there is no signature, and a writer of the tree can rewrite both. Its own SHA-256 is reported so the operator can compare it with
 * the published build report. Integrity is never functional qualification of the runtime or of features not yet integrated.
 */
export const releaseManifestName = 'release-manifest.json';
export const releaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const relativePath = z.string().min(1).max(1024).refine(path => !path.startsWith('/') && !path.includes('\0') &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const mode = z.number().int().min(0).max(0o7777);
const uniquePaths = (entries: readonly (readonly unknown[])[]) =>
  new Set(entries.map(entry => String(entry[0]).toLowerCase())).size === entries.length;
/** `d` directory, `f` regular file (mode, size, sha256), `l` relative symbolic link resolving inside the same tree. */
export type TreeEntry = [string, 'd', number] | [string, 'f', number, number, string] | [string, 'l', string];
const entrySchema = z.union([
  z.tuple([relativePath, z.literal('d'), mode]),
  z.tuple([relativePath, z.literal('f'), mode, z.number().int().nonnegative(), sha256]),
  z.tuple([relativePath, z.literal('l'), z.string().min(1).max(1024).refine(target => !target.startsWith('/') && !target.includes('\0'))]),
]);

/**
 * The production composition this release distributes (ticket 32, deferred by tickets 09/10/12/20 to the release): one fixed worker
 * profile for the three roles, the latest registered Factory skill pack with the continuation capability (derived) and the qualified budgets. Configuration selects
 * nothing else: provider/model per role must name exactly this profile (spec §6.1: explicit, no fallback); anything else is refused.
 */
export const productionProfile = Object.freeze({
  id: 'factory-production-v1',
  sandboxProfile: 'gondolin-qemu-alpine-dev-v1',
  sdkProfileId: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
  gondolinSdkProfileId: 'factory-development-gondolin-0.14.0-stdin-capacity-v1',
  model: Object.freeze({ auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses',
    credential: 'credentials/chatgpt.json (factory login; never copied, read only by the worker native store)' }),
  // The Builder skill pack is derived at composition (latest registered pack with the continuation capability) and recorded in the manifest.
  builder: Object.freeze({ modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 }),
  reviewer: Object.freeze({ modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5 * 1024 * 1024 }),
  // Ticket 13: captures per Builder activation (handoffs + the Host's closing capture); further rounds inside one Execution charge nothing.
  reviewRounds: Object.freeze({ max: 4 }),
  tools: Object.freeze({ builder: ['write', 'bash', 'read', 'edit', 'ask_user', 'handoff'], standards: ['read'], spec: ['read'] }),
  limits: Object.freeze({ socketPathBytes: 107, writeMaxBytes: 8192, editSourceMaxBytes: 8192,
    // `modelBudget` governs request/tool/byte limits only.
    modelBudget: Object.freeze({ builderV1: Object.freeze({ requests: 60, toolCalls: 120 }), reviewerV1: Object.freeze({ requests: 24, toolCalls: 80 }) }),
    providerRetries: 0, sdkRetries: 0,
    // Spec §4.4: the production composition sets NO worker clock deadline. Without a configured repository timeout there is no cut; the
    // optional per-repository `timeoutSeconds` is the only deadline (tickets 19) and this release never invents another.
    deadline: 'not set by production composition; only the optional configured per-repository timeoutSeconds applies' }),
  prompts: Object.freeze({
    builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never push, open pull ' +
      'requests, change GitHub state, request broader access or use another credential. Report blockers instead of working around them. When your proposal is ' +
      'complete, call the handoff tool (alone) for the Factory Standards and Spec reviews and stop; when the results arrive, treat ONLY the findings the results list ' +
      'and follow the skill pack for further rounds (hand off again with your treatments and gates) until the Factory says no new round is needed.',
    standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
      'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
    spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
      'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  }),
});

/** The latest id (registry order) whose pack declares the continuation capability; derived, so a newer registered pack supersedes it. */
export async function latestContinuationPack<T extends string>(ids: readonly T[], continues: (id: T) => Promise<boolean>): Promise<T> {
  for (const id of [...ids].reverse()) if (await continues(id)) return id;
  throw new Error('PRODUCTION_SKILL_PACK_UNAVAILABLE');
}

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('software-factory-release'),
  release: releaseIdSchema,
  builtAt: z.iso.datetime(),
  node: z.strictObject({ version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/), path: z.literal('node/bin/node'), sha256, license: z.literal('node/LICENSE') }),
  launcher: z.strictObject({ path: z.literal('factory'), sha256 }),
  guestAssets: z.strictObject({ path: z.string().regex(/^assets\/guest\/[0-9a-f]{64}$/), manifestSha256: sha256,
    files: z.array(entrySchema).min(1).max(64).refine(uniquePaths, 'Duplicate or case-colliding asset paths') }),
  production: z.strictObject({ id: z.literal(productionProfile.id) }).passthrough(),
  qualification: z.strictObject({ status: z.literal('unqualified'), statement: z.string().min(1).max(4096) }),
  /** Informational pins (source, build tooling, runtime packages/licenses, SDK profiles, assets provenance, build host). */
  metadata: z.record(z.string(), z.unknown()),
  files: z.array(entrySchema).min(1).max(200000).refine(uniquePaths, 'Duplicate or case-colliding paths'),
}).refine(value => value.guestAssets.path === `assets/guest/${value.guestAssets.manifestSha256}`)
  // The pinned guest manifest is itself a distributed file whose recomputed hash must BE the pin (it anchors kernel/initramfs/rootfs).
  .refine(value => value.guestAssets.files.some(entry => entry[0] === 'manifest.json' && entry[1] === 'f' && entry[4] === value.guestAssets.manifestSha256));
export type ReleaseManifest = z.infer<typeof manifestSchema>;

class ReleaseFailure extends Error {
  constructor(readonly code: string, readonly path?: string) { super(code); }
}

/** Root of the running application: the release tree, or the development checkout (compiled `dist/src/entrypoints`). */
export function applicationRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
}

/**
 * Installation root of a running release, by construction only (`<root>/releases/<id>` → `<root>`): never by manifest presence and never
 * from the environment, so a truncated or tampered release still serves exactly its own root.
 */
export function releaseInstallationRoot(): string | undefined {
  return structuralInstallationRoot(applicationRoot());
}

export const developmentMarkerName = 'development-checkout.json';

/** Only an EXPLICIT marker makes a tree a development checkout; anything else without a readable manifest is an invalid release. */
async function explicitDevelopmentCheckout(directory: string): Promise<boolean> {
  try {
    const info = await lstat(join(directory, developmentMarkerName));
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024) return false;
    return (JSON.parse(await readFile(join(directory, developmentMarkerName), 'utf8')) as { kind?: unknown }).kind === 'factory-development-checkout';
  } catch { return false; }
}

/** Root implied by the running application's own location (`<root>/releases/<id>`), independent of any manifest. */
export function structuralInstallationRoot(application: string): string | undefined {
  const parent = dirname(application);
  return basename(parent) === 'releases' && releaseIdSchema.safeParse(basename(application)).success ? dirname(parent) : undefined;
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
async function hashFile(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

/**
 * Exact inventory of a tree: directories, regular files (single link, no group/other write) and relative symbolic links that stay
 * inside the tree. Anything else (absolute or escaping links, devices, sockets, FIFOs, hard links, foreign owner) is refused.
 */
export async function inventoryTree(directory: string, exclude: readonly string[] = [], expected?: readonly TreeEntry[]): Promise<TreeEntry[]> {
  const base = await realpath(directory);
  const uid = process.getuid?.();
  const files: [[string, 'f', number, number, string], string][] = [];
  // Case-insensitive uniqueness: extraction on a case-insensitive filesystem must not merge two distributed entries.
  const seenPaths = new Set<string>();
  // Subdirectories are walked concurrently; each directory returns its entries in sorted order, so the result stays deterministic.
  async function visit(relative: string): Promise<TreeEntry[]> {
    const names = (await readdir(relative ? join(base, relative) : base)).sort(compare)
      .map(name => relative ? `${relative}/${name}` : name).filter(path => !exclude.includes(path));
    const infos = await Promise.all(names.map(path => lstat(join(base, path))));
    const parts = await Promise.all(names.map(async (path, index): Promise<TreeEntry[]> => {
      const absolute = join(base, path), info = infos[index]!;
      if (seenPaths.has(path.toLowerCase())) throw new ReleaseFailure('RELEASE_CASE_COLLISION', path);
      seenPaths.add(path.toLowerCase());
      if (info.uid !== uid) throw new ReleaseFailure('RELEASE_ENTRY_NOT_OWNED', path);
      if ((info.mode & 0o7022) !== 0 && !info.isSymbolicLink()) throw new ReleaseFailure('RELEASE_ENTRY_WRITABLE', path);
      if (info.isDirectory()) return [[path, 'd', info.mode & 0o7777], ...await visit(path)];
      if (info.isFile()) {
        if (info.nlink !== 1) throw new ReleaseFailure('RELEASE_ENTRY_ALIASED', path);
        const entry: [string, 'f', number, number, string] = [path, 'f', info.mode & 0o7777, info.size, ''];
        files.push([entry, absolute]);
        return [entry];
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        const resolved = resolve(dirname(absolute), target);
        const contained = (candidate: string) => candidate === base || candidate.startsWith(base + sep);
        // Lexical containment AND the resolved target: a chain of in-tree links must not end outside (or dangle).
        const real = contained(resolved) ? await realpath(absolute).catch(() => undefined) : undefined;
        if (target.startsWith('/') || !contained(resolved) || real === undefined || !contained(real)) {
          throw new ReleaseFailure('RELEASE_LINK_ESCAPES', path);
        }
        return [[path, 'l', target]];
      }
      throw new ReleaseFailure('RELEASE_ENTRY_UNSUPPORTED', path);
    }));
    return parts.flat();
  }
  const entries = await visit('');
  // Shape first (paths, types, modes, sizes, links): a wrong, extra, missing or re-moded entry fails before any content is read.
  if (expected) {
    const shape = (list: readonly TreeEntry[]) => list.map(entry => entry[1] === 'f' ? entry.slice(0, 4) : entry);
    if (JSON.stringify(shape(entries)) !== JSON.stringify(shape(expected))) throw new ReleaseFailure('RELEASE_INTEGRITY_MISMATCH', firstDifference(shape(entries) as TreeEntry[], shape(expected) as TreeEntry[]));
  }
  // Hash only after the complete shape is known; bounded parallel reads. Files up to 256 MiB (the private Node) are digested off the main thread (WebCrypto
  // thread pool); larger ones are streamed.
  let next = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < files.length) {
      const [entry, absolute] = files[next++]!;
      entry[4] = entry[3] <= 256 * 1024 * 1024 ? Buffer.from(await webcrypto.subtle.digest('SHA-256', await readFile(absolute))).toString('hex') : await hashFile(absolute);
    }
  }));
  return entries;
}

function firstDifference(actual: readonly TreeEntry[], expected: readonly TreeEntry[]): string {
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index++) {
    if (JSON.stringify(actual[index]) !== JSON.stringify(expected[index])) {
      const a = actual[index]?.[0], e = expected[index]?.[0];
      return a === undefined ? e! : e === undefined ? a : compare(a, e) <= 0 ? a : e;
    }
  }
  return '';
}

/** Schema check of manifest bytes; returns the manifest and its SHA-256, or undefined. Not an integrity check of any tree. */
export function parseReleaseManifest(bytes: string | Buffer): { manifest: ReleaseManifest; manifestSha256: string } | undefined {
  try {
    return { manifest: manifestSchema.parse(JSON.parse(bytes.toString('utf8'))), manifestSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return undefined; }
}

export type ReleaseVerification = { kind: 'development' } | { kind: 'invalid'; code: string; path?: string } |
  { kind: 'release'; manifest: ReleaseManifest; manifestSha256: string };

/** Verifies a release tree against its manifest: schema, then the exact inventory (every byte of every distributed file). */
export async function verifyReleaseTree(release: string): Promise<ReleaseVerification> {
  let bytes: Buffer;
  try {
    const info = await lstat(join(release, releaseManifestName));
    if (!info.isFile() || info.nlink !== 1) return { kind: 'invalid', code: 'RELEASE_MANIFEST_UNSAFE' };
    if (info.size > 64 * 1024 * 1024) return { kind: 'invalid', code: 'RELEASE_MANIFEST_TOO_LARGE' };
    bytes = await readFile(join(release, releaseManifestName));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      // Fail closed (static review): a release launcher without its manifest must refuse; only an explicitly marked
      // development checkout (tracked in the repository, never distributed) is development.
      // A marker inside `<root>/releases/<id>` never turns a release into a development checkout: the location decides.
      return structuralInstallationRoot(release) === undefined && await explicitDevelopmentCheckout(release) ? { kind: 'development' }
        : { kind: 'invalid', code: 'RELEASE_MANIFEST_MISSING' };
    }
    return { kind: 'invalid', code: 'RELEASE_MANIFEST_UNREADABLE' };
  }
  let manifest: ReleaseManifest;
  try { manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { return { kind: 'invalid', code: 'RELEASE_MANIFEST_INVALID' }; }
  try {
    const actual = await inventoryTree(release, [releaseManifestName], manifest.files);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
      return { kind: 'invalid', code: 'RELEASE_INTEGRITY_MISMATCH', path: firstDifference(actual, manifest.files) };
    }
  } catch (error) {
    return error instanceof ReleaseFailure ? { kind: 'invalid', code: error.code, ...(error.path ? { path: error.path } : {}) }
      : { kind: 'invalid', code: 'RELEASE_TREE_UNREADABLE' };
  }
  return { kind: 'release', manifest, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
}

const nextStep = 'Extract the published archive unchanged (tar -xpkf) into a new canonical installation root and compare the manifest SHA-256 with the build report; never edit or repair a release in place.';
export type ReleaseView = { release: string; manifestSha256: string; node: string; production: string; guestAssets: { path: string; manifestSha256: string };
  qualification: ReleaseManifest['qualification']; metadata: ReleaseManifest['metadata'] };

async function privateDirectory(path: string) {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch { return false; }
}

/**
 * Release facts of the running application for one installation root (doctor and controller bootstrap). Every distributed byte is
 * re-hashed here (the manifest is a claim to verify), including the guest assets, before storage is opened. Development checkouts carry
 * no release: no pinned assets, no execution composition.
 */
export async function inspectRelease(installationRoot: string): Promise<{
  release: ReleaseView | null; guestAssets?: { directory: string; manifestSha256: string }; checks: Diagnostic[] }> {
  const application = await realpath(applicationRoot());
  const verification = await verifyReleaseTree(application);
  if (verification.kind === 'development') {
    return { release: null, checks: [{ id: 'release', status: 'unverified',
      message: 'Development checkout: not a distributed release (no release manifest, private Node or pinned guest assets); execution is not composed.',
      nextStep: 'Build, extract and verify a self-contained release; a development checkout is not an operator installation.' }] };
  }
  if (verification.kind === 'invalid') {
    return { release: null, checks: [{ id: 'release:integrity', status: 'blocked',
      message: `${verification.code}${verification.path ? ` at ${verification.path}` : ''}; the release does not match its manifest.`, nextStep }] };
  }
  const { manifest, manifestSha256 } = verification;
  const root = await realpath(installationRoot).catch(() => resolve(installationRoot));
  const checks: Diagnostic[] = [{ id: 'release:integrity', status: 'ok',
    message: `Release ${manifest.release}: all ${manifest.files.length} distributed entries match manifest ${manifestSha256}. Integrity only, not authenticity or qualification.`, nextStep }];
  const located = application === join(root, 'releases', manifest.release);
  checks.push({ id: 'release:location', status: located ? 'ok' : 'blocked',
    message: located ? 'Release lives in releases/<id> of this canonical installation root.' : 'The running release is not releases/<id> of this installation root.',
    nextStep: 'Run the installation launcher of this root; a release is not relocated by copy and never serves another root.' });
  let selected = false;
  try {
    const info = await lstat(join(root, manifest.launcher.path));
    selected = info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o022) === 0 &&
      await hashFile(join(root, manifest.launcher.path)) === manifest.launcher.sha256;
  } catch { /* Missing or unreadable launcher: not selected. */ }
  checks.push({ id: 'release:selected', status: selected ? 'ok' : 'blocked',
    message: selected ? `<root>/factory explicitly selects release ${manifest.release}.` : `<root>/factory does not select release ${manifest.release}.`,
    nextStep: 'Selection is explicit: only the launcher shipped with a release selects it; no discovery or implicit switch.' });
  const node = process.execPath === join(application, manifest.node.path) && process.versions.node === manifest.node.version;
  checks.push({ id: 'release:node', status: node ? 'ok' : 'blocked',
    message: node ? `Private Node ${manifest.node.version} of the release is running.` : 'The running Node is not the private Node of this release.',
    nextStep: 'Use the installation launcher; the host Node or a personal version manager is never used by a release.' });
  for (const name of ['releases', 'assets']) {
    const safe = await privateDirectory(join(root, name));
    checks.push({ id: `permissions:${name}`, status: safe ? 'ok' : 'blocked',
      message: safe ? 'Account-owned private directory.' : 'Missing, non-private, non-owned or symlinked directory.',
      nextStep: 'Administrator must inspect the named installation directory; no recursive chmod or automatic repair.' });
  }
  const directory = join(root, manifest.guestAssets.path);
  let status: Diagnostic['status'] = 'blocked', message = 'Guest assets of this release are missing or differ from the release manifest.';
  try {
    // Every asset file is re-hashed from its bytes; the manifest hash is never copied as evidence.
    const actual = await inventoryTree(directory, [], manifest.guestAssets.files);
    message = JSON.stringify(actual) === JSON.stringify(manifest.guestAssets.files)
      ? `Guest assets ${manifest.guestAssets.manifestSha256} preserved exactly as distributed (no boot performed).`
      : `RELEASE_INTEGRITY_MISMATCH at ${manifest.guestAssets.path}/${firstDifference(actual, manifest.guestAssets.files)}`;
    status = message.startsWith('Guest assets') ? 'ok' : 'blocked';
  } catch (error) {
    // Name the divergent path/code; the manifest hash is never used as evidence of content.
    const failure = error as { code?: unknown; path?: unknown };
    if (typeof failure.code === 'string') message = `${failure.code}${typeof failure.path === 'string' ? ` at ${failure.path}` : ''}`;
  }
  checks.push({ id: 'release:assets', status, message,
    nextStep: 'Assets are preserved while dependent disks exist; never rebuild, download or replace them in place.' });
  checks.push({ id: 'release:qualification', status: 'unverified', message: manifest.qualification.statement,
    nextStep: 'Qualify the final composition with the separately authorized real groups; checksums and build success are not qualification.' });
  return { release: { release: manifest.release, manifestSha256, node: manifest.node.version, production: manifest.production.id,
    guestAssets: { path: manifest.guestAssets.path, manifestSha256: manifest.guestAssets.manifestSha256 }, qualification: manifest.qualification,
    metadata: manifest.metadata },
  guestAssets: { directory, manifestSha256: manifest.guestAssets.manifestSha256 }, checks };
}

/** Exact configured provider/model of every role against the release's single production worker profile (no fallback). */
export function productionModelChecks(models: Record<'builder' | 'standards' | 'spec', { provider: string; model: string }>): Diagnostic[] {
  return (['builder', 'standards', 'spec'] as const).map(role => {
    const supported = models[role].provider === productionProfile.model.providerId && models[role].model === productionProfile.model.modelId;
    return { id: `worker-profile:${role}`, status: supported ? 'ok' as const : 'blocked' as const,
      message: supported ? `Supported by ${productionProfile.sdkProfileId} (${productionProfile.model.auth}); model access not tested offline.`
        : `This release supports only provider ${productionProfile.model.providerId} with model ${productionProfile.model.modelId} for every role.`,
      nextStep: 'Configure the supported provider/model explicitly per role; no default, inheritance or silent fallback exists.' };
  });
}
