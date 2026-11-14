import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderBash } from '../../src/workers/bash.js';

const context: ToolContext = { workId: 'bash-work', executionId: 'bash-exec', invocationId: 'bash-invocation',
  role: 'builder', environmentRef: 'bash-env', bootRef: 'bash-boot', phaseId: 'bash-phase' };

test('native Bash custom exec streams ordered protected UTF-8 fragments including finish tail', async t => {
  const source = Buffer.from('α synthetic-secret stderr π tail');
  let streamFinished = false;
  let liveUpdate = false;
  const f = await nativeOwner(context, { exec(argv, options) {
    assert.deepEqual(argv, ['/usr/bin/env', '-i', 'GIT_AUTHOR_NAME=Software Factory Builder', 'GIT_AUTHOR_EMAIL=software-factory-builder@users.noreply.invalid', 'GIT_COMMITTER_NAME=Software Factory Builder', 'GIT_COMMITTER_EMAIL=software-factory-builder@users.noreply.invalid', '/bin/bash', '-c', 'model command is data'], 'fixed Factory commit identity, never the model\'s or a human\'s');
    assert.deepEqual(options.env, {}); assert.equal(options.cwd, '/workspace');
    assert.equal(options.stderr, 'pipe');
    return { async *output() { for (let i = 0; i < source.length; i++) yield {
      stream: i % 2 ? 'stderr' as const : 'stdout' as const, data: source.subarray(i, i + 1),
    }; streamFinished = true; }, result: Promise.resolve({ exitCode: 7 }) };
  } }); t.after(() => f.close());
  const sentinel = join(f.root, 'host-model-sentinel'); await writeFile(sentinel, 'untouched', { mode: 0o600 });
  const updates: string[] = [];
  const native = builderBash(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const result = await native.execute('bash-call', { command: 'model command is data' }, undefined,
    update => {
      updates.push(JSON.stringify(update));
      if (!streamFinished && update.content.some(block => block.type === 'text' && block.text.length > 0)) liveUpdate = true;
    }, { cwd: sentinel } as never);
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  const text = JSON.stringify(result);
  assert.ok(text.includes('α █ stderr π tail')); assert.equal(text.includes('synthetic-secret'), false);
  assert.equal(updates.join('').includes('synthetic-secret'), false); assert.equal(liveUpdate, true);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { exit_code: number }).exit_code, 7);
});

test('native UTF-8/secret source literal fragments survive EVERY byte cut across stdout/stderr and finish tail', async t => {
  const secret = 'segredo-🔒-ação';
  const source = Buffer.from('α ' + secret + ' π ' + secret);
  let cut = 0;
  const f = await nativeOwner(context, { exec() {
    return { async *output() {
      yield { stream: 'stdout' as const, data: source.subarray(0, cut) };
      yield { stream: 'stderr' as const, data: source.subarray(cut) };
    }, result: Promise.resolve({ exitCode: 0 }) };
  } }); t.after(() => f.close()); f.records.registerSecret(secret);
  const native = builderBash(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  for (cut = 0; cut <= source.length; cut++) {
    const result = await native.execute(`cut-${cut}`, { command: "printf 'seg''redo'" }, undefined, undefined, {} as never);
    assert.equal((result.structuredContent as { output: string }).output, 'α █ π █', `cut ${cut}`);
  }
  for (const entry of await readdir(f.root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.equal((await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(secret)), false);
  }
});

test('native tail and 1MiB structured readFullOutput use REAL protected HOST spill, not guest paths', async t => {
  const source = Buffer.from('head synthetic-secret\n' + 'protected output\n'.repeat(75000) + 'tail π');
  const f = await nativeOwner(context, { exec() {
    return { async *output() { for (let i = 0; i < source.length; i += 65536) yield {
      stream: 'stdout' as const, data: source.subarray(i, i + 65536),
    }; }, result: Promise.resolve({ exitCode: 0 }) };
  } }); t.after(() => f.close());
  const previous = process.env.TMPDIR; process.env.TMPDIR = f.root;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  const native = builderBash(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  const result = await native.execute('spill', { command: 'output only' }, undefined, undefined, {} as never);
  const structured = result.structuredContent as { output: string; truncated: boolean; full_output_path: string; exit_code: number };
  assert.equal(structured.exit_code, 0); assert.equal(structured.truncated, true);
  assert.match(structured.output, /^head █/); assert.match(structured.output, /bytes omitted/); assert.match(structured.output, /tail π$/);
  assert.ok(Buffer.byteLength(structured.output) <= 1024 * 1024 + 100);
  const details = result.details as { fullOutputPath: string; truncation: { truncated: boolean } };
  assert.equal(details.truncation.truncated, true); assert.equal(details.fullOutputPath, structured.full_output_path);
  assert.ok(details.fullOutputPath.startsWith(f.root + '/')); assert.equal((await stat(details.fullOutputPath)).mode & 0o777, 0o600);
  const full = await readFile(details.fullOutputPath, 'utf8');
  assert.equal(full, source.toString().replace('synthetic-secret', '█'));
});

for (const mode of ['null-exit', 'timeout', 'abort', 'callback-failure'] as const) test(`native Bash ${mode} revokes future calls; effects remain UNKNOWN`, async t => {
  let calls = 0;
  let abortRequested = false;
  const cancellation = new AbortController();
  const f = await nativeOwner(context, { exec(_argv, options) {
    calls++;
    const stopped = new Promise<void>(resolve => options.signal.addEventListener('abort', () => { abortRequested = true; resolve(); }, { once: true }));
    return { async *output() {
      if (mode === 'timeout' || mode === 'abort') {
        if (mode === 'abort') cancellation.abort();
        await stopped;
      } else yield { stream: 'stdout' as const, data: Buffer.from('safe output\n'.repeat(500)) };
    }, result: Promise.resolve({ exitCode: mode === 'null-exit' ? null : 0 }) };
  } }); t.after(() => f.close());
  let critical = 0;
  const native = builderBash(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical++; });
  await assert.rejects(native.execute('critical', { command: 'effect', ...(mode === 'timeout' ? { timeout: 0.01 } : {}) },
    cancellation.signal, mode === 'callback-failure' ? update => {
      if (JSON.stringify(update).includes('safe output')) throw new Error('synthetic-secret');
    } : undefined, {} as never),
    mode === 'timeout' ? /Command timed out/ : mode === 'abort' ? /Command aborted/ : /BASH_EFFECTS_OR_CAPTURE_UNKNOWN/);
  assert.ok(critical > 0);
  await assert.rejects(native.execute('dependent', { command: 'never retry' }, undefined, undefined, {} as never), /BASH_INVOCATION_REVOKED/);
  assert.equal(calls, 1);
  if (mode === 'timeout') assert.equal(abortRequested, true, 'abort requested; external double proves no physical cessation');
});

test('Bash role forging, stale phase/boot and administrative names cannot reach the VM', async t => {
  const f = await nativeOwner(context, { exec() { assert.fail('unauthorized guest execution'); } }); t.after(() => f.close());
  const sandbox = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  const call = { name: 'bash' as const, command: 'denied', callId: 'deny' };
  for (const forged of [{ ...context, role: 'standards' as const }, { ...context, phaseId: 'stale' }, { ...context, bootRef: 'stale' }]) {
    assert.equal((await sandbox.executeTool(forged, call)).status, 'failure');
  }
  assert.equal((await sandbox.executeTool(context, { ...call, name: 'stop' } as never)).status, 'failure');
});

test('native Bash rejects invalid timeouts before guest execution', async t => {
  const f = await nativeOwner(context, { exec() { assert.fail('invalid timeout reached guest'); } }); t.after(() => f.close());
  const native = builderBash(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }));
  for (const timeout of [0, -1, NaN, Infinity, 2147483.648]) {
    await assert.rejects(native.execute('bad-timeout', { command: 'anything', timeout }, undefined, undefined, {} as never), /Invalid timeout/);
  }
});
