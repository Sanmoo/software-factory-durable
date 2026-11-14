import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ProposalIdentity, ReviewerRole, ReviewOpinion } from '../../contracts/index.js';
import type { HandoffEvent } from '../../workers/index.js';
import type { ExecutionView, ReviewRoundView } from '../types.js';
import { concludeRound, reviewerRoles, type ReviewPlan } from '../rules/review.js';
import { works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const history = (work: WorkRecord, event: 'review-handoff' | 'reviewer-started' | 'reviewer-ended' | 'review-concluded' | 'review-delivered', executionId: string, detail: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-dispatch', executionId, detail });

/** Every review commit: the Execution is still the Work's current one and STARTED (the Builder is suspended, its Slot still held). */
async function withRound<T>(session: Session, work_id: string, executionId: string, round: number,
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
  plans: ReviewPlan[]; reviewer: ReviewRoundView['versions']['profile']['reviewer']; failure: string | null }) {
  return withRound(session, work_id, executionId, input.event.round, ({ work, execution, current }) => {
    const rounds = execution.review?.rounds ?? [];
    if (current || input.event.round !== rounds.length + 1) return 'refused' as const;
    const at = new Date().toISOString();
    const summary = input.event.status === 'captured' ? input.event.summary : null;
    const reviewers = Object.fromEntries(reviewerRoles.map(role => {
      const plan = input.plans.find(item => item.role === role);
      const view = { invocationId: plan?.invocationId ?? `${role}-${executionId}-r${input.event.round}a1`, phaseId: plan?.phaseId ?? `review-r${input.event.round}`,
        promptSha256: plan ? sha256(plan.prompt) : '', state: input.failure ? 'failed' as const : 'requested' as const, requestedAt: at, receiptId: null, endedAt: input.failure ? at : null,
        opinion: null, failure: input.failure ? { code: input.failure } : null, cessation: input.failure ? 'never-started' as const : null, input: { required: plan ? [...plan.review.required] : [], missing: plan ? [...plan.review.missing] : [] } };
      return [role, view];
    })) as ReviewRoundView['reviewers'];
    const record: ReviewRoundView = { round: input.event.round, attempt: 1, state: 'reviewing',
      handoff: { at, invocationId: execution.invocationId, status: input.event.status, code: input.event.status === 'failure' ? input.event.code : null,
        detail: input.event.status === 'failure' ? input.event.detail ?? null : null, summary },
      versions: { spec: summary?.spec ?? null, instructions: summary?.instructions ?? null, base: summary?.base ?? execution.request.baseCommit, head: summary?.head ?? null,
        profile: { skillPack: execution.request.skillPack, builder: execution.request.policies, reviewer: { ...input.reviewer } } },
      identity: { before: input.before, after: null }, reviewers, applicability: null, conclusion: null, reasons: [], concludedAt: null, delivery: null };
    execution.review = { rounds: [...rounds, record] };
    history(work, 'review-handoff', executionId, `r${record.round}:${input.event.status}${input.failure ? `:${input.failure}` : ''}`);
    return 'recorded' as const;
  });
}

/** A reviewer's start receipt (its own invocation of THIS Execution) is consumed once. */
export function recordReviewerStart(session: Session, work_id: string, executionId: string, round: number, role: ReviewerRole, receipt: { id: string; invocationId: string; executionId: string }) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    const reviewer = current?.reviewers[role];
    if (!current || current.state !== 'reviewing' || !reviewer || reviewer.state !== 'requested' || receipt.invocationId !== reviewer.invocationId || receipt.executionId !== executionId) return 'conflict' as const;
    reviewer.state = 'started';
    reviewer.receiptId = receipt.id;
    history(work, 'reviewer-started', executionId, `r${round}:${role}`);
    return 'recorded' as const;
  });
}

/** The complete opinion (already durable in the reviewer's protected record) or an explicit failure; never both, never overwritten. */
export function recordReviewerEnd(session: Session, work_id: string, executionId: string, round: number, role: ReviewerRole,
  outcome: ({ opinion: ReviewOpinion } | { failure: string }) & { cessation: 'completion-observed' | 'never-started' | 'unconfirmed' }) {
  return withRound(session, work_id, executionId, round, ({ work, current }) => {
    const reviewer = current?.reviewers[role];
    if (!current || current.state !== 'reviewing' || !reviewer || reviewer.state === 'ended' || reviewer.state === 'failed') return 'conflict' as const;
    if ('opinion' in outcome && (outcome.opinion.role !== role || outcome.opinion.round !== round || outcome.opinion.invocationId !== reviewer.invocationId ||
        outcome.opinion.input.handoffIndexSha256 !== current.handoff.summary?.indexSha256)) {
      reviewer.state = 'failed'; reviewer.failure = { code: 'OPINION_NOT_CORRELATED' };
    } else if ('opinion' in outcome) { reviewer.state = 'ended'; reviewer.opinion = JSON.parse(JSON.stringify(outcome.opinion)) as ReviewOpinion; }
    else { reviewer.state = 'failed'; reviewer.failure = { code: outcome.failure }; }
    reviewer.endedAt = new Date().toISOString();
    reviewer.cessation = outcome.cessation;
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
