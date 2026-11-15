import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords, listDetails, preserveEvidence } from '../../src/records/index.js';
import { markDelivered, seedPublishedWork, store } from '../control/delivery-fixture.js';
import { copyRecords, ownerRun, verdict } from './retention30-qualification.js';

// Ticket 30 recipe core on TEMPORARY fixtures (never the real root): the private Records copy, two real owner runs (public openControl with the
// production detail ports, local refusing doubles for every remote port, fixed calendar) and the verdict. Proves the recipe can work offline.
const day = 86_400_000;

test('recipe core: Records copied privately (symlink refused); run A retained + plan only; run B removes the copy\'s expired details; verdict met; no remote call', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'q30-recipe-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'); await mkdir(source, { mode: 0o700 });
  const opened = await store(t, source);
  const work_id = await seedPublishedWork(opened.session);
  const confirmedAt = new Date(Date.now() - 2 * day).toISOString();
  await markDelivered(opened.session, work_id, confirmedAt);
  await opened.close();
  const records = await createRecords({ root: source });
  const context = { workId: work_id, executionId: 'e-1', invocationId: 'i-1', role: 'builder' as const, environmentRef: 'env', bootRef: 'boot', callId: 'c-1' };
  // Real-data shape (q30-retention-v1: 88 logs): more logs than one intent batch (50), so a sweep spans several batches.
  for (let index = 0; index < 88; index++) await records.record({ ...context, callId: `c-${index}` }, { tool: 'bash', index });
  await preserveEvidence({ root: source, workId: work_id, label: 'env', stage: async () => {} });
  // A symlink anywhere in the source Records refuses the copy.
  const unsafe = join(dir, 'unsafe'); await mkdir(unsafe, { mode: 0o700 }); await symlink('/etc/passwd', join(unsafe, 'x'));
  await assert.rejects(copyRecords(unsafe, join(dir, 'unsafe-copy')), /RECORDS_COPY_UNSAFE/);
  const recordsRoot = join(dir, 'records'); await mkdir(recordsRoot, { mode: 0o700 }); await chmod(recordsRoot, 0o700);
  const copied = await copyRecords(join(source, work_id), join(recordsRoot, work_id));
  assert.ok(copied.files >= 5);
  const count = async () => { const inventory = await listDetails(recordsRoot, work_id); return { logs: inventory.items.filter(item => item.kind === 'log').length,
    sessions: inventory.items.filter(item => item.kind === 'session').length, evidence: inventory.evidence }; };
  const before = await count();
  assert.deepEqual(before, { logs: 88, sessions: 0, evidence: 1 });
  const storagePath = join(source, 'control.sqlite');
  const at = Date.parse(confirmedAt);
  const runA = await ownerRun({ storagePath, recordsRoot, workId: work_id, now: at + day, planSelect: ['logs', 'sessions', 'environment'], requestId: 'q30-test-a', deadlineMs: 20000 });
  assert.equal(runA.outcome.kind, 'clean');
  assert.equal(runA.work?.retention?.state, 'retained');
  assert.equal(runA.status && 'retention' in runA.status ? runA.status.retention?.sweeps : null, 1, 'run A stopped only after its completed boot sweep');
  const runB = await ownerRun({ storagePath, recordsRoot, workId: work_id, now: at + 31 * day, deadlineMs: 20000 });
  const after = await count();
  assert.deepEqual(after, { logs: 0, sessions: 0, evidence: 1 }, 'only the copy\'s logs are gone; evidence kept');
  assert.equal((await listDetails(source, work_id)).items.length, 88, 'the source Records are untouched');
  const result = verdict({ confirmedAt, runA, runB, before, after, sourceBefore: 'same', sourceAfter: 'same' });
  assert.equal(result.overall, 'met', JSON.stringify(result.checks.filter(check => !check.met)));
  assert.ok(!('cleanupBranch' in runA.calls) && !('cleanupBranch' in runB.calls));
});
