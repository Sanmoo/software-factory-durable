import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileInterruptedCaches } from '../../src/sandbox/index.js';

// Ticket 26 review MED4: repair-free reconciliation of host Git caches left in preparation; real git/flock on temporary private trees.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x' } }).trim();
async function world(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'factory-cache-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheRoot = join(root, 'cache', 'git');
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const source = join(root, 'source');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  await writeFile(join(source, 'a.txt'), 'a\n');
  git(source, 'add', '.'); git(source, 'commit', '-q', '-m', 'one');
  git(root, 'clone', '-q', '--bare', source, join(cacheRoot, '3.git'));
  const state = (id: number, value: Record<string, unknown>) => writeFile(join(cacheRoot, `${id}.state.json`), JSON.stringify({ version: 1, ...value }), { mode: 0o600 });
  return { root, cacheRoot, state };
}

test('a cache left mutating under the git-lock discipline, with no git still running and a verified bare cache, becomes idle again', async t => {
  const w = await world(t);
  await w.state(3, { state: 'mutating', lock: 'git-flock-v1' });
  await w.state(4, { state: 'idle' });
  assert.deepEqual(await reconcileInterruptedCaches(w.root), [{ repositoryId: 3, outcome: 'reconciled', code: null, nextStep: null }]);
  const after = JSON.parse(await readFile(join(w.cacheRoot, '3.state.json'), 'utf8'));
  assert.deepEqual([after.state, after.reconciled], ['idle', { previous: 'mutating', cache: 'connectivity-verified' }]);
});

test('kept blocked with an explicit operator action: git of the dead owner still holds the lock, legacy mutation without lock, corrupt cache', async t => {
  const w = await world(t);
  await w.state(3, { state: 'mutating', lock: 'git-flock-v1' });
  const holder = spawn('/usr/bin/flock', ['--exclusive', join(w.cacheRoot, '3.git.lock'), '/bin/sh', '-c', 'echo held; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise(resolve => holder.stdout!.once('data', resolve));
  const [busy] = await reconcileInterruptedCaches(w.root);
  holder.stdin!.end();
  await new Promise(resolve => holder.once('exit', resolve));
  assert.deepEqual([busy!.outcome, busy!.code], ['kept', 'CACHE_GIT_STILL_RUNNING']);
  assert.match(busy!.nextStep!, /never repairs or deletes it by itself/);
  assert.equal(JSON.parse(await readFile(join(w.cacheRoot, '3.state.json'), 'utf8')).state, 'mutating');
  await w.state(5, { state: 'mutating' });
  await mkdir(join(w.cacheRoot, '6.git'), { mode: 0o700 });
  await writeFile(join(w.cacheRoot, '6.git', 'HEAD'), 'garbage');
  await w.state(6, { state: 'mutating', lock: 'git-flock-v1' });
  const results = await reconcileInterruptedCaches(w.root);
  assert.deepEqual(results.map(item => [item.repositoryId, item.outcome, item.code]),
    [[3, 'reconciled', null], [5, 'kept', 'CACHE_PREPARATION_WITHOUT_GIT_LOCK'], [6, 'kept', 'CACHE_INTEGRITY_UNVERIFIED']]);
});
