import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { githubWorld, issue, pull, worldScope, type World } from './github-world-fixture.js';

// Ticket 16, I-local: the real CodeRepository `setDraft` (Q4B), GitHub access/issuer and gh transport; only gh/GitHub and the App HTTPS
// endpoints are substituted by the local world fixture. NOT evidence of the real GitHub boundary (that is the ticket 16 real-run recipe).
const head = 'd'.repeat(40);
const own = (overrides: Partial<ReturnType<typeof pull>> = {}) => pull(7, { head: { ref: 'factory/3-abcdef12', sha: head, repo: { id: 3 } }, draft: true,
  user: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, ...overrides });
async function compose(t: Parameters<typeof githubWorld>[0], world: Partial<World> = {}) {
  const fixture = await githubWorld(t, { issues: [issue(3)], pulls: [own()], checks: { branches: { main: { sha: 'b'.repeat(40), protected: false } },
    compare: { [`${'b'.repeat(40)}...${head}`]: { status: 'ahead', ahead_by: 1, behind_by: 0 } } }, ...world });
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  return { ...fixture, repository: createCodeRepository({ github }) };
}
const pr = { repo: worldScope, number: 7, nodeId: 'PR_node7' };
const effect = { effectId: '5f0c0e2e-0000-4000-8000-000000000016' };

test('AC3: ONE ready-for-review mutation on the own PR node under a fresh single-use grant (metadata R, pull requests W) used for nothing else, revoked after', async t => {
  const world = await compose(t);
  const before = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.equal(before.kind === 'observed' ? before.pullRequest.draft : null, true);
  const issuedBefore = (await world.trace()).filter(entry => entry.endpoint.includes('access_tokens')).length;
  const result = await world.repository.setDraft(pr, false, effect);
  assert.deepEqual([result.kind, result.kind === 'applied' ? [result.draft, result.headSha] : null, result.revocation], ['applied', [false, head], 'revoked']);
  const trace = await world.trace();
  const issued = trace.filter(entry => entry.endpoint.includes('access_tokens'));
  assert.equal(issued.length, issuedBefore + 1, 'a NEW grant, never the cached read grants');
  assert.deepEqual(issued.at(-1)!.permissions, { metadata: 'read', pull_requests: 'write' });
  const grant = (issued.at(-1) as { sequence?: number }).sequence;
  const used = trace.filter(entry => (entry as { grant?: number }).grant === grant);
  assert.deepEqual(used.map(entry => [entry.method, entry.endpoint]), [['POST', 'graphql'], ['DELETE', '/installation/token']], 'the grant serves exactly the mutation and its revocation');
  const mutation = JSON.parse(used[0]!.body!) as { query: string; variables: Record<string, string> };
  assert.match(mutation.query, /^mutation\(\$id: ID!, \$cid: String\) \{ markPullRequestReadyForReview\(input: \{pullRequestId: \$id, clientMutationId: \$cid\}\)/);
  assert.deepEqual(mutation.variables, { id: 'PR_node7', cid: effect.effectId }, 'correlated by the effect identity');
  assert.ok(trace.every(entry => entry.method === 'GET' || entry.endpoint.includes('access_tokens') || entry === used[0] || entry === used[1]), 'no other write');
  const after = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.equal(after.kind === 'observed' ? after.pullRequest.draft : null, false, 'the observation is a separate read');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-installation-secret/);
  const back = await world.repository.setDraft(pr, true, { effectId: '5f0c0e2e-0000-4000-8000-000000000017' });
  assert.equal(back.kind === 'applied' ? back.draft : null, true);
  assert.match((JSON.parse((await world.trace()).filter(entry => entry.endpoint === 'graphql').at(-1)!.body!) as { query: string }).query, /convertPullRequestToDraft/);
});

test('AC3: GraphQL errors are a known failure; a 5xx or a lost transport is UNKNOWN (may have applied); neither is retried; revocation always attempted', async t => {
  const forbidden = await compose(t, { graphqlFault: { status: 200, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }], applied: false } });
  const known = await forbidden.repository.setDraft(pr, false, effect);
  assert.deepEqual([known.kind, known.kind !== 'applied' ? known.code : null, known.revocation], ['known-failure', 'GITHUB_GRAPHQL_FORBIDDEN', 'revoked']);
  const ambiguous = await compose(t, { graphqlFault: { status: 502, applied: true } });
  const unknown = await ambiguous.repository.setDraft(pr, false, effect);
  assert.deepEqual([unknown.kind, unknown.revocation], ['unknown', 'revoked']);
  assert.equal((await ambiguous.trace()).filter(entry => entry.endpoint === 'graphql').length, 1, 'no automatic retry');
  const discovered = await ambiguous.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.equal(discovered.kind === 'observed' ? discovered.pullRequest.draft : null, false, 'discovery shows the ambiguous mutation did apply');
  const lost = await compose(t, { transportFailures: ['graphql'] });
  const transport = await lost.repository.setDraft(pr, false, effect);
  assert.deepEqual([transport.kind, transport.kind !== 'applied' ? transport.code : null], ['unknown', 'GITHUB_TRANSPORT_UNAVAILABLE']);
  const mismatch = await compose(t, { graphqlFault: { status: 200, applied: true, nodeId: 'PR_other' } });
  assert.equal((await mismatch.repository.setDraft(pr, false, effect)).kind, 'unknown', 'a success payload for another node is not a confirmation');
});

test('AC6: only the two fixed draft mutations exist; invalid input is refused locally with nothing issued or sent', async t => {
  const world = await compose(t);
  const issued = (await world.trace()).length;
  for (const bad of [{ ...pr, nodeId: 'PR"){ mergePullRequest' }, { ...pr, number: 0 }]) {
    const refused = await world.repository.setDraft(bad, false, effect);
    assert.deepEqual([refused.kind, refused.kind !== 'applied' ? refused.code : null, refused.revocation], ['known-failure', 'INVALID_DRAFT_CONVERSION', 'not-issued']);
  }
  assert.equal((await world.repository.setDraft(pr, false, { effectId: 'not a uuid' })).kind, 'known-failure');
  assert.equal((await world.trace()).length, issued, 'nothing sent, no grant issued');
});
