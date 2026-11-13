import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader } from '#factory-pi';
import { createSandbox, type ToolContext, type ToolProjection } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderEdit } from '../../src/workers/edit.js';
import { builderWrite } from '../../src/workers/write.js';

const context: ToolContext = { workId: 'schedule-work', executionId: 'schedule-exec', invocationId: 'schedule-invocation',
  role: 'builder', environmentRef: 'schedule-env', bootRef: 'schedule-boot', phaseId: 'schedule-phase' };

// Prerequisite probe only: Edit remains absent from normal worker sessions.
// Real pinned SDK/provider loop, wrappers, Protocol, Records and owner; VM and
// external HTTP are doubles. No guest helper body is executed on the host.
test('native SDK parallel Write reaches the single-flight projection during deferred Edit capture', { timeout: 10000 }, async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const pendingCapture = new Promise<void>(resolve => { entered = resolve; });
  const f = await nativeOwner(context, { exec() {
    entered();
    return { async *output() { await gate; yield { stream: 'stdout' as const, data: Buffer.from('old') }; },
      result: Promise.resolve({ exitCode: 0 }) };
  } }, { editSourceMaxBytes: 8192 });
  t.after(() => f.close());
  const directory = join(f.root, 'profile');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'sessions'), { mode: 0o700 });
  const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('offline-fixture', { api: 'openai-completions', baseUrl: 'https://offline.invalid',
    models: [{ id: 'builder', name: 'Builder', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
  await runtime.setRuntimeApiKey('offline-fixture', 'synthetic-key');
  const model = runtime.getModel('offline-fixture', 'builder');
  assert.ok(model);
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Offline scheduling probe.', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
  };
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
    assert.ok(++requests <= 2);
    const delta = requests === 1 ? { role: 'assistant', tool_calls: [
      { index: 0, id: 'edit-first', type: 'function', function: { name: 'edit',
        arguments: JSON.stringify({ path: 'source', edits: [{ oldText: 'missing', newText: 'new' }] }) } },
      { index: 1, id: 'write-second', type: 'function', function: { name: 'write',
        arguments: JSON.stringify({ path: 'different', content: 'new' }) } },
    ] } : { role: 'assistant', content: 'Done.' };
    const chunk = { id: 'response-' + requests, object: 'chat.completion.chunk', created: 1, model: 'builder',
      choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const projection = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  let secondRpc = 0;
  let secondResult: unknown;
  let secondSettled!: () => void;
  const writeSettled = new Promise<void>(resolve => { secondSettled = resolve; });
  const sandbox: ToolProjection = { async executeTool(ctx, call, onData, signal) {
    if (call.name === 'write') {
      secondRpc++;
      // Ensure the real owner is pending, rather than relying on socket ordering.
      await pendingCapture;
      const result = await projection.executeTool(ctx, call, onData, signal);
      secondResult = result;
      secondSettled();
      return result;
    }
    return projection.executeTool(ctx, call, onData, signal);
  } };
  const manager = SessionManager.create('/workspace', join(directory, 'sessions'));
  const { session } = await createAgentSession({ cwd: '/workspace', agentDir: directory, modelRuntime: runtime,
    model, thinkingLevel: 'off', tools: ['edit', 'write'], customTools: [builderEdit(context, sandbox), builderWrite(context, sandbox)],
    resourceLoader, sessionManager: manager, settingsManager: SettingsManager.inMemory({
      retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }) });
  const prompt = session.prompt('Edit source and write different in the same assistant message.');
  const abort = () => { release(); void session.abort(); };
  t.signal.addEventListener('abort', abort, { once: true });
  try {
    await pendingCapture;
    await writeSettled;
    assert.equal(secondRpc, 1, 'Write bypasses the Edit-instance FIFO before capture settles');
    assert.deepEqual(secondResult, { status: 'failure', code: 'TOOL_CALL_IN_PROGRESS' });
  } finally {
    release();
    try { await prompt; } finally {
      t.signal.removeEventListener('abort', abort);
      session.dispose();
    }
  }
  assert.equal(requests, 2);
  const messages = manager.buildSessionContext().messages;
  assert.ok(messages.some(message => message.role === 'toolResult' && message.toolCallId === 'write-second' &&
    message.isError && JSON.stringify(message).includes('TOOL_CALL_IN_PROGRESS')));
  assert.ok(messages.some(message => message.role === 'toolResult' && message.toolCallId === 'edit-first' &&
    message.isError && JSON.stringify(message).includes('Could not find')));
});
