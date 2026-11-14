import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

// Ticket 26: `find` (read(selection) with correlation filters) over REAL protected captures in a temporary private root.
const context = (callId: string, invocationId = 'builder-e1') => ({ workId: 'find-work', executionId: 'e1', invocationId, role: 'builder' as const,
  environmentRef: 'environment', bootRef: 'boot', callId });

test('find lists only captures of the selected correlation, with complete/partial state; no evidence directory is a complete empty listing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-find-'));
  try {
    const records = await createRecords({ root });
    assert.deepEqual(await records.find({ workId: 'find-work', callId: 'worker-start' }), { completeness: 'complete', captures: [] });
    const start = await records.record(context('worker-start'), { kind: 'worker-start' });
    await records.record(context('tool-1'), { kind: 'tool' });
    await records.record(context('worker-start', 'standards-e1'), { kind: 'worker-start' });
    const partial = await records.openOutput(context('worker-start', 'builder-e2'));
    await partial.write(Buffer.from('{"incomplete"'));
    const found = await records.find({ workId: 'find-work', executionId: 'e1', invocationId: 'builder-e1', callId: 'worker-start' });
    assert.deepEqual(found, { completeness: 'complete', captures: [{ reference: start, context: context('worker-start'), state: 'complete' }] });
    const open = await records.find({ workId: 'find-work', invocationId: 'builder-e2' });
    assert.deepEqual(open.captures.map(item => item.state), ['partial'], 'an unfinished capture is never complete');
    await partial.abort();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('find never turns unreadable evidence into absence: corrupt metadata or a foreign entry make the listing incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-find-'));
  try {
    const records = await createRecords({ root });
    const reference = await records.record(context('worker-start'), { kind: 'worker-start' });
    await unlink(join(root, 'find-work', 'evidence', reference.id, 'capture.json'));
    await writeFile(join(root, 'find-work', 'evidence', reference.id, 'capture.json'), '{not json', { mode: 0o600 });
    assert.deepEqual(await records.find({ workId: 'find-work', callId: 'worker-start' }), { completeness: 'incomplete', captures: [] });
    const other = await mkdtemp(join(tmpdir(), 'records-find-'));
    try {
      const fresh = await createRecords({ root: other });
      await fresh.record(context('worker-start'), { kind: 'worker-start' });
      await mkdir(join(other, 'find-work', 'evidence', 'not-a-uuid'), { mode: 0o700 });
      assert.equal((await fresh.find({ workId: 'find-work', callId: 'worker-start' })).completeness, 'incomplete');
    } finally { await rm(other, { recursive: true, force: true }); }
    await assert.rejects(records.find({ workId: '../escape' }), /PROTECTED_CAPTURE_UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
