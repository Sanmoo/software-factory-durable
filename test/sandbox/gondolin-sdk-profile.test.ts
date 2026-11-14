import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, readdir, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gondolinSdkProfile, prepareDevelopmentGondolinSdk, verifyDevelopmentGondolinSdk } from '../../src/sandbox/gondolin-sdk-profile.js';
import { prepareReleaseGondolinSdk } from '../../src/sandbox/index.js';

// Distribution and corrected sources are filesystem DATA only. No SDK entry/module evaluation.
async function fixture(run: (root: string, staging: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gdp-'));
  try {
    await mkdir(join(root, 'node_modules/@earendil-works'), { recursive: true });
    await cp('node_modules/@earendil-works/gondolin', join(root, 'node_modules/@earendil-works/gondolin'), { recursive: true });
    for (const name of ['cbor2', 'ssh2', 'undici', '@earendil-works/gondolin-krun-runner-linux-x64']) {
      const target = join(root, 'node_modules', name, 'package.json');
      await mkdir(dirname(target), { recursive: true });
      await cp(join('node_modules', name, 'package.json'), target);
    }
    await cp('package-lock.json', join(root, 'package-lock.json'));
    await mkdir(join(root, 'docs/evidence'), { recursive: true });
    await cp('docs/evidence/gondolin-sdk-v1', join(root, 'docs/evidence/gondolin-sdk-v1'), { recursive: true });
    await mkdir(join(root, '.scratch'));
    await run(root, join(root, gondolinSdkProfile.directory));
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Independent of the production inventory/verifier and its provenance comparisons.
async function originalSnapshot(root: string) {
  const source = join(root, 'node_modules/@earendil-works/gondolin');
  const snapshot: Record<string, string> = {};
  async function visit(relative: string) {
    for (const name of (await readdir(join(source, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, name.name);
      if (name.isDirectory()) await visit(path);
      else {
        assert.ok(name.isFile());
        snapshot[path] = createHash('sha256').update(await readFile(join(source, path))).digest('hex');
      }
    }
  }
  await visit('');
  assert.equal(Object.keys(snapshot).length, 407);
  for (const helper of ['stdin-capacity.js', 'stdin-capacity.d.ts']) {
    await assert.rejects(stat(join(source, 'dist/src/sandbox', helper)), { code: 'ENOENT' });
  }
  return snapshot;
}

test('Gondolin private preparation verifies exact copy/license and never rewrites an existing valid profile', async () => {
  await fixture(async (root, staging) => {
    await assert.rejects(verifyDevelopmentGondolinSdk(root));
    const originals = await originalSnapshot(root);
    const evidence = await prepareDevelopmentGondolinSdk(root);
    assert.deepEqual(await originalSnapshot(root), originals);
    assert.equal((await stat(staging)).mode & 0o777, 0o700);
    const file = join(staging, 'sdk/dist/src/vm/core.js');
    const before = await stat(file), record = await stat(join(staging, 'profile.json'));
    assert.deepEqual(await verifyDevelopmentGondolinSdk(root), evidence);
    assert.deepEqual(await prepareDevelopmentGondolinSdk(root), evidence);
    assert.deepEqual(await originalSnapshot(root), originals);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    assert.equal((await stat(join(staging, 'profile.json'))).mtimeMs, record.mtimeMs);
    assert.deepEqual(await readFile(join(staging, 'sdk/LICENSE')), await readFile(join(root, 'node_modules/@earendil-works/gondolin/LICENSE')));
    await writeFile(file, 'owned drift');
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await assert.rejects(verifyDevelopmentGondolinSdk(root), /GONDOLIN_/);
    assert.equal(await readFile(file, 'utf8'), 'owned drift');
  });
});

test('source wrong version/hash and missing or changed corrected helper fail before root creation', async () => {
  await fixture(async (root, staging) => {
    const source = join(root, 'node_modules/@earendil-works/gondolin/package.json');
    const bytes = await readFile(source);
    await writeFile(source, bytes.toString().replace('"0.14.0"', '"0.14.1"'));
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await assert.rejects(stat(staging), { code: 'ENOENT' });
    await writeFile(source, bytes);
    const readme = join(root, 'node_modules/@earendil-works/gondolin/README.md');
    const readmeBytes = await readFile(readme);
    const wrongHash = Buffer.from(readmeBytes);
    wrongHash[0] = (wrongHash[0] ?? 0) ^ 1;
    await writeFile(readme, wrongHash);
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_SOURCE_TREE/);
    await assert.rejects(stat(staging), { code: 'ENOENT' });
    await writeFile(readme, readmeBytes);
    const helper = join(root, 'docs/evidence/gondolin-sdk-v1/corrected/dist/src/sandbox/stdin-capacity.js.data');
    const data = await readFile(helper);
    await rm(helper);
    await assert.rejects(prepareDevelopmentGondolinSdk(root));
    await assert.rejects(stat(staging), { code: 'ENOENT' });
    await writeFile(helper, 'changed');
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await writeFile(helper, data);
    const lock = join(root, 'package-lock.json');
    const original = await readFile(lock);
    await writeFile(lock, original.toString().replace('sha512-MSw+', 'sha512-WRONG'));
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await assert.rejects(stat(staging), { code: 'ENOENT' });
  });
});

test('root symlink, incomplete root, wrong mode and unexpected entries are refused without repair', async () => {
  await fixture(async (root, staging) => {
    await symlink(join(root, '.scratch'), staging);
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await rm(staging);
    await mkdir(staging, { mode: 0o700 });
    await assert.rejects(prepareDevelopmentGondolinSdk(root));
    assert.deepEqual(await readdir(staging), []);
    await rm(staging, { recursive: true });
    await prepareDevelopmentGondolinSdk(root);
    await chmod(staging, 0o755);
    await assert.rejects(verifyDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await chmod(staging, 0o1700);
    await assert.rejects(verifyDevelopmentGondolinSdk(root), /GONDOLIN_UNSAFE_PATH/);
    await chmod(staging, 0o700);
    const copiedDirectory = join(staging, 'sdk/dist');
    await chmod(copiedDirectory, 0o700);
    await assert.rejects(verifyDevelopmentGondolinSdk(root), /GONDOLIN_TREE_SHAPE/);
    await chmod(copiedDirectory, 0o755);
    await writeFile(join(staging, 'unexpected'), 'leave untouched');
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    assert.equal(await readFile(join(staging, 'unexpected'), 'utf8'), 'leave untouched');
  });
});

test('copied helper absence and source or dependency-link symlink escape fail closed', async () => {
  await fixture(async (root, staging) => {
    await prepareDevelopmentGondolinSdk(root);
    const dependencyLink = join(staging, 'node_modules');
    await rm(dependencyLink);
    await symlink(join(root, '.scratch'), dependencyLink);
    await assert.rejects(verifyDevelopmentGondolinSdk(root), /GONDOLIN_DEPENDENCY_LINK/);
    await rm(dependencyLink);
    await symlink(join(root, 'node_modules'), dependencyLink);
    await rm(join(staging, 'sdk/dist/src/sandbox/stdin-capacity.js'));
    await assert.rejects(verifyDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await rm(staging, { recursive: true }); // Only this fixture owns this root.
    const file = join(root, 'node_modules/@earendil-works/gondolin/README.md');
    await rm(file);
    await symlink(join(root, 'package-lock.json'), file);
    await assert.rejects(prepareDevelopmentGondolinSdk(root), /GONDOLIN_/);
    await assert.rejects(stat(staging), { code: 'ENOENT' });
  });
});

for (const tree of ['source', 'copied'] as const) {
  for (const kind of ['file', 'directory'] as const) {
    test(`${tree} inventory rejects late unknown ${kind} before unknown access or distribution hashing`, async () => {
      await fixture(async (root, staging) => {
        if (tree === 'copied') await prepareDevelopmentGondolinSdk(root);
        const sdk = tree === 'source' ? join(root, 'node_modules/@earendil-works/gondolin') : join(staging, 'sdk');
        // Sorts after dist/src/vm/core.js: inline hashing during traversal is observable.
        const unknown = join(sdk, 'zzzz-unknown');
        if (kind === 'directory') {
          await mkdir(unknown, { mode: 0o700 });
          await writeFile(join(unknown, 'sentinel'), 'leave untouched');
        } else await writeFile(unknown, 'leave untouched');
        const calls: { operation: string; path: string }[] = [];
        const spies = [];
        for (const operation of ['lstat', 'open', 'readFile', 'readdir'] as const) {
          const original = fs.promises[operation];
          spies.push(mock.method(fs.promises, operation, (...args: unknown[]) => {
            calls.push({ operation, path: String(args[0]) });
            return Reflect.apply(original, fs.promises, args);
          }));
        }
        syncBuiltinESMExports();
        try {
          await assert.rejects(tree === 'source' ? prepareDevelopmentGondolinSdk(root) : verifyDevelopmentGondolinSdk(root), /GONDOLIN_TREE_SHAPE/);
        } finally {
          for (const spy of spies) spy.mock.restore();
          syncBuiltinESMExports();
        }
        assert.ok(calls.some(call => call.operation === 'lstat' && call.path === join(sdk, 'dist/src/vm/core.js')), 'known core traversed before late rejection');
        assert.deepEqual(calls.filter(call => call.path === unknown || call.path.startsWith(unknown + '/')), [], 'unknown entry never statted/opened/read/descended');
        const content = calls.filter(call => ['open', 'readFile'].includes(call.operation) && call.path.startsWith(sdk + '/'));
        // Source package VERSION metadata is intentionally read before inventory.
        // Source validity hashing before the copied walk is legitimate and outside sdk here.
        assert.deepEqual(content.map(call => [call.operation, call.path]), tree === 'source' ? [['readFile', join(sdk, 'package.json')]] : []);
        assert.equal(await readFile(kind === 'directory' ? join(unknown, 'sentinel') : unknown, 'utf8'), 'leave untouched');
        if (kind === 'directory') assert.deepEqual(await readdir(unknown), ['sentinel']);
        if (tree === 'source') await assert.rejects(stat(staging), { code: 'ENOENT' });
        else assert.ok((await readdir(sdk)).includes('zzzz-unknown'), 'verifier neither cleans nor repairs');
      });
    });
  }
}

test('release form (ticket 32): relative link to the SAME canonical node_modules verifies path-independently; nothing else is accepted', async () => {
  await fixture(async (root, staging) => {
    const evidence = await prepareReleaseGondolinSdk(root);
    assert.equal(await readlink(join(staging, 'node_modules')), '../../node_modules');
    assert.equal(evidence.dependencyLink, '../../node_modules');
    assert.doesNotMatch(await readFile(join(staging, 'profile.json'), 'utf8'), new RegExp(root));
    assert.deepEqual(await verifyDevelopmentGondolinSdk(root), evidence);
    assert.deepEqual(await prepareReleaseGondolinSdk(root), evidence); // Existing valid root: verified, never rewritten.
    const moved = `${root}-moved`;
    await rename(root, moved);
    try {
      assert.deepEqual(await verifyDevelopmentGondolinSdk(moved), evidence);
      const link = join(moved, gondolinSdkProfile.directory, 'node_modules');
      await rm(link);
      await symlink('../../.scratch', link);
      await assert.rejects(verifyDevelopmentGondolinSdk(moved), /GONDOLIN_DEPENDENCY_LINK/);
      await rm(link);
      await symlink('../../node_modules/', link); // Equivalent spelling is still not the exact pinned link.
      await assert.rejects(verifyDevelopmentGondolinSdk(moved), /GONDOLIN_DEPENDENCY_LINK/);
      await rm(link);
      await symlink(join(moved, 'node_modules'), link); // Absolute form with a relative-form record: record mismatch.
      await assert.rejects(verifyDevelopmentGondolinSdk(moved), /GONDOLIN_PROFILE_DRIFT/);
    } finally { await rename(moved, root); }
  });
});
