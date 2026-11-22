import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { createWorkers } from '../../src/workers/index.js';
import { observeOpinionRecord } from '../../src/workers/opinion-observation.js';

// Integration (I) with the REAL protected Records (temporary private root): ticket 28 opinion facet of Workers.observe. Not evidence of a
// real reviewer worker, model or lost notification — the opinion record is written here with the reviewer's own record shape.
const context = (invocationId: string) => ({ workId: 'w1', executionId: 'e1', invocationId, role: 'spec' as const, environmentRef: 'env1', bootRef: 'boot1', callId: 'review-opinion' });
const composed = (invocationId: string, extra: Record<string, unknown> = {}) => ({ kind: 'review-opinion', version: 1, role: 'spec', round: 2, attempt: 1, invocationId,
  session: { file: null, mode: 'new', from: null, code: null }, model: { providerId: 'openai', modelId: 'gpt-6-luna' }, profile: { id: 'p', modelBudget: 'reviewer-v1' },
  input: { handoffIndexSha256: 'a'.repeat(64), required: [], missing: [] }, finalMessageSha256: null, conclusion: 'findings', code: null,
  coverage: { scope: 'broad', justification: 'all files', examined: ['/workspace/checkout/docs/a.md'] },
  findings: [{ id: 'S1', basis: 'requirement', reference: '/artifacts/spec/v1/ticket.json#body', location: { path: '/workspace/checkout/docs/a.md' }, summary: 'Rollback missing' }],
  limitations: [], hostChecks: { reads: 3, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, recordedAt: new Date().toISOString(), ...extra });

test('AC1/AC2: the complete opinion record is located without its notification; absence needs a complete listing; partial/corrupt/multiple records are never opinions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-opinion28-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'p', systemPrompt: 's', auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses' } as never });
  const observe = (invocationId: string) => workers.observeOpinion({ workId: 'w1', executionId: 'e1', invocationId });

  assert.deepEqual(await observe('spec-e1-r2a1'), { kind: 'absent' }, 'no evidence of the Work under an intact root: absent');
  const reference = await records.record(context('spec-e1-r2a1'), composed('spec-e1-r2a1'));
  const found = await observe('spec-e1-r2a1');
  assert.equal(found.kind, 'opinion');
  if (found.kind === 'opinion') {
    assert.deepEqual([found.opinion.reference, found.opinion.conclusion, found.opinion.findings[0]!.id, found.opinion.attempt], [reference, 'findings', 'S1', 1]);
  }
  assert.deepEqual(await observe('spec-e1-r2a2'), { kind: 'absent' }, 'another attempt has no record');

  // A streamed/half-written capture (no completion marker) is never an opinion and never proves absence.
  const partial = await records.openOutput(context('spec-e1-r3a1'));
  await partial.write(Buffer.from('{"version":1'));
  assert.deepEqual(await observe('spec-e1-r3a1'), { kind: 'uncertain', code: 'OPINION_RECORD_INCOMPLETE' });

  // A complete record that is not a valid opinion of that invocation is uncertain (never zero findings).
  await records.record(context('spec-e1-r4a1'), composed('spec-e1-r4a1', { conclusion: 'maybe' }));
  assert.deepEqual(await observe('spec-e1-r4a1'), { kind: 'uncertain', code: 'OPINION_RECORD_INVALID' });
  await records.record(context('spec-e1-r5a1'), composed('spec-e1-r9a9'));
  assert.deepEqual(await observe('spec-e1-r5a1'), { kind: 'uncertain', code: 'OPINION_RECORD_INVALID' }, 'an opinion of another invocation');
  await records.record(context('spec-e1-r6a1'), composed('spec-e1-r6a1'));
  await records.record(context('spec-e1-r6a1'), composed('spec-e1-r6a1'));
  assert.deepEqual(await observe('spec-e1-r6a1'), { kind: 'uncertain', code: 'OPINION_RECORD_MULTIPLE' });

  assert.deepEqual(await createWorkers().observeOpinion({ workId: 'w1', executionId: 'e1', invocationId: 'x' }), { kind: 'uncertain', code: 'WORKER_EXECUTION_NOT_ENABLED' });
});

test('review LOW: an opinion record is read across EVERY page (never a single 64 KiB page), bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-opinion28p-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  await records.record(context('spec-e1-r2a1'), composed('spec-e1-r2a1'));
  // The same real record served in 512-byte pages.
  const paged = { find: records.find, async read(input: { reference: Awaited<ReturnType<typeof records.record>>; offset: number; limit: number }) {
    const page = await records.read({ ...input, limit: 512 });
    return page;
  } } as unknown as Parameters<typeof observeOpinionRecord>[0];
  const found = await observeOpinionRecord(paged, { workId: 'w1', executionId: 'e1', invocationId: 'spec-e1-r2a1' });
  assert.equal(found.kind, 'opinion');
  const stuck = { find: records.find, async read() { return { state: 'complete', data: Buffer.from('{'), nextOffset: 0, bytes: 10 }; } } as unknown as Parameters<typeof observeOpinionRecord>[0];
  assert.deepEqual(await observeOpinionRecord(stuck, { workId: 'w1', executionId: 'e1', invocationId: 'spec-e1-r2a1' }), { kind: 'uncertain', code: 'OPINION_RECORD_INVALID' });
});
