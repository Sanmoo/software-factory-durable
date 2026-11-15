import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { createWorkers } from '../../src/workers/index.js';

// Integration (I) with the REAL protected Records (temporary private root): ticket 27 question facet of Workers.observe. The ask_user record is
// written here with worker-session's own record shape (callId `ask-user-<id>`); not evidence of a real Builder, model or lost ACK.
const qid = (n: number) => `0b9c6a52-3d3e-4c8f-9a51-${String(n).padStart(12, '0')}`;
const context = (invocationId: string, questionId: string) => ({ workId: 'w1', executionId: 'e1', invocationId, role: 'builder' as const, environmentRef: 'env1', bootRef: 'boot1',
  callId: `ask-user-${questionId}` });
const asked = (questionId: string, extra: Record<string, unknown> = {}) => {
  const question = 'Which port?', details = 'Checked docs.';
  return { version: 1, kind: 'ask-user', questionId, question, context: details, sha256: createHash('sha256').update(JSON.stringify({ question, context: details })).digest('hex'),
    phaseId: 'builder-initial', toolCallId: 'call-1', askedAt: '2026-11-15T10:00:00.000Z', ...extra };
};

test('ticket 27 AC5: the preserved ask_user request is recovered with its identity, content and reference; absence needs a complete listing; partial/multiple/mismatched are uncertain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-question27-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'p', systemPrompt: 's', auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses' } as never });
  const observe = (invocationId: string) => workers.observeQuestion({ workId: 'w1', executionId: 'e1', invocationId });

  assert.deepEqual(await observe('builder-a'), { kind: 'absent' }, 'no evidence of the Work under an intact root: absent');
  // Other records of the invocation (start receipt, tool output) are not questions.
  await records.record({ ...context('builder-a', qid(1)), callId: 'worker-start' }, { version: 1, kind: 'worker-start' });
  assert.deepEqual(await observe('builder-a'), { kind: 'absent' });
  const reference = await records.record(context('builder-a', qid(1)), asked(qid(1)));
  const found = await observe('builder-a');
  assert.deepEqual(found, { kind: 'question', askedAt: '2026-11-15T10:00:00.000Z', request: { questionId: qid(1), question: 'Which port?', context: 'Checked docs.',
    sha256: asked(qid(1)).sha256, reference: { workId: reference.workId, id: reference.id } } });

  // Preservation interrupted (no completion marker): content lost, never a question and never absence.
  const partial = await records.openOutput(context('builder-b', qid(2)));
  await partial.write(Buffer.from('{"version":1,"context"'));
  assert.deepEqual(await observe('builder-b'), { kind: 'uncertain', code: 'QUESTION_RECORD_INCOMPLETE' });
  // A record whose callId does not name its own question id, or another kind, is a mismatch.
  await records.record(context('builder-c', qid(3)), asked(qid(4)));
  assert.deepEqual(await observe('builder-c'), { kind: 'uncertain', code: 'QUESTION_RECORD_MISMATCH' });
  await records.record(context('builder-d', qid(5)), asked(qid(5), { sha256: 'not-a-hash' }));
  assert.deepEqual(await observe('builder-d'), { kind: 'uncertain', code: 'QUESTION_RECORD_INVALID' });
  // ask_user is once per activation: two requests are never chosen between.
  await records.record(context('builder-e', qid(6)), asked(qid(6)));
  await records.record(context('builder-e', qid(7)), asked(qid(7)));
  assert.deepEqual(await observe('builder-e'), { kind: 'uncertain', code: 'QUESTION_RECORD_MULTIPLE' });

  assert.deepEqual(await createWorkers().observeQuestion({ workId: 'w1', executionId: 'e1', invocationId: 'x' }), { kind: 'uncertain', code: 'WORKER_EXECUTION_NOT_ENABLED' });
});
