import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRelease, copyTree, verifySkillPackRegistry, runtimeClosure, unaccountedShippedPaths, verifyShippedPackages } from '../../src/entrypoints/release-build.js';
import { inventoryTree, parseReleaseManifest, releaseInstallationRoot, verifyReleaseTree, type TreeEntry } from '../../src/entrypoints/release.js';
import { setupService, standardServiceDirectory } from '../../src/entrypoints/setup.js';

// R-level regression tests of the release verifier/build (ticket 32 static review): the manifest is a claim to VERIFY, never a source of
// trust; every shipped package must be accounted for; symlink containment is resolved, not lexical; duplicate/case-colliding entries fail.
const sha256Of = (text: string) => createHash('sha256').update(text).digest('hex');
async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'release-units-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function packageAt(project: string, key: string, manifest: Record<string, unknown>) {
  await mkdir(join(project, key), { recursive: true });
  await writeFile(join(project, key, 'package.json'), JSON.stringify(manifest));
}
async function project(root: string, packages: Record<string, unknown>, dependencies: Record<string, string>) {
  const lock = { name: 'x', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': { dependencies }, ...packages } };
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', dependencies }));
}

test('inventory: every file is hashed from its bytes; a manifest hash is never used as evidence', async () => {
  await workspace(async root => {
    await mkdir(join(root, 'tree'));
    await writeFile(join(root, 'tree', 'asset'), 'genuine bytes');
    const before = await inventoryTree(join(root, 'tree'));
    const file = before.find(entry => entry[1] === 'f') as [string, 'f', number, number, string];
    assert.equal(file[4], sha256Of('genuine bytes'));
    // A forged expectation with the real size but a different hash is never copied into the result.
    const forged = before.map(entry => entry[1] === 'f' ? [entry[0], 'f', entry[2], entry[3], '0'.repeat(64)] as typeof entry : entry);
    assert.notDeepEqual(await inventoryTree(join(root, 'tree'), [], forged), forged);
    await writeFile(join(root, 'tree', 'asset'), 'tampered byte'); // same size, different content
    const after = await inventoryTree(join(root, 'tree'), [], forged);
    assert.notEqual((after.find(entry => entry[1] === 'f') as [string, 'f', number, number, string])[4], forged.find(entry => entry[1] === 'f')![4]);
  });
});

test('inventory: duplicate and case-colliding manifest paths are refused; case-colliding tree entries are refused', async () => {
  const manifest = {
    schemaVersion: 1, kind: 'software-factory-release', release: 'x', builtAt: new Date().toISOString(),
    node: { version: '24.21.0', path: 'node/bin/node', sha256: 'a'.repeat(64), license: 'node/LICENSE' },
    launcher: { path: 'factory', sha256: 'b'.repeat(64) },
    guestAssets: { path: `assets/guest/${'c'.repeat(64)}`, manifestSha256: 'c'.repeat(64), files: [['manifest.json', 'f', 0o644, 1, 'c'.repeat(64)]] },
    production: { id: 'factory-production-v1' },
    qualification: { status: 'unqualified', statement: 'integrity only' }, metadata: {},
    files: [['a', 'f', 0o644, 1, 'e'.repeat(64)], ['b', 'f', 0o644, 1, 'f'.repeat(64)]],
  };
  assert.ok(parseReleaseManifest(JSON.stringify(manifest)));
  assert.equal(parseReleaseManifest(JSON.stringify({ ...manifest, files: [...manifest.files, manifest.files[0]] })), undefined, 'duplicate path');
  assert.equal(parseReleaseManifest(JSON.stringify({ ...manifest, files: [...manifest.files, ['A', 'f', 0o644, 1, 'f'.repeat(64)]] })), undefined, 'case-colliding path');
  assert.equal(parseReleaseManifest(JSON.stringify({ ...manifest, guestAssets: { ...manifest.guestAssets,
    files: [['manifest.json', 'f', 0o644, 1, 'c'.repeat(64)], ['MANIFEST.json', 'f', 0o644, 1, 'd'.repeat(64)]] } })), undefined, 'assets case collision');
  // The guest manifest file is distributed content whose hash must be the pin itself (it anchors kernel/initramfs/rootfs).
  assert.equal(parseReleaseManifest(JSON.stringify({ ...manifest, guestAssets: { ...manifest.guestAssets,
    files: [['manifest.json', 'f', 0o644, 1, 'd'.repeat(64)]] } })), undefined, 'guest manifest hash differs from the pin');
  assert.equal(parseReleaseManifest(JSON.stringify({ ...manifest, guestAssets: { ...manifest.guestAssets,
    files: [['kernel', 'f', 0o644, 1, 'c'.repeat(64)]] } })), undefined, 'guest manifest missing');
  await workspace(async root => {
    await mkdir(join(root, 'tree'));
    await writeFile(join(root, 'tree', 'name'), 'x');
    await writeFile(join(root, 'tree', 'NAME'), 'y');
    await assert.rejects(inventoryTree(join(root, 'tree')), /RELEASE_CASE_COLLISION/);
  });
});

test('inventory: chained and dangling symlinks are resolved, never trusted lexically', async () => {
  await workspace(async root => {
    const tree = join(root, 'tree'), outside = join(root, 'outside');
    await mkdir(tree); await mkdir(outside);
    await writeFile(join(outside, 'secret'), 'x');
    await writeFile(join(tree, 'real'), 'y');
    await symlink('real', join(tree, 'inside-link')); // relative, resolves inside
    assert.deepEqual((await inventoryTree(tree)).find(entry => entry[0] === 'inside-link'), ['inside-link', 'l', 'real']);
    await symlink('../outside/secret', join(tree, 'hop')); // lexically outside already
    await assert.rejects(inventoryTree(tree), /RELEASE_LINK_ESCAPES/);
    await rm(join(tree, 'hop'));
    await symlink('hop2', join(tree, 'hop1')); // hop1 -> hop2 (lexically inside) -> ../../outside/secret
    await symlink('../outside/secret', join(tree, 'hop2'));
    await assert.rejects(inventoryTree(tree), /RELEASE_LINK_ESCAPES/);
    await rm(join(tree, 'hop1')); await rm(join(tree, 'hop2'));
    // Every link is lexically inside, yet the kernel resolves `sub/up` first: sub/esc -> up/../outside/secret really escapes.
    await mkdir(join(tree, 'sub'));
    await symlink('..', join(tree, 'sub', 'up'));
    await symlink('up/../outside/secret', join(tree, 'sub', 'esc'));
    await assert.rejects(inventoryTree(tree), /RELEASE_LINK_ESCAPES/);
    await rm(join(tree, 'sub'), { recursive: true });
    await symlink('missing', join(tree, 'dangling'));
    await assert.rejects(inventoryTree(tree), /RELEASE_LINK_ESCAPES/);
  });
});

test('copyTree: a link whose resolved target escapes the source is refused even when its lexical path looks contained', async () => {
  await workspace(async root => {
    const source = join(root, 'source'), target = join(root, 'target'), outside = join(root, 'outside');
    await mkdir(join(source, 'sub'), { recursive: true }); await mkdir(outside);
    await writeFile(join(outside, 'secret'), 'x');
    await writeFile(join(source, 'sub', 'file'), 'y');
    await symlink('file', join(source, 'sub', 'good'));
    await copyTree(source, target);
    assert.equal((await lstat(join(target, 'sub', 'good'))).isSymbolicLink(), true); // copied as a link, never followed
    await symlink('../../outside/secret', join(source, 'sub', 'bad')); // sub/bad -> outside (escapes)
    await assert.rejects(copyTree(source, join(root, 'target2')), /RELEASE_SOURCE_LINK_ESCAPES/);
    await rm(join(source, 'sub', 'bad'));
    // Lexically contained links only: sub/up -> .. (the source root) and sub/esc -> up/../outside/secret, which the kernel resolves outside.
    await symlink('..', join(source, 'sub', 'up'));
    await symlink('up/../outside/secret', join(source, 'sub', 'esc'));
    await assert.rejects(copyTree(source, join(root, 'target3')), /RELEASE_SOURCE_LINK_ESCAPES/);
  });
});

test('runtime closure: every present package is visited, but a nested or disguised upstream SDK is refused by package identity', async () => {
  await workspace(async root => {
    const sdk = 'node_modules/@earendil-works/pi-coding-agent', nested = `node_modules/a/node_modules/@earendil-works/pi-coding-agent`;
    await project(root, {
      'node_modules/a': { version: '1.0.0', dependencies: { b: '1.0.0' }, optionalDependencies: { '@earendil-works/pi-coding-agent': '1.5.2' } },
      [nested]: { version: '1.5.2', optional: true },
      'node_modules/b': { version: '1.0.0' },
      [sdk]: { version: '1.5.2' },
    }, { a: '1.0.0' });
    await packageAt(root, 'node_modules/a', { name: 'a', version: '1.0.0' });
    await packageAt(root, nested, { name: '@earendil-works/pi-coding-agent', version: '1.5.2' });
    await packageAt(root, 'node_modules/b', { name: 'b', version: '1.0.0' });
    await packageAt(root, sdk, { name: '@earendil-works/pi-coding-agent', version: '1.5.2' });
    await assert.rejects(runtimeClosure(root), /RELEASE_SDK_UPSTREAM_REQUIRED/);
    await rm(join(root, nested), { recursive: true });
    // A package that merely RENAMES its entry (declares the SDK identity at another path) is the same refusal.
    await rm(join(root, 'node_modules/a/node_modules'), { recursive: true });
    await project(root, {
      'node_modules/a': { version: '1.0.0', dependencies: { b: '1.0.0', disguised: '1.5.2' } },
      'node_modules/b': { version: '1.0.0' }, [sdk]: { version: '1.5.2' },
      'node_modules/disguised': { version: '1.5.2' },
    }, { a: '1.0.0' });
    await packageAt(root, 'node_modules/a', { name: 'a', version: '1.0.0', dependencies: { disguised: '1.5.2' } });
    await packageAt(root, 'node_modules/disguised', { name: '@earendil-works/pi-coding-agent', version: '1.5.2' });
    await assert.rejects(runtimeClosure(root), /RELEASE_SDK_UPSTREAM_REQUIRED/);
  });
});

test('runtime closure: optional edges are refused when they would need shipping and recorded when genuinely omitted', async () => {
  await workspace(async root => {
    // Platform-excluded optional dependency: recorded, not shipped.
    await project(root, {
      'node_modules/a': { version: '1.0.0', optionalDependencies: { darwinOnly: '1.0.0' } },
      'node_modules/darwinOnly': { version: '1.0.0', optional: true, os: ['darwin'], cpu: ['arm64'] },
      'node_modules/@earendil-works/pi-coding-agent': { version: '1.5.2' },
    }, { a: '1.0.0' });
    await packageAt(root, 'node_modules/a', { name: 'a', version: '1.0.0' });
    await packageAt(root, 'node_modules/@earendil-works/pi-coding-agent', { name: '@earendil-works/pi-coding-agent', version: '1.5.2' });
    const closure = await runtimeClosure(root);
    assert.deepEqual(closure.keys, ['node_modules/a']);
    assert.deepEqual(closure.omitted, [{ from: 'node_modules/a', dependency: 'darwinOnly', reason: 'platform-excluded' }]);
    // Optional but installable and missing: refuse instead of shipping an incomplete closure.
    await project(root, {
      'node_modules/a': { version: '1.0.0', optionalDependencies: { needed: '1.0.0' } },
      'node_modules/needed': { version: '1.0.0', optional: true }, 'node_modules/@earendil-works/pi-coding-agent': { version: '1.5.2' },
    }, { a: '1.0.0' });
    await assert.rejects(runtimeClosure(root), /RELEASE_DEPENDENCY_MISSING/);
    // Platform-gated, but THIS platform satisfies the gate: its absence is an incomplete closure, not an exclusion.
    await project(root, {
      'node_modules/a': { version: '1.0.0', optionalDependencies: { native: '1.0.0' } },
      'node_modules/native': { version: '1.0.0', optional: true, os: [platform()], cpu: [arch()] },
      'node_modules/@earendil-works/pi-coding-agent': { version: '1.5.2' },
    }, { a: '1.0.0' });
    await assert.rejects(runtimeClosure(root), /RELEASE_DEPENDENCY_MISSING/);
    // A required dependency without any lock entry is refused (never silently skipped).
    await project(root, {
      'node_modules/a': { version: '1.0.0', dependencies: { ghost: '1.0.0' } },
      'node_modules/@earendil-works/pi-coding-agent': { version: '1.5.2' },
    }, { a: '1.0.0' });
    await assert.rejects(runtimeClosure(root), /RELEASE_DEPENDENCY_MISSING/);
    // Optional peer without a lock entry is normally not installed: recorded, not a failure.
    await project(root, {
      'node_modules/a': { version: '1.0.0', peerDependencies: { peer: '*' }, peerDependenciesMeta: { peer: { optional: true } } },
      'node_modules/@earendil-works/pi-coding-agent': { version: '1.5.2' },
    }, { a: '1.0.0' });
    await packageAt(root, 'node_modules/a', { name: 'a', version: '1.0.0' });
    const peers = await runtimeClosure(root);
    assert.deepEqual(peers.keys, ['node_modules/a']);
    assert.deepEqual(peers.omitted, [{ from: 'node_modules/a', dependency: 'peer', reason: 'optional-peer' }]);
    // An optional peer that exists in the lock but is NOT installed is also genuinely omitted, never a shipping requirement.
    await project(root, {
      'node_modules/a': { version: '1.0.0', peerDependencies: { peer: '*' }, peerDependenciesMeta: { peer: { optional: true } } },
      'node_modules/peer': { version: '1.0.0' },
      'node_modules/@earendil-works/pi-coding-agent': { version: '1.5.2' },
    }, { a: '1.0.0' });
    await packageAt(root, 'node_modules/a', { name: 'a', version: '1.0.0' });
    await packageAt(root, 'node_modules/@earendil-works/pi-coding-agent', { name: '@earendil-works/pi-coding-agent', version: '1.5.2' });
    const absentPeers = await runtimeClosure(root);
    assert.deepEqual(absentPeers.keys, ['node_modules/a']);
    assert.deepEqual(absentPeers.omitted, [{ from: 'node_modules/a', dependency: 'peer', reason: 'optional-peer' }]);
  });
});

test('shipped packages must be exactly the computed closures: unaccounted, nested or misplaced node_modules entries are refused', async () => {
  const dir = (path: string): TreeEntry => [path, 'd', 0o755];
  const file = (path: string): TreeEntry => [path, 'f', 0o644, 1, 'a'.repeat(64)];
  const sdk = '.scratch/sdk/sdk';
  const closures = [{ root: '', keys: ['node_modules/a', 'node_modules/@scope/b', 'node_modules/a/node_modules/c'] },
    { root: sdk, keys: ['node_modules/d'] }];
  const good: TreeEntry[] = [dir('dist'), file('dist/x.js'), dir('node_modules'), dir('node_modules/@scope'), dir('node_modules/@scope/b'),
    file('node_modules/@scope/b/index.js'), dir('node_modules/a'), file('node_modules/a/index.js'), dir('node_modules/a/node_modules'),
    dir('node_modules/a/node_modules/c'), file('node_modules/a/node_modules/c/index.js'), dir(sdk), file(`${sdk}/package.json`),
    dir(`${sdk}/node_modules`), dir(`${sdk}/node_modules/d`), file(`${sdk}/node_modules/d/index.js`), ['.scratch/g/node_modules', 'l', '../../node_modules'],
    dir(`${sdk}/node_modules/.bin`), [`${sdk}/node_modules/.bin/d`, 'l', '../d/index.js']];
  assert.deepEqual(unaccountedShippedPaths(good, closures, ['.scratch/g/node_modules']), []);
  // A package outside the closure, a nested tree under a key, a node_modules anywhere else, a link not explicitly allowed.
  assert.deepEqual(unaccountedShippedPaths([...good, dir('node_modules/rogue'), file('node_modules/rogue/index.js')], closures, ['.scratch/g/node_modules']),
    ['node_modules/rogue', 'node_modules/rogue/index.js']);
  assert.deepEqual(unaccountedShippedPaths([...good, file('node_modules/a/node_modules/deep/index.js')], closures, ['.scratch/g/node_modules']),
    ['node_modules/a/node_modules/deep/index.js']);
  assert.deepEqual(unaccountedShippedPaths([...good, file('dist/node_modules/x/index.js'), file(`${sdk}/node_modules/e/index.js`)], closures,
    ['.scratch/g/node_modules']), [`${sdk}/node_modules/e/index.js`, 'dist/node_modules/x/index.js']);
  assert.deepEqual(unaccountedShippedPaths(good, closures), ['.scratch/g/node_modules']);
  // npm bin links are accounted only when they point into a package of the closure.
  assert.deepEqual(unaccountedShippedPaths([...good, ['node_modules/.bin', 'd', 0o755], ['node_modules/.bin/x', 'l', '../rogue/x.js'],
    ['node_modules/.bin/a', 'l', '../a/index.js']], closures, ['.scratch/g/node_modules']), ['node_modules/.bin/x']);
  await workspace(async root => {
    await mkdir(join(root, 'node_modules/a/vendor'), { recursive: true });
    await writeFile(join(root, 'node_modules/a/package.json'), JSON.stringify({ name: 'a' }));
    const entries: TreeEntry[] = [dir('node_modules'), dir('node_modules/a'), file('node_modules/a/package.json')];
    await verifyShippedPackages(root, entries, [{ root: '', keys: ['node_modules/a'] }]);
    await assert.rejects(verifyShippedPackages(root, [...entries, file('node_modules/rogue/x.js')], [{ root: '', keys: ['node_modules/a'] }]),
      /RELEASE_UNACCOUNTED_PACKAGE node_modules\/rogue\/x.js/);
    // A vendored copy that declares the upstream SDK identity inside an accounted package is refused by package identity.
    await writeFile(join(root, 'node_modules/a/vendor/package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
    await assert.rejects(verifyShippedPackages(root, [...entries, dir('node_modules/a/vendor'), file('node_modules/a/vendor/package.json')],
      [{ root: '', keys: ['node_modules/a'] }]), /RELEASE_SDK_UPSTREAM_REQUIRED/);
  });
});

test('build refuses an existing output directory explicitly and never adopts it', async () => {
  await workspace(async root => {
    const output = join(root, 'existing');
    await mkdir(output);
    await writeFile(join(output, 'keep'), 'preserved');
    await assert.rejects(buildRelease({ release: 'x', output, guestAssets: { directory: join(root, 'missing'), manifestSha256: 'a'.repeat(64) } }),
      /RELEASE_OUTPUT_EXISTS/);
    assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'preserved');
    assert.deepEqual((await (await import('node:fs/promises')).readdir(output)).sort(), ['keep']);
    assert.equal(resolve(output), output);
  });
});

test('development is only an EXPLICIT marker: a tree without a manifest and without the marker is an invalid release', async () => {
  await workspace(async root => {
    await mkdir(join(root, 'checkout'));
    const unmarked = await verifyReleaseTree(join(root, 'checkout'));
    assert.deepEqual(unmarked, { kind: 'invalid', code: 'RELEASE_MANIFEST_MISSING' });
    await writeFile(join(root, 'checkout', 'development-checkout.json'), JSON.stringify({ kind: 'factory-development-checkout' }) + '\n');
    assert.deepEqual(await verifyReleaseTree(join(root, 'checkout')), { kind: 'development' });
    // Marker content is exact: anything else (a release trying to look like a checkout) is not a development fallback.
    await writeFile(join(root, 'checkout', 'development-checkout.json'), JSON.stringify({ kind: 'other' }));
    assert.deepEqual(await verifyReleaseTree(join(root, 'checkout')), { kind: 'invalid', code: 'RELEASE_MANIFEST_MISSING' });
    // A release location (`<root>/releases/<id>`) is never development, marker or not.
    const located = join(root, 'installation', 'releases', 'mvp-32.1');
    await mkdir(located, { recursive: true });
    await writeFile(join(located, 'development-checkout.json'), JSON.stringify({ kind: 'factory-development-checkout' }) + '\n');
    assert.deepEqual(await verifyReleaseTree(located), { kind: 'invalid', code: 'RELEASE_MANIFEST_MISSING' });
  });
});

test('root pinning is structural: the environment never selects an installation root', () => {
  const saved = process.env.FACTORY_INSTALLATION_ROOT;
  process.env.FACTORY_INSTALLATION_ROOT = '/elsewhere';
  try { assert.equal(releaseInstallationRoot(), undefined, 'this development checkout is not releases/<id> of any root'); }
  finally { if (saved === undefined) delete process.env.FACTORY_INSTALLATION_ROOT; else process.env.FACTORY_INSTALLATION_ROOT = saved; }
});

test('service unit: default directory comes from the account database, never HOME or XDG_CONFIG_HOME; explicit directories are canonical', async () => {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = '/nonexistent-home-decoy'; process.env.XDG_CONFIG_HOME = '/nonexistent-xdg-decoy';
  try { assert.equal(standardServiceDirectory(), join(userInfo().homedir, '.config', 'systemd', 'user')); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.notEqual(userInfo().homedir, '/nonexistent-home-decoy');
  await assert.rejects(setupService('/srv/factory', 'relative/units'), /SERVICE_DIRECTORY_UNSUPPORTED/);
  await assert.rejects(setupService('/srv/factory', '/tmp/a/../units'), /SERVICE_DIRECTORY_UNSUPPORTED/);
});

test('skill packs shipped are exactly the registered ones (factorySkillPackIds), each verified; unregistered or missing packs refuse', async () => {
  await workspace(async root => {
    await mkdir(join(root, 'packs', 'p1'), { recursive: true }); await mkdir(join(root, 'packs', 'p2'));
    const verified: string[] = [];
    const verify = async (id: string) => { verified.push(id); };
    await verifySkillPackRegistry(join(root, 'packs'), ['p1', 'p2'], verify);
    assert.deepEqual(verified, ['p1', 'p2']);
    await assert.rejects(verifySkillPackRegistry(join(root, 'packs'), ['p1', 'p2', 'p3'], verify), /RELEASE_SKILL_PACKS_DRIFT/);
    await assert.rejects(verifySkillPackRegistry(join(root, 'packs'), ['p1'], verify), /RELEASE_SKILL_PACKS_DRIFT/);
    await assert.rejects(verifySkillPackRegistry(join(root, 'packs'), ['p1', 'p2'], async () => { throw new Error('WORKER_SKILL_PACK_DRIFT'); }),
      /WORKER_SKILL_PACK_DRIFT/);
  });
});
