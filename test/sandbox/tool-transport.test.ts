import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { connect, protocolVersion } from '../../src/protocol/index.js';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { connectReadTools, serveReadTools, type GuestOwner } from '../../src/sandbox/read-tools.js';

const context: ToolContext = { workId: 'work-05', executionId: 'execution-05', invocationId: 'standards-05',
  role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' };
const read = { name: 'read' as const, operation: 'capture' as const, path: '/workspace/README.md', callId: 'read-1' };
function guest(text: Buffer, exitCode = 0): ReturnType<GuestOwner['exec']> {
  return { async *output() { yield { stream: 'stdout', data: text }; }, result: Promise.resolve({ exitCode }) };
}
async function fixture(t: { after(fn: () => Promise<void>): void }, exec: GuestOwner['exec']) {
  const root = await mkdtemp(join(tmpdir(), 'q5-'));
  const recordsRoot = join(root, 'records'); await mkdir(recordsRoot, { mode: 0o700 });
  const records = await createRecords({ root: recordsRoot });
  const authority = new AbortController();
  const owner = await serveReadTools({ endpoint: join(root, 'read.sock'), context, signal: authority.signal, records, vm: { exec } });
  t.after(async () => { await owner.close(); await rm(root, { recursive: true, force: true }); });
  const sandbox = createSandbox({ root, toolEndpoint: owner.endpoint });
  return { root, sandbox, records, owner, authority, execute: (call = read) => sandbox.executeTool(context, call) };
}

test('Q5 host-bound reviewer receives a protected reference and paginable filtered whole source', async t => {
  const f = await fixture(t, argv => {
    assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
    assert.equal(argv.length, 8);
    assert.equal(argv[5], '/workspace/README.md');
    return guest(Buffer.from('guest synthetic-secret content'));
  });
  f.records.registerSecret('synthetic-secret');
  const result = await f.execute(); assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  const evidence = await f.records.read({ reference: result.reference, offset: 0, limit: 100 });
  assert.equal(evidence.state, 'complete'); assert.equal(evidence.data.toString(), 'guest █ content');
  const page = await f.sandbox.executeTool(context, { name: 'read', operation: 'page', reference: result.reference, offset: 0, callId: 'page-1' });
  assert.equal(page.status, 'success');
  if (page.status === 'success') assert.equal(Buffer.from(page.data, 'base64').toString(), 'guest █ content');
});

test('self-asserted role, boot, invocation, phase and administrative calls cannot authorize Q5', async t => {
  const f = await fixture(t, () => { assert.fail('unauthorized request reached VM'); });
  const channel = await connect(f.owner.endpoint, 'local-operator'); t.after(async () => { channel.close(); });
  const messages = channel.messages[Symbol.asyncIterator]();
  for (const change of [{ role: 'builder' }, { bootRef: 'old-boot' }, { invocationId: 'other-invocation' },
    { executionId: 'other-execution' }, { phaseId: 'other-phase' }, { workId: 'other-work' }, { environmentRef: 'other-env' }]) {
    await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'read-1', reply_to: null,
      kind: 'execute-tool', payload: { context: { ...context, ...change }, call: read } });
    assert.equal((await messages.next()).value?.payload.status, 'failure');
  }
  assert.deepEqual(await f.execute({ ...read, name: 'bash' } as unknown as typeof read), { status: 'failure', code: 'INVALID_TOOL_CALL' });
  assert.deepEqual(await f.execute({ ...read, path: '/host/secret' }), { status: 'failure', code: 'READ_PATH_DENIED' });
  assert.deepEqual(await f.execute({ ...read, path: '/workspace/../etc/shadow' }), { status: 'failure', code: 'READ_PATH_DENIED' });
});

test('host revocation rejects new reads and late results, never confers authority from capture metadata', async t => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, () => ({ async *output() { entered(); await released; yield { stream: 'stdout', data: Buffer.from('late') }; },
    result: Promise.resolve({ exitCode: 0 }) }));
  const pending = f.execute(); await started; f.authority.abort(); release();
  const result = await pending;
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.ok(['STALE_TOOL_CONTEXT', 'TOOL_CHANNEL_CLOSED'].includes(result.code));
  await f.owner.close();
  assert.deepEqual(await f.execute(), { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' });
});

test('EOF revokes authority while guest read is pending, before the handler completes', async t => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let aborted!: () => void; const revoked = new Promise<void>(resolve => { aborted = resolve; });
  const f = await fixture(t, (_argv, options) => ({ async *output() {
    entered(); await new Promise<void>(resolve => { options.signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }); });
    yield { stream: 'stdout', data: Buffer.from('late') };
  }, result: Promise.resolve({ exitCode: 0 }) }));
  const tools = await connectReadTools(f.owner.endpoint, context);
  const pending = tools.executeTool(read); await started; tools.close(); await revoked;
  assert.deepEqual(await pending, { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' });
  await f.owner.close();
  assert.deepEqual(await f.execute(), { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' });
});

test('capture rejection and guest failure never deliver raw exception or output text', async t => {
  let reads = 0;
  const f = await fixture(t, () => { reads++; throw new Error('synthetic-secret'); });
  assert.deepEqual(await f.execute(), { status: 'failure', code: 'PROTECTED_READ_UNAVAILABLE' });
  f.records.registerSecret('standards-05');
  assert.deepEqual(await f.execute(), { status: 'failure', code: 'PROTECTED_READ_UNAVAILABLE' }); assert.equal(reads, 1);
});

test('streamed source larger than old head wrapper is complete and page frames stay bounded', async t => {
  const f = await fixture(t, () => guest(Buffer.alloc(150000, 120)));
  const result = await f.execute(); assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.equal(result.bytes, 150000);
  const page = await f.sandbox.executeTool(context, { name: 'read', operation: 'page', reference: result.reference, offset: 149999, callId: 'last' });
  assert.equal(page.status, 'success');
  if (page.status === 'success') { assert.equal(Buffer.from(page.data, 'base64').toString(), 'x'); assert.equal(page.nextOffset, 150000); }
});

test('supported image magic is not misreported as a complete text read', async t => {
  const f = await fixture(t, () => guest(Buffer.from('GIF89aABCDEFGHIJK')));
  assert.deepEqual(await f.execute(), { status: 'failure', code: 'READ_BINARY_UNSUPPORTED' });
});

test('guest nonzero status and invalid UTF-8 are explicit errors, not successful or raw output', async t => {
  let count = 0;
  const f = await fixture(t, () => ++count === 1 ? guest(Buffer.from('untrusted error secret'), 1) : guest(Buffer.from([255])));
  assert.deepEqual(await f.execute(), { status: 'failure', code: 'GUEST_READ_FAILED' });
  assert.deepEqual(await f.execute(), { status: 'failure', code: 'PROTECTED_READ_UNAVAILABLE' });
});

// Static syntax/structure evidence only: the helper is DATA to the host parser.
// No helper body (including open/read) is ever executed on the host.
test('guest helper is constant argv data and parses with same-FD authorization before reads', async t => {
  const invocations: string[][] = [];
  const f = await fixture(t, (argv, options) => {
    invocations.push(argv);
    assert.equal(options.windowBytes, 65536);
    assert.equal(options.stdout, 'pipe'); assert.equal(options.stderr, 'ignore');
    return guest(Buffer.from('source'));
  });
  const path = '/artifacts/name\'";$(not-a-command).txt';
  assert.equal((await f.execute({ ...read, path })).status, 'success');
  assert.equal((await f.execute()).status, 'success');
  const [first, second] = invocations;
  assert.ok(first && second);
  assert.deepEqual(first.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
  assert.equal(first.length, 8); assert.equal(first[5], path);
  assert.deepEqual(first.slice(6), ['reviewer', '[]']);
  assert.equal(first[4], second[4]);
  const program = first[4]!;
  const parsed = execFileSync('/usr/bin/python3', ['-I', '-S', '-c',
    'import ast,sys; tree=ast.parse(sys.stdin.read()); print(ast.dump(tree))'],
  { input: program, encoding: 'utf8', timeout: 5000 });
  assert.match(parsed, /Module\(body=/);
  assert.equal((program.match(/os\.open\(/g) ?? []).length, 1);
  assert.match(program, /os\.open\(path, os\.O_RDONLY \| os\.O_NONBLOCK \| os\.O_CLOEXEC\)/);
  for (const check of ['os.O_RDONLY != 0', 'os.O_NONBLOCK <= 0', 'os.O_CLOEXEC <= 0',
    'stat.S_ISREG(os.fstat(fd).st_mode)', 'os.readlink("/proc/self/fd/" + str(fd))',
    'target.startswith(("/workspace/", "/artifacts/"))', 'target.isprintable()',
    'target.endswith(" (deleted)")', 'part in ("", ".", "..")']) {
    assert.ok(program.includes(check), check);
    assert.ok(program.indexOf(check) < program.indexOf('os.read(fd,'), check + ' before source read');
  }
  assert.match(program, /path = sys\.argv\[1\]/);
  assert.match(program, /os\.read\(fd, 65536\)/);
  assert.match(program, /while data:/);
  assert.match(program, /written = os\.write\(1, data\)/);
  assert.match(program, /if written <= 0:/);
  assert.match(program, /data = data\[written:\]/);
  assert.match(program, /os\.close\(fd\)/);
  assert.doesNotMatch(program, /print\(|exec\(|eval\(|realpath|subprocess|cat|open\(target/);
});

for (const mode of ['nonzero', 'source-error', 'result-error', 'exec-error', 'revoked', 'binary', 'invalid-utf8', 'empty-nonzero'] as const) {
  test(`failed ${mode} source leaves real Records partial and no reference`, async t => {
    let revoke = () => {};
    const f = await fixture(t, () => {
      if (mode === 'exec-error') throw new Error('missing interpreter');
      return { async *output() {
        if (mode !== 'empty-nonzero') yield { stream: 'stdout', data: mode === 'invalid-utf8' ? Buffer.from([255]) :
          Buffer.from(mode === 'binary' ? 'GIF89aABCDEFGHIJK' : 'partial source already streamed') };
        if (mode === 'source-error') throw new Error('private source failure');
        if (mode === 'revoked') revoke();
      }, result: mode === 'result-error' ? Promise.reject(new Error('private result failure')) :
        Promise.resolve({ exitCode: mode === 'nonzero' || mode === 'empty-nonzero' ? 1 : 0 }) };
    });
    revoke = () => f.authority.abort();
    assert.equal((await f.execute()).status, 'failure');
    await f.owner.close();
    const ids = await readdir(join(f.root, 'records', context.workId, 'evidence'));
    assert.equal(ids.length, 1);
    const reference = { workId: context.workId, id: ids[0]! };
    assert.equal((await f.records.read({ reference, offset: 0, limit: 100 })).state, 'partial');
    assert.ok(!(await readdir(join(f.root, 'records', context.workId, 'evidence', reference.id))).includes('complete.json'));
  });
}
