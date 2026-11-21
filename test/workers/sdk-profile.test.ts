import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageMimeFacade, prepareDevelopmentSdk, sdkProfile, sdkStagingDirectory } from '../../src/workers/sdk-profile.js';

// A private project copy (installed SDK, lockfile, adopted patches): the drift fixtures never touch the
// shared staged SDK in this checkout's .scratch, so the test is safe next to any concurrent reader of it.
async function privateProject() {
  const root = await mkdtemp(join(tmpdir(), 'sdkp-'));
  await mkdir(join(root, 'node_modules/@earendil-works'), { recursive: true });
  await cp('node_modules/@earendil-works/pi-coding-agent', join(root, 'node_modules/@earendil-works/pi-coding-agent'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await cp('package-lock.json', join(root, 'package-lock.json'));
  await mkdir(join(root, 'docs/evidence'), { recursive: true });
  for (const patch of ['05-sdk-read-operations-candidate.patch', '05-sdk-async-bash-v2.patch', '05-sdk-lexical-queue-v3.patch']) {
    await cp(join('docs/evidence', patch), join(root, 'docs/evidence', patch));
  }
  await mkdir(join(root, '.scratch'));
  return root;
}

test('private pinned SDK preparation is idempotent and refuses drift without overwriting it', async () => {
  const shared = await readFile('node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js');
  const root = await privateProject();
  try {
    const original = await readFile(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js'));
    assert.deepEqual(await prepareDevelopmentSdk(root), await prepareDevelopmentSdk(root));
    const readme = join(root, sdkStagingDirectory, 'sdk/README.md');
    const before = await readFile(readme);
    await writeFile(readme, Buffer.concat([before, Buffer.from('\nOWNED DRIFT FIXTURE\n')]));
    await assert.rejects(prepareDevelopmentSdk(root), /SDK_STAGING_DRIFT/);
    assert.match(await readFile(readme, 'utf8'), /OWNED DRIFT FIXTURE/);
    await writeFile(readme, before);
    const facade = join(root, sdkStagingDirectory, imageMimeFacade.file);
    const facadeBefore = await readFile(facade, 'utf8');
    assert.equal(facadeBefore, imageMimeFacade.bytes);
    await writeFile(facade, facadeBefore + '// OWNED FACADE DRIFT FIXTURE\n');
    await assert.rejects(prepareDevelopmentSdk(root), /SDK_FACADE_DRIFT/);
    assert.match(await readFile(facade, 'utf8'), /OWNED FACADE DRIFT/);
    await writeFile(facade, facadeBefore);
    const evidence = await prepareDevelopmentSdk(root);
    assert.equal(evidence.resultSHA256, sdkProfile.resultSHA256);
    assert.equal(evidence.license, 'MIT');
    assert.deepEqual(await readFile(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js')), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(await readFile('node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js'), shared);
});
