import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../../src/entrypoints/release-build.js';
import { builtRelease, check, id, manifestSha256, sha, type Check } from './release-fixture.js';

// I-local (ticket 32): artifact layout/manifest pins and explicit failures of a changed, mis-extracted or foreign-root release.
let work: string, output: string, root: string, report: Awaited<ReturnType<typeof buildRelease>>, factory: Awaited<ReturnType<typeof builtRelease>>['factory'];
before(async () => ({ work, output, root, report, factory } = await builtRelease()));
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
  const wrong = factory(masked, ['setup', '--json']);
  assert.equal(wrong.status, 0, wrong.stderr);
  const wrongChecks: Check[] = JSON.parse(wrong.stdout).diagnostics.checks;
  assert.equal(check(wrongChecks, 'release:integrity')?.status, 'blocked');
  assert.match(check(wrongChecks, 'release:integrity')!.message, /RELEASE_INTEGRITY_MISMATCH/);
  assert.equal(wrongChecks.some(item => item.id === 'guest-assets:manifest'), false, 'no asset pin from an unverified release');
  // Its controller refuses before opening storage.
  const owner = factory(masked, ['run']);
  assert.equal(owner.status, 2, owner.stderr);
  assert.match(owner.stderr, /RELEASE_INVALID/);
  await assert.rejects(stat(join(masked, 'data', 'control.sqlite')), { code: 'ENOENT' });
  // Same-size content change of one distributed file.
  const target = join(root, 'releases', id, 'assets/skill-pack/factory-skills-v3/manifest.json');
  const original = await readFile(target);
  const changed = Buffer.from(original); changed[0] = changed[0]! ^ 1;
  await chmod(target, 0o644);
  await writeFile(target, changed);
  try {
    const tampered = factory(root, ['doctor', '--json']);
    assert.equal(tampered.status, 2, tampered.stderr); // This root has no configuration yet; the release check is blocked regardless.
    const integrity = check(JSON.parse(tampered.stdout).checks, 'release:integrity');
    assert.equal(integrity?.status, 'blocked');
    assert.match(integrity!.message, /RELEASE_INTEGRITY_MISMATCH at assets\/skill-pack\/factory-skills-v3\/manifest.json/);
    assert.deepEqual(await readFile(target), changed, 'never repaired');
  } finally { await writeFile(target, original); }
});

