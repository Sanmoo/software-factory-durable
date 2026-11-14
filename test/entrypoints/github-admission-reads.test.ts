import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker } from '../../src/issue-tracker/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { githubWorld, issue, pull, worldScope, type World } from './github-world-fixture.js';

const code = (observation: object) => 'code' in observation ? observation.code : undefined;
// Real adapters/issuer/transport; only gh/GitHub (and App HTTPS) are substituted by the local world fixture.
async function compose(t: Parameters<typeof githubWorld>[0], world: World, scenario?: string) {
  const fixture = await githubWorld(t, world, scenario);
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  return { ...fixture, tracker: createIssueTracker({ github, scopes: [worldScope] }), repository: createCodeRepository({ github }) };
}

test('listCandidates returns only open labelled issues with stable qualified identities across Link pages, without bodies', async t => {
  const world = await compose(t, { pageSize: 1, issues: [
    issue(1), issue(2, { labels: [{ id: 56, name: 'Ready-For-Agent' }] }), issue(3, { labels: [] }),
    issue(4, { state: 'closed', state_reason: 'completed' }), issue(5, { pull_request: {} }), issue(6),
  ], pulls: [] });
  const observed = await world.tracker.listCandidates(worldScope);
  assert.equal(observed.kind, 'observed');
  if (observed.kind !== 'observed') return;
  assert.equal(observed.completeness, 'complete');
  assert.equal(observed.repositoryId, 3);
  assert.deepEqual(observed.candidates.map(ticket => ticket.number), [1, 2, 6]);
  assert.deepEqual(observed.candidates[0], { tracker: 'github', repository: 'acme/project', repositoryId: 3, issueId: 7001, nodeId: 'I_node1', number: 1,
    url: 'https://github.com/acme/project/issues/1' });
  assert.doesNotMatch(JSON.stringify(observed), /SPEC-BODY|synthetic-installation-secret/);
  const trace = await world.trace();
  assert.ok(trace.some(entry => entry.endpoint.startsWith('/repositories/3/issues?')), 'GitHub id-based next links are followed');
});

test('listCandidates never turns a later-page failure into partial success or proven absence', async t => {
  const world = await compose(t, { pageSize: 1, issues: [issue(1), issue(2)], pulls: [], faults: { 'page=2': { status: 503 } } });
  const observed = await world.tracker.listCandidates(worldScope);
  assert.equal(observed.kind, 'unavailable');
  assert.equal(observed.completeness, 'incomplete');
  assert.equal(observed.code, 'GITHUB_QUERY_FAILED');
  assert.equal('candidates' in observed, false);
  assert.doesNotMatch(JSON.stringify(observed), /synthetic-installation-secret/);
});

test('rate limit headers are honoured: the wait is reported and no further request is sent before it elapses', async t => {
  const world = await compose(t, { issues: [issue(1)], pulls: [], faults: { '/issues?': { status: 403, headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0' } } } });
  const first = await world.tracker.listCandidates(worldScope);
  assert.equal(first.kind, 'unavailable');
  assert.equal(first.code, 'GITHUB_RATE_LIMITED');
  assert.equal(first.waitSeconds, 120);
  const before = (await world.trace()).length;
  const second = await world.tracker.listCandidates(worldScope);
  assert.equal(code(second), 'GITHUB_RATE_LIMITED');
  assert.ok(second.kind === 'unavailable' && second.waitSeconds !== undefined && second.waitSeconds > 0 && second.waitSeconds <= 120);
  assert.equal((await world.trace()).length, before, 'no request while the reported window is open');
});

test('an exhausted remaining quota on a successful response defers the next read until reset', async t => {
  const world = await compose(t, { issues: [issue(1)], pulls: [], exhaustRateLimit: true });
  assert.equal((await world.tracker.listCandidates(worldScope)).kind, 'observed');
  const before = (await world.trace()).length;
  const deferred = await world.tracker.listCandidates(worldScope);
  assert.equal(code(deferred), 'GITHUB_RATE_LIMITED');
  assert.equal((await world.trace()).length, before);
});

test('readTicket returns state, reason, labels and identity only; unconfigured repositories are refused without a request', async t => {
  const world = await compose(t, { issues: [issue(1, { state: 'closed', state_reason: 'not_planned' })], pulls: [] });
  const ref = { tracker: 'github' as const, repository: 'acme/project', repositoryId: 3, issueId: 7001, nodeId: 'I_node1', number: 1, url: 'https://github.com/acme/project/issues/1' };
  const observed = await world.tracker.readTicket(ref);
  assert.equal(observed.kind, 'observed');
  if (observed.kind !== 'observed') return;
  assert.deepEqual(observed.ticket, ref);
  assert.equal(observed.state, 'closed');
  assert.equal(observed.stateReason, 'not_planned');
  assert.deepEqual(observed.labels, [{ id: 55, name: 'ready-for-agent' }]);
  assert.equal(observed.pullRequest, false);
  assert.doesNotMatch(JSON.stringify(observed), /SPEC-BODY/);
  const before = (await world.trace()).length;
  const refused = await world.tracker.readTicket({ ...ref, repository: 'acme/other' });
  assert.equal(refused.kind, 'unavailable');
  assert.equal(refused.code, 'REPOSITORY_NOT_CONFIGURED');
  assert.equal((await world.trace()).length, before);
});

test('operational reads reuse one reduced in-memory grant per purpose and only ever issue GET requests', async t => {
  const world = await compose(t, { issues: [issue(1)], pulls: [pull(1)] });
  const listed = await world.tracker.listCandidates(worldScope);
  assert.equal(listed.kind, 'observed');
  if (listed.kind !== 'observed') return;
  await world.tracker.readTicket(listed.candidates[0]!);
  await world.tracker.listCandidates(worldScope);
  await world.repository.findPublication({ repo: worldScope, issueNumber: 1, knownBranches: [] });
  await world.repository.findPublication({ repo: worldScope, issueNumber: 1, knownBranches: [] });
  const trace = await world.trace();
  const posts = trace.filter(entry => entry.method === 'POST');
  assert.deepEqual(posts.map(entry => entry.permissions), [{ metadata: 'read', issues: 'read' }, { metadata: 'read', pull_requests: 'read' }]);
  assert.ok(trace.filter(entry => entry.credential === 'installation').every(entry => entry.method === 'GET'));
  assert.ok(!trace.some(entry => /labels\/|assignees|projects|\/comments/.test(entry.endpoint.split('?')[0]!)), 'no triage/project/status endpoints');
});

test('an unknown token issuance is never repeated automatically by later polling reads', async t => {
  const world = await compose(t, { issues: [issue(1)], pulls: [] }, 'uncertain-post');
  const first = await world.tracker.listCandidates(worldScope);
  assert.equal(code(first), 'GITHUB_TOKEN_ISSUANCE_UNKNOWN');
  const second = await world.tracker.listCandidates(worldScope);
  assert.equal(code(second), 'GITHUB_TOKEN_ISSUANCE_UNKNOWN');
  assert.match(second.kind === 'unavailable' ? second.nextStep : '', /Do not repeat POST automatically/);
  assert.equal(world.native.tokenPosts, 1);
});

test('findPublication reports closing-reference and known-branch pull requests with GitHub identities, ignoring mere mentions', async t => {
  const world = await compose(t, { issues: [issue(1)], pulls: [
    pull(10, { body: 'Fixes #1' }), pull(11, { body: 'see #1 for context' }), pull(12, { title: 'resolves: acme/project#1', state: 'closed', merged_at: '2026-01-01T00:00:00Z' }),
    pull(13, { body: 'Closes https://github.com/acme/project/issues/1' }), pull(14, { body: 'fixes acme/other#1' }), pull(15, { body: 'fixes #12' }),
    pull(16, { head: { ref: 'factory/work-x', repo: { id: 3 } } }),
  ] });
  const observed = await world.repository.findPublication({ repo: worldScope, issueNumber: 1, knownBranches: ['factory/work-x'] });
  assert.equal(observed.kind, 'observed');
  if (observed.kind !== 'observed') return;
  assert.equal(observed.completeness, 'complete');
  assert.deepEqual(observed.candidates.map(candidate => [candidate.number, candidate.association]),
    [[10, ['closing-reference']], [12, ['closing-reference']], [13, ['closing-reference']], [16, ['known-branch']]]);
  assert.deepEqual(observed.candidates[1], { pullRequestId: 9012, nodeId: 'PR_node12', number: 12, url: 'https://github.com/acme/project/pull/12', state: 'closed', merged: true,
    headRef: 'human/change-12', headRepositoryId: 3, author: { id: 10, login: 'someone', type: 'User' }, association: ['closing-reference'] });
  assert.ok(observed.limitations.some(limitation => /manual/i.test(limitation)));
});

test('findPublication failure is unavailable, never an empty candidate list', async t => {
  const world = await compose(t, { issues: [issue(1)], pulls: [pull(10)], faults: { '/pulls?': { status: 502 } } });
  const observed = await world.repository.findPublication({ repo: worldScope, issueNumber: 1, knownBranches: [] });
  assert.equal(observed.kind, 'unavailable');
  assert.equal(observed.completeness, 'incomplete');
  assert.equal('candidates' in observed, false);
});
