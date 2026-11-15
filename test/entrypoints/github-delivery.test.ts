import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { deliveryScope, deliveryWorld, mergeSha, ownPull, ownSha } from './github-delivery-fixture.js';

// Ticket 17 adapter evidence (synthetic GitHub executable; real issuer, gh transport parsing, adapters). Not proof of the real GitHub boundary.
const selection = { repo: deliveryScope, repositoryId: 3, branch: 'factory/3-abcdef12', base: 'main', expectedTip: ownSha, pullRequest: { number: 42, pullRequestId: 9042 } };
const ref = { repo: deliveryScope, repositoryId: 3, number: 42, pullRequestId: 9042, nodeId: 'PR_own42' };
const adapter = (root: string, executable: string) => createCodeRepository({ github: createGitHubAccess({ root, appId: 1, privateKeyFile: 'credentials/app.pem', executable }) });

test('readOwnMerge reports merge facts of the known own pull request under a read-only delivery grant', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: { 'factory/3-abcdef12': ownSha } });
  const observation = await adapter(world.root, world.executable).readOwnMerge!(ref);
  assert.equal(observation.kind, 'observed');
  assert.deepEqual(observation.kind === 'observed' && observation.pullRequest, { pullRequestId: 9042, nodeId: 'PR_own42', number: 42, url: 'https://github.com/acme/project/pull/42',
    state: 'closed', draft: false, merged: true, mergedAt: '2026-11-14T12:00:00Z', mergeCommitSha: mergeSha, headRef: 'factory/3-abcdef12', headSha: ownSha,
    headRepositoryId: 3, baseRef: 'main', baseRepositoryId: 3, reported: { mergeCommitSha: 'value', merged: 'value' } });
  const grants = (await world.trace()).filter(entry => entry.permissions);
  assert.deepEqual(grants.map(entry => entry.permissions), [{ metadata: 'read', contents: 'read', pull_requests: 'read' }], 'no write permission for tracking');
});

test('readOwnMerge failure is unavailable, never a merge or a closure', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: {}, faults: { '/pulls/42': 502 } });
  const observation = await adapter(world.root, world.executable).readOwnMerge!(ref);
  assert.equal(observation.kind, 'unavailable');
  assert.doesNotMatch(JSON.stringify(observation), /synthetic-installation-secret/);
});

const restDeletes = (trace: { method: string; endpoint: string }[]) => trace.filter(entry => entry.method === 'DELETE' && entry.endpoint.includes('/git/refs/'));
const atomic = (trace: { method: string; endpoint: string; body?: string }[]) => trace.filter(entry => entry.method === 'POST' && entry.endpoint === '/graphql');

test('cleanupBranch deletes only the own merged branch ATOMICALLY (updateRefs beforeOid = own tip) under its OWN single-use Contents W grant', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: { 'factory/3-abcdef12': ownSha, main: 'c'.repeat(40), 'human/other': 'd'.repeat(40) } });
  const result = await adapter(world.root, world.executable).cleanupBranch!(selection, { effectId: 'effect-1' });
  assert.equal(result.outcome, 'removed');
  assert.equal(result.tip, ownSha);
  assert.equal(result.revocation, 'revoked');
  assert.deepEqual((await world.world()).refs, { main: 'c'.repeat(40), 'human/other': 'd'.repeat(40) }, 'base and foreign branches untouched');
  const trace = await world.trace();
  assert.deepEqual(trace.filter(entry => entry.permissions).map(entry => entry.permissions), [{ metadata: 'read', contents: 'write', pull_requests: 'read' }]);
  assert.deepEqual(restDeletes(trace), [], 'never a non-conditional REST DELETE');
  assert.deepEqual(atomic(trace).map(entry => JSON.parse(entry.body!)), [{ repositoryId: 'R_3',
    refUpdates: [{ name: 'refs/heads/factory/3-abcdef12', beforeOid: ownSha, afterOid: '0'.repeat(40), force: false }] }], 'exactly one atomic conditional delete');
  const order = trace.map(entry => entry.endpoint);
  assert.equal(order[order.indexOf('/graphql') - 1], '/repos/acme/project/git/matching-refs/heads/factory/3-abcdef12?per_page=100&page=1', 'tip re-read immediately before it');
  assert.ok(order.indexOf('/repos/acme/project/pulls?state=open&base=factory%2F3-abcdef12&per_page=100&page=1') < order.indexOf('/graphql'), 'stacked PRs checked before it');
  assert.equal((await world.revoked()).length, 1);
});

test('cleanupBranch proves absence only from a complete read and sends nothing', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: { main: 'c'.repeat(40) } });
  const result = await adapter(world.root, world.executable).cleanupBranch!(selection, { effectId: 'effect-2' });
  assert.equal(result.outcome, 'absent');
  assert.deepEqual(atomic(await world.trace()), []);
  const failing = await deliveryWorld(t, { pulls: [ownPull()], refs: {}, faults: { 'matching-refs': 502 } });
  const unknown = await adapter(failing.root, failing.executable).cleanupBranch!(selection, { effectId: 'effect-3' });
  assert.equal(unknown.outcome, 'failed', 'a failed read is never absence');
  assert.deepEqual(atomic(await failing.trace()), []);
});

for (const [name, world, code] of [
  ['tip moved (human push after merge)', { pulls: [ownPull()], refs: { 'factory/3-abcdef12': 'e'.repeat(40) } }, 'BRANCH_TIP_CHANGED'],
  ['open pull request still uses the branch', { pulls: [ownPull(), ownPull({ id: 9043, node_id: 'PR_43', number: 43, state: 'open', merged: false, merged_at: null, merge_commit_sha: null })],
    refs: { 'factory/3-abcdef12': ownSha } }, 'BRANCH_IN_USE_BY_OPEN_PULL_REQUEST'],
  ['own pull request not merged', { pulls: [ownPull({ merged: false, merged_at: null })], refs: { 'factory/3-abcdef12': ownSha } }, 'OWN_PULL_REQUEST_NOT_CONFIRMED'],
  ['an open pull request is STACKED on the branch (base = own branch)', { pulls: [ownPull(), ownPull({ id: 9044, node_id: 'PR_44', number: 44, state: 'open', merged: false, merged_at: null,
    merge_commit_sha: null, head: { ref: 'human/stacked', sha: 'f'.repeat(40), repo: { id: 3 } }, base: { ref: 'factory/3-abcdef12', repo: { id: 3 } } })],
    refs: { 'factory/3-abcdef12': ownSha } }, 'BRANCH_BASE_OF_OPEN_PULL_REQUEST'],
  ['branch is the default branch', { pulls: [ownPull()], refs: { 'factory/3-abcdef12': ownSha }, defaultBranch: 'factory/3-abcdef12' }, 'DEFAULT_BRANCH_PROTECTED'],
] as const) {
  test(`cleanupBranch refuses when ${name}: nothing deleted`, async t => {
    const fixture = await deliveryWorld(t, structuredClone(world) as unknown as Parameters<typeof deliveryWorld>[1]);
    const result = await adapter(fixture.root, fixture.executable).cleanupBranch!(selection, { effectId: 'effect-r' });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, code);
    assert.deepEqual((await fixture.world()).refs, world.refs);
    assert.equal((await fixture.revoked()).length, 1, 'the cleanup grant is revoked even when nothing is deleted');
  });
}

test('cleanupBranch never selects the base and rejects invalid selections locally', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: { main: 'c'.repeat(40) } });
  const repository = adapter(world.root, world.executable);
  assert.equal((await repository.cleanupBranch!({ ...selection, branch: 'main' }, { effectId: 'x' })).code, 'BASE_BRANCH_PROTECTED');
  assert.equal((await repository.cleanupBranch!({ ...selection, branch: '../main' }, { effectId: 'x' })).code, 'CLEANUP_SELECTION_INVALID');
  assert.deepEqual(await world.trace(), [], 'nothing was issued or sent');
});

test('a push racing the delete is protected by the atomic precondition: nothing deleted, refused with the new tip', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: { 'factory/3-abcdef12': ownSha }, raceTip: 'e'.repeat(40) });
  const result = await adapter(world.root, world.executable).cleanupBranch!(selection, { effectId: 'race' });
  assert.deepEqual([result.outcome, result.code, result.tip], ['refused', 'BRANCH_TIP_CHANGED', 'e'.repeat(40)]);
  assert.deepEqual((await world.world()).refs, { 'factory/3-abcdef12': 'e'.repeat(40) });
});

test('without an atomic conditional delete for this token the branch is KEPT (never deleted without a precondition)', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: { 'factory/3-abcdef12': ownSha }, graphqlUnavailable: true });
  const result = await adapter(world.root, world.executable).cleanupBranch!(selection, { effectId: 'kept' });
  assert.deepEqual([result.outcome, result.code], ['kept', 'ATOMIC_DELETE_UNAVAILABLE']);
  assert.match(result.nextStep, /kept: atomic delete unavailable/);
  assert.deepEqual((await world.world()).refs, { 'factory/3-abcdef12': ownSha });
  assert.deepEqual(restDeletes(await world.trace()), []);
});

test('cleanupBranch with a lost DELETE answer is indeterminate, then a later attempt revalidates and proves absence', async t => {
  const world = await deliveryWorld(t, { pulls: [ownPull()], refs: { 'factory/3-abcdef12': ownSha }, deleteTransportLost: true });
  const repository = adapter(world.root, world.executable);
  const first = await repository.cleanupBranch!(selection, { effectId: 'effect-4' });
  assert.equal(first.outcome, 'indeterminate');
  await world.update(state => { delete state.deleteTransportLost; });
  const second = await repository.cleanupBranch!(selection, { effectId: 'effect-5' });
  assert.equal(second.outcome, 'absent');
});
