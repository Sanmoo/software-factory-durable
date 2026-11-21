import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 10 real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => {
  forbidden++;
  throw new Error('FORBIDDEN_EFFECT');
};
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, {
    namedExports: {
      connect: deny,
      createServer: deny,
      execFile: deny,
      execFileSync: deny,
      request: deny,
      open: deny,
      mkdir: deny,
      readFile: deny,
      access: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./question10-qualification.js');
const ticket = {
  tracker: 'github' as const,
  repository: 'Sanmoo/java-springboot-event-sourcing',
  repositoryId: 1256893534,
  issueId: 1,
  nodeId: 'I',
  number: 3,
  url: 'https://github.com/x/y/issues/3',
};

test('recipe: import and --plan are inert and declare the fixed bounds (2 activations, <= 1 Question comment per phase on #3)', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'ask', 'resume', 'inspect', 'stop-environment']);
  assert.deepEqual([plan.model.maxActivations, plan.model.perActivation.maxRequests, plan.model.providerRetries, plan.model.sdkRetries], [2, 60, 0, 0]);
  assert.match(plan.github.writes, /at most ONE POST \/repos\/Sanmoo\/java-springboot-event-sourcing\/issues\/3\/comments per phase/);
  assert.deepEqual(plan.operators, ['Sanmoo']);
  assert.equal(plan.skillPack, 'factory-skills-v2');
  assert.equal(plan.revision, 'q10-question-v2', 'v1 namespace was consumed by the first real ask run');
  assert.match(plan.operatorStep, /controller STOPPED/);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('recipe guard: one Question comment per phase and only on Ticket #3; reads pass through', async () => {
  const posts: number[] = [];
  const base = {
    async postComment(t: { number: number }) {
      posts.push(t.number);
      return { kind: 'published' as const, observedAt: 'x', commentId: 1, url: 'u', createdAt: 'x' };
    },
    async readInputs() {
      return 'read' as never;
    },
  } as never;
  const events: unknown[] = [];
  const guarded = recipe.guardTracker(base, events);
  const comment = { kind: 'question' as const, questionId: 'q', body: 'b' },
    effect = { effectId: 'e', questionId: 'q' };
  assert.equal((await guarded.postComment({ ...ticket, number: 4 }, comment, effect)).kind, 'failed', 'another Ticket is refused');
  const fresh = recipe.guardTracker(base, events);
  assert.equal((await fresh.postComment(ticket, comment, effect)).kind, 'published');
  assert.equal((await fresh.postComment(ticket, comment, effect)).kind, 'failed', 'a second comment in the same phase is refused');
  assert.deepEqual(posts, [3]);
  assert.equal(await fresh.readInputs(ticket, null), 'read');
});
