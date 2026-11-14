import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createSession } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';

export type Session = ReturnType<typeof createSession>;
export type Persistence = { sqliteVersion: string; sqliteSourceId: string; journalMode: 'wal'; synchronous: 'FULL' };

/** Private Pi Durable/SQLite authority. Bootstrap must already hold the canonical-storage flock. */
export async function openStore(storagePath: string): Promise<{ session: Session; persistence: Persistence; close(): Promise<void> }> {
  const database = await openNodeSqliteDatabase(storagePath);
  let session: Session | undefined;
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
    session = createSession(await SqliteStorage.open(database));
    const opened = session;
    return { session: opened, persistence: { sqliteVersion: version.version, sqliteSourceId: version.source, journalMode: 'wal', synchronous: 'FULL' },
      async close() { await opened.close(BACKGROUND_CONTEXT); } };
  } catch (error) {
    if (session) await session.close(BACKGROUND_CONTEXT).catch(() => {});
    else await database.close().catch(() => {});
    throw error;
  }
}
