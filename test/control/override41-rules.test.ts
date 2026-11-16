import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedReferencePattern, blockedRequestReference } from '../../src/contracts/index.js';
import { blockedRequestImpediment, blockedRequestToken, overrideBlockedRecoveryDecision, positiveResolution, type OverrideFacts } from '../../src/control/rules/recovery.js';

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
