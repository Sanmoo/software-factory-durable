import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { sessionRef, app, executionDoubles, publishOwn, pushWip, type Activation, type GuestWorkspace, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// v2 ticket 07 (V2-05..V2-09), flow level: real Control + Pi Durable + temporary SQLite. Doubled: GitHub, clock, the Sandbox (declaring NO
// persistent disk, or the MVP one) with the guest workspace the preservation program would report, Workers and credentials. The scenarios
// end at "gate accepted, boot stopped with confirmed cessation, Slot released, confirmed commit recorded": resuming in a new boot is ticket 08.
const main = 'b'.repeat(40),
  head = 'd'.repeat(40),
  wip = 'e'.repeat(40);
async function harness(
  t: { after(fn: () => Promise<void>): void },
  remote: Remote,
  scripts: (guest: GuestWorkspace) => Script[],
  options: { diskless: boolean },
) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-preservation-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const queue: Script[] = [];
  const execution = executionDoubles(remote, queue, options);
  queue.push(...scripts(execution.guest));
  const time = manualClock();
  let calendar = 0;
  const control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: { ...execution.ports, calendar: { now: () => Date.now() + calendar } },
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    if (!stop.signal.aborted) {
      stop.abort();
      await running;
    }
  });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) =>
    untilHolds(
      label,
      async () => {
        if (predicate(await work())) return true;
        // The persisted recovery wait runs on the calendar: jumped, never slept.
        if (time.isSleeping()) {
          calendar += 60000;
          time.advance();
        }
        return false;
      },
      5,
    );
  const kinds = () => execution.calls.map(call => call.kind).filter(kind => ['prepare', 'start', 'activate', 'gate', 'stop', 'issue'].includes(kind));
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  return { execution, control, work, settle, kinds, activations, guest: execution.guest };
}
const ask = (questionId = '11111111-2222-4333-8444-000000000001'): Script => ({
  kind: 'ask',
  head: main,
  question: 'Which storage should the note use?',
  questionId,
});
/** The substitute's own push: its activation is the first one of its Execution, which names the branch in its package. */
const pushWipTo = (guest: GuestWorkspace, remote: Remote, activation: Activation, sha: string) => {
  const branch = /branch=(\S+)/.exec(activation.prompt)![1]!;
  Object.assign(guest, { head: sha, modified: 0, untracked: 0 });
  (remote.refs ??= {})[branch] = sha;
};
const released = (value: WorkView | undefined) => value?.execution?.end?.cessation === 'confirmed' && !value.execution.slot.held;

test('a Question on a sandbox without a persistent disk: the dirty workspace is refused, the refusal returns to the Builder, it publishes WIP without a PR, and only then the boot is stopped and the Slot released', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const h = await harness(t, remote, guest => [ask(), { kind: 'publish', publish: pushWip(guest, wip), end: 'success' }], { diskless: true });
  h.guest.untracked = 1;
  await h.settle('question ended', released);
  const work = (await h.work())!;
  const execution = work.execution!;
  assert.deepEqual([execution.end?.outcome, execution.end?.cessation, execution.slot.held], ['question', 'confirmed', false]);
  // Refused, returned to the Builder in the same boot, checked again, and only after the acceptance the boot stops.
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'gate', 'activate', 'gate', 'stop']);
  assert.deepEqual(
    execution.preservationGate?.attempts.map(item => [item.outcome, item.code, item.commit ?? null, item.correction?.status ?? null]),
    [
      ['refused', 'WORKSPACE_UNTRACKED', null, 'completed'],
      ['accepted', null, wip, null],
    ],
  );
  assert.equal(execution.preservationGate?.occasion, 'question');
  const [, correction] = h.activations() as [Activation, Activation];
  assert.deepEqual(
    [correction.phaseId, correction.executionId, correction.handoff, correction.editSourceMaxBytes],
    ['builder-preservation', execution.executionId, null, 8192],
  );
  assert.deepEqual(correction.pushPolicy, { branch: work.branch, head: main, expected: null, remote: 'https://github.com/acme/project.git', wip: true });
  assert.match(correction.prompt, /WORKSPACE_UNTRACKED: 1 untracked file\(s\) not ignored/);
  assert.ok(correction.prompt.includes(`git -C /workspace/checkout push https://github.com/acme/project.git HEAD:refs/heads/${work.branch}`));
  assert.match(correction.prompt, /No pull request is needed/);
  assert.match(correction.prompt, /does not authorize committing secrets/);
  assert.ok(correction.token, 'the correction runs with the grant of the Execution');
  // Final review, should-fix 6 (V2-07 "a recusa volta ao Builder"): the refusal goes to the SAME session that returned control, and the
  // session recorded with the end is that session as the correction left it.
  assert.deepEqual(correction.continuation, { session: sessionRef(1) });
  assert.deepEqual(execution.end?.session, sessionRef(2));
  // The confirmed commit is on the Work, for the resume in a new boot; no PR exists.
  assert.deepEqual(
    [work.preservation?.commit, work.preservation?.branch, work.preservation?.occasion, work.preservation?.executionId, work.preservation?.heads],
    [wip, work.branch, 'question', execution.executionId, [wip]],
  );
  assert.equal(remote.refs![work.branch!], wip);
  assert.deepEqual(remote.pulls, {});
  assert.deepEqual(
    work.impediments.map(item => item.code),
    ['QUESTION_PENDING'],
  );
  assert.deepEqual(
    work.history.filter(item => item.event.startsWith('preservation-')).map(item => item.event),
    ['preservation-refused', 'preservation-accepted'],
  );
});

test('after the Execution completed (CI and readiness waits follow) the gate also precedes the stop: leftovers are refused until the Builder removes them', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const h = await harness(
    t,
    remote,
    guest => [
      { kind: 'implement', head },
      {
        kind: 'publish',
        publish: (world, activation) => {
          publishOwn()(world, activation);
          guest.modified = 1;
        },
        end: 'success',
      },
      {
        kind: 'publish',
        publish: () => {
          guest.modified = 0;
        },
        end: 'success',
      },
    ],
    { diskless: true },
  );
  await h.settle('published', value => value?.publication?.state === 'published');
  const work = (await h.work())!;
  const [execution] = [...work.previousExecutions, ...(work.execution ? [work.execution] : [])] as [ExecutionView];
  assert.deepEqual([execution.end?.outcome, execution.end?.cessation, execution.slot.held], ['completed', 'confirmed', false]);
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'activate', 'gate', 'activate', 'gate', 'stop']);
  assert.deepEqual(
    execution.preservationGate?.attempts.map(item => [item.outcome, item.code]),
    [
      ['refused', 'WORKSPACE_MODIFIED'],
      ['accepted', null],
    ],
  );
  assert.equal(execution.preservationGate?.occasion, 'ci-wait');
  assert.deepEqual([work.preservation?.commit, work.preservation?.occasion], [head, 'ci-wait']);
  assert.match(h.activations()[2]!.prompt, /Do not open, close or edit pull requests here/);
  assert.deepEqual(work.impediments, []);
});

test('three refusals in a row in the same return of control end the boot at once as a LOSS with the diagnostic of the last one; a substitute resumes through the queue on one operational recovery (Operator decision 7 of 2026-11-21)', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const noop: Script = { kind: 'publish', publish: () => {}, end: 'success' };
  const h = await harness(
    t,
    remote,
    guest => [
      ask(),
      {
        kind: 'publish',
        publish: () => {
          guest.untracked = 0;
          guest.stashes = 2;
        },
        end: 'success',
      },
      noop,
      // The substitute, after the answer: it publishes what it concludes.
      {
        kind: 'publish',
        publish: (world, activation) => {
          guest.stashes = 0;
          pushWipTo(guest, world, activation, wip);
        },
        end: 'success',
      },
    ],
    { diskless: true },
  );
  h.guest.untracked = 1;
  await h.settle('loss recorded', value => value?.losses?.length === 1 && !value.execution?.slot.held);
  const lost = (await h.work())!;
  const execution = lost.execution!;
  assert.deepEqual(
    execution.preservationGate?.attempts.map(item => [item.outcome, item.code]),
    [
      ['refused', 'WORKSPACE_UNTRACKED'],
      ['refused', 'STASH_PRESENT'],
      ['refused', 'STASH_PRESENT'],
    ],
  );
  // Two corrections were requested; the third refusal ends the boot instead of asking again or waiting for the Operator.
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'gate', 'activate', 'gate', 'activate', 'gate', 'stop']);
  assert.deepEqual(
    [execution.end?.outcome, execution.end?.code, execution.held, execution.slot.held, execution.credentialLifecycle?.state],
    ['failure', 'PRESERVATION_GATE_REFUSED', null, false, 'withdrawn'],
  );
  const [loss] = lost.losses!;
  assert.deepEqual(
    [loss!.cause, loss!.executionId, loss!.boot, loss!.reason],
    [
      'preservation-gate-refused',
      execution.executionId,
      execution.dispatch.boot,
      'Ended by the Factory: the preservation gate refused 3 time(s) in a row before question (last: STASH_PRESENT: 2 stash entr(ies)).',
    ],
  );
  // The stop was asked as a loss. Nothing waits for the Operator about the gate: the only impediment is the Builder's own Question.
  assert.deepEqual(
    h.execution.calls.filter(call => call.kind === 'stop').map(call => call.detail),
    ['loss'],
  );
  assert.deepEqual(
    lost.impediments.map(item => item.code),
    ['QUESTION_PENDING'],
  );
  assert.equal(lost.preservation, undefined, 'the gate confirmed nothing');
  assert.equal(lost.pendingRecovery?.reason, 'interrupted:PRESERVATION_GATE_REFUSED');
  const receipt = await h.control.accept({
    request_id: 'answer-7',
    operation: 'answer',
    question_id: '11111111-2222-4333-8444-000000000001',
    text: 'Use docs/note.md',
    origin: 'local-cli',
  });
  assert.equal('outcome' in receipt && receipt.outcome, 'accepted', JSON.stringify(receipt));
  await h.settle(
    'substitute ended',
    value => value?.execution?.executionId !== execution.executionId && value?.execution?.end?.outcome === 'completed' && !value.execution.slot.held,
  );
  const work = (await h.work())!;
  const substitute = work.execution!;
  assert.deepEqual(
    [substitute.interruption?.reason, substitute.interruption?.code, substitute.charge?.kind, substitute.charge?.state],
    ['OPERATIONAL_RECOVERY', 'PRESERVATION_GATE_REFUSED', 'recovery', 'consumed'],
  );
  const package_ = h.activations().find(item => item.executionId === substitute.executionId)!;
  assert.equal(package_.continuation, null);
  assert.ok(
    package_.prompt.includes(
      'was ended by the Factory because its work was not published (Ended by the Factory: the preservation gate refused 3 time(s) in a row before question',
    ),
    package_.prompt,
  );
  // The answer already given travels with the package: it is never asked again.
  assert.ok(package_.prompt.includes('Use docs/note.md'));
  assert.deepEqual(
    [substitute.preservationGate?.occasion, substitute.preservationGate?.attempts.map(item => item.outcome), work.preservation?.commit],
    ['substitute-end', ['accepted'], wip],
  );
});

test('an unreachable remote is refused under its own reason, returned to the Builder like any refusal, and after three in a row the boot ends as a loss while the Question stays pending', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const h = await harness(t, remote, () => [ask()], { diskless: true });
  h.guest.remoteDown = true;
  await h.settle('loss recorded', value => value?.losses?.length === 1 && !value.execution?.slot.held);
  const work = (await h.work())!;
  const execution = work.execution!;
  assert.deepEqual(
    execution.preservationGate?.attempts.map(item => item.code),
    ['REMOTE_UNAVAILABLE', 'REMOTE_UNAVAILABLE', 'REMOTE_UNAVAILABLE'],
  );
  assert.equal(h.kinds().filter(kind => kind === 'activate').length, 3, 'the Builder is asked to retry the publication: a remote that answers again passes');
  assert.deepEqual([execution.end?.outcome, execution.end?.code, execution.credentialLifecycle?.state], ['failure', 'PRESERVATION_GATE_REFUSED', 'withdrawn']);
  // The Question is recorded and still the only thing the Work waits for; the substitute starts after its answer.
  assert.deepEqual(
    work.impediments.map(item => item.code),
    ['QUESTION_PENDING'],
  );
  assert.equal(work.pendingRecovery?.reason, 'interrupted:PRESERVATION_GATE_REFUSED');
  assert.equal(h.kinds().filter(kind => kind === 'start').length, 1);
});

test('with a sandbox that declares a persistent disk no gate is asked and a Question ends as in the MVP', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const h = await harness(t, remote, () => [ask()], { diskless: false });
  h.guest.untracked = 1;
  await h.settle('question ended', released);
  const work = (await h.work())!;
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'stop']);
  assert.deepEqual([work.execution!.end?.outcome, work.execution!.preservationGate, work.preservation], ['question', undefined, undefined]);
  assert.equal(work.execution!.credentialLifecycle?.reason, 'external-wait');
});
