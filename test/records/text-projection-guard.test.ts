import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords, RecordsError, type TextProjection } from '../../src/records/index.js';

const context = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'builder' as const,
  environmentRef: 'environment', bootRef: 'boot', callId: 'call' };
async function fixture(run: (records: Awaited<ReturnType<typeof createRecords>>, root: string,
  request: { context: typeof context; reference: { workId: string; id: string }; expectedBytes: number }) => Promise<void>) {
  const root = await mkdtemp('/tmp/rg-');
  try {
    const records = await createRecords({ root });
    const output = await records.openOutput(context);
    await output.write(Buffer.from('late-secret public'));
    const done = await output.finish();
    await run(records, root, { context, reference: done.reference, expectedBytes: done.bytes });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function exhaust(projection: TextProjection) {
  const chunks: Buffer[] = [];
  for await (const chunk of projection.chunks) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
function denied(projection: TextProjection) {
  assert.throws(() => projection.assertCompleteAndCurrent(), error =>
    error instanceof RecordsError && error.message === 'PROTECTED_CAPTURE_UNAVAILABLE');
}

test('historical complete is insufficient after late registration; new projection uses current filter without recall', async () => {
  await fixture(async (records, _root, request) => {
    const projection = records.projectText(request);
    const alreadyReleased = await exhaust(projection);
    assert.equal(projection.state, 'complete');
    records.registerSecret('late-secret');
    // Old state alone still says complete: the new synchronous guard must reject.
    assert.equal(projection.state, 'complete');
    denied(projection);
    assert.equal(projection.state, 'complete');
    assert.equal(alreadyReleased, 'late-secret public');
    const current = records.projectText(request);
    assert.equal(await exhaust(current), '█ public');
    assert.equal(current.assertCompleteAndCurrent(), undefined);
    records.registerSecret('late-secret');
    assert.equal(current.assertCompleteAndCurrent(), undefined);
    denied(projection);
  });
});

test('guard rejects pending and last yield without poisoning eventual EOF completion; no source reread', async () => {
  await fixture(async (records, root, request) => {
    const projection = records.projectText(request);
    denied(projection);
    assert.equal(projection.state, 'pending');
    assert.equal((await projection.chunks.next()).done, false);
    denied(projection);
    assert.equal(projection.state, 'streaming');
    assert.deepEqual(await projection.chunks.next(), { done: true, value: undefined });
    assert.equal(projection.assertCompleteAndCurrent(), undefined);
    await unlink(join(root, 'work', 'evidence', request.reference.id, 'output'));
    assert.equal(projection.assertCompleteAndCurrent(), undefined);
    assert.equal(projection.state, 'complete');
  });
});

test('guard rejects aborted signals before iteration, during streaming and after completion', async () => {
  await fixture(async (records, _root, request) => {
    for (const phase of ['pending', 'streaming', 'complete'] as const) {
      const controller = new AbortController();
      const projection = records.projectText({ ...request, signal: controller.signal });
      if (phase === 'streaming') await projection.chunks.next();
      if (phase === 'complete') await exhaust(projection);
      controller.abort(new Error('private-abort-reason'));
      denied(projection);
      assert.equal(projection.state, phase === 'complete' ? 'complete' : 'failed');
      if (phase !== 'complete') {
        await assert.rejects(projection.chunks.next(), RecordsError);
        assert.equal(projection.state, 'failed');
        denied(projection);
      }
    }
  });
});

test('guard rejects failed and early-returned iterators, including return before first next', async () => {
  await fixture(async (records, _root, request) => {
    const failed = records.projectText({ ...request, expectedBytes: request.expectedBytes + 1 });
    await assert.rejects(failed.chunks.next(), RecordsError);
    denied(failed);
    assert.equal(failed.state, 'failed');
    for (const start of [false, true]) {
      const projection = records.projectText(request);
      if (start) await projection.chunks.next();
      await projection.chunks.return();
      denied(projection);
      assert.equal(projection.state, 'failed');
    }
  });
});
