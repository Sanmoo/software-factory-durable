import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { prepareDevelopmentSdk, sdkProfile } from '../../src/workers/sdk-profile.js';

test('private pinned SDK preparation is idempotent and refuses drift without overwriting it', { timeout: 15000 }, async () => {
  const original = await readFile('node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js');
  assert.deepEqual(await prepareDevelopmentSdk(), await prepareDevelopmentSdk());
  const readme = '.scratch/factory-development-sdk/sdk/README.md';
  const before = await readFile(readme);
  try {
    await writeFile(readme, Buffer.concat([before, Buffer.from('\nOWNED DRIFT FIXTURE\n')]));
    await assert.rejects(prepareDevelopmentSdk(), /SDK_STAGING_DRIFT/);
    assert.match(await readFile(readme, 'utf8'), /OWNED DRIFT FIXTURE/);
  } finally { await writeFile(readme, before); }
  const evidence = await prepareDevelopmentSdk();
  assert.equal(evidence.resultSHA256, sdkProfile.resultSHA256);
  assert.equal(evidence.license, 'MIT');
  assert.deepEqual(await readFile('node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js'), original);
});
