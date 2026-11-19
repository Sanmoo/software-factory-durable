import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelRuntime, ToolDefinition } from '#factory-pi';
import { productionProfile } from '../../src/entrypoints/release.js';
import { budgetFor, qualifyOAuth, reviewerBudget } from '../../src/workers/oauth-qualification.js';

// Ticket 51 (pilot 35, #126): the Spec reviewer of a medium change exhausted `reviewer-v1` (24 requests) three times and the Execution was held
// REVIEWER_RETRY_LIMIT. Operator decision 2026-11-19: 48 requests, 160 tool calls and 30 minutes, fixed, recorded in the release.

test('ticket 51: reviewer-v1 is 48 requests, 160 tool calls and a 30-minute request bound; only Standards/Spec get it', () => {
  assert.deepEqual([reviewerBudget.requests, reviewerBudget.tools, reviewerBudget.deadlineMs], [48, 160, 30 * 60 * 1000]);
  for (const role of ['standards', 'spec']) assert.equal(budgetFor(role, 'reviewer-v1'), reviewerBudget);
  assert.notEqual(budgetFor('builder', 'reviewer-v1'), reviewerBudget, 'never applied to a role it was not made for');
  assert.ok(Object.isFrozen(reviewerBudget), 'fixed: no configuration changes it');
});

test('ticket 51: the release records the reviewer budget it ships', () => {
  assert.deepEqual(productionProfile.limits.modelBudget.reviewerV1,
    { requests: reviewerBudget.requests, toolCalls: reviewerBudget.tools, requestTimeoutMinutes: reviewerBudget.deadlineMs / 60000 });
  assert.equal(productionProfile.reviewer.modelBudget, 'reviewer-v1');
});

test('ticket 51: the 48th request and the 160th tool call run; the next one closes the qualification', async () => {
  const model = { provider: 'openai', id: 'gpt-6-luna', api: 'openai-responses' };
  const runtime = { streamSimple: () => ({ push() {}, end() {} }) } as unknown as ModelRuntime;
  let aborted = 0;
  const gate = qualifyOAuth(runtime, new AbortController().signal, () => true, () => { aborted++; }, reviewerBudget);
  const request = () => runtime.streamSimple(model as never, { messages: [] } as never, {});
  for (let i = 0; i < 48; i++) request();
  assert.throws(request, /WORKER_QUALIFICATION_CLOSED/);
  assert.equal(aborted, 1);

  const tools = qualifyOAuth({ streamSimple: () => ({ push() {}, end() {} }) } as unknown as ModelRuntime, new AbortController().signal, () => true, () => {}, reviewerBudget);
  const read = tools.tool({ name: 'read', execute: async () => ({ content: [], details: undefined }) } as unknown as ToolDefinition);
  for (let i = 0; i < 160; i++) await read.execute(`c${i}`, { path: '/workspace/a' } as never, undefined, undefined, undefined as never);
  await assert.rejects(read.execute('c160', { path: '/workspace/a' } as never, undefined, undefined, undefined as never), /WORKER_QUALIFICATION_CLOSED/);
});
