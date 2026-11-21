import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import type { LostMarkersObservation } from '../../src/code-repository/index.js';
import type { ChannelReport } from '../../src/contracts/index.js';
import { createDeliveryDesk } from '../../src/control/durable/delivery-desk.js';
import { readWork, readWorks, works } from '../../src/control/durable/admission.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, type Activation, type Script } from './publication-doubles.js';
import { deliveryRepository, environment, headSha, merged, realCleanupPorts, sandboxRoot, seedPublishedWork, store } from './delivery-fixture.js';
import { untilHolds } from '../runner/budget.js';

// v2 ticket 12 (V2-16, V2-17, V2-02 Remover), flow level: real Control + Pi Durable + temporary SQLite. Doubled: GitHub (including the
// listing of loss marker refs), the clock, a Sandbox that declares NO persistent disk and reports the end of its environment, Workers and
// credentials. It shows what CONTROL records and deletes; the hook and the push are exercised in `test/sandbox/lambda-loss-marker.test.ts`.
const main = 'b'.repeat(40), wip = 'e'.repeat(40), lost = 'c'.repeat(40);
async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[], markers: { read: (workId: string) => LostMarkersObservation | Promise<LostMarkersObservation> },
  /** Operator decision 6: the sandbox also declares channel recovery and answers this report for a boot. */ channel?: (boot: string) => ChannelReport) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-loss-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const execution = executionDoubles(remote, [...scripts], { diskless: true });
  const watched: { boot: string; end(reason: string): void }[] = [];
  const markerReads: string[] = [];
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty',
    execution: { ...execution.ports, sandbox: { ...execution.ports.sandbox, capabilities: { ...execution.ports.sandbox.capabilities!, environmentWatch: true, ...(channel ? { channelRecovery: true } : {}) },
      ...(channel ? { channelReport: async (input: { boot: string }) => channel(input.boot) } : {}),
      awaitEnvironmentEnd: input => new Promise(resolve => {
        watched.push({ boot: input.boot, end: reason => resolve({ reason, terminatedAt: '2026-11-21T10:00:00.000Z' }) });
        input.signal.addEventListener('abort', () => resolve(null), { once: true });
      }) } },
    access: { tracker: github.tracker, repository: { ...github.repository, readLostMarkers: async selection => { markerReads.push(selection.workId); return markers.read(selection.workId); } },
      repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
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
  const executionOf = (value: WorkView | undefined, id: string) => [...(value?.previousExecutions ?? []), ...(value?.execution ? [value.execution] : [])].find(item => item.executionId === id) as ExecutionView | undefined;
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  return { execution, work, settle, watched, markerReads, executionOf, activations, guest: execution.guest };
}

test('V2-17: an environment that dies with unpublished work is a loss recorded on the Work: last confirmed commit, boot, consumption, the old session kept, and the marker ref by Control\'s own read', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  let workId = '';
  const h = await harness(t, remote, [{ kind: 'hang', head: lost }], { read: id => ({ state: 'complete', observedAt: '2026-11-21T10:00:01.000Z',
    markers: [{ ref: `refs/factory/lost/${id}/${h.watched[0]!.boot}`, boot: h.watched[0]!.boot, sha: lost }] }) });
  await h.settle('started', value => value?.execution?.state === 'started' && h.watched.length === 1);
  const started = (await h.work())!;
  workId = started.work_id;
  const execution = started.execution!;
  // The Work branch holds an earlier push; the guest's HEAD (`lost`) was committed and never pushed to it.
  remote.refs![started.branch!] = wip;
  assert.equal(started.losses, undefined);
  h.watched[0]!.end('MicroVM exceeded maximum lifetime.');
  await h.settle('slot released', value => h.executionOf(value, execution.executionId)?.slot.held === false);
  const work = (await h.work())!;
  const ended = h.executionOf(work, execution.executionId)!;
  assert.deepEqual([ended.end?.outcome, ended.end?.code], ['failure', 'SANDBOX_ENVIRONMENT_ENDED']);
  const [loss] = work.losses!;
  const ref = `refs/factory/lost/${workId}/${execution.dispatch.boot}`;
  assert.deepEqual({ ...loss, at: null, consumption: null }, { at: null, executionId: execution.executionId, boot: execution.dispatch.boot, environment: execution.dispatch.environment,
    reason: 'MicroVM exceeded maximum lifetime.', terminatedAt: '2026-11-21T10:00:00.000Z',
    confirmed: { commit: wip, source: 'origin-read', branch: started.branch, origin: { state: 'present', sha: wip } }, consumption: null,
    session: { invocationId: execution.invocationId, disposition: 'conserved-as-evidence' },
    marker: { ref, state: 'present', commit: lost, observedAt: '2026-11-21T10:00:01.000Z' } });
  assert.equal(typeof loss!.consumption.executionMs, 'number');
  assert.equal(work.losses!.length, 1);
  // Visible: an event of the Work's history says what is lost and that the marker is not preservation.
  const event = work.history.find(item => item.event === 'loss-recorded') as { executionId: string; detail: string };
  assert.deepEqual([event.executionId, event.detail], [execution.executionId, `${execution.dispatch.boot}: local work after ${wip} is lost; marker ${ref} at ${lost} (not preservation)`]);
  // The marker counts for nothing: no commit was confirmed as preserved and the Work branch is where it was.
  assert.equal(work.preservation, undefined);
  assert.equal(remote.refs![started.branch!], wip);
  assert.deepEqual(h.markerReads, [workId], 'one read of the marker refs, made by Control');
  // The old session is not continued: whatever activation follows carries no continuation.
  assert.deepEqual(h.activations().slice(1).map(item => item.continuation), h.activations().slice(1).map(() => null));
});

test('V2-17: with nothing ever pushed and no marker, the loss still is recorded: nothing confirmed, marker absent; an unreadable listing is unknown, never absent', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const h = await harness(t, remote, [{ kind: 'hang', head: lost }], { read: () => ({ state: 'complete', observedAt: '2026-11-21T10:00:01.000Z', markers: [] }) });
  await h.settle('started', value => value?.execution?.state === 'started' && h.watched.length === 1);
  h.watched[0]!.end('The service ended the MicroVM.');
  await h.settle('loss recorded', value => value?.losses?.length === 1);
  const [loss] = (await h.work())!.losses!;
  assert.deepEqual([loss!.confirmed.commit, loss!.confirmed.source, loss!.confirmed.origin, loss!.marker.state], [null, 'none', { state: 'absent' }, 'absent']);

  const unread = await harness(t, { pulls: {}, issues: [remoteIssue(3)], refs: { main } }, [{ kind: 'hang', head: lost }], { read: () => { throw new Error('transport'); } });
  await unread.settle('started', value => value?.execution?.state === 'started' && unread.watched.length === 1);
  unread.watched[0]!.end('The service ended the MicroVM.');
  await unread.settle('loss recorded', value => value?.losses?.length === 1);
  assert.deepEqual((await unread.work())!.losses![0]!.marker.state === 'unknown' && (await unread.work())!.losses![0]!.marker, { ref: (await unread.work())!.losses![0]!.marker.ref, state: 'unknown', code: 'LOST_MARKER_READ_FAILED' });
});

test('Operator decision 6: a channel that cannot be recovered with the environment alive ends the boot as a recorded loss and the Work retries by itself on a new boot, with no impediment', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const boots: string[] = [];
  // Only the first boot loses its channel for good; the boot that replaces it reports nothing.
  const channel = (boot: string): ChannelReport => { if (!boots.includes(boot)) boots.push(boot); return boot === boots[0] ? { indeterminateEffects: [], unrecoverable: { at: '2026-11-21T10:01:00.000Z', attempts: 5 } } : { indeterminateEffects: [], unrecoverable: null }; };
  const h = await harness(t, remote, [{ kind: 'implement', head: lost, failure: 'WORKER_INTERRUPTED' }, { kind: 'hang', head: lost }],
    { read: () => ({ state: 'complete', observedAt: '2026-11-21T10:00:01.000Z', markers: [] }) }, channel);
  await h.settle('loss recorded', value => value?.losses?.length === 1);
  let work = (await h.work())!;
  const [loss] = work.losses!;
  const ended = h.executionOf(work, loss!.executionId)!;
  assert.deepEqual([ended.end?.outcome, ended.end?.code], ['failure', 'SANDBOX_CHANNEL_UNRECOVERABLE']);
  // The environment was alive and unreachable: what it held and `origin` does not is lost when Control ends the boot.
  assert.deepEqual([loss!.boot, loss!.reason, loss!.terminatedAt, loss!.confirmed.commit, loss!.marker.state, loss!.session],
    [ended.dispatch.boot, 'SANDBOX_CHANNEL_UNRECOVERABLE: the tool channel could not be re-established in 5 attempts with the environment alive; Control ended the boot',
      null, null, 'absent', { invocationId: ended.invocationId, disposition: 'conserved-as-evidence' }]);
  assert.ok(h.execution.calls.some(call => call.kind === 'stop'), 'the unreachable boot is ended');
  assert.deepEqual(work.impediments, [], 'nothing waits for the Operator');
  // It comes back through the queue as ONE operational recovery, on a new boot, with a substitute session.
  await h.settle('retried', value => value?.execution?.executionId !== loss!.executionId && value?.execution?.state === 'started');
  work = (await h.work())!;
  assert.deepEqual([work.budget!.recoveries.consumed, work.impediments, work.losses!.length], [1, [], 1]);
  assert.notEqual(work.execution!.dispatch.boot, loss!.boot);
  assert.deepEqual(h.activations().map(item => item.continuation), [null, null], 'the lost session is not continued');
});

test('NEGATIVE (V2-16): a marker ref that holds the guest HEAD does not satisfy the preservation gate and nothing is recorded as preserved', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const ask: Script = { kind: 'ask', head: lost, question: 'Which storage should the note use?', questionId: '11111111-2222-4333-8444-000000000001' };
  const noop: Script = { kind: 'publish', publish: () => {}, end: 'success' };
  // `origin` holds the marker of this very boot at the guest's HEAD for the whole scenario; the Work branch does not exist.
  const h = await harness(t, remote, [ask, noop, noop], { read: id => ({ state: 'complete', observedAt: '2026-11-21T10:00:01.000Z',
    markers: [{ ref: `refs/factory/lost/${id}/${h.watched[0]!.boot}`, boot: h.watched[0]!.boot, sha: lost }] }) });
  await h.settle('ended as a loss', value => value?.execution?.end?.code === 'PRESERVATION_GATE_REFUSED' && value.losses?.length === 1);
  const work = (await h.work())!;
  assert.deepEqual(work.execution!.preservationGate?.attempts.map(item => [item.outcome, item.code]), [['refused', 'HEAD_NOT_PUBLISHED'], ['refused', 'HEAD_NOT_PUBLISHED'], ['refused', 'HEAD_NOT_PUBLISHED']]);
  // Operator decision 7 of 2026-11-21: the three refusals end the boot as a loss. The marker is recorded FOR THE SUBSTITUTE, and still
  // counts for nothing: no commit was confirmed as preserved.
  assert.equal(work.preservation, undefined);
  assert.deepEqual([work.losses![0]!.cause, work.losses![0]!.marker.state, work.losses![0]!.confirmed.commit], ['preservation-gate-refused', 'present', null]);
  // The gate never looked at marker refs (it asks about the Work branch only): the one read is the loss record's.
  assert.deepEqual(h.markerReads, [work.work_id]);
});

test('V2-02 Remover: the cleanup of a Work deletes its loss marker refs and records it, and touches neither another Work\'s marker nor the base', async t => {
  const root = await sandboxRoot(t);
  const { session } = await store(t, root);
  const work_id = await seedPublishedWork(session);
  await environment(root, work_id);
  // The Work ran without a persistent disk (its Execution carries Control's read of `origin`).
  await session.commit(async tx => { (await tx.doc(works, work_id, null)).work!.execution!.origin = { atStart: { state: 'absent' }, startCommit: main }; }, BACKGROUND_CONTEXT);
  const own = `refs/factory/lost/${work_id}/boot-6f2c1a52-0d6b-4a54-8a35-3d1f0f0c9a10`, foreign = 'refs/factory/lost/1c1f6c0e-5d0e-4c53-9d53-0a4f6f1f3c22/boot-6f2c1a52-0d6b-4a54-8a35-3d1f0f0c9a10';
  const github = { pull: merged(), branch: { 'factory/3-own': headSha, main: 'c'.repeat(40) } as Record<string, string>, markers: { [own]: lost, [foreign]: lost } as Record<string, string>, markersUnreadable: true };
  const repository = deliveryRepository(github);
  const log: string[] = [];
  const desk = createDeliveryDesk({ session, repository: repository.repository, repositories: [scope], cleanup: realCleanupPorts(root, log), running: () => false, interrupt: async () => {},
    readWorks: () => readWorks(session), stopped: () => false });
  await desk.cycle();
  const marker = async () => (await readWork(session, work_id))!.cleanup!.resources.find(item => item.kind === 'lost-markers')!;
  // An unreadable listing concludes nothing: recorded as indeterminate and the cleanup stays pending.
  assert.deepEqual([(await marker()).id, (await marker()).target, (await marker()).state, (await marker()).attempts.map(item => [item.outcome, item.code])],
    [`lost-markers:${work_id}`, `acme/project:refs/factory/lost/${work_id}/*`, 'indeterminate', [['indeterminate', 'GITHUB_QUERY_FAILED']]]);
  assert.equal((await readWork(session, work_id))!.cleanup!.state, 'pending');
  assert.deepEqual(Object.keys(github.markers), [own, foreign]);
  github.markersUnreadable = false;
  await desk.cycle();
  assert.deepEqual([(await marker()).state, (await marker()).attempts.map(item => item.outcome)], ['removed', ['indeterminate', 'removed']]);
  assert.deepEqual(Object.keys(github.markers), [foreign], 'only the marker refs of this Work');
  assert.equal(github.branch.main, 'c'.repeat(40));
  const calls = repository.calls.filter(call => call.method === 'cleanupLostMarkers').map(call => (call.args as { selection: { workId: string; repositoryId: number } }).selection);
  assert.deepEqual(calls.map(item => [item.workId, item.repositoryId]), [[work_id, 3], [work_id, 3]]);
  assert.equal((await readWork(session, work_id))!.cleanup!.state, 'complete');
  assert.equal((await readWork(session, work_id))!.result, 'delivered');
});
