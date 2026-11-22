import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilHolds } from '../runner/budget.js';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlInput, HistoryView, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { recoveryDoubles } from './recovery-doubles.js';

// Ticket 50 flow level (S): real Control + Pi Durable/SQLite + Records with the file-backed Sandbox host double of ticket 26. The Sandbox
// REFUSES a boot or a preparation (the codes of pilot 35: memory at boot, preserved disk check, seed conflict) exactly once. Doubled: Sandbox
// host, Builder, credentials, GitHub. Not evidence of a VM, of host memory, of a disk or of a model.
type Refusal = { status: 'failure' | 'indeterminate'; code: string; detail?: string };

async function harness(
  t: { after(fn: () => Promise<void>): void },
  refusals: { prepare?: Refusal[]; start?: Refusal[] },
  startReport?: (input: { diskRemedy?: string }) => Record<string, unknown>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-retry50-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  const prepare = [...(refusals.prepare ?? [])],
    start = [...(refusals.start ?? [])];
  const doubles = recoveryDoubles(dir, [], {
    prepareRefusal: () => prepare.shift(),
    startRefusal: () => start.shift(),
    ...(startReport ? { startReport } : {}),
  });
  let current!: { control: Control; stop: AbortController; running: Promise<unknown>; time: ReturnType<typeof manualClock> };
  async function open() {
    const time = manualClock();
    const control: Control = await openControl({
      storagePath: join(dir, 'control.sqlite'),
      runtimeInventory: 'empty',
      execution: doubles.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
      polling: { intervalSeconds: 60, clock: time.clock },
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  /** Stops the owner (as a controller restart of the pilot) and opens a new one on the same storage: boot reconciliation runs. */
  async function restart() {
    current.stop.abort();
    await current.running;
    await open();
  }
  await open();
  t.after(async () => {
    current.stop.abort();
    await current.running;
  });
  const control = {
    inspect: (query: Parameters<Control['inspect']>[0]) => current.control.inspect(query),
    accept: (input: ControlInput) => current.control.accept(input),
  };
  const time = { isSleeping: () => current.time.isSleeping(), advance: () => current.time.advance() };
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView;
  const show = async (work_id: string) => (await control.inspect({ kind: 'show', work_id })) as Extract<ShowView, { kind: 'work' }>;
  const until = (predicate: () => Promise<boolean> | boolean, label: string) =>
    untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (time.isSleeping()) time.advance();
        return false;
      },
      5,
    );
  const accept = (input: ControlInput) => control.accept(input);
  const retry = (work_id: string, code: string, request_id: string, remedy?: 'recreate-artifact-seed' | 'repair-disk' | 'replace-disk') =>
    accept({ request_id, operation: 'resume', work_id, retry_blocked_start: code, ...(remedy ? { remedy } : {}), origin: 'local-cli' });
  const blocked = async () => {
    await until(async () => (await work())?.impediments.some(item => item.code === 'RECOVERY_BLOCKED') ?? false, 'blocked');
    return work();
  };
  return { control, doubles, work, show, until, accept, retry, blocked, restart };
}
const outcome = (receipt: unknown) => {
  const value = receipt as { outcome?: string; reason?: string | null };
  return [value.outcome, value.reason];
};

test('AC1: lack of memory at boot returns the Work to its queue behind a capacity wait, Slot freed, nothing charged, then it starts', async t => {
  const h = await harness(t, { start: [{ status: 'failure', code: 'INSUFFICIENT_MEMORY_FOR_BOOT' }] });
  await h.until(async () => Boolean((await h.work())?.bootDeferral), 'capacity wait');
  let work = await h.work();
  const refused = work.execution!;
  assert.deepEqual(
    [refused.state, refused.start, refused.slot.held, refused.held!.code, refused.charge?.state === 'consumed'],
    ['released', null, false, 'START_INSUFFICIENT_MEMORY_FOR_BOOT', false],
    'proven non-start: Slot freed, nothing consumed',
  );
  assert.deepEqual(
    [work.bootDeferral!.code, work.bootDeferral!.waitSeconds, work.bootDeferral!.attempt, work.queue.pending],
    ['START_INSUFFICIENT_MEMORY_FOR_BOOT', 15, 0, true],
  );
  assert.equal(
    work.impediments.some(item => item.code === 'RECOVERY_BLOCKED'),
    false,
    'never blocked',
  );
  assert.deepEqual([work.pendingRecovery, work.budget!.recoveries.consumed], [null, 0], 'no recovery is requested or charged when nothing started');
  assert.ok(work.dispatch.reasons.includes('BOOT_CAPACITY_WAIT'), 'the wait is visible');
  assert.deepEqual(
    refused.recovery!.map(item => [item.trigger, item.decision, item.cessation.result]),
    [['start-refused', 'requeued', 'confirmed']],
  );
  assert.ok(work.history.some(item => item.event === 'boot-deferred'));
  assert.equal(h.doubles.calls('start-refused').length, 1);
  h.doubles.jumpCalendar(20_000);
  await h.until(async () => (await h.work()).execution?.end?.outcome === 'completed', 'started after the wait');
  work = await h.work();
  assert.deepEqual(
    [h.doubles.calls('activate').length, work.bootDeferral, work.budget!.recoveries.consumed, work.execution!.charge?.kind ?? 'none'],
    [1, null, 0, 'none'],
    'one activation; the wait ended with the operational boot; no recovery unit',
  );
});

test('AC2: another boot refusal blocks at once (Slot freed); only the exact code is retried, audited and deduplicated, through ONE operational recovery', async t => {
  const code = 'START_PRESERVED_DISK_CHECK_REQUIRED';
  const h = await harness(t, { start: [{ status: 'failure', code: 'PRESERVED_DISK_CHECK_REQUIRED' }] });
  const work = await h.blocked();
  const execution = work.execution!;
  assert.deepEqual(
    [execution.state, execution.slot.held, execution.blockedStart!.code, execution.blockedStart!.cessation, execution.blockedStart!.retry],
    ['released', false, code, 'confirmed', null],
    'cessation confirmed by the returned refusal; no controller restart needed',
  );
  const action = (await h.show(work.work_id)).work.limits.actions.find(item => item.code === 'RECOVERY_BLOCKED')!;
  assert.ok(action.nextStep.includes(`factory resume ${work.work_id} --retry-blocked-start ${code} --request-id <id>`), action.nextStep);

  assert.deepEqual(outcome(await h.accept({ request_id: 'r50-plain', operation: 'resume', work_id: work.work_id, origin: 'local-cli' })), [
    'not-applied',
    'NOTHING_TO_RESUME',
  ]);
  assert.deepEqual(outcome(await h.retry(work.work_id, 'START_GUEST_ASSETS_INVALID', 'r50-wrong')), ['not-applied', 'BLOCKED_CODE_MISMATCH']);
  assert.deepEqual(outcome(await h.retry(work.work_id, code, 'r50-remedy', 'recreate-artifact-seed')), ['not-applied', 'REMEDY_NOT_APPLICABLE']);
  assert.deepEqual(outcome(await h.retry('11111111-2222-4333-8444-555555555555', code, 'r50-unknown')), ['not-applied', 'WORK_NOT_FOUND']);
  assert.equal((await h.work()).pendingRecovery, null, 'refusals change nothing');

  const receipt = await h.retry(work.work_id, code, 'r50-accept');
  assert.deepEqual(receipt, {
    kind: 'durable',
    request_id: 'r50-accept',
    operation: 'resume',
    work_id: work.work_id,
    outcome: 'accepted',
    reason: null,
    created: null,
  });
  assert.deepEqual(await h.retry(work.work_id, code, 'r50-accept'), receipt, 'replay returns the recorded receipt');
  assert.deepEqual(await h.retry(work.work_id, 'START_GUEST_ASSETS_INVALID', 'r50-accept'), { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual(outcome(await h.retry(work.work_id, code, 'r50-again')), ['already-satisfied', 'BLOCKED_START_ALREADY_RETRIED']);

  let after = await h.work();
  const decision = after.execution!.blockedStart!.retry!;
  assert.deepEqual(
    [decision.request_id, decision.operator, decision.code, decision.remedy, decision.recoveryRequest],
    ['r50-accept', { kind: 'local-administrator' }, code, null, 'requested'],
  );
  assert.equal(
    after.impediments.some(item => item.code === 'RECOVERY_BLOCKED'),
    false,
  );
  assert.deepEqual([after.pendingRecovery!.waitSeconds, after.pendingRecovery!.reason, after.queue.pending], [5, `operator-retry:${code}`, true]);
  assert.deepEqual(
    after.history.filter(item => item.event === 'blocked-start-retried').map(item => ('detail' in item ? item.detail : null)),
    [`r50-accept:${code}`],
  );
  assert.equal(h.doubles.calls('activate').length, 0, 'accepting launches nothing; the persisted wait still runs');

  h.doubles.jumpCalendar(60_000);
  await h.until(async () => (await h.work()).execution?.end?.outcome === 'completed', 'recovery ran');
  after = await h.work();
  assert.deepEqual(
    [h.doubles.calls('start').length, after.execution!.charge!.kind, after.budget!.recoveries.consumed, after.pendingRecovery],
    [1, 'recovery', 1, null],
    'the Work came back through the ordinary operational recovery (one unit)',
  );

  // Ticket 29 inspection: the chain and the Execution's correlated history show the refusal and the decision.
  const chained = (await h.show(work.work_id)).chain.executions.find(item => item.executionId === execution.executionId)!;
  assert.deepEqual([chained.blockedStart!.state, chained.blockedStart!.retry!.request_id], ['retried', 'r50-accept']);
  const history = (await h.control.inspect({ kind: 'history', work_id: work.work_id, execution: execution.executionId, limit: 200 })) as HistoryView;
  assert.equal(history.entries.filter(item => item.entry.event === 'blocked-start-retried').length, 1);
});

test('AC5: a seed conflict shows the divergent file; the operator decision recreates that seed in the next preparation only', async t => {
  const detail = 'factory/skill-pack/factory-skills-v4/skills/tdd/SKILL.md';
  const code = 'PREPARE_ARTIFACT_SEED_VERSION_CONFLICT';
  const h = await harness(t, { prepare: [{ status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT', detail }] });
  const work = await h.blocked();
  assert.deepEqual([work.execution!.held!.detail, work.execution!.blockedStart!.detail, work.execution!.slot.held], [detail, detail, false]);
  const impediment = work.impediments.find(item => item.code === 'RECOVERY_BLOCKED')!;
  assert.ok(impediment.nextStep.includes(detail) && impediment.nextStep.includes('--remedy recreate-artifact-seed'), impediment.nextStep);

  assert.deepEqual(outcome(await h.retry(work.work_id, code, 'r50-seed', 'recreate-artifact-seed')), ['accepted', null]);
  let after = await h.work();
  assert.deepEqual(after.startRemedy && [after.startRemedy.remedy, after.startRemedy.seeds, after.startRemedy.request_id], [
    'recreate-artifact-seed',
    ['factory/skill-pack/factory-skills-v4'],
    'r50-seed',
  ]);
  h.doubles.jumpCalendar(60_000);
  await h.until(async () => (await h.work()).execution?.end?.outcome === 'completed', 'recovery ran');
  after = await h.work();
  const prepares = h.doubles.calls('prepare').map(item => (item.detail as { recreateSeeds: string[] | null }).recreateSeeds);
  assert.deepEqual(prepares, [null, ['factory/skill-pack/factory-skills-v4']], 'only the preparation after the decision recreates the seed');
  assert.equal(after.startRemedy, null, 'the remedy is consumed by that preparation');
  const applied = after.history.filter(item => item.event === 'start-remedy-applied').map(item => ('detail' in item ? item.detail : null));
  assert.deepEqual(applied, [
    'r50-seed:recreate-artifact-seed:factory/skill-pack/factory-skills-v4->factory/skill-pack/factory-skills-v4.divergent-20261119t100000z',
  ]);
});

test('AC2: an indeterminate refusal is never settled live (host evidence first): the hold keeps its Slot and no retry is accepted', async t => {
  const h = await harness(t, { prepare: [{ status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE' }] });
  await h.until(async () => (await h.work())?.execution?.state === 'held', 'held');
  const work = await h.work();
  assert.deepEqual([work.execution!.slot.held, work.execution!.blockedStart ?? null], [true, null]);
  assert.deepEqual(outcome(await h.retry(work.work_id, 'PREPARE_ENVIRONMENT_PREPARATION_INCOMPLETE', 'r50-held')), ['not-applied', 'RECOVERY_NOT_BLOCKED']);
});

test('AC1/AC2 after a restart (pilot 35 state): held refusals of an earlier controller are settled by the boot reconciliation the same way', async t => {
  // `indeterminate` keeps the live hold with its Slot, exactly like every START_/PREPARE_ refusal before this ticket (#124, #126).
  const h = await harness(t, { start: [{ status: 'indeterminate', code: 'INSUFFICIENT_MEMORY_FOR_BOOT' }] });
  await h.until(async () => (await h.work())?.execution?.state === 'held', 'held with its Slot');
  assert.equal((await h.work()).execution!.slot.held, true);
  await h.restart();
  let work = await h.work();
  assert.deepEqual(
    [work.execution!.state, work.execution!.slot.held, work.bootDeferral?.waitSeconds, work.impediments.some(item => item.code === 'RECOVERY_BLOCKED')],
    ['released', false, 15, false],
    'capacity: back to the queue behind its wait, never blocked',
  );
  assert.deepEqual(
    work.execution!.recovery!.map(item => [item.trigger, item.decision]),
    [['boot', 'requeued']],
  );

  const disk = await harness(t, { start: [{ status: 'indeterminate', code: 'PRESERVED_DISK_CHECK_REQUIRED' }] });
  await disk.until(async () => (await disk.work())?.execution?.state === 'held', 'held');
  await disk.restart();
  work = await disk.work();
  assert.deepEqual([work.execution!.blockedStart!.code, work.execution!.blockedStart!.cessation], ['START_PRESERVED_DISK_CHECK_REQUIRED', 'confirmed']);
  assert.deepEqual(outcome(await disk.retry(work.work_id, 'START_PRESERVED_DISK_CHECK_REQUIRED', 'r50-restart')), ['accepted', null]);
});

// Ticket 47: the disk remedies of START_PRESERVED_DISK_CHECK_REQUIRED reuse ticket 50's retry; the remedy is applied by the next BOOT only.
for (const remedy of ['repair-disk', 'replace-disk'] as const) {
  test(`ticket 47: a preserved disk failing its check is resumed by the operator's ${remedy} decision through ONE recovery (no cancel + new)`, async t => {
    const code = 'START_PRESERVED_DISK_CHECK_REQUIRED';
    const previous = 'boot-47474747-2222-4333-8444-555555555555';
    const h = await harness(t, { start: [{ status: 'failure', code: 'PRESERVED_DISK_CHECK_REQUIRED' }] }, input => ({
      previousStop: { boot: previous, result: 'forced', reason: 'NO_GUEST_STOP_RECORD' },
      ...(input.diskRemedy
        ? {
            remedy: {
              remedy: input.diskRemedy,
              outcome: 'applied',
              detail: `original kept as root.qcow2.${input.diskRemedy === 'repair-disk' ? 'damaged' : 'replaced'}-20261119t120000z`,
            },
          }
        : {}),
    }));
    const work = await h.blocked();
    const impediment = work.impediments.find(item => item.code === 'RECOVERY_BLOCKED')!;
    assert.ok(impediment.nextStep.includes('--remedy repair-disk|replace-disk') && impediment.nextStep.includes('e2fsck -p'), impediment.nextStep);
    assert.deepEqual(outcome(await h.retry(work.work_id, 'START_GUEST_ASSETS_INVALID', 'r47-wrong', remedy)), ['not-applied', 'BLOCKED_CODE_MISMATCH']);
    assert.deepEqual(outcome(await h.retry(work.work_id, code, 'r47-disk', remedy)), ['accepted', null]);
    let after = await h.work();
    assert.deepEqual(after.startRemedy && [after.startRemedy.remedy, after.startRemedy.request_id, after.startRemedy.seeds], [remedy, 'r47-disk', []]);
    assert.deepEqual(
      after.history.filter(item => item.event === 'blocked-start-retried').map(item => ('detail' in item ? item.detail : null)),
      [`r47-disk:${code}:${remedy}`],
    );
    h.doubles.jumpCalendar(60_000);
    await h.until(async () => (await h.work()).execution?.end?.outcome === 'completed', 'recovery ran');
    after = await h.work();
    const starts = h.doubles.calls('start').map(item => (item.detail as { diskRemedy: string | null }).diskRemedy);
    const prepares = h.doubles.calls('prepare').map(item => (item.detail as { recreateSeeds: string[] | null }).recreateSeeds);
    assert.deepEqual([starts, prepares], [[remedy], [null, null]], 'only the boot after the decision carries the disk remedy; preparations never do');
    assert.deepEqual(
      [after.startRemedy, after.budget!.recoveries.consumed, after.execution!.charge!.kind],
      [null, 1, 'recovery'],
      'consumed by that boot; one recovery unit',
    );
    const history = after.history
      .filter(item => item.event === 'start-remedy-applied' || item.event === 'previous-boot-stop')
      .map(item => [item.event, 'detail' in item ? item.detail : null]);
    assert.deepEqual(history, [
      ['previous-boot-stop', `${previous}:forced:NO_GUEST_STOP_RECORD`],
      ['start-remedy-applied', `r47-disk:${remedy}:applied:original kept as root.qcow2.${remedy === 'repair-disk' ? 'damaged' : 'replaced'}-20261119t120000z`],
    ]);
  });
}

test('ticket 47: every boot records how the previous boot of its environment was stopped (clean/forced), visible in the history', async t => {
  const h = await harness(t, {}, () => ({
    previousStop: { boot: 'boot-47474747-2222-4333-8444-555555555555', result: 'clean', reason: 'GUEST_ROOT_READ_ONLY' },
  }));
  await h.until(async () => (await h.work())?.execution?.end?.outcome === 'completed', 'ran');
  const work = await h.work();
  const entry = work.history.find(item => item.event === 'previous-boot-stop')!;
  assert.deepEqual(
    ['detail' in entry ? entry.detail : null, 'executionId' in entry ? entry.executionId : null],
    ['boot-47474747-2222-4333-8444-555555555555:clean:GUEST_ROOT_READ_ONLY', work.execution!.executionId],
  );
  const history = (await h.control.inspect({ kind: 'history', work_id: work.work_id, execution: work.execution!.executionId, limit: 200 })) as HistoryView;
  assert.equal(history.entries.filter(item => item.entry.event === 'previous-boot-stop').length, 1);
});
