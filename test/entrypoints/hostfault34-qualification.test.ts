import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-HOSTFAULT real-run recipe must be inert: no process, socket, filesystem or SDK effect. A phase without the
// exact argument shape is refused before any effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', 'node:http', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    access: deny, readdir: deny, copyFile: deny, statfs: deny, stat: deny, realpath: deny }, defaultExport: deny });
}
const recipe = await import('./hostfault34-qualification.js');

test('R-HOSTFAULT recipe: import and --plan are inert; own namespace; the disposable image, the operator mount (rootless and sudo) and the never-list are explicit', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-hostfault-v1');
  assert.deepEqual(plan.phases, ['image', 'preflight', 'floor', 'full', 'native', 'release', 'inspect']);
  assert.equal(plan.image.path, '/home/sanmoo/software-factory-test/y5/q34-hostfault-v1/disk.img');
  assert.match(plan.image.preallocated, /fallocate \(never sparse\)/);
  assert.ok(plan.maxDisposableBytes <= 8 * 1024 ** 3);
  assert.ok(plan.operator.afterImage.rootless.some((step: string) => step.startsWith('udisksctl loop-setup')), 'a rootless mount is proposed');
  assert.ok(plan.operator.afterImage.sudo.some((step: string) => step.startsWith('sudo mount -o loop,nosuid,nodev,noexec')), 'the sudo alternative is explicit');
  assert.match(plan.operator.afterImage.note, /never runs sudo, mount or losetup/);
  assert.ok(plan.requires.some((item: string) => /explicit operator authorization for THIS run/.test(item)));
  assert.ok(plan.requires.some((item: string) => /no VM, GitHub, model or credential/.test(item)));
  assert.ok(plan.guards.some((item: string) => /deletes only files it created under <mount>\/filler/.test(item)));
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main([]), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0, 'the refusals happen before any effect');
});
