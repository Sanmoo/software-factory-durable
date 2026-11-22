// Ticket 29 (spec §2.3 `inspect`, §11.3 history/logs, §12.1-12.2): pure presentation rules of the correlated inspection and consumption.
// Nothing here is authority: the Work's dimensions stay the source; these rules only correlate, page and classify them, without I/O or clocks.
import type { BootUsageReport } from '../../contracts/index.js';
import type { BootConsumptionView, ChainExecutionView, ChainView, CostEstimate, EvidenceState, ExecutionView, HistoryEntryView, InspectionFilter, InspectionRole, ObservationView,
  PageView, QuestionView, TokenUsage, UsageActivityView, UsageAggregate, UsageMeasurement, UsageObservation, WorkView } from '../types.js';

type Work = Omit<WorkView, 'dispatch' | 'limits'>;
type Entry = Work['history'][number];

export const inspectionLimits = Object.freeze({ defaultPage: 50, maxPage: 200, logPageBytes: 16384 });

const reviewerDetail = /^r\d+:(standards|spec)(?::|$)/;
/** Role an entry belongs to: reviewer events by their `r<round>:<role>` detail, other Execution events to the Builder, the rest to the Work. */
export function entryRole(entry: Entry): InspectionRole | null {
  if (!('executionId' in entry) || !entry.executionId) return null;
  const detail = 'detail' in entry && typeof entry.detail === 'string' ? entry.detail : '';
  const reviewer = reviewerDetail.exec(detail);
  if (reviewer && /^(reviewer-|opinion-)/.test(entry.event)) return reviewer[1] as InspectionRole;
  return entry.origin === 'controller-dispatch' || entry.origin === 'controller-clock' || entry.origin === 'controller-recovery' ? 'builder' : null;
}

/** Identities an entry refers to (Execution, Question, correction, feedback, scope update), for navigation. */
export function entryLinks(entry: Entry): Record<string, string> {
  const links: Record<string, string> = {};
  for (const key of ['executionId', 'questionId', 'correctionId', 'feedbackId', 'scopeUpdateId', 'evaluationId'] as const) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value === 'string' && value) links[key] = value;
  }
  return links;
}

/** Bounded page arguments: absent = defaults; invalid values never widen the page. */
export function pageArguments(filter: InspectionFilter): { cursor: number; limit: number } {
  const cursor = Number.isSafeInteger(filter.cursor) && filter.cursor! >= 0 ? filter.cursor! : 0;
  const limit = Number.isSafeInteger(filter.limit) && filter.limit! >= 1 ? Math.min(filter.limit!, inspectionLimits.maxPage) : inspectionLimits.defaultPage;
  return { cursor, limit };
}

export function page<T>(items: T[], total: number, filter: InspectionFilter): { items: T[]; page: PageView } {
  const { cursor, limit } = pageArguments(filter);
  const slice = items.slice(cursor, cursor + limit);
  const next = cursor + slice.length;
  return { items: slice, page: { cursor, limit, returned: slice.length, filtered: items.length, total, nextCursor: next < items.length ? next : null, fitted: false } };
}

/** History filtered by Execution/role, oldest first, each entry with its sequence (index in the Work's append-only history). */
export function historyEntries(work: Work, filter: InspectionFilter): HistoryEntryView[] {
  return work.history.map((entry, sequence) => ({ sequence, role: entryRole(entry), executionId: 'executionId' in entry ? entry.executionId ?? null : null,
    links: entryLinks(entry), entry }))
    .filter(item => (filter.execution === undefined || item.executionId === filter.execution) && (filter.role === undefined || item.role === filter.role));
}

/** Cut a page from its end until its serialization fits `maxBytes` (one protocol frame); at least one item, else nothing. */
/** A pager always makes progress: a single item larger than the budget is returned through `trim` (a marked, bounded form of it). */
export function fitPage<T>(items: T[], pageView: PageView, size: (items: T[]) => number, maxBytes: number, trim?: (item: T) => T): { items: T[]; page: PageView } {
  let kept = items;
  while (kept.length > 0 && size(kept) > maxBytes) kept = kept.slice(0, Math.max(0, Math.floor(kept.length * 0.7)));
  const trimmed = kept.length === 0 && items.length > 0 && trim !== undefined;
  if (trimmed) kept = [trim(items[0]!)];
  if (kept.length === items.length && !trimmed) return { items, page: pageView };
  const next = pageView.cursor + kept.length;
  return { items: kept, page: { ...pageView, returned: kept.length, nextCursor: next < pageView.filtered ? next : null, fitted: true } };
}

export function executionsOf(work: Work): ExecutionView[] {
  return [...work.previousExecutions, ...(work.execution && !work.previousExecutions.some(item => item.executionId === work.execution!.executionId) ? [work.execution] : [])];
}

function purposeOf(execution: ExecutionView): ChainExecutionView['purpose'] {
  if (execution.request.publication) return 'publication';
  if (execution.request.reconciliation) return 'reconciliation';
  if (execution.request.repair) return 'repair';
  if (execution.interruption) return 'recovery';
  if (execution.request.resume) return 'resumption';
  return execution.mode === 'recovery' ? 'recovery' : 'implementation';
}

function chainExecution(execution: ExecutionView): ChainExecutionView {
  return { executionId: execution.executionId, mode: execution.mode, state: execution.state, phase: execution.dispatch.phase, purpose: purposeOf(execution),
    outcome: execution.end?.outcome ?? null, code: execution.end?.code ?? execution.held?.code ?? null, environment: execution.dispatch.environment, boot: execution.dispatch.boot,
    startedAt: execution.start?.confirmedAt ?? null, endedAt: execution.end?.at ?? null,
    charge: execution.charge ? `${execution.charge.kind}:${execution.charge.state}` : null,
    duration: execution.timing?.duration?.kind ?? (execution.start ? 'unknown' : 'not-started'),
    verification: execution.review?.verification?.status ?? null, recoveries: execution.recovery?.length ?? 0,
    blockedRequest: execution.blockedRequest ? { reference: execution.blockedRequest.reference, code: execution.blockedRequest.code,
      state: execution.blockedRequest.override ? 'overridden' : 'blocking', override: execution.blockedRequest.override
        ? { request_id: execution.blockedRequest.override.request_id, at: execution.blockedRequest.override.at, operator: execution.blockedRequest.override.operator } : null } : null,
    blockedStart: execution.blockedStart ? { code: execution.blockedStart.code, detail: execution.blockedStart.detail, state: execution.blockedStart.retry ? 'retried' : 'blocking',
      retry: execution.blockedStart.retry ? { request_id: execution.blockedStart.retry.request_id, at: execution.blockedStart.retry.at, remedy: execution.blockedStart.retry.remedy } : null } : null,
    reviews: (execution.review?.rounds ?? []).map(round => ({ round: round.round, attempt: round.attempt, kind: round.kind ?? 'review', conclusion: round.conclusion,
      reviewers: (['standards', 'spec'] as const).filter(role => round.reviewers?.[role]).map(role => {
        const reviewer = round.reviewers[role];
        return { role, state: reviewer.state, attempt: reviewer.attempt ?? 1, conclusion: reviewer.opinion?.conclusion ?? reviewer.failure?.code ?? null,
          source: reviewer.source ?? (reviewer.opinion ? 'notification' : null), opinion: reviewer.opinion ? `${reviewer.opinion.reference.workId}/${reviewer.opinion.reference.id}` : null };
      }) })) };
}


/** Phase/wait of the Work from its dimensions, in priority order (presentation only). */
export function phaseOf(work: Work, questions: QuestionView[]): ChainView['phase'] {
  const first = work.impediments[0];
  const open = questions.find(question => question.state === 'open');
  if (work.result === 'delivered') {
    const cleanup = work.cleanup;
    return cleanup && cleanup.state !== 'complete' ? { code: 'delivered-cleanup-' + cleanup.state, waitingFor: cleanup.state === 'waiting' ? 'cleanup-eligibility' : 'cleanup', nextStep: cleanup.nextStep }
      : { code: 'delivered', waitingFor: null, nextStep: null };
  }
  const execution = work.execution;
  if (execution && (execution.state === 'started' || execution.state === 'reserved') && execution.slot.held) {
    const reviewing = execution.review?.rounds.some(round => round.state === 'reviewing');
    return { code: reviewing ? 'reviewing' : 'executing', waitingFor: null, nextStep: null };
  }
  if (open) return { code: 'awaiting-answer', waitingFor: 'question:' + open.questionId, nextStep: `Answer with \`factory answer ${open.questionId} <text>\` or on the Ticket.` };
  if (first) return { code: 'blocked', waitingFor: 'impediment:' + first.code, nextStep: first.nextStep };
  if (work.queue.pending) return { code: work.queue.category === 'repair' ? 'queued-repair' : 'queued', waitingFor: 'slot-or-dependencies', nextStep: null };
  if (work.delivery?.state === 'watching' && work.readiness) {
    return { code: 'awaiting-human', waitingFor: work.readiness.internal === 'ready' ? 'human-review-and-merge' : 'readiness', nextStep: work.readiness.nextStep };
  }
  if (work.publication) return { code: 'publication-' + work.publication.state, waitingFor: null, nextStep: work.publication.nextStep };
  return { code: 'idle', waitingFor: null, nextStep: null };
}

/** The correlated chain of one Work (spec §12.1): identities, Executions/reviews, stages and references, plus observation freshness. */
export function chainOf(work: Work, questions: QuestionView[], input: { timeoutSeconds: number | null; lastPolledAt: string | null;
  /** Completeness of the repository's latest polling read (null: not observed this run). */ lastPolledCompleteness?: string | null;
  /** Seconds since an instant (injected calendar), null when unknown. */ ageSeconds(at: string | null): number | null }): ChainView {
  const ageOf = (at: string | null) => input.ageSeconds(at);
  const executions = executionsOf(work);
  const references: ChainView['references'] = [];
  const models: ChainView['models'] = [];
  const seenModel = new Set<string>();
  const model = (role: InspectionRole, provider: string, name: string, source: 'builder-session' | 'opinion') => {
    const key = `${role}:${provider}:${name}`;
    if (!seenModel.has(key)) { seenModel.add(key); models.push({ role, provider, model: name, source }); }
  };
  for (const question of questions) references.push({ kind: 'question-content', executionId: question.executionId, reference: `${question.content.reference.workId}/${question.content.reference.id}` });
  for (const execution of executions) {
    if (execution.start) references.push({ kind: 'start-receipt', executionId: execution.executionId, reference: execution.start.receiptId });
    const session = execution.end?.session;
    if (session) {
      references.push({ kind: 'builder-session', executionId: execution.executionId, reference: session.ref });
      model('builder', session.profile.providerId, session.profile.modelId, 'builder-session');
    }
    for (const round of execution.review?.rounds ?? []) for (const role of ['standards', 'spec'] as const) {
      const opinion = round.reviewers?.[role]?.opinion;
      if (!opinion) continue;
      references.push({ kind: 'opinion', executionId: execution.executionId, reference: `${opinion.reference.workId}/${opinion.reference.id}` });
      if (opinion.session.file) references.push({ kind: 'reviewer-session', executionId: execution.executionId, reference: opinion.session.file });
      model(role, opinion.model.providerId, opinion.model.modelId, 'opinion');
    }
  }
  for (const evidence of work.cleanup?.evidence ?? []) if (evidence.reference) {
    references.push({ kind: 'preserved-evidence', executionId: null, reference: `${evidence.reference.workId}/${evidence.reference.id}` });
  }
  const last = work.history.at(-1);
  const pull = work.publication?.pullRequest ?? null;
  const observations: ObservationView[] = [
    // `complete` only with the read's own completeness proof; an observation without it is `unproven`.
    { source: 'polling', observedAt: input.lastPolledAt, ageSeconds: ageOf(input.lastPolledAt),
      completeness: !input.lastPolledAt ? 'not-observed-this-run' : input.lastPolledCompleteness ?? 'unproven' },
    { source: 'dependencies', observedAt: work.dependencies.latest?.observedAt ?? null, ageSeconds: ageOf(work.dependencies.latest?.observedAt ?? null),
      completeness: work.dependencies.latest?.completeness ?? 'not-evaluated' },
  ];
  if (work.publication) {
    const discovery = work.publication.discoveries.at(-1);
    observations.push({ source: 'publication', observedAt: discovery?.observedAt ?? null, ageSeconds: ageOf(discovery?.observedAt ?? null),
      completeness: !discovery ? 'not-observed' : discovery.outcome === 'incomplete' || discovery.branch.state === 'unknown' ? 'incomplete' : 'complete' });
  }
  if (work.checks) observations.push({ source: 'checks', observedAt: work.checks.latest.observedAt, ageSeconds: ageOf(work.checks.latest.observedAt),
    completeness: Object.values(work.checks.latest.completeness).every(value => value === 'complete' || value === 'not-applicable') ? 'complete' : 'incomplete' });
  if (work.readiness) observations.push({ source: 'readiness', observedAt: work.readiness.latest.at, ageSeconds: ageOf(work.readiness.latest.at),
    completeness: work.readiness.latest.decision === 'unknown' ? 'incomplete' : `derived-${work.readiness.latest.source}` });
  if (work.delivery) {
    const read = work.delivery.observations.at(-1);
    observations.push({ source: 'delivery', observedAt: read?.observedAt ?? null, ageSeconds: ageOf(read?.observedAt ?? null),
      completeness: !read ? 'not-observed' : read.outcome === 'unavailable' || read.outcome === 'merge-unconfirmed' ? 'incomplete' : 'complete' });
  }
  if (work.feedback) observations.push({ source: 'feedback', observedAt: work.feedback.observedAt, ageSeconds: ageOf(work.feedback.observedAt),
    completeness: work.feedback.observedAt ? 'unproven' : 'not-observed' });
  const feedback = work.feedback?.requests ?? [];
  return {
    ticket: work.ticket.tracker === 'github' ? { repository: work.ticket.repository, number: work.ticket.number, url: work.ticket.url } : { key: work.ticket.key, url: work.ticket.url },
    work: { work_id: work.work_id, cycle: work.cycle, predecessor: work.predecessor, result: work.result, admittedAt: work.admittedAt, branch: work.branch },
    phase: phaseOf(work, questions),
    lastActivity: last ? { at: last.at, event: last.event } : null,
    executions: executions.map(chainExecution),
    questions: questions.map(question => ({ questionId: question.questionId, executionId: question.executionId, state: question.state, publication: question.publication.state,
      url: question.publication.comment?.url ?? null })),
    corrections: { current: work.correction ? { correctionId: work.correction.correctionId, trigger: work.correction.trigger ?? null, consumed: work.correction.consumed } : null,
      closed: work.corrections?.length ?? 0, feedback: { pending: feedback.filter(item => item.state === 'pending').length, total: feedback.length } },
    publication: work.publication ? { state: work.publication.state, pullRequest: pull ? { number: pull.number, url: pull.url, draft: pull.draft, state: pull.merged ? 'merged' : pull.state } : null,
      verifiedHead: work.publication.verified?.head ?? null, nextStep: work.publication.nextStep } : null,
    checks: work.checks ? { outcome: work.checks.latest.outcome, headSha: work.checks.latest.pullRequest.headSha, at: work.checks.latest.at } : null,
    readiness: work.readiness ? { internal: work.readiness.internal, flag: work.readiness.flag.observed, nextStep: work.readiness.nextStep } : null,
    delivery: work.delivery ? { state: work.delivery.state, mergedAt: work.delivery.merge?.mergedAt ?? null, mergeCommitSha: work.delivery.merge?.mergeCommitSha ?? null } : null,
    cleanup: work.cleanup ? { state: work.cleanup.state, resources: work.cleanup.resources.map(item => ({ kind: item.kind, state: item.state })), nextStep: work.cleanup.nextStep } : null,
    references, models,
    configuration: { builder: executions.at(-1)?.request.policies ?? null, timeoutSeconds: input.timeoutSeconds },
    observations,
  };
}

// ---- Consumption ----

const zero = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total });

/** One role activity whose usage is to be measured: its session as recorded, and the evidence state of that session if already known. */
export type UsageSubject = { executionId: string; role: InspectionRole; round: number | null; attempt: number | null; invocationId: string | null; outcome: string | null;
  session: { sessionId: string | null; mode: string | null } | null;
  /** Why no session can be read (never recorded, removed by an own cleanup...), or null when it should be read. */
  missing: { state: EvidenceState; code: string } | null;
  /** Acceptance finding A7: the Builder of an Execution whose boot was LOST. It returned no session, so none was recorded; the session it
   * left in the lost `boot` is looked up by its invocation and, when found, measured as partial (it ended by loss, with no recorded hash). */
  lost?: { boot: string } };
/** The code of a measured session that ended by the loss of its boot (finding A7): counted, never complete. */
export const sessionEndedByLossCode = 'SESSION_ENDED_BY_LOSS';

/**
 * Usage of one activity from its session observation. `counted` holds `sessionId:entryId` of entries already attributed to an earlier
 * activity of the Work: a continued session carries them and they are never summed again (spec §12.1). Mutates `counted`.
 */
export function usageActivity(subject: UsageSubject, observation: UsageObservation | null, counted: Set<string>, removedByCleanup: boolean | 'expired' | 'removed' = false): UsageActivityView {
  // A session file the Work's own cleanup removed is `removed`; one whose Records copy a retention sweep removed is `expired` (ticket 30). Never absent or zero.
  if (!subject.missing && observation?.state === 'lost' && removedByCleanup) {
    subject = { ...subject, missing: removedByCleanup === 'expired' ? { state: 'expired', code: 'SESSION_EXPIRED_BY_RETENTION' }
      : { state: 'removed', code: removedByCleanup === 'removed' ? 'SESSION_REMOVED_BY_EXPLICIT_CLEANUP' : 'SESSION_REMOVED_BY_CLEANUP' } };
  }
  const base = { executionId: subject.executionId, role: subject.role, round: subject.round, attempt: subject.attempt, invocationId: subject.invocationId, outcome: subject.outcome };
  if (subject.missing || !observation || observation.state !== 'read') {
    const code = subject.missing?.code ?? (observation && observation.state !== 'read' ? observation.code : 'USAGE_OBSERVATION_NOT_COMPOSED');
    const state: EvidenceState = subject.missing?.state ?? (observation?.state === 'lost' ? 'absent' : 'unknown');
    return { ...base, session: { sessionId: subject.session?.sessionId ?? null, mode: subject.session?.mode ?? null, state }, models: [], measurement: 'unavailable', code,
      carriedEntries: 0, entries: 0, failedOrAborted: 0, tokens: null, cost: null };
  }
  let tokens = zero();
  let cost = 0;
  let costKnown = true;
  let carried = 0;
  let entries = 0;
  let failed = 0;
  const models = new Map<string, { provider: string | null; model: string | null }>();
  for (const entry of observation.entries) {
    const key = `${observation.sessionId}:${entry.id}`;
    if (counted.has(key)) { carried++; continue; }
    counted.add(key);
    entries++;
    tokens = add(tokens, entry.tokens);
    if (entry.cost === null) costKnown = false; else cost += entry.cost;
    if (entry.outcome === 'error' || entry.outcome === 'aborted') failed++;
    models.set(`${entry.provider}:${entry.model}`, { provider: entry.provider, model: entry.model });
  }
  // Entries the SDK wrote but we cannot read, or a session whose integrity cannot be verified (no recorded hash): partial, never complete.
  // A session that ended by the loss of its boot (finding A7) is what was written until then: counted, and partial too.
  const partial = observation.malformed > 0 || observation.integrity === 'unverified' || Boolean(subject.lost);
  return { ...base, session: { sessionId: observation.sessionId, mode: subject.session?.mode ?? null, state: subject.lost ? 'partial' : 'complete' }, models: [...models.values()],
    measurement: partial ? 'partial' : 'complete', code: observation.malformed > 0 ? 'USAGE_ENTRIES_UNREADABLE' : subject.lost ? sessionEndedByLossCode : partial ? 'SESSION_INTEGRITY_UNVERIFIED' : null,
    carriedEntries: carried, entries, failedOrAborted: failed,
    tokens, cost: costKnown && entries > 0 ? { total: round(cost), unit: 'sdk-catalog-estimate', currency: null } : entries === 0 ? { total: 0, unit: 'sdk-catalog-estimate', currency: null } : null };
}

const round = (value: number) => Math.round(value * 1e9) / 1e9;

/** Aggregate of activities: totals sum ONLY measured parts; `complete` only when every activity is complete (zero only when observed). */
export function aggregateUsage(activities: UsageActivityView[]): UsageAggregate {
  const measured = activities.filter(item => item.measurement !== 'unavailable');
  const unavailable = activities.length - measured.length;
  const measurement: UsageMeasurement = activities.length === 0 ? 'unavailable' : measured.length === 0 ? 'unavailable'
    : measured.every(item => item.measurement === 'complete') && unavailable === 0 ? 'complete' : 'partial';
  const tokens = measured.length ? measured.reduce((sum, item) => add(sum, item.tokens!), zero()) : null;
  const costs = measured.map(item => item.cost);
  const cost: CostEstimate | null = measured.length && costs.every(item => item !== null)
    ? { total: round(costs.reduce((sum, item) => sum + item!.total, 0)), unit: 'sdk-catalog-estimate', currency: null } : null;
  return { measurement, activities: activities.length, measured: measured.length, unavailable, tokens, cost };
}

/** Aggregate of aggregates (Work → installation), with the same completeness rule. */
export function combineAggregates(parts: UsageAggregate[]): UsageAggregate {
  const activities = parts.reduce((sum, item) => sum + item.activities, 0);
  const measured = parts.reduce((sum, item) => sum + item.measured, 0);
  const unavailable = parts.reduce((sum, item) => sum + item.unavailable, 0);
  const withTokens = parts.filter(item => item.tokens);
  const measurement: UsageMeasurement = measured === 0 ? 'unavailable' : unavailable === 0 && parts.every(item => item.measurement === 'complete' || item.activities === 0) ? 'complete' : 'partial';
  const costParts = parts.filter(item => item.measured > 0);
  return { measurement, activities, measured, unavailable, tokens: withTokens.length ? withTokens.reduce((sum, item) => add(sum, item.tokens!), zero()) : null,
    cost: costParts.length && costParts.every(item => item.cost) ? { total: round(costParts.reduce((sum, item) => sum + item.cost!.total, 0)), unit: 'sdk-catalog-estimate', currency: null } : null };
}

/** The role activities of a Work, oldest first: each Builder Execution and each reviewer attempt (failures included when they ran). */
export function usageSubjects(work: Work): UsageSubject[] {
  const subjects: UsageSubject[] = [];
  for (const execution of executionsOf(work)) {
    const session = execution.end?.session ?? null;
    const started = execution.start !== null;
    // Finding A7: a started Execution that ended by a recorded loss returned no session; the one it left in the lost boot is looked up.
    const loss = started && !session && execution.end ? (work.losses ?? []).findLast(item => item.executionId === execution.executionId) : undefined;
    subjects.push({ executionId: execution.executionId, role: 'builder', round: null, attempt: null, invocationId: execution.invocationId, outcome: execution.end?.outcome ?? execution.state,
      session: session ? { sessionId: session.sessionId, mode: execution.request.session?.mode ?? 'new' } : loss ? { sessionId: null, mode: execution.request.session?.mode ?? 'new' } : null,
      missing: !started ? { state: 'absent', code: 'NOT_STARTED' } : !session && !loss ? { state: 'unknown', code: 'SESSION_NOT_RECORDED' } : null, ...(loss ? { lost: { boot: loss.boot } } : {}) });
    for (const reviewRound of execution.review?.rounds ?? []) for (const role of ['standards', 'spec'] as const) {
      const reviewer = reviewRound.reviewers?.[role];
      if (!reviewer || reviewer.state === 'not-required' || reviewer.source === 'carried') continue;
      const file = reviewer.opinion?.session.file ?? null;
      subjects.push({ executionId: execution.executionId, role, round: reviewRound.round, attempt: reviewer.attempt ?? 1, invocationId: reviewer.invocationId,
        outcome: reviewer.opinion?.conclusion ?? reviewer.failure?.code ?? reviewer.state,
        session: reviewer.opinion ? { sessionId: null, mode: reviewer.opinion.session.mode ?? 'new' } : null,
        missing: reviewer.receiptId === null && reviewer.state !== 'ended' ? { state: 'absent', code: 'NOT_STARTED' } : !file ? { state: 'unknown', code: 'SESSION_NOT_RECORDED' } : null });
    }
  }
  return subjects;
}

/** Session `file` of a subject (reviewers) or the Builder ref, for the usage port; null when nothing can be read. */
export function sessionLocator(work: Work, subject: UsageSubject): { ref: string; sha256: string } | { file: string } | { invocation: { executionId: string; invocationId: string } } | null {
  if (subject.missing) return null;
  const execution = executionsOf(work).find(item => item.executionId === subject.executionId);
  if (!execution) return null;
  if (subject.role === 'builder') return execution.end?.session ? { ref: execution.end.session.ref, sha256: execution.end.session.sha256 }
    : subject.lost ? { invocation: { executionId: execution.executionId, invocationId: execution.invocationId } } : null;
  for (const reviewRound of execution.review?.rounds ?? []) {
    const reviewer = reviewRound.round === subject.round ? reviewRound.reviewers?.[subject.role as 'standards' | 'spec'] : undefined;
    if (reviewer?.invocationId === subject.invocationId && reviewer.opinion?.session.file) return { file: reviewer.opinion.session.file };
  }
  return null;
}

/**
 * Ticket 30: the Records copy of a subject's session (Builder: `session:<execution>` with the recorded hash; reviewer: the `--rv-` copy whose
 * source is the recorded file), preserved before its environment was removed; and whether that copy was itself removed afterwards
 * (`expired` by a retention sweep, `removed` by an explicit cleanup).
 */
export function sessionCopy(work: Work, subject: UsageSubject, locator: { ref: string; sha256: string } | { file: string } | { invocation: object } | null):
  { copy: { name: string; sha256: string } | null; removal: 'expired' | 'removed' | null } {
  const sessions = work.retention?.sessions ?? [];
  const preserved = sessions.find(item => item.executionId === subject.executionId && item.state === 'preserved' &&
    (subject.role === 'builder' ? item.role === 'builder' && (!locator || !('sha256' in locator) || item.sha256 === locator.sha256)
      : item.role === 'reviewer' && !!locator && 'file' in locator && locator.file.endsWith(`/${item.sourceRef}`)));
  if (!preserved) return { copy: null, removal: null };
  const removal = (work.retention?.removals ?? []).find(item => item.kind === 'session' && item.id === preserved.id && item.outcome === 'removed');
  return { copy: removal ? null : { name: preserved.id.slice('session:'.length), sha256: preserved.sha256 },
    removal: removal ? (removal.origin === 'retention' ? 'expired' : 'removed') : null };
}

/** Ticket 30: a capture id the Work's retention or explicit cleanup removed (`log:<id>`): `expired` / `removed`, else null. */
export function captureRemoval(work: Work, capture: string): 'expired' | 'removed' | null {
  const removal = (work.retention?.removals ?? []).find(item => item.kind === 'log' && item.id === `log:${capture}` && item.outcome === 'removed');
  return removal ? (removal.origin === 'retention' ? 'expired' : 'removed') : null;
}

/** Evidence state of a listed capture (spec §12.2): incomplete captures are `partial`, never `complete`; removal evidence wins. */
export function captureState(capture: { state: 'complete' | 'partial' }, removal: 'removed' | 'expired' | null): EvidenceState {
  if (removal) return removal;
  return capture.state === 'complete' ? 'complete' : 'partial';
}

/** Evidence state of one page read: the full content is `complete` only when this page reaches its end; otherwise it is `truncated`. */
export function pageState(read: { state: 'complete' | 'partial' | 'absent'; nextOffset: number; bytes: number }): EvidenceState {
  if (read.state === 'absent') return 'absent';
  if (read.state === 'partial') return 'partial';
  return read.nextOffset >= read.bytes ? 'complete' : 'truncated';
}

/** Bounded, marked form of a history entry whose detail alone exceeds a page (the full entry stays in the authority). */
export function trimEntry(item: HistoryEntryView): HistoryEntryView {
  const detail = 'detail' in item.entry && typeof item.entry.detail === 'string' ? item.entry.detail : '';
  return { ...item, entry: { ...item.entry, ...(detail ? { detail: `${detail.slice(0, 2048)}[TRUNCATED ${detail.length} characters]` } : {}) } as HistoryEntryView['entry'] };
}

/** Compacted Work view (to fit one frame): no history, no earlier Executions, current Execution without review rounds, bounded side histories. */
export function compactWork<T extends WorkView>(work: T): T {
  const execution = work.execution && work.execution.review ? { ...work.execution, review: { ...work.execution.review, rounds: [] } } : work.execution;
  return { ...work, history: [], previousExecutions: [], execution,
    ...(work.publication ? { publication: { ...work.publication, discoveries: work.publication.discoveries.slice(-1), divergences: [] } } : {}),
    ...(work.checks ? { checks: { ...work.checks, history: [] } } : {}),
    compacted: { history: work.history.length, previousExecutions: work.previousExecutions.length,
      nextStep: `factory history ${work.work_id} (history), factory show ${work.work_id} --limit <n> (executions)` } };
}

/**
 * v2 ticket 14 (V2-32): the seconds of one Work's boots, folded from what the sandbox reported for each of its environments (`null`: the
 * report could not be obtained). Only measured boots are summed. A boot still running, or whose final observation was not possible, makes
 * the total a lower bound and is counted apart: unknown is never zero. A refused start ran nothing and adds nothing.
 */
export function bootConsumption(reports: readonly (BootUsageReport | null)[], limit = 50): BootConsumptionView {
  const reported = reports.filter((report): report is Extract<BootUsageReport, { status: 'reported' }> => report?.status === 'reported');
  const missing = reports.find(report => report?.status !== 'reported');
  const code = reports.length === 0 ? 'ENVIRONMENT_NOT_PREPARED' : missing === undefined ? null : missing === null ? 'BOOT_USAGE_OBSERVATION_FAILED' : (missing as { code: string }).code;
  const boots = reported.flatMap(report => report.boots);
  let milliseconds = 0, measured = 0, running = 0, unknown = 0, notRun = 0;
  for (const boot of boots) {
    if (boot.state === 'measured' && typeof boot.seconds === 'number' && Number.isFinite(boot.seconds) && boot.seconds >= 0) { measured++; milliseconds += Math.round(boot.seconds * 1000); }
    else if (boot.state === 'not-run') notRun++;
    else if (boot.state === 'running') running++;
    else unknown++;
  }
  const lowerBound = running + unknown > 0 || (reported.length > 0 && code !== null);
  const nothing = reported.length === 0 || (measured === 0 && lowerBound);
  return { unit: reported[0]?.unit ?? null, seconds: nothing ? null : milliseconds / 1000, measured, running, unknown, notRun, lowerBound,
    measurement: nothing ? 'unavailable' : lowerBound ? 'partial' : 'complete', code, omitted: Math.max(0, boots.length - limit), items: boots.slice(-limit) };
}
