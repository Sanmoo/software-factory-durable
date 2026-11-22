import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionPorts, ListView, ShowView, WorkView } from '../../src/control/types.js';
import type { WorkerQuestion } from '../../src/workers/index.js';
import { githubDoubles, manualClock, scope } from './doubles.js';
import { card, jiraDoubles, jiraSource, type JiraRemote } from './jira-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Jira ticket 06 (spec §4) at flow level: real Control + Pi Durable + temporary SQLite; doubled GitHub, Jira, clock and execution boundaries.
// A Jira Work's Question is published on its origin Card (recoverable comment, reserved header, short reference), answered there by an
// ordinary comment (even from the Factory's shared account), and the Work resumes through its queue. NOT evidence of a real Jira site.
const sha = (question: string, context: string) => createHash('sha256').update(JSON.stringify({ question, context })).digest('hex');
const qid = '0b9c6a52-3d3e-4c8f-9a51-000000000017';
type Call = { kind: string; detail?: unknown };

function ports(calls: Call[], asks: number): ExecutionPorts {
  let remaining = asks;
  return {
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' },
    capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare' });
        return {
          status: 'success',
          environment: `env-${'c'.repeat(64)}` as never,
          seeds: [{ name: 'factory/skill-pack/factory-skills-v1', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: {
            path: '/workspace/checkout',
            repository: input.checkout.repository,
            repositoryId: input.checkout.repositoryId,
            base: 'main',
            branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git',
            reused: calls.filter(call => call.kind === 'prepare').length > 1,
            preparedAt: new Date().toISOString(),
          },
        };
      },
      async start() {
        calls.push({ kind: 'start' });
        return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(calls.length).padStart(12, '5')}` as never };
      },
      async stop() {
        calls.push({ kind: 'stop' });
        return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
    },
    credentials: {
      async issue() {
        calls.push({ kind: 'issue' });
        return {
          delivery: { token: 'ghs_syntheticJiraQuestion0123' },
          metadata: {
            role: 'builder',
            purpose: 'builder-start',
            repository: 'acme/project',
            repositoryId: 3,
            installationId: 2,
            permissions: { metadata: 'read', contents: 'read', issues: 'read' },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      },
      async revoke() {
        calls.push({ kind: 'revoke' });
        return { kind: 'not-attempted', nextStep: 'synthetic' };
      },
    },
    workers: {
      async activate(invocation, _delivery, events) {
        const ask = remaining > 0;
        remaining -= 1;
        calls.push({ kind: 'activate', detail: { prompt: invocation.prompt } });
        const receipt = { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' };
        const started = Promise.resolve({
          receipt,
          invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
        });
        const completed = started.then(async () => {
          if (!ask) return { status: 'success' as const, receipt };
          const question: WorkerQuestion = {
            questionId: qid,
            question: 'Preservo a API v1?',
            context: 'O Card não diz.',
            sha256: sha('Preservo a API v1?', 'O Card não diz.'),
            reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' },
          };
          const ack = await events!.question!(question);
          return { status: 'question' as const, receipt, question: { ...question, acknowledged: ack.status === 'recorded' } };
        });
        return {
          worker: invocation.context.invocationId,
          started,
          completed,
          close() {
            calls.push({ kind: 'close' });
          },
        };
      },
      async deliver(_worker, directive) {
        calls.push({ kind: `deliver-${directive.kind}` });
        return { status: directive.kind === 'credential' ? 'delivered' : 'withdrawn' };
      },
    },
  };
}

async function harness(t: { after(fn: () => Promise<void>): void }, jira: JiraRemote) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-jira-question-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ issues: [], pulls: {} });
  const doubles = jiraDoubles(jira);
  const calls: Call[] = [];
  const execution = ports(calls, 1);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<unknown>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      execution,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], sources: [jiraSource()], trackers: { jira: doubles.tracker } },
      polling: { intervalSeconds: 60, clock: time.clock },
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() {
    current!.stop.abort();
    await current!.running;
  }
  t.after(async () => {
    if (current && !current.stop.signal.aborted) await stop();
  });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView;
  const show = async () => (await current!.control.inspect({ kind: 'show', work_id: (await work()).work_id })) as Extract<ShowView, { kind: 'work' }>;
  const settle = (label: string, predicate: () => Promise<boolean>) =>
    untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (current!.time.isSleeping()) current!.time.advance();
        return false;
      },
      5,
    );
  const posts = () => doubles.calls.filter(call => call.method === 'publishComment').map(call => (call.args as { lines: string[] }).lines);
  const activations = () => calls.filter(call => call.kind === 'activate');
  const request = (request_id: string) => current!.control.inspect({ kind: 'request', request_id }) as Promise<{ receipt: Record<string, unknown> | null }>;
  return { jira: doubles, calls, start, stop, work, show, settle, posts, activations, request };
}
const question = async (h: Awaited<ReturnType<typeof harness>>) => (await h.show()).questions[0];

test('the Question is published on the origin Card; a shared-account /factory answer is accepted once, survives a restart re-read and resumes via the queue', async t => {
  const remote: JiraRemote = { cards: [card('81017', 'PAG-42')] };
  const h = await harness(t, remote);
  await h.start();
  await h.settle('question published', async () => (await question(h))?.publication.state === 'published');
  const published = await question(h);
  assert.equal(published!.jira!.ref, 'Q-1');
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0]![0], '[Software Factory · Pergunta Q-1]');
  assert.ok(h.posts()[0]!.includes('Preservo a API v1?'));
  assert.ok((await h.work()).impediments.some(item => item.code === 'QUESTION_PENDING' && item.nextStep.includes('/factory q1: <text>')));
  // Conversation, then the answer, both from the Factory's shared account: only the reserved header marks automatic text.
  h.jira.write('81017', 'acho que sim, mas vou confirmar');
  const answerId = h.jira.write('81017', '/factory sim, preserve a API');
  await h.settle('answered', async () => (await question(h))?.state === 'answered');
  const answered = await question(h);
  assert.deepEqual([answered!.answer!.text, answered!.answer!.author], ['sim, preserve a API', { kind: 'jira', accountId: 'acc-factory' }]);
  const request_id = `jira-comment-site_002dA-81017-${answerId}`;
  assert.deepEqual((await h.request(request_id)).receipt, {
    kind: 'durable',
    request_id,
    operation: 'answer',
    question_id: qid,
    outcome: 'accepted',
    reason: null,
    work_id: (await h.work()).work_id,
  });
  assert.equal(
    (await h.work()).impediments.some(item => item.code === 'QUESTION_PENDING'),
    false,
  );
  // The Work resumes through its queue: a recovery activation carrying the answer (no direct Execution from the comment).
  await h.settle('recovery activation', async () => h.activations().length === 2);
  assert.ok((h.activations()[1]!.detail as { prompt: string }).prompt.includes('sim, preserve a API'));
  assert.ok((h.activations()[1]!.detail as { prompt: string }).prompt.includes('Jira account acc-factory'));
  await h.settle('recovery ended', async () => (await h.work()).execution?.state === 'ended');
  // Restart and re-deliver every comment: same receipt, one transition, no new POST, the Question stays answered.
  await h.stop();
  remote.redeliver = true;
  const reads = h.jira.methods().filter(method => method === 'readInputs').length;
  await h.start();
  await h.settle('comments re-read after restart', async () => h.jira.methods().filter(method => method === 'readInputs').length > reads + 1);
  const after = await h.show();
  assert.equal(after.questions[0]!.state, 'answered');
  assert.deepEqual(after.work.history.filter(item => item.event === 'question-answered').length, 1);
  assert.equal(h.posts().length, 1);
  assert.equal(h.activations().length, 2);
  assert.deepEqual(
    h.jira.methods().filter(method => method.startsWith('unexpected:')),
    [],
  );
});

test('guidance, edited and restricted comments never answer; the Question stays open until a valid new comment', async t => {
  const remote: JiraRemote = { cards: [card('81017', 'PAG-42')] };
  const h = await harness(t, remote);
  await h.start();
  await h.settle('question published', async () => (await question(h))?.publication.state === 'published');
  const foreign = h.jira.write('81017', '/factory q9: sim');
  const edited = h.jira.write('81017', '/factory sim', { edited: true });
  const restricted = h.jira.write('81017', '/factory sim', { accountId: 'acc-human', restricted: true });
  const header = h.jira.write('81017', '[Software Factory · Pergunta Q-1]\n/factory sim', { accountId: 'acc-human' });
  const incomplete = h.jira.write('81017', '/factory answer Q-1', { accountId: 'acc-human' });
  await h.settle('three guidance replies posted', async () => h.posts().length === 4);
  const receipt = async (id: string) => (await h.request(`jira-comment-site_002dA-81017-${id}`)).receipt ?? null;
  assert.deepEqual(
    [(await receipt(foreign))?.reason, (await receipt(edited))?.reason, (await receipt(restricted))?.reason, (await receipt(incomplete))?.reason],
    ['JIRA_QUESTION_NOT_OPEN_HERE', 'JIRA_COMMENT_EDITED', 'JIRA_COMMENT_RESTRICTED', 'JIRA_COMMAND_INCOMPLETE'],
  );
  assert.equal((await receipt(restricted))?.outcome, 'ignored');
  assert.equal(await receipt(header), null, 'reserved text records nothing');
  const replies = h.posts().slice(1);
  assert.ok(replies.every(lines => lines[0]!.startsWith('[Software Factory · Orientação R-')));
  assert.ok(
    replies.every(lines => !lines.join('\n').includes('/factory sim')),
    'guidance never quotes the comment',
  );
  assert.ok(replies[0]!.join('\n').includes('Open questions of this Card: Q-1.'));
  assert.equal((await question(h))!.state, 'open');
  // The guidance comments themselves (reserved header, shared account) are never instructions; a valid new comment answers.
  h.jira.write('81017', '/factory q1: sim', { accountId: 'acc-human' });
  await h.settle('answered', async () => (await question(h))?.state === 'answered');
  assert.deepEqual((await question(h))!.answer!.author, { kind: 'jira', accountId: 'acc-human' });
  assert.equal(h.posts().length, 4, 'no reply to an accepted answer');
});

test('an uncertain Question POST is reconciled: confirmed by its one own copy; a look-alike header of another account neither confirms nor answers', async t => {
  const remote: JiraRemote = { cards: [card('81017', 'PAG-42')], postOutcomes: ['lost-not-created', 'lost-created'] };
  const h = await harness(t, remote);
  await h.start();
  await h.settle('first POST attempted', async () => h.posts().length === 1);
  // Someone copies the header while the outcome is unknown: it is not the Factory's account, so the next complete read finds the Question absent.
  h.jira.write('81017', '[Software Factory · Pergunta Q-1]\nThe Software Factory needs an answer', { accountId: 'acc-human' });
  await h.settle('reposted with the same reference', async () => h.posts().length === 2);
  assert.deepEqual(
    h.posts().map(lines => lines[0]),
    ['[Software Factory · Pergunta Q-1]', '[Software Factory · Pergunta Q-1]'],
  );
  // The second answer was lost too, but its copy exists: one exact own copy confirms, nothing else is sent.
  await h.settle('confirmed', async () => (await question(h))?.publication.state === 'published');
  assert.equal(h.posts().length, 2);
  const shown = await question(h);
  assert.equal(shown!.state, 'open');
  assert.match(String(shown!.publication.comment!.url), /focusedCommentId=/);
});

test('a /factory comment without observed author or with an invalid ADF body is recorded as ignored, never answers, and the cursor moves past it', async t => {
  const remote: JiraRemote = { cards: [card('81017', 'PAG-42')] };
  const h = await harness(t, remote);
  await h.start();
  await h.settle('question published', async () => (await question(h))?.publication.state === 'published');
  const anonymous = h.jira.write('81017', '/factory sim', { accountId: null });
  const unreadable = h.jira.write('81017', null, { accountId: 'acc-human' });
  const receipt = async (id: string) => (await h.request(`jira-comment-site_002dA-81017-${id}`)).receipt ?? null;
  await h.settle('both recorded', async () => Boolean(await receipt(anonymous)) && Boolean(await receipt(unreadable)));
  assert.deepEqual([(await receipt(anonymous))?.outcome, (await receipt(anonymous))?.reason], ['ignored', 'JIRA_COMMENT_AUTHOR_UNOBSERVED']);
  assert.deepEqual([(await receipt(unreadable))?.outcome, (await receipt(unreadable))?.reason], ['ignored', 'JIRA_COMMENT_ADF_INVALID']);
  assert.equal((await question(h))!.state, 'open', 'neither answered the single open question');
  assert.equal(h.posts().length, 1, 'no reply on the Card: only the question');
  h.jira.write('81017', '/factory sim', { accountId: 'acc-human' });
  await h.settle('answered', async () => (await question(h))?.state === 'answered');
});
