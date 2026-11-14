import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

test('write limits and denied host sentinel precede mkdir; cancellation after mkdir never implies no effects', async t => {
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

test('actual native per-path mutation queue holds in-flight overwrite and uses current UUID per callback', async t => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<{ exitCode: number }>(resolve => { release = () => resolve({ exitCode: 0 }); });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const operations: string[] = [];
  const f = await nativeOwner(context, { exec(argv) {
    operations.push(argv[5]!);
    const firstWrite = operations.length === 2;
    if (firstWrite) entered();
    return { async *output() {}, result: firstWrite ? held : Promise.resolve({ exitCode: 0 }) };
  } }); t.after(async () => { release(); await f.close(); });
  const native = builderWrite(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const execute = (id: string, content: string) => native.execute(id, { path: 'same.txt', content }, undefined, undefined, { cwd: '/workspace' } as never);
  const first = execute('first', 'first replacement');
  await started;
  const second = execute('second', 'second replacement');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(operations, ['mkdir', 'create'], 'second mkdir cannot pass in-flight native write');
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => JSON.stringify(result).includes('Successfully wrote to same.txt')));
  assert.deepEqual(operations, ['mkdir', 'create', 'mkdir', 'create']);
  const evidence = join(f.root, 'records', context.workId, 'evidence');
  const captures = await Promise.all((await readdir(evidence)).map(async id => JSON.parse(await readFile(join(evidence, id, 'output'), 'utf8'))));
  const intents = captures.filter(capture => capture.event.kind === 'mutation-intent');
  const ids = intents.map(capture => capture.context.callId);
  assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('Factory adapter fixed lexical mode routes owned EACCES path only to guest callbacks (not owner confinement)', async () => {
  const { mkdtemp, mkdir, chmod, realpath, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createWriteTool } = await import('#factory-pi');
  assert.notEqual(process.getuid?.(), 0, 'permission negative requires non-root');
  const root = await mkdtemp(join(tmpdir(), 'w105-'));
  await chmod(root, 0o700);
  const blocked = join(root, 'blocked');
  const sentinel = join(blocked, 'sentinel');
  const calls: { operation: string; path: string; content?: string }[] = [];
  try {
    await mkdir(blocked, { mode: 0o700 });
    await writeFile(sentinel, 'HOST_UNTOUCHED', { mode: 0o600 });
    await chmod(blocked, 0);
    await assert.rejects(realpath(sentinel), { code: 'EACCES' });
    // Actual native legacy custom operations still probe host; never use default host backend.
    const legacy = createWriteTool(root, { operations: {
      mkdir: async () => { assert.fail('legacy callback before EACCES'); },
      writeFile: async () => { assert.fail('legacy callback before EACCES'); },
    } });
    await assert.rejects(legacy.execute('legacy', { path: sentinel, content: '' }), { code: 'EACCES' });
    // Deliberate ToolProjection double: owned host fixture is NOT a guest-root path.
    const tool = builderWrite(context, { async executeTool(bound, call) {
      assert.equal(bound, context);
      if (call.name !== 'write') assert.fail('write only');
      calls.push(call);
      return { status: 'success', format: 'text', reference: { workId: context.workId, id: 'fixture' }, bytes: 0,
        encoding: 'base64', data: '', nextOffset: 0 };
    } });
    assert.doesNotMatch(JSON.stringify(tool.parameters), /mutationQueueMode/);
    for (const mutationQueueMode of ['host-realpath', 'unknown-model-mode']) {
      calls.length = 0;
      const result = await tool.execute('lexical', { path: sentinel, content: 'GUEST_ONLY', mutationQueueMode },
        undefined, undefined, { cwd: root, mutationQueueMode: 'invalid' } as never);
      assert.deepEqual(calls.map(call => [call.operation, call.path, call.content]), [
        ['mkdir', blocked, undefined], ['create', sentinel, 'GUEST_ONLY'],
      ]);
      assert.deepEqual(result.content, [{ type: 'text', text: `Successfully wrote to ${sentinel}` }]);
    }
  } finally {
    try {
      await chmod(blocked, 0o700);
      assert.equal(await readFile(sentinel, 'utf8'), 'HOST_UNTOUCHED');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('Builder composition has host-fixed lexical Write and independent host-gated Read/Edit', async () => {
  const source = await readFile('src/workers/write.ts', 'utf8');
  assert.match(source, /type LexicalWriteOptions = NonNullable<Parameters<typeof createWriteTool>\[1\]> &/);
  assert.match(source, /const options: LexicalWriteOptions = \{ mutationQueueMode: 'lexical', operations:/);
  assert.match(source, /return createWriteTool\(cwd, options\)/);
  assert.doesNotMatch(source, /\bany\b|process\.env|sdkProfile|input\.mutationQueueMode|ctx\??\.mutationQueueMode|createEditTool/);
  const worker = await readFile('src/workers/worker-session.ts', 'utf8');
  // Exact host policy: an explicit zero-byte budget enables Edit too; neither
  // model args nor context fields can opt in, and reviewers remain read-only.
  // OAuth composition adds a containing try block; indentation is not policy.
  // Preserve the exact complete gate/brace sequence while ignoring line indentation.
  const withoutIndentation = (value: string) => value.replace(/^[ \t]+/gm, '');
  assert.ok(withoutIndentation(worker).includes(withoutIndentation(`  const editEnabled = invocation.context.role === 'builder' && invocation.editSourceMaxBytes !== undefined;
  const customTools: ToolDefinition[] = invocation.context.role === 'builder'
    ? [builderWrite(invocation.context, options.sandbox, critical), builderBash(invocation.context, options.sandbox, critical, copyOutput)]
    : [reviewerRead(invocation.context, options.sandbox, critical)];
  const tools = invocation.context.role === 'builder' ? ['write', 'bash'] : ['read'];
  if (invocation.context.role === 'builder' && copyOutput) {
    customTools.push(reviewerRead(invocation.context, options.sandbox, critical));
    tools.push('read');
  }
  if (editEnabled) {
    customTools.push(builderEdit(invocation.context, options.sandbox, critical));
    tools.push('edit');
  }`)), 'default tools and independent Read/Edit additions must stay inside their exact host gates');
  // No second, unguarded adapter construction or active Edit name elsewhere.
  assert.equal(worker.match(/\bbuilderEdit\s*\(/g)?.length, 1);
  assert.equal(worker.match(/['"]edit['"]/g)?.length, 1);
  assert.doesNotMatch(worker, /createEditTool/);
});
