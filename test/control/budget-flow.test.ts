import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import { requestCorrection, requestRecovery } from '../../src/control/durable/control.js';
import type { Control, ControlReceipt, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { budgetDoubles, type Script } from './budget-doubles.js';

// Flow level (Q11): real Control + Pi Durable + temporary SQLite. Doubled: GitHub tracker, polling/execution clocks and the execution
// boundaries. The correction/recovery triggers are the module-internal seams the repair (22/23) and recovery (26) flows will call.
// NOT evidence of the real VM/worker/model/GitHub.
const qid = (n: number) => `0b9c6a52-3d3e-4c8f-9a51-${String(n).padStart(12, '0')}`;
type Limits = { correctionLimit?: number; recoveryLimit?: number };

async function harness(t: { after(fn: () => Promise<void>): void }, scripts: Script[], options: { cessation?: boolean; onPrepare?: () => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  const execution = budgetDoubles(scripts, { ...options, onPrepare: async () => { await options.onPrepare?.(); } });
  async function start(limits: Limits = {}) {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: execution.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...limits }], operators: ['operator-one'] },
      polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
    return current;
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0]!;
  const show = async (work_id: string) => await current!.control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  const settle = async (predicate: () => Promise<boolean>, label = 'condition') => {
    for (let i = 0; i < 600; i++) {
      if (await predicate()) return;
      if (current!.time.isSleeping()) current!.time.advance();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`${label} not reached`);
  };
  const cycles = async (n: number) => { for (let i = 0; i < n; i++) { current!.time.advance(); await current!.time.sleeping(); } };
  const idle = async () => settle(async () => { const w = await work(); return w?.execution !== null && w.execution!.slot.held === false; }, 'execution ended and Slot released');
  return { github, execution, start, stop, work, show, settle, cycles, idle, storagePath, control: () => current!.control };
}
const grant = (control: Control, request_id: string, work_id: string, counter: 'corrections' | 'recoveries', amount: number) =>
  control.accept({ request_id, operation: 'grant', work_id, counter, amount, origin: 'local-cli' }) as Promise<ControlReceipt | { kind: 'refused'; code: string }>;
const budgetEvents = (work: WorkView) => work.history.filter(item => item.event.startsWith('budget-')).map(item => [item.event, 'detail' in item ? item.detail : null]);

test('AC1: configured limits are snapshotted at admission; the initial implementation charges nothing; a correction reserves in the admission commit and is consumed once at the confirmed start', async t => {
  let atPrepare: WorkView | undefined;
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness(t, [{ kind: 'complete' }, { kind: 'complete' }], { onPrepare: async () => { atPrepare = await h.work(); } });
  await h.start({ correctionLimit: 2, recoveryLimit: 1 });
  await h.idle();
  let work = await h.work();
  assert.deepEqual([work.budget!.corrections, work.budget!.recoveries], [{ limit: 2, granted: 0, consumed: 0, reserved: null }, { limit: 1, granted: 0, consumed: 0, reserved: null }]);
  assert.equal(work.budget!.source.repository, 'acme/project');
  assert.deepEqual(work.execution!.charge, { kind: 'none', correctionId: null, counter: null, state: 'none', settledAt: null }, 'the initial implementation is not a correction');
  assert.deepEqual(budgetEvents(work), []);
  // A correction (seam of the repair flows): the next activation reserves it in the SAME commit that admits the Execution.
  assert.equal(await requestCorrection(h.control(), work.work_id, 'synthetic required check failed'), 'opened');
  await h.settle(async () => h.execution.activations().length === 2, 'correction activation');
  await h.idle();
  assert.deepEqual([atPrepare!.execution!.charge!.state, atPrepare!.budget!.corrections.reserved], ['reserved', atPrepare!.execution!.executionId],
    'reservation committed before any external effect (observed at prepare)');
  assert.equal(atPrepare!.budget!.corrections.consumed, 0, 'reservation is not consumption');
  work = await h.work();
  assert.deepEqual(work.budget!.corrections, { limit: 2, granted: 0, consumed: 1, reserved: null });
  assert.deepEqual([work.execution!.charge!.kind, work.execution!.charge!.state, work.execution!.charge!.correctionId], ['correction', 'consumed', work.correction!.correctionId]);
  assert.equal(work.correction!.consumed, true);
  assert.deepEqual(budgetEvents(work), [['budget-reserved', 'corrections'], ['budget-consumed', 'corrections']], 'charged once: not per event, test, push or renewal');
  assert.deepEqual([work.limits.corrections!.available, work.limits.corrections!.effectiveLimit, work.limits.recoveries!.available], [1, 2, 1]);
  // Repeated polling rounds never charge again nor relaunch.
  await h.cycles(3);
  assert.deepEqual((await h.work()).budget!.corrections.consumed, 1);
  assert.equal(h.execution.activations().length, 2);
});

test('AC2: proven non-start releases the reservation without consumption; an uncertain start keeps it (and it counts against the limit)', async t => {
  let pauseOnce = true;
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness(t, [{ kind: 'complete' }, { kind: 'complete' }, { kind: 'launch-uncertain' }], { onPrepare: async () => {
    // The pause committed during the correction's preparation refuses its activation before any worker request (own boot ceased).
    if (pauseOnce && (await h.work()).correction) { pauseOnce = false; await h.control().accept({ request_id: 'pause-1', operation: 'pause', origin: 'local-cli' }); }
  } });
  await h.start({ correctionLimit: 2 });
  await h.idle();
  const work_id = (await h.work()).work_id;
  await requestCorrection(h.control(), work_id, 'first correction');
  await h.settle(async () => (await h.work()).execution?.state === 'released', 'refused before start');
  let work = await h.work();
  assert.equal(h.execution.activations().length, 1, 'never activated');
  assert.deepEqual([work.execution!.charge!.state, work.budget!.corrections.reserved, work.budget!.corrections.consumed], ['released', null, 0]);
  assert.deepEqual(budgetEvents(work), [['budget-reserved', 'corrections'], ['budget-released', 'corrections']]);
  assert.equal(work.correction!.consumed, false, 'the correction stays pending with its identity');
  const correctionId = work.correction!.correctionId;
  await h.control().accept({ request_id: 'unpause-1', operation: 'unpause', origin: 'local-cli' });
  await h.settle(async () => h.execution.activations().length === 2, 'reactivated after unpause');
  await h.idle();
  work = await h.work();
  assert.deepEqual([work.budget!.corrections.consumed, work.execution!.charge!.correctionId], [1, correctionId], 'same correction identity, consumed once');
  // Second correction: the activation outcome is uncertain (may have launched) -> held, reservation KEPT (no proof of non-start).
  await requestCorrection(h.control(), work_id, 'second correction');
  await h.settle(async () => (await h.work()).execution?.state === 'held', 'uncertain activation held');
  work = await h.work();
  assert.deepEqual([work.execution!.charge!.state, work.budget!.corrections.reserved, work.budget!.corrections.consumed], ['reserved', work.execution!.executionId, 1]);
  assert.deepEqual([work.limits.corrections!.reserved, work.limits.corrections!.available, work.limits.corrections!.exhausted], [1, 0, true], 'an uncertain reservation still occupies the budget');
  await h.cycles(3);
  assert.equal(h.execution.activations().length, 3, 'no substitute launched blindly');
});

test('AC2: a question/answer continuation preserves the correction identity and its single charge; configuration change and restart never erase exhaustion', async t => {
  const h = await harness(t, [{ kind: 'complete' }, { kind: 'ask', questionId: qid(1), question: 'Which check matters?' }, { kind: 'complete' }]);
  await h.start({ correctionLimit: 1 });
  await h.idle();
  const work_id = (await h.work()).work_id;
  await requestCorrection(h.control(), work_id, 'only correction');
  await h.settle(async () => (await h.work()).execution?.end?.outcome === 'question' && (await h.work()).execution?.slot.held === false, 'question wait');
  const asked = await h.work();
  const correctionId = asked.correction!.correctionId;
  assert.deepEqual(asked.budget!.corrections, { limit: 1, granted: 0, consumed: 1, reserved: null });
  await h.control().accept({ request_id: 'answer-1', operation: 'answer', question_id: qid(1), text: 'The build check.', origin: 'local-cli' });
  await h.settle(async () => h.execution.activations().length === 3, 'continuation');
  await h.idle();
  const continued = await h.work();
  assert.deepEqual([continued.execution!.mode, continued.execution!.charge!.state, continued.execution!.charge!.correctionId], ['recovery', 'preserved', correctionId],
    'continuation of the SAME correction: identity and charge preserved, nothing new reserved');
  assert.deepEqual(continued.budget!.corrections, { limit: 1, granted: 0, consumed: 1, reserved: null }, 'question/continuation never charge twice, even at the limit');
  assert.deepEqual(continued.budget!.recoveries.consumed, 0, 'a question continuation is not an operational recovery');
  // A later correction finds the budget exhausted: durable impediment, no activation, no loop.
  assert.equal(await requestCorrection(h.control(), work_id, 'another correction'), 'opened');
  await h.cycles(4);
  let work = await h.work();
  assert.ok(work.impediments.some(item => item.code === 'CORRECTION_LIMIT_REACHED' && /factory grant .* --corrections <n>/.test(item.nextStep)));
  assert.equal(h.execution.activations().length, 3);
  assert.equal(budgetEvents(work).filter(([event]) => event === 'budget-exhausted').length, 1, 'recorded once, not per polling round');
  assert.deepEqual(work.dispatch.reasons, ['CORRECTION_LIMIT_REACHED']);
  // Restart with a larger configured limit: the Work keeps its snapshot and its exhaustion (configuration is not a grant).
  await h.stop();
  await h.start({ correctionLimit: 5 });
  await h.cycles(3);
  work = await h.work();
  assert.deepEqual([work.budget!.corrections.limit, work.budget!.corrections.consumed], [1, 1]);
  assert.ok(work.impediments.some(item => item.code === 'CORRECTION_LIMIT_REACHED'));
  assert.equal(h.execution.activations().length, 3, 'neither restart nor YAML change relaunches');
});

test('AC3: an explicit grant through the authorized ingress adds capacity with history, never resets counters, is idempotent per request, and re-enters only through the queue', async t => {
  const h = await harness(t, [{ kind: 'complete' }, { kind: 'complete' }, { kind: 'complete' }]);
  await h.start({ correctionLimit: 1, recoveryLimit: 0 });
  await h.idle();
  const work_id = (await h.work()).work_id;
  await requestCorrection(h.control(), work_id, 'c1');
  await h.settle(async () => h.execution.activations().length === 2);
  await h.idle();
  await requestCorrection(h.control(), work_id, 'c2');
  await h.cycles(2);
  assert.ok((await h.work()).impediments.some(item => item.code === 'CORRECTION_LIMIT_REACHED'));
  // Invalid amounts or counters never reach the authority; unknown Works are a durable not-applied result.
  for (const amount of [0, -1, 1.5, 1000]) assert.deepEqual(await grant(h.control(), `bad-${String(amount).replace(/\W/g, '')}`, work_id, 'corrections', amount), { kind: 'refused', code: 'INVALID_COMMAND' });
  const missing = await grant(h.control(), 'grant-missing', '6f0c7a52-3d3e-4c8f-9a51-000000000001', 'corrections', 1) as Extract<ControlReceipt, { operation: 'grant' }>;
  assert.deepEqual([missing.outcome, missing.reason], ['not-applied', 'WORK_NOT_FOUND']);
  const before = h.execution.activations().length;
  const receipt = await grant(h.control(), 'grant-1', work_id, 'corrections', 2) as Extract<ControlReceipt, { operation: 'grant' }>;
  assert.deepEqual([receipt.kind, receipt.operation, receipt.outcome, receipt.counter, receipt.amount], ['durable', 'grant', 'accepted', 'corrections', 2]);
  assert.deepEqual(receipt.budget, { limit: 1, granted: 2, effectiveLimit: 3, consumed: 1, reserved: 0, reservedBy: null, available: 2, exhausted: false });
  assert.equal(h.execution.activations().length, before, 'accept never spawns');
  assert.deepEqual(await grant(h.control(), 'grant-1', work_id, 'corrections', 2), receipt, 'same identity and content: the known receipt, not a second grant');
  assert.deepEqual(await grant(h.control(), 'grant-1', work_id, 'corrections', 3), { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  let work = await h.work();
  assert.deepEqual(work.budget!.corrections, { limit: 1, granted: 2, consumed: 1, reserved: null }, 'counters kept; only the grant is added');
  assert.deepEqual(work.budget!.grants.map(item => [item.request_id, item.counter, item.amount, item.before.granted, item.after.granted]), [['grant-1', 'corrections', 2, 0, 2]]);
  assert.equal(work.impediments.some(item => item.code === 'CORRECTION_LIMIT_REACHED'), false, 'only the exhaustion impediment it resolves is removed');
  assert.ok(work.history.some(item => item.event === 'budget-granted' && item.origin === 'local-cli'));
  // The pending correction now proceeds through the normal queue (revalidated), consuming the granted capacity once.
  await h.settle(async () => h.execution.activations().length === before + 1, 'queued activation after grant');
  await h.idle();
  work = await h.work();
  assert.deepEqual([work.budget!.corrections.consumed, work.limits.corrections!.available], [2, 1]);
  // Recoveries are a separate counter (limit 0 here): exhaustion there never touches corrections; grant --recoveries is explicit too.
  assert.equal(await requestRecovery(h.control(), work_id, 'synthetic transient worker failure'), 'requested');
  await h.cycles(2);
  work = await h.work();
  assert.ok(work.impediments.some(item => item.code === 'RECOVERY_LIMIT_REACHED' && /--recoveries <n>/.test(item.nextStep)));
  assert.equal(h.execution.activations().length, before + 1);
  await grant(h.control(), 'grant-r1', work_id, 'recoveries', 1);
  await h.settle(async () => h.execution.activations().length === before + 2, 'recovery activation');
  await h.idle();
  work = await h.work();
  assert.deepEqual([work.budget!.recoveries, work.budget!.corrections.consumed, work.execution!.charge!.kind, work.pendingRecovery],
    [{ limit: 0, granted: 1, consumed: 1, reserved: null }, 2, 'recovery', null], 'a recovery consumes a recovery, never a correction');
  const shown = await h.show(work_id);
  assert.deepEqual([shown.work.limits.grants, shown.work.limits.recoveries!.exhausted], [2, true]);
});
