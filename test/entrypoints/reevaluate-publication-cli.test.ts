import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { remainingMs, untilHolds } from '../runner/budget.js';
import { prepareController } from './controller-configuration.js';
import { githubWorld } from './github-world-fixture.js';

// Composition, ticket 61: real CLI, controller owner under flock, protocol socket and Pi Durable/SQLite. GitHub is the local world fixture
// (no repositories, so no Work exists here). Where an accepted re-evaluation lands is proven at flow level (test/control/publication61-flow).
function invoke(root: string, args: string[]) {
  const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'], {
    env: { PATH: `${root}:${process.env.PATH ?? ''}`, HOME: '/forbidden-personal-profile' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); }) };
}
const work = '0b9c6a52-3d3e-4c8f-9a51-000000000061';
const reason = 'Work f4f421b6 published its own branch concurrently.';

test('ticket 61: `factory reevaluate-publication <work> --reason <text>` parses strictly, identifies the request first and is durable through the owner', { timeout: remainingMs() }, async t => {
  const world = await githubWorld(t, { issues: [], pulls: [] });
  const root = world.root;
  await prepareController(root);
  const cli = async (...args: string[]) => { const result = await invoke(root, args).result; return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }; };
  for (const bad of [['reevaluate-publication'], ['reevaluate-publication', work], ['reevaluate-publication', work, reason], ['reevaluate-publication', 'not-a-uuid', '--reason', reason],
    ['reevaluate-publication', work, '--reason', ` ${reason}`], ['reevaluate-publication', work, '--reason', 'x'.repeat(2001)], ['reevaluate-publication', work, '--reason', '--json'],
    ['reevaluate-publication', work, '--reason', reason, 'extra'], ['reevaluate-publication', work, '--reason', reason, '--request-id', 'bad id'],
    ['reevaluate-publication', work, '--reason', reason, '--new-review-round']]) {
    const result = await cli(...bad);
    assert.equal(result.code, 2, bad.join(' '));
    assert.match(result.stderr, /INVALID_ARGUMENTS/, bad.join(' '));
    assert.match(result.stderr, /reevaluate-publication <work> --reason <text>/, 'the usage names the command');
  }
  const offline = await cli('reevaluate-publication', work, '--reason', reason, '--request-id', 're-offline');
  assert.equal(offline.code, 4);
  assert.match(offline.stderr, /REQUEST_IDENTIFIED.*re-offline/);
  assert.match(offline.stderr, /REQUEST_INDETERMINATE/);
  const owner = invoke(root, ['run']);
  t.after(async () => { owner.child.kill('SIGTERM'); await owner.result; });
  await untilHolds('controller available', async () => (await cli('status')).code === 0, 50);
  const first = await cli('reevaluate-publication', work, '--reason', reason, '--request-id', 're-1');
  assert.equal(first.code, 2, first.stderr);
  assert.match(first.stderr, /REQUEST_IDENTIFIED.*re-1/);
  assert.deepEqual(first.json, { kind: 'durable', request_id: 're-1', operation: 'reevaluate-publication', work_id: work, outcome: 'not-applied', reason: 'WORK_NOT_FOUND', nextStep: null });
  assert.deepEqual((await cli('reevaluate-publication', work, '--reason', reason, '--request-id', 're-1')).json, first.json, 'same identity and content: same result');
  assert.deepEqual((await cli('reevaluate-publication', work, '--reason', 'Another reason text.', '--request-id', 're-1')).json, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual((await cli('request', 're-1')).json, { kind: 'request', receipt: first.json });
});
