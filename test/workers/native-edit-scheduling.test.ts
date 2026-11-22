import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { join } from 'node:path';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '#factory-pi';
import { createSandbox, type ToolContext, type ToolProjection } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderEdit } from '../../src/workers/edit.js';
import { builderWrite } from '../../src/workers/write.js';
import { builderBash } from '../../src/workers/bash.js';
import { reviewerRead } from '../../src/workers/read.js';
import { remainingMs } from '../runner/budget.js';

const context: ToolContext = {
  workId: 'schedule-work',
  executionId: 'schedule-exec',
  invocationId: 'schedule-invocation',
  role: 'builder',
  environmentRef: 'schedule-env',
  bootRef: 'schedule-boot',
  phaseId: 'schedule-phase',
};

// Private component qualification only: Edit remains absent from normal worker sessions.
// Real pinned SDK/provider loop, wrappers, Protocol, Records and owner; VM and
// external HTTP are doubles. No guest helper body is executed on the host.
for (const scenario of ['unmarked-control', 'edit-write', 'write-bash', 'write-write', 'edit-edit', 'read-read', 'critical-edit-write'] as const) {
  test(`native SDK scheduling: ${scenario}`, { timeout: remainingMs() }, async t => {
    const legacy = scenario === 'unmarked-control';
    const criticalCase = scenario === 'critical-edit-write';
    const first = scenario.startsWith('write') ? 'write' : scenario === 'read-read' ? 'read' : 'edit';
    const second = scenario === 'write-bash' ? 'bash' : scenario === 'edit-edit' ? 'edit' : scenario === 'read-read' ? 'read' : 'write';
    const bound = { ...context, role: scenario === 'read-read' ? ('spec' as const) : ('builder' as const) };
    let ownerCalls = 0;
    let criticals = 0;
    let abortSession = () => {};
    const critical = () => {
      criticals++;
      abortSession();
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const pendingCapture = new Promise<void>(resolve => {
      entered = resolve;
    });
    const f = await nativeOwner(
      bound,
      {
        exec() {
          ownerCalls++;
          entered();
          return {
            async *output() {
              await gate;
              yield { stream: 'stdout' as const, data: criticalCase ? Buffer.from([0xff]) : Buffer.from('old') };
            },
            result: Promise.resolve({ exitCode: 0 }),
          };
        },
      },
      { editSourceMaxBytes: 8192 },
    );
    t.after(() => f.close());
    const directory = join(f.root, 'profile');
    await mkdir(directory, { mode: 0o700 });
    await mkdir(join(directory, 'sessions'), { mode: 0o700 });
    const runtime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(directory, 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider('offline-fixture', {
      api: 'openai-completions',
      baseUrl: 'https://offline.invalid',
      models: [
        {
          id: 'builder',
          name: 'Builder',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
      ],
    });
    await runtime.setRuntimeApiKey('offline-fixture', 'synthetic-key');
    const model = runtime.getModel('offline-fixture', 'builder');
    assert.ok(model);
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'Offline scheduling probe.',
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources() {},
      async reload() {},
    };
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
      assert.ok(++requests <= 2);
      const args = (name: string, path: string) =>
        name === 'edit'
          ? { path, edits: [{ oldText: 'missing', newText: 'new' }] }
          : name === 'write'
            ? { path, content: 'new' }
            : name === 'bash'
              ? { command: 'echo fixture' }
              : { path };
      const delta =
        requests === 1
          ? {
              role: 'assistant',
              tool_calls: [first, second].map((name, index) => ({
                index,
                id: index === 0 ? 'first' : 'second',
                type: 'function',
                function: { name, arguments: JSON.stringify(args(name, index === 0 ? 'source' : 'different')) },
              })),
            }
          : { role: 'assistant', content: 'Done.' };
      const chunk = {
        id: 'response-' + requests,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'builder',
        choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }],
      };
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const projection = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
    let secondRpc = 0;
    let secondResult: unknown;
    let secondSettled!: () => void;
    const writeSettled = new Promise<void>(resolve => {
      secondSettled = resolve;
    });
    const calls = new AsyncLocalStorage<string>();
    let firstSettled = false;
    const sandbox: ToolProjection = {
      async executeTool(ctx, call, onData, signal) {
        const isSecond = calls.getStore() === 'second';
        if (isSecond) {
          secondRpc++;
          if (legacy) await pendingCapture;
          else assert.ok(firstSettled, 'second Projection entry must follow first owner settlement');
        }
        const result = await projection.executeTool(ctx, call, onData, signal);
        if (isSecond) {
          secondResult = result;
          secondSettled();
        } else firstSettled = true;
        return result;
      },
    };
    const factoryDefinitions: ToolDefinition[] = [
      builderEdit(bound, sandbox, critical),
      builderWrite(bound, sandbox, critical),
      builderBash(bound, sandbox, critical),
      reviewerRead(bound, sandbox, critical),
    ];
    // Only tools present in this batch participate; an unused Edit marker cannot mask Write/Bash.
    // AsyncLocalStorage observes invocation identity without changing execution ordering.
    const definitions = factoryDefinitions
      .filter(definition => [first, second].includes(definition.name))
      .map(definition => ({
        ...definition,
        execute: (...args: Parameters<typeof definition.execute>) => calls.run(args[0], () => definition.execute(...args)),
      }));
    // Test-only reconstruction of the old unmarked definitions, NEVER a production fallback.
    const customTools = legacy
      ? definitions.map(definition => {
          const clone = { ...definition };
          delete clone.executionMode;
          return clone;
        })
      : definitions;
    const manager = SessionManager.create('/workspace', join(directory, 'sessions'));
    const { session } = await createAgentSession({
      cwd: '/workspace',
      agentDir: directory,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'off',
      tools: [...new Set([first, second])],
      customTools,
      resourceLoader,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false, provider: { maxRetries: 0 } },
        compaction: { enabled: false },
      }),
    });
    abortSession = () => {
      void session.abort();
    };
    const prompt = session.prompt('Edit source and write different in the same assistant message.');
    const abort = () => {
      release();
      void session.abort();
    };
    t.signal.addEventListener('abort', abort, { once: true });
    try {
      await pendingCapture;
      if (legacy) {
        await writeSettled;
        assert.equal(secondRpc, 1);
        assert.deepEqual(secondResult, { status: 'failure', code: 'TOOL_CALL_IN_PROGRESS' });
      } else {
        // Finite event-loop checkpoint, not a sleep/poll or a wait on the blocked second call.
        await nextTurn();
        assert.equal(secondRpc, 0, 'serial dispatch must not reach second Projection during pending owner request');
        assert.equal(ownerCalls, 1);
      }
    } finally {
      release();
      try {
        await prompt;
      } finally {
        t.signal.removeEventListener('abort', abort);
        session.dispose();
      }
    }
    const messages = manager.buildSessionContext().messages;
    const results = messages.filter(message => message.role === 'toolResult');
    if (legacy) {
      assert.ok(results.some(message => JSON.stringify(message).includes('TOOL_CALL_IN_PROGRESS')));
    } else {
      assert.ok(!JSON.stringify(results).includes('TOOL_CALL_IN_PROGRESS'));
      assert.equal(criticals, criticalCase ? 1 : 0);
      if (criticalCase) {
        assert.equal(secondRpc, 0, 'critical callback abort prevents queued tool dispatch');
        assert.equal(requests, 1, 'critical abort must not request another provider turn');
        assert.ok(results.some(result => result.toolCallId === 'first' && result.isError));
      } else {
        assert.ok(secondRpc > 0);
        assert.equal(requests, 2);
        assert.equal(results.length, 2);
        for (const [index, name] of [first, second].entries()) {
          const result = results[index];
          assert.ok(result);
          assert.equal(result.isError, name === 'edit');
          if (name === 'edit') assert.match(JSON.stringify(result), /Could not find/);
        }
      }
    }
  });
}

test('every shared-channel Factory definition requests native sequential execution', () => {
  const sandbox: ToolProjection = {
    executeTool: async () => {
      throw new Error('must not execute');
    },
  };
  for (const definition of [builderEdit(context, sandbox), builderWrite(context, sandbox), builderBash(context, sandbox), reviewerRead(context, sandbox)])
    assert.equal(definition.executionMode, 'sequential');
});
