import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { arch, platform, release as kernelRelease } from 'node:os';
import { pathToFileURL } from 'node:url';
import { protocolVersion } from '../protocol/index.js';
import { controlStorageCompatibility, factorySkillPackIds } from '../contracts/index.js';
import { createSandbox, prepareReleaseGondolinSdk, verifyGondolinSdk, gondolinSdkProfile } from '../sandbox/index.js';
import { configurationSchemaVersions } from './configuration.js';
import { applicationRoot, inventoryTree, latestContinuationPack, parseReleaseManifest, productionProfile, releaseIdSchema, releaseLauncher, releaseManifestName, verifyReleaseTree, type TreeEntry } from './release.js';

/**
 * DEVELOPMENT BUILD TOOL (ticket 32), never run on the operator host. Assembles a self-contained release from an already built and
 * prepared development checkout (`tsc` output and verified private SDK profiles): emitted JavaScript only, the runtime dependency
 * closure of the lockfile, the private Node, the private SDK profiles, the Factory skill packs and the pinned guest assets, plus a manifest
 * of every entry. No bundler, TypeScript runner, `npm install` or download: everything is copied from pinned, verified local inputs.
 * The archive is produced by the host `tar` (POSIX format, sorted, normalized owner/mtime). Output is an exclusive new directory.
 */
const run = promisify(execFile);
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function fail(code: string): never { throw new Error(code); }
const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };

/** Copies a tree preserving permission bits (never setuid/setgid/sticky), relative in-tree links only; refuses other entry types. */
export async function copyTree(source: string, target: string, accept: (relative: string, directory: boolean) => boolean = () => true, relative = ''): Promise<void> {
  const from = relative ? join(source, relative) : source, to = relative ? join(target, relative) : target;
  const info = await lstat(from);
  if (info.isDirectory()) {
    await mkdir(to, { mode: 0o700 });
    for (const name of (await readdir(from)).sort(compare)) {
      const child = relative ? `${relative}/${name}` : name;
      const childInfo = await lstat(join(source, child));
      if (accept(child, childInfo.isDirectory())) await copyTree(source, target, accept, child);
    }
    await chmod(to, info.mode & 0o777 & ~0o022);
  } else if (info.isFile()) {
    await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(to, info.mode & 0o777 & ~0o022);
  } else if (info.isSymbolicLink()) {
    const link = await readlink(from);
    // The copy keeps the relative link; containment is decided on the RESOLVED target, never on its lexical spelling.
    const real = isAbsolute(link) ? undefined : await realpath(from).catch(() => undefined);
    const base = await realpath(source);
    if (real === undefined || !(real === base || real.startsWith(base + '/')) || isAbsolute(link)) fail('RELEASE_SOURCE_LINK_ESCAPES');
    await symlink(link, to);
  } else fail('RELEASE_SOURCE_ENTRY_UNSUPPORTED');
}

type LockPackage = { version?: string; integrity?: string; license?: string; dev?: boolean; optional?: boolean; hasInstallScript?: boolean;
  os?: string[]; cpu?: string[];
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }> };
const sdkPackage = 'node_modules/@earendil-works/pi-coding-agent';
/** npm `os`/`cpu` semantics: a list of allowed values, or of `!`-negated excluded values. */
function excludedBy(list: readonly string[] | undefined, value: string) {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some(item => item.startsWith('!')) ? list.includes(`!${value}`) : !list.includes(value);
}

/** Runtime closure from the lockfile (Node resolution order): production dependencies plus the private SDK profile's dependencies.
 * The SDK package itself is replaced by its verified private copy (which carries its own nested dependencies). */
export type OmittedEdge = { from: string; dependency: string; reason: 'platform-excluded' | 'optional-peer' };
const upstreamSdkName = '@earendil-works/pi-coding-agent';
export async function runtimeClosure(project: string) {
  const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8')) as { lockfileVersion: number; packages: Record<string, LockPackage> };
  if (lock.lockfileVersion !== 3) fail('RELEASE_LOCKFILE_UNSUPPORTED');
  const packages = lock.packages;
  const present = async (key: string) => lstat(join(project, key)).then(info => info.isDirectory(), () => false);
  const locate = (from: string, name: string) => {
    for (let base = from; ; base = base.slice(0, Math.max(0, base.lastIndexOf('/node_modules/')))) {
      const key = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (packages[key]) return key;
      if (!base) return undefined;
    }
  };
  // The upstream SDK identity, wherever it appears: a renamed/nested copy would load unpatched code.
  const identity = async (key: string) => {
    try {
      const manifest = JSON.parse(await readFile(join(project, key, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === upstreamSdkName && key !== sdkPackage) fail('RELEASE_SDK_UPSTREAM_REQUIRED');
    } catch (error) { if (error instanceof Error && error.message === 'RELEASE_SDK_UPSTREAM_REQUIRED') throw error; fail('RELEASE_DEPENDENCY_MANIFEST_INVALID'); }
  };
  const seen = new Set<string>();
  const omitted: OmittedEdge[] = [];
  const visit = async (key: string): Promise<void> => {
    if (seen.has(key)) return;
    seen.add(key);
    await identity(key);
    const entry = packages[key]!;
    for (const [names, kind] of [[entry.dependencies, 'required'], [entry.optionalDependencies, 'optional'],
      [entry.peerDependencies, 'peer']] as const) {
      for (const name of Object.keys(names ?? {})) {
        const optionalPeer = kind === 'peer' && entry.peerDependenciesMeta?.[name]?.optional === true;
        const found = locate(key, name);
        if (!found) {
          // Optional peers are normally not installed; anything else without a lock entry would need shipping and is refused.
          if (optionalPeer) { omitted.push({ from: key, dependency: name, reason: 'optional-peer' }); continue; }
          fail('RELEASE_DEPENDENCY_MISSING');
        }
        const target = packages[found]!;
        if (!await present(found)) {
          // An optional peer is never required: shipped when installed, genuinely omitted when the lock names it but it is absent.
          if (optionalPeer) { omitted.push({ from: key, dependency: name, reason: 'optional-peer' }); continue; }
          // Only an optional package whose os/cpu gate EXCLUDES this build platform is legitimately absent; every other missing edge
          // (including an optional package this platform could install) is an incomplete closure.
          const gated = (kind === 'optional' || target.optional === true) && (excludedBy(target.os, platform()) || excludedBy(target.cpu, arch()));
          if (gated) { omitted.push({ from: key, dependency: name, reason: 'platform-excluded' }); continue; }
          fail('RELEASE_DEPENDENCY_MISSING');
        }
        await visit(found);
      }
    }
  };
  for (const name of Object.keys(packages['']?.dependencies ?? {})) await visit(locate('', name) ?? fail('RELEASE_DEPENDENCY_MISSING'));
  // The private SDK profile is prepared before the build; its package must be present for the closure to be complete.
  if (!await present(sdkPackage)) fail('RELEASE_DEPENDENCY_MISSING');
  await visit(sdkPackage);
  const keys = [...seen].filter(key => key !== sdkPackage && !key.startsWith(`${sdkPackage}/`)).sort(compare);
  // The private SDK copy ships the upstream package's own nested dependencies; they are accounted relative to that copy.
  const sdkKeys = [...seen].filter(key => key.startsWith(`${sdkPackage}/`)).map(key => key.slice(sdkPackage.length + 1)).sort(compare);
  return { lockfileSha256: sha(await readFile(join(project, 'package-lock.json'))), keys, sdkKeys, packages, omitted: omitted.sort((a, b) => compare(`${a.from}/${a.dependency}`, `${b.from}/${b.dependency}`)), sdk: packages[sdkPackage]! };
}

/** The skill-pack directory holds exactly the registered ids (no extra, missing or unregistered pack), each passing `verify`. */
export async function verifySkillPackRegistry<T extends string>(directory: string, ids: readonly T[], verify: (id: T) => Promise<void>) {
  const present = (await readdir(directory)).sort(compare);
  if (JSON.stringify(present) !== JSON.stringify([...ids].sort(compare))) fail('RELEASE_SKILL_PACKS_DRIFT');
  for (const id of ids) await verify(id);
}

/** A shipped dependency tree: `root` (release-relative, '' for the top level) holds `node_modules`; `keys` are lock keys relative to it. */
export type ShippedClosure = { root: string; keys: readonly string[] };

/** Release-relative paths under a `node_modules` segment that no package of the computed closures owns (pure; sorted, at most 32). */
export function unaccountedShippedPaths(entries: readonly TreeEntry[], closures: readonly ShippedClosure[], links: readonly string[] = []): string[] {
  const within = (root: string, path: string) => root === '' ? path : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  // A file or directory of the deepest owning package that is not inside another (unaccounted) nested node_modules.
  const owned = (keys: readonly string[], relative: string) => {
    const owner = keys.filter(key => relative.startsWith(`${key}/`)).sort((x, y) => y.length - x.length)[0];
    return owner !== undefined && !relative.slice(owner.length + 1).split('/').includes('node_modules');
  };
  // npm bin links: `node_modules/.bin` of a closure root or of a package's nested node_modules, whose links point into an owned package file.
  const binDirectory = (keys: readonly string[], relative: string) =>
    relative === 'node_modules/.bin' || keys.some(key => relative === `${key}/node_modules/.bin`);
  const unaccounted: string[] = [];
  for (const entry of entries) {
    const path = entry[0];
    if (!path.split('/').includes('node_modules')) continue;
    if (entry[1] === 'l' && links.includes(path)) continue; // An explicitly allowed dependency link (verified by its own profile).
    const closure = closures.filter(candidate => {
      const relative = within(candidate.root, path);
      return relative !== undefined && (relative === 'node_modules' || relative.startsWith('node_modules/'));
    }).sort((x, y) => y.root.length - x.root.length)[0];
    const relative = closure ? within(closure.root, path) : undefined;
    if (closure === undefined || relative === undefined) { unaccounted.push(path); continue; }
    const { keys } = closure;
    const accounted = keys.includes(relative) || owned(keys, relative) ||
      // A directory leading to a package (`node_modules` itself, a scope, a parent's nested `node_modules`) or an npm bin directory.
      (entry[1] === 'd' && (relative === 'node_modules' || keys.some(key => key.startsWith(`${relative}/`)) || binDirectory(keys, relative))) ||
      (entry[1] === 'l' && binDirectory(keys, dirname(relative)) && owned(keys, posix.normalize(posix.join(dirname(relative), entry[2]))));
    if (!accounted) unaccounted.push(path);
  }
  return unaccounted.sort(compare).slice(0, 32);
}

/**
 * Every shipped entry under a `node_modules` path belongs to a package of the computed closure, and no shipped package declares the upstream
 * SDK identity (`name` in any package.json below node_modules): the upstream SDK is only ever loaded as its verified private copy.
 */
export async function verifyShippedPackages(release: string, entries: readonly TreeEntry[], closures: readonly ShippedClosure[], links: readonly string[] = []) {
  const unaccounted = unaccountedShippedPaths(entries, closures, links);
  if (unaccounted.length > 0) fail(`RELEASE_UNACCOUNTED_PACKAGE ${unaccounted[0]}`);
  for (const entry of entries) {
    if (entry[1] !== 'f' || basename(entry[0]) !== 'package.json' || !entry[0].split('/').includes('node_modules')) continue;
    let name: unknown;
    try { name = (JSON.parse(await readFile(join(release, entry[0]), 'utf8')) as { name?: unknown }).name; } catch { continue; } // Not a manifest.
    if (name === upstreamSdkName) fail('RELEASE_SDK_UPSTREAM_REQUIRED');
  }
}

async function licenseFiles(directory: string) {
  return (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)/i.test(name)).sort(compare);
}

function hostVersion(command: string) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, env: environment });
  return result.status === 0 ? result.stdout.split('\n')[0]?.slice(0, 200) ?? null : null;
}

async function osRelease() {
  const text = await readFile('/etc/os-release', 'utf8').catch(() => '');
  return Object.fromEntries(text.split('\n').map(line => line.match(/^(ID|VERSION_ID|BUILD_ID|PRETTY_NAME)=("?)([^"]*)\2$/))
    .filter(match => match !== null).map(match => [match[1], match[3]]));
}

const launcher = releaseLauncher;

const privateSdk = '.scratch/factory-development-sdk-v3', privateSdkSdk = `${privateSdk}/sdk`;
export type BuildInput = { release: string; output: string; guestAssets: { directory: string; manifestSha256: string }; nodeHome?: string };

export async function buildRelease(input: BuildInput) {
  const id = releaseIdSchema.parse(input.release);
  const output = resolve(input.output);
  // Never adopt an existing output directory (not even an empty one): a build starts from an absent path it creates exclusively.
  const existing = await lstat(output).catch(() => undefined);
  if (existing) throw new Error('RELEASE_OUTPUT_EXISTS');
  const project = await realpath(applicationRoot());
  if ((await verifyReleaseTree(project)).kind !== 'development') fail('RELEASE_SOURCE_NOT_DEVELOPMENT');
  const packageJson = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as { name: string; version: string; type: string;
    engines: { node: string; npm: string }; packageManager: string; dependencies: Record<string, string>; imports: Record<string, unknown> };
  if (process.versions.node !== packageJson.engines.node) fail('RELEASE_NODE_NOT_PINNED');
  const nodeHome = await realpath(input.nodeHome ?? dirname(dirname(process.execPath)));
  if (await realpath(join(nodeHome, 'bin/node')) !== await realpath(process.execPath)) fail('RELEASE_NODE_HOME_MISMATCH');
  // Inputs verified BEFORE any output: private SDK profiles (closed verifiers) and the explicit guest asset pin.
  const sdkEvidence = JSON.parse((await run(process.execPath, [join(project, 'dist/src/workers/sdk-profile.js')], { cwd: project, env: environment, timeout: 60000,
    maxBuffer: 1024 * 1024 })).stdout) as Record<string, unknown>;
  if (sdkEvidence.id !== productionProfile.sdkProfileId) fail('RELEASE_SDK_PROFILE_MISMATCH');
  const gondolinDevelopment = await verifyGondolinSdk(project);
  if (gondolinDevelopment.id !== productionProfile.gondolinSdkProfileId) fail('RELEASE_GONDOLIN_PROFILE_MISMATCH');
  const assetsSource = await realpath(input.guestAssets.directory);
  const assetChecks = (await createSandbox({ root: project, guestAssets: { directory: assetsSource, manifestSha256: input.guestAssets.manifestSha256 } })
    .validate(undefined)).checks.filter(check => check.id.startsWith('guest-assets'));
  if (assetChecks.length !== 4 || assetChecks.some(check => check.status !== 'ok')) fail('RELEASE_GUEST_ASSETS_INVALID');
  const git = async (...args: string[]) => (await run('git', args, { cwd: project, env: environment, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  const source = { commit: await git('rev-parse', 'HEAD'), commitTime: await git('log', '-1', '--format=%cI'),
    dirty: (await git('status', '--porcelain', '--untracked-files=normal')).length > 0 };
  const closure = await runtimeClosure(project);

  // Exclusive output: created here, never adopted or overwritten.
  await mkdir(output, { mode: 0o700 }).catch((error: unknown) => {
    // A path that appeared after the early check is still refused with the same explicit code, never adopted.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') fail('RELEASE_OUTPUT_EXISTS');
    throw error;
  });
  if (await realpath(output) !== output) fail('RELEASE_OUTPUT_NOT_CANONICAL');
  const payload = join(output, 'payload');
  const releaseDirectory = join(payload, 'releases', id);
  const assetsDirectory = join(payload, 'assets', 'guest', input.guestAssets.manifestSha256);
  for (const directory of [payload, join(payload, 'releases'), join(payload, 'assets'), join(payload, 'assets', 'guest')]) await mkdir(directory, { mode: 0o700 });
  await mkdir(releaseDirectory, { mode: 0o700 });
  await mkdir(join(releaseDirectory, 'dist'), { mode: 0o755 });
  // Emitted JavaScript only: no TypeScript sources, declarations, maps or compiled tests.
  await copyTree(join(project, 'dist/src'), join(releaseDirectory, 'dist/src'), (path, directory) => directory || path.endsWith('.js'));
  await mkdir(join(releaseDirectory, 'assets'), { mode: 0o755 });
  // Exactly the registered Factory skill packs (factorySkillPackIds): no extra or missing pack, each manifest declaring its own id. Their bytes are
  // inventoried by the release manifest and verified by the Workers pack loader before any use; the production pack is the same derivation.
  const packManifest = async (id: string) => {
    const parsed = JSON.parse(await readFile(join(project, 'assets/skill-pack', id, 'manifest.json'), 'utf8')) as { id?: unknown; capabilities?: { continuation?: unknown } };
    if (parsed.id !== id) fail('RELEASE_SKILL_PACKS_DRIFT');
    return parsed;
  };
  await verifySkillPackRegistry(join(project, 'assets/skill-pack'), factorySkillPackIds, async id => { await packManifest(id); });
  await copyTree(join(project, 'assets/skill-pack'), join(releaseDirectory, 'assets/skill-pack'));
  // v2 ticket 02 (V2-31): the account template the Operator applies for a Lambda installation. Distributed, never applied by the Factory.
  await copyTree(join(project, 'assets/lambda'), join(releaseDirectory, 'assets/lambda'));
  const builderSkillPack = await latestContinuationPack(factorySkillPackIds, async id => (await packManifest(id)).capabilities?.continuation === true);
  await mkdir(join(releaseDirectory, '.scratch'), { mode: 0o755 });
  await copyTree(join(project, privateSdk), join(releaseDirectory, privateSdk));
  for (const directory of ['docs', 'docs/evidence', 'provenance']) await mkdir(join(releaseDirectory, directory), { mode: 0o755 });
  await copyTree(join(project, 'docs/evidence/gondolin-sdk-v1'), join(releaseDirectory, 'docs/evidence/gondolin-sdk-v1'));
  for (const file of ['05-sdk-read-operations-candidate.patch', '05-sdk-async-bash-v2.patch', '05-sdk-lexical-queue-v3.patch']) {
    await copyTree(join(project, 'docs/evidence', file), join(releaseDirectory, 'docs/evidence', file));
  }
  for (const file of ['local-installation.md', 'first-human-login.md', 'lambda-installation.md']) await copyTree(join(project, 'docs', file), join(releaseDirectory, 'docs', file));
  await copyTree(join(project, 'src/sandbox/guest-profile'), join(releaseDirectory, 'provenance/guest-profile'));
  await mkdir(join(releaseDirectory, 'node_modules'), { mode: 0o755 });
  const runtimePackages = [];
  for (const key of closure.keys) {
    for (let parent = dirname(key); parent !== '.' && parent !== ''; parent = dirname(parent)) {
      if (parent === 'node_modules') break;
      await mkdir(join(releaseDirectory, parent), { recursive: true, mode: 0o755 });
    }
    await copyTree(join(project, key), join(releaseDirectory, key), relative => !relative.split('/').includes('node_modules'));
    const entry = closure.packages[key]!;
    const manifest = JSON.parse(await readFile(join(project, key, 'package.json'), 'utf8')) as { name: string; version: string; license?: string;
      licenses?: { type?: string }[] }; // `licenses` is the legacy array form some packages still declare.
    const legacy = Array.isArray(manifest.licenses) ? manifest.licenses.map(item => item.type).filter(Boolean).join(' OR ') || undefined : undefined;
    if (manifest.version !== entry.version) fail('RELEASE_DEPENDENCY_DRIFT');
    runtimePackages.push({ path: key, name: manifest.name, version: entry.version, integrity: entry.integrity ?? null, license: entry.license ?? manifest.license ?? legacy ?? null,
      licenseFiles: await licenseFiles(join(project, key)), hasInstallScript: entry.hasInstallScript === true, optional: entry.optional === true,
      lockedAsDevelopment: entry.dev === true });
  }
  await copyTree(join(project, 'package-lock.json'), join(releaseDirectory, 'package-lock.json'));
  const releasePackage = { name: packageJson.name, version: packageJson.version, private: true, type: packageJson.type, engines: { node: packageJson.engines.node },
    dependencies: packageJson.dependencies, imports: packageJson.imports };
  await writeFile(join(releaseDirectory, 'package.json'), JSON.stringify(releasePackage, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  await mkdir(join(releaseDirectory, 'node'), { mode: 0o755 });
  await mkdir(join(releaseDirectory, 'node/bin'), { mode: 0o755 });
  await copyTree(join(nodeHome, 'bin/node'), join(releaseDirectory, 'node/bin/node'));
  await copyTree(join(nodeHome, 'LICENSE'), join(releaseDirectory, 'node/LICENSE'));
  // The SAME pinned Gondolin profile, prepared by its closed preparation inside the release (relative dependency link).
  const gondolinRelease = await prepareReleaseGondolinSdk(releaseDirectory);
  const sdkProfileBytes = await readFile(join(releaseDirectory, privateSdk, 'profile.json'));
  if (JSON.stringify(JSON.parse(sdkProfileBytes.toString())) !== JSON.stringify(sdkEvidence)) fail('RELEASE_SDK_PROFILE_DRIFT');

  // Guest assets: every regular file of the pinned directory, re-verified at the copy.
  await mkdir(assetsDirectory, { mode: 0o700 });
  for (const name of (await readdir(assetsSource)).sort(compare)) {
    const info = await lstat(join(assetsSource, name));
    if (!info.isFile() || info.nlink !== 1) fail('RELEASE_GUEST_ASSET_ENTRY_UNSUPPORTED');
    await copyTree(join(assetsSource, name), join(assetsDirectory, name));
  }
  const copiedChecks = (await createSandbox({ root: project, guestAssets: { directory: assetsDirectory, manifestSha256: input.guestAssets.manifestSha256 } })
    .validate(undefined)).checks.filter(check => check.id.startsWith('guest-assets'));
  if (copiedChecks.length !== 4 || copiedChecks.some(check => check.status !== 'ok')) fail('RELEASE_GUEST_ASSETS_COPY_INVALID');
  const assetManifest = JSON.parse(await readFile(join(assetsDirectory, 'manifest.json'), 'utf8')) as { buildId?: string; buildTime?: string;
    config?: { arch?: string; distro?: string; alpine?: unknown; sandboxdPath?: string; sandboxfsPath?: string; sandboxsshPath?: string; sandboxingressPath?: string };
    assets?: Record<string, string>; checksums?: Record<string, string> };
  const launcherBytes = launcher(id);
  await writeFile(join(payload, 'factory'), launcherBytes, { mode: 0o755, flag: 'wx' });

  const guestProfileDirectory = join(project, 'src/sandbox/guest-profile');
  const guestProfile = await Promise.all((await readdir(guestProfileDirectory)).sort(compare).map(async name => ({ path: name, sha256: await hashFile(join(guestProfileDirectory, name)) })));
  const apkPackages = (await readFile(join(guestProfileDirectory, 'apk-packages.txt'), 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const versionOf = async (key: string) => { const entry = closure.packages[key]; return entry ? { version: entry.version ?? null, integrity: entry.integrity ?? null } : null; };
  const developmentTool = async (name: string, config?: string) => ({ name, ...await versionOf(`node_modules/${name}`),
    ...(config ? { config, configSha256: await hashFile(join(project, config)) } : {}) });
  const licenses: Record<string, number> = {};
  for (const item of runtimePackages) licenses[item.license ?? 'UNKNOWN'] = (licenses[item.license ?? 'UNKNOWN'] ?? 0) + 1;
  const files = await inventoryTree(releaseDirectory);
  await verifyShippedPackages(releaseDirectory, files, [{ root: '', keys: closure.keys }, { root: privateSdkSdk, keys: closure.sdkKeys }],
    [`${gondolinSdkProfile.directory}/node_modules`]);
  const manifest = {
    schemaVersion: 1, kind: 'software-factory-release', release: id, builtAt: new Date().toISOString(),
    node: { version: process.versions.node, path: 'node/bin/node', sha256: await hashFile(join(releaseDirectory, 'node/bin/node')), license: 'node/LICENSE' },
    launcher: { path: 'factory', sha256: sha(launcherBytes) },
    guestAssets: { path: `assets/guest/${input.guestAssets.manifestSha256}`, manifestSha256: input.guestAssets.manifestSha256, files: await inventoryTree(assetsDirectory) },
    production: { ...productionProfile, builder: { ...productionProfile.builder, skillPack: builderSkillPack }, promptSha256: Object.fromEntries(Object.entries(productionProfile.prompts).map(([role, text]) => [role, sha(text)])) },
    qualification: { status: 'unqualified', statement: 'This release asserts the integrity and exact composition of the distributed set only. It claims no functional ' +
      'coverage: VM boot, Docker/TLS, real GitHub, model and pilot behaviour, and features not yet integrated (later MVP tickets) are qualified separately ' +
      'on the final composition, never by checksums or build success.' },
    metadata: {
      source: { project: packageJson.name, version: packageJson.version, ...source },
      platform: { os: platform(), arch: arch() },
      node: { versions: { node: process.versions.node, v8: process.versions.v8, openssl: process.versions.openssl, sqlite: process.versions.sqlite,
        modules: process.versions.modules }, provenance: `Copied from the pinned local installation ${nodeHome} (bin/node, LICENSE only); upstream release checksums were not re-verified offline.` },
      sqlite: { implementation: 'node:sqlite built into the private Node (no separate native binding)', version: process.versions.sqlite },
      runtime: { lockfileSha256: closure.lockfileSha256, lockfileVersion: 3, packageJsonSha256: sha(JSON.stringify(releasePackage, null, 2) + '\n'),
        packages: runtimePackages, omittedEdges: closure.omitted, licenses, installScriptsAlreadyRun: runtimePackages.filter(item => item.hasInstallScript).map(item => item.name),
        excluded: 'Development dependencies (TypeScript, ESLint, dependency-cruiser, @types) and the upstream SDK package (replaced by its private profile).' },
      pi: { codingAgent: { version: closure.sdk.version ?? null, integrity: closure.sdk.integrity ?? null, license: closure.sdk.license ?? null,
        profile: sdkEvidence, profileSha256: sha(sdkProfileBytes) },
      durable: await versionOf('node_modules/@earendil-works/pi-durable'), chord: await versionOf('node_modules/@earendil-works/chord') },
      gondolin: { ...await versionOf('node_modules/@earendil-works/gondolin'), profile: gondolinRelease, profileId: gondolinSdkProfile.id },
      guestAssets: { buildId: assetManifest.buildId ?? null, buildTime: assetManifest.buildTime ?? null, arch: assetManifest.config?.arch ?? null,
        distro: assetManifest.config?.distro ?? null, alpine: assetManifest.config?.alpine ?? null, assets: assetManifest.assets ?? null, checksums: assetManifest.checksums ?? null,
        helpers: Object.fromEntries(['sandboxdPath', 'sandboxfsPath', 'sandboxsshPath', 'sandboxingressPath'].map(key =>
          [key, (assetManifest.config as Record<string, unknown> | undefined)?.[key] === undefined ? null : basename(String((assetManifest.config as Record<string, unknown>)[key]))])),
        hostRequirements: 'QEMU/KVM, qemu-img, e2fsck/resize2fs and systemd user supervision are host prerequisites diagnosed by doctor; the release ships none of them.' },
      guestProfile: { files: guestProfile, apkPackages, location: 'provenance/guest-profile' },
      skillPacks: await Promise.all(factorySkillPackIds.map(async name => {
        const bytes = await readFile(join(project, 'assets/skill-pack', name, 'manifest.json'));
        const parsed = JSON.parse(bytes.toString()) as { id: string; version: string; licenses: unknown; credits: string };
        return { id: parsed.id, version: parsed.version, manifestSha256: sha(bytes), licenses: parsed.licenses, credits: parsed.credits };
      })),
      protocol: { version: protocolVersion },
      // Ticket 33: the storage formats this release operates/migrates (upgrade and rollback decide on it before changing anything).
      storage: { format: controlStorageCompatibility.format, migratesFrom: [...controlStorageCompatibility.migratesFrom],
        migrations: [...controlStorageCompatibility.migrations], documents: { ...controlStorageCompatibility.documents } },
      formats: { releaseManifest: 1, configuration: [...configurationSchemaVersions], sandboxConfiguration: 1, sandboxProfile: productionProfile.sandboxProfile,
        controlStorage: 'Pi Durable SqliteStorage on node:sqlite (FULL synchronous)', workerSessions: 'Pi coding-agent SessionManager JSONL v3 (context only)' },
      build: { typescript: await developmentTool('typescript', 'tsconfig.json'), npm: { pinned: packageJson.packageManager, executed: false,
        note: 'The build never runs npm; the lockfile above is the dependency authority.' },
      dependencyCruiser: await developmentTool('dependency-cruiser', '.dependency-cruiser.cjs'), eslint: await developmentTool('eslint', 'eslint.config.mjs'),
      typescriptEslintParser: await developmentTool('@typescript-eslint/parser'),
      architectureFixtures: await Promise.all((await readdir(join(project, 'test/architecture'))).sort(compare).map(async name =>
        ({ path: `test/architecture/${name}`, sha256: await hashFile(join(project, 'test/architecture', name)) }))),
      operatorHostRequires: 'None of these development instruments; the release runs with its private Node only.' },
      buildHost: { kernel: kernelRelease(), os: await osRelease(), qemu: hostVersion('qemu-system-x86_64'), qemuImg: hostVersion('qemu-img'),
        systemd: hostVersion('systemctl'), tar: hostVersion('tar'), note: 'Build host observation; the qualification host is recorded by the qualification evidence.' },
      credits: 'Third-party packages keep their own license files inside node_modules; Node.js license at node/LICENSE; Gondolin license and provenance at ' +
        'docs/evidence/gondolin-sdk-v1; skill pack credits/licenses in each assets/skill-pack/<id>/manifest.json.',
    },
    files,
  };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  await writeFile(join(releaseDirectory, releaseManifestName), manifestBytes, { mode: 0o644, flag: 'wx' });
  // The manifest must satisfy the very schema the operator host applies (the inventory above is its exact content).
  const verified = parseReleaseManifest(manifestBytes);
  if (!verified) fail('RELEASE_SELF_VERIFICATION_FAILED');
  // Deterministic archive layout; extraction on the operator host: tar -xpkf <archive> -C <new canonical root>.
  const archiveName = `software-factory-${id}.tar`;
  const archive = join(output, archiveName);
  await run('tar', ['--create', `--file=${archive}`, `--directory=${payload}`, '--format=posix', '--sort=name', '--owner=0', '--group=0', '--numeric-owner',
    `--mtime=${source.commitTime}`, '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime', 'factory', 'releases', 'assets'],
  { env: environment, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
  const archiveSha256 = await hashFile(archive);
  await writeFile(`${archive}.sha256`, `${archiveSha256}  ${archiveName}\n`, { mode: 0o644, flag: 'wx' });
  await writeFile(join(output, releaseManifestName), manifestBytes, { mode: 0o644, flag: 'wx' });
  const report = { code: 'RELEASE_BUILT', release: id, archive: archiveName, archiveSha256, manifestSha256: verified.manifestSha256,
    entries: files.length, guestAssets: input.guestAssets.manifestSha256, source, extract: `tar -xpkf ${archiveName} -C <new canonical installation root>` };
  await writeFile(join(output, 'build-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  await rm(payload, { recursive: true }); // Only the payload this build created inside its own exclusive output.
  return report;
}

export type { TreeEntry };
async function main(args: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !value || !['--release', '--output', '--guest-assets', '--guest-manifest-sha256', '--node-home'].includes(key) || options.has(key)) fail('INVALID_ARGUMENTS');
    options.set(key, value);
  }
  const release = options.get('--release'), output = options.get('--output'), directory = options.get('--guest-assets'), manifestSha256 = options.get('--guest-manifest-sha256');
  if (!release || !output || !directory || !manifestSha256 || !isAbsolute(output) || !isAbsolute(directory)) fail('INVALID_ARGUMENTS');
  const nodeHome = options.get('--node-home');
  return buildRelease({ release, output, guestAssets: { directory, manifestSha256 }, ...(nodeHome ? { nodeHome } : {}) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) {
    console.error(JSON.stringify({ code: 'RELEASE_BUILD_FAILED', reason: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN',
      message: 'No retry or repair; inspect inputs and build again into a NEW output directory.' }));
    process.exitCode = 2;
  }
}
