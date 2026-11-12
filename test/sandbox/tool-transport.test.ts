import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { connect, protocolVersion } from '../../src/protocol/index.js';
import { connectReadTools, serveReadTools, type ToolContext } from '../../src/sandbox/index.js';

const context: ToolContext = { workId: 'work-05', executionId: 'execution-05', invocationId: 'standards-05',
  role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' };

test('host-bound reviewer reads through its existing VM owner and receives only Records-filtered output', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'q5-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const recordsRoot = join(root, 'records');
  await mkdir(recordsRoot, { mode: 0o700 });
  const records = await createRecords({ root: recordsRoot });
  records.registerSecret('synthetic-secret');
  const owner = await serveReadTools({ endpoint: join(root, 'read.sock'), context, current: () => context, records,
    vm: { exec(argv) {
      assert.deepEqual(argv, ['/usr/bin/head', '-c', '16385', '--', '/workspace/README.md']);
      return Promise.resolve({ exitCode: 0, stdoutBuffer: Buffer.from('guest synthetic-secret content') });
    } } });
  t.after(async () => { await owner.close(); await rm(root, { recursive: true, force: true }); });
  const tools = await connectReadTools(owner.endpoint, context);
  t.after(() => tools.close());
  const result = await tools.executeTool({ name: 'read', path: '/workspace/README.md', callId: 'read-1' });
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.equal(result.display, 'guest █ content');
  const evidence = await records.read({ reference: result.reference, offset: 0, limit: 100 });
  assert.equal(evidence.state, 'complete');
  assert.equal(evidence.data.toString(), 'guest █ content');
});

async function fixture(t: { after(fn: () => Promise<void>): void },
  exec: (argv: string[]) => PromiseLike<{ exitCode: number; stdoutBuffer: Buffer }>, binding = context) {
  const root = await mkdtemp(join(tmpdir(), 'q5-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const recordsRoot = join(root, 'records');
  await mkdir(recordsRoot, { mode: 0o700 });
  const records = await createRecords({ root: recordsRoot });
  let current: ToolContext | undefined = { ...binding };
  const owner = await serveReadTools({ endpoint: join(root, 'read.sock'), context: binding, current: () => current,
    records, vm: { exec } });
  t.after(async () => { await owner.close(); });
  const tools = await connectReadTools(owner.endpoint, binding);
  t.after(async () => { tools.close(); });
  return { records, owner, tools, setCurrent(value: ToolContext | undefined) { current = value; } };
}
const read = { name: 'read' as const, path: '/workspace/README.md', callId: 'read-1' };

test('a self-asserted role, boot, invocation, or write operation cannot authorize a tool', { timeout: 5000 }, async t => {
  const f = await fixture(t, () => { assert.fail('unauthorized request reached VM'); });
  const channel = await connect(f.owner.endpoint, 'local-operator');
  t.after(() => channel.close());
  const messages = channel.messages[Symbol.asyncIterator]();
  for (const change of [{ role: 'builder' }, { bootRef: 'old-boot' }, { invocationId: 'other-invocation' },
    { executionId: 'other-execution' }, { phaseId: 'other-phase' }, { workId: 'other-work' }, { environmentRef: 'other-env' }]) {
    await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'read-1', reply_to: null,
      kind: 'execute-tool', payload: { context: { ...context, ...change }, call: read } });
    const response = await messages.next();
    assert.equal(response.value?.payload.status, 'failure');
  }
  assert.deepEqual(await f.tools.executeTool({ ...read, name: 'bash' } as unknown as typeof read),
    { status: 'failure', code: 'INVALID_TOOL_CALL' });
  assert.deepEqual(await f.tools.executeTool({ ...read, path: '/host/secret' }), { status: 'failure', code: 'READ_PATH_DENIED' });
  assert.deepEqual(await f.tools.executeTool({ ...read, path: '/workspace/../etc/shadow' }), { status: 'failure', code: 'READ_PATH_DENIED' });
});

test('host phase/boot invalidation and revocation reject new reads without a VM call', { timeout: 5000 }, async t => {
  const f = await fixture(t, () => { assert.fail('stale invocation reached VM'); });
  for (const current of [{ ...context, phaseId: 'review-2' }, { ...context, bootRef: 'boot-new' }, undefined]) {
    f.setCurrent(current);
    assert.deepEqual(await f.tools.executeTool(read), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  }
});

test('closed projection and lost owner transport fail closed without host fallback', { timeout: 5000 }, async t => {
  const f = await fixture(t, () => { assert.fail('closed transport reached VM'); });
  f.tools.close();
  assert.deepEqual(await f.tools.executeTool(read), { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' });
  const another = await connectReadTools(f.owner.endpoint, context);
  t.after(() => another.close());
  await f.owner.close();
  assert.deepEqual(await another.executeTool(read), { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' });
});

test('phase handoff during a guest read suppresses its late result', { timeout: 5000 }, async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: { exitCode: number; stdoutBuffer: Buffer }) => void;
  const guest = new Promise<{ exitCode: number; stdoutBuffer: Buffer }>(resolve => { release = resolve; });
  const f = await fixture(t, () => { entered(); return guest; });
  const pending = f.tools.executeTool(read);
  await started;
  f.setCurrent({ ...context, phaseId: 'review-2' });
  release({ exitCode: 0, stdoutBuffer: Buffer.from('late guest result') });
  assert.deepEqual(await pending, { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
});

test('capture rejection and guest failure never deliver raw exception/output text', { timeout: 5000 }, async t => {
  let reads = 0;
  const f = await fixture(t, () => { reads++; throw new Error('synthetic-secret'); });
  assert.deepEqual(await f.tools.executeTool(read), { status: 'failure', code: 'PROTECTED_READ_UNAVAILABLE' });
  f.records.registerSecret('standards-05');
  assert.deepEqual(await f.tools.executeTool({ ...read, callId: 'read-2' }), { status: 'failure', code: 'PROTECTED_READ_UNAVAILABLE' });
  assert.equal(reads, 1, 'capture must open successfully before executing in the VM');
});

test('Spec reviewer gets a truncated display with complete protected capture of the bounded guest read', { timeout: 5000 }, async t => {
  const f = await fixture(t, () => Promise.resolve({ exitCode: 0, stdoutBuffer: Buffer.alloc(16385, 120) }),
    { ...context, role: 'spec', invocationId: 'spec-05' });
  const result = await f.tools.executeTool(read);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.equal(result.truncated, true);
  assert.ok(result.display.endsWith('[DISPLAY TRUNCATED; protected output available by reference]'));
  const capture = await f.records.read({ reference: result.reference, offset: 0, limit: 20000 });
  assert.equal(capture.bytes, 16385);
  assert.equal(capture.state, 'complete', 'capture completeness is distinct from source-read truncation');
});

test('guest nonzero status and invalid text are explicit errors, not successful or raw output', { timeout: 5000 }, async t => {
  let invocation = 0;
  const f = await fixture(t, () => Promise.resolve(++invocation === 1
    ? { exitCode: 1, stdoutBuffer: Buffer.from('untrusted error secret') }
    : { exitCode: 0, stdoutBuffer: Buffer.from([255]) }));
  assert.deepEqual(await f.tools.executeTool(read), { status: 'failure', code: 'GUEST_READ_FAILED' });
  assert.deepEqual(await f.tools.executeTool({ ...read, callId: 'read-2' }), { status: 'failure', code: 'PROTECTED_READ_UNAVAILABLE' });
});
