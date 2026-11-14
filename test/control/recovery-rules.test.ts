import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyInterruption, dispatchGate, interruptionRecoveryPrompt, recoveryBackoff, recoveryRequest, recoveryWait, startDecision } from '../../src/control/rules/recovery.js';

// Rules level (Q11), ticket 26: deterministic functions over canonical inputs; every instant is supplied by the test (no clock, no I/O).
const t0 = Date.parse('2026-11-14T10:00:00.000Z');

test('AC6: persisted waits 5/15/45 s by recoveries already consumed; a larger service wait prevails; invalid hints never shorten it', () => {
  assert.deepEqual([0, 1, 2, 3, 7].map(attempt => recoveryWait({ attempt })), [5, 15, 45, 45, 45]);
  assert.equal(recoveryWait({ attempt: 0, serviceSeconds: 120 }), 120);
  assert.equal(recoveryWait({ attempt: 1, serviceSeconds: 3 }), 15, 'a shorter service hint does not anticipate');
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, null]) assert.equal(recoveryWait({ attempt: 2, serviceSeconds: bad }), 45);
  assert.equal(recoveryWait({ attempt: 0, serviceSeconds: 30.2 }), 31);
});

test('AC6: a new request derives its deadline; a repeated event keeps it (never earlier, never a second unit); a legacy request is filled from its own instant', () => {
  assert.deepEqual(recoveryRequest({ pending: null, consumed: 1, requestedAtMs: t0 }), { kind: 'new', waitSeconds: 15, attempt: 1, notBeforeMs: t0 + 15000 });
  assert.deepEqual(recoveryRequest({ pending: { notBeforeMs: t0 + 5000, requestedAtMs: t0 }, consumed: 0, requestedAtMs: t0 + 4000 }), { kind: 'keep' });
  assert.deepEqual(recoveryRequest({ pending: { notBeforeMs: t0 + 5000, requestedAtMs: t0 }, consumed: 0, requestedAtMs: t0 + 4000, serviceSeconds: 600 }), { kind: 'keep' },
    'not even a service hint renews or reschedules a pending recovery');
  assert.deepEqual(recoveryRequest({ pending: { notBeforeMs: null, requestedAtMs: t0 - 60000 }, consumed: 2, requestedAtMs: t0 }),
    { kind: 'fill', waitSeconds: 45, attempt: 2, notBeforeMs: t0 - 15000 });
});

test('AC6: the wait blocks until its deadline (calendar supplied); an unreadable deadline blocks; no deadline does not', () => {
  assert.equal(recoveryBackoff(t0 + 5000, t0 + 4999), true);
  assert.equal(recoveryBackoff(t0 + 5000, t0 + 5000), false);
  assert.equal(recoveryBackoff(Number.NaN, t0), true);
  assert.equal(recoveryBackoff(null, t0), false);
});

test('AC6: only transient worker/transport/channel interruptions are recoverable; authorization, configuration, drift, integrity and preparation block', () => {
  for (const code of [null, 'CONTROLLER_CRASH', 'STARTED_WORKER_EXECUTION_UNCERTAIN', 'ACTIVATE_WORKER_LAUNCH_UNCERTAIN', 'COMPLETED_WORKER_CHANNEL_CLOSED',
    'REVIEW_DELIVERY_UNCERTAIN', 'REVIEWER_CESSATION_UNCONFIRMED', 'ADMINISTRATIVE_STOP_CESSATION_UNCONFIRMED', 'WORKER_PROVIDER_UNAVAILABLE', 'TOOL_CHANNEL_CLOSED']) {
    assert.deepEqual(classifyInterruption(code), { kind: 'recoverable' }, String(code));
  }
  for (const code of ['START_RECEIPT_CONFLICT', 'PREPARE_ENVIRONMENT_PREPARATION_INCOMPLETE', 'START_GUEST_ASSETS_INVALID', 'CREDENTIAL_GITHUB_TOKEN_ISSUANCE_UNKNOWN',
    'ACTIVATION_CREDENTIALS_WITHDRAWN', 'EXECUTION_TIMEOUT', 'WORKER_SKILL_PACK_DRIFT', 'STARTED_WORKER_SKILL_PACK_DRIFT', 'REVIEW_HANDOFF_STALE']) {
    assert.deepEqual(classifyInterruption(code), { kind: 'blocking', code }, code);
  }
});

test('AC3: start evidence — a notified or discovered complete receipt confirms; absence proves non-start only after confirmed cessation; otherwise uncertain', () => {
  const base = { cessation: 'confirmed' as const, observation: null };
  assert.deepEqual(startDecision({ ...base, confirmed: { receiptId: 'r1' }, phase: 'started' }), { kind: 'confirmed', receiptId: 'r1', source: 'notification' });
  for (const phase of ['reserved', 'prepared', 'booted']) {
    assert.deepEqual(startDecision({ ...base, confirmed: null, phase, cessation: 'unconfirmed' }), { kind: 'not-started', basis: 'no-activation-request' }, phase);
  }
  assert.deepEqual(startDecision({ confirmed: null, phase: 'activation-requested', cessation: 'confirmed', observation: { kind: 'receipt', receiptId: 'r2' } }),
    { kind: 'confirmed', receiptId: 'r2', source: 'receipt-discovered' });
  assert.deepEqual(startDecision({ confirmed: null, phase: 'activation-requested', cessation: 'confirmed', observation: { kind: 'absent' } }),
    { kind: 'not-started', basis: 'receipt-absent-after-cessation' });
  assert.deepEqual(startDecision({ confirmed: null, phase: 'activation-requested', cessation: 'unconfirmed', observation: { kind: 'absent' } }),
    { kind: 'uncertain', code: 'RECOVERY_CESSATION_UNCONFIRMED' }, 'absence without cessation proves nothing: a late receipt may still appear');
  assert.deepEqual(startDecision({ confirmed: null, phase: 'activation-requested', cessation: 'confirmed', observation: { kind: 'uncertain', code: 'START_RECEIPT_INCOMPLETE' } }),
    { kind: 'uncertain', code: 'START_RECEIPT_INCOMPLETE' });
  assert.deepEqual(startDecision({ confirmed: null, phase: 'activation-requested', cessation: 'confirmed', observation: null }),
    { kind: 'uncertain', code: 'START_RECEIPT_OBSERVATION_NOT_COMPOSED' });
});

test('AC5: unknown resources, inventory, tasks or orphan Slots keep dispatch globally closed; without them only composition matters', () => {
  const base = { executionComposed: true, inventory: 'listed' as const, tasks: 0, unknownResources: [], orphanSlots: [] };
  assert.deepEqual(dispatchGate(base), { reason: null, closing: [] });
  assert.deepEqual(dispatchGate({ ...base, executionComposed: false }), { reason: 'EXECUTION_NOT_ENABLED', closing: [] });
  assert.deepEqual(dispatchGate({ ...base, inventory: 'unknown' }), { reason: 'RECONCILIATION_REQUIRED', closing: ['RUNTIME_INVENTORY_UNKNOWN'] });
  assert.deepEqual(dispatchGate({ ...base, tasks: 1, unknownResources: ['UNKNOWN_RESOURCE:run/x'], orphanSlots: ['e1'], executionComposed: false }),
    { reason: 'RECONCILIATION_REQUIRED', closing: ['PERSISTED_TASKS_PRESENT', 'UNKNOWN_RESOURCE:run/x', 'SLOT_WITHOUT_CURRENT_EXECUTION:e1'] });
});

test('AC8: the substitute instruction names the preserved context and forbids a blind replay of the last tool; a clean stop is not called a failure', () => {
  const input = { ticketUrl: 'https://github.com/acme/project/issues/3', repository: 'acme/project', base: 'main', baseCommit: 'a'.repeat(40), branch: 'factory/3-x',
    checkout: '/workspace/checkout', skillDirectory: '/artifacts/factory/skill-pack/factory-skills-v4', workId: 'w1', executionId: 'e2', previousExecutionId: 'e1', reviews: true };
  const recovery = interruptionRecoveryPrompt({ ...input, reason: 'OPERATIONAL_RECOVERY', code: 'CONTROLLER_CRASH' });
  assert.match(recovery, /previous-execution=e1/);
  assert.match(recovery, /never repeat a tool call blindly/);
  assert.match(recovery, /inspect the current state/);
  assert.match(recovery, /OPERATIONAL_RECOVERY:CONTROLLER_CRASH/);
  assert.doesNotMatch(recovery, /^\/implement/m, 'never a fresh /implement');
  const stopped = interruptionRecoveryPrompt({ ...input, reason: 'ADMINISTRATIVE_STOP', code: 'ADMINISTRATIVE_STOP' });
  assert.match(stopped, /stopped administratively/);
  assert.doesNotMatch(stopped, /interrupted \(/);
});
