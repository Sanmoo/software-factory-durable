import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny, readdir: deny }, defaultExport: deny });
}
const recipe = await import('./review12-qualification.js');

test('AC7 recipe: import and --plan are inert and declare the fixed bounds of the one-shot real review run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q12-review-v4', 'v1-v3 were consumed by real runs');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.deepEqual([plan.model.builder.maxRequests, plan.model.reviewers.maxRequestsEach, plan.model.maxRequestsTotal, plan.model.providerRetries, plan.model.sdkRetries],
    [60, 24, 108, 0, 0]);
  assert.deepEqual(plan.model.reviewers.tools, ['read']);
  assert.equal(plan.github.reviewerCredentials, 'none');
  assert.match(plan.github.writes, /^none/);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.deepEqual([plan.configuration.memoryMiB, plan.configuration.vcpus, plan.configuration.diskGiB], [4096, 2, 40]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('AC7 recipe guard: one Builder, then at most one Standards and one Spec of that same Execution', () => {
  const guard = recipe.activationGuard();
  const context = (role: string, executionId = 'e1') => ({ role, executionId, invocationId: `${role}-x` });
  assert.equal(guard(context('spec')), false, 'no reviewer before the Builder of the Execution');
  assert.equal(guard(context('builder')), true);
  assert.equal(guard(context('builder')), false);
  assert.equal(guard(context('standards', 'e2')), false, 'never a reviewer of another Execution');
  assert.equal(guard(context('standards')), true);
  assert.equal(guard(context('spec')), true);
  assert.equal(guard(context('spec')), false, 'no reviewer retry');
});

test('AC7 recipe inspect: session tool calls are read from the native JSONL format', () => {
  const jsonl = [JSON.stringify({ type: 'session', id: 's' }), 'not json',
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'toolCall', id: '1', name: 'read', arguments: { path: '/artifacts/review/r1/index.json' } }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [] } })].join('\n');
  assert.deepEqual(recipe.sessionToolCalls(jsonl), [{ name: 'read', path: '/artifacts/review/r1/index.json' }]);
});
