import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker, type DependencyGraphObservation, type TicketRef } from '../../src/issue-tracker/index.js';
import { githubWorld, issue, worldScope, type World } from './github-world-fixture.js';

// Real IssueTracker adapter, issuer and gh transport; only gh/GitHub and the App HTTPS endpoints are substituted by the local
// world fixture (several repositories/installations). NOT evidence of the real GitHub boundary.
const repositories = [{ name: 'acme/project', id: 3, installation: 2 }, { name: 'acme/deps', id: 4, installation: 2 }, { name: 'other/lib', id: 5, installation: 6 }];
const depsScope = { repository: 'acme/deps', installationId: 2, workflows: false };
const libScope = { repository: 'other/lib', installationId: 6, workflows: false };
const root: TicketRef = { tracker: 'github', repository: 'acme/project', repositoryId: 3, issueId: 7001, nodeId: 'I_node1', number: 1, url: 'https://github.com/acme/project/issues/1' };
const remote = (repository: string, id: number, number: number, overrides: Parameters<typeof issue>[1] = {}) =>
  issue(number, { repository, id, node_id: `I_${id}`, labels: [], ...overrides });

async function compose(t: Parameters<typeof githubWorld>[0], world: World, dependencyScopes = [depsScope, libScope]) {
  const fixture = await githubWorld(t, { repositories, ...world });
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  return { ...fixture, tracker: createIssueTracker({ github, scopes: [worldScope], dependencyScopes }) };
}
const nodes = (graph: DependencyGraphObservation) => graph.nodes.map(node => [node.repository, node.number, node.issueId, node.state, node.stateReason, node.access, node.repositoryRole, node.blockedBy]);
const problems = (graph: DependencyGraphObservation) => graph.problems.map(problem => [problem.code, problem.observedCode ?? null, problem.issueId ?? null]);

test('native blocked_by is read across small Link pages, traversing closed blockers, with qualified identities and read-only grants', async t => {
  const world = await compose(t, { pageSize: 1, pulls: [], issues: [
    issue(1, { blocked_by: [{ number: 2 }, { number: 3 }, { number: 4 }], body: 'Depends on #9 (prose is never a relation)', labels: [{ id: 1, name: 'blocked' }] }),
    issue(2, { state: 'closed', state_reason: 'completed', blocked_by: [{ number: 5 }] }), issue(3), issue(4, { state: 'closed', state_reason: 'not_planned' }),
    issue(5, { state: 'closed', state_reason: 'duplicate' }), issue(9),
  ] });
  const graph = await world.tracker.readDependencyGraph(root);
  assert.deepEqual([graph.kind, graph.source, graph.completeness, graph.problems], ['observed', 'github-rest', 'complete', []]);
  assert.deepEqual(nodes(graph), [
    ['acme/project', 1, 7001, 'open', null, 'read', 'executable', [7002, 7003, 7004]],
    ['acme/project', 2, 7002, 'closed', 'completed', 'read', 'executable', [7005]],
    ['acme/project', 3, 7003, 'open', null, 'read', 'executable', []],
    ['acme/project', 4, 7004, 'closed', 'not_planned', 'read', 'executable', []],
    ['acme/project', 5, 7005, 'closed', 'duplicate', 'read', 'executable', []],
  ], 'issue 9 named only in prose is not a node; the duplicate is not followed');
  assert.deepEqual(graph.nodes[0]!.repositoryId, 3);
  assert.deepEqual(graph.principals, [{ installationId: 2, repository: 'acme/project', repositoryId: 3, role: 'executable', purpose: 'dependency-read', permissions: { metadata: 'read', issues: 'read' } }]);
  const trace = await world.trace();
  assert.ok(trace.filter(entry => entry.credential === 'installation').every(entry => entry.method === 'GET'));
  assert.deepEqual(trace.filter(entry => entry.method === 'POST').map(entry => entry.permissions), [{ metadata: 'read', issues: 'read' }]);
  assert.equal(trace.filter(entry => entry.endpoint.includes('/issues/1/dependencies/blocked_by') || entry.endpoint.startsWith('/repositories/3/issues/1/dependencies/blocked_by')).length, 3, 'three Link pages');
  assert.ok(!trace.some(entry => /blocking|\/labels|\/timeline|\/comments/.test(entry.endpoint)), 'no inverse relation, labels, timeline or comments');
  assert.doesNotMatch(JSON.stringify(graph), /synthetic-installation-secret|SPEC-BODY|Depends on #9/);
});

test('equal numbers in distinct repositories stay distinct; executable and dependency-only repositories are told apart; cross-owner uses its own installation', async t => {
  const world = await compose(t, { pulls: [], issues: [
    issue(1, { blocked_by: [{ number: 2 }, { repository: 'acme/deps', number: 2 }, { repository: 'other/lib', number: 2 }] }),
    issue(2, { state: 'closed', state_reason: 'completed' }),
    remote('acme/deps', 8002, 2, { state: 'closed', state_reason: 'completed' }), remote('other/lib', 9002, 2),
  ] });
  const graph = await world.tracker.readDependencyGraph(root);
  assert.equal(graph.completeness, 'complete');
  assert.deepEqual(nodes(graph).slice(1), [
    ['acme/project', 2, 7002, 'closed', 'completed', 'read', 'executable', []],
    ['acme/deps', 2, 8002, 'closed', 'completed', 'read', 'dependency-only', []],
    ['other/lib', 2, 9002, 'open', null, 'read', 'dependency-only', []],
  ]);
  assert.deepEqual(graph.nodes.map(node => node.repositoryId), [3, 3, 4, 5]);
  assert.deepEqual(graph.principals.map(p => [p.installationId, p.repository, p.repositoryId, p.role]), [[2, 'acme/project', 3, 'executable'], [2, 'acme/deps', 4, 'dependency-only'], [6, 'other/lib', 5, 'dependency-only']]);
  const posts = (await world.trace()).filter(entry => entry.method === 'POST');
  assert.deepEqual(posts.map(entry => [entry.endpoint, (entry as { repository?: string }).repository, entry.permissions]), [
    ['/app/installations/2/access_tokens', 'acme/project', { metadata: 'read', issues: 'read' }],
    ['/app/installations/2/access_tokens', 'acme/deps', { metadata: 'read', issues: 'read' }],
    ['/app/installations/6/access_tokens', 'other/lib', { metadata: 'read', issues: 'read' }],
  ], 'one reduced token per repository; no token spans repositories');
});

test('a blocker in a repository that is not configured is reported, never read with another identity and never ignored', async t => {
  const world = await compose(t, { pulls: [], issues: [issue(1, { blocked_by: [{ repository: 'other/lib', number: 2 }] }), remote('other/lib', 9002, 2, { state: 'closed', state_reason: 'completed' })] }, [depsScope]);
  const graph = await world.tracker.readDependencyGraph(root);
  assert.equal(graph.completeness, 'incomplete');
  assert.deepEqual(nodes(graph)[1], ['other/lib', 2, 9002, 'closed', 'completed', 'edge-only', 'not-configured', null]);
  assert.deepEqual(problems(graph), [['DEPENDENCY_REPOSITORY_NOT_CONFIGURED', null, 9002]]);
  assert.match(graph.problems[0]!.nextStep, /dependencyRepositories/);
  assert.ok(!(await world.trace()).some(entry => /installations\/6|other\/lib|repositories\/5/.test(entry.endpoint)));
});

test('a failure after an emitted page, invalid JSON and invalid relations never become a partial or empty edge list', async t => {
  const later = await compose(t, { pageSize: 1, pulls: [], issues: [issue(1, { blocked_by: [{ number: 2 }, { number: 3 }] }), issue(2), issue(3)],
    faults: { 'blocked_by?per_page=100&page=2': { status: 502 } } });
  const failed = await later.tracker.readDependencyGraph(root);
  assert.equal(failed.completeness, 'incomplete');
  assert.deepEqual(problems(failed), [['DEPENDENCY_READ_UNAVAILABLE', 'GITHUB_QUERY_FAILED', 7001]]);
  assert.deepEqual(failed.nodes.map(node => [node.number, node.access, node.blockedBy]), [[1, 'edge-only', null]], 'first page is not reported as the relation set');

  const json = await compose(t, { pulls: [], issues: [issue(1, { blocked_by: [{ number: 2 }] }), issue(2)], faults: { '/issues/1/dependencies/blocked_by': { status: 200, body: '[{"id": 70' } } });
  assert.deepEqual(problems(await json.tracker.readDependencyGraph(root)), [['DEPENDENCY_READ_UNAVAILABLE', 'INVALID_GITHUB_PAYLOAD', 7001]]);

  const invalid = await compose(t, { pulls: [], issues: [issue(1, { no_summary: true, raw_blocked_by: [
    { id: 7010, node_id: 'PR_10', number: 10, state: 'open', html_url: 'https://github.com/acme/project/pull/10', repository_url: 'https://api.github.com/repos/acme/project', pull_request: {} },
    { id: 7011, node_id: 'I_11', number: 11, state: 'open', html_url: 'https://github.com/acme/other/issues/11', repository_url: 'https://api.github.com/repos/acme/project' },
    { id: 7001, node_id: 'I_node1', number: 1, state: 'open', html_url: 'https://github.com/acme/project/issues/1', repository_url: 'https://api.github.com/repos/acme/project' },
    { unexpected: true },
  ] })] });
  const relations = await invalid.tracker.readDependencyGraph(root);
  assert.equal(relations.completeness, 'incomplete');
  assert.deepEqual(problems(relations), [['INVALID_DEPENDENCY_RELATION', null, 7001]]);
  assert.match(relations.problems[0]!.nextStep, /4 invalid/);
});

test('rate limits and count mismatches are explicit; a missing summary is a declared limitation, not support', async t => {
  const limited = await compose(t, { pulls: [], issues: [issue(1, { blocked_by: [{ number: 2 }] }), issue(2)],
    faults: { '/dependencies/blocked_by': { status: 403, headers: { 'retry-after': '90', 'x-ratelimit-remaining': '0' } } } });
  const graph = await limited.tracker.readDependencyGraph(root);
  assert.deepEqual([graph.problems[0]!.code, graph.problems[0]!.observedCode, graph.problems[0]!.waitSeconds], ['DEPENDENCY_READ_UNAVAILABLE', 'GITHUB_RATE_LIMITED', 90]);

  const hidden = await compose(t, { pulls: [], issues: [issue(1, { blocked_by: [{ number: 2 }], hidden_blocked_by: 1 }), issue(2, { state: 'closed', state_reason: 'completed' })] });
  const mismatch = await hidden.tracker.readDependencyGraph(root);
  assert.deepEqual(problems(mismatch), [['DEPENDENCY_COUNT_MISMATCH', null, 7001]]);
  assert.match(mismatch.problems[0]!.nextStep, /listed 1 .*reports 2/);

  const unsummarised = await compose(t, { pulls: [], issues: [issue(1, { blocked_by: [{ number: 2 }], no_summary: true }), issue(2)] });
  const plain = await unsummarised.tracker.readDependencyGraph(root);
  assert.equal(plain.completeness, 'complete');
  assert.ok(plain.limitations.some(limitation => /summary.*absent.*cannot be detected/i.test(limitation)));
  assert.ok(plain.limitations.some(limitation => /do not certify/i.test(limitation)));
});

test('each node is read once per evaluation: a cycle terminates and a shared node is not re-read; root identity drift is reported', async t => {
  const world = await compose(t, { pulls: [], issues: [
    issue(1, { blocked_by: [{ number: 2 }, { number: 3 }] }), issue(2, { blocked_by: [{ number: 4 }] }), issue(3, { blocked_by: [{ number: 4 }] }),
    issue(4, { blocked_by: [{ number: 2 }] }),
  ] });
  const graph = await world.tracker.readDependencyGraph(root);
  assert.equal(graph.completeness, 'complete', 'the adapter reports the reachable graph; cycles are decided by Control rules');
  assert.deepEqual(graph.nodes.map(node => [node.number, node.blockedBy]), [[1, [7002, 7003]], [2, [7004]], [3, [7004]], [4, [7002]]]);
  const reads = (await world.trace()).filter(entry => /\/issues\/\d+$/.test(entry.endpoint));
  assert.deepEqual(reads.map(entry => entry.endpoint), ['/repos/acme/project/issues/1', '/repos/acme/project/issues/2', '/repos/acme/project/issues/3', '/repos/acme/project/issues/4']);

  const drift = await compose(t, { pulls: [], issues: [issue(1, { id: 7999 })] });
  const drifted = await drift.tracker.readDependencyGraph(root);
  assert.deepEqual(problems(drifted), [['DEPENDENCY_ROOT_MISMATCH', null, 7001]]);
});

test('dependency-only preflight verifies read access with its own least-privilege purpose and creates no issues or relations', async t => {
  const world = await compose(t, { pulls: [], issues: [remote('acme/deps', 8002, 2, { blocked_by: [] })] });
  const diagnostic = await world.tracker.checkAccess({ ...depsScope, role: 'dependency-only' });
  assert.deepEqual([diagnostic.status, diagnostic.purpose, diagnostic.grant?.permissions], ['ok', 'dependency', { metadata: 'read', issues: 'read' }]);
  assert.ok(diagnostic.limitations?.some(limitation => /not certified/.test(limitation)));
  const trace = await world.trace();
  assert.ok(trace.filter(entry => entry.credential === 'installation').every(entry => entry.method === 'GET'));
  assert.ok(!trace.some(entry => /comments/.test(entry.endpoint)), 'no question/milestone probe for a dependency-only repository');
});
