import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControl, type ListView } from '../../src/control/index.js';
import { holdStorageLock, openStorageCopy, resolveOperator } from './question10-qualification.js';

// Review 7: the recipe's inspection never writes the qualification storage (it reads a copy under the storage lock); review 3: the
// operator id is resolved from a GitHub observation and pinned. Local temporary files only.
const digest = async (dir: string) => {
  const hash = createHash('sha256');
  for (const name of (await readdir(dir)).filter(name => name.startsWith('control.sqlite')).sort()) hash.update(name).update(await readFile(join(dir, name)));
  return hash.digest('hex');
};

test('review 7: inspection opens a COPY under the exclusive storage lock; the original files are byte-identical afterwards; a second holder is refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q10-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'unknown' });
  const stop = new AbortController();
  stop.abort();
  await original.run(stop.signal);
  const before = await digest(dir);
  const lock = await holdStorageLock(join(dir, 'control.lock'));
  await assert.rejects(holdStorageLock(join(dir, 'control.lock')), /STORAGE_LOCK_UNAVAILABLE/);
  const copy = await openStorageCopy(join(dir, 'control.sqlite'), join(dir, 'inspect-copy'));
  assert.equal(((await copy.control.inspect({ kind: 'list' })) as ListView).kind, 'list');
  await copy.close();
  await lock.release();
  assert.equal(await digest(dir), before, 'the qualification storage was not written');
  const again = await holdStorageLock(join(dir, 'control.lock'));
  await again.release();
  await assert.rejects(openStorageCopy(join(dir, 'control.sqlite'), join(dir, 'inspect-copy')), /EEXIST/, 'never adopts an earlier copy');
});

test('review 3: the operator is pinned to the immutable id GitHub reports for the expected login; anything else is refused', () => {
  assert.deepEqual(resolveOperator({ owner: { login: 'Sanmoo', id: 4242, type: 'User' } }, 'sanmoo'), { login: 'Sanmoo', id: 4242 });
  for (const body of [
    { owner: { login: 'other', id: 1, type: 'User' } },
    { owner: { login: 'Sanmoo', id: 1, type: 'Organization' } },
    { owner: { login: 'Sanmoo' } },
    null,
  ]) {
    assert.throws(() => resolveOperator(body, 'Sanmoo'), /OPERATOR_IDENTITY_UNRESOLVED/);
  }
});
