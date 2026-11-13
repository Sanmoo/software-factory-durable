import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSandbox, type ToolContext, type ToolProjection } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderWrite } from '../../src/workers/write.js';
import { builderBash } from '../../src/workers/bash.js';

const context: ToolContext = { workId: 'ids-work', executionId: 'ids-exec', invocationId: 'ids-invocation',
  role: 'builder', environmentRef: 'ids-env', bootRef: 'ids-boot', phaseId: 'ids-phase' };

for (const [label, nativeId] of [['122 characters', 'a'.repeat(122)], ['over 128 characters', 'b'.repeat(256)],
  ['punctuation', 'native:call/with.punctuation!?']] as const) {
  for (const tool of ['write', 'bash'] as const) test(`native ${tool}: independent owner IDs for ${label}`, async t => {
    const lifetimes: AbortSignal[] = [];
    const effects: string[] = [];
    const f = await nativeOwner(context, { exec(argv, options) {
      assert.equal(options.signal.aborted, false);
      lifetimes.push(options.signal);
      effects.push(tool === 'write' ? argv[5]! : 'exec');
      return { async *output() {
        if (tool === 'bash') yield { stream: 'stdout' as const, data: Buffer.from('synthetic-secret safe') };
      }, result: Promise.resolve({ exitCode: 0 }) };
    } });
    t.after(() => f.close());
    const sandbox = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
    const ids: string[] = [];
    const projection: ToolProjection = { async executeTool(bound, call, onData, signal) {
      assert.deepEqual(bound, context);
      ids.push(call.callId);
      return sandbox.executeTool(bound, call, onData, signal);
    } };
    let critical = 0;
    const native = (tool === 'write' ? builderWrite : builderBash)(context, projection, () => { critical++; });
    // Reuse the native ID: each callback, not just each native invocation, needs a fresh owner ID.
    for (let i = 0; i < 2; i++) {
      const result = await native.execute(nativeId, tool === 'write'
        ? { path: `nested/new-${i}.txt`, content: 'synthetic-secret' } : { command: 'model command is data' },
      undefined, undefined, { cwd: '/workspace' } as never);
      if (tool === 'write') assert.deepEqual(result.content, [{ type: 'text', text: `Successfully wrote to nested/new-${i}.txt` }]);
      else assert.equal((result.structuredContent as { output: string }).output, '█ safe');
    }
    assert.deepEqual(effects, tool === 'write' ? ['mkdir', 'create', 'mkdir', 'create'] : ['exec', 'exec']);
    assert.equal(critical, 0);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
      assert.ok(id.length <= 128);
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.notEqual(id, nativeId);
    }
    assert.ok(lifetimes.every(signal => signal.aborted), 'each completed owner command lifetime is closed');
    assert.equal(f.authority.signal.aborted, false, 'successful calls do not revoke the invocation');
    const evidenceRoot = join(f.root, 'records', context.workId, 'evidence');
    const entries = await readdir(evidenceRoot);
    assert.equal(entries.length, tool === 'write' ? 8 : 2);
    const evidenceIds: string[] = [];
    for (const entry of entries) {
      const directory = join(evidenceRoot, entry);
      const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'));
      const { phaseId: _phase, ...captureContext } = context;
      assert.deepEqual(capture.context, { ...captureContext, callId: capture.context.callId });
      assert.ok(ids.includes(capture.context.callId));
      evidenceIds.push(capture.context.callId);
      await readFile(join(directory, 'complete.json'), 'utf8');
      const output = await readFile(join(directory, 'output'), 'utf8');
      assert.equal(output.includes('synthetic-secret'), false);
      if (tool === 'write') {
        const record = JSON.parse(output);
        assert.deepEqual(record.context, capture.context);
        assert.equal(record.event.phaseId, context.phaseId);
        assert.ok(['mutation-intent', 'mutation-result'].includes(record.event.kind));
      } else assert.equal(output, '█ safe');
    }
    assert.deepEqual(evidenceIds.sort(), ids.flatMap(id => tool === 'write' ? [id, id] : [id]).sort());
  });
}
