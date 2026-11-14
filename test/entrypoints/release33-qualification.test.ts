import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real upgrade verification recipe must be inert: no process, filesystem or network effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:fs', 'node:https']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, spawnSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny,
    readFile: deny, access: deny, readdir: deny, lstat: deny, createReadStream: deny }, defaultExport: deny });
}
const recipe = await import('./release33-qualification.js');

test('upgrade recipe: import and --plan are inert; fresh exclusive base, v1 = the built r32 archive (read only), no external effect', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.base, '/home/sanmoo/software-factory-test/r33-v1');
  assert.ok(plan.root.startsWith(`${plan.base}/`) && plan.output.startsWith(`${plan.base}/`) && plan.observations.startsWith(`${plan.base}/`));
  assert.equal(plan.v1.build.startsWith(plan.base), false, 'v1 is only read');
  assert.deepEqual([plan.v1.release, plan.v2.release, plan.migration], ['mvp-32.1', 'mvp-33.1', 'factory-storage-1-to-2']);
  assert.deepEqual(plan.phases, ['build', 'install-v1', 'seed-v1', 'extract-v2', 'check-and-refusals', 'interrupted-migration', 'start-v2']);
  assert.deepEqual(plan.guestAssets.manifestSha256, '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807');
  assert.match(plan.bounds.network, /^none/);
  assert.deepEqual([plan.bounds.github, plan.bounds.model, plan.bounds.retries], ['none', 'none', 0]);
  for (const phase of plan.phases) {
    const tombstone = recipe.tombstonePath(phase);
    assert.equal(tombstone, `/home/sanmoo/software-factory-test/r33-v1.${phase}-intent.json`);
    assert.equal(tombstone.startsWith(`${plan.base}/`), false);
  }
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['build', 'install-v1']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
