import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectEnvironment, needsStop } from './builder09-qualification.js';
import type { ExecutionView } from '../../src/control/index.js';

// Recipe safety on temporary fixtures only (never the real root): host inspection of a guest-written environment and the stop decision.
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

test('review 1/2: recipe inspect never runs git in the guest tree and never follows a guest symlink into host secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q09-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const environment = join(dir, 'env');
  const checkout = join(environment, 'workspace', 'checkout');
  await mkdir(checkout, { recursive: true });
  git(checkout, 'init', '-q', '-b', 'factory/3-x');
  await writeFile(join(checkout, 'f.txt'), 'x\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'c1');
  const base = git(checkout, 'rev-parse', 'HEAD');
  await writeFile(
    join(checkout, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch ${join(dir, 'RAN')}\n[log]\n\tshowSignature = true\n[gpg]\n\tprogram = touch ${join(dir, 'RAN')}\n`,
  );
  await writeFile(join(dir, 'app.pem'), 'PRIVATE KEY CANARY');
  await mkdir(join(environment, 'artifacts', 'spec', 'v1'), { recursive: true });
  await symlink(join(dir, 'app.pem'), join(environment, 'artifacts', 'spec', 'v1', 'sources.json'));
  await writeFile(join(environment, 'checkout.json'), JSON.stringify({ baseCommit: base }));
  const scratch = join(dir, 'scratch');
  await mkdir(scratch, { mode: 0o700 });
  const result = await inspectEnvironment(environment, scratch, base);
  await assert.rejects(access(join(dir, 'RAN')), 'no host code execution');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY CANARY/);
  assert.equal((result.specSources as { error?: string }).error, 'CONFINED_PATH_UNSAFE');
  assert.equal((result.git as { status: string }).status, 'observed');
  assert.ok((result.artifacts as string[]).includes('spec/v1/sources.json (symlink, not followed)'));
});

test('review 6: stop-environment covers every own-boot state that may still run, and nothing else', () => {
  const execution = (state: ExecutionView['state'], boot: string | null, cessation?: 'confirmed' | 'unconfirmed') =>
    ({ state, dispatch: { boot }, end: cessation ? { cessation } : null }) as unknown as ExecutionView;
  for (const state of ['reserved', 'started', 'held'] as const) assert.equal(needsStop(execution(state, 'boot-1')), true, state);
  assert.equal(needsStop(execution('ended', 'boot-1', 'unconfirmed')), true, 'ended with unconfirmed cessation');
  assert.equal(needsStop(execution('ended', 'boot-1', 'confirmed')), false);
  assert.equal(needsStop(execution('released', 'boot-1')), false);
  assert.equal(needsStop(execution('reserved', null)), false, 'no own boot recorded');
});
