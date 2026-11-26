import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import type {
  Control,
  ControlInput,
  ControlQuery,
  ControlStatus,
  TriageAttemptUsage,
  TriageCleanupItem,
  TriageCleanupPlan,
  TriageCleanupReceipt,
  TriageDetailPorts,
  TriageDetails,
  TriageDetailView,
  TriageRequest,
  TriageSourcePollView,
  TriageStatusView,
  TriagesView,
  TriageTranscriptView,
  TriageUsageView,
  UsageView,
} from '../types.js';
import { ticketLabel } from '../rules/admission.js';
import { fitPage, inspectionLimits, page } from '../rules/inspection.js';
import {
  resolveTriageRequest,
  triageAttemptUsage,
  triageCapacity,
  triageCleanupPlan,
  triageDetail,
  triageDetailProtections,
  triageDetailsView,
  triageHeld,
  triageRequestImpediments,
  triageStateCounts,
  triageStatus,
  triageSummary,
  triageUsageTotal,
  type TriageViewFacts,
} from '../rules/triage-operator.js';
import { viewBudgetBytes } from './inspection.js';
import type { Session } from './store.js';
import { acceptOnce, isTriageIntervention } from './triage-intervention.js';
import { readTriageRequest, readTriageRequests, readTriageVerdictText, ticketTriageRequests, triageRequests, triageVerdicts } from './triage-requests.js';

// Spec #68 §10 (ticket #80): the operator's side of the Triage requests. Views (`triages`, `triage`, the sections of `status` and `usage`)
// are built from the durable records only, so they are metadata by construction. Content leaves through ONE query, `triage-transcript`,
// which reads a session file or the Verdict text on purpose. The same desk keeps those details for the retention of the Work details,
// counted from the terminal state, and removes them early on an explicit plan and confirmation; every removal records its intent first.

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
type CleanupInput = Extract<ControlInput, { operation: 'triage-cleanup-plan' | 'triage-cleanup-confirm' }>;
type Inspect = Control['inspect'];
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const cleanupSchema = z.discriminatedUnion('operation', [
  z.strictObject({ request_id: requestId, operation: z.literal('triage-cleanup-plan'), triage_request_id: z.uuid(), origin: z.literal('local-cli') }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('triage-cleanup-confirm'),
    triage_request_id: z.uuid(),
    plan_id: z.uuid(),
    origin: z.literal('local-cli'),
  }),
]);
const dayMs = 86_400_000;
const queueShown = 50;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const listLimitations = [
  'Metadata only: the Ticket text, tool arguments and results and the Verdict text are never part of this view.',
  '`held` is the observation of the latest polling rounds of this controller run, not a durable record.',
];
const removalCode = { retention: 'RETENTION_EXPIRED', explicit: 'EXPLICIT_CLEANUP' } as const;
const calendar = { ms: (instant: string) => Date.parse(instant), instant: (ms: number) => new Date(ms).toISOString() };
const trust = 'untrusted-triage-content' as const;
type TranscriptQuery = Extract<ControlQuery, { kind: 'triage-transcript' }>;
type Content = Pick<TriageTranscriptView, 'state' | 'code' | 'text' | 'bytes' | 'nextOffset'>;
const partOf = (query: TranscriptQuery) => (query.verdict ? ('verdict' as const) : ('transcript' as const));
const noContent = (state: Content['state'], code: string): Content => ({ state, code, text: null, bytes: null, nextOffset: null });
/** Content already removed: by the retention (`expired`) or by an explicit cleanup (`removed`). */
const removedContent = (origin: 'retention' | 'explicit'): Content & { nextStep: string } => ({
  ...noContent(origin === 'retention' ? 'expired' : 'removed', removalCode[origin]),
  nextStep: 'The transcripts and the Verdict text of this request were removed; `factory triage` still shows its metadata and the published link.',
});
/** The attempt a transcript query names: the given one if it is of the request, else the latest. */
function attemptOf(attempts: string[], query: TranscriptQuery): string | null {
  if (query.verdict) return null;
  if (query.attempt === undefined) return attempts.at(-1) ?? null;
  return attempts.includes(query.attempt) ? query.attempt : null;
}

export function createTriageOperator(deps: {
  session: Session;
  /** `triager.capacity`, `triager.attempts` and `triager.investigationMinutes` when this Control investigates; null otherwise. */
  limits: { capacity: number; attempts: number; investigationMinutes: number } | null;
  details: TriageDetailPorts | undefined;
  retentionDays: number;
  now(): number;
  /** The Triage rounds of the latest polling iteration, with their candidates. */
  polled(): TriageSourcePollView[];
  stopped(): boolean;
  /** Ticket #81: `triage cancel | release | complete`. */
  interventions: { accept(input: ControlInput): ReturnType<Control['accept']> };
}) {
  const { session, details } = deps;
  const stamp = () => new Date(deps.now()).toISOString();
  const facts = (requests: readonly TriageRequest[]): TriageViewFacts => ({
    budget: deps.limits ? { investigationMs: deps.limits.investigationMinutes * 60_000, attempts: deps.limits.attempts } : null,
    now: deps.now(),
    retentionDays: deps.retentionDays,
    calendar,
    queue: requests
      .filter(request => request.state === 'queued')
      .sort((a, b) => a.sequence - b.sequence)
      .map(request => request.triage_request_id),
  });
  const composed = (requests: readonly TriageRequest[]) => deps.limits !== null || requests.length > 0;

  async function list(query: { cursor?: number | undefined; limit?: number | undefined }): Promise<TriagesView> {
    const requests = await readTriageRequests(session);
    const current = facts(requests);
    const base = {
      kind: 'triages' as const,
      capacity: triageCapacity(requests, deps.limits?.capacity ?? null),
      queue: current.queue.slice(0, queueShown),
      states: triageStateCounts(requests),
      impediments: requests.flatMap(triageRequestImpediments),
      held: triageHeld(deps.polled()),
      limitations: listLimitations,
    };
    const paged = page(requests, requests.length, query);
    const fitted = fitPage(
      paged.items.map(request => triageSummary(request, current)),
      paged.page,
      items => size(items),
      viewBudgetBytes - size(base) - 1024,
    );
    return { ...base, page: fitted.page, requests: fitted.items };
  }

  /** A detail that would not fit one frame keeps its latest timeline entries and says so. */
  function fitDetail(view: TriageDetailView): TriageDetailView {
    if (size(view) <= viewBudgetBytes) return view;
    const kept = 40;
    return {
      ...view,
      request: { ...view.request, timeline: view.request.timeline.slice(-kept) },
      previous: view.previous.slice(-10),
      later: view.later.slice(0, 10),
      limitations: [...view.limitations, `Only the latest ${kept} timeline entries and the nearest requests of the Ticket are shown, to fit one view.`],
    };
  }
  async function detail(reference: string) {
    const requests = await readTriageRequests(session);
    const request = resolveTriageRequest(requests, reference);
    if (!request)
      return { kind: 'triage-not-found' as const, request: reference, nextStep: 'No Triage request with this id or Ticket reference; use `factory triages`.' };
    return fitDetail(triageDetail(request, await ticketTriageRequests(session, request.ticket), facts(requests)));
  }

  /** The Verdict text, or one page of an attempt's session: content, read only because the operator asked for it by name. */
  async function transcript(query: TranscriptQuery): Promise<TriageTranscriptView | { kind: 'triage-not-found'; request: string; nextStep: string }> {
    const id = query.triage_request_id;
    const request = await readTriageRequest(session, id);
    if (!request) return { kind: 'triage-not-found', request: id, nextStep: 'No Triage request with this id; use `factory triages`.' };
    const attempts = (request.attempts ?? []).map(item => item.attempt);
    const attempt = attemptOf(attempts, query);
    const offset = query.offset ?? 0;
    const base = { kind: 'triage-transcript' as const, triage_request_id: id, part: partOf(query), attempt, attempts, offset, trust };
    // Reported as gone only once the removal was carried out: an intent still open (a removal that failed, or is under way) leaves
    // the session files or the Verdict text where they are, and they are read as they are.
    const removal = request.details?.removal;
    if (removal?.removedAt) return { ...base, ...removedContent(removal.origin) };
    const read = query.verdict ? await verdictContent(id) : await sessionContent(attempt, offset);
    const nextStep = read.nextOffset === null ? null : `factory triage transcript ${id} --attempt ${attempt} --offset ${read.nextOffset}`;
    return { ...base, ...read, nextStep };
  }
  async function verdictContent(triage_request_id: string): Promise<Content> {
    const text = await readTriageVerdictText(session, triage_request_id);
    if (text === undefined) return noContent('absent', 'TRIAGE_VERDICT_NOT_RECORDED');
    return { state: 'complete', code: null, text, bytes: Buffer.byteLength(text), nextOffset: null };
  }
  /** One page of an attempt's session file. What cannot be read now is `unknown`, never absence. */
  async function sessionContent(attempt: string | null, offset: number): Promise<Content> {
    if (!attempt) return noContent('absent', 'TRIAGE_ATTEMPT_NOT_FOUND');
    if (!details) return noContent('unknown', 'TRIAGE_DETAILS_NOT_COMPOSED');
    const read = await details
      .read({ attempt, offset, limit: inspectionLimits.logPageBytes })
      .catch(() => ({ state: 'unavailable' as const, code: 'TRIAGE_SESSION_UNREADABLE' }));
    if (read.state === 'absent') return noContent('absent', 'TRIAGE_SESSION_ABSENT');
    if (read.state === 'unavailable') return noContent('unknown', read.code);
    const more = read.nextOffset < read.bytes;
    return { state: more ? 'truncated' : 'complete', code: null, text: read.text, bytes: read.bytes, nextOffset: more ? read.nextOffset : null };
  }

  async function status(): Promise<{ triage: TriageStatusView } | Record<string, never>> {
    const requests = await readTriageRequests(session);
    if (!composed(requests)) return {};
    return { triage: triageStatus(requests, deps.limits?.capacity ?? null, triageHeld(deps.polled()).length) };
  }

  /** Tokens of an attempt: as measured with the removal intent once the details are gone, else read from its session now. */
  async function attemptUsage(request: TriageRequest, attempt: string): Promise<TriageAttemptUsage> {
    const kept = request.details?.usage?.find(item => item.attempt === attempt);
    if (kept) return kept;
    if (!details) return triageAttemptUsage(attempt, null);
    return triageAttemptUsage(attempt, await details.usage(attempt).catch(() => ({ state: 'unavailable' as const, code: 'TRIAGE_USAGE_OBSERVATION_FAILED' })));
  }
  const requestUsage = async (request: TriageRequest) => {
    const attempts: TriageAttemptUsage[] = [];
    for (const attempt of request.attempts ?? []) attempts.push(await attemptUsage(request, attempt.attempt));
    return attempts;
  };
  /**
   * The Triages' tokens: one line per request of the page shown, and the total of EVERY request of the installation (spec §10: "por
   * pedido e no total"), so the total never depends on the page.
   */
  async function usage(query: { cursor?: number | undefined; limit?: number | undefined }, budgetBytes: number): Promise<TriageUsageView | undefined> {
    const requests = await readTriageRequests(session);
    if (!composed(requests)) return undefined;
    const measured = new Map<string, TriageAttemptUsage[]>();
    for (const request of requests) measured.set(request.triage_request_id, await requestUsage(request));
    const paged = page(requests, requests.length, query);
    const rows = paged.items.map((request): TriageUsageView['requests'][number] => {
      const attempts = measured.get(request.triage_request_id) ?? [];
      return {
        triage_request_id: request.triage_request_id,
        ticket: ticketLabel(request.ticket),
        state: request.state,
        attempts,
        total: triageUsageTotal(attempts),
      };
    });
    const fitted = fitPage(rows, paged.page, items => size(items), budgetBytes);
    return {
      requests: fitted.items,
      total: triageUsageTotal([...measured.values()].flat()),
      page: fitted.page,
      note: 'Tokens of the Triager sessions, one line per Triage request and the total of every Triage request; they are never added to the Works or to `total`.',
    };
  }

  const command = (input: CleanupInput, decide: (tx: Tx) => Promise<TriageCleanupReceipt>) => acceptOnce(session, input, decide);
  const receipt = (input: CleanupInput, outcome: TriageCleanupReceipt['outcome'], reason: string | null, plan: TriageCleanupPlan | null) => ({
    kind: 'durable' as const,
    request_id: input.request_id,
    operation: input.operation,
    triage_request_id: input.triage_request_id,
    outcome,
    reason,
    plan: plan ? copy(plan) : null,
  });
  /** Why the details of a request may not be removed by the operator now (null: they may). */
  function refusal(request: TriageRequest): string | null {
    if (request.details?.removal) return 'TRIAGE_DETAILS_ALREADY_REMOVED';
    if (!details) return 'TRIAGE_DETAILS_NOT_COMPOSED';
    return triageDetailProtections(request)[0] ?? null;
  }
  /** What is kept now for the request: the session files of each attempt and the Verdict text. Read outside any commit. */
  async function inventory(request: TriageRequest): Promise<TriageCleanupItem[]> {
    const items: TriageCleanupItem[] = [];
    for (const attempt of request.attempts ?? []) {
      const found = await details?.inventory(attempt.attempt).catch(() => undefined);
      if (found?.state === 'listed') items.push({ kind: 'transcript', attempt: attempt.attempt, sessions: found.sessions, bytes: found.bytes });
    }
    const text = await readTriageVerdictText(session, request.triage_request_id);
    if (text !== undefined) items.push({ kind: 'verdict-text', bytes: Buffer.byteLength(text) });
    return items;
  }
  /** The details record of a request inside a commit, created on first use (re-read: the transaction tracks its own copy of what is assigned). */
  const detailsOf = (request: TriageRequest): TriageDetails => {
    request.details ??= { removal: null, plan: null };
    return request.details;
  };

  async function acceptPlan(input: CleanupInput) {
    const read = await readTriageRequest(session, input.triage_request_id);
    const items = read ? await inventory(read) : [];
    return command(input, async tx => {
      const request = (await tx.doc(triageRequests, input.triage_request_id, null)).request;
      if (!request) return receipt(input, 'not-applied', 'TRIAGE_REQUEST_NOT_FOUND', null);
      const refused = refusal(request);
      if (refused) return receipt(input, 'not-applied', refused, null);
      const plan = triageCleanupPlan({ planId: randomUUID(), request_id: input.request_id, at: stamp(), items, id: request.triage_request_id });
      // A plan that would remove nothing never replaces one that waits for its confirmation.
      if (items.length) detailsOf(request).plan = plan;
      return receipt(input, 'accepted', items.length ? null : 'NOTHING_TO_REMOVE', plan);
    });
  }
  async function acceptConfirm(input: CleanupInput & { operation: 'triage-cleanup-confirm' }) {
    return command(input, async tx => {
      const request = (await tx.doc(triageRequests, input.triage_request_id, null)).request;
      if (!request) return receipt(input, 'not-applied', 'TRIAGE_REQUEST_NOT_FOUND', null);
      const plan = request.details?.plan;
      if (plan?.planId !== input.plan_id) return receipt(input, 'not-applied', 'PLAN_NOT_FOUND', null);
      if (plan.state !== 'planned') return receipt(input, 'already-satisfied', 'PLAN_ALREADY_CONFIRMED', plan);
      // Revalidated now: a plan never removes the details of a request that an Impediment protects meanwhile.
      const refused = refusal(request);
      if (refused) return receipt(input, 'not-applied', refused, plan);
      const at = stamp();
      plan.state = 'confirmed';
      plan.nextStep = 'Confirmed: the details are being removed; `factory triage` shows the result.';
      detailsOf(request).removal = { origin: 'explicit', intendedAt: at, removedAt: null };
      request.timeline.push({ at, event: 'details-removal-intended', code: removalCode.explicit });
      return receipt(input, 'accepted', null, plan);
    });
  }

  /** The intent of the retention, in its own commit, only if the request is still due and unprotected there. */
  async function intend(triage_request_id: string) {
    return session.commit(async tx => {
      const request = (await tx.doc(triageRequests, triage_request_id, null)).request;
      if (!request || request.details?.removal) return;
      if (triageDetailsView(request, { now: deps.now(), retentionDays: deps.retentionDays, calendar }).state !== 'eligible') return;
      const at = stamp();
      detailsOf(request).removal = { origin: 'retention', intendedAt: at, removedAt: null };
      request.timeline.push({ at, event: 'details-removal-intended', code: removalCode.retention });
    }, BACKGROUND_CONTEXT);
  }
  /** The request whose recorded removal intent may be carried out now: not finished yet, and still unprotected. */
  async function pendingRemoval(triage_request_id: string): Promise<TriageRequest | undefined> {
    const request = await readTriageRequest(session, triage_request_id);
    const removal = request?.details?.removal;
    if (!request || !removal || removal.removedAt) return undefined;
    return triageDetailProtections(request).length ? undefined : request;
  }
  /** The tokens of the attempts, measured while their sessions are still there and kept with the intent. */
  async function keepUsage(request: TriageRequest) {
    if (request.details?.usage) return;
    const measured = await requestUsage(request);
    await session.commit(async tx => {
      const current = (await tx.doc(triageRequests, request.triage_request_id, null)).request;
      if (current?.details) current.details.usage = measured;
    }, BACKGROUND_CONTEXT);
  }
  /** Removes the directory of every attempt; the code of a removal that failed, or null when all are gone. */
  async function removeAttempts(store: TriageDetailPorts, request: TriageRequest): Promise<string | null> {
    let failed: string | null = null;
    for (const attempt of request.attempts ?? []) {
      const result = await store.remove(attempt.attempt).catch(() => ({ state: 'failed' as const, code: 'TRIAGE_DETAILS_REMOVAL_FAILED' }));
      if (result.state === 'failed') failed = result.code;
    }
    return failed;
  }
  /** The result of a removal, in one commit: the failure kept on the open intent, or the Verdict text deleted and the removal recorded. */
  async function recordRemoval(triage_request_id: string, failed: string | null) {
    await session.commit(async tx => {
      const current = (await tx.doc(triageRequests, triage_request_id, null)).request;
      const intent = current?.details?.removal;
      if (!current?.details || !intent || intent.removedAt) return;
      if (failed) return void (intent.code = failed);
      (await tx.doc(triageVerdicts, triage_request_id, null)).verdict = null;
      const at = stamp();
      current.details.removal = { origin: intent.origin, intendedAt: intent.intendedAt, removedAt: at };
      const { plan } = current.details;
      if (plan?.state === 'confirmed') Object.assign(plan, { state: 'executed', nextStep: 'Executed: the planned details were removed.' });
      current.timeline.push({ at, event: 'details-removed', code: removalCode[intent.origin] });
    }, BACKGROUND_CONTEXT);
  }
  /**
   * Carries out a recorded removal intent: the tokens are measured and kept first, then each attempt's directory goes, and only when
   * every one is gone the Verdict text is deleted and the removal recorded. A part that fails leaves the intent open for the next sweep.
   */
  async function execute(triage_request_id: string) {
    const request = await pendingRemoval(triage_request_id);
    if (!request || !details) return;
    await keepUsage(request);
    await recordRemoval(triage_request_id, await removeAttempts(details, request));
  }
  /** One request of the sweep: an open intent is carried out; a request whose term is over gets its intent first. */
  async function sweepRequest(request: TriageRequest) {
    const removal = request.details?.removal;
    if (removal?.removedAt) return;
    if (!removal) await intend(request.triage_request_id);
    await execute(request.triage_request_id);
  }

  let lastSweep: number | null = null;
  return {
    /** The Triage views; every other query goes to `inner`, whose `status` and installation `usage` gain their Triage section. */
    async inspect(query: ControlQuery, inner: Inspect): ReturnType<Inspect> {
      if (query.kind === 'triages') return list(query);
      if (query.kind === 'triage') return detail(query.request);
      if (query.kind === 'triage-transcript') return transcript(query);
      const view = await inner(query);
      if (query.kind === 'status') return { ...(view as ControlStatus), ...(await status()) };
      if (query.kind !== 'usage' || query.work_id !== undefined) return view;
      const triage = await usage(query, Math.max(8192, viewBudgetBytes - size(view)));
      return triage ? { ...(view as UsageView), triage } : view;
    },
    /**
     * The early removal commands and the interventions (ticket #81); `inner` accepts every other operation. A confirmed plan is carried
     * out once its receipt is recorded.
     */
    async accept(input: ControlInput, inner: Control['accept']): ReturnType<Control['accept']> {
      const { operation } = input as { operation?: unknown };
      if (isTriageIntervention(operation)) return deps.interventions.accept(input);
      if (!String(operation).startsWith('triage-cleanup-')) return inner(input);
      const parsed = cleanupSchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'INVALID_COMMAND' };
      if (parsed.data.operation === 'triage-cleanup-plan') return acceptPlan(parsed.data);
      const confirmed = await acceptConfirm(parsed.data);
      if (confirmed.kind === 'durable' && confirmed.outcome === 'accepted') await execute(parsed.data.triage_request_id).catch(() => {});
      return confirmed;
    },
    /**
     * The retention of the details, at the first pass of a run and then daily: a terminal request without protection whose term is over
     * loses its transcripts and its Verdict text. An intent a previous pass or process left open is carried out first. Never throws.
     */
    async sweep() {
      const now = deps.now();
      const recent = lastSweep !== null && now - lastSweep < dayMs;
      if (!details || recent) return;
      lastSweep = now;
      for (const request of await readTriageRequests(session)) {
        if (deps.stopped()) return;
        await sweepRequest(request);
      }
    },
  };
}
