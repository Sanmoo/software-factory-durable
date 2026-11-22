import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createDeliveryDesk } from '../../src/control/durable/delivery-desk.js';
import { createRetentionDesk } from '../../src/control/durable/retention-desk.js';
import { acceptCleanupConfirm, acceptCleanupPlan, plannedResourcesOf, recordDetailIntent } from '../../src/control/durable/retention.js';
import { readWork, readWorks, works, type WorkRecord } from '../../src/control/durable/admission.js';
import { readQuestions } from '../../src/control/durable/questions.js';
import { planCleanup } from '../../src/control/rules/delivery.js';
import { retentionProtections, type PlanFacts } from '../../src/control/rules/retention.js';
import { sessionCopy, sessionLocator, usageSubjects } from '../../src/control/rules/inspection.js';
import type { DetailPorts, ExplicitCleanupSelection } from '../../src/control/types.js';
import { createRecords, listDetails, preserveSessionCopy, removeRecordsDetail } from '../../src/records/index.js';
import { scope } from './doubles.js';
import { deliveryRepository, environment, merged, ownFacts, realCleanupPorts, sandboxRoot, seedPublishedWork, store } from './delivery-fixture.js';

// Ticket 30 storage-real flows: Pi Durable + SQLite, the REAL Records area (captures written by Records, inventory, session copies, confined
// removal), REAL Sandbox removal/evidence export on synthetic environments (systemctl double). The host session read is covered in delivery-composition. Doubled: GitHub
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
  // A reviewer's session of the same boot (not recorded by the controller): preserved like the Builder's (supervisor decision).
  const reviewerSessions = join(own.runtime, 'w-rev', 'profile', 'sessions');
  await mkdir(reviewerSessions, { recursive: true, mode: 0o700 });
  await writeFile(join(reviewerSessions, 'review.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 's-r', cwd: '/workspace' })}\n`, { mode: 0o600 });
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
  // Logs = tool/command outputs (raw captures with a tool call id), as in the real q17 run; records history needs are kept (never details).
  const toolOutput = async (workId: string, text: string) => { const output = await records.openOutput({ ...context, workId, callId: randomUUID() });
    await output.write(Buffer.from(text)); return (await output.finish()).reference; };
  const logs = [await toolOutput(work_id, 'one'), await toolOutput(work_id, 'two')];
  const foreignLog = await toolOutput('foreign-work', 'foreign');
  const kept = [await records.record({ ...context, callId: 'worker-start' }, { version: 1, kind: 'worker-start' }),
    await records.record({ ...context, role: 'spec', callId: 'review-opinion' }, { kind: 'review-opinion', verdict: 'approve' })];
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
    async runtimeSessions({ boot }) {
      const directory = join(root, 'r', Buffer.from(boot.slice(5).replaceAll('-', ''), 'hex').toString('base64url'));
      const found: ({ ref: string; sha256: string; bytes: number } | { ref: string; code: string })[] = [];
      for (const worker of await readdir(directory).catch(() => [] as string[])) {
        if (!worker.startsWith('w-')) continue;
        for (const name of await readdir(join(directory, worker, 'profile', 'sessions')).catch(() => [] as string[])) {
          if ((await lstat(join(directory, worker, 'profile', 'sessions', name))).isSymbolicLink()) {
            found.push({ ref: relative(root, join(directory, worker, 'profile', 'sessions', name)), code: 'SESSION_PATH_UNSAFE' }); continue; }
          const bytes = await readFile(join(directory, worker, 'profile', 'sessions', name));
          found.push({ ref: relative(root, join(directory, worker, 'profile', 'sessions', name)), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
        }
      }
      return found;
    },
    async preserveSession({ workId, executionId, name, session: recorded }) {
      log.push(`preserve-session:${name ?? executionId}`);
      // The confined host read (platform/host `readSessionFile`) is composed and tested in delivery-composition; here a plain read of the same file.
      const read = await readFile(join(root, recorded.ref)).catch(() => null);
      if (!read) return { status: 'lost', code: 'SESSION_FILE_MISSING' };
      if (createHash('sha256').update(read).digest('hex') !== recorded.sha256) return { status: 'failed', code: 'SESSION_ALTERED' };
      return preserveSessionCopy(root, workId, name ?? executionId, read, recorded.sha256);
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
    readWorks: () => readWorks(session), stopped: () => false, now: () => clock.now,
    protections: async work => retentionProtections(work, { running: running.has(work.work_id), questions: await readQuestions(session, work) }) });
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
  return { root, session, work_id, own, foreign, logs, kept, foreignLog, sessions, github, repository, log, running, clock, faults, details, delivery, retentionDesk, settled, work, plan,
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
  const reviewerName = h.log.find(item => item.startsWith('preserve-session:e-1--rv-'))?.slice('preserve-session:'.length);
  assert.ok(reviewerName, h.log.join('|'));
  assert.deepEqual(h.log.filter(item => !item.startsWith('remove-detail')), [`preserve:${h.own.env}`, 'preserve-session:e-1', `preserve-session:${reviewerName}`, `remove:${h.own.env}`]);
  assert.ok(await exists(join(h.root, h.work_id, 'sessions', `${reviewerName}.jsonl`)), 'the reviewer session copy survives too');
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
  assert.deepEqual([view.inventory?.logs, view.inventory?.sessions, view.inventory?.evidence], [2, 2, 1]);
  assert.deepEqual(view.sessions.map(item => [item.id, item.state]), [['session:e-1', 'preserved'], [`session:${reviewerName}`, 'preserved']]);
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
  assert.deepEqual([view.state, view.removed.logs, view.removed.sessions], ['expired', 2, 2]);
  assert.ok(view.removals.every(item => item.origin === 'retention' && item.outcome === 'removed' && item.resultAt !== null && item.intentAt <= item.resultAt));
  assert.equal(await exists(h.logPath(h.logs[0]!.id)) || await exists(h.logPath(h.logs[1]!.id)) || await exists(h.copy), false);
  assert.match(view.nextStep, /expired: removed by retention.*2 log\(s\), 2 session\(s\)/);
  // Kept: preserved evidence, the foreign Work's log, history/summary/references; delivery stands.
  const after = await h.work();
  assert.equal((await readdir(join(h.root, h.work_id, 'evidence'))).length, 3, 'the preserved evidence and the records history needs (start receipt, opinion) remain');
  assert.equal(view.inventory?.kept, 2);
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
  assert.equal(h.log.filter(item => item.startsWith('remove-detail')).length, 4, 'failed/indeterminate are not retried by the next sweep');
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
  assert.equal(h.log.filter(item => item.startsWith('remove-detail')).length, 4);
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
  assert.deepEqual(h.log.filter(item => !item.startsWith('remove-detail')).map(item => item.replace(/--rv-[0-9a-f]+$/, '--rv')),
    [`preserve:${h.own.env}`, 'preserve-session:e-1', 'preserve-session:e-1--rv', `remove:${h.own.env}`]);
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
  assert.equal(sessions.plan!.items.length, 2, 'Builder and reviewer sessions');
  await h.retentionDesk().cycle();
  assert.equal(await exists(h.copy), false);
  assert.deepEqual(await readdir(join(h.root, h.work_id, 'sessions')), []);
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
  // Review LOW: a resource left kept for an operator decision never holds the logs/sessions for ever.
  h.clock.now = Date.parse(work.delivery!.merge!.confirmedAt) + 31 * day;
  await h.retentionDesk().cycle();
  const expired = (await h.work()).retention!;
  assert.deepEqual([expired.state, expired.protections, expired.removed.logs], ['expired', [], 2]);
  assert.match(work.cleanup!.nextStep, /factory cleanup <work> --select environment\|remote-branch/);
});

test('a daily sweep of an unchanged Work adds no history (undelivered Works are kept for ever without growing their history)', async t => {
  const h = await harness(t, { result: 'cancelled' });
  const desk = h.retentionDesk();
  for (let index = 0; index < 5; index++) { h.clock.now = Date.now() + index * day; await desk.cycle(); }
  const work = await h.work();
  assert.equal(work.retention?.sweeps, 5);
  assert.equal(work.history.filter(item => item.event === 'retention-evaluated').length, 1);
});

test('review MED: a failed/indeterminate removal is never retried implicitly, even after it left the bounded removals window', async t => {
  const h = await harness(t);
  const merge = await deliver(h);
  h.faults[`log:${h.logs[0]!.id}`] = 'failed';
  h.clock.now = merge + 31 * day;
  await h.retentionDesk().cycle();
  delete h.faults[`log:${h.logs[0]!.id}`];
  assert.deepEqual((await h.work()).retention?.unsettledIds, [`log:${h.logs[0]!.id}`]);
  // The bounded list no longer holds that attempt (500 later removals would do the same).
  await h.session.commit(async tx => { const work = (await tx.doc(works, h.work_id, null)).work!; work.retention!.removals = []; }, BACKGROUND_CONTEXT);
  h.clock.now += day;
  await h.retentionDesk().cycle();
  assert.equal(h.log.filter(item => item === `remove-detail:log:${h.logs[0]!.id}`).length, 1, 'not attempted again');
  assert.ok(await exists(h.logPath(h.logs[0]!.id)));
});

test('review MED/LOW: a confirmed explicit plan is revalidated at execution (unsettled effect → dropped, nothing removed); an all-refused plan supersedes nothing', async t => {
  const h = await harness(t, { result: 'cancelled' });
  const plan = await h.plan('p-1', ['logs', 'environment']);
  assert.ok(plan.kind === 'durable' && plan.plan?.items.length);
  const refused = await h.plan('p-2', ['remote-branch']);
  assert.ok(refused.kind === 'durable' && refused.plan?.items.length === 0);
  const confirmed = await h.confirm('c-1', plan.plan!.planId);
  assert.ok(confirmed.kind === 'durable' && confirmed.outcome === 'accepted', 'the valid plan was not superseded by the all-refused one');
  // After the confirmation, an effect of the Work becomes unsettled: the details are needed again.
  await h.session.commit(async tx => { const work = (await tx.doc(works, h.work_id, null)).work!;
    work.readiness = { effect: { effectId: 'r-1', state: 'attempted' } } as never; }, BACKGROUND_CONTEXT);
  await h.delivery.cycle();
  await h.retentionDesk().cycle();
  const work = await h.work();
  assert.deepEqual(h.log.filter(item => item.startsWith('remove')), [], 'nothing removed by the old plan');
  assert.ok(await exists(h.own.directory) && await exists(h.logPath(h.logs[0]!.id)));
  assert.equal(work.cleanup?.explicit?.consumed, true, 'consumed: nothing left for any automatic retry');
  const executed = work.retention!.plans.find(item => item.planId === plan.plan!.planId)!;
  assert.ok(executed.items.every(item => item.state === 'dropped' && /EFFECT_UNSETTLED:readiness:r-1/.test(item.code ?? '')), JSON.stringify(executed.items));
  assert.ok(work.cleanup!.resources.every(item => item.attempts.length === 0));
});

test('review LOW: an unsafe agent session file in the runtime keeps the environment and is reported with its code (never followed)', async t => {
  const h = await harness(t);
  await symlink('/etc/hostname', join(h.own.runtime, 'w-rev', 'profile', 'sessions', 'link.jsonl'));
  await deliver(h);
  const work = await h.work();
  assert.equal(h.log.filter(item => item.startsWith('remove:')).length, 0, 'environment kept');
  assert.ok(await exists(h.own.runtime));
  assert.ok(work.retention?.sessions.some(item => item.state === 'failed' && item.code === 'SESSION_PATH_UNSAFE'), JSON.stringify(work.retention?.sessions));
});

test('finding A7: the session a LOST Execution left in its boot is preserved as its Builder session copy before the environment goes, and usage reads that copy', async t => {
  const h = await harness(t);
  const data = await readFile(join(h.sessions, 'one.jsonl'));
  const lost = { ref: relative(h.root, join(h.sessions, 'one.jsonl')), sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  const asked: unknown[] = [];
  h.details.lostSession = async input => { asked.push(input); return lost; };
  // The Execution ended by a loss: nothing returned, so no session was recorded on its end.
  await h.session.commit(async tx => {
    const work = (await tx.doc(works, h.work_id, null)).work!;
    const execution = work.execution!;
    work.execution = { ...execution, end: { ...execution.end!, outcome: 'failure', code: 'SANDBOX_ENVIRONMENT_ENDED', session: null } };
    work.losses = [{ at: new Date().toISOString(), executionId: execution.executionId, boot: execution.dispatch.boot!, environment: execution.dispatch.environment, reason: 'Terminated', terminatedAt: null,
      confirmed: { commit: null, source: 'none', branch: execution.request.branch, origin: { state: 'unknown', code: 'ORIGIN_NOT_READ' } }, consumption: { executionMs: 1 },
      session: { invocationId: execution.invocationId, disposition: 'conserved-as-evidence' }, marker: { state: 'unknown', code: 'LOST_MARKER_READ_NOT_COMPOSED' } } as NonNullable<WorkRecord['losses']>[number]];
  }, BACKGROUND_CONTEXT);
  const before = await h.work();
  await deliver(h);
  const work = await h.work();
  assert.deepEqual(asked, [{ workId: h.work_id, boot: before.execution!.dispatch.boot, executionId: before.execution!.executionId, invocationId: before.execution!.invocationId }]);
  const kept = work.retention!.sessions.filter(item => item.state === 'preserved');
  assert.deepEqual(kept.map(item => [item.role, item.id === `session:${before.execution!.executionId}`, item.sourceRef === lost.ref]).sort(), [['builder', true, true], ['reviewer', false, false]],
    'the lost session is the Builder copy of its Execution, not one more unnamed agent session');
  assert.ok(await exists(h.copy) && !await exists(h.own.runtime), 'the copy survives the removal of the runtime tree');
  // Usage then reads the copy: the subject is still the lost Builder, located by its invocation.
  const subject = usageSubjects(work).find(item => item.role === 'builder' && item.executionId === before.execution!.executionId)!;
  assert.deepEqual(subject.lost, { boot: before.execution!.dispatch.boot });
  assert.deepEqual(sessionCopy(work, subject, sessionLocator(work, subject)), { copy: { name: before.execution!.executionId, sha256: lost.sha256 }, removal: null });
});
