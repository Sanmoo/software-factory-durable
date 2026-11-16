import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords, forgetWorkRecords, inspectWorkRecords, preserveEvidence, preserveSessionCopy } from '../../src/records/index.js';
import { createHash } from 'node:crypto';

// Ticket 31: inspection and fail-closed deletion of a Work's WHOLE Records area over a REAL private Records area (captures written by Records,
// preserved evidence, a session copy). Nothing is followed; an unsafe entry refuses the whole deletion before anything is touched.
const workId = 'w-forget';
const base = { workId, executionId: 'e-1', invocationId: 'i-1', role: 'builder' as const, environmentRef: 'env', bootRef: 'boot' };
const exists = (path: string) => lstat(path).then(() => true, () => false);

async function area(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'records-forget31-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const output = await records.openOutput({ ...base, callId: randomUUID() });
  await output.write(Buffer.from('tool output')); await output.finish();
  await records.record({ ...base, callId: 'worker-start' }, { version: 1, kind: 'worker-start' });
  await preserveEvidence({ root, workId, label: 'env', stage: async destination => { await mkdir(join(destination, 'review'), { mode: 0o755 }); await writeFile(join(destination, 'review', 'a.json'), '{}'); } });
  const data = Buffer.from('{"type":"session"}\n');
  await preserveSessionCopy(root, workId, 'e-1', data, createHash('sha256').update(data).digest('hex'));
  const foreign = await records.openOutput({ ...base, workId: 'w-other', callId: randomUUID() });
  await foreign.write(Buffer.from('foreign')); await foreign.finish();
  return { root };
}

test('forget: inspects the whole tree, deletes it (rename to a tombstone first), and never touches another Work; absent afterwards', async t => {
  const { root } = await area(t);
  const tree = await inspectWorkRecords(root, workId);
  assert.equal(tree.completeness, 'complete');
  assert.deepEqual([tree.present, tree.leftover, tree.unsafe], [true, false, []]);
  assert.ok(tree.files >= 8 && tree.bytes > 0, JSON.stringify(tree));
  const result = await forgetWorkRecords(root, workId);
  assert.deepEqual([result.outcome, result.code, result.files], ['removed', null, tree.files]);
  assert.equal(await exists(join(root, workId)) || await exists(join(root, `.forget-${workId}`)), false);
  assert.ok(await exists(join(root, 'w-other')), 'another Work\'s Records stay');
  assert.deepEqual(await forgetWorkRecords(root, workId), { outcome: 'absent', code: null, files: 0, bytes: 0 });
  const after = await inspectWorkRecords(root, workId);
  assert.deepEqual([after.completeness, after.present, after.leftover, after.files], ['complete', false, false, 0]);
});

test('forget: an unsafe entry (symlink) refuses the whole deletion before anything is touched; invalid ids and a foreign root are refused', async t => {
  const { root } = await area(t);
  const target = join(root, 'outside'); await writeFile(target, 'must survive');
  await symlink(target, join(root, workId, 'evidence', 'link'));
  const tree = await inspectWorkRecords(root, workId);
  assert.deepEqual([tree.completeness, tree.unsafe], ['incomplete', [`${workId}/evidence/link`]]);
  const before = tree.files;
  assert.deepEqual(await forgetWorkRecords(root, workId), { outcome: 'refused', code: 'RECORDS_TREE_UNSAFE', files: 0, bytes: 0 });
  assert.equal((await inspectWorkRecords(root, workId)).files, before, 'nothing was removed');
  assert.ok(await exists(target));
  assert.equal((await forgetWorkRecords(root, '../etc')).outcome, 'refused');
  await chmod(root, 0o755);
  assert.equal((await forgetWorkRecords(root, workId)).code, 'RECORDS_AREA_UNAVAILABLE');
  await chmod(root, 0o700);
});

test('forget: an interrupted earlier deletion (tombstone left) is visible to the inspection and completed by the next forget', async t => {
  const { root } = await area(t);
  await rename(join(root, workId), join(root, `.forget-${workId}`));
  const tree = await inspectWorkRecords(root, workId);
  assert.deepEqual([tree.completeness, tree.present, tree.leftover], ['complete', false, true]);
  assert.equal((await forgetWorkRecords(root, workId)).outcome, 'removed');
  assert.equal(await exists(join(root, `.forget-${workId}`)), false);
});
