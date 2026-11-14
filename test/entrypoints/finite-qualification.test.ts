import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mock, test } from 'node:test';

// Install BEFORE evaluating recipe/application modules. No TCP, SDK or R access.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:os', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, platform: deny }, defaultExport: deny });
}
let sandboxCalls = 0;
let fileAttempts = 0;
let workerCalls = 0;
let environment = '';
let workerMode: 'reject' | 'success' = 'reject';
let listenAttempts = 0;
let closeRequests = 0;
let freezeDuringEvidence = false;
let receiptProfileOverride: unknown;
let transportServer: EventEmitter;
let serverHandler: (req: unknown, res: unknown) => void;
const activations: { context: { invocationId: string; role: string }; selectedOutputCopies?: string[]; profile: unknown }[] = [];
const copyPath = '/artifacts/factory-output-00000000-0000-4000-8000-000000000001.txt';
mock.module('node:http', { namedExports: { createServer: (_options: unknown, handler: typeof serverHandler) => {
  serverHandler = handler;
  const server = Object.assign(new EventEmitter(), {
    listen(port: number, host: string, done: () => void) { listenAttempts++; assert.equal(port, 18705); assert.equal(host, '127.0.0.1'); done(); },
    close(done: () => void) { done(); },
  });
  transportServer = server;
  return server;
} } });
mock.module('#factory-pi', { namedExports: { SessionManager: { open(path: string) { return { buildSessionContext() { return JSON.parse(files.get(path)!); } }; } } } });
const files = new Map<string, string>();
const dirs = new Set<string>();
const fs = {
  async mkdir(path: string) { fileAttempts++; if (dirs.has(path)) throw new Error('EXISTS'); dirs.add(path); },
  async open(path: string, flags: string) {
    fileAttempts++;
    if (path === '/home/sanmoo/software-factory-test/y5/q05-qualification-v3' && flags === 'r') return { async writeFile() { deny(); }, async sync() {}, async close() {} };
    assert.ok(path.startsWith('/home/sanmoo/software-factory-test/y5/q05-qualification-v3/') || path.endsWith('/workspace/source.txt'));
    assert.equal(flags, 'wx'); if (files.has(path)) throw new Error('EXISTS'); files.set(path, '');
    return { async writeFile(text: string) { files.set(path, text); }, async sync() {}, async close() {} };
  },
  async readFile(path: string | URL) {
    fileAttempts++;
    if (path instanceof URL) { assert.match(path.pathname, /dist\/test\/entrypoints\/finite-qualification(-provider)?\.js$/); return 'closed-source-identity'; }
    assert.ok(!path.includes('credentials'));
    if (freezeDuringEvidence && path.endsWith('/capture.json')) {
      freezeDuringEvidence = false;
      transportServer.emit('clientError', new Error('closed-double'), { destroy() {} });
    }
    if (!files.has(path)) throw Object.assign(new Error('MISSING'), { code: 'ENOENT' }); return files.get(path)!;
  },
  async lstat(path: string) { fileAttempts++; if (!files.has(path)) throw Object.assign(new Error('MISSING'), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => false, size: Buffer.byteLength(files.get(path)!) }; },
  async readdir(path: string, options?: { recursive: boolean }) {
    fileAttempts++;
    const prefix = path + '/';
    const entries = [...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
    return [...new Set(entries.map(key => options?.recursive ? key : key.split('/')[0]!))];
  },
};
mock.module('node:fs/promises', { namedExports: fs });
mock.module('../../src/sandbox/index.js', { namedExports: { createSandbox: () => ({
  async prepare({ workId }: { workId: string }) { sandboxCalls++; environment = 'env-' + createHash('sha256').update(workId).digest('hex'); return { status: 'success', environment }; },
  async start() { sandboxCalls++; return { status: 'success', boot: 'boot-00000000-0000-4000-8000-000000000001' }; },
  async observe() { sandboxCalls++; return { condition: 'active', cessationConfirmed: false }; },
  async stop() { sandboxCalls++; return { status: 'success', cessationConfirmed: true }; },
}) } });
mock.module('../../src/workers/index.js', { namedExports: { createWorkers: (configuration: { profile: { providerId: string; modelId: string; auth?: string } }) => {
  workerCalls++;
  if (workerMode === 'reject') throw new Error('WORKER_DOUBLE');
  return { async activate(invocation: { context: { workId: string; bootRef: string; invocationId: string; role: string }; prompt: string; selectedOutputCopies?: string[] }) {
    activations.push({ ...invocation, profile: configuration.profile });
    const which = invocation.context.invocationId.slice(4);
    const real = which === 'model';
    const results: { role: string; toolName: string; isError: boolean; content: { type: string; text: string }[]; details?: unknown }[] = [];
    const receiptId = `00000000-0000-4000-8000-${String(activations.length).padStart(12, '0')}`;
    const evidence = `/home/sanmoo/software-factory-test/y5/${invocation.context.workId}/evidence`;
    const addEvidence = (id: string, content: string) => {
      files.set(`${evidence}/${id}/capture.json`, JSON.stringify({ context: invocation.context }));
      files.set(`${evidence}/${id}/complete.json`, JSON.stringify({ bytes: Buffer.byteLength(content) }));
      files.set(`${evidence}/${id}/output`, content);
    };
    addEvidence(receiptId, JSON.stringify({ event: { suppliedContext: invocation.context, profile: receiptProfileOverride ?? recipe.plan().sdkProfile, providerId: configuration.profile.providerId, modelId: configuration.profile.modelId, observedProcess: { pid: 123 } } }));
    const completed = (async () => {
      if (real) {
        assert.equal(configuration.profile.auth, 'factory-oauth');
        assert.equal(configuration.profile.providerId, 'openai'); assert.equal(configuration.profile.modelId, 'gpt-6-luna');
        results.push({ role: 'toolResult', toolName: 'read', isError: false, content: [{ type: 'text', text: 'Qualification synthetic source only.\n' }] });
      } else {
        const messages: unknown[] = [{ role: 'user', content: which === 'w1' ? [{ type: 'text', text: invocation.prompt }] : invocation.prompt }];
        const socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1' });
        const n = which === 'w1' ? 9 : 2;
        for (let i = 0; i < n; i++) {
          const res = new Response();
          const finished = new Promise<void>(resolve => res.once('finish', resolve));
          serverHandler(request(JSON.stringify({ model: 'qual-model', stream: true, messages }), { socket }), res);
          await finished;
          assert.equal(res.statusCode, 200);
          const event = JSON.parse(res.body.split('\n')[0]!.slice(6));
          const tool = event.choices[0].delta.tool_calls?.[0];
          if (!tool) continue;
          const denied = which === 'w2' || which === 'w3' || (which === 'w1' && i === 2);
          const text = denied ? 'READ_PATH_DENIED' : which === 'w1' && i === 0 ? 'Successfully wrote to /workspace/q05-new.txt' : which === 'w1' && i === 1 ? 'Successfully replaced 1 block(s) in /workspace/q05-new.txt.' : which === 'w1' && i === 3 ? '█\n' : which === 'w1' && i === 4 ? `Full output: ${copyPath}` : i === 6 ? 'Q05-END\n' : i === 7 ? '0123456789abcdef\n0123456789abcdef\n' : 'Q05-BEGIN\n';
          messages.push({ role: 'tool', tool_call_id: tool.id, content: text });
          results.push({ role: 'toolResult', toolName: tool.function.name, isError: denied, content: [{ type: 'text', text }], ...(i === 4 ? { details: { fullOutputPath: copyPath, truncation: { truncated: true } } } : which === 'w1' && i === 1 ? { details: { diff: '-1 alpha\n+1 beta', firstChangedLine: 1 } } : {}) });
        }
      }
      const tag = Buffer.from(invocation.context.bootRef.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
      files.set(`/home/sanmoo/software-factory-test/y5/r/${tag}/w-${which}/profile/sessions/session.jsonl`, JSON.stringify({ prompt: invocation.prompt, messages: real ? [...results, ...Array.from({ length: 2 }, () => ({ role: 'assistant', provider: 'openai', model: 'gpt-6-luna', api: 'openai-responses', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } }))] : results }));
      if (which === 'w1') {
        const large = 'Q05-BEGIN\n' + '0123456789abcdef\n'.repeat(65536) + 'Q05-END\n';
        addEvidence('20000000-0000-4000-8000-000000000001', JSON.stringify({ event: { kind: 'mutation-result', operation: 'copy-output', status: 'guest-receipt-observed', path: copyPath, bytes: Buffer.byteLength(large), sha256: createHash('sha256').update(large).digest('hex') } }));
      }
      for (let i = 0; i < (which === 'w1' ? 4 : which === 'w4' ? 1 : 0); i++) {
        addEvidence(`10000000-0000-4000-8000-${String(activations.length * 10 + i).padStart(12, '0')}`, 'Q05-BEGIN\n' + '0123456789abcdef\n'.repeat(65536) + 'Q05-END\n');
      }
      return { status: 'success', receipt: { workId: invocation.context.workId, id: receiptId } };
    })();
    return { started: Promise.resolve({ receipt: { workId: invocation.context.workId, id: receiptId } }), completed, close() { closeRequests++; } };
  } };
} } });
const recipe = await import('./finite-qualification.js');
const provider = await import('./finite-qualification-provider.js');

test('plan and import are inert; no actual R, auth, assets, capacity, SDK, manager or network', () => {
  assert.equal(recipe.plan().root, '/home/sanmoo/software-factory-test/y5');
  assert.equal(files.size, 0); assert.equal(dirs.size, 0); assert.equal(fileAttempts, 0);
  assert.equal(sandboxCalls + workerCalls + forbidden, 0);
  assert.equal(recipe.plan().nativeCalls, 11);
  assert.equal(recipe.plan().providerPosts, 15);
  assert.ok(recipe.plan().httpFit.total <= recipe.plan().httpFit.limit);
  assert.ok(recipe.plan().bounds.retainedEnvelopeMiB < 80 * 1024);
});

test('CLI plan remains inert and rejects arbitrary root/config/commands', async () => {
  const before = fileAttempts;
  const output = mock.method(console, 'log', () => {});
  try { await recipe.main(['--plan']); assert.equal(output.mock.calls.length, 1); }
  finally { output.mock.restore(); }
  await assert.rejects(recipe.main(['prepare', '--root=/tmp/other']));
  await assert.rejects(recipe.runPhase('other' as never));
  assert.equal(fileAttempts, before); assert.equal(forbidden, 0);
});

test('closed public lifecycle: exclusive prepare/start, replay denied, exact new boot stop only', async () => {
  await recipe.runPhase('prepare');
  await assert.rejects(recipe.runPhase('prepare'));
  assert.equal(sandboxCalls, 1);
  await recipe.runPhase('start');
  await assert.rejects(recipe.runPhase('start'));
  assert.equal(sandboxCalls, 2);
  await recipe.runPhase('stop');
  assert.equal(sandboxCalls, 4); // current boot observation + exact stop
  await assert.rejects(recipe.runPhase('stop'));
  await assert.rejects(recipe.runPhase('w1'));
  assert.equal(workerCalls, 0);
  assert.equal(forbidden, 0);
});

test('all runnable phases through preinstalled public/transport doubles; fixed roles/selection, native counts and once-only lifetimes', async () => {
  files.clear(); dirs.clear(); workerMode = 'success';
  for (const phase of ['prepare', 'start', 'w1', 'w2', 'w3', 'w4', 'model', 'stop'] as const) await recipe.runPhase(phase);
  assert.equal(listenAttempts, 4); assert.equal(closeRequests, 5);
  assert.deepEqual(activations.map(a => a.context.role), ['builder', 'builder', 'standards', 'standards', 'standards']);
  assert.deepEqual(activations.map(a => a.selectedOutputCopies), [undefined, undefined, undefined, [copyPath], undefined]);
  assert.equal(forbidden, 0);
  const before = workerCalls;
  for (const phase of ['w1', 'w2', 'w3', 'w4', 'model'] as const) await assert.rejects(recipe.runPhase(phase));
  assert.equal(workerCalls, before);
  const result = JSON.parse(files.get('/home/sanmoo/software-factory-test/y5/q05-qualification-v3/w1-result.json')!);
  assert.equal(result.observation.nativeResults, 8); assert.equal(result.observation.wholeCaptures, 4);
  assert.equal(result.observation.physicalCessation, 'unknown');
});

test('late transport freeze during evidence checks cannot publish a successful phase', async () => {
  files.clear(); dirs.clear(); workerMode = 'success';
  await recipe.runPhase('prepare'); await recipe.runPhase('start');
  freezeDuringEvidence = true;
  await assert.rejects(recipe.runPhase('w1'), /QUALIFICATION_HELD/);
  assert.equal(freezeDuringEvidence, false);
  assert.ok(!files.has('/home/sanmoo/software-factory-test/y5/q05-qualification-v3/w1-result.json'));
  await assert.rejects(recipe.runPhase('w2'));
  assert.equal(forbidden, 0);
});

test('failed worker intent is consumed and blocks dependent phases with no fallback', async () => {
  files.clear(); dirs.clear(); workerMode = 'reject';
  await recipe.runPhase('prepare'); await recipe.runPhase('start');
  const before = workerCalls;
  await assert.rejects(recipe.runPhase('w1'), /QUALIFICATION_HELD/);
  await assert.rejects(recipe.runPhase('w1'));
  await assert.rejects(recipe.runPhase('w2'));
  assert.equal(workerCalls, before + 1);
  assert.ok(files.has('/home/sanmoo/software-factory-test/y5/q05-qualification-v3/w1-held.json'));
  assert.equal(forbidden, 0);
});

test('mismatched boot/source identity fails before stop or worker action; consumed failures never retry', async () => {
  files.clear(); dirs.clear();
  await recipe.runPhase('prepare'); await recipe.runPhase('start');
  const name = '/home/sanmoo/software-factory-test/y5/q05-qualification-v3/start-result.json';
  const result = JSON.parse(files.get(name)!); result.identity.source = 'wrong'; files.set(name, JSON.stringify(result));
  const before = sandboxCalls;
  await assert.rejects(recipe.runPhase('stop'), /QUALIFICATION_HELD/);
  await assert.rejects(recipe.runPhase('stop'));
  assert.equal(sandboxCalls, before); assert.equal(forbidden, 0);
});

class Response extends EventEmitter {
  statusCode = 200; body = ''; headers: unknown;
  writeHead(status: number, headers: unknown) { this.statusCode = status; this.headers = headers; return this; }
  end(text = '') { this.body += text; this.emit('finish'); return this; }
}
function request(body: string, overrides: Record<string, unknown> = {}) {
  const req = Readable.from([Buffer.from(body)]) as Readable & { method: string; url: string; headers: Record<string, string>; rawHeaders: string[]; socket: EventEmitter & { remoteAddress: string } };
  Object.assign(req, { method: 'POST', url: '/q05-qual-v1/chat/completions', headers: {
    host: '127.0.0.1:18705', authorization: 'Bearer q05-dummy-key-v1', 'content-type': 'application/json',
  }, rawHeaders: [], socket: Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1' }) }, overrides);
  return req;
}
test('provider counts attempts before rejection, freezes forever, never logs body/auth', async () => {
  const fixture = provider.createFixture('w2', '/artifacts/factory-output-00000000-0000-4000-8000-000000000001.txt');
  const res = new Response();
  await fixture.handle(request('{}', { method: 'GET' }) as never, res as never);
  assert.equal(fixture.observation().attempts, 1); assert.equal(fixture.observation().held, true);
  await fixture.handle(request('{}') as never, new Response() as never);
  assert.equal(fixture.observation().attempts, 2);
  assert.equal(fixture.observation().accepted, 0);
  assert.doesNotMatch(JSON.stringify(fixture.observation()), /Bearer|dummy|\{\}/);
});
test('provider fixed slot, result validation, terminal cap; fake streams, no TCP', async () => {
  const path = '/artifacts/factory-output-00000000-0000-4000-8000-000000000001.txt';
  const fixture = provider.createFixture('w2', path);
  const messages: unknown[] = [{ role: 'user', content: 'q05-w2' }];
  const first = new Response();
  const socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1' });
  await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages }), { socket }) as never, first as never);
  assert.match(first.body, /tool_calls/); assert.match(first.body, /q05-w2-0/);
  assert.ok(Buffer.byteLength(first.body) <= 65536);
  messages.push({ role: 'tool', tool_call_id: 'q05-w2-0', content: 'READ_PATH_DENIED' });
  const last = new Response();
  await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages }), { socket }) as never, last as never);
  assert.match(last.body, /Complete/);
  assert.deepEqual(fixture.observation(), { attempts: 2, accepted: 2, emitted: 1, results: 1, held: false, path });
  await fixture.handle(request('{}') as never, new Response() as never);
  assert.equal(fixture.observation().attempts, 3); assert.equal(fixture.observation().held, true);
});
test('static payload and finite HTTP fit: native1MiB continuation fits unchanged2MiB cap', () => {
  const text = 'Q05-BEGIN\n' + '0123456789abcdef\n'.repeat(65536) + 'Q05-END\n';
  assert.equal(Buffer.byteLength(text), 1114130);
  assert.equal(text.split('\n').length - 1, 65538);
  assert.equal(5 * Buffer.byteLength(text), 5570650);
  assert.ok(recipe.plan().httpFit.total < provider.bodyLimit);
  assert.equal(provider.schedule('w1').filter(call => call.name === 'bash').length, 2);
});

test('two valid sequential POSTs may use different owned sockets without a retry', async () => {
  const fixture = provider.createFixture('w2', copyPath);
  const messages: unknown[] = [{ role: 'user', content: 'q05-w2' }];
  await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages })) as never, new Response() as never);
  messages.push({ role: 'tool', tool_call_id: 'q05-w2-0', content: 'READ_PATH_DENIED' });
  await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages })) as never, new Response() as never);
  assert.equal(fixture.observation().attempts, 2); assert.equal(fixture.observation().accepted, 2); assert.equal(fixture.observation().held, false);
});

test('native exact text-block prompt is accepted, images and extra text are refused', async () => {
  for (const content of [ 'q05-w2', [{ type: 'text', text: 'q05-w2' }] ]) {
    const fixture = provider.createFixture('w2', copyPath);
    await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages: [{ role: 'user', content }] })) as never, new Response() as never);
    assert.equal(fixture.observation().attempts, 1); assert.equal(fixture.observation().accepted, 1); assert.equal(fixture.observation().held, false);
  }
  for (const content of [ [{ type: 'text', text: 'q05-w2 extra' }], [{ type: 'image_url', image_url: { url: 'closed.invalid' } }],
    [{ type: 'text', text: 'q05-w2' }, { type: 'text', text: 'extra' }], [{ type: 'text', text: 'q05-w2', extra: true }] ]) {
    const fixture = provider.createFixture('w2', copyPath);
    await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages: [{ role: 'user', content }] })) as never, new Response() as never);
    assert.equal(fixture.observation().attempts, 1); assert.equal(fixture.observation().accepted, 0); assert.equal(fixture.observation().held, true);
  }
});

test('string or drifted profile receipts are rejected instead of accepting only the ID', async () => {
  for (const profile of [recipe.plan().sdkProfile.id, { ...recipe.plan().sdkProfile, version: 'wrong' },
    { ...recipe.plan().sdkProfile, resultSHA256: '0'.repeat(64) }]) {
    files.clear(); dirs.clear(); workerMode = 'success'; freezeDuringEvidence = false; receiptProfileOverride = profile;
    try {
      await recipe.runPhase('prepare'); await recipe.runPhase('start');
      await assert.rejects(recipe.runPhase('w1'), /QUALIFICATION_HELD/);
      assert.ok(!files.has('/home/sanmoo/software-factory-test/y5/q05-qualification-v3/w1-result.json'));
    } finally { receiptProfileOverride = undefined; }
  }
  assert.equal(forbidden, 0);
});

test('owned connection acquisitions and simultaneous sockets remain bounded by the phase POST ceiling', async () => {
  const fixture = await provider.startProvider('w2', copyPath);
  const socket = () => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, { remoteAddress: '127.0.0.1', destroyed: false,
      destroy() { this.destroyed = true; emitter.emit('close'); } });
  };
  const first = socket(), second = socket(), extra = socket();
  transportServer.emit('connection', first); transportServer.emit('connection', second);
  assert.equal(fixture.observation().connections, 2); assert.equal(fixture.observation().held, false);
  transportServer.emit('connection', extra);
  assert.equal(fixture.observation().connections, 3); assert.equal(fixture.observation().held, true);
  assert.equal(fixture.observation().rejectedTransport, 1);
  assert.equal(first.destroyed && second.destroyed && extra.destroyed, true);
  await fixture.close(); assert.equal(forbidden, 0);
});

test('concurrent request freezes original too; no late result/response advancement', async () => {
  const fixture = provider.createFixture('w1');
  // Only HTTP metadata copied; the stream remains a fake owned Readable.
  const template = request('{}');
  const incoming = new Readable({ read() {} });
  Object.assign(incoming, { method: template.method, url: template.url, headers: template.headers, rawHeaders: [], socket: template.socket });
  const first = new Response();
  const pending = fixture.handle(incoming as never, first as never);
  await fixture.handle(request('{}') as never, new Response() as never);
  incoming.push(Buffer.from(JSON.stringify({ model: 'qual-model', stream: true, messages: [{ role: 'user', content: 'q05-w1' }] }))); incoming.push(null);
  await pending;
  assert.equal(fixture.observation().attempts, 2); assert.equal(fixture.observation().accepted, 0); assert.equal(first.statusCode, 400);
});

test('wrong previous tool identity and unexpected result never advance', async () => {
  for (const id of ['wrong', 'q05-w2-0']) {
    const fixture = provider.createFixture('w2', copyPath);
    const socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1' });
    const messages: unknown[] = [{ role: 'user', content: 'q05-w2' }];
    await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages }), { socket }) as never, new Response() as never);
    messages.push({ role: 'tool', tool_call_id: id, content: 'unexpected success' });
    await fixture.handle(request(JSON.stringify({ model: 'qual-model', stream: true, messages }), { socket }) as never, new Response() as never);
    assert.equal(fixture.observation().attempts, 2); assert.equal(fixture.observation().accepted, 1); assert.equal(fixture.observation().held, true);
  }
});

test('body, headers, peer and socket ownership limits fail closed before advancing', async () => {
  for (const override of [ { url: '/other' }, { socket: Object.assign(new EventEmitter(), { remoteAddress: '::1' }) },
    { headers: { host: 'evil' } }, { headers: { host: '127.0.0.1:18705', authorization: 'Bearer q05-dummy-key-v1', 'content-type': 'application/json', evil: 'x' } } ]) {
    const fixture = provider.createFixture('w1');
    await fixture.handle(request('{}', override) as never, new Response() as never);
    assert.equal(fixture.observation().attempts, 1); assert.equal(fixture.observation().held, true);
  }
  const fixture = provider.createFixture('w1');
  await fixture.handle(request('x'.repeat(2 * 1024 * 1024 + 1)) as never, new Response() as never);
  assert.equal(fixture.observation().accepted, 0); assert.equal(fixture.observation().held, true);
});
