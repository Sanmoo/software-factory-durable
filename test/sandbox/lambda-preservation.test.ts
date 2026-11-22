import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeLambdaPreservation, preservationGateProgram } from '../../src/sandbox/lambda/preservation.js';
import type { LambdaChannel } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// v2 ticket 07 (V2-06, proof G1): the fixed preservation program, run with the LOCAL bash and git against a temporary clone standing for
// the guest's checkout and a bare repository standing for `origin`. No guest, no channel, no network: the transport is a local process.
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
async function guest(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-preservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'),
    checkout = join(root, 'checkout');
  const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: environment, timeout: remainingMs() });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, checkout);
  git(checkout, 'checkout', '--quiet', '-b', 'factory/3-0123abcd');
  await writeFile(join(checkout, '.gitignore'), 'ignored/\n*.log\n');
  await writeFile(join(checkout, 'a.txt'), 'one\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'WIP 1');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:refs/heads/factory/3-0123abcd');
  const observe = (remote = origin) =>
    observeLambdaPreservation(localChannel(), { remote, branch: 'factory/3-0123abcd', token: 'unused-locally', directory: checkout });
  return { root, origin, checkout, git, observe, head: () => git(checkout, 'rev-parse', 'HEAD') };
}

test('the preservation program reports a published clean workspace: HEAD, nothing modified, untracked or stashed, and the tip `ls-remote` answered', async t => {
  const g = await guest(t);
  // Ignored files are rebuildable by definition (V2-08): they never count.
  await writeFile(join(g.checkout, 'build.log'), 'noise\n');
  assert.deepEqual(await g.observe(), {
    status: 'observed',
    head: g.head(),
    modified: 0,
    untracked: 0,
    stashes: 0,
    remote: { state: 'present', sha: g.head() },
  });
});

test('the preservation program tells modified, untracked and stashed work apart', async t => {
  const g = await guest(t);
  await writeFile(join(g.checkout, 'new file.txt'), 'x\n');
  assert.deepEqual(await g.observe().then(result => result.status === 'observed' && [result.modified, result.untracked, result.stashes]), [0, 1, 0]);
  await writeFile(join(g.checkout, 'a.txt'), 'two\n');
  g.git(g.checkout, 'add', 'a.txt');
  assert.deepEqual(await g.observe().then(result => result.status === 'observed' && [result.modified, result.untracked, result.stashes]), [1, 1, 0]);
  g.git(g.checkout, 'stash', '--quiet', '--include-untracked');
  assert.deepEqual(await g.observe().then(result => result.status === 'observed' && [result.modified, result.untracked, result.stashes]), [0, 0, 1]);
});

test('NEGATIVE (v2 ticket 12, V2-16): a loss marker ref holding HEAD on `origin` changes nothing: the program reports the Work BRANCH tip only', async t => {
  const g = await guest(t);
  const published = g.head();
  await writeFile(join(g.checkout, 'a.txt'), 'two\n');
  g.git(g.checkout, 'commit', '--quiet', '-am', 'committed, never pushed to the branch');
  // What the terminate hook of an earlier boot would have left: the unpublished commit under the Factory's marker namespace.
  g.git(g.checkout, 'push', '--quiet', g.origin, 'HEAD:refs/factory/lost/0b0f6c0e-5d0e-4c53-9d53-0a4f6f1f3c11/boot-6f2c1a52-0d6b-4a54-8a35-3d1f0f0c9a10');
  const observed = await g.observe();
  assert.deepEqual(observed.status === 'observed' && [observed.head === published, observed.remote], [false, { state: 'present', sha: published }]);
});

test('the preservation program asks `origin` itself: an unpushed commit, a stale tracking ref, a missing branch and an unreachable remote are all visible', async t => {
  const g = await guest(t);
  const published = g.head();
  await writeFile(join(g.checkout, 'a.txt'), 'two\n');
  g.git(g.checkout, 'commit', '--quiet', '-am', 'WIP 2 (not pushed)');
  assert.deepEqual(await g.observe().then(result => result.status === 'observed' && [result.head === published, result.remote]), [
    false,
    { state: 'present', sha: published },
  ]);
  // The local tracking ref says "published" while `origin` holds another tip: only `ls-remote` counts.
  g.git(g.checkout, 'update-ref', 'refs/remotes/origin/factory/3-0123abcd', g.head());
  assert.deepEqual(await g.observe().then(result => result.status === 'observed' && result.remote), { state: 'present', sha: published });
  g.git(g.origin, 'update-ref', '-d', 'refs/heads/factory/3-0123abcd');
  assert.deepEqual(await g.observe().then(result => result.status === 'observed' && result.remote), { state: 'absent' });
  assert.deepEqual(await g.observe(join(g.root, 'nowhere.git')).then(result => result.status === 'observed' && result.remote), { state: 'unavailable' });
});

test('the preservation program carries no secret in its text, and a value the host would not place in a script yields no program', async t => {
  const request = preservationGateProgram({ remote: 'https://github.com/acme/project.git', branch: 'factory/3-0123abcd', token: 'ghs_secretvalue' })!;
  assert.equal(request.program, 'preservation-gate');
  assert.ok(!request.script.includes('ghs_secretvalue'));
  assert.deepEqual(Object.keys(request.environment ?? {}).sort(), ['FACTORY_GIT_TOKEN', 'GIT_TERMINAL_PROMPT']);
  assert.equal(preservationGateProgram({ remote: 'https://github.com/acme/project.git', branch: '--upload-pack=x', token: 't' }), null);
  assert.equal(preservationGateProgram({ remote: '-x', branch: 'factory/3-0123abcd', token: 't' }), null);
  const g = await guest(t);
  assert.deepEqual(await observeLambdaPreservation(localChannel(), { remote: g.origin, branch: 'bad..branch', token: 't', directory: g.checkout }), {
    status: 'unavailable',
    code: 'PRESERVATION_REQUEST_INVALID',
  });
  assert.deepEqual(
    await observeLambdaPreservation(localChannel(), { remote: g.origin, branch: 'factory/3-0123abcd', token: 't', directory: join(g.root, 'missing') }),
    { status: 'unavailable', code: 'PRESERVATION_OBSERVATION_FAILED' },
  );
});
