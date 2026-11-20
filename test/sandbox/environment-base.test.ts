import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { EnvironmentDeclaration } from '../../src/contracts/index.js';
import type { PreparationVmInput, PreparationVmResult } from '../../src/sandbox/index.js';

// Ticket 44 (fast, offline): the environment base cache, identity, refusals and retry of the Sandbox with the preparation VM behind its port
// (a double that "installs" from a synthetic mirror) and the native disk steps replaced by file copies. The real native disk steps are proved
// by environment-base-native.test.ts (gated by FACTORY_SANDBOX_TEST_ROOT); the guest itself only by the real-VM proof (ticket 54).
const filesystemUrl = new URL('../../src/sandbox/filesystem.js', import.meta.url).href;
const actual = await import('../../src/sandbox/filesystem.js') as Record<string, unknown>;
mock.module(filesystemUrl, { namedExports: { ...actual,
  buildRootDisk: async (template: string, _raw: string, disk: string) => { await copyFile(template, disk); await fs.chmod(disk, 0o600); },
  copyBaseDisk: async (base: string, disk: string) => { await copyFile(base, disk); await fs.chmod(disk, 0o600); },
  checkDiskFilesystem: async () => true } });
const sandboxModule = await import('../../src/sandbox/index.js');
const { createSandbox, environmentBaseKey, guestAlpine, parseResolvedManifest, preparationEgress, preparationScript, createPreparationVm } = sandboxModule;

const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' as const, diskGiB: 1 };
const digest = `sha256:${'4'.repeat(64)}`;
const jdk: EnvironmentDeclaration = { schemaVersion: 1, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }], images: [] };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** A synthetic Alpine mirror inside the preparation VM double: installs exactly the requested `name=version` or fails like apk does. */
function vmDouble(mirror: Record<string, string>, options: { report?: (output: string) => string; result?: () => PreparationVmResult | undefined } = {}) {
  const runs: PreparationVmInput[] = [];
  return { runs, vm: { async run(input: PreparationVmInput): Promise<PreparationVmResult> {
    runs.push(input);
    const forced = options.result?.();
    if (forced) return forced;
    const requested = [...input.script.matchAll(/'([a-z0-9+._-]+)=([^']+)'/g)].map(match => [match[1]!, match[2]!] as const);
    const missing = requested.filter(([name, version]) => mirror[name] !== version);
    if (missing.length) {
      return { status: 'completed', exitCode: 1, cessation: 'confirmed', output: `fetch ${guestAlpine.mirror}/${guestAlpine.branch}/community/x86_64/APKINDEX.tar.gz\n` +
        `ERROR: unable to select packages:\n${missing.map(([name, version]) => `  ${name}-${version}:\n    breaks: world[${name}=${version}]`).join('\n')}\n` };
    }
    const images = [...input.script.matchAll(/docker image inspect --format '[^']*' '([^']+)'/g)].map(match => match[1]!);
    const output = ['@@factory-environment:installed', 'musl-1.2.5-r10', 'java-common-0.5-r0', ...requested.map(([name, version]) => `${name}-${version}`),
      ...images.flatMap((reference, index) => [`@@factory-environment:image ${index}`, `${reference.split('@')[0]!.split('/').slice(1).join('/')}@${reference.split('@')[1]}`]),
      '@@factory-environment:end', ''].join('\n');
    return { status: 'completed', exitCode: 0, cessation: 'confirmed', output: options.report ? options.report(output) : output };
  } } };
}

async function world(t: { after(fn: () => Promise<void>): void; mock: typeof mock }) {
  const root = await mkdtemp(join(tmpdir(), 'factory-environment-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Only the storage admission is substituted (a private /tmp is tmpfs): an ext4 with room; never a real disk claim.
  const statfs = fs.statfs;
  const boundary = t.mock.method(fs, 'statfs', async (path: string) => ({ ...await statfs(path, { bigint: true }), type: 0xef53n, bavail: 1n << 40n, bsize: 4096n }));
  syncBuiltinESMExports();
  t.after(async () => { boundary.mock.restore(); syncBuiltinESMExports(); });
  const assets = join(root, 'assets');
  await mkdir(assets);
  await writeFile(join(assets, 'rootfs.ext4'), 'release-rootfs');
  await writeFile(join(assets, 'kernel'), 'kernel');
  await writeFile(join(assets, 'initrd'), 'initrd');
  const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' }, assets: { kernel: 'kernel', initramfs: 'initrd', rootfs: 'rootfs.ext4' },
    checksums: { kernel: hash('kernel'), initramfs: hash('initrd'), rootfs: hash('release-rootfs') } });
  await writeFile(join(assets, 'manifest.json'), manifest);
  return { root, guestAssets: { directory: assets, manifestSha256: hash(manifest) } };
}
const request = (declaration: EnvironmentDeclaration, sha256 = hash(JSON.stringify(declaration))) =>
  ({ path: '.factory/environment.yaml', commit: 'a'.repeat(40), sha256, declaration, repository: 'acme/project', repositoryId: 3 });

test('the preparation is a fixed script of exact `name=version` apk installs from the release mirror and by-digest pulls; egress is the mirror and the declared registries only', async () => {
  const declaration: EnvironmentDeclaration = { schemaVersion: 1, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }, { name: 'gradle', version: '8.14.3-r0' }],
    images: [{ reference: `docker.io/testcontainers/ryuk@${digest}` }, { reference: `ghcr.io/acme/tool@${digest}` }] };
  const script = preparationScript(declaration);
  assert.match(script, /^set -eu\nexec 2>&1\n/);
  assert.ok(script.includes("apk add --update-cache --repositories-file /dev/null --repository 'https://dl-cdn.alpinelinux.org/alpine/v3.23/main' " +
    "--repository 'https://dl-cdn.alpinelinux.org/alpine/v3.23/community' -- 'openjdk25-jdk=25.0.5.1_p2-r0' 'gradle=8.14.3-r0'\n"), script);
  assert.ok(script.includes(`docker pull --quiet 'docker.io/testcontainers/ryuk@${digest}' >/dev/null\n`));
  assert.ok(script.includes('apk info -v'));
  assert.doesNotMatch(script, /--allow-untrusted|--force|--no-check|curl|wget|eval/);
  assert.throws(() => preparationScript({ schemaVersion: 1, apk: [{ name: 'x', version: "1-r0' ; rm -rf / ; '" }], images: [] }), /ENVIRONMENT_DECLARATION_INVALID/);
  assert.throws(() => preparationScript(jdk, { mirror: 'http://mirror.example', branch: 'v3.23' }), /ALPINE_REPOSITORIES_INVALID/);
  assert.deepEqual(preparationEgress(jdk), ['dl-cdn.alpinelinux.org']);
  assert.deepEqual(preparationEgress(declaration), ['auth.docker.io', 'dl-cdn.alpinelinux.org', 'ghcr.io', 'pkg-containers.githubusercontent.com',
    'production.cloudflare.docker.com', 'registry-1.docker.io']);
  assert.deepEqual(preparationEgress({ schemaVersion: 1, apk: [], images: [{ reference: `registry.acme.example:5000/x@${digest}` }] }), ['dl-cdn.alpinelinux.org', 'registry.acme.example']);
  // The release guest profile is the single source of the Alpine repositories.
  const profile = JSON.parse(await readFile('src/sandbox/guest-profile/alpine-docker-vfs.json', 'utf8')) as { alpine: { mirror: string; branch: string } };
  assert.deepEqual(guestAlpine, { mirror: profile.alpine.mirror, branch: profile.alpine.branch });
});

test('the resolved manifest accepts only the declared versions and digests, exactly', () => {
  const declaration: EnvironmentDeclaration = { ...jdk, images: [{ reference: `docker.io/testcontainers/ryuk@${digest}` }] };
  const report = (lines: string[]) => ['noise', '@@factory-environment:installed', ...lines, '@@factory-environment:end'].join('\n');
  assert.deepEqual(parseResolvedManifest(report(['musl-1.2.5-r10', 'openjdk25-jdk-25.0.5.1_p2-r0', '@@factory-environment:image 0', `testcontainers/ryuk@${digest}`]), declaration),
    { ok: true, installed: { musl: '1.2.5-r10', 'openjdk25-jdk': '25.0.5.1_p2-r0' }, images: [{ reference: `docker.io/testcontainers/ryuk@${digest}`, digest }] });
  assert.deepEqual(parseResolvedManifest(report(['openjdk25-jdk-25.0.6_p1-r0', '@@factory-environment:image 0', `testcontainers/ryuk@${digest}`]), declaration),
    { ok: false, detail: 'apk openjdk25-jdk: declared 25.0.5.1_p2-r0, installed 25.0.6_p1-r0' }, 'never another version');
  assert.equal(parseResolvedManifest(report(['openjdk25-jdk-25.0.5.1_p2-r0', '@@factory-environment:image 0', `testcontainers/ryuk@sha256:${'5'.repeat(64)}`]), declaration).ok, false);
  assert.equal(parseResolvedManifest('openjdk25-jdk-25.0.5.1_p2-r0', declaration).ok, false, 'no report section is not success');
});

test('AC5/AC6/AC7: JDK 25 — ONE base disk per (repository, hash), prepared before the first environment, reused by the next Works with the same identity', async t => {
  const { root, guestAssets } = await world(t);
  const vm = vmDouble({ 'openjdk25-jdk': '25.0.5.1_p2-r0' });
  const sandbox = createSandbox({ root, guestAssets, preparationVm: vm.vm });
  const first = await sandbox.prepare({ workId: 'work-1', configuration, environment: request(jdk) });
  assert.equal(first.status, 'success');
  if (first.status !== 'success') return;
  assert.equal(vm.runs.length, 1);
  assert.deepEqual(vm.runs[0]!.allowedHosts, ['dl-cdn.alpinelinux.org']);
  assert.equal(vm.runs[0]!.script, preparationScript(jdk));
  const key = environmentBaseKey({ repositoryId: 3, declarationSha256: request(jdk).sha256, guestAssets, configuration: { profile: configuration.profile, diskGiB: 1 } });
  const base = join(root, 'environment-bases', `base-${key}`);
  const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.declared, manifest.installed['openjdk25-jdk'], manifest.installed.musl, manifest.alpine], [{ 'openjdk25-jdk': '25.0.5.1_p2-r0' }, '25.0.5.1_p2-r0', '1.2.5-r10', guestAlpine]);
  assert.deepEqual(first.base, { base: key, declarationSha256: request(jdk).sha256, manifestSha256: hash(await readFile(join(base, 'manifest.json'))), reused: false,
    packages: { 'openjdk25-jdk': '25.0.5.1_p2-r0' }, images: [] });
  const owner = JSON.parse(await readFile(join(root, 'environments', first.environment, 'owner.json'), 'utf8'));
  assert.equal(owner.environmentBase.key, key, 'the environment records the base it was copied from');
  // Following Works of the same repository and hash: no new preparation, same identity.
  const second = await sandbox.prepare({ workId: 'work-2', configuration, environment: request(jdk) });
  const third = await sandbox.prepare({ workId: 'work-3', configuration, environment: request(jdk) });
  assert.equal(vm.runs.length, 1, 'the base disk is reused');
  for (const later of [second, third]) {
    assert.ok(later.status === 'success' && later.base);
    if (later.status !== 'success' || !later.base) return;
    assert.deepEqual({ ...later.base, reused: false }, first.base, 'same environment identity (hash + resolved manifest)');
    assert.equal(later.base.reused, true);
  }
  // Concurrent Works of one (repository, hash) share one preparation.
  const declaration = { ...jdk, apk: [...jdk.apk, { name: 'gradle', version: '8.14.3-r0' }] };
  const both = await Promise.all(['work-4', 'work-5'].map(workId => createSandbox({ root, guestAssets, preparationVm: vmDouble({ 'openjdk25-jdk': '25.0.5.1_p2-r0', gradle: '8.14.3-r0' }).vm })
    .prepare({ workId, configuration, environment: request(declaration) })));
  assert.ok(both.every(result => result.status === 'success'));
  assert.equal((await readdir(join(root, 'environment-bases'))).filter(name => name.startsWith('base-')).length, 2);
});

test('AC6: a new declaration hash gets a NEW base used only by new environments; an already prepared environment keeps its base, recorded (never a mismatch)', async t => {
  const { root, guestAssets } = await world(t);
  const vm = vmDouble({ 'openjdk25-jdk': '25.0.5.1_p2-r0', 'openjdk21-jdk': '21.0.9_p10-r0' });
  const sandbox = createSandbox({ root, guestAssets, preparationVm: vm.vm });
  const first = await sandbox.prepare({ workId: 'work-1', configuration, environment: request(jdk) });
  assert.ok(first.status === 'success');
  const changed: EnvironmentDeclaration = { schemaVersion: 1, apk: [{ name: 'openjdk21-jdk', version: '21.0.9_p10-r0' }], images: [] };
  const again = await sandbox.prepare({ workId: 'work-1', configuration, environment: request(changed) });
  assert.deepEqual(again.status === 'success' && again.base, first.status === 'success' && first.base ? { ...first.base, reused: true } : null, 'kept, not a mismatch');
  assert.equal(vm.runs.length, 1);
  const other = await sandbox.prepare({ workId: 'work-2', configuration, environment: request(changed) });
  assert.ok(other.status === 'success' && other.base && first.status === 'success' && first.base && other.base.base !== first.base.base);
  assert.equal(vm.runs.length, 2);
  // A Work without a declaration (admitted before ticket 44) keeps the generic guest: no base, no preparation VM.
  const legacy = await sandbox.prepare({ workId: 'legacy', configuration });
  assert.deepEqual([legacy.status, 'base' in legacy], ['success', false]);
  assert.equal(vm.runs.length, 2);
});

test('AC5/AC9: a version missing from the mirror refuses the preparation with its cause, never another version; recorded, never retried implicitly; the operator retry sets it aside and prepares again', async t => {
  const { root, guestAssets } = await world(t);
  const mirror: Record<string, string> = { 'openjdk25-jdk': '25.0.6_p1-r0' };
  const vm = vmDouble(mirror);
  const sandbox = createSandbox({ root, guestAssets, preparationVm: vm.vm });
  const refused = await sandbox.prepare({ workId: 'work-1', configuration, environment: request(jdk) });
  assert.equal(refused.status, 'failure');
  assert.equal('code' in refused && refused.code, 'ENVIRONMENT_BASE_PREPARATION_FAILED');
  assert.match('detail' in refused ? refused.detail ?? '' : '', /guest preparation exit 1 .*breaks: world\[openjdk25-jdk=25\.0\.5\.1_p2-r0\]/);
  await assert.rejects(() => lstat(join(root, 'environments', `env-${hash('work-1')}`)), { code: 'ENOENT' }, 'no environment from a refused base');
  const again = await sandbox.prepare({ workId: 'work-2', configuration, environment: request(jdk) });
  assert.deepEqual([again.status, 'code' in again && again.code, vm.runs.length], ['failure', 'ENVIRONMENT_BASE_PREPARATION_FAILED', 1], 'no implicit retry');
  mirror['openjdk25-jdk'] = '25.0.5.1_p2-r0';
  const retried = await sandbox.prepare({ workId: 'work-1', configuration, environment: request(jdk), retryEnvironmentBase: true });
  assert.equal(retried.status, 'success');
  assert.equal(vm.runs.length, 2);
  const names = await readdir(join(root, 'environment-bases'));
  assert.equal(names.filter(name => /^base-[a-f0-9]{64}\.failed-\d{8}t\d{6}z$/.test(name)).length, 1, 'the failed attempt is kept aside, never deleted');
  // A report with another version (e.g. a mirror that swapped it) is refused too.
  const swapped = createSandbox({ root, guestAssets, preparationVm: vmDouble({ x: '1-r0' }, { report: output => output.replace('x-1-r0', 'x-2-r0') }).vm });
  const swap = await swapped.prepare({ workId: 'work-3', configuration, environment: request({ schemaVersion: 1, apk: [{ name: 'x', version: '1-r0' }], images: [] }) });
  assert.match('detail' in swap ? swap.detail ?? '' : '', /resolved manifest refused: apk x: declared 1-r0, installed 2-r0/);
});

test('an unconfirmed preparation VM is indeterminate (nothing recorded, disk never read); no VM port refuses instead of using the generic guest', async t => {
  const { root, guestAssets } = await world(t);
  const lost = createSandbox({ root, guestAssets, preparationVm: vmDouble({}, { result: () => ({ status: 'failed', code: 'PREPARATION_UNIT_STILL_ACTIVE', detail: 'u', cessation: 'unconfirmed' }) }).vm });
  const result = await lost.prepare({ workId: 'work-1', configuration, environment: request(jdk) });
  assert.deepEqual([result.status, 'code' in result && result.code], ['indeterminate', 'ENVIRONMENT_PREPARATION_VM_UNCONFIRMED']);
  const [base] = (await readdir(join(root, 'environment-bases'))).filter(name => name.startsWith('base-'));
  await assert.rejects(() => lstat(join(root, 'environment-bases', base!, 'failed.json')), { code: 'ENOENT' });
  const incomplete = await lost.prepare({ workId: 'work-2', configuration, environment: request(jdk) });
  assert.deepEqual([incomplete.status, 'code' in incomplete && incomplete.code], ['failure', 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE']);
  const none = await createSandbox({ root, guestAssets }).prepare({ workId: 'work-3', configuration, environment: request({ ...jdk, apk: [] }) });
  assert.deepEqual([none.status, 'code' in none && none.code], ['failure', 'ENVIRONMENT_PREPARATION_VM_NOT_COMPOSED']);
});

test('production port: one transient `systemd-run --wait` unit per preparation; the result is read only after the manager shows the unit inactive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-preparation-vm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'environment-bases', `base-${'1'.repeat(64)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const launched: string[][] = [];
  let active = false;
  const vm = createPreparationVm({ root, state: async () => ({ ActiveState: active ? 'active' : 'inactive' }), runner: async (file, args) => {
    launched.push([file, ...args]);
    const vmRequest = JSON.parse(await readFile(join(directory, 'vm-request.json'), 'utf8'));
    await writeFile(join(directory, 'vm-result.json'), JSON.stringify({ version: 1, boot: vmRequest.boot, status: 'completed', exitCode: 0, code: null, output: 'ok', guestStop: 'clean' }), { mode: 0o600 });
    return {};
  } });
  const input = { directory, disk: join(directory, 'base-preparing.qcow2'), guestAssets: { directory: '/assets', manifestSha256: '2'.repeat(64) },
    configuration: { schemaVersion: 1 as const, profile: 'gondolin-qemu-alpine-dev-v1' as const, memoryMiB: 2048, vcpus: 2, diskGiB: 1, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 },
    allowedHosts: ['dl-cdn.alpinelinux.org'], script: 'set -eu\n', timeoutSeconds: 1800 };
  assert.deepEqual(await vm.run(input), { status: 'completed', exitCode: 0, output: 'ok', cessation: 'confirmed' });
  const argv = launched[0]!;
  assert.equal(argv[0], 'systemd-run');
  assert.ok(argv.includes('--wait') && argv.includes('--collect') && argv.includes('--property=RuntimeMaxSec=1890s'));
  assert.deepEqual(argv.slice(-4).map((item, index) => index === 0 ? item.endsWith('/entrypoints/adapter.js') : item), [true, 'prepare-environment', root, directory]);
  const vmRequest = JSON.parse(await readFile(join(directory, 'vm-request.json'), 'utf8'));
  assert.deepEqual([vmRequest.allowedHosts, vmRequest.script], [['dl-cdn.alpinelinux.org'], 'set -eu\n']);
  assert.equal(await vm.active!(directory), false);
  active = true;
  assert.equal(await vm.active!(directory), true, 'a surviving unit blocks any set-aside');
  const other = join(root, 'environment-bases', `base-${'3'.repeat(64)}`);
  await mkdir(other, { mode: 0o700 });
  assert.deepEqual(await createPreparationVm({ root, state: async () => ({ ActiveState: 'active' }), runner: async () => ({}) }).run({ ...input, directory: other }),
    { status: 'failed', code: 'PREPARATION_UNIT_STILL_ACTIVE', detail: (JSON.parse(await readFile(join(other, 'vm-request.json'), 'utf8')) as { unit: string }).unit, cessation: 'unconfirmed' });
});
