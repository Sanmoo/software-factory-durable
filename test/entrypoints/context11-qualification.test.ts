import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 11 real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny,
    readdir: deny, spawn: deny }, defaultExport: deny });
}
const recipe = await import('./context11-qualification.js');

test('recipe: import and --plan are inert and declare the fixed bounds (3 activations, <= 1 Question comment per phase on #3, fixed scope request)', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'ask', 'continue', 'scope', 'inspect', 'stop-environment']);
  assert.deepEqual([plan.model.maxActivations, plan.model.perActivation.maxRequests, plan.model.perActivation.deadlineMinutes, plan.model.providerRetries, plan.model.sdkRetries],
    [3, 60, 30, 0, 0]);
  assert.match(plan.github.writes, /at most ONE POST \/repos\/Sanmoo\/java-springboot-event-sourcing\/issues\/3\/comments per phase/);
  assert.match(plan.github.builderPurpose, /never widened for the private source/);
  assert.deepEqual(plan.operators, ['Sanmoo']);
  assert.equal(plan.skillPack, 'factory-skills-v4');
  assert.equal(plan.revision, 'q11-context-v1');
  assert.equal(plan.root, '/home/sanmoo/software-factory-test/y5');
  // The replacement subcase is a deliberate Host policy change (tool set without edit), not a damaged session.
  assert.deepEqual(plan.policies.full, { skillPack: 'factory-skills-v4', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 });
  assert.deepEqual(plan.policies.withoutEdit, { skillPack: 'factory-skills-v4', modelBudget: 'builder-v1', copyOutput: true });
  assert.equal(plan.scopeUpdate.request_id, 'q11-scope-1');
  assert.match(plan.scopeUpdate.reason, /ONLY requirement B1[\s\S]*Do NOT adopt requirement B2/);
  assert.match(plan.ticketSetup.afterAsk, /controller STOPPED/);
  for (const text of ['SESSION_COMPATIBLE', 'SESSION_INCOMPATIBLE', 'SCOPE_UPDATED', 'complete:false', 'delivery vs consumption']) assert.ok(JSON.stringify(plan.expected).includes(text), text);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['ask', 'again']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
