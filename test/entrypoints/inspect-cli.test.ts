import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { chmod, realpath } from 'node:fs/promises';
import { remainingMs, untilHolds } from '../runner/budget.js';
import { prepareController } from './controller-configuration.js';
import { githubWorld } from './github-world-fixture.js';
import { seedInspectedWork } from '../control/inspection-fixture.js';
import { main } from '../../src/entrypoints/cli.js';

// Ticket 29 composition: real CLI, controller owner under flock, protocol socket and Pi Durable/SQLite seeded with a Work of four Executions.
// A development checkout composes no execution: Records/usage observation are honestly unavailable (exit 3), never an empty list or a zero.
function invoke(root: string, args: string[]) {
  const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'], {
    env: { PATH: `${root}:${process.env.PATH ?? ''}`, HOME: '/forbidden-personal-profile' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); }) };
}

test('AC1-AC3/AC6: history/logs/usage/show over the socket, read-only, with stable codes for invalid, not found, unavailable and offline', { timeout: remainingMs() }, async t => {
  const world = await githubWorld(t, { issues: [], pulls: [] });
  const root = world.root;
  await prepareController(root);
  const work = await seedInspectedWork(join(root, 'data', 'control.sqlite'), await realpath(root));
  for (const suffix of ['', '-wal', '-shm']) await chmod(join(root, 'data', `control.sqlite${suffix}`), 0o600).catch(() => {});
  const cli = async (...args: string[]) => { const result = await invoke(root, args).result; return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined,
    error: result.stderr ? JSON.parse(result.stderr.trim().split('\n').at(-1)!) : undefined }; };
  // Argument validation happens before any connection: checked in-process on the real `main` (no controller, nothing read).
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    for (const bad of [['history'], ['history', 'not-a-uuid'], ['history', work, '--limit', '0'], ['history', work, '--limit', '201'], ['history', work, '--role', 'judge'],
      ['history', work, '--cursor', '-1'], ['logs', work, '--read', 'not-a-uuid'], ['logs', work, '--offset', '3'], ['logs', work, '--read', work, '--role', 'builder'],
      ['usage', 'not-a-uuid'], ['history', work, '--read', work], ['usage', work, '--limit', '3'], ['logs', work, '--cursor', '1'], ['list', '--after', work],
      ['show', work, '--role', 'spec']]) {
      errors.length = 0;
      assert.equal(await main([...bad, '--root', root, '--json']), 2, bad.join(' '));
      assert.equal(JSON.parse(errors.at(-1)!).code, 'INVALID_ARGUMENTS', bad.join(' '));
    }
  } finally { console.error = original; }
  const offline = await cli('history', work);
  assert.equal(offline.code, 3);
  assert.deepEqual([offline.error.code, offline.error.scope, offline.error.outcome], ['CONTROLLER_UNAVAILABLE', 'installation', 'unavailable']);
  assert.match(offline.error.nextStep, /not an empty result/);
  const owner = invoke(root, ['run']);
  t.after(async () => { owner.child.kill('SIGTERM'); await owner.result; });
  await untilHolds('controller available', async () => (await cli('status')).code === 0, 50);
  const status = await cli('status');
  assert.deepEqual(status.json.impediments.codes, { RECOVERY_BLOCKED: 1 });
  assert.equal(status.json.consumption.executions.total, 4);
  const page = await cli('history', work, '--limit', '2');
  assert.equal(page.code, 0, page.stderr);
  assert.deepEqual([page.json.kind, page.json.entries.length, page.json.page.nextCursor], ['history', 2, 2]);
  const filtered = await cli('history', work, '--execution', 'e-2', '--role', 'standards');
  assert.deepEqual(filtered.json.entries.map((item: { entry: { event: string } }) => item.entry.event), ['reviewer-started']);
  const logs = await cli('logs', work, '--role', 'builder');
  assert.equal(logs.code, 3, 'Records not composed: unavailable, not an empty success');
  assert.deepEqual([logs.json.listing.state, logs.json.listing.code, logs.json.captures], ['unavailable', 'RECORDS_NOT_COMPOSED', []]);
  const read = await cli('logs', work, '--read', '00000000-0000-4000-8000-000000000000', '--offset', '10');
  assert.deepEqual([read.code, read.json.state, read.json.code], [3, 'unknown', 'RECORDS_NOT_COMPOSED']);
  const usage = await cli('usage', work);
  assert.equal(usage.code, 0);
  assert.deepEqual([usage.json.scope, usage.json.total.measurement, usage.json.total.tokens], ['work', 'unavailable', null], 'not composed: unavailable, never zero');
  assert.equal((await cli('usage')).json.scope, 'installation');
  const listed = await cli('list', '--limit', '1');
  assert.deepEqual([listed.code, listed.json.works.length, listed.json.page.limit], [0, 1, 1], 'list pages over the socket');
  assert.equal((await cli('list')).json.page.limit, 50, 'the socket always pages list (default 50)');
  const show = await cli('show', work);
  assert.deepEqual([show.json.chain.phase.code, show.json.chain.executions.length], ['blocked', 4]);
  const missing = await cli('history', '00000000-0000-4000-8000-000000000000');
  assert.deepEqual([missing.code, missing.json.kind], [2, 'work-not-found']);
  owner.child.kill('SIGTERM');
  assert.equal((await owner.result).code, 0);
});
