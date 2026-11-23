import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionProfile } from '../../src/entrypoints/release.js';
import { defaultWorkerThinkingLevel } from '../../src/contracts/index.js';

// #48 (operator decisions 2026-11-22): every role requires reasoning; the maximum level is the default and a role may be configured lower.
test('#48: the release records the default reasoning level and the levels a role may be configured with (never off)', () => {
  // The same default the worker sends on every model request (pinned in test/workers/session-reasoning.test.ts).
  assert.equal(productionProfile.model.thinkingLevel.default, 'max');
  assert.equal(productionProfile.model.thinkingLevel.default, defaultWorkerThinkingLevel);
  assert.deepEqual(productionProfile.model.thinkingLevel.allowed, ['low', 'medium', 'high', 'xhigh', 'max']);
});
