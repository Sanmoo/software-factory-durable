import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords, listDetails, preserveEvidence, preserveSessionCopy, removeRecordsDetail } from '../../src/records/index.js';

// Ticket 30: inventory, session preservation and confined removal over a REAL private Records area (real captures written by Records).
const workId = 'w-retention';
const context = { workId, executionId: 'e-1', invocationId: 'i-1', role: 'builder' as const, environmentRef: 'env', bootRef: 'boot', callId: 'c-1' };
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const exists = (path: string) => lstat(path).then(() => true, () => false);

async function area(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'records-retention30-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const complete = await records.record(context, { tool: 'bash', exit: 0 });
  const partial = await records.openOutput({ ...context, callId: 'c-2' });
  await partial.write(Buffer.from('still writing'));
  const evidence = await preserveEvidence({ root, workId, label: 'env', stage: async destination => { await writeFile(join(destination, 'review.json'), '{}'); } });
  assert.equal(evidence.status, 'preserved');
  const session = Buffer.from('{"type":"session","id":"s-1"}\n');
  return { root, complete, partial, session };
}

test('inventory: logs (complete/partial) with their Execution, preserved sessions, protected evidence counted apart; unexpected entries make it incomplete', async t => {
  const { root, complete, partial, session } = await area(t);
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-1', session, sha(session)), { status: 'preserved', sha256: sha(session), bytes: session.length });
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-1', session, sha(session)), { status: 'already', sha256: sha(session), bytes: session.length }, 'idempotent, never overwritten');
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-1', Buffer.from('other'), sha(Buffer.from('other'))), { status: 'failed', code: 'SESSION_COPY_CONFLICT' });
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-2', session, 'f'.repeat(64)), { status: 'failed', code: 'SESSION_COPY_INVALID' }, 'bytes must match the recorded hash');
  const listed = await listDetails(root, workId);
  assert.equal(listed.completeness, 'complete');
  assert.equal(listed.evidence, 1, 'preserved evidence is protected, never listed as a detail');
  assert.deepEqual(listed.items.map(item => [item.id, item.kind, item.executionId, item.state]).sort(), [
    [`log:${complete.id}`, 'log', 'e-1', 'complete'], [`log:${partial.reference.id}`, 'log', 'e-1', 'partial'], ['session:e-1', 'session', 'e-1', 'complete']].sort());
  assert.deepEqual(await listDetails(root, 'w-unknown'), { ...await listDetails(root, 'w-unknown'), completeness: 'complete', items: [] }, 'a Work with no records: complete and empty');
  await writeFile(join(root, workId, 'stray'), 'x', { mode: 0o600 });
  const stray = await listDetails(root, workId);
  assert.equal(stray.completeness, 'incomplete');
  assert.deepEqual(stray.unknown, ['stray']);
});

test('removal: only an own log capture or the recorded session content; evidence, symlinks and changed sessions are refused; absence only under an intact area', async t => {
  const { root, complete, session } = await area(t);
  await preserveSessionCopy(root, workId, 'e-1', session, sha(session));
  const listed = await listDetails(root, workId);
  const evidenceDir = (await readdir(join(root, workId, 'evidence'))).filter(name => !listed.items.some(item => item.id === `log:${name}`));
  assert.equal(evidenceDir.length, 1);
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${evidenceDir[0]}`, kind: 'log' }, null), { outcome: 'refused', code: 'NOT_A_LOG_CAPTURE' }, 'preserved evidence is never a target');
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'session:e-1', kind: 'session' }, 'f'.repeat(64)), { outcome: 'refused', code: 'SESSION_CHANGED' });
  assert.ok(await exists(join(root, workId, 'sessions', 'e-1.jsonl')));
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'session:e-1', kind: 'session' }, sha(session)), { outcome: 'removed', code: null });
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'session:e-1', kind: 'session' }, sha(session)), { outcome: 'absent', code: null });
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${complete.id}`, kind: 'log' }, null), { outcome: 'removed', code: null });
  assert.equal(await exists(join(root, workId, 'evidence', complete.id)), false);
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${complete.id}`, kind: 'log' }, null), { outcome: 'absent', code: null });
  assert.ok(await exists(join(root, workId, 'evidence', evidenceDir[0]!, 'manifest.json')), 'evidence untouched');
  // A capture holding an unexpected entry (e.g. a symlink planted next to it) is refused whole.
  const records = await createRecords({ root });
  const other = await records.record({ ...context, callId: 'c-3' }, { tool: 'read' });
  await symlink('/etc/passwd', join(root, workId, 'evidence', other.id, 'link'));
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${other.id}`, kind: 'log' }, null), { outcome: 'refused', code: 'NOT_A_LOG_CAPTURE' });
  await unlink(join(root, workId, 'evidence', other.id, 'link'));
  // A foreign Work's id is never reachable through this Work (ids are confined to the Work directory) and bad ids are refused.
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'log:../../x', kind: 'log' }, null), { outcome: 'refused', code: 'DETAIL_ID_INVALID' });
  assert.deepEqual(await removeRecordsDetail(root, '../escape', { id: `log:${other.id}`, kind: 'log' }, null), { outcome: 'failed', code: 'RECORDS_AREA_UNAVAILABLE' });
  // An unsafe Records root concludes nothing (never "absent").
  await mkdir(join(root, 'w-open'), { mode: 0o755 });
  await chmod(join(root, 'w-open'), 0o755);
  assert.deepEqual(await removeRecordsDetail(root, 'w-open', { id: `log:${other.id}`, kind: 'log' }, null), { outcome: 'failed', code: 'RECORDS_AREA_UNAVAILABLE' });
  assert.equal((await listDetails(root, 'w-open')).completeness, 'incomplete');
});
