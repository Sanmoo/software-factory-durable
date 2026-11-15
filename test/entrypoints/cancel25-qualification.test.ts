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

test('ticket 25 recipe: import and --plan are inert; own namespace q25-cancel-v1; human steps; no Factory GitHub write; pinned to the issue #18 of the run', async () => {
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
  assert.deepEqual(plan.humanSteps.map((step: { action: string }) => step.action.split(' ')[0]), ['remove', 're-add', 'run,', 'leave']);
  assert.match(plan.humanSteps[2].action, /node dist\/src\/entrypoints\/cli\.js cancel <work id> --root \/home\/sanmoo\/software-factory-test\/y5\/q25-cancel-v1 --request-id q25-cancel-1 --json/,
    'cancellation through the REAL CLI against the recipe owner socket');
  assert.ok(plan.notCovered[0].includes('later real journey'));
  assert.deepEqual([plan.syntheticTicket.pinned, plan.syntheticTicket.number], [true, 18], 'pinned to the issue of the authorized run q25-cancel-v1 (consumed: its namespace exists, so no phase reruns)');
  assert.equal(plan.model.maxActivations, 1);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['run', 'again']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
