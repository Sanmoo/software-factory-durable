import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openStore } from '../../src/control/durable/store.js';
import { admitTicket, initialize, readWork, recordDependencies, works } from '../../src/control/durable/admission.js';
import { admitExecution, beginRenewal, confirmActivation, confirmStart, initializeSlots, recordEnd, recordIssuance, recordPhase, releaseAfterCessation } from '../../src/control/durable/execution.js';
import type { DependencyEvaluation, PublicationView } from '../../src/control/types.js';
import { ticket } from './doubles.js';

// Ticket 14, real Pi Durable/SQLite commits: the publication activation is admitted only for the Work's requested publication, holds the
// publish grant (never the start one, and never the reverse), renews with that purpose, and once started is never requested again.
const head = 'd'.repeat(40);
const evaluation = (attemptId: string): DependencyEvaluation => ({ evaluationId: `ev-${attemptId}`, attemptId, source: 'github-rest', observedAt: 'x', evaluatedAt: 'x',
  principals: [], completeness: 'complete', conclusion: 'satisfied', blockers: [], cycles: [], shared: [], reasons: [], limitations: [] });
const grant = (purpose: 'builder-start' | 'builder-publish') => ({ role: 'builder' as const, purpose, repository: 'acme/project', repositoryId: 3, installationId: 2,
  permissions: { contents: purpose === 'builder-publish' ? 'write' as const : 'read' as const }, issuedAt: 'a', expiresAt: 'b' });

async function ready(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-publication-commits-'));
  const opened = await openStore(join(dir, 'c.sqlite'));
  t.after(async () => { await opened.close(); await rm(dir, { recursive: true, force: true }); });
  const session = opened.session;
  await initialize(session); await initializeSlots(session);
  const admitted = await admitTicket(session, { ticket: ticket(3), repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, observedAt: 'x',
    label: { id: 55, name: 'ready-for-agent' }, publication: { observedAt: 'x', limitations: [] } });
  assert.equal(admitted.kind, 'admitted');
  const work_id = admitted.kind === 'admitted' ? admitted.work_id : '';
  const branch = `factory/3-${work_id.slice(0, 8)}`;
  const request = { ticket: 'https://github.com/acme/project/issues/3', repository: 'acme/project', base: 'main', branch, policies: {} };
  /** One Execution through reserve -> activation -> start, with the given grant. */
  const run = async (attempt: string, extra: Partial<Parameters<typeof admitExecution>[1]> = {}, purpose: 'builder-start' | 'builder-publish' = 'builder-start') => {
    await session.commit(async tx => { const document = await tx.doc(works, work_id, null); document.work!.queue = { ...document.work!.queue, pending: true }; }, BACKGROUND_CONTEXT);
    await recordDependencies(session, work_id, evaluation(attempt));
    const reserved = await admitExecution(session, { work_id, attemptId: attempt, capacity: 1, authorizationObservedAt: 'x', request, ...extra });
    if (reserved.kind !== 'reserved') return reserved;
    const id = reserved.execution.executionId;
    await recordPhase(session, work_id, id, 'reserved', 'prepared', 'execution-prepared', () => {});
    await recordPhase(session, work_id, id, 'prepared', 'booted', 'execution-booted', () => {});
    await recordIssuance(session, work_id, id, { requestedAt: 'x', outcome: 'requested' });
    await recordIssuance(session, work_id, id, { outcome: 'issued', metadata: grant(purpose) });
    const activation = await confirmActivation(session, work_id, id, attempt, grant(purpose), 'p');
    return { reserved, activation, id };
  };
  return { session, work_id, branch, run };
}
/** The publication the discovery would record: a requested publication of the verified commit of `basis`. */
async function request(session: Awaited<ReturnType<typeof ready>>['session'], work_id: string, basis: string, branch: string) {
  await session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const publication: PublicationView = { state: 'requested', basisExecutionId: basis, marker: `<!-- software-factory:work:${work_id} -->`, branch, base: 'main',
      verified: { executionId: basis, head, contentSha256: 'f'.repeat(64), verifiedAt: null, reviewedRound: 1, gates: [], requiredChecks: [] }, expectedRemote: { state: 'absent' },
      requestedAt: 'x', pullRequest: null, description: null, discoveries: [], reasons: [], nextStep: null, updatedAt: 'x' };
    document.work!.publication = publication;
    document.work!.queue = { ...document.work!.queue, pending: true };
  }, BACKGROUND_CONTEXT);
}

test('AC1/AC5: only the requested publication is admitted, with exactly its commit/branch/base/marker/lease, and only with the publish grant', async t => {
  const { session, work_id, branch, run } = await ready(t);
  const first = await run('d1');
  assert.ok('activation' in first && first.activation.kind === 'advanced', 'implementation activation with the start grant');
  const basis = (first as { id: string }).id;
  assert.equal(await confirmStart(session, work_id, basis, { workId: work_id, id: 'r1', executionId: basis, invocationId: `builder-${basis}` }), 'confirmed');
  await recordEnd(session, work_id, basis, 'completed', null);
  await releaseAfterCessation(session, work_id, basis, 'confirmed');
  const publication = { basisExecutionId: basis, head, branch, base: 'main', marker: `<!-- software-factory:work:${work_id} -->`, expectedRemote: { state: 'absent' as const } };
  const resume = { previousExecutionId: basis, questionId: null, answerSha256: null, scopeUpdateIds: [], reason: 'PUBLICATION_REQUESTED' as const };
  // Not requested by a discovery: refused.
  assert.deepEqual(await run('d2', { resume, request: { ticket: '', repository: 'acme/project', base: 'main', branch, policies: {}, publication } }),
    { kind: 'refused', reasons: ['RESUME_BASIS_CHANGED'] });
  await request(session, work_id, basis, branch);
  // A different commit or lease than requested: refused in the admission commit.
  for (const changed of [{ ...publication, head: 'e'.repeat(40) }, { ...publication, expectedRemote: { state: 'present' as const, sha: head } }]) {
    assert.deepEqual(await run('d3', { resume, request: { ticket: '', repository: 'acme/project', base: 'main', branch, policies: {}, publication: changed } }),
      { kind: 'refused', reasons: ['RESUME_BASIS_CHANGED'] });
  }
  // The start grant can never activate a publication.
  const wrong = await run('d4', { resume, request: { ticket: '', repository: 'acme/project', base: 'main', branch, policies: {}, publication } }, 'builder-start');
  assert.ok('activation' in wrong);
  assert.deepEqual((wrong as { activation: unknown }).activation, { kind: 'refused', reasons: ['CREDENTIAL_PURPOSE_MISMATCH'] });
});

test('AC6: a started publication activation is an attempt: never requested again, discovery pending, and it renews only its publish grant', async t => {
  const { session, work_id, branch, run } = await ready(t);
  const first = await run('d1') as { id: string };
  await confirmStart(session, work_id, first.id, { workId: work_id, id: 'r1', executionId: first.id, invocationId: `builder-${first.id}` });
  await recordEnd(session, work_id, first.id, 'completed', null);
  await releaseAfterCessation(session, work_id, first.id, 'confirmed');
  await request(session, work_id, first.id, branch);
  const publication = { basisExecutionId: first.id, head, branch, base: 'main', marker: `<!-- software-factory:work:${work_id} -->`, expectedRemote: { state: 'absent' as const } };
  const resume = { previousExecutionId: first.id, questionId: null, answerSha256: null, scopeUpdateIds: [], reason: 'PUBLICATION_REQUESTED' as const };
  const second = await run('d2', { resume, request: { ticket: '', repository: 'acme/project', base: 'main', branch, policies: {}, publication } }, 'builder-publish') as
    { id: string; activation: { kind: string } };
  assert.equal(second.activation.kind, 'advanced');
  assert.equal(await confirmStart(session, work_id, second.id, { workId: work_id, id: 'r2', executionId: second.id, invocationId: `builder-${second.id}` }), 'confirmed');
  const started = await readWork(session, work_id);
  assert.equal(started!.publication!.state, 'awaiting-discovery');
  assert.ok(started!.history.some(item => item.event === 'publication-started'));
  assert.deepEqual(await beginRenewal(session, work_id, second.id, { repositoryConfigured: true }), { kind: 'begun', sequence: 1 }, 'renewal keeps the publish purpose');
  await recordEnd(session, work_id, second.id, 'failure', 'WORKER_CHANNEL_LOST');
  await releaseAfterCessation(session, work_id, second.id, 'confirmed');
  // Even with the Work queued again by some other path, nothing runs before the discovery decides.
  const again = await run('d3', { resume, request: { ticket: '', repository: 'acme/project', base: 'main', branch, policies: {}, publication } }, 'builder-publish');
  assert.ok('kind' in again && again.kind === 'refused' && again.reasons.includes('PUBLICATION_DISCOVERY_PENDING'));
});
