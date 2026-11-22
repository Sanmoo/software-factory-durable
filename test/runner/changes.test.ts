import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedSet } from '../../scripts/test-runner/changes.ts';

function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-changes-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', message); };
  git('init', '-q', '-b', 'main');
  return { dir, git, commit, write: (file: string, text = 'x') => writeFileSync(join(dir, file), text), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a branch compares against its merge base and includes the working tree, untracked and deleted files', t => {
  const repo = repository();
  t.after(repo.cleanup);
  repo.write('a.ts'); repo.write('gone.ts'); repo.commit('base');
  repo.git('switch', '-q', '-c', 'change');
  repo.write('b.ts'); repo.commit('committed change');
  repo.write('a.ts', 'edited'); repo.write('new.ts'); rmSync(join(repo.dir, 'gone.ts'));
  const change = changedSet(repo.dir, 'main');
  assert.deepEqual(change.files, ['a.ts', 'b.ts', 'gone.ts', 'new.ts']);
  assert.deepEqual(change.deleted, ['gone.ts']);
});

test('on the base tip the change is what landed with the tip commit', t => {
  const repo = repository();
  t.after(repo.cleanup);
  repo.write('a.ts'); repo.commit('one');
  repo.write('b.ts'); repo.commit('two');
  assert.deepEqual(changedSet(repo.dir, 'main').files, ['b.ts']);
});

test('an unknown base, a root commit on the base tip, or unrelated history widen instead of reading as no change', t => {
  const repo = repository();
  t.after(repo.cleanup);
  repo.write('a.ts'); repo.commit('root');
  assert.match(changedSet(repo.dir, 'nope').widened ?? '', /base nope does not resolve/);
  assert.match(changedSet(repo.dir, 'main').widened ?? '', /no earlier commit/);
  repo.git('switch', '-q', '--orphan', 'other'); repo.write('z.ts'); repo.commit('unrelated');
  assert.match(changedSet(repo.dir, 'main').widened ?? '', /shares no history/);
});

test('a new branch still at the base tip measures its working tree, not the tip commit; detached at the tip measures the tip', t => {
  const repo = repository();
  t.after(repo.cleanup);
  repo.write('a.ts'); repo.commit('one');
  repo.write('b.ts'); repo.commit('two');
  repo.git('switch', '-q', '-c', 'change');
  repo.write('c.ts');
  const change = changedSet(repo.dir, 'main');
  assert.equal(change.widened, undefined);
  assert.deepEqual(change.files, ['c.ts']);
  rmSync(join(repo.dir, 'c.ts'));
  repo.git('switch', '-q', '--detach', 'main');
  assert.deepEqual(changedSet(repo.dir, 'main').files, ['b.ts']);
});
