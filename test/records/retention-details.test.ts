import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords, listDetails, preserveEvidence, preserveSessionCopy, removeRecordsDetail } from '../../src/records/index.js';

// Ticket 30: inventory, session preservation and confined removal over a REAL private Records area, with the capture shape of the real
// q17-delivery-v4 run (records written by Records itself): raw tool outputs (UUID call ids), Host probe/handoff outputs, and Records event
// envelopes (worker-start, review-opinion, review-opinion-forward, mutation-intent/result, question requests).
const workId = 'w-retention';
const base = { workId, executionId: 'e-1', invocationId: 'i-1', role: 'builder' as const, environmentRef: 'env', bootRef: 'boot' };
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function area(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'records-retention30-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const raw = async (callId: string, text: string, finish = true) => {
    const output = await records.openOutput({ ...base, callId });
    await output.write(Buffer.from(text));
    if (finish) await output.finish();
    return output.reference;
  };
  const tool = [await raw(randomUUID(), 'ls output'), await raw(randomUUID(), 'git status output')];
  const partial = await raw(randomUUID(), 'still writing', false);
  await raw(`probe-${randomUUID()}`, '{"clean": true, "headMatches": true}');
  await raw(`handoff-${randomUUID()}`, 'handoff gate output');
  const kept = [
    await records.record({ ...base, callId: 'worker-start' }, { version: 1, kind: 'worker-start' }),
    await records.record({ ...base, role: 'spec', callId: 'review-opinion' }, { kind: 'review-opinion', verdict: 'approve' }),
    await records.record({ ...base, role: 'spec', callId: 'review-opinion-forward' }, { opinion: { verdict: 'approve' } }),
    await records.record({ ...base, callId: randomUUID() }, { kind: 'mutation-intent', path: 'a.ts' }),
    await records.record({ ...base, callId: 'question-request' }, { kind: 'question', question: 'Which DB?' }),
  ];
  await raw('custom-call', 'unknown kind of capture');
  const evidence = await preserveEvidence({
    root,
    workId,
    label: 'env',
    stage: async destination => {
      await writeFile(join(destination, 'review.json'), '{}');
    },
  });
  assert.equal(evidence.status, 'preserved');
  const session = Buffer.from('{"type":"session","id":"s-1"}\n');
  return { root, tool, partial, kept, session };
}

test('real-data shape: only tool/command outputs and session copies are details; records history needs, Host evidence and unknown kinds are kept', async t => {
  const { root, tool, partial, session } = await area(t);
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-1', session, sha(session)), { status: 'preserved', sha256: sha(session), bytes: session.length });
  assert.deepEqual(
    await preserveSessionCopy(root, workId, 'e-1', session, sha(session)),
    { status: 'already', sha256: sha(session), bytes: session.length },
    'idempotent, never overwritten',
  );
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-1', Buffer.from('other'), sha(Buffer.from('other'))), {
    status: 'failed',
    code: 'SESSION_COPY_CONFLICT',
  });
  assert.deepEqual(
    await preserveSessionCopy(root, workId, 'e-2', session, 'f'.repeat(64)),
    { status: 'failed', code: 'SESSION_COPY_INVALID' },
    'bytes must match the hash',
  );
  assert.deepEqual(
    await preserveSessionCopy(root, '../escape', 'e-2', session, sha(session)),
    { status: 'failed', code: 'SESSION_COPY_INVALID' },
    'workId validated',
  );
  const listed = await listDetails(root, workId);
  assert.equal(listed.completeness, 'complete', JSON.stringify(listed.unknown));
  assert.equal(listed.evidence, 1);
  assert.deepEqual(listed.kept, {
    'host-evidence': 2,
    'record:worker-start': 1,
    'record:review-opinion': 1,
    'record:review-opinion-forward': 1,
    'record:mutation-intent': 1,
    'record:question': 1,
    'unknown-kind': 1,
  });
  assert.deepEqual(
    listed.items.map(item => [item.id, item.kind, item.state]).sort(),
    [
      [`log:${tool[0]!.id}`, 'log', 'complete'],
      [`log:${tool[1]!.id}`, 'log', 'complete'],
      [`log:${partial.id}`, 'log', 'partial'],
      ['session:e-1', 'session', 'complete'],
    ].sort(),
  );
  assert.equal(listed.items.find(item => item.kind === 'session')?.sha256, sha(session));
  const none = await listDetails(root, 'w-unknown');
  assert.deepEqual(
    { ...none, observedAt: 'x' },
    { completeness: 'complete', observedAt: 'x', items: [], evidence: 0, kept: {}, unknown: [] },
    'no records: complete and empty',
  );
  await writeFile(join(root, workId, 'stray'), 'x', { mode: 0o600 });
  const stray = await listDetails(root, workId);
  assert.deepEqual([stray.completeness, stray.unknown], ['incomplete', ['stray']]);
});

test('removal: only a tool output capture or a session at its listed hash; records, evidence, symlinks and changed sessions are refused', async t => {
  const { root, tool, kept, session } = await area(t);
  await preserveSessionCopy(root, workId, 'e-1', session, sha(session));
  for (const reference of kept)
    assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${reference.id}`, kind: 'log' }, null), {
      outcome: 'refused',
      code: 'NOT_A_LOG_CAPTURE',
    });
  const manifests = (await readdir(join(root, workId, 'evidence'))).filter(name => name !== tool[0]!.id).length;
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'session:e-1', kind: 'session' }, 'f'.repeat(64)), {
    outcome: 'refused',
    code: 'SESSION_CHANGED',
  });
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'session:e-1', kind: 'session' }, sha(session)), { outcome: 'removed', code: null });
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'session:e-1', kind: 'session' }, sha(session)), { outcome: 'absent', code: null });
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${tool[0]!.id}`, kind: 'log' }, null), { outcome: 'removed', code: null });
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${tool[0]!.id}`, kind: 'log' }, null), { outcome: 'absent', code: null });
  assert.equal((await readdir(join(root, workId, 'evidence'))).length, manifests, 'every kept capture and the evidence are still there');
  await symlink('/etc/passwd', join(root, workId, 'evidence', tool[1]!.id, 'link'));
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: `log:${tool[1]!.id}`, kind: 'log' }, null), { outcome: 'refused', code: 'NOT_A_LOG_CAPTURE' });
  await unlink(join(root, workId, 'evidence', tool[1]!.id, 'link'));
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'log:../../x', kind: 'log' }, null), { outcome: 'refused', code: 'DETAIL_ID_INVALID' });
  assert.deepEqual(await removeRecordsDetail(root, '../escape', { id: `log:${tool[1]!.id}`, kind: 'log' }, null), {
    outcome: 'failed',
    code: 'RECORDS_AREA_UNAVAILABLE',
  });
  await mkdir(join(root, 'w-open'), { mode: 0o755 });
  await chmod(join(root, 'w-open'), 0o755);
  assert.deepEqual(await removeRecordsDetail(root, 'w-open', { id: `log:${tool[1]!.id}`, kind: 'log' }, null), {
    outcome: 'failed',
    code: 'RECORDS_AREA_UNAVAILABLE',
  });
  assert.equal((await listDetails(root, 'w-open')).completeness, 'incomplete');
});

test('a session copy interrupted between link and unlink (nlink 2 + temporary) or before link is repaired idempotently, never blocking', async t => {
  const { root, session } = await area(t);
  const sessions = join(root, workId, 'sessions');
  await mkdir(sessions, { mode: 0o700 });
  // Crash after link, before unlink: the published copy and its temporary are the same inode.
  await writeFile(join(sessions, '.e-1.11111111-2222-4333-8444-555555555555.tmp'), session, { mode: 0o600 });
  await link(join(sessions, '.e-1.11111111-2222-4333-8444-555555555555.tmp'), join(sessions, 'e-1.jsonl'));
  // Crash before link: an unpublished temporary of another copy.
  await writeFile(join(sessions, '.e-2.11111111-2222-4333-8444-666666666666.tmp'), 'partial', { mode: 0o600 });
  const listed = await listDetails(root, workId);
  assert.equal(listed.completeness, 'complete', 'leftover temporaries are not unknown entries');
  assert.deepEqual(
    listed.items.filter(item => item.kind === 'session').map(item => item.id),
    ['session:e-1'],
  );
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-1', session, sha(session)), { status: 'already', sha256: sha(session), bytes: session.length });
  assert.deepEqual(await preserveSessionCopy(root, workId, 'e-2', session, sha(session)), { status: 'preserved', sha256: sha(session), bytes: session.length });
  assert.deepEqual((await readdir(sessions)).sort(), ['e-1.jsonl', 'e-2.jsonl'], 'temporaries discarded, copies single-link');
  assert.equal((await lstat(join(sessions, 'e-1.jsonl'))).nlink, 1);
  // A session copy left with its temporary is still removable (the temporary goes with it).
  await link(join(sessions, 'e-2.jsonl'), join(sessions, '.e-2.11111111-2222-4333-8444-777777777777.tmp'));
  assert.deepEqual(await removeRecordsDetail(root, workId, { id: 'session:e-2', kind: 'session' }, sha(session)), { outcome: 'removed', code: null });
  assert.equal(await exists(join(sessions, '.e-2.11111111-2222-4333-8444-777777777777.tmp')), false);
});
