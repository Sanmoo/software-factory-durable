import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handoffCaptureProgram, handoffCommand, parseHandoffSummary } from '../../src/workers/handoff.js';
import { captureHandoff } from '../../src/workers/builder-handoff.js';

// The capture program is GUEST code (constant, Factory-owned, run by the Host through the Builder's own binding). This test runs the same
// constant against a TEST-OWNED local repository on the host, with the guest paths passed as arguments; it is never run on a guest tree here.
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
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const checkout = join(dir, 'workspace', 'checkout');
  const artifacts = join(dir, 'artifacts');
  await mkdir(checkout, { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(join(checkout, 'kept.txt'), 'kept\n');
  await writeFile(join(checkout, 'removed.txt'), 'bye\n');
  await writeFile(join(checkout, 'staged.txt'), 'one\n');
  await writeFile(join(checkout, 'unstaged.txt'), 'one\n');
  await writeFile(join(checkout, '.gitignore'), 'build/\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'base');
  const base = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '-b', 'factory/3-abcdef12');
  await writeFile(join(checkout, 'committed.txt'), 'new committed\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'work');
  await writeFile(join(checkout, 'staged.txt'), 'two\n');
  git(checkout, 'add', 'staged.txt');
  await writeFile(join(checkout, 'unstaged.txt'), 'two\n');
  await unlink(join(checkout, 'removed.txt'));
  await mkdir(join(checkout, 'docs'));
  await writeFile(join(checkout, 'docs', 'untracked.md'), '# new\n');
  await mkdir(join(checkout, 'build'));
  await writeFile(join(checkout, 'build', 'generated.bin'), 'ignored output');
  for (const [kind, version, complete] of [
    ['spec', 'v1', false],
    ['spec', 'v2', true],
    ['instructions', 'v1', true],
  ] as const) {
    await mkdir(join(artifacts, kind, version), { recursive: true });
    await writeFile(join(artifacts, kind, version, 'sources.json'), JSON.stringify({ version, complete }));
  }
  return { dir, checkout, artifacts, base };
}
const run = (f: { checkout: string; artifacts: string; base: string }, round = '1') =>
  execFileSync('/usr/bin/python3', ['-I', '-S', '-c', handoffCaptureProgram, f.checkout, f.artifacts, round, f.base, '/workspace/checkout', '/artifacts'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

test('AC1: the handoff index covers committed, staged, unstaged, new and removed paths with Git/base metadata, without a clean tree or candidate commit', async t => {
  const f = await fixture(t);
  const summary = JSON.parse(run(f));
  const index = JSON.parse(await readFile(join(f.artifacts, 'review', 'r1', 'index.json'), 'utf8'));
  assert.equal(summary.indexSha256, sha(await readFile(join(f.artifacts, 'review', 'r1', 'index.json'))));
  assert.deepEqual(
    [summary.round, summary.index, summary.base, summary.branch, summary.head, summary.mergeBase],
    [1, '/artifacts/review/r1/index.json', f.base, 'factory/3-abcdef12', git(f.checkout, 'rev-parse', 'HEAD'), f.base],
  );
  const byPath = Object.fromEntries(index.entries.map((entry: { path: string }) => [entry.path, entry]));
  assert.deepEqual(Object.keys(byPath).sort(), ['committed.txt', 'docs/untracked.md', 'removed.txt', 'staged.txt', 'unstaged.txt']);
  assert.equal(byPath['committed.txt'].committed, 'A');
  assert.equal(byPath['staged.txt'].staged, 'M');
  assert.equal(byPath['unstaged.txt'].unstaged, 'M');
  assert.equal(byPath['removed.txt'].unstaged, 'D');
  assert.equal(byPath['removed.txt'].present, false);
  assert.equal(byPath['docs/untracked.md'].untracked, true);
  assert.equal(byPath['docs/untracked.md'].guestPath, '/workspace/checkout/docs/untracked.md');
  assert.equal(byPath['unstaged.txt'].sha256, sha('two\n'), 'identity by content hash of the working file');
  assert.equal(byPath['build/generated.bin'], undefined, 'ignored generated output is not part of the proposal');
  assert.deepEqual(summary.counts, { entries: 5, committed: 1, staged: 1, unstaged: 2, untracked: 1, removed: 1 });
  // Preserved request/instructions versions: the latest COMPLETE version, by path and hash.
  assert.deepEqual([summary.spec.version, summary.spec.sources], ['v2', '/artifacts/spec/v2/sources.json']);
  assert.equal(summary.instructions.version, 'v1');
  for (const name of ['committed', 'staged', 'unstaged'] as const) {
    const patch = await readFile(join(f.artifacts, 'review', 'r1', `${name}.patch`));
    assert.equal(summary.patches[name].sha256, sha(patch));
    assert.equal(summary.patches[name].path, `/artifacts/review/r1/${name}.patch`);
  }
  assert.match(await readFile(join(f.artifacts, 'review', 'r1', 'staged.patch'), 'utf8'), /\+two/);
  assert.match(await readFile(join(f.artifacts, 'review', 'r1', 'committed.patch'), 'utf8'), /new committed/);
  assert.match(index.reviewerNote, /read/);
});

test('AC1: a round directory is never overwritten and invalid inputs are refused before any effect', async t => {
  const f = await fixture(t);
  run(f);
  assert.throws(() => run(f), 'second capture of the same round fails instead of overwriting');
  assert.throws(() => run(f, '../x'));
  assert.throws(() =>
    execFileSync('/usr/bin/python3', ['-I', '-S', '-c', handoffCaptureProgram, f.checkout, f.artifacts, '2', 'HEAD', '/workspace/checkout', '/artifacts'], {
      stdio: 'pipe',
    }),
  );
  const command = handoffCommand(2, f.base);
  assert.ok(command.length < 16384, 'fits the Builder Bash command bound');
  assert.match(
    command,
    /^exec \/usr\/bin\/python3 -I -S - \/workspace\/checkout \/artifacts 2 [0-9a-f]{40} \/workspace\/checkout \/artifacts <<'FACTORY_HANDOFF_EOF'\n/,
  );
  assert.throws(() => handoffCommand(0, f.base));
  assert.throws(() => handoffCommand(1, 'main'));
});

test('real-run fix 1: the capture works on a checkout git sees as owned by someone else (guest root over the FUSE uid), without system/global config', async t => {
  const f = await fixture(t);
  // Git's own test switch reproduces "dubious ownership" on the host; the system safe.directory of the guest profile is NOT read (NOSYSTEM).
  const marker = '"GIT_OPTIONAL_LOCKS": "0"}';
  assert.ok(handoffCaptureProgram.includes(marker));
  const program = handoffCaptureProgram.replace(marker, '"GIT_OPTIONAL_LOCKS": "0", "GIT_TEST_ASSUME_DIFFERENT_OWNER": "1"}');
  const summary = JSON.parse(
    execFileSync('/usr/bin/python3', ['-I', '-S', '-c', program, f.checkout, f.artifacts, '1', f.base, '/workspace/checkout', '/artifacts'], {
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );
  assert.equal(summary.counts.entries, 5);
  assert.match(handoffCaptureProgram, /"-c", "safe\.directory=" \+ checkout/, 'only the exact checkout is trusted, on the command line');
  assert.match(handoffCaptureProgram, /"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "\/dev\/null"/, 'isolation kept');
});

test('real-run fix 2: every failure writes one machine code line to stderr, and the Host surfaces it in the handoff failure', async t => {
  const f = await fixture(t);
  const failure = (args: string[]) => {
    try {
      execFileSync('/usr/bin/python3', ['-I', '-S', '-c', handoffCaptureProgram, ...args], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      return String((error as { stderr: string }).stderr);
    }
    assert.fail('expected a failure');
  };
  assert.equal(
    failure([f.checkout, f.artifacts, '1', 'f'.repeat(40), '/workspace/checkout', '/artifacts']),
    'FACTORY_HANDOFF_ERROR GIT_FAILED git-merge-base\n',
  );
  assert.equal(failure([f.checkout, f.artifacts, 'x', f.base, '/workspace/checkout', '/artifacts']), 'FACTORY_HANDOFF_ERROR INPUT_INVALID input\n');
  run(f);
  assert.equal(failure([f.checkout, f.artifacts, '1', f.base, '/workspace/checkout', '/artifacts']), 'FACTORY_HANDOFF_ERROR ROUND_EXISTS write\n');
  const context = { workId: 'w', executionId: 'e', invocationId: 'b', role: 'builder' as const, environmentRef: 'env', bootRef: 'boot', phaseId: 'p' };
  const sandbox = {
    async executeTool(_context: unknown, _call: unknown, onData?: (data: Buffer) => void | Promise<void>) {
      await onData?.(Buffer.from('FACTORY_HANDOFF_ERROR GIT_FAILED git-head\n'));
      return {
        status: 'success' as const,
        format: 'text' as const,
        reference: { workId: 'w', id: '11111111-2222-4333-8444-555555555555' },
        bytes: 41,
        encoding: 'base64' as const,
        data: '',
        nextOffset: 0,
        exitCode: 3,
      };
    },
  };
  assert.deepEqual(await captureHandoff(context, sandbox, 1, f.base, new AbortController().signal), {
    round: 1,
    status: 'failure',
    code: 'HANDOFF_CAPTURE_FAILED',
    detail: 'GIT_FAILED:git-head',
  });
});

test('ticket 21: with `preserve` the capture reports whether the authorized remote tip is an ancestor of HEAD (constant program, never the model)', async t => {
  const f = await fixture(t);
  const human = git(f.checkout, 'rev-parse', 'HEAD'); // the "remote" commit to preserve
  const capture = (round: string, preserve: string) =>
    JSON.parse(
      execFileSync(
        '/usr/bin/python3',
        ['-I', '-S', '-c', handoffCaptureProgram, f.checkout, f.artifacts, round, f.base, '/workspace/checkout', '/artifacts', 'capture', preserve],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    );
  git(f.checkout, 'stash', '-q', '-u');
  await writeFile(join(f.checkout, 'factory.txt'), 'factory on top\n');
  git(f.checkout, 'add', '.');
  git(f.checkout, 'commit', '-q', '-m', 'factory rebased on top of the human commit');
  const kept = capture('1', human);
  assert.deepEqual(kept.preserved, { commit: human, ancestor: true });
  assert.deepEqual(JSON.parse(await readFile(join(f.artifacts, 'review', 'r1', 'index.json'), 'utf8')).preserved, kept.preserved, 'the index carries it too');
  git(f.checkout, 'reset', '-q', '--hard', f.base); // the human commit dropped (rewritten history)
  await writeFile(join(f.checkout, 'factory.txt'), 'factory only\n');
  git(f.checkout, 'add', '.');
  git(f.checkout, 'commit', '-q', '-m', 'factory without the human commit');
  assert.deepEqual(capture('2', human).preserved, { commit: human, ancestor: false });
  assert.deepEqual(capture('3', '9'.repeat(40)).preserved, { commit: '9'.repeat(40), ancestor: false }, 'a commit never fetched is not preserved');
  assert.equal(JSON.parse(run(f, '4')).preserved, undefined, 'absent unless asked');
  assert.throws(
    () =>
      execFileSync(
        '/usr/bin/python3',
        ['-I', '-S', '-c', handoffCaptureProgram, f.checkout, f.artifacts, '5', f.base, '/workspace/checkout', '/artifacts', 'probe', human],
        { stdio: 'pipe' },
      ),
    /status 2|exit/i,
    'probe mode never takes a preserve argument',
  );
  assert.match(handoffCommand(1, f.base, human), new RegExp(` capture ${human} <<'FACTORY_HANDOFF_EOF'`));
  assert.throws(() => handoffCommand(1, f.base, 'not-a-commit'), /HANDOFF_INPUT_INVALID/);
  const summary = JSON.stringify(kept);
  assert.throws(() => parseHandoffSummary(summary, 1, f.base), /HANDOFF_CAPTURE_INVALID/, 'an unrequested ancestry answer is refused');
  assert.throws(() => parseHandoffSummary(summary, 1, f.base, '9'.repeat(40)), /HANDOFF_CAPTURE_INVALID/, 'an answer about another commit is refused');
  assert.deepEqual(parseHandoffSummary(summary, 1, f.base, human).preserved, { commit: human, ancestor: true });
});

test("q34-ghadv-v2/v3: a reconciliation capture writes the Builder's OWN patch (authorized tip..HEAD) and lists only its own changed files; the human file is context", async t => {
  const f = await fixture(t);
  git(f.checkout, 'stash', '-q', '-u');
  await writeFile(join(f.checkout, 'human.md'), '# human\n');
  git(f.checkout, 'add', '.');
  git(f.checkout, 'commit', '-q', '-m', 'human commit on the Factory branch');
  const human = git(f.checkout, 'rev-parse', 'HEAD');
  await writeFile(join(f.checkout, 'factory.md'), 'factory result on top of the human commit\n');
  git(f.checkout, 'add', '.');
  git(f.checkout, 'commit', '-q', '-m', 'factory rebased on top');
  await writeFile(join(f.checkout, 'notes.md'), 'untracked own work\n');
  const capture = (round: string, preserve?: string) =>
    JSON.parse(
      execFileSync(
        '/usr/bin/python3',
        [
          '-I',
          '-S',
          '-c',
          handoffCaptureProgram,
          f.checkout,
          f.artifacts,
          round,
          f.base,
          '/workspace/checkout',
          '/artifacts',
          ...(preserve ? ['capture', preserve] : []),
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    );
  const summary = capture('1', human);
  assert.ok(summary.changed.includes('/workspace/checkout/human.md'), 'the base-relative listing still shows the human file (context)');
  assert.deepEqual(
    summary.ownChanged,
    ['/workspace/checkout/committed.txt', '/workspace/checkout/factory.md', '/workspace/checkout/notes.md'].filter(path => !path.endsWith('committed.txt')),
    'only what changed on top of the authorized tip (and the working tree)',
  );
  assert.equal(summary.ownChangedTruncated, false);
  const own = await readFile(join(f.artifacts, 'review', 'r1', 'own.patch'), 'utf8');
  assert.equal(summary.patches.own.path, '/artifacts/review/r1/own.patch');
  assert.equal(summary.patches.own.sha256, sha(own));
  assert.match(own, /factory\.md/);
  assert.doesNotMatch(own, /human\.md/, 'the human commit is never part of the own patch');
  assert.deepEqual(parseHandoffSummary(JSON.stringify(summary), 1, f.base, human).patches.own, summary.patches.own);
  // Not an ancestor (the human commit dropped): no own patch is offered, the verification refuses it anyway.
  git(f.checkout, 'reset', '-q', '--hard', f.base);
  await writeFile(join(f.checkout, 'factory.md'), 'factory only\n');
  git(f.checkout, 'add', '.');
  git(f.checkout, 'commit', '-q', '-m', 'factory without the human commit');
  const dropped = capture('2', human);
  assert.deepEqual([dropped.patches.own, dropped.ownChanged], [undefined, undefined]);
  const plain = capture('3');
  assert.deepEqual([plain.patches.own, plain.ownChanged], [undefined, undefined], 'absent outside a reconciliation');
  const forged = JSON.stringify({ ...plain, ownChanged: [] });
  assert.throws(() => parseHandoffSummary(forged, 3, f.base), /HANDOFF_CAPTURE_INVALID/, 'an own listing without a preserved ancestor is refused');
});
