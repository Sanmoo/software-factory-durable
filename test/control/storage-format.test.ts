import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { inspectStorage, migrateStorage, openControl, StorageFormatError, type StorageInspection } from '../../src/control/index.js';
import type { ControlReceipt, ControlStatus, QuestionQueryView, ShowView } from '../../src/control/types.js';
import { openStore } from '../../src/control/durable/store.js';
import { recordRunStart } from '../../src/control/durable/migration.js';
import { questionId, storageWithPendingQuestion, writeFormatOne } from './upgrade-fixture.js';

// Flow level (ticket 33): real Control + Pi Durable + SQLite storages; the pending Question comes from the public Control boundaries with
// doubled execution/GitHub (upgrade-fixture). The format-1 storages are re-expressions of that state through the public Pi Durable API.
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-format-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const storage = (inspection: StorageInspection) => {
  assert.equal(inspection.kind, 'storage');
  return inspection as Extract<StorageInspection, { kind: 'storage' }>;
};
async function status(storagePath: string, run = true) {
  const control = await openControl({ storagePath, runtimeInventory: 'unknown' });
  const stop = new AbortController();
  if (!run) stop.abort();
  const running = control.run(stop.signal);
  const view = (await control.inspect({ kind: 'status' })) as ControlStatus;
  // Wait for this run's start commit (a run aborted before it starts records nothing, by design).
  for (let i = 0; run && i < 200; i++) {
    const current = ((await inspectStorage(storagePath)) as Extract<StorageInspection, { kind: 'storage' }>).installation?.lifecycle?.current as {
      runId?: string;
    } | null;
    if (current?.runId === view.controller_run_id) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const started = (await control.inspect({ kind: 'status' })) as ControlStatus;
  stop.abort();
  return { view: started, end: await running, control };
}

test('format 2: a fresh storage is created at the current format; the controller lifecycle tells a clean stop from a crash', async t => {
  const dir = await directory(t);
  const path = join(dir, 'control.sqlite');
  assert.deepEqual(await inspectStorage(path), { kind: 'absent' });
  const first = await status(path);
  assert.deepEqual(first.end, { kind: 'clean' });
  assert.equal(first.view.storage.format, 2);
  assert.equal(first.view.storage.previousRun, null);
  const inspected = storage(await inspectStorage(path));
  assert.equal(inspected.format, 2);
  assert.equal(inspected.operational, 'ready');
  const lifecycle = inspected.installation!.lifecycle as { current: unknown; last: { end: string; runId: string } };
  assert.equal(lifecycle.current, null);
  assert.deepEqual([lifecycle.last.end, lifecycle.last.runId], ['clean', first.view.controller_run_id]);
  // The next run reads the recorded clean end of the previous one.
  const second = await status(path);
  assert.equal(second.view.storage.previousRun?.end, 'clean');
  // A run that recorded its start and never its end (process killed after the start commit) is a crash, whatever was intended.
  const store = await openStore(path);
  await recordRunStart(store.session, 'killed-run');
  await store.close();
  const afterCrash = storage(await inspectStorage(path));
  assert.equal((afterCrash.installation!.lifecycle as { current: { runId: string } }).current.runId, 'killed-run');
  const third = await status(path);
  assert.deepEqual([third.view.storage.previousRun?.runId, third.view.storage.previousRun?.end], ['killed-run', 'crash']);
  // A read-only open (run stopped before it starts) records nothing.
  const before = JSON.stringify(storage(await inspectStorage(path)).installation);
  await status(path, false);
  assert.equal(JSON.stringify(storage(await inspectStorage(path)).installation), before);
});

test('format 1 is never adopted implicitly; the explicit supported migration preserves everything and the pending Question stays answerable', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite'),
    path = join(dir, 'control.sqlite');
  const { waiting, list } = await storageWithPendingQuestion(source);
  await writeFormatOne(source, path);
  const before = storage(await inspectStorage(path));
  assert.deepEqual([before.format, before.operational, before.problems], [1, 'migration-required', []]);
  assert.deepEqual(before.documents['factory.installation'], { count: 1, versions: { 1: 1 } });
  assert.deepEqual([before.installation!.paused, before.installation!.lifecycle], [true, null], 'format 1 recorded no lifecycle: nothing proves a clean stop');
  assert.deepEqual([before.preserved!.works, before.preserved!.questions], [2, { open: 1, answered: 0 }]);
  // The operational open refuses BEFORE any Session exists and writes nothing (no lazy document migration).
  await assert.rejects(
    openControl({ storagePath: path, runtimeInventory: 'unknown' }),
    (error: unknown) => error instanceof StorageFormatError && error.code === 'STORAGE_MIGRATION_REQUIRED',
  );
  assert.deepEqual(storage(await inspectStorage(path)), before);
  // Explicit migration: one commit; ids, index/cycles, FIFO, Questions, Slots, limits, history unchanged (preserved digest), installation v2.
  const migrated = await migrateStorage(path, { upgradeId: 'up-1', release: 'mvp-33.1', previousRelease: 'mvp-32.1' });
  assert.equal(migrated.kind, 'migrated');
  const after = storage(await inspectStorage(path));
  assert.deepEqual([after.format, after.operational, after.problems], [2, 'ready', []]);
  assert.deepEqual(after.preserved, before.preserved);
  assert.deepEqual(
    (after.installation!.migrations as { upgradeId: string; migration: string; from: number; to: number }[]).map(item => [
      item.upgradeId,
      item.migration,
      item.from,
      item.to,
    ]),
    [['up-1', 'factory-storage-1-to-2', 1, 2]],
  );
  // Completing the same upgrade again is idempotent; another upgrade finds nothing to migrate.
  assert.equal((await migrateStorage(path, { upgradeId: 'up-1', release: 'mvp-33.1', previousRelease: 'mvp-32.1' })).kind, 'already-applied');
  assert.equal((await migrateStorage(path, { upgradeId: 'up-2', release: 'mvp-33.1', previousRelease: 'mvp-32.1' })).kind, 'not-needed');
  // The new release starts paused, shows the same Work/queue/Question and accepts the answer through the public Control.
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown' });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const shown = (await control.inspect({ kind: 'show', work_id: waiting.work_id })) as Extract<ShowView, { kind: 'work' }>;
  assert.deepEqual([shown.work.queue, shown.work.cycle, shown.work.ticket], [waiting.queue, waiting.cycle, waiting.ticket]);
  assert.deepEqual(shown.work.dispatch.reasons.includes('GLOBAL_PAUSE'), true, 'starts paused');
  assert.deepEqual(shown.work.execution?.executionId, waiting.execution?.executionId);
  const status = (await control.inspect({ kind: 'status' })) as ControlStatus;
  assert.deepEqual([status.paused, status.works.total, status.storage.format, status.storage.previousRun], [true, list.works.length, 2, null]);
  const question = (await control.inspect({ kind: 'question', question_id: questionId })) as QuestionQueryView;
  assert.equal(question.kind === 'question' && question.question.state, 'open');
  const answer = (await control.accept({
    request_id: 'answer-after-upgrade',
    operation: 'answer',
    question_id: questionId,
    text: 'Use docs/factory.md',
    origin: 'local-cli',
  })) as ControlReceipt;
  assert.equal(answer.kind, 'durable');
  const answered = (await control.inspect({ kind: 'question', question_id: questionId })) as QuestionQueryView;
  assert.equal(answered.kind === 'question' && answered.question.state, 'answered');
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});

test('incompatible storages are refused before any change: unknown document kind, newer document version, other Pi Durable schema', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite');
  await status(source);
  const cases = [
    { name: 'unknown', extra: [{ kind: 'factory.future', version: 1, value: { anything: true } }], code: 'STORAGE_DOCUMENT_UNKNOWN' },
    {
      name: 'newer',
      extra: [{ kind: 'factory.work', version: 7, key: '00000000-0000-4000-8000-000000000001', value: { work: null } }],
      code: 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED',
    },
  ];
  for (const item of cases) {
    const path = join(dir, `${item.name}.sqlite`);
    await writeFormatOne(source, path, item.extra);
    const before = storage(await inspectStorage(path));
    assert.equal(before.operational, 'incompatible', item.name);
    assert.ok(
      before.problems.some(problem => problem.code === item.code),
      item.name,
    );
    await assert.rejects(
      openControl({ storagePath: path, runtimeInventory: 'unknown' }),
      (error: unknown) => error instanceof StorageFormatError && error.code === 'STORAGE_INCOMPATIBLE',
    );
    const refused = await migrateStorage(path, { upgradeId: 'up-x', release: 'r', previousRelease: null });
    assert.deepEqual([refused.kind, refused.kind === 'refused' && refused.code], ['refused', 'STORAGE_INCOMPATIBLE']);
    assert.deepEqual(storage(await inspectStorage(path)), before, `${item.name}: nothing written`);
  }
  // A Pi Durable schema this release does not support is never opened by SqliteStorage (that open would migrate it implicitly).
  const schema = join(dir, 'schema.sqlite');
  await writeFormatOne(source, schema);
  const database = await openNodeSqliteDatabase(schema); // Fixture edit of the backend version only (never a production path).
  await database.run('UPDATE durable_schema SET version = 1 WHERE singleton = 1');
  await database.close();
  const old = storage(await inspectStorage(schema));
  assert.deepEqual([old.operational, old.backend.durableSchema, old.problems[0]?.code], ['incompatible', 1, 'STORAGE_BACKEND_INCOMPATIBLE']);
  await assert.rejects(
    openControl({ storagePath: schema, runtimeInventory: 'unknown' }),
    (error: unknown) => error instanceof StorageFormatError && error.code === 'STORAGE_INCOMPATIBLE',
  );
  const check = await openNodeSqliteDatabase(schema);
  assert.equal((await check.get<{ version: number }>('SELECT version FROM durable_schema'))!.version, 1, 'the backend schema was not migrated');
  await check.close();
});
