import { stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createSession } from '@earendil-works/pi-durable';
import type { ScrubResult, StorageScrub } from '../types.js';
import { examine, type StorageInspection } from './format.js';

export type Session = ReturnType<typeof createSession>;
export type Persistence = { sqliteVersion: string; sqliteSourceId: string; journalMode: 'wal'; synchronous: 'FULL' };

/** Ticket 33: the storage is not in this release's operational format; nothing was written. */
export class StorageFormatError extends Error {
  constructor(readonly code: 'STORAGE_MIGRATION_REQUIRED' | 'STORAGE_INCOMPATIBLE', readonly inspection: StorageInspection) { super(code); }
}

/**
 * Private Pi Durable/SQLite authority. Bootstrap must already hold the canonical-storage flock.
 * Ticket 33: the format is examined BEFORE any Session exists. An operational open accepts only the current format (or an empty
 * storage); `migration` additionally accepts a storage awaiting a supported migration, for the explicitly requested upgrade only.
 */
export async function openStore(storagePath: string, options: { purpose?: 'operational' | 'migration' } = {}):
Promise<{ session: Session; persistence: Persistence; close(): Promise<void> } & StorageScrub> {
  const database = await openNodeSqliteDatabase(storagePath);
  let session: Session | undefined;
  let closeStorage: (() => Promise<void>) | undefined;
  try {
    await database.exec('PRAGMA synchronous = FULL');
    const version = await database.get<{ version: string; source: string }>('SELECT sqlite_version() AS version, sqlite_source_id() AS source');
    const journal = await database.get<{ journal_mode: string }>('PRAGMA journal_mode');
    const sync = await database.get<{ synchronous: number }>('PRAGMA synchronous');
    const parts = version?.version.split('.').map(Number) ?? [];
    if (!version || parts.length !== 3 || parts.some(Number.isNaN) ||
      (parts[0]! * 1000000 + parts[1]! * 1000 + parts[2]!) < 3051003 || journal?.journal_mode !== 'wal' || sync?.synchronous !== 2) {
      throw new Error('UNSUPPORTED_SQLITE_DURABILITY');
    }
    // A Pi Durable schema other than the supported one is never opened (SqliteStorage.open would migrate it implicitly).
    const { inspection, storage } = await examine(database, { create: true });
    if (storage) closeStorage = () => storage.close(BACKGROUND_CONTEXT);
    const accepted = inspection.operational === 'ready' || (options.purpose === 'migration' && inspection.operational === 'migration-required');
    if (!storage || !accepted) {
      throw new StorageFormatError(inspection.operational === 'migration-required' ? 'STORAGE_MIGRATION_REQUIRED' : 'STORAGE_INCOMPATIBLE', inspection);
    }
    session = createSession(storage);
    const opened = session;
    return { session: opened, persistence: { sqliteVersion: version.version, sqliteSourceId: version.source, journalMode: 'wal', synchronous: 'FULL' },
      async close() { await opened.close(BACKGROUND_CONTEXT); },
      // D-07: VACUUM and checkpoint run on the SAME connection Pi Durable uses, through its serial queue: never inside or beside a transaction.
      vacuum: () => scrubStep(async () => { await database.exec('VACUUM'); return checkpointed(); }),
      checkpoint: () => scrubStep(checkpointed) };
    async function checkpointed(): Promise<ScrubResult> {
      // TRUNCATE: every WAL frame (old page images included) is copied back and the WAL file is cut to zero bytes. Busy = not complete.
      const result = await database.get<{ busy: number; log: number; checkpointed: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
      if (!result || result.busy !== 0 || result.log !== result.checkpointed) return { outcome: 'failed', code: 'SCRUB_CHECKPOINT_INCOMPLETE' };
      const wal = await stat(`${storagePath}-wal`).then(info => info.size, () => 0);
      return wal === 0 ? { outcome: 'scrubbed' } : { outcome: 'failed', code: 'SCRUB_WAL_NOT_TRUNCATED' };
    }
  } catch (error) {
    if (session) await session.close(BACKGROUND_CONTEXT).catch(() => {});
    else if (closeStorage) await closeStorage().catch(() => {});
    else await database.close().catch(() => {});
    throw error;
  }
}

/** A failed scrub step answers its SQLite code (e.g. `SQLITE_FULL`), never throws: the forget it follows is already committed. */
async function scrubStep(step: () => Promise<ScrubResult>): Promise<ScrubResult> {
  try { return await step(); } catch (error) {
    const code = error && typeof error === 'object' && 'errcode' in error && typeof error.errcode === 'number' ? sqliteCodes[error.errcode & 0xff] ?? `SQLITE_${error.errcode & 0xff}` : null;
    return { outcome: 'failed', code: code ?? 'SCRUB_FAILED' };
  }
}
const sqliteCodes: Record<number, string> = { 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 7: 'SQLITE_NOMEM', 8: 'SQLITE_READONLY', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 13: 'SQLITE_FULL' };
