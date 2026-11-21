import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ControlInput, ControlReceipt, ForgetPlan, ForgetRemoval, RetentionEvent, ScrubResult } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import type { MergeDecision } from '../rules/delivery.js';
import { forgetBasis, forgetLosses, forgetPlanNextStep, forgetRefusals, minimalMemoryOf, type ForgetFacts } from '../rules/forget.js';
import { requests, ticketIndex, works, type WorkRecord } from './admission.js';
import { rememberResult } from './cycles.js';
import { questions as questionDocs } from './questions.js';
import type { Session } from './store.js';

// Ticket 31 durable commits (spec §12.4 `forget`). Plan and confirmation are deduplicated commands (as ticket 30's cleanup); the deletion is
// intended BEFORE the Records effect and its result is recorded after it. Only a removed/absent Records area completes the forget, and then ONE
// commit keeps the minimal cycle memory in the Ticket index, takes the Work out of the listing order, retires the Work and Question records and
// erases the text of this Work's content-bearing request receipts. A lost intent is `indeterminate`, never retried implicitly.

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
type ForgetInput = Extract<ControlInput, { operation: 'forget-plan' | 'forget-confirm' }>;
type ForgetReceipt = Extract<ControlReceipt, { operation: 'forget-plan' | 'forget-confirm' }>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const plansKept = 10;
const history = (
  work: WorkRecord,
  event: RetentionEvent,
  detail: string,
  at = new Date().toISOString(),
  origin: 'controller-retention' | 'local-cli' = 'controller-retention',
) => work.history.push({ at, event, origin, detail: detail.slice(0, 512) });
const plansOf = (work: WorkRecord) => (work.forget ??= { plans: [] }).plans;
const settle = (plan: ForgetPlan, state: ForgetPlan['state'], code: string | null = plan.code) => {
  plan.state = state;
  plan.code = code;
  plan.nextStep = forgetPlanNextStep(plan);
};

async function command(
  session: Session,
  input: ForgetInput,
  decide: (tx: Tx) => Promise<ForgetReceipt>,
): Promise<ForgetReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return copy(request.receipt) as ForgetReceipt;
    }
    const receipt = await decide(tx);
    request.input = input;
    request.receipt = receipt;
    return copy(receipt);
  }, BACKGROUND_CONTEXT);
}
const receiptOf = (input: ForgetInput, outcome: ForgetReceipt['outcome'], reason: string | null, plan: ForgetPlan | null): ForgetReceipt => ({
  kind: 'durable',
  request_id: input.request_id,
  operation: input.operation,
  work_id: input.work_id,
  outcome,
  reason,
  plan: plan ? copy(plan) : null,
});
/** Questions of the Work as the commit sees them (protections are re-read inside each decision commit). */
async function questionsIn(tx: Tx, work: WorkRecord) {
  const found = [];
  for (const id of work.questions ?? []) {
    const question = (await tx.doc(questionDocs, id, null)).question;
    if (question) found.push(question);
  }
  return found;
}

/**
 * `forget-plan`: the plan of losses computed from the CURRENT facts (Records tree inspected just before). An ineligible Work gets a `refused`
 * plan naming every reason; nothing is changed to make it eligible. An older unconfirmed plan is superseded only by an eligible one.
 */
export async function acceptForgetPlan(
  session: Session,
  input: ForgetInput & { operation: 'forget-plan' },
  facts: (work: WorkRecord) => Omit<ForgetFacts, 'questions'>,
) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    if (index.forgotten?.[input.work_id]) return receiptOf(input, 'already-satisfied', 'ALREADY_FORGOTTEN', null);
    const work = (await tx.doc(works, input.work_id, null)).work;
    if (!work) return receiptOf(input, 'not-applied', 'WORK_NOT_FOUND', null);
    const current: ForgetFacts = { ...facts(work), questions: await questionsIn(tx, work) };
    const refusals = forgetRefusals(work, current);
    const at = new Date().toISOString();
    const plans = plansOf(work);
    // A confirmed plan the desk has not started yet is superseded too (it never runs afterwards: beginForget needs `confirmed`).
    if (!refusals.length) for (const plan of plans) if (plan.state === 'planned' || plan.state === 'confirmed') settle(plan, 'superseded');
    const plan: ForgetPlan = {
      planId: randomUUID(),
      request_id: input.request_id,
      work_id: work.work_id,
      createdAt: at,
      state: refusals.length ? 'refused' : 'planned',
      basis: forgetBasis(work, current),
      refusals,
      ...forgetLosses(work, current),
      confirmedBy: null,
      confirmedAt: null,
      effect: null,
      code: null,
      nextStep: '',
    };
    plan.nextStep = forgetPlanNextStep(plan);
    work.forget = { plans: [...plans, plan].slice(-plansKept) };
    history(
      work,
      'forget-planned',
      `${input.request_id}:${plan.planId}:${plan.state}${refusals.length ? `:${refusals.map(item => item.code).join(',')}` : ''}`,
      at,
      'local-cli',
    );
    return receiptOf(input, refusals.length ? 'not-applied' : 'accepted', refusals[0]?.code ?? null, plan);
  });
}

/**
 * `forget-confirm`: revalidated NOW against the current facts; a plan whose basis changed (the losses it showed are no longer exact) or a Work no
 * longer eligible is dropped, never executed. A confirmed plan is executed by the retention desk after the ACK, revalidated again in the intent.
 */
export async function acceptForgetConfirm(
  session: Session,
  input: ForgetInput & { operation: 'forget-confirm' },
  facts: (work: WorkRecord) => Omit<ForgetFacts, 'questions'>,
) {
  return command(session, input, async tx => {
    const index = await tx.doc(ticketIndex);
    if (index.forgotten?.[input.work_id])
      return receiptOf(
        input,
        'already-satisfied',
        index.forgotten[input.work_id]!.planId === input.plan_id ? 'ALREADY_FORGOTTEN' : 'ALREADY_FORGOTTEN_BY_OTHER_PLAN',
        null,
      );
    const work = (await tx.doc(works, input.work_id, null)).work;
    if (!work) return receiptOf(input, 'not-applied', 'WORK_NOT_FOUND', null);
    const plan = plansOf(work).find(item => item.planId === input.plan_id);
    if (!plan) return receiptOf(input, 'not-applied', 'PLAN_NOT_FOUND', null);
    if (plan.state === 'superseded') return receiptOf(input, 'not-applied', 'PLAN_SUPERSEDED', plan);
    if (plan.state === 'refused') return receiptOf(input, 'not-applied', 'PLAN_REFUSED', plan);
    // Review MED: an ended plan answers its real outcome (never `already-satisfied`); only a confirmed/executing one is already satisfied.
    if (plan.state === 'dropped' || plan.state === 'failed' || plan.state === 'indeterminate')
      return receiptOf(input, 'not-applied', `PLAN_${plan.state.toUpperCase()}${plan.code ? `:${plan.code}` : ''}`, plan);
    if (plan.state !== 'planned') return receiptOf(input, 'already-satisfied', 'PLAN_ALREADY_CONFIRMED', plan);
    const current: ForgetFacts = { ...facts(work), questions: await questionsIn(tx, work) };
    const at = new Date().toISOString();
    const refusals = forgetRefusals(work, current);
    const code = refusals.length
      ? `BECAME_INELIGIBLE:${refusals.map(item => item.code).join(',')}`
      : forgetBasis(work, current) !== plan.basis
        ? 'PLAN_OBSOLETE'
        : null;
    plan.confirmedBy = input.request_id;
    plan.confirmedAt = at;
    if (code) {
      settle(plan, 'dropped', code);
      history(work, 'forget-dropped', `${input.request_id}:${plan.planId}:${code}`, at, 'local-cli');
      return receiptOf(input, 'not-applied', code, plan);
    }
    settle(plan, 'confirmed', null);
    history(work, 'forget-confirmed', `${input.request_id}:${plan.planId}`, at, 'local-cli');
    return receiptOf(input, 'accepted', null, plan);
  });
}

/** A `removing` plan whose result this process does not hold was cut by a crash: `indeterminate` (RESULT_NOT_RECORDED), never retried. */
export async function settleLostForget(session: Session, work_id: string, inFlight: ReadonlySet<string>) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work) return 0;
    let settled = 0;
    const at = new Date().toISOString();
    for (const plan of work.forget?.plans ?? [])
      if (plan.state === 'removing' && plan.effect?.outcome === 'intended' && !inFlight.has(plan.effect.effectId)) {
        Object.assign(plan.effect, { outcome: 'indeterminate', resultAt: at, code: 'RESULT_NOT_RECORDED' });
        settle(plan, 'indeterminate', 'RESULT_NOT_RECORDED');
        history(work, 'forget-result', `${plan.planId}:indeterminate:RESULT_NOT_RECORDED`, at);
        settled++;
      }
    return settled;
  }, BACKGROUND_CONTEXT);
}

/**
 * Durable intent BEFORE deleting the Records area: the confirmed plan is revalidated on the record, its Questions and the activity as they are in
 * this commit, and against a fresh Records inspection (the losses shown must still be exact). Otherwise the plan is dropped with its reason.
 */
export async function beginForget(
  session: Session,
  work_id: string,
  planId: string,
  facts: (work: WorkRecord) => Omit<ForgetFacts, 'questions'>,
): Promise<{ kind: 'removing'; effectId: string } | { kind: 'dropped'; code: string } | 'stale'> {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const plan = work?.forget?.plans.find(item => item.planId === planId);
    if (!work || !plan || plan.state !== 'confirmed') return 'stale' as const;
    const current: ForgetFacts = { ...facts(work), questions: await questionsIn(tx, work) };
    const at = new Date().toISOString();
    // The plan's own confirmed state is not a refusal of itself.
    const refusals = forgetRefusals({ ...work, forget: { plans: work.forget!.plans.filter(item => item.planId !== planId) } }, current);
    const code = refusals.length
      ? `BECAME_INELIGIBLE:${refusals.map(item => item.code).join(',')}`
      : forgetBasis(work, current) !== plan.basis
        ? 'PLAN_OBSOLETE'
        : null;
    if (code) {
      settle(plan, 'dropped', code);
      history(work, 'forget-dropped', `${planId}:${code}`, at);
      return { kind: 'dropped' as const, code };
    }
    const effectId = randomUUID();
    plan.effect = { effectId, intentAt: at, resultAt: null, outcome: 'intended', code: null };
    settle(plan, 'removing', null);
    history(work, 'forget-intended', `${planId}:${effectId}`, at);
    return { kind: 'removing' as const, effectId };
  }, BACKGROUND_CONTEXT);
}

/** Request receipts of this Work whose input carries operator text (answers, scope updates, readiness authorizations). */
export function contentRequestIds(
  work: WorkRecord,
  questionViews: { answer: { origin: { kind: string; request_id?: string; commentId?: number } } | null; ignored: { origin: string }[] }[],
): string[] {
  const ids = new Set<string>();
  const fromLabel = (label: string) => {
    const [kind, id] = [label.slice(0, label.indexOf(':')), label.slice(label.indexOf(':') + 1)];
    if (kind === 'local-cli' && id) ids.add(id);
    if (kind === 'github-comment' && /^\d+$/.test(id)) ids.add(`github-comment-${id}`);
  };
  for (const question of questionViews) {
    const origin = question.answer?.origin;
    if (origin?.kind === 'local-cli' && origin.request_id) ids.add(origin.request_id);
    if (origin?.kind === 'github-comment' && origin.commentId !== undefined) ids.add(`github-comment-${origin.commentId}`);
    for (const item of question.ignored) fromLabel(item.origin);
  }
  for (const update of work.scopeUpdates ?? []) if (update.origin.kind === 'local-cli') ids.add(update.origin.request_id);
  if (work.readiness?.authorization) ids.add(work.readiness.authorization.request_id);
  return [...ids].filter(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id));
}

/**
 * Result of the deletion. `removed`/`absent` completes the forget in THIS commit: the Ticket memory follows the cycle (result, merge), the minimal
 * memory is kept, the Work leaves the listing order, its Work/Question records are retired and the text of its content-bearing request inputs is
 * erased (`existingRequests`: ids read before, so no empty record is ever created). Anything else keeps the Work with the plan `failed`/`indeterminate`.
 */
export async function finishForget(
  session: Session,
  work_id: string,
  planId: string,
  effectId: string,
  result: ForgetRemoval,
  existingRequests: string[],
): Promise<'forgotten' | 'failed' | 'indeterminate' | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const plan = work?.forget?.plans.find(item => item.planId === planId);
    if (!work || !plan || plan.state !== 'removing' || plan.effect?.effectId !== effectId || plan.effect.outcome !== 'intended') return 'stale' as const;
    const at = new Date().toISOString();
    Object.assign(plan.effect, { outcome: result.outcome, resultAt: at, code: result.code });
    const done = result.outcome === 'removed' || result.outcome === 'absent';
    if (!done || (work.result !== 'delivered' && work.result !== 'cancelled')) {
      const state = result.outcome === 'indeterminate' ? ('indeterminate' as const) : ('failed' as const);
      settle(plan, state, done ? 'WORK_CHANGED_DURING_FORGET' : (result.code ?? result.outcome.toUpperCase()));
      history(work, 'forget-result', `${planId}:${result.outcome}${result.code ? `:${result.code}` : ''}:${result.files} file(s)`, at);
      return state;
    }
    rememberResult(index, work);
    const memory = minimalMemoryOf(work, { at, request_id: plan.confirmedBy ?? plan.request_id, planId });
    // D-07: committed WITH the forget, so a scrub cut by a crash (or failed) is still pending at the next owner run, never silently skipped.
    memory.scrub = { state: 'pending', attempts: 0, lastAttemptAt: null, code: null, scrubbedAt: null };
    index.forgotten = { ...(index.forgotten ?? {}), [work_id]: memory };
    index.order = index.order.filter(id => id !== work_id);
    // Sanity: the Ticket stays indexed (anti re-admission) — the index entry is never removed by forget.
    if (!index.tickets[ticketKey(work.ticket)]) throw new Error('FORGET_INDEX_INCONSISTENT');
    // A Question named by the Work but never recorded is created and retired in this commit (retiring needs a live incarnation).
    for (const id of work.questions ?? []) {
      await tx.doc(questionDocs, id, null);
      await tx.retireDoc(questionDocs, id);
    }
    // Review MED: every request linked to the Work at its own commit (accepted or not), plus the ones the Work/Questions reference (older records).
    for (const id of [...new Set([...existingRequests, ...(work.contentRequests ?? [])])]) {
      const request = await tx.doc(requests, id, null);
      if (!request.input) continue;
      const input = request.input as { request_id: string; operation: string; origin: string };
      request.input = { request_id: input.request_id, operation: input.operation, origin: input.origin, forgotten: work_id } as never;
    }
    await tx.retireDoc(works, work_id);
    return 'forgotten' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Review MED (spec §12.3): one read of a forgotten cancelled cycle's own PR, from its memory watch. A confirmed merge turns the memory into a
 * delivery (result, merge fact, PR identity) and updates the Ticket's cycle memory in the same commit; anything else only records the read.
 */
export async function recordForgottenMerge(session: Session, work_id: string, decision: MergeDecision | { outcome: 'unavailable'; reasons: string[] }) {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const memory = index.forgotten?.[work_id];
    if (!memory?.watch || memory.watch.state !== 'watching') return 'stale' as const;
    const at = new Date().toISOString();
    memory.watch.lastReadAt = at;
    if (decision.outcome !== 'unavailable') memory.watch.lastOutcome = decision.outcome;
    if (decision.outcome !== 'merged') return 'observed' as const;
    const pull = memory.watch.pullRequest;
    Object.assign(memory, {
      result: 'delivered',
      mergeConfirmed: true,
      mergeConfirmedAt: at,
      pullRequest: { number: pull.number, pullRequestId: pull.pullRequestId, nodeId: pull.nodeId, url: pull.url },
    });
    memory.watch.state = 'delivered';
    const key = Object.entries(index.tickets).find(([, entry]) => entry.current === work_id || entry.previous.includes(work_id))?.[0];
    if (key)
      index.memory = {
        ...(index.memory ?? {}),
        [key]: {
          cycles: (index.memory?.[key]?.cycles ?? []).map(item =>
            item.work_id === work_id ? { ...item, result: 'delivered' as const, mergeConfirmed: true } : item,
          ),
        },
      };
    return 'delivered' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * D-07: the result of one storage scrub attempt for the forgotten Works that were pending when it started. `scrubbed` only after VACUUM and a
 * complete WAL truncation; a failure keeps them `pending` with its code (re-attempted by the retention desk).
 */
export async function recordScrub(session: Session, work_ids: string[], result: ScrubResult, at: string) {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    let recorded = 0;
    for (const id of work_ids) {
      const memory = index.forgotten?.[id];
      if (!memory || memory.scrub?.state === 'scrubbed') continue;
      const attempts = (memory.scrub?.attempts ?? 0) + 1;
      memory.scrub =
        result.outcome === 'scrubbed'
          ? { state: 'scrubbed', attempts, lastAttemptAt: at, code: null, scrubbedAt: at }
          : { state: 'pending', attempts, lastAttemptAt: at, code: result.code, scrubbedAt: null };
      recorded++;
    }
    return recorded;
  }, BACKGROUND_CONTEXT);
}
