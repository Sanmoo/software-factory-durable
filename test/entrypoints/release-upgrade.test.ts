import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { controlStorageFormats, inspectStorage, type StorageInspection } from '../../src/control/index.js';
import { inventoryTree } from '../../src/entrypoints/release.js';
import { questionId, storageWithPendingQuestion, storedBytesExceptInstallation, writeFormatOne, writeFormatThree } from '../control/upgrade-fixture.js';
import { id, releaseBuild } from './release-fixture.js';
import { remainingMs, until } from '../runner/budget.js';
import { configuration, fakeRelease, storageDeclarations } from './upgrade-fixture.js';

// I-local (ticket 33): the REAL release builder output (private Node, emitted JS, manifest declaring storage format 4) extracted NEXT TO a
// pre-33 release selected by its pinned launcher (a synthetic tree with a real manifest; it carries no code) with SYNTHETIC guest assets.
// The new release's own private Node runs `upgrade check/apply` (CLI → flock → upgrade owner), then the switched launcher starts the real
// controller (paused, no repository configured: no GitHub/network call), the local CLI reads/answers the pending Question over the real
// protocol and Ctrl+C stops it cleanly. The pending Question comes from the public Control with doubled execution (upgrade-fixture).
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let work: string, archive: string;
// Ticket 37: the run's shared release build (release-fixture), not a third build of its own; only the extraction roots are private.
before(async () => {
  const built = await releaseBuild();
  work = built.work;
  archive = join(built.output, built.report.archive);
});
after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});
/** A private installation root with the built release extracted in it (not selected); removed when the test ends. */
async function installationRoot(t: { after(fn: () => Promise<void>): void }, name: string) {
  const root = join(work, name);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['releases', 'assets', 'credentials', 'data', 'environments', 'run']) await mkdir(join(root, directory), { mode: 0o700 });
  const extracted = spawnSync('tar', ['-xpf', archive, '-C', root, '--skip-old-files', 'releases', 'assets'], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  return root;
}
/** The built release's own private Node running its CLI (the upgrade is always run by the NEW release). */
const builtCli = (root: string) => (args: string[]) =>
  spawnSync(
    '/usr/bin/env',
    [
      '-u',
      'NODE_OPTIONS',
      '-u',
      'NODE_PATH',
      '-u',
      'NODE_COMPILE_CACHE',
      'NODE_DISABLE_COMPILE_CACHE=1',
      join(root, 'releases', id, 'node/bin/node'),
      join(root, 'releases', id, 'dist/src/entrypoints/cli.js'),
      ...args,
    ],
    { encoding: 'utf8', timeout: remainingMs() },
  );

test('built release: extracted next to the previous one, explicit migration, switched selection, paused start, pending Question answered, clean stop', async t => {
  // Previous (pre-33) release selected; storage format 1 with a pending Question, paused, cleanly stopped.
  const root = await installationRoot(t, 'root');
  const previous = await fakeRelease(root, 'mvp-32.1', { storage: false, skillPack: 'factory-skills-v4' });
  await writeFile(join(root, 'factory'), previous.launcher, { mode: 0o755 });
  await writeFile(join(root, 'config.yaml'), configuration, { mode: 0o600 });
  await writeFile(join(root, 'credentials', 'github-app.pem'), 'synthetic-never-read', { mode: 0o600 });
  const source = join(work, 'source.sqlite');
  await storageWithPendingQuestion(source);
  await writeFormatOne(source, join(root, 'data', 'control.sqlite'));
  await chmod(join(root, 'data', 'control.sqlite'), 0o600);
  const releasesBefore = JSON.stringify(await inventoryTree(join(root, 'releases', 'mvp-32.1')));
  const target = builtCli(root);
  const checked = target(['upgrade', 'check']);
  assert.equal(checked.status, 0, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.code, 'UPGRADE_MIGRATION_REQUIRED');
  assert.deepEqual(
    report.checks.filter((item: { status: string }) => item.status === 'blocked'),
    [],
  );
  assert.equal(
    report.checks.find((item: { id: string }) => item.id === 'upgrade:target').status,
    'ok',
    'the built release verifies itself (every byte) before anything',
  );
  // (Refusals without the explicit request and the rollback refusal are covered against the same logic in upgrade.test.ts.)
  assert.equal(sha(await readFile(join(root, 'factory'))), previous.manifest.launcher.sha256);
  await assert.rejects(stat(join(root, 'data', 'upgrade')), { code: 'ENOENT' }, 'check writes nothing');
  const applied = target(['upgrade', 'apply', '--migrate', 'factory-storage-1-to-2,factory-storage-2-to-3,factory-storage-3-to-4']);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  assert.equal(JSON.parse(applied.stdout).code, 'UPGRADE_COMPLETED');
  assert.equal(JSON.stringify(await inventoryTree(join(root, 'releases', 'mvp-32.1'))), releasesBefore, 'previous release preserved');
  // The installation launcher now selects the new release; doctor agrees.
  const factory = (args: string[]) => spawnSync(join(root, 'factory'), args, { encoding: 'utf8', timeout: remainingMs() });
  const doctor = JSON.parse(factory(['doctor', '--json']).stdout);
  assert.equal(doctor.release.release, id);
  assert.equal(doctor.checks.find((item: { id: string }) => item.id === 'release:selected').status, 'ok');
  // Start paused, inspect, answer the pending Question, stop cleanly.
  const run = spawn(join(root, 'factory'), ['run'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  run.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>(resolve => run.once('exit', code => resolve(code)));
  try {
    // The owner is up when its status answers: re-probed, bounded by the runner budget instead of 100 x 100 ms.
    const status = await until(
      () => `controller status (stderr: ${stderr.slice(-300)})`,
      async () => {
        const probe = factory(['status', '--json']);
        return probe.status === 0 ? probe : undefined;
      },
      100,
    );
    const view = JSON.parse(status.stdout).payload ?? JSON.parse(status.stdout);
    assert.deepEqual([view.paused, view.storage.format, view.questions.open], [true, 4, 1]);
    const question = JSON.parse(factory(['question', questionId, '--json']).stdout);
    assert.equal(question.question.state, 'open');
    const answered = factory(['answer', questionId, 'Use docs/factory.md']);
    assert.equal(answered.status, 0, answered.stderr);
    assert.equal(JSON.parse(factory(['question', questionId, '--json']).stdout).question.state, 'answered');
  } finally {
    run.kill('SIGINT');
  }
  assert.equal(await exited, 0, stderr);
  const restarted = spawnSync(join(root, 'factory'), ['upgrade', 'status'], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(JSON.parse(restarted.stdout).code, 'UPGRADE_COMPLETED');
  assert.equal(JSON.parse(restarted.stdout).storage.lifecycle.last.end, 'clean', 'the clean stop is recorded only after confirmed cessation/persistence');
  assert.doesNotMatch(await readFile(join(root, 'data', 'control.sqlite'), 'latin1'), /synthetic-never-read/);
});

test('TR-52: the built release migrates format 3 to 4 by `upgrade apply --migrate factory-storage-3-to-4`; every other document stays byte for byte, the rollback is refused and a release that knows no Triage refuses the storage', async t => {
  // Previous release: knows the Jira origin and no Triage (storage format 3, configuration 1 and 2); a synthetic tree with a real manifest.
  const root = await installationRoot(t, 'root-triage');
  const previous = await fakeRelease(root, 'jira-1', {
    storage: storageDeclarations.formatThree,
    skillPack: 'factory-skills-v12',
    configurationSchema: [1, 2],
  });
  await writeFile(join(root, 'factory'), previous.launcher, { mode: 0o755 });
  await writeFile(join(root, 'config.yaml'), configuration, { mode: 0o600 });
  await writeFile(join(root, 'credentials', 'github-app.pem'), 'synthetic-never-read', { mode: 0o600 });
  const storagePath = join(root, 'data', 'control.sqlite');
  const source = join(work, 'source-triage.sqlite');
  await storageWithPendingQuestion(source);
  await writeFormatThree(source, storagePath);
  await chmod(storagePath, 0o600);
  const storageOf = (inspection: StorageInspection) => inspection as Extract<StorageInspection, { kind: 'storage' }>;
  const before = storageOf(await inspectStorage(storagePath));
  assert.deepEqual([before.format, before.preserved!.works, before.preserved!.questions], [3, 2, { open: 1, answered: 0 }]);
  const bytes = storedBytesExceptInstallation(storagePath);
  const target = builtCli(root);
  const report = (args: string[]) => {
    const ran = target(args);
    assert.notEqual(ran.stdout, '', ran.stderr);
    return JSON.parse(ran.stdout);
  };
  const checked = report(['upgrade', 'check']);
  assert.deepEqual([checked.code, checked.migration.required, checked.storage.format], ['UPGRADE_MIGRATION_REQUIRED', 'factory-storage-3-to-4', 3]);
  assert.deepEqual(storedBytesExceptInstallation(storagePath), bytes, 'check writes nothing');
  assert.equal(report(['upgrade', 'apply']).code, 'UPGRADE_MIGRATION_NOT_REQUESTED', 'never migrated without the explicit request');
  assert.equal(storageOf(await inspectStorage(storagePath)).format, 3);
  assert.equal(report(['upgrade', 'apply', '--migrate', 'factory-storage-3-to-4']).code, 'UPGRADE_COMPLETED');
  // Only the format identity changed: the stored rows and revisions of every other document are the same; no Triage request, no other record.
  const after = storageOf(await inspectStorage(storagePath));
  assert.deepEqual([after.format, after.operational, after.problems], [4, 'ready', []]);
  assert.deepEqual(storedBytesExceptInstallation(storagePath), bytes);
  assert.deepEqual(after.preserved, before.preserved);
  assert.deepEqual(
    Object.fromEntries(Object.entries(after.documents).map(([kind, entry]) => [kind, entry.count])),
    Object.fromEntries(Object.entries(before.documents).map(([kind, entry]) => [kind, entry.count])),
  );
  assert.equal(after.documents['factory.triage-request'], undefined);
  assert.deepEqual(
    (after.installation!.migrations as { migration: string; from: number; to: number }[]).map(item => [item.migration, item.from, item.to]),
    [['factory-storage-3-to-4', 3, 4]],
  );
  // After the commit the rollback is refused, with no Triage request stored: the previous release operates format 3 only.
  const rollback = report(['upgrade', 'rollback']);
  assert.equal(rollback.code, 'ROLLBACK_FORMAT_UNSUPPORTED');
  assert.deepEqual(
    rollback.checks.filter((item: { status: string }) => item.status === 'blocked').map((item: { id: string }) => item.id),
    ['rollback:storage'],
  );
  assert.notEqual(sha(await readFile(join(root, 'factory'))), previous.manifest.launcher.sha256, 'the previous release is not reselected');
  assert.deepEqual(storageOf(await inspectStorage(storagePath)), after, 'the refused rollback wrote nothing');
  // The older release itself: read with the format table of a release that ends at format 3 (its binary is not part of this run), the
  // migrated storage has no format it knows, which refuses every open.
  const { 4: _four, ...beforeTriage } = controlStorageFormats;
  const older = storageOf(await inspectStorage(storagePath, beforeTriage));
  assert.deepEqual(
    [older.format, older.operational, older.problems.map(problem => problem.code)],
    [null, 'incompatible', ['STORAGE_DOCUMENT_VERSION_UNSUPPORTED']],
  );
});
