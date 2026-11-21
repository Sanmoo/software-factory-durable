import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilHolds } from '../runner/budget.js';
import { openControl } from '../../src/control/index.js';
import type { BootUsage, BootUsageReport, EnvironmentBuildReport } from '../../src/contracts/index.js';
import type { Control, ControlInput, ListView, ShowView, UsageView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { recoveryDoubles } from './recovery-doubles.js';

// v2 ticket 14 flow level (V2-30 execution side, V2-32): real Control + Pi Durable/SQLite + Records with the file-backed Sandbox host double
// of ticket 26. The Sandbox refuses a boot for lack of service quota, and reports what the boots of an environment consumed in its own
// neutral terms. Doubled: Sandbox host, Builder, credentials, GitHub. Not evidence of a service, of a quota or of a real boot.
type Refusal = { status: 'failure' | 'indeterminate'; code: string; detail?: string };
type Reports = { usage?: (environment: string) => BootUsageReport; builds?: () => EnvironmentBuildReport };

async function harness(t: { after(fn: () => Promise<void>): void }, refusals: Refusal[] = [], reports: Reports = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-usage14-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  const start = [...refusals];
  const doubles = recoveryDoubles(dir, [], { startRefusal: () => start.shift() });
  const execution = { ...doubles.ports, sandbox: { ...doubles.ports.sandbox,
    ...(reports.usage ? { usage: async (input: { environment: string }) => reports.usage!(input.environment) } : {}),
    ...(reports.builds ? { environmentBuilds: async () => reports.builds!() } : {}) } };
  const time = manualClock();
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await time.sleeping();
  t.after(async () => { stop.abort(); await running; });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView;
  const show = async (work_id: string) => await control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  const until = (predicate: () => Promise<boolean> | boolean, label: string) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  const accept = (input: ControlInput) => control.accept(input);
  const retry = (work_id: string, code: string, request_id: string) => accept({ request_id, operation: 'resume', work_id, retry_blocked_start: code, origin: 'local-cli' });
  const completed = () => until(async () => (await work())?.execution?.end?.outcome === 'completed', 'completed');
  return { control, doubles, work, show, until, retry, completed, time };
}

test('a boot the service refuses for quota waits and is retried by itself: no impediment, no operational recovery, the service\'s cause visible as the wait reason', async t => {
  const code = 'START_SERVICE_CAPACITY_REFUSED';
  const cause = 'capacity: ServiceQuotaExceededException: allocated memory quota exceeded';
  const refusal: Refusal = { status: 'failure', code: 'SERVICE_CAPACITY_REFUSED', detail: cause };
  const h = await harness(t, [refusal, refusal]);
  await h.until(async () => Boolean((await h.work())?.bootDeferral), 'capacity wait');
  let work = await h.work();
  const refused = work.execution!;
  assert.deepEqual([refused.state, refused.start, refused.slot.held, refused.charge?.state === 'consumed', refused.blockedStart ?? null],
    ['released', null, false, false, null], 'nothing started: Slot freed, nothing consumed, nothing blocked');
  assert.deepEqual([work.impediments, work.pendingRecovery, work.budget!.recoveries.consumed, work.budget!.recoveries.reserved], [[], null, 0, null]);
  assert.deepEqual([work.bootDeferral!.code, work.bootDeferral!.detail, work.bootDeferral!.waitSeconds, work.bootDeferral!.attempt, work.queue.pending], [code, cause, 15, 0, true]);
  assert.ok(work.dispatch.reasons.includes('BOOT_CAPACITY_WAIT'), 'the wait is visible');
  // Final review, should-fix 8: the service's cause is part of what `factory status` and the Work view show of the wait.
  assert.deepEqual(work.dispatch.capacityWait, { code, cause, notBefore: work.bootDeferral!.notBefore, waitSeconds: 15, attempt: 0 });
  assert.ok(work.history.some(item => item.event === 'boot-deferred' && item.detail?.includes(code) && item.detail.includes(cause)), 'the cause is in the history');

  // Not a hot loop: nothing is attempted again before the persisted wait ends, and a repeated refusal waits longer.
  h.doubles.jumpCalendar(10_000);
  for (let round = 0; round < 3; round += 1) { h.time.advance(); await h.time.sleeping(); }
  assert.equal(h.doubles.calls('start-refused').length, 1, 'no attempt inside the wait');
  h.doubles.jumpCalendar(10_000);
  await h.until(async () => (await h.work()).bootDeferral?.attempt === 1, 'second wait');
  work = await h.work();
  assert.deepEqual([work.bootDeferral!.waitSeconds, work.impediments, work.pendingRecovery, h.doubles.calls('start-refused').length], [60, [], null, 2]);
  h.doubles.jumpCalendar(61_000);
  await h.completed();
  work = await h.work();
  assert.deepEqual([h.doubles.calls('activate').length, work.bootDeferral, work.execution!.charge?.kind ?? 'none', work.budget!.recoveries.consumed, work.budget!.recoveries.reserved],
    [1, null, 'none', 0, null], 'the Work started as what it was: no recovery unit reserved or consumed');
});

test('the Operator retry of a blocked start does not apply to a quota refusal: there is no block to lift', async t => {
  const h = await harness(t, [{ status: 'failure', code: 'SERVICE_CAPACITY_REFUSED' }]);
  await h.until(async () => Boolean((await h.work())?.bootDeferral), 'capacity wait');
  const work = await h.work();
  const receipt = await h.retry(work.work_id, 'START_SERVICE_CAPACITY_REFUSED', 'q14-none') as { outcome?: string; reason?: string | null };
  assert.deepEqual([receipt.outcome, receipt.reason], ['not-applied', 'RECOVERY_NOT_BLOCKED']);
});

const boot = (id: string, change: Partial<BootUsage> = {}): BootUsage => ({ boot: `boot-${id}`, begin: 'start', end: 'end', size: 'large', startedAt: '2026-11-21T10:00:00.000Z',
  endedAt: '2026-11-21T10:10:00.000Z', seconds: 600, state: 'measured', ...change });

test('the usage of a Work shows every boot the sandbox reports and their accumulated seconds, next to the existing consumption', async t => {
  const boots = [boot('a', { end: 'planned-swap' }), boot('b', { begin: 'planned-swap', seconds: 90.5 }), boot('c', { seconds: 0, state: 'not-run', startedAt: null, endedAt: null, code: 'SERVICE_CAPACITY_REFUSED' })];
  const asked: string[] = [];
  const h = await harness(t, [], { usage: environment => { asked.push(environment); return { status: 'reported', unit: 'sandbox-seconds', boots }; } });
  await h.completed();
  const work = await h.work();
  const view = await h.control.inspect({ kind: 'usage', work_id: work.work_id }) as UsageView;
  const usage = view.works[0]!;
  assert.deepEqual(asked, [work.execution!.dispatch.environment]);
  assert.deepEqual(usage.boots, { unit: 'sandbox-seconds', seconds: 690.5, measured: 2, running: 0, unknown: 0, notRun: 1, lowerBound: false, measurement: 'complete', code: null,
    omitted: 0, items: boots });
  // The existing consumption stays where it was.
  assert.equal(usage.time.executions, 1);
  assert.ok(usage.budget.recoveries);
  assert.doesNotMatch(JSON.stringify(view), /dollar|usd|\$/i);
});

test('a boot with unknown seconds makes the Work total a lower bound: unknown is counted, never summed as zero', async t => {
  const boots = [boot('a'), boot('b', { seconds: null, state: 'unknown', endedAt: null }), boot('c', { seconds: null, state: 'running', end: null, endedAt: null })];
  const h = await harness(t, [], { usage: () => ({ status: 'reported', unit: 'sandbox-seconds', boots }) });
  await h.completed();
  const usage = (await h.control.inspect({ kind: 'usage' }) as UsageView).works[0]!;
  assert.deepEqual([usage.boots!.seconds, usage.boots!.measured, usage.boots!.unknown, usage.boots!.running, usage.boots!.lowerBound, usage.boots!.measurement],
    [600, 1, 1, 1, true, 'partial']);
  const only = await harness(t, [], { usage: () => ({ status: 'reported', unit: 'sandbox-seconds', boots: [boots[1]!] }) });
  await only.completed();
  const none = (await only.control.inspect({ kind: 'usage' }) as UsageView).works[0]!.boots!;
  assert.deepEqual([none.seconds, none.lowerBound, none.measurement], [null, true, 'unavailable'], 'nothing measured is not zero seconds');
});

test('a sandbox that does not measure boots, or whose report fails, shows boot usage as unavailable with the reason; one that has no such report shows nothing new', async t => {
  const unavailable = await harness(t, [], { usage: () => ({ status: 'unavailable', code: 'BOOT_USAGE_NOT_MEASURED' }) });
  await unavailable.completed();
  const first = (await unavailable.control.inspect({ kind: 'usage' }) as UsageView).works[0]!.boots!;
  assert.deepEqual([first.measurement, first.code, first.seconds, first.items], ['unavailable', 'BOOT_USAGE_NOT_MEASURED', null, []]);
  const failing = await harness(t, [], { usage: () => { throw new Error('unreadable'); } });
  await failing.completed();
  const second = (await failing.control.inspect({ kind: 'usage' }) as UsageView).works[0]!.boots!;
  assert.deepEqual([second.measurement, second.code, second.seconds], ['unavailable', 'BOOT_USAGE_OBSERVATION_FAILED', null]);
  const absent = await harness(t);
  await absent.completed();
  const view = await absent.control.inspect({ kind: 'usage' }) as UsageView;
  assert.equal('boots' in view.works[0]!, false);
  assert.equal('environmentBuilds' in view, false);
});

test('the installation usage shows the environment builds per key as the sandbox reports them', async t => {
  const keys = [{ key: 'a'.repeat(64), name: 'factory-acme-aaaa', builds: 2, works: 1, last: { requestedAt: '2026-11-21T09:00:00.000Z', settledAt: '2026-11-21T09:02:10.000Z', outcome: 'created' as const } }];
  const h = await harness(t, [], { builds: () => ({ status: 'reported', keys }) });
  await h.completed();
  const installation = await h.control.inspect({ kind: 'usage' }) as UsageView;
  assert.deepEqual(installation.environmentBuilds, { status: 'reported', builds: 2, omitted: 0, keys });
  // One Work's usage is about that Work: builds are shared by key across Works and belong to the installation view.
  const work = await h.work();
  assert.equal('environmentBuilds' in (await h.control.inspect({ kind: 'usage', work_id: work.work_id }) as UsageView), false);
});
