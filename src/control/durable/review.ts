import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ProposalIdentity, ReviewerRole, ReviewOpinion } from '../../contracts/index.js';
import type { HandoffEvent } from '../../workers/index.js';
import type { ExecutionView, ReviewRoundView } from '../types.js';
import { concludeRound, lastReviewed, reviewerRoles, verifyExecution, type CaptureClass, type ReviewPlan } from '../rules/review.js';
import { notRetriedReasons, reviewProfile, type CarryPlan } from '../rules/review-recovery.js';
import { works, type WorkRecord } from './admission.js';
import { budgetHistory } from './execution.js';
import { questions } from './questions.js';
import type { Session } from './store.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const history = (work: WorkRecord, event: Extract<WorkRecord['history'][number], { origin: 'controller-dispatch'; executionId: string }>['event'], executionId: string, detail: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-dispatch', executionId, detail });

/** Every review commit: the Execution is still the Work's current one and STARTED (the Builder is suspended, its Slot still held). */
export async function withRound<T>(session: Session, work_id: string, executionId: string, round: number,
  mutate: (state: { work: WorkRecord; execution: ExecutionView; current: ReviewRoundView | undefined }) => T): Promise<T | 'stale'> {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.state !== 'started' || !execution.slot.held) return 'stale' as const;
    const current = execution.review?.rounds.find(item => item.round === round);
    return mutate({ work, execution, current });
  }, BACKGROUND_CONTEXT);
}

/**
 * Handoff commit (intent before effect): the round, the handoff summary, the Host identity observed BEFORE any reviewer, the versions
 * of request/instructions/profile, and BOTH reviewer intents (identities, inputs, prompt hashes) — or, without a usable handoff, both
 * reviewers explicitly failed. Exactly the next round; a repeated or skipped round is refused.
 */
export function recordHandoff(session: Session, work_id: string, executionId: string, input: { event: HandoffEvent; before: ProposalIdentity | null;
  plans: ReviewPlan[]; reviewer: ReviewRoundView['versions']['profile']['reviewer']; failure: string | null;
  /** Ticket 13: the round numbers of this Execution continue those of earlier Executions; the capture's classification (exemption = no reviewer). */
  firstRound?: number; classification?: CaptureClass;
  /** Ticket 28: opinions of the interrupted round carried into this first round of a recovery Execution (same proposal and context). */
  carried?: CarryPlan }) {
  return withRound(session, work_id, executionId, input.event.round, ({ work, execution, current }) => {
    const rounds = execution.review?.rounds ?? [];
    const firstRound = execution.review?.firstRound ?? input.firstRound ?? 1;
    if (current || input.event.round !== (rounds.at(-1)?.round ?? firstRound - 1) + 1) return 'refused' as const;
    const exemption = input.classification?.kind === 'exemption' && !input.failure ? input.classification.exemption : null;
    const reviewed = exemption ? lastReviewed(rounds) : undefined;
    if (exemption && reviewed?.round !== exemption.reviewedRound) return 'refused' as const;
    const at = new Date().toISOString();
    const summary = input.event.status === 'captured' ? input.event.summary : null;
    const reviewers = Object.fromEntries(reviewerRoles.map(role => {
      const plan = input.plans.find(item => item.role === role);
      const carried = !input.failure && !exemption ? input.carried?.[role] : undefined;
      if (carried) {
        // No reviewer activity in this round for the role: its current opinion is the carried one, with its provenance.
        return [role, { invocationId: carried.from.invocationId, phaseId: plan?.phaseId ?? `review-r${input.event.round}`, promptSha256: '', state: 'ended' as const,
          requestedAt: at, receiptId: null, endedAt: at, opinion: JSON.parse(JSON.stringify(carried.opinion)) as ReviewOpinion, failure: null, cessation: 'never-started' as const,
          input: { required: [...carried.opinion.input.required], missing: [...carried.opinion.input.missing] }, attempt: carried.from.attempt, source: 'carried' as const,
          carried: { ...carried.from } }];
      }
      const view = { invocationId: plan?.invocationId ?? `${role}-${executionId}-r${input.event.round}a1`, phaseId: plan?.phaseId ?? `review-r${input.event.round}`,
        promptSha256: plan ? sha256(plan.prompt) : '', state: input.failure ? 'failed' as const : exemption ? 'not-required' as const : 'requested' as const, requestedAt: at, receiptId: null,
        endedAt: input.failure || exemption ? at : null, opinion: null, failure: input.failure ? { code: input.failure } : null,
        cessation: input.failure || exemption ? 'never-started' as const : null, input: { required: plan ? [...plan.review.required] : [], missing: plan ? [...plan.review.missing] : [] } };
      return [role, view];
    })) as ReviewRoundView['reviewers'];
    const record: ReviewRoundView = { round: input.event.round, attempt: 1, state: exemption ? 'concluded' : 'reviewing',
      ...(input.classification ? { kind: exemption ? 'exemption' as const : 'review' as const, closing: input.event.closing === true, exemption,
        declarations: input.event.declarations ? JSON.parse(JSON.stringify(input.event.declarations)) as NonNullable<ReviewRoundView['declarations']> : null } : {}),
      handoff: { at, invocationId: execution.invocationId, status: input.event.status, code: input.event.status === 'failure' ? input.event.code : null,
        detail: input.event.status === 'failure' ? input.event.detail ?? null : null, summary },
      versions: { spec: summary?.spec ?? null, instructions: summary?.instructions ?? null, base: summary?.base ?? execution.request.baseCommit, head: summary?.head ?? null,
        profile: reviewProfile(execution.request, input.reviewer) },
      identity: { before: input.before, after: exemption ? input.before : null }, reviewers, applicability: exemption ? 'current' : null,
      conclusion: exemption ? reviewed!.conclusion : null, reasons: exemption ? [`EXEMPT_${exemption.kind.toUpperCase().replace('-', '_')}`] : [], concludedAt: exemption ? at : null, delivery: null };
    execution.review = { ...execution.review, ...(input.firstRound !== undefined || execution.review?.firstRound !== undefined ? { firstRound } : {}), rounds: [...rounds, record] };
    history(work, 'review-handoff', executionId, `r${record.round}:${input.event.status}${input.failure ? `:${input.failure}` : ''}${input.event.closing ? ':closing' : ''}`);
    for (const role of reviewerRoles) {
      const from = record.reviewers[role].carried;
      if (from) history(work, 'opinion-carried', executionId, `r${record.round}:${role}:from:${from.executionId}:r${from.round}a${from.attempt}${from.discovered ? ':records-discovery' : ''}`);
    }
    if (exemption) history(work, 'review-exempted', executionId, `r${record.round}:${exemption.kind}:r${exemption.reviewedRound}`);
    return 'recorded' as const;
  });
}

/** Ticket 28: settle the `recoveries` unit a retry attempt reserved (counter of the Work, never a parallel review budget). */
export function settleReviewerCharge(work: WorkRecord, executionId: string, reviewer: ReviewRoundView['reviewers'][ReviewerRole], state: 'consumed' | 'released') {
  if (reviewer.charge?.state !== 'reserved' || !work.budget) return;
  const counter = work.budget.recoveries;
  if (counter.reserved === reviewer.invocationId) counter.reserved = null;
  if (state === 'consumed') counter.consumed += 1;
  reviewer.charge = { ...reviewer.charge, state, settledAt: new Date().toISOString() };
  budgetHistory(work, state === 'consumed' ? 'budget-consumed' : 'budget-released', executionId, `recoveries:${reviewer.invocationId}`);
}

/** A reviewer's start receipt (its own invocation of THIS Execution) is consumed once. */
export function recordReviewerStart(session: Session, work_id: string, executionId: string, round: number, role: ReviewerRole, receipt: { id: string; invocationId: string; executionId: string }) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    const reviewer = current?.reviewers[role];
    if (!current || current.state !== 'reviewing' || !reviewer || reviewer.state !== 'requested' || receipt.invocationId !== reviewer.invocationId || receipt.executionId !== executionId) return 'conflict' as const;
    reviewer.state = 'started';
    reviewer.receiptId = receipt.id;
    // Ticket 28: a retry attempt consumes its reserved operational recovery unit exactly once, with its confirmed start.
    settleReviewerCharge(work, executionId, reviewer, 'consumed');
    history(work, 'reviewer-started', executionId, `r${round}:${role}${reviewer.attempt && reviewer.attempt > 1 ? `:a${reviewer.attempt}` : ''}`);
    return 'recorded' as const;
  });
}

/** The complete opinion (already durable in the reviewer's protected record) or an explicit failure; never both, never overwritten. */
export function recordReviewerEnd(session: Session, work_id: string, executionId: string, round: number, role: ReviewerRole,
  outcome: ({ opinion: ReviewOpinion } | { failure: string }) & { cessation: 'completion-observed' | 'never-started' | 'unconfirmed';
    /** Ticket 28: the opinion was located in the reviewer's complete protected record after its notification was lost. */
    source?: 'notification' | 'records-discovery' }) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    const reviewer = current?.reviewers[role];
    if (!current || current.state !== 'reviewing' || !reviewer || reviewer.state === 'ended' || reviewer.state === 'failed') return 'conflict' as const;
    if ('opinion' in outcome && (outcome.opinion.role !== role || outcome.opinion.round !== round || outcome.opinion.invocationId !== reviewer.invocationId ||
        outcome.opinion.attempt !== (reviewer.attempt ?? outcome.opinion.attempt) || outcome.opinion.input.handoffIndexSha256 !== current.handoff.summary?.indexSha256)) {
      reviewer.state = 'failed'; reviewer.failure = { code: 'OPINION_NOT_CORRELATED' };
    } else if ('opinion' in outcome) {
      reviewer.state = 'ended'; reviewer.opinion = JSON.parse(JSON.stringify(outcome.opinion)) as ReviewOpinion;
      if (outcome.source) reviewer.source = outcome.source;
    }
    else { reviewer.state = 'failed'; reviewer.failure = { code: outcome.failure }; }
    reviewer.endedAt = new Date().toISOString();
    reviewer.cessation = outcome.cessation;
    // A retry attempt proven never launched releases its reservation without consumption; an uncertain launch keeps it.
    if (outcome.cessation === 'never-started') settleReviewerCharge(work, executionId, reviewer, 'released');
    history(work, 'reviewer-ended', executionId, `r${round}:${role}:${reviewer.opinion?.conclusion ?? reviewer.failure?.code ?? 'unknown'}`);
    return 'recorded' as const;
  });
}

/** After BOTH reviewers' activity ended: identity after, applicability and the round conclusion, durable before any delivery. */
export function recordConclusion(session: Session, work_id: string, executionId: string, round: number, after: ProposalIdentity | null) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    if (!current || current.state !== 'reviewing' || reviewerRoles.some(role => ['requested', 'started'].includes(current.reviewers[role].state) ||
        current.reviewers[role].cessation === 'unconfirmed')) return 'conflict' as const;
    const result = concludeRound({ opinions: { standards: current.reviewers.standards.opinion, spec: current.reviewers.spec.opinion }, before: current.identity.before, after });
    if (current.handoff.status === 'failure') result.reasons.unshift(`HANDOFF_${current.handoff.code ?? 'FAILED'}`);
    result.reasons.push(...notRetriedReasons(current));
    current.identity.after = after;
    current.applicability = result.applicability;
    current.conclusion = current.handoff.status === 'failure' ? 'incomplete' : result.conclusion;
    current.reasons = result.reasons;
    current.concludedAt = new Date().toISOString();
    current.state = 'concluded';
    history(work, 'review-concluded', executionId, `r${round}:${current.conclusion}:${current.applicability}`);
    return JSON.parse(JSON.stringify(current)) as ReviewRoundView;
  });
}

/** Delivery intent before the call, then its outcome. Delivery does not prove SDK consumption. */
export function recordDelivery(session: Session, work_id: string, executionId: string, round: number, update: { promptSha256: string } | { outcome: 'delivered' | 'failed' | 'uncertain'; code: string | null }) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    if (!current) return 'conflict' as const;
    if ('promptSha256' in update) {
      if (current.state !== 'concluded' || current.delivery) return 'conflict' as const;
      current.delivery = { requestedAt: new Date().toISOString(), outcome: 'requested', code: null, promptSha256: update.promptSha256 };
      return 'recorded' as const;
    }
    if (!current.delivery || current.delivery.outcome !== 'requested') return 'conflict' as const;
    current.delivery = { ...current.delivery, outcome: update.outcome, code: update.code };
    if (update.outcome === 'delivered') current.state = 'delivered';
    history(work, 'review-delivered', executionId, `r${round}:${update.outcome}`);
    return 'recorded' as const;
  });
}

/**
 * Ticket 13 end-of-Execution verification commit, while the Execution is still STARTED (before its end is recorded): the pure rule over the
 * durable rounds, with the Questions referenced by authorizations read in the SAME commit. Presence/correlation only, never semantics.
 */
export async function recordVerification(session: Session, work_id: string, executionId: string, input: { sources: string[] }) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.state !== 'started' || !execution.review) return 'stale' as const;
    const referenced = new Set(execution.review.rounds.flatMap(round => [...(round.declarations?.treatments ?? []), ...(round.declarations?.gates ?? [])])
      .flatMap(item => item.authorization?.kind === 'question' ? [item.authorization.questionId] : []));
    const known = new Map<string, { workId: string; state: 'open' | 'answered' }>();
    for (const id of [...referenced].slice(0, 64)) {
      const question = (await tx.doc(questions, id, null)).question;
      if (question) known.set(id, { workId: question.workId, state: question.state });
    }
    // Preserved sources were verified by the Host BEFORE this commit (confined reads); here only the verified set is used.
    const sources = new Set(input.sources.slice(0, 32));
    const verification = verifyExecution({ at: new Date().toISOString(), workId: work_id, rounds: execution.review.rounds, question: id => known.get(id) ?? null,
      source: reference => sources.has(reference) });
    execution.review.verification = verification;
    history(work, 'review-verified', executionId, `${verification.status}${verification.reasons.length ? `:${verification.reasons.slice(0, 8).join(',')}` : ''}`.slice(0, 512));
    return JSON.parse(JSON.stringify(verification)) as typeof verification;
  }, BACKGROUND_CONTEXT);
}
