import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';

// Ticket 26 finding (real run q26-recovery-v1): what an incremental text capture has on disk WHILE a command still runs. Characterization of
// the approved Q8 behaviour ("pode reter a cauda necessária à filtragem de segredos fragmentados"), not a new contract.
const context = { workId: 'retention-work', executionId: 'e1', invocationId: 'builder-e1', role: 'builder' as const, environmentRef: 'environment', bootRef: 'boot', callId: 'bash-1' };

test('a running text capture writes each filtered chunk to its output file at once (no sync), but holds back up to (longest registered secret - 1) characters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-retention-'));
  try {
    const records = await createRecords({ root });
    const output = await records.openOutput(context);
    const file = join(root, context.workId, 'evidence', output.reference.id, 'output');
    // No secret registered: the chunk is on disk while the capture is still open (page cache; durability is only at finish).
    await output.write(Buffer.from('q26-a1-c1-start\n'));
    assert.equal(await readFile(file, 'utf8'), 'q26-a1-c1-start\n');
    await output.abort();
    // With a registered credential (a Builder token is ~40+ characters), a short progress line stays in memory only: an abrupt end loses it.
    records.registerSecret(`ghs_${'x'.repeat(36)}`);
    const held = await records.openOutput({ ...context, callId: 'bash-2' });
    await held.write(Buffer.from('q26-a1-c1-start\n'));
    assert.equal(await readFile(join(root, context.workId, 'evidence', held.reference.id, 'output'), 'utf8'), '', 'retained for fragmented-secret filtering');
    await held.abort();
  } finally { await rm(root, { recursive: true, force: true }); }
});
