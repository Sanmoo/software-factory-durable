import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBounded, snapshotStorage } from './review12-qualification.js';

// Recipe safety on temporary fixtures only (never the real root).
test('review fix 11: inspect/stop open only an exclusive private copy of the run storage; session reads are bounded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q12-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = join(dir, 'run');
  await mkdir(run);
  await writeFile(join(run, 'control.sqlite'), 'db');
  await writeFile(join(run, 'control.sqlite-wal'), 'wal');
  const before = await stat(join(run, 'control.sqlite'));
  const copy = await snapshotStorage(run, join(dir, 'inspect-storage-copy'));
  assert.equal(copy, join(dir, 'inspect-storage-copy', 'control.sqlite'));
  assert.deepEqual([await readFile(copy, 'utf8'), await readFile(join(dir, 'inspect-storage-copy', 'control.sqlite-wal'), 'utf8')], ['db', 'wal']);
  assert.equal((await stat(join(run, 'control.sqlite'))).mtimeMs, before.mtimeMs, 'original untouched');
  assert.equal((await stat(join(dir, 'inspect-storage-copy'))).mode & 0o777, 0o700);
  await assert.rejects(snapshotStorage(run, join(dir, 'inspect-storage-copy')), 'a phase copy is exclusive, never reused');
  await assert.rejects(snapshotStorage(join(dir, 'missing'), join(dir, 'other')), 'no storage, no inspection');
  await writeFile(join(dir, 'big.jsonl'), 'x'.repeat(100));
  await symlink(join(dir, 'big.jsonl'), join(dir, 'link.jsonl'));
  assert.deepEqual(await readBounded(join(dir, 'big.jsonl'), 10), { skipped: 'larger-than-10' });
  assert.deepEqual(await readBounded(join(dir, 'link.jsonl'), 1000), { skipped: 'not-a-regular-file' });
  assert.deepEqual(await readBounded(join(dir, 'big.jsonl'), 1000), { text: 'x'.repeat(100) });
});
