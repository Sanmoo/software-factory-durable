import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInvestigationClones } from '../../src/sandbox/index.js';

// The copy of a candidate repository a Triager asks for. Real git over a local file:// upstream; GitHub and
// its credential are doubles. Proves what the Host creates, not the read-only mount (test/sandbox/investigation-environment.test.ts).
const canary = 'ghs_' + 'TR30cloneCANARY';
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

async function world(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-triage-clone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = join(dir, 'upstream');
  await mkdir(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'README.md'), 'first\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', 'first');
  await writeFile(join(upstream, 'README.md'), 'second\n');
  git(upstream, 'commit', '-q', '-am', 'second');
  git(upstream, 'branch', 'feature');
  const root = join(dir, 'root');
  const directory = join(dir, 'attempt', 'clones');
  await mkdir(root, { mode: 0o700 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const issued: string[] = [];
  const revoked: string[] = [];
  const clones = createInvestigationClones({
    root,
    fetch: {
      async fetch(scope) {
        issued.push(scope.repository);
        return { token: canary };
      },
      async revoke({ token }) {
        revoked.push(token);
        return { kind: 'revoked' };
      },
    } as Parameters<typeof createInvestigationClones>[0]['fetch'],
    remoteUrl: () => `file://${upstream}`,
  });
  return { dir, upstream, root, directory, clones, issued, revoked };
}
const request = (directory: string, name = 'acme__project') => ({
  directory,
  name,
  repository: 'acme/project',
  repositoryId: 7,
  installationId: 2,
  base: 'main',
});

test('a requested clone is the default branch with its history, fetched through the bare cache, with no remote and no credential', async t => {
  const w = await world(t);
  const result = await w.clones.create(request(w.directory));
  const head = git(w.upstream, 'rev-parse', 'main');
  assert.deepEqual(result, { status: 'success', path: join(w.directory, 'acme__project'), commit: head });
  const clone = join(w.directory, 'acme__project');
  assert.equal(await readFile(join(clone, 'README.md'), 'utf8'), 'second\n', 'the branch is checked out');
  assert.equal(git(clone, 'log', '--format=%s'), 'second\nfirst', 'with its history');
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(clone, 'remote'), '', 'no remote at all');
  assert.equal(git(clone, 'branch', '--all', '--format=%(refname)'), 'refs/heads/main', 'only the default branch');
  await assert.rejects(access(join(clone, '.git', 'objects', 'info', 'alternates')), 'independent of the cache');
  await access(join(w.root, 'cache', 'git', '7.git', 'HEAD'));
  assert.deepEqual([w.issued, w.revoked], [['acme/project'], [canary]], 'one read credential, used by the fetch on the Host and revoked');
  for (const file of await readdir(clone, { recursive: true })) {
    const text = await readFile(join(clone, file)).catch(() => Buffer.alloc(0));
    assert.ok(!text.includes(canary), `${file} carries the credential`);
  }
});

test('a second attempt gets its own copy from the same cache; a name already taken or an invalid request is refused', async t => {
  const w = await world(t);
  assert.equal((await w.clones.create(request(w.directory))).status, 'success');
  assert.deepEqual(await w.clones.create(request(w.directory)), { status: 'failure', code: 'INVESTIGATION_CLONE_EXISTS' });
  const other = join(w.dir, 'attempt-2');
  await mkdir(other);
  await writeFile(join(w.upstream, 'NEW.md'), 'third\n');
  git(w.upstream, 'add', '.');
  git(w.upstream, 'commit', '-q', '-m', 'third');
  const second = await w.clones.create(request(other));
  assert.equal(second.status === 'success' && second.commit, git(w.upstream, 'rev-parse', 'main'), 'each clone fetches the current default branch');
  assert.deepEqual(await w.clones.create(request(other, '../escape')), { status: 'failure', code: 'CHECKOUT_REQUEST_INVALID' });
  assert.deepEqual(await w.clones.create({ ...request(other, 'x'), repository: 'acme/../etc' }), { status: 'failure', code: 'CHECKOUT_REQUEST_INVALID' });
});
