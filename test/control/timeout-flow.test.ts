import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mock, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlReceipt, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { budgetDoubles, executionClock, type Script } from './budget-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (Q11): real Control + Pi Durable + temporary SQLite. Doubled: GitHub tracker, the polling clock, the LOCAL MONOTONIC clock of
// the Execution (controlled: no 61 real minutes) and the execution boundaries. The calendar is moved independently with mocked Date.
// NOT evidence of the real VM/worker/model/GitHub nor of a real elapsed hour.
const qid = (n: number) => `0b9c6a52-3d3e-4c8f-9a51-${String(n).padStart(12, '0')}`;
const minute = 60000;

async function harness(t: { after(fn: () => Promise<void>): void }, scripts: Script[], options: { timeoutSeconds?: number; reviews?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  const monotonic = executionClock();
  const execution = budgetDoubles(scripts, { clock: monotonic.clock, ...(options.reviews ? { reviews: true } : {}) });
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      execution: execution.ports,
      access: {
        tracker: github.tracker,
        repository: github.repository,
        repositories: [{ ...scope, ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}) }],
        operators: ['operator-one'],
      },
      polling: { intervalSeconds: 60, clock: time.clock },
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
    return current;
  }
  async function stop() {
    current!.stop.abort();
    assert.deepEqual(await current!.running, { kind: 'clean' });
  }
  t.after(async () => {
    if (current && !current.stop.signal.aborted) await stop();
  });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0]!;
  const show = async () => (await current!.control.inspect({ kind: 'show', work_id: (await work()).work_id })) as Extract<ShowView, { kind: 'work' }>;
  const settle = async (predicate: () => Promise<boolean>, label = 'condition') => {
    await untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (current!.time.isSleeping()) current!.time.advance();
        return false;
      },
      5,
    );
  };
  const until = async (predicate: () => Promise<boolean>, label = 'condition') => {
    await untilHolds(label, predicate, 5);
  };
  const cycles = async (n: number) => {
    for (let i = 0; i < n; i++) {
      current!.time.advance();
      await current!.time.sleeping();
    }
  };
  const running = async () => {
    await settle(async () => (await work())?.execution?.state === 'started', 'Builder started');
  };
  return { execution, monotonic, start, stop, work, show, settle, until, cycles, running, storagePath, control: () => current!.control };
}
const kinds = (h: { execution: { calls: { kind: string }[] } }) => h.execution.calls.map(call => call.kind);

test('AC4/AC5/AC6: a configured per-repo timeout is measured on the local monotonic clock (calendar jumps do not count), records the timeout, interrupts and blocks', async t => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T10:00:00.000Z') });
  t.after(() => mock.timers.reset());
  const h = await harness(t, [{ kind: 'hang' }], { timeoutSeconds: 120 });
  await h.start();
  await h.running();
  await h.until(async () => h.monotonic.sleepers() === 1, 'timer armed');
  // Calendar adjustments (forward 3 h, then backward) never move the Execution clock.
  mock.timers.setTime(Date.parse('2026-11-14T13:00:00.000Z'));
  h.monotonic.advance(119000);
  await h.cycles(2);
  mock.timers.setTime(Date.parse('2026-11-14T09:00:00.000Z'));
  await h.cycles(1);
  let view = await h.show();
  assert.equal(view.work.execution!.state, 'started', '119 s monotonic: not reached whatever the calendar says');
  assert.deepEqual(
    [view.work.limits.duration.state, view.work.limits.duration.elapsedMs, view.work.limits.duration.clock],
    ['running', 119000, 'controller-monotonic'],
  );
  assert.deepEqual([view.work.limits.timeout.seconds, view.work.limits.timeout.scope, view.work.limits.timeout.reached], [120, 'per-execution', null]);
  assert.equal(kinds(h).includes('stop'), false);
  h.monotonic.advance(1000);
  await h.settle(async () => (await h.work()).execution?.slot.held === false, 'timeout handled, Slot released after cessation');
  view = await h.show();
  const execution = view.work.execution!;
  assert.deepEqual(
    [execution.state, execution.end!.outcome, execution.end!.code, execution.end!.cessation],
    ['ended', 'timeout', 'EXECUTION_TIMEOUT', 'confirmed'],
  );
  assert.deepEqual([execution.timing!.timeout!.elapsedMs, execution.timing!.timeout!.evidence, execution.timing!.overrun], [120000, 'measured', 'proven']);
  assert.deepEqual(
    execution.timing!.duration && execution.timing!.duration.kind === 'measured' ? execution.timing!.duration.elapsedMs : null,
    120000,
    'duration is the monotonic value, not calendar arithmetic',
  );
  assert.equal(
    execution.timing!.origin,
    ((await h.control().inspect({ kind: 'status' })) as { controller_run_id: string }).controller_run_id,
    'measured by THIS controller origin',
  );
  assert.ok(h.execution.signals[0]!.signal.aborted, 'the activity was interrupted (worker channel closed)');
  assert.deepEqual([execution.credentialLifecycle.state, execution.credentialLifecycle.reason], ['withdrawn', 'timeout']);
  assert.ok(kinds(h).indexOf('revoke') < kinds(h).indexOf('stop'), 'credentials withdrawn/revoked before the boot stop');
  assert.ok(view.work.impediments.some(item => item.code === 'EXECUTION_TIMEOUT' && /no new clock/.test(item.nextStep)));
  assert.equal(view.work.dispatch.state, 'held');
  assert.ok(view.work.dispatch.reasons.includes('EXECUTION_TIMEOUT'));
  assert.ok(
    view.work.limits.actions.some(action => action.code === 'EXECUTION_TIMEOUT'),
    'the CLI view shows the required action',
  );
  // No automatic loop: polling rounds, a grant or a restart never relaunch it nor renew its clock.
  await h.cycles(4);
  const grant = (await h
    .control()
    .accept({ request_id: 'grant-t1', operation: 'grant', work_id: view.work.work_id, counter: 'corrections', amount: 1, origin: 'local-cli' })) as Extract<
    ControlReceipt,
    { operation: 'grant' }
  >;
  assert.equal(grant.outcome, 'accepted');
  await h.cycles(2);
  await h.stop();
  await h.start();
  await h.cycles(2);
  const after = await h.work();
  assert.equal(h.execution.activations().length, 1);
  assert.ok(
    after.impediments.some(item => item.code === 'EXECUTION_TIMEOUT'),
    'grant/restart do not bypass a reached timeout',
  );
  assert.equal(after.history.filter(item => item.event === 'timeout-reached').length, 1);
});

test('AC4/AC5: without a configured timeout there is no cut at 60 minutes (or any other); duration and last activity stay observable', async t => {
  const h = await harness(t, [{ kind: 'hang' }]);
  await h.start();
  await h.running();
  h.monotonic.advance(61 * minute);
  await h.cycles(3);
  let view = await h.show();
  assert.equal(view.work.execution!.state, 'started');
  assert.equal(h.monotonic.sleepers(), 0, 'no timer is armed at all');
  assert.equal(kinds(h).includes('stop'), false);
  assert.deepEqual([view.work.limits.timeout.seconds, view.work.limits.duration.state, view.work.limits.duration.elapsedMs], [null, 'running', 61 * minute]);
  assert.equal(view.work.limits.duration.lastActivity!.event, 'started');
  assert.match(view.work.limits.duration.note, /Silence is not a stall/);
  h.execution.finish(0);
  await h.settle(async () => (await h.work()).execution?.slot.held === false);
  view = await h.show();
  assert.deepEqual(
    [view.work.limits.duration.state, view.work.limits.duration.elapsedMs, view.work.execution!.timing!.overrun],
    ['measured', 61 * minute, 'not-applicable'],
  );
  assert.equal(view.work.impediments.length, 0);
});

test('AC4: the timeout covers the review round inside the SAME Execution: reviewers are interrupted with the Builder, no extra Slot', async t => {
  const h = await harness(t, [{ kind: 'handoff' }], { timeoutSeconds: 120, reviews: true });
  await h.start();
  await h.running();
  await h.until(async () => kinds(h).includes('activate-standards') && kinds(h).includes('activate-spec'), 'reviewers running');
  const during = await h.work();
  assert.match(during.limits.duration.lastActivity!.event, /^(review-handoff-r1|reviewer-started-)/);
  h.monotonic.advance(120000);
  await h.settle(async () => (await h.work()).execution?.slot.held === false, 'timeout during review');
  const work = await h.work();
  assert.deepEqual([work.execution!.end!.outcome, work.execution!.timing!.timeout!.elapsedMs], ['timeout', 120000]);
  assert.ok(
    h.execution.signals.every(item => item.signal.aborted),
    'Builder AND both reviewers interrupted',
  );
  assert.deepEqual(h.execution.signals.map(item => item.role).sort(), ['builder', 'spec', 'standards']);
  assert.ok(work.impediments.some(item => item.code === 'EXECUTION_TIMEOUT'));
});

test('AC4: an external wait ends the activity and its clock; the next Execution has a new clock (no accumulation); a timeout reached before the wait is never bypassed', async t => {
  const h = await harness(
    t,
    [
      {
        kind: 'ask',
        questionId: qid(1),
        question: 'Which file?',
        beforeAsk: async () => {
          await h.until(async () => h.monotonic.sleepers() === 1, 'timer armed');
          h.monotonic.advance(100000);
        },
      },
      { kind: 'hang' },
    ],
    { timeoutSeconds: 120 },
  );
  await h.start();
  await h.settle(async () => (await h.work()).execution?.end?.outcome === 'question' && (await h.work()).execution?.slot.held === false, 'question wait');
  let work = await h.work();
  assert.deepEqual(
    [work.execution!.timing!.duration, work.execution!.timing!.overrun].map(value =>
      value && typeof value === 'object' ? (value as { elapsedMs: number }).elapsedMs : value,
    ),
    [100000, 'within'],
    'measured up to the end of the activity',
  );
  assert.equal(h.monotonic.sleepers(), 0, 'the clock stopped with the activity');
  h.monotonic.advance(60 * minute);
  await h.cycles(2);
  work = await h.work();
  assert.equal(
    work.impediments.some(item => item.code === 'EXECUTION_TIMEOUT'),
    false,
    'waiting for an answer consumes no active time',
  );
  const firstExecution = work.execution!.executionId;
  await h.control().accept({ request_id: 'answer-1', operation: 'answer', question_id: qid(1), text: 'docs/a.md', origin: 'local-cli' });
  await h.settle(
    async () => (await h.work()).execution?.executionId !== firstExecution && (await h.work()).execution?.state === 'started',
    'continuation started',
  );
  h.monotonic.advance(119000);
  await h.cycles(1);
  work = await h.work();
  assert.equal(work.execution!.state, 'started', '100 s + 119 s across two Executions: no accumulated per-Work ceiling');
  assert.equal(work.limits.duration.elapsedMs, 119000, 'new clock for the new Execution');
  h.monotonic.advance(1000);
  await h.settle(async () => (await h.work()).execution?.end?.outcome === 'timeout', 'continuation times out on its own clock');
});

test('AC4/AC6: a question whose activity had already reached the timeout keeps EXECUTION_TIMEOUT after the answer (no bypass through the wait)', async t => {
  const h = await harness(
    t,
    [
      // The monotonic clock passes the limit while the timer wake-up is late: the end observes elapsed >= timeout.
      {
        kind: 'ask',
        questionId: qid(2),
        question: 'Late?',
        beforeAsk: async () => {
          await h.until(async () => h.monotonic.sleepers() === 1, 'timer armed');
          h.monotonic.jump(130000);
        },
      },
      { kind: 'complete' },
    ],
    { timeoutSeconds: 120 },
  );
  await h.start();
  await h.settle(async () => (await h.work()).execution?.slot.held === false && (await h.work()).execution?.end !== null, 'ended');
  let work = await h.work();
  assert.deepEqual([work.execution!.end!.outcome, work.execution!.timing!.overrun, work.execution!.timing!.timeout!.elapsedMs], ['question', 'proven', 130000]);
  assert.deepEqual(work.impediments.map(item => item.code).sort(), ['EXECUTION_TIMEOUT', 'QUESTION_PENDING']);
  await h.control().accept({ request_id: 'answer-2', operation: 'answer', question_id: qid(2), text: 'yes', origin: 'local-cli' });
  await h.cycles(3);
  work = await h.work();
  assert.deepEqual(
    work.impediments.map(item => item.code),
    ['EXECUTION_TIMEOUT'],
    'the answer removes only its own impediment',
  );
  assert.equal(h.execution.activations().length, 1, 'no continuation renews the clock of a timed-out Execution');
});

/** A real controller child process is SIGKILLed once its Builder Execution runs (see timing-crash-child). */
async function crashed(storagePath: string, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./timing-crash-child.js', import.meta.url)), storagePath, mode], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', chunk => {
      out += String(chunk);
      if (out.includes('ACTIVE')) resolve();
    });
    child.once('exit', code => reject(new Error(`child exited ${code}`)));
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
}
async function reopen(t: { after(fn: () => Promise<void>): void }, storagePath: string, timeoutSeconds?: number) {
  const time = manualClock();
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  const control = await openControl({
    storagePath,
    runtimeInventory: 'empty',
    execution: budgetDoubles([]).ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...(timeoutSeconds ? { timeoutSeconds } : {}) }] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  return { control, time };
}

test('AC5/AC6: after a real controller crash, proven, estimated and unknown durations stay distinct; an overrun that cannot be excluded blocks automatic resumption', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-timing-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ['timeout', 'none', 'proven'] as const) {
    const storagePath = join(dir, `${mode}.sqlite`);
    await crashed(storagePath, mode);
    const { control, time } = await reopen(t, storagePath, mode === 'none' ? undefined : 120);
    // Before reconciliation: not measured by this process -> unknown, never zero.
    const before = ((await control.inspect({ kind: 'list' })) as ListView).works[0]!;
    assert.deepEqual([before.limits.duration.state, before.limits.duration.elapsedMs], ['unknown', null], mode);
    const stop = new AbortController();
    const running = control.run(stop.signal);
    await time.sleeping();
    const work: WorkView = ((await control.inspect({ kind: 'list' })) as ListView).works[0]!;
    const timing = work.execution!.timing!;
    assert.equal(timing.duration?.kind, 'lower-bound', mode);
    const lower = timing.duration as { provenMs: number; calendarEstimateMs: number | null };
    assert.ok(lower.calendarEstimateMs === null || lower.calendarEstimateMs >= 0);
    assert.deepEqual(
      [work.limits.duration.state, work.limits.duration.elapsedMs, work.limits.duration.lowerBoundMs],
      ['lower-bound', null, lower.provenMs],
      `${mode}: lower bound, never zero/measured`,
    );
    const codes = work.impediments.map(item => item.code);
    if (mode === 'timeout') {
      assert.deepEqual([lower.provenMs, timing.overrun], [0, 'not-excludable']);
      assert.ok(codes.includes('TIMEOUT_OVERRUN_NOT_EXCLUDED'));
    } else if (mode === 'none') {
      assert.deepEqual([timing.overrun, codes], ['not-applicable', []], 'without timeout imprecision is not a block');
    } else {
      assert.deepEqual([lower.provenMs, timing.overrun, timing.timeout!.evidence], [130000, 'proven', 'lower-bound']);
      assert.ok(codes.includes('EXECUTION_TIMEOUT'));
    }
    assert.equal(work.history.filter(item => item.event === 'duration-reconciled').length, 1);
    stop.abort();
    assert.deepEqual(await running, { kind: 'clean' });
    // A second boot never re-reconciles nor rewrites the evidence of the lost origin.
    const again = await reopen(t, storagePath, mode === 'none' ? undefined : 120);
    const halt = new AbortController();
    const second = again.control.run(halt.signal);
    await again.time.sleeping();
    const reread = ((await again.control.inspect({ kind: 'list' })) as ListView).works[0]!;
    assert.equal(reread.history.filter(item => item.event === 'duration-reconciled').length, 1);
    halt.abort();
    await second;
    assert.doesNotMatch(await readFile(storagePath, 'latin1'), /ghs_synthetic/);
  }
});
