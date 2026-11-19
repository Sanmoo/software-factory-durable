import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionProfile } from '../../src/entrypoints/release.js';

// Ticket 51 (operator decision 2026-11-19): the release records the fixed reviewer budget it ships (48 requests, 160 tool calls, 30 minutes).
test('ticket 51: the release records the reviewer budget it ships', () => {
  // The same values the worker enforces (`reviewerBudget`, pinned in test/workers/reviewer-budget.test.ts).
  assert.deepEqual(productionProfile.limits.modelBudget.reviewerV1, { requests: 48, toolCalls: 160, requestTimeoutMinutes: 30 });
  assert.equal(productionProfile.reviewer.modelBudget, 'reviewer-v1');
});
