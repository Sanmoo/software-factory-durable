import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CheckoutFingerprint, GateEvidence } from '../../src/contracts/index.js';
import { budgetEndProgress, builderBudgetPolicy, stateSummary, summaryLimits } from '../../src/control/rules/budget-continuation.js';
import { chargeDecision, counterOf, exhaustionImpediment, initialBudget } from '../../src/control/rules/budget.js';
import { classifyInterruption, interruptionRecoveryPrompt } from '../../src/control/rules/recovery.js';
import type { WorkBudget } from '../../src/control/types.js';

// Ticket 48 (pure rules): progress from the Host's fingerprints only, the continuation counter, the bounded summary and answered Questions.

const observed = (patch: Partial<Extract<CheckoutFingerprint, { status: 'observed' }>> = {}): CheckoutFingerprint => ({
  status: 'observed',
  head: 'ref: refs/heads/factory/3-x',
  ref: 'a'.repeat(40),
  git: 'g1',
  tree: 't1',
  entries: 3,
  observedAt: '2026-11-19T10:00:00.000Z',
  ...patch,
});

test('ticket 48: progress = new commits or a changed checkout between the Host fingerprints; anything not observed is unknown, never assumed', () => {
  assert.deepEqual(budgetEndProgress(observed(), observed()), { kind: 'none' });
  assert.deepEqual(budgetEndProgress(observed(), observed({ ref: 'b'.repeat(40), git: 'g2' })), { kind: 'progress', commits: true, checkout: true });
  assert.deepEqual(budgetEndProgress(observed(), observed({ tree: 't2' })), { kind: 'progress', commits: false, checkout: true }, 'uncommitted edits count');
  assert.deepEqual(budgetEndProgress(observed(), observed({ git: 'g2' })), { kind: 'progress', commits: false, checkout: true }, 'staged changes count');
  assert.deepEqual(
    budgetEndProgress(observed({ head: 'c'.repeat(40), ref: 'c'.repeat(40) }), observed({ head: 'd'.repeat(40), ref: 'd'.repeat(40) })),
    { kind: 'progress', commits: true, checkout: false },
    'detached HEAD moved',
  );
  assert.deepEqual(budgetEndProgress(null, observed()), { kind: 'unknown', code: 'CHECKOUT_START_NOT_OBSERVED' });
  assert.deepEqual(budgetEndProgress(observed(), null), { kind: 'unknown', code: 'CHECKOUT_END_NOT_OBSERVED' });
  assert.deepEqual(budgetEndProgress(observed(), { status: 'unavailable', code: 'CHECKOUT_PATH_UNSAFE' }), {
    kind: 'unknown',
    code: 'CHECKOUT_END_CHECKOUT_PATH_UNSAFE',
  });
  assert.deepEqual(
    budgetEndProgress(observed(), observed({ tree: null })),
    { kind: 'unknown', code: 'CHECKOUT_TREE_UNBOUNDED' },
    'an unbounded walk proves no "no change"',
  );
  assert.deepEqual(budgetEndProgress(observed({ tree: null }), observed({ tree: null, ref: 'e'.repeat(40) })), {
    kind: 'progress',
    commits: true,
    checkout: false,
  });
});

test('ticket 48: budget end without progress stays a recoverable interruption; with progress it charges `continuations`, never `recoveries`', () => {
  assert.deepEqual(classifyInterruption('WORKER_BUDGET_EXHAUSTED'), { kind: 'recoverable' });
  const budget = initialBudget({}, 'acme/project', '2026-11-19T10:00:00.000Z');
  assert.deepEqual(budget.continuations, { limit: 5, granted: 0, consumed: 0, reserved: null });
  assert.deepEqual(chargeDecision(budget, { kind: 'continuation', correctionId: null }), { kind: 'reserve', counter: 'continuations', correctionId: null });
  budget.continuations!.consumed = 5;
  assert.deepEqual(chargeDecision(budget, { kind: 'continuation', correctionId: null }), {
    kind: 'exhausted',
    counter: 'continuations',
    code: 'CONTINUATION_LIMIT_REACHED',
  });
  // A budget recorded before ticket 48 gets the counter on first use (release value), not an error.
  const legacy = {
    corrections: { limit: 3, granted: 0, consumed: 0, reserved: null },
    recoveries: { limit: 3, granted: 0, consumed: 3, reserved: null },
    source: { kind: 'repository-configuration', repository: 'acme/project', recordedAt: 'x' },
    grants: [],
  } as WorkBudget;
  assert.deepEqual(counterOf(legacy, 'continuations'), { limit: 5, granted: 0, consumed: 0, reserved: null });
  assert.deepEqual(chargeDecision(legacy, { kind: 'continuation', correctionId: null }).kind, 'reserve', 'exhausted recoveries do not block a continuation');
  const impediment = exhaustionImpediment('continuations', 'w-1', 'now');
  assert.equal(impediment.code, 'CONTINUATION_LIMIT_REACHED');
  assert.match(impediment.nextStep, /`factory grant w-1 --continuations <n>`/);
});

const gate = (id: string, command: string, outcome: GateEvidence['outcome'], exitCode: number | null): GateEvidence => ({
  id,
  source: '/artifacts/instructions/v1/AGENTS.md',
  command,
  cwd: '/workspace/checkout',
  requiredCheck: null,
  declared: 'run',
  outcome,
  code: null,
  exitCode,
  output: null,
  sequence: 1,
  current: true,
  reason: null,
  authorization: null,
});

test('ticket 48: the summary names the last phase, the last Host-evidenced gates with real results and every answered Question (fenced data)', () => {
  const summary = stateSummary({
    previousExecutionId: 'e-1',
    code: 'WORKER_BUDGET_EXHAUSTED',
    progress: { decision: { kind: 'progress', commits: true, checkout: false }, start: observed(), end: observed({ ref: 'b'.repeat(40) }) },
    rounds: [
      { round: 1, state: 'delivered', closing: false, conclusion: 'findings', head: '1'.repeat(40), gates: [gate('unit', './gradlew test', 'failed', 1)] },
      { round: 2, state: 'reviewing', closing: false, conclusion: null, head: '2'.repeat(40), gates: [] },
    ],
    answered: [{ questionId: 'q-1', question: 'Which seams?', answer: 'Use ```the port```.' }],
  });
  assert.match(summary, /previous-execution: e-1 ended WORKER_BUDGET_EXHAUSTED; progress observed by the host: new commits; HEAD aaaaaaaaaaaa -> bbbbbbbbbbbb/);
  assert.match(summary, /last-phase: review round 2: reviewing, handed-off head 222222222222/);
  assert.match(
    summary,
    /last-gates \(round 1, evidenced by the host from the real Bash results\):\n {2}- unit: outcome failed \(exit 1\); command:\n```\n\.\/gradlew test\n```/,
  );
  assert.match(summary, /do NOT ask them again/);
  assert.match(summary, /Answer:\n````\nUse ```the port```\.\n````/, 'operator text is fenced longer than any fence it contains');
  const none = stateSummary({ previousExecutionId: 'e-1', code: 'WORKER_INTERRUPTED', rounds: [], answered: [] });
  assert.match(
    none,
    /last-phase: implementation \(no review handoff recorded by the host\)\n- last-gates: none recorded by the host\n- answered-questions: none/,
  );
});

test('ticket 48: the summary is bounded; the oldest answered Questions are dropped first and counted, the newest kept', () => {
  const answered = Array.from({ length: 12 }, (_, index) => ({
    questionId: `q-${index}`,
    question: `Question ${index} ${'é'.repeat(900)}`,
    answer: `Answer ${index} ${'x'.repeat(2000)}`,
  }));
  const gates = Array.from({ length: 9 }, (_, index) => gate(`g${index}`, `run ${'ü'.repeat(500)}`, 'passed', 0));
  const summary = stateSummary({
    previousExecutionId: 'e-1',
    code: 'WORKER_BUDGET_EXHAUSTED',
    rounds: [{ round: 3, state: 'delivered', closing: true, conclusion: 'clean', head: null, gates }],
    answered,
  });
  assert.ok(new TextEncoder().encode(summary).length <= summaryLimits.bytes, 'never above the bound');
  assert.match(summary, /Question q-11:/, 'the newest answer is kept');
  assert.doesNotMatch(summary, /Question q-0:/);
  assert.match(summary, /older answered questions omitted/);
  assert.match(summary, /[0-9] more gates omitted/);
  assert.match(summary, /…\[truncated\]/);
});

test('ticket 48: the continuation instruction is not a failure recovery and carries the summary before the recorded reason', () => {
  const base = {
    ticketUrl: 'https://github.com/acme/project/issues/3',
    repository: 'acme/project',
    base: 'main',
    baseCommit: 'a'.repeat(40),
    branch: 'factory/3-x',
    checkout: '/workspace/checkout',
    skillDirectory: '/artifacts/factory/skill-pack/factory-skills-v8',
    workId: 'w',
    executionId: 'e-2',
    previousExecutionId: 'e-1',
    reviews: true,
  };
  const prompt = interruptionRecoveryPrompt({ ...base, reason: 'BUDGET_CONTINUATION', code: 'WORKER_BUDGET_EXHAUSTED', summary: 'Factory state summary (x)' });
  assert.match(prompt, /reached its per-Execution Builder budget \(WORKER_BUDGET_EXHAUSTED\)/);
  assert.match(prompt, /do not restart or redo finished work/);
  assert.ok(prompt.indexOf('Factory state summary') < prompt.indexOf('BUDGET_CONTINUATION:WORKER_BUDGET_EXHAUSTED'));
  assert.doesNotMatch(
    interruptionRecoveryPrompt({ ...base, reason: 'OPERATIONAL_RECOVERY', code: 'WORKER_INTERRUPTED' }),
    /state summary/,
    'no summary given, none invented',
  );
});

test('ticket 48: the repository Builder budget in worker terms (absent values keep the release ones); above 2x never sent clamped', () => {
  assert.equal(builderBudgetPolicy(undefined), null);
  assert.equal(builderBudgetPolicy({}), null);
  assert.deepEqual(builderBudgetPolicy({ toolCalls: 600 }), { requests: 150, tools: 600, deadlineMs: 3_600_000 });
  assert.deepEqual(builderBudgetPolicy({ requests: 10, toolCalls: 20, requestTimeoutMinutes: 5 }), { requests: 10, tools: 20, deadlineMs: 300_000 });
  assert.throws(() => builderBudgetPolicy({ requests: 301 }), /BUILDER_BUDGET_ABOVE_MAXIMUM/);
});
