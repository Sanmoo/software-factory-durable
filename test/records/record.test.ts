import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

const context = { workId: 'work-05', executionId: 'execution-05', invocationId: 'builder-05',
  role: 'builder' as const, environmentRef: 'environment-05', bootRef: 'boot-05', callId: 'receipt' };

test('Records publishes a complete correlated event durably and filters secrets before JSON escaping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    records.registerSecret('synthetic\nsecret');
    const reference = await records.record(context, { kind: 'tool-result', nested: ['synthetic\nsecret'], detail: 'result synthetic\nsecret end' });
    const reopened = await createRecords({ root });
    const page = await reopened.read({ reference, offset: 0, limit: 65536 });
    assert.equal(page.state, 'complete');
    const event = JSON.parse(Buffer.from(page.data).toString());
    assert.deepEqual(event.context, context);
    assert.deepEqual(event.event, { kind: 'tool-result', nested: ['█'], detail: 'result █ end' });
    assert.equal(event.version, 1);
    assert.ok(Number.isFinite(Date.parse(event.recordedAt)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Records never returns a complete result if critical completion publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    const output = await records.openOutput(context);
    await output.write(Buffer.from('filtered evidence'));
    const directory = join(root, context.workId, 'evidence', output.reference.id);
    await mkdir(join(directory, 'complete.json'));
    await assert.rejects(output.finish(), /PROTECTED_CAPTURE_UNAVAILABLE/);
    await assert.rejects(output.write(Buffer.from('not admitted')), /PROTECTED_CAPTURE_UNAVAILABLE/);
    await rm(join(directory, 'complete.json'), { recursive: true });
    assert.equal((await records.read({ reference: output.reference, offset: 0, limit: 100 })).state, 'partial');
  } finally { await rm(root, { recursive: true, force: true }); }
});
