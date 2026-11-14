import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl, type ListView, type WorkView } from '../../src/control/index.js';
import { createBuilderCredentials, createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker } from '../../src/issue-tracker/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { githubWorld, issue, worldScope } from './github-world-fixture.js';
import { manualClock } from '../control/doubles.js';
import { executionDoubles, type Activation } from '../control/publication-doubles.js';

// I-local composition (ticket 14): REAL Control + Pi Durable/SQLite, REAL GitHubAccess issuer/transport, IssueTracker, CodeRepository and
// Builder credentials, with ticket 13's real review rounds; gh/GitHub (and App HTTPS) substituted by the local world fixture, Sandbox and
// Workers doubled. The Builder double publishes DIRECTLY with ITS delivered grant through the fixture's gh (`gh api` POST git/refs + pulls),
// exactly the boundary the guest uses; the controller never writes refs/PRs. NOT evidence of the real GitHub boundary (real recipe).
function builderGh(executable: string, token: string, endpoint: string, body: object): Promise<number> {
  return new Promise(resolve => {
    const child = execFile(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', endpoint], { env: { PATH: process.env.PATH ?? '', GH_TOKEN: token }, encoding: 'utf8' },
    (_error, stdout) => resolve(Number(/^HTTP\/[\d.]+ (\d{3})/.exec(stdout)?.[1] ?? 0)));
    child.stdin?.end(JSON.stringify(body));
  });
}

test('AC1/AC2/AC6 composition: real adapters discover absence, the Builder publishes with its own publish grant, Control links the own draft PR', async t => {
  const world = await githubWorld(t, { issues: [issue(3)], pulls: [], refs: {},
    branchRules: { main: [{ type: 'pull_request', ruleset_id: 1 }] }, rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const statuses: number[] = [];
  const publish = (_remote: unknown, activation: Activation) => {
    const workId = /Work ([0-9a-f-]{36})/.exec(activation.prompt)![1]!;
    const branch = /your branch (\S+);/.exec(activation.prompt)![1]!;
    const head = /verified commit ([0-9a-f]{40})/.exec(activation.prompt)![1]!;
    const body = [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the note. Closes #3', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n');
    return (async () => {
      statuses.push(await builderGh(world.executable, activation.token, '/repos/acme/project/git/refs', { ref: `refs/heads/${branch}`, sha: head }));
      statuses.push(await builderGh(world.executable, activation.token, '/repos/acme/project/pulls', { title: 'Factory smoke', head: branch, base: 'main', body, draft: true }));
    })();
  };
  const execution = executionDoubles({ pulls: {}, issues: [] }, [{ kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish, end: 'success' }]);
  // The real Builder credential projection replaces the double: the delivered token is the fixture's installation token of its purpose.
  execution.ports.credentials = createBuilderCredentials({ github, repositories: [worldScope] });
  const dir = await mkdtemp(join(tmpdir(), 'factory-publication-composition-'));
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
  for (let i = 0; i < 600 && (await work())?.publication?.state !== 'published'; i++) {
    if (time.isSleeping()) time.advance();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const final = (await work())!;
  assert.equal(final.publication?.state, 'published', JSON.stringify(final.publication?.reasons));
  assert.deepEqual(statuses, [201, 201], 'the Builder created its branch and its draft PR with ITS grant');
  assert.deepEqual([final.publication!.pullRequest!.author.login, final.publication!.pullRequest!.draft, final.publication!.pullRequest!.headSha],
    ['factory-app[bot]', true, 'd'.repeat(40)], 'author is the pinned App bot');
  assert.deepEqual(final.publication!.refsBefore, { 'refs/heads/main': 'b'.repeat(40) });
  const trace = await world.trace();
  const grants = trace.filter(entry => entry.endpoint.includes('access_tokens')).map(entry => entry.permissions);
  assert.ok(grants.some(item => item?.contents === 'write' && item.pull_requests === 'write'), 'one publish grant was issued');
  assert.equal(grants.filter(item => item?.contents === 'write').length, 1, 'only the publication activation held Contents W');
  // Every write came from the Builder's tokens: the controller's own writes are none (no comment, no ref, no PR).
  const writes = trace.filter(entry => entry.method !== 'GET' && !entry.endpoint.includes('access_tokens') && entry.endpoint !== '/installation/token');
  assert.deepEqual(writes.map(entry => entry.endpoint), ['/repos/acme/project/git/refs', '/repos/acme/project/pulls']);
  assert.equal(final.result, 'open');
});
