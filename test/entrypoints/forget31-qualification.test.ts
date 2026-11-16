import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 31 LOCAL recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny,
    readdir: deny, copyFile: deny, stat: deny, lstat: deny, realpath: deny, chmod: deny, rename: deny, rmdir: deny, unlink: deny }, defaultExport: deny });
}
const recipe = await import('./forget31-qualification.js');

test('recipe: import and --plan are inert; own namespace, COPIES of q17-delivery-v4 and q25-cancel-v1, local only, verdict declared', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'forget', 'inspect']);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q31-forget-v1');
  assert.equal(plan.cases.delivered.storage, '/home/sanmoo/software-factory-test/y5/q17-delivery-v4/authority');
  assert.equal(plan.cases.cancelled.storage, '/home/sanmoo/software-factory-test/y5/q25-cancel-v1');
  assert.match(plan.network, /^none:/);
  assert.match(plan.effects[0], /COPY of the storage.*format-1 copy is migrated.*PRIVATE copy/);
  assert.match(plan.effects[1], /expected refused: RESOURCES_PENDING.*labelled recipe environment port.*must answer `existing`/);
  assert.ok(plan.verdict.some((item: string) => /never admitted again/.test(item)));
  assert.deepEqual(recipe.memoryKeys, [...recipe.memoryKeys].sort());
  await assert.rejects(recipe.main(['run']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
