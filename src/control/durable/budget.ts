import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { BudgetCounter, ClosedCorrection, ControlReceipt, ConfiguredRepository, RepairReason } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { availableOf, counterView, exhaustionCodes, exhaustionImpediment, grantDecision, initialBudget, type BudgetCounterName } from '../rules/budget.js';
import { requests, ticketIndex, works, type TicketIndex, type WorkRecord } from './admission.js';
import { activeExecution } from './execution.js';
import { applyRecoveryRequest } from './recovery-request.js';
import type { Session } from './store.js';
import { settleFeedback } from './feedback.js';
import { undeliveredHuman } from '../rules/feedback.js';

type Limits = Pick<ConfiguredRepository, 'correctionLimit' | 'recoveryLimit'>;
type GrantInput = { request_id: string; operation: 'grant'; work_id: string; counter: BudgetCounterName; amount: number; origin: 'local-cli' };
/** The budget AS STORED in the document: assign first, then read it back (`??=` returns the detached value, whose later mutations are lost). */
export function ensureBudget(work: WorkRecord, limits: Limits | undefined, at: string) {
  if (!work.budget) work.budget = initialBudget(limits ?? {}, work.repository.repository, at);
  return work.budget;
}
const copy = (counter: BudgetCounter): BudgetCounter => ({ ...counter });

/**
 * Explicit grant (spec §4.4/§11.3), "Aceitar resposta/comando" boundary: deduplication by request identity, the decision, the added capacity
 * with before/after history and the removal of ONLY the exhaustion impediment it resolves share one commit. Counters are never reset and
 * nothing is launched: a pending correction/recovery proceeds through the normal queue and revalidation.
 */
export async function grantBudget(session: Session, input: GrantInput, limits: (repository: string) => Limits | undefined):
  Promise<Extract<ControlReceipt, { operation: 'grant' }> | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return JSON.parse(JSON.stringify(request.receipt)) as Extract<ControlReceipt, { operation: 'grant' }>;
    }
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const decision = grantDecision({ work: work ? { result: work.result, current: index.tickets[ticketKey(work.ticket)]?.current === work.work_id } : null, amount: input.amount });
    const base = { kind: 'durable' as const, request_id: input.request_id, operation: 'grant' as const, work_id: input.work_id, counter: input.counter, amount: input.amount };
    let receipt: Extract<ControlReceipt, { operation: 'grant' }>;
    if (decision.kind === 'refuse' || !work) receipt = { ...base, outcome: 'not-applied', reason: decision.kind === 'refuse' ? decision.code : 'WORK_NOT_FOUND', budget: null };
    else {
      const now = new Date().toISOString();
      const budget = ensureBudget(work, limits(work.repository.repository), now);
      const counter = budget[input.counter];
      const before = copy(counter);
      counter.granted += input.amount;
      budget.grants.push({ at: now, request_id: input.request_id, origin: 'local-cli', counter: input.counter, amount: input.amount, before, after: copy(counter) });
      if (availableOf(counter) > 0) work.impediments = work.impediments.filter(item => item.code !== exhaustionCodes[input.counter]);
      work.history.push({ at: now, event: 'budget-granted', origin: 'local-cli', executionId: null, detail: `${input.counter}:+${input.amount}:${input.request_id}` });
      receipt = { ...base, outcome: 'accepted', reason: null, budget: counterView(counter) };
    }
    request.input = input;
    request.receipt = receipt;
    return JSON.parse(JSON.stringify(receipt)) as typeof receipt;
  }, BACKGROUND_CONTEXT);
}

type Opened = 'opened' | 'requested' | 'already-open' | 'refused';
/** Shared commit of the charge triggers: open, current Work without an active Execution; pending again in its SAME queue position. */
async function charge(session: Session, work_id: string, limits: (repository: string) => Limits | undefined, counter: BudgetCounterName,
  mutate: (work: WorkRecord, at: string, index: TicketIndex) => Opened): Promise<Opened> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id || activeExecution(work.execution ?? null)) return 'refused' as const;
    const now = new Date().toISOString();
    ensureBudget(work, limits(work.repository.repository), now);
    const outcome = mutate(work, now, index);
    if (outcome === 'refused' || outcome === 'already-open') return outcome;
    markPending(work, counter, now);
    return outcome;
  }, BACKGROUND_CONTEXT);
}
/** Pending again; exhaustion is visible at once (no activation is attempted to discover it); only an explicit grant resolves it. */
function markPending(work: WorkRecord, counter: BudgetCounterName, now: string) {
  const budget = work.budget!;
  if (availableOf(budget[counter]) === 0 && !work.impediments.some(item => item.code === exhaustionCodes[counter])) {
    work.impediments.push(exhaustionImpediment(counter, work.work_id, now));
    work.history.push({ at: now, event: 'budget-exhausted', origin: 'controller-budget', executionId: null, detail: `${counter}:${budget[counter].consumed}/${budget[counter].limit + budget[counter].granted}` });
  }
  work.queue = { ...work.queue, pending: true };
}

/** Closes the Work's correction into its bounded history (inside a commit); the Work leaves the repair category, keeping its admission position. */
export function closeCorrection(work: WorkRecord, at: string, outcome: ClosedCorrection['outcome'], facts: { head: string | null; basisExecutionId: string | null }) {
  const correction = work.correction;
  if (!correction) return;
  work.corrections = [...(work.corrections ?? []), { correctionId: correction.correctionId, sequence: correction.sequence ?? null, openedAt: correction.openedAt, closedAt: at,
    charged: correction.consumed, outcome, reasons: correction.reasons ?? [], head: facts.head, basisExecutionId: facts.basisExecutionId }].slice(-10);
  // Ticket 23: only the human requests DELIVERED to a started Execution of a charged correction are treated; every other one (never
  // delivered: superseded/internal/unpublishable closure, or a correction that never started) waits again — never silently lost.
  const undelivered = new Set(undeliveredHuman(correction, [...work.previousExecutions, ...(work.execution ? [work.execution] : [])]).map(item => item.subject ?? ''));
  settleFeedback(work, correction.correctionId, correction.consumed, at, outcome, undelivered);
  work.correction = null;
  const { repairSequence: _sequence, ...queue } = work.queue;
  work.queue = { ...queue, category: 'normal' };
  work.history.push({ at, event: 'correction-closed', origin: 'controller-repair', correctionId: correction.correctionId, detail: `${outcome}${facts.head ? `:${facts.head}` : ''}` });
}

/**
 * Inside a commit (shared by the module seam and ticket 22's repair observation): opens a correction with a stable identity and a NEW repair
 * sequence; the Work enters the repair category (selected before normal Works, FIFO, no preemption). A correction not yet charged absorbs
 * the new reason (same identity/charge); an already charged one is closed (`superseded`) and a NEW correction opens.
 */
export function openCorrectionIn(work: WorkRecord, index: TicketIndex, at: string, reason: string,
  repair?: { reasons: RepairReason[]; headSha: string | null; basisExecutionId: string | null; trigger?: 'effective-impediment' | 'human-feedback' }): Opened {
  if (work.correction && !work.correction.consumed) {
    // Same identity and charge, but the reason that motivated it is never silently lost.
    if (work.correction.reason !== reason) work.history.push({ at, event: 'correction-reason-added', origin: 'controller-budget', executionId: null, detail: reason.slice(0, 200) });
    return 'already-open';
  }
  if (work.correction) closeCorrection(work, at, 'superseded', { head: null, basisExecutionId: null });
  const sequence = (index.repairSequence ?? 0) + 1;
  index.repairSequence = sequence;
  work.correction = { correctionId: randomUUID(), reason, openedAt: at, consumed: false, sequence,
    ...(repair ? { trigger: repair.trigger ?? 'effective-impediment' as const, reasons: repair.reasons, headSha: repair.headSha, basisExecutionId: repair.basisExecutionId } : { trigger: 'internal' as const }) };
  work.queue = { ...work.queue, category: 'repair', repairSequence: sequence };
  work.history.push({ at, event: 'correction-opened', origin: 'controller-budget', executionId: null, detail: work.correction.correctionId });
  return 'opened';
}
/** Opens (inside a commit) and marks pending with the visible exhaustion check; the caller already verified the Work is current and idle. */
export function openCorrectionPending(work: WorkRecord, index: TicketIndex, at: string, reason: string, limits: Limits | undefined,
  repair: Parameters<typeof openCorrectionIn>[4]): Opened {
  ensureBudget(work, limits, at);
  const outcome = openCorrectionIn(work, index, at, reason, repair);
  if (outcome === 'opened') markPending(work, 'corrections', at);
  return outcome;
}

/**
 * Module-internal trigger of the repair flows (tickets 22/23; not a public Control operation): opens a correction with a stable identity.
 * A correction not yet charged absorbs the new reason (same identity/charge); an already charged one is closed and a NEW correction opens.
 */
export const openCorrection = (session: Session, work_id: string, reason: string, limits: (repository: string) => Limits | undefined) =>
  charge(session, work_id, limits, 'corrections', (work, at, index) => openCorrectionIn(work, index, at, reason));

/**
 * Module-internal trigger of the recovery flow (ticket 26): the next Execution of the Work is an operational recovery (one unit), after the
 * persisted wait (5/15/45 s by recoveries already consumed). A repeated request keeps the pending one: no earlier deadline, no second unit.
 */
export const requestOperationalRecovery = (session: Session, work_id: string, reason: string, limits: (repository: string) => Limits | undefined) =>
  charge(session, work_id, limits, 'recoveries', (work, at) => applyRecoveryRequest(work, { executionId: null, code: 'REQUESTED', at, reason }));
