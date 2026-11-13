import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parser } from './write-source-guard.fixture.js';
import { boundBashTools } from '../../src/sandbox/bash-tools.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { serveReadTools, connectReadTools, type GuestOwner, type ToolContext } from '../../src/sandbox/read-tools.js';

const context: ToolContext = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'builder',
  environmentRef: 'environment', bootRef: 'boot', phaseId: 'phase' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const qualified = { profileOrigin: 'factory-development-gondolin-0.14.0-stdin-capacity-v1' as const, copyOutput: true };
// Trusted, explicitly qualified VM receipt DOUBLE. This does NOT prove native
// SDK execution, kernel FD behavior, backpressure, physical cessation or durability.
async function fixture(run: (f: { records: Awaited<ReturnType<typeof createRecords>>; context: ToolContext;
  tools: Awaited<ReturnType<typeof connectReadTools>>; captured: () => Buffer; executions: () => number;
  signal: AbortController; peer: Awaited<ReturnType<typeof connectReadTools>>; helperSource: () => string; root: string;
  eof: Promise<void>; releaseResult: () => void; firstChunk: Promise<void>; resumeSource: () => void;
  eofCount: () => number; vm: GuestOwner; direct: ReturnType<typeof boundBashTools> }) => Promise<void>, caps: { profileOrigin?: 'factory-development-gondolin-0.14.0-stdin-capacity-v1'; copyOutput?: boolean } = qualified,
  mode: 'ok' | 'mismatch' | 'null' | 'partial' | 'late' | 'cancel' | 'held-result' | 'held-source' | 'incomplete' | 'extra' | 'stderr' | 'oversized' | 'nonzero' | 'guest-signal' | 'duplicate' | 'digest' = 'ok') {
  const root = await mkdtemp('/tmp/bc-');
  const records = await createRecords({ root });
  const signal = new AbortController();
  const chunks: Buffer[] = [];
  let executions = 0;
  let helperSource = '';
  let eofCount = 0;
  const eof = deferred(); const resultGate = deferred(); const firstChunk = deferred(); const sourceGate = deferred();
  const source = Buffer.from(('A€\ufeffsecret-Z'.repeat(30000)) + 'tail');
  const vm: GuestOwner = { exec(_argv, options) {
    executions++;
    if (typeof options.stdin === 'string') return {
      async *output() { for (let i = 0; i < source.length; i += 64001) yield { stream: 'stdout' as const, data: source.subarray(i, i + 64001) }; },
      result: Promise.resolve({ exitCode: 0 }),
    };
    helperSource = _argv[6]!;
    assert.deepEqual(_argv.slice(0, 6), ['/usr/bin/env', '-i', '/usr/bin/python3', '-I', '-S', '-c']);
    assert.deepEqual(options.stdinCapacity, { maxChunkBytes: 65536 });
    const result = mode === 'held-result' ? resultGate.promise.then(() => ({ exitCode: 0 })) : Promise.resolve({ exitCode: mode === 'null' ? null : mode === 'nonzero' ? 1 : 0, ...(mode === 'guest-signal' ? { signal: 9 } : {}) });
    return { result, async *output() {
      assert.ok(options.stdin && typeof options.stdin !== 'string');
      for await (const chunk of options.stdin) {
        assert.ok(Buffer.isBuffer(chunk) && chunk.length > 0 && chunk.length <= 65536);
        chunks.push(Buffer.from(chunk));
        if (mode === 'incomplete') break;
        if (mode === 'held-source' && chunks.length === 1) { firstChunk.resolve(); await sourceGate.promise; }
      }
      eofCount++; eof.resolve();
      const bytes = Buffer.concat(chunks);
      if (mode === 'late') records.registerSecret('new-after-eof');
      if (mode === 'cancel') signal.abort();
      const receipt = JSON.stringify({ bytes: bytes.length + (mode === 'mismatch' ? 1 : 0), sha256: mode === 'digest' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') });
      yield { stream: mode === 'stderr' ? 'stderr' as const : 'stdout' as const, data: Buffer.from(mode === 'duplicate' ? receipt.replace('{', '{"bytes":0,') : mode === 'partial' ? receipt.slice(0, -1) : mode === 'extra' ? receipt + receipt : mode === 'oversized' ? 'x'.repeat(8193) : receipt) };
    } };
  } };
  const endpoint = root + '/tools';
  const owner = await serveReadTools({ endpoint, records, context, signal: signal.signal, vm, ...caps });
  const tools = await connectReadTools(endpoint, context);
  const peer = await connectReadTools(endpoint, context);
  const direct = boundBashTools({ endpoint, records, context, signal: signal.signal, vm, ...caps }, () => !signal.signal.aborted, () => signal.abort());
  try { await run({ records, context, tools, captured: () => Buffer.concat(chunks), executions: () => executions, signal, peer, helperSource: () => helperSource, root,
    eof: eof.promise, releaseResult: resultGate.resolve, firstChunk: firstChunk.promise, resumeSource: sourceGate.resolve, eofCount: () => eofCount, vm, direct }); }
  finally { resultGate.resolve(); sourceGate.resolve(); peer.close(); tools.close(); await owner.close(); await rm(root, { recursive: true, force: true }); }
}

test('owner copies ALL just-completed Bash bytes through Records with current secrets and strict receipt', async () => {
  await fixture(async ({ records, tools, captured, eofCount }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    assert.ok(bash.bytes > 300000);
    records.registerSecret('secret-Z');
    records.registerSecret('tail-more'); // Forces the final tail through Records.finishTail.
    const result = await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
    assert.equal(result.status, 'success'); if (result.status !== 'success') return;
    const metadata = JSON.parse(Buffer.from(result.data, 'base64').toString());
    const expected = Buffer.from(('A€\ufeff█'.repeat(30000)) + 'tail');
    assert.deepEqual(captured(), expected); assert.equal(eofCount(), 1);
    assert.equal(metadata.bytes, expected.length);
    assert.equal(metadata.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.match(metadata.path, /^\/artifacts\/factory-output-[a-f0-9-]+\.txt$/);
    assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'replay' })).status, 'failure');
  });
});

for (const caps of [{}, { copyOutput: true }, { profileOrigin: qualified.profileOrigin }, { ...qualified, copyOutput: false }, { ...qualified, profileOrigin: 'legacy' as typeof qualified.profileOrigin }]) {
  test(`default deny policy/qualification ${JSON.stringify(caps)}`, async () => {
    await fixture(async ({ tools, executions }) => {
      const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
      assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
      const result = await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
      assert.equal(result.status, 'failure'); assert.equal(executions(), 1);
    }, caps);
  });
}
for (const mode of ['mismatch', 'null', 'partial', 'late', 'cancel', 'incomplete', 'extra', 'stderr', 'oversized', 'nonzero', 'guest-signal', 'duplicate', 'digest'] as const) {
  test(`copy rejects ${mode} without publication or retry`, async () => {
    await fixture(async ({ tools, executions }) => {
      const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
      assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
      assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' })).status, 'failure');
      assert.equal((await tools.executeTool({ name: 'write', operation: 'create', path: '/artifacts/peer', content: '', callId: 'peer' })).status, 'failure');
      assert.equal(executions(), 2);
    }, qualified, mode);
  });
}

test('slot binds all context fields; unknown/foreign/raw refs and older Bash are denied before effects', async () => {
  await fixture(async ({ records, tools, executions, direct }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    const directBash = await direct(context, { name: 'bash', command: 'direct-owned', callId: 'direct-bash' }, async () => {});
    assert.equal(directBash.status, 'success'); if (directBash.status !== 'success') return;
    for (const key of Object.keys(context) as (keyof ToolContext)[]) {
      const wrong = { ...context, [key]: key === 'role' ? 'spec' : 'foreign' };
      assert.equal((await direct(wrong, { name: 'bash', operation: 'copy-output', reference: directBash.reference, callId: 'wrong' }, async () => {})).status, 'failure');
    }
    assert.equal(executions(), 2, 'mismatched contexts never invoke guest copy');
    for (const reference of [{ ...bash.reference, workId: 'foreign' }, { workId: 'work', id: '00000000-0000-4000-8000-000000000001' }]) {
      assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference, callId: 'unknown' })).status, 'failure');
    }
    const { phaseId: _phase, ...captureContext } = context;
    const raw = await records.openOutput({ ...captureContext, callId: 'raw' }, { format: 'raw', maxBytes: 10 });
    await raw.write(Buffer.from('raw')); const rawCapture = await raw.finish();
    assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: rawCapture.reference, callId: 'raw-copy' })).status, 'failure');
    await tools.executeTool({ name: 'bash', command: 'new', callId: 'new' }, () => {});
    assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'old' })).status, 'failure');
    assert.equal(executions(), 3);
  });
});

test('parallel peer spends slot once and new secret while guest result held forbids publication', async () => {
  await fixture(async ({ tools, peer, records, eof, releaseResult, executions }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    const pending = tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
    await eof;
    assert.equal((await peer.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'parallel' })).status, 'failure');
    records.registerSecret('late-guest-result'); releaseResult();
    assert.equal((await pending).status, 'failure'); assert.equal(executions(), 2);
  }, qualified, 'held-result');
});

test('late secret while asynchronous mutation result persistence waits rejects metadata publication', async () => {
  await fixture(async ({ tools, records }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    const entered = deferred(); const release = deferred();
    const record = records.record.bind(records);
    records.record = async (binding, event) => {
      if ((event as { status?: string }).status === 'guest-receipt-observed') { entered.resolve(); await release.promise; }
      return record(binding, event);
    };
    try {
      const pending = tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
      await entered.promise; records.registerSecret('late-result-evidence'); release.resolve();
      assert.equal((await pending).status, 'failure');
    } finally { release.resolve(); records.record = record; }
  });
});

test('uncertain evidence hold revokes peer Write/Edit/Bash synchronously BEFORE release', async () => {
  await fixture(async ({ tools, peer, records, executions }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    const entered = deferred(); const release = deferred(); const record = records.record.bind(records);
    records.record = async (binding, event) => {
      if ((event as { status?: string }).status === 'effects-unknown-no-retry') { entered.resolve(); await release.promise; }
      return record(binding, event);
    };
    try {
      const pending = tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
      await entered.promise;
      assert.equal((await peer.executeTool({ name: 'write', operation: 'create', path: '/artifacts/peer', content: '', callId: 'peer' })).status, 'failure');
      assert.equal((await peer.executeTool({ name: 'edit-source', operation: 'capture', path: '/artifacts/peer', callId: 'edit' })).status, 'failure');
      assert.equal((await peer.executeTool({ name: 'bash', command: 'peer', callId: 'peer-bash' }, () => {})).status, 'failure');
      assert.equal(executions(), 2); release.resolve(); assert.equal((await pending).status, 'failure');
    } finally { release.resolve(); records.record = record; }
  }, qualified, 'mismatch');
});

test('source failure midstream leaves partial bytes uncertain and never publishes path', async () => {
  await fixture(async ({ tools, root, firstChunk, resumeSource, captured }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    const pending = tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
    await firstChunk;
    await rm(`${root}/work/evidence/${bash.reference.id}/output`);
    resumeSource(); assert.equal((await pending).status, 'failure');
    assert.ok(captured().length > 0 && captured().length < bash.bytes);
  }, qualified, 'held-source');
});

test('shared exclusive stream helper SOURCE AST checks before create/data, with unsafe mutants', async () => {
  await fixture(async ({ tools, helperSource }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' })).status, 'success');
    const source = helperSource();
    const check = (candidate: string) => spawnSync('/usr/bin/python3', ['-I', '-S', '-c', parser, 'stream'], { input: candidate, encoding: 'utf8', timeout: 5000 });
    const valid = check(source); assert.equal(valid.status, 0, valid.stderr); assert.match(valid.stdout, /guest BODY NOT executed/);
    for (const unsafe of [source.replace('os.O_EXCL', 'os.O_TRUNC'), source.replace('parts[1], flags', 'parts[1], os.O_RDONLY'),
      source.replace('authorize(parent)\n        leaf', 'leaf'), source.replace('authorize(fd, regular=True)', 'authorize(fd)'),
      source.replace('authorize(parent)\n        count = 0', 'count = 0'), source.replace('dir_fd=parent)', 'dir_fd=base)'),
      source.replace('os.O_NONBLOCK | ', ''), source.replace('target = os.readlink("/proc/self/fd/" + str(fd))', 'target = "/artifacts/claimed"'),
      source.replace('digest.update(data[:written])', 'digest.update(data)'), source.replace('count > 9007199254740991', 'count > 99999999999999999999')]) {
      assert.notEqual(unsafe, source); assert.notEqual(check(unsafe).status, 0, 'AST checker must reject unsafe mutation');
    }
  });
});

for (const role of ['spec', 'standards'] as const) {
  test(`${role} cannot use copy even with true trusted host policy`, async () => {
    await fixture(async ({ records, signal, vm, executions }) => {
      const ownContext = { ...context, role };
      const own = boundBashTools({ context: ownContext, records, signal: signal.signal, vm, endpoint: '/unused', ...qualified }, () => true, () => signal.abort());
      const result = await own(ownContext, { name: 'bash', operation: 'copy-output', reference: { workId: 'work', id: '00000000-0000-4000-8000-000000000001' }, callId: 'copy' }, async () => {});
      assert.deepEqual(result, { status: 'failure', code: 'BASH_ROLE_DENIED' }); assert.equal(executions(), 0);
    });
  });
}

test('policy spoof in tool JSON cannot grant copy or qualify SDK', async () => {
  await fixture(async ({ tools, executions }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    const spoof = { name: 'bash' as const, operation: 'copy-output' as const, reference: bash.reference, callId: 'spoof', ...qualified };
    assert.deepEqual(await tools.executeTool(spoof), { status: 'failure', code: 'INVALID_TOOL_CALL' });
    assert.equal(executions(), 1);
  }, {});
});

test('result persistence failure cannot become success and revokes peer mutation', async () => {
  await fixture(async ({ tools, peer, records, executions }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    const record = records.record.bind(records);
    records.record = async (binding, event) => {
      if ((event as { status?: string }).status === 'guest-receipt-observed') throw new Error('owned fixture persistence failure');
      return record(binding, event);
    };
    try {
      assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' })).status, 'failure');
      assert.equal((await peer.executeTool({ name: 'write', operation: 'create', path: '/artifacts/peer', content: '', callId: 'peer' })).status, 'failure');
      assert.equal(executions(), 2);
    } finally { records.record = record; }
  });
});

test('secret-bearing generated metadata cannot report success', async () => {
  await fixture(async ({ tools, records }) => {
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    records.registerSecret('factory-output-');
    assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' })).status, 'failure');
  });
});

test('trusted policy is snapshotted, not a mutable caller claim', async () => {
  const caps = { ...qualified };
  await fixture(async ({ tools }) => {
    caps.copyOutput = false;
    const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
    assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
    assert.equal((await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' })).status, 'success');
  }, caps);
});

test('actual adapter SOURCE stamps verified private SDK origin into same VM owner seam only', async () => {
  // Source inspection only. Never imports/evaluates the SDK, invokes adapter boot,
  // or treats the test receipt DOUBLE as native qualification evidence.
  const source = await readFile(new URL('../../../src/sandbox/adapter.ts', import.meta.url), 'utf8');
  const selected = source.indexOf('await loadDevelopmentGondolinSdk()');
  const stamped = source.indexOf("const profileOrigin = 'factory-development-gondolin-0.14.0-stdin-capacity-v1' as const");
  const created = source.indexOf('vm = await VM.create(');
  const registered = source.indexOf('readTools = await serveOwnerRegistration(');
  assert.ok(selected > 0 && selected < stamped && stamped < created && created < registered);
  assert.match(source.slice(registered), /bootRef: boot }, vm,\s*\{[^;]+runtimeDirectory: runtime.directory }, \{ profileOrigin, copyOutput: true }\)/);
  // Boot availability alone is not per-invocation selection. Executable launch
  // policy tests separately prove absent/false and context-only default deny.
  assert.equal(source.match(/copyOutput: true/g)?.length, 1);
});
