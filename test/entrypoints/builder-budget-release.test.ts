import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionProfile } from '../../src/entrypoints/release.js';
import { builderBudgetMaximumFactor } from '../../src/contracts/index.js';

// Ticket 48 (operator decision 2026-11-19): the release records the Builder budget it ships (150 requests, 300 tool calls, 60 minutes per
// model request), the per-repository maximum (2x) and the continuations per Work (5).
test('ticket 48: the release records the Builder budget, its repository maximum and the continuations per Work', () => {
  const recorded = productionProfile.limits.modelBudget.builderV1;
  assert.deepEqual(recorded, {
    requests: 150,
    toolCalls: 300,
    requestTimeoutMinutes: 60,
    repositoryMaximum: { requests: 300, toolCalls: 600, requestTimeoutMinutes: 120 },
    continuationsPerWork: 5,
  });
  // The worker derives `builderBudget` from the same contract values (pinned in test/workers/builder-budget.test.ts).
  assert.deepEqual(
    [recorded.requests, recorded.toolCalls, recorded.requestTimeoutMinutes].map(value => value * builderBudgetMaximumFactor),
    [recorded.repositoryMaximum.requests, recorded.repositoryMaximum.toolCalls, recorded.repositoryMaximum.requestTimeoutMinutes],
  );
  assert.equal(productionProfile.builder.modelBudget, 'builder-v1');
});
