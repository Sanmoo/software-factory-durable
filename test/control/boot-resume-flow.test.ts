import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ControlReceipt, ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, publishOwn, pushWip, sessionRef, type Activation, type GuestWorkspace, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// v2 ticket 08 (V2-11; MVP §5.5, §10.1), flow level: real Control + Pi Durable + temporary SQLite. Doubled: GitHub, clock, a Sandbox that
// declares NO persistent disk (every start is a new boot that clones the commit Control names), Workers and credentials. Each scenario
// starts where ticket 07 ends: a Question recorded, the gate accepted at a WIP commit, the boot stopped and the Slot released.
const main = 'b'.repeat(40), head = 'd'.repeat(40), wip = 'e'.repeat(40), third = 'f'.repeat(40), other = '9'.repeat(40);
const questionId = '11111111-2222-4333-8444-000000000001';
async function waiting(t: { after(fn: () => Promise<void>): void }, after: (guest: GuestWorkspace) => Script[] = () => []) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-boot-resume-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const github = githubDoubles(remote);
  const queue: Script[] = [];
  const execution = executionDoubles(remote, queue, { diskless: true });
  queue.push({ kind: 'ask', head: main, question: 'Which storage should the note use?', questionId }, { kind: 'publish', publish: pushWip(execution.guest, wip), end: 'success' }, ...after(execution.guest));
  execution.guest.untracked = 1;
  execution.guest.restored = { restored: ['spec/v1', 'instructions/v1'], from: 'boot-of-the-question', lost: [] };
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
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
  await settle('question ended with the gate accepted', value => value?.execution?.end?.outcome === 'question' && value.execution.end.cessation === 'confirmed' && !value.execution.slot.held);
  const asked = (await work())!;
  assert.equal(asked.preservation?.commit, wip);
  const answer = async () => { const receipt = (await control.accept({ request_id: 'answer-1', operation: 'answer', question_id: questionId, text: 'Use docs/note.md', origin: 'local-cli' })) as ControlReceipt;
    assert.equal('outcome' in receipt && receipt.outcome, 'accepted', JSON.stringify(receipt)); }
  const starts = () => execution.calls.filter(call => call.kind === 'start').map(call => call.detail as { commit: string; branch: string } | null);
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  const kinds = () => execution.calls.map(call => call.kind).filter(kind => ['prepare', 'start', 'activate', 'gate', 'stop'].includes(kind));
  const recoveries = async () => { const shown = await control.inspect({ kind: 'show', work_id: asked.work_id }); return 'work' in shown ? shown.work.budget?.recoveries.consumed : undefined; };
  return { remote, asked, work, settle, answer, starts, activations, kinds, recoveries, guest: execution.guest, branch: asked.branch! };
}
const resumed = (asked: WorkView) => (value: WorkView | undefined) => Boolean(value?.execution && value.execution.executionId !== asked.execution!.executionId && value.execution.start);

test('the answered Question resumes in a NEW boot cloned from the branch tip on origin, in the same session, starting with the fixed notice; later activations in that boot do not repeat it', async t => {
  const h = await waiting(t, () => [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  await h.answer();
  await h.settle('published in the new boot', value => value?.publication?.state === 'published');
  const work = (await h.work())!;
  const execution = [...work.previousExecutions, ...(work.execution ? [work.execution] : [])].at(-1) as ExecutionView;
  // A new boot from the tip of the branch on origin: the commit the gate confirmed. Nothing of the earlier boot is adopted.
  assert.deepEqual(h.starts(), [{ repository: 'acme/project', installationId: scope.installationId, commit: main, branch: h.branch }, { repository: 'acme/project', installationId: scope.installationId, commit: wip, branch: h.branch }]);
  assert.notEqual(execution.dispatch.boot, h.asked.execution!.dispatch.boot);
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'activate', 'gate', 'activate', 'gate', 'stop', 'prepare', 'start', 'activate', 'activate', 'gate', 'stop']);
  const [, , continued, publication] = h.activations() as [Activation, Activation, Activation, Activation];
  // The same session continues.
  assert.deepEqual([continued.phaseId, (continued.continuation as { session: unknown }).session, execution.request.session?.mode, execution.request.session?.reason], ['builder-continuation', sessionRef(1), 'continue', 'SESSION_COMPATIBLE']);
  assert.ok(continued.prompt.startsWith('Factory notice (new boot): this environment was RECREATED'), continued.prompt.slice(0, 200));
  assert.ok(continued.prompt.includes(`Starting commit: ${wip} (the tip of ${h.branch} on origin`));
  assert.match(continued.prompt, /Ignored files, installed packages, caches and Docker data .* no longer exist/);
  assert.ok(continued.prompt.includes(`No new commit on origin: the starting commit is the commit the Factory confirmed before the previous boot ended (${wip}).`));
  assert.match(continued.prompt, /Restored into \/artifacts .*: spec\/v1, instructions\/v1\./);
  assert.match(continued.prompt, /\ncontinue\nFactory continuation of the SAME session/);
  assert.ok(continued.prompt.includes('Use docs/note.md'));
  assert.doesNotMatch(continued.prompt, /were preserved/);
  // The notice is the boot's first activation only: the publication activation of the same boot has none.
  assert.equal(publication.executionId, execution.executionId);
  assert.doesNotMatch(publication.prompt, /Factory notice \(new boot\)/);
  // What the session saw is on the record, for the next boot (tickets 09 and 13 ask the same question).
  assert.equal(execution.sessionBoot, execution.dispatch.boot);
  assert.deepEqual(execution.bootNotice, { boot: execution.dispatch.boot, previousBoot: h.asked.execution!.dispatch.boot, startCommit: wip, confirmed: wip, commits: 0,
    restored: ['spec/v1', 'instructions/v1'], lost: false });
  assert.equal(h.asked.execution!.sessionBoot, h.asked.execution!.dispatch.boot);
  // A resume after a wait is not an operational recovery.
  assert.equal(await h.recoveries(), 0);
  assert.equal(execution.interruption ?? null, null);
});

test('commits of someone else on top of the confirmed commit keep the same session; the boot starts at the new tip and the notice lists them', async t => {
  const h = await waiting(t, () => [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  h.remote.refs![h.branch] = third;
  await h.answer();
  await h.settle('resumed', resumed(h.asked));
  const work = (await h.work())!;
  const execution = [...work.previousExecutions, ...(work.execution ? [work.execution] : [])].at(-1) as ExecutionView;
  assert.equal(h.starts().at(-1)?.commit, third);
  const continued = h.activations()[2]!;
  assert.deepEqual([continued.phaseId, (continued.continuation as { session: unknown }).session], ['builder-continuation', sessionRef(1)]);
  assert.ok(continued.prompt.includes(`Starting commit: ${third}`));
  assert.ok(continued.prompt.includes(`New commits on origin since the commit the Factory confirmed before the previous boot ended (${wip})`));
  assert.ok(continued.prompt.includes(`- ${third} Human edit on the Factory branch (operator-one)`));
  assert.deepEqual([execution.origin?.startCommit, execution.bootNotice?.confirmed, execution.bootNotice?.commits], [third, wip, 1]);
  assert.equal(await h.recoveries(), 0);
});

for (const [name, change, reason] of [
  ['rewritten history', (h: Awaited<ReturnType<typeof waiting>>) => { h.remote.refs![h.branch] = other;
    h.remote.comparisons = { [`${wip}...${other}`]: { state: 'complete', from: wip, to: other, status: 'diverged', aheadBy: 1, behindBy: 1, commits: [], files: [], truncated: false } }; }, 'ORIGIN_HISTORY_REWRITTEN'],
  ['a missing branch', (h: Awaited<ReturnType<typeof waiting>>) => { delete h.remote.refs![h.branch]; }, 'ORIGIN_BRANCH_ABSENT'],
] as const) {
  test(`${name} is a divergence: no boot is started from another commit, no Builder is activated and the Work is blocked for an explicit decision`, async t => {
    const h = await waiting(t);
    change(h);
    await h.answer();
    await h.settle('blocked', value => value?.impediments.some(item => item.code === 'RECOVERY_CONTEXT_INSUFFICIENT'));
    const work = (await h.work())!;
    assert.equal(h.starts().length, 1, 'only the boot of the Question ever started');
    assert.equal(h.activations().length, 2);
    const impediment = work.impediments.find(item => item.code === 'RECOVERY_CONTEXT_INSUFFICIENT')!;
    assert.ok(impediment.nextStep.includes(reason), impediment.nextStep);
    assert.ok(impediment.nextStep.includes(wip));
    assert.deepEqual([work.execution?.state, work.execution?.slot.held, work.execution?.held?.code], ['released', false, 'RECOVERY_CONTEXT_INSUFFICIENT']);
    assert.equal(work.preservation?.commit, wip, 'the confirmed commit stays on the record');
    assert.equal(await h.recoveries(), 0);
  });
}

test('an ancestry that could not be read decides nothing: no boot starts, and the resume happens once it is readable', async t => {
  const h = await waiting(t, () => [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  h.remote.refs![h.branch] = third;
  h.remote.comparisons = { [`${wip}...${third}`]: 'unknown' };
  await h.answer();
  await h.settle('released before start', value => value?.execution?.held?.nextStep === 'ORIGIN_COMPARISON_NOT_READ' || value?.previousExecutions.some(item => item.held?.nextStep === 'ORIGIN_COMPARISON_NOT_READ'));
  assert.equal(h.starts().length, 1);
  h.remote.comparisons = {};
  await h.settle('resumed', value => Boolean(value?.execution?.start && value.execution.bootNotice));
  assert.equal(h.starts().at(-1)?.commit, third);
  assert.equal((await h.work())!.impediments.some(item => item.code === 'RECOVERY_CONTEXT_INSUFFICIENT'), false);
});
