import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRetentionDesk } from '../../src/control/durable/retention-desk.js';
import { acceptForgetConfirm, acceptForgetPlan } from '../../src/control/durable/forget.js';
import { initialize, readForgotten, readWork, readWorks, works } from '../../src/control/durable/admission.js';
import { questions as questionDocs, readQuestions } from '../../src/control/durable/questions.js';
import { openStore } from '../../src/control/durable/store.js';
import type { StorageScrub } from '../../src/control/types.js';
import { forgetWorkRecords, inspectWorkRecords, listDetails } from '../../src/records/index.js';
import { markDelivered, seedPublishedWork } from './delivery-fixture.js';

// Operator decision D-07 (ticket 31): after a forget, the deleted controller records must not stay recoverable in the REAL SQLite file's free
// pages or WAL. The proof reads the raw bytes of `control.sqlite` and `control.sqlite-wal` (local, real SQLite file; no VM, GitHub or model).
const raw = async (path: string) => Buffer.concat(await Promise.all(['', '-wal'].map(suffix => readFile(`${path}${suffix}`).catch(() => Buffer.alloc(0)))));

async function forgottenInstallation(t: { after(fn: () => Promise<void> | void): void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-forget-scrub-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'control.sqlite');
  const opened = await openStore(path);
  t.after(() => opened.close().catch(() => {}));
  await initialize(opened.session);
  const work_id = await seedPublishedWork(opened.session, { environmentFor: () => 'no-environment' });
  await markDelivered(opened.session, work_id, new Date().toISOString());
  const marker = `D07-MARKER-${randomUUID()}`;
  const questionId = randomUUID();
  // The marker is rewritten several times while the Work lives (earlier revisions are freed pages long before the forget).
  for (const round of [1, 2, 3]) {
    await opened.session.commit(async tx => {
      const work = (await tx.doc(works, work_id, null)).work!;
      if (!work.questions.includes(questionId)) work.questions.push(questionId);
      (await tx.doc(questionDocs, questionId, null)).question = { questionId, workId: work_id, state: 'answered', publication: { state: 'published' }, ignored: [],
        answer: null, content: { question: `${marker} round ${round}` } } as never;
    }, BACKGROUND_CONTEXT);
  }
  assert.ok((await raw(path)).includes(marker), 'sanity: the marker is in the raw file before the forget');
  const tree = await inspectWorkRecords(dir, work_id);
  const facts = () => ({ running: false, tree, repositoryConfigured: false });
  const planned = await acceptForgetPlan(opened.session, { request_id: 'f-1', operation: 'forget-plan', work_id, origin: 'local-cli' }, facts);
  assert.ok(planned.kind === 'durable' && planned.outcome === 'accepted', JSON.stringify(planned));
  await acceptForgetConfirm(opened.session, { request_id: 'f-1c', operation: 'forget-confirm', work_id, plan_id: planned.plan!.planId, origin: 'local-cli' }, facts);
  const desk = (scrub: StorageScrub | 'none' = opened) => createRetentionDesk({ session: opened.session, storage: scrub === 'none' ? undefined : scrub,
    details: { list: () => listDetails(dir, work_id), preserveSession: async () => ({ status: 'lost', code: 'X' }), remove: async () => ({ outcome: 'refused', code: 'X' }),
      inspectTree: ({ workId }) => inspectWorkRecords(dir, workId), forget: ({ workId }) => forgetWorkRecords(dir, workId) },
    repositories: [], readWorks: () => readWorks(opened.session), readQuestions: work => readQuestions(opened.session, work), running: () => false, settled: () => true, stopped: () => false });
  return { dir, path, opened, work_id, marker, desk };
}

test('D-07: after a forget the deleted records are absent from the raw SQLite file and its WAL; the memory reports the scrub', async t => {
  const h = await forgottenInstallation(t);
  const desk = h.desk();
  await desk.cycle();
  assert.equal(await readWork(h.opened.session, h.work_id), undefined, JSON.stringify(desk.view().failures));
  const bytes = await raw(h.path);
  assert.equal(bytes.includes(h.marker), false, 'the forgotten marker is still recoverable from the SQLite file or its WAL');
  const memory = (await readForgotten(h.opened.session))[0]!;
  assert.equal(memory.scrub?.state, 'scrubbed', JSON.stringify(memory.scrub));
  assert.ok(memory.scrub?.scrubbedAt);
});

test('D-07: a scrub that fails (or is cut by a crash) leaves the forget committed, is reported pending and is re-attempted, never silently skipped', async t => {
  const h = await forgottenInstallation(t);
  let attempts = 0;
  const failing = { vacuum: async () => { attempts++; return { outcome: 'failed' as const, code: 'SQLITE_FULL' }; }, checkpoint: () => h.opened.checkpoint() };
  await h.desk(failing).cycle();
  assert.equal(await readWork(h.opened.session, h.work_id), undefined, 'the forget stays committed');
  let memory = (await readForgotten(h.opened.session))[0]!;
  assert.deepEqual([memory.scrub?.state, memory.scrub?.code, memory.scrub?.attempts, attempts], ['pending', 'SQLITE_FULL', 1, 1]);
  // No storage port composed: still pending, never marked scrubbed.
  await h.desk('none').cycle();
  memory = (await readForgotten(h.opened.session))[0]!;
  assert.equal(memory.scrub?.state, 'pending');
  // A crash mid-VACUUM is the same durable state (pending, committed with the forget): the next owner run re-attempts it and completes.
  await h.opened.close();
  const reopened = await openStore(h.path);
  t.after(() => reopened.close());
  const desk = createRetentionDesk({ session: reopened.session, storage: reopened, details: { list: async () => ({ completeness: 'complete', items: [] }) as never,
    preserveSession: async () => ({ status: 'lost', code: 'X' }), remove: async () => ({ outcome: 'refused', code: 'X' }) },
    repositories: [], readWorks: () => readWorks(reopened.session), readQuestions: work => readQuestions(reopened.session, work), running: () => false, settled: () => true, stopped: () => false });
  await desk.cycle();
  memory = (await readForgotten(reopened.session))[0]!;
  assert.equal(memory.scrub?.state, 'scrubbed', JSON.stringify([memory.scrub, desk.view().failures]));
  assert.equal(memory.scrub?.attempts, 2);
  assert.equal((await raw(h.path)).includes(h.marker), false);
});
