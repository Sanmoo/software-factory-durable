import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ListView, RuntimeInventory, WorkView } from '../../src/control/types.js';
import { createHash } from 'node:crypto';
import { confirmStart } from '../../src/control/durable/execution.js';
import { openStore } from '../../src/control/durable/store.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { readHost, recoveryDoubles, updateHost, type RecoveryScript } from './recovery-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Ticket 26, real crash cuts: a REAL controller child process (Control + Pi Durable/SQLite + Records) is SIGKILLed at a defined point with its
// doubled boot left active; a NEW Control boots on the same storage/Records and reconciles. Doubled: Sandbox host (file-backed), Builder,
// credentials, GitHub. Not evidence of a VM/systemd/worker/model/GitHub (the real-boundary recipe is recovery26-qualification.ts).

async function crash(dir: string, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./recovery-crash-child.js', import.meta.url)), dir, mode], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk;
      if (output.includes('CUT')) child.kill('SIGKILL');
    });
    child.on('exit', (_code, signal) => (signal === 'SIGKILL' ? resolve() : reject(new Error(`child exited without crash: ${output}`))));
  });
}

async function reopen(
  t: { after(fn: () => Promise<void>): void },
  dir: string,
  scripts: RecoveryScript[],
  options: { capacity?: number; issues?: number[]; inventory?: RuntimeInventory; reviews?: boolean } = {},
) {
  const doubles = recoveryDoubles(dir, scripts, { capacity: options.capacity ?? 1, ...(options.reviews ? { reviews: true } : {}) });
  const github = githubDoubles({ pulls: {}, issues: (options.issues ?? [3]).map(number => remoteIssue(number)) });
  const time = manualClock();
  const control: Control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: options.inventory ?? 'empty',
    execution: doubles.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const before = (await control.inspect({ kind: 'status' })) as ControlStatus;
  const stop = new AbortController();
  const running = control.run(stop.signal);
  let halted = false;
  const halt = async () => {
    if (!halted) {
      halted = true;
      stop.abort();
      return running;
    }
    return { kind: 'clean' };
  };
  t.after(async () => {
    await halt();
  });
  await time.sleeping();
  const works = async () => ((await control.inspect({ kind: 'list' })) as ListView).works;
  const work = async (number = 3) => (await works()).find(item => item.ticket.number === number) as WorkView;
  const until = async (predicate: () => Promise<boolean> | boolean, label: string) => {
    await untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (time.isSleeping()) time.advance();
        return false;
      },
      5,
    );
  };
  return { control, doubles, before, works, work, until, halt, time };
}
const scratch = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-recovery-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const kinds = (dir: string) => readHost(dir).log.map(item => item.kind);

test('AC1/AC2/AC8 tool cut: the barrier is closed at boot; the survivor boot is stopped by the host BEFORE anything new; the Work comes back as ONE recovery after its wait, on the preserved checkout, with an explicit instruction', async t => {
  const dir = await scratch(t);
  await crash(dir, 'tool');
  const crashed = readHost(dir);
  const survivor = Object.entries(crashed.boots).find(([, state]) => state === 'active')![0];
  const logLength = crashed.log.length;
  const h = await reopen(t, dir, [{ kind: 'complete' }]);
  assert.deepEqual([h.before.dispatch, h.before.dispatchReason], ['closed', 'RECONCILIATION_REQUIRED'], 'Pi Durable opens with the barrier closed');
  const after = readHost(dir).log.slice(logLength);
  assert.deepEqual(
    after.slice(0, 1).map(item => [item.kind, (item.detail as { boot: string }).boot]),
    [['stop', survivor]],
    'the first effect of the new owner stops the survivor',
  );
  assert.equal(readHost(dir).boots[survivor], 'stopped');
  let work = await h.work();
  const crashedExecution = work.execution!;
  assert.deepEqual(
    [crashedExecution.state, crashedExecution.end!.outcome, crashedExecution.end!.code, crashedExecution.end!.cessation, crashedExecution.slot.held],
    ['ended', 'failure', 'CONTROLLER_CRASH', 'confirmed', false],
  );
  const record = crashedExecution.recovery![0]!;
  assert.deepEqual(
    [record.trigger, record.found.state, record.cessation.result, record.cessation.basis, record.start.kind, record.decision],
    ['boot', 'started', 'confirmed', 'sandbox-stop', 'confirmed', 'operational-recovery'],
  );
  assert.notEqual(record.controllerRunId, crashedExecution.timing!.origin, 'the old run measured it; THIS run incorporated the evidence explicitly');
  assert.equal(crashedExecution.timing!.duration!.kind, 'lower-bound', 'the lost duration is never zero');
  assert.deepEqual([work.pendingRecovery!.waitSeconds, work.pendingRecovery!.attempt], [5, 0]);
  const status = (await h.control.inspect({ kind: 'status' })) as ControlStatus;
  assert.deepEqual([status.dispatch, status.recovery!.reconciled, status.recovery!.ceased, status.recovery!.unconfirmed], ['open', 1, 1, 0]);
  // The persisted wait holds: polling rounds and restarts do not anticipate it.
  for (let round = 0; round < 3; round++) {
    h.time.advance();
    await h.time.sleeping();
  }
  work = await h.work();
  assert.ok(work.dispatch.reasons.includes('RECOVERY_BACKOFF'));
  assert.equal(h.doubles.calls('activate').length, 1, 'only the crashed activation so far');
  h.doubles.jumpCalendar(60000);
  await h.until(
    async () => (await h.work()).execution?.slot.held === false && (await h.work()).execution?.executionId !== crashedExecution.executionId,
    'recovery Execution ended',
  );
  work = await h.work();
  const recovery = work.execution!;
  assert.deepEqual(
    [recovery.interruption, recovery.charge!.kind, recovery.charge!.state, work.budget!.recoveries.consumed],
    [{ previousExecutionId: crashedExecution.executionId, reason: 'OPERATIONAL_RECOVERY', code: 'CONTROLLER_CRASH' }, 'recovery', 'consumed', 1],
  );
  const activations = h.doubles.calls('activate');
  assert.equal(activations.length, 2);
  assert.equal((activations[1]!.detail as { bootActive: boolean }).bootActive, true);
  assert.notEqual((activations[1]!.detail as { boot: string }).boot, survivor, 'a NEW boot, never the survivor (not adopted)');
  assert.equal(readHost(dir).boots[survivor], 'stopped', 'the survivor ceased before the substitute started');
  const prompt = h.doubles.prompts.at(-1)!;
  assert.equal(prompt.phaseId, 'builder-recovery');
  assert.match(prompt.prompt, /never repeat a tool call blindly/);
  assert.match(prompt.prompt, new RegExp(`previous-execution=${crashedExecution.executionId}`));
  assert.ok(
    h.doubles.calls('prepare').at(-1)!.detail && (h.doubles.calls('prepare').at(-1)!.detail as { reused: boolean }).reused,
    'the preserved environment/checkout is reused',
  );
  assert.deepEqual(
    [recovery.request.branch, recovery.request.baseCommit],
    [crashedExecution.request.branch, crashedExecution.request.baseCommit],
    'context preserved',
  );
  // AC4: a late start message of the OLD Execution (old opening) never changes the current reservation or charge.
  const consumed = work.budget!.recoveries.consumed;
  assert.deepEqual(await h.halt(), { kind: 'clean' });
  const store = await openStore(join(dir, 'control.sqlite'));
  try {
    assert.equal(
      await confirmStart(store.session, work.work_id, crashedExecution.executionId, {
        workId: work.work_id,
        id: crashedExecution.start!.receiptId,
        executionId: crashedExecution.executionId,
        invocationId: crashedExecution.invocationId,
      }),
      'stale',
    );
  } finally {
    await store.close();
  }
  const again = await reopen(t, dir, []);
  assert.equal((await again.work()).budget!.recoveries.consumed, consumed, 'restart/replay never re-charges');
  assert.equal(again.doubles.calls('activate').length, 2, 'a restart after the settled recovery launches nothing');
});

test('AC3 receipt cut: a complete synchronized receipt without its notification confirms the start and consumes the recovery exactly once', async t => {
  const dir = await scratch(t);
  await crash(dir, 'receipt');
  // The child moved its doubled calendar past the first wait; the reopened owner starts from the real calendar again.
  updateHost(dir, state => {
    state.calendarOffsetMs = 0;
  });
  const h = await reopen(t, dir, []);
  const work = await h.work();
  const execution = work.execution!;
  const receipt = readHost(dir)
    .log.filter(item => item.kind === 'receipt')
    .at(-1)!.detail as { id: string };
  assert.deepEqual([execution.start?.receiptId, execution.recovery![0]!.start.detail], [receipt.id, `receipt-discovered:${receipt.id}`]);
  assert.deepEqual(
    [execution.charge!.kind, execution.charge!.state, work.budget!.recoveries.consumed, work.budget!.recoveries.reserved],
    ['recovery', 'consumed', 1, null],
    'single consumption, incorporated once',
  );
  assert.ok(work.history.some(item => item.event === 'execution-started' && 'detail' in item && item.detail === `${receipt.id}:receipt-discovered`));
  assert.deepEqual([work.pendingRecovery!.attempt, work.pendingRecovery!.waitSeconds], [1, 15], 'the next recovery waits 15 s (one already consumed)');
  assert.ok(kinds(dir).lastIndexOf('stop') > kinds(dir).lastIndexOf('receipt'), 'cessation was established before the receipt was trusted');
});

test('AC3 spawn cut: an activation request whose worker never wrote a receipt is a proven non-start only after host cessation; nothing is consumed and no duplicate writer runs', async t => {
  const dir = await scratch(t);
  await crash(dir, 'spawn');
  const survivor = Object.entries(readHost(dir).boots).find(([, state]) => state === 'active')![0];
  const h = await reopen(t, dir, [{ kind: 'complete' }]);
  await h.until(async () => h.doubles.calls('activate').length === 2 && (await h.work()).execution?.slot.held === false, 'requeued attempt ended');
  const work = await h.work();
  const first = work.previousExecutions[0]!;
  assert.deepEqual(
    [first.state, first.start, first.recovery![0]!.start, first.recovery![0]!.decision],
    ['released', null, { kind: 'not-started', detail: 'receipt-absent-after-cessation' }, 'requeued'],
  );
  assert.equal(work.budget!.recoveries.consumed, 0);
  assert.equal(work.execution!.charge!.kind, 'none', 'the requeued attempt is the same initial implementation, not a recovery');
  const log = readHost(dir).log;
  assert.ok(
    log.findIndex(item => item.kind === 'stop' && (item.detail as { boot: string }).boot === survivor) < log.findLastIndex(item => item.kind === 'activate'),
    'the survivor ceased before the substitute was activated (never two writers)',
  );
});

test('AC3 reservation cut: interrupted before any start request — nothing to cease, reservation released, the Work keeps its queue position', async t => {
  const dir = await scratch(t);
  await crash(dir, 'reservation');
  const h = await reopen(t, dir, [{ kind: 'complete' }]);
  await h.until(async () => h.doubles.calls('activate').length === 1 && (await h.work()).execution?.slot.held === false, 'requeued attempt ended');
  const first = (await h.work()).previousExecutions[0]!;
  assert.deepEqual(
    [first.state, first.recovery![0]!.cessation.basis, first.recovery![0]!.start.detail],
    ['released', 'preparation:no-environment', 'no-activation-request'],
  );
  const log = readHost(dir).log;
  assert.equal(
    log.findIndex(item => item.kind === 'stop'),
    log.findLastIndex(item => item.kind === 'stop'),
    "only the requeued attempt's own end stops a boot",
  );
  assert.ok(
    log.findIndex(item => item.kind === 'stop') > log.findIndex(item => item.kind === 'activate'),
    'no boot existed at reconciliation: nothing was stopped then',
  );
});

test('AC5 local uncertainty: a Work whose survivor cessation is unconfirmed keeps its Slot/reservation and is blocked; the independent one proceeds with the remaining capacity', async t => {
  const dir = await scratch(t);
  await crash(dir, 'two');
  // The boot of Ticket #3 is stuck (its unit never confirms cessation); #4's stops normally.
  const h0 = readHost(dir);
  const store = await openStore(join(dir, 'control.sqlite'));
  let stuckBoot: string;
  try {
    const { readWorks } = await import('../../src/control/durable/admission.js');
    stuckBoot = (await readWorks(store.session)).find(item => item.ticket.number === 3)!.execution!.dispatch.boot!;
  } finally {
    await store.close();
  }
  updateHost(dir, state => {
    state.stuck.push(stuckBoot);
  });
  assert.equal(Object.values(h0.boots).filter(state => state === 'active').length, 2);
  const h = await reopen(t, dir, [{ kind: 'complete' }], { capacity: 2, issues: [3, 4] });
  const status = (await h.control.inspect({ kind: 'status' })) as ControlStatus;
  assert.deepEqual([status.dispatch, status.slots.held, status.recovery!.unconfirmed, status.recovery!.ceased], ['open', 1, 1, 1]);
  const blocked = await h.work(3);
  assert.deepEqual(
    [blocked.execution!.state, blocked.execution!.slot.held, blocked.impediments.map(item => item.code)],
    ['held', true, ['RECOVERY_CESSATION_UNCONFIRMED']],
  );
  assert.equal(blocked.execution!.recovery![0]!.decision, 'kept');
  h.doubles.jumpCalendar(60000);
  await h.until(async () => h.doubles.calls('activate').length === 3 && (await h.work(4)).execution?.slot.held === false, 'independent recovery ended');
  assert.equal((await h.work(3)).execution!.executionId, blocked.execution!.executionId, 'no substitute for the uncertain Work');
});

test('AC4/AC3 question cut: a Question recorded before the crash binds the end (no recovery charge); the Work waits for its answer', async t => {
  const dir = await scratch(t);
  await crash(dir, 'question');
  const h = await reopen(t, dir, []);
  const work = await h.work();
  assert.deepEqual(
    [work.execution!.end!.outcome, work.execution!.end!.questionId, work.pendingRecovery, work.execution!.recovery![0]!.decision],
    ['question', '0b9c6a52-3d3e-4c8f-9a51-000000000026', null, 'settled'],
  );
  assert.ok(work.impediments.some(item => item.code === 'QUESTION_PENDING'));
});

const listed = (environments: { environment: string; workId: string }[], cache: RuntimeInventory['cache'] = []): RuntimeInventory => ({
  kind: 'listed',
  observedAt: new Date().toISOString(),
  environments,
  cache,
  unknown: [],
});
async function crashedWorkId(dir: string) {
  const { readWorks } = await import('../../src/control/durable/admission.js');
  const store = await openStore(join(dir, 'control.sqlite'));
  try {
    return (await readWorks(store.session))[0]!.work_id;
  } finally {
    await store.close();
  }
}

test('review MED1/MED3: a preparation in flight is never ASSUMED ceased — an incomplete own environment or a cache left in preparation keeps the Work blocked; a later boot with host evidence lifts the block', async t => {
  const dir = await scratch(t);
  await crash(dir, 'reservation');
  const workId = await crashedWorkId(dir);
  const environment = `env-${createHash('sha256').update(workId).digest('hex')}`;
  // The environment exists but its preparation never completed (the doubled host observes it as indeterminate).
  let h = await reopen(t, dir, [], { inventory: listed([{ environment, workId }]) });
  let work = await h.work();
  assert.deepEqual(
    [work.execution!.state, work.execution!.slot.held, work.execution!.recovery![0]!.cessation.basis, work.execution!.charge!.state],
    ['held', true, 'preparation:observed-indeterminate', 'none'],
  );
  assert.ok(work.impediments.some(item => item.code === 'RECOVERY_CESSATION_UNCONFIRMED'));
  assert.equal(h.doubles.calls('prepare').length, 1, 'nothing new is prepared for it');
  await h.halt();
  // A cache of its repository left in preparation (a git of the dead owner may still run) keeps it blocked too.
  h = await reopen(t, dir, [], { inventory: listed([], [{ repositoryId: 3, state: 'preparing' }]) });
  work = await h.work();
  assert.equal(work.execution!.recovery!.at(-1)!.cessation.basis, 'preparation:git-cache-not-reconciled');
  await h.halt();
  // Host evidence now proves the environment finished preparing (never booted): cessation confirmed, the block is lifted, the Work requeued.
  updateHost(dir, state => {
    if (!state.prepared.includes(environment)) state.prepared.push(environment);
  });
  h = await reopen(t, dir, [{ kind: 'complete' }], { inventory: listed([{ environment, workId }]) });
  await h.until(async () => h.doubles.calls('activate').length === 1 && (await h.work()).execution?.slot.held === false, 'requeued attempt ended');
  work = await h.work();
  const first = work.previousExecutions[0]!;
  assert.deepEqual(
    [first.state, first.recovery!.at(-1)!.cessation.basis, first.recovery!.at(-1)!.decision],
    ['released', 'preparation:never-booted', 'requeued'],
  );
  assert.equal(
    work.impediments.some(item => item.code === 'RECOVERY_CESSATION_UNCONFIRMED'),
    false,
    "lifted by this boot's recorded evidence",
  );
});

test('ticket 13 composition: a crash mid review round — the shared boot (Builder suspended + both reviewers) is stopped once by the host, no reviewer is re-activated or adopted, unfinished reviewers are recorded failed/boot-ceased, and the Work recovers through the queue', async t => {
  const dir = await scratch(t);
  await crash(dir, 'review');
  const boot = Object.entries(readHost(dir).boots).find(([, state]) => state === 'active')![0];
  const before = readHost(dir).log.length;
  const h = await reopen(t, dir, [], { reviews: true });
  const after = readHost(dir).log.slice(before);
  assert.deepEqual(
    after.filter(item => item.kind === 'stop').map(item => (item.detail as { boot: string }).boot),
    [boot],
    'one host stop of the shared boot',
  );
  assert.equal(after.filter(item => item.kind === 'activate-reviewer').length, 0, 'no reviewer re-activated on the survivor');
  const work = await h.work();
  const execution = work.execution!;
  const round = execution.review!.rounds[0]!;
  assert.deepEqual(
    [round.reviewers.standards.state, round.reviewers.standards.cessation, round.reviewers.spec.failure?.code, round.conclusion],
    ['failed', 'boot-ceased', 'EXECUTION_INTERRUPTED', null],
    'never concluded green; nothing delivered',
  );
  assert.ok(round.reasons.includes('EXECUTION_INTERRUPTED'));
  assert.deepEqual(
    [execution.end!.outcome, execution.end!.code, execution.slot.held, work.pendingRecovery!.waitSeconds],
    ['failure', 'CONTROLLER_CRASH', false, 5],
  );
});
