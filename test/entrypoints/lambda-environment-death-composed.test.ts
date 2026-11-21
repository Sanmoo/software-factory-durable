import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from '../runner/budget.js';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { openControl, type ExecutionPorts, type ListView, type WorkView } from '../../src/control/index.js';
import { composeProductionAccess, composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import { productionProfile } from '../../src/entrypoints/release.js';
import { createSandbox, type LambdaServiceFactory, type LambdaWorkerLauncher, type ReadResult, type ToolCall } from '../../src/sandbox/index.js';
import { manualClock } from '../control/doubles.js';
import { lambdaAccountFake } from '../sandbox/lambda-service-fake.js';
import { lambdaGuestFake } from '../sandbox/lambda-guest-fake.js';
import { manualObservationTimer } from '../sandbox/lambda-observation-timer.js';
import { githubWorld, issue, worldScope } from './github-world-fixture.js';

// v2 ticket 10 (V2-15, MANDATORY gate of the spec; the continuity proof failed its absence: I2), composed level: ONE owner run of the
// PRODUCTION composition with the Lambda adapter, over the in-memory AWS account, the in-process guest and the gh world fixture.
// Real: Control, Pi Durable, SQLite, the Lambda adapter (boot, channel, boot owner, role-bound tools, the WATCH of the environment),
// the Workers facade and the Builder credentials. Substituted: the AWS account, the guest and the WORKER PROCESS, which is a scripted
// agent loop here: each turn is one "model request" followed by one tool call through the endpoint the owner bound for it.
//
// What the explicit assertion covers: after the service confirmed the cessation, (1) the owner aborts the lifetime signal of the worker
// before the worker's loop can take another turn, so the loop makes no further model request and no further tool call, even though this
// scripted loop IGNORES failed tool calls; (2) a call the worker still attempts is denied without reaching the guest; (3) Control ends
// the Execution and launches nothing more on that boot. What it does NOT cover: a real worker process (agent SDK + model). There, the
// same lifetime signal makes the supervisor send the worker its abort directive and the failed tool call aborts the session
// (`test/workers/environment-ended.test.ts`), but no real model request was ever counted. Dublê não comprova fronteira substituída.
const tip = 'b'.repeat(40);
const remoteUrl = 'https://github.com/acme/project.git';
const pullRequestRule = { type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' };
const model = { provider: productionProfile.model.providerId, model: productionProfile.model.modelId };
const repository = { ...worldScope, correctionLimit: 3, recoveryLimit: 3 };
const interval = 20;
const effective = { models: { builder: model, standards: model, spec: model }, repositories: [repository], dependencyRepositories: [], operators: ['operator-one'],
  concurrency: 1, sandbox: { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme', observationIntervalSeconds: interval } };

test('V2-15: the environment dies under a running Builder: no model request and no tool call happens after the confirmed cessation, and Control ends the activation', async t => {
  const world = await githubWorld(t, { issues: [issue(3, { title: 'Factory smoke', body: 'Add docs/FACTORY_SMOKE.md.' })], pulls: [], refs: {},
    rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, comments: [], checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      rules: { main: [pullRequestRule] }, checkRuns: {}, statuses: {}, compare: {} } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const fake = lambdaAccountFake();
  const guests = lambdaGuestFake(fake);
  // v2 ticket 12: what a push of the loss marker holder does on this remote: the ref appears in the gh world Control reads.
  const pushes: Promise<void>[] = [];
  guests.world.origins[remoteUrl] = { commits: [tip], token: token => token.startsWith('synthetic-installation-secret-'),
    push: (ref, sha) => { pushes.push(world.update(state => { state.factoryRefs = { ...state.factoryRefs, [ref]: sha }; })); } };
  const clock = { now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } };
  const watch = manualObservationTimer(milliseconds => { fake.account.clock.now += milliseconds; });
  // ONE ordered log of everything the assertion is about: model requests, tool calls, and the instant the SERVICE confirms the cessation.
  const log: string[] = [];
  const service: LambdaServiceFactory = profile => {
    const real = fake.service(profile);
    return { ...real, microvm: async id => {
      const read = await real.microvm(id);
      if (read.ok && read.value.state === 'TERMINATED' && !log.includes('cessation-confirmed')) log.push('cessation-confirmed');
      return read;
    } };
  };

  const launched: { role: string; phaseId: string; boot: string }[] = [];
  let aborted = false;
  let longRunning!: () => void;
  const inLongCommand = new Promise<void>(resolve => { longRunning = resolve; });
  let lateCall: (() => Promise<ReadResult>) | undefined;
  guests.world.commands['git status'] = () => 0;
  // A long command of a living environment: it never ends by itself.
  guests.world.commands['mvn deploy'] = async (_guest, run) => { longRunning(); await run.disconnected; return 0; };
  const launcher: LambdaWorkerLauncher = async (request, endpoint, signal) => {
    const context = request.context;
    launched.push({ role: context.role, phaseId: context.phaseId, boot: context.bootRef });
    signal.addEventListener('abort', () => { aborted = true; log.push('worker-aborted'); }, { once: true });
    const tools = createSandbox({ root: world.root, toolEndpoint: endpoint });
    let calls = 0;
    const call = async (command: string) => {
      log.push(`tool-call:${command}`);
      const result = await tools.executeTool(context, { callId: `call-${calls += 1}`, name: 'bash', command } as ToolCall, () => {}, new AbortController().signal);
      log.push(`tool-result:${result.status === 'success' ? 'success' : result.code}`);
      return result;
    };
    lateCall = () => tools.executeTool(context, { callId: `late-${calls += 1}`, name: 'bash', command: 'git status' } as ToolCall, () => {}, new AbortController().signal);
    const receipt = { workId: context.workId, id: randomUUID() };
    const completed = (async () => {
      // The agent loop. It deliberately ignores a failed tool call and goes on: only the end of its lifetime stops it.
      for (const command of ['git status', 'mvn deploy', 'git status', 'git status', 'git status']) {
        if (signal.aborted) break;
        log.push('model-request');
        await call(command);
      }
      return { status: 'failure' as const, code: 'WORKER_INTERRUPTED' };
    })();
    return { started: Promise.resolve({ receipt, invocation: { executionId: context.executionId, invocationId: context.invocationId } }), completed, deliver: async () => false };
  };

  const composed = await composeProductionExecution({ root: world.root, effective, guestAssets: { directory: join(world.root, 'guest'), manifestSha256: 'a'.repeat(64) }, github,
    lambda: { service, transport: guests.transport, clock, imageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep }, workerLauncher: launcher, observationTimer: watch.timer } });
  assert.equal(composed.status, 'composed', JSON.stringify(composed));
  if (composed.status !== 'composed') return;
  const ports: ExecutionPorts = composed.ports;
  // Control learns that the sandbox watches its environment, and nothing of how: no profile, no interval.
  assert.deepEqual([ports.sandbox.capabilities?.environmentWatch, ports.configuration], [true, null]);
  assert.equal(JSON.stringify(ports.sandbox.capabilities).includes(String(interval)), false);
  const dir = await mkdtemp(join(tmpdir(), 'factory-lambda-death-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: ports,
    access: composeProductionAccess({ github, effective }), polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const executionOf = (value: WorkView | undefined, id?: string) => [...(value?.previousExecutions ?? []), ...(value?.execution ? [value.execution] : [])].find(item => id === undefined || item.executionId === id);
  let lastSeen = '';
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => until(() => `${label} ${lastSeen}`, async () => {
    const value = await work();
    if (predicate(value)) return value!;
    lastSeen = JSON.stringify({ state: value?.execution?.state, end: value?.execution?.end, held: value?.execution?.held, phase: value?.execution?.dispatch.phase, impediments: value?.impediments, launched, log });
    if (time.isSleeping()) time.advance();
    return undefined;
  }, 10);

  // The Builder runs and is inside a long command; the environment is alive.
  await settle('started', value => value?.execution?.state === 'started');
  await inLongCommand;
  const started = (await work())!.execution!;
  const environment = started.dispatch.environment!, boot = started.dispatch.boot!;
  const guest = guests.guestOf(fake.account.microvms[0]!.microvmId)!;
  const reads = () => fake.calls.filter(call => call.operation === 'microvm').length;
  const before = reads();
  for (let round = 0; round < 3; round += 1) await watch.tick();
  // The watch asked the service once per interval of the profile, under the call in flight, and a long command ended nothing.
  assert.equal(reads() - before, 3);
  assert.deepEqual([...new Set(watch.intervals())], [interval * 1000]);
  assert.deepEqual([(await work())!.execution!.state, aborted, log.filter(entry => entry === 'model-request').length], ['started', false, 2]);

  // v2 ticket 12 (V2-16, V2-24): the host armed the loss marker holder of this boot when it delivered the Builder's grant: one fixed
  // program as `builder`, the token in its process environment only, the ref named by the Work and the boot.
  const workId = (await work())!.work_id;
  const markerRef = `refs/factory/lost/${workId}/${boot}`;
  const armed = guest.executions.filter(item => item.program === 'loss-marker-arm');
  assert.deepEqual(armed.map(item => [item.user, item.environmentNames]), [['builder', ['FACTORY_GIT_TOKEN', 'GIT_TERMINAL_PROMPT']]]);
  assert.deepEqual([guest.lossMarker?.remote, guest.lossMarker?.ref], [remoteUrl, markerRef]);
  assert.equal(armed[0]!.script.includes(guest.lossMarker!.token), false, 'the token is in no script');
  // The Builder committed work it never pushed; the service ends the MicroVM and calls the terminate hook, which takes no parameter.
  const unpublished = 'd'.repeat(40);
  guest.repository!.commit = unpublished;
  assert.equal(guests.terminateHook(guest.microvmId), true);
  await Promise.all(pushes);
  // The MicroVM dies. Its open connection just hangs: nothing tells the host (what the continuity proof observed).
  fake.kill(guest.microvmId, 'MicroVM exceeded maximum lifetime.');
  assert.equal(log.includes('cessation-confirmed'), false);
  await watch.expire();
  const ended = executionOf(await settle('ended', value => executionOf(value, started.executionId)?.end != null), started.executionId)!;

  // THE GATE (V2-15): nothing of the agent happens after the service confirmed the cessation.
  const confirmedAt = log.indexOf('cessation-confirmed');
  assert.notEqual(confirmedAt, -1, log.join(','));
  const after = log.slice(confirmedAt + 1);
  assert.deepEqual(after.filter(entry => entry === 'model-request'), [], `no model request after the confirmed cessation: ${log.join(',')}`);
  assert.deepEqual(after.filter(entry => entry.startsWith('tool-call:')), [], `no tool call after the confirmed cessation: ${log.join(',')}`);
  // The call in flight was cancelled and answered as "environment ended"; the worker's lifetime was ended by the owner.
  assert.deepEqual(after.filter(entry => entry.startsWith('tool-result:')), ['tool-result:SANDBOX_ENVIRONMENT_ENDED']);
  assert.equal(aborted, true);
  assert.deepEqual(log.filter(entry => entry === 'model-request').length, 2, 'the loop had three more turns to take and took none');
  // A call a worker still attempts is denied, and nothing reaches the guest.
  const programs = guest.executions.length;
  // (By now Control has also stopped the boot's owner, so the endpoint itself is gone; the denial by the latch, with its own code, is
  // pinned at the sandbox level in `test/sandbox/lambda-environment-death.test.ts`.)
  const late = await lateCall!();
  assert.equal(late.status === 'failure' && ['SANDBOX_ENVIRONMENT_ENDED', 'TOOL_CHANNEL_CLOSED'].includes(late.code), true, JSON.stringify(late));
  assert.equal(guest.executions.length, programs);

  // Control ended the activation: the Execution is over as a loss, with what the sandbox observed, and nothing else was launched on that boot.
  assert.deepEqual([ended.end?.outcome, ended.end?.code], ['failure', 'SANDBOX_ENVIRONMENT_ENDED']);
  assert.deepEqual([ended.environmentEnd?.boot, ended.environmentEnd?.reason], [boot, 'MicroVM exceeded maximum lifetime.']);
  assert.deepEqual(launched.filter(item => item.boot === boot), [{ role: 'builder', phaseId: 'builder-initial', boot }]);
  const released = executionOf(await settle('slot released', value => executionOf(value, started.executionId)?.slot.held === false), started.executionId)!;
  assert.equal(released.end?.cessation, 'confirmed');
  // The started command is an uncertain effect of that Execution (ticket 13 gives it to the substitute session).
  assert.deepEqual(released.indeterminateEffects?.map(effect => [effect.tool, effect.description, effect.outcome]), [['bash', 'mvn deploy', 'environment-ended']]);
  // The boot's record carries the end and the reason the service gave; nobody asked the service to terminate anything.
  const record = JSON.parse(await readFile(join(world.root, 'lambda', 'works', environment, 'boots', boot, 'boot.json'), 'utf8')) as { phase: string; end: { reason: string; stateReason: string; terminatedAt: string } };
  assert.deepEqual([record.phase, record.end.reason, record.end.stateReason], ['ended', 'loss', 'MicroVM exceeded maximum lifetime.']);
  assert.equal(typeof record.end.terminatedAt, 'string');
  assert.deepEqual(fake.mutations.filter(mutation => mutation.operation === 'terminateMicrovm'), []);
  assert.equal(watch.pending(), 0, 'the watch of the dead boot is over');
  // v2 ticket 12 (V2-17): the loss is on the Work, from Control's own reads of `origin`: nothing of the Work branch was ever pushed, and
  // the marker ref holds the commit the hook pushed. It is not preservation: nothing was confirmed and the Work has no branch on origin.
  const lostWork = (await settle('loss recorded', value => value?.losses?.length === 1))!;
  const [loss] = lostWork.losses!;
  assert.deepEqual([loss!.executionId, loss!.boot, loss!.reason, loss!.confirmed.commit, loss!.confirmed.source, loss!.session],
    [started.executionId, boot, 'MicroVM exceeded maximum lifetime.', null, 'none', { invocationId: started.invocationId, disposition: 'conserved-as-evidence' }]);
  assert.deepEqual([loss!.marker.state, loss!.marker.ref, loss!.marker.state === 'present' && loss!.marker.commit], ['present', markerRef, unpublished]);
  assert.equal(lostWork.preservation, undefined);
  assert.equal(typeof loss!.consumption.executionMs, 'number');
  // The old session's host directory (the boot's worker runtime) is still there: evidence, removed only by the Work's cleanup.
  assert.equal(await stat(join(world.root, 'r')).then(entry => entry.isDirectory(), () => false), true);
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});

// Final review of the v2 Lambda work (must-fix 1, items 16 and 18), composed level: a boot CONTROL ends with unpublished work. Same
// production composition and the same substitutions as above. The Builder fails with a commit it never pushed; Control's one check runs
// the real preservation program contract against the guest, the boot is stopped AS A LOSS (so the adapter keeps the loss marker holder
// armed for the terminate hook, `keepMarker`, and records the boot's end as `loss`), the loss is recorded with the marker Control read on
// origin, and the Work returns by itself in a NEW boot whose session gets the substitute package.
test('V2-17: a Builder that fails with unpublished work loses the boot visibly: the holder stays armed for the terminate hook, the boot ends as a loss, and the substitute resumes in a new boot', async t => {
  const world = await githubWorld(t, { issues: [issue(3, { title: 'Factory smoke', body: 'Add docs/FACTORY_SMOKE.md.' })], pulls: [], refs: {},
    rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, comments: [], checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      rules: { main: [pullRequestRule] }, checkRuns: {}, statuses: {}, compare: {} } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const fake = lambdaAccountFake();
  const guests = lambdaGuestFake(fake);
  const pushes: Promise<void>[] = [];
  guests.world.origins[remoteUrl] = { commits: [tip], token: token => token.startsWith('synthetic-installation-secret-'), tip: () => null,
    push: (ref, sha) => { pushes.push(world.update(state => { state.factoryRefs = { ...state.factoryRefs, [ref]: sha }; })); } };
  const clock = { now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } };
  const watch = manualObservationTimer(milliseconds => { fake.account.clock.now += milliseconds; });
  // The guest's terminate hook runs when the SERVICE ends the MicroVM: whether a holder was still armed then is what `keepMarker` decides.
  const hooks: { microvmId: string; pushed: boolean }[] = [];
  const service: LambdaServiceFactory = profile => {
    const real = fake.service(profile);
    return { ...real, terminateMicrovm: async id => { hooks.push({ microvmId: id, pushed: guests.terminateHook(id) }); await Promise.all(pushes); return real.terminateMicrovm(id); } };
  };
  const unpublished = 'd'.repeat(40);
  const launched: { phaseId: string; boot: string; prompt: string }[] = [];
  const launcher: LambdaWorkerLauncher = async (request, _endpoint, signal) => {
    const context = request.context;
    const turn = launched.push({ phaseId: context.phaseId, boot: context.bootRef, prompt: request.prompt });
    const started = Promise.resolve({ receipt: { workId: context.workId, id: randomUUID() }, invocation: { executionId: context.executionId, invocationId: context.invocationId } });
    if (turn === 1) {
      // The first Builder commits work, never pushes it, and its activation fails (a transient worker failure).
      guests.guestOf(fake.account.microvms[0]!.microvmId)!.repository!.commit = unpublished;
      return { started, completed: Promise.resolve({ status: 'failure' as const, code: 'WORKER_INTERRUPTED' }), deliver: async () => false };
    }
    // The substitute: at work until the test ends.
    const completed = new Promise<{ status: 'failure'; code: string }>(resolve => signal.addEventListener('abort', () => resolve({ status: 'failure', code: 'WORKER_INTERRUPTED' }), { once: true }));
    return { started, completed, deliver: async () => false };
  };
  const composed = await composeProductionExecution({ root: world.root, effective, guestAssets: { directory: join(world.root, 'guest'), manifestSha256: 'a'.repeat(64) }, github,
    lambda: { service, transport: guests.transport, clock, imageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep }, workerLauncher: launcher, observationTimer: watch.timer } });
  assert.equal(composed.status, 'composed', JSON.stringify(composed));
  if (composed.status !== 'composed') return;
  const dir = await mkdtemp(join(tmpdir(), 'factory-lambda-control-loss-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const time = manualClock();
  let calendar = 0;
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: { ...composed.ports, calendar: { now: () => Date.now() + calendar } },
    access: composeProductionAccess({ github, effective }), polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  let lastSeen = '';
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => until(() => `${label} ${lastSeen}`, async () => {
    const value = await work();
    if (predicate(value)) return value!;
    lastSeen = JSON.stringify({ state: value?.execution?.state, end: value?.execution?.end, held: value?.execution?.held, losses: value?.losses?.length, impediments: value?.impediments, launched: launched.map(item => item.phaseId) });
    // The persisted recovery wait runs on the calendar: jumped, never slept.
    if (time.isSleeping()) { calendar += 60000; time.advance(); }
    return undefined;
  }, 10);

  const lost = await settle('loss recorded', value => value?.losses?.length === 1);
  const [loss] = lost.losses!;
  const failed = [...lost.previousExecutions, ...(lost.execution ? [lost.execution] : [])].find(item => item.executionId === loss!.executionId)!;
  const environment = failed.dispatch.environment!, boot = failed.dispatch.boot!;
  const first = fake.account.microvms[0]!;
  const guest = guests.guestOf(first.microvmId)!;
  // Control's one check ran the preservation program in the guest and found HEAD unpublished; nobody was asked to correct it.
  assert.deepEqual(failed.preservationGate?.attempts.map(item => [item.outcome, item.code]), [['refused', 'HEAD_NOT_PUBLISHED']]);
  assert.equal(guest.executions.filter(item => item.program === 'preservation-gate').length, 1);
  assert.deepEqual([failed.end?.outcome, failed.end?.code, loss!.cause, loss!.boot, loss!.confirmed.commit], ['failure', 'WORKER_INTERRUPTED', 'ended-unpublished', boot, null]);
  // `keepMarker`: the holder armed with the Builder's grant was NOT ended before the stop, so the terminate hook of that MicroVM pushed
  // the committed HEAD to the marker ref, and Control read it on origin for the record.
  const lifecycle = guest.executions.filter(item => item.program.startsWith('loss-marker-')).map(item => item.program);
  assert.deepEqual([lifecycle.includes('loss-marker-arm'), lifecycle.at(-1)], [true, 'loss-marker-arm']);
  assert.deepEqual(hooks, [{ microvmId: first.microvmId, pushed: true }]);
  const markerRef = `refs/factory/lost/${lost.work_id}/${boot}`;
  assert.deepEqual([loss!.marker.state, loss!.marker.ref, loss!.marker.state === 'present' && loss!.marker.commit], ['present', markerRef, unpublished]);
  // The adapter's own record of the boot agrees with Control's: ended as a loss, by a stop that was asked as one.
  const record = JSON.parse(await readFile(join(world.root, 'lambda', 'works', environment, 'boots', boot, 'boot.json'), 'utf8')) as { phase: string; stop: { reason: string }; end: { reason: string } };
  assert.deepEqual([record.phase, record.stop.reason, record.end.reason], ['ended', 'loss', 'loss']);

  // The Work comes back by itself on one operational recovery, in a NEW boot, and that session is the substitute.
  const resumed = await settle('substitute started', value => value?.execution?.executionId !== failed.executionId && value?.execution?.state === 'started');
  assert.notEqual(resumed.execution!.dispatch.boot, boot);
  assert.equal(fake.account.microvms.length, 2);
  assert.deepEqual(launched.map(item => item.phaseId), ['builder-initial', 'builder-recovery']);
  const package_ = launched[1]!.prompt;
  assert.ok(package_.startsWith('Factory notice (new boot): this environment was RECREATED'), package_.slice(0, 200));
  assert.ok(package_.includes('Factory substitute-session package (recovery after a LOSS)'));
  assert.ok(package_.includes(`LOSS declared by the Factory: the environment of boot ${boot} (Execution ${failed.executionId}) was ended by the Factory because its work was not published`));
  assert.ok(package_.includes(`Loss marker ref: ${markerRef} at ${unpublished}`));
  assert.equal(resumed.budget?.recoveries.consumed, 1);
  stop.abort();
  await running;
});
