import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armLossMarker, disarmLossMarker, lossMarkerPaths } from '../../src/sandbox/lambda/loss-marker.js';
import { guestFiles } from '../../src/sandbox/lambda/guest-files.js';
import { lostMarkerRef } from '../../src/contracts/index.js';
import type { LambdaChannel } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// v2 ticket 12 (V2-16, proof G4): the loss marker, with the LOCAL bash, git and python3. A temporary clone stands for the guest's checkout,
// a bare repository for `origin`, a temporary directory for `/run/factory`; the REAL holder program and the REAL terminate handler of the
// hook agent run as local processes. No guest, no channel, no network, no port: the agent's HTTP server is never started.
const environment = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'b',
  GIT_AUTHOR_EMAIL: 'b@example.invalid',
  GIT_COMMITTER_NAME: 'b',
  GIT_COMMITTER_EMAIL: 'b@example.invalid',
  PATH: process.env.PATH ?? '',
};
const localChannel = (): LambdaChannel => ({
  async exec(request) {
    const run = spawnSync('/bin/bash', ['-c', request.script], { encoding: 'utf8', timeout: remainingMs(), env: { ...environment, ...request.environment } });
    return { status: 'exited', exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
  },
  close() {},
});
const workId = '0b0f6c0e-5d0e-4c53-9d53-0a4f6f1f3c11',
  boot = 'boot-6f2c1a52-0d6b-4a54-8a35-3d1f0f0c9a10';
const ref = lostMarkerRef(workId, boot)!;

async function guest(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-marker-'));
  const origin = join(root, 'origin.git'),
    checkout = join(root, 'checkout');
  const paths = { fifo: join(root, 'run', 'terminate'), state: join(root, 'run', 'marker') };
  const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: environment, timeout: remainingMs() });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  // What the start script does in the guest: the trigger only root writes, and the state directory of the `builder` user.
  await mkdir(paths.state, { recursive: true });
  assert.equal(spawnSync('mkfifo', ['-m', '0644', paths.fifo]).status, 0);
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, checkout);
  git(checkout, 'checkout', '--quiet', '-b', 'factory/3-0123abcd');
  await writeFile(join(checkout, 'a.txt'), 'one\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'published');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:refs/heads/factory/3-0123abcd');
  const channel = localChannel();
  const arm = (remote = origin) => armLossMarker(channel, { remote, ref, token: 'unused-locally', directory: checkout, paths });
  t.after(async () => {
    await disarmLossMarker(channel, paths);
    await rm(root, { recursive: true, force: true });
  });
  /** The hook agent's own terminate handler (the file's text up to the HTTP server), with the guest paths replaced by the temporary ones. */
  const terminate = (waitSeconds = 20) => {
    const source = guestFiles['hook-agent.py'].split('\nclass Hooks')[0]!;
    const run = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-c',
        `${source}\nTERMINATE_FIFO = ${JSON.stringify(paths.fifo)}\nMARKER_DONE = ${JSON.stringify(join(paths.state, 'done'))}\nMARKER_READY = ${JSON.stringify(join(paths.state, 'ready'))}\nprint(on_terminate(${waitSeconds}))`,
      ],
      { encoding: 'utf8', timeout: remainingMs() },
    );
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const marker = () => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: origin, encoding: 'utf8', env: environment }).stdout.trim() || null;
  return {
    root,
    origin,
    checkout,
    paths,
    git,
    arm,
    terminate,
    marker,
    channel,
    head: () => git(checkout, 'rev-parse', 'HEAD'),
    branch: () => git(origin, 'rev-parse', 'refs/heads/factory/3-0123abcd'),
  };
}

test('the marker ref names the Work and the boot, and nothing that is not both is ever a marker ref', () => {
  assert.equal(ref, 'refs/factory/lost/0b0f6c0e-5d0e-4c53-9d53-0a4f6f1f3c11/boot-6f2c1a52-0d6b-4a54-8a35-3d1f0f0c9a10');
  assert.equal(lostMarkerRef('../heads/main', boot), null);
  assert.equal(lostMarkerRef(workId, 'main'), null);
});

test('the terminate hook pushes the committed HEAD to the marker ref and leaves the Work branch where it was', async t => {
  const g = await guest(t);
  const published = g.head();
  await writeFile(join(g.checkout, 'a.txt'), 'two\n');
  g.git(g.checkout, 'commit', '--quiet', '-am', 'committed, never pushed');
  // Limit (V2-16): what was not committed is not in the marker.
  await writeFile(join(g.checkout, 'uncommitted.txt'), 'lost\n');
  assert.deepEqual(await g.arm(), { status: 'armed' });
  assert.equal(g.terminate(), 'done');
  assert.equal(g.marker(), g.head());
  assert.notEqual(g.marker(), published);
  assert.equal(g.branch(), published);
  assert.equal(g.git(g.origin, 'ls-tree', '--name-only', '-r', ref), 'a.txt');
  assert.equal((await readFile(join(g.paths.state, 'done'), 'utf8')).trim(), 'push=0');
});

test('the terminate hook takes nothing from its caller: without an armed holder it does nothing, and an unreachable remote is not an error', async t => {
  const g = await guest(t);
  assert.equal(g.terminate(), 'unarmed');
  assert.equal(g.marker(), null);
  assert.deepEqual(await g.arm(join(g.root, 'no-such-remote.git')), { status: 'armed' });
  assert.equal(g.terminate(), 'done');
  assert.equal(g.marker(), null);
  assert.match(await readFile(join(g.paths.state, 'done'), 'utf8'), /^push=[1-9]/);
});

test('a disarmed holder pushes nothing, and arming again replaces the holder instead of adding one', async t => {
  const g = await guest(t);
  assert.deepEqual(await g.arm(), { status: 'armed' });
  assert.deepEqual(await disarmLossMarker(g.channel, g.paths), { status: 'disarmed' });
  assert.equal(g.terminate(), 'unarmed');
  assert.equal(g.marker(), null);
  assert.deepEqual(await g.arm(join(g.root, 'no-such-remote.git')), { status: 'armed' });
  assert.deepEqual(await g.arm(), { status: 'armed' });
  assert.equal(g.terminate(), 'done');
  // Only the latest holder answered: the earlier one (unreachable remote) was ended, so the push that ran is the good one.
  assert.equal(g.marker(), g.head());
});

test('the holder program carries the credential in the process environment only and refuses values the host does not place in a script', async () => {
  const seen: { script: string; environment: Record<string, string> }[] = [];
  const channel: LambdaChannel = {
    async exec(request) {
      seen.push({ script: request.script, environment: { ...request.environment } });
      return { status: 'exited', exitCode: 0, stdout: 'MARKER armed\n', stderr: '' };
    },
    close() {},
  };
  assert.deepEqual(await armLossMarker(channel, { remote: 'https://github.com/o/r.git', ref, token: 'ghs_secret-value' }), { status: 'armed' });
  assert.equal(seen[0]!.environment.FACTORY_GIT_TOKEN, 'ghs_secret-value');
  assert.ok(!seen[0]!.script.includes('ghs_secret-value'));
  assert.ok(seen[0]!.script.includes(lossMarkerPaths.fifo) && seen[0]!.script.includes(ref));
  assert.deepEqual(await armLossMarker(channel, { remote: 'https://github.com/o/r.git', ref: 'refs/heads/main', token: 't' }), {
    status: 'unavailable',
    code: 'LOSS_MARKER_REQUEST_INVALID',
  });
  assert.deepEqual(await armLossMarker(channel, { remote: '--upload-pack=x', ref, token: 't' }), {
    status: 'unavailable',
    code: 'LOSS_MARKER_REQUEST_INVALID',
  });
  assert.equal(seen.length, 1);
});
