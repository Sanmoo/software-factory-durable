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
import { checkRun, githubWorld, issue, worldScope } from './github-world-fixture.js';
import { untilHolds } from '../runner/budget.js';

// Ticket 16 composed level (I with a substituted boundary): public Control (owner loop, polling, dispatch, ticket 13 rounds, ticket 14's REAL
// publication flow, ticket 15's checks step, the readiness step, Pi Durable/SQLite) + the real IssueTracker/CodeRepository adapters, GitHub
// access, gh transport and Builder credentials; gh/GitHub is the local world fixture, Sandbox/Workers are doubled. The Builder double
// publishes its branch and draft PR with ITS grant; Control links it, explains its checks and converts it to ready itself.
const head = 'd'.repeat(40), tip = 'b'.repeat(40);
function builderGh(executable: string, token: string, endpoint: string, body: object): Promise<number> {
  return new Promise(resolve => {
    const child = execFile(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', endpoint], { env: { PATH: process.env.PATH ?? '', GH_TOKEN: token }, encoding: 'utf8' },
    (_error, stdout) => resolve(Number(/^HTTP\/[\d.]+ (\d{3})/.exec(stdout)?.[1] ?? 0)));
    child.stdin?.end(JSON.stringify(body));
  });
}

test('AC1-AC7 composed: the controller converts its own linked draft PR to ready from current evidence, with ONE mutation under its own fresh grant', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [], refs: {}, rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, checks: {
    branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
    rules: { main: [{ type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' }] },
    checkRuns: { [head]: [checkRun(3, 'docs', { conclusion: 'failure' })] }, statuses: { [head]: [] },
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
  const dir = await mkdtemp(join(tmpdir(), 'factory-readiness-composition-'));
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
  // Bounded by the runner budget (not an iteration count): exits as soon as the conversion settled.
  await untilHolds('readiness conversion settled', async () => {
    if ((await work())?.readiness?.effects.length) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 10);
  const view = (await work())!;
  assert.equal(view.publication?.state, 'published', JSON.stringify(view.publication?.reasons));
  const readiness = view.readiness!;
  assert.deepEqual([readiness.internal, readiness.flag.factory, readiness.flag.observed, readiness.latest.decision, readiness.latest.reasons], ['ready', 'ready', 'ready', 'ready', []]);
  assert.deepEqual(readiness.effects.map(item => [item.action, item.state, item.attempt?.outcome, item.attempt?.revocation, item.observation?.draft]),
    [['mark-ready', 'confirmed', 'applied', 'revoked', false]]);
  assert.equal(view.checks!.latest.optional[0]?.name, 'docs', 'an optional failure is visible and never blocks');
  assert.equal(view.checks!.latest.modalities[0]?.interpretation, 'human-stage', 'the pending human review does not block readiness');
  assert.deepEqual([view.result, view.queue.pending, view.impediments.map(item => item.code)], ['open', false, []], 'ready is not delivery');
  const trace = await world.trace();
  const writes = trace.filter(entry => entry.method !== 'GET' && !entry.endpoint.includes('access_tokens') && entry.endpoint !== '/installation/token');
  assert.deepEqual(writes.map(entry => entry.endpoint), ['/repos/acme/project/git/refs', '/repos/acme/project/pulls', 'graphql'], 'Builder publication, then ONE controller conversion');
  const issued = trace.filter(entry => entry.endpoint.endsWith('/access_tokens') && JSON.stringify(entry.permissions) === JSON.stringify({ metadata: 'read', pull_requests: 'write' }));
  assert.equal(issued.length, 1, 'one fresh readiness grant');
  assert.deepEqual(trace.filter(entry => entry.grant === issued[0]!.sequence).map(entry => [entry.method, entry.endpoint]), [['POST', 'graphql'], ['DELETE', '/installation/token']]);
  assert.match(writes[2]!.body!, /markPullRequestReadyForReview/);
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});
