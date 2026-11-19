import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guestShutdownScript, readGuestStop, stopGuestCleanly } from '../../src/sandbox/guest-shutdown.js';
import type { BootRef } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// Ticket 47 (offline, guest doubled): the clean stop asked of the guest before the VMM is closed, its grace-period bound and its record.
// The guest script is DATA here: it is parsed (`sh -n`), never executed on the host.
const boot = 'boot-47474747-2222-4333-8444-555555555555' as BootRef;
type Call = { argv: string[]; options: { signal: AbortSignal; stdout: string; stderr: string } };

test('ticket 47: a guest that stops its writers and leaves its root read-only is a clean stop (one separate guest exec)', async () => {
  const calls: Call[] = [];
  const stop = await stopGuestCleanly(async (argv, options) => { calls.push({ argv, options }); return { exitCode: 0 }; }, 30);
  assert.deepEqual(stop, { result: 'clean', reason: 'GUEST_ROOT_READ_ONLY' });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0]!.argv[0], calls[0]!.argv[1], calls[0]!.argv[2]], ['/bin/sh', '-c', guestShutdownScript(24)], '80% of the grace period');
  assert.deepEqual([calls[0]!.options.stdout, calls[0]!.options.stderr, calls[0]!.options.signal.aborted], ['ignore', 'ignore', false]);
});

test('ticket 47: the grace period bounds the guest stop; on expiry the stop is FORCED (the VMM is closed anyway)', async () => {
  let aborted = false;
  // The guest never answers (a busy guest or a stuck sync): the exec only ends when the grace-period signal fires.
  const stop = await stopGuestCleanly((_argv, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
  }), 0.005);
  assert.deepEqual([stop, aborted], [{ result: 'forced', reason: 'GUEST_FINALIZATION_TIMEOUT' }, true]);
});

test('ticket 47: a guest stop that fails (nonzero: root still writable; exec refused) is FORCED, never a guessed clean stop', async () => {
  assert.deepEqual(await stopGuestCleanly(async () => ({ exitCode: 3 }), 30), { result: 'forced', reason: 'GUEST_FINALIZATION_FAILED' });
  assert.deepEqual(await stopGuestCleanly(async () => { throw new Error('server is shutting down'); }, 30), { result: 'forced', reason: 'GUEST_FINALIZATION_FAILED' });
});

test('ticket 47: the guest script stops containers, then every non-Gondolin process, syncs and verifies a read-only ext4 root (parsed only)', async () => {
  const script = guestShutdownScript(24);
  const order = ['docker stop', 'kill -TERM $out', 'kill -KILL $out', 'sync', 'mount -o remount,ro /', 'echo u > /proc/sysrq-trigger', '/proc/mounts', 'exit 0'];
  let at = -1;
  for (const step of order) { const next = script.indexOf(step, at + 1); assert.ok(next > at, `${step} after the previous step`); at = next; }
  for (const kept of ['/usr/bin/sandboxd', '/usr/bin/sandboxfs', '/usr/bin/sandboxssh', '/usr/bin/sandboxingress', 'keep=" 1 $$ "']) assert.ok(script.includes(kept), kept);
  assert.ok(script.includes('test "$ticks" -lt 72 || break'), 'SIGTERM wait = 30% of the budget, in tenths of a second');
  assert.throws(() => guestShutdownScript(0), /INVALID_GUEST_SHUTDOWN_BUDGET/);
  const dir = await mkdtemp(join(tmpdir(), 'factory-guest-shutdown-'));
  try {
    await writeFile(join(dir, 'stop.sh'), script, { mode: 0o600 });
    execFileSync('/bin/sh', ['-n', join(dir, 'stop.sh')], { timeout: remainingMs() });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ticket 47: the boot stop record is read for that boot only; missing, foreign or invalid = an abrupt (forced) end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-guest-stop-'));
  try {
    assert.deepEqual(await readGuestStop(dir, boot), { result: 'forced', reason: 'NO_GUEST_STOP_RECORD' });
    await writeFile(join(dir, 'guest-stop.json'), JSON.stringify({ version: 1, boot, result: 'clean', reason: 'GUEST_ROOT_READ_ONLY' }), { mode: 0o600 });
    assert.deepEqual(await readGuestStop(dir, boot), { result: 'clean', reason: 'GUEST_ROOT_READ_ONLY' });
    assert.deepEqual(await readGuestStop(dir, 'boot-99999999-2222-4333-8444-555555555555' as BootRef), { result: 'forced', reason: 'NO_GUEST_STOP_RECORD' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
