import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelPrelude, guestPath } from '../../src/sandbox/bash-tools.js';
import { remoteCommand } from '../../src/sandbox/lambda/ssh-transport.js';
import { callMarker, endCallOutcome, endCallProgram, toolScript } from '../../src/sandbox/lambda/tools.js';
import type { GuestExecRequest } from '../../src/sandbox/lambda/transport.js';
import { ended, killTree, remainingMs } from '../runner/budget.js';

// Real run of 2026-11-22 (V2-21): the REAL guest programs of a dropped call, run by a real bash over real processes. The in-process
// guest of the other Lambda tests answers `end-call` from a table; it cannot show what the shell text does to a process group. Nothing
// here is AWS, ssh or a VM: what `sshd` gives a command (a new session whose leader is the command) is given by `setsid`.

/** One program as the transport delivers it: the remote command line through the user's shell, environment and input on stdin. */
const delivered = (request: GuestExecRequest) => { const remote = remoteCommand(request)!; return { command: remote.command, stdin: Buffer.from(remote.stdin) }; };
const runProgram = (request: GuestExecRequest) => {
  const { command, stdin } = delivered(request);
  return spawnSync('/bin/bash', ['-c', command], { input: stdin, encoding: 'utf8', timeout: remainingMs() });
};
/** State and process group of a process, from `/proc` (the command name may hold spaces and parentheses). */
const processState = (pid: number): { state: string; group: number } | null => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ');
    return { state: fields[0]!, group: Number(fields[2]) };
  } catch { return null; }
};

test('end-call ends the group of a dropped call whose members nobody reaps: zombies are not a living call (real run of 2026-11-22)', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-lambda-guest-scripts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const call = randomUUID();
  t.after(() => rm(callMarker(call), { force: true }));
  // The Builder's Bash program exactly as the adapter sends it: marker, fixed prelude, the command with a child of its own.
  const tool = delivered({ program: 'tool', script: toolScript(['/bin/bash', '-c', channelPrelude, 'factory-builder', 'echo started; sleep 100000 & wait', `PATH=${guestPath}`], directory, call) });
  const input = join(directory, 'stdin');
  await writeFile(input, tool.stdin);
  // The guest after the drop: the call is the leader of its own session, and its parent (PID 1 of the guest, the hook agent) never
  // waits for it. Here that parent is `cat`, which lives until this test closes its input.
  const parent = spawn('/bin/bash', ['-c', 'setsid /bin/bash -c "$1" < "$2" & exec cat > /dev/null', 'guest-init', tool.command, input], { detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const parentEnd = ended(parent, () => 'the stand-in of the guest init');
  let leader: number | undefined;
  t.after(() => { if (leader) try { process.kill(-leader, 'SIGKILL'); } catch { /* already gone */ } killTree(parent); });
  const [first] = await once(parent.stdout, 'data') as [Buffer];
  assert.equal(first.toString(), 'started\n');
  leader = Number(await readFile(callMarker(call), 'utf8'));
  const before = processState(leader);
  assert.ok(before && before.group === leader && before.state !== 'Z', `the marker names the living leader of the call's own process group: ${JSON.stringify(before)}`);

  const end = runProgram(endCallProgram(call));
  assert.deepEqual([end.status, end.stdout, end.stderr], [0, 'call-ended\n', '']);
  assert.equal(endCallOutcome(end.stdout), 'call-ended');
  // The scenario was the real one: the leader is dead and unreaped, which `kill -0` reports as alive.
  assert.equal(processState(leader)?.state, 'Z');
  assert.doesNotThrow(() => process.kill(-leader!, 0), 'a signal to the group of zombies still succeeds');
  assert.equal(existsSync(callMarker(call)), false);
  // Nothing is left to end: asked again, the call is one that is not registered.
  assert.deepEqual([runProgram(endCallProgram(call)).stdout], ['call-not-started\n']);
  parent.stdin.end();
  await parentEnd;
});

test('end-call answers for a call that never registered and refuses a marker that names no process group', async t => {
  const never = runProgram(endCallProgram(randomUUID()));
  assert.deepEqual([never.status, never.stdout], [0, 'call-not-started\n']);
  for (const content of ['', 'abc\n', '1\n', '12 34\n']) {
    const call = randomUUID();
    t.after(() => rm(callMarker(call), { force: true }));
    await writeFile(callMarker(call), content);
    assert.equal(runProgram(endCallProgram(call)).status, 6, JSON.stringify(content));
    assert.equal(existsSync(callMarker(call)), true);
  }
  assert.equal(endCallOutcome('call-alive\n'), 'call-alive');
  assert.equal(endCallOutcome('ghs_notAWordOfTheProgram\ncall-ended\n'), undefined);
});
