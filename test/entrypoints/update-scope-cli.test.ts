import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareController } from './controller-configuration.js';
import { githubWorld } from './github-world-fixture.js';

// Composition: real CLI, controller owner under flock, protocol socket and Pi Durable/SQLite. GitHub is the local world fixture (no
// repositories, so no Work exists here). Where an accepted scope update lands is proven at flow level (test/control/continuation-flow).
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

test('AC3: `factory update-scope <work> --reason` identifies the request first, is idempotent, durable when not applied and indeterminate offline', { timeout: 45000 }, async t => {
  const world = await githubWorld(t, { issues: [], pulls: [] });
  const root = world.root;
  await prepareController(root);
  const cli = async (...args: string[]) => { const result = await invoke(root, args).result; return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }; };
  for (const bad of [['update-scope', work], ['update-scope', work, 'Only docs.'], ['update-scope', 'not-a-uuid', '--reason', 'Only touch docs/ please.'],
    ['update-scope', work, '--reason', ' padded reason text'], ['update-scope', work, '--reason', 'x'.repeat(2001)], ['update-scope', work, '--reason', 'a', 'b']]) {
    assert.equal((await cli(...bad)).code, 2, bad.join(' '));
  }
  const offline = await cli('update-scope', work, '--reason', 'Only touch docs/ please.', '--request-id', 'scope-offline');
  assert.equal(offline.code, 4);
  assert.match(offline.stderr, /REQUEST_IDENTIFIED.*scope-offline/);
  assert.match(offline.stderr, /REQUEST_INDETERMINATE/);
  const owner = invoke(root, ['run']);
  t.after(async () => { owner.child.kill('SIGTERM'); await owner.result; });
  for (let i = 0; i < 200 && (await cli('status')).code !== 0; i++) await delay(50);
  const first = await cli('update-scope', work, '--reason', 'Only touch docs/ please.', '--request-id', 'scope-1');
  assert.equal(first.code, 2, first.stderr);
  assert.deepEqual(first.json, { kind: 'durable', request_id: 'scope-1', operation: 'update-scope', work_id: work, outcome: 'not-applied', reason: 'WORK_NOT_FOUND',
    scopeUpdateId: null, appliesAt: null });
  assert.deepEqual((await cli('update-scope', work, '--reason', 'Only touch docs/ please.', '--request-id', 'scope-1')).json, first.json, 'same identity and content: same result');
  assert.deepEqual((await cli('update-scope', work, '--reason', 'Changed reason text here.', '--request-id', 'scope-1')).json, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual((await cli('request', 'scope-1')).json, { kind: 'request', receipt: first.json });
  // Ticket 16: `authorize-readiness <work> --reason` follows the same shape; with no Work, a durable not-applied receipt (nothing authorized).
  assert.equal((await cli('authorize-readiness', work, 'no flag')).code, 2);
  const authorize = await cli('authorize-readiness', work, '--reason', 'Restore ready after the human draft.', '--request-id', 'ready-1');
  assert.equal(authorize.code, 2, authorize.stderr);
  assert.match(authorize.stderr, /REQUEST_IDENTIFIED.*ready-1/);
  assert.deepEqual(authorize.json, { kind: 'durable', request_id: 'ready-1', operation: 'authorize-readiness', work_id: work, outcome: 'not-applied', reason: 'WORK_NOT_FOUND', purpose: null });
  // Ticket 25: cycle commands share the identified-request shape; with no Work every one is a durable not-applied receipt (nothing changed).
  for (const bad of [['cancel', 'not-a-uuid'], ['resume', work, 'extra'], ['reopen'], ['new', 'acme/project'], ['new', 'acme/project#0'], ['new', 'acme/project#3', '--keep']]) {
    assert.equal((await cli(...bad)).code, 2, bad.join(' '));
  }
  for (const operation of ['cancel', 'resume', 'reopen'] as const) {
    const result = await cli(operation, work, '--request-id', `${operation}-1`);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`REQUEST_IDENTIFIED.*${operation}-1`));
    assert.deepEqual(result.json, { kind: 'durable', request_id: `${operation}-1`, operation, work_id: work, outcome: 'not-applied', reason: 'WORK_NOT_FOUND', created: null });
  }
  const created = await cli('new', 'acme/project#3', '--keep-predecessor-pr', '--request-id', 'new-1');
  assert.equal(created.code, 2, created.stderr);
  assert.deepEqual(created.json, { kind: 'durable', request_id: 'new-1', operation: 'new', work_id: null, outcome: 'not-applied', reason: 'TICKET_NOT_KNOWN', created: null });
  assert.deepEqual((await cli('new', 'acme/project#3', '--request-id', 'new-1')).json, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' }, 'same identity, other decision');
  // Ticket 30: explicit cleanup through the real CLI/socket/owner: plan (identified request, nothing removed) and confirmation; no Work → not-applied.
  const plan = '0b9c6a52-3d3e-4c8f-9a51-000000000099';
  for (const bad of [['cleanup', work], ['cleanup', work, '--select'], ['cleanup', work, '--select', 'history'], ['cleanup', work, '--select', 'logs,evidence'],
    ['cleanup', 'not-a-uuid', '--select', 'logs'], ['cleanup', work, '--select', 'logs', '--yes', '--yes'], ['cleanup-confirm', work], ['cleanup-confirm', work, 'not-a-plan'],
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
