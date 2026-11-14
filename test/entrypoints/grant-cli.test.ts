import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareController } from './controller-configuration.js';
import { githubWorld } from './github-world-fixture.js';

// Composition: real CLI, controller owner under flock, protocol socket and Pi Durable/SQLite. GitHub is the local world fixture (no
// repositories, so no Work exists here). Applying a grant to a REAL exhausted Work is proven at flow level (test/control/budget-flow).
function invoke(root: string, args: string[]) {
  const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'], {
    env: { PATH: `${root}:${process.env.PATH ?? ''}`, HOME: '/forbidden-personal-profile' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); }) };
}
const work = '6f0c7a52-3d3e-4c8f-9a51-000000000042';

test('AC3/AC7: `factory grant` is an identified local ingress (exactly one counter, bounded amount), idempotent by identity and indeterminate when the controller is down', { timeout: 45000 }, async t => {
  const world = await githubWorld(t, { issues: [], pulls: [] });
  const root = world.root;
  await prepareController(root);
  const cli = async (...args: string[]) => { const result = await invoke(root, args).result; return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }; };
  for (const bad of [['grant', work], ['grant', work, '--corrections'], ['grant', work, '--corrections', '0'], ['grant', work, '--corrections', '101'],
    ['grant', work, '--corrections', '1.5'], ['grant', work, '--corrections', '-1'], ['grant', work, '--corrections', '1', '--recoveries', '1'],
    ['grant', 'not-a-uuid', '--corrections', '1'], ['grant', work, '--corrections', '01'], ['grant', work, '--minutes', '5']]) {
    assert.equal((await cli(...bad)).code, 2, bad.join(' '));
  }
  const offline = await cli('grant', work, '--corrections', '2', '--request-id', 'grant-offline');
  assert.equal(offline.code, 4);
  assert.match(offline.stderr, /REQUEST_IDENTIFIED.*grant-offline/);
  assert.match(offline.stderr, /REQUEST_INDETERMINATE/);
  const owner = invoke(root, ['run']);
  t.after(async () => { owner.child.kill('SIGTERM'); await owner.result; });
  for (let i = 0; i < 200 && (await cli('status')).code !== 0; i++) await delay(50);
  const first = await cli('grant', work, '--recoveries', '2', '--request-id', 'grant-1');
  assert.equal(first.code, 2, first.stderr);
  assert.deepEqual(first.json, { kind: 'durable', request_id: 'grant-1', operation: 'grant', work_id: work, counter: 'recoveries', amount: 2,
    outcome: 'not-applied', reason: 'WORK_NOT_FOUND', budget: null });
  assert.deepEqual((await cli('grant', work, '--recoveries', '2', '--request-id', 'grant-1')).json, first.json, 'same identity and content: same durable result');
  assert.deepEqual((await cli('grant', work, '--corrections', '2', '--request-id', 'grant-1')).json, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual((await cli('request', 'grant-1')).json, { kind: 'request', receipt: first.json });
  owner.child.kill('SIGTERM');
  assert.equal((await owner.result).code, 0);
});
