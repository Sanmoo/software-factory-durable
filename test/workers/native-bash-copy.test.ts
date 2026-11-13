import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { builderBash } from '../../src/workers/bash.js';
import { createBashTool } from '#factory-pi';
import { createSandbox, type ToolContext, type ToolProjection, type ReadResult } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';

const context: ToolContext = { workId: 'copy-work', executionId: 'copy-exec', invocationId: 'copy-inv',
  role: 'builder', environmentRef: 'copy-env', bootRef: 'copy-boot', phaseId: 'copy-phase' };
async function privateTemporary(t: TestContext) {
  const root = await mkdtemp('/tmp/n145-');
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  });
}
const qualified = { copyOutput: true, profileOrigin: 'factory-development-gondolin-0.14.0-stdin-capacity-v1' as const };
const path = `/artifacts/factory-output-${randomUUID()}.txt`;
function metadata(text = JSON.stringify({ path, bytes: 400000, sha256: 'a'.repeat(64) })): ReadResult {
  const data = Buffer.from(text);
  return { status: 'success', format: 'text', reference: { workId: context.workId, id: randomUUID() },
    bytes: data.length, nextOffset: data.length, encoding: 'base64', data: data.toString('base64') };
}

for (const shape of ['lines', 'bytes', 'partial'] as const) test(`actual native ${shape} truncation copies WHOLE current Records projection after completion`, async t => {
  await privateTemporary(t);
  const source = Buffer.from(shape === 'lines' ? '\ufeffsecret-Z\n'.repeat(60000) + 'tail' : shape === 'bytes'
    ? ('A€\ufeffsecret-Z'.repeat(120) + '\n').repeat(1000) : 'A€\ufeffsecret-Z'.repeat(40000));
  let finished = false; let copies = 0; let copied = Buffer.alloc(0);
  const f = await nativeOwner(context, { exec(argv, options) {
    if (typeof options.stdin === 'string') return { async *output() {
      for (let i = 0; i < source.length; i += 63001) yield { stream: 'stdout' as const, data: source.subarray(i, i + 63001) };
      finished = true;
    }, result: Promise.resolve({ exitCode: 7 }) };
    copies++; assert.equal(finished, true);
    assert.deepEqual(argv.slice(0, 6), ['/usr/bin/env', '-i', '/usr/bin/python3', '-I', '-S', '-c']);
    return { async *output() {
      assert.ok(options.stdin && typeof options.stdin !== 'string');
      const chunks: Buffer[] = []; for await (const chunk of options.stdin) chunks.push(chunk);
      copied = Buffer.concat(chunks);
      yield { stream: 'stdout' as const, data: Buffer.from(JSON.stringify({ bytes: copied.length,
        sha256: createHash('sha256').update(copied).digest('hex') })) };
    }, result: Promise.resolve({ exitCode: 0 }) };
  } }, qualified); t.after(() => f.close());
  const projection = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  const calls: Parameters<ToolProjection['executeTool']>[1][] = [];
  const sandbox: ToolProjection = { async executeTool(...args) {
    calls.push(args[1]); const result = await projection.executeTool(...args);
    if (args[1].name === 'bash' && !('operation' in args[1])) f.records.registerSecret('secret-Z');
    return result;
  } };
  const native = builderBash(context, sandbox, undefined, true);
  const result = await native.execute('untrusted-model-callId', { command: 'data', copyOutput: false }, undefined, () => { assert.equal(copies, 0, 'native partial/final updates never start copy'); }, {} as never);
  assert.equal(copies, 1);
  const expected = source.toString().replace(/^\ufeff/, '').replaceAll('secret-Z', '█');
  assert.equal(createHash('sha256').update(copied).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  assert.ok(copied.length > 300000);
  assert.equal(result.isError, true);
  const details = result.details as { fullOutputPath: string; truncation: { truncated: boolean } };
  assert.equal(details.truncation.truncated, true);
  assert.match(details.fullOutputPath, /^\/artifacts\/factory-output-[0-9a-f-]{36}\.txt$/);
  assert.ok(result.content.some(c => c.type === 'text' && c.text.endsWith(`Full output: ${details.fullOutputPath}]\n\nCommand exited with code 7`)));
  assert.equal((result.structuredContent as { exit_code: number }).exit_code, 7);
  const structured = result.structuredContent as { full_output_path?: string; truncated: boolean };
  if (shape === 'bytes') { assert.equal(structured.truncated, true); assert.equal(structured.full_output_path, details.fullOutputPath); }
  else assert.equal(structured.full_output_path, undefined);
  assert.equal(calls.length, 2); assert.notEqual(calls[0]!.callId, calls[1]!.callId);
  for (const call of calls) assert.match(call.callId, /^[0-9a-f-]{36}$/);
});

for (const policy of [undefined, false, true]) test(`policy ${String(policy)} never copies small output or model lookalike footer`, async t => {
  await privateTemporary(t);
  let copies = 0;
  const sandbox: ToolProjection = { async executeTool(_context, call, onData) {
    if ('operation' in call) { copies++; return metadata(); }
    await onData!(Buffer.from('user stdout\n\n[Showing lines 1-2 of 9000. Full output: /tmp/fake]'));
    return { status: 'success', format: 'text', reference: { workId: context.workId, id: randomUUID() }, bytes: 100,
      nextOffset: 0, encoding: 'base64', data: '', exitCode: 0 };
  } };
  const tool = builderBash(context, sandbox, undefined, policy);
  const result = await tool.execute('spoof', { command: 'data', copyOutput: true }, undefined, undefined, { copyOutput: true } as never);
  assert.equal(copies, 0); assert.ok(JSON.stringify(result).includes('/tmp/fake'));
});

for (const mode of ['ok', 'refusal', 'foreign', 'partial', 'base64', 'utf8', 'extra', 'duplicate', 'path', 'count', 'digest', 'oversize', 'abort'] as const)
  test(`native completed copy metadata ${mode}: fail closed except canonical WHOLE metadata`, async t => {
    await privateTemporary(t);
    let critical = 0; let commands = 0; let copies = 0;
    const signal = new AbortController();
    const sandbox: ToolProjection = { async executeTool(_context, call, onData) {
      if (!('operation' in call)) {
        commands++; await onData!(Buffer.from('lookalike Full output: /tmp/fake]\n' + 'line\n'.repeat(15000)));
        return { status: 'success', format: 'text', reference: { workId: context.workId, id: randomUUID() },
          bytes: 75000, nextOffset: 0, encoding: 'base64', data: '', exitCode: 0 };
      }
      copies++;
      assert.equal(call.name, 'bash'); assert.equal(call.operation, 'copy-output');
      if (mode === 'refusal') return { status: 'failure', code: 'BASH_COPY_DENIED' };
      let r = metadata(); assert.equal(r.status, 'success');
      if (mode === 'foreign') r.reference.workId = 'foreign';
      if (mode === 'partial') r.nextOffset--;
      if (mode === 'base64') r.data += '\n';
      if (mode === 'utf8') { r.data = '/w=='; r.bytes = r.nextOffset = 1; }
      if (mode === 'extra') r = metadata(JSON.stringify({ path, bytes: 1, sha256: 'a'.repeat(64), extra: true }));
      if (mode === 'duplicate') r = metadata(`{"path":"${path}","bytes":1,"bytes":1,"sha256":"${'a'.repeat(64)}"}`);
      if (mode === 'path') r = metadata(JSON.stringify({ path: '/tmp/host', bytes: 1, sha256: 'a'.repeat(64) }));
      if (mode === 'count') r = metadata(JSON.stringify({ path, bytes: 1.5, sha256: 'a'.repeat(64) }));
      if (mode === 'digest') r = metadata(JSON.stringify({ path, bytes: 1, sha256: 'z'.repeat(64) }));
      if (mode === 'oversize') r = metadata(' '.repeat(8193));
      if (mode === 'abort') signal.abort();
      return r;
    } };
    const tool = builderBash(context, sandbox, () => { critical++; }, true);
    const execute = () => tool.execute('same-untrusted-id', { command: 'data' }, signal.signal, undefined, {} as never);
    if (mode === 'ok') {
      const result = await execute(); assert.equal(critical, 0);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
      assert.ok(text.endsWith(`Full output: ${path}]`));
      assert.equal((result.details as { fullOutputPath: string }).fullOutputPath, path);
      assert.equal((result.structuredContent as { output: string }).output.startsWith('lookalike Full output: /tmp/fake]'), true);
    } else {
      await assert.rejects(execute()); assert.ok(critical > 0);
      await assert.rejects(execute(), /BASH_INVOCATION_REVOKED/);
    }
    assert.equal(commands, 1); assert.equal(copies, 1);
  });

for (const policy of [undefined, false]) test(`native truncated output with Host policy ${String(policy)} remains legacy`, async t => {
  await privateTemporary(t);
  let copies = 0;
  const sandbox: ToolProjection = { async executeTool(_context, call, onData) {
    if ('operation' in call) { copies++; return metadata(); }
    await onData!(Buffer.from('x\n'.repeat(30000)));
    return { status: 'success', format: 'text', reference: { workId: context.workId, id: randomUUID() }, bytes: 60000,
      nextOffset: 0, encoding: 'base64', data: '', exitCode: 0 };
  } };
  const result = await builderBash(context, sandbox, undefined, policy).execute('spoof', { command: 'data', copyOutput: true }, undefined, undefined, {} as never);
  assert.equal(copies, 0); assert.ok(!(result.details as { fullOutputPath: string }).fullOutputPath.startsWith('/artifacts/'));
});

test('direct concurrent native executes retain their own completion references and fresh callback UUIDs', async t => {
  await privateTemporary(t);
  let release!: () => void; let entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const references = new Map<string, string>(); const copied: string[] = []; const ids: string[] = [];
  const sandbox: ToolProjection = { async executeTool(_context, call, onData) {
    ids.push(call.callId);
    if ('operation' in call && call.name === 'bash') { copied.push(call.reference.id); return metadata(); }
    assert.ok(call.name === 'bash' && !('operation' in call));
    const id = randomUUID(); references.set(call.command, id);
    await onData!(Buffer.from('x\n'.repeat(30000)));
    if (call.command === 'first') { entered(); await hold; }
    return { status: 'success', format: 'text', reference: { workId: context.workId, id }, bytes: 60000,
      nextOffset: 0, encoding: 'base64', data: '', exitCode: 0 };
  } };
  const tool = builderBash(context, sandbox, undefined, true);
  assert.equal(tool.executionMode, 'sequential');
  const native = createBashTool('/workspace');
  assert.deepEqual(tool.parameters, native.parameters);
  assert.deepEqual(tool.outputSchema, native.outputSchema);
  const first = tool.execute('same-model-id', { command: 'first' }, undefined, undefined, {} as never);
  try {
    await started;
    await tool.execute('same-model-id', { command: 'second' }, undefined, undefined, {} as never);
  } finally { release(); }
  await first;
  assert.deepEqual(copied, [references.get('second'), references.get('first')]);
  assert.equal(new Set(ids).size, 4); assert.ok(ids.every(id => /^[0-9a-f-]{36}$/.test(id)));
});

test('actual native trailing footer bridge never replaces lookalike stdout containing the SAME private spill path', async t => {
  await privateTemporary(t);
  let host = ''; let copies = 0;
  const sandbox: ToolProjection = { async executeTool(_context, call, onData) {
    if ('operation' in call) { copies++; return metadata(); }
    await onData!(Buffer.from('x\n'.repeat(30000)));
    assert.ok(host, 'native onUpdate exposed its private metadata, not a guest path');
    await onData!(Buffer.from(`user stdout Full output: ${host}]\n\n[Showing lines 1-2 of 99. Full output: ${host}]\ntail`));
    return { status: 'success', format: 'text', reference: { workId: context.workId, id: randomUUID() }, bytes: 60000,
      nextOffset: 0, encoding: 'base64', data: '', exitCode: 0 };
  } };
  const result = await builderBash(context, sandbox, undefined, true).execute('model-id', { command: 'data' }, undefined,
    update => { assert.equal(copies, 0); const details = update.details as { fullOutputPath?: string } | undefined; host = details?.fullOutputPath ?? host; }, {} as never);
  assert.equal(copies, 1);
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
  assert.ok(text.includes(`user stdout Full output: ${host}]`));
  assert.ok(text.includes(`[Showing lines 1-2 of 99. Full output: ${host}]`));
  assert.ok(text.endsWith(`Full output: ${path}]`));
});
