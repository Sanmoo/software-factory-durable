import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { executionClock } from './budget-doubles.js';
import { app, executionDoubles, pushAs, type Activation, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Final review of the v2 Lambda work, must-fix 1 (V2-10, V2-14, V2-17), flow level: real Control + Pi Durable + temporary SQLite.
// Doubled: GitHub, both clocks, a Sandbox that declares NO persistent disk, Workers and credentials. Every way CONTROL itself ends a boot
// (plain failure, budget end, Execution timeout, controller stop, reconciliation at controller start) is preceded by ONE non-correcting
// preservation check, or recorded as a loss; a loss feeds the ledger of boots and the next session gets the substitute package.
const main = 'b'.repeat(40), unpublished = 'c'.repeat(40);
const packageHeader = 'Factory substitute-session package (recovery after a LOSS)';

async function harness(t: { after(fn: () => Promise<void>): void }, options: { timeoutSeconds?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-boot-end-loss-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const github = githubDoubles(remote);
  const queue: Script[] = [];
  const mono = executionClock();
  const execution = executionDoubles(remote, queue, { diskless: true, clock: mono.clock });
  /** What the sandbox answers to the next stops (default: cessation confirmed). */
  const stops: ('unconfirmed')[] = [];
  const sandbox: typeof execution.ports.sandbox = { ...execution.ports.sandbox, async stop(input) {
    const confirmed = await execution.ports.sandbox.stop(input);
    return stops.shift() === 'unconfirmed' ? { status: 'indeterminate', cessationConfirmed: false, code: 'CESSATION_NOT_CONFIRMED' } : confirmed;
  } };
  // The persisted recovery wait runs on the calendar: jumped, never slept.
  let calendar = 0;
  let current: { stop: AbortController; running: Promise<unknown>; control: Awaited<ReturnType<typeof openControl>>; time: ReturnType<typeof manualClock> } | undefined;
  const open = async () => {
    const time = manualClock();
    const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: { ...execution.ports, sandbox, calendar: { now: () => Date.now() + calendar } },
      access: { tracker: github.tracker, repository: { ...github.repository, readLostMarkers: async () => ({ state: 'complete' as const, observedAt: '2026-11-21T10:00:01.000Z', markers: [] }) },
        repositories: [{ ...scope, ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}) }], operators: ['operator-one'], factoryApp: async () => app },
      polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { stop, running: control.run(stop.signal), control, time };
  };
  const halt = async () => { if (current && !current.stop.signal.aborted) { current.stop.abort(); await current.running; } };
  t.after(halt);
  await open();
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => untilHolds(label, async () => {
    if (predicate(await work())) return true;
    if (current!.time.isSleeping()) { calendar += 60000; current!.time.advance(); }
    return false;
  }, 5);
  const executions = (value: WorkView | undefined) => [...(value?.previousExecutions ?? []), ...(value?.execution ? [value.execution] : [])] as ExecutionView[];
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  const stopReasons = () => execution.calls.filter(call => call.kind === 'stop').map(call => call.detail as string);
  const gates = () => execution.calls.filter(call => call.kind === 'gate').length;
  return { remote, queue, mono, stops, open, halt, work, settle, executions, activations, stopReasons, gates, guest: execution.guest };
}
type Harness = Awaited<ReturnType<typeof harness>>;
/** The first Execution of the Work ended and its Slot was released. */
const firstEnded = (h: Harness) => h.settle('first Execution settled', value => h.executions(value)[0]?.slot.held === false && Boolean(h.executions(value)[0]?.end));
const branchOf = (activation: Activation) => /branch=(\S+)/.exec(activation.prompt)![1]!;

test('V2-17: a Builder failure that leaves unpublished work is a LOSS: one check, the boot ended as a loss, the ledger fed, and the next session gets the substitute package', async t => {
  const h = await harness(t);
  h.queue.push({ kind: 'implement', head: unpublished, failure: 'WORKER_INTERRUPTED' }, { kind: 'hang', head: unpublished });
  await firstEnded(h);
  let work = (await h.work())!;
  const [failed] = h.executions(work);
  assert.deepEqual([failed!.end?.outcome, failed!.end?.code], ['failure', 'WORKER_INTERRUPTED']);
  // ONE check, nobody is asked to correct anything (the Builder is what failed).
  assert.equal(h.gates(), 1);
  assert.deepEqual(failed!.preservationGate?.attempts.map(item => [item.outcome, item.code, item.correction ?? null]), [['refused', 'HEAD_NOT_PUBLISHED', null]]);
  assert.equal(failed!.preservationGate?.occasion, 'boot-end');
  const [loss] = work.losses!;
  assert.deepEqual([loss!.executionId, loss!.boot, loss!.cause, loss!.confirmed.commit, loss!.marker.state], [failed!.executionId, failed!.dispatch.boot, 'ended-unpublished', null, 'absent']);
  assert.match(loss!.reason!, /^Ended by the Factory \(the Builder activation failed: WORKER_INTERRUPTED\) with work that was not on origin: HEAD_NOT_PUBLISHED: /);
  // The sandbox is told why the boot ends, so its own record of the boot agrees with Control's.
  assert.deepEqual(h.stopReasons(), ['loss']);
  assert.deepEqual(work.bootLedger?.map(item => [item.boot, item.end]), [[failed!.dispatch.boot, 'loss']]);
  // The loss consumes one operational recovery and the session that follows is the SUBSTITUTE (V2-18, V2-19), not the MVP recovery.
  await h.settle('substitute started', value => value?.execution?.executionId !== failed!.executionId && value?.execution?.state === 'started');
  work = (await h.work())!;
  assert.equal(work.budget!.recoveries.consumed, 1);
  const substitute = h.activations().at(-1)!;
  assert.ok(substitute.prompt.includes(packageHeader));
  assert.ok(substitute.prompt.includes('was ended by the Factory because its work was not published'));
  assert.ok(substitute.prompt.includes('Conduct of this session (fixed by the Factory):'));
});

test('V2-17: a Builder failure with a clean workspace whose HEAD is the Work branch tip on origin is NOT a loss: the commit is confirmed and the ordinary recovery follows', async t => {
  const h = await harness(t);
  h.queue.push({ kind: 'implement', head: unpublished, failure: 'WORKER_INTERRUPTED', during: (remote, activation) => pushAs(remote, branchOf(activation), unpublished, app) },
    { kind: 'hang', head: unpublished });
  await firstEnded(h);
  let work = (await h.work())!;
  const [failed] = h.executions(work);
  assert.deepEqual([failed!.end?.code, work.losses ?? []], ['WORKER_INTERRUPTED', []]);
  assert.deepEqual(failed!.preservationGate?.attempts.map(item => [item.outcome, item.commit]), [['accepted', unpublished]]);
  assert.deepEqual([work.preservation?.commit, work.preservation?.occasion], [unpublished, 'boot-end']);
  assert.deepEqual(h.stopReasons(), ['builder execution ended']);
  assert.deepEqual(work.bootLedger?.map(item => item.end), ['end']);
  await h.settle('recovery started', value => value?.execution?.executionId !== failed!.executionId && value?.execution?.state === 'started');
  work = (await h.work())!;
  assert.equal(h.activations().at(-1)!.prompt.includes(packageHeader), false);
});

test('V2-17: a Builder budget end that leaves unpublished work is a loss too, and the substitute returns on one operational recovery', async t => {
  const h = await harness(t);
  h.queue.push({ kind: 'implement', head: unpublished, failure: 'WORKER_BUDGET_EXHAUSTED' }, { kind: 'hang', head: unpublished });
  await firstEnded(h);
  const work = (await h.work())!;
  const [ended] = h.executions(work);
  assert.deepEqual([ended!.end?.code, work.losses?.map(item => item.cause), h.stopReasons(), work.bootLedger?.map(item => item.end)],
    ['WORKER_BUDGET_EXHAUSTED', ['ended-unpublished'], ['loss'], ['loss']]);
  await h.settle('substitute started', value => value?.execution?.executionId !== ended!.executionId && value?.execution?.state === 'started');
  assert.ok(h.activations().at(-1)!.prompt.includes(packageHeader));
});

test('V2-17: an Execution timeout on a boot with unpublished work records the loss before the boot is ended; the timeout still blocks as in the MVP', async t => {
  const h = await harness(t, { timeoutSeconds: 120 });
  h.queue.push({ kind: 'hang', head: unpublished });
  await h.settle('started', value => value?.execution?.state === 'started' && h.mono.sleepers() > 0);
  h.mono.advance(120_000);
  await h.settle('timed out', value => value?.execution?.end?.outcome === 'timeout' && value.execution.slot.held === false);
  const work = (await h.work())!;
  assert.deepEqual([h.gates(), work.losses?.map(item => [item.cause, item.boot]), h.stopReasons(), work.bootLedger?.map(item => item.end)],
    [1, [['ended-unpublished', work.execution!.dispatch.boot]], ['loss'], ['loss']]);
  assert.match(work.losses![0]!.reason!, /^Ended by the Factory \(the Execution reached its timeout\) /);
  assert.ok(work.impediments.some(item => item.code === 'EXECUTION_TIMEOUT'));
});

test('V2-17: a graceful stop of the controller checks each running boot first: unpublished work is a recorded loss, and the session after the restart is the substitute', async t => {
  const h = await harness(t);
  h.queue.push({ kind: 'hang', head: unpublished }, { kind: 'hang', head: unpublished });
  await h.settle('started', value => value?.execution?.state === 'started');
  const stopped = (await h.work())!.execution!;
  await h.halt();
  assert.deepEqual([h.gates(), h.stopReasons()], [1, ['loss']]);
  await h.open();
  let work = (await h.work())!;
  const before = h.executions(work).find(item => item.executionId === stopped.executionId)!;
  assert.deepEqual([before.end?.outcome, before.end?.code], ['stopped', 'ADMINISTRATIVE_STOP']);
  assert.deepEqual(work.losses?.map(item => [item.executionId, item.boot, item.cause]), [[stopped.executionId, stopped.dispatch.boot, 'ended-unpublished']]);
  assert.match(work.losses![0]!.reason!, /^Ended by the Factory \(the controller was stopped\) /);
  assert.deepEqual(work.bootLedger?.map(item => item.end), ['loss']);
  await h.settle('substitute started', value => value?.execution?.executionId !== stopped.executionId && value?.execution?.state === 'started');
  work = (await h.work())!;
  assert.ok(h.activations().at(-1)!.prompt.includes(packageHeader));
  // The clean stop of the controller is the Operator's act: no operational recovery is charged for it (MVP §11.4).
  assert.equal(work.budget?.recoveries.consumed ?? 0, 0);
});

test('V2-17: an Execution whose stop could not be settled is reconciled at the next controller start: the loss its live check found is recorded then, from Control\'s own reads, without inspecting the guest again', async t => {
  const h = await harness(t);
  h.queue.push({ kind: 'hang', head: unpublished }, { kind: 'hang', head: unpublished });
  await h.settle('started', value => value?.execution?.state === 'started');
  const left = (await h.work())!.execution!;
  // The stop of the first controller does not confirm the cessation: the Execution stays held for the next controller start.
  h.stops.push('unconfirmed');
  await h.halt();
  const gatesBefore = h.gates();
  await h.open();
  await h.settle('reconciled', value => h.executions(value).find(item => item.executionId === left.executionId)?.slot.held === false);
  let work = (await h.work())!;
  assert.equal(h.gates(), gatesBefore, 'the reconciliation inspects nothing in the guest');
  assert.deepEqual(work.losses?.map(item => [item.executionId, item.boot, item.cause, item.confirmed.commit, item.marker.state]), [[left.executionId, left.dispatch.boot, 'ended-unpublished', null, 'absent']]);
  assert.deepEqual(h.stopReasons().at(-1), 'loss');
  assert.deepEqual(work.bootLedger?.map(item => [item.boot, item.end]), [[left.dispatch.boot, 'loss']]);
  await h.settle('substitute started', value => value?.execution?.executionId !== left.executionId && value?.execution?.state === 'started');
  work = (await h.work())!;
  assert.ok(h.activations().at(-1)!.prompt.includes(packageHeader));
  assert.ok(h.activations().at(-1)!.prompt.includes('was ended by the Factory because its work was not published (Ended by the Factory (the controller was stopped)'));
});

test('V2-17: a boot whose Builder left nothing behind (a clean workspace at the very commit the boot cloned) loses nothing when Control ends it', async t => {
  const h = await harness(t);
  h.queue.push({ kind: 'hang', head: main });
  await h.settle('started', value => value?.execution?.state === 'started');
  await h.halt();
  assert.deepEqual([h.gates(), h.stopReasons()], [1, ['administrative stop']]);
  await h.open();
  const work = (await h.work())!;
  assert.deepEqual([work.losses ?? [], work.bootLedger?.map(item => item.end), h.executions(work)[0]!.preservationGate ?? null], [[], ['end'], null]);
});
