import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createEditTool, type ToolDefinition } from '#factory-pi';
import { createSandbox, type ToolContext, type ToolProjection } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderEdit, captureRefusal } from '../../src/workers/edit.js';
import { sourceShape } from '../architecture/source-text.js';

const context: ToolContext = {
  workId: 'edit-work',
  executionId: 'edit-exec',
  invocationId: 'edit-invocation',
  role: 'builder',
  environmentRef: 'edit-env',
  bootRef: 'edit-boot',
  phaseId: 'edit-phase',
};
const run = (tool: ToolDefinition, id: string, input: unknown, signal?: AbortSignal) => tool.execute(id, input, signal, undefined, undefined as never);
const operation = (call: Parameters<ToolProjection['executeTool']>[1] | undefined) => (call && 'operation' in call ? call.operation : undefined);
const args = (oldText = 'old', newText = 'new', path = 'source') => ({ path, edits: [{ oldText, newText }] });
async function fixture(t: { after(fn: () => Promise<void>): void }, original: string | Buffer = 'old') {
  let virtual = Buffer.from(original);
  let outcome: number | null = 0;
  let partial = false;
  let onCommit = () => {};
  let onCapture = () => {};
  let captureGate = Promise.resolve();
  let captureExit = 0;
  const calls: string[][] = [];
  const f = await nativeOwner(
    context,
    {
      exec(argv, options) {
        calls.push(argv);
        const commit = argv[5] === 'commit';
        const captured = Buffer.from(virtual);
        let exitCode = outcome;
        if (!commit) onCapture();
        if (commit) {
          onCommit();
          if (outcome === 0 && (Number(argv[7]) !== virtual.length || argv[8] !== createHash('sha256').update(virtual).digest('hex'))) exitCode = 42;
          if (exitCode === 0) {
            assert.equal(typeof options.stdin, 'string');
            if (typeof options.stdin !== 'string') throw new Error('fixture expects text stdin');
            virtual = Buffer.from(options.stdin);
            if (partial) {
              virtual = virtual.subarray(0, 1);
              exitCode = 1;
            }
          }
        }
        return {
          async *output() {
            if (!commit) {
              await captureGate;
              yield { stream: 'stdout' as const, data: captured };
            }
          },
          result: Promise.resolve({ exitCode: commit ? exitCode : captureExit }),
        };
      },
    },
    { editSourceMaxBytes: 8192 },
  );
  t.after(() => f.close());
  const projection = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  const wire: Parameters<ToolProjection['executeTool']>[1][] = [];
  const sandbox: ToolProjection = {
    executeTool(ctx, call, onData, signal) {
      wire.push(call);
      return projection.executeTool(ctx, call, onData, signal);
    },
  };
  let critical = 0;
  const tool = builderEdit(context, sandbox, () => {
    critical++;
  });
  return {
    ...f,
    tool,
    sandbox,
    wire,
    calls,
    get critical() {
      return critical;
    },
    get text() {
      return virtual.toString();
    },
    change(text: string) {
      virtual = Buffer.from(text);
    },
    outcome(code: number | null) {
      outcome = code;
    },
    partial() {
      partial = true;
    },
    captureExit(code: number) {
      captureExit = code;
    },
    holdCapture(gate: Promise<void>) {
      captureGate = gate;
    },
    onCommit(fn: () => void) {
      onCommit = fn;
    },
    onCapture(fn: () => void) {
      onCapture = fn;
    },
  };
}

test('real owner pending capture serializes different paths, releases unused sources and stays usable', async t => {
  const f = await fixture(t);
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  f.holdCapture(
    new Promise<void>(resolve => {
      release = resolve;
    }),
  );
  f.onCapture(enter);
  const a = assert.rejects(run(f.tool, 'first', args('missing', 'new', 'first')), /Could not find/);
  await entered;
  const b = assert.rejects(run(f.tool, 'second', args('missing', 'new', 'second')), /Could not find/);
  const both = Promise.all([a, b]);
  // Attach before yielding so the baseline rejection is observed, not unhandled.
  void both.catch(() => {});
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    release();
  }
  await both;
  assert.equal(f.critical, 0);
  assert.equal(f.wire.filter(c => operation(c) === 'release').length, 2);
  await run(f.tool, 'fresh', args());
  assert.equal(f.text, 'new');
});

test('queued cancellation denies RPC, revokes following waiters, and cleanup waits for settlement', async t => {
  const f = await fixture(t);
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  f.holdCapture(
    new Promise<void>(resolve => {
      release = resolve;
    }),
  );
  f.onCapture(enter);
  const first = assert.rejects(run(f.tool, 'first', args('missing', 'new', 'first')), /REVOKED/);
  await entered;
  const cancelled = new AbortController();
  const second = assert.rejects(run(f.tool, 'cancel', args('missing', 'new', 'cancel'), cancelled.signal), /aborted/);
  const third = assert.rejects(run(f.tool, 'third', args('missing', 'new', 'third')), /REVOKED/);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    cancelled.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.wire.length, 1, 'no release or queued RPC before actual settlement');
  } finally {
    release();
  }
  await Promise.all([first, second, third]);
  assert.deepEqual(f.wire.map(operation), ['capture', 'release']);
  assert.equal(f.critical, 1);
});

test('cancelled queued commit is not spent and releases its unused capture', async t => {
  const f = await fixture(t);
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let captures = 0;
  f.onCapture(() => {
    if (++captures === 2) {
      f.holdCapture(gate);
      enter();
    }
  });
  const cancelled = new AbortController();
  let blocker: Promise<void> | undefined;
  let tool: ToolDefinition;
  tool = builderEdit(context, {
    async executeTool(ctx, call, onData, signal) {
      const result = await f.sandbox.executeTool(ctx, call, onData, signal);
      if (call.name === 'edit-source' && call.operation === 'page' && call.path.endsWith('/first')) {
        // Queue another path's capture ahead of this path's upcoming commit.
        blocker = assert.rejects(run(tool, 'blocker', args('missing', 'new', 'blocker')), /REVOKED/);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return result;
    },
  });
  const first = assert.rejects(run(tool, 'first', args('old', 'new', 'first'), cancelled.signal), /aborted/);
  await entered;
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    cancelled.abort();
    assert.deepEqual(f.wire.map(operation), ['capture', 'page', 'capture']);
  } finally {
    release();
  }
  await Promise.all([first, blocker]);
  assert.equal(
    f.wire.some(c => operation(c) === 'commit'),
    false,
  );
  assert.equal(f.wire.filter(c => operation(c) === 'release').length, 2);
  assert.equal(f.text, 'old');
});

test('technical admission bound rejects before RPC without poisoning accepted executions', async t => {
  const f = await fixture(t);
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  f.holdCapture(
    new Promise<void>(resolve => {
      release = resolve;
    }),
  );
  f.onCapture(enter);
  const pending = [assert.rejects(run(f.tool, 'first', args('missing', 'new', 'first')), /Could not find/)];
  await entered;
  try {
    for (let i = 1; i < 16; i++) pending.push(assert.rejects(run(f.tool, String(i), args('missing', 'new', `path-${i}`)), /Could not find/));
    await assert.rejects(run(f.tool, 'overflow', args('missing', 'new', 'overflow')), /EDIT_ADMISSION_FULL/);
    assert.equal(f.wire.length, 1);
    assert.equal(f.critical, 0);
  } finally {
    release();
  }
  await Promise.all(pending);
  assert.equal(f.wire.filter(c => operation(c) === 'release').length, 16);
  assert.equal(f.critical, 0);
  await run(f.tool, 'fresh', args());
});

test('actual Native Edit schema/diff, multiple edits, BOM/mixed EOL/multibyte and full replacement via real Q5', async t => {
  const original = '\uFEFFold\r\nkeep\n世界\r\nend';
  const f = await fixture(t, original);
  const input = {
    path: 'source',
    edits: [
      { oldText: 'old\n', newText: 'new\n' },
      { oldText: '世界', newText: 'é' },
    ],
  };
  let expected = original;
  const options: NonNullable<Parameters<typeof createEditTool>[1]> & { mutationQueueMode: 'lexical' } = {
    mutationQueueMode: 'lexical',
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(original),
      writeFile: async (_path, text) => {
        expected = text;
      },
    },
  };
  const native = createEditTool('/workspace', options);
  assert.deepEqual(f.tool.parameters, native.parameters);
  const expectedResult = await native.execute('native', input);
  assert.deepEqual(await run(f.tool, 'native:'.repeat(100), input), expectedResult);
  assert.equal(f.text, expected);
  assert.equal(f.text, '\uFEFFnew\r\nkeep\né\r\nend');
  assert.deepEqual(
    f.wire.map(c => ('operation' in c ? c.operation : '')),
    ['capture', 'page', 'commit'],
  );
  assert.equal(new Set(f.wire.map(c => c.callId)).size, 3);
  for (const call of f.wire) assert.match(call.callId, /^[0-9a-f-]{36}$/);
  assert.equal(f.critical, 0);
});

test('noMatch/ambiguity/invalid edits preserve native errors and release every unused slot (>32 attempts)', async t => {
  const f = await fixture(t, 'old old');
  for (let i = 0; i < 36; i++) await assert.rejects(run(f.tool, 'repeated!?', args('missing')), /Could not find/);
  await assert.rejects(run(f.tool, 'ambiguous', args()), /occurrences|unique|multiple/i);
  await assert.rejects(run(f.tool, 'invalid', { path: 'source', edits: [] }), /at least one replacement/);
  f.change('abcdef');
  await assert.rejects(
    run(f.tool, 'overlap', {
      path: 'source',
      edits: [
        { oldText: 'abc', newText: 'x' },
        { oldText: 'bcd', newText: 'y' },
      ],
    }),
    /overlap/,
  );
  assert.equal(f.wire.filter(c => ('operation' in c ? c.operation : '') === 'capture').length, 38);
  assert.equal(f.wire.filter(c => ('operation' in c ? c.operation : '') === 'release').length, 38);
  assert.equal(
    f.calls.some(c => c[5] === 'commit'),
    false,
  );
  assert.equal(f.critical, 0);
});

test('known source change has no effect, spends once, permits fresh capture; unknown effects revoke locally', async t => {
  const f = await fixture(t);
  f.onCapture(() => f.change('changed'));
  await assert.rejects(run(f.tool, 'same:!?', args()), /SOURCE_CHANGED/);
  assert.equal(f.text, 'changed');
  assert.equal(f.critical, 0);
  assert.equal(f.wire.filter(c => ('operation' in c ? c.operation : '') === 'release').length, 0);
  f.onCapture(() => {});
  await run(f.tool, 'same:!?', args('changed', 'fresh'));
  assert.equal(f.text, 'fresh');
  f.outcome(null);
  await assert.rejects(run(f.tool, 'unknown', args('fresh')), /UNCERTAIN/);
  assert.equal(f.critical, 1);
  const before = f.wire.length;
  await assert.rejects(run(f.tool, 'later', args()), /REVOKED/);
  assert.equal(f.wire.length, before);
});

test('ticket 46: capture refusals before any effect are ordinary tool errors; the invocation and session stay usable', async t => {
  for (const [name, source, reason] of [
    ['source cap', 'x'.repeat(8193), /EDIT_SOURCE_NOT_LOSSLESS.*8192 bytes.*bash/],
    ['control byte', 'old\x01', /EDIT_SOURCE_NOT_LOSSLESS.*bash/],
    ['known secret', 'synthetic-secret', /EDIT_SOURCE_NOT_LOSSLESS/],
    ['image', 'GIF89aimage', /READ_BINARY_UNSUPPORTED/],
    ['missing', '', /GUEST_READ_FAILED.*missing/],
  ] as const) {
    const f = await fixture(t, source);
    if (name === 'missing') f.captureExit(1);
    await assert.rejects(run(f.tool, `refused-${name}`, args()), reason);
    assert.equal(
      f.wire.some(c => operation(c) === 'commit'),
      false,
    );
    assert.equal(f.critical, 0, `${name}: no critical(), so the session is not aborted`);
    f.change('old');
    f.captureExit(0);
    await run(f.tool, `after-${name}`, args());
    assert.equal(f.text, 'new', `${name}: the same invocation still edits`);
  }
});

test('ticket 46 pure rule: only owner capture refusals without effect are ordinary errors; unknown state stays critical', () => {
  for (const code of ['EDIT_SOURCE_NOT_LOSSLESS', 'READ_BINARY_UNSUPPORTED', 'READ_PATH_DENIED', 'GUEST_READ_FAILED'])
    assert.match(captureRefusal(code) ?? '', new RegExp(`^${code}: .+`));
  for (const code of [
    'PROTECTED_READ_UNAVAILABLE',
    'STALE_TOOL_CONTEXT',
    'TOOL_CHANNEL_CLOSED',
    'EDIT_SOURCE_LIMIT',
    'EDIT_SOURCE_DENIED',
    'INVALID_TOOL_CALL',
    'EDIT_SOURCE_VERSION_DENIED',
    'PROTECTED_EDIT_SOURCE_UNAVAILABLE',
    'EDIT_EFFECTS_UNCERTAIN',
    'toString',
    '__proto__',
  ])
    assert.equal(captureRefusal(code), undefined, code);
});

test('malformed UTF8 fails closed before native Buffer (protected capture unavailable stays critical)', async t => {
  for (const source of [Buffer.from([0xc3, 0x28])]) {
    const f = await fixture(t, source);
    await assert.rejects(run(f.tool, 'bad-source', args()), /LOSSLESS|UNAVAILABLE|UNSUPPORTED/);
    assert.equal(
      f.wire.some(c => ('operation' in c ? c.operation : '') === 'commit'),
      false,
    );
    assert.equal(f.critical, 1);
    const before = f.wire.length;
    await assert.rejects(run(f.tool, 'later', args()), /REVOKED/);
    assert.equal(f.wire.length, before);
  }
});

test('role/preflight denial is ZERO RPC and bounds before walking huge input or JSON', async () => {
  const sandbox: ToolProjection = {
    async executeTool() {
      assert.fail('must not reach Q5');
    },
  };
  for (const role of ['standards', 'spec'] as const) await assert.rejects(run(builderEdit({ ...context, role }, sandbox), 'deny', args()), /ROLE_DENIED/);
  const tool = builderEdit(context, sandbox);
  const edits = new Array(1000000);
  Object.defineProperty(edits, 0, {
    get() {
      assert.fail('must check list length first');
    },
  });
  for (const input of [
    { path: 'x'.repeat(4097), edits },
    { path: 'source', edits },
    args('old', 'x'.repeat(8193)),
    {
      ...args(),
      toJSON() {
        assert.fail('never stringify untrusted input');
      },
      edits: [{ oldText: 'x'.repeat(8193), newText: '' }],
    },
  ]) {
    await assert.rejects(run(tool, 'large', input), /PAYLOAD_TOO_LARGE/);
  }
});

test('empty replacement, exact byte bound, multibyte replacement cap and aggregate list cap', async t => {
  const f = await fixture(t);
  await run(f.tool, 'empty', args('old', ''));
  assert.equal(f.text, '');
  // Native does not support inserting into an empty source via empty oldText.
  await assert.rejects(run(f.tool, 'empty-native-error', args('', 'x')), /oldText|empty/);
  assert.equal(operation(f.wire.at(-1)), 'release');
  f.change('old');
  await run(f.tool, 'boundary', args('old', 'x'.repeat(8192)));
  assert.equal(Buffer.byteLength(f.text), 8192);
  f.change('old' + 'x'.repeat(8189));
  await run(f.tool, 'source-boundary', args('old', 'new'));
  assert.equal(f.text, 'new' + 'x'.repeat(8189));
  f.change('old');
  await assert.rejects(run(f.tool, 'utf8-cap', args('old', 'é'.repeat(4097))), /PAYLOAD_TOO_LARGE/);
  assert.equal(f.text, 'old');
  assert.equal(operation(f.wire.at(-1)), 'release');
  const before = f.wire.length;
  await assert.rejects(
    run(f.tool, 'aggregate', { path: 'source', edits: Array.from({ length: 128 }, () => ({ oldText: 'x'.repeat(128), newText: 'y'.repeat(128) })) }),
    /PAYLOAD_TOO_LARGE/,
  );
  assert.equal(f.wire.length, before);
  assert.equal(f.critical, 0);
});

test('native same-path queue, repeated long IDs, fresh per-execute source and distinct RPC IDs', async t => {
  const f = await fixture(t);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let first = true;
  const sandbox: ToolProjection = {
    async executeTool(ctx, call, onData, signal) {
      if (call.name === 'edit-source' && call.operation === 'commit' && first) {
        first = false;
        enter();
        await gate;
      }
      return f.sandbox.executeTool(ctx, call, onData, signal);
    },
  };
  const tool = builderEdit(context, sandbox);
  const id = 'repeat!?'.repeat(200);
  const a = run(tool, id, args('old', 'middle'));
  await entered;
  const b = run(tool, id, args('middle', 'last'));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.wire.filter(c => c.name === 'edit-source' && c.operation === 'capture').length, 1);
  } finally {
    release();
  }
  await Promise.all([a, b]);
  assert.equal(f.text, 'last');
  assert.equal(new Set(f.wire.map(c => c.callId)).size, 6);
  const captures = f.wire.filter(c => c.name === 'edit-source' && c.operation === 'commit');
  assert.equal(captures.length, 2);
  if (captures[0]?.name === 'edit-source' && captures[0].operation === 'commit' && captures[1]?.name === 'edit-source' && captures[1].operation === 'commit')
    assert.notEqual(captures[0].sourceVersion, captures[1].sourceVersion);
});

test('concurrent independent paths keep their own capture binding and cancellation cleanup', async t => {
  const f = await fixture(t);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const cancelled = new AbortController();
  const seenSignals: (AbortSignal | undefined)[] = [];
  const sandbox: ToolProjection = {
    async executeTool(ctx, call, onData, signal) {
      seenSignals.push(signal);
      const result = await f.sandbox.executeTool(ctx, call, onData, signal);
      if (call.name === 'edit-source' && call.operation === 'page' && call.path.endsWith('/cancel')) {
        enter();
        await gate;
      }
      return result;
    },
  };
  let critical = 0;
  const tool = builderEdit(context, sandbox, () => {
    critical++;
  });
  const a = run(tool, 'cancel', args('old', 'never', 'cancel'), cancelled.signal);
  const rejected = assert.rejects(a, /aborted/);
  await entered;
  // Even a wrapper that has not settled retains RPC ownership. A different
  // path waits; revocation must be checked again before its actual dispatch.
  const other = assert.rejects(run(tool, 'other', args('old', 'other', 'other')), /REVOKED/);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.wire.length, 2);
  } finally {
    cancelled.abort();
    release();
  }
  await Promise.all([rejected, other]);
  const releases = f.wire.filter(c => c.name === 'edit-source' && c.operation === 'release');
  assert.equal(releases.length, 1);
  assert.ok(releases[0]?.name === 'edit-source' && releases[0].path.endsWith('/cancel'));
  assert.equal(f.text, 'old');
  assert.equal(critical, 1);
  assert.ok(seenSignals.includes(cancelled.signal));
  assert.equal(seenSignals.at(-1), undefined, 'unused capture cleanup is not cancelled with original signal');
  const before = f.wire.length;
  await assert.rejects(run(tool, 'later', args()), /REVOKED/);
  assert.equal(f.wire.length, before);
});

test('ended signal before call is critical with ZERO RPC; cancellation after commit never reports success or releases spent source', async t => {
  const f = await fixture(t);
  const ended = new AbortController();
  ended.abort();
  await assert.rejects(run(f.tool, 'ended', args(), ended.signal), /aborted/);
  assert.equal(f.wire.length, 0);
  assert.equal(f.critical, 1);
  const after = await fixture(t);
  const signal = new AbortController();
  const sandbox: ToolProjection = {
    async executeTool(ctx, call, onData, scoped) {
      const result = await after.sandbox.executeTool(ctx, call, onData, scoped);
      if (call.name === 'edit-source' && call.operation === 'commit') signal.abort();
      return result;
    },
  };
  let critical = 0;
  const tool = builderEdit(context, sandbox, () => {
    critical++;
  });
  await assert.rejects(run(tool, 'after', args(), signal.signal), /aborted/);
  assert.equal(after.text, 'new', 'VIRTUAL mutation can survive reported cancellation');
  assert.equal(
    after.wire.some(c => c.name === 'edit-source' && c.operation === 'release'),
    false,
  );
  assert.equal(critical, 1);
});

test('native malformed-edit failure releases; cleanup failure never hides original error but revokes', async t => {
  const f = await fixture(t);
  let critical = 0;
  const tool = builderEdit(
    context,
    {
      async executeTool(ctx, call, onData, signal) {
        if (call.name === 'edit-source' && call.operation === 'release') throw new Error('cleanup-transport-failure');
        return f.sandbox.executeTool(ctx, call, onData, signal);
      },
    },
    () => {
      critical++;
    },
  );
  await assert.rejects(run(tool, 'original', args('missing')), /Could not find/);
  assert.equal(critical, 1);
  await assert.rejects(run(tool, 'later', args()), /REVOKED/);
  const malformed = await fixture(t);
  await assert.rejects(run(malformed.tool, 'malformed', { path: 'source', edits: [null] }), TypeError);
  assert.equal(operation(malformed.wire.at(-1)), 'release');
});

test('protected page identity/base64/length/UTF8 proof failures release and revoke before commit', async t => {
  const corruptions = [
    { sourceVersion: '00000000-0000-4000-8000-000000000000' },
    { reference: { workId: 'other', id: '00000000-0000-4000-8000-000000000000' } },
    { format: 'raw' },
    { bytes: 4 },
    { nextOffset: 2 },
    { data: 'b2xk=' },
    { data: undefined },
    { reference: undefined },
    { data: 'x'.repeat(10925) },
    { data: Buffer.from([0xc3, 0x28, 0x61]).toString('base64') },
  ];
  for (const corruption of corruptions) {
    const f = await fixture(t);
    let critical = 0;
    const tool = builderEdit(
      context,
      {
        async executeTool(ctx, call, onData, signal) {
          const result = await f.sandbox.executeTool(ctx, call, onData, signal);
          return (call.name === 'edit-source' && call.operation === 'page' ? { ...result, ...corruption } : result) as Awaited<
            ReturnType<ToolProjection['executeTool']>
          >;
        },
      },
      () => {
        critical++;
      },
    );
    await assert.rejects(run(tool, 'corrupt-page', args()), /UNAVAILABLE/);
    assert.equal(critical, 1);
    assert.equal(
      f.calls.some(c => c[5] === 'commit'),
      false,
    );
    assert.equal(operation(f.wire.at(-1)), 'release');
  }
});

test('transport throw, unknown commit envelope and real result evidence failure are never success and deny later calls', async t => {
  for (const behavior of ['throw', 'envelope', 'evidence', 'partial'] as const) {
    const f = await fixture(t);
    let critical = 0;
    if (behavior === 'evidence') f.onCommit(() => f.records.registerSecret(context.invocationId));
    if (behavior === 'partial') f.partial();
    const tool = builderEdit(
      context,
      {
        async executeTool(ctx, call, onData, signal) {
          const result = await f.sandbox.executeTool(ctx, call, onData, signal);
          if (call.name === 'edit-source' && call.operation === 'commit') {
            if (behavior === 'throw') throw new Error('synthetic-transport-loss');
            if (behavior === 'envelope') return { ...result, status: 'UNKNOWN' } as never;
          }
          return result;
        },
      },
      () => {
        critical++;
      },
    );
    await assert.rejects(run(tool, behavior, args()), behavior);
    assert.equal(critical, 1);
    assert.equal(
      f.wire.some(c => c.name === 'edit-source' && c.operation === 'release'),
      false,
    );
    const before = f.wire.length;
    await assert.rejects(run(tool, 'later', args()), /REVOKED/);
    assert.equal(f.wire.length, before);
  }
});

test('native prepareArguments retained with bounded JSON/single/legacy input and no walk of irrelevant model fields', async t => {
  const f = await fixture(t);
  for (const input of [
    { path: 'source', edits: JSON.stringify([{ oldText: 'old', newText: 'new' }]) },
    { path: 'source', edits: { oldText: 'old', newText: 'new' } },
    { path: 'source', oldText: 'old', newText: 'new' },
  ]) {
    f.change('old');
    const prepared = f.tool.prepareArguments!(input);
    await run(f.tool, 'prepared', prepared);
    assert.equal(f.text, 'new');
  }
  assert.throws(() => f.tool.prepareArguments!({ path: 'source', edits: 'x'.repeat(16385) }), /PAYLOAD_TOO_LARGE/);
  const input = {
    ...args('new', 'final'),
    ignored: {
      toJSON() {
        assert.fail('do not walk irrelevant payload');
      },
    },
  };
  await run(f.tool, 'ignored', input);
  assert.equal(f.text, 'final');
});

test('capture metadata bounds and failed page/transport revoke; usable identity is released without masking original', async t => {
  for (const behavior of ['bytes', 'offset', 'workId', 'version', 'page-failure', 'page-throw'] as const) {
    const f = await fixture(t);
    let critical = 0;
    const tool = builderEdit(
      context,
      {
        async executeTool(ctx, call, onData, signal) {
          const result = await f.sandbox.executeTool(ctx, call, onData, signal);
          if (result.status === 'success' && call.name === 'edit-source' && call.operation === 'capture') {
            if (behavior === 'bytes') return { ...result, bytes: 8193 };
            if (behavior === 'offset') return { ...result, nextOffset: 1 };
            if (behavior === 'workId') return { ...result, reference: { ...result.reference, workId: 'wrong' } };
            if (behavior === 'version') return { ...result, sourceVersion: 'invalid' } as never;
          }
          if (call.name === 'edit-source' && call.operation === 'page') {
            if (behavior === 'page-failure') return { status: 'failure', code: 'PROTECTED_READ_UNAVAILABLE' };
            if (behavior === 'page-throw') throw new Error('page-transport-failure');
          }
          return result;
        },
      },
      () => {
        critical++;
      },
    );
    await assert.rejects(run(tool, behavior, args()), /UNAVAILABLE|page-transport-failure/);
    assert.equal(critical, 1);
    assert.equal(
      f.calls.some(c => c[5] === 'commit'),
      false,
    );
    await assert.rejects(run(tool, 'later', args()), /REVOKED/);
  }
});

test('full replacement encoded frame bound rejects before commit and ignores model authority fields', async t => {
  const f = await fixture(t);
  await assert.rejects(run(f.tool, 'encoded-cap', args('old', '\0'.repeat(8192))), /PAYLOAD_TOO_LARGE/);
  assert.equal(f.text, 'old');
  assert.equal(operation(f.wire.at(-1)), 'release');
  await run(f.tool, 'model-forgery', {
    ...args(),
    reference: { id: 'forged' },
    sourceVersion: 'forged',
    expectedDigest: 'forged',
    mutationQueueMode: 'host-realpath',
    grant: true,
    hash: 'forged',
  });
  const commit = f.wire.find(c => c.name === 'edit-source' && c.operation === 'commit');
  assert.ok(commit && commit.name === 'edit-source' && commit.operation === 'commit');
  assert.notEqual(commit.sourceVersion, 'forged');
  assert.deepEqual(Object.keys(commit).sort(), ['callId', 'name', 'operation', 'path', 'reference', 'replacement', 'sourceVersion']);
});

test('fixed lexical native Edit routes host-owned EACCES path to guest double only, not owner confinement', async () => {
  const { mkdtemp, mkdir, chmod, realpath, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.notEqual(process.getuid?.(), 0);
  const root = await mkdtemp(join(tmpdir(), 'e110-'));
  const blocked = join(root, 'blocked');
  const sentinel = join(blocked, 'sentinel');
  try {
    await chmod(root, 0o700);
    await mkdir(blocked, { mode: 0o700 });
    await writeFile(sentinel, 'HOST_UNTOUCHED', { mode: 0o600 });
    await chmod(blocked, 0);
    await assert.rejects(realpath(sentinel), { code: 'EACCES' });
    const legacy = createEditTool(root, {
      operations: {
        access: async () => {
          assert.fail('legacy callback before EACCES');
        },
        readFile: async () => {
          assert.fail();
        },
        writeFile: async () => {
          assert.fail();
        },
      },
    });
    await assert.rejects(legacy.execute('legacy', args('old', 'new', sentinel)), { code: 'EACCES' });
    const reference = { workId: context.workId, id: '00000000-0000-4000-8000-000000000001' };
    const sourceVersion = '00000000-0000-4000-8000-000000000002';
    const calls: string[] = [];
    // Projection double deliberately allows an owned path OUTSIDE guestRoot.
    // This proves routing/no host realpath, NOT owner confinement or FD checks.
    const tool = builderEdit(context, {
      async executeTool(_ctx, call) {
        assert.equal(call.name, 'edit-source');
        if (call.name !== 'edit-source') assert.fail();
        assert.equal(call.path, sentinel);
        calls.push(call.operation);
        if (call.operation === 'commit') assert.equal(call.replacement, 'new');
        return {
          status: 'success',
          format: 'text',
          reference,
          sourceVersion,
          bytes: call.operation === 'commit' ? 0 : 3,
          encoding: 'base64',
          data: call.operation === 'page' ? Buffer.from('old').toString('base64') : '',
          nextOffset: call.operation === 'page' ? 3 : 0,
        };
      },
    });
    assert.doesNotMatch(JSON.stringify(tool.parameters), /mutationQueueMode/);
    await run(tool, 'lexical', { ...args('old', 'new', sentinel), mutationQueueMode: 'host-realpath' });
    assert.deepEqual(calls, ['capture', 'page', 'commit']);
  } finally {
    try {
      await chmod(blocked, 0o700);
      assert.equal(await readFile(sentinel, 'utf8'), 'HOST_UNTOUCHED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('private fixed typed native adapter has no host implementation backend or bootstrap SDK construction', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = sourceShape(await readFile('src/workers/edit.ts', 'utf8'));
  assert.match(source, /type LexicalEditOptions = NonNullable<Parameters<typeof createEditTool>\[1\]> &/);
  assert.match(source, /const options: LexicalEditOptions = \{ mutationQueueMode: 'lexical', operations:/);
  assert.doesNotMatch(source, /\bany\b|process\.env|node:fs|realpath|generateEditDiff|normalizeToLF|Buffer\.concat/);
  // Host-gated normal composition is exercised through the real new Node in
  // entrypoints/normal-edit.test.ts; no longer assert universal non-enablement.
  assert.doesNotMatch(sourceShape(await readFile('src/workers/worker-process.ts', 'utf8')), /builderEdit|createEditTool/);
});
