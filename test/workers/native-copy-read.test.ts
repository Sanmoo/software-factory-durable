import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { reviewerRead } from '../../src/workers/read.js';
import { connect, protocolVersion } from '../../src/protocol/index.js';

const context: ToolContext = { workId: 'work', executionId: 'exec', invocationId: 'builder', role: 'builder', environmentRef: 'env', bootRef: 'boot', phaseId: 'phase' };
const qualified = { copyOutput: true, profileOrigin: 'factory-development-gondolin-0.14.0-stdin-capacity-v1' as const };
const source = Buffer.from('\ufeffGIF89a synthetic-secret\n' + 'prefix\n'.repeat(9000) + 'target\nlast');
function guest(data = source) {
  const files = new Map<string, Buffer>();
  const attempts = { bash: 0, copy: 0, read: 0, validatedRead: 0 };
  const programs: string[] = [];
  const vm: Parameters<typeof nativeOwner>[1] = { exec(argv, options) {
    if (argv[0] === '/usr/bin/env' && argv.includes('/bin/bash')) {
      attempts.bash++;
      return { async *output() { yield { stream: 'stdout', data }; }, result: Promise.resolve({ exitCode: 0 }) };
    }
    if (argv[2] === '/usr/bin/python3') {
      attempts.copy++;
      assert.equal(argv[7], 'stream');
      return { async *output() {
        assert.ok(options.stdin && typeof options.stdin !== 'string');
        const chunks: Buffer[] = [];
        for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks); files.set(argv[8]!, bytes);
        yield { stream: 'stdout', data: Buffer.from(JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
      }, result: Promise.resolve({ exitCode: 0 }) };
    }
    attempts.read++; // BEFORE assertions; owner catches VM assertion errors.
    assert.equal(argv[0], '/usr/bin/python3');
    assert.equal(argv.length, 8); programs.push(argv[4]!);
    assert.ok(JSON.parse(argv[7]!).includes(argv[5]!));
    const bytes = files.get(argv[5]!); assert.ok(bytes);
    attempts.validatedRead++;
    return { async *output() { for (let i = 0; i < bytes.length; i += 8191) yield { stream: 'stdout', data: bytes.subarray(i, i + 8191) }; }, result: Promise.resolve({ exitCode: 0 }) };
  } };
  return { vm, files, attempts, programs };
}

test('Builder native Read streams its whole published copies across subsequent Bash commands, not Bash references', async () => {
  const g = guest(); const f = await nativeOwner(context, g.vm, qualified);
  const tools = await f.connect();
  try {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, async () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') throw new Error('bash failed');
    const copied = await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
    assert.equal(copied.status, 'success'); if (copied.status !== 'success') throw new Error('copy failed');
    const path = JSON.parse(Buffer.from(copied.data, 'base64').toString()).path as string;
    await tools.executeTool({ name: 'bash', command: 'next', callId: 'next' }, async () => {});
    const native = reviewerRead(context, { executeTool: (_context, call) => tools.executeTool(call) });
    const result = await native.execute('native', { path, offset: 9002, limit: 2 });
    assert.deepEqual(result.content, [{ type: 'text', text: 'target\nlast' }]);
    assert.equal(g.attempts.read, 1); assert.equal(g.attempts.validatedRead, 1);
    const prefix = await native.execute('gif-text', { path, limit: 1 });
    assert.deepEqual(prefix.content, [{ type: 'text', text: 'GIF89a █\n\n[9002 more lines in file. Use offset=2 to continue.]' }]);
    assert.deepEqual(await tools.executeTool({ name: 'read', operation: 'page', reference: bash.reference, offset: 0, callId: 'guess' }), { status: 'failure', code: 'READ_REFERENCE_DENIED' });
    assert.equal((await tools.executeTool({ name: 'read', operation: 'capture', path: '/workspace/source', callId: 'workspace' })).status, 'failure');
    assert.equal(g.attempts.read, 2);
    const channel = await connect(f.owner.endpoint, 'local-operator');
    try {
      const messages = channel.messages[Symbol.asyncIterator]();
      for (const key of Object.keys(context) as (keyof ToolContext)[]) {
        await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'spoof', reply_to: null, kind: 'execute-tool',
          payload: { context: { ...context, [key]: key === 'role' ? 'spec' : 'foreign' }, call: { name: 'read', operation: 'capture', path, callId: 'spoof' } } });
        assert.equal((await messages.next()).value?.payload.code, 'STALE_TOOL_CONTEXT');
      }
      assert.equal(g.attempts.read, 2, 'all seven bound context fields are checked before guest source');
      const spoof = { name: 'read' as const, operation: 'capture' as const, path: '/workspace/source', callId: 'spoof-flags', selectedOutputCopies: [path], copyOutput: true };
      assert.deepEqual(await tools.executeTool(spoof), { status: 'failure', code: 'INVALID_TOOL_CALL' });
      const { phaseId: _phase, ...captureContext } = context;
      const raw = await f.records.openOutput({ ...captureContext, callId: 'raw' }, { format: 'raw', maxBytes: 10 });
      await raw.write(Buffer.from('raw')); const completedRaw = await raw.finish();
      assert.deepEqual(await tools.executeTool({ name: 'read', operation: 'page', format: 'raw', reference: completedRaw.reference, offset: 0, callId: 'raw-guess' }), { status: 'failure', code: 'READ_REFERENCE_DENIED' });
    } finally { channel.close(); }
  } finally { tools.close(); await f.close(); }
});

const path = '/artifacts/factory-output-00000000-0000-4000-8000-000000000001.txt';
for (const mode of ['pending', 'late-secret', 'signal', 'persistence'] as const) test(`copy ${mode} cannot publish Read permission, even with a known guest file path`, async () => {
  const g = guest(Buffer.from('GIF89a text\nlast'));
  const f = await nativeOwner(context, g.vm, qualified);
  const tools = await f.connect();
  const peer = await f.connect();
  let release!: () => void; const hold = new Promise<void>(r => { release = r; });
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const record = f.records.record.bind(f.records);
  f.records.record = async (binding, event) => {
    if ((event as { status?: string }).status === 'guest-receipt-observed') { entered(); await hold; if (mode === 'persistence') throw new Error('owned persistence failure'); }
    return record(binding, event);
  };
  try {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, async () => {});
    assert.ok(bash.status === 'success');
    const pending = tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
    await started;
    const copiedPath = [...g.files.keys()][0]!; assert.ok(copiedPath);
    const capture = { name: 'read' as const, operation: 'capture' as const, path: copiedPath, callId: 'pending-read' };
    assert.deepEqual(await peer.executeTool(capture), { status: 'failure', code: 'READ_PATH_DENIED' });
    assert.equal(g.attempts.read, 0);
    if (mode === 'late-secret') f.records.registerSecret('new-after-evidence');
    if (mode === 'signal') f.authority.abort();
    release();
    const result = await pending;
    assert.equal(result.status, mode === 'pending' ? 'success' : 'failure');
    const after = await peer.executeTool({ ...capture, callId: 'after' });
    assert.equal(after.status, mode === 'pending' ? 'success' : 'failure');
    assert.equal(g.attempts.read, mode === 'pending' ? 1 : 0);
    assert.equal(g.attempts.copy, 1); assert.equal(g.files.has(copiedPath), true, 'revocation never deletes guest files');
  } finally { release(); f.records.record = record; peer.close(); tools.close(); await f.close(); }
});

test('32 completed private grants survive new commands; the 33rd copy denies before guest mutation without evicting an old grant', async () => {
  const g = guest(Buffer.from('GIF89a text\nlast'));
  const f = await nativeOwner(context, g.vm, qualified);
  const tools = await f.connect();
  try {
    for (let i = 0; i < 33; i++) {
      const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash-' + i }, async () => {}); assert.ok(bash.status === 'success');
      const copy = await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy-' + i });
      assert.equal(copy.status, i < 32 ? 'success' : 'failure');
    }
    assert.equal(g.attempts.bash, 33); assert.equal(g.attempts.copy, 32); assert.equal(g.files.size, 32);
    for (const copiedPath of g.files.keys()) assert.equal((await tools.executeTool({ name: 'read', operation: 'capture', path: copiedPath, callId: 'read-old' })).status, 'success');
    assert.equal(g.attempts.read, 32); assert.equal(g.attempts.validatedRead, 32);
  } finally { tools.close(); await f.close(); }
});

for (const selected of [undefined, [], [path]] as const) test(`reviewer selection ${JSON.stringify(selected)} and new Builder bindings do not inherit paths/references`, async () => {
  const g = guest(); g.files.set(path, Buffer.from('GIF89a selected text\nlast'));
  const reviewer = { ...context, role: 'spec' as const };
  const f = await nativeOwner(reviewer, g.vm, selected === undefined ? {} : { selectedOutputCopies: selected });
  const tools = await f.connect();
  try {
    const result = await tools.executeTool({ name: 'read', operation: 'capture', path, callId: 'selected' });
    assert.equal(result.status, selected?.length ? 'success' : 'failure');
    assert.equal(g.attempts.read, selected?.length ? 1 : 0);
    if (result.status === 'success') {
      const page = await tools.executeTool({ name: 'read', operation: 'page', reference: result.reference, offset: 0, callId: 'page' });
      assert.ok(page.status === 'success'); assert.equal(Buffer.from(page.data, 'base64').toString(), 'GIF89a selected text\nlast');
      const builder = await nativeOwner({ ...context, invocationId: 'new-builder' }, g.vm, qualified);
      const next = await builder.connect();
      try {
        assert.equal((await next.executeTool({ name: 'read', operation: 'capture', path, callId: 'known' })).status, 'failure');
        assert.deepEqual(await next.executeTool({ name: 'read', operation: 'page', reference: result.reference, offset: 0, callId: 'foreign' }), { status: 'failure', code: 'READ_REFERENCE_DENIED' });
        assert.equal(g.attempts.read, 1);
      } finally { next.close(); await builder.close(); }
      // Guest helper remains SOURCE ONLY on host. Test actual-target authorization
      // ordering, not a fabricated executed guest/symlink confinement proof.
      const program = g.programs[0]!;
      const ast = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', 'import ast,sys; t=ast.parse(sys.stdin.read()); print(type(t).__name__)'], { input: program, encoding: 'utf8', timeout: 5000 });
      assert.equal(ast.status, 0, ast.stderr); assert.equal(ast.stdout, 'Module\n');
      const opened = program.indexOf('fd = os.open(path,'); const target = program.indexOf('target = os.readlink("/proc/self/fd/" + str(fd))');
      const beforeBytes = program.indexOf('data = os.read(fd, 65536)');
      assert.ok(opened > 0 && target > opened && beforeBytes > target);
      for (const check of ['stat.S_ISREG(os.fstat(fd).st_mode)', 'path not in selected or target != path', 'target.startswith("/artifacts/factory-output-") and target not in selected']) assert.ok(program.indexOf(check) > opened && program.indexOf(check) < beforeBytes);
      assert.equal((program.match(/os\.read\(fd,/g) ?? []).length, 1, 'one shared source loop, no second reader');
      assert.doesNotMatch(program, /eval\(|exec\(|subprocess|os\.write\(fd|unlink|remove|ftruncate/);
    }
  } finally { tools.close(); await f.close(); }
});
