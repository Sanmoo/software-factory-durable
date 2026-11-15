import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { WorkerCompletion } from '../../src/workers/index.js';

// Import and --plan of the ticket 28 real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny, readdir: deny }, defaultExport: deny });
}
const recipe = await import('./review28-qualification.js');

test('AC7 recipe: import and --plan are inert and declare the fixed bounds and the two provocations of the one-shot real run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q28-partial-v1');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.deepEqual([plan.model.builder.maxRequests, plan.model.reviewers.maxRequestsEach, plan.model.reviewers.maxActivations, plan.model.reviewers.retries,
    plan.model.maxRequestsTotal, plan.model.providerRetries, plan.model.sdkRetries], [60, 24, { standards: 4, spec: 5 }, { standards: 0, spec: 1 }, 276, 0, 0]);
  assert.equal(plan.provocations.length, 2);
  assert.match(plan.provocations[0], /^spec r1a1: Host deadlineMs 20000/);
  assert.match(plan.provocations[1], /^standards r1a1: its completion reaches Control without the opinion/);
  assert.equal(plan.github.reviewerCredentials, 'none');
  assert.match(plan.guards[0], /WORKER_LAUNCH_INVALID: never-started, reservation released, not retried\); more than 2 stop the run/, 'a guard refusal never cascades into free retries');
  assert.match(plan.effects.find((item: string) => item.startsWith('inspect:')), /private copy of the Work's Records/, 'inspect never opens the live Records');
  assert.match(plan.github.writes, /^none/);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('AC7 recipe guard: one Builder; Standards never retried; Spec retried at most once and only in round 1', () => {
  const guard = recipe.activationGuard();
  const context = (role: string, executionId = 'e1') => ({ role, executionId });
  assert.equal(guard(context('spec'), { round: 1, attempt: 1 }), false, 'no reviewer before the Builder');
  assert.equal(guard(context('builder')), true);
  assert.equal(guard(context('builder')), false, 'never a second Builder');
  assert.equal(guard(context('spec', 'e2'), { round: 1, attempt: 1 }), false, 'never another Execution');
  assert.equal(guard(context('standards'), { round: 1, attempt: 1 }), true);
  assert.equal(guard(context('standards'), { round: 1, attempt: 2 }), false, 'a lost notification is never rerun');
  assert.equal(guard(context('spec'), { round: 1, attempt: 1 }), true);
  assert.equal(guard(context('spec'), { round: 1, attempt: 1 }), false, 'distinct (round, attempt)');
  assert.equal(guard(context('spec'), { round: 1, attempt: 2 }), true, 'the one provoked retry');
  assert.equal(guard(context('spec'), { round: 1, attempt: 3 }), false);
  assert.equal(guard(context('spec'), { round: 2, attempt: 2 }), false);
  for (const round of [2, 3, 4]) assert.equal(guard(context('spec'), { round, attempt: 1 }), true);
  assert.equal(guard(context('spec'), { round: 5, attempt: 1 }), false, 'bounded');
});

test('AC7 recipe provocations: exactly one invocation each, on round 1 attempt 1', () => {
  const provoke = recipe.provocation(1);
  assert.equal(provoke.deadline({ role: 'spec' }, { round: 1, attempt: 1 }), 20000);
  assert.equal(provoke.deadline({ role: 'spec' }, { round: 1, attempt: 2 }), undefined, 'the retry runs without the provoked deadline');
  assert.equal(provoke.deadline({ role: 'standards' }, { round: 1, attempt: 1 }), undefined);
  assert.equal(provoke.deadline({ role: 'builder' }), undefined);
  const success = { status: 'success', receipt: { workId: 'w', id: 'r' }, opinion: { conclusion: 'clean' } } as unknown as WorkerCompletion;
  assert.deepEqual(provoke.dropOpinion({ role: 'standards' }, { round: 1, attempt: 1 }, success), { status: 'success', receipt: { workId: 'w', id: 'r' } });
  assert.equal(provoke.dropOpinion({ role: 'standards' }, { round: 2, attempt: 1 }, success), success);
  assert.equal(provoke.dropOpinion({ role: 'spec' }, { round: 1, attempt: 1 }, success), success);
});
