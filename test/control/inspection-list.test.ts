// Ticket 29 (supervisor decision 3): `list` paginates by cursor/limit and fits one frame instead of refusing a large installation.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openControl } from '../../src/control/index.js';
import type { ListView } from '../../src/control/types.js';
import { works } from '../../src/control/durable/admission.js';
import { seedPublishedWork, store } from './delivery-fixture.js';

async function installation(t: { after(fn: () => Promise<void> | void): void }, count: number, historyEntries = 0) {
  const root = await mkdtemp(join(tmpdir(), 'factory-list29-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = await store(t, root);
  const ids: string[] = [];
  for (let number = 1; number <= count; number++) {
    const id = await seedPublishedWork(opened.session, { number, pr: 100 + number });
    if (historyEntries) await opened.session.commit(async tx => {
      const document = await tx.doc(works, id, null);
      for (let i = 0; i < historyEntries; i++) document.work!.history.push({ at: 'now', event: 'checks-evaluated', origin: 'controller-checks', detail: 'x'.repeat(200) });
    }, BACKGROUND_CONTEXT);
    ids.push(id);
  }
  await opened.close();
  return { path: join(root, 'control.sqlite'), ids };
}

test('list pages by cursor/limit in admission order; queues and selection stay installation-wide; no page argument keeps the full list', async t => {
  const { path, ids } = await installation(t, 3);
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown' });
  const first = await control.inspect({ kind: 'list', limit: 2 }) as ListView;
  assert.deepEqual(first.works.map(work => work.work_id), ids.slice(0, 2));
  assert.deepEqual([first.page.cursor, first.page.returned, first.page.filtered, first.page.nextCursor, first.page.fitted], [0, 2, 3, 2, false]);
  const second = await control.inspect({ kind: 'list', cursor: first.page.nextCursor!, limit: 2 }) as ListView;
  assert.deepEqual([second.works.map(work => work.work_id), second.page.nextCursor], [ids.slice(2), null]);
  const all = await control.inspect({ kind: 'list' }) as ListView;
  assert.deepEqual([all.works.length, all.page.nextCursor], [3, null]);
  const stopped = new AbortController(); stopped.abort(); await control.run(stopped.signal);
});

test('a paged list larger than one frame is cut with a cursor to the rest (never VIEW_TOO_LARGE)', async t => {
  const { path } = await installation(t, 4, 60);
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown' });
  const page = await control.inspect({ kind: 'list', limit: 50 }) as ListView;
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 63 * 1024, 'fits one frame');
  assert.equal(page.page.fitted, true);
  assert.ok(page.works.length >= 1 && page.works.length < 4);
  let seen = page.works.length, cursor = page.page.nextCursor;
  while (cursor !== null) { const next = await control.inspect({ kind: 'list', cursor, limit: 50 }) as ListView; seen += next.works.length; cursor = next.page.nextCursor; }
  assert.equal(seen, 4, 'every Work reachable by following the cursor');
  const stopped = new AbortController(); stopped.abort(); await control.run(stopped.signal);
});
