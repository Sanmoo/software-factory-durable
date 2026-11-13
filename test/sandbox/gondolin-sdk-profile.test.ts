import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, stat, readdir, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gondolinSdkProfile, prepareDevelopmentGondolinSdk, verifyDevelopmentGondolinSdk } from '../../src/sandbox/gondolin-sdk-profile.js';

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

test('Gondolin private preparation verifies exact copy/license and never rewrites an existing valid profile', async () => {
  await fixture(async (root, staging) => {
    await assert.rejects(verifyDevelopmentGondolinSdk(root));
    const evidence = await prepareDevelopmentGondolinSdk(root);
    assert.equal((await stat(staging)).mode & 0o777, 0o700);
    const file = join(staging, 'sdk/dist/src/vm/core.js');
    const before = await stat(file), record = await stat(join(staging, 'profile.json'));
    assert.deepEqual(await verifyDevelopmentGondolinSdk(root), evidence);
    assert.deepEqual(await prepareDevelopmentGondolinSdk(root), evidence);
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
