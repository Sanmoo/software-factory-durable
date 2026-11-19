import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelRuntime, ToolDefinition } from '#factory-pi';
import { budgetFor, builderBudget, builderBudgetOverrideValid, qualifyOAuth } from '../../src/workers/oauth-qualification.js';
import { workerBootstrapSchema } from '../../src/platform/host/index.js';

// Ticket 48 (pilot 35): every Builder of a Java code Ticket exhausted `builder-v1` (60 requests) in 10-30 minutes. Operator decision
// 2026-11-19: 150 requests, 300 tool calls and 60 minutes (the per-request timeout), adjustable per repository up to 2x.

const model = { provider: 'openai', id: 'gpt-6-luna', api: 'openai-responses' };
const runtime = () => ({ streamSimple: () => ({ push() {}, end() {} }) }) as unknown as ModelRuntime;

test('ticket 48: builder-v1 is 150 requests, 300 tool calls and a 60-minute request bound; only the Builder gets it', () => {
  assert.deepEqual([builderBudget.requests, builderBudget.tools, builderBudget.deadlineMs], [150, 300, 60 * 60 * 1000]);
  assert.equal(budgetFor('builder', 'builder-v1'), builderBudget);
  assert.notEqual(budgetFor('spec', 'builder-v1'), builderBudget, 'never applied to a role it was not made for');
  assert.ok(Object.isFrozen(builderBudget));
});

test('ticket 48: a repository override replaces only requests/tools/request timeout, never above 2x; anything else refuses', () => {
  const limits = budgetFor('builder', 'builder-v1', { requests: 300, tools: 600, deadlineMs: 120 * 60 * 1000 });
  assert.deepEqual([limits.requests, limits.tools, limits.deadlineMs, limits.contextBytes], [300, 600, 120 * 60 * 1000, builderBudget.contextBytes]);
  assert.equal(builderBudgetOverrideValid({ requests: 1, tools: 1, deadlineMs: 60_000 }), true, 'lowering is allowed');
  for (const bad of [{ requests: 301, tools: 300, deadlineMs: 3_600_000 }, { requests: 150, tools: 601, deadlineMs: 3_600_000 },
    { requests: 150, tools: 300, deadlineMs: 7_260_000 }, { requests: 0, tools: 300, deadlineMs: 3_600_000 }, { requests: 150, tools: 300, deadlineMs: 3_600_500 }]) {
    assert.equal(builderBudgetOverrideValid(bad), false, JSON.stringify(bad));
    assert.throws(() => budgetFor('builder', 'builder-v1', bad), /WORKER_BUDGET_INVALID/);
  }
  assert.throws(() => budgetFor('spec', 'reviewer-v1', { requests: 10, tools: 10, deadlineMs: 60_000 }), /WORKER_BUDGET_INVALID/, 'Builder only');
});

test('ticket 48: the bootstrap carries the override only for a builder-v1 Builder and never above 2x', () => {
  const base = { version: 1, context: { workId: 'w', executionId: 'e', invocationId: 'i', role: 'builder', environmentRef: 'env', bootRef: 'boot', phaseId: 'builder-initial' },
    endpoint: '/run/x', recordsRoot: '/r', knownSecrets: [], prompt: 'p',
    profile: { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3', systemPrompt: 's', auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna',
      api: 'openai-responses', directory: '/d' } };
  const ok = { requests: 300, tools: 600, deadlineMs: 7_200_000 };
  assert.equal(workerBootstrapSchema.safeParse({ ...base, modelBudget: 'builder-v1', builderBudget: ok }).success, true);
  assert.equal(workerBootstrapSchema.safeParse({ ...base, modelBudget: 'builder-v1', builderBudget: { ...ok, requests: 301 } }).success, false);
  assert.equal(workerBootstrapSchema.safeParse({ ...base, builderBudget: ok }).success, false, 'only with builder-v1');
  assert.equal(workerBootstrapSchema.safeParse({ ...base, context: { ...base.context, role: 'spec' }, modelBudget: 'reviewer-v1', builderBudget: ok }).success, false);
});

test('ticket 48: the session knows which count of the budget closed it (requests or tools), and only then', async () => {
  const requests = runtime();
  const gate = qualifyOAuth(requests, new AbortController().signal, () => true, () => {}, builderBudget);
  const request = () => requests.streamSimple(model as never, { messages: [] } as never, {});
  for (let i = 0; i < 150; i++) request();
  assert.equal(gate.exhausted(), null);
  assert.throws(request, /WORKER_QUALIFICATION_CLOSED/);
  assert.equal(gate.exhausted(), 'requests');

  const tools = qualifyOAuth(runtime(), new AbortController().signal, () => true, () => {}, budgetFor('builder', 'builder-v1', { requests: 10, tools: 3, deadlineMs: 60_000 }));
  const read = tools.tool({ name: 'read', execute: async () => ({ content: [], details: undefined }) } as unknown as ToolDefinition);
  for (let i = 0; i < 3; i++) await read.execute(`c${i}`, { path: '/workspace/a' } as never, undefined, undefined, undefined as never);
  await assert.rejects(read.execute('c3', { path: '/workspace/a' } as never, undefined, undefined, undefined as never), /WORKER_QUALIFICATION_CLOSED/);
  assert.equal(tools.exhausted(), 'tools');

  // Closed for another reason (wrong model): not a budget end.
  const other = runtime();
  const closed = qualifyOAuth(other, new AbortController().signal, () => true, () => {}, builderBudget);
  assert.throws(() => other.streamSimple({ ...model, id: 'other' } as never, { messages: [] } as never, {}), /WORKER_QUALIFICATION_CLOSED/);
  assert.equal(closed.exhausted(), null);
});
