import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords, RecordsError } from '../../src/records/index.js';

for (const change of ['grow', 'withdraw', 'missing'] as const) {
  test(`projection rejects source ${change} after last data yield rather than declaring completion`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-'));
    try {
      const records = await createRecords({ root });
      const context = {
        workId: 'work',
        executionId: 'execution',
        invocationId: 'invocation',
        role: 'builder' as const,
        environmentRef: 'environment',
        bootRef: 'boot',
        callId: 'call',
      };
      const output = await records.openOutput(context);
      await output.write(Buffer.from('all data'));
      const done = await output.finish();
      const projection = records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
      assert.equal((await projection.chunks.next()).value?.toString(), 'all data');
      const directory = join(root, 'work', 'evidence', done.reference.id);
      if (change === 'grow') await appendFile(join(directory, 'output'), '!');
      else await unlink(join(directory, change === 'withdraw' ? 'complete.json' : 'output'));
      await assert.rejects(projection.chunks.next(), RecordsError);
      assert.equal(projection.state, 'failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
