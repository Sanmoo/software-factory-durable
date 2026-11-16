import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '#factory-pi';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { workerLaunchSchema } from '../../src/platform/host/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { reviewerRead } from '../../src/workers/read.js';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';

const context: ToolContext = { workId: 'image-work', executionId: 'image-exec', invocationId: 'image-invocation',
  role: 'standards', environmentRef: 'image-env', bootRef: 'image-boot', phaseId: 'image-phase' };
import { png, jpeg, gif, webp, withMetadata, widePng } from './fixtures/images.js';
import { remainingMs } from '../runner/budget.js';

test('explicit host image budget delivers real native PNG image block from completed protected capture', async t => {
  const f = await nativeOwner(context, { exec() { return { async *output() {
    for (let i = 0; i < png.length; i += 7) yield { stream: 'stdout' as const, data: png.subarray(i, i + 7) };
  }, result: Promise.resolve({ exitCode: 0 }) }; } }, { imageSourceMaxBytes: png.length });
  t.after(() => f.close());
  const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const result = await native.execute('image-read', { path: 'renamed.txt' });
  assert.ok(result.content.some(block => block.type === 'image' && block.mimeType === 'image/png'));
});

for (const [name, source, mime] of [['PNG', png, 'image/png'], ['JPEG', jpeg, 'image/jpeg'], ['GIF', gif, 'image/gif'], ['WebP', webp, 'image/webp']] as const) {
  const large = withMetadata(source, Buffer.from('clean-metadata-'.repeat(3700)));
  for (const delta of [-1, 0, 1]) test(`${name} >50000 native image uses explicit TEST source budget ${delta >= 0 ? '+' : ''}${delta}`, async t => {
    assert.ok(large.length > 50000);
    let executions = 0;
    const f = await nativeOwner(context, { exec() {
      executions++;
      return { async *output() {
        for (let offset = 0; offset < large.length; offset += 8191) yield { stream: 'stdout' as const, data: large.subarray(offset, offset + 8191) };
      }, result: Promise.resolve({ exitCode: 0 }) };
    } }, { imageSourceMaxBytes: large.length + delta });
    t.after(() => f.close());
    let critical = false;
    const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical = true; });
    if (delta < 0) {
      await assert.rejects(native.execute('image-limit', { path: 'extension-is-not-an-image.txt' }), /PROTECTED_READ_UNAVAILABLE/);
      assert.equal(critical, true);
    } else {
      const result = await native.execute('image-limit', { path: 'extension-is-not-an-image.txt', offset: 999, limit: 1 });
      const block = result.content.find(block => block.type === 'image');
      assert.ok(block && block.type === 'image');
      assert.equal(block.mimeType, mime); assert.deepEqual(Buffer.from(block.data, 'base64'), large);
      assert.equal(critical, false);
    }
    assert.equal(executions, 1, 'access/detector/full-buffer all use the same capture, never path recapture');
  });

  test(`${name} raw transport is completed-only, explicit, invocation-bound, bounded and byte exact`, async t => {
    const f = await nativeOwner(context, { exec() { return { async *output() { yield { stream: 'stdout' as const, data: large }; },
      result: Promise.resolve({ exitCode: 0 }) }; } }, { imageSourceMaxBytes: large.length });
    t.after(() => f.close());
    const sandbox = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
    const capture = await sandbox.executeTool(context, { name: 'read', operation: 'capture', path: '/workspace/renamed.txt', callId: 'capture-image' });
    assert.ok(capture.status === 'success' && capture.format === 'raw');
    assert.equal(capture.imageSourceMaxBytes, large.length); assert.equal(capture.data, ''); assert.equal(capture.bytes, large.length);
    const read = { name: 'read' as const, operation: 'page' as const, reference: capture.reference, offset: 0, callId: 'image-page' };
    assert.deepEqual(await sandbox.executeTool(context, read), { status: 'failure', code: 'READ_REFERENCE_DENIED' });
    await assert.rejects(f.records.read({ reference: capture.reference, offset: 0, limit: 65536 }), /PROTECTED_CAPTURE_UNAVAILABLE/);
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < capture.bytes) {
      const page = await sandbox.executeTool(context, { ...read, format: 'raw', offset });
      assert.ok(page.status === 'success' && page.format === 'raw');
      assert.equal(page.encoding, 'base64'); assert.ok(page.data.length <= 32768);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
      const data = Buffer.from(page.data, 'base64'); chunks.push(data);
      assert.equal(page.nextOffset, offset + data.length); assert.ok(page.nextOffset <= capture.bytes); offset = page.nextOffset;
    }
    assert.deepEqual(Buffer.concat(chunks), large);
    const eof = await sandbox.executeTool(context, { ...read, format: 'raw', offset });
    assert.ok(eof.status === 'success'); assert.equal(eof.data, ''); assert.equal(eof.nextOffset, large.length);
    assert.equal((await sandbox.executeTool(context, { ...read, format: 'raw', offset: large.length + 1 })).status, 'failure');
    assert.equal((await sandbox.executeTool(context, { ...read, format: 'raw', offset: Number.MAX_SAFE_INTEGER + 1 })).status, 'failure');
    assert.equal((await sandbox.executeTool(context, { ...read, format: 'raw', imageSourceMaxBytes: large.length * 2 } as never)).status, 'failure');
    assert.equal((await sandbox.executeTool({ ...context, invocationId: 'other-invocation' }, { ...read, format: 'raw' })).status, 'failure');
    f.authority.abort();
    assert.equal((await sandbox.executeTool(context, { ...read, format: 'raw' })).status, 'failure');
  });

  test(`${name} remains denied without a host budget; model arguments cannot enable it`, async t => {
    const f = await nativeOwner(context, { exec() { return { async *output() { yield { stream: 'stdout' as const, data: source }; },
      result: Promise.resolve({ exitCode: 0 }) }; } }); t.after(() => f.close());
    const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
    await assert.rejects(native.execute('no-budget', { path: 'renamed.txt', imageSourceMaxBytes: 1000000 } as never), /READ_BINARY_UNSUPPORTED/);
  });
}

test('native image decode omission and native classifier rejection are failures, never raw text fallback', async t => {
  for (const bad of [png.subarray(0, 35), gif.subarray(0, 16), webp.subarray(0, 16), Buffer.from([255, 216, 255, 247, 0, 0, 0, 0, 0, 0, 0, 0])]) {
    const f = await nativeOwner(context, { exec() { return { async *output() { yield { stream: 'stdout' as const, data: bad }; },
      result: Promise.resolve({ exitCode: 0 }) }; } }, { imageSourceMaxBytes: 1000 }); t.after(() => f.close());
    let critical = false;
    const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical = true; });
    await assert.rejects(native.execute('bad-image', { path: 'bad.txt' }), /READ_IMAGE_UNAVAILABLE/);
    assert.equal(critical, true);
  }
});

for (const [name, source] of [['PNG', png], ['JPEG', jpeg], ['GIF', gif], ['WebP', webp]] as const) {
  test(`${name} split literal non-ASCII and ASCII metadata fail before source publish, SDK or transport`, async () => {
    for (const secret of ['synthetic-secret', 'segredo-🔒-ação']) {
      const bytes = Buffer.from(secret);
      const infected = withMetadata(source, Buffer.concat([Buffer.from('safe-prefix-'), bytes, Buffer.from('-suffix')]));
      const start = infected.indexOf(bytes); assert.ok(start > 12);
      for (let split = 1; split < bytes.length; split++) {
        const cut = start + split;
        const f = await nativeOwner(context, { exec() { return { async *output() {
          yield { stream: 'stdout' as const, data: infected.subarray(0, cut) };
          yield { stream: 'stdout' as const, data: infected.subarray(cut) };
        }, result: Promise.resolve({ exitCode: 0 }) }; } }, { imageSourceMaxBytes: infected.length });
        // Await each fixture close in-loop to keep resource usage bounded.
        try {
          f.records.registerSecret(secret);
          let critical = false;
          const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical = true; });
          await assert.rejects(native.execute('secret-image', { path: 'renamed.txt' }), /PROTECTED_READ_UNAVAILABLE/);
          assert.equal(critical, true);
          const files = await controlledFiles(f.root);
          assert.ok(files.length > 0);
          for (const file of files) {
            assert.equal(file.data.includes(bytes), false, 'literal source secret must not reach controlled disk');
            assert.equal(file.path.endsWith('/complete.json'), false, 'failed image has no completed source publication');
          }
        } finally { await f.close(); }
      }
    }
    // The test deliberately never feeds source base64 into a text filter.
  });
}

async function controlledFiles(directory: string): Promise<{ path: string; data: Buffer }[]> {
  const files: { path: string; data: Buffer }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await controlledFiles(path));
    else if (entry.isFile()) files.push({ path, data: await readFile(path) });
  }
  return files;
}

for (const [name, source, mime] of [['PNG', png, 'image/png'], ['JPEG', jpeg, 'image/jpeg'], ['GIF', gif, 'image/gif'], ['WebP', webp, 'image/webp']] as const) {
  for (const contaminated of [false, true]) test(`${name} real native vision session ${contaminated ? 'aborts on literal metadata secret' : 'persists image and reopens it'}`, { timeout: remainingMs() }, async t => {
    const secret = 'segredo-🔒-ação';
    const image = withMetadata(source, Buffer.from(contaminated ? 'prefix-' + secret + '-suffix' : 'clean-local-metadata-'.repeat(2600)));
    const cut = contaminated ? image.indexOf(Buffer.from(secret)) + 10 : 24576;
    let executions = 0;
    const f = await nativeOwner(context, { exec(argv) {
      executions++; assert.equal(argv[5], '/workspace/renamed.txt');
      return { async *output() {
        yield { stream: 'stdout' as const, data: image.subarray(0, cut) };
        yield { stream: 'stdout' as const, data: image.subarray(cut) };
      }, result: Promise.resolve({ exitCode: 0 }) };
    } }, { imageSourceMaxBytes: image.length }); t.after(() => f.close());
    f.records.registerSecret(secret);
    const directory = join(f.root, 'profile'); await mkdir(directory, { mode: 0o700 });
    await mkdir(join(directory, 'sessions'), { mode: 0o700 });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
      const body = input instanceof Request ? await input.text() : String(init?.body);
      assert.doesNotMatch(body, /synthetic-secret|synthetic-key|segredo|ação/);
      requests++;
      assert.ok(requests <= (contaminated ? 1 : 2), 'no next model turn after failed protection');
      if (requests === 2) {
        assert.ok(body.includes(`data:${mime};base64,${image.toString('base64')}`), 'real provider next turn contains native vision image');
      }
      const choices = requests === 1 ? [
        { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'image-call', type: 'function',
          function: { name: 'read', arguments: '{"path":"renamed.txt"}' } }] }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'tool_calls' },
      ] : [
        { index: 0, delta: { role: 'assistant', content: 'Local image review complete.' }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ];
      return new Response(choices.map(choice => 'data: ' + JSON.stringify({ id: 'image-response', object: 'chat.completion.chunk',
        created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const profile = { id: sdkProfile.id, directory, systemPrompt: 'Read-only local image fixture.', providerId: 'offline-fixture',
      modelId: 'reader', apiKey: 'synthetic-key', provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid',
        models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text', 'image'] as ('text' | 'image')[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } };
    const { directory: _directory, ...launchProfile } = profile;
    const launch = { context, profile: launchProfile, prompt: 'Read renamed.txt.', knownSecrets: [secret] };
    for (const invalid of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(workerLaunchSchema.safeParse({ ...launch, imageSourceMaxBytes: invalid }).success, false);
    }
    assert.equal(workerLaunchSchema.parse({ ...launch, imageSourceMaxBytes: image.length }).imageSourceMaxBytes, image.length);
    assert.equal(workerLaunchSchema.parse(launch).imageSourceMaxBytes, undefined);
    const worker = createWorkerSession({ profile, records: f.records,
      sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) });
    const result = await worker.activate({ context, prompt: launch.prompt, signal: f.authority.signal });
    assert.equal(result.status, contaminated ? 'interrupted' : 'completed');
    assert.equal(requests, contaminated ? 1 : 2); assert.equal(executions, 1); assert.ok(result.sessionFile);
    const sessionBytes = await readFile(result.sessionFile!);
    assert.equal(sessionBytes.includes(Buffer.from(secret)), false);
    const reopened = SessionManager.open(result.sessionFile!, join(directory, 'sessions'));
    const images = reopened.buildSessionContext().messages.flatMap(message => message.role === 'toolResult'
      ? message.content.filter(block => block.type === 'image') : []);
    if (contaminated) {
      assert.equal(images.length, 0);
      for (const file of await controlledFiles(f.root)) {
        assert.equal(file.data.includes(Buffer.from(secret)), false);
        assert.equal(file.data.includes(Buffer.from(image.toString('base64'))), false, 'no encoded contaminated source either');
      }
    } else {
      assert.equal(images.length, 1); assert.equal(images[0]!.mimeType, mime);
      assert.deepEqual(Buffer.from(images[0]!.data, 'base64'), image);
    }
  });
}


test('native auto-resize stays enabled and performs real PNG resize', async t => {
  const source = widePng();
  const f = await nativeOwner(context, { exec() { return { async *output() { yield { stream: 'stdout' as const, data: source }; },
    result: Promise.resolve({ exitCode: 0 }) }; } }, { imageSourceMaxBytes: source.length }); t.after(() => f.close());
  const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const result = await native.execute('resize', { path: 'wide.txt' });
  const block = result.content.find(block => block.type === 'image'); assert.ok(block && block.type === 'image');
  assert.notDeepEqual(Buffer.from(block.data, 'base64'), source);
  assert.match(JSON.stringify(result.content), /2101|2000/);
});

test('configured image budget retains file BOM and preserves UTF8/page/redaction and whole-buffer fallback cap', async t => {
  const source = Buffer.from('\uFEFF' + 'x'.repeat(24574) + '🔒ação\nsynthetic-secret\nlast');
  const f = await nativeOwner(context, { exec() { return { async *output() {
    for (let offset = 0; offset < source.length; offset += 7) yield { stream: 'stdout' as const, data: source.subarray(offset, offset + 7) };
  }, result: Promise.resolve({ exitCode: 0 }) }; } }, { imageSourceMaxBytes: 1 }); t.after(() => f.close());
  const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const result = await native.execute('unicode-text', { path: 'source.png' });
  assert.equal(result.content[0]?.type, 'text');
  assert.ok(JSON.stringify(result).includes('🔒ação\\n█\\nlast')); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|�/);
  // File reads opt in; ordinary Records evidence/event capture stays legacy.
  assert.equal(JSON.stringify(result).includes('\uFEFF'), true);
  const big = await nativeOwner({ ...context, invocationId: 'large-text' }, { exec() { return { async *output() {
    yield { stream: 'stdout' as const, data: Buffer.from('x'.repeat(50001)) };
  }, result: Promise.resolve({ exitCode: 0 }) }; } }, { imageSourceMaxBytes: 100000 }); t.after(() => big.close());
  const bigRead = reviewerRead({ ...context, invocationId: 'large-text' }, createSandbox({ root: big.root, toolEndpoint: big.owner.endpoint }));
  await assert.rejects(bigRead.execute('text-fallback', { path: 'big.txt', offset: 1.5 }), /READ_BUFFER_LIMIT/);
});

for (const mode of ['nonzero', 'stream-error', 'rotation', 'revocation'] as const) {
  test(`raw ${mode} never publishes a partial source or falls back to text`, async t => {
    let interrupt = () => {};
    const f = await nativeOwner(context, { exec() { return { async *output() {
      yield { stream: 'stdout' as const, data: png.subarray(0, 40) };
      if (mode === 'stream-error') throw new Error('private guest detail');
      interrupt();
      yield { stream: 'stdout' as const, data: png.subarray(40) };
    }, result: Promise.resolve({ exitCode: mode === 'nonzero' ? 1 : 0 }) }; } }, { imageSourceMaxBytes: png.length });
    t.after(() => f.close());
    interrupt = () => {
      if (mode === 'rotation') f.records.registerSecret('newly-registered');
      if (mode === 'revocation') f.authority.abort();
    };
    let critical = false;
    const native = reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical = true; });
    await assert.rejects(native.execute('failed-raw', { path: 'source.txt' }), /PROTECTED_READ_UNAVAILABLE|STALE_TOOL_CONTEXT|TOOL_CHANNEL_CLOSED/);
    assert.equal(critical, true);
    for (const file of await controlledFiles(f.root)) assert.equal(file.path.endsWith('/complete.json'), false);
  });
}
