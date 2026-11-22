import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords, outputLimits, RecordsError } from '../../src/records/index.js';

const context = {
  workId: 'work',
  executionId: 'execution',
  invocationId: 'invocation',
  role: 'builder' as const,
  environmentRef: 'environment',
  bootRef: 'boot',
  callId: 'call',
};
async function fixture(run: (records: Awaited<ReturnType<typeof createRecords>>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rp-'));
  try {
    await run(await createRecords({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function capture(records: Awaited<ReturnType<typeof createRecords>>, text: string) {
  const output = await records.openOutput(context, { format: 'text', preserveBOM: true });
  const data = Buffer.from(text);
  for (let offset = 0; offset < data.length; offset += outputLimits.chunkBytes) await output.write(data.subarray(offset, offset + outputLimits.chunkBytes));
  return output.finish();
}

test('projection re-filters whole completed text with split UTF8, split secrets, BOM and finish tail', async () => {
  await fixture(async records => {
    // BOM + prefix put the emoji across the first page and secret across the second.
    const source = '\uFEFF' + 'a'.repeat(65532) + '😀' + 'b'.repeat(65530) + 'SECRET' + 'tail';
    const done = await capture(records, source);
    records.registerSecret('SECRET');
    const projection = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
    const chunks: Buffer[] = [];
    for await (const chunk of projection.chunks) {
      assert.ok(chunk.length <= outputLimits.pageBytes);
      chunks.push(chunk);
    }
    assert.equal(Buffer.concat(chunks).toString(), source.replace('SECRET', '█'));
    assert.equal(projection.state, 'complete');
    assert.ok(done.truncated);
    assert.equal((await records.read({ reference: done.reference, offset: 131069, limit: 32 })).data.toString(), 'SECRETtail');
  });
});

test('projection fences registration during read await and between yields; duplicate is a no-op', async () => {
  await fixture(async records => {
    const done = await capture(records, 'x'.repeat(140000));
    const request = { context, reference: done.reference, expectedBytes: done.bytes };
    const raced = records.projectText(request);
    const reading = raced.chunks.next();
    records.registerSecret('new-secret');
    await assert.rejects(reading, RecordsError);
    assert.equal(raced.state, 'failed');
    const projection = records.projectText(request);
    assert.equal((await projection.chunks.next()).done, false);
    records.registerSecret('new-secret');
    assert.equal((await projection.chunks.next()).done, false);
    records.registerSecret('rotation');
    await assert.rejects(projection.chunks.next(), RecordsError);
    assert.equal(projection.state, 'failed');
  });
});

test('projection cancellation and iterator close never report full completion', async () => {
  await fixture(async records => {
    const done = await capture(records, 'x'.repeat(140000));
    const controller = new AbortController();
    const projection = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes, signal: controller.signal });
    const reading = projection.chunks.next();
    controller.abort();
    await assert.rejects(reading, RecordsError);
    assert.equal(projection.state, 'failed');
    const closed = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
    for await (const chunk of closed.chunks) {
      assert.ok(chunk.length);
      break;
    }
    assert.equal(closed.state, 'failed');
    const unopened = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
    await unopened.chunks.return();
    assert.equal(unopened.state, 'failed');
    const interrupted = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
    await assert.rejects(interrupted.chunks.throw(new RecordsError()), RecordsError);
    assert.equal(interrupted.state, 'failed');
  });
});

test('projection rejects partial, raw, wrong context/count and corrupt UTF8; supports empty text', async () => {
  await fixture(async (records, root) => {
    const partial = await records.openOutput(context);
    await partial.write(Buffer.from('partial'));
    const raw = await records.openOutput(context, { format: 'raw', maxBytes: 16 });
    await raw.write(Buffer.from([137, 80, 78, 71]));
    const rawDone = await raw.finish();
    const done = await capture(records, 'valid');
    for (const request of [
      { context, reference: partial.reference, expectedBytes: 7 },
      { context, reference: rawDone.reference, expectedBytes: rawDone.bytes },
      { context: { ...context, invocationId: 'other' }, reference: done.reference, expectedBytes: done.bytes },
      { context, reference: done.reference, expectedBytes: 6 },
      { context, reference: done.reference, expectedBytes: Infinity },
    ]) {
      const projection = records.projectText(request);
      await assert.rejects(async () => {
        for await (const chunk of projection.chunks) assert.fail(`unexpected ${chunk.length} bytes`);
      }, RecordsError);
      assert.equal(projection.state, 'failed');
    }
    await partial.abort();
    await writeFile(join(root, 'work', 'evidence', done.reference.id, 'output'), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
    const corrupt = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
    await assert.rejects(corrupt.chunks.next(), RecordsError);
    await writeFile(join(root, 'work', 'evidence', done.reference.id, 'output'), Buffer.from([0x61, 0x61, 0x61, 0x61, 0xc2]));
    const incompleteUTF8 = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
    assert.equal((await incompleteUTF8.chunks.next()).done, false);
    await assert.rejects(incompleteUTF8.chunks.next(), RecordsError);
    assert.equal(incompleteUTF8.state, 'failed');
    const empty = await capture(records, '');
    const projection = records.projectText({ context, reference: empty.reference, expectedBytes: 0 });
    assert.deepEqual(await projection.chunks.next(), { done: true, value: undefined });
    assert.equal(projection.state, 'complete');
  });
});
