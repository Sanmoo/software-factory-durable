import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Diagnostic } from '../../contracts/index.js';
import { factorySkillPackIds } from '../../contracts/index.js';
import { controlStorageMigrations, inspectStorage, migrateStorage, type StorageInspection } from '../../control/index.js';
import { protocolVersion } from '../../protocol/index.js';
import { controllerPaths, startFailureCause, verifyControllerLock } from '../../platform/host/index.js';
import { environmentDependencies } from '../../sandbox/index.js';
import { configurationSchemaVersion, readConfiguration } from '../configuration.js';
import {
  applicationRoot,
  inspectRelease,
  parseReleaseManifest,
  productionModelChecks,
  productionProfile,
  releaseIdSchema,
  releaseLauncher,
  releaseManifestName,
  releaseStorageSupport,
  verifyReleaseTree,
  type ReleaseManifest,
} from '../release.js';

/**
 * Ticket 33 (spec §11.4): explicit release upgrade of one installation, run by the NEW release (which alone knows the formats it supports)
 * under the same canonical-storage flock as the controller, so no owner runs meanwhile. Procedure: the operator pauses and stops the
 * current controller cleanly, extracts the new release next to the previous one (never over it), then `upgrade check` (read-only) and
 * `upgrade apply` [--migrate <id>]. Apply re-checks everything, writes an upgrade journal, runs only the explicitly requested supported
 * migration (one Control commit), then switches the explicit selection (`<root>/factory`, atomic rename of the launcher pinned by the new
 * manifest). Every interruption is detectable from the journal: the controller refuses to start until `upgrade resume` completes it or
 * `upgrade rollback` reselects the previous release, which is possible ONLY while the storage is still in a format that release operates.
 * No storage copy, backup or restore is made (protection against storage loss stays external); no disk, base or asset is migrated or removed.
 */
export type UpgradeTarget = {
  directory: string;
  manifest: ReleaseManifest;
  manifestSha256: string;
  checks: Diagnostic[];
  guestAssets: { directory: string; manifestSha256: string };
};
export type UpgradeContext = {
  root: string;
  storagePath: string;
  target: UpgradeTarget;
  /** Test seam: called after each durable step of apply/resume (journal written, migration committed, selection switched). */
  observe?: (step: 'journal' | 'migrated' | 'selected') => Promise<void> | void;
};
export type UpgradeCommand = 'check' | 'apply' | 'status' | 'resume' | 'rollback';

const stateSchema = z.enum(['guarding', 'migrating', 'migrated', 'selecting', 'completed', 'rolled-back']);
const side = z.strictObject({
  release: releaseIdSchema,
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  launcherSha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageFormat: z.number().int(),
  migratesFrom: z.array(z.number().int()),
});
const journalSchema = z.strictObject({
  version: z.literal(1),
  upgradeId: z.uuid(),
  createdAt: z.iso.datetime(),
  from: side,
  to: side,
  migration: z.string().nullable(),
  /** Preserved digest recorded at apply, BEFORE anything changed: re-verified before the migration commit and before the selection. */
  expected: z.strictObject({
    preservedDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  }),
  state: stateSchema,
  steps: z.array(z.strictObject({ state: stateSchema, at: z.iso.datetime() })).max(32),
});
export type UpgradeJournal = z.infer<typeof journalSchema>;
const terminal = (state: UpgradeJournal['state']) => state === 'completed' || state === 'rolled-back';

export type UpgradeReport = {
  code: string;
  command: UpgradeCommand;
  from: { release: string } | null;
  to: { release: string };
  journal: UpgradeJournal | null;
  storage: StorageSummary | null;
  migration: { required: string | null; requested: string | null };
  checks: Diagnostic[];
  nextStep: string;
};
type StorageSummary = {
  state: 'absent' | 'present';
  format: number | null;
  operational: string | null;
  paused: boolean | null;
  problems: string[];
  preserved: unknown;
  stateDigest: string | null;
  activity: unknown;
  lifecycle: unknown;
  migrations: unknown[];
};

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const journalDirectory = (root: string) => join(root, 'data', 'upgrade');
const journalPath = (root: string) => join(journalDirectory(root), 'journal.json');
const previousLauncherPath = (root: string, upgradeId: string) => join(journalDirectory(root), `${upgradeId}.previous-launcher`);

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Durable atomic replacement: exclusive temporary, fsync, rename, fsync of the directory. */
async function writeAtomically(path: string, bytes: string | Buffer, mode: number) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await syncDirectory(resolve(path, '..'));
}

/** The upgrade journal of this installation; `invalid` is never repaired automatically. */
export async function readJournal(root: string): Promise<UpgradeJournal | null | 'invalid'> {
  try {
    const info = await lstat(journalPath(root));
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) return 'invalid';
    const parsed = journalSchema.safeParse(JSON.parse(await readFile(journalPath(root), 'utf8')));
    return parsed.success ? parsed.data : 'invalid';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    return 'invalid';
  }
}
async function saveJournal(root: string, journal: UpgradeJournal, state: UpgradeJournal['state']) {
  journal.state = state;
  journal.steps.push({ state, at: new Date().toISOString() });
  await writeAtomically(journalPath(root), JSON.stringify(journal, null, 1) + '\n', 0o600);
}

/** Which release `<root>/factory` selects: the release whose manifest pins exactly the launcher's SHA-256 (by bytes, never by name). */
async function selectedRelease(
  root: string,
): Promise<
  | { id: string; directory: string; manifest: ReleaseManifest; manifestSha256: string; launcherSha256: string; bytes: Buffer }
  | { id: null; launcherSha256: string | null }
> {
  let launcherSha256: string | null = null;
  let bytes: Buffer | undefined;
  try {
    const info = await lstat(join(root, 'factory'));
    if (info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o022) === 0) {
      bytes = await readFile(join(root, 'factory'));
      launcherSha256 = sha(bytes);
    }
  } catch {
    /* No launcher: nothing is selected. */
  }
  if (!launcherSha256) return { id: null, launcherSha256 };
  const matches = [];
  for (const id of (await readdir(join(root, 'releases')).catch(() => [] as string[])).sort()) {
    if (!releaseIdSchema.safeParse(id).success) continue;
    const manifestBytes = await readFile(join(root, 'releases', id, releaseManifestName)).catch(() => undefined);
    const parsed = manifestBytes ? parseReleaseManifest(manifestBytes) : undefined;
    if (parsed && parsed.manifest.release === id && parsed.manifest.launcher.sha256 === launcherSha256)
      matches.push({ id, directory: join(root, 'releases', id), ...parsed, launcherSha256, bytes: bytes! });
  }
  return matches.length === 1 ? matches[0]! : { id: null, launcherSha256 };
}

const check = (id: string, ok: boolean, message: string, nextStep: string, unverified = false): Diagnostic => ({
  id,
  status: ok ? (unverified ? 'unverified' : 'ok') : 'blocked',
  message,
  nextStep,
});

function summary(inspection: StorageInspection): StorageSummary {
  if (inspection.kind === 'absent')
    return {
      state: 'absent',
      format: null,
      operational: null,
      paused: null,
      problems: [],
      preserved: null,
      stateDigest: null,
      activity: null,
      lifecycle: null,
      migrations: [],
    };
  return {
    state: 'present',
    format: inspection.format,
    operational: inspection.operational,
    paused: inspection.installation?.paused ?? null,
    problems: inspection.problems.map(problem => `${problem.code}: ${problem.detail}`),
    preserved: inspection.preserved,
    stateDigest: inspection.stateDigest,
    activity: inspection.activity,
    lifecycle: inspection.installation?.lifecycle ?? null,
    migrations: inspection.installation?.migrations ?? [],
  };
}

/** Every compatibility verification of spec §11.4 step 3, read-only, BEFORE anything is changed. */
async function compatibility(context: UpgradeContext, phase: 'before-migration' | 'after-migration') {
  const { root, target } = context;
  const checks: Diagnostic[] = [];
  const support = releaseStorageSupport(target.manifest);
  // Target release: integrity, location, private Node and its guest assets (selection is what the upgrade changes).
  const targetBlocked = target.checks.filter(item => item.status === 'blocked' && item.id !== 'release:selected');
  checks.push(
    check(
      'upgrade:target',
      targetBlocked.length === 0,
      targetBlocked.length === 0
        ? `Release ${target.manifest.release} verified next to the previous one (manifest ${target.manifestSha256}).`
        : `Target release not verified: ${targetBlocked.map(item => `${item.id} ${item.message}`).join('; ')}`,
      'Extract the new archive unchanged into releases/<new id> of this root (never over an existing release) and verify it; never repair in place.',
    ),
  );
  const selected = await selectedRelease(root);
  let previous: Awaited<ReturnType<typeof selectedRelease>> = selected;
  if (selected.id === null) {
    checks.push(
      check(
        'upgrade:previous',
        false,
        '<root>/factory selects no installed release (missing, edited or ambiguous launcher).',
        'Inspect the installation; the explicit selection is never guessed or repaired by the upgrade.',
      ),
    );
  } else {
    const intact = await verifyReleaseTree(selected.directory);
    const differs = selected.id !== target.manifest.release;
    checks.push(
      check(
        'upgrade:previous',
        intact.kind === 'release' && differs,
        !differs
          ? `Release ${selected.id} is already selected.`
          : intact.kind === 'release'
            ? `Currently selected release ${selected.id} is preserved intact (manifest ${selected.manifestSha256}).`
            : `Selected release ${selected.id} does not match its manifest (${intact.kind === 'invalid' ? intact.code : intact.kind}).`,
        'The previous release stays installed and unchanged; it can be reselected only while the storage stays in a format it operates.',
      ),
    );
    previous = selected;
  }
  // Configuration and worker profile of the target, exactly as its controller would validate them (no partial application).
  const configuration = await readConfiguration(root, target.guestAssets);
  const models = configuration.configuration.valid ? productionModelChecks(configuration.configuration.effective.models) : [];
  const modelsOk = models.every(item => item.status === 'ok');
  checks.push(
    check(
      'upgrade:configuration',
      configuration.configuration.valid && modelsOk,
      configuration.configuration.valid
        ? modelsOk
          ? 'config.yaml is valid for the target release and names its worker profile for every role.'
          : `Worker profile unsupported: ${models
              .filter(item => item.status !== 'ok')
              .map(item => item.id)
              .join(', ')}.`
        : `config.yaml is invalid for the target release: ${configuration.configuration.errors.map(error => `${error.code} ${error.path}`).join('; ')}.`,
      'Fix config.yaml explicitly before upgrading; the upgrade never edits configuration.',
    ),
  );
  // Storage backend/schema, documents, registry, pause and stop evidence.
  const inspection = await inspectStorage(context.storagePath);
  const storageSummary = summary(inspection);
  let required: string | null = null;
  if (inspection.kind === 'storage') {
    const formatOk =
      inspection.operational !== 'incompatible' &&
      (inspection.format === null || inspection.format === support.format || support.migratesFrom.includes(inspection.format));
    if (inspection.format !== null && inspection.format !== support.format && formatOk) {
      required = controlStorageMigrations.find(item => item.from === inspection.format && item.to === support.format)?.id ?? null;
    }
    checks.push(
      check(
        'upgrade:storage',
        formatOk && (phase === 'before-migration' || required === null),
        inspection.operational === 'incompatible'
          ? `Storage incompatible with release ${target.manifest.release}: ${inspection.problems.map(problem => problem.code).join(', ')}.`
          : required
            ? `Storage format ${inspection.format} needs the supported migration ${required} to format ${support.format} (requested explicitly only).`
            : `Storage format ${inspection.format ?? 'empty'} is operated by release ${target.manifest.release} (Pi Durable schema ${inspection.backend.durableSchema ?? 'none'}).`,
        'An incompatible storage blocks the upgrade: never delete or resubmit tasks or documents to get around it; keep the previous release.',
      ),
    );
    checks.push(
      check(
        'upgrade:registry',
        inspection.tasks.count === 0,
        inspection.tasks.count === 0
          ? 'No persisted Pi Durable task; the target registers none (compatible registry).'
          : `Persisted task kinds ${inspection.tasks.kinds.join(', ')} have no definition in the target release.`,
        'Never delete or resubmit tasks to get around an incompatible registry.',
      ),
    );
    const paused = inspection.installation?.paused;
    checks.push(
      check(
        'upgrade:pause',
        paused === true || inspection.format === null,
        paused === true
          ? 'Installation paused: the new release starts paused.'
          : inspection.format === null
            ? 'Empty storage: nothing to pause.'
            : 'Installation not paused.',
        'With the current release: `factory pause`, then stop the controller (Ctrl+C or service stop) and confirm the clean exit; then check again.',
      ),
    );
    const lifecycle = inspection.installation?.lifecycle as
      { current: { runId: string } | null; last: { end: string; runId: string; reconciliationPending?: boolean } | null } | null | undefined;
    const settled = inspection.activity.unsettled.length === 0 && inspection.activity.heldSlots === 0;
    // Clean-stop evidence: the recorded clean end of the last run, or (no end recorded: format 1, or no run since a migration) durably
    // settled activity. A run that never recorded its end (crash/forced stop) or an unsettled activity blocks until a reconciling boot settles it.
    const stop = lifecycle?.current
      ? { ok: false, message: `Controller run ${lifecycle.current.runId} never recorded its end (crash or forced stop).` }
      : lifecycle?.last?.end === 'clean' && !lifecycle.last.reconciliationPending && settled
        ? { ok: true, message: 'The last controller run recorded a clean stop (confirmed cessation and persistence).' }
        : lifecycle?.last && lifecycle.last.end !== 'clean'
          ? { ok: false, message: `The last run ended ${lifecycle.last.end}, not clean: a reconciling boot (ticket 26) must settle it.` }
          : lifecycle?.last?.reconciliationPending
            ? {
                ok: false,
                message: `An earlier interruption was never settled: run ${lifecycle.last.runId} stopped cleanly but did not perform the boot reconciliation (ticket 26).`,
              }
            : settled
              ? {
                  ok: true,
                  message: 'No run end is recorded (format 1, or no run since a migration); the durable state proves no unsettled Execution and no held Slot.',
                }
              : {
                  ok: false,
                  message: `No clean stop is recorded and ${inspection.activity.unsettled.length} Execution(s) are unsettled / ${inspection.activity.heldSlots} Slot(s) held.`,
                };
    checks.push(
      check(
        'upgrade:stop',
        stop.ok,
        stop.message,
        'Start the current release, let its boot reconcile the interrupted activity (cessation confirmed, Slots released), keep it paused and stop it cleanly; a stop intention never turns a crash into a clean stop.',
      ),
    );
  } else {
    checks.push(check('upgrade:storage', true, 'No Control storage yet: nothing to migrate or preserve.', 'Nothing to do.'));
  }
  // Protocol: no protocol state is persisted; CLI and controller always come from the selected release (no multi-version negotiation).
  const previousProtocol =
    previous.id !== null ? ((previous as { manifest: ReleaseManifest }).manifest.metadata.protocol as { version?: unknown } | undefined) : undefined;
  checks.push(
    check(
      'upgrade:protocol',
      true,
      `Target speaks local protocol ${protocolVersion}; previous ${previousProtocol?.version ?? 'unknown'}. No protocol state is persisted and no previous owner runs (lock held).`,
      'After selection, use only the new launcher; an old CLI is refused by the single supported format.',
    ),
  );
  // Worker profile, skill packs and preserved sessions: continued only when compatible, otherwise replaced with a recorded reason (ticket 11).
  const previousProduction =
    previous.id !== null
      ? ((previous as { manifest: ReleaseManifest }).manifest.production as { sdkProfileId?: unknown; builder?: { skillPack?: unknown } })
      : undefined;
  const targetPack = (target.manifest.production as { builder?: { skillPack?: unknown } }).builder?.skillPack;
  const sameProfile = previousProduction?.sdkProfileId === productionProfile.sdkProfileId;
  const sessions = inspection.kind === 'storage' ? (inspection.preserved?.sessions ?? 0) : 0;
  const packKnown = previousProduction?.builder?.skillPack === undefined || factorySkillPackIds.includes(previousProduction.builder.skillPack as never);
  checks.push(
    check(
      'upgrade:profiles',
      packKnown,
      `Worker profile ${sameProfile ? 'unchanged' : `changes to ${productionProfile.sdkProfileId}`}; Builder skill pack ${String(previousProduction?.builder?.skillPack ?? 'unknown')} → ${String(targetPack ?? 'unknown')}; ${sessions} preserved Builder session(s): each next activation continues a session only when compatible, otherwise replaces it with a recorded reason and recoverable context.`,
      'No session is converted or migrated; an incompatible session is replaced explicitly at its next activation.',
    ),
  );
  // Environments: disks/bases are never migrated; a disk prepared with other guest assets or another profile cannot be booted by the target.
  const environments = await environmentDependencies(root);
  const targetPin = await realpath(target.guestAssets.directory).catch(() => target.guestAssets.directory);
  const incompatible = [];
  for (const item of environments) {
    const pinned = item.guestAssets ? await realpath(item.guestAssets.directory).catch(() => item.guestAssets!.directory) : null;
    if (
      !item.guestAssets ||
      pinned !== targetPin ||
      item.guestAssets.manifestSha256 !== target.guestAssets.manifestSha256 ||
      item.profile !== productionProfile.sandboxProfile
    )
      incompatible.push(item.environment);
  }
  checks.push(
    check(
      'upgrade:environments',
      incompatible.length === 0,
      incompatible.length === 0
        ? `${environments.length} persistent environment(s) depend on guest assets ${target.guestAssets.manifestSha256}, which the target uses unchanged.`
        : `Environment(s) ${incompatible.join(', ')} depend on other guest assets/profile or are unreadable; disks are never migrated.`,
      'Keep the previous release, or finish and explicitly clean up the dependent Works first; assets are never removed while disks depend on them.',
    ),
  );
  return { checks, inspection, storage: storageSummary, required, previous, support };
}

function launcherFor(manifest: ReleaseManifest): string {
  const bytes = releaseLauncher(manifest.release);
  if (sha(bytes) !== manifest.launcher.sha256) throw new Error('UPGRADE_LAUNCHER_MISMATCH');
  return bytes;
}
async function select(root: string, bytes: string | Buffer, expectedSha256: string) {
  if (sha(bytes) !== expectedSha256) throw new Error('UPGRADE_LAUNCHER_MISMATCH');
  const current = await readFile(join(root, 'factory')).catch(() => undefined);
  if (current && sha(current) === expectedSha256) return; // Already selected (resume after the rename).
  await writeAtomically(join(root, 'factory'), bytes, 0o755);
}
/**
 * The launcher in place from the journal until the end of the upgrade: it selects NO release and starts nothing, so neither the previous
 * release (a pre-33 one cannot read the journal) nor the new one can run, inspect or unpause during the upgrade (ticket 33 review).
 */
export const guardLauncher = (journal: Pick<UpgradeJournal, 'upgradeId' | 'to'>) => `#!/bin/sh
# Software Factory installation launcher DURING upgrade ${journal.upgradeId} to release ${journal.to.release}: it selects no release and starts nothing.
echo '{"code":"UPGRADE_INCOMPLETE","upgradeId":"${journal.upgradeId}","release":"${journal.to.release}","message":"An upgrade is in progress: run upgrade status, resume or rollback with releases/${journal.to.release}. Nothing was started."}' >&2
exit 2
`;

function report(command: UpgradeCommand, code: string, context: UpgradeContext, fields: Partial<UpgradeReport> & { nextStep: string }): UpgradeReport {
  return {
    code,
    command,
    from: null,
    to: { release: context.target.manifest.release },
    journal: null,
    storage: null,
    migration: { required: null, requested: null },
    checks: [],
    ...fields,
  };
}
const startStep =
  'Start the controller with `./factory run` (the installation stays paused), inspect `./factory status`, `list`, `show <work>` and pending Questions (answerable), then `./factory unpause`.';
const verificationStep =
  'Nothing is selected and the guard launcher stays: the storage no longer matches what this upgrade verified. Inspect it (`upgrade status`). ' +
  'While it is still in the previous format, `upgrade rollback` reselects the previous release; otherwise restore your own external storage protection to the ' +
  'pre-upgrade copy (outside the Factory; GitHub is never undone) and run `upgrade resume`, which verifies again before anything.';

/** The storage is exactly what this upgrade verified (and, after the migration, carries its own migration record). */
async function verifiedStorage(context: UpgradeContext, journal: UpgradeJournal, migrated: boolean) {
  const inspection = await inspectStorage(context.storagePath);
  if (inspection.kind === 'absent') return { ok: journal.expected.preservedDigest === null, inspection };
  const own = (inspection.installation?.migrations ?? []).some(item => (item as { upgradeId?: unknown }).upgradeId === journal.upgradeId);
  const ok =
    inspection.operational !== 'incompatible' &&
    inspection.preserved?.digest === journal.expected.preservedDigest &&
    (!migrated || (inspection.format === journal.to.storageFormat && own));
  return { ok, inspection };
}

async function finish(context: UpgradeContext, journal: UpgradeJournal, command: UpgradeCommand): Promise<UpgradeReport> {
  const { root, target } = context;
  const blockedReport = (code: string, inspection: StorageInspection, nextStep = verificationStep) =>
    report(command, code, context, { journal, storage: summary(inspection), from: { release: journal.from.release }, nextStep });
  if (journal.state === 'guarding') {
    await select(root, guardLauncher(journal), sha(guardLauncher(journal)));
    await saveJournal(root, journal, journal.migration ? 'migrating' : 'selecting');
    await context.observe?.('journal');
  }
  if (journal.state === 'migrating') {
    if (!journal.migration) throw new Error('UPGRADE_JOURNAL_INCONSISTENT');
    const result = await migrateStorage(context.storagePath, {
      upgradeId: journal.upgradeId,
      release: journal.to.release,
      previousRelease: journal.from.release,
      ...(journal.expected.preservedDigest ? { expectedDigest: journal.expected.preservedDigest } : {}),
    });
    if (result.kind === 'refused')
      return blockedReport(result.code === 'MIGRATION_VERIFICATION_FAILED' ? 'UPGRADE_VERIFICATION_FAILED' : 'UPGRADE_MIGRATION_REFUSED', result.inspection);
    // Only this upgrade's own record proves its migration; a format change by anyone else is never adopted.
    if (result.kind === 'not-needed') return blockedReport('UPGRADE_MIGRATION_UNPROVEN', result.inspection);
    await saveJournal(root, journal, 'migrated');
    await context.observe?.('migrated');
  }
  if (journal.state === 'migrated' || journal.state === 'selecting') {
    // Always re-verified before the selection (resume included): never select on an unverified storage.
    const verified = await verifiedStorage(context, journal, journal.migration !== null);
    if (!verified.ok) return blockedReport('UPGRADE_VERIFICATION_FAILED', verified.inspection);
    if (journal.state === 'migrated') await saveJournal(root, journal, 'selecting');
    await select(root, launcherFor(target.manifest), journal.to.launcherSha256);
    await context.observe?.('selected');
    await saveJournal(root, journal, 'completed');
  }
  return report(command, 'UPGRADE_COMPLETED', context, {
    journal,
    from: { release: journal.from.release },
    storage: summary(await inspectStorage(context.storagePath)),
    nextStep: startStep,
  });
}

/** The upgrade commands. The caller holds the canonical-storage flock (no controller runs) for the whole call. */
export async function upgrade(context: UpgradeContext, command: UpgradeCommand, options: { migrate?: string } = {}): Promise<UpgradeReport> {
  const { root, target } = context;
  const journal = await readJournal(root);
  if (journal === 'invalid') {
    return report(command, 'UPGRADE_JOURNAL_INVALID', context, {
      nextStep: 'Inspect data/upgrade/journal.json manually; it is never repaired or replaced automatically.',
    });
  }
  const open = journal && !terminal(journal.state) ? journal : null;
  if (command === 'status') {
    const inspection = await inspectStorage(context.storagePath);
    return report(
      command,
      open ? 'UPGRADE_INCOMPLETE' : journal ? `UPGRADE_${journal.state === 'completed' ? 'COMPLETED' : 'ROLLED_BACK'}` : 'UPGRADE_NONE',
      context,
      {
        journal: journal ?? null,
        storage: summary(inspection),
        from: journal ? { release: journal.from.release } : null,
        nextStep: open
          ? '`upgrade resume` completes this upgrade; `upgrade rollback` reselects the previous release only while the storage is in a format it operates.'
          : 'Nothing pending.',
      },
    );
  }
  if (command === 'resume' || command === 'rollback') {
    if (!journal || (command === 'resume' && !open))
      return report(command, 'UPGRADE_NOT_IN_PROGRESS', context, { journal: journal ?? null, nextStep: 'Nothing to resume.' });
    if (journal.to.release !== target.manifest.release || journal.to.manifestSha256 !== target.manifestSha256) {
      return report(command, 'UPGRADE_WRONG_RELEASE', context, {
        journal,
        nextStep: `Run this command with release ${journal.to.release}, the one that started the upgrade.`,
      });
    }
    if (command === 'resume') {
      // Re-verified before continuing: the target, the configuration and (while not migrated yet) the full storage compatibility.
      const verified = await compatibility(context, journal.state === 'migrating' || journal.state === 'guarding' ? 'before-migration' : 'after-migration');
      const blocked = verified.checks.filter(item => item.status === 'blocked' && item.id !== 'upgrade:previous');
      if (blocked.length)
        return report(command, 'UPGRADE_INCOMPATIBLE', context, {
          journal,
          checks: verified.checks,
          storage: verified.storage,
          from: { release: journal.from.release },
          nextStep: 'Resolve the blocked checks (nothing was changed by this resume), then resume again, or roll back while still possible.',
        });
      return finish(context, journal, command);
    }
    if (journal.state === 'rolled-back') return report(command, 'UPGRADE_NOT_IN_PROGRESS', context, { journal, nextStep: 'Already rolled back.' });
    // Rollback: only to the recorded previous release, with the same pre-checks as an apply TO it (pause, stop, registry, configuration,
    // environments/assets, storage format it operates); an unknown format (no storage) is refused.
    const previousDirectory = join(root, 'releases', journal.from.release);
    const intact = await verifyReleaseTree(previousDirectory);
    if (intact.kind !== 'release' || intact.manifestSha256 !== journal.from.manifestSha256 || intact.manifest.launcher.sha256 !== journal.from.launcherSha256) {
      return report(command, 'ROLLBACK_PREVIOUS_RELEASE_INVALID', context, {
        journal,
        nextStep: 'The previous release no longer matches its manifest; reselecting it is refused.',
      });
    }
    const inspection = await inspectStorage(context.storagePath);
    const format = inspection.kind === 'storage' ? inspection.format : null;
    if (format === null) {
      return report(command, 'ROLLBACK_FORMAT_UNKNOWN', context, {
        journal,
        storage: summary(inspection),
        from: { release: journal.from.release },
        nextStep: `No storage format is established; keep ${journal.to.release} (\`upgrade resume\` if incomplete). A rollback needs a storage in a format the previous release operates.`,
      });
    }
    if (format !== journal.from.storageFormat) {
      return report(command, 'ROLLBACK_FORMAT_UNSUPPORTED', context, {
        journal,
        storage: summary(inspection),
        from: { release: journal.from.release },
        nextStep: `Release ${journal.from.release} operates storage format ${journal.from.storageFormat} only; this storage is format ${format}. There is no universal rollback: keep ${journal.to.release}, or restore your own external storage protection (outside the Factory; GitHub is never undone).`,
      });
    }
    // config.yaml is validated with THIS release's rules, which is valid for the previous release only when it declares the same schema.
    const previousConfiguration = (intact.manifest.metadata.formats as { configuration?: unknown } | undefined)?.configuration;
    if (previousConfiguration !== configurationSchemaVersion) {
      return report(command, 'ROLLBACK_CONFIGURATION_UNVERIFIABLE', context, {
        journal,
        storage: summary(inspection),
        from: { release: journal.from.release },
        nextStep: `Release ${journal.from.release} declares configuration schema ${String(previousConfiguration ?? 'none')}, not ${configurationSchemaVersion}: this release cannot verify config.yaml for it, so the rollback is refused. Keep ${journal.to.release}.`,
      });
    }
    const towards: UpgradeContext = {
      ...context,
      target: {
        directory: previousDirectory,
        manifest: intact.manifest,
        manifestSha256: intact.manifestSha256,
        checks: [],
        guestAssets: { directory: join(root, intact.manifest.guestAssets.path), manifestSha256: intact.manifest.guestAssets.manifestSha256 },
      },
    };
    const prechecks = await compatibility(towards, 'after-migration');
    const refused = prechecks.checks.filter(item => item.status === 'blocked' && item.id !== 'upgrade:previous' && item.id !== 'upgrade:target');
    if (refused.length) {
      return report(command, 'ROLLBACK_INCOMPATIBLE', context, {
        journal,
        checks: refused,
        storage: prechecks.storage,
        from: { release: journal.from.release },
        nextStep: 'Nothing was changed. Resolve the blocked checks (each has its next step) and roll back again.',
      });
    }
    // Exactly the bytes hashed when the previous selection was identified (kept at apply time).
    const bytes = await readFile(previousLauncherPath(root, journal.upgradeId));
    await select(root, bytes, journal.from.launcherSha256);
    await saveJournal(root, journal, 'rolled-back');
    return report(command, 'UPGRADE_ROLLED_BACK', context, {
      journal,
      from: { release: journal.from.release },
      storage: summary(inspection),
      nextStep: `Release ${journal.from.release} is selected again; start it with ./factory run (still paused).`,
    });
  }
  if (open) return report(command, 'UPGRADE_IN_PROGRESS', context, { journal: open, nextStep: '`upgrade resume` or `upgrade rollback` first.' });
  const verified = await compatibility(context, 'before-migration');
  const blocked = verified.checks.filter(item => item.status === 'blocked');
  const fields = {
    checks: verified.checks,
    storage: verified.storage,
    from: verified.previous.id ? { release: verified.previous.id } : null,
    migration: { required: verified.required, requested: options.migrate ?? null },
  };
  if (blocked.length) {
    return report(command, 'UPGRADE_INCOMPATIBLE', context, {
      ...fields,
      nextStep:
        'Nothing was changed. Resolve every blocked check (see nextStep of each); incompatible state is never deleted, resubmitted or migrated implicitly.',
    });
  }
  if (options.migrate !== undefined && options.migrate !== verified.required) {
    return report(command, 'UPGRADE_MIGRATION_NOT_APPLICABLE', context, {
      ...fields,
      nextStep: verified.required ? `Request exactly --migrate ${verified.required}.` : 'No migration is needed; apply without --migrate.',
    });
  }
  if (command === 'check') {
    return report(command, verified.required ? 'UPGRADE_MIGRATION_REQUIRED' : 'UPGRADE_COMPATIBLE', context, {
      ...fields,
      nextStep: verified.required
        ? `Apply with the explicit request: upgrade apply --migrate ${verified.required} (the previous release cannot operate the migrated storage).`
        : 'upgrade apply',
    });
  }
  if (verified.required && options.migrate !== verified.required) {
    return report(command, 'UPGRADE_MIGRATION_NOT_REQUESTED', context, {
      ...fields,
      nextStep: `Nothing was changed. Request the migration explicitly: upgrade apply --migrate ${verified.required}.`,
    });
  }
  const previous = verified.previous as Extract<Awaited<ReturnType<typeof selectedRelease>>, { manifest: ReleaseManifest }>;
  const previousSupport = releaseStorageSupport(previous.manifest);
  const format = verified.inspection.kind === 'storage' ? (verified.inspection.format ?? verified.support.format) : verified.support.format;
  const created: UpgradeJournal = {
    version: 1,
    upgradeId: randomUUID(),
    createdAt: new Date().toISOString(),
    from: {
      release: previous.id,
      manifestSha256: previous.manifestSha256,
      launcherSha256: previous.launcherSha256,
      storageFormat: verified.required ? format : previousSupport.format,
      migratesFrom: previousSupport.migratesFrom,
    },
    to: {
      release: target.manifest.release,
      manifestSha256: target.manifestSha256,
      launcherSha256: target.manifest.launcher.sha256,
      storageFormat: verified.support.format,
      migratesFrom: verified.support.migratesFrom,
    },
    migration: verified.required,
    expected: { preservedDigest: verified.inspection.kind === 'storage' ? (verified.inspection.preserved?.digest ?? null) : null },
    state: 'guarding',
    steps: [],
  };
  launcherFor(target.manifest); // The shipped launcher must reproduce the manifest pin BEFORE anything is written.
  await mkdir(journalDirectory(root), { mode: 0o700, recursive: true });
  // A closed earlier upgrade keeps its journal under its own id (history; never reused).
  if (journal && terminal(journal.state)) await rename(journalPath(root), join(journalDirectory(root), `${journal.upgradeId}.journal.json`));
  // The previous selection is kept byte-for-byte for rollback (the launcher only, never a copy of storage).
  await writeAtomically(previousLauncherPath(root, created.upgradeId), previous.bytes, 0o600);
  await saveJournal(root, created, created.state);
  const result = await finish(context, created, command);
  return { ...result, checks: verified.checks, migration: fields.migration };
}

/** Controller boot guard (spec §11.4): an incomplete or unreadable upgrade journal keeps the controller from opening the storage. */
export async function upgradeBlocksStart(root: string): Promise<{ code: string; nextStep: string } | null> {
  const journal = await readJournal(root);
  if (journal === null || (journal !== 'invalid' && terminal(journal.state))) return null;
  return journal === 'invalid'
    ? { code: 'UPGRADE_JOURNAL_INVALID', nextStep: 'Inspect data/upgrade/journal.json; it is never repaired automatically.' }
    : {
        code: 'UPGRADE_INCOMPLETE',
        nextStep: `Upgrade ${journal.upgradeId} to ${journal.to.release} stopped at ${journal.state}: run \`upgrade resume\` or \`upgrade rollback\` with release ${journal.to.release}.`,
      };
}

async function main(args: string[]): Promise<number> {
  process.umask(0o077);
  const [rootArgument, command, ...rest] = args;
  const commands: UpgradeCommand[] = ['check', 'apply', 'status', 'resume', 'rollback'];
  if (!rootArgument || !commands.includes(command as UpgradeCommand)) {
    console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS' }));
    return 2;
  }
  let migrate: string | undefined;
  if (rest.length === 2 && rest[0] === '--migrate' && (command === 'apply' || command === 'check')) migrate = rest[1];
  else if (rest.length) {
    console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS' }));
    return 2;
  }
  const paths = await controllerPaths(rootArgument);
  await verifyControllerLock(paths.lockPath);
  const release = await inspectRelease(paths.root);
  if (!release.manifest || !release.guestAssets) {
    console.error(
      JSON.stringify({
        code: 'UPGRADE_TARGET_INVALID',
        checks: release.checks.filter(item => item.status !== 'ok').map(item => ({ id: item.id, message: item.message })),
        message: 'Run the upgrade with the verified new release installed in releases/<id> of this root; nothing was changed.',
      }),
    );
    return 2;
  }
  const result = await upgrade(
    {
      root: paths.root,
      storagePath: paths.storagePath,
      target: {
        directory: await realpath(applicationRoot()),
        manifest: release.manifest,
        manifestSha256: release.release!.manifestSha256,
        checks: release.checks,
        guestAssets: release.guestAssets,
      },
    },
    command as UpgradeCommand,
    migrate ? { migrate } : {},
  );
  console.log(JSON.stringify(result, null, 1));
  return ['UPGRADE_COMPATIBLE', 'UPGRADE_MIGRATION_REQUIRED', 'UPGRADE_COMPLETED', 'UPGRADE_ROLLED_BACK', 'UPGRADE_NONE'].includes(result.code) ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      JSON.stringify({
        code: 'UPGRADE_FAILED',
        ...startFailureCause(error),
        message: 'Nothing is retried or repaired: `upgrade status` shows the journal; resume or roll back explicitly.',
      }),
    );
    process.exitCode = 4;
  }
}
