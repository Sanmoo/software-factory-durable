import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectStorage, openControl, type StorageInspection } from '../../src/control/index.js';
import { readJournal, upgrade, upgradeBlocksStart, type UpgradeReport } from '../../src/entrypoints/controller/upgrade.js';
import { verifyReleaseTree } from '../../src/entrypoints/release.js';
import { crashAfterStart, reconcilingRun, storageWithPendingQuestion, writeFormatOne } from '../control/upgrade-fixture.js';
import { installation } from './upgrade-fixture.js';
import { remainingMs, untilHolds } from '../runner/budget.js';

// I-local (ticket 33): the real upgrade logic against an installation root with real manifests/launchers of synthetic release trees and a
// real Control storage (pending Question produced by the public Control with doubled execution/GitHub). Crash cuts are REAL SIGKILLs of a
// child process right after each durable step. Not evidence of built releases, a VM, GitHub or a model.
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const node = process.execPath;
const child = 'dist/test/entrypoints/upgrade-crash-child.js';
async function rootWithFormatOne(t: { after(fn: () => Promise<void>): void }, options: Parameters<typeof installation>[0] = {}) {
  const fixture = await installation(options);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const source = join(fixture.root, 'run', 'source.sqlite');
  const pending = await storageWithPendingQuestion(source);
  await writeFormatOne(source, fixture.context.storagePath);
  await rm(source); await rm(`${source}-wal`, { force: true }); await rm(`${source}-shm`, { force: true });
  await chmod(fixture.context.storagePath, 0o600); // As the controller creates it (umask 077).
  return { ...fixture, pending };
}
const snapshot = async (root: string, storagePath: string) => ({ launcher: sha(await readFile(join(root, 'factory'))), journal: await readJournal(root),
  storage: await inspectStorage(storagePath) });
const blocked = (result: UpgradeReport) => result.checks.filter(item => item.status === 'blocked').map(item => item.id);
const storageOf = (inspection: StorageInspection) => inspection as Extract<StorageInspection, { kind: 'storage' }>;

test('check verifies every compatibility point read-only; apply refuses a required migration that was not requested; the explicit one completes', async t => {
  const { root, context, previous, target } = await rootWithFormatOne(t);
  const before = await snapshot(root, context.storagePath);
  const checked = await upgrade(context, 'check');
  assert.equal(checked.code, 'UPGRADE_MIGRATION_REQUIRED');
  assert.deepEqual(blocked(checked), []);
  assert.deepEqual(checked.checks.map(item => item.id), ['upgrade:target', 'upgrade:previous', 'upgrade:configuration', 'upgrade:storage', 'upgrade:registry', 'upgrade:pause',
    'upgrade:stop', 'upgrade:protocol', 'upgrade:profiles', 'upgrade:environments']);
  const stop = checked.checks.find(item => item.id === 'upgrade:stop')!;
  assert.equal(stop.status, 'ok', 'format 1 records no run end: the evidence is the durably settled activity');
  assert.match(stop.message, /no unsettled Execution and no held Slot/);
  assert.deepEqual([checked.from, checked.migration.required, checked.storage!.format, checked.storage!.paused], [{ release: 'mvp-32.1' }, 'factory-storage-1-to-2', 1, true]);
  for (const [options, code] of [[{}, 'UPGRADE_MIGRATION_NOT_REQUESTED'], [{ migrate: 'something-else' }, 'UPGRADE_MIGRATION_NOT_APPLICABLE']] as const) {
    assert.equal((await upgrade(context, 'apply', options)).code, code);
    assert.deepEqual(await snapshot(root, context.storagePath), before, `${code}: nothing changed`);
  }
  const applied = await upgrade(context, 'apply', { migrate: 'factory-storage-1-to-2' });
  assert.equal(applied.code, 'UPGRADE_COMPLETED', JSON.stringify(applied));
  const after = await snapshot(root, context.storagePath);
  assert.equal(after.launcher, target.manifest.launcher.sha256, 'the explicit selection now names the new release');
  assert.deepEqual([after.journal !== 'invalid' && after.journal?.state, after.journal !== 'invalid' && after.journal?.steps.map(step => step.state)],
    ['completed', ['guarding', 'migrating', 'migrated', 'selecting', 'completed']]);
  assert.deepEqual(storageOf(after.storage).preserved, storageOf(before.storage).preserved, 'ids, queues, Questions, Slots and history preserved');
  assert.equal(storageOf(after.storage).format, 2);
  assert.equal((await verifyReleaseTree(previous.directory)).kind, 'release', 'previous release preserved intact');
  assert.equal(await upgradeBlocksStart(root), null);
  // No universal rollback: the previous release operates format 1 only and this storage is now format 2.
  const rollback = await upgrade(context, 'rollback');
  assert.equal(rollback.code, 'ROLLBACK_FORMAT_UNSUPPORTED');
  assert.equal(sha(await readFile(join(root, 'factory'))), target.manifest.launcher.sha256);
  // A second upgrade with the same release finds it already selected.
  assert.ok(blocked(await upgrade(context, 'check')).includes('upgrade:previous'));
});

test('incompatibility is refused before any change: not paused, unclean stop, unknown document, foreign environment assets, invalid configuration', async t => {
  // Not paused (format 2 storage written by the current release, which recorded a clean stop, but never paused).
  const fresh = await installation({ previousStorage: true });
  t.after(() => rm(fresh.root, { recursive: true, force: true }));
  const { openControl } = await import('../../src/control/index.js');
  const control = await openControl({ storagePath: fresh.context.storagePath, runtimeInventory: 'unknown' });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await untilHolds('run start recorded', async () => Boolean(storageOf(await inspectStorage(fresh.context.storagePath)).installation?.lifecycle?.current), 5);
  // Inspect while the run is alive: its start is recorded without an end (a crash would leave exactly this).
  const alive = await upgrade(fresh.context, 'check');
  assert.deepEqual(blocked(alive), ['upgrade:pause', 'upgrade:stop']);
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
  const before = await snapshot(fresh.root, fresh.context.storagePath);
  const notPaused = await upgrade(fresh.context, 'apply');
  assert.deepEqual([notPaused.code, blocked(notPaused)], ['UPGRADE_INCOMPATIBLE', ['upgrade:pause']]);
  assert.deepEqual(await snapshot(fresh.root, fresh.context.storagePath), before);

  // Unknown document kind, an environment prepared with other guest assets and an invalid configuration, at once.
  const bad = await rootWithFormatOne(t);
  const source = join(bad.root, 'run', 'copy.sqlite');
  await writeFormatOne(bad.context.storagePath, source, [{ kind: 'factory.future', version: 1, value: { x: 1 } }]);
  await rm(bad.context.storagePath); await rm(`${bad.context.storagePath}-wal`, { force: true }); await rm(`${bad.context.storagePath}-shm`, { force: true });
  await writeFormatOne(source, bad.context.storagePath);
  const workId = 'w-foreign';
  const environment = `env-${sha(workId)}`;
  await mkdir(join(bad.root, 'environments', environment), { mode: 0o700 });
  await writeFile(join(bad.root, 'environments', environment, 'owner.json'), JSON.stringify({ version: 1, workId, environment,
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 },
    guestAssets: { directory: join(bad.root, 'assets', 'guest', 'b'.repeat(64)), manifestSha256: 'b'.repeat(64) } }), { mode: 0o600 });
  await writeFile(join(bad.root, 'environments', environment, 'ready.json'), JSON.stringify({ environment }), { mode: 0o600 });
  await writeFile(join(bad.root, 'config.yaml'), 'schemaVersion: 1\n', { mode: 0o600 });
  const snapshotBad = await snapshot(bad.root, bad.context.storagePath);
  const refused = await upgrade(bad.context, 'apply', { migrate: 'factory-storage-1-to-2' });
  assert.equal(refused.code, 'UPGRADE_INCOMPATIBLE');
  assert.deepEqual(blocked(refused), ['upgrade:configuration', 'upgrade:storage', 'upgrade:environments']);
  assert.match(refused.checks.find(item => item.id === 'upgrade:storage')!.message, /STORAGE_DOCUMENT_UNKNOWN/);
  assert.deepEqual(await snapshot(bad.root, bad.context.storagePath), snapshotBad, 'nothing deleted, resubmitted or migrated');
  await assert.rejects(stat(join(bad.root, 'data', 'upgrade')), { code: 'ENOENT' });
});

/**
 * Ticket 37 P5 (approved): the upgrade stopped right after `cut` without a second process. Its observe hook never returns at that step,
 * so the call stays frozen there (as a killed process, it does nothing more) and what is durable is exactly what that step left.
 */
function frozenAt(context: Parameters<typeof upgrade>[0], cut: 'journal' | 'selected'): Promise<void> {
  return new Promise(reached => {
    void upgrade({ ...context, observe: step => { if (step !== cut) return; reached(); return new Promise<never>(() => {}); } }, 'apply', { migrate: 'factory-storage-1-to-2' });
  });
}

test('interruption after each durable step (a real SIGKILL at the migration commit; journal and selection frozen at their step): the interruption is detected, the controller refuses to start, resume completes it or rollback reselects while possible', async t => {
  for (const cut of ['journal', 'migrated', 'selected'] as const) {
    const { root, context, previous, target, pending } = await rootWithFormatOne(t);
    const before = storageOf(await inspectStorage(context.storagePath));
    if (cut === 'migrated') {
      // The one real process death of this mechanism: a SIGKILL right after the migration committed.
      const killed = spawnSync(node, [child, root, cut, 'apply', 'factory-storage-1-to-2'], { encoding: 'utf8', timeout: remainingMs() });
      assert.equal(killed.signal, 'SIGKILL', `${cut}: ${killed.stderr}`);
    } else await frozenAt(context, cut);
    const journal = await readJournal(root);
    assert.ok(journal && journal !== 'invalid');
    assert.equal(journal.state, { journal: 'migrating', migrated: 'migrated', selected: 'selecting' }[cut]);
    const storage = storageOf(await inspectStorage(context.storagePath));
    assert.equal(storage.format, cut === 'journal' ? 1 : 2, `${cut}: never a partially migrated storage`);
    assert.deepEqual(storage.preserved, before.preserved);
    const selected = sha(await readFile(join(root, 'factory')));
    if (cut === 'selected') assert.equal(selected, target.manifest.launcher.sha256);
    else {
      // From the journal on, <root>/factory is the guard launcher: NO release (not the pre-33 v1) can start until resume or rollback.
      assert.notEqual(selected, previous.manifest.launcher.sha256);
      const v1 = spawnSync(join(root, 'factory'), ['run'], { encoding: 'utf8', timeout: remainingMs() });
      assert.equal(v1.status, 2, `${cut}: the launcher starts nothing during the upgrade`);
      assert.equal(JSON.parse(v1.stderr.trim()).code, 'UPGRADE_INCOMPLETE');
    }
    assert.equal((await upgradeBlocksStart(root))?.code, 'UPGRADE_INCOMPLETE');
    assert.equal((await upgrade(context, 'status')).code, 'UPGRADE_INCOMPLETE');
    assert.equal((await upgrade(context, 'apply', { migrate: 'factory-storage-1-to-2' })).code, 'UPGRADE_IN_PROGRESS');
    if (cut === 'journal') {
      // Nothing migrated yet: rolling back closes the upgrade with the previous release still selected and the storage untouched.
      const rolled = await upgrade(context, 'rollback');
      assert.equal(rolled.code, 'UPGRADE_ROLLED_BACK');
      assert.equal(sha(await readFile(join(root, 'factory'))), previous.manifest.launcher.sha256);
      assert.deepEqual(storageOf(await inspectStorage(context.storagePath)), before);
      assert.equal(await upgradeBlocksStart(root), null);
      // A new upgrade can then start again and a SIGKILLed resume is itself resumable.
      const again = spawnSync(node, [child, root, 'migrated', 'apply', 'factory-storage-1-to-2'], { encoding: 'utf8', timeout: remainingMs() });
      assert.equal(again.signal, 'SIGKILL');
    } else {
      const rolled = await upgrade(context, 'rollback');
      assert.equal(rolled.code, 'ROLLBACK_FORMAT_UNSUPPORTED', `${cut}: the previous release cannot operate the migrated storage`);
    }
    const resumed = await upgrade(context, 'resume');
    assert.equal(resumed.code, 'UPGRADE_COMPLETED', `${cut}: ${JSON.stringify(resumed.checks)}`);
    assert.equal(sha(await readFile(join(root, 'factory'))), target.manifest.launcher.sha256);
    const final = storageOf(await inspectStorage(context.storagePath));
    assert.deepEqual([final.format, final.preserved], [2, before.preserved]);
    assert.equal((final.installation!.migrations as unknown[]).length, 1, `${cut}: migrated exactly once`);
    assert.equal(final.preserved!.questions.open, 1, 'the pending Question is still open (answerable after start)');
    assert.equal(pending.waiting.impediments.some(item => item.code === 'QUESTION_PENDING'), true);
    assert.equal(await upgradeBlocksStart(root), null);
  }
});

test('the controller owner refuses an incomplete upgrade and an unmigrated storage before opening it; the upgrade shares the controller lock', async t => {
  const { root, context } = await rootWithFormatOne(t);
  const controller = 'dist/src/entrypoints/controller.js';
  const ownerRun = () => spawnSync(node, [controller, root], { encoding: 'utf8', timeout: remainingMs() });
  const migrationRequired = ownerRun();
  assert.equal(migrationRequired.status, 2, migrationRequired.stderr);
  assert.equal(JSON.parse(migrationRequired.stderr.trim().split('\n').at(-1)!).code, 'STORAGE_MIGRATION_REQUIRED');
  const killed = spawnSync(node, [child, root, 'journal', 'apply', 'factory-storage-1-to-2'], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(killed.signal, 'SIGKILL');
  const before = await inspectStorage(context.storagePath);
  const incomplete = ownerRun();
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stderr.trim().split('\n').at(-1)!).code, 'UPGRADE_INCOMPLETE');
  assert.deepEqual(await inspectStorage(context.storagePath), before, 'storage not opened');
  // The upgrade owner of a development checkout refuses: it is not a release (nothing changed).
  const development = spawnSync(node, [controller, root, 'upgrade', 'status'], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(development.status, 2);
  assert.equal(JSON.parse(development.stderr.trim().split('\n').at(-1)!).code, 'UPGRADE_TARGET_INVALID');
  // While another owner holds the canonical lock, the upgrade cannot run (no takeover).
  const holder = spawnSync('flock', ['--exclusive', '--nonblock', join(root, 'data', 'control.lock'), node, controller, root, 'upgrade', 'status'], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(holder.status, 73, holder.stderr);
});

test('resume re-verifies the migrated storage against the journal: a changed state blocks the selection with an explicit exit', async t => {
  const { root, context, target } = await rootWithFormatOne(t);
  const killed = spawnSync(node, [child, root, 'migrated', 'apply', 'factory-storage-1-to-2'], { encoding: 'utf8', timeout: remainingMs() });
  assert.equal(killed.signal, 'SIGKILL');
  // The storage changes after the migration commit (here through the public Control; a stale or foreign writer in reality).
  const control = await openControl({ storagePath: context.storagePath, runtimeInventory: 'unknown' });
  assert.equal((await control.accept({ request_id: 'unpause-x', operation: 'unpause', origin: 'local-cli' }) as { kind: string }).kind, 'durable');
  assert.equal((await control.accept({ request_id: 'pause-x', operation: 'pause', origin: 'local-cli' }) as { kind: string }).kind, 'durable');
  const aborted = new AbortController(); aborted.abort(); await control.run(aborted.signal);
  const resumed = await upgrade(context, 'resume');
  assert.equal(resumed.code, 'UPGRADE_VERIFICATION_FAILED');
  assert.match(resumed.nextStep, /external storage protection/);
  assert.notEqual(sha(await readFile(join(root, 'factory'))), target.manifest.launcher.sha256, 'never selected');
  const journal = await readJournal(root);
  assert.equal(journal !== 'invalid' && journal?.state, 'migrated');
  assert.equal((await upgradeBlocksStart(root))?.code, 'UPGRADE_INCOMPLETE');
});

test('format 1 without clean-stop evidence needs durably settled activity; otherwise the upgrade is blocked', async t => {
  const fixture = await installation();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const source = join(fixture.root, 'run', 'source.sqlite');
  await storageWithPendingQuestion(source, { cessation: false });
  await writeFormatOne(source, fixture.context.storagePath);
  const checked = await upgrade(fixture.context, 'check');
  assert.equal(checked.code, 'UPGRADE_INCOMPATIBLE');
  assert.ok(blocked(checked).includes('upgrade:stop'));
  assert.match(checked.checks.find(item => item.id === 'upgrade:stop')!.message, /unsettled/);
});

test('rollback applies the same pre-checks as apply (pause, stop, environments, configuration) and refuses an unknown format', async t => {
  const fixture = await installation({ previousStorage: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await storageWithPendingQuestion(fixture.context.storagePath);
  await chmod(fixture.context.storagePath, 0o600);
  assert.equal((await upgrade(fixture.context, 'apply')).code, 'UPGRADE_COMPLETED');
  const control = await openControl({ storagePath: fixture.context.storagePath, runtimeInventory: 'unknown' });
  await control.accept({ request_id: 'unpause-y', operation: 'unpause', origin: 'local-cli' });
  const aborted = new AbortController(); aborted.abort(); await control.run(aborted.signal);
  const refused = await upgrade(fixture.context, 'rollback');
  assert.deepEqual([refused.code, blocked(refused)], ['ROLLBACK_INCOMPATIBLE', ['upgrade:pause']]);
  assert.equal(sha(await readFile(join(fixture.root, 'factory'))), fixture.target.manifest.launcher.sha256);
  const again = await openControl({ storagePath: fixture.context.storagePath, runtimeInventory: 'unknown' });
  await again.accept({ request_id: 'pause-y', operation: 'pause', origin: 'local-cli' });
  const stopped = new AbortController(); stopped.abort(); await again.run(stopped.signal);
  assert.equal((await upgrade(fixture.context, 'rollback')).code, 'UPGRADE_ROLLED_BACK');
  assert.equal(sha(await readFile(join(fixture.root, 'factory'))), fixture.previous.manifest.launcher.sha256);
  // No storage at all: the format a release would operate is unknown, so the rollback is refused.
  const fresh = await installation({ previousStorage: true });
  t.after(() => rm(fresh.root, { recursive: true, force: true }));
  assert.equal((await upgrade(fresh.context, 'apply')).code, 'UPGRADE_COMPLETED');
  assert.equal((await upgrade(fresh.context, 'rollback')).code, 'ROLLBACK_FORMAT_UNKNOWN');
});

test('after an interruption, only a run that performed ticket 26\'s boot reconciliation and then stopped cleanly is clean-stop evidence', async t => {
  const fixture = await installation({ previousStorage: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await storageWithPendingQuestion(fixture.context.storagePath);
  await chmod(fixture.context.storagePath, 0o600);
  await crashAfterStart(fixture.context.storagePath, 'killed-run'); // The process dies after its start commit.
  const stopOf = async () => (await upgrade(fixture.context, 'check')).checks.find(item => item.id === 'upgrade:stop')!;
  assert.equal((await stopOf()).status, 'blocked');
  // Runs without execution boundaries reconcile nothing: even stopped cleanly, the interruption stays pending.
  for (let i = 0; i < 2; i++) {
    const control = await openControl({ storagePath: fixture.context.storagePath, runtimeInventory: 'unknown' });
    const stop = new AbortController();
    const running = control.run(stop.signal);
    await untilHolds('run start recorded', async () =>
      Boolean((storageOf(await inspectStorage(fixture.context.storagePath)).installation?.lifecycle as { current?: unknown } | null)?.current), 5);
    stop.abort();
    assert.deepEqual(await running, { kind: 'clean' });
    const stopped = await stopOf();
    assert.deepEqual([stopped.status, /reconcil/.test(stopped.message)], ['blocked', true]);
  }
  // A reconciling boot (26) followed by a clean stop settles it.
  const reconciled = await reconcilingRun(fixture.context.storagePath);
  assert.deepEqual(reconciled.end, { kind: 'clean' });
  assert.notEqual(reconciled.recovery, null);
  assert.equal((await stopOf()).status, 'ok');
});

test('rollback validates config.yaml with the current rules only when the previous release declares the same configuration schema', async t => {
  for (const schema of [2, null]) {
    const fixture = await installation({ previousStorage: true, previousConfigurationSchema: schema });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await storageWithPendingQuestion(fixture.context.storagePath);
    await chmod(fixture.context.storagePath, 0o600);
    assert.equal((await upgrade(fixture.context, 'apply')).code, 'UPGRADE_COMPLETED');
    assert.equal((await upgrade(fixture.context, 'rollback')).code, 'ROLLBACK_CONFIGURATION_UNVERIFIABLE', String(schema));
    assert.equal(sha(await readFile(join(fixture.root, 'factory'))), fixture.target.manifest.launcher.sha256);
  }
});
