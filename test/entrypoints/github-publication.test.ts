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
  assert.ok(reads.some(item => JSON.stringify(item) === JSON.stringify({ metadata: 'read', contents: 'read', pull_requests: 'read' })), 'refs read with Contents R only');
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
