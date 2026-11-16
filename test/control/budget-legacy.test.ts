import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openControl } from '../../src/control/index.js';
import type { ListView } from '../../src/control/types.js';
import { openStore } from '../../src/control/durable/store.js';
import { readWork, works } from '../../src/control/durable/admission.js';
import { grantBudget, openCorrection, requestOperationalRecovery } from '../../src/control/durable/budget.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { untilHolds } from '../runner/budget.js';

// Ticket 19 regression (real Pi Durable + SQLite): a Work admitted BEFORE budgets existed has no budget record; the first budget commit
// creates it. What that commit writes into the new record (a grant, the exhaustion check of a charge) must be persisted in the document.
async function legacyWork(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-budget-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, 'control.sqlite');
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const time = manualClock();
  const control = await openControl({ storagePath, runtimeInventory: 'empty',
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  let work_id: string | undefined;
  await untilHolds('Work admitted', async () => {
    work_id = ((await control.inspect({ kind: 'list' })) as ListView).works[0]?.work_id;
    if (!work_id && time.isSleeping()) time.advance();
    return work_id !== undefined;
  }, 5);
  stop.abort();
  await running;
  assert.ok(work_id, 'admitted');
  const store = await openStore(storagePath);
  t.after(() => store.close().catch(() => {}));
  // The legacy shape: no budget record.
  await store.session.commit(async tx => { const document = await tx.doc(works, work_id!, null); document.work!.budget = null; }, BACKGROUND_CONTEXT);
  assert.equal((await readWork(store.session, work_id))!.budget, null);
  return { session: store.session, work_id };
}

test('ticket 19: an explicit grant on a Work without a budget record is persisted (counter and grant history)', async t => {
  const { session, work_id } = await legacyWork(t);
  const receipt = await grantBudget(session, { request_id: 'g-1', operation: 'grant', work_id, counter: 'corrections', amount: 2, origin: 'local-cli' }, () => ({ correctionLimit: 1 }));
  assert.equal((receipt as { outcome: string }).outcome, 'accepted');
  const budget = (await readWork(session, work_id))!.budget!;
  assert.deepEqual([budget.corrections.limit, budget.corrections.granted, budget.grants.map(item => item.request_id)], [1, 2, ['g-1']]);
});

test('ticket 19: the first correction of a Work without a budget record keeps the exhaustion check of the created record', async t => {
  const { session, work_id } = await legacyWork(t);
  assert.equal(await openCorrection(session, work_id, 'r', () => ({ correctionLimit: 0 })), 'opened');
  const work = (await readWork(session, work_id))!;
  assert.deepEqual([work.budget?.corrections.limit, work.queue.pending, work.impediments.map(item => item.code)], [0, true, ['CORRECTION_LIMIT_REACHED']]);
});

test('ticket 19: the first operational recovery of a Work without a budget record persists the created record and its recovery wait', async t => {
  const { session, work_id } = await legacyWork(t);
  assert.equal(await requestOperationalRecovery(session, work_id, 'r', () => ({ recoveryLimit: 0 })), 'requested');
  const work = (await readWork(session, work_id))!;
  assert.deepEqual([work.budget?.recoveries.limit, work.impediments.map(item => item.code), work.pendingRecovery?.reason], [0, ['RECOVERY_LIMIT_REACHED'], 'r']);
});
