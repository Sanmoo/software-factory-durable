import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireMachineLock, machineLockPath } from '../../scripts/test-runner/lock.ts';

const holder = fileURLToPath(new URL('./fixtures/ci-lock-holder.js', import.meta.url));

function start(lock: string, name: string, transcript: string[]) {
  const child = spawn(process.execPath, [holder, lock, name], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const waiters: { pattern: RegExp; resolve: () => void }[] = [];
  let buffered = '', errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  child.stdout.on('data', chunk => {
    buffered += String(chunk);
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      transcript.push(line);
      for (const waiter of [...waiters]) if (waiter.pattern.test(line)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
    }
  });
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  return {
    until: (pattern: RegExp) => new Promise<void>(resolve => {
      if (transcript.some(line => pattern.test(line))) resolve(); else waiters.push({ pattern, resolve });
    }),
    finish: async () => { child.stdin.end(); const code = await exited; assert.equal(code, 0, errors); },
  };
}

test('two simultaneous ci executions are serialized by the machine lock; the second waits, then runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tr-lock-'));
  try {
    const lock = join(root, 'machine.lock'), transcript: string[] = [];
    const first = start(lock, 'first', transcript);
    await first.until(/^first: working$/);
    const second = start(lock, 'second', transcript);
    await second.until(/^second: machine lock busy \(.*"name":"first".*\); queued/);
    assert.ok(!transcript.includes('second: working'), 'the second never starts work while the first holds the lock');
    await first.finish();
    await second.until(/^second: working$/);
    await second.finish();
    const order = transcript.filter(line => / (working|done)$|lock busy|^\w+: RESULT/.test(line)).map(line => line.replace(/ \(.*$/, ''));
    assert.deepEqual(order, ['first: working', 'second: machine lock busy', 'first: done', 'first: RESULT: PASS', 'second: working', 'second: done', 'second: RESULT: PASS']);
    assert.ok(transcript.some(line => /^second: lock wait: \d+\.\d s \(not counted in the budget\)$/.test(line)), 'the queue time is reported apart');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the lock is free again once its holder releases it, and lives outside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tr-lock-'));
  try {
    const path = join(root, 'machine.lock');
    const first = await acquireMachineLock(path, { name: 'a' }, () => {});
    first.release();
    const lines: string[] = [];
    const second = await acquireMachineLock(path, { name: 'b' }, line => lines.push(line));
    second.release();
    assert.deepEqual(lines, [], 'no queueing once released');
    assert.equal(machineLockPath({ XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/software-factory-test-runner.lock');
    assert.throws(() => machineLockPath({}), /TEST_RUNNER_LOCK_UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
