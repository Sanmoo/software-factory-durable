import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedRequestImpediment, blockedRequestReference, overrideBlockedRecoveryDecision, type OverrideFacts } from '../../src/control/rules/recovery.js';

// Rules level, ticket 41: the explicit operator exit of a recovery blocked by a lost Builder request (ticket 27). Every fact is supplied by the test.
const invocation = 'builder-5d1e0c1a-8a0b-4b5e-9c3f-0123456789ab';
const reference = blockedRequestReference(invocation, 'QUESTION_RECORD_INCOMPLETE');
const facts = (change: Partial<OverrideFacts> = {}, execution: Partial<NonNullable<OverrideFacts['execution']>> = {}): OverrideFacts => ({
  work: { result: 'open', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] },
  execution: { state: 'ended', slotHeld: false, end: { outcome: 'failure', code: 'QUESTION_RECORD_INCOMPLETE', cessation: 'confirmed' },
    blockedRequest: { reference, code: 'QUESTION_RECORD_INCOMPLETE', override: null }, lastRecoveryDecision: 'blocked', ...execution },
  reference, running: false, questionBound: false, ...change });

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
  assert.equal(refused(facts({ questionBound: true })), 'REQUEST_RESOLVED_BY_RECORDS', 'a Question recorded for that Execution resolved it');
  assert.equal(refused(facts({}, { lastRecoveryDecision: 'settled' })), 'REQUEST_RESOLVED_BY_RECORDS', 'a later reconciliation no longer blocked');
  assert.equal(refused(facts({}, { end: { outcome: 'failure', code: 'QUESTION_RECORD_MULTIPLE', cessation: 'confirmed' } })), 'BLOCK_CHANGED');
});

test('AC5: once overridden, the same reference is already satisfied (no second acceptance); another one is refused', () => {
  const overridden = facts({ work: { result: 'open', current: true, impediments: [] } },
    { blockedRequest: { reference, code: 'QUESTION_RECORD_INCOMPLETE', override: { reference } } });
  assert.deepEqual(overrideBlockedRecoveryDecision(overridden), { kind: 'already', code: 'BLOCKED_RECOVERY_ALREADY_OVERRIDDEN' });
  assert.deepEqual(overrideBlockedRecoveryDecision({ ...overridden, reference: blockedRequestReference(invocation, 'QUESTION_RECORD_INVALID') }),
    { kind: 'refuse', code: 'RECOVERY_NOT_BLOCKED' });
});
