import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionProfile } from '../../src/entrypoints/release.js';
import { workerThinkingLevel } from '../../src/contracts/index.js';

// #48 (operator decision 2026-11-22): every role requires reasoning, at the maximum level of the release's single model.
test('#48: the release records the reasoning level its single worker profile runs at', () => {
  // The same value the worker sends on every model request (pinned in test/workers/session-reasoning.test.ts).
  assert.equal(productionProfile.model.thinkingLevel, 'max');
  assert.equal(productionProfile.model.thinkingLevel, workerThinkingLevel);
});
