import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareController } from './controller-configuration.js';
import { githubWorld } from './github-world-fixture.js';

// Ticket 30 composition: real CLI, controller owner under flock, protocol socket and Pi Durable/SQLite (GitHub = local world fixture, no Work).
// What a plan and its confirmation do on a real Work is proven at flow level (test/control/retention-flow).
function invoke(root: string, args: string[]) {
  const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'], {
    env: { PATH: `${root}:${process.env.PATH ?? ''}`, HOME: '/forbidden-personal-profile' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); }) };
}
const work = '0b9c6a52-3d3e-4c8f-9a51-000000000011';

test('ticket 30: `factory cleanup` / `cleanup-confirm` identify the request first; invalid selections refused locally; no Work → durable not-applied', async t => {
  const world = await githubWorld(t, { issues: [], pulls: [] });
  const root = world.root;
  await prepareController(root);
  const cli = async (...args: string[]) => { const result = await invoke(root, args).result; return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }; };
  const owner = invoke(root, ['run']);
  t.after(async () => { owner.child.kill('SIGTERM'); await owner.result; });
  for (let i = 0; i < 200 && (await cli('status')).code !== 0; i++) await delay(50);
  // Ticket 30: explicit cleanup through the real CLI/socket/owner: plan (identified request, nothing removed) and confirmation; no Work → not-applied.
  const plan = '0b9c6a52-3d3e-4c8f-9a51-000000000099';
  for (const bad of [['cleanup', work, '--select', 'logs,evidence'], ['cleanup', 'not-a-uuid', '--select', 'logs'], ['cleanup-confirm', work, 'not-a-plan'],
    ['cleanup', work, '--select', 'logs', '--yes', '--request-id', 'x'.repeat(121)]]) {
    assert.equal((await cli(...bad)).code, 2, bad.join(' '));
  }
  const planned = await cli('cleanup', work, '--select', 'logs,sessions', '--request-id', 'cleanup-1');
  assert.equal(planned.code, 2, planned.stderr);
  assert.match(planned.stderr, /REQUEST_IDENTIFIED.*cleanup-1/);
  assert.deepEqual(planned.json, { kind: 'durable', request_id: 'cleanup-1', operation: 'cleanup-plan', work_id: work, outcome: 'not-applied', reason: 'WORK_NOT_FOUND', plan: null });
  const automated = await cli('cleanup', work, '--select', 'logs', '--yes', '--request-id', 'cleanup-2');
  assert.equal(automated.code, 2, 'automation mode: no plan accepted, so nothing is confirmed');
  assert.doesNotMatch(automated.stderr, /cleanup-2-confirm/);
  const confirmed = await cli('cleanup-confirm', work, plan, '--request-id', 'confirm-1');
  assert.equal(confirmed.code, 2, confirmed.stderr);
  assert.deepEqual(confirmed.json, { kind: 'durable', request_id: 'confirm-1', operation: 'cleanup-confirm', work_id: work, outcome: 'not-applied', reason: 'WORK_NOT_FOUND', plan: null });
  owner.child.kill('SIGTERM');
  assert.equal((await owner.result).code, 0);
});
