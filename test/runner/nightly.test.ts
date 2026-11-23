import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ended } from './budget.ts';

const nightly = resolve('scripts/test-runner/nightly');
// Run from the pre-commit hook, the inherited environment carries GIT_DIR/GIT_INDEX_FILE of this checkout: never pass them on.
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

// A stand-in for the runner, committed in the fixture: it records which tree it ran on and passes (STUB_NO_REPORT: writes nothing).
const stubRunner = `#!/bin/sh
set -eu
[ "$1" = full ] && [ "$2" = --report ] || exit 64
[ -z "\${STUB_NO_REPORT:-}" ] || exit 0
printf 'RESULT: PASS (stub run of %s)\\n' "$(git rev-parse HEAD)" > "$3"
`;

/**
 * An `origin` repository, the operator's main checkout cloned from it, and a second clone that integrates by
 * pushing, as a merged pull request does. Local `main` of the main checkout never moves by itself.
 */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-nightly-'));
  const origin = join(dir, 'origin.git');
  const checkout = join(dir, 'checkout');
  const upstream = join(dir, 'upstream');
  const bin = join(dir, 'bin');
  const reports = join(dir, 'state/software-factory/nightly-tests');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: environment,
    }).trim();
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, upstream);
  mkdirSync(join(upstream, 'scripts/test-runner'), { recursive: true });
  writeFileSync(join(upstream, 'scripts/test-runner/run'), stubRunner);
  chmodSync(join(upstream, 'scripts/test-runner/run'), 0o755);
  writeFileSync(join(upstream, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(upstream, '.gitignore'), 'node_modules/\n');
  const integrate = (file: string, text: string) => {
    writeFileSync(join(upstream, file), text);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', `change ${file}`);
    git(upstream, 'push', '-q', 'origin', 'HEAD:main');
    return git(upstream, 'rev-parse', 'HEAD');
  };
  integrate('a.txt', 'one');
  git(dir, 'clone', '-q', origin, checkout);
  // npm stand-in: records each install in the worktree it ran in; NPM_FAIL makes it fail.
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh\n[ -z "\${NPM_FAIL:-}" ] || { echo "npm ERR! stub failure" >&2; exit 1; }\nmkdir -p node_modules\necho "$*" >> "${dir}/npm.calls"\n`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const run = async (env: Record<string, string> = {}) => {
    const child = spawn(nightly, [], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, ...env, SF_NIGHTLY_REPO: checkout, XDG_STATE_HOME: join(dir, 'state'), PATH: `${bin}:${process.env.PATH}` },
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const exit = await ended(child, () => output);
    const last = existsSync(reports)
      ? readdirSync(reports)
          .filter(name => name.endsWith('.txt'))
          .sort()
          .at(-1)
      : undefined;
    return { code: exit.code, output, report: last ? readFileSync(join(reports, last), 'utf8') : '' };
  };
  return {
    dir,
    checkout,
    git,
    integrate,
    run,
    worktreeHead: () => git(join(checkout, '.worktrees/nightly-full'), 'rev-parse', 'HEAD'),
    installs: () => (existsSync(join(dir, 'npm.calls')) ? readFileSync(join(dir, 'npm.calls'), 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('with local main behind origin/main, the nightly validates the integrated commit and names it in the report', async t => {
  const w = world();
  t.after(w.cleanup);
  const integrated = w.integrate('b.txt', 'merged by pull request');
  assert.notEqual(w.git(w.checkout, 'rev-parse', 'main'), integrated, 'local main is behind');
  const { code, output, report } = await w.run();
  assert.equal(code, 0, output);
  assert.equal(w.worktreeHead(), integrated);
  assert.match(report, new RegExp(`validated commit: ${integrated} \\(origin/main\\)`));
  assert.match(report, /local main is 1 commit\(s\) behind origin\/main/);
  assert.match(report, new RegExp(`RESULT: PASS \\(stub run of ${integrated}\\)`));
});

test('a failed fetch is a red report naming the environment failure, and the old tree is not validated', async t => {
  const w = world();
  t.after(w.cleanup);
  w.git(w.checkout, 'remote', 'set-url', 'origin', join(w.dir, 'missing.git'));
  const { code, report } = await w.run();
  assert.equal(code, 1);
  assert.match(report, /^NIGHTLY_FETCH_FAILED: git fetch origin main failed/);
  assert.match(report, /RESULT: FAIL/);
  assert.doesNotMatch(report, /stub run/);
  assert.equal(existsSync(join(w.checkout, '.worktrees/nightly-full')), false);
});

test('a failed fetch after an earlier run leaves the older worktree where it was, unvalidated', async t => {
  const w = world();
  t.after(w.cleanup);
  assert.equal((await w.run()).code, 0);
  const earlier = w.worktreeHead();
  w.integrate('b.txt', 'merged after the earlier run');
  w.git(w.checkout, 'remote', 'set-url', 'origin', join(w.dir, 'missing.git'));
  const { code, report } = await w.run();
  assert.equal(code, 1);
  assert.match(report, /^NIGHTLY_FETCH_FAILED/);
  assert.doesNotMatch(report, /stub run/);
  assert.equal(w.worktreeHead(), earlier);
});

test('a runner that ends without a report is a red report and a failed run', async t => {
  const w = world();
  t.after(w.cleanup);
  const { code, report } = await w.run({ STUB_NO_REPORT: '1' });
  assert.match(report, /RESULT: FAIL \(the runner wrote no report/);
  assert.equal(code, 1);
});

test('the nightly worktree runs npm ci when package-lock.json changed since the last install, and only then', async t => {
  const w = world();
  t.after(w.cleanup);
  assert.equal((await w.run()).code, 0);
  assert.deepEqual(w.installs(), ['ci'], 'a fresh worktree is installed');
  w.integrate('b.txt', 'no dependency change');
  assert.equal((await w.run()).code, 0);
  assert.deepEqual(w.installs(), ['ci'], 'same lockfile: no install');
  w.integrate('package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  assert.equal((await w.run()).code, 0);
  assert.deepEqual(w.installs(), ['ci', 'ci'], 'changed lockfile: installed again');
});

test('a failed npm ci is a red report naming the environment failure, retried on the next run', async t => {
  const w = world();
  t.after(w.cleanup);
  const failed = await w.run({ NPM_FAIL: '1' });
  assert.equal(failed.code, 1);
  assert.match(failed.report, /^NIGHTLY_INSTALL_FAILED: npm ci failed in /);
  assert.doesNotMatch(failed.report, /stub run/);
  assert.equal((await w.run()).code, 0);
  assert.deepEqual(w.installs(), ['ci'], 'the next run installs again');
});

test('a nightly worktree with local changes is a red report and is not moved', async t => {
  const w = world();
  t.after(w.cleanup);
  assert.equal((await w.run()).code, 0);
  const earlier = w.worktreeHead();
  writeFileSync(join(w.checkout, '.worktrees/nightly-full/a.txt'), 'edited by hand');
  w.integrate('b.txt', 'merged');
  const { code, report } = await w.run();
  assert.equal(code, 1);
  assert.match(report, /^NIGHTLY_WORKTREE_DIRTY/);
  assert.equal(w.worktreeHead(), earlier);
});
