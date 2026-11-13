import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderWrite } from '../../src/workers/write.js';

const context: ToolContext = { workId: 'write-work', executionId: 'write-exec', invocationId: 'write-invocation',
  role: 'builder', environmentRef: 'write-env', bootRef: 'write-boot', phaseId: 'write-phase' };

test('actual native write replaces both callbacks via owner Protocol/Records, with content on stdin only', async t => {
  const calls: string[][] = [];
  const f = await nativeOwner(context, { exec(argv, options) {
    calls.push(argv);
    assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
    assert.deepEqual(options.env, {}); assert.equal(options.cwd, '/');
    assert.equal(argv.includes('synthetic-secret'), false);
    if (argv[5] === 'create') assert.equal(options.stdin, 'synthetic-secret');
    else assert.equal(options.stdin, '');
    return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
  } });
  t.after(() => f.close());
  const native = builderWrite(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const result = await native.execute('new-file', { path: 'nested/new.txt', content: 'synthetic-secret' }, undefined, undefined, { cwd: '/workspace' } as never);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Successfully wrote to nested/new.txt' }]);
  assert.deepEqual(calls.map(argv => argv.slice(5)), [['mkdir', '/workspace/nested'], ['create', '/workspace/nested/new.txt']]);
});

test('reviewer mutation, forged builder, stale phase and admin calls cannot reach VM', async t => {
  const reviewer = { ...context, role: 'standards' as const };
  const f = await nativeOwner(reviewer, { exec() { assert.fail('unauthorized VM effect'); } });
  t.after(() => f.close());
  const sandbox = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  const call = { name: 'write' as const, operation: 'mkdir' as const, path: '/workspace/dir', callId: 'deny' };
  assert.equal((await sandbox.executeTool(reviewer, call)).status, 'failure');
  assert.equal((await sandbox.executeTool(context, call)).status, 'failure');
  assert.equal((await sandbox.executeTool({ ...reviewer, phaseId: 'stale' }, call)).status, 'failure');
  assert.equal((await sandbox.executeTool(reviewer, { ...call, name: 'remove' } as never)).status, 'failure');
});

test('new-file limits and denied host sentinel precede mkdir; cancellation after mkdir never implies no effects', async t => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let calls = 0;
  const cancelled = new AbortController();
  const f = await nativeOwner(context, { exec() {
    calls++; cancelled.abort();
    return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
  } }); t.after(() => f.close());
  const sentinel = join(f.root, 'host-sentinel'); await writeFile(sentinel, 'untouched', { mode: 0o600 });
  const native = builderWrite(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const execute = (path: string, content: string, signal?: AbortSignal) => native.execute('guard', { path, content }, signal, undefined, { cwd: '/workspace' } as never);
  await assert.rejects(execute(sentinel, ''), /WRITE_PATH_DENIED/);
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched'); assert.equal(calls, 0);
  await assert.rejects(execute('large.txt', 'x'.repeat(8193)), /WRITE_PAYLOAD_TOO_LARGE/); assert.equal(calls, 0);
  await assert.rejects(execute('cancelled.txt', '', AbortSignal.abort()), /Operation aborted/); assert.equal(calls, 0);
  await assert.rejects(execute('new.txt', '', cancelled.signal), /Operation aborted/); assert.equal(calls, 1, 'mkdir completed; create not called');
});

test('real protected intent/result persistence failure blocks dependent effects with honest uncertainty', async t => {
  let effects = 0;
  let corruptResult = false;
  const f = await nativeOwner(context, { exec() {
    effects++;
    if (corruptResult) f.records.registerSecret(context.invocationId);
    return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
  } }); t.after(() => f.close());
  let critical = false;
  const native = builderWrite(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical = true; });
  corruptResult = true;
  await assert.rejects(native.execute('persist-fail', { path: 'new.txt', content: 'hello' }, undefined, undefined, { cwd: '/workspace' } as never), /WRITE_EVIDENCE_OR_EFFECTS_UNCERTAIN/);
  assert.equal(effects, 1, 'mkdir may have happened; no create after failed result persistence'); assert.equal(critical, true);
  await assert.rejects(native.execute('no-retry', { path: 'next.txt', content: '' }, undefined, undefined, { cwd: '/workspace' } as never), /STALE_TOOL_CONTEXT|TOOL_CHANNEL_CLOSED/);
  assert.equal(effects, 1);
  const before = await nativeOwner({ ...context, invocationId: 'before-effect' }, { exec() { assert.fail('intent failure before VM'); } });
  t.after(() => before.close()); before.records.registerSecret('before-effect');
  const projection = createSandbox({ root: before.root, toolEndpoint: before.owner.endpoint });
  assert.deepEqual(await projection.executeTool({ ...context, invocationId: 'before-effect' },
    { name: 'write', operation: 'mkdir', path: '/workspace/new', callId: 'intent-fail' }), { status: 'failure', code: 'PROTECTED_WRITE_UNAVAILABLE' });
});
