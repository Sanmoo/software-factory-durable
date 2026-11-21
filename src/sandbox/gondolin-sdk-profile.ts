import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Closed, offline preparation only. No SDK runtime import, loader, VM or Workers dependency.
export const gondolinSdkProfile = Object.freeze({
  id: 'factory-development-gondolin-0.14.0-stdin-capacity-v1',
  directory: '.scratch/factory-development-gondolin-v1',
  version: '0.14.0',
  integrity: 'sha512-MSw+EGcqFJeyKHdXEfm+nMRr74ytT4x8DGIohav0oPCHeVQAB9AajquM94cv2xqvIU3VDAaZZVC07IXsOY6OVQ==',
  provenanceSHA256: 'a2159d649ab9ee947ffb87c0f11a046df4653d4bb17b873844af476469137a3d',
  patchSHA256: '441621ba414e419cae9715e3ffbfa3059d4048247972515db8db4cf3cfdcca88',
  patchManifestSHA256: '2ec5805fbbdc9badcf6e0bd52720e3c5a47e8a927f3b41bbe1e3d7feb448d1c8',
});
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value) + '\n';
function deny(reason: string): never {
  throw new Error(`GONDOLIN_${reason}`);
}
function parse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return deny('INVALID_JSON');
  }
}
function comparePaths(a: string, b: string) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
type Entry = [string, 'directory'] | [string, 'file', string, number, number];
interface Provenance {
  candidateHead: string;
  sdkCodeCommit: string;
  original133SHA256: string;
  licenseSHA256: string;
  original: Entry[];
  copied: Entry[];
  originalTreeSHA256: string;
  copiedTreeSHA256: string;
  dependencies: { name: string; version: string; integrity: string; packageSHA256: string }[];
}
interface Correction {
  path: string;
  beforeSha256: string | null;
  afterSha256: string;
  afterBytes: number;
}

/** Refuse links (including ancestor links), foreign ownership, writable shared paths and hard links. */
async function checked(path: string, type: 'file' | 'directory') {
  const info = await lstat(path);
  if (
    (await realpath(path)) !== path ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o7022 ||
    (type === 'file' ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
  )
    deny('UNSAFE_PATH');
  return info;
}
async function directoryChain(base: string, relative: string) {
  let path = base;
  for (const name of relative.split('/')) {
    path = join(path, name);
    await checked(path, 'directory');
  }
}
async function bytes(path: string) {
  await checked(path, 'file');
  return readFile(path);
}
// Specific distribution inventory, not an executable closure or guest-asset inventory.
async function inventory(root: string, expected: Entry[]): Promise<Entry[]> {
  const entries: Entry[] = [],
    allowed = new Map(expected.map(entry => [entry[0], entry]));
  async function visit(relative: string): Promise<void> {
    const entry = allowed.get(relative);
    if (!entry) deny('TREE_SHAPE'); // Never open/hash unknown files or descend into unknown directories.
    const path = join(root, relative),
      info = await lstat(path);
    if (info.isDirectory()) {
      // Every directory in this exact published distribution is mode0755 (private parent is0700).
      if (entry[1] !== 'directory' || (info.mode & 0o7777) !== 0o755) deny('TREE_SHAPE');
      await checked(path, 'directory');
      entries.push([relative, 'directory']);
      for (const name of (await readdir(path)).sort(comparePaths)) await visit(relative ? `${relative}/${name}` : name);
    } else {
      await checked(path, 'file');
      if (entry[1] !== 'file' || info.size !== entry[3] || (info.mode & 0o7777) !== entry[4]) deny('TREE_SHAPE');
      entries.push([relative, 'file', '', info.size, info.mode & 0o7777]);
    }
  }
  await visit('');
  if (entries.length !== expected.length) deny('TREE_SHAPE');
  // Validate the complete path/type/size/mode inventory before reading any distribution bytes.
  for (const entry of entries) if (entry[1] === 'file') entry[2] = sha(await bytes(join(root, entry[0])));
  return entries.sort((a, b) => comparePaths(a[0], b[0]));
}
async function context(project: string) {
  const base = resolve(project);
  await checked(base, 'directory');
  const dependencies = join(base, 'node_modules');
  await checked(dependencies, 'directory');
  const source = join(dependencies, '@earendil-works/gondolin');
  await directoryChain(dependencies, '@earendil-works/gondolin');
  const lock = parse((await bytes(join(base, 'package-lock.json'))).toString());
  const pin = lock.packages?.['node_modules/@earendil-works/gondolin'];
  const pkg = parse((await bytes(join(source, 'package.json'))).toString());
  if (
    pin?.version !== gondolinSdkProfile.version ||
    pin?.integrity !== gondolinSdkProfile.integrity ||
    pkg.name !== '@earendil-works/gondolin' ||
    pkg.version !== gondolinSdkProfile.version ||
    pkg.license !== 'Apache-2.0'
  )
    deny('SOURCE_PIN');
  const data = join(base, 'docs/evidence/gondolin-sdk-v1');
  await directoryChain(base, 'docs/evidence/gondolin-sdk-v1');
  const provenanceBytes = await bytes(join(data, 'provenance.data'));
  if (sha(provenanceBytes) !== gondolinSdkProfile.provenanceSHA256) deny('PROVENANCE_PIN');
  const provenance: Provenance = parse(provenanceBytes.toString());
  const manifestBytes = await bytes(join(data, 'patch-manifest.data'));
  if (
    sha(manifestBytes) !== gondolinSdkProfile.patchManifestSHA256 ||
    sha(await bytes(join(data, 'native-stdin.patch'))) !== gondolinSdkProfile.patchSHA256 ||
    sha(await bytes(join(data, 'original-133.data'))) !== provenance.original133SHA256 ||
    sha(await bytes(join(data, 'LICENSE'))) !== provenance.licenseSHA256
  )
    deny('CANDIDATE_PIN');
  const corrections: Correction[] = parse(manifestBytes.toString()).files;
  if (corrections.length !== 9 || corrections.filter(file => file.beforeSha256 === null).length !== 2) deny('CANDIDATE_COUNT');
  const corrected = new Map<string, Buffer>();
  for (const file of corrections) {
    // Manifest bytes are pinned above; no untrusted path/patch interpreter.
    await directoryChain(data, `corrected/${dirname(file.path)}`);
    const content = await bytes(join(data, 'corrected', `${file.path}.data`));
    if (
      content.length !== file.afterBytes ||
      sha(content) !== file.afterSha256 ||
      (provenance.original.find(entry => entry[0] === file.path)?.[2] ?? null) !== file.beforeSha256 ||
      provenance.copied.find(entry => entry[0] === file.path)?.[2] !== file.afterSha256
    )
      deny('CORRECTED_PIN');
    corrected.set(file.path, content);
  }
  if (
    sha(json(provenance.original)) !== provenance.originalTreeSHA256 ||
    sha(json(provenance.copied)) !== provenance.copiedTreeSHA256 ||
    json(await inventory(source, provenance.original)) !== json(provenance.original)
  )
    deny('SOURCE_TREE');
  for (const dep of provenance.dependencies) {
    const pin = lock.packages?.[`node_modules/${dep.name}`];
    await directoryChain(dependencies, dep.name);
    const metadata = await bytes(join(dependencies, dep.name, 'package.json'));
    const pkg = parse(metadata.toString());
    if (
      pin?.version !== dep.version ||
      pin?.integrity !== dep.integrity ||
      pkg.name !== dep.name ||
      pkg.version !== dep.version ||
      sha(metadata) !== dep.packageSHA256
    )
      deny('DEPENDENCY_PIN');
  }
  await checked(join(base, '.scratch'), 'directory');
  const staging = join(base, gondolinSdkProfile.directory);
  const evidence = {
    ...gondolinSdkProfile,
    candidateHead: provenance.candidateHead,
    sdkCodeCommit: provenance.sdkCodeCommit,
    original133SHA256: provenance.original133SHA256,
    originalInventoryCount: 133,
    originalTreeSHA256: provenance.originalTreeSHA256,
    copiedTreeSHA256: provenance.copiedTreeSHA256,
    originalFiles: 407,
    copiedFiles: 409,
    modifiedFiles: 7,
    addedFiles: 2,
    license: 'Apache-2.0',
    licenseSHA256: provenance.licenseSHA256,
    dependencies: provenance.dependencies,
    dependencyLink: dependencies,
    dependencyUsage: 'Existing canonical node_modules linked for future read-only usage; not a filesystem write barrier or dependency execution audit.',
    scope: 'Private preparation only; NO RUNTIME SWITCH. Future consumer must verify before effects. No guest/lifecycle qualification.',
  };
  return { source, staging, dependencies, provenance, corrected, evidence };
}

/** Release form (ticket 32): the same canonical dependency directory through this exact relative link, so an extracted release
 * verifies at its own canonical path; the development form keeps the absolute link. No other spelling or target is accepted. */
const releaseDependencyLink = '../../node_modules';
type DependencyLink = 'absolute' | 'relative';

async function verifyPrepared(ctx: Awaited<ReturnType<typeof context>>) {
  const { staging, dependencies, provenance } = ctx;
  if (((await checked(staging, 'directory')).mode & 0o777) !== 0o700) deny('ROOT_MODE');
  if (json((await readdir(staging)).sort(comparePaths)) !== json(['node_modules', 'profile.json', 'sdk'])) deny('ROOT_DRIFT');
  const link = join(staging, 'node_modules'),
    info = await lstat(link);
  // Sole allowed escaping symlink: exact canonical installed dependency directory, never followed during SDK inventory.
  const target = info.isSymbolicLink() ? await readlink(link) : undefined;
  if (
    !info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (target !== dependencies && target !== releaseDependencyLink) ||
    (await realpath(link)) !== dependencies
  )
    deny('DEPENDENCY_LINK');
  const evidence = { ...ctx.evidence, dependencyLink: target };
  if (json(await inventory(join(staging, 'sdk'), provenance.copied)) !== json(provenance.copied)) deny('COPY_TREE');
  const record = join(staging, 'profile.json');
  if (((await checked(record, 'file')).mode & 0o777) !== 0o600 || (await bytes(record)).toString() !== json(evidence)) deny('PROFILE_DRIFT');
  return evidence;
}

/** Must be called by any future binding before effects; never prepares, repairs or falls back. */
export async function verifyDevelopmentGondolinSdk(project = process.cwd()) {
  return verifyPrepared(await context(project));
}

/** Offline, explicit preparation. Existing/incomplete/drifted roots are never repaired or removed. */
export async function prepareDevelopmentGondolinSdk(project = process.cwd(), { dependencyLink = 'absolute' }: { dependencyLink?: DependencyLink } = {}) {
  const ctx = await context(project);
  try {
    await mkdir(ctx.staging, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return verifyPrepared(ctx);
  }
  // Only the newly created owned root is written. Failure intentionally leaves a refused incomplete root.
  if (((await checked(ctx.staging, 'directory')).mode & 0o777) !== 0o700) deny('ROOT_MODE');
  await cp(ctx.source, join(ctx.staging, 'sdk'), { recursive: true, force: false, errorOnExist: true });
  for (const [relative, content] of ctx.corrected) {
    const target = join(ctx.staging, 'sdk', relative);
    await checked(dirname(target), 'directory');
    const existed = ctx.provenance.original.some(entry => entry[0] === relative);
    if (existed) await checked(target, 'file');
    await writeFile(target, content, { flag: existed ? 'w' : 'wx', mode: 0o644 });
  }
  if (json(await inventory(ctx.source, ctx.provenance.original)) !== json(ctx.provenance.original)) deny('SOURCE_TREE');
  const link = dependencyLink === 'relative' ? releaseDependencyLink : ctx.dependencies;
  await symlink(link, join(ctx.staging, 'node_modules'));
  await writeFile(join(ctx.staging, 'profile.json'), json({ ...ctx.evidence, dependencyLink: link }), { mode: 0o600, flag: 'wx' });
  return verifyPrepared(ctx);
}
/** Release preparation (ticket 32) of the SAME pinned profile inside a release tree being assembled: relative dependency link. */
export async function prepareReleaseGondolinSdk(release: string) {
  return prepareDevelopmentGondolinSdk(release, { dependencyLink: 'relative' });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('dist/src/sandbox/gondolin-sdk-profile.js')) {
  process.stdout.write(json(await prepareDevelopmentGondolinSdk()));
}
