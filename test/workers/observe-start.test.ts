import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { createWorkers } from '../../src/workers/index.js';

// Ticket 26: the receipt facet of Workers.observe over REAL Records (the worker host's `worker-start` record format); no worker runs.
const ids = { workId: 'observe-work', executionId: 'e1', invocationId: 'builder-e1' };
const context = { ...ids, role: 'builder' as const, environmentRef: 'environment', bootRef: 'boot', callId: 'worker-start' };
const receiptEvent = (supplied = { ...ids, role: 'builder', environmentRef: 'environment', bootRef: 'boot', phaseId: 'builder-initial' }) =>
  ({ version: 1, kind: 'worker-start', suppliedContext: supplied, startedAt: new Date().toISOString() });

test('observeStart: a complete correlated receipt is a start; a complete empty listing is absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observe-start-'));
  try {
    const workers = createWorkers({ root, knownSecrets: [], profile: {} as never });
    assert.deepEqual(await workers.observeStart(ids), { kind: 'absent', completeness: 'complete' });
    const records = await createRecords({ root });
    const reference = await records.record(context, receiptEvent());
    const observed = await workers.observeStart(ids);
    assert.equal(observed.kind, 'receipt');
    assert.deepEqual(observed.kind === 'receipt' ? observed.receipt : null, { ...ids, id: reference.id });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('observeStart: partial, multiple, mismatched or corrupt receipts are uncertain, never absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observe-start-'));
  try {
    const workers = createWorkers({ root, knownSecrets: [], profile: {} as never });
    const records = await createRecords({ root });
    const partial = await records.openOutput(context);
    await partial.write(Buffer.from('{'));
    assert.deepEqual(await workers.observeStart(ids), { kind: 'uncertain', code: 'START_RECEIPT_INCOMPLETE' });
    await partial.abort();
    await records.record(context, receiptEvent());
    assert.deepEqual(await workers.observeStart(ids), { kind: 'uncertain', code: 'START_RECEIPT_MULTIPLE' });
    const other = await mkdtemp(join(tmpdir(), 'observe-start-'));
    try {
      const fresh = await createRecords({ root: other });
      await fresh.record(context, receiptEvent({ ...ids, invocationId: 'builder-other', role: 'builder', environmentRef: 'environment', bootRef: 'boot', phaseId: 'x' }));
      assert.deepEqual(await createWorkers({ root: other, knownSecrets: [], profile: {} as never }).observeStart(ids), { kind: 'uncertain', code: 'START_RECEIPT_MISMATCH' });
      const ref = (await fresh.find({ workId: ids.workId })).captures[0]!.reference;
      await unlink(join(other, ids.workId, 'evidence', ref.id, 'capture.json'));
      await writeFile(join(other, ids.workId, 'evidence', ref.id, 'capture.json'), 'x', { mode: 0o600 });
      assert.deepEqual(await createWorkers({ root: other, knownSecrets: [], profile: {} as never }).observeStart(ids), { kind: 'uncertain', code: 'START_RECEIPT_LISTING_INCOMPLETE' });
    } finally { await rm(other, { recursive: true, force: true }); }
    assert.deepEqual(await createWorkers().observeStart(ids), { kind: 'uncertain', code: 'WORKER_EXECUTION_NOT_ENABLED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
