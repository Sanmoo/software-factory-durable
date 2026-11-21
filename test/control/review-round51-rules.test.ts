import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyInterruption, newReviewRoundDecision, reviewerRetryLimitImpediment, type NewReviewRoundFacts } from '../../src/control/rules/recovery.js';
import { interruptedEnd } from '../../src/control/rules/questions.js';

// Rules level, ticket 51: the operator's explicit decision on an Execution stopped by REVIEWER_RETRY_LIMIT (ticket 28's cap of 2 retries per
// role per round). Two decisions only: a new review round, or cancel. Accepting an unverified round is not an option. Facts are supplied.
const facts = (change: Partial<NewReviewRoundFacts> = {}, execution: Partial<NonNullable<NewReviewRoundFacts['execution']>> = {}): NewReviewRoundFacts => ({
  work: { result: 'open', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] },
  execution: {
    state: 'ended',
    slotHeld: false,
    held: { code: 'REVIEWER_RETRY_LIMIT' },
    end: { outcome: 'failure', code: 'REVIEWER_RETRY_LIMIT', cessation: 'confirmed' },
    reviewRetryLimit: null,
    ...execution,
  },
  running: false,
  cancelling: false,
  pendingRecovery: false,
  ...change,
});
const decided = (value: NewReviewRoundFacts) => {
  const decision = newReviewRoundDecision(value);
  return decision.kind === 'accept' ? 'accept' : `${decision.kind}:${decision.code}`;
};

test('ticket 51: REVIEWER_RETRY_LIMIT is never retried automatically; once ceased it ends as a failure that blocks for the operator', () => {
  assert.deepEqual(classifyInterruption('REVIEWER_RETRY_LIMIT'), { kind: 'blocking', code: 'REVIEWER_RETRY_LIMIT' });
  assert.deepEqual(interruptedEnd({ questionId: null, recovered: false, trigger: 'review-retry-limit', blocked: null, heldCode: 'REVIEWER_RETRY_LIMIT' }), {
    outcome: 'failure',
    code: 'REVIEWER_RETRY_LIMIT',
    questionId: null,
  });
});

test('ticket 51: the impediment names exactly the two decisions (new review round, cancel) and no way to accept the unverified round', () => {
  const impediment = reviewerRetryLimitImpediment('w-1', '2026-11-19T10:00:00.000Z');
  assert.equal(impediment.code, 'RECOVERY_BLOCKED');
  assert.ok(impediment.nextStep.includes('factory resume w-1 --new-review-round --request-id <id>'), impediment.nextStep);
  assert.ok(impediment.nextStep.includes('factory cancel w-1'), impediment.nextStep);
  assert.match(impediment.nextStep, /never accepted as verified/);
});

test('ticket 51: a new review round is accepted only for a current open Work blocked by REVIEWER_RETRY_LIMIT, ceased, without activity or Slot', () => {
  assert.equal(decided(facts()), 'accept');
  assert.equal(decided(facts({ work: null })), 'refuse:WORK_NOT_FOUND');
  assert.equal(decided(facts({ work: { result: 'open', current: false, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'refuse:WORK_NOT_CURRENT');
  assert.equal(decided(facts({ work: { result: 'cancelled', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'refuse:WORK_CANCELLED');
  assert.equal(decided(facts({ work: { result: 'delivered', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'refuse:WORK_DELIVERED');
  assert.equal(decided(facts({ cancelling: true })), 'refuse:WORK_CANCELLING');
  assert.equal(decided(facts({ execution: null })), 'refuse:REVIEWER_RETRY_LIMIT_NOT_PENDING');
  assert.equal(
    decided(
      facts(
        {},
        {
          held: { code: 'START_PRESERVED_DISK_CHECK_REQUIRED' },
          end: { outcome: 'failure', code: 'START_PRESERVED_DISK_CHECK_REQUIRED', cessation: 'confirmed' },
        },
      ),
    ),
    'refuse:REVIEWER_RETRY_LIMIT_NOT_PENDING',
    'another block is not a review decision',
  );
  // Still held (its own boot not yet stopped): the controller stops it; the decision waits for the confirmed cessation.
  assert.equal(decided(facts({}, { state: 'held', end: null })), 'refuse:CESSATION_NOT_CONFIRMED');
  assert.equal(decided(facts({}, { end: { outcome: 'failure', code: 'REVIEWER_RETRY_LIMIT', cessation: 'unconfirmed' } })), 'refuse:CESSATION_NOT_CONFIRMED');
  assert.equal(decided(facts({ running: true })), 'refuse:EXECUTION_ACTIVE');
  assert.equal(decided(facts({}, { slotHeld: true })), 'refuse:SLOT_HELD');
  assert.equal(decided(facts({ work: { result: 'open', current: true, impediments: [] } })), 'refuse:RECOVERY_NOT_BLOCKED');
  assert.equal(decided(facts({ pendingRecovery: true })), 'refuse:RECOVERY_ALREADY_PENDING');
});

test('ticket 51: a decision already taken is reported, never applied twice', () => {
  const after = { decision: 'new-review-round' as const, request_id: 'r-1' };
  assert.equal(
    decided(facts({ work: { result: 'open', current: true, impediments: [] }, pendingRecovery: true }, { reviewRetryLimit: after })),
    'already:NEW_REVIEW_ROUND_ALREADY_DECIDED',
  );
  assert.equal(
    decided(
      facts(
        { work: { result: 'cancelled', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] } },
        { reviewRetryLimit: { decision: 'cancel', request_id: 'r-2' } },
      ),
    ),
    'refuse:WORK_CANCELLED',
    'a cancel decision is final',
  );
});
