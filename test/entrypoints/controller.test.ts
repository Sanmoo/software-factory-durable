import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareController } from './controller-configuration.js';
import { remainingMs, until } from '../runner/budget.js';

const cli = resolve('dist/src/entrypoints/cli.js');
function invoke(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  }) };
}
async function command(root: string, ...args: string[]) {
  const result = await invoke([...args, '--root', root, '--json']).result;
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
async function ready(root: string, owner: ChildProcess) {
  return await until('controller available', async () => {
    if (owner.exitCode !== null) assert.fail(`controller exited ${owner.exitCode} before serving`);
    const result = await invoke(['status', '--root', root, '--json']).result;
    return result.code === 0 ? JSON.parse(result.stdout) as Record<string, unknown> : undefined;
  }, 20);
}

test('CLI pause is durable across controller restart and a repeated request does not reapply it', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-control-'));
  await prepareController(root);
  let owner = invoke(['run', '--root', root]);
  t.after(async () => { owner.child.kill('SIGTERM'); await owner.result; await rm(root, { recursive: true, force: true }); });
  const initial = await ready(root, owner.child);
  assert.equal(initial.paused, false);
  assert.equal(initial.dispatch, 'closed');
  const accepted = await command(root, 'pause', '--request-id', 'pause-1');
  assert.equal(accepted.kind, 'durable');
  assert.equal(accepted.paused, true);
  assert.equal((await command(root, 'status')).historyLength, 1);
  owner.child.kill('SIGTERM');
  assert.equal((await owner.result).code, 0);
  owner = invoke(['run', '--root', root]);
  assert.equal((await ready(root, owner.child)).paused, true);
  assert.deepEqual(await command(root, 'pause', '--request-id', 'pause-1'), accepted);
  assert.equal((await command(root, 'status')).historyLength, 1);
  assert.deepEqual((await command(root, 'request', 'pause-1')).receipt, accepted);
  await command(root, 'unpause', '--request-id', 'unpause-1');
  const status = await command(root, 'status');
  assert.equal(status.paused, false);
  assert.equal(status.dispatch, 'closed', 'unpause is not reconciliation or dispatch authority');
});
