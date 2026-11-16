import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ListView, RuntimeInventory, WorkView } from '../../src/control/types.js';
import { requestRecovery } from '../../src/control/durable/control.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { readHost, recoveryDoubles, updateHost, type RecoveryScript } from './recovery-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (Q11), ticket 26: real Control + Pi Durable/SQLite + Records + the Workers receipt facet; doubled Sandbox host, Builder, credentials
// and GitHub. In-process owners (no crash): live recoverable failures, administrative stop and the boot inventory gate.

async function harness(t: { after(fn: () => Promise<void>): void }, options: { issues?: number[]; capacity?: number; recoveryLimit?: number; repositoryId?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-recovery-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: (options.issues ?? [3]).map(number => remoteIssue(number)) });
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock>; doubles: ReturnType<typeof recoveryDoubles> } | undefined;
  async function start(scripts: RecoveryScript[], inventory: 'empty' | RuntimeInventory = 'empty', extra: { observeStart?: boolean } = {}) {
    const doubles = recoveryDoubles(dir, scripts, { capacity: options.capacity ?? 1, ...extra });
    const time = manualClock();
    const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: inventory, execution: doubles.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...(options.recoveryLimit === undefined ? {} : { recoveryLimit: options.recoveryLimit }) }],
        operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time, doubles };
    await time.sleeping();
    return current;
  }
  async function halt() { if (current && !current.stop.signal.aborted) { current.stop.abort(); return current.running; } return null; }
  t.after(async () => { await halt(); });
  const work = async (number = 3) => ((await current!.control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === number) as WorkView;
  const until = async (predicate: () => Promise<boolean> | boolean, label: string) => {
    await untilHolds(label, async () => {
      if (await predicate()) return true;
      if (current!.time.isSleeping()) current!.time.advance();
      return false;
    }, 5);
  };
  const rounds = async (n: number) => { for (let i = 0; i < n; i++) { current!.time.advance(); await current!.time.sleeping(); } };
  return { dir, start, halt, work, until, rounds, current: () => current! };
}
const idle = (h: Awaited<ReturnType<typeof harness>>, count: number) => h.until(async () =>
  h.current().doubles.calls('activate').length === count && (await h.work()).execution?.slot.held === false, `${count} activations ended`);

test('AC6: a live transient failure returns as ONE recovery under its own counter after persisted waits of 5, 15 and 45 s; repeated events neither anticipate nor renew; exhaustion blocks', async t => {
  const h = await harness(t);
  const fail = { kind: 'fail' as const, code: 'WORKER_EXECUTION_UNCERTAIN' };
  await h.start([fail, fail, fail, fail]);
  await idle(h, 1);
  let work = await h.work();
  assert.deepEqual([work.execution!.end!.outcome, work.pendingRecovery!.waitSeconds, work.pendingRecovery!.attempt, work.queue.pending], ['failure', 5, 0, true]);
  const deadline = work.pendingRecovery!.notBefore!;
  assert.ok(Date.parse(deadline) - Date.parse(work.pendingRecovery!.requestedAt) === 5000);
  // A repeated event: same pending recovery, same deadline, no second unit.
  assert.equal(await requestRecovery(h.current().control, work.work_id, 'repeated transient event'), 'already-open');
  await h.rounds(3);
  work = await h.work();
  assert.deepEqual([work.pendingRecovery!.notBefore, work.budget!.recoveries.consumed, h.current().doubles.calls('activate').length], [deadline, 0, 1]);
  assert.ok(work.dispatch.reasons.includes('RECOVERY_BACKOFF') && work.history.some(item => item.event === 'recovery-wait-kept'));
  for (const [index, wait] of [[2, 15], [3, 45]] as const) {
    h.current().doubles.jumpCalendar(60000);
    await idle(h, index);
    work = await h.work();
    assert.deepEqual([work.execution!.charge!.kind, work.budget!.recoveries.consumed, work.pendingRecovery!.waitSeconds], ['recovery', index - 1, wait]);
    assert.equal(work.execution!.interruption!.reason, 'OPERATIONAL_RECOVERY');
  }
  h.current().doubles.jumpCalendar(120000);
  await idle(h, 4);
  work = await h.work();
  assert.equal(work.budget!.recoveries.consumed, 3);
  assert.ok(work.impediments.some(item => item.code === 'RECOVERY_LIMIT_REACHED'), 'exhaustion is visible at once; no automatic loop');
  h.current().doubles.jumpCalendar(600000);
  await h.rounds(3);
  assert.equal(h.current().doubles.calls('activate').length, 4);
  // A restart neither resets the counters nor renews the budget.
  await h.halt();
  await h.start([]);
  await h.rounds(2);
  work = await h.work();
  assert.deepEqual([work.budget!.recoveries.consumed, h.current().doubles.calls('activate').length], [3, 4]);
});

test('AC6: a blocking failure (drift/authorization/configuration) is never retried automatically', async t => {
  const h = await harness(t);
  await h.start([{ kind: 'fail', code: 'WORKER_SKILL_PACK_DRIFT' }]);
  await idle(h, 1);
  h.current().doubles.jumpCalendar(600000);
  await h.rounds(3);
  const work = await h.work();
  assert.deepEqual([work.pendingRecovery, work.queue.pending, h.current().doubles.calls('activate').length], [null, false, 1]);
});

test('AC7: an administrative stop is clean only after confirmed cessation and persistence; it continues in a new Execution without a recovery charge', async t => {
  const h = await harness(t);
  await h.start([{ kind: 'hang' }]);
  await h.until(async () => (await h.work()).execution?.state === 'started', 'started');
  assert.deepEqual(await h.halt(), { kind: 'clean' });
  const stopped = readHost(h.dir);
  assert.ok(Object.values(stopped.boots).every(state => state === 'stopped'), 'the own boot ceased (host stop)');
  await h.start([{ kind: 'complete' }]);
  let work = await h.work();
  await idle(h, 2);
  work = await h.work();
  const first = work.previousExecutions.at(-1)!;
  assert.deepEqual([first.end!.outcome, first.end!.code, first.end!.cessation, first.slot.held, first.timing!.duration!.kind], ['stopped', 'ADMINISTRATIVE_STOP', 'confirmed', false, 'measured']);
  assert.deepEqual([work.execution!.interruption!.reason, work.execution!.charge!.kind, work.budget!.recoveries.consumed, work.pendingRecovery], ['ADMINISTRATIVE_STOP', 'none', 0, null]);
  assert.match(h.current().doubles.prompts.at(-1)!.prompt, /stopped administratively/);
});

test('AC7: a stop whose cessation is unconfirmed is `uncertain`, never clean; the next boot treats it as an interruption (failure treatment, recovery charge)', async t => {
  const h = await harness(t);
  await h.start([{ kind: 'hang' }]);
  await h.until(async () => (await h.work()).execution?.state === 'started', 'started');
  const boot = (await h.work()).execution!.dispatch.boot!;
  updateHost(h.dir, state => { state.stuck.push(boot); });
  assert.deepEqual(await h.halt(), { kind: 'uncertain' });
  // Later the unit does stop (operator/host); the next boot reconciles the interruption.
  updateHost(h.dir, state => { state.stuck = []; });
  await h.start([{ kind: 'complete' }]);
  const work = await h.work();
  assert.deepEqual([work.execution!.end!.outcome, work.execution!.end!.code, work.execution!.recovery!.at(-1)!.decision, work.pendingRecovery!.waitSeconds],
    ['failure', 'ADMINISTRATIVE_STOP_CESSATION_UNCONFIRMED', 'operational-recovery', 5]);
});

test('AC7: an administrative stop while the start receipt is awaited consults the receipt facet: a discovered start ends as a stopped continuation', async t => {
  const h = await harness(t);
  await h.start([{ kind: 'lose-notification' }]);
  await h.until(() => h.current().doubles.calls('receipt').length === 1, 'receipt written');
  assert.deepEqual(await h.halt(), { kind: 'clean' });
  await h.start([{ kind: 'complete' }]);
  await idle(h, 2);
  const work = await h.work();
  const stopped = work.previousExecutions.at(-1)!;
  assert.deepEqual([stopped.start !== null, stopped.end!.outcome, stopped.recovery![0]!.trigger, stopped.recovery![0]!.start.kind, stopped.charge!.state],
    [true, 'stopped', 'administrative-stop', 'confirmed', 'none']);
  assert.deepEqual([work.execution!.interruption!.reason, work.budget!.recoveries.consumed], ['ADMINISTRATIVE_STOP', 0], 'continuation without recovery charge');
});

test('AC1/AC5: the listed host inventory gates dispatch — unknown resources keep it closed; a Git cache in preparation blocks only its repository', async t => {
  const h = await harness(t);
  const base: RuntimeInventory = { kind: 'listed', observedAt: new Date().toISOString(), environments: [], cache: [], unknown: [] };
  let { control } = await h.start([], { ...base, unknown: ['run/stale-socket'], environments: [{ environment: `env-${'9'.repeat(64)}`, workId: null }] });
  let status = await control.inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([status.dispatch, status.dispatchReason], ['closed', 'RECONCILIATION_REQUIRED']);
  assert.deepEqual(status.recovery!.global, [`UNKNOWN_RESOURCE:environment:env-${'9'.repeat(64)}`, 'UNKNOWN_RESOURCE:run/stale-socket']);
  await h.rounds(2);
  assert.equal(h.current().doubles.calls('prepare').length, 0, 'nothing dispatched while unknown resources exist');
  await h.halt();
  ({ control } = await h.start([], { ...base, cache: [{ repositoryId: 3, state: 'preparing' }, { repositoryId: 99, state: 'preparing' }] }));
  status = await control.inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([status.dispatch, status.recovery!.cachePreparing], ['open', [3, 99]]);
  await h.rounds(2);
  const work = await h.work();
  assert.ok(work.dispatch.reasons.includes('CACHE_RECONCILIATION_REQUIRED'));
  assert.equal(h.current().doubles.calls('prepare').length, 0);
  await h.halt();
  // An own environment of a Work that is settled is observed; a survivor without an Execution is stopped, never adopted.
  await h.start([{ kind: 'complete' }]);
  await idle(h, 1);
  const { work_id, execution } = await h.work();
  const environment = execution!.dispatch.environment!;
  const survivor = 'boot-00000000-0000-4000-8000-000000000026';
  updateHost(h.dir, state => { state.boots[survivor] = 'active'; state.current[environment] = survivor; });
  await h.halt();
  ({ control } = await h.start([], { ...base, environments: [{ environment, workId: work_id }] }));
  status = await control.inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([status.dispatch, readHost(h.dir).boots[survivor]], ['open', 'stopped']);
});


test('review MED2: settling an ended Execution reuses ticket 11 — a completed Execution whose stop was unconfirmed requeues for a scope update accepted meanwhile', async t => {
  const h = await harness(t);
  await h.start([{ kind: 'hang' }, { kind: 'complete' }]);
  await h.until(async () => (await h.work()).execution?.state === 'started', 'started');
  const work_id = (await h.work()).work_id;
  const receipt = await h.current().control.accept({ request_id: 'scope-26', operation: 'update-scope', work_id, reason: 'Also expose the port in the README file', origin: 'local-cli' });
  assert.equal((receipt as { outcome: string }).outcome, 'deferred');
  const boot = (await h.work()).execution!.dispatch.boot!;
  updateHost(h.dir, state => { state.stuck.push(boot); });
  h.current().doubles.finish(0);
  await h.until(async () => (await h.work()).execution?.state === 'ended', 'ended with unconfirmed cessation');
  let work = await h.work();
  assert.deepEqual([work.execution!.end!.outcome, work.execution!.end!.cessation, work.execution!.slot.held, work.queue.pending], ['completed', 'unconfirmed', true, false]);
  await h.halt();
  updateHost(h.dir, state => { state.stuck = []; });
  await h.start([{ kind: 'complete' }]);
  await idle(h, 2);
  work = await h.work();
  const settled = work.previousExecutions.at(-1)!;
  assert.deepEqual([settled.end!.cessation, settled.recovery![0]!.decision], ['confirmed', 'settled']);
  assert.equal(work.execution!.request.resume?.reason, 'SCOPE_UPDATED', 'the pending authorized scope change resumes the Work through its queue position');
});

test('review LOW: a FORCED termination at an administrative stop is not clean — failure treatment (one operational recovery)', async t => {
  const h = await harness(t);
  await h.start([{ kind: 'hang' }]);
  await h.until(async () => (await h.work()).execution?.state === 'started', 'started');
  updateHost(h.dir, state => { state.forced = true; });
  assert.deepEqual(await h.halt(), { kind: 'uncertain' });
  updateHost(h.dir, state => { state.forced = false; });
  await h.start([]);
  const work = await h.work();
  assert.deepEqual([work.execution!.end!.outcome, work.execution!.end!.code, work.execution!.slot.held, work.pendingRecovery!.waitSeconds],
    ['failure', 'ADMINISTRATIVE_STOP_FORCED', false, 5]);
});
