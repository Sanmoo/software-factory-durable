import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ended, remainingMs, until, untilHolds } from './budget.js';

test('the guard is what remains of the runner deadline (minus a margin), never a fixed per-test timeout', () => {
  assert.equal(remainingMs({ FACTORY_TEST_DEADLINE: '100000' }, 50_000), 45_000);
  assert.equal(remainingMs({ FACTORY_TEST_DEADLINE: '100000' }, 99_000), 1_000, 'at least a second, so a late file still reports its stage');
  assert.equal(remainingMs({}, 0), 600_000, 'outside the runner (manual run, full): the ci ceiling');
  assert.equal(remainingMs({ FACTORY_TEST_DEADLINE: 'soon' }, 0), 600_000);
});

test('past the budget a hung child is killed with its whole group and the failure names the stage it reached', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log('grandchild ' + c.pid); setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let output = '';
  const grandchild = new Promise<number>(resolve =>
    child.stdout.on('data', data => {
      output += data;
      const pid = /grandchild (\d+)/.exec(output)?.[1];
      if (pid) resolve(Number(pid));
    }),
  );
  const pid = await grandchild;
  const saved = process.env.FACTORY_TEST_DEADLINE;
  process.env.FACTORY_TEST_DEADLINE = String(Date.now()); // already due: the 1 s floor applies
  try {
    await assert.rejects(
      ended(child, () => 'stage-canary'),
      /TEST_BUDGET_EXCEEDED.*last stage: stage-canary/,
    );
  } finally {
    if (saved === undefined) delete process.env.FACTORY_TEST_DEADLINE;
    else process.env.FACTORY_TEST_DEADLINE = saved;
  }
  // SIGKILL delivery is asynchronous: the event is the pipe the grandchild shares with its parent closing (both files closed).
  if (child.stdout.readable) await once(child.stdout, 'close');
  // The group was SIGKILLed: the grandchild is gone, a zombie, or on its exit path (PF_EXITING), never alive.
  let alive = false;
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
      .replace(/^.*\) /s, '')
      .split(' ');
    alive = !['Z', 'X'].includes(fields[0]!) && !(Number(fields[6]) & 0x4);
  } catch {
    /* gone */
  }
  assert.equal(alive, false);
});

test('a child that ends on its own resolves with its exit code; until() returns the first defined probe value', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { detached: true, stdio: 'ignore' });
  assert.deepEqual(await ended(child, () => 'unused'), { code: 7, signal: null });
  let probes = 0;
  assert.equal(await until('three probes', async () => (++probes === 3 ? 'ready' : undefined), 1), 'ready');
  let checks = 0;
  await untilHolds('two checks', () => ++checks === 2, 1);
  assert.equal(checks, 2);
});

test('past the budget a condition that never holds fails naming what it waited for', async () => {
  const saved = process.env.FACTORY_TEST_DEADLINE;
  process.env.FACTORY_TEST_DEADLINE = String(Date.now()); // already due: the 1 s floor applies
  try {
    await assert.rejects(
      untilHolds('stage-canary held', () => false, 50),
      /TEST_BUDGET_EXCEEDED waiting for: stage-canary held/,
    );
  } finally {
    if (saved === undefined) delete process.env.FACTORY_TEST_DEADLINE;
    else process.env.FACTORY_TEST_DEADLINE = saved;
  }
});
