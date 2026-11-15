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
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q26-recovery-v2', 'v1 was consumed by a real run');
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
  // The tool-cut proof is guest-side and durable: a marker file in /workspace BEFORE the long command, another only after it.
  assert.match(provider.schedules[0]![1]!.command, /^printf 'started\\n' > \/workspace\/\.q26-a1-c1-started; .*sleep 600; printf 'ended\\n' > \/workspace\/\.q26-a1-c1-ended/);
  for (const call of provider.schedules.flat()) assert.doesNotMatch(call.command, /GH_TOKEN|printenv|\benv\b|git /);
});

test('ticket 26 recipe: inventory excludes only the recorded pre-existing environments and other repositories\' caches; the verdict needs every cut', () => {
  const listed = { environments: [{ environment: 'env-a', workId: 'old' }, { environment: 'env-b', workId: 'new' }], cache: [{ repositoryId: 1256893534, state: 'idle' as const },
    { repositoryId: 7, state: 'preparing' as const }], unknown: ['run/x'] };
  assert.deepEqual(recipe.ownInventory(listed, ['env-a'], 't'), { kind: 'listed', observedAt: 't', environments: [{ environment: 'env-b', workId: 'new' }],
    cache: [{ repositoryId: 1256893534, state: 'idle' }], unknown: ['run/x'] });
  const verdict = recipe.assess({ work: undefined, events: [], exits: {}, provider: { activations: 0, results: [], emitted: [], prompts: [], held: false } });
  assert.equal(verdict.passed, false);
});

test('ticket 26 recipe v2: the tool cut is proven by guest markers read on the host, and the provider oracle never needs output it cannot see', () => {
  assert.deepEqual(recipe.toolCutProof({ started: Buffer.from('started\n'), ended: null }), { started: true, ended: false, proven: true });
  assert.deepEqual(recipe.toolCutProof({ started: null, ended: null }), { started: false, ended: false, proven: false }, 'no marker: the cut is not proven');
  assert.deepEqual(recipe.toolCutProof({ started: Buffer.from('started\n'), ended: Buffer.from('ended\n') }), { started: true, ended: true, proven: false });
  const prompts = [{ activation: 1, kind: 'implement' }, { activation: 2, kind: 'recovery' }];
  const provider = (results: { markers: string[] }[], emitted: { activation: number; call: number }[]) => ({ activations: 2, held: false, prompts, results, emitted });
  // c1 was handed to the worker (emitted) and its result never came back: the controller died during it.
  assert.equal(recipe.providerScheduleCheck(provider([{ markers: ['a1-c0:pom.xml,'] }], [{ activation: 1, call: 0 }, { activation: 1, call: 1 }])), true);
  assert.equal(recipe.providerScheduleCheck(provider([{ markers: ['a1-c0:pom.xml,'] }], [{ activation: 1, call: 0 }])), false, 'c1 never emitted');
  assert.equal(recipe.providerScheduleCheck(provider([{ markers: ['a1-c1-end'] }], [{ activation: 1, call: 0 }, { activation: 1, call: 1 }])), false, 'c1 completed: no cut');
});
