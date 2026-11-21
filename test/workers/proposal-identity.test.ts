import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSandbox } from '../../src/sandbox/index.js';
import { handoffCaptureProgram } from '../../src/workers/handoff.js';

// Host-side identity over a TEST-OWNED environment (local repository), produced by the same constant capture program the guest runs.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x',
    },
  }).trim();
const environment = `env-${'1'.repeat(64)}` as never;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'environments', environment);
  const checkout = join(directory, 'workspace', 'checkout');
  await mkdir(checkout, { recursive: true });
  await mkdir(join(directory, 'artifacts'));
  git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(join(checkout, 'a.txt'), 'a\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'base');
  const base = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '-b', 'factory/3-abcdef12');
  await writeFile(join(checkout, 'a.txt'), 'changed\n');
  await writeFile(join(checkout, 'b.txt'), 'new\n');
  execFileSync(
    '/usr/bin/python3',
    ['-I', '-S', '-c', handoffCaptureProgram, checkout, join(directory, 'artifacts'), '1', base, '/workspace/checkout', '/artifacts'],
    { stdio: 'pipe' },
  );
  await writeFile(join(root, 'host-secret'), 'PRIVATE KEY CANARY');
  return { root, checkout, sandbox: createSandbox({ root }) };
}

test('AC7: equal host identities mean no observed change; content or staging changes during review invalidate it', async t => {
  const f = await fixture(t);
  const first = await f.sandbox.observeProposal({ environment, round: 1 });
  assert.ok(first.status === 'observed');
  assert.deepEqual([first.entries, first.consistent], [2, true]);
  const again = await f.sandbox.observeProposal({ environment, round: 1 });
  assert.ok(again.status === 'observed' && again.sha256 === first.sha256);
  await writeFile(join(f.checkout, 'c.txt'), 'unindexed');
  const unindexed = await f.sandbox.observeProposal({ environment, round: 1 });
  assert.ok(
    unindexed.status === 'observed' && unindexed.sha256 === first.sha256,
    'documented limit: an unindexed new file is not observed (no freeze promised)',
  );
  await writeFile(join(f.checkout, 'b.txt'), 'edited during review\n');
  const edited = await f.sandbox.observeProposal({ environment, round: 1 });
  assert.ok(edited.status === 'observed' && edited.sha256 !== first.sha256 && !edited.consistent);
  await writeFile(join(f.checkout, 'b.txt'), 'new\n');
  git(f.checkout, 'add', 'a.txt');
  const staged = await f.sandbox.observeProposal({ environment, round: 1 });
  assert.ok(staged.status === 'observed' && staged.sha256 !== first.sha256, 'staging changes the Git index identity');
});

test('AC4/AC7: identity never follows a guest link to host files nor runs git; a missing round is unavailable', async t => {
  const f = await fixture(t);
  await unlink(join(f.checkout, 'b.txt'));
  await symlink(join(f.root, 'host-secret'), join(f.checkout, 'b.txt'));
  const linked = await f.sandbox.observeProposal({ environment, round: 1 });
  assert.ok(linked.status === 'observed' && !linked.consistent);
  assert.doesNotMatch(JSON.stringify(linked), /CANARY/);
  assert.deepEqual(await f.sandbox.observeProposal({ environment, round: 2 }), { status: 'unavailable', code: 'PROPOSAL_INDEX_MISSING' });
  assert.deepEqual(await f.sandbox.observeProposal({ environment: 'env-../x' as never, round: 1 }), { status: 'refused', code: 'ENVIRONMENT_REF_INVALID' });
});
