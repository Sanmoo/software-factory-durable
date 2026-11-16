// Ticket 29: pure rules of the correlated inspection and consumption (no I/O, no clock).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateUsage, captureState, trimEntry, chainOf, combineAggregates, entryRole, fitPage, historyEntries, page, pageArguments, pageState, phaseOf, usageActivity,
  usageSubjects, type UsageSubject } from '../../src/control/rules/inspection.js';
import type { UsageObservation, WorkView } from '../../src/control/types.js';
import { basisExecution } from './readiness-seed.js';

type Work = Omit<WorkView, 'dispatch' | 'limits'>;
const at = '2026-11-15T10:00:00.000Z';
function work(overrides: Partial<Work> = {}): Work {
  return { work_id: '11111111-2222-4333-8444-555555555555', cycle: 1, predecessor: null,
    ticket: { tracker: 'github', repository: 'acme/project', repositoryId: 3, issueId: 30, nodeId: 'I_3', number: 3, url: 'https://github.com/acme/project/issues/3' },
    repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, result: 'open',
    authorization: {} as Work['authorization'], queue: { category: 'normal', sequence: 1, pending: false }, impediments: [],
    dependencies: { latest: null, lastComplete: null }, execution: null, branch: null, pullRequest: null, previousExecutions: [], questions: [], inputs: { cursor: null },
    budget: null, correction: null, pendingRecovery: null, admittedAt: at, history: [], ...overrides };
}
const history: Work['history'] = [
  { at, event: 'admitted', origin: 'github-polling', sequence: 1 },
  { at, event: 'execution-started', origin: 'controller-dispatch', executionId: 'e-1' },
  { at, event: 'reviewer-started', origin: 'controller-dispatch', executionId: 'e-1', detail: 'r1:standards' },
  { at, event: 'reviewer-ended', origin: 'controller-dispatch', executionId: 'e-1', detail: 'r1:spec:clean' },
  { at, event: 'question-recorded', origin: 'controller-dispatch', questionId: 'q-1' },
  { at, event: 'execution-started', origin: 'controller-dispatch', executionId: 'e-2' },
  { at, event: 'budget-consumed', origin: 'controller-budget', executionId: 'e-2', detail: 'corrections' },
];

test('AC2 history entries carry sequence, role and links; filters by Execution and role compose', () => {
  const all = historyEntries(work({ history }), {});
  assert.deepEqual(all.map(item => [item.sequence, item.role]), [[0, null], [1, 'builder'], [2, 'standards'], [3, 'spec'], [4, null], [5, 'builder'], [6, null]]);
  assert.deepEqual(all[4]!.links, { questionId: 'q-1' });
  assert.deepEqual(historyEntries(work({ history }), { execution: 'e-1' }).map(item => item.sequence), [1, 2, 3]);
  assert.deepEqual(historyEntries(work({ history }), { execution: 'e-1', role: 'spec' }).map(item => item.sequence), [3]);
  assert.deepEqual(historyEntries(work({ history }), { role: 'builder' }).map(item => item.sequence), [1, 5]);
  assert.equal(entryRole({ at, event: 'reviewer-started', origin: 'controller-dispatch', executionId: 'e', detail: 'not-a-round' }), 'builder');
});

test('AC2 pages are bounded and stable; fitting to a frame keeps a cursor to the rest', () => {
  assert.deepEqual(pageArguments({ limit: 10_000, cursor: -3 }), { cursor: 0, limit: 200 });
  const items = Array.from({ length: 7 }, (_, index) => index);
  const first = page(items, 9, { limit: 3 });
  assert.deepEqual([first.items, first.page.nextCursor, first.page.filtered, first.page.total], [[0, 1, 2], 3, 7, 9]);
  const last = page(items, 7, { cursor: 6, limit: 3 });
  assert.deepEqual([last.items, last.page.nextCursor], [[6], null]);
  const fitted = fitPage(first.items, first.page, kept => kept.length * 100, 150);
  assert.deepEqual([fitted.items, fitted.page.nextCursor, fitted.page.fitted, fitted.page.returned], [[0], 1, true, 1]);
});

test('AC4 evidence states: incomplete capture is partial, a page short of the end is truncated, removal wins, absent stays absent', () => {
  assert.equal(captureState({ state: 'partial' }, null), 'partial');
  assert.equal(captureState({ state: 'complete' }, 'expired'), 'expired');
  assert.equal(pageState({ state: 'complete', nextOffset: 10, bytes: 20 }), 'truncated');
  assert.equal(pageState({ state: 'complete', nextOffset: 20, bytes: 20 }), 'complete');
  assert.equal(pageState({ state: 'partial', nextOffset: 20, bytes: 20 }), 'partial');
  assert.equal(pageState({ state: 'absent', nextOffset: 0, bytes: 0 }), 'absent');
});

const subject = (overrides: Partial<UsageSubject> = {}): UsageSubject => ({ executionId: 'e-1', role: 'builder', round: null, attempt: null, invocationId: 'i', outcome: 'completed',
  session: { sessionId: 's', mode: 'new' }, missing: null, ...overrides });
const read = (ids: string[], options: { cost?: number | null; outcome?: 'ok' | 'error' | 'aborted'; malformed?: number } = {}): UsageObservation => ({ state: 'read', sessionId: 's',
  malformed: options.malformed ?? 0, entries: ids.map(id => ({ id, provider: 'p', model: 'm', outcome: options.outcome ?? 'ok', tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, total: 16 },
    cost: options.cost === undefined ? 0.5 : options.cost })) });

test('AC6 a continued session is never summed again; failures/aborts count; unavailable is not zero', () => {
  const counted = new Set<string>();
  const first = usageActivity(subject(), read(['a', 'b']), counted);
  const continued = usageActivity(subject({ executionId: 'e-2', session: { sessionId: 's', mode: 'continue' } }), read(['a', 'b', 'c'], { outcome: 'aborted' }), counted);
  assert.deepEqual([first.entries, first.tokens?.total, first.cost?.total], [2, 32, 1]);
  assert.deepEqual([continued.entries, continued.carriedEntries, continued.failedOrAborted, continued.tokens?.total], [1, 2, 1, 16]);
  const lost = usageActivity(subject({ executionId: 'e-3' }), { state: 'lost', code: 'SESSION_FILE_MISSING' }, counted);
  assert.deepEqual([lost.measurement, lost.tokens, lost.cost, lost.session.state], ['unavailable', null, null, 'absent']);
  const removed = usageActivity(subject({ executionId: 'e-4' }), { state: 'lost', code: 'SESSION_FILE_MISSING' }, counted, true);
  assert.deepEqual([removed.session.state, removed.code], ['removed', 'SESSION_REMOVED_BY_CLEANUP']);
  const missing = usageActivity(subject({ missing: { state: 'unknown', code: 'SESSION_NOT_RECORDED' } }), null, counted);
  assert.deepEqual([missing.measurement, missing.code], ['unavailable', 'SESSION_NOT_RECORDED']);
  const total = aggregateUsage([first, continued, lost]);
  assert.deepEqual([total.measurement, total.measured, total.unavailable, total.tokens?.total], ['partial', 2, 1, 48]);
  assert.equal(aggregateUsage([lost]).tokens, null, 'nothing measured is never a zero');
  assert.equal(aggregateUsage([]).measurement, 'unavailable');
  assert.equal(aggregateUsage([first]).measurement, 'complete');
});

test('AC6/AC7 unknown per-entry cost or unreadable entries make the measurement partial; cost is an SDK estimate without invented currency', () => {
  const noCost = usageActivity(subject(), read(['a'], { cost: null }), new Set());
  assert.deepEqual([noCost.measurement, noCost.cost], ['complete', null]);
  const gaps = usageActivity(subject(), read(['a'], { malformed: 2 }), new Set());
  assert.deepEqual([gaps.measurement, gaps.code], ['partial', 'USAGE_ENTRIES_UNREADABLE']);
  const measured = usageActivity(subject(), read(['a']), new Set());
  assert.deepEqual(measured.cost, { total: 0.5, unit: 'sdk-catalog-estimate', currency: null });
  const installation = combineAggregates([aggregateUsage([measured]), aggregateUsage([gaps])]);
  assert.deepEqual([installation.measurement, installation.tokens?.total], ['partial', 32]);
  assert.equal(combineAggregates([aggregateUsage([])]).measurement, 'unavailable');
});

test('AC6 usage subjects: one Builder per Execution plus each reviewer attempt that ran; carried opinions are not a new activity', () => {
  const execution = basisExecution('e-1');
  const reviewer = (role: 'standards' | 'spec', source?: 'carried') => ({ invocationId: `${role}-i`, phaseId: 'p', promptSha256: 'x', state: 'ended' as const, requestedAt: at, receiptId: 'r',
    endedAt: at, failure: null, cessation: 'completion-observed' as const, input: { required: [], missing: [] }, ...(source ? { source } : {}),
    opinion: { version: 1 as const, role, round: 1, attempt: 1, invocationId: `${role}-i`, reference: { workId: 'w', id: 'o' }, session: { file: `/root/r/b/w-${role}/profile/sessions/s.jsonl` },
      model: { providerId: 'prov', modelId: `model-${role}` }, profile: { id: 'p', modelBudget: null }, input: { handoffIndexSha256: 'h', required: [], missing: [] }, conclusion: 'clean' as const,
      code: null, coverage: null, findings: [], limitations: [], hostChecks: { reads: 0, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: null, recordedAt: at } });
  execution.review!.rounds[0]!.reviewers = { standards: reviewer('standards'), spec: reviewer('spec', 'carried') };
  const subjects = usageSubjects(work({ execution }));
  assert.deepEqual(subjects.map(item => [item.role, item.missing?.code ?? null]), [['builder', 'SESSION_NOT_RECORDED'], ['standards', null]]);
  const chain = chainOf(work({ execution, history }), [], { ageSeconds: value => value ? 60 : null, timeoutSeconds: null, lastPolledAt: at });
  assert.deepEqual(chain.models, [{ role: 'standards', provider: 'prov', model: 'model-standards', source: 'opinion' }, { role: 'spec', provider: 'prov', model: 'model-spec', source: 'opinion' }]);
  assert.deepEqual(chain.references.map(item => item.kind), ['start-receipt', 'opinion', 'reviewer-session', 'opinion', 'reviewer-session']);
  assert.equal(chain.executions[0]!.reviews[0]!.reviewers.find(item => item.role === 'spec')!.source, 'carried');
  assert.deepEqual(chain.observations[0], { source: 'polling', observedAt: at, ageSeconds: 60, completeness: 'unproven' }, 'no completeness proof given');
  assert.equal(chain.observations[1]!.completeness, 'not-evaluated');
});

test('AC1 phase/wait is derived in priority order and always names the next step it knows', () => {
  assert.equal(phaseOf(work(), []).code, 'idle');
  assert.deepEqual(phaseOf(work({ impediments: [{ code: 'RECOVERY_BLOCKED', scope: 'work', nextStep: 'decide' }] }), []), { code: 'blocked', waitingFor: 'impediment:RECOVERY_BLOCKED', nextStep: 'decide' });
  assert.equal(phaseOf(work({ queue: { category: 'repair', sequence: 1, pending: true } }), []).code, 'queued-repair');
  assert.equal(phaseOf(work({ result: 'delivered', cleanup: { state: 'pending', eligibility: { eligible: true, reasons: [], checkedAt: at }, evidence: [], resources: [], protected: [],
    sweeps: 1, lastSweepAt: at, nextStep: 'retry' } }), []).code, 'delivered-cleanup-pending');
  const question = { questionId: 'q-1', state: 'open' } as never;
  assert.equal(phaseOf(work({ impediments: [{ code: 'QUESTION_PENDING', scope: 'work', nextStep: 'answer' }] }), [question]).code, 'awaiting-answer');
});

test('review LOW: a pager always makes progress — a single oversized entry is returned trimmed with a marker', () => {
  const big = historyEntries(work({ history: [{ at, event: 'checks-evaluated', origin: 'controller-checks', detail: 'z'.repeat(10_000) }] }), {});
  const paged = page(big, 1, {});
  const fitted = fitPage(paged.items, paged.page, items => JSON.stringify(items).length, 3000, trimEntry);
  assert.equal(fitted.items.length, 1);
  assert.match((fitted.items[0]!.entry as { detail: string }).detail, /\[TRUNCATED 10000 characters\]$/);
  assert.equal(fitted.page.nextCursor, null);
});

test('review LOW: freshness is `complete` only with a completeness proof; otherwise unproven/incomplete', () => {
  const chain = chainOf(work({ feedback: { requests: [], pullRequestCursor: null, observedAt: at, ignored: [] } }), [], { ageSeconds: () => 1, timeoutSeconds: null, lastPolledAt: at });
  assert.deepEqual(chain.observations.map(item => [item.source, item.completeness]), [['polling', 'unproven'], ['dependencies', 'not-evaluated'], ['feedback', 'unproven']]);
  const proven = chainOf(work(), [], { ageSeconds: () => 1, timeoutSeconds: null, lastPolledAt: at, lastPolledCompleteness: 'complete' });
  assert.equal(proven.observations[0]!.completeness, 'complete');
});

test('review MED: a reviewer session without a recorded hash is measured but never complete', () => {
  const unverified = usageActivity(subject({ role: 'standards' }), { ...read(['a']), integrity: 'unverified' } as UsageObservation, new Set());
  assert.deepEqual([unverified.measurement, unverified.code], ['partial', 'SESSION_INTEGRITY_UNVERIFIED']);
});
