import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Module-internal seam (Q14 permits tests of a module to use it): the same durable store/admission commit used by Control.run.
import { openStore } from '../../src/control/durable/store.js';
import { admitTicket, readWorks, acceptPauseCommand } from '../../src/control/durable/admission.js';
import { ticket } from './doubles.js';

const evidence = (number: number) => ({
  ticket: ticket(number),
  repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
  observedAt: '2026-11-14T00:00:00.000Z',
  label: { id: 55, name: 'ready-for-agent' },
  publication: { observedAt: '2026-11-14T00:00:00.000Z', limitations: ['synthetic'] },
});

test('concurrent admissions of one Ticket on real SQLite commit exactly one Work, index entry and sequence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(join(dir, 'control.sqlite'));
  try {
    const results = await Promise.all(Array.from({ length: 25 }, () => admitTicket(store.session, evidence(1))));
    assert.equal(results.filter(r => r.kind === 'admitted').length, 1);
    assert.equal(results.filter(r => r.kind === 'existing').length, 24);
    assert.equal(new Set(results.map(r => ('work_id' in r ? r.work_id : ''))).size, 1);
    const distinct = await Promise.all([2, 3, 4, 5, 2, 3].map(n => admitTicket(store.session, evidence(n))));
    assert.equal(distinct.filter(r => r.kind === 'admitted').length, 4);
    const works = await readWorks(store.session);
    assert.deepEqual(
      works.map(w => w.queue.sequence),
      [1, 2, 3, 4, 5],
      'contiguous FIFO sequence, no gaps or duplicates',
    );
    assert.deepEqual(works.map(w => w.ticket.number).sort(), [1, 2, 3, 4, 5]);
    // Pause is re-checked inside the same commit as the index/sequence.
    await acceptPauseCommand(store.session, { request_id: 'pause-1', operation: 'pause', origin: 'local-cli' });
    assert.equal((await admitTicket(store.session, evidence(6))).kind, 'paused');
    assert.equal((await admitTicket(store.session, evidence(1))).kind, 'existing', 'an existing cycle is reported even while paused');
    assert.equal((await readWorks(store.session)).length, 5);
  } finally {
    await store.close();
  }
  const reopened = await openStore(join(dir, 'control.sqlite'));
  try {
    assert.equal((await admitTicket(reopened.session, evidence(1))).kind, 'existing', 'restart does not forget the index');
    assert.equal((await readWorks(reopened.session)).length, 5);
  } finally {
    await reopened.close();
  }
});
