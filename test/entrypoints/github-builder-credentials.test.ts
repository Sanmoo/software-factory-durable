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
});

test('ticket 20 AC4: revoke sends one DELETE /installation/token with the grant itself; success, already-invalid, failure and unknown are distinct', async t => {
  const world = await githubWorld(t, { repositories, issues: [], pulls: [] });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const credentials = createBuilderCredentials({ github, repositories: [project] });
  const first = await credentials.issue({ workId: 'w', executionId: 'e', repository: project });
  const revoked = await credentials.revoke(first);
  assert.deepEqual([revoked.kind, revoked.code], ['revoked', 'GITHUB_TOKEN_REVOKED']);
  assert.deepEqual(await world.revoked(), [first.delivery.token]);
  const deletes = (await world.trace()).filter(entry => entry.method === 'DELETE');
  assert.deepEqual(deletes.map(entry => [entry.endpoint, entry.credential]), [['/installation/token', 'installation']], 'self-revocation with the installation token, never the App JWT');
  // A second attempt finds the token no longer accepted: distinct from a revocation, and never a proof of cessation.
  const again = await credentials.revoke(first);
  assert.deepEqual([again.kind, again.code], ['already-invalid', 'GITHUB_TOKEN_NOT_ACCEPTED']);
  assert.match(again.nextStep, /not proof of cessation/i);
  // Known rejection (complete response, not 2xx/401) = failed; no response at all = unknown. No automatic repetition in either case.
  const second = await credentials.issue({ workId: 'w', executionId: 'e', repository: project });
  await world.update(value => { value.faults = { '/installation/token': { status: 403 } }; });
  const failed = await credentials.revoke(second);
  assert.deepEqual([failed.kind, failed.code], ['failed', 'GITHUB_REVOCATION_REJECTED']);
  await world.update(value => { value.faults = { '/installation/token': { status: 502 } }; });
  assert.equal((await credentials.revoke(second)).kind, 'unknown', 'a server error does not say whether the token was revoked');
  await world.update(value => { delete value.faults; value.transportFailures = ['/installation/token']; });
  const unknown = await credentials.revoke(second);
  assert.deepEqual([unknown.kind, unknown.code], ['unknown', 'GITHUB_REVOCATION_OUTCOME_UNKNOWN']);
  assert.equal((await world.trace()).filter(entry => entry.method === 'DELETE').length, 4, 'one DELETE per revoke call, the transport failure leaves no response');
  // A grant whose value is gone cannot be revoked: impossibility is reported without any request.
  const impossible = await credentials.revoke({ metadata: second.metadata, delivery: { token: '' } });
  assert.deepEqual([impossible.kind, impossible.code], ['impossible', 'GRANT_VALUE_UNAVAILABLE']);
  assert.doesNotMatch(JSON.stringify([revoked, again, failed, unknown, impossible]), /synthetic-installation-secret/);
});

test('AC2: the host cache fetch credential is Contents read for a configured repository; an unknown issuance is never retried', async t => {
  const world = await githubWorld(t, { repositories, issues: [], pulls: [] });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const fetch = createRepositoryFetchCredentials({ github, repositories: [project] });
  const grant = await fetch.fetch(project);
  assert.match(grant.token, /-r3$/);
  assert.deepEqual((await world.trace()).filter(entry => entry.method === 'POST').map(entry => entry.permissions), [{ metadata: 'read', contents: 'read' }]);
  await assert.rejects(fetch.fetch({ repository: 'acme/other', installationId: 2, workflows: false }), /FETCH_REPOSITORY_NOT_CONFIGURED/);
  // Ticket 20 review: the host fetch credential is self-revoked after use.
  assert.equal((await fetch.revoke(grant)).kind, 'revoked');
  assert.deepEqual(await world.revoked(), [grant.token]);
});

test('an uncertain token POST throws GITHUB_TOKEN_ISSUANCE_UNKNOWN without a second POST', async t => {
  const world = await githubWorld(t, { repositories, issues: [], pulls: [] }, 'uncertain-post');
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const credentials = createBuilderCredentials({ github, repositories: [project] });
  await assert.rejects(credentials.issue({ workId: 'w', executionId: 'e', repository: project }), (error: Error & { outcome?: string }) =>
    error.message === 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' && error.outcome === 'unknown');
  assert.equal(world.native.tokenPosts, 1);
});
