import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectCheckout, readConfined } from '../../src/sandbox/index.js';

// Real git; the "guest-written" checkout is a local fixture whose .git/config and attributes are hostile. Host must never execute them.
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

async function hostileEnvironment(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const environment = join(dir, 'env');
  const checkout = join(environment, 'workspace', 'checkout');
  await mkdir(checkout, { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(join(checkout, 'a.txt'), 'one\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'base');
  const base = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '-b', 'factory/3-abcdef12');
  await writeFile(join(checkout, 'a.txt'), 'two\n');
  await writeFile(join(checkout, 'b.txt'), 'new\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'builder change');
  const canary = (name: string) => `touch ${join(dir, name)}`;
  // Hostile repository-local configuration and attributes, as a guest could write them.
  await writeFile(
    join(checkout, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = ${canary('FSMONITOR')}\n\tpager = ${canary('PAGER')}\n` +
      `[diff "x"]\n\ttextconv = ${canary('TEXTCONV')}\n\tcommand = ${canary('EXTDIFF')}\n[filter "f"]\n\tclean = ${canary('CLEAN')}\n\tsmudge = ${canary('SMUDGE')}\n` +
      `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${canary('GPG')}\n[remote "origin"]\n\turl = https://github.com/acme/project.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  await writeFile(join(checkout, '.git', 'info', 'attributes'), '* diff=x filter=f\n').catch(async () => {
    await mkdir(join(checkout, '.git', 'info'), { recursive: true });
    await writeFile(join(checkout, '.git', 'info', 'attributes'), '* diff=x filter=f\n');
  });
  await writeFile(join(checkout, '.gitattributes'), '* diff=x filter=f\n');
  // Host secret the guest tries to exfiltrate through symlinks.
  await writeFile(join(dir, 'app.pem'), 'PRIVATE KEY CANARY');
  return { dir, environment, checkout, base, canaries: ['FSMONITOR', 'PAGER', 'TEXTCONV', 'EXTDIFF', 'CLEAN', 'SMUDGE', 'GPG'].map(name => join(dir, name)) };
}

test('review 1: the checkout is inspected through a Factory-owned bare copy of its objects; no repo-local config/attributes ever execute on the host', async t => {
  const h = await hostileEnvironment(t);
  const scratch = join(h.dir, 'scratch');
  await mkdir(scratch, { mode: 0o700 });
  const result = await inspectCheckout(h.environment, { scratch, base: h.base });
  assert.equal(result.status, 'observed', JSON.stringify(result));
  if (result.status !== 'observed') return;
  assert.equal(result.branch, 'factory/3-abcdef12');
  assert.deepEqual(
    result.commits.map(line => line.replace(/^[0-9a-f]+ /, '')),
    ['builder change', 'base'],
  );
  assert.match(result.diffStat, /a\.txt[\s\S]*b\.txt[\s\S]*2 files changed/);
  assert.deepEqual(result.remotes, [{ name: 'origin', url: 'https://github.com/acme/project.git' }]);
  assert.equal(result.alternates, false);
  for (const canary of h.canaries) await assert.rejects(access(canary), `${canary} never executed`);
});

test('review 1: a symlinked or alternates-bearing Git directory is refused, never followed', async t => {
  const h = await hostileEnvironment(t);
  const scratch = join(h.dir, 'scratch');
  await mkdir(scratch, { mode: 0o700 });
  await symlink(join(h.dir, 'app.pem'), join(h.checkout, '.git', 'refs', 'heads', 'stolen'));
  const linked = await inspectCheckout(h.environment, { scratch, base: h.base });
  assert.deepEqual([linked.status, linked.status === 'refused' && linked.code], ['refused', 'CHECKOUT_PATH_UNSAFE']);
  await rm(join(h.checkout, '.git', 'refs', 'heads', 'stolen'));
  await writeFile(join(h.checkout, '.git', 'objects', 'info', 'alternates'), join(h.dir, 'elsewhere') + '\n');
  const alternates = await inspectCheckout(h.environment, { scratch, base: h.base });
  assert.deepEqual([alternates.status, alternates.status === 'refused' && alternates.code], ['refused', 'CHECKOUT_ALTERNATES_PRESENT']);
});

test('review 2: host reads of guest-writable paths never follow symlinks or hard links and stay inside the base, bounded', async t => {
  const h = await hostileEnvironment(t);
  const artifacts = join(h.environment, 'artifacts');
  await mkdir(join(artifacts, 'spec', 'v1'), { recursive: true });
  await writeFile(join(artifacts, 'spec', 'v1', 'ok.json'), '{"complete":true}');
  assert.equal((await readConfined(artifacts, 'spec/v1/ok.json', 1024))?.toString(), '{"complete":true}');
  await symlink(join(h.dir, 'app.pem'), join(artifacts, 'spec', 'v1', 'sources.json'));
  await assert.rejects(readConfined(artifacts, 'spec/v1/sources.json', 1024), /CONFINED_PATH_UNSAFE/, 'final symlink');
  await symlink(h.dir, join(artifacts, 'escape'));
  await assert.rejects(readConfined(artifacts, 'escape/app.pem', 1024), /CONFINED_PATH_UNSAFE/, 'intermediate symlink');
  await link(join(h.dir, 'app.pem'), join(artifacts, 'hard.json'));
  await assert.rejects(readConfined(artifacts, 'hard.json', 1024), /CONFINED_PATH_UNSAFE/, 'hard link to a host file');
  await assert.rejects(readConfined(artifacts, '../app.pem', 1024), /CONFINED_PATH_UNSAFE/);
  await writeFile(join(artifacts, 'big.json'), 'x'.repeat(2048));
  await assert.rejects(readConfined(artifacts, 'big.json', 1024), /CONFINED_FILE_TOO_LARGE/);
  assert.equal(await readConfined(artifacts, 'spec/v2/sources.json', 1024), null, 'absent is distinct');
});
