import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile, symlink, link, unlink, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareController } from './controller-configuration.js';
import { setup } from '../../src/entrypoints/setup.js';
import { ended, remainingMs, until } from '../runner/budget.js';

const cli = resolve('dist/src/entrypoints/cli.js');
// No fixed per-test or per-call timeout (ticket 40): each controller CLI runs detached in its own group and its end is awaited by
// event, bounded only by the runner budget, which kills the whole tree (launcher, flock, owner) and names the stage reached.
function launch(root: string) {
  const child = spawn(process.execPath, [cli, 'run', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.on('data', bytes => {
    stderr += String(bytes);
  });
  child.stdout.resume();
  const exit = ended(child, () => `controller run --root ${root}; stderr: ${stderr.slice(-300)}`).then(result => result.code);
  exit.catch(() => {}); // Rejection is observed where the test awaits it.
  return { child, ended: exit, stderr: () => stderr };
}
async function status(root: string, owner: ChildProcess) {
  return await until(
    'controller status available',
    async () => {
      assert.equal(owner.exitCode, null);
      const result = spawnSync(process.execPath, [cli, 'status', '--root', root, '--json'], { encoding: 'utf8', timeout: remainingMs() });
      return result.status === 0 ? (JSON.parse(result.stdout) as Record<string, unknown>) : undefined;
    },
    10,
  );
}
async function ownerPid(cliPid: number): Promise<number> {
  const launcher = Number((await readFile(`/proc/${cliPid}/task/${cliPid}/children`, 'utf8')).trim());
  const owner = Number((await readFile(`/proc/${launcher}/task/${launcher}/children`, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(owner) && owner > 0, 'real no-fork flock owner PID');
  return owner;
}

test('run refuses the incomplete setup configuration before creating operational storage', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-incomplete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await setup(root);
  const owner = launch(root);
  t.after(async () => {
    owner.child.kill('SIGTERM');
    await owner.ended;
  });
  assert.equal(await owner.ended, 2);
  assert.match(owner.stderr(), /CONFIGURATION_INVALID/);
  await assert.rejects(lstat(join(root, 'data/control.sqlite')), { code: 'ENOENT' });
});

test('canonical-root aliases share a stable exclusive lock, and internal owner refuses to bypass flock', { timeout: remainingMs() }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'factory-owner-'));
  const root = join(parent, 'installation');
  await prepareController(root);
  const first = launch(root);
  t.after(async () => {
    first.child.kill('SIGTERM');
    await first.ended;
    await rm(parent, { recursive: true, force: true });
  });
  await status(root, first.child);
  const lockBefore = await lstat(join(root, 'data/control.lock'));
  await symlink(root, join(parent, 'alias'));
  for (const path of [root, join(parent, 'alias'), join(root, '..', 'installation')]) {
    const other = launch(path);
    assert.equal(await other.ended, 73);
    assert.match(other.stderr(), /CONTROLLER_ALREADY_RUNNING/);
  }
  const alternate = join(parent, 'alternate');
  await prepareController(alternate);
  for (const alias of [symlink, link]) {
    const aliasPath = join(alternate, 'data/control.sqlite');
    await alias(join(root, 'data/control.sqlite'), aliasPath);
    const other = launch(alternate);
    assert.equal(await other.ended, 3, 'a symlink/hardlink alias cannot create a second owner');
    await unlink(aliasPath);
  }
  const bypass = spawnSync(process.execPath, [resolve('dist/src/entrypoints/controller/owner.js'), root], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(bypass.status, 3);
  assert.match(bypass.stderr, /CONTROLLER_START_FAILED/);
  assert.equal((await lstat(join(root, 'data/control.lock'))).ino, lockBefore.ino);
  const persistence = (await status(root, first.child)).persistence;
  assert.deepEqual(persistence, {
    sqliteVersion: '3.53.4',
    sqliteSourceId: '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc',
    journalMode: 'wal',
    synchronous: 'FULL',
  });
});

test('internal owner refuses shared or unrelated inherited flock descriptions', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-lock-kind-'));
  await prepareController(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const unrelated = join(root, 'data/unrelated.lock');
  await writeFile(unrelated, '', { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'data/control.lock'), '', { flag: 'wx', mode: 0o600 });
  for (const [kind, lockPath] of [
    ['--shared', join(root, 'data/control.lock')],
    ['--exclusive', unrelated],
  ]) {
    const child = spawnSync(
      'flock',
      [kind!, '--nonblock', '--no-fork', lockPath!, process.execPath, resolve('dist/src/entrypoints/controller/owner.js'), root],
      { encoding: 'utf8', timeout: remainingMs() },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 3, 'a current-PID lock on an unrelated file or a shared lock is not authority');
    assert.match(child.stderr, /CONTROLLER_START_FAILED/);
    await assert.rejects(lstat(join(root, 'data/control.sqlite')), { code: 'ENOENT' });
  }
});
test('controller verifies its own flock on configured persistent storage without accepting another process owner', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(process.env.FACTORY_TEST_ROOT ?? tmpdir(), 'factory-storage-lock-'));
  await prepareController(root);
  const owner = launch(root);
  t.after(async () => {
    owner.child.kill('SIGTERM');
    await owner.ended;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await status(root, owner.child)).dispatch, 'closed');
  const bypass = spawnSync(process.execPath, [resolve('dist/src/entrypoints/controller/owner.js'), root], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(bypass.status, 3, 'the held lock must belong to this process, not merely exist');
  const contender = launch(root);
  assert.equal(await contender.ended, 73);
});

test('SIGKILL releases the owner lock and a restart preserves acknowledged pause', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-crash-'));
  await prepareController(root);
  let owner = launch(root);
  t.after(async () => {
    owner.child.kill('SIGTERM');
    await owner.ended;
    await rm(root, { recursive: true, force: true });
  });
  await status(root, owner.child);
  const pause = spawnSync(process.execPath, [cli, 'pause', '--request-id', 'before-crash', '--root', root, '--json'], {
    encoding: 'utf8',
    timeout: remainingMs(),
  });
  assert.equal(pause.status, 0, pause.stderr);
  process.kill(await ownerPid(owner.child.pid!), 'SIGKILL');
  assert.equal(await owner.ended, 1);
  owner = launch(root);
  const recovered = await status(root, owner.child);
  assert.equal(recovered.paused, true);
  assert.equal(recovered.dispatch, 'closed');
  assert.equal(recovered.historyLength, 1);
});

test('real file-size limit prevents a control commit from producing durable ACK or a half transition', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-commit-failure-'));
  await prepareController(root);
  let owner = launch(root);
  t.after(async () => {
    owner.child.kill('SIGTERM');
    await owner.ended;
    await rm(root, { recursive: true, force: true });
  });
  await status(root, owner.child);
  const pid = await ownerPid(owner.child.pid!);
  const limit = spawnSync('prlimit', ['--pid', String(pid), '--fsize=0:0'], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(limit.status, 0, limit.stderr);
  const failed = spawnSync(process.execPath, [cli, 'pause', '--request-id', 'failed-commit', '--root', root, '--json'], {
    encoding: 'utf8',
    timeout: remainingMs(),
  });
  assert.equal(failed.status, 4, failed.stdout + failed.stderr);
  assert.doesNotMatch(failed.stdout, /"kind":"durable"/);
  assert.notEqual(await owner.ended, 0, 'storage failure is not clean administrative stop');
  owner = launch(root);
  const recovered = await status(root, owner.child);
  assert.equal(recovered.paused, false);
  assert.equal(recovered.historyLength, 0);
  const lookup = spawnSync(process.execPath, [cli, 'request', 'failed-commit', '--root', root, '--json'], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(lookup.status, 0, lookup.stderr);
  assert.deepEqual(JSON.parse(lookup.stdout), { kind: 'request', receipt: null });
});

for (const directory of ['environments', 'run'])
  test(`unpause cannot release dispatch with unknown ${directory} resources; offline queries are explicit errors`, { timeout: remainingMs() }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'factory-unknown-'));
    await prepareController(root);
    const offline = spawnSync(process.execPath, [cli, 'status', '--root', root, '--json'], { encoding: 'utf8', timeout: remainingMs() });
    assert.equal(offline.status, 3);
    assert.match(offline.stderr, /CONTROLLER_UNAVAILABLE/);
    assert.equal(offline.stdout, '');
    await writeFile(join(root, directory, 'unknown-resource'), 'preserve me');
    const owner = launch(root);
    t.after(async () => {
      owner.child.kill('SIGTERM');
      await owner.ended;
      await rm(root, { recursive: true, force: true });
    });
    assert.equal((await status(root, owner.child)).dispatchReason, 'RECONCILIATION_REQUIRED');
    const unpause = spawnSync(process.execPath, [cli, 'unpause', '--request-id', 'unpause', '--root', root, '--json'], {
      encoding: 'utf8',
      timeout: remainingMs(),
    });
    assert.equal(unpause.status, 0, unpause.stderr);
    const current = await status(root, owner.child);
    assert.equal(current.dispatch, 'closed');
    assert.equal(current.dispatchReason, 'RECONCILIATION_REQUIRED');
    assert.equal(await readFile(join(root, directory, 'unknown-resource'), 'utf8'), 'preserve me');
  });
