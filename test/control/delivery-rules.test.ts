import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchOutcome, cleanupEligibility, cleanupState, decideMerge, environmentOutcomes, mergePlan, ownPullRequestOf, planCleanup, recoverLostIntents,
  selectPending } from '../../src/control/rules/delivery.js';
import type { CleanupResourceView, ExecutionView, PullRequestFacts } from '../../src/control/types.js';

// Pure ticket 17 rules (spec §12.3): merge confirmation by own PR/cycle identity, cleanup eligibility, the owned plan and per-resource results.
const own = { pullRequestId: 9042, nodeId: 'PR_own42', number: 42, url: 'https://github.com/acme/project/pull/42', headRef: 'factory/3-abcdef12', base: 'main' };
const expect = { repositoryId: 3, branch: 'factory/3-abcdef12', base: 'main' };
const facts = (overrides: Partial<PullRequestFacts> = {}): PullRequestFacts => ({ pullRequestId: 9042, nodeId: 'PR_own42', number: 42, url: own.url, state: 'closed',
  draft: false, merged: true, mergedAt: '2026-11-14T12:00:00Z', mergeCommitSha: 'b'.repeat(40), headRef: own.headRef, headSha: 'a'.repeat(40), headRepositoryId: 3,
  baseRef: 'main', baseRepositoryId: 3, ...overrides });
const env = (n: number) => `env-${String(n).repeat(64)}`;
const execution = (id: string, overrides: Partial<ExecutionView> = {}): ExecutionView => ({
  executionId: id, invocationId: `i-${id}`, mode: 'initial', state: 'ended', slot: { held: false, capacity: 1, reservedAt: 'x', releasedAt: 'y' },
  admission: { attemptId: 'a', evaluationId: 'e', authorizationObservedAt: 'x', activationAttemptId: null, activationEvaluationId: null },
  dispatch: { intent: 'prepare-start-activate', phase: 'stopped', environment: env(1), boot: 'boot-1', updatedAt: 'x' },
  request: { ticket: 't', repository: 'acme/project', base: 'main', branch: own.headRef, baseCommit: null, checkout: null, promptSha256: null, skillPack: null,
    policies: {} as ExecutionView['request']['policies'] },
  credential: null, credentialIssuance: null, credentialRenewals: [], credentialLifecycle: { state: 'withdrawn', withdrawnAt: 'x', reason: 'ended', renewal: 'stopped', renewalStop: null, workerNotice: null },
  start: { receiptId: 'r', confirmedAt: 'x' }, end: { at: 'x', outcome: 'completed', code: null, cessation: 'confirmed' }, held: null,
  completion: { automatic: false, reason: 'x' }, ...overrides });
const delivered = { result: 'delivered' as const, branch: own.headRef, repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
  delivery: { state: 'delivered' as const, merge: { headSha: 'a'.repeat(40) } }, previousExecutions: [execution('e1')], execution: execution('e2', { dispatch: { ...execution('e2').dispatch, environment: env(1) } }) };

test('own pull request identity comes only from the publication link (no link, no delivery)', () => {
  assert.equal(ownPullRequestOf({}), null);
  assert.equal(ownPullRequestOf({ publication: { pullRequest: null } }), null);
  assert.equal(ownPullRequestOf({ publication: { pullRequest: { number: 42 } } }), null, 'incomplete identity is not an identity');
  assert.deepEqual(ownPullRequestOf({ publication: { branch: own.headRef, base: 'main', pullRequest: { ...own, state: 'open', merged: false } } }), own);
});

test('delivery requires a confirmed merge of the SAME own pull request; closure, open or another identity never deliver', () => {
  const merged = decideMerge(own, expect, facts());
  assert.equal(merged.outcome, 'merged');
  assert.deepEqual(merged.outcome === 'merged' && merged.merge, { mergedAt: '2026-11-14T12:00:00Z', mergeCommitSha: 'b'.repeat(40), headSha: 'a'.repeat(40),
    pullRequestId: 9042, number: 42, url: own.url });
  assert.deepEqual(decideMerge(own, expect, facts({ merged: false, mergedAt: null, mergeCommitSha: null })), { outcome: 'closed-unmerged', reasons: ['CLOSED_WITHOUT_MERGE'] });
  assert.deepEqual(decideMerge(own, expect, facts({ state: 'open', merged: false, mergedAt: null, mergeCommitSha: null })), { outcome: 'open', reasons: [] });
  assert.deepEqual(decideMerge(own, expect, facts({ pullRequestId: 1, nodeId: 'PR_x', headRef: 'human/x', baseRef: 'dev', headRepositoryId: 99 })), { outcome: 'identity-mismatch',
    reasons: ['PULL_REQUEST_ID_MISMATCH', 'PULL_REQUEST_NODE_MISMATCH', 'HEAD_BRANCH_MISMATCH', 'HEAD_REPOSITORY_MISMATCH', 'BASE_MISMATCH'] });
  assert.deepEqual(decideMerge(own, expect, facts({ mergedAt: null })), { outcome: 'merge-unconfirmed', reasons: ['MERGE_EVIDENCE_INCOMPLETE'] });
});

test('cleanup is eligible only after merge and confirmed cessation of every Execution of the Work', () => {
  assert.deepEqual(cleanupEligibility(delivered, false), { eligible: true, reasons: [] });
  assert.deepEqual(cleanupEligibility({ ...delivered, result: 'open' }, false).reasons, ['NOT_DELIVERED']);
  assert.deepEqual(cleanupEligibility(delivered, true).reasons, ['ACTIVITY_RUNNING']);
  const unconfirmed = { ...delivered, execution: execution('e2', { end: { at: 'x', outcome: 'failure', code: 'WORK_DELIVERED', cessation: 'unconfirmed' } }) };
  assert.deepEqual(cleanupEligibility(unconfirmed, false).reasons, ['CESSATION_UNCONFIRMED:e2']);
  const held = { ...delivered, execution: execution('e2', { state: 'held', slot: { held: true, capacity: 1, reservedAt: 'x', releasedAt: null }, end: null }) };
  assert.deepEqual(cleanupEligibility(held, false).reasons, ['SLOT_HELD:e2', 'CESSATION_UNCONFIRMED:e2']);
  const neverBooted = { ...delivered, execution: execution('e2', { state: 'released', end: null, dispatch: { ...execution('e2').dispatch, environment: null, boot: null } }) };
  assert.deepEqual(cleanupEligibility(neverBooted, false), { eligible: true, reasons: [] }, 'a proven non-start has nothing to cease');
});

test('the plan names only the Work\'s own resources and lists base, shared cache, other Works and Docker as protected', () => {
  const plan = planCleanup(delivered, { repositoryConfigured: true });
  assert.deepEqual(plan.resources.map(item => [item.id, item.kind, item.target]), [
    [`environment:${env(1)}`, 'environment', `${env(1)}/root.qcow2`],
    [`checkout:${env(1)}`, 'checkout', `${env(1)}/workspace/checkout`],
    [`local-branch:${env(1)}`, 'local-branch', `${env(1)}/workspace/checkout:refs/heads/${own.headRef}`],
    [`temporaries:${env(1)}`, 'temporaries', `${env(1)}/artifacts + boot runtime directories`],
    [`remote-branch:${own.headRef}`, 'remote-branch', `acme/project:refs/heads/${own.headRef}`],
  ]);
  assert.deepEqual(plan.protected.map(item => item.reason), ['BASE_BRANCH', 'SHARED_FACTORY_CACHE', 'NOT_OWNED', 'NO_GLOBAL_DOCKER_CLEANUP', 'RETAINED_HISTORY']);
  assert.equal(planCleanup({ ...delivered, branch: 'main' }, { repositoryConfigured: true }).resources.some(item => item.kind === 'remote-branch'), false, 'base is never a cleanup target');
  assert.equal(planCleanup({ ...delivered, execution: execution('e2', { dispatch: { ...execution('e2').dispatch, environment: 'env-../../x' } }) }, { repositoryConfigured: true })
    .resources.filter(item => item.kind === 'environment').length, 1, 'an invalid environment reference is never planned');
});

test('Sandbox and branch results map to per-resource outcomes; a failed query is never absence', () => {
  assert.deepEqual(environmentOutcomes({ status: 'success', resources: [{ resource: 'disk', status: 'removed' }, { resource: 'workspace', status: 'removed' },
    { resource: 'artifacts', status: 'removed' }, { resource: 'runtime', status: 'absent' }] }), {
    environment: { outcome: 'removed', code: null }, checkout: { outcome: 'removed', code: null }, 'local-branch': { outcome: 'removed', code: null },
    temporaries: { outcome: 'removed', code: null } });
  assert.deepEqual(environmentOutcomes({ status: 'partial', code: 'ENVIRONMENT_REMOVAL_PARTIAL', resources: [{ resource: 'disk', status: 'removed' },
    { resource: 'workspace', status: 'refused' }, { resource: 'artifacts', status: 'removed' }, { resource: 'runtime', status: 'failed' }] }), {
    environment: { outcome: 'removed', code: null }, checkout: { outcome: 'refused', code: 'ENVIRONMENT_REMOVAL_PARTIAL' }, 'local-branch': { outcome: 'refused', code: 'ENVIRONMENT_REMOVAL_PARTIAL' },
    temporaries: { outcome: 'failed', code: 'ENVIRONMENT_REMOVAL_PARTIAL' } });
  assert.deepEqual(environmentOutcomes({ status: 'indeterminate', code: 'ENVIRONMENT_LIFECYCLE_BUSY', resources: [] }).environment, { outcome: 'indeterminate', code: 'ENVIRONMENT_LIFECYCLE_BUSY' });
  assert.deepEqual(environmentOutcomes({ status: 'failure', code: 'CLEANUP_WORK_MISMATCH', resources: [] }).checkout, { outcome: 'refused', code: 'CLEANUP_WORK_MISMATCH' });
  assert.deepEqual(branchOutcome({ outcome: 'failed', code: 'GITHUB_READ_FAILED', observedAt: 'x', tip: null, revocation: 'revoked', nextStep: '', effectId: 'e' }),
    { outcome: 'failed', code: 'GITHUB_READ_FAILED' });
});

test('retries select only pending resources; a lost result is indeterminate, never success; state separates waiting/pending/complete', () => {
  const resource = (id: string, state: CleanupResourceView['state'], attempts: CleanupResourceView['attempts'] = []): CleanupResourceView =>
    ({ id, kind: 'environment', target: id, environment: null, ownership: 'own', state, attempts });
  const resources = [resource('a', 'removed'), resource('b', 'absent'), resource('c', 'failed'), resource('d', 'indeterminate'), resource('e', 'pending'),
    resource('f', 'pending', [{ effectId: 'x', intentAt: 't', resultAt: null, outcome: 'intended', code: null }])];
  const recovered = recoverLostIntents(resources, 'now');
  assert.deepEqual(recovered.find(item => item.id === 'f')?.attempts.at(-1), { effectId: 'x', intentAt: 't', resultAt: 'now', outcome: 'indeterminate', code: 'RESULT_NOT_RECORDED' });
  assert.equal(recovered.find(item => item.id === 'f')?.state, 'indeterminate');
  assert.deepEqual(selectPending(recovered).map(item => item.id), ['c', 'd', 'e', 'f']);
  assert.equal(cleanupState({ eligible: false, resources: recovered }), 'waiting');
  assert.equal(cleanupState({ eligible: true, resources: recovered }), 'pending');
  assert.equal(cleanupState({ eligible: true, resources: [resource('a', 'removed'), resource('b', 'absent')] }), 'complete');
  const merged = mergePlan([resource('a', 'removed')], [{ id: 'a', kind: 'environment', target: 'a', environment: null, ownership: 'own' },
    { id: 'z', kind: 'remote-branch', target: 'z', environment: null, ownership: 'own' }]);
  assert.deepEqual(merged.map(item => [item.id, item.state]), [['a', 'removed'], ['z', 'pending']], 'a re-plan keeps concluded results and adds only new owned resources');
});
