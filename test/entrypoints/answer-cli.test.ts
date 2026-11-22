import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { remainingMs, untilHolds } from '../runner/budget.js';
import { prepareController } from './controller-configuration.js';
import { githubWorld } from './github-world-fixture.js';

// Composition: real CLI, controller owner under flock, protocol socket and Pi Durable/SQLite. GitHub is the local world fixture (unused:
// no repositories). Acceptance of a REAL Question is proven at flow level (test/control/question-flow) and by the real-run recipe:
// the production owner composes no execution ports, so no Question exists here.
function invoke(root: string, args: string[]) {
  const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'], {
    env: { PATH: `${root}:${process.env.PATH ?? ''}`, HOME: '/forbidden-personal-profile' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', data => {
    stdout += String(data);
  });
  child.stderr.on('data', data => {
    stderr += String(data);
  });
  return {
    child,
    result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    }),
  };
}
const qid = '0b9c6a52-3d3e-4c8f-9a51-000000000042';

test(
  'AC4/AC5: `factory answer` identifies the request before sending, is idempotent by identity, and is indeterminate (never assumed) when the controller is down',
  { timeout: remainingMs() },
  async t => {
    const world = await githubWorld(t, { issues: [], pulls: [] });
    const root = world.root;
    await prepareController(root);
    const cli = async (...args: string[]) => {
      const result = await invoke(root, args).result;
      return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined };
    };
    for (const bad of [
      ['answer', qid],
      ['answer', 'not-a-uuid', 'yes'],
      ['answer', qid, ' padded'],
      ['answer', qid, 'x'.repeat(2001)],
      ['answer', qid, 'a', 'b'],
    ]) {
      assert.equal((await cli(...bad)).code, 2, bad.join(' '));
    }
    const offline = await cli('answer', qid, 'Use docs/a.md', '--request-id', 'answer-offline');
    assert.equal(offline.code, 4);
    assert.match(offline.stderr, /REQUEST_IDENTIFIED.*answer-offline/);
    assert.match(offline.stderr, /REQUEST_INDETERMINATE/);
    const owner = invoke(root, ['run']);
    t.after(async () => {
      owner.child.kill('SIGTERM');
      await owner.result;
    });
    await untilHolds('controller available', async () => (await cli('status')).code === 0, 50);
    const first = await cli('answer', qid, 'Use docs/a.md', '--request-id', 'answer-1');
    assert.equal(first.code, 2, first.stderr);
    assert.deepEqual(first.json, {
      kind: 'durable',
      request_id: 'answer-1',
      operation: 'answer',
      question_id: qid,
      outcome: 'not-applied',
      reason: 'QUESTION_NOT_FOUND',
      work_id: null,
    });
    assert.deepEqual(
      (await cli('answer', qid, 'Use docs/a.md', '--request-id', 'answer-1')).json,
      first.json,
      'same identity and content: same durable result',
    );
    assert.deepEqual((await cli('answer', qid, 'Changed', '--request-id', 'answer-1')).json, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
    assert.deepEqual((await cli('request', 'answer-1')).json, { kind: 'request', receipt: first.json });
    const question = await cli('question', qid);
    assert.deepEqual([question.code, question.json.kind], [2, 'question-not-found']);
    const status = (await cli('status')).json;
    assert.deepEqual(status.questions, { open: 0, answered: 0, unpublished: 0 });
    owner.child.kill('SIGTERM');
    assert.equal((await owner.result).code, 0);
  },
);
