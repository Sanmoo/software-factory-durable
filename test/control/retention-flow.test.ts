import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createDeliveryDesk } from '../../src/control/durable/delivery-desk.js';
import { createRetentionDesk } from '../../src/control/durable/retention-desk.js';
import { acceptCleanupConfirm, acceptCleanupPlan, plannedResourcesOf, recordDetailIntent } from '../../src/control/durable/retention.js';
import { readWork, readWorks, works, type WorkRecord } from '../../src/control/durable/admission.js';
import { readQuestions } from '../../src/control/durable/questions.js';
import { planCleanup } from '../../src/control/rules/delivery.js';
import type { PlanFacts } from '../../src/control/rules/retention.js';
import type { DetailPorts, ExplicitCleanupSelection } from '../../src/control/types.js';
import { createRecords, listDetails, preserveSessionCopy, removeRecordsDetail } from '../../src/records/index.js';
import { readSessionFile } from '../../src/platform/host/index.js';
import { scope } from './doubles.js';
import { deliveryRepository, environment, merged, ownFacts, realCleanupPorts, sandboxRoot, seedPublishedWork, store } from './delivery-fixture.js';

// Ticket 30 storage-real flows: Pi Durable + SQLite, the REAL Records area (captures written by Records, inventory, session copies, confined
// removal), REAL Sandbox removal/evidence export on synthetic environments (systemctl double), REAL host session read. Doubled: GitHub
// (CodeRepository) and the calendar (controlled instants). Not evidence of a real VM, GitHub or model.
const day = 86_400_000;
const exists = (path: string) => lstat(path).then(() => true, () => false);

async function harness(t: { after(fn: () => Promise<void> | void): void }, options: { result?: 'cancelled' } = {}) {
  const root = await realpath(await sandboxRoot(t));
  const { session } = await store(t, root);
  const work_id = await seedPublishedWork(session);
  const own = await environment(root, work_id);
  const foreign = await environment(root, 'foreign-work', 'boot-99999999-2222-4333-8444-555555555555');
  // The recorded Builder session of e-1, in its boot runtime tree (what ticket 11 records), and the Work's logs written by Records.
  const sessions = join(own.runtime, 'w-abc', 'profile', 'sessions');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const data = Buffer.from(`${JSON.stringify({ type: 'session', version: 3, id: 's-1', cwd: '/workspace' })}\n{"type":"message"}\n`);
  await writeFile(join(sessions, 'one.jsonl'), data, { mode: 0o600 });
  const sha256 = createHash('sha256').update(data).digest('hex');
  await session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work!;
    work.execution!.end!.session = { ref: relative(root, join(sessions, 'one.jsonl')), sessionId: 's-1', sha256, bytes: data.length, format: 'pi-session-jsonl-v3',
      profile: { sdkProfile: 'p', providerId: 'x', modelId: 'y', skillPack: null, tools: ['bash'] } };
    if (options.result === 'cancelled') {
      work.result = 'cancelled';
      work.cancellation = { request_id: 'c-1', requestedAt: new Date().toISOString(), state: 'ceased', ceasedAt: new Date().toISOString(), executionId: null, nextStep: '' };
    }
  }, BACKGROUND_CONTEXT);
  const records = await createRecords({ root });
  const context = { workId: work_id, executionId: 'e-1', invocationId: 'i-1', role: 'builder' as const, environmentRef: own.env, bootRef: 'boot', callId: 'c-1' };
  const logs = [await records.record(context, { tool: 'bash', output: 'one' }), await records.record({ ...context, callId: 'c-2' }, { tool: 'read', output: 'two' })];
  const foreignLog = await records.record({ ...context, workId: 'foreign-work' }, { tool: 'bash' });
  const github = { pull: ownFacts() as ReturnType<typeof ownFacts> | 'unavailable', branch: { 'factory/3-own': 'a'.repeat(40), main: 'c'.repeat(40) } as Record<string, string>,
    branchOutcomes: [] as ('removed' | 'absent' | 'refused' | 'failed' | 'indeterminate' | 'kept')[] };
  const repository = deliveryRepository(github);
  const log: string[] = [];
  const running = new Set<string>();
  const clock = { now: Date.now() };
  const faults: Record<string, 'failed' | 'throw'> = {};
  // The same composition as production `detailPorts` (records + host session read), with a call log and injectable faults.
  const details: DetailPorts = {
    list: ({ workId }) => listDetails(root, workId),
    async preserveSession({ workId, executionId, session: recorded }) {
      log.push(`preserve-session:${executionId}`);
      const read = await readSessionFile(root, recorded.ref);
      if (read.state === 'lost') return { status: 'lost', code: read.code };
      if (read.state !== 'read' || read.sha256 !== recorded.sha256) return { status: 'failed', code: 'SESSION_ALTERED' };
      return preserveSessionCopy(root, workId, executionId, read.data, read.sha256);
    },
    async remove({ workId, item, expectedSha256 }) {
      log.push(`remove-detail:${item.id}`);
      if (faults[item.id] === 'throw') throw new Error('LOST');
      if (faults[item.id] === 'failed') return { outcome: 'failed', code: 'SYNTHETIC_FAILURE' };
      return removeRecordsDetail(root, workId, item, expectedSha256);
    },
  };
  const cleanup = { ...realCleanupPorts(root, log), details, retentionDays: 30 };
  const settled = { value: true };
  const delivery = createDeliveryDesk({ session, repository: repository.repository, repositories: [scope], cleanup, running: id => running.has(id), interrupt: async () => {},
    readWorks: () => readWorks(session), stopped: () => false, now: () => clock.now });
  const retentionDesk = () => createRetentionDesk({ session, details, repositories: [scope], days: 30, sweepSeconds: 86400, readWorks: () => readWorks(session),
    readQuestions: work => readQuestions(session, work), running: id => running.has(id), settled: () => settled.value, stopped: () => false, now: () => clock.now });
  const work = async () => (await readWork(session, work_id))!;
  /** The facts Control reads for a plan/confirmation (Control's `cleanupFacts`). */
  const facts = async (): Promise<(current: WorkRecord) => PlanFacts> => {
    const inventory = await details.list({ workId: work_id });
    const questions = await readQuestions(session, await work());
    const isRunning = running.has(work_id);
    return current => ({ running: isRunning, questions, inventory, repositoryConfigured: true,
      plannedResources: plannedResourcesOf(current, planCleanup(current, { repositoryConfigured: true }).resources) });
  };
  const plan = async (request_id: string, select: ExplicitCleanupSelection[]) =>
    acceptCleanupPlan(session, { request_id, operation: 'cleanup-plan', work_id, select, origin: 'local-cli' }, await facts());
  const confirm = async (request_id: string, plan_id: string) =>
    acceptCleanupConfirm(session, { request_id, operation: 'cleanup-confirm', work_id, plan_id, origin: 'local-cli' }, await facts());
  const logPath = (id: string, workId = work_id) => join(root, workId, 'evidence', id);
  return { root, session, work_id, own, foreign, logs, foreignLog, sessions, github, repository, log, running, clock, faults, details, delivery, retentionDesk, settled, work, plan,
    confirm, logPath, copy: join(root, work_id, 'sessions', 'e-1.jsonl') };
}
async function deliver(h: Awaited<ReturnType<typeof harness>>) {
  h.github.pull = merged();
  await h.delivery.cycle();
  const work = await h.work();
  assert.equal(work.result, 'delivered');
  return Date.parse(work.delivery!.merge!.confirmedAt);
}

test('AC1/AC3/AC4/AC8: sessions are preserved before the environment goes; delivered details expire 30 days after the merge, protected ones later with no new period', async t => {
  const h = await harness(t);
  const merge = await deliver(h);
  const delivered = await h.work();
  assert.equal(delivered.cleanup?.state, 'complete', JSON.stringify(delivered.cleanup?.resources.map(item => [item.id, item.state])));
  // Preservation precedes the removal of its origin: evidence, then the recorded session, then the Sandbox removal.
  assert.deepEqual(h.log.filter(item => !item.startsWith('remove-detail')), [`preserve:${h.own.env}`, 'preserve-session:e-1', `remove:${h.own.env}`]);
  assert.equal(await exists(h.own.runtime), false, 'the runtime tree (with the original session) is gone');
  assert.ok(await exists(h.copy), 'the session copy survives the resource cleanup');
  assert.equal(delivered.retention?.sessions[0]?.state, 'preserved');
  assert.ok(await exists(h.foreign.directory) && await exists(h.foreign.runtime), 'foreign environment untouched');

  // Boot sweep only after the reconciliation settled the installation; then daily (a restarted owner sweeps again at its first cycle).
  h.settled.value = false;
  let desk = h.retentionDesk();
  await desk.cycle();
  assert.equal((await h.work()).retention?.sweeps, 0, 'nothing before the boot reconciliation');
  h.settled.value = true;
  h.clock.now = merge + day;
  await desk.cycle();
  let view = (await h.work()).retention!;
  assert.deepEqual([view.class, view.state, view.dueAt, view.sweeps], ['delivered', 'retained', new Date(merge + 30 * day).toISOString(), 1]);
  assert.match(view.nextStep, /kept until .* \(30 days after the confirmed merge\)/);
  assert.deepEqual([view.inventory?.logs, view.inventory?.sessions, view.inventory?.evidence], [2, 1, 1]);
  await desk.cycle();
  assert.equal((await h.work()).retention?.sweeps, 1, 'not again before a day');
  desk = h.retentionDesk();
  await desk.cycle();
  assert.equal((await h.work()).retention?.sweeps, 2, 'a new owner process sweeps at boot');

  // Past the deadline but in use (an activity of the Work): protected, nothing removed.
  h.clock.now = merge + 31 * day;
  h.running.add(h.work_id);
  desk = h.retentionDesk();
  await desk.cycle();
  view = (await h.work()).retention!;
  assert.deepEqual([view.state, view.protections], ['protected', ['ACTIVITY_RUNNING']]);
  assert.ok(await exists(h.logPath(h.logs[0]!.id)) && await exists(h.copy));
  assert.equal(h.log.filter(item => item.startsWith('remove-detail')).length, 0);
  // The protection ends at day 40: the next daily sweep removes them at once (the deadline stays merge + 30).
  h.running.delete(h.work_id);
  h.clock.now = merge + 40 * day;
  await desk.cycle();
  view = (await h.work()).retention!;
  assert.equal(view.dueAt, new Date(merge + 30 * day).toISOString(), 'no new 30 days');
  assert.deepEqual([view.state, view.removed.logs, view.removed.sessions], ['expired', 2, 1]);
  assert.ok(view.removals.every(item => item.origin === 'retention' && item.outcome === 'removed' && item.resultAt !== null && item.intentAt <= item.resultAt));
  assert.equal(await exists(h.logPath(h.logs[0]!.id)) || await exists(h.logPath(h.logs[1]!.id)) || await exists(h.copy), false);
  assert.match(view.nextStep, /expired: removed by retention.*2 log\(s\), 1 session\(s\)/);
  // Kept: preserved evidence, the foreign Work's log, history/summary/references; delivery stands.
  const after = await h.work();
  assert.equal((await readdir(join(h.root, h.work_id, 'evidence'))).length, 1, 'only the preserved evidence directory remains');
  assert.ok(await exists(h.logPath(h.foreignLog.id, 'foreign-work')));
  assert.deepEqual([after.result, after.delivery?.state, after.cleanup?.evidence.length], ['delivered', 'delivered', 1]);
  assert.ok(after.history.some(item => item.event === 'delivery-confirmed') && after.history.some(item => item.event === 'detail-removal-result'));
});

test('AC2: undelivered (cancelled) Works keep every log/session past any age; only explicit cleanup removes them', async t => {
  const h = await harness(t, { result: 'cancelled' });
  h.clock.now = Date.now() + 400 * day;
  await h.retentionDesk().cycle();
  const view = (await h.work()).retention!;
  assert.deepEqual([view.class, view.state, view.dueAt, view.removed.logs], ['undelivered', 'retained', null, 0]);
  assert.match(view.nextStep, /until an explicit `factory cleanup`/);
  assert.ok(await exists(h.logPath(h.logs[0]!.id)) && await exists(h.own.runtime));
  assert.equal(h.log.length, 0, 'no preservation or removal at all');
});

test('AC8: partial failure, lost result after a crash (indeterminate) and absence proven later — nothing is retried implicitly', async t => {
  const h = await harness(t);
  const merge = await deliver(h);
  h.faults[`log:${h.logs[0]!.id}`] = 'failed';
  h.faults['session:e-1'] = 'throw';
  h.clock.now = merge + 31 * day;
  const desk = h.retentionDesk();
  await desk.cycle();
  let view = (await h.work()).retention!;
  const outcome = (id: string) => view.removals.filter(item => item.id === id).map(item => [item.outcome, item.code]);
  assert.deepEqual(outcome(`log:${h.logs[0]!.id}`), [['failed', 'SYNTHETIC_FAILURE']]);
  assert.deepEqual(outcome(`log:${h.logs[1]!.id}`), [['removed', null]], 'one failure never stops the others');
  assert.deepEqual(outcome('session:e-1'), [['indeterminate', 'DETAIL_REMOVAL_UNAVAILABLE']]);
  delete h.faults[`log:${h.logs[0]!.id}`]; delete h.faults['session:e-1'];
  h.clock.now += day;
  await desk.cycle();
  view = (await h.work()).retention!;
  assert.equal(h.log.filter(item => item.startsWith('remove-detail')).length, 3, 'failed/indeterminate are not retried by the next sweep');
  assert.equal(view.state, 'eligible');
  // A crash right after the intent (no result recorded): the next sweep makes it indeterminate, never success.
  const intent = await recordDetailIntent(h.session, h.work_id, [{ id: `log:${h.logs[0]!.id}`, kind: 'log', executionId: 'e-1', bytes: 1 }],
    { kind: 'retention', request_id: null, planId: null }, () => null);
  assert.equal(typeof intent === 'object' && intent.kind, 'recorded');
  h.clock.now += day;
  await h.retentionDesk().cycle();
  view = (await h.work()).retention!;
  assert.deepEqual(view.removals.at(-1) && [view.removals.at(-1)!.outcome, view.removals.at(-1)!.code], ['indeterminate', 'RESULT_NOT_RECORDED']);
  // Absence observed by a COMPLETE inventory concludes an indeterminate removal (no effect sent).
  await rm(h.copy);
  h.clock.now += day;
  await desk.cycle();
  view = (await h.work()).retention!;
  assert.deepEqual(outcome('session:e-1'), [['absent', 'ABSENT_IN_COMPLETE_INVENTORY']]);
  assert.equal(h.log.filter(item => item.startsWith('remove-detail')).length, 3);
});

test('AC5/AC6/AC7: explicit cleanup of a cancelled Work — cancel first, plan of losses, supersede/obsolete revalidation, environment then details, foreign never touched', async t => {
  const h = await harness(t);
  // The cycle can still continue: everything refused, nothing changed, nothing implicitly cancelled.
  const open = await h.plan('p-open', ['logs', 'environment']);
  assert.equal(open.kind === 'durable' && open.plan?.refusals.map(item => item.code).join(), 'CANCEL_REQUIRED,CANCEL_REQUIRED');
  assert.equal((await h.work()).result, 'open');
  await h.session.commit(async tx => { const work = (await tx.doc(works, h.work_id, null)).work!; work.result = 'cancelled';
    work.cancellation = { request_id: 'c-1', requestedAt: 'x', state: 'ceased', ceasedAt: 'x', executionId: null, nextStep: '' }; }, BACKGROUND_CONTEXT);

  const first = await h.plan('p-1', ['logs', 'sessions', 'environment', 'remote-branch']);
  assert.ok(first.kind === 'durable' && first.plan);
  const planned = first.plan!;
  assert.deepEqual(planned.items.map(item => item.kind).sort(), ['environment', 'environment', 'environment', 'environment', 'log', 'log']);
  assert.deepEqual(planned.refusals.map(item => item.code).sort(), ['NOTHING_TO_REMOVE', 'REMOTE_BRANCH_NOT_DELIVERED', 'SESSION_IN_ENVIRONMENT']);
  assert.equal(planned.losses.length, 6);
  assert.match(planned.nextStep, /factory cleanup-confirm <work>/);
  assert.ok(await exists(h.logPath(h.logs[0]!.id)), 'a plan removes nothing');
  assert.deepEqual(await h.plan('p-1', ['logs', 'sessions', 'environment', 'remote-branch']), first, 'same identity and content: same receipt');
  // A newer plan supersedes the older one; an obsolete plan is revalidated at confirmation (an activity now runs: everything is dropped).
  const second = await h.plan('p-2', ['logs', 'environment']);
  assert.deepEqual(await h.confirm('c-old', planned.planId).then(item => item.kind === 'durable' ? [item.outcome, item.reason] : item), ['not-applied', 'PLAN_SUPERSEDED']);
  h.running.add(h.work_id);
  const stale = await h.confirm('c-2', second.kind === 'durable' ? second.plan!.planId : '');
  assert.ok(stale.kind === 'durable');
  assert.deepEqual([stale.outcome, stale.reason], ['not-applied', 'NOTHING_LEFT_AFTER_REVALIDATION']);
  assert.ok(stale.plan!.items.every(item => item.state === 'dropped' && item.code?.startsWith('BECAME_PROTECTED:ACTIVITY_RUNNING')));
  await h.delivery.cycle(); await h.retentionDesk().cycle();
  assert.ok(await exists(h.own.directory) && await exists(h.logPath(h.logs[0]!.id)), 'an old plan never removes what became active');
  h.running.delete(h.work_id);

  const third = await h.plan('p-3', ['logs', 'environment']);
  const confirmed = await h.confirm('c-3', third.kind === 'durable' ? third.plan!.planId : '');
  assert.ok(confirmed.kind === 'durable');
  assert.equal(confirmed.outcome, 'accepted');
  assert.equal((await h.work()).cleanup?.explicit?.consumed, false);
  assert.deepEqual(await h.confirm('c-3b', third.kind === 'durable' ? third.plan!.planId : '').then(item => item.kind === 'durable' && item.outcome), 'already-satisfied');
  await h.delivery.cycle();
  let work = await h.work();
  assert.deepEqual(h.log.filter(item => !item.startsWith('remove-detail')), [`preserve:${h.own.env}`, 'preserve-session:e-1', `remove:${h.own.env}`]);
  assert.equal(work.cleanup?.explicit?.consumed, true);
  assert.ok(work.cleanup?.resources.every(item => item.state === 'removed' && item.kind !== 'remote-branch'), JSON.stringify(work.cleanup?.resources));
  assert.equal(h.repository.calls.filter(call => call.method === 'cleanupBranch').length, 0, 'a cancelled Work\'s branch and GitHub are never touched');
  assert.ok(await exists(h.foreign.directory) && await exists(h.foreign.runtime));
  await h.delivery.cycle();
  assert.equal(h.log.filter(item => item.startsWith('remove:')).length, 1, 'swept once: no implicit repetition');
  await h.retentionDesk().cycle();
  work = await h.work();
  const executed = work.retention!.plans.find(item => item.planId === (third.kind === 'durable' ? third.plan!.planId : ''))!;
  assert.equal(executed.state, 'executed');
  assert.deepEqual(executed.items.filter(item => item.kind === 'log').map(item => item.state), ['removed', 'removed']);
  assert.ok(work.retention!.removals.every(item => item.origin === 'explicit' && item.request_id === 'c-3'));
  assert.ok(await exists(h.logPath(h.foreignLog.id, 'foreign-work')), 'a foreign Work\'s log is never touched');
  assert.equal(work.result, 'cancelled', 'cleanup never changes the result');
  // The preserved session is now a selectable detail; its removal warns that nothing resumes it. Automation = plan + confirm, same checks.
  const sessions = await h.plan('p-4', ['sessions']);
  assert.ok(sessions.kind === 'durable');
  assert.ok(sessions.plan!.warnings.some(item => /`resume` does not recreate a session/.test(item)));
  await h.confirm('c-4', sessions.plan!.planId);
  await h.retentionDesk().cycle();
  assert.equal(await exists(h.copy), false);
  assert.equal((await h.work()).retention?.state, 'explicitly-cleaned');
});

test('AC5/AC6 (ticket 17 hand-off): a kept/refused own branch of a delivered Work gets ONE fresh revalidated attempt per explicit confirmation, never forced', async t => {
  const h = await harness(t);
  h.github.branchOutcomes.push('kept');
  await deliver(h);
  const branch = (await h.work()).cleanup!.resources.find(item => item.kind === 'remote-branch')!;
  assert.equal(branch.state, 'kept');
  h.clock.now += 2 * day;
  await h.delivery.cycle();
  const attempts = () => h.repository.calls.filter(call => call.method === 'cleanupBranch').length;
  assert.equal(attempts(), 1, 'kept is never retried automatically');
  const plan = await h.plan('p-b', ['remote-branch']);
  assert.ok(plan.kind === 'durable' && plan.plan);
  assert.deepEqual(plan.plan!.items.map(item => item.id), [branch.id]);
  await h.confirm('c-b', plan.plan!.planId);
  h.github.branchOutcomes.push('kept');
  await h.delivery.cycle();
  await h.delivery.cycle();
  const work = await h.work();
  assert.equal(attempts(), 2, 'exactly one fresh attempt for the confirmation');
  assert.deepEqual([work.cleanup!.resources.find(item => item.id === branch.id)!.state, work.cleanup!.explicit?.consumed, work.result], ['kept', true, 'delivered']);
});

test('a daily sweep of an unchanged Work adds no history (undelivered Works are kept for ever without growing their history)', async t => {
  const h = await harness(t, { result: 'cancelled' });
  const desk = h.retentionDesk();
  for (let index = 0; index < 5; index++) { h.clock.now = Date.now() + index * day; await desk.cycle(); }
  const work = await h.work();
  assert.equal(work.retention?.sweeps, 5);
  assert.equal(work.history.filter(item => item.event === 'retention-evaluated').length, 1);
});
