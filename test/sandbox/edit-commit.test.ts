import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect, protocolVersion } from '../../src/protocol/index.js';
import { createRecords } from '../../src/records/index.js';
import { connectReadTools, serveReadTools, type GuestOwner, type ToolCall, type ToolContext } from '../../src/sandbox/read-tools.js';
import { remainingMs } from '../runner/budget.js';

const context: ToolContext = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'builder', environmentRef: 'env', bootRef: 'boot', phaseId: 'phase' };
async function fixture(t: { after(fn: () => Promise<void>): void }, original = 'original') {
  const root = await mkdtemp(join(tmpdir(), 'q5c-')); // mkdtemp creates our private 0700 root.
  let cleanupOwner: Awaited<ReturnType<typeof serveReadTools>> | undefined;
  let cleanupTools: Awaited<ReturnType<typeof connectReadTools>> | undefined;
  t.after(async () => {
    try { cleanupTools?.close(); await cleanupOwner?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(join(root, 'records'), { mode: 0o700 });
  const records = await createRecords({ root: join(root, 'records') });
  const authority = new AbortController();
  const calls: { argv: string[]; stdin: string | undefined }[] = [];
  let outcome: number | null = 0;
  let virtual = original;
  let behavior: 'normal' | 'exec-error' | 'stream-error' | 'result-error' | 'abort' | 'partial' = 'normal';
  const vm: GuestOwner = { exec(argv, options) {
    assert.ok(options.stdin === undefined || typeof options.stdin === 'string');
    calls.push({ argv, stdin: options.stdin });
    const commit = argv[5] === 'commit';
    const captured = Buffer.from(virtual);
    if (commit && behavior === 'exec-error') throw new Error('synthetic transport error');
    // VIRTUAL bytes only: this double does not model kernel FD/inode behavior.
    let exitCode = outcome;
    if (commit && outcome === 0 && (Number(argv[7]) !== Buffer.byteLength(virtual) ||
      argv[8] !== createHash('sha256').update(virtual).digest('hex'))) exitCode = 42;
    if (commit && exitCode === 0) {
      virtual = options.stdin!;
      if (behavior === 'partial') { virtual = virtual.slice(0, 3); exitCode = 1; }
    }
    return { async *output() {
      if (!commit) yield { stream: 'stdout', data: captured };
      if (commit && behavior === 'stream-error') throw new Error('synthetic stream error');
      if (commit && behavior === 'abort') authority.abort();
    }, result: commit && behavior === 'result-error' ? Promise.reject(new Error('synthetic result error')) : Promise.resolve({ exitCode: commit ? exitCode : 0 }) };
  } };
  const owner = await serveReadTools({ endpoint: join(root, 'tools'), context, records, vm, signal: authority.signal, editSourceMaxBytes: 8192 });
  cleanupOwner = owner;
  const tools = await connectReadTools(owner.endpoint, context);
  cleanupTools = tools;
  const run = (call: unknown) => tools.executeTool(call as ToolCall);
  const source = await run({ name: 'edit-source', operation: 'capture', path: '/workspace/source', callId: 'capture' });
  assert.equal(source.status, 'success');
  if (source.status !== 'success' || source.format !== 'text') throw new Error('capture failed');
  const commit = { name: 'edit-source', operation: 'commit', path: '/workspace/source', reference: source.reference,
    sourceVersion: source.sourceVersion, replacement: 'replacement', callId: 'commit' };
  return { run, calls, records, owner, authority, commit, source, setOutcome(value: number | null) { outcome = value; }, changeSource(value: string) { virtual = value; }, setBehavior(value: typeof behavior) { behavior = value; }, value: () => virtual };
}

for (const [original, replacement] of [['original', 'replacement'], ['', ''], ['\ufeffé\r\n原', '\ufeff次\r\né'], ['x', 'é'.repeat(4096)]]) {
  test(`conditional commit returns protected result and consumes capture (${Buffer.byteLength(original!)} bytes)`, async t => {
    const f = await fixture(t, original);
    const { replacement: _oldReplacement, ...version } = f.commit;
    const page = await f.run({ ...version, operation: 'page', offset: 0 });
    assert.equal(page.status, 'success');
    if (page.status === 'success') assert.deepEqual(Buffer.from(page.data, 'base64'), Buffer.from(original!));
    const result = await f.run({ ...f.commit, replacement });
    assert.equal(result.status, 'success');
    assert.equal(f.calls.length, 2);
    assert.equal(f.value(), replacement);
    if (result.status === 'success') {
      const page = await f.records.read({ reference: result.reference, offset: 0, limit: 8192 });
      assert.match(page.data.toString(), /mutation-result/);
      assert.match(page.data.toString(), /complete/);
      assert.ok(!('sourceVersion' in result));
    }
    assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
    assert.equal((await f.run({ ...f.commit, operation: 'release', replacement: undefined })).status, 'failure');
  });
}

test('known pre-effect source mismatch spends version without revoking fresh capture', async t => {
  const f = await fixture(t); f.changeSource('externally changed');
  const record = f.records.record; const events: unknown[] = [];
  f.records.record = async (...args) => { events.push(args[1]); return record(...args); };
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_CHANGED' });
  assert.equal(f.value(), 'externally changed');
  assert.match(JSON.stringify(events), /not-applied/); assert.match(JSON.stringify(events), /source-changed-before-effect/);
  assert.ok(!JSON.stringify(events).includes('expectedDigest'));
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
  assert.equal((await f.run({ name: 'edit-source', operation: 'capture', path: '/workspace/source', callId: 'fresh' })).status, 'success');
});

test('closed commit schema and UTF8/escaped frame budgets deny before guest effects', async t => {
  const f = await fixture(t);
  for (const extra of [{ expectedDigest: 'forged' }, { expectedBytes: 8 }, { editSourceMaxBytes: 99999 }, { budget: 99999 }]) {
    assert.deepEqual(await f.run({ ...f.commit, ...extra }), { status: 'failure', code: 'INVALID_TOOL_CALL' });
  }
  for (const replacement of ['é'.repeat(4097), '\u0000'.repeat(8192)]) {
    assert.deepEqual(await f.run({ ...f.commit, replacement }), { status: 'failure', code: 'EDIT_SOURCE_PAYLOAD_TOO_LARGE' });
  }
  assert.equal(f.calls.length, 1);
  assert.equal((await f.run(f.commit)).status, 'success');
});

for (const outcome of [1, null]) test(`unknown result ${outcome} revokes future owner effects`, async t => {
  const f = await fixture(t); f.setOutcome(outcome);
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_EFFECTS_UNCERTAIN' });
  assert.deepEqual(await f.run({ name: 'write', operation: 'create', path: '/workspace/later', content: '', callId: 'later' }), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  assert.equal(f.calls.length, 2);
});

for (const outcome of [1, null]) test(`unknown result ${outcome} revokes peer effects before result persistence completes`, async t => {
  const f = await fixture(t); f.setOutcome(outcome);
  const peer = await connectReadTools(f.owner.endpoint, context);
  const record = f.records.record;
  let unblock!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let resultReference: Awaited<ReturnType<typeof record>> | undefined;
  let commitRecords = 0;
  f.records.record = async (...args) => {
    if (args[0].callId === f.commit.callId && ++commitRecords === 2) {
      entered(); await gate;
      resultReference = await record(...args);
      return resultReference;
    }
    return record(...args);
  };
  const pending = f.run(f.commit);
  try {
    await started;
    assert.equal(f.calls.length, 2);
    const result = await peer.executeTool({ name: 'write', operation: 'create', path: '/workspace/later', content: '', callId: 'peer' });
    assert.equal(f.calls.length, 2, 'peer must not dispatch any additional VM exec while result persistence is held');
    assert.deepEqual(result, { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  } finally {
    unblock();
    try { await pending; } finally { peer.close(); }
  }
  assert.deepEqual(await pending, { status: 'failure', code: 'EDIT_SOURCE_EFFECTS_UNCERTAIN' });
  assert.ok(resultReference);
  const page = await f.records.read({ reference: resultReference, offset: 0, limit: 8192 });
  assert.match(page.data.toString(), /effects-uncertain/);
});

test('intent persistence failure spends version, revokes owner and makes zero mutation guest calls', async t => {
  const f = await fixture(t);
  f.records.record = async () => { throw new Error('synthetic critical persistence failure'); };
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'PROTECTED_EDIT_SOURCE_UNAVAILABLE' });
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  assert.equal(f.calls.length, 1);
});

test('result persistence failure never reports success and revokes owner', async t => {
  const f = await fixture(t); const record = f.records.record;
  let count = 0;
  f.records.record = async (...args) => { if (++count === 2) throw new Error('synthetic result failure'); return record(...args); };
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_EVIDENCE_OR_EFFECTS_UNCERTAIN' });
  assert.equal(f.value(), 'replacement');
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
});

for (const behavior of ['exec-error', 'stream-error', 'result-error'] as const) test(`${behavior} is uncertain and denies subsequent effects`, async t => {
  const f = await fixture(t); f.setBehavior(behavior);
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_EVIDENCE_OR_EFFECTS_UNCERTAIN' });
  assert.deepEqual(await f.run({ name: 'bash', command: 'ignored', callId: 'later' }), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  assert.equal(f.calls.length, 2);
});

test('owner abort after virtual effect never delivers success', async t => {
  const f = await fixture(t); f.setBehavior('abort');
  const result = await f.run(f.commit);
  assert.equal(result.status, 'failure');
  assert.equal(f.value(), 'replacement');
  assert.equal((await f.run(f.commit)).status, 'failure');
  assert.equal(f.calls.length, 2);
});

for (const corruption of ['digest', 'count', 'nextOffset', 'state', 'unavailable'] as const) test(`protected ${corruption} recheck denies before mutation and revokes`, async t => {
  const f = await fixture(t); const read = f.records.read;
  f.records.read = (async (request: Parameters<typeof read>[0]) => {
    assert.equal(request.limit, 8192); assert.equal(request.offset, 0); assert.ok(!('format' in request));
    if (corruption === 'unavailable') throw new Error('synthetic read failure');
    const page = await read(request);
    if (corruption === 'digest') return { ...page, data: Buffer.from('Original') };
    if (corruption === 'count') return { ...page, bytes: page.bytes + 1 };
    if (corruption === 'nextOffset') return { ...page, nextOffset: page.nextOffset - 1 };
    return { ...page, state: 'partial' };
  }) as typeof read; // This test intercepts only the asserted text request.
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'PROTECTED_EDIT_SOURCE_UNAVAILABLE' });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
});

test('full context and path/ref/version substitution cannot authorize commit', async t => {
  const f = await fixture(t);
  const channel = await connect(f.owner.endpoint, 'local-operator'); t.after(async () => { channel.close(); });
  const messages = channel.messages[Symbol.asyncIterator]();
  for (const key of Object.keys(context)) {
    await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: f.commit.callId, reply_to: null,
      kind: 'execute-tool', payload: { context: { ...context, [key]: key === 'role' ? 'spec' : 'stale' }, call: f.commit } as never });
    assert.equal((await messages.next()).value?.payload.code, 'STALE_TOOL_CONTEXT');
  }
  for (const change of [{ path: '/workspace/other' }, { reference: { ...f.commit.reference, workId: 'other' } },
    { sourceVersion: '00000000-0000-4000-8000-000000000000' }, { path: '/workspace/../source' }, { path: '/workspace//source' }]) {
    assert.deepEqual(await f.run({ ...f.commit, ...change }), { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
  }
  assert.equal(f.calls.length, 1);
  assert.equal((await f.run(f.commit)).status, 'success');
});

test('version is consumed before first protected-read await: concurrent commit/page/release denied', async t => {
  const f = await fixture(t);
  const peer = await connectReadTools(f.owner.endpoint, context); t.after(async () => { peer.close(); });
  const read = f.records.read;
  let unblock!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.records.read = (async (request: Parameters<typeof read>[0]) => { entered(); await gate; return read(request); }) as typeof read;
  const first = f.run(f.commit);
  try {
    await started;
    const { replacement: _replacement, ...version } = f.commit;
    for (const call of [f.commit, { ...version, operation: 'page', offset: 0 }, { ...version, operation: 'release' }]) {
      assert.deepEqual(await peer.executeTool(call as ToolCall), { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
    }
    assert.equal(f.calls.length, 1);
  } finally { unblock(); }
  assert.equal((await first).status, 'success');
  assert.equal(f.calls.length, 2);
});

test('release first denies later commit without a guest call', async t => {
  const f = await fixture(t); const { replacement: _replacement, ...version } = f.commit;
  assert.equal((await f.run({ ...version, operation: 'release' })).status, 'success');
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
  assert.equal(f.calls.length, 1);
});

// Parser executes ONLY this trusted AST inspection, with guest helper as stdin DATA.
// No guest helper body, filesystem syscall, VM or interpreter behavior is exercised.
const conditionalParser = `import ast, sys
source = sys.stdin.read()
tree = ast.parse(source)
calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
attrs = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
assert not ({'O_CREAT', 'O_TRUNC', 'mkdir', 'rename', 'replace', 'unlink'} & attrs)
opens = [n for n in calls if isinstance(n.func, ast.Attribute) and n.func.attr == 'open']
leaf = [n for n in opens if isinstance(n.args[0], ast.Name) and n.args[0].id == 'leaf']
assert len(leaf) == 2 # one directory walk site and ONE mutation leaf site
writable = next(n for n in leaf if any(isinstance(a, ast.Attribute) and a.attr == 'O_RDWR' for a in ast.walk(n)))
assert {n.attr for n in ast.walk(writable) if isinstance(n, ast.Attribute) and n.attr.startswith('O_')} == {'O_RDWR', 'O_NONBLOCK', 'O_NOFOLLOW', 'O_CLOEXEC'}
assert any(k.arg == 'dir_fd' and ast.unparse(k.value) == 'parent' for k in writable.keywords)
assert source.count('os.O_RDWR') == 1
assert 'flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC' in source
assert 'target = os.readlink("/proc/self/fd/" + str(fd))' in source
assert 'stat.S_ISREG(os.fstat(fd).st_mode)' in source
assert 'target.startswith(("/workspace/", "/artifacts/"))' in source
assert 'target.endswith(" (deleted)")' in source
assert source.index('fds.append(fd)\\n        authorize(fd, regular=True)\\n        authorize(parent)') < source.index('data = os.read(fd, expected_count + 1 - observed_count)')
assert 'if not 0 <= expected_count <= 8192:' in source
loop = next(n for n in ast.walk(tree) if isinstance(n, ast.While) and ast.unparse(n.test) == 'observed_count <= expected_count')
assert 'data = os.read(fd, expected_count + 1 - observed_count)' in ast.unparse(loop)
assert 'observed_count += len(data)' in ast.unparse(loop)
assert 'observed_digest.update(data)' in ast.unparse(loop)
compare = next(n for n in ast.walk(tree) if isinstance(n, ast.If) and 'observed_digest.hexdigest()' in ast.unparse(n.test))
assert ast.unparse(compare.test) == 'observed_count != expected_count or observed_digest.hexdigest() != expected_digest'
assert len(compare.body) == 1 and isinstance(compare.body[0], ast.Raise) and ast.unparse(compare.body[0].exc) == 'SourceMismatch()'
assert 'authorize(fd, regular=True)\\n        authorize(parent)\\n        os.lseek(fd, 0, os.SEEK_SET)\\n        os.ftruncate(fd, 0)' in source
assert source.index('raise SourceMismatch()') < source.index('os.lseek(fd, 0, os.SEEK_SET)') < source.index('os.ftruncate(fd, 0)') < source.index('os.write(fd, data)')
assert source.count('os.ftruncate') == 1 and source.count('os.write(fd, data)') == 1
handler = next(n for n in ast.walk(tree) if isinstance(n, ast.ExceptHandler) and isinstance(n.type, ast.Name) and n.type.id == 'SourceMismatch')
assert ast.unparse(handler.body[0]) == 'sys.exit(42)'
assert source.count('sys.exit(42)') == 1 and source.count('raise SourceMismatch()') == 1
# Both missing parent/leaf handlers must immediately raise, never create/retry.
for handler in [n for n in ast.walk(tree) if isinstance(n, ast.ExceptHandler) and isinstance(n.type, ast.Name) and n.type.id == 'FileNotFoundError']:
    assert len(handler.body) == 1 and isinstance(handler.body[0], ast.Raise) and handler.body[0].exc is None
print('conditional AST guards passed; guest BODY NOT executed')
`;
test('conditional helper SOURCE AST guards existing-only same-FD bounded compare before effect', async t => {
  const f = await fixture(t); assert.equal((await f.run(f.commit)).status, 'success');
  const argv = f.calls[1]!.argv; const source = argv[4]!;
  assert.equal(argv[5], 'commit'); assert.equal(argv[7], '8');
  assert.equal(argv[8], createHash('sha256').update('original').digest('hex'));
  const inspect = (data: string) => spawnSync('/usr/bin/python3', ['-I', '-S', '-c', conditionalParser], { input: data, encoding: 'utf8', timeout: remainingMs() });
  const valid = inspect(source); assert.equal(valid.status, 0, valid.stderr); assert.match(valid.stdout, /guest BODY NOT executed/);
  for (const altered of [source.replace('os.O_RDWR', 'os.O_WRONLY'), source.replace('os.O_NONBLOCK | ', ''),
    source.replace('expected_count + 1 - observed_count', '65536'), source.replace('os.lseek(fd, 0, os.SEEK_SET)', 'pass'),
    source.replace('authorize(fd, regular=True)', 'authorize(fd)'), source.replace('raise SourceMismatch()', 'os.ftruncate(fd, 0)'),
    source.replace('sys.exit(42)', 'sys.exit(0)'), source.replace('os.O_RDWR', 'os.O_RDWR | os.O_CREAT'),
    source.replace('target = os.readlink("/proc/self/fd/" + str(fd))', 'target = "/workspace/claimed"'),
    source.replace('except FileNotFoundError:\n            raise', 'except FileNotFoundError:\n            os.mkdir(leaf, dir_fd=parent)')]) {
    assert.notEqual(inspect(altered).status, 0, 'AST guard must reject unsafe helper regression');
  }
});

test('page already awaiting protected Records cannot return a spent commit version', async t => {
  const f = await fixture(t);
  const peer = await connectReadTools(f.owner.endpoint, context); t.after(async () => { peer.close(); });
  const read = f.records.read;
  let unblock!: () => void; let entered!: () => void; let reads = 0;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.records.read = (async (request: Parameters<typeof read>[0]) => {
    if (++reads === 1) { entered(); await gate; }
    return read(request);
  }) as typeof read;
  const { replacement: _replacement, ...version } = f.commit;
  const pending = f.run({ ...version, operation: 'page', offset: 0 });
  try {
    await started;
    assert.equal((await peer.executeTool(f.commit as ToolCall)).status, 'success');
  } finally { unblock(); }
  assert.deepEqual(await pending, { status: 'failure', code: 'EDIT_SOURCE_VERSION_DENIED' });
});

test('revocation while critical result persistence waits cannot report late success', async t => {
  const f = await fixture(t); const record = f.records.record; let count = 0;
  f.records.record = async (...args) => {
    const reference = await record(...args);
    if (++count === 2) f.authority.abort();
    return reference;
  };
  assert.equal((await f.run(f.commit)).status, 'failure');
  assert.equal(f.value(), 'replacement');
});

test('virtual partial direct write stays uncertain with no repair or retry', async t => {
  const f = await fixture(t); f.setBehavior('partial');
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'EDIT_SOURCE_EFFECTS_UNCERTAIN' });
  assert.equal(f.value(), 'rep');
  assert.deepEqual(await f.run(f.commit), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  assert.equal(f.calls.length, 2);
});
