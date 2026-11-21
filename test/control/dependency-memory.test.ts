import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/control/durable/store.js';
import { admitTicket, initialize, ownCycles } from '../../src/control/durable/admission.js';
import { ticket } from './doubles.js';

// Storage-real: the minimal memory used for own-blocker classification is written by the Admit-Work commit itself (Pi Durable + SQLite).
test('admission records the explicit minimal memory of the cycle; own classification survives reopening the storage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-memory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'control.sqlite');
  let store = await openStore(path);
  await initialize(store.session);
  const admitted = await admitTicket(store.session, {
    ticket: ticket(2),
    repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
    observedAt: 'now',
    label: { id: 55, name: 'ready-for-agent' },
    publication: { observedAt: 'now', limitations: [] },
  });
  assert.equal(admitted.kind, 'admitted');
  const work_id = admitted.kind === 'admitted' ? admitted.work_id : '';
  const expected = { source: 'work', applicable: { work_id, cycle: 1, result: 'open', mergeConfirmed: false }, previousCycles: [] };
  assert.deepEqual(await ownCycles(store.session, [7002, 7099]), { 7002: expected }, 'unknown issue stays external');
  await store.close();
  store = await openStore(path);
  t.after(() => store.close());
  assert.deepEqual(await ownCycles(store.session, [7002]), { 7002: expected });
  assert.deepEqual(await ownCycles(store.session, []), {});
});
