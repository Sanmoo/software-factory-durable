import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControl } from '../../src/control/index.js';
import type { ListView } from '../../src/control/index.js';
import { githubDoubles, manualClock, remoteIssue, scope } from '../control/doubles.js';
import { readStoredControl } from './review28-qualification.js';
import { untilHolds } from '../runner/budget.js';

// Ticket 28 recipe `inspect` held with "Session is closed" on the real q28-partial-v2 storage: it read `show` AFTER `run(aborted)`, which
// closes the storage session. Real Control + Pi Durable/SQLite on a temporary storage with an admitted Work; GitHub doubled.
async function storage(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review28-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(6)] });
  const time = manualClock();
  const path = join(dir, 'control.sqlite');
  const control = await openControl({ storagePath: path, runtimeInventory: 'empty', access: { tracker: github.tracker, repository: github.repository, repositories: [scope] },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await untilHolds('Work admitted', async () => ((await control.inspect({ kind: 'list' })) as ListView).works.length > 0, 5);
  stop.abort(); await running;
  return path;
}

test('diagnosis: after run(aborted) the stored Control session is closed, so a later inspect fails "Session is closed" (the held real inspect)', async t => {
  const path = await storage(t);
  const stored = await openControl({ storagePath: path, runtimeInventory: 'unknown' });
  const list = await stored.inspect({ kind: 'list' }) as ListView;
  const stopped = new AbortController(); stopped.abort();
  await stored.run(stopped.signal);
  await assert.rejects(stored.inspect({ kind: 'show', work_id: list.works[0]!.work_id }), /Session is closed/);
});

test('readStoredControl reads list AND show of the recipe Work before closing the storage session', async t => {
  const path = await storage(t);
  const read = await readStoredControl(path, works => works.find(item => item.ticket.number === 6));
  assert.equal(read.work?.ticket.number, 6);
  assert.ok(read.shown && 'work' in read.shown && read.shown.work.work_id === read.work!.work_id, 'show of the same Work');
  const none = await readStoredControl(path, () => undefined);
  assert.deepEqual([none.work, none.shown], [undefined, null]);
});
