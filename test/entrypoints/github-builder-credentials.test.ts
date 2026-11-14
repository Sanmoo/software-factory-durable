import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuilderCredentials, createGitHubAccess, createRepositoryFetchCredentials } from '../../src/platform/github/index.js';
import { githubWorld } from './github-world-fixture.js';

// Real issuer + App HTTPS contract; gh/GitHub and App HTTPS substituted by the local world fixture. NOT real GitHub evidence.
const repositories = [{ name: 'acme/project', id: 3, installation: 2 }, { name: 'acme/other', id: 4, installation: 2 }];
const project = { repository: 'acme/project', installationId: 2, workflows: false };

test('AC5: the Builder grant is reduced to its own repository and fixed read purpose; only metadata is serializable', async t => {
  const world = await githubWorld(t, { repositories, issues: [], pulls: [] });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const credentials = createBuilderCredentials({ github, repositories: [project] });
  const grant = await credentials.issue({ workId: 'w', executionId: 'e', repository: project });
  assert.match(grant.delivery.token, /^synthetic-installation-secret-\d+-r3$/);
  assert.deepEqual({ ...grant.metadata, issuedAt: 'x', expiresAt: 'y' }, { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3,
    installationId: 2, permissions: { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: 'x', expiresAt: 'y' });
  assert.doesNotMatch(JSON.stringify(grant.metadata), /synthetic-installation-secret/);
  assert.ok(Object.isFrozen(grant.delivery));
  const posts = (await world.trace()).filter(entry => entry.method === 'POST');
  assert.deepEqual(posts.map(entry => [entry.permissions, (entry as { repository?: string }).repository]), [[{ metadata: 'read', contents: 'read', issues: 'read' }, 'acme/project']],
    'one POST, one repository, no write/Workflows');
  await assert.rejects(credentials.issue({ workId: 'w', executionId: 'e', repository: { repository: 'acme/other', installationId: 2, workflows: false } }), /BUILDER_REPOSITORY_NOT_CONFIGURED/,
    'another repository is never widened into, even on the same installation');
  assert.equal((await world.trace()).filter(entry => entry.method === 'POST').length, 1);
  assert.deepEqual((await credentials.revoke(grant)).kind, 'not-attempted', 'revocation is not claimed before ticket 20');
});

test('AC2: the host cache fetch credential is Contents read for a configured repository; an unknown issuance is never retried', async t => {
  const world = await githubWorld(t, { repositories, issues: [], pulls: [] });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const fetch = createRepositoryFetchCredentials({ github, repositories: [project] });
  const grant = await fetch.fetch(project);
  assert.match(grant.token, /-r3$/);
  assert.deepEqual((await world.trace()).filter(entry => entry.method === 'POST').map(entry => entry.permissions), [{ metadata: 'read', contents: 'read' }]);
  await assert.rejects(fetch.fetch({ repository: 'acme/other', installationId: 2, workflows: false }), /FETCH_REPOSITORY_NOT_CONFIGURED/);
});

test('an uncertain token POST throws GITHUB_TOKEN_ISSUANCE_UNKNOWN without a second POST', async t => {
  const world = await githubWorld(t, { repositories, issues: [], pulls: [] }, 'uncertain-post');
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const credentials = createBuilderCredentials({ github, repositories: [project] });
  await assert.rejects(credentials.issue({ workId: 'w', executionId: 'e', repository: project }), (error: Error & { outcome?: string }) =>
    error.message === 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' && error.outcome === 'unknown');
  assert.equal(world.native.tokenPosts, 1);
});
