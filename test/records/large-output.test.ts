import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords, outputLimits } from '../../src/records/index.js';

const context = { workId: 'work-05', executionId: 'execution-05', invocationId: 'builder-05',
  role: 'builder' as const, environmentRef: 'environment-05', bootRef: 'boot-05', callId: 'large' };

test('Records captures large output incrementally and pages the protected copy with a prefix-only marked excerpt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    const output = await records.openOutput(context);
    await output.write(Buffer.from('a'.repeat(4095) + '€'));
    await output.write(Buffer.from('Z'));
    const partial = await records.read({ reference: output.reference, offset: 4095, limit: 4 });
    assert.equal(partial.state, 'partial');
    assert.equal(Buffer.from(partial.data).toString(), '€Z');
    for (let index = 0; index < 32; index++) await output.write(Buffer.alloc(outputLimits.chunkBytes, 120));
    const finished = await output.finish();
    assert.equal(finished.bytes, 4099 + 32 * 65536);
    assert.equal(finished.truncated, true);
    assert.equal(finished.excerpt, 'a'.repeat(4095));
    assert.match(finished.display, /DISPLAY TRUNCATED/);
    const last = await records.read({ reference: output.reference, offset: finished.bytes - 3, limit: 3 });
    assert.equal(last.state, 'complete');
    assert.equal(Buffer.from(last.data).toString(), 'xxx');
    assert.equal(last.nextOffset, finished.bytes);
    await assert.rejects(records.read({ reference: output.reference, offset: 0, limit: 65537 }), /PROTECTED_CAPTURE_UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
