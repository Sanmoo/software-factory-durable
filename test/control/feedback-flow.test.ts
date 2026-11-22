import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlReceipt, ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import type { ConversationCommentFact, ReviewFact } from '../../src/code-repository/index.js';
import { comment, githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, leasedPublish, type Activation, type Script } from './publication-doubles.js';
import { observedPull } from './readiness-seed.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (S) of ticket 23: real Control + Pi Durable + temporary SQLite with the REAL ticket 13 reviews/verification, ticket 14
// publication (lease semantics), ticket 15 checks, ticket 16 readiness, ticket 22 repair desk and the ticket 23 feedback desk/commands.
// Doubled: GitHub (reviews/comments as the CodeRepository/IssueTracker contracts report them), clock, Sandbox, Workers (scripted Builder
// and reviewers), credentials. Not evidence of real GitHub reviews, Git, VM, model or reviewers.
const first = 'd'.repeat(40), second = 'e'.repeat(40), third = 'f'.repeat(40);
const operator = { id: 7, login: 'operator-one', type: 'User' };
const stranger = { id: 9, login: 'stranger', type: 'User' };

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[], limits: { correctionLimit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-feedback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const execution = executionDoubles(remote, scripts);
  const time = manualClock();
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...limits }], operators: [{ login: 'operator-one', id: 7 }], factoryApp: async () => app },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await time.sleeping();
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const list = async () => (await control.inspect({ kind: 'list' })) as ListView;
  const work = async () => (await list()).works[0] as WorkView;
  // Ticket 40: bounded by the runner budget, never an iteration count.
  const settle = async (predicate: (work: WorkView) => boolean, label: string) => {
    let last: WorkView | undefined;
    await untilHolds(() => `${label}: ${JSON.stringify({ correction: last?.correction ?? null, feedback: last?.feedback ?? null, h: last?.history.slice(-8) ?? null })}`, async () => {
      last = await work();
      if (predicate(last)) return true;
      if (time.isSleeping()) time.advance();
      return false;
    }, 5);
  };
  const cycles = async (n: number) => { for (let i = 0; i < n; i++) { time.advance(); await time.sleeping(); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  const pause = (operation: 'pause' | 'unpause', n: number) => control.accept({ request_id: `${operation}-${n}`, operation, origin: 'local-cli' });
  const repair = async (n: number, reason: string) => (await control.accept({ request_id: `repair-${n}`, operation: 'repair', work_id: (await work()).work_id, reason, origin: 'local-cli' })) as ControlReceipt;
  return { github, execution, list, work, settle, cycles, activations, pause, repair, control };
}
/** The ticket 15 observation of the own PR #4 at `sha` (clean, mergeable): no effective impediment by itself. */
function observe(remote: Remote, sha: string) {
  const branch = Object.keys(remote.refs ?? {}).find(name => name.startsWith('factory/'))!;
  const observed = observedPull({ headSha: sha, recheckHead: sha });
  observed.pullRequest = { ...observed.pullRequest, pullRequestId: 9004, nodeId: 'PR_node4', number: 4, url: 'https://github.com/acme/project/pull/4', headRef: branch };
  observed.final = { baseTip: observed.baseTip, classic: observed.classic, rules: observed.rules };
  (remote.pullRequests ??= {})[4] = observed;
}
const publishAt = (sha: string) => (remote: Remote, activation: Activation) => { leasedPublish(remote, activation); observe(remote, sha); };
let reviewSequence = 500;
const review = (state: string, author: ReviewFact['author'], commitId: string, body: string): ReviewFact => {
  const id = ++reviewSequence;
  // Submitted now (after the Work's admission): a review older than the Work never triggers it.
  return { reviewId: id, author, state, commitId, submittedAt: new Date(Date.now() + id).toISOString(), body, url: `https://github.com/acme/project/pull/4#pullrequestreview-${id}` };
};
const prComment = (body: string, author = operator): ConversationCommentFact => {
  const made = comment(body, author, 4);
  return { ...made, url: `https://github.com/acme/project/pull/4#issuecomment-${made.commentId}` };
};
const reviewsOf = (remote: Remote) => ((remote.feedback ??= {})[4] ??= {}) as { reviews?: ReviewFact[]; comments?: ConversationCommentFact[] };
const executionsOf = (work: WorkView): ExecutionView[] => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];
const repairs = (work: WorkView) => executionsOf(work).filter(item => item.request.resume?.reason === 'REPAIR_REQUESTED');
const events = (work: WorkView, name: string) => work.history.filter(item => item.event === name).length;

test('AC1/AC2/AC3/AC5: an operator CHANGES_REQUESTED (not prose, bots or third parties) becomes ONE correction with its preserved content; after the push it is treated, never lost or re-charged', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: first }, { kind: 'publish', publish: publishAt(first), end: 'success' },
    { kind: 'implement', head: second }, { kind: 'publish', publish: publishAt(second), end: 'success' }]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  observe(remote, first);
  // Noise first: prose, a third party's and a bot's CHANGES_REQUESTED, an operator COMMENTED review — none is a trigger.
  const feedback = reviewsOf(remote);
  feedback.reviews = [review('CHANGES_REQUESTED', stranger, first, 'Delete the whole module.'), review('CHANGES_REQUESTED', { id: 10, login: 'lint[bot]', type: 'Bot' }, first, 'x'),
    review('COMMENTED', operator, first, 'Looks fine to me.'),
    { ...review('CHANGES_REQUESTED', operator, first, 'An old request from before this Work.'), submittedAt: '2020-01-01T00:00:00Z' }];
  feedback.comments = [prComment('Could you also rename the flag? /factory repair please')];
  await h.cycles(4);
  let work = await h.work();
  assert.deepEqual([work.correction, h.activations().length, work.feedback?.requests.length ?? 0], [null, 2, 0]);
  assert.deepEqual(work.feedback!.ignored.map(item => item.code).sort(), ['AUTHOR_IS_BOT', 'AUTHOR_NOT_OPERATOR', 'REVIEW_PREDATES_WORK']);
  // The operator requests changes on the CURRENT head `first`.
  const requested = review('CHANGES_REQUESTED', operator, first, 'Rename the `--dry` flag to `--dry-run` in docs/a.md.');
  feedback.reviews.push(requested);
  await h.settle(work => (work.corrections ?? []).length === 1, 'correction closed');
  work = await h.work();
  const closed = work.corrections![0]!;
  assert.deepEqual([closed.outcome, closed.charged, closed.head, closed.reasons.map(item => [item.code, item.subject])],
    ['published', true, second, [['HUMAN_CHANGES_REQUESTED', `review-${requested.reviewId}`]]]);
  const record = work.feedback!.requests.find(item => item.feedbackId === `review-${requested.reviewId}`)!;
  assert.deepEqual([record.state, record.correctionId, record.outcome, record.feedback.version, record.feedback.author, record.feedback.url],
    ['treated', closed.correctionId, 'published', first, { login: 'operator-one', id: 7 }, requested.url], 'identity, origin, version and content are durable');
  assert.equal(record.feedback.content, 'Rename the `--dry` flag to `--dry-run` in docs/a.md.');
  assert.deepEqual([work.budget!.corrections.consumed, repairs(work).length, repairs(work)[0]!.charge!.state], [1, 1, 'consumed']);
  const builder = h.activations()[2]!;
  assert.equal(builder.phaseId, 'builder-continuation');
  assert.ok(builder.prompt.includes('Human requests from configured operators') && builder.prompt.includes('`--dry-run` in docs/a.md') && builder.prompt.includes('use ask_user'));
  assert.ok(!builder.prompt.includes('Delete the whole module') && !builder.prompt.includes('Looks fine to me'), 'only the authorized request reaches the Builder');
  // Real run q23-feedback-v2: the reviewers of the repair judge it with the operator's request as part of the authorized request (never "out of scope").
  const specPrompts = h.execution.calls.filter(call => call.kind === 'activate-spec').map(call => (call.detail as { prompt: string }).prompt);
  assert.ok(specPrompts.length >= 2 && !specPrompts[0]!.includes('Operator requests authorized in this Work'), 'the first implementation has none');
  assert.ok(specPrompts.at(-1)!.includes('Operator requests authorized in this Work') && specPrompts.at(-1)!.includes(`review-${requested.reviewId}`) &&
    specPrompts.at(-1)!.includes('`--dry-run` in docs/a.md') && specPrompts.at(-1)!.includes('in scope'));
  // The review stays CHANGES_REQUESTED on GitHub after the push (commit `first`, head now `second`): treated, never a second charge.
  await h.cycles(5);
  work = await h.work();
  assert.deepEqual([work.correction, h.activations().length, work.budget!.corrections.consumed], [null, 4, 1]);
  // A later approval removes nothing that was treated and says nothing about the human merge approval.
  feedback.reviews.push(review('APPROVED', operator, second, 'Thanks.'));
  await h.cycles(3);
  work = await h.work();
  assert.deepEqual([work.correction, h.activations().length, work.feedback!.requests.map(item => item.state)], [null, 4, ['treated']]);
  assert.deepEqual(work.feedback!.settled, [`review-${requested.reviewId}`], 'tombstone: a still-live review is never recorded (or charged) again, even after eviction');
  assert.equal(work.readiness?.stages.humanReview ?? 'human-stage', 'human-stage', 'the human review/merge stage stays human');
});

test('AC3/AC4: an approval before the start withdraws ONLY that review (no charge); an independent explicit repair stays and runs alone', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: first }, { kind: 'publish', publish: publishAt(first), end: 'success' },
    { kind: 'implement', head: second }, { kind: 'publish', publish: publishAt(second), end: 'success' }]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  observe(remote, first);
  await h.pause('pause', 1);
  const requested = review('CHANGES_REQUESTED', operator, first, 'Add a changelog entry.');
  reviewsOf(remote).reviews = [requested];
  await h.settle(work => work.correction !== null, 'correction opened while paused');
  assert.equal((await h.work()).correction!.trigger, 'human-feedback');
  const accepted = await h.repair(1, 'Also mention the rollback owner in docs/a.md.');
  assert.deepEqual([accepted.kind, (accepted as { outcome: string }).outcome], ['durable', 'accepted']);
  assert.deepEqual(((await h.repair(2, 'Also mention the rollback owner in docs/a.md.')) as { outcome: string; reason: string }), { kind: 'durable', request_id: 'repair-2',
    operation: 'repair', work_id: (await h.work()).work_id, outcome: 'already-covered', reason: 'REPAIR_ALREADY_PENDING', feedbackId: null, appliesAt: null,
    nextStep: 'The same repair is already pending in this Work; nothing was duplicated. Follow it with `factory show <work>`.' }, 'same request: nothing duplicated');
  await h.settle(work => (work.correction?.reasons ?? []).length === 2, 'both reasons in the pending correction');
  reviewsOf(remote).reviews!.push(review('APPROVED', operator, first, 'Never mind.'));
  await h.settle(work => work.feedback!.requests.some(item => item.state === 'withdrawn'), 'review withdrawn');
  await h.settle(work => (work.correction?.reasons ?? []).length === 1, 'only the explicit repair remains');
  assert.deepEqual((await h.work()).correction!.reasons!.map(item => item.code), ['EXPLICIT_REPAIR']);
  await h.pause('unpause', 2);
  await h.settle(work => (work.corrections ?? []).length === 1, 'repair closed');
  const work = await h.work();
  assert.deepEqual(repairs(work)[0]!.request.repair!.reasons.map(item => [item.code, item.feedback?.content]), [['EXPLICIT_REPAIR', 'Also mention the rollback owner in docs/a.md.']]);
  assert.deepEqual([work.budget!.corrections.consumed, events(work, 'feedback-withdrawn')], [1, 1]);
  assert.ok(h.activations()[2]!.prompt.includes('Also mention the rollback owner') && !h.activations()[2]!.prompt.includes('Add a changelog entry'));
  assert.deepEqual(work.feedback!.requests.map(item => [item.code, item.state]).sort(), [['EXPLICIT_REPAIR', 'treated'], ['HUMAN_CHANGES_REQUESTED', 'withdrawn']]);
});

test('AC4: a request withdrawn before the start of a correction of its own withdraws the correction without charge', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: first }, { kind: 'publish', publish: publishAt(first), end: 'success' }]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  observe(remote, first);
  await h.pause('pause', 1);
  reviewsOf(remote).reviews = [review('CHANGES_REQUESTED', operator, first, 'Add a changelog entry.')];
  await h.settle(work => work.correction !== null, 'correction opened');
  reviewsOf(remote).reviews![0]!.state = 'DISMISSED';
  await h.settle(work => work.correction === null, 'withdrawn');
  await h.pause('unpause', 2);
  await h.cycles(3);
  const work = await h.work();
  assert.deepEqual(work.corrections!.map(item => [item.outcome, item.charged]), [['withdrawn', false]]);
  assert.deepEqual([work.budget!.corrections.consumed, h.activations().length, work.queue.pending], [0, 2, false]);
});

test('AC4/AC5/AC6/AC7: feedback during the repair accumulates for its next safe activation — same correction, preserved charge, no interruption, no duplicate; repair/resume during activity answer by phase', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const receipts: Promise<unknown>[] = [];
  let workId = '';
  // During the repair activation an operator submits a SECOND review and both an explicit CLI repair and a resume arrive.
  const during = (target: Remote) => {
    reviewsOf(target).reviews!.push(review('CHANGES_REQUESTED', operator, first, 'Also add an example to docs/b.md.'));
    receipts.push(control.accept({ request_id: 'repair-during', operation: 'repair', work_id: workId, reason: 'Keep the old flag as a deprecated alias.', origin: 'local-cli' }));
    // Ticket 25's `resume` (unified): an active Work answers it is active, launching nothing.
    receipts.push(control.accept({ request_id: 'resume-during', operation: 'resume', work_id: workId, origin: 'local-cli' }));
  };
  const h = await harness(t, remote, [{ kind: 'implement', head: first }, { kind: 'publish', publish: publishAt(first), end: 'success' },
    { kind: 'implement', head: second, during }, { kind: 'publish', publish: publishAt(second), end: 'success' },
    { kind: 'implement', head: third }, { kind: 'publish', publish: publishAt(third), end: 'success' }]);
  const control: Control = h.control;
  await h.settle(work => work.publication?.state === 'published', 'publication');
  workId = (await h.work()).work_id;
  observe(remote, first);
  reviewsOf(remote).reviews = [review('CHANGES_REQUESTED', operator, first, 'Rename the flag.')];
  await h.settle(work => (work.corrections ?? []).length === 1, 'correction closed after its continuation');
  const [repairReceipt, resumeReceipt] = await Promise.all(receipts) as [{ outcome: string }, { outcome: string; reason: string }];
  assert.equal(repairReceipt.outcome, 'deferred', 'during activity: accepted for later');
  assert.deepEqual([resumeReceipt.outcome, resumeReceipt.reason], ['already-satisfied', 'EXECUTION_ACTIVE'], 'resume of an active Work launches nothing');
  const work = await h.work();
  const closed = work.corrections![0]!;
  assert.deepEqual([closed.outcome, closed.head, closed.charged], ['published', third, true]);
  const [initial, continued] = repairs(work);
  assert.deepEqual(initial!.request.repair!.reasons.map(item => item.code), ['HUMAN_CHANGES_REQUESTED']);
  // Commit order decides the order of the reasons (the CLI request was committed before the next feedback read); all entered the SAME correction.
  assert.deepEqual(continued!.request.repair!.reasons.map(item => item.code).sort(), ['EXPLICIT_REPAIR', 'HUMAN_CHANGES_REQUESTED', 'HUMAN_CHANGES_REQUESTED']);
  assert.deepEqual([initial!.charge!.state, continued!.charge!.state, continued!.charge!.correctionId], ['consumed', 'preserved', closed.correctionId], 'same correction, charged once');
  assert.equal(work.budget!.corrections.consumed, 1);
  assert.equal(h.activations().length, 6, 'one Builder at a time: no parallel writer, no extra activation');
  assert.ok(!h.execution.calls.some(call => call.kind === 'deliver-credential' || call.kind === 'deliver-feedback'), 'nothing injected into the running activity');
  const prompt = h.activations()[4]!.prompt;
  assert.ok(prompt.includes('Also add an example to docs/b.md.') && prompt.includes('Keep the old flag as a deprecated alias.'));
  assert.deepEqual([events(work, 'repair-continued'), events(work, 'correction-opened')], [1, 1]);
  // Real run q23-feedback-v3: a DELIVERED continuation is never "cancelled" afterwards (that reset would clear the pending publication).
  assert.equal(work.history.filter(item => item.event === 'feedback-withdrawn' && item.detail.startsWith('continuation')).length, 0);
  assert.deepEqual(work.feedback!.requests.map(item => item.state), ['treated', 'treated', 'treated']);
  // Idle again: resume has nothing suspended; a new explicit repair would open a NEW correction (FIFO, charged on its own).
  const idle = (await control.accept({ request_id: 'resume-idle', operation: 'resume', work_id: workId, origin: 'local-cli' })) as { outcome: string; reason: string };
  assert.deepEqual([idle.outcome, idle.reason], ['not-applied', 'NOTHING_TO_RESUME']);
});

test('AC1: `/factory repair` on the own PR and on the Ticket goes through the single command authentication; edited, third-party and repeated comments never add a request', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: first }, { kind: 'publish', publish: publishAt(first), end: 'success' },
    { kind: 'implement', head: second }, { kind: 'publish', publish: publishAt(second), end: 'success' }]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  observe(remote, first);
  await h.pause('pause', 1);
  const edited = prComment('/factory repair Make the title shorter please.');
  edited.updatedAt = new Date(Date.parse(edited.createdAt) + 5000).toISOString();
  reviewsOf(remote).comments = [prComment('/factory repair Remove the docs entirely.', stranger), edited, prComment('/factory repair Rename the flag to --dry-run in docs/a.md.')];
  (remote.comments ??= {})[3] = [comment('/factory repair Add the rollback owner to docs/a.md.', operator, 3)];
  await h.settle(work => (work.correction?.reasons ?? []).length === 2, 'both operator repairs in one correction');
  await h.cycles(3);
  let work = await h.work();
  assert.deepEqual(work.correction!.reasons!.map(item => [item.code, item.feedback?.origin, item.feedback?.content]).sort(), [
    ['EXPLICIT_REPAIR', 'github-comment', 'Add the rollback owner to docs/a.md.'], ['EXPLICIT_REPAIR', 'github-comment', 'Rename the flag to --dry-run in docs/a.md.']]);
  assert.deepEqual(work.feedback!.ignored.map(item => item.code).sort(), ['AUTHOR_NOT_OPERATOR', 'COMMENT_EDITED']);
  assert.equal(work.feedback!.requests.length, 2, 'complete re-reads of the same comments add nothing');
  await h.pause('unpause', 2);
  await h.settle(work => (work.corrections ?? []).length === 1, 'repair closed');
  work = await h.work();
  assert.deepEqual([work.budget!.corrections.consumed, work.corrections![0]!.outcome], [1, 'published']);
});

test('review fixes: a charged repair that ends NOT publishable with an undelivered request closes ONCE; the request returns to pending (never treated) with a waiting note, no per-cycle history', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const during = (target: Remote) => { reviewsOf(target).reviews!.push(review('CHANGES_REQUESTED', operator, first, 'Also add an example to docs/b.md.')); };
  const h = await harness(t, remote, [{ kind: 'implement', head: first }, { kind: 'publish', publish: publishAt(first), end: 'success' },
    { kind: 'implement', head: second, gate: 'failed', during }]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  observe(remote, first);
  reviewsOf(remote).reviews = [review('CHANGES_REQUESTED', operator, first, 'Rename the flag.')];
  await h.settle(work => (work.corrections ?? []).length === 1, 'correction closed');
  await h.cycles(6);
  const work = await h.work();
  const closed = work.corrections![0]!;
  assert.deepEqual([closed.outcome, closed.charged, work.correction], ['not-publishable', true, null]);
  const states = Object.fromEntries(work.feedback!.requests.map(item => [item.feedback.content, item.state]));
  assert.deepEqual(states, { 'Rename the flag.': 'treated', 'Also add an example to docs/b.md.': 'pending' }, 'only the delivered request is treated');
  assert.match(work.feedback!.waiting!.nextStep, /wait for this Work's published own pull request/);
  assert.deepEqual([events(work, 'repair-continued'), events(work, 'correction-closed'), h.activations().length, work.budget!.corrections.consumed], [0, 1, 3, 1]);
});

test('review fixes: an explicit repair folded into an open INTERNAL correction makes it observation-driven, so its Builder receives the request', async t => {
  const { requestCorrection } = await import('../../src/control/durable/control.js');
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: first }, { kind: 'publish', publish: publishAt(first), end: 'success' },
    { kind: 'implement', head: second }, { kind: 'publish', publish: publishAt(second), end: 'success' }]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  observe(remote, first);
  await h.pause('pause', 1);
  assert.equal(await requestCorrection(h.control, (await h.work()).work_id, 'internal seam'), 'opened');
  assert.equal((await h.work()).correction!.trigger, 'internal');
  assert.equal(((await h.repair(1, 'Rename the flag to --dry-run in docs/a.md.')) as { outcome: string }).outcome, 'accepted');
  await h.settle(work => work.correction?.trigger === 'human-feedback' && (work.correction.reasons ?? []).length === 1, 'adopted');
  await h.pause('unpause', 2);
  await h.settle(work => (work.corrections ?? []).length === 1, 'repair closed');
  const work = await h.work();
  assert.ok(h.activations()[2]!.prompt.includes('Rename the flag to --dry-run in docs/a.md.'));
  assert.deepEqual([work.corrections![0]!.outcome, work.feedback!.requests[0]!.state, work.budget!.corrections.consumed], ['published', 'treated', 1]);
});

test('review fixes: `/factory repair` on the Ticket of a Work without its own PR is refused with the update-scope next step, answered ONCE on the Ticket (discovery after an unknown outcome), cursor advanced', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], postOutcomes: ['unknown-created'] };
  // The implementation is not publishable (failed gate): the Work is idle with no own PR.
  const h = await harness(t, remote, [{ kind: 'implement', head: first, gate: 'failed' }]);
  await h.settle(work => work.publication?.state === 'not-publishable' && !work.pullRequest, 'idle without an own PR');
  const source = comment('/factory repair Rename the flag to --dry-run in docs/a.md.', operator, 3);
  (remote.comments ??= {})[3] = [source];
  await h.settle(work => Number(work.inputs.cursor ?? 0) >= source.commentId, 'cursor advanced');
  const receipt = (await h.control.inspect({ kind: 'request', request_id: `github-comment-${source.commentId}` })) as { receipt: { outcome: string; reason: string; nextStep: string } };
  assert.deepEqual([receipt.receipt.outcome, receipt.receipt.reason], ['not-applied', 'REPAIR_REQUIRES_OWN_PULL_REQUEST']);
  assert.match(receipt.receipt.nextStep, /factory update-scope .* --reason <text>/);
  await h.settle(work => work.feedback?.replies?.[0]?.publication.state === 'published', 'reply published after discovery');
  await h.cycles(3);
  const replies = (remote.comments[3] ?? []).filter(item => item.body.startsWith('<!-- software-factory:reply:'));
  assert.equal(replies.length, 1, 'the unknown outcome is discovered, never posted twice');
  assert.ok(replies[0]!.body.includes('refused: nothing changed') && replies[0]!.body.includes(source.url) && !replies[0]!.body.includes('Rename the flag'), 'the reason is not echoed');
  assert.equal(h.github.calls.filter(call => call.method === 'findReply').length >= 1, true);
  const work = await h.work();
  assert.deepEqual([work.feedback!.requests.length, h.activations().length], [0, 1]);
});
