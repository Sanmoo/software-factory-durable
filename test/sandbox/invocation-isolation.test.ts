import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { connectReadTools, serveReadTools, serveReadToolBindings, type GuestOwner } from '../../src/sandbox/read-tools.js';

// Existing Q5 projection and external GuestOwner boundary; no VM/model execution.
test('one boot owns independent reviewer bindings: abort/EOF isolate pending reads and deny forged contexts', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bindings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recordsRoot = join(root, 'records'); await mkdir(recordsRoot, { mode: 0o700 });
  const records = await createRecords({ root: recordsRoot });
  const standards: ToolContext = { workId: 'work-05', executionId: 'execution-05', invocationId: 'standards-05',
    role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' };
  const spec: ToolContext = { ...standards, invocationId: 'spec-05', role: 'spec' };
  const read = { name: 'read' as const, operation: 'capture' as const, path: '/workspace/spec.txt', callId: 'read-1' };
  // Exercise both ways an invocation ends without confusing either with boot stop.
  for (const ending of ['abort', 'EOF'] as const) {
    const authority = new AbortController();
    const specAuthority = new AbortController();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let aborted!: () => void; const revoked = new Promise<void>(resolve => { aborted = resolve; });
    let bootStops = 0;
    let reads = 0;
    const vm: GuestOwner & { close(): void } = { close() { bootStops++; }, exec(argv, options) {
      reads++;
      if (argv[5] === '/workspace/pending.txt') return { async *output() {
        entered();
        await new Promise<void>(resolve => {
          options.signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true });
        });
        yield { stream: 'stdout', data: Buffer.from('revoked output') };
      }, result: Promise.resolve({ exitCode: 0 }) };
      assert.equal(argv[5], '/workspace/spec.txt');
      return { async *output() { yield { stream: 'stdout', data: Buffer.from('same boot spec') }; },
        result: Promise.resolve({ exitCode: 0 }) };
    } };
    const standardEndpoint = join(root, ending + '-standards.sock');
    const specEndpoint = join(root, ending + '-spec.sock');
    const owner = await serveReadToolBindings([
      { endpoint: standardEndpoint, context: standards, signal: authority.signal, records },
      { endpoint: specEndpoint, context: spec, signal: specAuthority.signal, records },
    ], vm);
    t.after(() => owner.close());
    const tools = await connectReadTools(standardEndpoint, standards);
    t.after(async () => { tools.close(); });
    const pending = tools.executeTool({ ...read, path: '/workspace/pending.txt' }); await started;
    if (ending === 'abort') authority.abort(); else tools.close();
    await revoked;
    assert.equal((await pending).status, 'failure');
    const stale = createSandbox({ root, toolEndpoint: standardEndpoint });
    assert.equal((await stale.executeTool(standards, read)).status, 'failure');
    const projection = createSandbox({ root, toolEndpoint: specEndpoint });
    assert.deepEqual(await projection.executeTool({ ...spec, invocationId: 'forged' }, read),
      { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
    const sandbox = createSandbox({ root, toolEndpoint: specEndpoint });
    const capture = await sandbox.executeTool(spec, read);
    assert.equal(capture.status, 'success');
    if (capture.status === 'success') {
      const page = await sandbox.executeTool(spec, { name: 'read', operation: 'page', reference: capture.reference, offset: 0, callId: 'page-1' });
      assert.equal(page.status, 'success');
      if (page.status === 'success') assert.equal(Buffer.from(page.data, 'base64').toString(), 'same boot spec');
    }
    assert.equal(reads, 2, 'revoked and forged calls never reach the existing VM');
    assert.equal(bootStops, 0, 'invocation loss never closes the boot VM');
    await owner.close(); await owner.close();
    assert.equal((await sandbox.executeTool(spec, read)).status, 'failure', 'all-close revokes the remaining reviewer');
    assert.equal(bootStops, 0, 'binding cleanup does not own VM shutdown');
  }
});

test('binding closes an already-aborted or setup-aborted listener', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'binding-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const context: ToolContext = { workId: 'work-05', executionId: 'execution-05', invocationId: 'race-05',
    role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' };
  const vm: GuestOwner = { exec() { assert.fail('revoked binding reached guest'); } };
  for (const mode of ['already', 'listen', 'add'] as const) {
    const authority = new AbortController();
    const endpoint = join(root, mode + '.sock');
    if (mode === 'already') authority.abort();
    const binding = { endpoint, context, signal: authority.signal, records };
    const collection = await serveReadToolBindings([], vm);
    t.after(() => collection.close());
    const pending = mode === 'add' ? collection.add(binding) : serveReadTools({ ...binding, vm });
    authority.abort(); // while listen's private-directory/listen/chmod awaits are outstanding
    if (mode === 'add') await assert.rejects(pending, /STALE_TOOL_CONTEXT/);
    const owner = mode === 'add' ? undefined : await pending;
    if (owner) t.after(() => owner.close());
    // Test the actual Unix listener, not a tool-level authorization error.
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = createConnection(endpoint);
      socket.once('error', reject);
      socket.once('connect', () => { socket.destroy(); resolve(); });
    }), { code: 'ENOENT' });
    if (owner) { await owner.close(); await owner.close(); }
  }
});

test('binding close drains its actual pending callback after abort without closing a guest', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'binding-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const context: ToolContext = { workId: 'work-05', executionId: 'execution-05', invocationId: 'drain-05',
    role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' };
  const authority = new AbortController();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  let revoked!: () => void; const aborted = new Promise<void>(resolve => { revoked = resolve; });
  const owner = await serveReadTools({ endpoint: join(root, 'read.sock'), context, signal: authority.signal, records,
    vm: { exec(_argv, options) { return { async *output() {
      options.signal.addEventListener('abort', revoked, { once: true });
      entered(); await released; yield { stream: 'stdout', data: Buffer.from('late') };
    }, result: Promise.resolve({ exitCode: 0 }) }; } } });
  t.after(async () => { release(); await owner.close(); });
  const tools = await connectReadTools(owner.endpoint, context);
  const pending = tools.executeTool({ name: 'read', operation: 'capture', path: '/workspace/pending', callId: 'pending' });
  await started; authority.abort(); await aborted;
  const closing = owner.close(); assert.equal(owner.close(), closing);
  let drained = false; void closing.then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(drained, false, 'transport shutdown alone is not callback drain');
  release(); await closing;
  assert.equal((await pending).status, 'failure');
});
