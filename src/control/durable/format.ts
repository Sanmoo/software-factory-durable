import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SqliteDatabase } from '@earendil-works/chord/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import type { JsonValue } from '@earendil-works/chord';
import type { Cursor, DocumentRecord, JsonObject } from '@earendil-works/pi-durable';
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { controlStorageCompatibility } from '../../contracts/index.js';
import { unsettledExecutions, type SettlementFacts } from '../rules/quiescence.js';

/**
 * Ticket 33 (spec §11.4): the Control storage FORMATS this release knows, read through the public Pi Durable Storage contract.
 * A format is the Pi Durable SQLite schema plus the exact version of every Factory document kind; the registry of Pi Durable tasks is
 * empty in every format (this MVP defines no task), so any persisted task is incompatible. Format 2 adds the storage identity and the
 * controller lifecycle to the installation document. Nothing here writes: an older Pi Durable schema is never opened (its open would
 * migrate it implicitly) and an older Factory document is never adopted lazily.
 */
export const currentFormat = controlStorageCompatibility.format;
const formats: Record<number, Record<string, number>> = {
  1: { 'factory.installation': 1, 'factory.request': 1, 'factory.ticket-index': 1, 'factory.work': 1, 'factory.slots': 1, 'factory.question': 1 },
  2: { 'factory.installation': 2, 'factory.request': 1, 'factory.ticket-index': 1, 'factory.work': 1, 'factory.slots': 1, 'factory.question': 1 },
};
/** Supported migrations: explicit, whole-storage, one Session commit each. */
export const supportedMigrations = [{ id: 'factory-storage-1-to-2', from: 1, to: 2,
  changes: 'factory.installation v1 → v2: adds the storage format identity, the migration record and the controller lifecycle (clean-stop evidence); every other document is kept byte-for-byte.' }] as const;
export const durableSchemaVersion = CURRENT_SQLITE_SCHEMA_VERSION;

export type StorageProblem = { code: 'STORAGE_BACKEND_INCOMPATIBLE' | 'STORAGE_DOCUMENT_UNKNOWN' | 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED' | 'STORAGE_FORMAT_MIXED' |
  'STORAGE_REGISTRY_INCOMPATIBLE' | 'STORAGE_UNREADABLE' | 'STORAGE_NOT_FACTORY' | 'STORAGE_INSTALLATION_MISSING'; detail: string };
export type StorageInspection = { kind: 'absent' } | { kind: 'storage';
  backend: { durableSchema: number | null; supported: number; sqliteVersion: string | null };
  /** Detected Factory format (null: not determinable, see problems). Empty storage (no document yet) is format null and compatible. */
  format: number | null; current: number;
  documents: Record<string, { count: number; versions: Record<string, number> }>;
  tasks: { count: number; kinds: string[] };
  problems: StorageProblem[];
  /** Installation facts, when the installation document is readable at a known version. */
  installation: { paused: boolean; migrations: unknown[]; lifecycle: { current: unknown; last: unknown } | null;
    /** Canonical form of the installation fields every migration preserves (pause and history). */
    preservedCanonical: string } | null;
  /** Domain counts kept by any migration (ids, queues, Questions, reservations), and the digest of every preserved document. */
  preserved: { works: number; questions: { open: number; answered: number }; heldSlots: number; requests: number; sessions: number; digest: string } | null;
  /** Digest of EVERY document in full (lifecycle and migration records included): any write changes it. */
  stateDigest: string | null;
  /** Durable activity evidence: Executions not settled (see rules/quiescence) and Slots held. */
  activity: { unsettled: string[]; heldSlots: number };
  /** What is needed before an operational open: nothing, an explicitly requested supported migration, or it is refused. */
  operational: 'ready' | 'migration-required' | 'incompatible' };

const canonical = (value: JsonValue | undefined): string => value === null || typeof value !== 'object' ? JSON.stringify(value ?? null)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(',')}}`;
/** Installation fields every migration preserves (format 2 additions excluded). */
const preservedInstallation = (value: JsonObject) => ({ paused: value.paused ?? null, history: value.history ?? null });
export const preservedCanonical = (value: JsonObject) => canonical(preservedInstallation(value) as JsonObject);

/**
 * The Pi Durable schema version, `fresh` only for a provably empty database (no table at all), `foreign` for any other database without
 * the schema table and `unreadable` for any read error: neither is ever opened (SqliteStorage.open would create or migrate it).
 */
async function durableSchema(database: SqliteDatabase): Promise<number | 'fresh' | 'foreign' | 'unreadable'> {
  try {
    const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger')");
    if (tables.length === 0) return 'fresh';
    if (!tables.some(table => table.name === 'durable_schema')) return 'foreign';
    const row = await database.get<{ version: number }>('SELECT version FROM durable_schema WHERE singleton = 1');
    return row && Number.isSafeInteger(row.version) ? row.version : 'unreadable';
  } catch { return 'unreadable'; }
}

const empty = { format: null, documents: {}, tasks: { count: 0, kinds: [] }, installation: null, preserved: null, stateDigest: null, activity: { unsettled: [], heldSlots: 0 } };
/** Examines an open database. `storage` is returned only when the Pi Durable schema is exactly the supported one (opening never migrates). */
export async function examine(database: SqliteDatabase, options: { create: boolean }): Promise<{ inspection: Extract<StorageInspection, { kind: 'storage' }>; storage?: SqliteStorage }> {
  const found = await durableSchema(database);
  const schema = typeof found === 'number' ? found : null;
  const sqlite = await database.get<{ version: string }>('SELECT sqlite_version() AS version').then(row => row?.version ?? null, () => null);
  const base = { backend: { durableSchema: schema, supported: durableSchemaVersion, sqliteVersion: sqlite }, current: currentFormat };
  // A provably empty database: compatible; only an operational open creates its schema.
  if (found === 'fresh' && !options.create) return { inspection: { kind: 'storage', ...base, ...empty, operational: 'ready', problems: [] } };
  if (found === 'foreign' || found === 'unreadable') {
    return { inspection: { kind: 'storage', ...base, ...empty, operational: 'incompatible', problems: [found === 'foreign'
      ? { code: 'STORAGE_NOT_FACTORY', detail: 'A non-empty SQLite database without the Pi Durable schema: not a Control storage; nothing is created in it.' }
      : { code: 'STORAGE_UNREADABLE', detail: 'The Pi Durable schema version could not be read; the storage is not opened.' }] } };
  }
  if (schema !== null && schema !== durableSchemaVersion) {
    return { inspection: { kind: 'storage', ...base, ...empty, operational: 'incompatible',
      problems: [{ code: 'STORAGE_BACKEND_INCOMPATIBLE', detail: `Pi Durable SQLite schema ${schema}; this release supports exactly ${durableSchemaVersion} and migrates no backend schema.` }] } };
  }
  const storage = await SqliteStorage.open(database);
  const documents: Record<string, { count: number; versions: Record<string, number> }> = {};
  const problems: StorageProblem[] = [];
  const digest = createHash('sha256');
  const full = createHash('sha256');
  const workFacts: SettlementFacts[] = [];
  let installation: Extract<StorageInspection, { kind: 'storage' }>['installation'] = null;
  const counts = { works: 0, open: 0, answered: 0, heldSlots: 0, requests: 0, sessions: 0 };
  let installationVersion: number | null = null;
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 200, cursor, BACKGROUND_CONTEXT);
    for (const record of page.items as DocumentRecord[]) {
      const stored = await storage.document(record.id, 'current', BACKGROUND_CONTEXT);
      if (!stored) { problems.push({ code: 'STORAGE_UNREADABLE', detail: `Document ${record.kind} ${record.key ?? ''} could not be read.` }); continue; }
      const entry = documents[record.kind] ??= { count: 0, versions: {} };
      entry.count++;
      entry.versions[String(stored.version)] = (entry.versions[String(stored.version)] ?? 0) + 1;
      const known = Object.entries(formats).filter(([, kinds]) => kinds[record.kind] === stored.version).map(([format]) => Number(format));
      if (!Object.values(formats).some(kinds => record.kind in kinds)) problems.push({ code: 'STORAGE_DOCUMENT_UNKNOWN', detail: `Document kind ${record.kind} is not defined by any known format.` });
      else if (known.length === 0) problems.push({ code: 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED', detail: `${record.kind} version ${stored.version} is not part of any known format.` });
      const value = stored.value;
      full.update(`${record.kind}:${record.key ?? ''}:${stored.version}:${canonical(value)}\n`);
      if (record.kind === 'factory.installation') {
        installationVersion = stored.version;
        const lifecycle = value.lifecycle as { current: unknown; last: unknown } | undefined;
        installation = { paused: value.paused === true, migrations: ((value.storage as JsonObject | undefined)?.migrations as unknown[] | undefined) ?? [], lifecycle: lifecycle ?? null,
          preservedCanonical: preservedCanonical(value) };
        digest.update(`installation:${canonical(preservedInstallation(value))}\n`);
      } else digest.update(`${record.kind}:${record.key ?? ''}:${stored.version}:${canonical(value)}\n`);
      if (record.kind === 'factory.work' && value.work) {
        counts.works++;
        workFacts.push(value.work as SettlementFacts);
        // A preserved Builder session (ticket 11) that a later activation may continue when compatible, or replace with a recorded reason.
        if ((((value.work as JsonObject).execution as JsonObject | null)?.end as JsonObject | null)?.session) counts.sessions++;
      }
      if (record.kind === 'factory.request' && value.receipt) counts.requests++;
      if (record.kind === 'factory.slots') counts.heldSlots = Object.keys((value.held as JsonObject | undefined) ?? {}).length;
      if (record.kind === 'factory.question') {
        const state = (value.question as JsonObject | null)?.state;
        if (state === 'open') counts.open++;
        if (state === 'answered') counts.answered++;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  // Every non-installation document is v1 in both formats; the installation version decides the format.
  const format = installationVersion === null ? null : Object.entries(formats).find(([, kinds]) => kinds['factory.installation'] === installationVersion)?.[0];
  const detected = format === undefined ? null : format === null ? null : Number(format);
  if (detected !== null) for (const [kind, entry] of Object.entries(documents)) {
    for (const version of Object.keys(entry.versions)) if (formats[detected]?.[kind] !== undefined && formats[detected][kind] !== Number(version)) {
      problems.push({ code: 'STORAGE_FORMAT_MIXED', detail: `${kind} version ${version} does not belong to format ${detected}.` });
    }
  }
  // Factory documents without the installation document: never adopted, never completed by a lazily created installation.
  if (installationVersion === null && Object.keys(documents).length > 0) {
    problems.push({ code: 'STORAGE_INSTALLATION_MISSING', detail: 'Factory documents exist without the installation document; the storage is not adopted.' });
  }
  const tasks = await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT);
  const taskKinds = [...new Set(tasks.items.map(task => String((task as { kind?: unknown }).kind)))].sort();
  if (tasks.items.length > 0) problems.push({ code: 'STORAGE_REGISTRY_INCOMPATIBLE', detail: `Persisted Pi Durable task kinds ${taskKinds.join(', ')}; this release registers no task definition.` });
  const operational = problems.length > 0 ? 'incompatible' : detected === null || detected === currentFormat ? 'ready'
    : supportedMigrations.some(migration => migration.from === detected && migration.to === currentFormat) ? 'migration-required' : 'incompatible';
  return { storage, inspection: { kind: 'storage', ...base, format: detected, documents, tasks: { count: tasks.items.length, kinds: taskKinds }, problems, installation,
    preserved: { works: counts.works, questions: { open: counts.open, answered: counts.answered }, heldSlots: counts.heldSlots, requests: counts.requests, sessions: counts.sessions,
      digest: digest.digest('hex') }, stateDigest: full.digest('hex'), activity: { unsettled: unsettledExecutions(workFacts), heldSlots: counts.heldSlots }, operational } };
}

/**
 * Read-only compatibility inspection of the canonical Control storage (ticket 33). The caller must hold the canonical-storage flock, as
 * for any open. Never creates the storage, never migrates the Pi Durable schema, never writes a document.
 */
export async function inspectStorage(storagePath: string): Promise<StorageInspection> {
  try { await lstat(storagePath); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
  const database = await openNodeSqliteDatabase(storagePath);
  try {
    const { inspection, storage } = await examine(database, { create: false });
    if (storage) await storage.close(BACKGROUND_CONTEXT);
    else await database.close();
    return inspection;
  } catch (error) { await database.close().catch(() => {}); throw error; }
}
