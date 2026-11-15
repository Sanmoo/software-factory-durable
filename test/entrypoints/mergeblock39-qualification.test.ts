import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny,
    readdir: deny, copyFile: deny }, defaultExport: deny });
}
const recipe = await import('./mergeblock39-qualification.js');

test('ticket 39 recipe: import and --plan are inert; GET only, no Control, namespace q39-mergeblock-v1, update expected merge-blocking', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q39-mergeblock-v1');
  assert.deepEqual(plan.phases, ['preflight', 'evaluate']);
  assert.deepEqual(plan.expectedRuleset, { id: 26435808, base: 'main', merge: { update: 'blocking', pull_request: 'human-stage', non_fast_forward: 'not-blocking', deletion: 'not-blocking' } });
  assert.equal(plan.model, 'none');
  assert.match(plan.control, /^none/);
  assert.match(plan.github.guard, /anything but GET without input refused/);
  for (const never of ['GitHub write of any kind', 'merge', 'approval or review', 'ready-for-review or draft conversion', 'bypass', 'branch/ruleset/protection change']) assert.ok(plan.github.never.includes(never), never);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['evaluate', 'again']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
