import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { executionClock } from './budget-doubles.js';
import { app, executionDoubles, publishOwn, pushWip, sessionRef, type Activation, type GuestWorkspace, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// v2 ticket 09 (V2-10, V2-12, V2-13, V2-14), flow level: real Control + Pi Durable + temporary SQLite. Doubled: GitHub, the polling clock,
// the MONOTONIC clock of the Execution (the boot clock and the timeout run on it: no real hour passes), a Sandbox that declares NO
// persistent disk and a boot of 3600 s with a 600 s margin, Workers and credentials. Not evidence of a real swap under a real margin,
// of a real interrupted call or of a boot longer than an hour (acceptance, ticket 16).
const main = 'b'.repeat(40), head = 'd'.repeat(40), wip = 'e'.repeat(40);
const margin = 3000_000, half = 300_000, rest = 300_000;

async function harness(t: { after(fn: () => Promise<void>): void }, scripts: (guest: GuestWorkspace) => Script[], options: { timeoutSeconds?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-boot-swap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const github = githubDoubles(remote);
  const queue: Script[] = [];
  const mono = executionClock();
  const execution = executionDoubles(remote, queue, { diskless: true, clock: mono.clock });
  queue.push(...scripts(execution.guest));
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}) }], operators: ['operator-one'], factoryApp: async () => app },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => untilHolds(label, async () => {
    if (predicate(await work())) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  const of = (kind: string) => execution.calls.filter(call => call.kind === kind).map(call => call.detail);
  const activations = () => of('activate') as Activation[];
  const kinds = () => execution.calls.map(call => call.kind).filter(kind => ['prepare', 'start', 'activate', 'gate', 'stop', 'deliver-boot-swap', 'interrupt-calls'].includes(kind));
  const recoveries = async () => { const shown = await control.inspect({ kind: 'show', work_id: (await work())!.work_id }); return 'work' in shown ? shown.work.budget?.recoveries.consumed : undefined; };
  /** The Builder of the current boot is working and the boot clock is armed. */
  const working = (n: number) => settle(`Builder working in boot ${n}`, value => value?.execution?.state === 'started' && activations().length >= n && (value.execution.swaps ?? []).filter(item => item.outcome).length === Math.max(0, of('start').length - 1) && mono.sleepers() > 0);
  return { remote, mono, work, settle, of, activations, kinds, recoveries, working, guest: execution.guest };
}

test('V2-10/V2-13: crossing the margin swaps the boot inside the SAME Execution: notice to the working session, WIP published, gate accepted, cessation confirmed, only then the new boot, and the same session continues with the fixed notice', async t => {
  const h = await harness(t, guest => [{ kind: 'work', head: main, dirty: 2, yields: 'directive' }, { kind: 'publish', publish: pushWip(guest, wip), end: 'success' },
    { kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  await h.working(1);
  const before = (await h.work())!.execution!;
  // Inside the margin nothing is asked of the Builder.
  h.mono.advance(margin - 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.of('deliver-boot-swap'), []);
  h.mono.advance(1000);
  await h.settle('published in the second boot', value => value?.publication?.state === 'published' && value.execution?.end?.cessation === 'confirmed');
  const work = (await h.work())!;
  const execution = work.execution as ExecutionView;
  // The imposed order. Never two boots at once: the stop of the first boot precedes the start of the second.
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'activate', 'deliver-boot-swap', 'activate', 'gate', 'stop', 'start', 'activate', 'activate', 'gate', 'stop']);
  assert.deepEqual(h.of('stop'), ['planned-swap', 'builder execution ended']);
  assert.deepEqual(h.of('start-reason'), ['start', 'planned-swap']);
  const branch = work.branch!;
  assert.deepEqual(h.of('start'), [{ repository: 'acme/project', installationId: scope.installationId, commit: main, branch }, { repository: 'acme/project', installationId: scope.installationId, commit: wip, branch }]);
  // Identity: the same Work, Execution and Slot; only the boot reference (and the Builder activation that continues the session) changed.
  assert.equal(work.previousExecutions.length, 0);
  assert.equal(execution.executionId, before.executionId);
  assert.notEqual(execution.dispatch.boot, before.dispatch.boot);
  assert.equal(execution.slot.reservedAt, before.slot.reservedAt);
  assert.equal(await h.recoveries(), 0, 'a planned swap consumes no operational recovery');
  assert.equal(execution.interruption ?? null, null);
  const [swap] = execution.swaps!;
  assert.deepEqual([execution.swaps!.length, swap!.fromBoot, swap!.interrupted, swap!.yieldedInvocationId, swap!.notice?.status, swap!.outcome?.status, swap!.outcome?.commit, swap!.outcome?.toBoot],
    [1, before.dispatch.boot, false, before.invocationId, 'completed', 'swapped', wip, execution.dispatch.boot]);
  assert.equal(execution.invocationId, swap!.continuation!.invocationId);
  // The swap notice is its own activation of the working session, in the OLD boot, with the one WIP push.
  const [, notice, continued, publication] = h.activations() as [Activation, Activation, Activation, Activation];
  assert.deepEqual([notice.phaseId, (notice.continuation as { session: unknown }).session, notice.handoff], ['builder-swap-notice', sessionRef(1), null]);
  assert.match(notice.prompt, /^Factory notice \(planned boot swap\)/);
  assert.ok(notice.prompt.includes('about 600 seconds'), notice.prompt);
  assert.deepEqual(notice.pushPolicy, { branch, head: main, expected: null, remote: 'https://github.com/acme/project.git', wip: true });
  // The SAME session continues in the new boot, after the fixed new-boot notice.
  assert.deepEqual([continued.phaseId, (continued.continuation as { session: unknown }).session, Boolean(continued.handoff)], ['builder-continuation', sessionRef(2), true]);
  assert.ok(continued.prompt.startsWith('Factory notice (new boot): this environment was RECREATED'), continued.prompt.slice(0, 120));
  assert.ok(continued.prompt.includes(`Starting commit: ${wip} (the tip of ${branch} on origin`));
  assert.match(continued.prompt, /\ncontinue\nFactory continuation of the SAME session after a planned boot swap/);
  assert.equal(publication.executionId, execution.executionId);
  assert.deepEqual([execution.sessionBoot, execution.bootNotice?.previousBoot, execution.bootNotice?.startCommit, execution.bootNotice?.confirmed], [execution.dispatch.boot, before.dispatch.boot, wip, wip]);
  // Each boot is on the Work's record with its reasons.
  assert.deepEqual(work.bootLedger!.map(item => [item.boot, item.begin, item.end]), [[before.dispatch.boot, 'start', 'planned-swap'], [execution.dispatch.boot, 'planned-swap', 'end']]);
  assert.equal(execution.end?.outcome, 'completed');
});

test('V2-13: a call that has not returned with half the margin left is interrupted by the sandbox, and the work in progress is asked for with the time that is left', async t => {
  const h = await harness(t, guest => [{ kind: 'work', head: main, dirty: 1, yields: 'interrupt' }, { kind: 'publish', publish: pushWip(guest, wip), end: 'success' }, { kind: 'work', head: wip, yields: 'never' }]);
  await h.working(1);
  const first = (await h.work())!.execution!;
  h.mono.advance(margin);
  await h.settle('swap asked of the Builder', () => h.of('deliver-boot-swap').length === 1 && h.mono.sleepers() > 0);
  // The call in flight is NOT interrupted when the margin is crossed.
  assert.deepEqual(h.of('interrupt-calls'), []);
  assert.equal(((await h.work())!.execution!.swaps ?? []).length, 0);
  h.mono.advance(half);
  await h.settle('swapped', value => value?.execution?.swaps?.[0]?.outcome?.status === 'swapped');
  assert.deepEqual(h.of('interrupt-calls'), [{ environment: first.dispatch.environment, boot: first.dispatch.boot, invocationId: first.invocationId }]);
  const execution = (await h.work())!.execution!;
  assert.equal(execution.swaps![0]!.interrupted, true);
  const notice = h.activations()[1]!;
  assert.match(notice.prompt, /The call that was running was interrupted/);
  assert.ok(notice.prompt.includes('about 300 seconds'), notice.prompt);
  await h.settle('continued', () => h.activations().length === 3);
  assert.match(h.activations()[2]!.prompt, /A call was interrupted before the swap/);
});

test('a swap request that did not reach the Builder is repeated with half the margin left', async t => {
  const h = await harness(t, guest => [{ kind: 'work', head: main, dirty: 1, yields: 'directive', undelivered: 1 }, { kind: 'publish', publish: pushWip(guest, wip), end: 'success' }, { kind: 'work', head: wip, yields: 'never' }]);
  await h.working(1);
  h.mono.advance(margin);
  await h.settle('first request made', () => h.of('deliver-boot-swap').length === 1 && h.mono.sleepers() > 0);
  assert.equal(((await h.work())!.execution!.swaps ?? []).length, 0);
  h.mono.advance(half);
  await h.settle('swapped', value => value?.execution?.swaps?.[0]?.outcome?.status === 'swapped');
  assert.equal(h.of('deliver-boot-swap').length, 2);
  // The Builder yielded at the repeated request: there was no call left to interrupt.
  assert.equal((await h.work())!.execution!.swaps![0]!.interrupted, false);
});

test('V2-13: when the gate has not accepted by the end of the boot the loss path applies and is recorded as such', async t => {
  const h = await harness(t, () => [{ kind: 'work', head: main, dirty: 1, yields: 'directive' }, { kind: 'work', head: main, dirty: 1, yields: 'never' }]);
  await h.working(1);
  const first = (await h.work())!.execution!;
  h.mono.advance(margin);
  // The swap notice is running and publishes nothing.
  await h.settle('notice running', value => Boolean(value?.execution?.swaps?.[0]?.notice) && h.activations().length === 2 && h.mono.sleepers() > 0);
  h.mono.advance(half);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.of('interrupt-calls'), [], 'the swap notice itself is never interrupted');
  h.mono.advance(rest);
  await h.settle('lost', value => value?.execution?.end?.cessation === 'confirmed');
  const work = (await h.work())!;
  const execution = work.execution!;
  assert.deepEqual([execution.end?.outcome, execution.end?.code, execution.slot.held], ['failure', 'SANDBOX_ENVIRONMENT_ENDED', false]);
  assert.deepEqual([execution.environmentEnd?.boot, execution.environmentEnd?.reason], [first.dispatch.boot, 'BOOT_DURATION_REACHED']);
  assert.deepEqual([execution.swaps![0]!.outcome?.status, execution.swaps![0]!.outcome?.code], ['lost', 'SANDBOX_ENVIRONMENT_ENDED']);
  assert.deepEqual(work.bootLedger!.map(item => [item.boot, item.end, item.endTip.state]), [[first.dispatch.boot, 'loss', 'absent']]);
  // No second boot was started for this Execution; the loss comes back through the queue as an operational recovery (V2-10).
  assert.equal(h.of('start').length, 1);
  assert.ok(work.pendingRecovery, 'the loss opened an operational recovery');
});

test('V2-13 with Operator decision 7: a gate that refuses three times during the swap ends the boot as a loss at once; no new boot of this Execution starts', async t => {
  const nothing = { kind: 'publish' as const, publish: () => {}, end: 'success' as const };
  const h = await harness(t, () => [{ kind: 'work', head: main, dirty: 1, yields: 'directive' }, nothing, nothing, nothing]);
  await h.working(1);
  const first = (await h.work())!.execution!;
  h.mono.advance(margin);
  await h.settle('lost', value => value?.execution?.end?.cessation === 'confirmed');
  const work = (await h.work())!;
  const execution = work.execution!;
  assert.deepEqual([execution.end?.outcome, execution.end?.code, execution.slot.held], ['failure', 'PRESERVATION_GATE_REFUSED', false]);
  assert.deepEqual([execution.swaps![0]!.notice?.status, execution.swaps![0]!.outcome?.status, execution.swaps![0]!.outcome?.code], ['completed', 'lost', 'PRESERVATION_GATE_REFUSED']);
  // The notice went to the working session; the two corrections of the gate went to the preservation session (ticket 07).
  assert.deepEqual(h.activations().map(item => item.phaseId), ['builder-initial', 'builder-swap-notice', 'builder-preservation', 'builder-preservation']);
  assert.deepEqual([h.of('start').length, h.of('stop')], [1, ['loss']]);
  // The loss is on the Work's record (ticket 12) and in the ledger of boots (V2-14); a substitute comes back through the queue.
  assert.deepEqual(work.losses?.map(item => [item.boot, item.executionId]), [[first.dispatch.boot, first.executionId]]);
  assert.deepEqual(work.bootLedger!.map(item => [item.boot, item.end]), [[first.dispatch.boot, 'loss']]);
  assert.ok(work.pendingRecovery);
});

test('V2-14: two boots in a row that publish no new commit block the Work with "sem progresso entre boots" instead of a third boot without progress', async t => {
  const h = await harness(t, guest => [{ kind: 'work', head: main, dirty: 1, yields: 'directive' }, { kind: 'publish', publish: pushWip(guest, wip), end: 'success' },
    { kind: 'work', head: wip, yields: 'directive' }, { kind: 'publish', publish: () => {}, end: 'success' },
    { kind: 'work', head: wip, yields: 'directive' }, { kind: 'publish', publish: () => {}, end: 'success' }]);
  // Boot 1 publishes a commit; boots 2 and 3 publish nothing.
  for (const n of [1, 2]) {
    await h.working(2 * n - 1);
    h.mono.advance(margin);
    await h.settle(`swap ${n}`, value => value?.execution?.swaps?.[n - 1]?.outcome?.status === 'swapped');
  }
  await h.working(5);
  h.mono.advance(margin);
  await h.settle('blocked', value => value?.impediments.some(item => item.code === 'NO_PROGRESS_BETWEEN_BOOTS'));
  await h.settle('slot released', value => value?.execution?.slot.held === false);
  const work = (await h.work())!;
  const execution = work.execution!;
  assert.equal(h.of('start').length, 3, 'no fourth boot');
  assert.equal(h.of('stop').at(-1), 'planned-swap');
  assert.deepEqual(work.bootLedger!.map(item => [item.begin, item.end, item.startTip.state === 'present' ? item.startTip.sha : item.startTip.state, item.endTip.state === 'present' ? item.endTip.sha : item.endTip.state]),
    [['start', 'planned-swap', 'absent', wip], ['planned-swap', 'planned-swap', wip, wip], ['planned-swap', 'planned-swap', wip, wip]]);
  const impediment = work.impediments.find(item => item.code === 'NO_PROGRESS_BETWEEN_BOOTS')!;
  assert.match(impediment.nextStep, /sem progresso entre boots/);
  assert.ok(impediment.nextStep.includes(wip));
  assert.deepEqual([execution.end?.outcome, execution.end?.code, execution.end?.cessation, execution.swaps!.map(item => item.outcome?.status)], ['failure', 'NO_PROGRESS_BETWEEN_BOOTS', 'confirmed', ['swapped', 'swapped', 'blocked']]);
  assert.equal(work.previousExecutions.length, 0);
  assert.equal(await h.recoveries(), 0);
  assert.equal(work.pendingRecovery ?? null, null, 'a block is not retried');
});

test('V2-10/V2-12: the Execution timeout clock keeps running across the swap; the boot clock is another limit and starts again with each boot', async t => {
  const h = await harness(t, guest => [{ kind: 'work', head: main, dirty: 1, yields: 'directive' }, { kind: 'publish', publish: pushWip(guest, wip), end: 'success' }, { kind: 'work', head: wip, yields: 'never' }],
    { timeoutSeconds: 4000 });
  await h.working(1);
  h.mono.advance(margin);
  await h.settle('swapped', value => value?.execution?.swaps?.[0]?.outcome?.status === 'swapped');
  await h.working(3);
  // 3000 s of the Execution are gone; the new boot is seconds old. 1000 s later the Execution reaches ITS limit, far inside the boot's.
  h.mono.advance(999_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.work())!.execution!.end ?? null, null);
  assert.deepEqual(h.of('deliver-boot-swap').length, 1, 'the new boot is nowhere near its margin');
  h.mono.advance(1000);
  await h.settle('timeout', value => value?.execution?.end?.outcome === 'timeout');
  const execution = (await h.work())!.execution!;
  assert.equal(execution.timing?.duration?.kind === 'measured' && execution.timing.duration.elapsedMs >= 4000_000, true, JSON.stringify(execution.timing));
  assert.deepEqual(h.of('stop'), ['planned-swap', 'execution timeout']);
});
