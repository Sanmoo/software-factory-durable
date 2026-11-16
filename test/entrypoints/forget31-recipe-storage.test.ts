import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords, inspectWorkRecords, preserveEvidence } from '../../src/records/index.js';
import { cancelWithSuccessor, markCleaned, markDelivered, seedPublishedWork, store } from '../control/delivery-fixture.js';
import { ticket } from '../control/doubles.js';
import { copyRecords } from './retention30-qualification.js';
import { forgetOwnerRun, verdict, type CaseObservation } from './forget31-qualification.js';

// Ticket 31 recipe core on TEMPORARY fixtures (never the real root): a delivered Work (cleanup complete) and a cancelled cycle with an open
// successor, their Records copied privately, real owner runs through the public `openControl` (CLI accept/inspect path) with the production
// detail ports, local doubles for every remote port, and the verdict (met; a no-op is not met). Proves the recipe can work offline.
const label = { id: 55, name: 'ready-for-agent' };

async function source(dir: string, name: string, number: number, kind: 'delivered' | 'cancelled') {
  const path = join(dir, `${name}-source`); await mkdir(path, { mode: 0o700 });
  const opened = await store({ after: () => {} }, path);
  const work_id = await seedPublishedWork(opened.session, { number, ...(kind === 'delivered' ? { environmentFor: () => 'no-environment' } : {}) });
  let successor: string | null = null;
  if (kind === 'delivered') { await markDelivered(opened.session, work_id, new Date().toISOString()); await markCleaned(opened.session, work_id); }
  else successor = await cancelWithSuccessor(opened.session, work_id, number);
  await opened.close();
  const records = await createRecords({ root: path });
  const context = { workId: work_id, executionId: 'e-1', invocationId: 'i-1', role: 'builder' as const, environmentRef: 'env', bootRef: 'boot', callId: 'c-1' };
  for (let index = 0; index < 5; index++) { const output = await records.openOutput({ ...context, callId: randomUUID() }); await output.write(Buffer.from(`out ${index}`)); await output.finish(); }
  await records.record({ ...context, role: 'spec', callId: 'review-opinion' }, { kind: 'review-opinion' });
  await preserveEvidence({ root: path, workId: work_id, label: 'env', stage: async () => {} });
  const caseRoot = join(dir, name); await mkdir(join(caseRoot, 'records'), { recursive: true, mode: 0o700 });
  const recordsRoot = await realpath(join(caseRoot, 'records'));
  await copyRecords(join(path, work_id), join(recordsRoot, work_id));
  return { storagePath: join(path, 'control.sqlite'), copyRoot: caseRoot, recordsRoot, workId: work_id, successor, ticket: ticket(number), label, now: Date.now(),
    repositoryName: 'acme/project', deadlineMs: 20000, before: await inspectWorkRecords(recordsRoot, work_id) };
}

test('recipe core: delivered and cancelled Works forgotten on copies through the public Control; existing after forget and restart; verdict met, no-op not met; no remote call', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'q31-recipe-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const d = await source(dir, 'delivered', 3, 'delivered');
  const c = await source(dir, 'cancelled', 18, 'cancelled');
  assert.ok(d.before.present && d.before.files >= 8 && c.before.present);
  const runDA = await forgetOwnerRun({ ...d, steps: ['forget'], requestPrefix: 't-d-a' });
  assert.equal((runDA.shown as { kind: string }).kind, 'work-forgotten', JSON.stringify(runDA).slice(0, 2000));
  const runCA = await forgetOwnerRun({ ...c, steps: ['cleanup-environment-then-forget'], requestPrefix: 't-c-a' });
  assert.equal((runCA.shown as { kind: string }).kind, 'work-forgotten', JSON.stringify(runCA).slice(0, 3000));
  assert.deepEqual(runCA.environmentPort.map(item => item.split(':')[0]), ['preserve', 'remove'], 'the labelled environment port answered the explicit cleanup only');
  const runDB = await forgetOwnerRun({ ...d, steps: ['new'], requestPrefix: 't-d-b' });
  const runCB = await forgetOwnerRun({ ...c, steps: [], requestPrefix: 't-c-b' });
  const observed = async (input: typeof d, runA: typeof runDA, runB: typeof runDA): Promise<CaseObservation> => {
    const after = await inspectWorkRecords(input.recordsRoot, input.workId);
    const tree = (value: typeof after) => ({ present: value.present, leftover: value.leftover, files: value.files, completeness: value.completeness });
    return { workId: input.workId, successorId: input.successor, before: tree(input.before), after: tree(after), runA, runB };
  };
  const delivered = await observed(d, runDA, runDB), cancelled = await observed(c, runCA, runCB);
  const result = verdict({ delivered, cancelled, sourceBefore: 'same', sourceAfter: 'same' });
  assert.equal(result.overall, 'met', JSON.stringify(result.checks.filter(check => !check.met)));
  // A no-op (nothing forgotten, Records still there) is never a pass.
  const noop = { ...delivered, after: delivered.before, runA: { ...runDA, shown: { kind: 'work' } }, runB: { ...runDB, shown: { kind: 'work' } } };
  assert.equal(verdict({ delivered: noop, cancelled, sourceBefore: 'same', sourceAfter: 'same' }).overall, 'not-met');
  for (const run of [runDA, runDB, runCA, runCB]) assert.ok(!('cleanupBranch' in run.calls) && !('postComment' in run.calls) && !('sandbox.remove' in run.calls));
});
