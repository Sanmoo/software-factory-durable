import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { inspectStorage, migrateStorage, openControl, StorageFormatError, type StorageInspection } from '../../src/control/index.js';
import { openStore } from '../../src/control/durable/store.js';
import { recordRunStart } from '../../src/control/durable/migration.js';
import { storageWithPendingQuestion, writeFormatOne } from './upgrade-fixture.js';

// Flow level (ticket 33 review): strictness of the storage gate, verification BEFORE the migration commit, and the recorded run end.
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review33-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const storage = (inspection: StorageInspection) => { assert.equal(inspection.kind, 'storage'); return inspection as Extract<StorageInspection, { kind: 'storage' }>; };
const incompatibleOpen = (path: string) => assert.rejects(openControl({ storagePath: path, runtimeInventory: 'unknown' }),
  (error: unknown) => error instanceof StorageFormatError && error.code === 'STORAGE_INCOMPATIBLE');

test('a stop whose activity cessation is not confirmed is recorded uncertain, never clean', async t => {
  const dir = await directory(t);
  const path = join(dir, 'control.sqlite');
  await storageWithPendingQuestion(path, { cessation: false });
  const inspected = storage(await inspectStorage(path));
  assert.ok(inspected.activity.unsettled.length >= 1, 'the asking Execution is unsettled');
  assert.equal((inspected.installation!.lifecycle as { last: { end: string } }).last.end, 'uncertain');
});

test('only a provably empty file is fresh: a non-Factory SQLite database is refused and left untouched', async t => {
  const dir = await directory(t);
  const path = join(dir, 'control.sqlite');
  const database = await openNodeSqliteDatabase(path);
  await database.exec('CREATE TABLE foreign_data (x INTEGER)');
  await database.close();
  const inspected = storage(await inspectStorage(path));
  assert.equal(inspected.operational, 'incompatible');
  await incompatibleOpen(path);
  const check = await openNodeSqliteDatabase(path);
  const tables = await check.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  await check.close();
  assert.deepEqual(tables.map(row => row.name), ['foreign_data'], 'no Pi Durable schema was created');
});

test('Factory documents without the installation document are incompatible; the installation is never created lazily', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite'), path = join(dir, 'control.sqlite');
  await storageWithPendingQuestion(source);
  await writeFormatOne(source, path, [], ['factory.installation']);
  const before = storage(await inspectStorage(path));
  assert.equal(before.operational, 'incompatible');
  assert.ok(before.problems.some(problem => problem.code === 'STORAGE_INSTALLATION_MISSING'));
  await incompatibleOpen(path);
  assert.deepEqual(storage(await inspectStorage(path)), before);
  assert.equal((await migrateStorage(path, { upgradeId: 'u', release: 'r', previousRelease: null })).kind, 'refused');
});

test('the migration verifies the expected preserved state BEFORE its commit; a mismatch commits nothing', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite'), path = join(dir, 'control.sqlite');
  await storageWithPendingQuestion(source);
  await writeFormatOne(source, path);
  const before = storage(await inspectStorage(path));
  const refused = await migrateStorage(path, { upgradeId: 'u1', release: 'r', previousRelease: null, expectedDigest: 'f'.repeat(64) });
  assert.deepEqual([refused.kind, refused.kind === 'refused' && refused.code], ['refused', 'MIGRATION_VERIFICATION_FAILED']);
  assert.deepEqual(storage(await inspectStorage(path)), before, 'still format 1, nothing written');
  const migrated = await migrateStorage(path, { upgradeId: 'u1', release: 'r', previousRelease: null, expectedDigest: before.preserved!.digest });
  assert.equal(migrated.kind, 'migrated');
});

test('the full state digest covers lifecycle and migration records; the preserved digest does not', async t => {
  const dir = await directory(t);
  const path = join(dir, 'control.sqlite');
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown' });
  const aborted = new AbortController(); aborted.abort();
  await control.run(aborted.signal); // Initializes, records nothing, closes.
  const before = storage(await inspectStorage(path));
  const store = await openStore(path);
  await recordRunStart(store.session, 'run-x');
  await store.close();
  const after = storage(await inspectStorage(path));
  assert.equal(after.preserved!.digest, before.preserved!.digest);
  assert.notEqual(after.stateDigest, before.stateDigest);
});
