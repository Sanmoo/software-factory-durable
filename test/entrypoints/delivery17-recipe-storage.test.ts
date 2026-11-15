import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStorage, type StorageInspection } from '../../src/control/index.js';
import { storageWithPendingQuestion, writeFormatOne } from '../control/upgrade-fixture.js';
import { prepareAuthority } from './delivery17-qualification.js';

// Ticket 17 recipe, storage path only (temporary fixtures, never the real root): a format-1 source (written before ticket 33) is COPIED and
// only the copy is migrated explicitly with ticket 33's digest-checked migrateStorage; the source stays byte-identical at format 1.
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const storage = (inspection: StorageInspection) => { assert.equal(inspection.kind, 'storage'); return inspection as Extract<StorageInspection, { kind: 'storage' }>; };

test('recipe preflight storage: a format-1 source is copied, ONLY the copy is migrated 1→2 with the preserved digest checked and recorded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q17-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await storageWithPendingQuestion(join(dir, 'state.sqlite'));
  const source = join(dir, 'source');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source, { mode: 0o700 });
  await writeFormatOne(join(dir, 'state.sqlite'), join(source, 'control.sqlite'));
  const sourceBefore = storage(await inspectStorage(join(source, 'control.sqlite')));
  assert.equal(sourceBefore.format, 1);
  const bytes = await sha(join(source, 'control.sqlite'));
  const result = await prepareAuthority(source, join(dir, 'authority'), 'q17-test');
  assert.equal(result.kind, 'migrated');
  if (result.kind !== 'migrated') return;
  assert.deepEqual([result.before.format, result.after.format], [1, 2]);
  assert.equal(result.before.digest, sourceBefore.preserved!.digest);
  assert.equal(result.after.digest, result.before.digest, 'preserved documents identical after the migration');
  assert.equal(result.storagePath, join(dir, 'authority', 'control.sqlite'));
  assert.equal(storage(await inspectStorage(result.storagePath)).format, 2);
  assert.equal(storage(await inspectStorage(join(source, 'control.sqlite'))).format, 1, 'the original is never migrated');
  assert.equal(await sha(join(source, 'control.sqlite')), bytes, 'the original is byte-identical');
  await assert.rejects(prepareAuthority(source, join(dir, 'authority'), 'q17-test'), 'the authority copy is exclusive, never reused');
});

test('recipe preflight storage: a format-2 source needs no migration; an absent source is refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q17-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'source'), { mode: 0o700 });
  await storageWithPendingQuestion(join(dir, 'source', 'control.sqlite'));
  const result = await prepareAuthority(join(dir, 'source'), join(dir, 'authority'), 'q17-test');
  assert.equal(result.kind, 'current');
  await assert.rejects(prepareAuthority(join(dir, 'missing'), join(dir, 'other'), 'q17-test'));
});
