import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { checkRun, commitStatus, githubWorld, pull, worldScope, type ChecksWorld, type World } from './github-world-fixture.js';

// Ticket 15 adapter level (I with a substituted boundary): the real CodeRepository adapter, GitHub access, gh transport, pagination and
// rate limiting; only gh/GitHub (and the App HTTPS endpoints) are replaced by the local world fixture. Not evidence of real GitHub.
const head = 'd'.repeat(40), tip = 'b'.repeat(40);
const own = pull(7, { head: { ref: 'factory/3-abcdef12', repo: { id: 3 } }, user: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, body: '<!-- software-factory:work:x -->' });
const checksWorld = (overrides: Partial<ChecksWorld> = {}): ChecksWorld => ({
  details: { 7: { head_sha: head, mergeable: null, mergeable_state: 'unknown', merge_commit_sha: 'e'.repeat(40) } },
  branches: { main: { sha: tip, protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['build'], checks: [{ context: 'build', app_id: 15368 }] } } } },
  requiredStatusChecks: { main: { strict: true, contexts: ['build', 'legacy'], checks: [{ context: 'build', app_id: 15368 }, { context: 'legacy', app_id: null }] } },
  rules: { main: [
    { type: 'required_status_checks', ruleset_source_type: 'Organization', ruleset_source: 'acme', ruleset_id: 11,
      parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'lint', integration_id: 15368 }, { context: 'ci/external' }] } },
    { type: 'workflows', ruleset_source_type: 'Repository', ruleset_source: 'acme/project', ruleset_id: 12, parameters: { workflows: [] } },
    { type: 'pull_request', ruleset_source_type: 'Repository', ruleset_source: 'acme/project', ruleset_id: 12, parameters: { required_approving_review_count: 1 } }] },
  checkRuns: { [head]: [checkRun(1, 'build'), checkRun(2, 'build', { status: 'queued', conclusion: null }), checkRun(3, 'lint', { conclusion: 'skipped' })] },
  statuses: { [head]: [commitStatus(20, 'ci/external', 'pending'), commitStatus(19, 'ci/external', 'success')] },
  compare: { [`${tip}...${head}`]: { status: 'diverged', ahead_by: 2, behind_by: 1 } },
  ...overrides });

async function compose(t: Parameters<typeof githubWorld>[0], world: Partial<World>) {
  const fixture = await githubWorld(t, { issues: [], pulls: [own], ...world });
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  return { ...fixture, repository: createCodeRepository({ github }) };
}

test('AC1: one read of the own PR covers identity/head/base/test merge/tri-state mergeability, classic + rulesets, paginated check-runs and statuses', async t => {
  const world = await compose(t, { pageSize: 1, checks: checksWorld() });
  const observed = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.equal(observed.kind, 'observed');
  if (observed.kind !== 'observed') return;
  assert.deepEqual(observed.pullRequest, { pullRequestId: 9007, nodeId: 'PR_node7', number: 7, url: 'https://github.com/acme/project/pull/7', state: 'open', merged: false,
    draft: true, headRef: 'factory/3-abcdef12', headSha: head, headRepositoryId: 3, baseRef: 'main', baseSha: 'a'.repeat(40), mergeCommitSha: 'e'.repeat(40),
    mergeable: null, mergeableState: 'unknown', author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' } });
  assert.deepEqual(observed.baseTip, { state: 'complete', value: tip });
  assert.deepEqual(observed.classic, { state: 'complete', value: { kind: 'required', strict: true, enforcement: 'everyone',
    checks: [{ context: 'build', integrationId: 15368 }, { context: 'legacy', integrationId: null }] } });
  assert.equal(observed.rules.state, 'complete');
  assert.deepEqual(observed.rules.state === 'complete' && observed.rules.value.map(rule => [rule.type, rule.ruleset.id, rule.ruleset.sourceType, rule.statusChecks ?? null]), [
    ['required_status_checks', 11, 'Organization', { strict: false, checks: [{ context: 'lint', integrationId: 15368 }, { context: 'ci/external', integrationId: null }] }],
    ['workflows', 12, 'Repository', null], ['pull_request', 12, 'Repository', null]], 'inherited (organization) and repository rules are all kept');
  assert.deepEqual(observed.checkRuns.state === 'complete' && observed.checkRuns.value.map(run => [run.id, run.name, run.status, run.conclusion, run.appId, run.checkSuiteId, run.headSha]),
    [[1, 'build', 'completed', 'success', 15368, 500, head], [2, 'build', 'queued', null, 15368, 500, head], [3, 'lint', 'completed', 'skipped', 15368, 500, head]], 'every page of every attempt');
  assert.deepEqual(observed.statuses.state === 'complete' && observed.statuses.value.map(item => [item.id, item.context, item.state, item.creator?.login]),
    [[20, 'ci/external', 'pending', 'ci-bot[bot]'], [19, 'ci/external', 'success', 'ci-bot[bot]']]);
  assert.deepEqual(observed.comparison, { state: 'complete', value: { status: 'diverged', aheadBy: 2, behindBy: 1 } });
  assert.deepEqual(observed.recheck, { state: 'complete', value: { headSha: head, baseRef: 'main', state: 'open', merged: false } });
  assert.ok(observed.limitations.some(item => /not an atomic/.test(item)));
  const trace = await world.trace();
  const operational = trace.filter(entry => entry.credential === 'installation');
  assert.ok(operational.length > 0 && operational.every(entry => entry.method === 'GET'), 'read-only: every installation request is a GET');
  const issued = trace.filter(entry => entry.endpoint.endsWith('/access_tokens'));
  assert.equal(issued.length, 1, 'one reduced grant reused for the whole collection');
  assert.deepEqual(issued[0]!.permissions, { metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', administration: 'read' });
  assert.ok(trace.some(entry => entry.endpoint.includes('/check-runs?filter=all&per_page=100&page=2')), 'object-wrapped pages are followed');
  assert.doesNotMatch(JSON.stringify(observed), /synthetic-installation-secret/);
});

test('AC1/AC2: a truncated check-run listing, a hidden rule set or protection and a missing branch are unknown, never an empty requirement or result', async t => {
  const world = await compose(t, { pageSize: 1, checks: checksWorld({ checkRunsTotalOffset: 1, requiredStatusChecks: {} }),
    faults: { '/rules/branches/': { status: 404 } } });
  const observed = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(observed.kind === 'observed');
  assert.deepEqual([observed.checkRuns.state, observed.checkRuns.state === 'unknown' && observed.checkRuns.code], ['unknown', 'INCOMPLETE_GITHUB_QUERY']);
  assert.deepEqual([observed.rules.state, observed.rules.state === 'unknown' && observed.rules.code], ['unknown', 'GITHUB_NOT_FOUND_OR_HIDDEN']);
  assert.deepEqual([observed.classic.state, observed.classic.state === 'unknown' && observed.classic.code], ['unknown', 'GITHUB_NOT_FOUND_OR_HIDDEN'],
    'enforced classic checks whose detail is hidden are unknown');
  assert.equal(observed.statuses.state, 'complete');
});

test('AC2: classic absence is concluded only from an authorized complete branch read (not protected, or status checks not enforced)', async t => {
  const unprotected = await compose(t, { checks: checksWorld({ branches: { main: { sha: tip, protected: false } }, requiredStatusChecks: {} }) });
  const a = await unprotected.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(a.kind === 'observed');
  assert.deepEqual(a.classic, { state: 'complete', value: { kind: 'none', evidence: 'BRANCH_NOT_PROTECTED' } });
  const off = await compose(t, { checks: checksWorld({ branches: { main: { sha: tip, protected: true, protection: { enabled: true,
    required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } } }, requiredStatusChecks: {} }) });
  const b = await off.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(b.kind === 'observed');
  assert.deepEqual(b.classic, { state: 'complete', value: { kind: 'none', evidence: 'STATUS_CHECKS_NOT_ENFORCED' } });
  const summaryless = await compose(t, { checks: checksWorld({ branches: { main: { sha: tip, protected: true } } }) });
  const c = await summaryless.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(c.kind === 'observed');
  assert.deepEqual(c.classic.state === 'unknown' && c.classic.code, 'CLASSIC_PROTECTION_SUMMARY_ABSENT', 'a protected branch without a readable summary is unknown');
  const denied = await compose(t, { checks: checksWorld(), faults: { '/branches/main': { status: 403 } } });
  const d = await denied.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(d.kind === 'observed');
  assert.deepEqual([d.baseTip.state, d.classic.state, d.comparison], ['unknown', 'unknown', null], 'denied access never proves an unprotected base');
});

test('AC7: the re-read after the collection exposes a push during it; an unreadable pull request is unavailable', async t => {
  const moved = await compose(t, { checks: checksWorld({ details: { 7: { head_sha: head, change: { afterReads: 2, head_sha: 'f'.repeat(40) } } } }) });
  const observed = await moved.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(observed.kind === 'observed');
  assert.equal(observed.pullRequest.headSha, head);
  assert.deepEqual(observed.recheck.state === 'complete' && observed.recheck.value.headSha, 'f'.repeat(40));
  const missing = await compose(t, { checks: checksWorld() });
  const absent = await missing.repository.readPullRequest({ repo: worldScope, number: 8 });
  assert.deepEqual([absent.kind, absent.kind === 'unavailable' && absent.code], ['unavailable', 'GITHUB_NOT_FOUND_OR_HIDDEN']);
});

test('AC1: a rate limit in the middle of the collection leaves the remaining reads unknown and sends nothing more', async t => {
  const world = await compose(t, { checks: checksWorld(), faults: { '/check-runs': { status: 429, headers: { 'retry-after': '90' } } } });
  const observed = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(observed.kind === 'observed');
  assert.deepEqual([observed.checkRuns.state, observed.checkRuns.state === 'unknown' && observed.checkRuns.code], ['unknown', 'GITHUB_RATE_LIMITED']);
  assert.deepEqual([observed.statuses.state, observed.statuses.state === 'unknown' && observed.statuses.code], ['unknown', 'GITHUB_RATE_LIMITED']);
  assert.equal(observed.recheck.state, 'unknown');
  const trace = await world.trace();
  assert.equal(trace.filter(entry => entry.endpoint.includes('/statuses')).length, 0, 'no request while the window is open');
});

test('review LOW: an item that fails its schema is unknown alone; the rest of the listing stays complete', async t => {
  const world = await compose(t, { checks: checksWorld({
    checkRuns: { [head]: [checkRun(1, 'build'), { id: 2, name: 'lint', head_sha: head, status: 42 }, { garbage: true }] },
    statuses: { [head]: [commitStatus(20, 'ci/external', 'success'), { id: 21, context: 'ci/other', state: null }] },
    rules: { main: [{ type: 'required_status_checks', ruleset_id: 11, parameters: { broken: true } }, { type: 'pull_request', ruleset_id: 12 }, { nope: 1 }] } }) });
  const observed = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(observed.kind === 'observed');
  assert.deepEqual(observed.checkRuns.state === 'complete' && observed.checkRuns.value.map(item => [item.id, item.name, item.status]),
    [[1, 'build', 'completed'], [2, 'lint', 'unparsed'], [0, '', 'unparsed']]);
  assert.deepEqual(observed.statuses.state === 'complete' && observed.statuses.value.map(item => [item.id, item.context, item.state]),
    [[20, 'ci/external', 'success'], [21, 'ci/other', 'unparsed']]);
  assert.deepEqual(observed.rules.state === 'complete' && observed.rules.value.map(item => [item.type, item.ruleset.id, item.unparsed ?? false]),
    [['required_status_checks', 11, true], ['pull_request', 12, false], ['unparsed', null, true]]);
});

test('review LOW: a check-run listing that reaches the 1000 check-suite cap is incomplete', async t => {
  const runs = Array.from({ length: 1000 }, (_, index) => checkRun(index + 1, `job-${index + 1}`));
  const world = await compose(t, { checks: checksWorld({ checkRuns: { [head]: runs } }) });
  const observed = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(observed.kind === 'observed');
  assert.deepEqual([observed.checkRuns.state, observed.checkRuns.state === 'unknown' && observed.checkRuns.code], ['unknown', 'CHECK_RUNS_LIMIT_REACHED']);
});

test('review MED 2: a light read of an unchanged head reads only the PR; a moved head gets the full collection', async t => {
  const world = await compose(t, { checks: checksWorld() });
  const light = await world.repository.readPullRequest({ repo: worldScope, number: 7, unless: { headSha: head, baseRef: 'main' } });
  assert.deepEqual([light.kind, light.kind === 'unchanged' && light.headSha], ['unchanged', head]);
  assert.deepEqual((await world.trace()).filter(entry => entry.credential === 'installation' && entry.endpoint !== '/repos/acme/project').map(entry => entry.endpoint),
    ['/repos/acme/project/pulls/7'], 'one GET');
  const full = await world.repository.readPullRequest({ repo: worldScope, number: 7, unless: { headSha: 'f'.repeat(40), baseRef: 'main' } });
  assert.equal(full.kind, 'observed');
});

test('spec §9.2 step 6: requirements are read at the start and again at the end of the collection', async t => {
  const world = await compose(t, { checks: checksWorld({ rulesChange: { afterReads: 2, rules: { main: [] } } }) });
  const observed = await world.repository.readPullRequest({ repo: worldScope, number: 7 });
  assert.ok(observed.kind === 'observed');
  assert.deepEqual([observed.rules.state === 'complete' && observed.rules.value.length, observed.final.rules.state === 'complete' && observed.final.rules.value.length], [3, 0]);
  assert.deepEqual(observed.final.baseTip, { state: 'complete', value: tip });
});
