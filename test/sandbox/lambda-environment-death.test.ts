import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { createSandbox, type BootRef, type EnvironmentRef, type ReadResult, type ToolCall, type ToolContext } from '../../src/sandbox/index.js';
import { lambdaAccountFake } from './lambda-service-fake.js';
import { lambdaGuestFake } from './lambda-guest-fake.js';
import { manualObservationTimer } from './lambda-observation-timer.js';

// v2 ticket 10 (V2-15, mandatory gate; the continuity proof failed its absence: I2): the adapter watches the ENVIRONMENT through the
// service at the profile's interval and, on confirmed cessation, cancels the call in flight and denies every later one. Sandbox level:
// the real tool owner of a Lambda boot over the in-memory account and the in-process guest. No AWS call, no ssh, no VM. What it does NOT
// cover: worker processes and Control (see `test/entrypoints/lambda-environment-death-composed.test.ts`).
const interval = 45;
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme', observationIntervalSeconds: interval };
const pinned = { path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: 'd'.repeat(64), repository: 'acme/shop', repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [], images: [] } };
const workId = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a10';
const remote = 'https://github.com/acme/shop.git';
const startingCommit = '1'.repeat(40);
const ended = { status: 'failure', code: 'SANDBOX_ENVIRONMENT_ENDED' };

async function watchedBoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-death-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  const guests = lambdaGuestFake(fake);
  guests.world.origins[remote] = { commits: [startingCommit], token: 'ghs_token' };
  const clock = { now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } };
  const watch = manualObservationTimer(milliseconds => { fake.account.clock.now += milliseconds; });
  const sandbox = createSandbox({ root, lambdaService: fake.service, lambdaTransport: guests.transport, lambdaBootClock: clock, lambdaObservationTimer: watch.timer,
    lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep } });
  const prepared = await sandbox.prepare({ workId, configuration, environment: pinned });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared));
  const environment = (prepared as { environment: EnvironmentRef }).environment;
  const started = await sandbox.start({ environment, configuration, checkout: { repository: 'acme/shop', commit: startingCommit, branch: 'factory/work-1', credential: { token: 'ghs_token' } } });
  assert.equal(started.status, 'success', JSON.stringify(started));
  const boot = (started as { boot: BootRef }).boot;
  const guest = guests.guestOf(fake.account.microvms.at(-1)!.microvmId)!;
  await mkdir(join(root, 'records'), { mode: 0o700 });
  const records = await createRecords({ root: join(root, 'records') });
  const endings: unknown[] = [];
  const served = await sandbox.serveTools({ environment, boot, environmentEnded: observed => { endings.push(observed); watch.settled(); } });
  assert.equal(served.status, 'serving', JSON.stringify(served));
  const tools = (served as Extract<typeof served, { status: 'serving' }>).tools;
  t.after(() => tools.close());
  let sockets = 0;
  const bind = (role: ToolContext['role'], invocationId: string) => {
    const context: ToolContext = { workId, executionId: 'execution-1', invocationId, role, environmentRef: environment, bootRef: boot, phaseId: 'phase-1' };
    return { context, bound: tools.bind({ endpoint: join(root, `t${sockets += 1}`), context, signal: new AbortController().signal, records }) };
  };
  const invocation = async (role: ToolContext['role'] = 'builder', invocationId = `invocation-${sockets}`) => {
    const { context, bound } = bind(role, invocationId);
    const result = await bound;
    assert.equal(result.status, 'bound', JSON.stringify(result));
    const client = createSandbox({ root, toolEndpoint: (result as { endpoint: string }).endpoint });
    let calls = 0;
    return { call: (input: Record<string, unknown>): Promise<ReadResult> => client.executeTool(context, { callId: `call-${calls += 1}`, ...input } as ToolCall, () => {}) };
  };
  /** A Builder command that runs until the test lets it end: a long command of a living environment. */
  const longCommand = (command: string) => {
    let finish!: () => void, began!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const running = new Promise<void>(resolve => { began = resolve; });
    guests.world.commands[command] = async () => { began(); await done; return 0; };
    return { running, finish };
  };
  const queries = () => fake.calls.filter(call => call.operation === 'microvm').length;
  return { fake, guests, guest, sandbox, environment, boot, watch, endings, tools, bind, invocation, longCommand, queries };
}

test('V2-15: the adapter asks the service for the environment at the interval of the profile, with or without a call in flight; a long command and a silent agent end nothing', async t => {
  const h = await watchedBoot(t);
  const builder = await h.invocation();
  // A silent agent: no tool call at all, the environment alive.
  let before = h.queries();
  for (let round = 0; round < 3; round += 1) await h.watch.tick();
  assert.equal(h.queries() - before, 3, 'one service read per interval with no call in flight');
  // A long command: the watch goes on under it and never ends it.
  const long = h.longCommand('mvn verify');
  const call = builder.call({ name: 'bash', command: 'mvn verify' });
  await long.running;
  before = h.queries();
  for (let round = 0; round < 4; round += 1) await h.watch.tick();
  assert.equal(h.queries() - before, 4, 'one service read per interval under a call in flight');
  assert.deepEqual(h.watch.intervals(), Array.from({ length: 8 }, () => interval * 1000), 'the interval is the one the profile declares');
  long.finish();
  const result = await call;
  assert.deepEqual([result.status, (result as { exitCode?: number }).exitCode], ['success', 0]);
  assert.deepEqual(h.endings, []);
  assert.equal((await builder.call({ name: 'bash', command: 'docker ps' })).status, 'success', 'the binding is still served');
  assert.equal((await h.sandbox.bootRecord({ environment: h.environment, boot: h.boot }))?.phase, 'active');
});

test('V2-15: confirmed cessation cancels the call in flight as "environment ended", denies every new call and binding, and records the boot end with the observed reason', async t => {
  const h = await watchedBoot(t);
  const builder = await h.invocation('builder', 'builder-1');
  const reviewer = await h.invocation('standards', 'reviewer-1');
  const long = h.longCommand('mvn deploy');
  const call = builder.call({ name: 'bash', command: 'mvn deploy' });
  await long.running;
  // The MicroVM dies and the open connection just hangs (what the continuity proof observed: nothing told the host).
  h.fake.kill(h.guest.microvmId, 'MicroVM exceeded maximum lifetime.');
  await h.watch.tick();
  assert.deepEqual(await call, ended, 'the call in flight is cancelled and answered as environment ended');
  assert.deepEqual(h.endings, [{ reason: 'MicroVM exceeded maximum lifetime.', terminatedAt: new Date(h.fake.account.microvms[0]!.terminatedAt!).toISOString() }]);
  const programs = h.guest.executions.length;
  // Every new call is denied, on the binding that had the call and on one that had none; nothing reaches the channel.
  assert.deepEqual(await builder.call({ name: 'bash', command: 'docker ps' }), ended);
  assert.deepEqual(await builder.call({ name: 'write', operation: 'create', path: '/workspace/checkout/late.txt', content: 'x' }), ended);
  assert.deepEqual(await reviewer.call({ name: 'read', operation: 'capture', path: '/workspace/checkout/README.md' }), ended);
  assert.deepEqual(await h.bind('builder', 'builder-2').bound, { status: 'refused', code: 'ENVIRONMENT_ENDED' });
  assert.equal(h.guest.executions.length, programs, 'no program was sent to the guest after the confirmed cessation');
  // The boot's end, with the reason the service gave (tickets 12 and 14 read it).
  const record = await h.sandbox.bootRecord({ environment: h.environment, boot: h.boot });
  assert.deepEqual([record?.phase, record?.end?.reason, record?.end?.stateReason, record?.end?.terminatedAt],
    ['ended', 'loss', 'MicroVM exceeded maximum lifetime.', new Date(h.fake.account.microvms[0]!.terminatedAt!).toISOString()]);
  // The cancelled call had started: its effect is recorded as uncertain (ticket 13 gives it to the substitute session).
  const report = await h.sandbox.channelReport({ environment: h.environment, boot: h.boot });
  assert.deepEqual(report.indeterminateEffects.map(effect => [effect.tool, effect.description, effect.outcome]), [['bash', 'mvn deploy', 'environment-ended']]);
  // The watch is over: nothing is asked of the service again and nothing is ever reconnected.
  assert.equal(h.watch.pending(), 0);
  assert.deepEqual(h.guest.executions.filter(execution => execution.program === 'end-call'), []);
  long.finish();
});

test('V2-15: a service query that fails, or an in-between state, is "unknown" and never cessation: the watch goes on and the tools stay served', async t => {
  const h = await watchedBoot(t);
  const builder = await h.invocation();
  h.fake.account.denied.push('lambda:GetMicrovm');
  for (let round = 0; round < 3; round += 1) await h.watch.tick();
  assert.deepEqual(h.endings, []);
  assert.equal((await builder.call({ name: 'bash', command: 'docker ps' })).status, 'success');
  h.fake.account.denied.length = 0;
  await h.watch.tick();
  assert.deepEqual(h.endings, []);
  assert.equal((await h.sandbox.bootRecord({ environment: h.environment, boot: h.boot }))?.phase, 'active');
  // The same watch still confirms a real end afterwards.
  h.fake.kill(h.guest.microvmId, 'Host failure.');
  await h.watch.tick();
  assert.deepEqual(h.endings.map(item => (item as { reason: string }).reason), ['Host failure.']);
  assert.deepEqual(await builder.call({ name: 'bash', command: 'docker ps' }), ended);
});

// v2 ticket 09 (V2-13), same harness: with half the rotation margin of the boot left, the adapter interrupts the call of ONE invocation
// that has not returned. The environment is alive: nothing ends but that call.
test('V2-13: the adapter interrupts the call in flight of one invocation: its connection is closed, its process group ended, it answers "indeterminate" and the invocation goes on', async t => {
  const h = await watchedBoot(t);
  const builder = await h.invocation('builder', 'builder-1');
  const other = await h.invocation('builder', 'builder-2');
  const after: string[] = [];
  let began!: () => void;
  const running = new Promise<void>(resolve => { began = resolve; });
  h.guests.world.commands['mvn verify'] = async (_guest, run) => { began(); await run.killed; after.push('killed'); return 0; };
  const untouched = h.longCommand('sleep 600');
  const call = builder.call({ name: 'bash', command: 'mvn verify' });
  const bystander = other.call({ name: 'bash', command: 'sleep 600' });
  await Promise.all([running, untouched.running]);
  // An invocation with nothing in flight, or one the boot never bound, interrupts nothing.
  assert.equal(h.tools.interruptCalls('builder-9'), 0);
  assert.equal(h.tools.interruptCalls('builder-1'), 1);
  // Never "not executed", never a result: the effect may have happened.
  assert.deepEqual(await call, { status: 'failure', code: 'BASH_RESULT_INDETERMINATE' });
  assert.deepEqual(after, ['killed'], 'closing the connection does not end the program: its process group was ended over a new connection');
  assert.deepEqual(h.guest.executions.filter(execution => execution.program === 'end-call').length, 1);
  const report = await h.sandbox.channelReport({ environment: h.environment, boot: h.boot });
  assert.deepEqual(report.indeterminateEffects.map(effect => [effect.tool, effect.description, effect.outcome]), [['bash', 'mvn verify', 'orphan-ended']]);
  // The boot, the watch and the other invocation are untouched; the interrupted invocation runs its next command.
  assert.deepEqual(h.endings, []);
  assert.equal((await h.sandbox.observe({ environment: h.environment, boot: h.boot })).condition, 'active');
  h.guests.world.commands['git status'] = async () => 0;
  const next = await builder.call({ name: 'bash', command: 'git status' });
  assert.equal(next.status === 'success' && 'exitCode' in next && next.exitCode, 0, JSON.stringify(next));
  untouched.finish();
  const done = await bystander;
  assert.equal(done.status === 'success' && 'exitCode' in done && done.exitCode, 0, JSON.stringify(done));
  assert.equal(h.tools.interruptCalls('builder-1'), 0);
});
