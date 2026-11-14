import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableOf, chargeDecision, classifyOverrun, counterView, durationView, grantDecision, initialBudget, timeoutReached } from '../../src/control/rules/budget.js';
import type { WorkBudget } from '../../src/control/types.js';

// Rules level (Q11): deterministic functions over canonical inputs; no SQLite, GitHub or clock (callers pass every instant/elapsed value).
const at = '2026-11-14T10:00:00.000Z';
const budget = (patch: Partial<Record<'corrections' | 'recoveries', Partial<WorkBudget['corrections']>>> = {}): WorkBudget => {
  const base = initialBudget({}, 'acme/project', at);
  return { ...base, corrections: { ...base.corrections, ...patch.corrections }, recoveries: { ...base.recoveries, ...patch.recoveries } };
};

test('AC1: separate configurable correction/recovery limits, default three/three, snapshot of the repository configuration', () => {
  const defaults = initialBudget({}, 'acme/project', at);
  assert.deepEqual([defaults.corrections, defaults.recoveries], [{ limit: 3, granted: 0, consumed: 0, reserved: null }, { limit: 3, granted: 0, consumed: 0, reserved: null }]);
  assert.deepEqual(defaults.source, { kind: 'repository-configuration', repository: 'acme/project', recordedAt: at });
  const configured = initialBudget({ correctionLimit: 0, recoveryLimit: 5 }, 'acme/project', at);
  assert.deepEqual([configured.corrections.limit, configured.recoveries.limit], [0, 5]);
  assert.deepEqual(defaults.grants, []);
});

test('AC1/AC2: a correction reserves once, a consumed correction is preserved (question/continuation), a recovery reserves its own counter', () => {
  assert.deepEqual(chargeDecision(budget(), { kind: 'none' }), { kind: 'none' }, 'an initial implementation charges no correction');
  assert.deepEqual(chargeDecision(budget(), { kind: 'correction', correctionId: 'c1', consumed: false }), { kind: 'reserve', counter: 'corrections', correctionId: 'c1' });
  assert.deepEqual(chargeDecision(budget({ corrections: { consumed: 3 } }), { kind: 'correction', correctionId: 'c1', consumed: true }),
    { kind: 'preserve', correctionId: 'c1' }, 'its continuation keeps the identity/charge even with no budget left');
  assert.deepEqual(chargeDecision(budget(), { kind: 'recovery', correctionId: 'c1' }), { kind: 'reserve', counter: 'recoveries', correctionId: 'c1' });
  assert.deepEqual(chargeDecision(budget({ corrections: { consumed: 3 } }), { kind: 'correction', correctionId: 'c2', consumed: false }),
    { kind: 'exhausted', counter: 'corrections', code: 'CORRECTION_LIMIT_REACHED' });
  assert.deepEqual(chargeDecision(budget({ recoveries: { consumed: 2, reserved: 'e1' } }), { kind: 'recovery', correctionId: null }),
    { kind: 'exhausted', counter: 'recoveries', code: 'RECOVERY_LIMIT_REACHED' }, 'an uncertain reservation still occupies the budget');
  assert.deepEqual(chargeDecision(budget({ corrections: { limit: 0, granted: 1 } }), { kind: 'correction', correctionId: 'c3', consumed: false }).kind, 'reserve');
});

test('AC1/AC3: availability counts limit + grants - consumed - reservation and is never negative; the view never hides a reservation', () => {
  assert.equal(availableOf({ limit: 3, granted: 2, consumed: 4, reserved: 'e1' }), 0);
  assert.equal(availableOf({ limit: 3, granted: 2, consumed: 3, reserved: null }), 2);
  assert.equal(availableOf({ limit: 1, granted: 0, consumed: 5, reserved: null }), 0);
  assert.deepEqual(counterView({ limit: 3, granted: 1, consumed: 3, reserved: 'e9' }),
    { limit: 3, granted: 1, effectiveLimit: 4, consumed: 3, reserved: 1, reservedBy: 'e9', available: 0, exhausted: true });
});

test('AC3: a grant applies only through an open current Work with a positive bounded amount; it never resets counters', () => {
  assert.deepEqual(grantDecision({ work: { result: 'open', current: true }, amount: 2 }), { kind: 'apply' });
  assert.deepEqual(grantDecision({ work: null, amount: 2 }), { kind: 'refuse', code: 'WORK_NOT_FOUND' });
  assert.deepEqual(grantDecision({ work: { result: 'delivered', current: true }, amount: 1 }), { kind: 'refuse', code: 'WORK_NOT_OPEN' });
  assert.deepEqual(grantDecision({ work: { result: 'open', current: false }, amount: 1 }), { kind: 'refuse', code: 'WORK_NOT_CURRENT' });
  for (const amount of [0, -1, 1.5, 101, Number.NaN]) assert.deepEqual(grantDecision({ work: { result: 'open', current: true }, amount }), { kind: 'refuse', code: 'GRANT_AMOUNT_INVALID' }, String(amount));
});

test('AC4/AC5/AC6: timeout is reached only on the local monotonic elapsed value; no timeout means no cut at 60 minutes or any other value', () => {
  assert.equal(timeoutReached(null, 61 * 60 * 1000), false, 'absent timeout: no implicit 60 min cut');
  assert.equal(timeoutReached(null, Number.MAX_SAFE_INTEGER), false);
  assert.equal(timeoutReached(120, 119999), false);
  assert.equal(timeoutReached(120, 120000), true);
});

test('AC6: proven, estimated and unknown durations stay distinct; an overrun that cannot be excluded blocks automatic resumption', () => {
  assert.equal(classifyOverrun({ timeoutSeconds: null, measuredMs: null, lowerBoundMs: 10 }), 'not-applicable', 'without timeout imprecision is only observability');
  assert.equal(classifyOverrun({ timeoutSeconds: 60, measuredMs: 59000, lowerBoundMs: null }), 'within', 'cessation before the limit demonstrated');
  assert.equal(classifyOverrun({ timeoutSeconds: 60, measuredMs: 60000, lowerBoundMs: null }), 'proven');
  assert.equal(classifyOverrun({ timeoutSeconds: 60, measuredMs: null, lowerBoundMs: 61000 }), 'proven', 'a proven lower bound already overran');
  assert.equal(classifyOverrun({ timeoutSeconds: 60, measuredMs: null, lowerBoundMs: 1000 }), 'not-excludable', 'lost end after a crash: never zero, never within');
  assert.equal(classifyOverrun({ timeoutSeconds: 60, measuredMs: null, lowerBoundMs: null }), 'not-excludable');
});

test('AC5/AC7: duration presentation: live monotonic, measured, lower bound with calendar estimate, unknown is never zero, silence is not a stall', () => {
  const timing = { timeoutSeconds: 120, clock: 'controller-monotonic' as const, origin: 'run-1', startedAt: at,
    lastActivity: { at: '2026-11-14T10:00:30.000Z', elapsedMs: 30000, event: 'review-handoff' }, duration: null, timeout: null, overrun: null };
  const live = durationView(timing, { elapsedMs: 45000 });
  assert.deepEqual([live.state, live.elapsedMs, live.clock, live.lastActivity?.event], ['running', 45000, 'controller-monotonic', 'review-handoff']);
  assert.match(live.note, /silence is not a stall/i);
  const measured = durationView({ ...timing, duration: { kind: 'measured', elapsedMs: 50000, endedAt: '2026-11-14T10:00:50.000Z' } }, null);
  assert.deepEqual([measured.state, measured.elapsedMs], ['measured', 50000]);
  const lower = durationView({ ...timing, duration: { kind: 'lower-bound', provenMs: 30000, calendarEstimateMs: 7200000, reconciledAt: at } }, null);
  assert.deepEqual([lower.state, lower.elapsedMs, lower.lowerBoundMs, lower.calendarEstimateMs], ['lower-bound', null, 30000, 7200000]);
  assert.match(lower.note, /calendar estimate is not proof/i);
  const unknown = durationView(timing, null);
  assert.deepEqual([unknown.state, unknown.elapsedMs, unknown.lowerBoundMs], ['unknown', null, 30000], 'not live in this process and not reconciled: unknown, never zero');
  assert.equal(durationView(null, null).state, 'not-recorded');
  assert.equal(durationView({ ...timing, startedAt: null, lastActivity: null }, null).state, 'not-started');
});
