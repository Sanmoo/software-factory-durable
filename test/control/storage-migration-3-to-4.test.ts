import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@earendil-works/pi-durable';
import { controlStorageFormats, inspectStorage, migrateStorage, openControl, StorageFormatError, type StorageInspection } from '../../src/control/index.js';
import type { ControlStatus, ListView } from '../../src/control/types.js';
import { githubDoubles, manualClock, scope } from './doubles.js';
import { storageWithPendingQuestion, storedBytesExceptInstallation, storedDocuments, writeFormatThree } from './upgrade-fixture.js';

// Flow level: a REAL Control + Pi Durable + SQLite storage holding two Works, a held Slot's
// history, a published open Question and its receipts, re-expressed as format 3 (every release that knows the Jira origin and no Triage)
// through the public Pi Durable API. The explicit factory-storage-3-to-4 migration runs on it; then the current Control runs on the result
// with a GitHub double that records every call. The upgrade command and the built release are in test/entrypoints (upgrade, release-upgrade).
// NOT evidence of a real VM, worker, model, GitHub or Jira, nor of the binary of an older release.
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-format4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const storage = (inspection: StorageInspection) => {
  assert.equal(inspection.kind, 'storage');
  return inspection as Extract<StorageInspection, { kind: 'storage' }>;
};
const installationOf = async (path: string) => (await storedDocuments(path)).find(item => item.kind === 'factory.installation')!;
/** Documents of the kinds only format 3 added (opaque values: this file never opens a Control on the storage that holds them). */
const jiraDocuments = [
  {
    kind: 'factory.jira-impediment',
    version: 1,
    key: 'acme.atlassian.net/PAY-7',
    value: { impediment: { code: 'SYNTHETIC', since: '2026-11-01T00:00:00.000Z' } },
  },
  { kind: 'factory.jira-comment', version: 1, key: 'comment-effect-1', value: { effect: { state: 'settled', body: 'kept as written  ' } } },
  { kind: 'factory.jira-link', version: 1, key: 'link-of-work-1', value: { link: { desired: 'https://github.com/acme/project/pull/90', confirmed: true } } },
];
/** The format table of a release that knows no Triage: this release's without format 4. */
const beforeTriage = (() => {
  const { 4: _four, ...older } = controlStorageFormats;
  return older;
})();

test('factory-storage-3-to-4 changes only the format identity; Works, Slots, Questions and every other document stay byte for byte and no Triage request is created', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite'),
    path = join(dir, 'control.sqlite');
  await storageWithPendingQuestion(source);
  await writeFormatThree(source, path, { extra: jiraDocuments });
  const before = storage(await inspectStorage(path));
  assert.deepEqual([before.format, before.operational, before.problems], [3, 'migration-required', []]);
  assert.deepEqual(before.documents['factory.installation'], { count: 1, versions: { 3: 1 } });
  assert.deepEqual([before.preserved!.works, before.preserved!.questions], [2, { open: 1, answered: 0 }]);
  const bytesBefore = storedBytesExceptInstallation(path);
  const kinds = [...new Set(bytesBefore.rows.map(row => row.kind))].sort();
  assert.deepEqual(
    kinds,
    [
      'factory.jira-comment',
      'factory.jira-impediment',
      'factory.jira-link',
      'factory.question',
      'factory.request',
      'factory.slots',
      'factory.ticket-index',
      'factory.work',
    ],
    'the fixture holds every kind of format 3',
  );
  assert.ok(bytesBefore.revisions.length >= bytesBefore.rows.length, 'every document has its stored revisions in the comparison');
  const installationBefore = await installationOf(path);
  assert.equal(installationBefore.version, 3);
  // No lazy migration: the operational open refuses before any Session exists and writes nothing.
  await assert.rejects(
    openControl({ storagePath: path, runtimeInventory: 'unknown' }),
    (error: unknown) => error instanceof StorageFormatError && error.code === 'STORAGE_MIGRATION_REQUIRED',
  );
  assert.deepEqual(storedBytesExceptInstallation(path), bytesBefore);
  assert.deepEqual(await installationOf(path), installationBefore);

  const migrated = await migrateStorage(path, { upgradeId: 'up-4', release: 'triage-1', previousRelease: 'jira-1', expectedDigest: before.preserved!.digest });
  assert.deepEqual([migrated.kind, migrated.kind === 'migrated' && migrated.migration], ['migrated', 'factory-storage-3-to-4']);
  const after = storage(await inspectStorage(path));
  assert.deepEqual([after.format, after.operational, after.problems], [4, 'ready', []]);
  // Every other document: the same rows and the same revisions, as stored. Nothing added, nothing rewritten.
  assert.deepEqual(storedBytesExceptInstallation(path), bytesBefore);
  assert.deepEqual(after.preserved, before.preserved);
  assert.deepEqual(
    Object.fromEntries(Object.entries(after.documents).map(([kind, entry]) => [kind, entry.count])),
    Object.fromEntries(Object.entries(before.documents).map(([kind, entry]) => [kind, entry.count])),
    'no document created: no Triage request, no other record',
  );
  assert.equal(after.documents['factory.triage-request'], undefined);
  // The installation: version 4, its format identity 4 and this migration's record; pause, history, earlier records and lifecycle as they were.
  const installationAfter = await installationOf(path);
  assert.equal(installationAfter.version, 4);
  const { storage: identityBefore, ...restBefore } = installationBefore.value;
  const { storage: identityAfter, ...restAfter } = installationAfter.value;
  assert.deepEqual(restAfter, restBefore);
  const [record, ...unexpected] = ((identityAfter as JsonObject).migrations as JsonObject[]).slice(
    ((identityBefore as JsonObject).migrations as JsonObject[]).length,
  );
  assert.deepEqual(unexpected, []);
  const { at, ...recorded } = record!;
  assert.deepEqual(recorded, { upgradeId: 'up-4', migration: 'factory-storage-3-to-4', from: 3, to: 4, release: 'triage-1', previousRelease: 'jira-1' });
  assert.ok(!Number.isNaN(Date.parse(at as string)));
  assert.deepEqual([(identityBefore as JsonObject).format, (identityAfter as JsonObject).format], [3, 4]);
  // Idempotent per upgrade; another upgrade finds nothing to migrate. Neither writes.
  const bytesOfInstallation = JSON.stringify(installationAfter);
  assert.equal(
    (await migrateStorage(path, { upgradeId: 'up-4', release: 'triage-1', previousRelease: 'jira-1', expectedDigest: before.preserved!.digest })).kind,
    'already-applied',
  );
  assert.equal((await migrateStorage(path, { upgradeId: 'up-5', release: 'triage-1', previousRelease: 'jira-1' })).kind, 'not-needed');
  assert.equal(JSON.stringify(await installationOf(path)), bytesOfInstallation);
  assert.deepEqual(storedBytesExceptInstallation(path), bytesBefore);
});

test('a release that knows no Triage refuses the storage in format 4, even with no Triage request stored', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite'),
    path = join(dir, 'control.sqlite');
  await storageWithPendingQuestion(source);
  await writeFormatThree(source, path);
  // Read with the table of a release that ends at format 3, the same storage is its own format before the migration...
  const older = storage(await inspectStorage(path, beforeTriage));
  assert.deepEqual([older.format, older.problems], [3, []]);
  assert.equal((await migrateStorage(path, { upgradeId: 'up-4', release: 'triage-1', previousRelease: 'jira-1' })).kind, 'migrated');
  // ...and after it no format at all: the installation version is one it does not know, which is the refusal of every open.
  const refused = storage(await inspectStorage(path, beforeTriage));
  assert.deepEqual(
    [refused.format, refused.operational, refused.problems],
    [null, 'incompatible', [{ code: 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED', detail: 'factory.installation version 4 is not part of any known format.' }]],
  );
  assert.equal(refused.documents['factory.triage-request'], undefined, 'refused with no Triage request stored');
  // This release reads the same storage as its own format.
  assert.deepEqual([storage(await inspectStorage(path)).format, storage(await inspectStorage(path)).operational], [4, 'ready']);
});

test('after the migration the Control runs on the same Works and Question, publishes nothing and creates no Triage request', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite'),
    path = join(dir, 'control.sqlite');
  const { list, remote } = await storageWithPendingQuestion(source);
  await writeFormatThree(source, path);
  const before = storage(await inspectStorage(path));
  assert.equal((await migrateStorage(path, { upgradeId: 'up-4', release: 'triage-1', previousRelease: 'jira-1' })).kind, 'migrated');
  const github = githubDoubles(remote);
  const time = manualClock();
  const control = await openControl({
    storagePath: path,
    runtimeInventory: 'unknown',
    polling: { intervalSeconds: 60, clock: time.clock },
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  for (let round = 0; round < 2; round++) {
    await time.sleeping();
    time.advance();
  }
  await time.sleeping();
  const status = (await control.inspect({ kind: 'status' })) as ControlStatus;
  assert.deepEqual([status.storage.format, status.paused, status.works.total, status.questions.open], [4, true, list.works.length, 1]);
  assert.deepEqual(
    ((await control.inspect({ kind: 'list' })) as ListView).works.map(work => [work.work_id, work.queue, work.cycle]),
    list.works.map(work => [work.work_id, work.queue, work.cycle]),
  );
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
  assert.ok(github.calls.length > 0, 'the Control did observe the origin');
  assert.deepEqual(
    github.calls.filter(call => !/^(read|list|find|observe|check)/.test(call.method)).map(call => call.method),
    [],
    'only reads reached the origin: nothing published',
  );
  const final = storage(await inspectStorage(path));
  assert.equal(final.documents['factory.triage-request'], undefined);
  assert.deepEqual([final.preserved!.works, final.preserved!.questions], [before.preserved!.works, before.preserved!.questions]);
});
