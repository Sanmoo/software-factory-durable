import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { connect, protocolVersion } from '../../src/protocol/index.js';
import { createRecords } from '../../src/records/index.js';
import { connectReadTools, serveReadTools, type GuestOwner, type ToolCall, type ToolContext } from '../../src/sandbox/read-tools.js';
import { remainingMs } from '../runner/budget.js';

const context: ToolContext = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'builder',
  environmentRef: 'environment', bootRef: 'boot', phaseId: 'phase' };
const capture = { name: 'edit-source', operation: 'capture', path: '/workspace/source', callId: 'capture' };
async function fixture(t: { after(fn: () => Promise<void>): void }, chunks: Buffer[], config: {
  budget?: number | undefined; context?: ToolContext; exec?: GuestOwner['exec'];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'q5e-'));
  await mkdir(join(root, 'records'), { mode: 0o700 });
  const records = await createRecords({ root: join(root, 'records') });
  const authority = new AbortController();
  const vm: GuestOwner = { exec: config.exec ?? (() => ({ async *output() {
    for (const data of chunks) yield { stream: 'stdout', data };
  }, result: Promise.resolve({ exitCode: 0 }) })) };
  const budget = 'budget' in config ? config.budget : 8192;
  const policy = budget === undefined ? {} : { editSourceMaxBytes: budget };
  // Even an enabled legacy raw-image policy cannot authorize edit-source images.
  const binding = { endpoint: join(root, 'tools'), context: config.context ?? context, records, vm, signal: authority.signal,
    imageSourceMaxBytes: 8192, ...policy };
  const pendingOwner = serveReadTools(binding);
  // The owner policy is a synchronous snapshot, not a mutable configuration callback.
  binding.editSourceMaxBytes = 8192;
  const owner = await pendingOwner;
  const tools = await connectReadTools(owner.endpoint, config.context ?? context);
  t.after(async () => { tools.close(); await owner.close(); await rm(root, { recursive: true, force: true }); });
  return { records, authority, owner, tools, run: (call: unknown, signal?: AbortSignal) => tools.executeTool(call as ToolCall, undefined, signal) };
}

test('builder edit-source captures complete lossless BOM/CRLF/multibyte bytes beyond excerpt and releases its version', async t => {
  const bytes = Buffer.from('\ufeff' + 'é\r\n'.repeat(1500) + 'tail');
  const f = await fixture(t, [bytes.subarray(0, 2), bytes.subarray(2, 4501), bytes.subarray(4501)]);
  const result = await f.run(capture);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.equal(result.bytes, bytes.length);
  assert.ok('sourceVersion' in result && typeof result.sourceVersion === 'string');
  const bound = { name: 'edit-source', path: capture.path, reference: result.reference, sourceVersion: result.sourceVersion };
  const page = await f.run({ ...bound, operation: 'page', offset: 0, callId: 'page' });
  assert.equal(page.status, 'success');
  if (page.status === 'success') assert.deepEqual(Buffer.from(page.data, 'base64'), bytes);
  assert.equal((await f.run({ ...bound, operation: 'release', callId: 'release' })).status, 'success');
  assert.equal((await f.run({ ...bound, operation: 'page', offset: 0, callId: 'replay' })).status, 'failure');
});

test('host budget is optional, byte-based, snapshotted, and cannot be raised by a model field', async t => {
  const disabled = await fixture(t, [], { budget: undefined, exec() { assert.fail('disabled reached VM'); } });
  assert.deepEqual(await disabled.run(capture), { status: 'failure', code: 'EDIT_SOURCE_DENIED' });
  const small = await fixture(t, [Buffer.from('éé')], { budget: 3 });
  assert.deepEqual(await small.run(capture), { status: 'failure', code: 'EDIT_SOURCE_NOT_LOSSLESS' });
  assert.deepEqual(await small.run({ ...capture, editSourceMaxBytes: 8192 }), { status: 'failure', code: 'INVALID_TOOL_CALL' });
  assert.deepEqual(await small.run({ ...capture, expectedHash: 'caller-is-not-authority' }), { status: 'failure', code: 'INVALID_TOOL_CALL' });
  const boundary = await fixture(t, [Buffer.from('é'.repeat(4096))]);
  assert.equal((await boundary.run(capture)).status, 'success');
  const over = await fixture(t, [Buffer.from('é'.repeat(4096) + 'a')]);
  assert.equal((await over.run(capture)).status, 'failure');
  const zero = await fixture(t, [], { budget: 0 });
  assert.equal((await zero.run(capture)).status, 'success');
});

test('all actual Records appends including retained finish tail participate in lossless comparison', async t => {
  const text = Buffer.from('whole-protected-text-with-a-retained-tail');
  const f = await fixture(t, [text.subarray(0, 15), text.subarray(15)]);
  f.records.registerSecret('a-secret-not-in-source');
  const result = await f.run(capture); assert.equal(result.status, 'success');
  if (result.status !== 'success' || !('sourceVersion' in result)) return;
  const page = await f.run({ ...capture, operation: 'page', reference: result.reference, sourceVersion: result.sourceVersion, offset: 0 });
  assert.equal(page.status, 'success');
  if (page.status === 'success') assert.deepEqual(Buffer.from(page.data, 'base64'), text);
});

for (const [name, chunks, secret] of [
  ['split secret', [Buffer.from('prefix-syn'), Buffer.from('thetic-secret-suffix')], 'synthetic-secret'],
  ['equal byte length redaction', [Buffer.from('abc')], 'abc'],
  ['secret beyond 4096 excerpt', [Buffer.alloc(5000, 120), Buffer.from('synthetic-secret')], 'synthetic-secret'],
  ['invalid UTF8', [Buffer.from([0xc3]), Buffer.from([0x28])], undefined],
  ['unfinished UTF8', [Buffer.from([0xc3])], undefined],
  ['PNG image', [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], undefined],
  ['GIF image', [Buffer.from('GIF89aABCDEFGHIJK')], undefined],
  ['binary NUL', [Buffer.from('prefix\x00suffix')], undefined],
  ['binary control', [Buffer.from('prefix\x01suffix')], undefined],
] as const) {
  test(`edit-source rejects ${name} without a capability or raw fallback`, async t => {
    const f = await fixture(t, [...chunks]);
    if (secret) f.records.registerSecret(secret);
    const result = await f.run(capture);
    assert.equal(result.status, 'failure');
    assert.ok(!('reference' in result) && !('sourceVersion' in result) && !('data' in result));
  });
}

test('versions are independent across paths; full path/reference/context/phase binding and release replay are enforced', async t => {
  const f = await fixture(t, [Buffer.from('source')]);
  const a = await f.run(capture);
  const b = await f.run({ ...capture, path: '/artifacts/second', callId: 'second' });
  assert.equal(a.status, 'success'); assert.equal(b.status, 'success');
  if (a.status !== 'success' || b.status !== 'success' || !('sourceVersion' in a) || !('sourceVersion' in b)) return;
  assert.notEqual(a.sourceVersion, b.sourceVersion);
  const bound = { ...capture, operation: 'page', reference: a.reference, sourceVersion: a.sourceVersion, offset: 0 };
  for (const change of [
    { path: '/artifacts/second' }, { sourceVersion: b.sourceVersion }, { reference: b.reference },
    { reference: { ...a.reference, workId: 'other' } }, { sourceVersion: '00000000-0000-4000-8000-000000000000' },
  ]) assert.deepEqual(await f.run({ ...bound, ...change }), { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
  assert.equal((await f.run({ name: 'read', operation: 'page', reference: a.reference, offset: 0, callId: 'legacy' })).status, 'failure');
  const channel = await connect(f.owner.endpoint, 'local-operator');
  t.after(async () => { channel.close(); });
  const messages = channel.messages[Symbol.asyncIterator]();
  for (const operation of ['capture', 'page', 'release']) {
    for (const change of [{ phaseId: 'old-phase' }, { bootRef: 'old-boot' }, { invocationId: 'old-invocation' },
      { role: 'standards' }, { executionId: 'old-execution' }, { environmentRef: 'old-env' }, { workId: 'other' }]) {
      const call = operation === 'capture' ? capture : { ...capture, operation, reference: a.reference, sourceVersion: a.sourceVersion,
        ...(operation === 'page' ? { offset: 0 } : {}) };
      await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: capture.callId, reply_to: null,
        kind: 'execute-tool', payload: { context: { ...context, ...change }, call } as never });
      assert.equal((await messages.next()).value?.payload.code, 'STALE_TOOL_CONTEXT');
    }
  }
  const anotherOwner = await fixture(t, [Buffer.from('source')]);
  assert.deepEqual(await anotherOwner.run(bound), { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
  assert.equal((await f.run(bound)).status, 'success'); // bad substitutions do not consume a valid version
  assert.equal((await f.run({ ...capture, operation: 'release', reference: a.reference, sourceVersion: a.sourceVersion })).status, 'success');
  assert.equal((await f.run({ ...capture, operation: 'release', reference: a.reference, sourceVersion: a.sourceVersion })).status, 'failure');
  assert.equal((await f.run(bound)).status, 'failure');
  assert.equal((await f.run({ ...bound, path: '/artifacts/second', reference: b.reference, sourceVersion: b.sourceVersion })).status, 'success');
});

test('standards/spec cannot capture/page/release edit-source even with owner technical budget', async t => {
  for (const role of ['standards', 'spec'] as const) {
    const f = await fixture(t, [], { context: { ...context, role }, exec() { assert.fail('wrong role reached guest'); } });
    assert.deepEqual(await f.run(capture), { status: 'failure', code: 'EDIT_SOURCE_DENIED' });
    for (const operation of ['page', 'release']) assert.deepEqual(await f.run({ ...capture, operation,
      sourceVersion: '00000000-0000-4000-8000-000000000000', reference: { workId: context.workId, id: '00000000-0000-4000-8000-000000000001' },
      ...(operation === 'page' ? { offset: 0 } : {}) }), { status: 'failure', code: 'EDIT_SOURCE_DENIED' });
  }
});

test('bounded version bookkeeping is released, not a mutable last-capture slot', async t => {
  const f = await fixture(t, []);
  const versions = [];
  for (let i = 0; i < 32; i++) {
    const result = await f.run({ ...capture, callId: `capture-${i}` });
    assert.equal(result.status, 'success');
    if (result.status === 'success' && 'sourceVersion' in result) versions.push(result);
  }
  assert.deepEqual(await f.run(capture), { status: 'failure', code: 'EDIT_SOURCE_LIMIT' });
  const first = versions[0]!;
  assert.equal((await f.run({ ...capture, operation: 'release', reference: first.reference, sourceVersion: first.sourceVersion })).status, 'success');
  assert.equal((await f.run(capture)).status, 'success');
});

for (const kind of ['nonzero', 'null-result', 'stream-error', 'result-error'] as const) {
  test(`partial ${kind} capture never mints a version`, async t => {
    const f = await fixture(t, [], { exec() { return {
      async *output() { yield { stream: 'stdout', data: Buffer.from('partial-source') }; if (kind === 'stream-error') throw new Error('private'); },
      result: kind === 'result-error' ? Promise.reject(new Error('private')) : Promise.resolve({ exitCode: kind === 'null-result' ? null : kind === 'nonzero' ? 1 : 0 }),
    }; } });
    const result = await f.run(capture);
    assert.equal(result.status, 'failure');
    assert.ok(!('sourceVersion' in result) && !('reference' in result));
  });
}

for (const kind of ['cancel', 'EOF', 'owner-end'] as const) {
  test(`${kind} aborts pending capture and denies a late version`, async t => {
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let revoked!: () => void;
    const aborted = new Promise<void>(resolve => { revoked = resolve; });
    const f = await fixture(t, [], { exec(_argv, options) { return {
      async *output() {
        yield { stream: 'stdout', data: Buffer.from('partial-source') };
        started();
        await new Promise<void>(resolve => { options.signal.addEventListener('abort', () => { revoked(); resolve(); }, { once: true }); });
        yield { stream: 'stdout', data: Buffer.from('late-source') };
      }, result: Promise.resolve({ exitCode: 0 }),
    }; } });
    const cancel = new AbortController();
    const pending = f.run(capture, cancel.signal); await entered;
    if (kind === 'cancel') cancel.abort();
    else if (kind === 'EOF') f.tools.close();
    else f.authority.abort();
    await aborted;
    const result = await pending; assert.equal(result.status, 'failure');
    assert.ok(!('sourceVersion' in result) && !('reference' in result));
    assert.equal((await f.run(capture)).status, 'failure');
  });
}

test('edit guest mode AST authorizes nofollow parents and regular resolved FD before the shared first source read; never host executes helper', async t => {
  let program = '';
  const f = await fixture(t, [], { exec(argv) {
    assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
    assert.equal(argv[5], capture.path); program = argv[4]!;
    return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
  } });
  assert.equal((await f.run(capture)).status, 'success');
  const output = execFileSync('/usr/bin/python3', ['-I', '-S', '-c', `import ast,sys
source = sys.stdin.read()
tree = ast.parse(source)
calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
def named(n, name):
    return isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == "os" and n.func.attr == name
assert not any(named(n, name) for n in calls for name in ("mkdir", "ftruncate", "truncate", "rename", "unlink", "remove"))
reads = [n for n in calls if named(n, "read")]
assert len(reads) == 1 and ast.unparse(reads[0].args[0]) == "fd"
read_line = reads[0].lineno
opens = [n for n in calls if named(n, "open")]
assert len(opens) == 4
for node in opens:
    assert node.lineno < read_line
    flags = ast.unparse(node.args[1])
    assert flags == "flags" or ("O_RDONLY" in flags and "O_NOFOLLOW" in flags and "O_NONBLOCK" in flags)
    assert "O_CREAT" not in flags and "O_TRUNC" not in flags and "O_WRONLY" not in flags and "O_RDWR" not in flags
writes = [n for n in calls if named(n, "write")]
assert len(writes) == 1 and ast.literal_eval(writes[0].args[0]) == 1
body = next(n for n in tree.body if isinstance(n, ast.Try)).body
loop_index = next(i for i,n in enumerate(body) if isinstance(n, ast.While))
assert ast.unparse(body[loop_index-1]) == "authorize_parent(parent)"
assert any(isinstance(n, ast.If) and "stat.S_ISREG(os.fstat(fd).st_mode)" in ast.unparse(n.test) for n in body[:loop_index])
assert any(isinstance(n, ast.Assign) and "os.readlink('/proc/self/fd/' + str(fd))" in ast.unparse(n) for n in body[:loop_index])
assert any(isinstance(n, ast.If) and "target.startswith" in ast.unparse(n.test) and "deleted" in ast.unparse(n.test) for n in body[:loop_index])
assert "os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC" in source
assert "os.O_CREAT" not in source and "os.O_TRUNC" not in source
print("AST guard passed: authorized parents/regular resolved FD before shared read; stdout-only writes")`],
  { input: program, encoding: 'utf8', timeout: remainingMs() });
  assert.match(output, /AST guard passed/);
});

test('invalid trusted source policies fail before endpoint or guest effects', async t => {
  const f = await fixture(t, []);
  for (const editSourceMaxBytes of [-1, 8193, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(serveReadTools({ endpoint: f.owner.endpoint, context, records: f.records, signal: f.authority.signal,
      vm: { exec() { assert.fail('invalid policy reached VM'); } }, editSourceMaxBytes }));
  }
});

test('closed schemas reject raw mode, arbitrary budget/hash/operation, noncanonical paths and offset overflow', async t => {
  const f = await fixture(t, [], { exec() { assert.fail('invalid request reached VM'); } });
  for (const change of [{ format: 'raw' }, { sourceVersion: '00000000-0000-4000-8000-000000000000' },
    { expectedHash: 'not-authority' }, { operation: 'consume' }, { maxBytes: 8192 }]) {
    assert.deepEqual(await f.run({ ...capture, ...change }), { status: 'failure', code: 'INVALID_TOOL_CALL' });
  }
  for (const path of ['/host/source', '/workspace/../source', '/workspace/./source', '/workspace//source', '/workspace/source/', '/workspace/source\x00']) {
    assert.deepEqual(await f.run({ ...capture, path }), { status: 'failure', code: 'READ_PATH_DENIED' });
  }
  assert.deepEqual(await f.run({ ...capture, operation: 'page', offset: 8193, sourceVersion: '00000000-0000-4000-8000-000000000000',
    reference: { workId: context.workId, id: '00000000-0000-4000-8000-000000000001' } }), { status: 'failure', code: 'INVALID_TOOL_CALL' });
});

test('simultaneous captures for two paths retain independent owner versions', async t => {
  let started!: () => void;
  const firstEntered = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, [], { exec(argv) { return {
    async *output() {
      if (argv[5] === capture.path) { started(); await held; }
      yield { stream: 'stdout', data: Buffer.from(argv[5]!) };
    }, result: Promise.resolve({ exitCode: 0 }),
  }; } });
  const secondTools = await connectReadTools(f.owner.endpoint, context);
  t.after(async () => { secondTools.close(); });
  const pending = f.run(capture); await firstEntered;
  const second = await secondTools.executeTool({ ...capture, name: 'edit-source', operation: 'capture', path: '/artifacts/second', callId: 'second' });
  release();
  const first = await pending;
  assert.equal(first.status, 'success'); assert.equal(second.status, 'success');
  if (first.status !== 'success' || second.status !== 'success' || !('sourceVersion' in first) || !('sourceVersion' in second)) return;
  for (const [path, result] of [[capture.path, first], ['/artifacts/second', second]] as const) {
    const page = await f.run({ ...capture, path, operation: 'page', offset: 0, reference: result.reference, sourceVersion: result.sourceVersion });
    assert.equal(page.status, 'success');
    if (page.status === 'success') assert.equal(Buffer.from(page.data, 'base64').toString(), path);
  }
});

test('read and edit-source capture drain both pipes required by native ExecProcess.output without publishing stderr', async t => {
  const calls = [capture, { name: 'read', operation: 'capture', path: '/workspace/source', callId: 'read' }];
  for (const call of calls) await t.test(call.name, async t => {
    let outputAttempts = 0, stderrDrained = 0;
    const f = await fixture(t, [], { ...(call.name === 'read' ? { context: { ...context, role: 'standards' as const } } : {}), exec(_argv, options) {
      return { async *output() {
        outputAttempts++;
        // Actual pinned ExecProcess.output contract (gondolin dist/src/exec.js:298–303), not VM execution.
        if (options?.stdout !== 'pipe' || options.stderr !== 'pipe') throw new Error('stdout/stderr are not piped');
        yield { stream: 'stdout', data: Buffer.from('alpha\n') };
        stderrDrained++;
        yield { stream: 'stderr', data: Buffer.from('private-guest-diagnostic') };
      }, result: Promise.resolve({ exitCode: 0 }) };
    } });
    const result = await f.run(call);
    assert.equal(outputAttempts, 1, JSON.stringify(result));
    assert.equal(stderrDrained, 1);
    assert.equal(result.status, 'success');
    if (result.status !== 'success') return;
    const page = await f.run(call.name === 'read' ? { name: 'read', operation: 'page', reference: result.reference, offset: 0, callId: 'p' }
      : { name: 'edit-source', path: call.path, reference: result.reference, sourceVersion: (result as { sourceVersion?: string }).sourceVersion, operation: 'page', offset: 0, callId: 'p' });
    assert.equal(page.status, 'success');
    if (page.status === 'success') {
      const text = Buffer.from(page.data, 'base64').toString();
      assert.match(text, /alpha/);
      assert.doesNotMatch(text, /private-guest-diagnostic/);
    }
  });
});
