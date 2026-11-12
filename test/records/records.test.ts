import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

const context = { workId: 'work-05', executionId: 'execution-05', invocationId: 'builder-05',
  role: 'builder' as const, environmentRef: 'environment-05', bootRef: 'boot-05', callId: 'call-05' };

test('Records filters a known secret across chunks before returning or writing any output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    records.registerSecret('synthetic-token-05');
    const output = await records.openOutput(context);
    let delivered = '';
    for (const chunk of ['before synthetic-', 'token-', '05 after']) delivered += await output.write(Buffer.from(chunk));
    const finished = await output.finish();
    delivered += finished.tail;
    assert.equal(delivered, 'before █ after');
    const page = await records.read({ reference: finished.reference, offset: 0, limit: 1024 });
    assert.equal(page.state, 'complete');
    assert.equal(Buffer.from(page.data).toString(), delivered);
    assert.equal((await readFile(join(root, 'work-05', 'evidence', finished.reference.id, 'output'))).toString(), delivered);
  } finally { await rm(root, { recursive: true, force: true }); }
});
