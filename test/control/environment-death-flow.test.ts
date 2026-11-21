import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilHolds } from '../runner/budget.js';
import type { SandboxCapabilities } from '../../src/contracts/index.js';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, WorkView } from '../../src/control/types.js';
import type { Invocation } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { readHost, recoveryDoubles, type RecoveryScript } from './recovery-doubles.js';

// v2 ticket 10 flow level (V2-15): real Control + Pi Durable/SQLite + Records; doubled: GitHub, a TEST sandbox that declares capabilities
// and reports the end of an environment (file-backed host of the recovery doubles), the Builder and credentials. It shows what CONTROL
// does when the sandbox confirms the cessation; it is not evidence of any real sandbox, worker process or model.
const base: SandboxCapabilities = { docker: true, persistentDisk: true, bootDuration: null, egress: { mediation: 'none', publicTcp: true, udp: false, ipv6: false, privateNetwork: false } };

async function harness(t: { after(fn: () => Promise<void>): void }, scripts: RecoveryScript[], capabilities: SandboxCapabilities) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-environment-death-flow-'));
  const world: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(world);
  const activations: Invocation[] = [];
  const doubles = recoveryDoubles(dir, scripts, { onActivate: invocation => { activations.push(invocation); } });
  const time = manualClock();
  const watched: { environment: string; boot: string; signal: AbortSignal; end(reason: string): void }[] = [];
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty',
    execution: { ...doubles.ports, sandbox: { ...doubles.ports.sandbox, capabilities,
      awaitEnvironmentEnd: input => new Promise(resolve => {
        watched.push({ ...input, end: reason => resolve({ reason, terminatedAt: null }) });
        input.signal.addEventListener('abort', () => resolve(null), { once: true });
      }) } },
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; await rm(dir, { recursive: true, force: true }); });
  await time.sleeping();
  const work = async () => (((await control.inspect({ kind: 'list' })) as ListView).works as WorkView[]).find(item => item.ticket.number === 3)!;
  const until = (predicate: () => Promise<boolean> | boolean, label: string) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  return { dir, doubles, work, until, watched, activations, time };
}

test('V2-15: when the sandbox confirms that the environment ended, Control ends the activation: the worker is interrupted, the Execution ends as a loss and the Slot is released', async t => {
  const h = await harness(t, [{ kind: 'hang' }], { ...base, environmentWatch: true });
  await h.until(async () => (await h.work())?.execution?.state === 'started' && h.watched.length === 1, 'the Builder started and Control waits on the sandbox');
  const started = (await h.work()).execution!;
  assert.deepEqual([h.watched[0]!.environment, h.watched[0]!.boot], [started.dispatch.environment, started.dispatch.boot], 'Control watches the boot it started, through the sandbox');
  assert.equal(h.activations[0]!.signal.aborted, false);
  h.watched[0]!.end('MicroVM exceeded maximum lifetime.');
  await h.until(async () => {
    const work = await h.work();
    return [...work.previousExecutions, work.execution!].find(item => item.executionId === started.executionId)?.end != null;
  }, 'the Execution ended');
  // The activation is over for the worker: its signal (model requests and tool calls of the session hang on it) is aborted.
  assert.equal(h.activations[0]!.signal.aborted, true);
  const work = await h.work();
  const ended = [...work.previousExecutions, work.execution!].find(item => item.executionId === started.executionId)!;
  assert.deepEqual([ended.end?.outcome, ended.end?.code], ['failure', 'SANDBOX_ENVIRONMENT_ENDED']);
  await h.until(async () => {
    const shown = await h.work();
    return [...shown.previousExecutions, shown.execution!].find(item => item.executionId === started.executionId)?.slot.held === false;
  }, 'the Slot was released after the cessation the sandbox confirmed');
  // What the sandbox observed is on the Execution, for the loss record (ticket 12) and the consumption (ticket 14).
  assert.deepEqual([ended.environmentEnd?.boot, ended.environmentEnd?.reason], [started.dispatch.boot, 'MicroVM exceeded maximum lifetime.']);
  // The boot is settled through the sandbox's own Stop (which confirms from the service), and the watch of that boot is over.
  assert.deepEqual(readHost(h.dir).log.filter(entry => entry.kind === 'stop').map(entry => (entry.detail as { boot: string }).boot), [started.dispatch.boot]);
  assert.equal(h.watched[0]!.signal.aborted, true);
});

test('V2-15: Control has no watchdog of its own: a silent Builder with a living environment is never ended by the watch, and a sandbox that does not declare it is never asked', async t => {
  const watching = await harness(t, [{ kind: 'hang' }], { ...base, environmentWatch: true });
  await watching.until(async () => (await watching.work())?.execution?.state === 'started' && watching.watched.length === 1, 'started');
  for (let round = 0; round < 5; round += 1) { watching.time.advance(); await watching.time.sleeping(); }
  const silent = (await watching.work()).execution!;
  assert.deepEqual([silent.state, silent.end ?? null, watching.activations[0]!.signal.aborted], ['started', null, false]);

  const plain = await harness(t, [{ kind: 'complete' }], base);
  await plain.until(async () => (await plain.work())?.execution?.dispatch.phase === 'stopped', 'execution ended and its boot stopped');
  assert.deepEqual(plain.watched, []);
});

test('V2-15: an Execution that ended normally stops watching its boot', async t => {
  const h = await harness(t, [{ kind: 'complete' }], { ...base, environmentWatch: true });
  await h.until(async () => (await h.work())?.execution?.dispatch.phase === 'stopped', 'execution ended and its boot stopped');
  assert.deepEqual([h.watched.length, h.watched[0]!.signal.aborted], [1, true]);
  assert.deepEqual([(await h.work()).execution!.end?.outcome, (await h.work()).execution!.end?.code], ['completed', null]);
});

test('V2-15: an environment that ends before the Builder\'s start was confirmed ends nothing by guess: the Execution is held with its Slot under ENVIRONMENT_ENDED_START_UNCONFIRMED and the next controller start reconciles it', async t => {
  // The worker was asked to start and never wrote its receipt: whether it started is unknown when the environment ends.
  const h = await harness(t, [{ kind: 'no-receipt' }], { ...base, environmentWatch: true });
  await h.until(async () => h.watched.length === 1 && h.activations.length === 1, 'the activation was requested and Control waits on the sandbox');
  const requested = (await h.work()).execution!;
  assert.deepEqual([requested.dispatch.phase, requested.start ?? null], ['activation-requested', null]);
  h.watched[0]!.end('MicroVM exceeded maximum lifetime.');
  await h.until(async () => (await h.work()).execution?.state === 'held', 'the Execution is held');
  const held = (await h.work()).execution!;
  assert.deepEqual([held.held?.code, held.slot.held, held.end ?? null, held.start ?? null], ['ENVIRONMENT_ENDED_START_UNCONFIRMED', true, null, null]);
  assert.match(held.held!.nextStep, /the next controller boot reconciles it/);
  // What the sandbox observed is on the record, the worker was interrupted and the boot was settled through the sandbox's Stop.
  assert.deepEqual([held.environmentEnd?.boot, held.environmentEnd?.reason, h.activations[0]!.signal.aborted], [held.dispatch.boot, 'MicroVM exceeded maximum lifetime.', true]);
  assert.deepEqual(readHost(h.dir).log.filter(entry => entry.kind === 'stop').map(entry => (entry.detail as { boot: string }).boot), [held.dispatch.boot]);
  // No recovery is opened on a start nobody confirmed.
  assert.equal((await h.work()).pendingRecovery ?? null, null);
});
