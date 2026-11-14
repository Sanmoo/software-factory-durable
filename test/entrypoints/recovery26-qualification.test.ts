import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 26 real-run recipe must be inert: no process, socket, filesystem, HTTP server or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:fs', 'node:https', 'node:http', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    readdir: deny, access: deny, appendFileSync: deny }, defaultExport: deny });
}
const recipe = await import('./recovery26-qualification.js');
const provider = await import('./recovery26-provider.js');

test('ticket 26 recipe: import and --plan are inert and declare the fixed cuts and bounds of the one-shot real recovery run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.deepEqual(plan.steps, ['a-tool', 'b-reservation', 'c-spawn', 'd-final']);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q26-recovery-v1');
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.match(plan.model, /no OAuth\/model request/);
  assert.match(plan.effects[1], /flock --exclusive --nonblock --no-fork/);
  assert.match(plan.effects[2], /exclusive private COPY/);
  assert.match(plan.effects[2], /no host git/);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['child', 'z-other']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main([]), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('ticket 26 recipe: the provider admits /implement only first and afterwards only the explicit recovery instruction; schedules never print secrets or run git', () => {
  const ticket = 'https://github.com/Sanmoo/java-springboot-event-sourcing/issues/3';
  assert.equal(provider.promptAllowed(1, `/implement ${ticket} repository=x`), true);
  assert.equal(provider.promptAllowed(2, `/implement ${ticket} repository=x`), false, 'never a fresh /implement after an interruption');
  const recovery = `Factory recovery instruction for Ticket ${ticket}.\nprevious-execution=0b9c6a52-3d3e-4c8f-9a51-000000000001 ... never repeat a tool call blindly.`;
  assert.equal(provider.promptAllowed(2, recovery), true);
  assert.equal(provider.promptAllowed(1, recovery), false);
  assert.match(provider.schedules[0]![1]!.command, /q26-a1-c1-start.*sleep 600.*q26-a1-c1-end/);
  for (const call of provider.schedules.flat()) assert.doesNotMatch(call.command, /GH_TOKEN|printenv|\benv\b|git /);
});

test('ticket 26 recipe: inventory excludes only the recorded pre-existing environments and other repositories\' caches; the verdict needs every cut', () => {
  const listed = { environments: [{ environment: 'env-a', workId: 'old' }, { environment: 'env-b', workId: 'new' }], cache: [{ repositoryId: 1256893534, state: 'idle' as const },
    { repositoryId: 7, state: 'preparing' as const }], unknown: ['run/x'] };
  assert.deepEqual(recipe.ownInventory(listed, ['env-a'], 't'), { kind: 'listed', observedAt: 't', environments: [{ environment: 'env-b', workId: 'new' }],
    cache: [{ repositoryId: 1256893534, state: 'idle' }], unknown: ['run/x'] });
  const verdict = recipe.assess({ work: undefined, events: [], exits: {}, provider: { activations: 0, results: [], prompts: [], held: false } });
  assert.equal(verdict.passed, false);
});
