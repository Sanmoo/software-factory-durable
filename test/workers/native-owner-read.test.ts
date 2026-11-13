import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { reviewerRead } from '../../src/workers/read.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '#factory-pi';

const context: ToolContext = { workId: 'work-05', executionId: 'execution-05', invocationId: 'standards-05',
  role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' };

test('Q5 owner capture reaches native SDK pagination, beyond the old 16K wrapper, with split secrets filtered', async t => {
  const text = 'prefix\n'.repeat(5000) + 'synthetic-secret\ntarget\nlast';
  const f = await nativeOwner(context, { exec(argv) {
      assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
      assert.equal(argv.length, 6); assert.equal(argv[5], '/workspace/source.txt');
      return { async *output() { for (let i = 0; i < text.length; i += 11) yield { stream: 'stdout' as const, data: Buffer.from(text.slice(i, i + 11)) }; },
        result: Promise.resolve({ exitCode: 0 }) };
    } });
  t.after(() => f.close());
  const sandbox = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  const native = reviewerRead(context, sandbox);
  const result = await native.execute('read-1', { path: 'source.txt', offset: 5001, limit: 2 });
  assert.match(JSON.stringify(result.content), /█\\ntarget/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|prefix/);
  f.authority.abort();
  await assert.rejects(native.execute('read-2', { path: 'source.txt' }), /STALE_TOOL_CONTEXT|TOOL_CHANNEL_CLOSED/);
});

test('Workers-private SDK component uses real provider loop and native JSONL with preserved file BOM and only filtered guest tool content', { timeout: 10000 }, async t => {
  const f = await nativeOwner(context, { exec() { return {
    async *output() { yield { stream: 'stdout' as const, data: Buffer.from('\uFEFFfirst\nsynthetic-') };
      yield { stream: 'stdout' as const, data: Buffer.from('secret\nthird\n') }; }, result: Promise.resolve({ exitCode: 0 }),
  }; } });
  t.after(() => f.close());
  const directory = join(f.root, 'profile'); await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'sessions'), { mode: 0o700 });
  let requests = 0;
  // External provider HTTP boundary only. Never delegate to real fetch, including
  // unexpected URLs. No SDK/model-loop/Records/tool implementation is doubled.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://offline.invalid/chat/completions');
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-key');
    const body = input instanceof Request ? await input.text() : String(init?.body);
    assert.doesNotMatch(body, /synthetic-secret/);
    assert.doesNotMatch(body, /\"name\":\"(?:bash|write|edit)\"/);
    requests++;
    if (requests === 2) { assert.match(body, /█/); assert.ok(body.includes('\uFEFFfirst')); }
    const choices = requests === 1 ? [
      { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'tool-call-1', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: 'source.txt', offset: 1, limit: 2 }) } }] }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'tool_calls' },
    ] : [
      { index: 0, delta: { role: 'assistant', content: 'Local provider boundary completed.' }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' },
    ];
    assert.ok(requests <= 2, 'no SDK/provider retry or extra model turn');
    const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'response-' + requests, object: 'chat.completion.chunk',
      created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('');
    return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const workers = createWorkerSession({ profile: { id: sdkProfile.id, directory, systemPrompt: 'Read-only Factory fixture. No personal resources.',
    providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key', provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid',
      models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } }, records: f.records,
    sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) });
  const result = await workers.activate({ context, prompt: 'Use read at offset 1, limit 2.', signal: f.authority.signal });
  assert.equal(result.status, 'completed'); assert.equal(requests, 2);
  assert.ok(result.sessionFile);
  const stored = await readFile(result.sessionFile!, 'utf8');
  assert.doesNotMatch(stored, /synthetic-secret|synthetic-key/); assert.match(stored, /█/);
  const reopened = SessionManager.open(result.sessionFile!, join(directory, 'sessions'));
  assert.ok(reopened.buildSessionContext().messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('█') && JSON.stringify(message).includes('\uFEFFfirst')));
  f.records.registerSecret('standards-05');
  await assert.rejects(workers.activate({ context, prompt: 'Must not reach the provider.', signal: f.authority.signal }), /PROTECTED_CAPTURE_UNAVAILABLE/);
  assert.equal(requests, 2, 'critical start-capture failure precedes provider/model activity');
  f.authority.abort();
  await assert.rejects(workers.activate({ context, prompt: 'Must not start.', signal: f.authority.signal }), /STALE_TOOL_CONTEXT/);
  assert.equal(requests, 2);
});

test('a critical owner capture failure aborts the real SDK instead of requesting another provider turn', { timeout: 10000 }, async t => {
  const f = await nativeOwner(context, { exec() { assert.fail('critical capture must fail before guest activity'); } });
  t.after(() => f.close());
  const directory = join(f.root, 'profile'); await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'sessions'), { mode: 0o700 });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
    assert.equal(++requests, 1, 'no new provider turn after critical output failure');
    // Start receipt is already published; failure is at the subsequent real
    // Records capture boundary, not an SDK/owner/session implementation double.
    f.records.registerSecret('standards-05');
    const chunk = { id: 'critical-response', object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'failed-read', type: 'function',
        function: { name: 'read', arguments: '{"path":"source.txt"}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const workers = createWorkerSession({ profile: { id: sdkProfile.id, directory, systemPrompt: 'Read-only Factory fixture.',
    providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key', provider: { api: 'openai-completions',
      baseUrl: 'https://offline.invalid', models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } },
    records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) });
  const result = await workers.activate({ context, prompt: 'Read source.txt.', signal: f.authority.signal });
  assert.equal(result.status, 'interrupted'); assert.equal(requests, 1);
  assert.doesNotMatch(await readFile(result.sessionFile!, 'utf8'), /synthetic-secret|synthetic-key/);
});
