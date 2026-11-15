import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { installation, type ControllerRunEnd } from './admission.js';
import type { JsonObject } from '@earendil-works/pi-durable';
import { currentFormat, inspectStorage, preservedCanonical, supportedMigrations, type StorageInspection } from './format.js';
import { openStore, type Session } from './store.js';

export type MigrationResult =
  | { kind: 'not-needed'; inspection: StorageInspection }
  | { kind: 'already-applied'; inspection: StorageInspection }
  | { kind: 'migrated'; migration: string; before: StorageInspection; after: StorageInspection }
  | { kind: 'refused'; code: 'STORAGE_INCOMPATIBLE' | 'MIGRATION_NOT_SUPPORTED' | 'MIGRATION_VERIFICATION_FAILED'; inspection: StorageInspection };

const preserved = (inspection: StorageInspection) => inspection.kind === 'storage' ? JSON.stringify(inspection.preserved) : null;
const applied = (inspection: StorageInspection, upgradeId: string) => inspection.kind === 'storage' &&
  (inspection.installation?.migrations ?? []).some(item => (item as { upgradeId?: unknown }).upgradeId === upgradeId);

/**
 * Ticket 33 (spec §11.4 step 4): the ONLY supported migration, executed only when the upgrade explicitly requests it, as ONE Session
 * commit (all or nothing: an interruption leaves format 1 untouched, or format 2 complete with this upgrade's record). Idempotent per
 * `upgradeId`, so an interrupted upgrade can complete it. Afterwards the preserved documents (ids, index/cycles, FIFO sequence, Questions and
 * answers, Slots/reservations, limits, effects, history) must be EXACTLY those before, or the result is an error. The caller holds the flock.
 */
export async function migrateStorage(storagePath: string, input: { upgradeId: string; release: string; previousRelease: string | null;
  /** The preserved digest the upgrade recorded before migrating: verified BEFORE the commit, and again for an already-applied migration. */
  expectedDigest?: string }): Promise<MigrationResult> {
  const before = await inspectStorage(storagePath);
  if (before.kind === 'storage' && before.operational === 'incompatible') return { kind: 'refused', code: 'STORAGE_INCOMPATIBLE', inspection: before };
  if (before.kind === 'absent' || before.format === null) return { kind: 'not-needed', inspection: before };
  const expected = (inspection: StorageInspection) => input.expectedDigest === undefined || (inspection.kind === 'storage' && inspection.preserved?.digest === input.expectedDigest);
  if (before.format === currentFormat) {
    if (!applied(before, input.upgradeId)) return { kind: 'not-needed', inspection: before };
    return expected(before) ? { kind: 'already-applied', inspection: before } : { kind: 'refused', code: 'MIGRATION_VERIFICATION_FAILED', inspection: before };
  }
  const migration = supportedMigrations.find(item => item.from === before.format && item.to === currentFormat);
  if (!migration) return { kind: 'refused', code: 'MIGRATION_NOT_SUPPORTED', inspection: before };
  if (!expected(before)) return { kind: 'refused', code: 'MIGRATION_VERIFICATION_FAILED', inspection: before };
  const unchanged = before.installation?.preservedCanonical;
  const store = await openStore(storagePath, { purpose: 'migration' });
  try {
    try { await store.session.commit(async tx => {
      // Read at version 1 and converted in memory by the definition; this commit is the only one that persists version 2.
      const current = await tx.doc(installation);
      // Verified BEFORE the commit: the converted document keeps exactly the preserved fields (the other documents are not written).
      if (preservedCanonical(JSON.parse(JSON.stringify(current)) as JsonObject) !== unchanged) throw new Error('MIGRATION_VERIFICATION_FAILED');
      current.storage.migrations.push({ upgradeId: input.upgradeId, migration: migration.id, from: migration.from, to: migration.to,
        at: new Date().toISOString(), release: input.release, previousRelease: input.previousRelease });
    }, BACKGROUND_CONTEXT); }
    catch (error) {
      if (error instanceof Error && error.message === 'MIGRATION_VERIFICATION_FAILED') return { kind: 'refused', code: 'MIGRATION_VERIFICATION_FAILED', inspection: before };
      throw error;
    }
  } finally { await store.close(); }
  const after = await inspectStorage(storagePath);
  // Post-commit check: a mismatch here cannot be undone (no storage copy exists); the upgrade keeps the journal blocked (never selects).
  if (after.kind !== 'storage' || after.format !== currentFormat || after.operational !== 'ready' || preserved(after) !== preserved(before) || !applied(after, input.upgradeId)) {
    return { kind: 'refused', code: 'MIGRATION_VERIFICATION_FAILED', inspection: after };
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
    const pending = previous !== null && (previous.end !== 'clean' || (previous as ControllerRunEnd).reconciliationPending === true);
    doc.lifecycle.current = { runId, startedAt: new Date().toISOString(), pendingReconciliation: pending };
    return previous;
  }, BACKGROUND_CONTEXT);
}

/** Ticket 33: the end of this run, recorded only after the cessation/persistence outcome is known; never written for a crash. */
export async function recordRunEnd(session: Session, runId: string, end: ControllerRunEnd['end'], facts: { reconciled: boolean } = { reconciled: false }) {
  await session.commit(async tx => {
    const doc = await tx.doc(installation);
    if (doc.lifecycle.current?.runId !== runId) return;
    const pending = (doc.lifecycle.current.pendingReconciliation === true && !facts.reconciled) || end !== 'clean';
    doc.lifecycle.last = { runId: doc.lifecycle.current.runId, startedAt: doc.lifecycle.current.startedAt, endedAt: new Date().toISOString(), end,
      reconciled: facts.reconciled, reconciliationPending: pending };
    doc.lifecycle.current = null;
  }, BACKGROUND_CONTEXT);
}
