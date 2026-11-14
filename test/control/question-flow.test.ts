import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlReceipt, ControlStatus, ExecutionPorts, ListView, QuestionView, ShowView, WorkView } from '../../src/control/types.js';
import type { QuestionAck, WorkerQuestion } from '../../src/workers/index.js';
import { comment, githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';

// Flow level (Q11): real Control + Pi Durable + temporary SQLite. Doubled: GitHub tracker/repository, clock and the execution boundaries
// (Sandbox lifecycle, Workers activation with its question event, Builder credentials). NOT evidence of the real VM/worker/model/GitHub.
const operator = { id: 501, login: 'Operator-One', type: 'User' };
const sha = (question: string, context: string) => createHash('sha256').update(JSON.stringify({ question, context })).digest('hex');
type Script = { kind: 'complete' } | { kind: 'ask'; questionId: string; question: string; context?: string; notify?: boolean;
  completion?: 'same' | 'lost-content' | 'other-content'; afterAck?: () => Promise<void> };
const qid = (n: number) => `0b9c6a52-3d3e-4c8f-9a51-${String(n).padStart(12, '0')}`;

function executionDoubles(control: () => Control, scripts: Script[], options: { cessation?: boolean } = {}) {
  const calls: { kind: string; detail?: unknown }[] = [];
  const acks: { ack: QuestionAck; show: Extract<ShowView, { kind: 'work' }> }[] = [];
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 }, capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare', detail: input });
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v1', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: calls.filter(call => call.kind === 'prepare').length > 1, preparedAt: new Date().toISOString() } };
      },
      async start() { calls.push({ kind: 'start' }); return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(calls.length).padStart(12, '5')}` as never }; },
      async stop(input) { calls.push({ kind: 'stop', detail: input });
        return options.cessation === false ? { status: 'indeterminate', code: 'STOP_UNCONFIRMED', cessationConfirmed: false } : { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
    },
    credentials: {
      async issue() {
        calls.push({ kind: 'issue' });
        return { delivery: { token: 'ghs_syntheticQuestionGrant0123' }, metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3, installationId: 2,
          permissions: { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } };
      },
      async revoke() { calls.push({ kind: 'revoke' }); return { kind: 'not-attempted', nextStep: 'ticket 20' }; },
    },
    workers: {
      async activate(invocation, _delivery, events) {
        const script = scripts.shift() ?? { kind: 'complete' };
        calls.push({ kind: 'activate', detail: { prompt: invocation.prompt, context: invocation.context, script: script.kind } });
        const receipt = { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' };
        const started = Promise.resolve({ receipt, invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
        const completed = started.then(async () => {
          if (script.kind === 'complete') return { status: 'success' as const, receipt };
          const context = script.context ?? '';
          const question: WorkerQuestion = { questionId: script.questionId, question: script.question, context, sha256: sha(script.question, context), reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' } };
          let acknowledged = false;
          if (script.notify !== false) {
            const ack = await events!.question!(question);
            acks.push({ ack, show: await control().inspect({ kind: 'show', work_id: invocation.context.workId }) as Extract<ShowView, { kind: 'work' }> });
            acknowledged = ack.status === 'recorded';
            await script.afterAck?.();
          }
          const final = script.completion === 'lost-content' ? { ...question, question: '', context: '' }
            : script.completion === 'other-content' ? { ...question, question: 'A different question', sha256: sha('A different question', context) } : question;
          return { status: 'question' as const, receipt, question: { ...final, acknowledged } };
        });
        return { worker: invocation.context.invocationId, started, completed, close() { calls.push({ kind: 'close' }); } };
      },
      async deliver(worker, directive) { calls.push({ kind: `deliver-${directive.kind}`, detail: worker }); return { status: directive.kind === 'credential' ? 'delivered' as const : 'withdrawn' as const }; },
    },
  };
  return { ports, calls, acks };
}

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[], options: { cessation?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-question-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  const execution = executionDoubles(() => current!.control, scripts, options);
  async function start(inventory: 'empty' | 'unknown' = 'empty') {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: inventory, execution: execution.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
    return current;
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const list = async () => await current!.control.inspect({ kind: 'list' }) as ListView;
  const byNumber = async () => Object.fromEntries((await list()).works.map(work => [work.ticket.number, work])) as Record<number, WorkView>;
  const show = async (work_id: string) => await current!.control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  const until = async (predicate: () => Promise<boolean>, label = 'condition') => {
    for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail(`${label} not reached`);
  };
  const cycle = async () => { current!.time.advance(); await current!.time.sleeping(); };
  /** Like until, but lets the owner loop run further polling iterations (dispatch only happens after a polling iteration). */
  const settle = async (predicate: () => Promise<boolean>, label = 'condition') => {
    for (let i = 0; i < 600; i++) {
      if (await predicate()) return;
      if (current!.time.isSleeping()) current!.time.advance();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`${label} not reached`);
  };
  const activations = () => execution.calls.filter(call => call.kind === 'activate');
  return { github, execution, start, stop, list, byNumber, show, until, settle, cycle, activations, storagePath, control: () => current!.control };
}
const answer = (control: Control, request_id: string, question_id: string, text: string) =>
  control.accept({ request_id, operation: 'answer', question_id, text, origin: 'local-cli' }) as Promise<ControlReceipt>;

test('AC1/AC2/AC3/AC6: ask -> Question+impediment+intent committed before the ACK; cessation then Slot; published with marker; comment answer requeues; recovery via the queue', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(1), question: 'Which file name should the doc use?', context: 'Ticket names none.' }, { kind: 'complete' }]);
  await h.start();
  // #3 asks; its Slot is freed only after cessation; #4 (FIFO behind it) then gets the only Slot while #3 waits for the answer.
  await h.settle(async () => h.activations().length === 2, 'second Work activated after the question freed the Slot');
  const [ack] = h.execution.acks;
  assert.deepEqual(ack!.ack, { status: 'recorded' });
  // At ACK time the commit already holds the Question, its impediment and the publication intent (spec §3.4 "Registrar pergunta").
  const atAck = ack!.show;
  assert.deepEqual(atAck.questions.map(q => [q.questionId, q.state, q.publication.state, q.recordedFrom]), [[qid(1), 'open', 'intended', 'worker-notification']]);
  assert.ok(atAck.work.impediments.some(item => item.code === 'QUESTION_PENDING' && item.questionId === qid(1)));
  assert.equal(atAck.work.execution!.slot.held, true, 'cessation/release come after the record');
  const works = await h.byNumber();
  const waiting = works[3]!;
  assert.deepEqual([waiting.execution!.state, waiting.execution!.end!.outcome, waiting.execution!.end!.questionId, waiting.execution!.end!.cessation, waiting.execution!.slot.held],
    ['ended', 'question', qid(1), 'confirmed', false]);
  assert.deepEqual([waiting.queue.pending, waiting.queue.category, waiting.queue.sequence], [true, 'normal', 1], 'back in its queue position, not executing');
  assert.deepEqual(waiting.dispatch, { state: 'held', reasons: ['QUESTION_PENDING'] });
  const kinds = h.execution.calls.map(call => call.kind);
  assert.ok(kinds.indexOf('stop') < kinds.lastIndexOf('activate'), 'the first boot ceased before the second activation');
  // Published on the Ticket issue with the stable marker and the explicit reply instruction.
  await h.until(async () => (await h.show(waiting.work_id)).questions[0]!.publication.state === 'published', 'published');
  const posted = (remote.comments![3] ?? []).filter(item => item.viaApp === 1);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body, new RegExp(`^<!-- software-factory:question:${qid(1)} -->\\n\\*\\*Software Factory question\\*\\*`));
  assert.ok(posted[0]!.body.includes(`/factory answer ${qid(1)} <your answer>`));
  // Answer by an authorized operator comment on the same Ticket.
  remote.comments![3]!.push(comment(`/factory answer ${qid(1)} Use docs/factory-smoke.md`, operator));
  await h.cycle();
  const answered = await h.show(waiting.work_id);
  assert.deepEqual([answered.questions[0]!.state, answered.questions[0]!.answer!.text, answered.questions[0]!.answer!.author], ['answered', 'Use docs/factory-smoke.md', { kind: 'github', id: 501, login: 'Operator-One' }]);
  assert.equal(answered.work.impediments.some(item => item.code === 'QUESTION_PENDING'), false);
  // #4 still holds the only Slot: #3 waits in its position; when #4 ends, #3 resumes through the queue with an explicit recovery instruction.
  await h.settle(async () => h.activations().length === 3, 'recovery activation');
  const recovery = h.activations()[2]!.detail as { prompt: string; context: { executionId: string } };
  assert.match(recovery.prompt, /^Factory recovery instruction for Ticket https:\/\/github\.com\/acme\/project\/issues\/3\./);
  assert.ok(recovery.prompt.includes('Use docs/factory-smoke.md') && recovery.prompt.includes('Which file name should the doc use?'));
  await h.settle(async () => (await h.byNumber())[3]!.execution!.state === 'ended');
  const resumed = (await h.byNumber())[3]!;
  assert.equal(resumed.execution!.mode, 'recovery');
  assert.deepEqual(resumed.execution!.request.resume, { previousExecutionId: waiting.execution!.executionId, questionId: qid(1),
    answerSha256: createHash('sha256').update('Use docs/factory-smoke.md').digest('hex'), reason: 'NEW_BOOT_REPLACEMENT_SESSION' });
  assert.equal(resumed.execution!.request.branch, waiting.execution!.request.branch, 'same Work branch/workspace');
  assert.deepEqual(resumed.previousExecutions.map(item => item.executionId), [waiting.execution!.executionId]);
  assert.deepEqual(resumed.history.filter(item => item.event.startsWith('question-')).map(item => item.event), ['question-recorded', 'question-published', 'question-answered']);
  const status = await h.control().inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual(status.questions, { open: 0, answered: 1, unpublished: 0 });
  await h.stop();
  assert.doesNotMatch(await readFile(h.storagePath, 'latin1'), /ghs_synthetic/);
});

test('AC4: bot, third party, prose, wrong prefix and another Work\'s Ticket never answer; CLI (administrator account) does', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(2), question: 'Approve the seams?' }, { kind: 'ask', questionId: qid(13), question: 'Other Work question' }]);
  await h.start();
  await h.settle(async () => { const works = await h.byNumber(); return works[3]?.execution?.slot.held === false && works[4]?.execution?.slot.held === false; });
  const work = (await h.byNumber())[3]!;
  (remote.comments ??= {})[3] = [...(remote.comments[3] ?? []),
    comment(`/factory answer ${qid(2)} yes`, { id: 9, login: 'helper[bot]', type: 'Bot' }),
    comment(`/factory answer ${qid(2)} yes`, { id: 10, login: 'stranger', type: 'User' }),
    comment(`I approve. /factory answer ${qid(2)} yes`, operator),
    comment(` /factory answer ${qid(2)} yes`, operator),
    comment(`/factory approve ${qid(2)}`, operator)];
  // The same command on ANOTHER Work's Ticket never answers this Work's Question (not its context).
  remote.comments[4] = [...(remote.comments[4] ?? []), comment(`/factory answer ${qid(2)} yes`, operator, 4)];
  await h.cycle(); await h.cycle();
  let view = await h.show(work.work_id);
  assert.equal(view.questions[0]!.state, 'open');
  assert.ok(view.work.impediments.some(item => item.code === 'QUESTION_PENDING'));
  assert.deepEqual(view.questions[0]!.ignored.map(item => item.code).sort(), ['AUTHOR_IS_BOT', 'AUTHOR_NOT_OPERATOR', 'QUESTION_NOT_IN_CONTEXT']);
  assert.equal(h.activations().length, 2, 'nothing reactivated');
  const before = h.activations().length;
  const receipt = await answer(h.control(), 'cli-answer-1', qid(2), 'Yes, seams approved: the public module API.');
  assert.deepEqual([receipt.operation, 'outcome' in receipt && receipt.outcome, 'work_id' in receipt && receipt.work_id], ['answer', 'accepted', work.work_id]);
  assert.equal(h.activations().length, before, 'accept never spawns: the ACK is durable, the start goes through the queue');
  view = await h.show(work.work_id);
  assert.deepEqual(view.questions[0]!.answer!.author, { kind: 'local-administrator' });
  assert.deepEqual(view.questions[0]!.answer!.origin, { kind: 'local-cli', request_id: 'cli-answer-1' });
});

test('AC5: first durable answer wins; duplicates/later answers never replace it; same request id is idempotent, different content conflicts', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(3), question: 'Which base?' }, { kind: 'complete' }]);
  await h.start();
  await h.until(async () => (await h.byNumber())[3]?.execution?.slot.held === false);
  const work = (await h.byNumber())[3]!;
  remote.comments![3]!.push(comment(`/factory answer ${qid(3)} first`, operator), comment(`/factory answer ${qid(3)} second`, operator));
  await h.cycle();
  const first = await answer(h.control(), 'cli-late', qid(3), 'third');
  assert.deepEqual(['outcome' in first && first.outcome, 'reason' in first && first.reason], ['not-applied', 'QUESTION_ALREADY_ANSWERED']);
  assert.deepEqual(await answer(h.control(), 'cli-late', qid(3), 'third'), first, 'same identity and content: the recorded result, not reapplied');
  assert.deepEqual(await h.control().accept({ request_id: 'cli-late', operation: 'answer', question_id: qid(3), text: 'changed', origin: 'local-cli' }),
    { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual(await h.control().inspect({ kind: 'request', request_id: 'cli-late' }), { kind: 'request', receipt: first });
  const view = await h.show(work.work_id);
  assert.equal(view.questions[0]!.answer!.text, 'first');
  assert.ok(view.questions[0]!.ignored.some(item => item.code === 'QUESTION_ALREADY_ANSWERED' && item.origin.startsWith('github-comment:')));
  // Repeated polling of the same comments changes nothing (cursor + per-comment identity).
  await h.cycle(); await h.cycle();
  const again = await h.show(work.work_id);
  assert.deepEqual(again.questions[0]!.answer, view.questions[0]!.answer);
  assert.equal(again.work.history.filter(item => item.event === 'question-answered').length, 1);
  const unknown = await answer(h.control(), 'cli-unknown', qid(99), 'x');
  assert.deepEqual(['outcome' in unknown && unknown.outcome, 'reason' in unknown && unknown.reason], ['not-applied', 'QUESTION_NOT_FOUND']);
});

test('AC5: a lost ACK recovers the SAME identity/content from the completion; a lost notification is registered once from the preserved request', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const h = await harness(t, remote, [
    { kind: 'ask', questionId: qid(4), question: 'Q four', completion: 'same' },
    { kind: 'ask', questionId: qid(5), question: 'Q five', notify: false }]);
  await h.start();
  await h.settle(async () => { const works = await h.byNumber(); return works[3]?.execution?.slot.held === false && works[4]?.execution?.slot.held === false; });
  const works = await h.byNumber();
  const four = await h.show(works[3]!.work_id), five = await h.show(works[4]!.work_id);
  assert.deepEqual(four.questions.map(q => [q.questionId, q.recordedFrom, q.content.question]), [[qid(4), 'worker-notification', 'Q four']], 'completion replay deduplicated');
  assert.deepEqual(five.questions.map(q => [q.questionId, q.recordedFrom, q.content.question]), [[qid(5), 'worker-completion', 'Q five']]);
  assert.equal(four.work.impediments.filter(item => item.code === 'QUESTION_PENDING').length, 1);
  await h.until(async () => (remote.comments?.[4] ?? []).length === 1 && (remote.comments?.[3] ?? []).length === 1, 'each Question published once');
});

test('AC5/AC7: same identity with different content is a conflict; lost content is never invented (no Question, explicit impediment)', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const h = await harness(t, remote, [
    { kind: 'ask', questionId: qid(6), question: 'Original', completion: 'other-content' },
    { kind: 'ask', questionId: qid(7), question: 'Lost one', notify: false, completion: 'lost-content' }]);
  await h.start();
  await h.settle(async () => { const works = await h.byNumber(); return Boolean(works[3]?.execution?.end && works[4]?.execution?.end); });
  await h.cycle();
  const works = await h.byNumber();
  const conflict = await h.show(works[3]!.work_id);
  assert.equal(conflict.questions[0]!.content.question, 'Original', 'recorded content is never replaced');
  assert.equal(conflict.work.execution!.end!.code, 'QUESTION_ID_CONFLICT');
  const lost = await h.show(works[4]!.work_id);
  assert.deepEqual(lost.questions, []);
  assert.ok(lost.work.impediments.some(item => item.code === 'QUESTION_CONTENT_LOST'));
  assert.deepEqual([lost.work.execution!.end!.outcome, lost.work.execution!.end!.code], ['question', 'QUESTION_CONTENT_LOST']);
  assert.equal((remote.comments?.[4] ?? []).length, 0, 'nothing invented or published');
  assert.equal(lost.work.dispatch.state, 'held');
  assert.equal(h.activations().length, 2);
});

test('AC2: ambiguous publication is discovered before any repost; an incomplete search never proves absence; several candidates are never chosen', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], postOutcomes: ['unknown-created'] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(8), question: 'Ambiguous?' }]);
  await h.start();
  await h.until(async () => (await h.byNumber())[3]?.execution?.slot.held === false);
  const work = (await h.byNumber())[3]!;
  await h.until(async () => (await h.show(work.work_id)).questions[0]!.publication.state === 'ambiguous');
  remote.incompleteSearches = 2;
  await h.cycle(); await h.cycle();
  assert.equal((await h.show(work.work_id)).questions[0]!.publication.state, 'ambiguous', 'incomplete discovery: no conclusion, no repost');
  assert.equal(h.github.calls.filter(call => call.method === 'postComment').length, 1);
  await h.cycle();
  const found = (await h.show(work.work_id)).questions[0]!;
  assert.equal(found.publication.state, 'published');
  assert.equal(found.publication.comment!.commentId, remote.comments![3]![0]!.commentId, 'discovered, not reposted');
  assert.equal(h.github.calls.filter(call => call.method === 'postComment').length, 1);
  assert.deepEqual(found.publication.attempts.map(item => item.outcome), ['attempting', 'unknown', 'discovery-incomplete', 'discovery-incomplete', 'discovered']);
});

test('AC2: unknown outcome with a COMPLETE empty discovery reposts once; duplicates found later are a conflict, never chosen', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], postOutcomes: ['unknown-not-created'] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(9), question: 'Repost?' }]);
  await h.start();
  await h.until(async () => (await h.byNumber())[3]?.execution?.slot.held === false);
  const work = (await h.byNumber())[3]!;
  await h.until(async () => (await h.show(work.work_id)).questions[0]!.publication.state === 'ambiguous');
  await h.cycle();
  await h.until(async () => (await h.show(work.work_id)).questions[0]!.publication.state === 'published');
  assert.equal(h.github.calls.filter(call => call.method === 'postComment').length, 2);
  assert.equal(remote.comments![3]!.length, 1);
});

test('AC6/AC7: answer while the controller is down is accepted after restart (dispatch still closed); removes only its impediment; withdrawn label blocks the resume', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(10), question: 'Restart?' }, { kind: 'complete' }]);
  await h.start();
  await h.until(async () => (await h.byNumber())[3]?.execution?.slot.held === false);
  await h.until(async () => (remote.comments?.[3] ?? []).length === 1);
  const work = (await h.byNumber())[3]!;
  await h.stop();
  // While the owner is down: the operator answers on GitHub.
  remote.comments![3]!.push(comment(`/factory answer ${qid(10)} go ahead`, operator));
  // Restart with an unknown runtime inventory: dispatch stays closed, yet the answer is accepted (resposta durante o boot).
  await h.start('unknown');
  await h.until(async () => (await h.show(work.work_id)).questions[0]!.state === 'answered', 'answer accepted after restart');
  let view = await h.show(work.work_id);
  assert.deepEqual(view.work.dispatch.reasons, ['RECONCILIATION_REQUIRED']);
  assert.equal(view.work.queue.sequence, 1);
  assert.equal(h.activations().length, 1, 'no spawn by the answer');
  await h.stop();
  // Authorization withdrawn (label removed) before the next owner: the answer never renews authorization.
  remote.issues[0]!.labels = [];
  await h.start('empty');
  await h.cycle(); await h.cycle();
  view = await h.show(work.work_id);
  assert.equal(h.activations().length, 1, 'withdrawn authorization blocks the resume despite the answer');
  assert.deepEqual([view.work.queue.pending, view.work.queue.sequence], [true, 1]);
  // Label restored: resumes through the queue.
  remote.issues[0]!.labels = [{ id: 55, name: 'ready-for-agent' }];
  await h.cycle();
  await h.settle(async () => h.activations().length === 2, 'resume after authorization restored');
});

test('AC5: an insufficient answer can lead to ANOTHER Question (new identity); the answered one stays preserved', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(11), question: 'Which file?' }, { kind: 'ask', questionId: qid(12), question: 'Which directory for that file?' }]);
  await h.start();
  await h.until(async () => (await h.byNumber())[3]?.execution?.slot.held === false);
  const work = (await h.byNumber())[3]!;
  await answer(h.control(), 'cli-1', qid(11), 'a.md');
  await h.cycle();
  await h.settle(async () => (await h.show(work.work_id)).questions.length === 2 && (await h.byNumber())[3]!.execution!.slot.held === false);
  const view = await h.show(work.work_id);
  assert.deepEqual(view.questions.map((q: QuestionView) => [q.questionId, q.state]), [[qid(11), 'answered'], [qid(12), 'open']]);
  assert.deepEqual(view.work.impediments.filter(item => item.code === 'QUESTION_PENDING').map(item => item.questionId), [qid(12)]);
  assert.equal(view.work.previousExecutions.length, 1);
});

test('AC6: the answer removes ONLY its Question impediment; a dependency impediment that appeared meanwhile still blocks the resume', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(8, { labels: [] })] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(14), question: 'Proceed?' }, { kind: 'complete' }]);
  await h.start();
  await h.until(async () => (await h.byNumber())[3]?.execution?.slot.held === false);
  const work = (await h.byNumber())[3]!;
  // A native blocker is added while the Work waits for its answer.
  remote.issues[0]!.blockedBy = [8];
  await h.cycle();
  await answer(h.control(), 'cli-dep', qid(14), 'yes');
  // Right after the answer commit (no polling in between): the dependency impediment is untouched.
  const atAnswer = await h.show(work.work_id);
  assert.deepEqual(atAnswer.work.impediments.map(item => item.code), ['DEPENDENCY_PENDING']);
  await h.cycle(); await h.cycle();
  const view = await h.show(work.work_id);
  assert.equal(view.work.impediments.some(item => item.code === 'QUESTION_PENDING'), false);
  assert.ok(view.work.impediments.some(item => item.code.startsWith('DEPENDENC')), JSON.stringify(view.work.impediments));
  assert.equal(h.activations().length, 1, 'still blocked by the dependency');
  remote.issues[1]!.state = 'closed'; remote.issues[1]!.stateReason = 'completed';
  remote.issues[0]!.blockedBy = [];
  await h.settle(async () => h.activations().length === 2, 'resumes once the other impediment is gone');
});

test('AC3: cessation not confirmed keeps the Slot and the Work out of the queue; the Question is still published and answerable, without a resume', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const h = await harness(t, remote, [{ kind: 'ask', questionId: qid(15), question: 'Stuck?' }, { kind: 'complete' }], { cessation: false });
  await h.start();
  await h.until(async () => (await h.byNumber())[3]?.execution?.end?.cessation === 'unconfirmed');
  const work = (await h.byNumber())[3]!;
  assert.deepEqual([work.execution!.slot.held, work.queue.pending], [true, false]);
  assert.deepEqual((await h.list()).slots, { capacity: 1, held: 1 });
  await h.until(async () => (await h.show(work.work_id)).questions[0]!.publication.state === 'published', 'publication independent of cessation');
  await answer(h.control(), 'cli-stuck', qid(15), 'yes');
  await h.cycle(); await h.cycle();
  assert.equal(h.activations().length, 1, 'no resume and no other Work while the uncertain Slot is held');
});
