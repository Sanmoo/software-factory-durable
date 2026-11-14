import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { installation, type ControllerRunEnd } from './admission.js';
import { currentFormat, inspectStorage, supportedMigrations, type StorageInspection } from './format.js';
import { openStore, type Session } from './store.js';

export type MigrationResult =
  | { kind: 'not-needed'; inspection: StorageInspection }
  | { kind: 'already-applied'; inspection: StorageInspection }
  | { kind: 'migrated'; migration: string; before: StorageInspection; after: StorageInspection }
  | { kind: 'refused'; code: 'STORAGE_INCOMPATIBLE' | 'MIGRATION_NOT_SUPPORTED'; inspection: StorageInspection };

const preserved = (inspection: StorageInspection) => inspection.kind === 'storage' ? JSON.stringify(inspection.preserved) : null;
const applied = (inspection: StorageInspection, upgradeId: string) => inspection.kind === 'storage' &&
  (inspection.installation?.migrations ?? []).some(item => (item as { upgradeId?: unknown }).upgradeId === upgradeId);

/**
 * Ticket 33 (spec §11.4 step 4): the ONLY supported migration, executed only when the upgrade explicitly requests it, as ONE Session
 * commit (all or nothing: an interruption leaves format 1 untouched, or format 2 complete with this upgrade's record). Idempotent per
 * `upgradeId`, so an interrupted upgrade can complete it. Afterwards the preserved documents (ids, index/cycles, FIFO sequence, Questions and
 * answers, Slots/reservations, limits, effects, history) must be EXACTLY those before, or the result is an error. The caller holds the flock.
 */
export async function migrateStorage(storagePath: string, input: { upgradeId: string; release: string; previousRelease: string | null }): Promise<MigrationResult> {
  const before = await inspectStorage(storagePath);
  if (before.kind === 'absent' || before.format === null) return { kind: 'not-needed', inspection: before };
  if (before.operational === 'incompatible') return { kind: 'refused', code: 'STORAGE_INCOMPATIBLE', inspection: before };
  if (before.format === currentFormat) return applied(before, input.upgradeId) ? { kind: 'already-applied', inspection: before } : { kind: 'not-needed', inspection: before };
  const migration = supportedMigrations.find(item => item.from === before.format && item.to === currentFormat);
  if (!migration) return { kind: 'refused', code: 'MIGRATION_NOT_SUPPORTED', inspection: before };
  const store = await openStore(storagePath, { purpose: 'migration' });
  try {
    await store.session.commit(async tx => {
      // Read at version 1 and converted in memory by the definition; this commit is the only one that persists version 2.
      const current = await tx.doc(installation);
      current.storage.migrations.push({ upgradeId: input.upgradeId, migration: migration.id, from: migration.from, to: migration.to,
        at: new Date().toISOString(), release: input.release, previousRelease: input.previousRelease });
    }, BACKGROUND_CONTEXT);
  } finally { await store.close(); }
  const after = await inspectStorage(storagePath);
  if (after.kind !== 'storage' || after.format !== currentFormat || after.operational !== 'ready' || preserved(after) !== preserved(before) || !applied(after, input.upgradeId)) {
    throw new Error('MIGRATION_VERIFICATION_FAILED');
  }
  return { kind: 'migrated', migration: migration.id, before, after };
}

/** Ticket 33: the run of THIS owner begins (committed before polling or any dispatch). An earlier `current` left behind is a crash. */
export async function recordRunStart(session: Session, runId: string): Promise<ControllerRunEnd | { runId: string; startedAt: string; end: 'crash' } | null> {
  return session.commit(async tx => {
    const doc = await tx.doc(installation);
    // Plain copies: transaction documents are not readable after the commit.
    const previous = doc.lifecycle.current ? { runId: doc.lifecycle.current.runId, startedAt: doc.lifecycle.current.startedAt, end: 'crash' as const }
      : doc.lifecycle.last ? JSON.parse(JSON.stringify(doc.lifecycle.last)) as ControllerRunEnd : null;
    doc.lifecycle.current = { runId, startedAt: new Date().toISOString() };
    return previous;
  }, BACKGROUND_CONTEXT);
}

/** Ticket 33: the end of this run, recorded only after the cessation/persistence outcome is known; never written for a crash. */
export async function recordRunEnd(session: Session, runId: string, end: ControllerRunEnd['end']) {
  await session.commit(async tx => {
    const doc = await tx.doc(installation);
    if (doc.lifecycle.current?.runId !== runId) return;
    doc.lifecycle.last = { runId: doc.lifecycle.current.runId, startedAt: doc.lifecycle.current.startedAt, endedAt: new Date().toISOString(), end };
    doc.lifecycle.current = null;
  }, BACKGROUND_CONTEXT);
}
