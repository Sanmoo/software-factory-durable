import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedReferencePattern, blockedRequestReference } from '../../src/contracts/index.js';
import { blockedFailureImpediment, blockedRequestImpediment, blockedRequestToken, blocksReturnedFailure, overrideBlockedRecoveryDecision, positiveResolution, type OverrideFacts } from '../../src/control/rules/recovery.js';

// Rules level, ticket 41: the explicit operator exit of a recovery blocked by a lost Builder request (ticket 27). Every fact is supplied by the test.
const invocation = 'builder-5d1e0c1a-8a0b-4b5e-9c3f-0123456789ab';
const reference = blockedRequestReference(invocation, 'QUESTION_RECORD_INCOMPLETE');
const facts = (change: Partial<OverrideFacts> = {}, execution: Partial<NonNullable<OverrideFacts['execution']>> = {}): OverrideFacts => ({
  work: { result: 'open', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] },
  execution: { state: 'ended', slotHeld: false, end: { outcome: 'failure', code: 'QUESTION_RECORD_INCOMPLETE', cessation: 'confirmed' },
    blockedRequest: { reference, code: 'QUESTION_RECORD_INCOMPLETE', override: null }, ...execution },
  reference, running: false, resolved: false, cancelling: false, pendingRecovery: false, ...change });

test('AC1: the blocked reference names the invocation and the finding; the impediment shows the exact override command', () => {
  assert.equal(reference, `request:${invocation}:QUESTION_RECORD_INCOMPLETE`);
  const impediment = blockedRequestImpediment('w-1', reference, 'QUESTION_RECORD_INCOMPLETE', '2026-11-16T10:00:00.000Z');
  assert.equal(impediment.code, 'RECOVERY_BLOCKED');
  assert.ok(impediment.nextStep.includes(`factory resume w-1 --override-blocked-recovery ${reference} --request-id <id>`), impediment.nextStep);
  assert.ok(/never reconstructed|not reconstructed/.test(impediment.nextStep), 'says the lost request is not reconstructed');
});

test('AC1/AC2: accepted only for a current open Work blocked by exactly that reference, ceased, without activity, Slot or later resolution', () => {
  assert.deepEqual(overrideBlockedRecoveryDecision(facts()), { kind: 'accept', code: 'QUESTION_RECORD_INCOMPLETE' });
  const refused = (value: OverrideFacts) => { const decided = overrideBlockedRecoveryDecision(value); return decided.kind === 'refuse' ? decided.code : decided.kind; };
  assert.equal(refused(facts({ work: null })), 'WORK_NOT_FOUND');
  assert.equal(refused(facts({ work: { result: 'open', current: false, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'WORK_NOT_CURRENT');
  assert.equal(refused(facts({ work: { result: 'cancelled', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'WORK_CANCELLED');
  assert.equal(refused(facts({ work: { result: 'delivered', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'WORK_DELIVERED');
  assert.equal(refused(facts({ work: { result: 'open', current: true, impediments: [] } })), 'RECOVERY_NOT_BLOCKED');
  assert.equal(refused(facts({}, { blockedRequest: undefined })), 'BLOCK_NOT_A_LOST_REQUEST', 'another blocking code (e.g. a preparation failure) is not overridable');
  assert.equal(refused(facts({ execution: null })), 'BLOCK_NOT_A_LOST_REQUEST');
  assert.equal(refused(facts({ reference: blockedRequestReference(invocation, 'QUESTION_RECORD_MULTIPLE') })), 'BLOCKED_REFERENCE_MISMATCH');
  assert.equal(refused(facts({ reference: blockedRequestReference('6d1e0c1a-8a0b-4b5e-9c3f-0123456789ab', 'QUESTION_RECORD_INCOMPLETE') })), 'BLOCKED_REFERENCE_MISMATCH');
  assert.equal(refused(facts({ running: true })), 'EXECUTION_ACTIVE');
  assert.equal(refused(facts({}, { state: 'started' })), 'EXECUTION_ACTIVE');
  assert.equal(refused(facts({}, { end: { outcome: 'failure', code: 'QUESTION_RECORD_INCOMPLETE', cessation: 'unconfirmed' } })), 'CESSATION_NOT_CONFIRMED');
  assert.equal(refused(facts({}, { end: null })), 'CESSATION_NOT_CONFIRMED');
  assert.equal(refused(facts({}, { slotHeld: true })), 'SLOT_HELD');
  assert.equal(refused(facts({ resolved: true })), 'REQUEST_RESOLVED_BY_RECORDS', 'a positive resolution of that request');
  assert.equal(refused(facts({ cancelling: true })), 'WORK_CANCELLING', 'a cancellation still stopping');
  assert.equal(refused(facts({ pendingRecovery: true })), 'RECOVERY_ALREADY_PENDING', 'never an ambiguous second recovery request');
  assert.equal(refused(facts({}, { end: { outcome: 'failure', code: 'QUESTION_RECORD_MULTIPLE', cessation: 'confirmed' } })), 'BLOCK_CHANGED');
});

test('AC5: once overridden, the same reference is already satisfied (no second acceptance); another one is refused', () => {
  const overridden = facts({ work: { result: 'open', current: true, impediments: [] } },
    { blockedRequest: { reference, code: 'QUESTION_RECORD_INCOMPLETE', override: { reference } } });
  assert.deepEqual(overrideBlockedRecoveryDecision(overridden), { kind: 'already', code: 'BLOCKED_RECOVERY_ALREADY_OVERRIDDEN' });
  assert.deepEqual(overrideBlockedRecoveryDecision({ ...overridden, reference: blockedRequestReference(invocation, 'QUESTION_RECORD_INVALID') }),
    { kind: 'refuse', code: 'RECOVERY_NOT_BLOCKED' });
});

test('review MED 1 / LOW: only a POSITIVE resolution of THAT request counts — a later non-blocked record or another Question of the Execution does not', () => {
  const blocked = { questionId: 'q-1', at: '2026-11-16T10:00:00.000Z' };
  const base = { blocked, executionId: 'e-1', invocationId: invocation, questions: [], recovery: [] };
  assert.equal(positiveResolution(base), false);
  assert.equal(positiveResolution({ ...base, recovery: [{ at: '2026-11-16T11:00:00.000Z', question: 'absent' }, { at: '2026-11-16T11:00:01.000Z', question: 'unresolved:RECORDS_UNAVAILABLE' }] }),
    false, 'later reconciliations that did not find it intact');
  assert.equal(positiveResolution({ ...base, questions: [{ questionId: 'q-2', executionId: 'e-1', invocationId: invocation }] }), false, 'another Question of the Execution');
  assert.equal(positiveResolution({ ...base, questions: [{ questionId: 'q-1', executionId: 'e-2', invocationId: invocation }] }), false, 'same id, other Execution');
  assert.equal(positiveResolution({ ...base, questions: [{ questionId: 'q-1', executionId: 'e-1', invocationId: invocation }] }), true);
  assert.equal(positiveResolution({ ...base, recovery: [{ at: '2026-11-16T11:00:00.000Z', question: 'recorded:q-1' }] }), true, 'a later reconciliation recorded it');
  assert.equal(positiveResolution({ ...base, recovery: [{ at: '2026-11-16T09:00:00.000Z', question: 'recorded:q-1' }] }), false, 'not a LATER read');
  assert.equal(positiveResolution({ ...base, recovery: [{ at: '2026-11-16T11:00:00.000Z', question: 'recorded:q-9' }] }), false, 'another request');
  // Unknown questionId (multiple/unreadable record): only a Question of the SAME invocation recorded from Records resolves it.
  const unknown = { ...base, blocked: { questionId: null, at: blocked.at } };
  assert.equal(positiveResolution({ ...unknown, questions: [{ questionId: 'q-3', executionId: 'e-1', invocationId: 'reviewer-x' }] }), false);
  assert.equal(positiveResolution({ ...unknown, questions: [{ questionId: 'q-3', executionId: 'e-1', invocationId: invocation }] }), true);
});

test('LOW: the reference always has a usable token (invocation, else the Records reference, else the Execution) and one shared pattern', () => {
  assert.equal(blockedRequestToken({ invocationId: invocation, records: ['r-1'], executionId: 'e-1' }), invocation);
  assert.equal(blockedRequestToken({ invocationId: '', records: ['7777aaaa-2222-4333-8444-555555555555'], executionId: 'e-1' }), '7777aaaa-2222-4333-8444-555555555555');
  assert.equal(blockedRequestToken({ invocationId: 'bad id/with:colons', records: [], executionId: '0b9c6a52-3d3e-4c8f-9a51-000000000041' }), '0b9c6a52-3d3e-4c8f-9a51-000000000041');
  for (const token of [invocation, '7777aaaa-2222-4333-8444-555555555555', 'e-1']) assert.ok(blockedReferencePattern.test(blockedRequestReference(token, 'QUESTION_RECORD_MULTIPLE')), token);
  for (const bad of ['request:x y:CODE', 'request::CODE', 'request:a:code', 'other:a:CODE']) assert.equal(blockedReferencePattern.test(bad), false, bad);
});

// Acceptance finding A9: an Execution that RETURNED a blocking failure (not a loss) used to leave the Work open with nothing to do.
test('A9: a returned blocking failure blocks the Work visibly, with the failure code and the override command as its next step', () => {
  const blocked = blockedRequestReference(invocation, 'WORKER_SECRET_SYNC_SCHEMA');
  const impediment = blockedFailureImpediment('w-1', blocked, 'WORKER_SECRET_SYNC_SCHEMA', '2026-11-22T10:00:00.000Z');
  assert.equal(impediment.code, 'RECOVERY_BLOCKED');
  assert.ok(blockedReferencePattern.test(blocked));
  assert.ok(impediment.nextStep.includes('WORKER_SECRET_SYNC_SCHEMA') && impediment.nextStep.includes(`factory resume w-1 --override-blocked-recovery ${blocked} --request-id <id>`) &&
    impediment.nextStep.includes('factory cancel w-1'), impediment.nextStep);
  assert.ok(impediment.nextStep.includes('nothing is retried automatically'));
});

test('A9: only a failure nothing else answers is blocked: not a transient one, a cancelled or closed Work, one with its own decision or one already blocked', () => {
  const base = { result: 'open', cancelling: false, pendingRecovery: false, impediments: [] as { code: string }[], end: { outcome: 'failure', code: 'WORKER_SECRET_SYNC_SCHEMA' as string | null }, decided: false };
  assert.equal(blocksReturnedFailure(base), 'WORKER_SECRET_SYNC_SCHEMA');
  assert.equal(blocksReturnedFailure({ ...base, end: { outcome: 'failure', code: 'ACTIVATE_WORKER_SKILL_PACK_DRIFT' } }), 'ACTIVATE_WORKER_SKILL_PACK_DRIFT');
  // The automatic policy is untouched: a transient failure (or a loss) keeps its operational recovery.
  for (const code of ['WORKER_EXECUTION_UNCERTAIN', 'SANDBOX_ENVIRONMENT_ENDED', 'WORKER_BUDGET_EXHAUSTED', 'STARTED_WORKER_CHANNEL_CLOSED', null]) {
    assert.equal(blocksReturnedFailure({ ...base, end: { outcome: 'failure', code } }), null, String(code));
  }
  for (const outcome of ['completed', 'question', 'timeout', 'stopped']) assert.equal(blocksReturnedFailure({ ...base, end: { outcome, code: 'WORKER_SECRET_SYNC_SCHEMA' } }), null, outcome);
  assert.equal(blocksReturnedFailure({ ...base, result: 'delivered' }), null);
  assert.equal(blocksReturnedFailure({ ...base, result: 'cancelled' }), null);
  assert.equal(blocksReturnedFailure({ ...base, cancelling: true }), null);
  assert.equal(blocksReturnedFailure({ ...base, pendingRecovery: true }), null);
  // A failure with its own impediment and operator decision (two boots without progress, the reviewer retry limit, a lost request) keeps it.
  assert.equal(blocksReturnedFailure({ ...base, end: { outcome: 'failure', code: 'NO_PROGRESS_BETWEEN_BOOTS' }, impediments: [{ code: 'NO_PROGRESS_BETWEEN_BOOTS' }] }), null);
  assert.equal(blocksReturnedFailure({ ...base, end: { outcome: 'failure', code: 'REVIEWER_RETRY_LIMIT' } }), null);
  assert.equal(blocksReturnedFailure({ ...base, impediments: [{ code: 'RECOVERY_BLOCKED' }] }), null);
  assert.equal(blocksReturnedFailure({ ...base, decided: true }), null);
});

test('A9: the override of a returned failure needs no lost request to stay unresolved and follows the same refusals', () => {
  const returned = facts({}, { end: { outcome: 'failure', code: 'WORKER_SECRET_SYNC_SCHEMA', cessation: 'confirmed' },
    blockedRequest: { reference: blockedRequestReference(invocation, 'WORKER_SECRET_SYNC_SCHEMA'), code: 'WORKER_SECRET_SYNC_SCHEMA', override: null } });
  const named = { ...returned, reference: blockedRequestReference(invocation, 'WORKER_SECRET_SYNC_SCHEMA') };
  assert.deepEqual(overrideBlockedRecoveryDecision(named), { kind: 'accept', code: 'WORKER_SECRET_SYNC_SCHEMA' });
  assert.deepEqual(overrideBlockedRecoveryDecision(returned), { kind: 'refuse', code: 'BLOCKED_REFERENCE_MISMATCH' });
  assert.deepEqual(overrideBlockedRecoveryDecision({ ...named, running: true }), { kind: 'refuse', code: 'EXECUTION_ACTIVE' });
});
