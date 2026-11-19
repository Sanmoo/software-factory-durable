import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedStartCodePattern } from '../../src/contracts/index.js';
import { blockedStartImpediment, blockingStartRefusal, bootCapacityWait, classifyInterruption, isBootCapacityRefusal, refusedWithoutActivity, remediesFor,
  retryBlockedStartDecision, type StartRetryFacts } from '../../src/control/rules/recovery.js';

// Rules level, ticket 50: capacity refusals are transient; other boot/preparation refusals block with an explicit, generic operator retry
// (ticket 47 reuses it for START_PRESERVED_DISK_CHECK_REQUIRED). Every fact is supplied by the test.
const code = 'PREPARE_ARTIFACT_SEED_VERSION_CONFLICT';
const facts = (change: Partial<StartRetryFacts> = {}, execution: Partial<NonNullable<StartRetryFacts['execution']>> = {}): StartRetryFacts => ({
  work: { result: 'open', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] },
  execution: { state: 'released', started: false, slotHeld: false, blockedStart: { code, cessation: 'confirmed', retry: null }, ...execution },
  code, remedy: null, running: false, cancelling: false, ...change });
const outcome = (value: StartRetryFacts) => { const decided = retryBlockedStartDecision(value); return decided.kind === 'accept' ? 'accept' : decided.code; };

test('AC1: lack of memory/disk at boot or preparation is transient (no block), with a growing persisted capacity wait', () => {
  for (const item of ['START_INSUFFICIENT_MEMORY_FOR_BOOT', 'START_INSUFFICIENT_STORAGE_FOR_BOOT', 'PREPARE_INSUFFICIENT_STORAGE_FOR_PREPARATION']) {
    assert.ok(isBootCapacityRefusal(item), item);
    assert.deepEqual(classifyInterruption(item), { kind: 'recoverable' }, item);
    assert.equal(blockingStartRefusal(item), false, `${item} never needs an operator retry`);
  }
  assert.deepEqual([0, 1, 2, 3, 9].map(bootCapacityWait), [15, 60, 300, 300, 300]);
  for (const item of ['START_PRESERVED_DISK_CHECK_REQUIRED', 'PREPARE_ENVIRONMENT_CONFIGURATION_MISMATCH', code, 'START_GUEST_ASSET_PIN_MISMATCH']) {
    assert.deepEqual(classifyInterruption(item), { kind: 'blocking', code: item }, item);
    assert.ok(blockingStartRefusal(item) && blockedStartCodePattern.test(item), item);
  }
  assert.equal(blockingStartRefusal('WORKER_INTERRUPTED'), false);
});

test('AC2: only a returned definitive refusal proves no activity (start failure, known preparation refusals); indeterminate never', () => {
  assert.equal(refusedWithoutActivity({ phase: 'start', status: 'failure', code: 'PRESERVED_DISK_CHECK_REQUIRED' }), true);
  assert.equal(refusedWithoutActivity({ phase: 'start', status: 'indeterminate', code: 'BOOT_OPERATIONAL_STATE_UNCONFIRMED' }), false);
  assert.equal(refusedWithoutActivity({ phase: 'prepare', status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' }), true);
  assert.equal(refusedWithoutActivity({ phase: 'prepare', status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH' }), true);
  assert.equal(refusedWithoutActivity({ phase: 'prepare', status: 'failure', code: 'SYNTHETIC_PREPARE_FAILED' }), false, 'unknown preparation failure: host evidence first');
  assert.equal(refusedWithoutActivity({ phase: 'prepare', status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE' }), false);
});

test('AC2: the impediment names the refusal, its detail and the exact retry command (remedy where it applies)', () => {
  const seed = blockedStartImpediment('w-1', code, 'factory/skill-pack/v8/skills/tdd/SKILL.md', '2026-11-19T10:00:00.000Z');
  assert.equal(seed.code, 'RECOVERY_BLOCKED');
  assert.ok(seed.nextStep.includes('factory/skill-pack/v8/skills/tdd/SKILL.md'), 'the divergent file is shown');
  assert.ok(seed.nextStep.includes(`factory resume w-1 --retry-blocked-start ${code} --request-id <id>`), seed.nextStep);
  assert.ok(seed.nextStep.includes('--remedy recreate-artifact-seed'), 'recreating the seed is offered');
  const disk = blockedStartImpediment('w-1', 'START_PRESERVED_DISK_CHECK_REQUIRED', null, '2026-11-19T10:00:00.000Z');
  assert.ok(!disk.nextStep.includes('--remedy') && disk.nextStep.includes('--retry-blocked-start START_PRESERVED_DISK_CHECK_REQUIRED'));
  const mismatch = blockedStartImpediment('w-1', 'PREPARE_ENVIRONMENT_CONFIGURATION_MISMATCH', 'sandbox.diskGiB 40 -> 60', '2026-11-19T10:00:00.000Z');
  assert.match(mismatch.nextStep, /sandbox\.diskGiB 40 -> 60.*memory\/vCPU never do.*NEW environment/);
  assert.deepEqual([remediesFor(code), remediesFor('START_PRESERVED_DISK_CHECK_REQUIRED')], [['recreate-artifact-seed'], []]);
});

test('AC2: accepted only for exactly the blocking refusal of a current open Work, ceased, released, without Slot; remedy only where it applies', () => {
  assert.deepEqual(retryBlockedStartDecision(facts()), { kind: 'accept', code });
  assert.equal(outcome(facts({ remedy: 'recreate-artifact-seed' })), 'accept');
  assert.equal(outcome(facts({ work: null })), 'WORK_NOT_FOUND');
  assert.equal(outcome(facts({ work: { result: 'open', current: false, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'WORK_NOT_CURRENT');
  assert.equal(outcome(facts({ work: { result: 'cancelled', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'WORK_CANCELLED');
  assert.equal(outcome(facts({ work: { result: 'delivered', current: true, impediments: [{ code: 'RECOVERY_BLOCKED' }] } })), 'WORK_DELIVERED');
  assert.equal(outcome(facts({ cancelling: true })), 'WORK_CANCELLING');
  assert.equal(outcome(facts({ work: { result: 'open', current: true, impediments: [] } })), 'RECOVERY_NOT_BLOCKED');
  assert.equal(outcome(facts({}, { blockedStart: undefined })), 'BLOCK_NOT_A_START_REFUSAL', 'a lost request (ticket 41) or a worker failure is not a start refusal');
  assert.equal(outcome(facts({ execution: null })), 'BLOCK_NOT_A_START_REFUSAL');
  assert.equal(outcome(facts({ code: 'START_PRESERVED_DISK_CHECK_REQUIRED' })), 'BLOCKED_CODE_MISMATCH');
  assert.equal(outcome(facts({ running: true })), 'EXECUTION_ACTIVE');
  assert.equal(outcome(facts({}, { state: 'held' })), 'EXECUTION_ACTIVE');
  assert.equal(outcome(facts({}, { started: true })), 'BLOCK_NOT_A_START_REFUSAL');
  assert.equal(outcome(facts({}, { blockedStart: { code, cessation: 'unconfirmed', retry: null } })), 'CESSATION_NOT_CONFIRMED');
  assert.equal(outcome(facts({}, { slotHeld: true })), 'SLOT_HELD');
  assert.equal(outcome(facts({ code: 'START_PRESERVED_DISK_CHECK_REQUIRED', remedy: 'recreate-artifact-seed' },
    { blockedStart: { code: 'START_PRESERVED_DISK_CHECK_REQUIRED', cessation: 'confirmed', retry: null } })), 'REMEDY_NOT_APPLICABLE');
});

test('AC2: a retried block is already satisfied for the same code; another code is refused', () => {
  const retried = facts({ work: { result: 'open', current: true, impediments: [] } }, { blockedStart: { code, cessation: 'confirmed', retry: { code } } });
  assert.deepEqual(retryBlockedStartDecision(retried), { kind: 'already', code: 'BLOCKED_START_ALREADY_RETRIED' });
  assert.equal(outcome({ ...retried, code: 'START_PRESERVED_DISK_CHECK_REQUIRED' }), 'RECOVERY_NOT_BLOCKED');
});
