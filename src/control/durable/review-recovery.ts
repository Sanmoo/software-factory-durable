import { createHash } from 'node:crypto';
import type { ReviewerRole } from '../../contracts/index.js';
import type { ExecutionView, ReviewerAttemptView } from '../types.js';
import { availableOf } from '../rules/budget.js';
import type { ReviewPlan } from '../rules/review.js';
import { reviewerFailure, type RetryDecision } from '../rules/review-recovery.js';
import { budgetHistory } from './execution.js';
import { history, settleReviewerCharge, withRound } from './review.js';
import { works, type WorkRecord } from './admission.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';

// Ticket 28 (spec §4.4/§5.6/§6.4): partial review recovery commits. The Execution stays current/started with its Slot; the Builder stays
// suspended. Every retry is intent before effect: the earlier attempt is kept, the new attempt identity and its recoveries reservation are
// durable BEFORE any wait or launch; nothing is retried on a changed proposal, an unknown cessation or without budget.

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
type NotRetried = Extract<RetryDecision, { kind: 'not-retried' }>['code'];

/**
 * Retry intent of ONE failed reviewer in the SAME round: its failure (with known cessation) moves to `attempts`, the next attempt identity,
 * prompt hash and persisted wait are recorded, and ONE unit of the Work's existing `recoveries` counter is reserved for it — all in one
 * commit, re-checked against the durable budget. Without capacity the failure stays explicit (`notRetried`) and nothing is reserved.
 */
export function recordReviewerRetry(session: Session, work_id: string, executionId: string, round: number, role: ReviewerRole,
  input: { plan: ReviewPlan; attempt: number; waitSeconds: number }) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    const reviewer = current?.reviewers[role];
    const failure = reviewer ? reviewerFailure(reviewer) : null;
    if (!current || current.state !== 'reviewing' || !reviewer || !failure || (reviewer.attempt ?? 1) !== input.attempt - 1 ||
        !['completion-observed', 'never-started'].includes(reviewer.cessation ?? '') || input.plan.role !== role || input.plan.review.attempt !== input.attempt) return 'conflict' as const;
    const at = new Date();
    const counter = work.budget?.recoveries;
    const refused: NotRetried | null = !counter ? 'RECOVERY_BUDGET_UNAVAILABLE' : counter.reserved ? 'RECOVERY_RESERVATION_BUSY' : availableOf(counter) === 0 ? 'RECOVERY_LIMIT_REACHED' : null;
    if (refused || !counter) {
      reviewer.notRetried = { code: refused ?? 'RECOVERY_BUDGET_UNAVAILABLE', at: at.toISOString() };
      history(work, 'reviewer-not-retried', executionId, `r${round}:${role}:${reviewer.notRetried.code}`);
      if (refused === 'RECOVERY_LIMIT_REACHED') budgetHistory(work, 'budget-exhausted', executionId, `recoveries:${counter!.consumed}/${counter!.limit + counter!.granted}`);
      return { kind: 'not-retried' as const, code: reviewer.notRetried.code };
    }
    const previous: ReviewerAttemptView = { attempt: reviewer.attempt ?? 1, invocationId: reviewer.invocationId, promptSha256: reviewer.promptSha256, state: reviewer.state,
      receiptId: reviewer.receiptId, requestedAt: reviewer.requestedAt, endedAt: reviewer.endedAt, failure: reviewer.failure ? { ...reviewer.failure } : null, cessation: reviewer.cessation,
      opinion: reviewer.opinion ? { reference: { ...reviewer.opinion.reference }, conclusion: reviewer.opinion.conclusion, code: reviewer.opinion.code } : null,
      charge: reviewer.charge ? { ...reviewer.charge } : null };
    // Assigned as new values (never an assigned value mutated afterwards).
    reviewer.attempts = [...(reviewer.attempts ?? []), previous];
    Object.assign(reviewer, { invocationId: input.plan.invocationId, phaseId: input.plan.phaseId, promptSha256: sha256(input.plan.prompt), state: 'requested', requestedAt: at.toISOString(),
      receiptId: null, endedAt: null, opinion: null, failure: null, cessation: null, attempt: input.attempt,
      input: { required: [...input.plan.review.required], missing: [...input.plan.review.missing] },
      charge: { counter: 'recoveries', state: 'reserved', settledAt: null },
      retry: { requestedAt: at.toISOString(), waitSeconds: input.waitSeconds, notBefore: new Date(at.getTime() + input.waitSeconds * 1000).toISOString(), after: failure.code },
      notRetried: null });
    delete reviewer.source;
    counter.reserved = input.plan.invocationId;
    budgetHistory(work, 'budget-reserved', executionId, `recoveries:${input.plan.invocationId}`);
    history(work, 'reviewer-retried', executionId, `r${round}:${role}:a${input.attempt}:after:${failure.code}:wait:${input.waitSeconds}s`);
    return { kind: 'recorded' as const };
  });
}

/** A failure that is NOT re-obtained, with why (cessation unknown, not transient, proposal changed/unknown, attempts exhausted). */
export function recordNotRetried(session: Session, work_id: string, executionId: string, round: number, role: ReviewerRole, code: NotRetried) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    const reviewer = current?.reviewers[role];
    if (!current || current.state !== 'reviewing' || !reviewer || !reviewerFailure(reviewer) || reviewer.notRetried) return 'conflict' as const;
    reviewer.notRetried = { code, at: new Date().toISOString() };
    history(work, 'reviewer-not-retried', executionId, `r${round}:${role}:${code}`);
    const counter = work.budget?.recoveries;
    if (code === 'RECOVERY_LIMIT_REACHED' && counter) budgetHistory(work, 'budget-exhausted', executionId, `recoveries:${counter.consumed}/${counter.limit + counter.granted}`);
    return 'recorded' as const;
  });
}

/**
 * A retry whose intent is durable but that was NEVER launched (interrupted or stopped during its persisted wait, proposal changed right
 * before the launch, failure before Workers.activate): a proven non-start. The attempt ends `failed`/`never-started`, its recoveries
 * reservation is released without consumption and why it was not re-obtained stays explicit.
 */
export function releaseReviewerRetry(session: Session, work_id: string, executionId: string, round: number, role: ReviewerRole,
  input: { attempt: number; code: 'PROPOSAL_CHANGED' | 'PROPOSAL_IDENTITY_UNKNOWN' | 'RETRY_NOT_LAUNCHED' }) {
  // Not tied to a STARTED Execution: an interruption may already have ended it; the non-start of this attempt is proven either way.
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId) return 'stale' as const;
    const current = execution.review?.rounds.find(item => item.round === round);
    const reviewer = current?.reviewers[role];
    if (!current || !reviewer || reviewer.state !== 'requested' || (reviewer.attempt ?? 1) !== input.attempt || reviewer.charge?.state !== 'reserved') return 'conflict' as const;
    const at = new Date().toISOString();
    Object.assign(reviewer, { state: 'failed', failure: { code: 'RETRY_NOT_LAUNCHED' }, cessation: 'never-started', endedAt: at, notRetried: { code: input.code, at } });
    settleReviewerCharge(work, executionId, reviewer, 'released');
    history(work, 'reviewer-not-retried', executionId, `r${round}:${role}:a${input.attempt}:${input.code}`);
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** Reviewer retry attempts of an Execution whose recoveries reservation is still outstanding (start not confirmed, non-start not proven). */
export const pendingReviewerReservations = (execution: Pick<ExecutionView, 'review'>): { round: number; role: ReviewerRole; invocationId: string }[] =>
  (execution.review?.rounds ?? []).flatMap(round => (['standards', 'spec'] as const).flatMap(role =>
    round.reviewers[role].charge?.state === 'reserved' ? [{ round: round.round, role, invocationId: round.reviewers[role].invocationId }] : []));

/**
 * In-commit settlement of outstanding reviewer reservations for the reconciliation of an interrupted Execution (ticket 26 "Confirmar
 * efeito/cessação"): ONLY after the host confirmed the cessation of its activity. A complete start receipt of the retry invocation confirms
 * its start and consumes the unit once; a complete listing without one proves non-start and releases it; anything else keeps it (uncertain
 * start — never consumed or released by guess). Returns what it settled.
 */
export function settleReviewerReservations(work: WorkRecord, execution: ExecutionView, input: { cessation: 'confirmed' | 'unconfirmed';
  receipt(invocationId: string): { kind: 'receipt'; id: string } | { kind: 'absent' } | { kind: 'uncertain'; code: string } }): { invocationId: string; outcome: 'consumed' | 'released' | 'kept' }[] {
  const settled: { invocationId: string; outcome: 'consumed' | 'released' | 'kept' }[] = [];
  for (const pending of pendingReviewerReservations(execution)) {
    const reviewer = execution.review!.rounds.find(item => item.round === pending.round)!.reviewers[pending.role];
    const observed = input.cessation === 'confirmed' ? input.receipt(pending.invocationId) : { kind: 'uncertain' as const, code: 'CESSATION_UNCONFIRMED' };
    if (observed.kind === 'uncertain') { settled.push({ invocationId: pending.invocationId, outcome: 'kept' }); continue; }
    if (observed.kind === 'receipt') reviewer.receiptId ??= observed.id;
    settleReviewerCharge(work, execution.executionId, reviewer, observed.kind === 'receipt' ? 'consumed' : 'released');
    settled.push({ invocationId: pending.invocationId, outcome: observed.kind === 'receipt' ? 'consumed' : 'released' });
  }
  return settled;
}
