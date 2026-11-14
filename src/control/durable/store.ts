import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createSession } from '@earendil-works/pi-durable';
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
Promise<{ session: Session; persistence: Persistence; close(): Promise<void> }> {
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
      async close() { await opened.close(BACKGROUND_CONTEXT); } };
  } catch (error) {
    if (session) await session.close(BACKGROUND_CONTEXT).catch(() => {});
    else if (closeStorage) await closeStorage().catch(() => {});
    else await database.close().catch(() => {});
    throw error;
  }
}
