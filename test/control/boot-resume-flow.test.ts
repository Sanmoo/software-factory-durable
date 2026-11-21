import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ControlReceipt, ExecutionView, ListView, ShowView, WorkView } from '../../src/control/types.js';
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
  let calendar = 0;
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: { ...execution.ports, calendar: { now: () => Date.now() + calendar } },
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => untilHolds(label, async () => {
    if (predicate(await work())) return true;
    if (time.isSleeping()) { calendar += 60000; time.advance(); }
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
  const reply = async (question_id: string, text: string, request_id: string) => { const receipt = (await control.accept({ request_id, operation: 'answer', question_id, text, origin: 'local-cli' })) as ControlReceipt;
    assert.equal('outcome' in receipt && receipt.outcome, 'accepted', JSON.stringify(receipt)); };
  const question = async (questionId: string) => { const shown = await control.inspect({ kind: 'show', work_id: asked.work_id }); return (shown as Extract<ShowView, { kind: 'work' }>).questions.find(item => item.questionId === questionId)!; };
  return { remote, asked, work, settle, answer, reply, question, starts, activations, kinds, recoveries, guest: execution.guest, branch: asked.branch! };
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

// Operator decision 8 of 2026-11-21 (amends V2-11 where the sandbox keeps no disk; replaces ticket 08's block).
const rewrite = (h: Awaited<ReturnType<typeof waiting>>) => { h.remote.refs![h.branch] = other;
  h.remote.comparisons = { [`${wip}...${other}`]: { state: 'complete', from: wip, to: other, status: 'diverged', aheadBy: 1, behindBy: 1, commits: [], files: [], truncated: false } }; };

test('decision 8: rewritten history is followed: a SUBSTITUTE session starts at the new tip with the notice that the history changed, on one operational recovery, without a Question', async t => {
  const h = await waiting(t, () => [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  rewrite(h);
  await h.answer();
  // To the end: the substitute's verified commit is published on top of the followed tip, which is not taken for an unknown change.
  await h.settle('published on the followed history', value => Boolean(value?.execution?.bootNotice) && value?.publication?.state === 'published');
  assert.equal(h.remote.refs![h.branch], head);
  const work = (await h.work())!;
  const execution = work.execution!;
  // The Execution that found the rewrite never started anything: released, and the Work came back as ONE operational recovery.
  const found = work.previousExecutions.at(-1)!;
  assert.deepEqual([found.state, found.held?.code, found.start, found.dispatch.boot], ['released', 'ORIGIN_HISTORY_REWRITTEN', null, null]);
  assert.deepEqual([execution.charge?.kind, execution.charge?.state, await h.recoveries()], ['recovery', 'consumed', 1]);
  assert.deepEqual(work.originDivergence && [work.originDivergence.kind, work.originDivergence.confirmed, 'current' in work.originDivergence && work.originDivergence.current], ['history-rewritten', wip, other]);
  // The boot follows the remote: it starts at the rewritten tip.
  assert.deepEqual(h.starts().map(item => item?.commit), [main, other]);
  // A substitute session, never the old one; its first prompt starts with the notice naming both refs.
  const substitute = h.activations()[2]!;
  assert.deepEqual([substitute.phaseId, substitute.continuation, execution.request.session?.mode, execution.request.session?.reason], ['builder-recovery', null, 'replace', 'ORIGIN_HISTORY_REWRITTEN']);
  assert.ok(substitute.prompt.startsWith('Factory notice (new boot): this environment was RECREATED'), substitute.prompt.slice(0, 200));
  assert.ok(substitute.prompt.includes(`HISTORY CHANGED: the history of ${h.branch} on origin was rewritten while no environment existed. The commit the Factory confirmed before the previous boot ended (${wip}) is NOT an ancestor of the current tip (${other}).`));
  assert.ok(substitute.prompt.includes(`Starting commit: ${other}`));
  assert.ok(substitute.prompt.includes('Use docs/note.md'), 'the accepted answer still reaches the new session');
  assert.deepEqual([execution.bootNotice?.origin, execution.bootNotice?.confirmed, execution.bootNotice?.startCommit], ['rewritten', wip, other]);
  // No Question was asked about it and nothing blocks.
  assert.equal(work.questions?.length, 1);
  assert.deepEqual(work.impediments, []);
});

test('decision 8: a missing branch asks an ordinary Question; "restart" restarts the Work from the base with a substitute session and no operational recovery', async t => {
  const h = await waiting(t, () => [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  delete h.remote.refs![h.branch];
  await h.answer();
  await h.settle('asked', value => value?.originDivergence?.kind === 'branch-absent' && value.impediments.some(item => item.code === 'QUESTION_PENDING'));
  const asked = (await h.work())!;
  assert.equal(h.starts().length, 1, 'only the boot of the first Question ever started');
  assert.equal(h.activations().length, 2);
  assert.deepEqual([asked.execution?.state, asked.execution?.slot.held, asked.execution?.held?.code], ['released', false, 'ORIGIN_BRANCH_ABSENT']);
  const divergence = asked.originDivergence as Extract<NonNullable<WorkView['originDivergence']>, { kind: 'branch-absent' }>;
  assert.deepEqual([divergence.state, divergence.confirmed, divergence.branch], ['awaiting-answer', wip, h.branch]);
  assert.deepEqual(asked.impediments.map(item => item.code), ['QUESTION_PENDING']);
  const shown = await h.question(divergence.questionId);
  assert.match(shown.content.question, /no longer exists on origin/);
  assert.match(shown.content.question, /Reply exactly "restart" to restart the Work from the tip of the base main .* or exactly "end" to end the Work/);
  assert.ok(shown.content.question.includes(wip));
  // An answer that is neither keyword decides nothing: asked again.
  await h.reply(divergence.questionId, 'maybe later', 'r1');
  await h.settle('asked again', value => { const current = value?.originDivergence; return current?.kind === 'branch-absent' && current.questionId !== divergence.questionId && current.state === 'awaiting-answer'; });
  const again = (await h.work())!.originDivergence as typeof divergence;
  assert.equal(h.starts().length, 1);
  await h.reply(again.questionId, 'restart', 'r2');
  await h.settle('restarted', value => Boolean(value?.execution?.start && value.execution.bootNotice));
  const work = (await h.work())!;
  const execution = work.execution!;
  assert.deepEqual(h.starts().at(-1), { repository: 'acme/project', installationId: scope.installationId, commit: main, branch: h.branch });
  const substitute = h.activations()[2]!;
  assert.deepEqual([substitute.phaseId, substitute.continuation, execution.request.session?.reason, execution.bootNotice?.origin], ['builder-recovery', null, 'ORIGIN_BRANCH_ABSENT', 'restarted']);
  assert.ok(substitute.prompt.includes(`BRANCH GONE: ${h.branch} no longer exists on origin`));
  assert.ok(substitute.prompt.includes('The Operator answered to RESTART the Work from the base'));
  assert.ok(substitute.prompt.includes(`Starting commit: ${main} (the tip of the base main on origin`));
  assert.equal((work.originDivergence as typeof divergence).state, 'restart-authorized');
  assert.equal(await h.recoveries(), 0);
});

test('decision 8: a missing branch answered "end" ends the Work: cancelled, nothing started', async t => {
  const h = await waiting(t);
  delete h.remote.refs![h.branch];
  await h.answer();
  await h.settle('asked', value => value?.originDivergence?.kind === 'branch-absent' && value.impediments.some(item => item.code === 'QUESTION_PENDING'));
  const divergence = (await h.work())!.originDivergence as Extract<NonNullable<WorkView['originDivergence']>, { kind: 'branch-absent' }>;
  await h.reply(divergence.questionId, 'end', 'r1');
  await h.settle('cancelled', value => value?.result === 'cancelled');
  const work = (await h.work())!;
  assert.equal(h.starts().length, 1);
  assert.equal(h.activations().length, 2);
  assert.deepEqual([(work.originDivergence as typeof divergence).state, work.cancellation?.state, work.execution?.slot.held], ['end-authorized', 'ceased', false]);
});

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
