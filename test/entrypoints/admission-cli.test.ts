import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareController } from './controller-configuration.js';
import { githubWorld, issue, pull } from './github-world-fixture.js';

// Composition: real CLI, controller owner under flock, protocol socket, Pi Durable/SQLite, adapters, issuer and gh transport.
// Only gh/GitHub (and the App HTTPS endpoints) are substituted by the local world fixture: NOT evidence of the real GitHub boundary.
function invoke(root: string, args: string[], fixturePath: string) {
  const child = spawn(process.execPath, ['--import', join(fixturePath, 'native-fixture.mjs'), resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'], {
    env: { PATH: `${fixturePath}:${process.env.PATH ?? ''}`, GH_TOKEN: 'synthetic-personal-not-authorized', HOME: '/forbidden-personal-profile' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  }) };
}
type Json = Record<string, any>;

test('CLI list/show expose one durable Work per eligible Ticket across repeated polling and controller restart', { timeout: 45000 }, async t => {
  const world = await githubWorld(t, { issues: [issue(1), issue(2), issue(3, { labels: [] })], pulls: [pull(20, { body: 'Fixes #2' })] });
  const root = world.root;
  await prepareController(root);
  await writeFile(join(root, 'config.yaml'), (await readFile(join(root, 'config.yaml'), 'utf8'))
    .replace('credentials/unused.pem', 'credentials/app.pem')
    .replace('repositories: []', 'repositories: [{repository: acme/project, base: main, installationId: 2, workflows: false}]\npollingSeconds: 1'));
  const cli = async (...args: string[]) => {
    const result = await invoke(root, args, root).result;
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) as Json : undefined };
  };
  const unavailable = await cli('list');
  assert.equal(unavailable.code, 3);
  assert.match(unavailable.stderr, /CONTROLLER_UNAVAILABLE/, 'no offline reader of the authority');

  async function owner(minimumCycles: number) {
    const process = invoke(root, ['run'], root);
    let stopped = false;
    t.after(async () => { if (!stopped) { process.child.kill('SIGTERM'); await process.result; } });
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = await cli('status');
      if (status.code === 0 && status.json!.polling.cycles >= minimumCycles) return { async stop() {
        stopped = true; process.child.kill('SIGTERM'); const end = await process.result; assert.equal(end.code, 0, end.stderr);
      } };
      await delay(50);
    }
    throw new Error('controller did not complete polling cycles');
  }

  let running = await owner(3);
  const listed = await cli('list');
  assert.equal(listed.code, 0, listed.stderr);
  const view = listed.json!;
  assert.equal(view.kind, 'list');
  assert.equal(view.dispatch, 'closed');
  assert.deepEqual(view.works.map((work: Json) => [work.ticket.number, work.ticket.issueId, work.ticket.nodeId, work.ticket.repositoryId, work.queue.sequence]),
    [[1, 7001, 'I_node1', 3, 1]]);
  const work = view.works[0];
  assert.deepEqual(work.dispatch.reasons, ['DEPENDENCIES_NOT_EVALUATED', 'EXECUTION_NOT_ENABLED']);
  const candidates = view.polling.repositories[0].candidates as Json[];
  const foreign = candidates.find(candidate => candidate.ticket.number === 2)!;
  assert.equal(foreign.outcome, 'held');
  assert.equal(foreign.holds[0].code, 'FOREIGN_PULL_REQUEST');
  assert.deepEqual(foreign.holds[0].pullRequests.map((pr: Json) => [pr.number, pr.pullRequestId]), [[20, 9020]]);
  assert.equal(candidates.some(candidate => candidate.ticket.number === 3), false);
  const shown = await cli('show', work.work_id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.json!.kind, 'work');
  assert.equal(shown.json!.work.authorization.basis.label.name, 'ready-for-agent');
  const missing = await cli('show', '00000000-0000-4000-8000-000000000000');
  assert.equal(missing.json!.kind, 'work-not-found');
  assert.equal(missing.code, 2);
  assert.equal((await cli('show', 'not-a-work-id')).code, 2);
  await running.stop();

  // Operator resolves the foreign PR on GitHub; the restarted owner admits Ticket 2 once, Ticket 1 is not duplicated.
  await world.update(state => { state.pulls = []; });
  running = await owner(3);
  const after = (await cli('list')).json!;
  assert.deepEqual(after.works.map((item: Json) => [item.work_id === work.work_id, item.ticket.number, item.queue.sequence]), [[true, 1, 1], [false, 2, 2]]);
  const status = (await cli('status')).json!;
  assert.deepEqual([status.works.total, status.queues.normal, status.historyLength, status.polling.intervalSeconds], [2, 2, 0, 1]);
  await running.stop();

  const trace = await world.trace();
  assert.ok(trace.filter(entry => entry.credential === 'installation').every(entry => entry.method === 'GET'));
  assert.ok(trace.filter(entry => entry.method === 'POST').every(entry => entry.endpoint === '/app/installations/2/access_tokens'));
  assert.ok(trace.filter(entry => entry.method === 'POST').every(entry => !Object.values(entry.permissions ?? {}).includes('write')), 'polling grants are read-only');
  assert.ok(!trace.some(entry => /\/(labels|assignees|projects|comments)\b/.test(entry.endpoint.split('?')[0]!)));
  assert.ok(trace.filter(entry => entry.method === 'POST').length <= 4, 'grants are reused across polls of one owner (two purposes per owner)');
  const database = Buffer.concat(await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(name => readFile(join(root, 'data', name)).catch(() => Buffer.alloc(0)))));
  for (const forbidden of ['SPEC-BODY', 'synthetic-installation-secret', 'PRIVATE KEY']) assert.equal(database.includes(Buffer.from(forbidden)), false, forbidden);
});
