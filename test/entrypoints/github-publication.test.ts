import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { createBuilderCredentials, createGitHubAccess } from '../../src/platform/github/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { githubWorld, issue, pull, worldScope } from './github-world-fixture.js';

// Ticket 14, adapter level: real issuer, transport and CodeRepository adapter; gh/GitHub (and App HTTPS) substituted by the local world
// fixture. NOT evidence of the real GitHub boundary (that is the one-shot real recipe).
const project = { repository: 'acme/project', installationId: 2, workflows: false };
const branch = 'factory/3-0b9c6a52';
const head = 'd'.repeat(40);
const marker = '<!-- software-factory:work:0b9c6a52-3d3e-4c8f-9a51-000000000001 -->';

/** What the Builder's own `gh api` call does in the guest, with ITS delivered token (never the controller's). */
function builderGh(executable: string, token: string, endpoint: string, body: object): Promise<{ status: number; body: unknown }> {
  return new Promise(resolve => {
    const child = execFile(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', endpoint], { env: { PATH: process.env.PATH ?? '', GH_TOKEN: token }, encoding: 'utf8' }, (_error, stdout) => {
      const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(stdout);
      resolve({ status: Number(match?.[1] ?? 0), body: match ? JSON.parse(match[2]!) : null });
    });
    child.stdin?.end(JSON.stringify(body));
  });
}

test('AC1: the publication grant is Contents W + Pull requests W for the own repository only; the start grant cannot publish', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [] });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const credentials = createBuilderCredentials({ github, repositories: [project] });
  const start = await credentials.issue({ workId: 'w', executionId: 'e', repository: project });
  const publish = await credentials.issue({ workId: 'w', executionId: 'e2', repository: project, purpose: 'builder-publish' });
  assert.equal(start.metadata.purpose, 'builder-start');
  assert.deepEqual([publish.metadata.purpose, publish.metadata.permissions], ['builder-publish', { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'read' }]);
  assert.deepEqual((await world.trace()).filter(entry => entry.method === 'POST').map(entry => entry.permissions),
    [{ metadata: 'read', contents: 'read', issues: 'read' }, { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'read' }], 'never Workflows, never another repository');
  // The read-only start grant is refused by GitHub (the token, not the Factory, enforces it).
  assert.equal((await builderGh(world.executable, start.delivery.token, '/repos/acme/project/git/refs', { ref: `refs/heads/${branch}`, sha: head })).status, 403);
  assert.equal((await builderGh(world.executable, publish.delivery.token, '/repos/acme/project/git/refs', { ref: `refs/heads/${branch}`, sha: head })).status, 201);
  assert.equal((await builderGh(world.executable, publish.delivery.token, '/repos/acme/project/pulls', { title: 'T', head: branch, base: 'main', body: marker, draft: true })).status, 201);
  await assert.rejects(credentials.issue({ workId: 'w', executionId: 'e', repository: project, purpose: 'admin' as never }), /BUILDER_PURPOSE_INVALID/);
});

test('AC2/AC6: discovery reports the own branch tip and each correlated pull request with head commit, base, draft flag and body', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [pull(4, { head: { ref: branch, sha: head, repo: { id: 3 } }, draft: true, body: `${marker}\nCloses #3`,
    user: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' } })], refs: { [branch]: head, [`${branch}-other`]: 'e'.repeat(40) } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const repository = createCodeRepository({ github });
  const observed = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [branch] });
  assert.equal(observed.kind, 'observed');
  if (observed.kind !== 'observed') return;
  assert.deepEqual(observed.branches, { [branch]: { state: 'present', sha: head } }, 'the exact ref only, never a prefix match');
  const issue3 = observed.issues['3']!;
  assert.equal(issue3.completeness, 'complete');
  if (issue3.completeness !== 'complete') return;
  assert.deepEqual(issue3.candidates.map(item => [item.number, item.headSha, item.baseRef, item.draft, item.association, item.author.type]),
    [[4, head, 'main', true, ['closing-reference', 'known-branch'], 'Bot']]);
  assert.ok(issue3.candidates[0]!.body!.startsWith(marker));
  const reads = (await world.trace()).filter(entry => entry.method === 'POST' && entry.endpoint.includes('access_tokens')).map(entry => entry.permissions);
  assert.ok(reads.some(item => JSON.stringify(item) === JSON.stringify({ metadata: 'read', contents: 'read', pull_requests: 'read', administration: 'read' })),
    'refs/rules read with Contents R and Administration R (rulesets), never a write');
  assert.ok(reads.every(item => !Object.values(item ?? {}).includes('write')), 'discovery never holds a write grant');
});

test('AC6: an absent own branch is proven only by a complete read; a failed ref read is unknown, never absence', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [], refs: {} });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const repository = createCodeRepository({ github });
  const absent = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [branch] });
  assert.ok(absent.kind === 'observed' && absent.branches[branch]?.state === 'absent');
  await world.update(value => { value.faults = { 'matching-refs': { status: 502 } }; });
  const unknown = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [branch] });
  assert.ok(unknown.kind === 'observed');
  if (unknown.kind !== 'observed') return;
  assert.equal(unknown.branches[branch]!.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(unknown), /synthetic-installation-secret/);
  const admission = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [] });
  assert.ok(admission.kind === 'observed' && Object.keys(admission.branches).length === 0, 'admission reads no refs');
});

test('review MED 3: the Factory App bot identity is pinned from GET /app (slug) and the bot user read with an installation token', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [] });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  assert.deepEqual(await github.appIdentity(project), { login: 'factory-app[bot]', id: 41898282 });
  const reads = (await world.trace()).filter(entry => entry.endpoint.startsWith('/users/'));
  assert.deepEqual(reads.map(entry => [entry.endpoint, entry.credential]), [['/users/factory-app%5Bbot%5D', 'installation']]);
  const missing = await githubWorld(t, { issues: [issue(3)], pulls: [], appSlug: 'renamed' });
  const other = createGitHubAccess({ root: missing.root, executable: missing.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  await missing.update(value => { value.appSlug = 'renamed'; });
  assert.ok((await other.appIdentity(project)) !== null, 'the slug of THIS App is used');
});

test('review MED 4: discovery lists every branch and tag tip and reports whether the base requires PRs without App bypass', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [], refs: { [branch]: head }, tags: { v1: 'e'.repeat(40) },
    branchRules: { main: [{ type: 'pull_request', ruleset_id: 7 }, { type: 'deletion', ruleset_id: 7 }] }, rulesets: { 7: { enforcement: 'active', current_user_can_bypass: 'never' } } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const repository = createCodeRepository({ github });
  const observed = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [branch], refs: true, base: 'main' });
  assert.ok(observed.kind === 'observed');
  if (observed.kind !== 'observed') return;
  assert.deepEqual(observed.refs, { state: 'complete', refs: { 'refs/heads/main': 'b'.repeat(40), [`refs/heads/${branch}`]: head, 'refs/tags/v1': 'e'.repeat(40) } });
  assert.deepEqual(observed.baseProtection, { state: 'pull-request-required', sources: ['ruleset:7'] });
  // A ruleset the App can bypass, or none at all: not required. Classic required reviews without App bypass count.
  await world.update(value => { value.rulesets = { 7: { enforcement: 'active', current_user_can_bypass: 'always' } }; });
  assert.deepEqual((await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [], base: 'main' }) as { baseProtection?: unknown }).baseProtection,
    { state: 'not-required', reason: 'NO_PULL_REQUEST_RULE_WITHOUT_APP_BYPASS' });
  await world.update(value => { value.branchRules = {}; value.classicProtection = { main: { required_pull_request_reviews: { required_approving_review_count: 1 } } }; });
  assert.deepEqual((await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [], base: 'main' }) as { baseProtection?: unknown }).baseProtection,
    { state: 'pull-request-required', sources: ['classic'] });
  await world.update(value => { value.classicProtection = { main: { required_pull_request_reviews: { bypass_pull_request_allowances: { apps: [{ slug: 'factory-app' }] } } } }; });
  assert.equal(((await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [], base: 'main' }) as { baseProtection?: { state: string } }).baseProtection)!.state, 'not-required');
  await world.update(value => { value.faults = { '/rules/branches/': { status: 502 } }; });
  assert.equal(((await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [], base: 'main' }) as { baseProtection?: { state: string } }).baseProtection)!.state, 'unknown');
  await world.update(value => { value.faults = { 'matching-refs/tags': { status: 502 } }; });
  assert.equal(((await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [], refs: true }) as { refs?: { state: string } }).refs)!.state, 'unknown',
    'a failed listing is never a partial snapshot');
});

test('ticket 21: with `compareFrom` discovery reads the comparison of the Factory-known tip with the own branch tip (commits with linked accounts, files)', async t => {
  const human = '1'.repeat(40);
  const commit = (sha: string, author: { login: string; id: number } | null, name: string, message: string) => ({ sha, author, commit: { author: { name }, message } });
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [], refs: { [branch]: human }, checks: { compare: { [`${head}...${human}`]: { status: 'ahead', ahead_by: 2, behind_by: 0,
    total_commits: 2, commits: [commit('2'.repeat(40), { login: 'operator-one', id: 77 }, 'Operator', 'Fix wording\n\nlonger body'), commit(human, null, 'Unknown Person', 'Second edit')],
    files: [{ filename: 'docs/a.md' }] } } } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const repository = createCodeRepository({ github });
  const observed = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [branch], compareFrom: head });
  assert.ok(observed.kind === 'observed');
  if (observed.kind !== 'observed') return;
  assert.deepEqual(observed.comparison, { state: 'complete', from: head, to: human, status: 'ahead', aheadBy: 2, behindBy: 0, files: ['docs/a.md'], truncated: false,
    commits: [{ sha: '2'.repeat(40), author: { login: 'operator-one', id: 77 }, authorName: 'Operator', subject: 'Fix wording' },
      { sha: human, author: null, authorName: 'Unknown Person', subject: 'Second edit' }] });
  const same = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [branch], compareFrom: human });
  assert.ok(same.kind === 'observed' && same.comparison === undefined, 'nothing to compare when the tip is the expectation');
  const missing = await repository.findPublication({ repo: worldScope, issueNumbers: [3], knownBranches: [branch], compareFrom: 'e'.repeat(40) });
  assert.ok(missing.kind === 'observed' && missing.comparison?.state === 'unknown', 'a failed comparison is unknown, never an empty difference');
});
