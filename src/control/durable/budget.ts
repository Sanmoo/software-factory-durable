import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { BudgetCounter, ControlReceipt, ConfiguredRepository } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { availableOf, counterView, exhaustionCodes, exhaustionImpediment, grantDecision, initialBudget, type BudgetCounterName } from '../rules/budget.js';
import { requests, ticketIndex, works, type WorkRecord } from './admission.js';
import { activeExecution } from './execution.js';
import type { Session } from './store.js';

type Limits = Pick<ConfiguredRepository, 'correctionLimit' | 'recoveryLimit'>;
type GrantInput = { request_id: string; operation: 'grant'; work_id: string; counter: BudgetCounterName; amount: number; origin: 'local-cli' };
const ensureBudget = (work: WorkRecord, limits: Limits | undefined, at: string) => work.budget ??= initialBudget(limits ?? {}, work.repository.repository, at);
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
  mutate: (work: WorkRecord, at: string) => Opened): Promise<Opened> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id || activeExecution(work.execution ?? null)) return 'refused' as const;
    const now = new Date().toISOString();
    const budget = ensureBudget(work, limits(work.repository.repository), now);
    const outcome = mutate(work, now);
    if (outcome === 'refused' || outcome === 'already-open') return outcome;
    // Exhaustion is visible at once (no activation is attempted to discover it); only an explicit grant resolves it.
    if (availableOf(budget[counter]) === 0 && !work.impediments.some(item => item.code === exhaustionCodes[counter])) {
      work.impediments.push(exhaustionImpediment(counter, work_id, now));
      work.history.push({ at: now, event: 'budget-exhausted', origin: 'controller-budget', executionId: null, detail: `${counter}:${budget[counter].consumed}/${budget[counter].limit + budget[counter].granted}` });
    }
    work.queue = { ...work.queue, pending: true };
    return outcome;
  }, BACKGROUND_CONTEXT);
}

/**
 * Module-internal trigger of the repair flows (tickets 22/23; not a public Control operation): opens a correction with a stable identity.
 * A correction not yet charged absorbs the new reason (same identity/charge); an already charged one is closed and a NEW correction opens.
 */
export const openCorrection = (session: Session, work_id: string, reason: string, limits: (repository: string) => Limits | undefined) =>
  charge(session, work_id, limits, 'corrections', (work, at) => {
    if (work.correction && !work.correction.consumed) {
      // Same identity and charge, but the reason that motivated it is never silently lost.
      if (work.correction.reason !== reason) work.history.push({ at, event: 'correction-reason-added', origin: 'controller-budget', executionId: null, detail: reason.slice(0, 200) });
      return 'already-open';
    }
    work.correction = { correctionId: randomUUID(), reason, openedAt: at, consumed: false };
    work.history.push({ at, event: 'correction-opened', origin: 'controller-budget', executionId: null, detail: work.correction.correctionId });
    return 'opened';
  });

/** Module-internal trigger of the recovery flow (ticket 26): the next Execution of the Work is an operational recovery (one unit). */
export const requestOperationalRecovery = (session: Session, work_id: string, reason: string, limits: (repository: string) => Limits | undefined) =>
  charge(session, work_id, limits, 'recoveries', (work, at) => {
    if (work.pendingRecovery) return 'already-open';
    work.pendingRecovery = { reason, requestedAt: at };
    work.history.push({ at, event: 'recovery-requested', origin: 'controller-budget', executionId: null, detail: reason.slice(0, 200) });
    return 'requested';
  });
