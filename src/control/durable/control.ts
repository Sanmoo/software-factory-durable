import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createSession, defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { z } from 'zod';
import type { Control, ControlInput, ControlReceipt } from '../types.js';

const inputSchema = z.strictObject({
  request_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli'),
});
type History = { request_id: string; operation: 'pause' | 'unpause'; before: boolean; after: boolean; origin: 'local-cli' };
type Installation = { paused: boolean; history: History[] };
const installation = defineDoc<Installation>({ kind: 'factory.installation', version: 1, scope: 'session',
  initial: () => ({ paused: false, history: [] }), checkpointWhen: () => true });
const requests = defineDocFamily<{ input: ControlInput | null; receipt: ControlReceipt | null }, null>({
  kind: 'factory.request', version: 1, scope: 'session', family: true, initial: () => ({ input: null, receipt: null }), checkpointWhen: () => true,
});

/** Bootstrap must already hold the stable canonical-storage flock for this owner's entire lifetime. */
export async function openControl(options: { storagePath: string; runtimeInventory: 'empty' | 'unknown' }): Promise<Control> {
  // Closed before any storage open; this increment exposes no scheduler, task, or external-effect entrypoint.
  let dispatchReason: 'RECONCILIATION_REQUIRED' | 'EXECUTION_NOT_ENABLED' = 'RECONCILIATION_REQUIRED';
  const controller_run_id = randomUUID();
  const database = await openNodeSqliteDatabase(options.storagePath);
  let session;
  let persistence;
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
    persistence = { sqliteVersion: version.version, sqliteSourceId: version.source, journalMode: 'wal' as const, synchronous: 'FULL' as const };
    session = createSession(await SqliteStorage.open(database));
    await session.commit(async tx => { await tx.doc(installation); }, BACKGROUND_CONTEXT);
  } catch (error) {
    if (session) await session.close(BACKGROUND_CONTEXT).catch(() => {});
    else await database.close().catch(() => {});
    throw error;
  }
  const state = session;
  const verifiedPersistence = persistence;
  let running = false;
  return {
    async accept(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'INVALID_COMMAND' };
      const command = parsed.data;
      // No deferred persistence; the receipt, history and pause change share this real Session commit.
      return state.commit(async tx => {
        const current = await tx.doc(installation);
        const request = await tx.doc(requests, command.request_id, null);
        if (request.input) {
          if (request.input.operation !== command.operation || request.input.origin !== command.origin) {
            return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
          }
          return { ...request.receipt! };
        }
        const paused = command.operation === 'pause';
        const receipt: ControlReceipt = { kind: 'durable', request_id: command.request_id, operation: command.operation,
          paused, historySequence: current.history.length + 1 };
        current.history.push({ request_id: command.request_id, operation: command.operation, before: current.paused, after: paused, origin: command.origin });
        current.paused = paused;
        request.input = command;
        request.receipt = receipt;
        return receipt;
      }, BACKGROUND_CONTEXT);
    },
    async inspect(query) {
      if (query.kind === 'request') {
        if (!inputSchema.shape.request_id.safeParse(query.request_id).success) throw new Error('INVALID_REQUEST_ID');
        const request = await state.snapshot(requests, query.request_id, BACKGROUND_CONTEXT);
        return { kind: 'request', receipt: request?.receipt ?? null };
      }
      const current = await state.snapshot(installation, BACKGROUND_CONTEXT);
      if (!current) throw new Error('INSTALLATION_STATE_MISSING');
      return { controller_run_id, paused: current.paused, dispatch: 'closed', dispatchReason,
        historyLength: current.history.length, persistence: verifiedPersistence };
    },
    async run(signal) {
      if (running) throw new Error('CONTROL_ALREADY_RUNNING');
      running = true;
      try {
        // Authoritative persisted task inventory, not an empty fake scheduler. Unknown runtime resources stay closed.
        const tasks = await state.commit(tx => tx.scanTasks({}, 1), BACKGROUND_CONTEXT);
        if (tasks.items.length === 0 && options.runtimeInventory === 'empty') dispatchReason = 'EXECUTION_NOT_ENABLED';
        const aborted = new Promise<'stop'>(resolve => {
          if (signal.aborted) resolve('stop');
          else signal.addEventListener('abort', () => resolve('stop'), { once: true });
        });
        const outcome = await Promise.race([aborted, state.closed]);
        await state.close(BACKGROUND_CONTEXT);
        const end = await state.closed;
        return { kind: outcome === 'stop' && end.kind === 'closed' ? 'clean' : 'failed' };
      } catch {
        await state.close(BACKGROUND_CONTEXT).catch(() => {});
        return { kind: 'failed' };
      }
    },
  };
}
