import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControl } from '../../src/control/index.js';
import type { CheckoutFingerprint } from '../../src/contracts/index.js';
import type { Control, ControlReceipt, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { recoveryDoubles, type RecoveryScript } from './recovery-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (Q11), ticket 48: real Control + Pi Durable/SQLite + Records; doubled Sandbox host (with the checkout fingerprint port), Builder,
// credentials and GitHub. A Builder budget end WITH Host-observed progress continues on the Work's own counter; without it, it recovers.

const budgetEnd: RecoveryScript = { kind: 'fail', code: 'WORKER_BUDGET_EXHAUSTED' };
const fingerprint = (version: number): CheckoutFingerprint => ({
  status: 'observed',
  head: 'ref: refs/heads/factory/3-x',
  ref: String(version).padStart(40, '0'),
  git: `git-${version}`,
  tree: `tree-${version}`,
  entries: 10,
  observedAt: new Date().toISOString(),
});

async function harness(
  t: { after(fn: () => Promise<void>): void },
  options: { progress: boolean; builderBudget?: { requests?: number; toolCalls?: number; requestTimeoutMinutes?: number } },
) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-continuation48-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  // The "checkout" changes while a Builder runs (a commit per activation) only when `progress` holds; the Host observes it.
  let version = 0;
  const invocations: { builderBudget?: unknown }[] = [];
  const scripts: RecoveryScript[] = [];
  const doubles = recoveryDoubles(dir, [], {
    observeCheckout: () => fingerprint(version),
    guestShutdown: { result: 'clean', reason: 'GUEST_ROOT_READ_ONLY' },
    onActivate: invocation => {
      invocations.push({ ...(invocation.builderBudget ? { builderBudget: invocation.builderBudget } : {}) });
      if (options.progress) version++;
    },
    script: () => scripts.shift() ?? { kind: 'complete' },
  });
  const time = manualClock();
  const control: Control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: doubles.ports,
    access: {
      tracker: github.tracker,
      repository: github.repository,
      repositories: [{ ...scope, ...(options.builderBudget ? { builderBudget: options.builderBudget } : {}) }],
      operators: ['operator-one'],
    },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    stop.abort();
    await running;
  });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView;
  const until = (predicate: () => Promise<boolean> | boolean, label: string) =>
    untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (time.isSleeping()) time.advance();
        return false;
      },
      5,
    );
  const idle = (count: number) =>
    until(async () => doubles.calls('activate').length === count && (await work()).execution?.slot.held === false, `${count} activations ended`);
  const rounds = async (n: number) => {
    for (let i = 0; i < n; i++) {
      time.advance();
      await time.sleeping();
    }
  };
  await time.sleeping();
  return { control, doubles, scripts, work, until, idle, rounds, invocations };
}

test('ticket 48: a budget end WITH progress is a continuation on its own counter (no wait, recoveries untouched), stopped cleanly; the new session gets the summary', async t => {
  const h = await harness(t, { progress: true });
  h.scripts.push(budgetEnd, { kind: 'complete' });
  await h.idle(1);
  let work = await h.work();
  const first = work.execution!;
  assert.deepEqual(
    [first.end!.code, first.checkout!.progress, first.checkout!.guestStop],
    ['WORKER_BUDGET_EXHAUSTED', { kind: 'progress', commits: true, checkout: true }, 'clean:GUEST_ROOT_READ_ONLY'],
  );
  assert.ok(
    work.history.some(item => item.event === 'budget-end-observed' && /progress:commits\+checkout; guest-stop clean:GUEST_ROOT_READ_ONLY/.test(item.detail)),
  );
  assert.ok(
    h.doubles.calls('stop').some(item => (item.detail as { reason: string }).reason === 'builder execution ended'),
    'the clean stop of ticket 47',
  );
  await h.idle(2);
  work = await h.work();
  assert.deepEqual(
    [
      work.execution!.interruption!.reason,
      work.execution!.charge!.kind,
      work.budget!.continuations!.consumed,
      work.budget!.recoveries.consumed,
      work.pendingRecovery,
    ],
    ['BUDGET_CONTINUATION', 'continuation', 1, 0, null],
  );
  const prompt = h.doubles.prompts.at(-1)!.prompt;
  assert.match(prompt, /CONTINUATION of the same work, not a failure recovery/);
  assert.match(prompt, /Factory state summary/);
  assert.match(prompt, /progress observed by the host: new commits and changed checkout/);
  assert.match(prompt, /last-phase: implementation \(no review handoff recorded by the host\)/);
  assert.match(prompt, /answered-questions: none/);
  assert.match(prompt, /BUDGET_CONTINUATION:WORKER_BUDGET_EXHAUSTED/);
  // The continuation is shown with its own counter.
  assert.deepEqual([work.limits.continuations!.limit, work.limits.continuations!.consumed], [5, 1]);
});

test('ticket 48: a budget end WITHOUT progress goes to recovery as before (recoveries counter, persisted wait)', async t => {
  const h = await harness(t, { progress: false });
  h.scripts.push(budgetEnd);
  await h.idle(1);
  const work = await h.work();
  assert.deepEqual([work.execution!.checkout!.progress, work.pendingRecovery!.kind, work.pendingRecovery!.waitSeconds], [{ kind: 'none' }, undefined, 5]);
  assert.ok(work.history.some(item => item.event === 'recovery-requested' && /interrupted:WORKER_BUDGET_EXHAUSTED/.test(item.detail)));
  assert.equal(work.budget!.continuations!.consumed, 0);
});

test('ticket 48: 5 continuations per Work; the 6th budget end with progress is an impediment whose explicit exit is `grant --continuations`', async t => {
  const h = await harness(t, { progress: true });
  h.scripts.push(budgetEnd, budgetEnd, budgetEnd, budgetEnd, budgetEnd, budgetEnd, { kind: 'complete' });
  await h.idle(6);
  await h.until(async () => (await h.work()).impediments.some(item => item.code === 'CONTINUATION_LIMIT_REACHED'), 'continuations exhausted');
  let work = await h.work();
  assert.deepEqual([work.budget!.continuations!.consumed, work.budget!.recoveries.consumed], [5, 0]);
  const impediment = work.impediments.find(item => item.code === 'CONTINUATION_LIMIT_REACHED')!;
  assert.match(impediment.nextStep, new RegExp(`factory grant ${work.work_id} --continuations <n>`));
  await h.rounds(3);
  assert.equal(h.doubles.calls('activate').length, 6, 'no automatic loop');
  const grant = (await h.control.accept({
    request_id: 'grant-48',
    operation: 'grant',
    work_id: work.work_id,
    counter: 'continuations',
    amount: 1,
    origin: 'local-cli',
  })) as Extract<ControlReceipt, { operation: 'grant' }>;
  assert.deepEqual([grant.outcome, grant.budget!.effectiveLimit], ['accepted', 6]);
  await h.idle(7);
  work = await h.work();
  assert.deepEqual(
    [work.execution!.interruption!.reason, work.budget!.continuations!.consumed, work.execution!.end!.outcome],
    ['BUDGET_CONTINUATION', 6, 'completed'],
  );
});

test('ticket 48: an answered Question travels in the continuation summary with its answer and is never to be asked again', async t => {
  const h = await harness(t, { progress: true });
  const questionId = '0b9c6a52-3d3e-4c8f-9a51-000000000048';
  h.scripts.push({ kind: 'ask', questionId, question: 'Which seams should the tests use?' }, budgetEnd, { kind: 'complete' });
  await h.idle(1);
  const work = await h.work();
  assert.equal(work.execution!.end!.outcome, 'question');
  await h.control.accept({
    request_id: 'answer-48',
    operation: 'answer',
    question_id: questionId,
    text: 'Use the repository port; JDK already installed.',
    origin: 'local-cli',
  });
  await h.idle(3);
  const prompt = h.doubles.prompts.at(-1)!.prompt;
  assert.equal((await h.work()).execution!.interruption!.reason, 'BUDGET_CONTINUATION');
  assert.match(prompt, /answered-questions \(already answered: do NOT ask them again; use these answers\)/);
  assert.match(
    prompt,
    new RegExp(
      `Question ${questionId}:\\n\`\`\`\\nWhich seams should the tests use\\?\\n\`\`\`\\n    Answer:\\n\`\`\`\\nUse the repository port; JDK already installed\\.`,
    ),
  );
});

test('ticket 48: the repository Builder budget adjustment is recorded with the Execution and handed to the Builder', async t => {
  const h = await harness(t, { progress: false, builderBudget: { requests: 300, requestTimeoutMinutes: 90 } });
  h.scripts.push({ kind: 'complete' });
  await h.idle(1);
  const expected = { requests: 300, tools: 300, deadlineMs: 90 * 60_000 };
  assert.deepEqual((await h.work()).execution!.request.policies.builderBudget, expected);
  assert.deepEqual(h.invocations[0], { builderBudget: expected });
});

// Ticket 53 (pilot 35, #125/#126): seam answers already given in the Work reach every later Execution through ticket 48's state summary, so a
// new session (continuation after a budget end, or an ordinary operational recovery) never asks the seam Question again. The skill pack
// (factory-skills-v9, `implement` §4/§5 and `tdd`) tells the Builder to use them (test/workers/skill-pack-v9.test.ts).
const seamQuestions = [
  {
    questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000531',
    question: 'May the tests use the seams the Ticket names (domain, use case with fake ports, Postgres IT, REST)?',
    answer: 'Yes: those seams are approved; Cucumber for the acceptance flow.',
  },
  {
    questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000532',
    question: 'May the new V2 event get its own repository port seam?',
    answer: 'Yes, a new port seam for the V2 event.',
  },
];
async function answerBoth(h: Awaited<ReturnType<typeof harness>>) {
  await h.idle(1);
  await h.control.accept({
    request_id: 'answer-53-1',
    operation: 'answer',
    question_id: seamQuestions[0]!.questionId,
    text: seamQuestions[0]!.answer,
    origin: 'local-cli',
  });
  await h.idle(2);
  await h.control.accept({
    request_id: 'answer-53-2',
    operation: 'answer',
    question_id: seamQuestions[1]!.questionId,
    text: seamQuestions[1]!.answer,
    origin: 'local-cli',
  });
  await h.idle(3);
}
function assertSeamAnswers(prompt: string) {
  assert.match(prompt, /^Factory recovery instruction for Ticket /, 'a NEW session (not `continue`)');
  assert.match(prompt, /answered-questions \(already answered: do NOT ask them again; use these answers\)/);
  for (const item of seamQuestions) {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      prompt,
      new RegExp(`Question ${item.questionId}:\\n\`\`\`\\n${escape(item.question)}\\n\`\`\`\\n    Answer:\\n\`\`\`\\n${escape(item.answer)}\\n\`\`\``),
      item.questionId,
    );
  }
}

test('ticket 53: seam answers given in earlier Executions reach a continuation after a budget end (the new session gets both)', async t => {
  const h = await harness(t, { progress: true });
  h.scripts.push({ kind: 'ask', ...seamQuestions[0]! }, { kind: 'ask', ...seamQuestions[1]! }, budgetEnd, { kind: 'complete' });
  await answerBoth(h);
  await h.idle(4);
  assert.equal((await h.work()).execution!.interruption!.reason, 'BUDGET_CONTINUATION');
  assertSeamAnswers(h.doubles.prompts.at(-1)!.prompt);
});

test('ticket 53: seam answers given in earlier Executions reach an ordinary operational recovery (the new session gets both)', async t => {
  const h = await harness(t, { progress: false });
  h.scripts.push(
    { kind: 'ask', ...seamQuestions[0]! },
    { kind: 'ask', ...seamQuestions[1]! },
    { kind: 'fail', code: 'WORKER_EXECUTION_UNCERTAIN' },
    { kind: 'complete' },
  );
  await answerBoth(h);
  h.doubles.jumpCalendar(60000);
  await h.idle(4);
  const work = await h.work();
  assert.deepEqual([work.execution!.interruption!.reason, work.execution!.charge!.kind], ['OPERATIONAL_RECOVERY', 'recovery']);
  assertSeamAnswers(h.doubles.prompts.at(-1)!.prompt);
});

test('ticket 53: a resume after an answer in a REPLACEMENT session carries every answered Question of the Work, not only the current answer', async t => {
  const h = await harness(t, { progress: false });
  h.scripts.push({ kind: 'ask', ...seamQuestions[0]! }, { kind: 'ask', ...seamQuestions[1]! }, { kind: 'complete' });
  await answerBoth(h);
  const work = await h.work();
  assert.equal(work.execution!.request.resume!.reason, 'QUESTION_ANSWERED');
  const prompt = h.doubles.prompts.at(-1)!.prompt;
  assert.match(prompt, /its session is not continued \(reason: SESSION_/, 'a replacement session, not `continue`');
  assert.match(prompt, new RegExp(`Accepted answer \\(by`), 'the current answer stays');
  assertSeamAnswers(prompt);
});
