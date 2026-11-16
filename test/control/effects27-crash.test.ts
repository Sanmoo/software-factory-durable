import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilHolds } from '../runner/budget.js';
import { fileURLToPath } from 'node:url';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlReceipt, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { readHost, recoveryDoubles } from './recovery-doubles.js';

// Ticket 27, REAL crash cuts at the controller's external effects (one representative scenario per mechanism; the variations are rule tests
// in question-rules.test.ts): a real controller child (Control + Pi Durable/SQLite + Records) is SIGKILLed at the cut with its doubled boot
// left active; a NEW Control boots on the same storage/Records (ticket 26 reconciliation) and the effect is RECOVERED, never repeated.
// Doubled: Sandbox host (file-backed), Builder (scripted), credentials, GitHub (its comment store survives the kill through a file).
// Not evidence of a VM, worker process, model or real GitHub (the real-boundary recipe is test/entrypoints/crashfx27-qualification.ts).

async function crash(dir: string, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./effects27-crash-child.js', import.meta.url)), dir, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk; if (output.includes('CUT')) child.kill('SIGKILL'); });
    child.on('exit', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`child exited without crash: ${output}`)));
  });
}

async function reopen(t: { after(fn: () => Promise<void>): void }, dir: string, remote: Remote) {
  const doubles = recoveryDoubles(dir, []);
  const github = githubDoubles(remote);
  const time = manualClock();
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: doubles.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; });
  const work = async () => (await control.inspect({ kind: 'list' }) as ListView).works.find(item => item.ticket.number === 3) as WorkView;
  const show = async (work_id: string) => await control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  // Bounded by the runner budget (ticket 40), never a counted loop.
  const until = (predicate: () => Promise<boolean>, label: string) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  return { control, doubles, github, work, show, until };
}
const scratch = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-effects27-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('AC5 lost ACK: the request the Builder preserved before the controller died is recorded at boot with its identity and content, published once and answerable once', async t => {
  const dir = await scratch(t);
  await crash(dir, 'question-lost');
  const questionId = '0b9c6a52-3d3e-4c8f-9a51-000000000271';
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await reopen(t, dir, remote);
  await h.until(async () => (await h.work())?.execution?.end?.questionId === questionId, 'interrupted Execution bound to the recovered Question');
  const work = await h.work();
  const execution = work.execution!;
  assert.deepEqual([execution.end!.outcome, execution.end!.cessation, execution.recovery![0]!.decision, work.pendingRecovery, work.budget?.recoveries.consumed ?? 0],
    ['question', 'confirmed', 'settled', null, 0], 'the Work waits for the answer: no operational recovery, no charge, no substitute Builder');
  assert.ok(readHost(dir).log.some(item => item.kind === 'observe-question'), 'located through the Records question facet');
  await h.until(async () => (await h.show(work.work_id)).questions[0]?.publication.state === 'published', 'recovered Question published');
  const [question] = (await h.show(work.work_id)).questions;
  assert.deepEqual([question!.questionId, question!.recordedFrom, question!.content.question, question!.content.context, question!.executionId],
    [questionId, 'records-recovery', 'Which port should the service use?', 'Checked the docs.', execution.executionId], 'same identity and complete content, never invented');
  assert.equal(h.github.calls.filter(call => call.method === 'postComment').length, 1);
  assert.ok(work.impediments.some(item => item.code === 'QUESTION_PENDING' && item.questionId === questionId));
  // One answer is accepted; a second one never replaces it.
  const first = await h.control.accept({ request_id: 'a-27-1', operation: 'answer', question_id: questionId, text: 'Port 8080.', origin: 'local-cli' }) as ControlReceipt;
  const second = await h.control.accept({ request_id: 'a-27-2', operation: 'answer', question_id: questionId, text: 'Port 9090.', origin: 'local-cli' }) as ControlReceipt;
  assert.deepEqual([(first as { outcome: string }).outcome, (second as { outcome: string; reason: string | null }).reason], ['accepted', 'QUESTION_ALREADY_ANSWERED']);
  assert.equal(h.doubles.calls('activate').length, 1, 'nothing started by the recovery or by the answer before the dispatch revalidates (queue)');
});

test('AC1/AC3/AC4 Question POST landed, controller killed before the result commit: the boot discovers the ONE own comment and links it; never reposted', async t => {
  const dir = await scratch(t);
  await crash(dir, 'question-post');
  const questionId = '0b9c6a52-3d3e-4c8f-9a51-000000000272';
  const persisted = JSON.parse(await readFile(join(dir, 'github.json'), 'utf8')) as { comments: Remote['comments']; posts: number };
  assert.equal(persisted.comments![3]!.length, 1, 'the comment exists on (doubled) GitHub');
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], comments: persisted.comments! };
  const h = await reopen(t, dir, remote);
  await h.until(async () => {
    const work = await h.work();
    return Boolean(work && (await h.show(work.work_id)).questions[0]?.publication.state === 'published');
  }, 'publication discovered');
  const work = await h.work();
  const [question] = (await h.show(work.work_id)).questions;
  assert.deepEqual(question!.publication.attempts.map(item => item.outcome), ['attempting', 'discovered'], 'the crash-left attempt was discovered, not resent');
  assert.equal(question!.publication.comment!.commentId, persisted.comments![3]![0]!.commentId);
  assert.equal(h.github.calls.filter(call => call.method === 'postComment').length, 0, 'no second POST after the restart');
  assert.equal(remote.comments![3]!.length, 1, 'no duplicate comment');
  assert.deepEqual([work.execution!.end!.outcome, work.execution!.end!.questionId, question!.questionId], ['question', questionId, questionId]);
});
