import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real release verification recipe must be inert: no process, filesystem or network effect.
let forbidden = 0;
const deny = () => {
  forbidden++;
  throw new Error('FORBIDDEN_EFFECT');
};
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:fs', 'node:https']) {
  mock.module(name, {
    namedExports: {
      connect: deny,
      createServer: deny,
      execFile: deny,
      spawnSync: deny,
      spawn: deny,
      request: deny,
      open: deny,
      mkdir: deny,
      readFile: deny,
      access: deny,
      readdir: deny,
      lstat: deny,
      createReadStream: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./release32-qualification.js');

test('release recipe: import and --plan are inert and declare a fresh exclusive base, the real asset pin and no external effect', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.base, '/home/sanmoo/software-factory-test/r32-v2', 'v1 was consumed by the supervisor run');
  assert.ok(plan.root.startsWith(`${plan.base}/`) && plan.output.startsWith(`${plan.base}/`) && plan.observations.startsWith(`${plan.base}/`));
  assert.deepEqual(plan.phases, ['build', 'verify', 'install', 'setup', 'doctor', 'controller-refusal']);
  assert.deepEqual(plan.guestAssets, {
    directory: '/home/sanmoo/software-factory-test/assets34/assets',
    manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
  });
  assert.deepEqual([plan.bounds.network, plan.bounds.github, plan.bounds.model, plan.bounds.vm, plan.bounds.retries], ['none', 'none', 'none', 'none', 0]);
  // A phase tombstone is written OUTSIDE the base, before the base is created, so a partial failure never leaves a resumable base.
  for (const phase of plan.phases) {
    const tombstone = recipe.tombstonePath(phase);
    assert.equal(tombstone, `/home/sanmoo/software-factory-test/r32-v2.${phase}-intent.json`);
    assert.equal(tombstone.startsWith(`${plan.base}/`), false);
  }
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['build', 'verify']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('release recipe listing rule: only the launcher, the release tree and its guest assets; no absolute or parent paths', () => {
  const assets = 'a'.repeat(64);
  assert.deepEqual(
    recipe.listingViolations(
      [
        'factory',
        'releases/',
        'releases/x/',
        'releases/x/node/bin/node',
        'assets/',
        'assets/guest/',
        `assets/guest/${assets}/`,
        `assets/guest/${assets}/rootfs.ext4`,
      ],
      'x',
      assets,
    ),
    [],
  );
  assert.deepEqual(
    recipe.listingViolations(['releases/y/a', '/etc/passwd', 'releases/x/../../escape', 'config.yaml', `assets/guest/${'b'.repeat(64)}/k`], 'x', assets),
    ['releases/y/a', '/etc/passwd', 'releases/x/../../escape', 'config.yaml', `assets/guest/${'b'.repeat(64)}/k`],
  );
});
