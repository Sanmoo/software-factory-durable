// Ticket 29: read-only inspection handlers (history, logs, one log page, consumption) over the Control authority and the injected
// Records/Workers observation ports. Nothing here writes: no commit, no Records capture, no external read.
import type { BootUsageReport } from '../../contracts/index.js';
import type {
  CounterView,
  EnvironmentBuildsView,
  EvidenceState,
  ExecutionPorts,
  UsageObservation,
  HistoryQuery,
  HistoryView,
  LogCaptureView,
  LogPageView,
  LogReadQuery,
  LogsQuery,
  LogsView,
  UsageActivityView,
  UsageView,
  WorkUsageView,
} from '../types.js';
import {
  aggregateUsage,
  bootConsumption,
  captureState,
  combineAggregates,
  executionsOf,
  fitPage,
  historyEntries,
  inspectionLimits,
  page,
  pageState,
  sessionCopy,
  sessionLocator,
  trimEntry,
  captureRemoval,
  usageActivity,
  usageSubjects,
} from '../rules/inspection.js';
import { counterView, defaultLimits } from '../rules/budget.js';
import type { WorkRecord } from './admission.js';
import { ticketLabel } from '../rules/admission.js';

/** Serialized size budget of one view (the local protocol frame is 64 KiB, envelope included). */
export const viewBudgetBytes = 56 * 1024;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const historyLimitations = [
  "History is the Work's append-only controller record (authority); detail strings are summaries, never transcripts. Follow `nextCursor` for more.",
];
const logLimitations = [
  "Captures are the Work's protected Records (filtered at capture); a listing that is not complete never proves absence. Raw captures and native sessions are never displayed.",
  'An agent reads a large output only through a filtered selective copy in its own artifacts area; that editable copy certifies no gate (spec §12.2).',
];

export function inspectHistory(work: WorkRecord, query: HistoryQuery): HistoryView {
  const filter = { execution: query.execution, role: query.role, cursor: query.cursor, limit: query.limit };
  const entries = historyEntries(work, filter);
  const paged = page(entries, work.history.length, filter);
  const fitted = fitPage(paged.items, paged.page, items => size(items), viewBudgetBytes - 2048, trimEntry);
  return {
    kind: 'history',
    work_id: work.work_id,
    filter: { execution: query.execution ?? null, role: query.role ?? null },
    page: fitted.page,
    entries: fitted.items,
    limitations: historyLimitations,
  };
}

export async function inspectLogs(work: WorkRecord, query: LogsQuery, ports: ExecutionPorts | undefined): Promise<LogsView> {
  const filter = { execution: query.execution ?? null, role: query.role ?? null };
  const limit = Math.min(Math.max(1, query.limit ?? inspectionLimits.defaultPage), inspectionLimits.maxPage);
  const empty = (state: 'incomplete' | 'unavailable', code: string, nextStep: string): LogsView => ({
    kind: 'logs',
    work_id: work.work_id,
    filter,
    listing: { state, code, nextStep },
    page: { after: query.after ?? null, limit, returned: 0, next: null, fitted: false },
    captures: [],
    limitations: logLimitations,
  });
  if (!ports?.records)
    return empty(
      'unavailable',
      'RECORDS_NOT_COMPOSED',
      'Logs are read from the protected Records of a release controller with composed execution; nothing is concluded about their absence.',
    );
  let found;
  try {
    // Records-level paging (by capture id): a big Work is listed page by page, never refused as over the listing cap.
    found = await ports.records.find({
      workId: work.work_id,
      ...(query.execution ? { executionId: query.execution } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.after ? { after: query.after } : {}),
      limit,
    });
  } catch {
    return empty('unavailable', 'RECORDS_UNAVAILABLE', 'The protected Records could not be read now; retry the query. Absence is not concluded.');
  }
  const captures: LogCaptureView[] = found.captures.map(item => ({
    capture: item.reference.id,
    executionId: item.context.executionId,
    invocationId: item.context.invocationId,
    role: item.context.role,
    callId: item.context.callId,
    environment: item.context.environmentRef,
    boot: item.context.bootRef,
    format: item.format ?? 'text',
    state: captureState(item, null),
  }));
  const fitted = fitPage(
    captures,
    { cursor: 0, limit, returned: captures.length, filtered: captures.length, total: captures.length, nextCursor: null, fitted: false },
    items => size(items),
    viewBudgetBytes - 4096,
  );
  const next = fitted.page.fitted ? (fitted.items.at(-1)?.capture ?? query.after ?? null) : (found.next ?? null);
  const preservedEvidence = found.preservedEvidence ?? 0;
  return {
    kind: 'logs',
    work_id: work.work_id,
    filter,
    listing:
      found.completeness === 'complete'
        ? { state: 'complete', code: null, nextStep: null, preservedEvidence }
        : {
            state: 'incomplete',
            code: 'RECORDS_LISTING_INCOMPLETE',
            nextStep: 'Some captures could not be listed or verified; what is shown is not everything. Inspect the Records directory as administrator.',
            preservedEvidence,
          },
    page: { after: query.after ?? null, limit, returned: fitted.items.length, next, fitted: fitted.page.fitted },
    captures: fitted.items,
    limitations: logLimitations,
  };
}

/** Largest prefix of `data` that ends on a UTF-8 character boundary (a page never splits a character). */
function utf8Prefix(data: Uint8Array): number {
  const end = data.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const byte = data[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > back ? end - back : end;
  }
  return end;
}

export async function inspectLog(work: WorkRecord, query: LogReadQuery, ports: ExecutionPorts | undefined): Promise<LogPageView> {
  const offset = Number.isSafeInteger(query.offset) && query.offset! >= 0 ? query.offset! : 0;
  const view = (state: EvidenceState, code: string | null, nextStep: string | null, rest: Partial<LogPageView> = {}): LogPageView => ({
    kind: 'log',
    work_id: work.work_id,
    capture: query.capture,
    state,
    code,
    text: null,
    offset,
    nextOffset: null,
    bytes: null,
    nextStep,
    trust: 'untrusted-captured-output',
    ...rest,
  });
  if (!ports?.records)
    return view('unknown', 'RECORDS_NOT_COMPOSED', 'Logs are read from the protected Records of a release controller with composed execution.');
  let found;
  try {
    found = await ports.records.find({ workId: work.work_id, id: query.capture });
  } catch {
    return view('unknown', 'RECORDS_UNAVAILABLE', 'The protected Records could not be read now; retry. Nothing is concluded.');
  }
  const capture = found.captures.find(item => item.reference.id === query.capture);
  if (!capture) {
    // Ticket 30: a capture the Work's retention (or an explicit cleanup) removed is `expired` (or `removed`), never "not found".
    const removal = captureRemoval(work, query.capture);
    if (removal)
      return view(
        removal,
        removal === 'expired' ? 'CAPTURE_EXPIRED_BY_RETENTION' : 'CAPTURE_REMOVED_BY_EXPLICIT_CLEANUP',
        "This log was removed as recorded in the Work's retention (`factory show <work>`); its content is not recoverable.",
      );
    return found.completeness === 'complete'
      ? view('absent', 'CAPTURE_NOT_FOUND', "No capture with this identity in this Work's Records; use `factory logs <work>`.")
      : view('unknown', 'RECORDS_LISTING_INCOMPLETE', 'The capture was not found in an incomplete listing: its absence is not proven.');
  }
  if ((capture.format ?? 'text') === 'raw')
    return view(captureState(capture, null), 'RAW_CAPTURE_NOT_DISPLAYED', 'Raw (binary) captures are protected evidence and are never displayed.');
  // At least 4 bytes: one whole UTF-8 character always fits, so a page always makes progress.
  let limit = Math.max(4, Math.min(query.limit ?? inspectionLimits.logPageBytes, inspectionLimits.logPageBytes));
  for (;;) {
    let read;
    try {
      read = await ports.records.read({ reference: capture.reference, offset, limit });
    } catch {
      return view('unknown', 'CAPTURE_UNREADABLE', 'The capture metadata or file could not be verified; it is neither absent nor complete.');
    }
    if (read.state === 'absent') return view('absent', 'CAPTURE_OUTPUT_ABSENT', 'The capture exists but its output file is absent.');
    if (offset > 0 && offset >= read.bytes) {
      return view('absent', 'OFFSET_OUT_OF_RANGE', `The capture has ${read.bytes} bytes; read from an offset below that (start with no --offset).`, {
        bytes: read.bytes,
      });
    }
    const end = read.nextOffset >= read.bytes ? read.data.length : utf8Prefix(read.data);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(read.data.subarray(0, end));
    const nextOffset = offset + end;
    const state = pageState({ state: read.state, nextOffset, bytes: read.bytes });
    const result = view(
      state,
      read.state === 'partial' ? 'CAPTURE_INCOMPLETE' : null,
      read.state === 'partial'
        ? 'The capture never completed: what is shown is all that was captured, not the full output.'
        : state === 'truncated'
          ? `Part of the output; read on with \`--offset ${nextOffset}\`.`
          : null,
      { text, nextOffset: nextOffset < read.bytes ? nextOffset : null, bytes: read.bytes },
    );
    if (size(result) <= viewBudgetBytes || limit <= 256) return result;
    limit = Math.floor(limit / 2);
  }
}

const removedEnvironment = (work: WorkRecord, environment: string | null) =>
  environment !== null &&
  (work.cleanup?.resources ?? []).some(
    item => item.kind === 'environment' && item.environment === environment && (item.state === 'removed' || item.state === 'absent'),
  );

/** The Work's Execution time: measured, proven lower bounds and started Executions of unknown duration. */
function executionDurations(executions: ReturnType<typeof executionsOf>) {
  let measuredMs = 0,
    lowerBoundMs = 0,
    unknown = 0;
  for (const execution of executions) {
    const duration = execution.timing?.duration;
    if (duration?.kind === 'measured') measuredMs += duration.elapsedMs;
    else if (duration?.kind === 'lower-bound') lowerBoundMs += duration.provenMs;
    else if (execution.start) unknown++;
  }
  return { measuredMs, lowerBoundMs, unknown };
}

export async function workUsage(work: WorkRecord, ports: ExecutionPorts | undefined): Promise<WorkUsageView> {
  const counted = new Set<string>();
  const activities: UsageActivityView[] = [];
  const executions = executionsOf(work);
  for (const subject of usageSubjects(work)) {
    const locator = sessionLocator(work, subject);
    const environment = executions.find(item => item.executionId === subject.executionId)?.dispatch.environment ?? null;
    let observation: UsageObservation | null = null;
    let removal: 'expired' | 'removed' | null = null;
    if (locator && ports?.workers.observeUsage) {
      // The Workers facet reads each unchanged hash-verified session once (its own bounded cache keyed by the file identity).
      // Finding A7: the session of a lost Execution is looked up in the boot that was lost.
      const boot = subject.lost?.boot ?? executions.find(item => item.executionId === subject.executionId)?.dispatch.boot ?? null;
      const observe = async (session: Parameters<NonNullable<ExecutionPorts['workers']['observeUsage']>>[0]['session']): Promise<UsageObservation> => {
        try {
          return await ports.workers.observeUsage!({ workId: work.work_id, boot, session });
        } catch {
          return { state: 'unavailable' as const, code: 'USAGE_OBSERVATION_FAILED' };
        }
      };
      observation = await observe(locator);
      // Ticket 30: once the environment is removed, the session is read from its Records copy (hash-verified), if it was preserved and kept.
      const preserved = sessionCopy(work, subject, locator);
      if (observation.state === 'lost' && preserved.copy) observation = await observe({ copy: { workId: work.work_id, ...preserved.copy } });
      if (observation.state === 'lost' && preserved.removal) removal = preserved.removal;
    }
    activities.push(usageActivity(subject, observation, counted, removal ?? removedEnvironment(work, environment)));
  }
  const byRole = {
    builder: aggregateUsage(activities.filter(item => item.role === 'builder')),
    standards: aggregateUsage(activities.filter(item => item.role === 'standards')),
    spec: aggregateUsage(activities.filter(item => item.role === 'spec')),
  };
  const { measuredMs, lowerBoundMs, unknown } = executionDurations(executions);
  const counter = (key: 'corrections' | 'recoveries'): CounterView | null => (work.budget ? counterView(work.budget[key]) : null);
  // v2 ticket 14 (V2-32): the sandbox's own report for each environment of the Work, covering the boots of every Execution. A report
  // that cannot be obtained is `null` (unavailable), never an empty list.
  const report = ports?.sandbox.usage;
  const reports: (BootUsageReport | null)[] = [];
  if (report)
    for (const environment of new Set(executions.flatMap(item => (item.dispatch.environment ? [item.dispatch.environment] : [])))) {
      reports.push(await report({ environment: environment as Parameters<typeof report>[0]['environment'] }).catch(() => null));
    }
  return {
    work_id: work.work_id,
    ticket: ticketLabel(work.ticket),
    activities,
    byRole,
    total: aggregateUsage(activities),
    budget: {
      corrections: counter('corrections'),
      recoveries: counter('recoveries'),
      continuations: work.budget
        ? counterView(work.budget.continuations ?? { limit: defaultLimits.continuations, granted: 0, consumed: 0, reserved: null })
        : null,
      grants: work.budget?.grants.length ?? 0,
    },
    time: {
      executions: executions.length,
      measuredMs,
      lowerBoundMs,
      unknown,
      measurement: executions.length === 0 ? 'unavailable' : unknown === 0 && lowerBoundMs === 0 ? 'complete' : 'partial',
    },
    ...(report ? { boots: bootConsumption(reports) } : {}),
  };
}

const buildKeysLimit = 50;
/** v2 ticket 14 (V2-32): environment base builds per key, as the sandbox recorded them (the latest keys when there are many). */
async function environmentBuilds(ports: ExecutionPorts): Promise<EnvironmentBuildsView> {
  let report: Awaited<ReturnType<NonNullable<ExecutionPorts['sandbox']['environmentBuilds']>>>;
  try {
    report = await ports.sandbox.environmentBuilds!();
  } catch {
    return { status: 'unavailable', code: 'ENVIRONMENT_BUILDS_OBSERVATION_FAILED' };
  }
  if (report.status !== 'reported') return { status: 'unavailable', code: report.code };
  return {
    status: 'reported',
    builds: report.keys.reduce((total, entry) => total + entry.builds, 0),
    omitted: Math.max(0, report.keys.length - buildKeysLimit),
    keys: report.keys.slice(-buildKeysLimit),
  };
}

export async function inspectUsage(
  all: WorkRecord[],
  scope: 'installation' | 'work',
  ports: ExecutionPorts | undefined,
  slots: { capacity: number; held: number },
  now: number,
  options: { cursor?: number | undefined; limit?: number | undefined } = {},
): Promise<UsageView> {
  // Installation scope is bounded: one page of Works (default 50), each hash-verified session read once per Control (cache).
  const paged = page(all, all.length, { cursor: options.cursor, limit: options.limit });
  const views: WorkUsageView[] = [];
  for (const work of paged.items) views.push(await workUsage(work, ports));
  const limitations = [
    "Token/cost figures are the SDK's own per-message usage and catalog-price estimate read from preserved sessions; they are not an invoice, no billing is queried and no price is invented.",
    'A continued session carries earlier messages: they are counted once, for the activity that produced them.',
    '`unavailable` means not measurable (session not recorded, removed, unreadable or not composed); it is never a zero. Totals sum only measured activities.',
    ...(ports?.workers.observeUsage ? [] : ['Usage observation is not composed in this controller (no release execution): every activity is `unavailable`.']),
    ...(ports?.sandbox.usage
      ? [
          "`boots` are the sandbox's own seconds per boot, summed per Work over every boot and Execution; a boot still running or without a final observation " +
            "is counted apart and makes the sum a lower bound, never a zero. No monetary value or ceiling is computed: check the cost in the provider's billing by the installation tag.",
        ]
      : []),
  ];
  const view: UsageView = {
    kind: 'usage',
    scope,
    at: new Date(now).toISOString(),
    works: views,
    total: combineAggregates(views.map(item => item.total)),
    page: paged.page,
    slots,
    resources: {
      state: 'unavailable',
      code: 'ADAPTER_RESOURCE_METRICS_NOT_OBSERVED',
      note: 'Adapter RAM/CPU/I/O/disk are not measured by this release; they are distinct from tokens/cost and from configured virtual capacity.',
    },
    ...(scope === 'installation' && ports?.sandbox.environmentBuilds ? { environmentBuilds: await environmentBuilds(ports) } : {}),
    limitations,
  };
  // Keep the installation view within one frame: per-activity detail is dropped first (still available per Work with `usage <work>`).
  if (size(view) > viewBudgetBytes) {
    return {
      ...view,
      works: views.map(item => ({
        ...item,
        activities: [],
        ...(item.boots ? { boots: { ...item.boots, omitted: item.boots.omitted + item.boots.items.length, items: [] } } : {}),
      })),
      limitations: [...limitations, 'Per-activity and per-boot detail omitted to fit one view; query `factory usage <work>`.'],
    };
  }
  return view;
}
