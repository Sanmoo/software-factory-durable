import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createDeliveryDesk } from '../../src/control/durable/delivery-desk.js';
import { createRetentionDesk } from '../../src/control/durable/retention-desk.js';
import { acceptCleanupConfirm, acceptCleanupPlan, plannedResourcesOf } from '../../src/control/durable/retention.js';
import { acceptForgetConfirm, acceptForgetPlan, beginForget } from '../../src/control/durable/forget.js';
import { acceptCancel, acceptNewCycle } from '../../src/control/durable/cycles.js';
import { admitTicket, initialize, ownCycles, readForgotten, readWork, readWorks, requests, ticketIndex, works, type WorkRecord } from '../../src/control/durable/admission.js';
import { evaluateWorkDependencies } from '../../src/control/durable/polling.js';
import { acceptAnswer, questions as questionDocs, readQuestions } from '../../src/control/durable/questions.js';
import { openStore } from '../../src/control/durable/store.js';
import { openControl } from '../../src/control/index.js';
import { acceptScopeUpdate } from '../../src/control/durable/scope.js';
import { acceptReadinessAuthorization } from '../../src/control/durable/readiness.js';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { planCleanup } from '../../src/control/rules/delivery.js';
import { retentionProtections } from '../../src/control/rules/retention.js';
import type { DetailPorts, QuestionView } from '../../src/control/types.js';
import { createRecords, forgetWorkRecords, inspectWorkRecords, listDetails, removeRecordsDetail } from '../../src/records/index.js';
import { githubDoubles, remoteIssue, scope, ticket } from './doubles.js';
import { deliveryRepository, environment, markDelivered, merged, ownFacts, realCleanupPorts, sandboxRoot, seedPublishedWork, store } from './delivery-fixture.js';

// Ticket 31 storage-real flows: Pi Durable + SQLite, the REAL Records area (captures written by Records, whole-tree inspection and deletion), REAL
// Sandbox removal/evidence export on synthetic environments (systemctl double), REAL admission, own-cycle memory, native dependency evaluation and
// `new` over the same storage. Doubled: GitHub (tracker/CodeRepository, calls counted) and the calendar. Not evidence of a real VM, GitHub or model.
const exists = (path: string) => lstat(path).then(() => true, () => false);
/** Every document revision the real SQLite store still holds (live rows; free pages are the documented limitation). */
async function storedRevisions(path: string): Promise<string[]> {
  const database = await openNodeSqliteDatabase(path);
  try { return (await database.all<{ content: unknown }>('SELECT content FROM document_revisions')).map(row => String(row.content)); } finally { await database.close(); }
}
const admission = (number = 3) => ({ ticket: ticket(number), repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, observedAt: 'now',
  label: { id: 55, name: 'ready-for-agent' }, publication: { observedAt: 'now', limitations: [] } });

async function harness(t: { after(fn: () => Promise<void> | void): void }) {
  const root = await realpath(await sandboxRoot(t));
  const { session } = await store(t, root);
  const work_id = await seedPublishedWork(session);
  const own = await environment(root, work_id);
  const records = await createRecords({ root });
  const context = { workId: work_id, executionId: 'e-1', invocationId: 'i-1', role: 'builder' as const, environmentRef: own.env, bootRef: 'boot', callId: 'c-1' };
  const toolOutput = async (workId: string, text: string) => { const output = await records.openOutput({ ...context, workId, callId: randomUUID() });
    await output.write(Buffer.from(text)); return (await output.finish()).reference; };
  await toolOutput(work_id, 'secret-free tool output one');
  await records.record({ ...context, callId: 'worker-start' }, { version: 1, kind: 'worker-start' });
  await records.record({ ...context, role: 'spec', callId: 'review-opinion' }, { kind: 'review-opinion', verdict: 'approve', text: 'REVIEW OPINION CONTENT' });
  const foreignLog = await toolOutput('foreign-work', 'foreign');
  const github = { pull: ownFacts() as ReturnType<typeof ownFacts> | 'unavailable', branch: { 'factory/3-own': 'a'.repeat(40), main: 'c'.repeat(40) } as Record<string, string> };
  const repository = deliveryRepository(github);
  const log: string[] = [];
  const running = new Set<string>();
  const faults: { forget?: 'failed' | 'throw' } = {};
  const details: DetailPorts = {
    list: ({ workId }) => listDetails(root, workId),
    async preserveSession() { return { status: 'lost', code: 'NOT_USED' }; },
    remove: ({ workId, item, expectedSha256 }) => removeRecordsDetail(root, workId, item, expectedSha256),
    inspectTree: ({ workId }) => inspectWorkRecords(root, workId),
    async forget({ workId }) {
      log.push(`forget:${workId}`);
      if (faults.forget === 'throw') throw new Error('LOST');
      if (faults.forget === 'failed') return { outcome: 'failed', code: 'SYNTHETIC_FAILURE', files: 0, bytes: 0 };
      return forgetWorkRecords(root, workId);
    },
  };
  const cleanup = { ...realCleanupPorts(root, log), details, retentionDays: 30 };
  const delivery = createDeliveryDesk({ session, repository: repository.repository, repositories: [scope], cleanup, running: id => running.has(id), interrupt: async () => {},
    readWorks: () => readWorks(session), stopped: () => false,
    protections: async work => retentionProtections(work, { running: running.has(work.work_id), questions: await readQuestions(session, work) }) });
  const desk = () => createRetentionDesk({ session, details, repositories: [scope], days: 30, sweepSeconds: 86400, readWorks: () => readWorks(session),
    readQuestions: work => readQuestions(session, work), running: id => running.has(id), settled: () => true, stopped: () => false });
  /** The facts Control reads for a forget plan/confirmation (Control's `forgetFacts`). */
  const facts = async (id = work_id) => { const tree = await details.inspectTree!({ workId: id }); const busy = running.has(id);
    return (current: WorkRecord) => ({ running: busy, tree, repositoryConfigured: current.repository.repository === scope.repository }); };
  const plan = async (request_id: string, id = work_id) => acceptForgetPlan(session, { request_id, operation: 'forget-plan', work_id: id, origin: 'local-cli' }, await facts(id));
  const confirm = async (request_id: string, plan_id: string, id = work_id) =>
    acceptForgetConfirm(session, { request_id, operation: 'forget-confirm', work_id: id, plan_id, origin: 'local-cli' }, await facts(id));
  const work = async () => readWork(session, work_id);
  return { root, session, work_id, own, foreignLog, github, repository, log, running, faults, details, delivery, desk, plan, confirm, work };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function deliver(h: Harness) {
  h.github.pull = merged();
  await h.delivery.cycle();
  const work = (await h.work())!;
  assert.deepEqual([work.result, work.cleanup?.state], ['delivered', 'complete'], JSON.stringify(work.cleanup?.resources.map(item => [item.id, item.state])));
}
/** An answered Question of the Work with its local answer and a scope update: the request receipts carry operator text. */
async function seedContent(h: Harness) {
  const questionId = randomUUID();
  await h.session.commit(async tx => {
    const work = (await tx.doc(works, h.work_id, null)).work!;
    work.questions.push(questionId);
    work.scopeUpdates = [{ scopeUpdateId: 'scope-s-1', reason: 'SCOPE REASON CONTENT', sha256: 'x', acceptedAt: 'x', origin: { kind: 'local-cli', request_id: 's-1' },
      acceptedDuring: null, state: 'consumed', executionId: null, deliveredAt: null, consumedAt: null, consumption: null, reoffers: 0 } as never];
    (await tx.doc(questionDocs, questionId, null)).question = { questionId, workId: h.work_id, executionId: 'e-1', invocationId: 'i-1', recordedAt: 'x', recordedFrom: 'worker-notification',
      content: { question: 'QUESTION CONTENT', context: 'QUESTION CONTEXT', sha256: 'x', reference: { workId: h.work_id, id: 'r' } }, destination: { kind: 'issue', ticket: ticket(3) },
      state: 'answered', publication: { effectId: 'p', state: 'published', updatedAt: 'x', attempts: [], comment: null, nextStep: null },
      answer: { text: 'ANSWER CONTENT', sha256: 'x', acceptedAt: 'x', author: { kind: 'local-administrator' }, origin: { kind: 'local-cli', request_id: 'a-1' } }, ignored: [] } satisfies QuestionView;
    const answer = await tx.doc(requests, 'a-1', null);
    answer.input = { request_id: 'a-1', operation: 'answer', question_id: questionId, text: 'ANSWER CONTENT', origin: 'local-cli' };
    answer.receipt = { kind: 'durable', request_id: 'a-1', operation: 'answer', question_id: questionId, outcome: 'accepted', reason: null, work_id: h.work_id };
    const scopeRequest = await tx.doc(requests, 's-1', null);
    scopeRequest.input = { request_id: 's-1', operation: 'update-scope', work_id: h.work_id, reason: 'SCOPE REASON CONTENT', origin: 'local-cli' };
  }, BACKGROUND_CONTEXT);
  return questionId;
}

test('AC1/AC3/AC4/AC5/AC7: a delivered Work is forgotten after plan + confirmation; only the minimal memory stays; never re-admitted; own blocker still satisfied; `new` is evaluated', async t => {
  const h = await harness(t);
  const questionId = await seedContent(h);
  await deliver(h);
  // Review MED: refused/not-applied requests carrying text are linked to the Work at their own commit (the Work/Question never reference them).
  const refusedScope = await acceptScopeUpdate(h.session, { request_id: 's-refused', operation: 'update-scope', work_id: h.work_id, reason: 'REFUSED SCOPE TEXT', origin: 'local-cli' });
  assert.ok(refusedScope.kind === 'durable' && refusedScope.outcome === 'not-applied');
  const refusedAnswer = await acceptAnswer(h.session, { request_id: 'a-refused', question_id: questionId, text: 'REFUSED ANSWER TEXT', origin: { kind: 'local-cli' } });
  assert.ok(refusedAnswer.kind === 'durable' && refusedAnswer.outcome === 'not-applied');
  const refusedReadiness = await acceptReadinessAuthorization(h.session, { request_id: 'r-refused', operation: 'authorize-readiness', work_id: h.work_id, reason: 'REFUSED READINESS TEXT', origin: 'local-cli' });
  assert.ok(refusedReadiness.kind === 'durable' && refusedReadiness.outcome === 'not-applied');
  const callsBefore = h.repository.calls.length;
  const planned = await h.plan('f-1');
  assert.ok(planned.kind === 'durable' && planned.outcome === 'accepted' && planned.plan, JSON.stringify(planned));
  const plan = planned.plan!;
  assert.equal(plan.state, 'planned');
  assert.match(plan.losses[0]!, /whole Records area \(\d+ file\(s\)/);
  assert.match(plan.keeps.join('\n'), /Minimal memory: Ticket acme\/project#3.*result delivered, pull request #42 with its merge confirmed/);
  assert.match(plan.warnings[0]!, /Not erased: GitHub.*backups.*external copy can bring deleted data back/);
  assert.match(plan.nextStep, /factory forget-confirm <work>/);
  assert.ok(await exists(join(h.root, h.work_id)) && (await h.work()) !== undefined, 'a plan deletes nothing');
  assert.deepEqual(await h.plan('f-1'), planned, 'same identity and content: same receipt');
  const confirmed = await h.confirm('f-1-confirm', plan.planId);
  assert.ok(confirmed.kind === 'durable' && confirmed.outcome === 'accepted', JSON.stringify(confirmed));
  assert.ok(await exists(join(h.root, h.work_id)), 'the confirmation itself deletes nothing: the desk executes it');
  await h.desk().cycle();

  // Deleted: the Work record, its Questions, its whole Records area and the operator text of its request receipts.
  assert.equal(await h.work(), undefined);
  assert.equal(await exists(join(h.root, h.work_id)) || await exists(join(h.root, `.forget-${h.work_id}`)), false);
  assert.ok(await exists(join(h.root, 'foreign-work', 'evidence', h.foreignLog.id)), 'another Work\'s Records are untouched');
  assert.equal(await h.session.snapshot(questionDocs, questionId, BACKGROUND_CONTEXT), undefined);
  const answer = await h.session.snapshot(requests, 'a-1', BACKGROUND_CONTEXT);
  assert.deepEqual(answer?.input, { request_id: 'a-1', operation: 'answer', origin: 'local-cli', forgotten: h.work_id });
  assert.equal(answer?.receipt?.kind, 'durable', 'the receipt (no content) stays');
  assert.deepEqual((await h.session.snapshot(requests, 's-1', BACKGROUND_CONTEXT))?.input, { request_id: 's-1', operation: 'update-scope', origin: 'local-cli', forgotten: h.work_id });
  for (const [id, operation] of [['s-refused', 'update-scope'], ['a-refused', 'answer'], ['r-refused', 'authorize-readiness']] as const) {
    assert.deepEqual((await h.session.snapshot(requests, id, BACKGROUND_CONTEXT))?.input, { request_id: id, operation, origin: 'local-cli', forgotten: h.work_id }, id);
  }
  // Review MED: verified against the REAL store — no stored document revision (retired or rewritten) still holds any of the texts.
  const revisions = await storedRevisions(join(h.root, 'control.sqlite'));
  assert.ok(revisions.length > 0);
  for (const content of ['QUESTION CONTENT', 'ANSWER CONTENT', 'SCOPE REASON CONTENT', 'REFUSED SCOPE TEXT', 'REFUSED ANSWER TEXT', 'REFUSED READINESS TEXT', 'The Builder said']) {
    assert.ok(!revisions.some(text => text.includes(content)), `revision still holds ${content}`);
  }
  // Kept: the minimal memory only, with no request content, log or opinion.
  const index = await h.session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  const memory = index!.forgotten![h.work_id]!;
  assert.deepEqual({ ...memory, forgottenAt: 'x' }, { work_id: h.work_id, ticket: ticket(3), repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, cycle: 1,
    predecessor: null, sequence: 1, result: 'delivered', pullRequest: { number: 42, pullRequestId: 9042, nodeId: 'PR_own42', url: 'https://github.com/acme/project/pull/42' },
    mergeConfirmed: true, mergeConfirmedAt: memory.mergeConfirmedAt, label: { id: 55, name: 'ready-for-agent' }, questions: [questionId], watch: null, forgottenAt: 'x', request_id: 'f-1-confirm',
    planId: plan.planId });
  assert.ok(memory.mergeConfirmedAt);
  const stored = JSON.stringify(index);
  for (const content of ['QUESTION CONTENT', 'ANSWER CONTENT', 'SCOPE REASON CONTENT', 'REVIEW OPINION CONTENT', 'The Builder said', 'tool output', 'REFUSED']) assert.ok(!stored.includes(content), content);
  assert.deepEqual(index!.memory!['github:repository:3:issue:7003']!.cycles, [{ work_id: h.work_id, cycle: 1, result: 'delivered', mergeConfirmed: true }]);
  assert.deepEqual(index!.order, [], 'the forgotten Work leaves the listing order');
  assert.deepEqual(index!.tickets['github:repository:3:issue:7003'], { current: h.work_id, previous: [] }, 'the Ticket stays indexed');
  assert.deepEqual(await readWorks(h.session), []);
  assert.deepEqual((await readForgotten(h.session)).map(item => item.work_id), [h.work_id]);
  assert.equal(h.repository.calls.length, callsBefore, 'forget never reaches GitHub');
  assert.deepEqual(h.log.filter(item => item.startsWith('forget:')), [`forget:${h.work_id}`]);

  // Anti re-admission: the same Ticket (label/polling) is `existing`, also after a restart of the storage.
  assert.deepEqual(await admitTicket(h.session, admission()), { kind: 'existing', work_id: h.work_id });
  // Own blocker: still own, satisfied by the delivered cycle from the minimal memory (issue #5 is blocked by #3).
  const remote = { issues: [remoteIssue(3, { state: 'closed', stateReason: 'completed' }), remoteIssue(5, { blockedBy: [3] })], pulls: {} };
  const gh = githubDoubles(remote);
  const evaluate = async () => (await evaluateWorkDependencies(gh.tracker, ids => ownCycles(h.session, ids), ticket(5), 'attempt')).evaluation;
  let evaluation = await evaluate();
  assert.deepEqual([evaluation.conclusion, evaluation.blockers[0]?.classification, evaluation.blockers[0]?.work_id, evaluation.blockers[0]?.satisfied], ['satisfied', 'own', h.work_id, true]);
  assert.equal((await ownCycles(h.session, [ticket(3).issueId]))[ticket(3).issueId]?.source, 'minimal-memory');
  // Replays and later commands on the forgotten Work are explicit, never "not found".
  assert.deepEqual(await h.plan('f-2').then(item => item.kind === 'durable' ? [item.outcome, item.reason] : item), ['already-satisfied', 'ALREADY_FORGOTTEN']);
  assert.deepEqual(await h.confirm('f-1-confirm-2', plan.planId).then(item => item.kind === 'durable' ? [item.outcome, item.reason] : item), ['already-satisfied', 'ALREADY_FORGOTTEN']);
  // A new cycle depends on an explicit `new` (fresh Ticket read) and becomes the evaluated one; it never inherits the old merge.
  const created = await acceptNewCycle(h.session, { request_id: 'new-1', operation: 'new', ticket: { repository: 'acme/project', number: 3 }, keepPredecessorPullRequest: false, origin: 'local-cli' },
    { configured: () => scope, tracker: githubDoubles({ issues: [remoteIssue(3)], pulls: {} }).tracker });
  assert.ok(created.kind === 'durable' && created.outcome === 'accepted' && created.created, JSON.stringify(created));
  const successor = (await readWork(h.session, created.created!))!;
  assert.deepEqual([successor.cycle, successor.predecessor, successor.result, successor.authorization.basis.label.name], [2, h.work_id, 'open', 'ready-for-agent']);
  assert.match(successor.authorization.publication.limitations[0]!, /was forgotten/);
  evaluation = await evaluate();
  assert.deepEqual([evaluation.conclusion, evaluation.blockers[0]?.work_id, evaluation.blockers[0]?.satisfied, evaluation.reasons[0]?.code],
    ['pending', created.created, false, 'OWN_CYCLE_NOT_DELIVERED']);
  const facts = (await ownCycles(h.session, [ticket(3).issueId]))[ticket(3).issueId];
  assert.ok(facts && facts.source === 'work' && facts.previousCycles.some(item => item.work_id === h.work_id && item.result === 'delivered' && item.mergeConfirmed));
  assert.deepEqual(await admitTicket(h.session, admission()), { kind: 'existing', work_id: created.created });
});

test('AC4: restart after forget — the reopened storage still answers `existing` and keeps the forgotten cycle own', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-forget-restart-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'control.sqlite');
  let opened = await openStore(path);
  await initialize(opened.session);
  // No own environment recorded (its cleanup is ticket 17's; here only the authority is restarted).
  const work_id = await seedPublishedWork(opened.session, { environmentFor: () => 'no-environment' });
  await markDelivered(opened.session, work_id, new Date().toISOString());
  const questionId = randomUUID();
  await opened.session.commit(async tx => { (await tx.doc(works, work_id, null)).work!.questions.push(questionId);
    (await tx.doc(questionDocs, questionId, null)).question = { questionId, workId: work_id, state: 'answered', publication: { state: 'published' }, ignored: [], answer: null } as never; }, BACKGROUND_CONTEXT);
  const tree = await inspectWorkRecords(dir, work_id);
  const facts = () => ({ running: false, tree, repositoryConfigured: false });
  const planned = await acceptForgetPlan(opened.session, { request_id: 'f-1', operation: 'forget-plan', work_id, origin: 'local-cli' }, facts);
  assert.ok(planned.kind === 'durable' && planned.outcome === 'accepted', JSON.stringify(planned));
  assert.match(planned.plan!.losses[0]!, /no Records area left/);
  await acceptForgetConfirm(opened.session, { request_id: 'f-1c', operation: 'forget-confirm', work_id, plan_id: planned.plan!.planId, origin: 'local-cli' }, facts);
  const desk = createRetentionDesk({ session: opened.session, details: { list: () => listDetails(dir, work_id), preserveSession: async () => ({ status: 'lost', code: 'X' }),
    remove: async () => ({ outcome: 'refused', code: 'X' }), inspectTree: ({ workId }) => inspectWorkRecords(dir, workId), forget: ({ workId }) => forgetWorkRecords(dir, workId) },
    repositories: [], readWorks: () => readWorks(opened.session), readQuestions: work => readQuestions(opened.session, work), running: () => false, settled: () => true, stopped: () => false });
  await desk.cycle();
  assert.equal(await readWork(opened.session, work_id), undefined, JSON.stringify(desk.view().failures));
  await opened.close();
  opened = await openStore(path);
  t.after(() => opened.close());
  assert.equal(await readWork(opened.session, work_id), undefined);
  assert.deepEqual(await admitTicket(opened.session, admission()), { kind: 'existing', work_id });
  const facts3 = (await ownCycles(opened.session, [ticket(3).issueId]))[ticket(3).issueId];
  assert.deepEqual(facts3, { source: 'minimal-memory', applicable: { work_id, cycle: 1, result: 'delivered', mergeConfirmed: true }, previousCycles: [] });
  assert.deepEqual((await readForgotten(opened.session)).map(item => [item.work_id, item.result]), [[work_id, 'delivered']]);
  await opened.close();
  // Through the public Control (CLI inspect path): the Work and its Question answer `forgotten`, never "not found".
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown' });
  const shown = await control.inspect({ kind: 'show', work_id });
  assert.ok('kind' in shown && shown.kind === 'work-forgotten' && /not an expired or missing record/.test(shown.nextStep), JSON.stringify(shown));
  const question = await control.inspect({ kind: 'question', question_id: questionId });
  assert.ok('kind' in question && question.kind === 'question-forgotten' && question.work_id === work_id, JSON.stringify(question));
  const unknown = await control.inspect({ kind: 'question', question_id: randomUUID() });
  assert.ok('kind' in unknown && unknown.kind === 'question-not-found');
  const stopped = new AbortController(); stopped.abort();
  await control.run(stopped.signal);
  opened = await openStore(path);
});

test('AC2: open, closed-unmerged, protected or resource-holding Works are refused; nothing is changed to make them eligible; a cancelled Work after its environment cleanup is forgotten', async t => {
  const h = await harness(t);
  const refusalCodes = async (id: string) => { const receipt = await h.plan(id); assert.ok(receipt.kind === 'durable'); return [receipt.outcome, receipt.plan?.refusals.map(item => item.code)]; };
  assert.deepEqual(await refusalCodes('open'), ['not-applied', ['WORK_NOT_ENDED', 'RESOURCES_PENDING']]);
  let work = (await h.work())!;
  assert.deepEqual([work.result, work.forget?.plans.at(-1)?.state, work.forget?.plans.at(-1)?.nextStep.includes('nothing was changed')], ['open', 'refused', true]);
  await h.session.commit(async tx => { (await tx.doc(works, h.work_id, null)).work!.result = 'closed-unmerged'; }, BACKGROUND_CONTEXT);
  assert.deepEqual((await refusalCodes('closed'))[1]?.slice(0, 1), ['CANCEL_REQUIRED']);
  assert.equal((await h.work())!.result, 'closed-unmerged', 'forget never cancels');
  await h.session.commit(async tx => { (await tx.doc(works, h.work_id, null)).work!.result = 'open'; }, BACKGROUND_CONTEXT);
  const cancel = await acceptCancel(h.session, { request_id: 'c-1', operation: 'cancel', work_id: h.work_id, origin: 'local-cli' });
  assert.ok(cancel.kind === 'durable' && cancel.outcome === 'accepted');
  // The own PR of the cancelled cycle is not observed closed yet: a later human merge would still deliver it.
  assert.ok((await refusalCodes('pr'))[1]?.includes('PULL_REQUEST_NOT_CLOSED'));
  h.github.pull = ownFacts({ state: 'closed', merged: false });
  await h.delivery.cycle();
  work = (await h.work())!;
  assert.equal(work.delivery?.observations.at(-1)?.outcome, 'closed-unmerged', JSON.stringify(work.delivery));
  // An open Question protects the Work; its environment is still an own resource.
  const questionId = await seedContent(h);
  await h.session.commit(async tx => { (await tx.doc(questionDocs, questionId, null)).question!.state = 'open'; }, BACKGROUND_CONTEXT);
  assert.deepEqual((await refusalCodes('question'))[1], ['PROTECTED', 'RESOURCES_PENDING']);
  await h.session.commit(async tx => { (await tx.doc(questionDocs, questionId, null)).question!.state = 'answered'; }, BACKGROUND_CONTEXT);
  const pending = await h.plan('env');
  assert.ok(pending.kind === 'durable' && pending.plan);
  assert.match(pending.plan!.refusals[0]!.detail, /environment:env-.*factory cleanup <work> --select environment/);
  assert.ok(await exists(h.own.directory) && await exists(join(h.root, h.work_id)), 'refusals touch nothing');
  // The operator cleans the environment explicitly (ticket 30), then forget is eligible.
  const cleanupFacts = async () => { const inventory = await h.details.list({ workId: h.work_id }); const questions = await readQuestions(h.session, (await h.work())!);
    return (current: WorkRecord) => ({ running: false, questions, inventory, repositoryConfigured: true, plannedResources: plannedResourcesOf(current, planCleanup(current, { repositoryConfigured: true }).resources) }); };
  const cleanupPlan = await acceptCleanupPlan(h.session, { request_id: 'cl-1', operation: 'cleanup-plan', work_id: h.work_id, select: ['environment'], origin: 'local-cli' }, await cleanupFacts());
  assert.ok(cleanupPlan.kind === 'durable' && cleanupPlan.plan?.items.length);
  const cleanupConfirmed = await acceptCleanupConfirm(h.session, { request_id: 'cl-1c', operation: 'cleanup-confirm', work_id: h.work_id, plan_id: cleanupPlan.plan!.planId, origin: 'local-cli' }, await cleanupFacts());
  assert.ok(cleanupConfirmed.kind === 'durable' && cleanupConfirmed.outcome === 'accepted', JSON.stringify(cleanupConfirmed));
  await h.delivery.cycle();
  assert.ok((await h.work())!.cleanup?.resources.every(item => item.state === 'removed'), 'environment removed by the explicit cleanup');
  const eligible = await h.plan('cancelled');
  assert.ok(eligible.kind === 'durable' && eligible.outcome === 'accepted', JSON.stringify(eligible.kind === 'durable' ? eligible.plan?.refusals : eligible));
  assert.match(eligible.plan!.keeps.join('\n'), /result cancelled/);
  await h.confirm('cancelled-c', eligible.plan!.planId);
  await h.desk().cycle();
  assert.equal(await h.work(), undefined);
  let memory = (await readForgotten(h.session))[0]!;
  assert.deepEqual([memory.result, memory.mergeConfirmed, memory.pullRequest, memory.watch?.state, memory.watch?.pullRequest.number], ['cancelled', false, null, 'watching', 42]);
  assert.match(eligible.plan!.keeps.join('\n'), /own pull request #42 of this cancelled cycle stays watched/);
  // The cancelled own blocker never satisfies, even with the issue closed as completed; it is never external.
  const gh = githubDoubles({ issues: [remoteIssue(3, { state: 'closed', stateReason: 'completed' }), remoteIssue(5, { blockedBy: [3] })], pulls: {} });
  const evaluation = (await evaluateWorkDependencies(gh.tracker, ids => ownCycles(h.session, ids), ticket(5), 'attempt')).evaluation;
  assert.deepEqual([evaluation.conclusion, evaluation.blockers[0]?.classification, evaluation.reasons[0]?.code], ['pending', 'own', 'OWN_CYCLE_CANCELLED']);
  assert.deepEqual(await admitTicket(h.session, admission()), { kind: 'existing', work_id: h.work_id });
  // Review MED (spec §12.3): the closed PR is still watched from the memory; a human reopens and merges it later → the memory becomes a delivery.
  const reads = h.repository.calls.filter(call => call.method === 'readOwnMerge').length;
  await h.delivery.cycle();
  assert.equal(h.repository.calls.filter(call => call.method === 'readOwnMerge').length, reads + 1, 'read from the memory watch');
  assert.equal((await readForgotten(h.session))[0]!.result, 'cancelled', 'still closed: nothing changes');
  h.github.pull = merged();
  await h.delivery.cycle();
  memory = (await readForgotten(h.session))[0]!;
  assert.deepEqual([memory.result, memory.mergeConfirmed, memory.pullRequest?.number, memory.watch?.state], ['delivered', true, 42, 'delivered']);
  const satisfied = (await evaluateWorkDependencies(gh.tracker, ids => ownCycles(h.session, ids), ticket(5), 'attempt')).evaluation;
  assert.deepEqual([satisfied.conclusion, satisfied.blockers[0]?.classification], ['satisfied', 'own']);
  await h.delivery.cycle();
  assert.equal(h.repository.calls.filter(call => call.method === 'readOwnMerge').length, reads + 2, 'a delivered memory is no longer read');
  // `new` after the forgotten cycle takes its authorization basis from the FRESH read (label id as observed now), nothing copied or invented.
  const created = await acceptNewCycle(h.session, { request_id: 'new-c', operation: 'new', ticket: { repository: 'acme/project', number: 3 }, keepPredecessorPullRequest: false, origin: 'local-cli' },
    { configured: () => scope, tracker: githubDoubles({ issues: [remoteIssue(3, { labels: [{ id: 77, name: 'ready-for-agent' }] })], pulls: {} }).tracker });
  assert.ok(created.kind === 'durable' && created.outcome === 'accepted' && created.created, JSON.stringify(created));
  const successor = (await readWork(h.session, created.created!))!;
  assert.deepEqual([successor.predecessor, successor.cycle, successor.authorization.basis.label], [h.work_id, 2, { id: 77, name: 'ready-for-agent' }]);
  const refused = await acceptNewCycle(h.session, { request_id: 'new-c2', operation: 'new', ticket: { repository: 'acme/project', number: 3 }, keepPredecessorPullRequest: false, origin: 'local-cli' },
    { configured: () => scope, tracker: githubDoubles({ issues: [remoteIssue(3)], pulls: {} }).tracker });
  assert.ok(refused.kind === 'durable' && refused.reason === 'CYCLE_STILL_CURRENT');
});

test('AC1: revalidated at confirmation and again before the deletion; a crash after the intent is indeterminate; a failure keeps the Work; nothing is retried implicitly', async t => {
  const h = await harness(t);
  await deliver(h);
  const planId = async (id: string) => { const receipt = await h.plan(id); assert.ok(receipt.kind === 'durable' && receipt.plan?.state === 'planned', JSON.stringify(receipt)); return receipt.plan!.planId; };
  const reason = async (id: string, plan: string) => { const receipt = await h.confirm(id, plan); return receipt.kind === 'durable' ? [receipt.outcome, receipt.reason] : receipt; };
  // An activity started after the plan: dropped at confirmation, nothing deleted.
  let plan = await planId('p-1');
  h.running.add(h.work_id);
  assert.deepEqual(await reason('p-1c', plan), ['not-applied', 'BECAME_INELIGIBLE:PROTECTED']);
  h.running.delete(h.work_id);
  assert.deepEqual(await reason('p-1c2', plan), ['not-applied', 'PLAN_DROPPED:BECAME_INELIGIBLE:PROTECTED'], 'a dropped plan answers its real outcome, never already-satisfied');
  // A newer plan supersedes an older unconfirmed one.
  const older = await planId('p-2');
  plan = await planId('p-3x');
  assert.deepEqual(await reason('p-2c', older), ['not-applied', 'PLAN_SUPERSEDED']);
  // Review LOW: a confirmed plan not started yet (e.g. a restart without the Records port) never blocks: a newer eligible plan supersedes it.
  const stuck = await planId('p-3s');
  assert.deepEqual(await reason('p-3sc', stuck), ['accepted', null]);
  plan = await planId('p-3');
  assert.deepEqual(await reason('p-3sc2', stuck), ['not-applied', 'PLAN_SUPERSEDED']);
  // Confirmed, then the Records tree changes before the desk runs: the losses shown are no longer exact → dropped before any effect.
  assert.deepEqual(await reason('p-3c', plan), ['accepted', null]);
  await writeFile(join(h.root, h.work_id, 'evidence', 'late-entry'), 'x', { mode: 0o600 });
  await h.desk().cycle();
  let work = (await h.work())!;
  assert.deepEqual([work.forget?.plans.at(-1)?.state, work.forget?.plans.at(-1)?.code], ['dropped', 'PLAN_OBSOLETE']);
  assert.equal(h.log.filter(item => item.startsWith('forget:')).length, 0);
  // A crash right after the intent (no result recorded): indeterminate at the next desk cycle, Work and Records kept, never retried.
  plan = await planId('p-4');
  assert.deepEqual(await reason('p-4c', plan), ['accepted', null]);
  const tree = await h.details.inspectTree!({ workId: h.work_id });
  const intent = await beginForget(h.session, h.work_id, plan, current => ({ running: false, tree, repositoryConfigured: current.repository.repository === scope.repository }));
  assert.equal(typeof intent === 'object' && intent.kind, 'removing');
  await h.desk().cycle();
  work = (await h.work())!;
  assert.deepEqual([work.forget?.plans.at(-1)?.state, work.forget?.plans.at(-1)?.effect?.outcome, work.forget?.plans.at(-1)?.code], ['indeterminate', 'indeterminate', 'RESULT_NOT_RECORDED']);
  await h.desk().cycle();
  assert.equal(h.log.filter(item => item.startsWith('forget:')).length, 0, 'never retried implicitly');
  assert.deepEqual(await reason('p-4c2', plan), ['not-applied', 'PLAN_INDETERMINATE:RESULT_NOT_RECORDED']);
  assert.ok(await exists(join(h.root, h.work_id, 'evidence', 'late-entry')));
  // A failed deletion keeps the Work and is not retried; the next explicit plan + confirmation completes it from what is left.
  plan = await planId('p-5');
  await reason('p-5c', plan);
  h.faults.forget = 'failed';
  await h.desk().cycle();
  work = (await h.work())!;
  assert.deepEqual([work.forget?.plans.at(-1)?.state, work.forget?.plans.at(-1)?.code], ['failed', 'SYNTHETIC_FAILURE']);
  assert.deepEqual(await reason('p-5c2', plan), ['not-applied', 'PLAN_FAILED:SYNTHETIC_FAILURE']);
  await h.desk().cycle();
  assert.equal(h.log.filter(item => item.startsWith('forget:')).length, 1);
  delete h.faults.forget;
  plan = await planId('p-6');
  await reason('p-6c', plan);
  await h.desk().cycle();
  assert.equal(await h.work(), undefined);
  assert.equal(await exists(join(h.root, h.work_id)), false);
  assert.ok(await readdir(h.root));
});
