import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRuntime } from '#factory-pi';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { qualifyOAuth, reviewerBudget } from '../../src/workers/oauth-qualification.js';
import { workerThinkingLevel } from '../../src/contracts/index.js';
import { remainingMs } from '../runner/budget.js';

// #48: every agent session ran with the model's reasoning off (a literal in the session, and the OAuth request boundary rebuilt the request
// options without the level). Operator decision 2026-11-22: every role requires reasoning; gpt-6-luna runs at the maximum level.

test('#48: the OAuth request boundary sends the release reasoning level on every model request, whatever the session passes', () => {
  const model = { provider: 'openai', id: 'gpt-6-luna', api: 'openai-responses' };
  const seen: unknown[] = [];
  const runtime = {
    streamSimple: (_model: unknown, _context: unknown, options: { reasoning?: unknown }) => {
      seen.push(options.reasoning);
      return { push() {}, end() {} };
    },
  } as unknown as ModelRuntime;
  qualifyOAuth(
    runtime,
    new AbortController().signal,
    () => true,
    () => {},
    reviewerBudget,
  );
  runtime.streamSimple(model as never, { messages: [] } as never, {});
  runtime.streamSimple(model as never, { messages: [] } as never, { reasoning: 'off' } as never);
  assert.equal(workerThinkingLevel, 'max');
  assert.deepEqual(seen, [workerThinkingLevel, workerThinkingLevel]);
});

// I-local: native Pi SDK loop, real Records and owner transport; doubled ONLY the provider HTTP boundary. Not evidence of a real model.
const reviewer: ToolContext = {
  workId: 'work-48',
  executionId: 'execution-48',
  invocationId: 'spec-r1a1',
  role: 'spec',
  environmentRef: 'environment-48',
  bootRef: 'boot-48',
  phaseId: 'review-r1',
};

test('#48: a session asks the provider for reasoning (the highest level its model declares)', { timeout: remainingMs() }, async t => {
  const bodies: { reasoning_effort?: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as { reasoning_effort?: string });
    const chunk = (choice: object) =>
      'data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'thinker', choices: [choice] }) + '\n\n';
    const text = '```json\n' + JSON.stringify({ role: 'spec', conclusion: 'not_verified', findings: [], limitations: ['fixture'] }) + '\n```';
    return new Response(
      chunk({ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }) +
        chunk({ index: 0, delta: {}, finish_reason: 'stop' }) +
        'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const vm = { exec: () => ({ async *output() {}, result: Promise.resolve({ exitCode: 1 }) }) } as unknown as Parameters<typeof nativeOwner>[1];
  const f = await nativeOwner(reviewer, vm, { imageSourceMaxBytes: 1048576 });
  t.after(() => f.close());
  const directory = join(f.root, 'profile');
  await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const session = createWorkerSession({
    profile: {
      id: sdkProfile.id,
      directory,
      systemPrompt: 'Factory reviewer fixture. No personal resources.',
      providerId: 'offline-fixture',
      modelId: 'thinker',
      apiKey: 'synthetic-key',
      provider: {
        api: 'openai-completions' as const,
        baseUrl: 'https://offline.invalid',
        models: [
          {
            id: 'thinker',
            name: 'Thinker',
            reasoning: true,
            input: ['text' as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100000,
            maxTokens: 1000,
          },
        ],
      },
    },
    records: f.records,
    sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }),
  });
  await session.activate({
    context: reviewer,
    prompt: 'Review round 1.',
    signal: f.authority.signal,
    review: { round: 1, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: [], missing: [] },
  });
  assert.ok(bodies.length >= 1);
  // A model that declares no xhigh/max level is clamped by the SDK to the highest one it has; never `off`.
  assert.deepEqual(
    bodies.map(body => body.reasoning_effort),
    bodies.map(() => 'high'),
  );
});
