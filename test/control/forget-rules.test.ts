import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetBasis, forgetLosses, forgetPlanNextStep, forgetRefusals, forgottenNextStep, minimalMemoryOf, pendingResources, type ForgetFacts } from '../../src/control/rules/forget.js';
import { ownCycleFor, evaluateDependencies } from '../../src/control/rules/dependencies.js';
import type { ExecutionView, ForgetTree } from '../../src/control/types.js';

// Ticket 31 pure rules (spec §12.4 `forget`, §4.2): eligibility, plan of losses, minimal memory and its use by own-dependency classification.
type Work = Parameters<typeof forgetRefusals>[0];
const tree = (overrides: Partial<ForgetTree> = {}): ForgetTree => ({ completeness: 'complete', observedAt: 'now', present: true, leftover: false, files: 12, directories: 4, bytes: 900, unsafe: [], ...overrides });
const facts = (overrides: Partial<ForgetFacts> = {}): ForgetFacts => ({ running: false, questions: [], tree: tree(), repositoryConfigured: true, ...overrides });
const pull = { pullRequestId: 9042, nodeId: 'PR_own42', number: 42, url: 'https://github.com/acme/project/pull/42', headRef: 'factory/3-own', base: 'main', heads: ['a'.repeat(40)] };
function work(overrides: Record<string, unknown> = {}): Work {
  return { work_id: 'w-1', cycle: 2, predecessor: 'w-0', ticket: { tracker: 'github', repository: 'acme/project', repositoryId: 3, issueId: 7003, nodeId: 'I', number: 3, url: 'u' },
    repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, result: 'delivered', branch: null,
    authorization: { basis: { label: { id: 55, name: 'ready-for-agent' } } }, queue: { sequence: 4 },
    execution: { executionId: 'e-1', state: 'ended', slot: { held: false }, dispatch: { boot: 'b', environment: null }, end: { cessation: 'confirmed' } } as unknown as ExecutionView,
    previousExecutions: [], impediments: [], cancellation: null, closure: null, readiness: null, publication: null, pendingRecovery: null, retention: null, forget: null, questions: ['q-1'],
    history: [{ event: 'admitted' }], scopeUpdates: [{ reason: 'SECRET REQUEST TEXT' }],
    delivery: { state: 'delivered', pullRequest: pull, observations: [], merge: { confirmedAt: '2026-11-01T00:00:00.000Z' } },
    cleanup: { state: 'complete', resources: [{ id: 'remote-branch:x', state: 'removed' }], explicit: null }, ...overrides } as unknown as Work;
}
const codes = (subject: Work, input: Partial<ForgetFacts> = {}) => forgetRefusals(subject, facts(input)).map(item => item.code);

test('AC1/AC2: only an ended Work with nothing pending is eligible; open/closed-unmerged/stopping/protected/resource-holding/unsafe are refused', () => {
  assert.deepEqual(codes(work()), []);
  assert.deepEqual(codes(work({ result: 'open' })), ['WORK_NOT_ENDED']);
  assert.deepEqual(codes(work({ result: 'closed-unmerged' })), ['CANCEL_REQUIRED'], 'a PR closed without merge needs cancel first');
  assert.deepEqual(codes(work({ delivery: { state: 'watching', pullRequest: pull, observations: [], merge: null } })), ['DELIVERY_NOT_CONFIRMED']);
  const cancelled = { result: 'cancelled', delivery: null, cleanup: null };
  assert.deepEqual(codes(work({ ...cancelled, cancellation: { state: 'ceased' } })), []);
  assert.deepEqual(codes(work({ ...cancelled, cancellation: { state: 'stopping' } })), ['CANCELLATION_STOPPING', 'PROTECTED']);
  // A cancelled cycle with its own PR not observed closed: a later human merge would still deliver it.
  const published = { publication: { pullRequest: { ...pull, headSha: 'a'.repeat(40) }, linkedHeads: [] } };
  assert.deepEqual(codes(work({ ...cancelled, ...published, cancellation: { state: 'ceased' } })), ['PULL_REQUEST_NOT_CLOSED']);
  assert.deepEqual(codes(work({ ...cancelled, ...published, cancellation: { state: 'ceased' }, delivery: { state: 'watching', pullRequest: pull, merge: null,
    observations: [{ outcome: 'closed-unmerged' }] } })), []);
  assert.deepEqual(codes(work(), { running: true }), ['PROTECTED']);
  assert.deepEqual(codes(work(), { questions: [{ questionId: 'q', state: 'open', publication: { state: 'published' } } as never] }), ['PROTECTED']);
  assert.deepEqual(codes(work({ pendingRecovery: { reason: 'x', requestedAt: 'x' } })), ['RECOVERY_PENDING']);
  assert.deepEqual(codes(work({ cleanup: { state: 'pending', resources: [{ id: 'remote-branch:x', state: 'kept' }], explicit: null } })), ['RESOURCES_PENDING']);
  assert.deepEqual(codes(work({ retention: { plans: [{ planId: 'p', state: 'confirmed', items: [{ state: 'planned' }] }], removals: [] } })), ['CLEANUP_PLAN_PENDING']);
  assert.deepEqual(codes(work({ forget: { plans: [{ state: 'removing' }] } })), ['FORGET_IN_PROGRESS']);
  assert.deepEqual(codes(work({ forget: { plans: [{ state: 'confirmed' }] } })), [], 'a confirmed plan not started never blocks (a newer plan supersedes it)');
  assert.deepEqual(codes(work({ retention: { plans: [], removals: [{ id: 'log:a', outcome: 'indeterminate' }] } })), ['DETAIL_REMOVAL_UNSETTLED']);
  assert.deepEqual(codes(work({ retention: { plans: [], removals: [{ id: 'log:a', outcome: 'failed' }] } })), [], 'a known failed removal leaves the file: forget deletes it');
  assert.deepEqual(codes(work(), { tree: null }), ['RECORDS_NOT_COMPOSED']);
  assert.deepEqual(codes(work(), { tree: tree({ completeness: 'incomplete', unsafe: ['w-1/evidence/link'] }) }), ['RECORDS_TREE_UNSAFE']);
  // An own environment not removed yet is a pending resource (cancelled: never its branch or GitHub).
  const withEnvironment = work({ ...cancelled, cancellation: { state: 'ceased' }, execution: { executionId: 'e-1', state: 'ended', slot: { held: false },
    dispatch: { boot: 'b', environment: `env-${'a'.repeat(64)}` }, end: { cessation: 'confirmed' } } });
  assert.deepEqual(pendingResources(withEnvironment, true).map(id => id.split(':')[0]), ['environment', 'checkout', 'local-branch', 'temporaries']);
  assert.match(forgetRefusals(withEnvironment, facts())[0]!.detail, /--select environment.*forget never removes a resource/);
});

test('AC3: the minimal memory keeps identities, order/link, result and the delivered PR/merge fact; never request content, logs or opinions', () => {
  const memory = minimalMemoryOf(work(), { at: 'now', request_id: 'r', planId: 'p' });
  assert.deepEqual(memory, { work_id: 'w-1', ticket: work().ticket, repository: work().repository, cycle: 2, predecessor: 'w-0', sequence: 4, result: 'delivered',
    pullRequest: { number: 42, pullRequestId: 9042, nodeId: 'PR_own42', url: 'https://github.com/acme/project/pull/42' }, mergeConfirmed: true,
    mergeConfirmedAt: '2026-11-01T00:00:00.000Z', label: { id: 55, name: 'ready-for-agent' }, questions: ['q-1'], watch: null, forgottenAt: 'now', request_id: 'r', planId: 'p' });
  assert.ok(!JSON.stringify(memory).includes('SECRET REQUEST TEXT'));
  const cancelled = minimalMemoryOf(work({ result: 'cancelled', delivery: null }), { at: 'now', request_id: 'r', planId: 'p' });
  assert.deepEqual([cancelled.result, cancelled.pullRequest, cancelled.mergeConfirmed, cancelled.mergeConfirmedAt], ['cancelled', null, false, null]);
});

test('AC5: from the minimal memory alone an own delivered blocker is satisfied, a cancelled one is not, a new cycle is the evaluated one; never external', () => {
  const node = (issueId: number, blockedBy: number[] | null, state: 'open' | 'closed' = 'open') => ({ issueId, nodeId: `N${issueId}`, repository: 'acme/project', repositoryId: 3,
    number: issueId, url: `u${issueId}`, state, stateReason: state === 'closed' ? 'completed' : null, access: 'read' as const, repositoryRole: 'executable' as const, blockedBy });
  const graph = { rootIssueId: 5, nodes: [node(5, [3]), node(3, [], 'closed')], problems: [] };
  const delivered = { work_id: 'w-1', cycle: 1, result: 'delivered' as const, mergeConfirmed: true };
  const memoryOnly = ownCycleFor({ indexed: { current: 'w-1', previous: [] }, memory: [delivered], records: {} });
  assert.equal(memoryOnly?.source, 'minimal-memory');
  assert.equal(evaluateDependencies({ graph, own: { 3: memoryOnly } }).conclusion, 'satisfied');
  const cancelled = ownCycleFor({ indexed: { current: 'w-1', previous: [] }, memory: [{ ...delivered, result: 'cancelled', mergeConfirmed: false }], records: {} });
  const refused = evaluateDependencies({ graph, own: { 3: cancelled } });
  assert.deepEqual([refused.conclusion, refused.blockers[0]?.classification, refused.reasons[0]?.code], ['pending', 'own', 'OWN_CYCLE_CANCELLED']);
  const successor = ownCycleFor({ indexed: { current: 'w-2', previous: ['w-1'] }, memory: [delivered, { work_id: 'w-2', cycle: 2, result: 'open', mergeConfirmed: false }], records: {} });
  assert.deepEqual(evaluateDependencies({ graph, own: { 3: successor } }).reasons[0]?.code, 'OWN_CYCLE_NOT_DELIVERED', 'the new cycle never inherits the old merge');
});

test('AC6: the plan names what becomes unrecoverable, what stays and what forget never reaches; the forgotten view is never "not found" or "expired"', () => {
  const plan = forgetLosses(work(), facts());
  assert.match(plan.losses[0]!, /whole Records area \(12 file\(s\), 900 bytes\)/);
  assert.match(plan.losses[2]!, /1 Question\(s\).*erased from their receipts/);
  assert.match(plan.losses[3]!, /stops counting in installation totals/);
  assert.match(plan.keeps[0]!, /Ticket acme\/project#3 \(issue 7003\), Work w-1, cycle 2 after w-0, result delivered, pull request #42/);
  assert.match(plan.keeps[1]!, /never admit it again.*factory new/);
  assert.match(plan.warnings[0]!, /Not erased: GitHub.*controller storage is scrubbed \(VACUUM, then the WAL is truncated\).*SQLite free pages or the WAL.*memory\.scrub/);
  assert.deepEqual(plan.records, { files: 12, bytes: 900, present: true, leftover: false });
  assert.match(forgetLosses(work(), facts({ tree: tree({ present: false, files: 0 }) })).losses[0]!, /no Records area left/);
  assert.match(forgottenNextStep(minimalMemoryOf(work(), { at: 'T', request_id: 'r', planId: 'p' })), /not an expired or missing record.*factory new acme\/project#3/);
  // D-07: the forgotten view says whether the storage scrub completed; a record without one (forgotten before D-07) counts as pending.
  const memory = minimalMemoryOf(work(), { at: 'T', request_id: 'r', planId: 'p' });
  assert.match(forgottenNextStep(memory), /scrub PENDING: until it completes, the deleted controller records may remain in SQLite free pages\/WAL/);
  assert.match(forgottenNextStep({ ...memory, scrub: { state: 'pending', attempts: 1, lastAttemptAt: 'A', code: 'SQLITE_FULL', scrubbedAt: null } }), /last attempt A: SQLITE_FULL/);
  assert.match(forgottenNextStep({ ...memory, scrub: { state: 'scrubbed', attempts: 1, lastAttemptAt: 'S', code: null, scrubbedAt: 'S' } }), /Controller storage scrubbed at S\./);
  for (const state of ['planned', 'refused', 'superseded', 'confirmed', 'dropped', 'removing', 'failed', 'indeterminate', 'forgotten'] as const) {
    assert.ok(forgetPlanNextStep({ state, planId: 'p', refusals: [], code: 'X' }).length > 10, state);
  }
  assert.notEqual(forgetBasis(work(), facts()), forgetBasis(work(), facts({ tree: tree({ files: 13 }) })), 'a changed tree makes the plan obsolete');
  assert.equal(forgetBasis(work(), facts()), forgetBasis(work(), facts()));
});
