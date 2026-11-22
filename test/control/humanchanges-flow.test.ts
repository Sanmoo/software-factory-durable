import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlReceipt, ExecutionView, ListView, QuestionView, WorkView } from '../../src/control/types.js';
import { comment, githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { untilHolds } from '../runner/budget.js';
import { app, executionDoubles, facts, humanPush, leasedPublish, ownPull, pushAs, type Activation, type Script } from './publication-doubles.js';

// Flow level (S) of ticket 21: real Control + Pi Durable + temporary SQLite with ticket 13's REAL review rounds/verification and ticket 14's
// REAL publication/discovery. Doubled: GitHub (with Git lease semantics on the own branch), clock, Sandbox, Workers (scripted Builder whose
// Host capture reports the ancestry check), credentials. Not evidence of real Git, GitHub, VM, model or reviewers.
const factory = 'd'.repeat(40);
const updated = 'e'.repeat(40);
const reconciled = 'f'.repeat(40);
const human = '1'.repeat(40);
const again = '2'.repeat(40);
const operator = { id: 5, login: 'operator-one', type: 'User' };
const skew = { ms: 0 };

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[]) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-humanchanges-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const execution = executionDoubles(remote, scripts);
  // Calendar of the persisted recovery waits (ticket 26): advanced by the test, never slept.
  execution.ports.calendar = { now: () => Date.now() + skew.ms };
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } = { control, stop, running: control.run(stop.signal), time };
  await time.sleeping();
  t.after(async () => { if (!current!.stop.signal.aborted) { current!.stop.abort(); await current!.running; } });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView;
  // Ticket 40: bounded by the runner budget, never an iteration count.
  const settle = async (predicate: () => Promise<boolean>, label: string) => {
    await untilHolds(label, async () => {
      if (await predicate()) return true;
      if (current!.time.isSleeping()) current!.time.advance();
      return false;
    }, 5);
  };
  const cycles = async (n: number) => { for (let i = 0; i < n; i++) { current!.time.advance(); await current!.time.sleeping(); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  const question = async (id: string) => (await current!.control.inspect({ kind: 'question', question_id: id })) as unknown as { question: QuestionView };
  const answer = (question_id: string, text: string) => current!.control.accept({ request_id: `answer-${question_id}-${text.length}`, operation: 'answer', question_id, text,
    origin: 'local-cli' }) as Promise<ControlReceipt>;
  /** First publication (ticket 14), then a scope update produces a NEW verified basis whose publication is an UPDATE of the own branch. */
  async function publishedThenUpdated(beforeUpdate: (branch: string) => void) {
    await settle(async () => (await work())?.publication?.state === 'published', 'first publication');
    const { work_id, branch } = await work();
    beforeUpdate(branch!);
    const accepted = await current!.control.accept({ request_id: 'scope-1', operation: 'update-scope', work_id, reason: 'Also mention the rollback owner in the smoke page (only that).',
      origin: 'local-cli' });
    assert.equal((accepted as { outcome?: string }).outcome, 'accepted');
    return { work_id, branch: branch! };
  }
  return { github, execution, work, settle, cycles, activations, question, answer, publishedThenUpdated, control: () => current!.control };
}
const executionsOf = (work: WorkView): ExecutionView[] => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];
const lastDivergence = (work: WorkView) => work.publication!.divergences!.at(-1)!;

test('AC3/AC4/AC5/AC7: a human push before the update blocks the write and asks; "incorporate" reconciles preserving it and publishes with a lease on exactly it', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'implement', head: reconciled }, { kind: 'publish', publish: leasedPublish, end: 'success' }]);
  remote.graph = { [reconciled]: [human] }; // the reconciliation rebased the Factory commits onto the human commit
  const { branch } = await h.publishedThenUpdated(branch => humanPush(remote, branch, human));
  await h.settle(async () => (await h.work()).publication?.state === 'diverged', 'diverged');
  let work = await h.work();
  const divergence = lastDivergence(work);
  assert.deepEqual([divergence.trigger, divergence.current, divergence.expected, divergence.local, divergence.state, divergence.pullRequest?.number],
    ['update', human, { state: 'present', sha: factory }, updated, 'awaiting-answer', 4]);
  assert.ok(divergence.comparison.state === 'complete' && divergence.comparison.commits[0]!.author?.login === 'operator-one', 'authorship as GitHub links it');
  assert.ok(work.impediments.some(item => item.code === 'HUMAN_CHANGE_RECONCILIATION') && work.impediments.some(item => item.code === 'QUESTION_PENDING' && item.questionId === divergence.questionId));
  assert.deepEqual(work.publication!.verified!.head, updated, 'the local result is preserved, not discarded');
  // The Question is durable and published on the Ticket (the controller's only write) with the concrete facts and the proposal.
  const asked = (await h.question(divergence.questionId)).question;
  assert.equal(asked.recordedFrom, 'controller-divergence');
  for (const fact of [branch, `Current remote tip: ${human}`, `Local Factory result (verified, not pushed): ${updated}`, 'incorporate', `discard ${human}`]) assert.ok(asked.content.question.includes(fact), fact);
  await h.settle(async () => (await h.question(divergence.questionId)).question.publication.state === 'published', 'question published');
  const publishesBefore = h.activations().filter(item => item.phaseId === 'builder-publication').length;
  await h.cycles(3);
  assert.equal(h.activations().length, 3, 'nothing written or activated while the Question is open');
  assert.equal(remote.refs![branch], human, 'the human commit is untouched');
  const budget = JSON.stringify((await h.work()).budget);
  // The operator answers on the Ticket (authorized comment): incorporate.
  (remote.comments ??= {})[3] = [...(remote.comments?.[3] ?? []), comment(`/factory answer ${divergence.questionId} incorporate`, operator)];
  await h.settle(async () => (await h.work()).publication?.state === 'published' && (await h.work()).publication!.verified!.head === reconciled, 'reconciled and published');
  work = await h.work();
  const reconciliation = executionsOf(work).find(item => item.request.resume?.reason === 'RECONCILIATION_AUTHORIZED')!;
  assert.deepEqual(reconciliation.request.reconciliation, { divergenceId: divergence.divergenceId, questionId: divergence.questionId,
    answerSha256: (await h.question(divergence.questionId)).question.answer!.sha256, expected: { state: 'present', sha: factory }, authorizedRemote: human, localHead: updated,
    strategy: 'rebase-unless-agents-documents-another' });
  const [, , , reconcile, publish] = h.activations();
  assert.equal(reconcile!.phaseId, 'builder-reconciliation');
  assert.deepEqual(reconcile!.handoff, { baseCommit: 'a'.repeat(40), rounds: { first: 5, max: 4 }, preserve: human }, 'every capture checks the authorized tip as an ancestor');
  assert.match(reconcile!.token, /Start/, 'the reconciliation never holds a write grant');
  assert.ok(reconcile!.prompt.startsWith('Factory reconciliation instruction') && reconcile!.prompt.includes(`rebase ${human}`));
  assert.ok(reconcile!.prompt.includes('declare EVERY documented Validation gate') && reconcile!.prompt.includes(`"questionId": "${divergence.questionId}"`), 'v5: gate and findings duties');
  assert.equal(publish!.phaseId, 'builder-publication');
  assert.ok(publish!.prompt.includes(`--force-with-lease=refs/heads/${branch}:${human} https://github.com/acme/project.git ${reconciled}:refs/heads/${branch}`), 'lease on exactly the authorized tip');
  assert.deepEqual(publish!.pushPolicy, { branch, head: reconciled, expected: human, remote: 'https://github.com/acme/project.git' }, 'the Builder Host allows only that exact push');
  assert.equal(reconcile!.pushPolicy, null, 'no push at all in the reconciliation');
  assert.equal(h.activations().filter(item => item.phaseId === 'builder-publication').length, publishesBefore + 1);
  assert.equal(remote.refs![branch], reconciled);
  assert.deepEqual([work.publication!.reconciliation!.state, lastDivergence(work).state], ['consumed', 'resolved']);
  assert.ok(work.publication!.linkedHeads!.includes(reconciled));
  assert.equal(JSON.stringify(work.budget), budget, 'the answer renews no budget');
  assert.deepEqual(reconciliation.request.scopeUpdateIds, [], 'the answer is not a scope update');
  assert.ok(!work.impediments.length, JSON.stringify(work.impediments));
  await h.cycles(3);
  assert.equal(h.activations().length, 5, 'nothing repeated');
});

test('AC3/AC5/AC7: a human push racing the publication makes the lease FAIL; nothing is retried; after "incorporate" a NEW change asks again', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const racing = (remote: Remote, activation: Activation) => { humanPush(remote, /your branch (\S+);/.exec(activation.prompt)![1]!, human); leasedPublish(remote, activation); };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'publish', publish: racing, end: 'success' },
    // The reconciliation preserves `human`, but meanwhile the human pushes AGAIN.
    { kind: 'implement', head: reconciled, during: remote => humanPush(remote, Object.keys(remote.refs!).find(name => name.startsWith('factory/'))!, again) }]);
  const { branch } = await h.publishedThenUpdated(() => {});
  await h.settle(async () => (await h.work()).publication?.state === 'diverged', 'diverged after the failed lease');
  let work = await h.work();
  const first = lastDivergence(work);
  assert.deepEqual([first.trigger, first.current, first.expected], ['lease-failed', human, { state: 'present', sha: factory }]);
  assert.ok(work.publication!.reasons.includes('LEASE_FAILED'));
  assert.deepEqual(work.publication!.attempts!.map(item => [item.head, item.expectedRemote]), [[factory, { state: 'absent' }], [updated, { state: 'present', sha: factory }]],
    'the expectation used by the failed push is preserved, never replaced by the tip read afterwards');
  await h.cycles(3);
  assert.equal(h.activations().length, 4, 'the lease failure is never retried automatically with a recaptured tip');
  assert.equal(remote.refs![branch], human);
  assert.equal((await h.answer(first.questionId, 'incorporate')).kind, 'durable');
  await h.settle(async () => (await h.work()).publication?.state === 'diverged' && lastDivergence(await h.work()).divergenceId !== first.divergenceId, 'a new divergence');
  work = await h.work();
  const second = lastDivergence(work);
  assert.deepEqual([second.current, second.expected, second.trigger], [again, { state: 'present', sha: human }, 'update'], 'evaluated against the authorized tip');
  assert.deepEqual([work.publication!.reconciliation!.state, work.publication!.divergences!.find(item => item.divergenceId === first.divergenceId)!.state], ['superseded', 'superseded']);
  assert.notEqual(second.questionId, first.questionId);
  await h.cycles(3);
  assert.equal(h.activations().filter(item => item.phaseId === 'builder-publication').length, 2, 'no publication over the new change without a new answer');
  assert.equal(remote.refs![branch], again, 'both human changes are on the branch');
});

test('AC4/AC5: an answer that is not an authorization asks again; "discard <tip>" publishes the verified result with a lease on exactly that tip', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'publish', publish: leasedPublish, end: 'success' }]);
  const { branch } = await h.publishedThenUpdated(branch => humanPush(remote, branch, human));
  await h.settle(async () => (await h.work()).publication?.state === 'diverged', 'diverged');
  const first = lastDivergence(await h.work());
  await h.answer(first.questionId, 'ok');
  await h.settle(async () => lastDivergence(await h.work()).divergenceId !== first.divergenceId, 'asked again');
  let work = await h.work();
  assert.deepEqual([work.publication!.divergences![0]!.state, work.publication!.divergences![0]!.answer!.code], ['not-authorized', 'ANSWER_NOT_AN_AUTHORIZATION']);
  assert.equal(h.activations().length, 3, 'a generic approval authorizes nothing');
  const second = lastDivergence(work);
  await h.answer(second.questionId, `discard ${human}`);
  await h.settle(async () => (await h.work()).publication?.state === 'published' && remote.refs![branch] === updated, 'discarded explicitly and published');
  work = await h.work();
  const publish = h.activations().at(-1)!;
  assert.ok(publish.prompt.includes(`--force-with-lease=refs/heads/${branch}:${human} https://github.com/acme/project.git ${updated}:refs/heads/${branch}`));
  assert.equal(h.activations().filter(item => item.phaseId === 'builder-reconciliation').length, 0, 'discard needs no reconciliation Execution');
  assert.deepEqual([work.publication!.reconciliation!.mode, work.publication!.reconciliation!.state, lastDivergence(work).state], ['discard', 'consumed', 'resolved']);
  assert.ok(work.publication!.divergences!.every(item => item.comparison.state === 'complete'), 'the discarded commits stay recorded with their authorship');
});

test('AC6: a changed base of the own PR blocks continuation until restored; the mere advance of the base triggers no work', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'publish', publish: leasedPublish, end: 'success' }]);
  await h.settle(async () => (await h.work())?.publication?.state === 'published', 'published');
  // The base advances (another merge on main): zero Executions, reviews, rebases or drafts.
  remote.main = 'c'.repeat(40);
  const reads = h.github.calls.length;
  await h.cycles(3);
  assert.equal(h.activations().length, 2);
  assert.equal(h.github.calls.slice(reads).filter(call => call.method === 'findPublication' && (call.args as { knownBranches: string[] }).knownBranches.length).length, 0,
    'no discovery or update for a published Work whose base merely advanced');
  await h.publishedThenUpdated(() => { remote.pulls[3]![0]!.baseRef = 'release'; });
  await h.settle(async () => (await h.work()).publication?.state === 'base-changed', 'base changed');
  let work = await h.work();
  assert.deepEqual(work.publication!.baseChange && [work.publication!.baseChange.from, work.publication!.baseChange.to], ['main', 'release']);
  assert.ok(work.impediments.some(item => item.code === 'BASE_TARGET_CHANGED'));
  await h.cycles(3);
  assert.equal(h.activations().length, 3, 'no publication while the base differs');
  remote.pulls[3]![0]!.baseRef = 'main';
  await h.settle(async () => (await h.work()).publication?.state === 'published' && (await h.work()).publication!.verified!.head === updated, 'restored and updated');
  work = await h.work();
  // Review MED: the restoring read decided nothing; a later complete read re-evaluated before the update was requested.
  const discoveries = work.publication!.discoveries;
  const restoredAt = discoveries.map(item => item.outcome).lastIndexOf('base-changed') + 1;
  assert.ok(discoveries.length - restoredAt >= 3, JSON.stringify(discoveries.map(item => item.outcome)));
  const restoreIndex = work.history.findIndex(item => item.event === 'publication-base-restored');
  const requestIndex = work.history.findIndex((item, index) => index > restoreIndex && item.event === 'publication-requested');
  assert.ok(restoreIndex >= 0 && requestIndex > restoreIndex);
  assert.ok(!work.impediments.some(item => item.code === 'BASE_TARGET_CHANGED'));
  assert.ok(work.history.some(item => item.event === 'publication-base-restored'));
});

test('review HIGH: a Builder that recaptures the lease and pushes over a human commit is NEVER linked: LOST_HUMAN_CHANGE Question; only an exact discard accepts it', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  // The model ignores the instruction: after its leased push is rejected it pushes again with the NEW tip as its lease.
  const attack = (remote: Remote, activation: Activation) => {
    const { workId, branch, head } = facts(activation.prompt);
    humanPush(remote, branch, human);
    pushAs(remote, branch, head, { login: app.login, id: app.id });
    remote.pulls[3] = (remote.pulls[3] ?? []).map(pull => pull.headRef === branch ? { ...pull, headSha: head } : pull);
    void workId; void ownPull;
  };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'publish', publish: attack, end: 'success' }]);
  const { branch } = await h.publishedThenUpdated(() => {});
  await h.settle(async () => (await h.work()).publication?.state === 'diverged', 'diverged');
  let work = await h.work();
  const lost = lastDivergence(work);
  assert.deepEqual([lost.kind, lost.current, work.publication!.reasons[0]], ['lost', human, `LOST_HUMAN_CHANGE:${human}`]);
  assert.equal(work.publication!.pullRequest!.headSha, factory, 'the head that dropped the human commit is never linked');
  assert.ok(!work.publication!.linkedHeads!.includes(updated));
  assert.match((await h.question(lost.questionId)).question.content.question, new RegExp(`does NOT preserve commit ${human}`));
  await h.answer(lost.questionId, 'incorporate');
  await h.settle(async () => lastDivergence(await h.work()).divergenceId !== lost.divergenceId, 'asked again');
  work = await h.work();
  assert.equal(work.publication!.divergences!.find(item => item.divergenceId === lost.divergenceId)!.answer!.code, 'LOST_CHANGE_NOT_INCORPORABLE');
  const again = lastDivergence(work);
  assert.equal(again.kind, 'lost');
  await h.answer(again.questionId, `discard ${human}`);
  await h.settle(async () => (await h.work()).publication?.state === 'published', 'linked after the explicit discard');
  work = await h.work();
  assert.deepEqual([work.publication!.pullRequest!.headSha, work.publication!.waived!.includes(human)], [updated, true]);
  assert.equal(remote.refs![branch], updated);
});

test('review MED: a reconciled head that reverts the human file is not linked (ancestry is not enough); a reconciliation that fails asks again', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'implement', head: reconciled }, { kind: 'publish', publish: leasedPublish, end: 'success' }]);
  remote.graph = { [reconciled]: [human] };
  remote.changes = { [`${human}...${reconciled}`]: ['docs/a.md'] }; // the human commit changed docs/a.md (default comparison) and the result changes it again
  await h.publishedThenUpdated(branch => humanPush(remote, branch, human));
  await h.settle(async () => (await h.work()).publication?.state === 'diverged', 'diverged');
  await h.answer(lastDivergence(await h.work()).questionId, 'incorporate');
  await h.settle(async () => lastDivergence(await h.work()).kind === 'lost', 'lost after the publication');
  const work = await h.work();
  assert.ok(work.publication!.reasons.includes('HUMAN_CONTENT_CHANGED:docs/a.md'));
  assert.notEqual(work.publication!.pullRequest!.headSha, reconciled, 'not linked');
  assert.equal(work.publication!.reconciliation!.state, 'superseded', 'never consumed by an unlinked head; the new Question replaces it');

  const other: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const g = await harness(t, other, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'implement', head: reconciled, preserves: false }]);
  await g.publishedThenUpdated(branch => humanPush(other, branch, human));
  await g.settle(async () => (await g.work()).publication?.state === 'diverged', 'diverged');
  const first = lastDivergence(await g.work());
  await g.answer(first.questionId, 'incorporate');
  await g.settle(async () => (await g.work()).publication!.divergences!.length === 2, 'asked again after the failed reconciliation');
  const failed = await g.work();
  assert.deepEqual([failed.publication!.reconciliation!.state, failed.publication!.reconciliation!.failure], ['failed', ['HUMAN_CHANGE_NOT_PRESERVED']]);
  assert.ok(failed.history.some(item => item.event === 'reconciliation-failed'));
  assert.equal(failed.publication!.verified!.head, updated, 'the earlier verified result is kept');
  assert.equal(g.activations().filter(item => item.phaseId === 'builder-publication').length, 1, 'nothing published from the failed reconciliation');
});

test('review MED: an authorized reconciliation takes precedence over a pending scope update, which stays pending (never delivered to it)', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'implement', head: reconciled }]);
  remote.graph = { [reconciled]: [human] };
  const { work_id } = await h.publishedThenUpdated(branch => humanPush(remote, branch, human));
  await h.settle(async () => (await h.work()).publication?.state === 'diverged', 'diverged');
  const accepted = await h.control().accept({ request_id: 'scope-2', operation: 'update-scope', work_id, reason: 'Also add a one-line changelog note for the smoke page (only that).', origin: 'local-cli' });
  assert.equal((accepted as { outcome?: string }).outcome, 'accepted');
  await h.answer(lastDivergence(await h.work()).questionId, 'incorporate');
  await h.settle(async () => h.activations().some(item => item.phaseId === 'builder-reconciliation'), 'reconciliation first');
  const work = await h.work();
  const reconciliation = executionsOf(work).find(item => item.request.resume?.reason === 'RECONCILIATION_AUTHORIZED')!;
  assert.deepEqual([reconciliation.request.scopeUpdateIds, reconciliation.request.resume!.scopeUpdateIds], [[], []]);
  assert.equal(work.scopeUpdates!.find(item => item.reason.startsWith('Also add a one-line'))!.state, 'pending');
});

test('real run q21-human-v1: a PUBLISHED Work with an accepted scope update is dispatched exactly once (SCOPE_UPDATED) and its update published with a lease', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'publish', publish: leasedPublish, end: 'success' }]);
  const { branch } = await h.publishedThenUpdated(() => {});
  await h.settle(async () => (await h.work()).publication?.state === 'published' && (await h.work()).publication!.verified!.head === updated, 'update published');
  const work = await h.work();
  const update = executionsOf(work).filter(item => item.request.resume?.reason === 'SCOPE_UPDATED');
  assert.equal(update.length, 1, 'exactly one update Execution');
  assert.equal(h.activations().filter(item => item.phaseId !== 'builder-publication').length, 2);
  assert.ok(h.activations().at(-1)!.prompt.includes(`--force-with-lease=refs/heads/${branch}:${factory}`));
  await h.cycles(3);
  assert.equal(h.activations().length, 4, 'nothing more');
});

test('real run q21-human-v4: a reconciliation interrupted by a provider failure is RECOVERED with the same reconciliation and publishes with the lease on the authorized tip', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: factory }, { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated }, { kind: 'implement', head: reconciled, failure: 'WORKER_INTERRUPTED' }, { kind: 'implement', head: reconciled },
    { kind: 'publish', publish: leasedPublish, end: 'success' }]);
  remote.graph = { [reconciled]: [human] };
  const { branch } = await h.publishedThenUpdated(branch => humanPush(remote, branch, human));
  await h.settle(async () => (await h.work()).publication?.state === 'diverged', 'diverged');
  await h.answer(lastDivergence(await h.work()).questionId, 'incorporate');
  await h.settle(async () => Boolean((await h.work()).pendingRecovery), 'interrupted reconciliation awaits its operational recovery');
  assert.equal((await h.work()).publication!.reconciliation!.state, 'executing');
  skew.ms = 60 * 60 * 1000; // past the persisted wait
  t.after(() => { skew.ms = 0; });
  await h.settle(async () => (await h.work()).publication?.state === 'published' && (await h.work()).publication!.verified!.head === reconciled, 'recovered and published');
  const work = await h.work();
  const runs = h.activations().filter(item => item.phaseId === 'builder-reconciliation');
  assert.equal(runs.length, 2, 'the interrupted reconciliation and its recovery');
  assert.deepEqual(runs.map(item => (item.handoff as { preserve?: string }).preserve), [human, human], 'the recovery keeps the preservation check');
  assert.ok(runs[1]!.prompt.startsWith('Factory reconciliation continues') && runs[1]!.prompt.includes(`rev-parse FETCH_HEAD must print exactly ${human}`));
  const recovery = executionsOf(work).find(item => item.interruption && item.request.reconciliation)!;
  assert.deepEqual([recovery.request.resume, recovery.request.reconciliation!.authorizedRemote, recovery.request.scopeUpdateIds], [null, human, []]);
  const publish = h.activations().at(-1)!;
  assert.ok(publish.prompt.includes(`--force-with-lease=refs/heads/${branch}:${human} `), 'lease on exactly the authorized tip');
  assert.deepEqual([work.publication!.reconciliation!.state, remote.refs![branch]], ['consumed', reconciled]);
});
