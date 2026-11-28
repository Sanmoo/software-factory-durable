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
import { triageSettlement, type TriageSettlement, type TriageSettlementFacts } from '../rules/triage-settlement.js';

/**
 * Ticket 33 (spec §11.4): the Control storage FORMATS this release knows, read through the public Pi Durable Storage contract.
 * A format is the Pi Durable SQLite schema plus the exact version of every Factory document kind; the registry of Pi Durable tasks is
 * empty in every format (this MVP defines no task), so any persisted task is incompatible. Format 2 adds the storage identity and the
 * controller lifecycle to the installation document. Nothing here writes: an older Pi Durable schema is never opened (its open would
 * migrate it implicitly) and an older Factory document is never adopted lazily.
 */
export const currentFormat = controlStorageCompatibility.format;
/**
 * Format → document kind → version. Jira ticket 02: format 3 differs from format 2 only by `factory.installation` v3 (its format identity) and the
 * Jira kinds, so a format-2 release refuses a storage that may hold Jira-origin state. Triage: format 4 differs from format 3 only by
 * `factory.installation` v4 and the Triage request kinds, so a release that knows no Triage refuses it. Format 4 is still open while Triage is
 * integrated: a later ticket adds its new kinds to the contract's `documents` (format 4 only); a kind absent from the detected format makes the
 * storage mixed.
 */
export type FormatTable = Record<number, Record<string, number>>;
const original = { 'factory.request': 1, 'factory.ticket-index': 1, 'factory.work': 1, 'factory.slots': 1, 'factory.question': 1 };
const formats: FormatTable = {
  1: { 'factory.installation': 1, ...original },
  2: { 'factory.installation': 2, ...original },
  3: { 'factory.installation': 3, ...original, 'factory.jira-impediment': 1, 'factory.jira-comment': 1, 'factory.jira-link': 1 },
  // The current format's matrix is declared once, in the contract the release manifest publishes.
  [currentFormat]: { ...controlStorageCompatibility.documents },
};
/** Every format this release knows. A test derives from it the table of a release that knew fewer formats. */
export const knownFormats: Readonly<FormatTable> = formats;
/** Supported migrations: explicit, whole-storage, one Session commit each (a path of several is still applied in ONE commit, see `migrationPath`). */
export const supportedMigrations = [
  {
    id: 'factory-storage-1-to-2',
    from: 1,
    to: 2,
    changes:
      'factory.installation v1 → v2: adds the storage format identity, the migration record and the controller lifecycle (clean-stop evidence); every other document is kept byte-for-byte.',
  },
  {
    id: 'factory-storage-2-to-3',
    from: 2,
    to: 3,
    changes:
      'factory.installation v2 → v3: the storage format identity becomes 3 (a format-2 release refuses it); pause, history, migration records and lifecycle are kept; every other document is kept byte-for-byte; nothing is published.',
  },
  {
    id: 'factory-storage-3-to-4',
    from: 3,
    to: 4,
    changes:
      'factory.installation v3 → v4: the storage format identity becomes 4 (a release that knows no Triage refuses it); pause, history, migration records and lifecycle are kept; every other document is kept byte-for-byte; no Triage request is created and nothing is published.',
  },
] as const;
export type SupportedMigration = (typeof supportedMigrations)[number];
/**
 * The explicit chain of supported migrations from `from` to `to` (each step's `to` is the next step's `from`), or null when none exists. Format 1
 * reaches 4 only through the existing 1→2 step followed by 2→3 and 3→4; nothing is skipped or invented.
 */
export function migrationPath(from: number, to: number, available: readonly { id: string; from: number; to: number }[] = supportedMigrations) {
  const path: { id: string; from: number; to: number }[] = [];
  for (let at = from; at !== to;) {
    const step = available.find(item => item.from === at && item.to > at && item.to <= to);
    if (!step) return null;
    path.push(step);
    at = step.to;
  }
  return path.length ? path : null;
}
/** The id an operator requests for a path: one step's id, or the step ids in order joined by commas. */
export const migrationPathId = (path: readonly { id: string }[]) => path.map(step => step.id).join(',');

/**
 * Pure format decision (Jira ticket 02): the installation version names the format; every other document kind must exist in that format at
 * exactly its version (a kind another format defines but this one does not, or another version, is STORAGE_FORMAT_MIXED).
 */
export function decideFormat(installationVersion: number | null, versions: Record<string, Record<string, number>>, table: FormatTable = formats) {
  const found =
    installationVersion === null ? undefined : Object.entries(table).find(([, kinds]) => kinds['factory.installation'] === installationVersion)?.[0];
  const format = found === undefined ? null : Number(found);
  const problems: StorageProblem[] = format === null ? [] : mixedFormatProblems(format, versions, table);
  return { format, problems };
}
/** The documents whose kind belongs to some format but whose version does not belong to `format`. */
function mixedFormatProblems(format: number, versions: Record<string, Record<string, number>>, table: FormatTable) {
  const problems: StorageProblem[] = [];
  for (const [kind, entry] of Object.entries(versions)) {
    if (!Object.values(table).some(kinds => kind in kinds)) continue; // Unknown kinds are reported as STORAGE_DOCUMENT_UNKNOWN.
    for (const version of Object.keys(entry))
      if (table[format]![kind] !== Number(version)) {
        problems.push({
          code: 'STORAGE_FORMAT_MIXED',
          detail:
            table[format]![kind] === undefined ? `${kind} is not part of format ${format}.` : `${kind} version ${version} does not belong to format ${format}.`,
        });
      }
  }
  return problems;
}
export const durableSchemaVersion = CURRENT_SQLITE_SCHEMA_VERSION;

export type StorageProblem = {
  code:
    | 'STORAGE_BACKEND_INCOMPATIBLE'
    | 'STORAGE_DOCUMENT_UNKNOWN'
    | 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED'
    | 'STORAGE_FORMAT_MIXED'
    | 'STORAGE_REGISTRY_INCOMPATIBLE'
    | 'STORAGE_UNREADABLE'
    | 'STORAGE_NOT_FACTORY'
    | 'STORAGE_INSTALLATION_MISSING';
  detail: string;
};
export type StorageInspection =
  | { kind: 'absent' }
  | {
      kind: 'storage';
      backend: { durableSchema: number | null; supported: number; sqliteVersion: string | null };
      /** Detected Factory format (null: not determinable, see problems). Empty storage (no document yet) is format null and compatible. */
      format: number | null;
      current: number;
      documents: Record<string, { count: number; versions: Record<string, number> }>;
      tasks: { count: number; kinds: string[] };
      problems: StorageProblem[];
      /** Installation facts, when the installation document is readable at a known version. */
      installation: {
        paused: boolean;
        migrations: unknown[];
        lifecycle: { current: unknown; last: unknown } | null;
        /** Canonical form of the installation fields every migration preserves (pause and history). */
        preservedCanonical: string;
      } | null;
      /** Domain counts kept by any migration (ids, queues, Questions, reservations), and the digest of every preserved document. */
      preserved: { works: number; questions: { open: number; answered: number }; heldSlots: number; requests: number; sessions: number; digest: string } | null;
      /** Digest of EVERY document in full (lifecycle and migration records included): any write changes it. */
      stateDigest: string | null;
      /** Durable activity evidence: Executions not settled (see rules/quiescence) and Slots held. */
      activity: { unsettled: string[]; heldSlots: number };
      /**
       * The Triage requests by situation, the units of Triage capacity held and the attempts holding them.
       * Metadata only (states and how attempts ended); all zero in a storage without Triage requests.
       */
      triage: TriageSettlement;
      /** What is needed before an operational open: nothing, an explicitly requested supported migration, or it is refused. */
      operational: 'ready' | 'migration-required' | 'incompatible';
    };

const canonical = (value: JsonValue | undefined): string =>
  value === null || typeof value !== 'object'
    ? JSON.stringify(value ?? null)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value)
          .sort()
          .map(key => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`)
          .join(',')}}`;
/** Installation fields every migration preserves (the additions of format 2 and the format identity excluded). */
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
  } catch {
    return 'unreadable';
  }
}

const empty = {
  format: null,
  documents: {},
  tasks: { count: 0, kinds: [] },
  installation: null,
  preserved: null,
  stateDigest: null,
  activity: { unsettled: [], heldSlots: 0 },
  triage: triageSettlement([]),
};
/** The settlement facts of a stored Triage request (none for any other document): its state and its attempts, never its content. */
const triageRequestFacts = (kind: string, value: JsonObject): TriageSettlementFacts[] =>
  kind === 'factory.triage-request' && value.request ? [value.request as unknown as TriageSettlementFacts] : [];
/** Examines an open database. `storage` is returned only when the Pi Durable schema is exactly the supported one (opening never migrates). */
export async function examine(
  database: SqliteDatabase,
  options: { create: boolean; known: FormatTable },
): Promise<{ inspection: Extract<StorageInspection, { kind: 'storage' }>; storage?: SqliteStorage }> {
  const table = options.known;
  const found = await durableSchema(database);
  const schema = typeof found === 'number' ? found : null;
  const sqlite = await database.get<{ version: string }>('SELECT sqlite_version() AS version').then(
    row => row?.version ?? null,
    () => null,
  );
  const base = { backend: { durableSchema: schema, supported: durableSchemaVersion, sqliteVersion: sqlite }, current: currentFormat };
  // A provably empty database: compatible; only an operational open creates its schema.
  if (found === 'fresh' && !options.create) return { inspection: { kind: 'storage', ...base, ...empty, operational: 'ready', problems: [] } };
  if (found === 'foreign' || found === 'unreadable') {
    return {
      inspection: {
        kind: 'storage',
        ...base,
        ...empty,
        operational: 'incompatible',
        problems: [
          found === 'foreign'
            ? {
                code: 'STORAGE_NOT_FACTORY',
                detail: 'A non-empty SQLite database without the Pi Durable schema: not a Control storage; nothing is created in it.',
              }
            : { code: 'STORAGE_UNREADABLE', detail: 'The Pi Durable schema version could not be read; the storage is not opened.' },
        ],
      },
    };
  }
  if (schema !== null && schema !== durableSchemaVersion) {
    return {
      inspection: {
        kind: 'storage',
        ...base,
        ...empty,
        operational: 'incompatible',
        problems: [
          {
            code: 'STORAGE_BACKEND_INCOMPATIBLE',
            detail: `Pi Durable SQLite schema ${schema}; this release supports exactly ${durableSchemaVersion} and migrates no backend schema.`,
          },
        ],
      },
    };
  }
  const storage = await SqliteStorage.open(database);
  const documents: Record<string, { count: number; versions: Record<string, number> }> = {};
  const problems: StorageProblem[] = [];
  const digest = createHash('sha256');
  const full = createHash('sha256');
  const workFacts: SettlementFacts[] = [];
  const triageFacts: TriageSettlementFacts[] = [];
  let installation: Extract<StorageInspection, { kind: 'storage' }>['installation'] = null;
  const counts = { works: 0, open: 0, answered: 0, heldSlots: 0, requests: 0, sessions: 0 };
  let installationVersion: number | null = null;
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 200, cursor, BACKGROUND_CONTEXT);
    for (const record of page.items as DocumentRecord[]) {
      const stored = await storage.document(record.id, 'current', BACKGROUND_CONTEXT);
      if (!stored) {
        problems.push({ code: 'STORAGE_UNREADABLE', detail: `Document ${record.kind} ${record.key ?? ''} could not be read.` });
        continue;
      }
      const entry = (documents[record.kind] ??= { count: 0, versions: {} });
      entry.count++;
      entry.versions[String(stored.version)] = (entry.versions[String(stored.version)] ?? 0) + 1;
      const known = Object.entries(table)
        .filter(([, kinds]) => kinds[record.kind] === stored.version)
        .map(([format]) => Number(format));
      if (!Object.values(table).some(kinds => record.kind in kinds))
        problems.push({ code: 'STORAGE_DOCUMENT_UNKNOWN', detail: `Document kind ${record.kind} is not defined by any known format.` });
      else if (known.length === 0)
        problems.push({ code: 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED', detail: `${record.kind} version ${stored.version} is not part of any known format.` });
      const value = stored.value;
      full.update(`${record.kind}:${record.key ?? ''}:${stored.version}:${canonical(value)}\n`);
      if (record.kind === 'factory.installation') {
        installationVersion = stored.version;
        const lifecycle = value.lifecycle as { current: unknown; last: unknown } | undefined;
        installation = {
          paused: value.paused === true,
          migrations: ((value.storage as JsonObject | undefined)?.migrations as unknown[] | undefined) ?? [],
          lifecycle: lifecycle ?? null,
          preservedCanonical: preservedCanonical(value),
        };
        digest.update(`installation:${canonical(preservedInstallation(value))}\n`);
      } else digest.update(`${record.kind}:${record.key ?? ''}:${stored.version}:${canonical(value)}\n`);
      if (record.kind === 'factory.work' && value.work) {
        counts.works++;
        workFacts.push(value.work as SettlementFacts);
        // A preserved Builder session (ticket 11) that a later activation may continue when compatible, or replace with a recorded reason.
        if ((((value.work as JsonObject).execution as JsonObject | null)?.end as JsonObject | null)?.session) counts.sessions++;
      }
      if (record.kind === 'factory.request' && value.receipt) counts.requests++;
      triageFacts.push(...triageRequestFacts(record.kind, value));
      if (record.kind === 'factory.slots') counts.heldSlots = Object.keys((value.held as JsonObject | undefined) ?? {}).length;
      if (record.kind === 'factory.question') {
        const state = (value.question as JsonObject | null)?.state;
        if (state === 'open') counts.open++;
        if (state === 'answered') counts.answered++;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  const decided = decideFormat(installationVersion, Object.fromEntries(Object.entries(documents).map(([kind, entry]) => [kind, entry.versions])), table);
  const detected = decided.format;
  problems.push(...decided.problems);
  // Factory documents without the installation document: never adopted, never completed by a lazily created installation.
  if (installationVersion === null && Object.keys(documents).length > 0) {
    problems.push({ code: 'STORAGE_INSTALLATION_MISSING', detail: 'Factory documents exist without the installation document; the storage is not adopted.' });
  }
  const tasks = await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT);
  const taskKinds = [...new Set(tasks.items.map(task => String((task as { kind?: unknown }).kind)))].sort();
  if (tasks.items.length > 0)
    problems.push({
      code: 'STORAGE_REGISTRY_INCOMPATIBLE',
      detail: `Persisted Pi Durable task kinds ${taskKinds.join(', ')}; this release registers no task definition.`,
    });
  const operational =
    problems.length > 0
      ? 'incompatible'
      : detected === null || detected === currentFormat
        ? 'ready'
        : migrationPath(detected, currentFormat)
          ? 'migration-required'
          : 'incompatible';
  return {
    storage,
    inspection: {
      kind: 'storage',
      ...base,
      format: detected,
      documents,
      tasks: { count: tasks.items.length, kinds: taskKinds },
      problems,
      installation,
      preserved: {
        works: counts.works,
        questions: { open: counts.open, answered: counts.answered },
        heldSlots: counts.heldSlots,
        requests: counts.requests,
        sessions: counts.sessions,
        digest: digest.digest('hex'),
      },
      stateDigest: full.digest('hex'),
      activity: { unsettled: unsettledExecutions(workFacts), heldSlots: counts.heldSlots },
      triage: triageSettlement(triageFacts),
      operational,
    },
  };
}

/**
 * Read-only compatibility inspection of the canonical Control storage (ticket 33). The caller must hold the canonical-storage flock, as
 * for any open. Never creates the storage, never migrates the Pi Durable schema, never writes a document. `known` is the format table the
 * storage is read with: this release's by default; a narrower one shows what a release that knew fewer formats finds in the same storage.
 */
export async function inspectStorage(storagePath: string, known: FormatTable = formats): Promise<StorageInspection> {
  try {
    await lstat(storagePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  const database = await openNodeSqliteDatabase(storagePath);
  try {
    const { inspection, storage } = await examine(database, { create: false, known });
    if (storage) await storage.close(BACKGROUND_CONTEXT);
    else await database.close();
    return inspection;
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}
