import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    access: deny, readdir: deny, copyFile: deny }, defaultExport: deny });
}
const recipe = await import('./cancel25-qualification.js');

test('ticket 25 recipe: import and --plan are inert; own namespace q25-cancel-v1; human steps; no Factory GitHub write; unpinned ticket refuses every real phase', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q25-cancel-v1');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'new', 'inspect', 'stop-environment']);
  assert.match(plan.github.accessRoot, /^\/home\/sanmoo\/software-factory-test\/y5\/q25-cancel-v1 \(own namespace/);
  assert.match(plan.github.writes, /^none by the Factory/);
  assert.match(plan.github.builderPurpose, /read-only/);
  assert.deepEqual(plan.humanSteps.map((step: { action: string }) => step.action.split(' ')[0]), ['remove', 're-add', 'create', 'leave']);
  assert.equal(plan.syntheticTicket.pinned, false, 'the synthetic issue does not exist yet: the supervisor pins it after creating it');
  assert.equal(plan.model.maxActivations, 1);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['run', 'again']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/, 'nothing is created before the ticket is pinned');
  assert.equal(forbidden, 0);
});
