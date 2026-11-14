import { createHash } from 'node:crypto';
import type { ReviewerRole } from '../../contracts/index.js';
import type { ReviewerAttemptView } from '../types.js';
import { availableOf } from '../rules/budget.js';
import type { ReviewPlan } from '../rules/review.js';
import { reviewerFailure, type RetryDecision } from '../rules/review-recovery.js';
import { budgetHistory } from './execution.js';
import { history, withRound } from './review.js';
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
