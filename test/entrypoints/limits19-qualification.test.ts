import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 19 real-run recipe must be inert: no process, socket, filesystem, HTTP server or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', 'node:http', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, readdir: deny, access: deny },
    defaultExport: deny });
}
const recipe = await import('./limits19-qualification.js');
const provider = await import('./limits19-provider.js');

test('ticket 19 recipe: import and --plan are inert and declare the fixed bounds of the one-shot real timeout run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q19-limits-v2', 'own namespace, never an earlier qualification (v1 was consumed by a real preflight)');
  assert.deepEqual([plan.repository.timeoutSeconds, plan.repository.correctionLimit, plan.repository.recoveryLimit], [90, 1, 0]);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.match(plan.github.builderPurpose, /builder-start \{metadata:read, contents:read, issues:read\}/);
  assert.match(plan.model, /no OAuth\/model request/);
  assert.match(plan.effects[2], /exclusive private COPY/);
  assert.match(plan.effects[2], /no host git/);
  assert.deepEqual([plan.configuration.memoryMiB, plan.configuration.vcpus, plan.configuration.diskGiB], [4096, 2, 40]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main([]), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('ticket 19 recipe: the scripted schedule has one short and one long command whose end marker cannot appear before the Factory timeout', () => {
  const [first, long] = provider.schedules[0]!;
  assert.ok(first!.timeout <= 60);
  assert.match(long!.command, /q19-a1-c1-start.*sleep 600.*q19-a1-c1-end/);
  assert.ok(long!.timeout > 600, 'the tool timeout never ends the command before the Factory timeout');
  for (const call of provider.schedules.flat()) assert.doesNotMatch(call.command, /GH_TOKEN|printenv|\benv\b|git /, 'never prints secrets/environment; no git');
  assert.deepEqual(provider.extract('q19-a1-c0:pom.xml,src,\nq19-a1-c1-start\n').markers, ['a1-c0:pom.xml,src,', 'a1-c1-start']);
});

test('ticket 19 recipe: the scripted provider walks one activation and holds on any further or deviating request', async () => {
  const fixture = provider.createFixture();
  const request = (messages: unknown[], overrides: Record<string, unknown> = {}) => {
    const body = Buffer.from(JSON.stringify({ model: 'q19-model', stream: true, messages }));
    return Object.assign((async function* () { yield body; })(), { method: 'POST', url: provider.path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: `127.0.0.1:${provider.port}`, authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' }, ...overrides });
  };
  const send = async (req: unknown) => {
    let status = 0, text = '';
    await fixture.handle(req as never, { writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as never);
    return { status, text };
  };
  const user = { role: 'user', content: '/implement https://github.com/Sanmoo/java-springboot-event-sourcing/issues/3 repository=x' };
  let reply = await send(request([user]));
  assert.equal(reply.status, 200);
  assert.ok(reply.text.includes(JSON.stringify(JSON.stringify(provider.schedules[0]![0]))));
  reply = await send(request([user, { role: 'assistant', content: null }, { role: 'tool', tool_call_id: 'q19-a1-0', content: 'q19-a1-c0:pom.xml,' }]));
  assert.ok(reply.text.includes('sleep 600'));
  assert.deepEqual(fixture.observation().results.map(result => result.markers), [['a1-c0:pom.xml,']]);
  // A result for c1 (the interrupted command) would be a deviation: one spare request, then held.
  reply = await send(request([user, { role: 'assistant', content: null }, { role: 'tool', tool_call_id: 'q19-a1-0', content: 'x' }, { role: 'assistant', content: null },
    { role: 'tool', tool_call_id: 'q19-a1-1', content: 'q19-a1-c1-end' }]));
  assert.match(reply.text, /"content":"Complete\."/);
  assert.equal((await send(request([user]))).status, 400, 'no further activation');
  assert.equal(fixture.observation().held, true);
  const other = provider.createFixture();
  await other.handle(request([user], { headers: { host: `127.0.0.1:${provider.port}`, authorization: 'Bearer other', 'content-type': 'application/json' } }) as never, { writeHead() {}, end() {} } as never);
  assert.equal(other.observation().held, true, 'wrong credential holds the provider');
});

test('ticket 19 recipe: the verdict passes only for a measured monotonic timeout that ceased, withdrew credentials and blocked without loop or bypass', () => {
  const work = {
    budget: { corrections: { limit: 1, granted: 1, consumed: 0, reserved: null }, recoveries: { limit: 0, granted: 0, consumed: 0, reserved: null }, grants: [{}] },
    impediments: [{ code: 'EXECUTION_TIMEOUT' }], history: [{ event: 'timeout-reached' }],
    execution: { end: { outcome: 'timeout', code: 'EXECUTION_TIMEOUT', cessation: 'confirmed' }, slot: { held: false }, charge: { kind: 'none' },
      credentialLifecycle: { state: 'withdrawn', reason: 'timeout' }, credentialIssuance: { revocation: 'revoked' },
      timing: { origin: 'run-1', timeout: { evidence: 'measured', elapsedMs: 90012 }, duration: { kind: 'measured', elapsedMs: 90400 } } },
  } as never;
  const good = { work, runId: 'run-1', grant: { outcome: 'accepted' }, markers: ['a1-c0:pom.xml,', 'a1-c1-start'], providerAttempts: 2,
    samples: [{ at: 'a', state: 'not-started', elapsedMs: null, clock: 'controller-monotonic' }, { at: 'b', state: 'running', elapsedMs: 20000, clock: 'controller-monotonic' },
      { at: 'c', state: 'running', elapsedMs: 30000, clock: 'controller-monotonic' }],
    activationsAfter: Array(9).fill(1), impedimentsAfter: Array(9).fill(['EXECUTION_TIMEOUT']) };
  assert.deepEqual(recipe.assess(good), { passed: true, checks: Object.fromEntries(Object.keys(recipe.assess(good).checks).map(key => [key, true])) });
  assert.equal(recipe.assess({ ...good, activationsAfter: [...Array(8).fill(1), 2] }).checks.blockedWithoutLoop, false);
  assert.equal(recipe.assess({ ...good, impedimentsAfter: [...Array(8).fill(['EXECUTION_TIMEOUT']), []] }).checks.blockedWithoutLoop, false);
  assert.equal(recipe.assess({ ...good, runId: 'run-2' }).checks.measuredOnLocalMonotonic, false, 'measured by the run process origin only');
  assert.equal(recipe.assess({ ...good, markers: [...good.markers, 'a1-c1-end'] }).checks.runningCommandInterrupted, false);
  assert.equal(recipe.assess({ ...good, samples: [good.samples[2]!, good.samples[1]!] }).checks.liveDurationObserved, false, 'monotonic samples never decrease');
  assert.equal(recipe.assess({ ...good, grant: { outcome: 'not-applied' } }).checks.grantAcceptedWithoutBypass, false);
});
