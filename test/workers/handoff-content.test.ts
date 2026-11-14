import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handoffCaptureProgram, parseHandoffSummary } from '../../src/workers/handoff.js';

// Level H: the constant GUEST capture program run against a TEST-OWNED local repository (never a guest tree). Ticket 13: the capture
// carries a content identity independent of Git metadata (`content.sha256`), whether the tree is clean, and whether the HEAD commit
// contains exactly that content (`content.headMatches`, from the blobs of HEAD), so an identical commit can be demonstrated, not declared.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x' } }).trim();

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'handoff13-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const checkout = join(dir, 'checkout');
  const artifacts = join(dir, 'artifacts');
  await mkdir(checkout, { recursive: true });
  await mkdir(artifacts);
  git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(join(checkout, 'kept.txt'), 'kept\n');
  await writeFile(join(checkout, 'removed.txt'), 'bye\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'base');
  const base = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '-b', 'factory/3-abcdef12');
  await mkdir(join(checkout, 'docs'));
  await writeFile(join(checkout, 'docs', 'smoke.md'), '# Smoke\n');
  await writeFile(join(checkout, 'kept.txt'), 'kept and changed\n');
  git(checkout, 'rm', '-q', 'removed.txt');
  return { checkout, artifacts, base };
}
const capture = (f: { checkout: string; artifacts: string; base: string }, round: number) => {
  const stdout = execFileSync('/usr/bin/python3', ['-I', '-S', '-c', handoffCaptureProgram, f.checkout, f.artifacts, String(round), f.base, '/workspace/checkout', '/artifacts'],
    { encoding: 'utf8', stdio: 'pipe' });
  return parseHandoffSummary(stdout, round, f.base);
};

test('AC5: committing exactly the reviewed content keeps the content identity, cleans the tree and proves HEAD holds that content', async t => {
  const f = await fixture(t);
  const reviewed = capture(f, 1);
  assert.ok(reviewed.content, 'the capture reports its content identity');
  assert.match(reviewed.content.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([reviewed.content.clean, reviewed.content.headMatches], [false, false], 'uncommitted proposal: not clean, HEAD does not hold it');
  git(f.checkout, 'add', '-A'); git(f.checkout, 'commit', '-q', '-m', 'docs: smoke');
  const committed = capture(f, 2);
  assert.notEqual(committed.head, reviewed.head, 'a new commit');
  assert.equal(committed.content!.sha256, reviewed.content.sha256, 'same content: the identity ignores Git metadata (index, HEAD, refs)');
  assert.deepEqual([committed.content!.clean, committed.content!.headMatches], [true, true]);
  const index = JSON.parse(await readFile(join(f.artifacts, 'review', 'r2', 'index.json'), 'utf8')) as { entries: { path: string; sha256?: string; headSha256: string | null }[] };
  const byPath = Object.fromEntries(index.entries.map(entry => [entry.path, entry]));
  assert.equal(byPath['docs/smoke.md']!.headSha256, byPath['docs/smoke.md']!.sha256, 'the blob of HEAD is hashed by content, like the working file');
  assert.equal(byPath['removed.txt']!.headSha256, null, 'removed: absent from HEAD');
});

test('AC4/AC5: any content change after the reviewed capture changes the identity; a commit with other content than the tree is not a match', async t => {
  const f = await fixture(t);
  const reviewed = capture(f, 1);
  git(f.checkout, 'add', '-A'); git(f.checkout, 'commit', '-q', '-m', 'docs: smoke');
  await writeFile(join(f.checkout, 'docs', 'smoke.md'), '# Smoke\n\nMore.\n');
  const changed = capture(f, 2);
  assert.notEqual(changed.content!.sha256, reviewed.content!.sha256);
  assert.deepEqual([changed.content!.clean, changed.content!.headMatches], [false, false]);
  // Revert the tree to the reviewed content but leave the extra change STAGED: tree and HEAD match, yet the index differs (not clean).
  git(f.checkout, 'add', '-A'); await writeFile(join(f.checkout, 'docs', 'smoke.md'), '# Smoke\n');
  const staged = capture(f, 3);
  assert.equal(staged.content!.sha256, reviewed.content!.sha256);
  assert.deepEqual([staged.content!.clean, staged.content!.headMatches], [false, true], 'not clean: an exemption needs both');
  // A new untracked file is part of the proposal identity.
  git(f.checkout, 'add', '-A'); git(f.checkout, 'commit', '-q', '--allow-empty', '-m', 'restore');
  await writeFile(join(f.checkout, 'docs', 'extra.md'), 'x\n');
  assert.notEqual(capture(f, 4).content!.sha256, reviewed.content!.sha256);
});
