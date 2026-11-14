import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildRelease } from '../../src/entrypoints/release-build.js';
import { inventoryTree } from '../../src/entrypoints/release.js';

// I-local (ticket 32): the REAL release builder over this development checkout (emitted JS, lockfile closure, private Node, private SDK
// profiles, skill packs) with SYNTHETIC guest assets (non-bootable bytes, pinned by hash); real host tar extraction into a clean root and
// the extracted release's own private Node running setup/doctor/run. No VM, network, GitHub, model or credential.
const manifestSha256 = '9bf9e4c0a3af47bc92a350509f4ddfe7de3d319b5b63ca42a2939ad73b6ef80f';
const id = 'r32-test';
let work: string, output: string, root: string, report: Awaited<ReturnType<typeof buildRelease>>;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
type Check = { id: string; status: string; message: string };

/** PATH whose installer/escalation commands only leave a canary: setup/doctor must never invoke any of them. */
async function canaryPath(directory: string) {
  await mkdir(join(directory, 'bin'), { recursive: true });
  for (const name of ['sudo', 'su', 'doas', 'pkexec', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'node', 'apk', 'pacman', 'apt-get', 'dnf', 'docker', 'podman', 'curl', 'wget']) {
    await writeFile(join(directory, 'bin', name), `#!/bin/sh\necho ${name} >> ${join(directory, 'canary')}\nexit 1\n`, { mode: 0o755 });
  }
  return `${join(directory, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`;
}
function factory(installation: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(join(installation, 'factory'), args, { cwd: work, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
}
const check = (checks: Check[], name: string) => checks.find(item => item.id === name);

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'factory-r32-'));
  const assets = join(work, 'synthetic-assets');
  await mkdir(assets);
  await writeFile(join(assets, 'manifest.json'), await readFile('test/sandbox/asset-manifest.fixture.json'));
  await writeFile(join(assets, 'vmlinuz-virt'), 'kernel fixture\n');
  await writeFile(join(assets, 'initramfs.cpio.lz4'), 'initramfs fixture\n');
  await writeFile(join(assets, 'rootfs.ext4'), 'rootfs fixture\n');
  output = join(work, 'build');
  report = await buildRelease({ release: id, output, guestAssets: { directory: assets, manifestSha256 } });
  root = join(work, 'installation');
  await mkdir(root, { mode: 0o700 });
  const extracted = spawnSync('tar', ['-xpkf', join(output, report.archive), '-C', root], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
});
after(async () => { if (work) await rm(work, { recursive: true, force: true }); });

test('build: one exclusive archive with checksum and manifest pinning Node/SDKs/SQLite/Gondolin/assets/profile/tooling, and nothing of development', async () => {
  assert.deepEqual((await readdir(output)).sort(), ['build-report.json', 'release-manifest.json', `software-factory-${id}.tar`, `software-factory-${id}.tar.sha256`]);
  assert.equal(await readFile(join(output, `${report.archive}.sha256`), 'utf8'), `${sha(await readFile(join(output, report.archive)))}  ${report.archive}\n`);
  await assert.rejects(buildRelease({ release: id, output, guestAssets: { directory: join(work, 'synthetic-assets'), manifestSha256 } }), { code: 'EEXIST' });
  const listing = spawnSync('tar', ['-tf', join(output, report.archive)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.trim().split('\n');
  assert.ok(listing.every(path => path === 'factory' || path.startsWith(`releases/`) || path.startsWith('assets/')), 'only launcher, release and assets');
  assert.ok(listing.includes(`releases/${id}/node/bin/node`) && listing.includes(`releases/${id}/dist/src/entrypoints/cli.js`));
  assert.ok(listing.includes(`assets/guest/${manifestSha256}/rootfs.ext4`));
  const release = listing.filter(path => path.startsWith(`releases/${id}/`)).map(path => path.slice(`releases/${id}/`.length));
  // Development instruments are absent; type-only packages stay only where an upstream runtime package declares them (lockfile closure).
  for (const forbidden of [/^dist\/test\//, /^dist\/.*\.(ts|map)$/, /^src\//, /^node_modules\/(typescript|eslint|dependency-cruiser|@typescript-eslint|@types\/(?!node\/|retry\/)[^/]+)/,
    /^node_modules\/@earendil-works\/pi-coding-agent\//, /^test\//]) {
    assert.ok(!release.some(path => forbidden.test(path)), String(forbidden));
  }
  const manifest = JSON.parse(await readFile(join(root, 'releases', id, 'release-manifest.json'), 'utf8'));
  assert.equal(await readFile(join(output, 'release-manifest.json'), 'utf8'), await readFile(join(root, 'releases', id, 'release-manifest.json'), 'utf8'));
  assert.equal(sha(await readFile(join(output, 'release-manifest.json'))), report.manifestSha256);
  assert.equal(manifest.node.version, '24.21.0');
  assert.equal(manifest.node.sha256, sha(await readFile(process.execPath)));
  const { metadata } = manifest;
  assert.equal(metadata.sqlite.version, process.versions.sqlite);
  assert.equal(metadata.pi.durable.version, '1.5.0');
  assert.equal(metadata.pi.codingAgent.version, '1.5.2');
  assert.equal(metadata.pi.codingAgent.profile.id, 'factory-development-pi-1.5.2-read-async-bash-lexical-v3');
  assert.equal(metadata.gondolin.version, '0.14.0');
  assert.equal(metadata.gondolin.profile.dependencyLink, '../../node_modules');
  assert.deepEqual(metadata.skillPacks.map((pack: { id: string }) => pack.id), ['factory-skills-v1', 'factory-skills-v2', 'factory-skills-v3']);
  assert.ok(metadata.skillPacks.every((pack: { licenses: unknown[]; credits: string }) => pack.licenses.length > 0 && pack.credits));
  assert.equal(metadata.protocol.version, 1);
  assert.ok(metadata.guestProfile.apkPackages.includes('docker'));
  assert.equal(metadata.runtime.lockfileSha256, sha(await readFile('package-lock.json')));
  assert.ok(metadata.runtime.packages.length > 100);
  assert.ok(metadata.runtime.packages.every((item: { integrity: string | null; license: string | null }) => item.integrity && item.license));
  assert.equal(metadata.build.typescript.version, '6.0.3');
  assert.equal(metadata.build.dependencyCruiser.configSha256, sha(await readFile('.dependency-cruiser.cjs')));
  assert.equal(metadata.build.eslint.configSha256, sha(await readFile('eslint.config.mjs')));
  assert.equal(metadata.build.npm.executed, false);
  assert.ok(metadata.build.architectureFixtures.some((item: { path: string }) => item.path === 'test/architecture/architecture-gate.test.ts'));
  assert.equal(manifest.production.builder.skillPack, 'factory-skills-v3');
  assert.deepEqual(manifest.production.tools.standards, ['read']);
  assert.equal(manifest.qualification.status, 'unqualified');
  assert.match(manifest.qualification.statement, /claims no functional coverage/);
});

test('extracted release: repeated setup and offline doctor verify integrity with the private Node, preserve everything and never install or escalate', async () => {
  const canaries = join(work, 'canaries');
  const PATH = await canaryPath(canaries);
  const before = JSON.stringify(await inventoryTree(join(root, 'releases'))) + JSON.stringify(await inventoryTree(join(root, 'assets')));
  const first = factory(root, ['setup', '--json'], { PATH, NODE_OPTIONS: '--require /nonexistent-personal-hook.cjs' });
  assert.equal(first.status, 0, first.stderr);
  const prepared = JSON.parse(first.stdout);
  assert.equal(prepared.root, root);
  assert.deepEqual(prepared.created.sort(), ['config.yaml', 'credentials', 'data', 'environments', 'run']);
  const checks: Check[] = prepared.diagnostics.checks;
  for (const name of ['release:integrity', 'release:location', 'release:selected', 'release:node', 'release:assets', 'permissions:releases', 'permissions:assets',
    'guest-assets:manifest', 'guest-assets:kernel', 'guest-assets:initramfs', 'guest-assets:rootfs']) assert.equal(check(checks, name)?.status, 'ok', name);
  assert.equal(check(checks, 'release:qualification')?.status, 'unverified');
  assert.equal(check(checks, 'kvm-functional')?.status, 'unverified');
  assert.equal(prepared.diagnostics.release.release, id);
  assert.equal(prepared.diagnostics.release.manifestSha256, report.manifestSha256);
  assert.equal(prepared.diagnostics.versions.node, '24.21.0');
  // Complete configuration with the release's single supported worker profile, then setup again: nothing created or overwritten.
  const configuration = (await readFile(join(root, 'config.yaml'), 'utf8')).replace('operators: []', 'operators: [operador]')
    .replaceAll('{ provider: null, model: null }', '{ provider: openai, model: gpt-6-luna }').replace('appId: null', 'appId: 123');
  await writeFile(join(root, 'config.yaml'), configuration);
  await writeFile(join(root, 'credentials', 'github-app.pem'), 'synthetic-never-read', { mode: 0o600 });
  await writeFile(join(root, 'data', 'unknown'), 'preserved');
  // XDG_CONFIG_HOME set: a plain setup still writes no service definition (registration only on explicit request).
  const second = factory(root, ['setup', '--json'], { PATH, XDG_CONFIG_HOME: join(work, 'xdg') });
  assert.equal(second.status, 0, second.stderr);
  const repeated = JSON.parse(second.stdout);
  assert.deepEqual(repeated.created, []);
  assert.equal(repeated.diagnostics.configuration.valid, true, JSON.stringify(repeated.diagnostics.configuration));
  for (const role of ['builder', 'standards', 'spec']) assert.equal(check(repeated.diagnostics.checks, `worker-profile:${role}`)?.status, 'ok', role);
  assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), configuration);
  assert.equal(await readFile(join(root, 'credentials', 'github-app.pem'), 'utf8'), 'synthetic-never-read');
  assert.equal(await readFile(join(root, 'data', 'unknown'), 'utf8'), 'preserved');
  assert.deepEqual(await readdir(join(root, 'environments')), []);
  assert.deepEqual(await readdir(join(root, 'run')), []);
  await assert.rejects(stat(join(work, 'xdg')), { code: 'ENOENT' });
  assert.doesNotMatch(first.stdout + second.stdout + first.stderr + second.stderr, /synthetic-never-read/);
  // An unsupported model is diagnosed as a blocked prerequisite of this release, never silently replaced.
  await writeFile(join(root, 'config.yaml'), configuration.replace('{ provider: openai, model: gpt-6-luna }', '{ provider: other, model: other-model }'));
  const unsupported = factory(root, ['doctor', '--json'], { PATH });
  assert.equal(unsupported.status, 3, unsupported.stderr);
  assert.equal(check(JSON.parse(unsupported.stdout).checks, 'worker-profile:builder')?.status, 'blocked');
  await writeFile(join(root, 'config.yaml'), configuration);
  await assert.rejects(stat(join(canaries, 'canary')), { code: 'ENOENT' }, 'no installer, package manager, host Node or escalation was invoked');
  assert.equal(JSON.stringify(await inventoryTree(join(root, 'releases'))) + JSON.stringify(await inventoryTree(join(root, 'assets'))), before);
});

test('a release serves only its own canonical root; wrong extraction and changed bytes fail explicitly without repair', async () => {
  const other = join(work, 'other-root');
  const cli = join(root, 'releases', id, 'dist/src/entrypoints/cli.js');
  const node = join(root, 'releases', id, 'node/bin/node');
  const elsewhere = spawnSync(node, [cli, 'setup', '--root', other, '--json'], { encoding: 'utf8' });
  assert.equal(elsewhere.status, 2);
  assert.match(elsewhere.stderr, /RELEASE_ROOT_MISMATCH/);
  await assert.rejects(stat(other), { code: 'ENOENT' });
  // Extraction without preserved permissions under a private umask changes modes: refused, never chmod-repaired.
  const masked = join(work, 'masked');
  await mkdir(masked, { mode: 0o700 });
  assert.equal(spawnSync('sh', ['-c', `umask 077 && tar -xkf "$1" -C "$2"`, 'sh', join(output, report.archive), masked]).status, 0);
  const wrong = factory(masked, ['doctor', '--json']);
  const wrongChecks: Check[] = JSON.parse(wrong.stdout).checks;
  assert.equal(check(wrongChecks, 'release:integrity')?.status, 'blocked');
  assert.match(check(wrongChecks, 'release:integrity')!.message, /RELEASE_INTEGRITY_MISMATCH/);
  assert.equal(wrongChecks.some(item => item.id === 'guest-assets:manifest'), false, 'no asset pin from an unverified release');
  // Same-size content change of one distributed file.
  const target = join(root, 'releases', id, 'assets/skill-pack/factory-skills-v3/manifest.json');
  const original = await readFile(target);
  const changed = Buffer.from(original); changed[0] = changed[0]! ^ 1;
  await chmod(target, 0o644);
  await writeFile(target, changed);
  try {
    const tampered = factory(root, ['doctor', '--json']);
    assert.equal(tampered.status, 3, tampered.stderr);
    const integrity = check(JSON.parse(tampered.stdout).checks, 'release:integrity');
    assert.equal(integrity?.status, 'blocked');
    assert.match(integrity!.message, /RELEASE_INTEGRITY_MISMATCH at assets\/skill-pack\/factory-skills-v3\/manifest.json/);
    assert.deepEqual(await readFile(target), changed, 'never repaired');
  } finally { await writeFile(target, original); }
});

test('foreground run and the explicitly requested user service use the same stable lock; setup registers nothing unless asked', async () => {
  const lock = join(root, 'data', 'control.lock');
  await writeFile(lock, '', { mode: 0o600, flag: 'a' });
  const holder = spawn('flock', ['--exclusive', lock, 'sleep', '30'], { stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = factory(root, ['run']);
    assert.equal(second.status, 73, second.stderr);
    assert.match(second.stderr, /CONTROLLER_ALREADY_RUNNING/);
  } finally { holder.kill('SIGKILL'); }
  const config = join(work, 'xdg');
  const service = factory(root, ['setup', '--service', '--json'], { XDG_CONFIG_HOME: config });
  assert.equal(service.status, 0, service.stderr);
  const result = JSON.parse(service.stdout);
  const unit = join(config, 'systemd/user', result.service.unit);
  assert.equal(result.service.path, unit);
  assert.equal(result.service.state, 'created');
  const text = await readFile(unit, 'utf8');
  assert.match(text, new RegExp(`^ExecStart=${root}/factory run$`, 'm'));
  assert.match(text, /^Restart=no$/m);
  assert.match(text, /^NoNewPrivileges=yes$/m);
  assert.doesNotMatch(text, /^(User|Group|AmbientCapabilities|CapabilityBoundingSet|ExecStartPre)=/m);
  assert.doesNotMatch(text, /sudo|--root/);
  const again = factory(root, ['setup', '--service', '--json'], { XDG_CONFIG_HOME: config });
  assert.equal(JSON.parse(again.stdout).service.state, 'preserved');
  await writeFile(unit, '# operator edited\n');
  const conflict = factory(root, ['setup', '--service', '--json'], { XDG_CONFIG_HOME: config });
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /SERVICE_UNIT_CONFLICT/);
  assert.equal(await readFile(unit, 'utf8'), '# operator edited\n');
  assert.equal(resolve(root), root);
});
