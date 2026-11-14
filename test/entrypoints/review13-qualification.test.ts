import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 13 real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny, readdir: deny }, defaultExport: deny });
}
const recipe = await import('./review13-qualification.js');

test('AC7 recipe: import and --plan are inert and declare the fixed bounds of the one-shot real rounds run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q13-rounds-v1');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.equal(plan.model.builder.skillPack, 'factory-skills-v4');
  assert.deepEqual([plan.model.builder.maxRequests, plan.model.builder.captures, plan.model.reviewers.maxRequestsEach, plan.model.reviewers.maxRounds,
    plan.model.reviewers.maxActivations, plan.model.maxRequestsTotal, plan.model.providerRetries, plan.model.sdkRetries], [60, 4, 24, 4, 8, 252, 0, 0]);
  assert.deepEqual(plan.model.reviewers.tools, ['read']);
  assert.equal(plan.github.reviewerCredentials, 'none');
  assert.match(plan.github.writes, /^none/);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.match(plan.ticket.body, /`docs\/FACTORY_SMOKE\.md`/);
  assert.match(plan.ticket.body, /grep -q '\^## Rollback' docs\/FACTORY_SMOKE\.md/, 'the documented gate is in the Ticket itself');
  assert.match(plan.ticket.provocation, /omits ## Rollback/, 'the provocation is declared, not hidden');
  assert.deepEqual([plan.configuration.memoryMiB, plan.configuration.vcpus, plan.configuration.diskGiB], [4096, 2, 40]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('AC7 recipe guard: one Builder, then per reviewer role at most four activations of DISTINCT rounds of that same Execution', () => {
  const guard = recipe.activationGuard();
  const context = (role: string, executionId = 'e1') => ({ role, executionId, invocationId: `${role}-x` });
  assert.equal(guard(context('spec'), { round: 1 }), false, 'no reviewer before the Builder of the Execution');
  assert.equal(guard(context('builder')), true);
  assert.equal(guard(context('builder')), false, 'never a second Builder (no recovery in this recipe)');
  assert.equal(guard(context('standards', 'e2'), { round: 1 }), false, 'never a reviewer of another Execution');
  assert.equal(guard(context('standards')), false, 'a reviewer without a round input is refused');
  for (const round of [1, 2, 3, 4]) assert.equal(guard(context('standards'), { round }), true);
  assert.equal(guard(context('standards'), { round: 5 }), false, 'bounded');
  assert.equal(guard(context('spec'), { round: 1 }), true);
  assert.equal(guard(context('spec'), { round: 1 }), false, 'no reviewer retry of the same round');
});
