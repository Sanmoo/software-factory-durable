import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { prepareController } from './controller-configuration.js';
import { remainingMs } from '../runner/budget.js';

async function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return (await once(child, 'message'))[0] as Record<string, unknown>;
}
function fixture(root: string, mode = 'control') {
  return spawn('flock', ['--exclusive', '--nonblock', '--no-fork', join(root, 'data/control.lock'),
    process.execPath, resolve('dist/test/entrypoints/control-fixture.js'), root, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
}

test('Control.accept/inspect/run never expose dispatch or a raw Session, before or after unpause', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-control-seam-'));
  await prepareController(root);
  await writeFile(join(root, 'data/control.lock'), '', { mode: 0o600 });
  const child = fixture(root);
  child.stderr?.resume();
  const ended = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await ended; await rm(root, { recursive: true, force: true }); });
  const first = await message(child);
  assert.deepEqual(first.surface, ['accept', 'inspect', 'run']);
  assert.equal((first.initial as Record<string, unknown>).dispatch, 'closed');
  assert.equal((first.initial as Record<string, unknown>).dispatchReason, 'RECONCILIATION_REQUIRED');
  let received = message(child);
  child.send({ request_id: 'unpause', operation: 'unpause', origin: 'local-cli' });
  const accepted = await received;
  assert.deepEqual(accepted.receipt, { kind: 'durable', request_id: 'unpause', operation: 'unpause', paused: false, historySequence: 1 });
  assert.equal((accepted.status as Record<string, unknown>).dispatch, 'closed');
  assert.equal((accepted.status as Record<string, unknown>).dispatchReason, 'EXECUTION_NOT_ENABLED');
  received = message(child);
  child.send('stop');
  assert.deepEqual(await received, { kind: 'clean' });
  assert.equal((await ended)[0], 0);
});

test('a surviving real Node subprocess does not inherit the no-fork owner lock descriptor', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-lock-fd-'));
  await prepareController(root);
  await writeFile(join(root, 'data/control.lock'), '', { mode: 0o600 });
  const owner = fixture(root, 'lock-probe');
  owner.stderr?.resume();
  const ended = once(owner, 'exit');
  let survivor: number | undefined;
  t.after(async () => {
    owner.kill('SIGKILL'); await ended;
    if (survivor) { try { process.kill(survivor, 'SIGKILL'); } catch { /* already ceased */ } }
    await rm(root, { recursive: true, force: true });
  });
  const reply = await message(owner);
  assert.equal(typeof reply.childPid, 'number');
  survivor = reply.childPid as number;
  owner.kill('SIGKILL');
  await ended;
  process.kill(survivor, 0); // The subprocess really outlived its owning process.
  const replacement = spawnSync('flock', ['--exclusive', '--nonblock', '--no-fork', join(root, 'data/control.lock'), process.execPath, '-e', ''], { timeout: remainingMs() });
  assert.equal(replacement.status, 0, replacement.stderr?.toString());
});
