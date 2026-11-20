import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { apkPackageNamePattern, apkVersionPattern, imageReferenceParts, validateEnvironmentDeclaration, type EnvironmentBaseIdentity,
  type EnvironmentDeclaration, type PinnedEnvironment } from '../contracts/index.js';
import { inspectStorage } from '../platform/host/index.js';
import type { GuestAssetPin } from './guest-assets.js';
import type { SandboxConfiguration } from './configuration.js';
import { buildRootDisk, checkDiskFilesystem } from './filesystem.js';

/**
 * Ticket 44 (operator decision 2026-11-19): ONE base disk per (repository, declaration hash) — keyed also by what it is built on (guest asset
 * pin, profile, disk size), since a base built on other assets is another disk — prepared by the controller BEFORE the first boot of a Work
 * environment, in a preparation VM whose egress reaches only the Alpine mirror and the registries of the declared images. The host never
 * executes the declaration: it builds ONE fixed guest script from the validated values (`pkg=version`, `image@sha256:`), runs it in the guest
 * through the `PreparationVm` port and parses the resolved manifest the guest reports. A failure is recorded (`failed.json`) and returned with
 * its cause; it is never retried implicitly (only the operator's `--retry-blocked-start`), and never swapped for another version or image.
 */

/** Alpine repositories of the guest assets (`guest-profile/alpine-docker-vfs.json`: alpine.mirror / alpine.branch). */
export const guestAlpine = Object.freeze({ mirror: 'https://dl-cdn.alpinelinux.org/alpine', branch: 'v3.23' });
export type AlpineRepositories = { mirror: string; branch: string };

/** The Sandbox's view of the declaration given to `prepare`: the Work's pin plus the repository identity the base is keyed by. */
export type EnvironmentRequest = PinnedEnvironment & { repository: string; repositoryId: number };

/** Port: one preparation VM on `disk` (an own qcow2 candidate), egress restricted to `allowedHosts`, running `script` once, then a clean guest
 * stop. `cessation: 'confirmed'` = the VM and its supervising process are gone (only then may the host read/check the disk). */
export type PreparationVmInput = { directory: string; disk: string; guestAssets: GuestAssetPin; configuration: SandboxConfiguration;
  allowedHosts: string[]; script: string; timeoutSeconds: number };
export type PreparationVmResult = { status: 'completed'; exitCode: number; output: string; cessation: 'confirmed' } |
  { status: 'failed'; code: string; detail: string; cessation: 'confirmed' | 'unconfirmed' };
export interface PreparationVm {
  run(input: PreparationVmInput): Promise<PreparationVmResult>;
  /** Whether a preparation VM started for `directory` (e.g. before a controller crash) may still run: true/unknown blocks any set-aside. */
  active?(directory: string): Promise<boolean>;
}

export const preparationTimeoutSeconds = 1800;
const outputLimit = 256 * 1024;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Cache key of a base disk. Same repository + same declaration bytes + same release guest assets/profile/disk size = the same base disk. */
export function environmentBaseKey(input: { repositoryId: number; declarationSha256: string; guestAssets: GuestAssetPin;
  configuration: Pick<SandboxConfiguration, 'profile' | 'diskGiB'> }): string {
  return sha256(JSON.stringify({ version: 1, repositoryId: input.repositoryId, declarationSha256: input.declarationSha256,
    guestAssetsManifestSha256: input.guestAssets.manifestSha256, profile: input.configuration.profile, diskGiB: input.configuration.diskGiB }));
}

/**
 * Hosts the preparation VM may reach (HTTP(S) mediation allowlist): the Alpine mirror and, per declared image, its registry plus the
 * well-known token/blob hosts that registry redirects to. A registry outside the table gets only its own host (a redirect elsewhere fails
 * visibly, never widened implicitly).
 */
const registryHosts: Record<string, string[]> = {
  'docker.io': ['registry-1.docker.io', 'auth.docker.io', 'production.cloudflare.docker.com'],
  'registry-1.docker.io': ['registry-1.docker.io', 'auth.docker.io', 'production.cloudflare.docker.com'],
  'ghcr.io': ['ghcr.io', 'pkg-containers.githubusercontent.com'],
  'quay.io': ['quay.io', 'cdn.quay.io', 'cdn01.quay.io', 'cdn02.quay.io', 'cdn03.quay.io'],
  'mcr.microsoft.com': ['mcr.microsoft.com', 'eastus.data.mcr.microsoft.com', 'westus.data.mcr.microsoft.com'],
};
export function preparationEgress(declaration: EnvironmentDeclaration, alpine: AlpineRepositories = guestAlpine): string[] {
  const hosts = new Set<string>([new URL(alpine.mirror).hostname]);
  for (const image of declaration.images) {
    const parts = imageReferenceParts(image.reference);
    if (!parts) throw new Error('ENVIRONMENT_DECLARATION_INVALID');
    const host = parts.registry.replace(/:\d+$/, '');
    for (const item of registryHosts[host] ?? [host]) hosts.add(item);
  }
  return [...hosts].sort();
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** Markers of the guest report (the guest output is untrusted data: only these sections are parsed, bounded). */
const marker = { installed: '@@factory-environment:installed', image: '@@factory-environment:image', end: '@@factory-environment:end' };

/**
 * The ONE guest script of a preparation, built from re-validated values only (every interpolated value matched a closed pattern; each is
 * also single-quoted). `apk add` names EXACT versions (`name=version`) from the release's Alpine repositories only (the guest's own
 * repositories file is ignored); a version missing from the mirror makes apk fail: the preparation is refused, never another version.
 * Images are pulled BY DIGEST. Then the guest reports what is installed (every package and version) and each image's repo digests.
 */
export function preparationScript(declaration: EnvironmentDeclaration, alpine: AlpineRepositories = guestAlpine): string {
  const checked = validateEnvironmentDeclaration(declaration);
  if (!checked.valid) throw new Error('ENVIRONMENT_DECLARATION_INVALID');
  if (!/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._-]+)*$/.test(alpine.mirror) || !/^v[0-9]+\.[0-9]+$|^edge$/.test(alpine.branch)) throw new Error('ALPINE_REPOSITORIES_INVALID');
  const lines = ['set -eu', 'exec 2>&1', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'umask 022', 'export LANG=C LC_ALL=C'];
  const packages = checked.declaration.apk;
  for (const item of packages) if (!apkPackageNamePattern.test(item.name) || !apkVersionPattern.test(item.version)) throw new Error('ENVIRONMENT_DECLARATION_INVALID');
  if (packages.length) {
    lines.push(['apk', 'add', '--update-cache', '--repositories-file', '/dev/null',
      '--repository', quote(`${alpine.mirror}/${alpine.branch}/main`), '--repository', quote(`${alpine.mirror}/${alpine.branch}/community`),
      '--', ...packages.map(item => quote(`${item.name}=${item.version}`))].join(' '));
  }
  checked.declaration.images.forEach(image => {
    lines.push(`docker pull --quiet ${quote(image.reference)} >/dev/null`);
  });
  lines.push(`echo ${marker.installed}`, 'apk info -v 2>/dev/null');
  checked.declaration.images.forEach((image, index) => {
    lines.push(`echo '${marker.image} ${index}'`, `docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' ${quote(image.reference)}`);
  });
  lines.push(`echo ${marker.end}`, 'sync');
  return `${lines.join('\n')}\n`;
}

/** `name-version` of `apk info -v` (the version is the last `-<digit>…-r<n>` suffix). */
const installedPattern = /^([a-z0-9][a-z0-9+._-]*)-([0-9][0-9a-z._]*-r[0-9]+)$/;

export type ResolvedManifest = { schemaVersion: 1; repository: string; repositoryId: number; declarationSha256: string; alpine: AlpineRepositories;
  guestAssetsManifestSha256: string; declared: Record<string, string>; installed: Record<string, string>; images: { reference: string; digest: string }[] };

/**
 * Parse the guest report against the declaration: every declared package must be installed at EXACTLY its declared version and every image
 * present with its declared digest. Anything else (missing section, other version, other digest, oversized output) is a refusal with its cause.
 */
export function parseResolvedManifest(output: string, declaration: EnvironmentDeclaration): { ok: true; installed: Record<string, string>; images: { reference: string; digest: string }[] } |
  { ok: false; detail: string } {
  if (output.length > outputLimit) return { ok: false, detail: 'guest report too large' };
  const lines = output.split('\n').map(line => line.trim());
  const start = lines.indexOf(marker.installed);
  const end = lines.lastIndexOf(marker.end);
  if (start < 0 || end < start) return { ok: false, detail: 'guest report incomplete (no installed-package section)' };
  const installed: Record<string, string> = {};
  let index = start + 1;
  for (; index < end && !lines[index]!.startsWith(marker.image); index++) {
    const line = lines[index]!;
    if (!line) continue;
    const match = installedPattern.exec(line.split(/\s+/)[0]!);
    if (match) installed[match[1]!] = match[2]!;
  }
  for (const item of declaration.apk) {
    const found = installed[item.name];
    if (found !== item.version) return { ok: false, detail: `apk ${item.name}: declared ${item.version}, ${found ? `installed ${found}` : 'not installed'}` };
  }
  const digests = new Map<number, string[]>();
  let current: number | null = null;
  for (; index < end; index++) {
    const line = lines[index]!;
    const header = new RegExp(`^${marker.image} ([0-9]{1,2})$`).exec(line);
    if (header) { current = Number(header[1]); digests.set(current, []); continue; }
    const digest = /@(sha256:[a-f0-9]{64})$/.exec(line)?.[1];
    if (current !== null && digest) digests.get(current)!.push(digest);
  }
  const images: { reference: string; digest: string }[] = [];
  for (const [position, image] of declaration.images.entries()) {
    const expected = imageReferenceParts(image.reference)?.digest;
    if (!expected || !(digests.get(position) ?? []).includes(expected)) return { ok: false, detail: `image ${image.reference}: declared digest not present after pull` };
    images.push({ reference: image.reference, digest: expected });
  }
  return { ok: true, installed, images };
}

/** Printable, bounded tail of untrusted guest output for an operator-facing cause. */
export function outputCause(output: string, limit = 400): string {
  const lines = output.replace(/[^\x20-\x7e\n]/g, '?').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('@@factory-environment'));
  const tail = lines.slice(-6).join(' | ');
  return tail.length > limit ? `…${tail.slice(-limit)}` : tail;
}

const identitySchema = z.strictObject({ version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), repository: z.string().max(256),
  repositoryId: z.number().int().positive().safe(), declarationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  guestAssetsManifestSha256: z.string().regex(/^[a-f0-9]{64}$/), profile: z.string().max(128), diskGiB: z.number().int().positive().safe() });
const readySchema = z.strictObject({ version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) });
const failedSchema = z.strictObject({ version: z.literal(1), key: z.string(), code: z.string().max(96), detail: z.string().max(1024), at: z.string() });

/** The record of the base an environment was created from (kept in the environment's owner.json). */
export const environmentBaseRecordSchema = z.strictObject({ key: z.string().regex(/^[a-f0-9]{64}$/), declarationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), repositoryId: z.number().int().positive().safe(),
  packages: z.record(z.string(), z.string()), images: z.array(z.strictObject({ reference: z.string(), digest: z.string() })) });
export type EnvironmentBaseRecord = z.infer<typeof environmentBaseRecordSchema>;

async function privateJson(path: string, value: unknown) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 1024 * 1024) throw new Error('UNSAFE_BASE_RECORD');
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
const stampOf = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();

export type EnsuredBase = { status: 'success'; disk: string; record: EnvironmentBaseRecord; identity: EnvironmentBaseIdentity } |
  { status: 'failure' | 'indeterminate'; code: string; detail?: string };

/** In-process serialization: Works of the same (repository, hash) prepared concurrently share ONE preparation. */
const inFlight = new Map<string, Promise<EnsuredBase>>();

/**
 * The ready base disk for `environment`, preparing it if needed. Reuse needs nothing but a `ready.json` + `base.qcow2` of the same key. A
 * recorded failure or an interrupted preparation (no ready, no failure: a crash) is returned as such, never retried implicitly; with
 * `retry` (the operator's `--retry-blocked-start`) it is set aside as `<base>.failed-<stamp>` (kept, never deleted) and prepared again.
 */
export function ensureEnvironmentBase(root: string, input: { environment: EnvironmentRequest; guestAssets: GuestAssetPin; template: string;
  configuration: SandboxConfiguration; vm?: PreparationVm | undefined; alpine?: AlpineRepositories; retry?: boolean; now?: () => Date }): Promise<EnsuredBase> {
  const checked = validateEnvironmentDeclaration(input.environment.declaration);
  if (!checked.valid || !/^[a-f0-9]{64}$/.test(input.environment.sha256) || !Number.isSafeInteger(input.environment.repositoryId) || input.environment.repositoryId <= 0) {
    return Promise.resolve({ status: 'failure', code: 'ENVIRONMENT_DECLARATION_INVALID' });
  }
  const key = environmentBaseKey({ repositoryId: input.environment.repositoryId, declarationSha256: input.environment.sha256, guestAssets: input.guestAssets,
    configuration: input.configuration });
  const directory = join(root, 'environment-bases', `base-${key}`);
  const running = inFlight.get(directory);
  if (running) return running;
  const task = prepareBase(root, directory, key, { ...input, declaration: checked.declaration }).finally(() => inFlight.delete(directory));
  inFlight.set(directory, task);
  return task;
}

async function prepareBase(root: string, directory: string, key: string, input: Parameters<typeof ensureEnvironmentBase>[1] & { declaration: EnvironmentDeclaration }): Promise<EnsuredBase> {
  const alpine = input.alpine ?? guestAlpine;
  const parent = join(root, 'environment-bases');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o077)) throw new Error('PRIVATE_BASE_DIRECTORY_REQUIRED');
  const disk = join(directory, 'base.qcow2');
  const ready = async (reused: boolean): Promise<EnsuredBase> => {
    const record = await readJson(join(directory, 'ready.json'), readySchema);
    const manifestText = await readFile(join(directory, 'manifest.json'), 'utf8');
    if (!record || record.key !== key || sha256(manifestText) !== record.manifestSha256) return { status: 'indeterminate', code: 'ENVIRONMENT_BASE_RECORD_INCONSISTENT' };
    const manifest = JSON.parse(manifestText) as ResolvedManifest;
    const info = await lstat(disk);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) return { status: 'indeterminate', code: 'ENVIRONMENT_BASE_DISK_UNSAFE' };
    const base: EnvironmentBaseRecord = { key, declarationSha256: manifest.declarationSha256, manifestSha256: record.manifestSha256, repositoryId: manifest.repositoryId,
      packages: manifest.declared, images: manifest.images };
    return { status: 'success', disk, record: base, identity: { base: key, declarationSha256: base.declarationSha256, manifestSha256: base.manifestSha256, reused,
      packages: base.packages, images: base.images } };
  };
  if (await exists(directory)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) return { status: 'indeterminate', code: 'ENVIRONMENT_BASE_DIRECTORY_UNSAFE' };
    if (await exists(join(directory, 'ready.json'))) return ready(true);
    const failed = await readJson(join(directory, 'failed.json'), failedSchema).catch(() => null);
    if (!input.retry) {
      return failed ? { status: 'failure', code: failed.code, detail: failed.detail }
        : { status: 'failure', code: 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE', detail: `${directory.slice(root.length + 1)} was left without a result (interrupted); retry explicitly` };
    }
    // A preparation VM of that attempt that may still run (controller crash) is never raced: its cessation must be confirmed first.
    if (input.vm?.active && await input.vm.active(directory).catch(() => true)) {
      return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_VM_UNCONFIRMED', detail: 'a preparation VM of this environment base may still run' };
    }
    // The operator's retry: the failed/interrupted attempt is set aside (kept for inspection), then prepared again from scratch.
    const kept = `${directory}.failed-${stampOf((input.now ?? (() => new Date()))())}`;
    if (await exists(kept)) return { status: 'indeterminate', code: 'ENVIRONMENT_BASE_SET_ASIDE_NAME_TAKEN' };
    await rename(directory, kept);
    await syncDirectory(parent);
  }
  if (!input.vm) return { status: 'failure', code: 'ENVIRONMENT_PREPARATION_VM_NOT_COMPOSED', detail: 'this installation cannot run environment preparation VMs' };
  const size = BigInt(input.configuration.diskGiB) * 1073741824n;
  const storage = await inspectStorage(parent);
  if (!storage || storage.unsuitable || BigInt(storage.availableBytes) < 2n * size + BigInt(input.configuration.minFreeSpaceGiB) * 1073741824n) {
    return { status: 'failure', code: 'INSUFFICIENT_STORAGE_FOR_PREPARATION' };
  }
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'indeterminate', code: 'ENVIRONMENT_BASE_PREPARATION_BUSY' }; throw error; }
  await privateJson(join(directory, 'identity.json'), identitySchema.parse({ version: 1, key, repository: input.environment.repository, repositoryId: input.environment.repositoryId,
    declarationSha256: input.environment.sha256, guestAssetsManifestSha256: input.guestAssets.manifestSha256, profile: input.configuration.profile, diskGiB: input.configuration.diskGiB }));
  await syncDirectory(directory);
  await syncDirectory(parent);
  const fail = async (code: string, detail: string): Promise<EnsuredBase> => {
    const bounded = detail.slice(0, 1024);
    await privateJson(join(directory, 'failed.json'), { version: 1, key, code, detail: bounded, at: (input.now ?? (() => new Date()))().toISOString() }).catch(() => {});
    await syncDirectory(directory).catch(() => {});
    return { status: 'failure', code, detail: bounded };
  };
  const candidate = join(directory, 'base-preparing.qcow2');
  try { await buildRootDisk(input.template, join(directory, 'rootfs-preparing.ext4'), candidate, size); }
  catch { return fail('ENVIRONMENT_BASE_PREPARATION_FAILED', 'the base disk could not be created from the release guest assets'); }
  const allowedHosts = preparationEgress(input.declaration, alpine);
  const script = preparationScript(input.declaration, alpine);
  await privateJson(join(directory, 'request.json'), { version: 1, key, allowedHosts, scriptSha256: sha256(script), timeoutSeconds: preparationTimeoutSeconds });
  let result: PreparationVmResult;
  try { result = await input.vm.run({ directory, disk: candidate, guestAssets: input.guestAssets, configuration: input.configuration, allowedHosts, script,
    timeoutSeconds: preparationTimeoutSeconds }); }
  catch { return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_VM_UNCONFIRMED', detail: 'the preparation VM outcome is unknown; its cessation is not confirmed' }; }
  // Never read or check the disk of a VM whose cessation is not confirmed: the attempt stays incomplete for the boot reconciliation/operator.
  if (result.cessation !== 'confirmed') return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_VM_UNCONFIRMED', detail: result.status === 'failed' ? result.detail.slice(0, 512) : '' };
  if (result.status === 'failed') return fail('ENVIRONMENT_BASE_PREPARATION_FAILED', `preparation VM: ${result.code}${result.detail ? ` (${result.detail})` : ''}`);
  const log = await open(join(directory, 'preparation.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await log.writeFile(result.output.slice(0, outputLimit)); await log.sync(); } finally { await log.close(); }
  if (result.exitCode !== 0) {
    return fail('ENVIRONMENT_BASE_PREPARATION_FAILED', `guest preparation exit ${result.exitCode} (a declared version missing from ${alpine.mirror}/${alpine.branch} or an image ` +
      `that cannot be pulled refuses the preparation; nothing else is installed instead): ${outputCause(result.output)}`);
  }
  const parsed = parseResolvedManifest(result.output, input.declaration);
  if (!parsed.ok) return fail('ENVIRONMENT_BASE_PREPARATION_FAILED', `resolved manifest refused: ${parsed.detail}`);
  if (!await checkDiskFilesystem(directory, candidate, size)) return fail('ENVIRONMENT_BASE_PREPARATION_FAILED', 'the prepared base disk failed its filesystem check');
  const manifest: ResolvedManifest = { schemaVersion: 1, repository: input.environment.repository, repositoryId: input.environment.repositoryId,
    declarationSha256: input.environment.sha256, alpine, guestAssetsManifestSha256: input.guestAssets.manifestSha256,
    declared: Object.fromEntries(input.declaration.apk.map(item => [item.name, item.version])), installed: parsed.installed, images: parsed.images };
  const manifestText = JSON.stringify(manifest);
  await privateJson(join(directory, 'manifest.json'), manifest);
  await rename(candidate, disk);
  await privateJson(join(directory, 'ready.json'), { version: 1, key, manifestSha256: sha256(manifestText) });
  await syncDirectory(directory);
  return ready(false);
}
