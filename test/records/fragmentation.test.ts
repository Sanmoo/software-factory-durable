import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

const context = {
  workId: 'work-05',
  executionId: 'execution-05',
  invocationId: 'builder-05',
  role: 'builder' as const,
  environmentRef: 'environment-05',
  bootRef: 'boot-05',
  callId: 'fragmentation',
};

test('Records filters every UTF-8 byte split, overlapping secrets and a registered rotation before downstream delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    records.registerSecret('🔒synthetic-secret');
    records.registerSecret('🔒synthetic');
    const raw = Buffer.from('begin 🔒synthetic-secret / 🔒synthetic end');
    for (let split = 0; split <= raw.length; split++) {
      const output = await records.openOutput({ ...context, callId: `split-${split}` });
      let visible = await output.write(raw.subarray(0, split));
      visible += await output.write(raw.subarray(split));
      visible += (await output.finish()).tail;
      assert.equal(visible, 'begin █ / █ end');
    }
    const output = await records.openOutput(context);
    let visible = await output.write(Buffer.from('start '));
    records.registerSecret('new-synthetic-token');
    visible += await output.write(Buffer.from('new-synthetic-'));
    visible += await output.write(Buffer.from('token done'));
    visible += (await output.finish()).tail;
    assert.equal(visible, 'start █ done');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Records replacement boundaries cannot synthesize another registered secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    records.registerSecret('synthetic-primary-token');
    records.registerSecret('D]tail');
    assert.throws(() => records.registerSecret('synthetic-█-token'), /PROTECTED_CAPTURE_UNAVAILABLE/);
    const output = await records.openOutput(context);
    let visible = await output.write(Buffer.from('synthetic-primary-tokentail'));
    visible += (await output.finish()).tail;
    assert.ok(!visible.includes('synthetic-primary-token'));
    assert.ok(!visible.includes('D]tail'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Records refuses corrupt correlation metadata instead of exposing an unverified capture as complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    const output = await records.openOutput(context);
    await output.write(Buffer.from('ordinary output'));
    const finished = await output.finish();
    await writeFile(join(root, context.workId, 'evidence', finished.reference.id, 'capture.json'), '{}');
    await assert.rejects(records.read({ reference: finished.reference, offset: 0, limit: 100 }), /PROTECTED_CAPTURE_UNAVAILABLE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
