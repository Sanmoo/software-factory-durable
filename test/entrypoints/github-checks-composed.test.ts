import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuilderCredentials, createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker } from '../../src/issue-tracker/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { openControl, type ListView, type WorkView } from '../../src/control/index.js';
import { manualClock } from '../control/doubles.js';
import { executionDoubles, type Activation } from '../control/publication-doubles.js';
import { checkRun, commitStatus, githubWorld, issue, worldScope } from './github-world-fixture.js';
import { until } from '../runner/budget.js';

// Ticket 15 composed level (I with a substituted boundary): public Control (owner loop, polling, dispatch, ticket 13 rounds, ticket 14's REAL
// publication flow, the checks tracking step, Pi Durable/SQLite) + the real IssueTracker/CodeRepository adapters, GitHub access, gh
// transport and Builder credentials; gh/GitHub is the local world fixture, Sandbox/Workers are doubled. The Builder double publishes its
// branch and draft PR with ITS grant (as in ticket 14's composition test); Control links it; then the checks of that PR are explained.
const head = 'd'.repeat(40), tip = 'b'.repeat(40);
function builderGh(executable: string, token: string, endpoint: string, body: object): Promise<number> {
  return new Promise(resolve => {
    const child = execFile(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', endpoint], { env: { PATH: process.env.PATH ?? '', GH_TOKEN: token }, encoding: 'utf8' },
    (_error, stdout) => resolve(Number(/^HTTP\/[\d.]+ (\d{3})/.exec(stdout)?.[1] ?? 0)));
    child.stdin?.end(JSON.stringify(body));
  });
}

test('AC1-AC7 composed: after ticket 14 links the own draft PR, the owner loop explains its required checks from real GitHub reads, durably', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [], refs: {}, rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, checks: {
    branches: { main: { sha: tip, protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['build'] } } } },
    requiredStatusChecks: { main: { strict: false, contexts: ['build'], checks: [{ context: 'build', app_id: 15368 }] } },
    rules: { main: [{ type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' },
      { type: 'required_status_checks', ruleset_source_type: 'Organization', ruleset_source: 'acme', ruleset_id: 11,
        parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'ci/external' }] } }] },
    checkRuns: { [head]: [checkRun(1, 'build', { conclusion: 'failure' }), checkRun(2, 'build', { status: 'in_progress', conclusion: null }), checkRun(3, 'docs', { conclusion: 'failure' })] },
    statuses: { [head]: [commitStatus(10, 'ci/external', 'success')] },
    compare: { [`${tip}...${head}`]: { status: 'ahead', ahead_by: 1, behind_by: 0 } } } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const publish = (_remote: unknown, activation: Activation) => {
    const workId = /Work ([0-9a-f-]{36})/.exec(activation.prompt)![1]!;
    const branch = /your branch (\S+);/.exec(activation.prompt)![1]!;
    const verified = /verified commit ([0-9a-f]{40})/.exec(activation.prompt)![1]!;
    const body = [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the note. Closes #3', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n');
    return (async () => {
      await builderGh(world.executable, activation.token, '/repos/acme/project/git/refs', { ref: `refs/heads/${branch}`, sha: verified });
      await builderGh(world.executable, activation.token, '/repos/acme/project/pulls', { title: 'Factory smoke', head: branch, base: 'main', body, draft: true });
    })();
  };
  const execution = executionDoubles({ pulls: {}, issues: [] }, [{ kind: 'implement', head }, { kind: 'publish', publish, end: 'success' }]);
  execution.ports.credentials = createBuilderCredentials({ github, repositories: [worldScope] });
  const dir = await mkdtemp(join(tmpdir(), 'factory-checks-composition-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: createIssueTracker({ github, scopes: [worldScope], dependencyScopes: [] }), repository: createCodeRepository({ github }), repositories: [worldScope],
      operators: ['operator-one'], factoryApp: () => github.appIdentity(worldScope) }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  await time.sleeping();
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  // No fixed iteration count (800 x 10 ms expired once at ci load 18, ticket 37): advance the manual polling clock whenever the poller
  // sleeps until the checks are explained, bounded only by the runner budget.
  let last: WorkView | undefined;
  const view = await until(() => `checks explained; last publication: ${JSON.stringify(last?.publication ?? null)}`, async () => {
    last = await work();
    if (last?.checks) return last;
    if (time.isSleeping()) time.advance();
    return undefined;
  }, 10);
  assert.equal(view.publication?.state, 'published', JSON.stringify(view.publication?.reasons));
  const latest = view.checks!.latest;
  assert.deepEqual([latest.pullRequest.number, latest.pullRequest.headSha], [view.publication!.pullRequest!.number, head], 'the PR ticket 14 linked, at its verified head');
  assert.equal(latest.outcome, 'waiting');
  assert.deepEqual(latest.requirements.map(item => [item.context, item.integrationId, item.sources, item.state, item.results.map(result => result.id)]), [
    ['build', 15368, ['classic'], 'waiting', [2]], ['ci/external', null, ['ruleset:11:Organization:acme'], 'satisfied', [10]]],
    'the in-progress rerun is current: the older failure neither repairs nor borrows');
  assert.deepEqual(latest.reasons, [{ category: 'wait', code: 'REQUIRED_CHECK_PENDING', subject: 'build' }]);
  assert.deepEqual(latest.optional.map(item => [item.name, item.classification]), [['docs', 'failed']], 'an optional failure is only visible');
  assert.deepEqual(latest.modalities.map(item => [item.type, item.interpretation]), [['pull_request', 'human-stage'], ['required_status_checks', 'required-checks']]);
  assert.deepEqual([latest.requiredSet, latest.strict.state], ['non-empty', 'not-required']);
  assert.ok(Object.values(latest.completeness).every(value => value === 'complete'));
  assert.deepEqual([view.queue.pending, view.impediments.map(item => item.code)], [false, []], 'tracking only: no queue entry, no impediment');
  const trace = await world.trace();
  assert.ok(trace.some(entry => entry.endpoint.endsWith('/access_tokens') && JSON.stringify(entry.permissions) ===
    JSON.stringify({ metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', administration: 'read' })));
  const writes = trace.filter(entry => entry.method !== 'GET' && !entry.endpoint.includes('access_tokens') && entry.endpoint !== '/installation/token');
  assert.deepEqual(writes.map(entry => entry.endpoint), ['/repos/acme/project/git/refs', '/repos/acme/project/pulls'], 'the only writes are the Builder\'s own publication');
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});
