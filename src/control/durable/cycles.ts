import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AccessDependencies, ControlInput, ControlReceipt, CycleEvent, Impediment, WorkView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { initialBudget } from '../rules/budget.js';
import { authorizationChange, authorizationFacts, cancelDecision, cycleImpediments, hasImpediment, newCycleDecision, occupying, reopenDecision, resumeDecision,
  settleCancellation } from '../rules/cycles.js';
import { decideMerge, ownPullRequestOf } from '../rules/delivery.js';
import { requests, ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

// Ticket 25 durable commits and the cycle desk (spec §3.4 "Aceitar comando", "Interromper/cancelar", "Confirmar efeito"; §4.1; §11.3; §12.3).
// Remote reads/effects happen OUTSIDE the commits; every commit re-checks the Work, its cycle and the occurrence it records.

type CycleInput = Extract<ControlInput, { operation: 'cancel' | 'resume' | 'reopen' | 'new' }>;
type Receipt = Extract<ControlReceipt, { operation: 'cancel' | 'resume' | 'reopen' | 'new' }>;
type Index = { tickets: Record<string, { current: string; previous: string[] }>; memory?: Record<string, { cycles: { work_id: string; cycle: number; result: WorkView['result']; mergeConfirmed: boolean }[] }> };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const history = (work: WorkRecord, event: CycleEvent,
  origin: 'controller-cycles' | 'local-cli', detail: string, at = new Date().toISOString()) => work.history.push({ at, event, origin, detail: detail.slice(0, 512) });
const addImpediment = (work: WorkRecord, impediment: Impediment) => { if (!hasImpediment(work, impediment.code)) work.impediments.push(impediment); };
const removeImpediments = (work: WorkRecord, codes: string[]) => { work.impediments = work.impediments.filter(item => !codes.includes(item.code)); };
/** The Ticket's explicit minimal memory (spec §12.4) follows the cycle's result in the same commit. */
export function rememberResult(index: Index, work: WorkRecord) {
  const key = ticketKey(work.ticket);
  const cycles = index.memory?.[key]?.cycles ?? [];
  const entry = { work_id: work.work_id, cycle: work.cycle, result: work.result, mergeConfirmed: work.result === 'delivered' && Boolean(work.delivery?.merge) };
  index.memory = { ...(index.memory ?? {}), [key]: { cycles: cycles.some(item => item.work_id === work.work_id) ? cycles.map(item => item.work_id === work.work_id ? entry : item) : [...cycles, entry] } };
}

/** Deduplicated "Aceitar comando": same identity + content returns the recorded receipt; same identity + other content is a conflict. */
async function command(session: Session, input: CycleInput, decide: (tx: Parameters<Parameters<Session['commit']>[0]>[0]) => Promise<Receipt>): Promise<Receipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return copy(request.receipt) as Receipt;
    }
    const receipt = await decide(tx);
    request.input = input;
    request.receipt = receipt;
    return copy(receipt);
  }, BACKGROUND_CONTEXT);
}
const receiptOf = (input: CycleInput, work_id: string | null, outcome: Receipt['outcome'], reason: string | null, created: string | null = null): Receipt =>
  ({ kind: 'durable', request_id: input.request_id, operation: input.operation, work_id, outcome, reason, created });

/**
 * `cancel <work>` (spec §3.4 "Interromper/cancelar", §12.3): in ONE commit the prohibition (result `cancelled`, impediment, queue work dropped,
 * Ticket memory) and the stop intent are durable BEFORE anything is interrupted. The caller then withdraws credentials and requests the stop;
 * the Slot is released only by the confirmed cessation. Branch, PR, artifacts and GitHub are never touched.
 */
export async function acceptCancel(session: Session, input: CycleInput & { operation: 'cancel' }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const decision = cancelDecision(work, work ? index.tickets[ticketKey(work.ticket)]?.current === work.work_id : false);
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', 'ALREADY_CANCELLED');
    const at = new Date().toISOString();
    const active = work!.execution && occupying(work!.execution) ? work!.execution.executionId : null;
    work!.result = 'cancelled';
    work!.cancellation = { request_id: input.request_id, requestedAt: at, state: 'stopping', ceasedAt: null, executionId: active,
      nextStep: 'Cancellation recorded: credentials are withdrawn and the stop requested; the Slot is released only after the confirmed cessation. Nothing on GitHub is undone.' };
    addImpediment(work!, { code: cycleImpediments.cancelled, scope: 'work', since: at, nextStep: 'Cancelled by the operator: no new action, publication or renewal. ' +
      '`factory new <owner/repo#number>` starts another cycle once cessation is confirmed.' });
    history(work!, 'cancel-requested', 'local-cli', `${input.request_id}${active ? `:active:${active}` : ''}`, at);
    if (settleCancellation(work!, at)) history(work!, 'cancellation-ceased', 'controller-cycles', 'no own activity was running', at);
    rememberResult(index, work!);
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/** `resume <work>`: removes ONLY the suspension codes it answers and leaves a pending-read impediment; never touches any other impediment. */
export async function acceptResume(session: Session, input: CycleInput & { operation: 'resume' }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const decision = resumeDecision(work, work ? index.tickets[ticketKey(work.ticket)]?.current === work.work_id : false);
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', decision.code);
    const at = new Date().toISOString();
    removeImpediments(work!, decision.remove);
    addImpediment(work!, { code: cycleImpediments.resumePending, scope: 'work', since: at, nextStep: 'Resume accepted: the next complete read of the Ticket must ' +
      'show it open with the configured label; then the Work re-enters its queue position. Other impediments still apply.' });
    history(work!, 'resume-accepted', 'local-cli', `${input.request_id}:${decision.remove.join(',')}`, at);
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/** `reopen <work>`: the reopen effect is INTENDED here; the cycle desk observes, sends at most once and confirms (an ACK is not the effect). */
export async function acceptReopen(session: Session, input: CycleInput & { operation: 'reopen' }) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const decision = reopenDecision(work, work ? index.tickets[ticketKey(work.ticket)]?.current === work.work_id : false, work ? ownPullRequestOf(work) !== null : false);
    if (decision.kind === 'refuse') return receiptOf(input, input.work_id, 'not-applied', decision.code);
    if (decision.kind === 'already') return receiptOf(input, input.work_id, 'already-satisfied', decision.code);
    const at = new Date().toISOString();
    const effectId = randomUUID();
    work!.closure!.reopen = { effectId, request_id: input.request_id, intendedAt: at, state: 'intended', sendingAt: null, attempt: null, observation: null, settledAt: null };
    work!.closure!.nextStep = 'Reopen intended: the own pull request is observed and reopened at most once; confirming it does not resume the Work (`factory resume`).';
    history(work!, 'reopen-intended', 'local-cli', `${input.request_id}:${effectId}`, at);
    return receiptOf(input, work!.work_id, 'accepted', null);
  });
}

/**
 * `new <owner/repo#number>` (spec §4.1): a NEW Work for the Ticket with predecessor, cycle + 1, its own budget, branch and environment, in the
 * same commit as the index (current/previous) and the Ticket memory. It starts suspended until its first complete authorization read and
 * its first dependency evaluation; nothing of the predecessor (PR, branch, environment) is adopted, closed or removed.
 */
export async function acceptNewCycle(session: Session, input: CycleInput & { operation: 'new' },
  limits: (repository: string) => { correctionLimit?: number | undefined; recoveryLimit?: number | undefined } | undefined) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    let predecessor: WorkRecord | null = null;
    let key: string | null = null;
    for (const [entryKey, entry] of Object.entries(index.tickets)) {
      const work = (await tx.doc(works, entry.current, null)).work;
      if (work && work.ticket.repository.toLowerCase() === input.ticket.repository.toLowerCase() && work.ticket.number === input.ticket.number) { predecessor = work; key = entryKey; break; }
    }
    const decision = newCycleDecision(predecessor, { keepPredecessorPullRequest: input.keepPredecessorPullRequest, ownPullRequest: predecessor ? ownPullRequestOf(predecessor) !== null : false });
    if (decision.kind === 'refuse') return receiptOf(input, predecessor?.work_id ?? null, 'not-applied', decision.code);
    const configured = limits(predecessor!.repository.repository);
    if (!configured) return receiptOf(input, predecessor!.work_id, 'not-applied', 'REPOSITORY_NOT_CONFIGURED');
    const at = new Date().toISOString();
    const work_id = randomUUID();
    const document = await tx.doc(works, work_id, null);
    if (document.work) throw new Error('WORK_IDENTITY_COLLISION');
    const sequence = index.admissionSequence + 1;
    const previous = predecessor!;
    document.work = {
      work_id, cycle: previous.cycle + 1, predecessor: previous.work_id, ticket: copy(previous.ticket), repository: copy(previous.repository), result: 'open',
      authorization: { ...copy(previous.authorization), state: 'authorized', tracking: 'New cycle requested explicitly; authorization is confirmed by the next complete Ticket read.',
        lastObservedAt: null, withdrawal: null },
      queue: { category: 'normal', sequence, pending: true },
      impediments: [{ code: 'DEPENDENCIES_NOT_EVALUATED', scope: 'work', since: at, nextStep: 'Native blocked_by evaluation must complete before any dispatch; the next polling round evaluates it.' },
        { code: cycleImpediments.notConfirmed, scope: 'work', since: at, nextStep: 'New cycle: the next complete read of the Ticket must show it open with the configured label.' }],
      dependencies: { latest: null, lastComplete: null }, execution: null, branch: null, pullRequest: null, previousExecutions: [], questions: [], inputs: { cursor: null }, admittedAt: at,
      budget: initialBudget(configured, previous.repository.repository, at), correction: null, pendingRecovery: null,
      history: [{ at, event: 'cycle-created', origin: 'local-cli', detail: `${input.request_id}:predecessor:${previous.work_id}:cycle:${previous.cycle + 1}${input.keepPredecessorPullRequest ? ':predecessor-pr-kept' : ''}` }],
    };
    index.admissionSequence = sequence;
    const entry = index.tickets[key!]!;
    index.tickets[key!] = { current: work_id, previous: [...entry.previous, entry.current] };
    index.order.push(work_id);
    rememberResult(index, document.work);
    history(previous, 'successor-created', 'local-cli', `${input.request_id}:${work_id}`, at);
    return receiptOf(input, previous.work_id, 'accepted', null, work_id);
  });
}

/** One complete authorization read of a CURRENT open Work (cycle desk or dispatch revalidation). Unknown reads are never recorded as change. */
export async function recordAuthorization(session: Session, work_id: string, observed: { kind: 'authorized' } | { kind: 'withdrawn'; codes: string[] }): Promise<'recorded' | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id) return 'stale' as const;
    const at = new Date().toISOString();
    const change = authorizationChange(work, observed, at);
    removeImpediments(work, change.remove);
    for (const item of change.add) addImpediment(work, item);
    for (const event of change.events) history(work, event.event, 'controller-cycles', event.detail, at);
    work.authorization = { ...work.authorization, state: change.state, lastObservedAt: at, withdrawal: change.withdrawal };
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** Commit right before the reopen request is sent: an intent WITHOUT it provably never reached GitHub. */
async function beginReopen(session: Session, work_id: string, effectId: string): Promise<'sending' | 'stale'> {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const reopen = work?.closure?.reopen;
    if (!work || work.result !== 'closed-unmerged' || reopen?.effectId !== effectId || reopen.state !== 'intended' || reopen.sendingAt) return 'stale' as const;
    reopen.sendingAt = new Date().toISOString();
    return 'sending' as const;
  }, BACKGROUND_CONTEXT);
}

/** Records the attempt and/or the independent observation of a reopen; `open` confirms it (result open, RESUME_REQUIRED), `closed` settles it not applied. */
async function recordReopen(session: Session, work_id: string, effectId: string, input: { attempt?: { outcome: string; code: string | null }; observed?: 'open' | 'closed-unmerged' | 'other' }) {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, work_id, null)).work;
    const reopen = work?.closure?.reopen;
    if (!work || reopen?.effectId !== effectId || (reopen.state !== 'intended' && reopen.state !== 'attempted')) return 'stale' as const;
    const at = new Date().toISOString();
    if (input.attempt) {
      reopen.attempt = { at, ...input.attempt };
      reopen.state = 'attempted';
      history(work, 'reopen-attempted', 'controller-cycles', `${effectId}:${input.attempt.outcome}${input.attempt.code ? `:${input.attempt.code}` : ''}`, at);
    }
    if (input.observed === 'open' && work.result === 'closed-unmerged') {
      Object.assign(reopen, { state: 'confirmed', observation: { at, outcome: 'open' }, settledAt: at });
      work.result = 'open';
      removeImpediments(work, [cycleImpediments.closedUnmerged]);
      addImpediment(work, { code: cycleImpediments.resumeRequired, scope: 'work', since: at, nextStep: 'The own pull request is open again. Reopening grants no resume, scope or budget: ' +
        '`factory resume <work>` (current requirements re-read), then the usual commands (repair, update-scope, grant) decide any new activity.' });
      work.closure!.nextStep = 'Reopened and confirmed by observation; the Work stays suspended until `factory resume`.';
      history(work, 'reopen-confirmed', 'controller-cycles', effectId, at);
      rememberResult(index, work);
    } else if (input.observed === 'closed-unmerged' && (reopen.state === 'attempted' || reopen.sendingAt)) {
      // Sent (or possibly sent) and still closed: never resent implicitly; another `factory reopen` is a new decision.
      Object.assign(reopen, { state: 'not-applied', observation: { at, outcome: 'closed-unmerged' }, settledAt: at });
      work.closure!.nextStep = 'The reopen was not applied (still closed). Nothing is repeated automatically: inspect GitHub and decide (`factory reopen` again, or `factory cancel`).';
      history(work, 'reopen-not-applied', 'controller-cycles', effectId, at);
    }
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Ticket 25 cycle desk, in the existing owner loop (no daemon/scheduler), BEFORE the dispatcher tick: (1) a bounded number of complete Ticket
 * re-reads of current open Works, least recently observed first, recording withdrawal/restoration/confirmations; (2) the reopen effects the
 * operator intended: observe first (a human reopen needs no write), send at most once, then observe again and confirm.
 */
export function createCycleDesk(deps: { session: Session; access: AccessDependencies; readWorks(): Promise<WorkRecord[]>; stopped(): boolean; readsPerCycle?: number }) {
  const readsPerCycle = deps.readsPerCycle ?? 8;
  const configured = (repository: string) => deps.access.repositories.find(scope => scope.repository.toLowerCase() === repository.toLowerCase());
  const failures: { at: string; work_id: string; step: string }[] = [];
  const failed = (work_id: string, step: string) => { failures.push({ at: new Date().toISOString(), work_id, step }); failures.splice(0, Math.max(0, failures.length - 50)); };

  /** One read; returns the decision that was recorded (null when nothing could be concluded). */
  async function observeAuthorization(work: WorkRecord) {
    const scope = configured(work.repository.repository);
    let facts;
    try { facts = await deps.access.tracker.readTicket(work.ticket); } catch { return null; }
    const observed = authorizationFacts({ configuredLabel: scope?.label, ticket: work.ticket, facts });
    if (observed.kind === 'unknown') return null;
    await recordAuthorization(deps.session, work.work_id, observed);
    return observed;
  }
  async function observeOwn(work: WorkRecord) {
    const own = ownPullRequestOf(work);
    const scope = configured(work.repository.repository);
    if (!own || !scope || !deps.access.repository.readOwnMerge) return null;
    const read = await deps.access.repository.readOwnMerge({ repo: scope, repositoryId: work.repository.repositoryId, number: own.number, pullRequestId: own.pullRequestId, nodeId: own.nodeId })
      .catch(() => null);
    if (!read || read.kind !== 'observed') return null;
    const decision = decideMerge(own, { repositoryId: work.repository.repositoryId, branch: work.branch, base: work.repository.base }, read.pullRequest);
    return decision.outcome === 'open' || decision.outcome === 'closed-unmerged' ? decision.outcome : 'other' as const;
  }
  async function reopen(work: WorkRecord) {
    const effect = work.closure?.reopen;
    if (!effect) return;
    const observed = await observeOwn(work);
    if (observed === null) return; // nothing concluded: kept for a later cycle
    if (observed !== 'closed-unmerged' || effect.state === 'attempted' || effect.sendingAt) { await recordReopen(deps.session, work.work_id, effect.effectId, { observed }); return; }
    const scope = configured(work.repository.repository)!;
    const own = ownPullRequestOf(work)!;
    if (!deps.access.repository.reopenPullRequest) { await recordReopen(deps.session, work.work_id, effect.effectId, { attempt: { outcome: 'not-sent', code: 'REOPEN_NOT_COMPOSED' } }); return; }
    if (await beginReopen(deps.session, work.work_id, effect.effectId) !== 'sending') return;
    const result = await deps.access.repository.reopenPullRequest({ repo: scope, number: own.number, nodeId: own.nodeId }, { effectId: effect.effectId })
      .catch(() => ({ kind: 'unknown' as const, code: 'REOPEN_UNAVAILABLE' }));
    await recordReopen(deps.session, work.work_id, effect.effectId, { attempt: { outcome: result.kind, code: 'code' in result ? result.code : null } });
    const after = await observeOwn(work);
    if (after !== null) await recordReopen(deps.session, work.work_id, effect.effectId, { observed: after });
  }

  return {
    view: () => ({ failures: [...failures] }),
    /** Never throws: the question desk and the dispatcher run after it in the same owner cycle. */
    async cycle() {
      if (deps.stopped()) return;
      let all: WorkRecord[];
      try { all = await deps.readWorks(); } catch { return; }
      const tracked = all.filter(work => work.result === 'open' && configured(work.repository.repository))
        .sort((a, b) => (a.authorization.lastObservedAt ?? '').localeCompare(b.authorization.lastObservedAt ?? ''));
      for (const work of tracked.slice(0, readsPerCycle)) {
        if (deps.stopped()) return;
        try { await observeAuthorization(work); } catch { failed(work.work_id, 'authorization'); }
      }
      for (const work of all.filter(item => item.result === 'closed-unmerged' && (item.closure?.reopen?.state === 'intended' || item.closure?.reopen?.state === 'attempted'))) {
        if (deps.stopped()) return;
        try { await reopen(work); } catch { failed(work.work_id, 'reopen'); }
      }
    },
  };
}
