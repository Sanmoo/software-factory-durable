// Pure partial review recovery rules (ticket 28, spec §4.4/§5.6/§6.4). No I/O, clock or randomness: callers supply every fact.
import { reviewerRetriesPerRound, type ProposalHandoff, type ProposalIdentity, type ReviewerRole, type ReviewOpinion } from '../../contracts/index.js';
import type { CarriedOpinionView, ExecutionView, ReviewerView, ReviewRoundView } from '../types.js';
import { recoveryWait } from './recovery.js';
import { reviewerRoles, sameProposal } from './review.js';

/**
 * The persisted wait before retry attempt `attempt` (2 or 3) of ONE reviewer in ONE round: spec §4.4's 5/15/45 s schedule (ticket 26's
 * `recoveryWait`) indexed by the retries this role already had IN THIS ROUND (attempt 2 waits 5 s, attempt 3 waits 15 s). Ticket 57: never by
 * the Work's recoveries, which reviewer retries no longer touch.
 */
export const reviewerRetryWait = (attempt: number): number => recoveryWait({ attempt: attempt - 2 });

/** An opinion is a real reviewer result when it concluded (clean, findings or incomplete); failure/cancellation is a failure, never zero findings. */
export const concluded = (opinion: ReviewOpinion | null | undefined): opinion is ReviewOpinion =>
  Boolean(opinion && ['clean', 'findings', 'incomplete'].includes(opinion.conclusion));

/** The failure of a reviewer's current attempt (ended without a concluded opinion), or null while running / with a real result. */
export function reviewerFailure(reviewer: Pick<ReviewerView, 'state' | 'opinion' | 'failure'>): { code: string } | null {
  if (reviewer.state !== 'ended' && reviewer.state !== 'failed') return null;
  if (reviewer.state === 'ended' && concluded(reviewer.opinion)) return null;
  return { code: reviewer.opinion?.code ?? reviewer.failure?.code ?? 'OPINION_MISSING' };
}

// Transient model/transport/worker failures of a reviewer whose activity is known to have ended (spec §4.4 "Recuperação transitória de
// modelo/transporte/worker"). Configuration, authorization, correlation/integrity and session-safety failures are never retried.
const transient = new Set(['WORKER_MODEL_UNAVAILABLE', 'WORKER_PROVIDER_UNAVAILABLE', 'WORKER_INTERRUPTED', 'WORKER_CHANNEL_CLOSED', 'WORKER_EXECUTION_UNCERTAIN',
  'WORKER_START_UNCERTAIN', 'TOOL_CHANNEL_CLOSED', 'REVIEWER_INTERRUPTED', 'OPINION_MISSING', 'REVIEW_VERDICT_INVALID', 'REVIEW_VERDICT_ROLE_MISMATCH',
  'REVIEW_VERDICT_BASIS_INVALID', 'REVIEW_VERDICT_TOO_LARGE',
  // Ticket 57: the reviewer's own request/tool budget closed its session (Host count). The model is not deterministic (pilot 2: the retried
  // Spec concluded within the same budget), so it is retried like an interruption, within the per-round limit below.
  'REVIEWER_BUDGET_EXHAUSTED']);
/**
 * Operator decision 2026-11-15: at most TWO retries per role per round (attempt 3 is the last); the next failure stops the Execution
 * (`REVIEWER_RETRY_LIMIT`, ticket 51) for the operator's decision. Ticket 57: this is the reviewers' OWN limit. A reviewer retry no longer
 * reserves or consumes the Work's `recoveries` (pilot 2: three Spec retries spent all three, and the Builder's later interruption found none
 * left). Recorded in the release (`productionProfile.limits.reviewerRetriesPerRound`).
 */
export const maxReviewerRetries = reviewerRetriesPerRound;

export type RetryDecision = { kind: 'retry'; attempt: number; waitSeconds: number } |
  { kind: 'not-retried'; code: 'REVIEWER_CESSATION_UNCONFIRMED' | 'REVIEWER_FAILURE_NOT_TRANSIENT' | 'PROPOSAL_CHANGED' | 'PROPOSAL_IDENTITY_UNKNOWN' |
    'REVIEWER_RETRY_LIMIT' } | { kind: 'none' };

/** The proposal identity re-observed is NOT the one the round started on (or cannot be shown to be): never reviewed on the old input. */
export function identityChange(before: ProposalIdentity | null, now: ProposalIdentity | null): 'PROPOSAL_CHANGED' | 'PROPOSAL_IDENTITY_UNKNOWN' | null {
  if (before?.status !== 'observed' || now?.status !== 'observed' || !before.consistent || !now.consistent) return 'PROPOSAL_IDENTITY_UNKNOWN';
  if (before.sha256 !== now.sha256 || before.indexSha256 !== now.indexSha256) return 'PROPOSAL_CHANGED';
  return null;
}

/**
 * Whether ONE failed reviewer is re-obtained alone in the same round (spec §5.6/§6.4): only with its cessation known (completion observed
 * or never launched), a transient failure, a retry left in this round's own limit (`maxReviewerRetries`) and the proposal identity
 * re-observed EQUAL to the identity the round started on (same content and index, consistent). A changed or unknown proposal is never
 * retried: the round concludes on what it has and the next capture gets new opinions of BOTH reviewers. Ticket 57: the Work's
 * `recoveries` are not consulted (they stay for Builder interruptions).
 */
export function retryDecision(input: { reviewer: Pick<ReviewerView, 'state' | 'opinion' | 'failure' | 'cessation' | 'attempt'>; before: ProposalIdentity | null;
  now: ProposalIdentity | null }): RetryDecision {
  const failure = reviewerFailure(input.reviewer);
  if (!failure) return { kind: 'none' };
  if (input.reviewer.cessation !== 'completion-observed' && input.reviewer.cessation !== 'never-started') return { kind: 'not-retried', code: 'REVIEWER_CESSATION_UNCONFIRMED' };
  if (!transient.has(failure.code)) return { kind: 'not-retried', code: 'REVIEWER_FAILURE_NOT_TRANSIENT' };
  const attempt = (input.reviewer.attempt ?? 1) + 1;
  if (attempt > 1 + maxReviewerRetries) return { kind: 'not-retried', code: 'REVIEWER_RETRY_LIMIT' };
  const changed = identityChange(input.before, input.now);
  if (changed) return { kind: 'not-retried', code: changed };
  return { kind: 'retry', attempt, waitSeconds: reviewerRetryWait(attempt) };
}

/**
 * A discovered opinion record is incorporated ONLY when it is the complete opinion of exactly this request: role, round, attempt, invocation
 * and handoff index. Its conclusion is kept as is — a recorded failure/cancellation stays a failure (never zero findings).
 */
export function incorporable(opinion: ReviewOpinion, expected: { role: ReviewerRole; round: number; attempt: number; invocationId: string; handoffIndexSha256: string }): boolean {
  return opinion.role === expected.role && opinion.round === expected.round && opinion.attempt === expected.attempt && opinion.invocationId === expected.invocationId &&
    opinion.input.handoffIndexSha256 === expected.handoffIndexSha256;
}

/** Operator decision 2026-11-15: opinions are carried ONLY into an operational recovery; after an administrative stop both review again. */
export function carryBasis(interruption: ExecutionView['interruption'] | undefined): string | null {
  return interruption?.reason === 'OPERATIONAL_RECOVERY' ? interruption.previousExecutionId : null;
}

/** The interrupted round a recovery Execution may carry opinions from: the LAST review round of the interrupted Execution, if its cessation is confirmed. */
export function carrySource(previous: Pick<ExecutionView, 'executionId' | 'end' | 'review' | 'request'> | null | undefined): { executionId: string; round: ReviewRoundView } | null {
  if (!previous || previous.end?.cessation !== 'confirmed') return null;
  const round = [...(previous.review?.rounds ?? [])].reverse().find(item => (item.kind ?? 'review') === 'review');
  if (!round || round.handoff.status !== 'captured' || !round.handoff.summary) return null;
  return { executionId: previous.executionId, round };
}

const carriable = (opinion: ReviewOpinion | null | undefined): opinion is ReviewOpinion => Boolean(opinion && ['clean', 'findings'].includes(opinion.conclusion));

type PackRef = { name: string; manifestSha256: string } | string | null | undefined;
/** Canonical pack identity: the seed name without its `factory/skill-pack/` prefix and the manifest hash when known (never key order). */
export function packIdentity(pack: PackRef): { name: string; manifestSha256: string | null } | null {
  if (!pack) return null;
  const name = (typeof pack === 'string' ? pack : pack.name).replace(/^factory\/skill-pack\//, '');
  return { name, manifestSha256: typeof pack === 'string' ? null : pack.manifestSha256 };
}
/**
 * The reviewer profile of the interrupted round and of this capture are the same: same pack (name AND manifest — a side without a manifest
 * never matches, it cannot be demonstrated) and the same reviewer policy fields. Never a serialized-object comparison.
 */
export function sameReviewProfile(a: { skillPack: PackRef; reviewer: { modelBudget?: string | undefined; imageSourceMaxBytes?: number | undefined } },
  b: { skillPack: PackRef; reviewer: { modelBudget?: string | undefined; imageSourceMaxBytes?: number | undefined } }): boolean {
  const left = packIdentity(a.skillPack), right = packIdentity(b.skillPack);
  const packs = left === null && right === null ? true : Boolean(left && right && left.name === right.name && left.manifestSha256 !== null && left.manifestSha256 === right.manifestSha256);
  return packs && (a.reviewer.modelBudget ?? null) === (b.reviewer.modelBudget ?? null) && (a.reviewer.imageSourceMaxBytes ?? null) === (b.reviewer.imageSourceMaxBytes ?? null);
}
/** The profile a round records (`versions.profile`) and a carry compares against: ONE construction for both sides. */
export function reviewProfile(request: Pick<ExecutionView['request'], 'skillPack' | 'policies'>, reviewer: ReviewRoundView['versions']['profile']['reviewer']): ReviewRoundView['versions']['profile'] {
  return { skillPack: request.skillPack ? { name: request.skillPack.name, manifestSha256: request.skillPack.manifestSha256 } : null, builder: request.policies, reviewer: { ...reviewer } };
}

export type CarryPlan = Partial<Record<ReviewerRole, { opinion: ReviewOpinion; from: CarriedOpinionView }>>;
/**
 * Pure (spec §5.6/§6.4/V-08): which opinions of the interrupted round are still current for this capture. Only when the capture is the SAME
 * proposal in the SAME context (`sameProposal`), with the same skill pack and reviewer profile; then each role's concluded opinion that is
 * correlated to its own request of that round — recorded, or `discovered` in Records for an outcome whose notification was lost — is carried;
 * every other role is reviewed again. A changed proposal carries nothing: both reviewers give new current opinions.
 */
export function carryPlan(input: { source: { executionId: string; round: ReviewRoundView } | null; summary: ProposalHandoff; identity: ProposalIdentity | null;
  profile: ReviewRoundView['versions']['profile']; discovered?: Partial<Record<ReviewerRole, ReviewOpinion | null>> }): CarryPlan {
  const source = input.source;
  const before = source?.round.handoff.summary;
  if (!source || !before?.content || !sameProposal({ now: input.summary, identity: input.identity, before })) return {};
  if (!sameReviewProfile(source.round.versions.profile, input.profile)) return {};
  const plan: CarryPlan = {};
  for (const role of reviewerRoles) {
    const reviewer = source.round.reviewers[role];
    const attempt = reviewer.attempt ?? 1;
    const expected = { role, round: source.round.round, attempt, invocationId: reviewer.invocationId, handoffIndexSha256: before.indexSha256 };
    // Only a COMPLETE result is carried (clean/findings); an incomplete opinion (limitation, unread input) is reviewed again.
    const recorded = reviewer.state === 'ended' && carriable(reviewer.opinion) && incorporable(reviewer.opinion, expected) ? reviewer.opinion : null;
    const found = !recorded && outcomeUnrecorded(reviewer) ? input.discovered?.[role] ?? null : null;
    const opinion = recorded ?? (found && carriable(found) && incorporable(found, expected) ? found : null);
    if (!opinion) continue;
    plan[role] = { opinion, from: { executionId: source.executionId, round: source.round.round, attempt, invocationId: reviewer.invocationId,
      indexSha256: before.indexSha256, contentSha256: before.content.sha256, discovered: !recorded } };
  }
  return plan;
}

/** Reviewers of the interrupted round whose outcome was never recorded: their complete opinion may sit in Records (lost notification). */
export const undiscovered = (round: ReviewRoundView | null | undefined): ReviewerRole[] => !round ? [] :
  reviewerRoles.filter(role => !concluded(round.reviewers[role].opinion) && outcomeUnrecorded(round.reviewers[role]));
/** No outcome reached Control: still requested/started, unconfirmed, or recorded by ticket 26's reconciliation as interrupted with the boot. */
function outcomeUnrecorded(reviewer: Pick<ReviewerView, 'state' | 'cessation' | 'failure' | 'opinion'>): boolean {
  if (reviewer.opinion) return false;
  return reviewer.state === 'requested' || reviewer.state === 'started' || reviewer.cessation === 'unconfirmed' ||
    (reviewer.state === 'failed' && reviewer.cessation === 'boot-ceased' && reviewer.failure?.code === 'EXECUTION_INTERRUPTED');
}

/** Round reasons for failures that were not re-obtained (explicit, never zero findings). */
export const notRetriedReasons = (round: Pick<ReviewRoundView, 'reviewers'>): string[] =>
  reviewerRoles.flatMap(role => round.reviewers[role].notRetried ? [`${role.toUpperCase()}_NOT_RETRIED:${round.reviewers[role].notRetried!.code}`] : []);

const fenced = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
};
/**
 * Spec §5.6 ("Entrega ao SDK antes de checkpoint perdido não comprova consumo; reconstruir continuação com evidências/efeitos observados"):
 * the preserved review state of an interrupted Execution for its substitute session — the last round's conclusion and each reviewer's
 * effective opinion or explicit failure/unknown outcome, and whether its delivery was confirmed. Context only: the substitute treats the
 * findings of the results it receives at its next handoff, never these, so no treatment or charge is duplicated. Bounded.
 */
export function preservedReviewContext(rounds: readonly ReviewRoundView[], maxBytes = 12000, options: { carry: boolean } = { carry: true }): string | null {
  const round = [...rounds].reverse().find(item => (item.kind ?? 'review') === 'review');
  if (!round) return null;
  const reviewers = reviewerRoles.map(role => {
    const reviewer = round.reviewers[role];
    const failure = reviewerFailure(reviewer);
    return concluded(reviewer.opinion) && !failure
      ? { role, conclusion: reviewer.opinion.conclusion, findings: reviewer.opinion.findings.map(item => ({ id: item.id, basis: item.basis, location: item.location, summary: item.summary.slice(0, 300) })) }
      : { role, conclusion: failure ? 'failure' : 'unknown', code: failure?.code ?? 'OUTCOME_NOT_RECORDED', findings: [] };
  });
  const delivery = round.delivery?.outcome ?? 'not-requested';
  const head = `PRESERVED REVIEW STATE of the previous Execution — round ${round.round} (${round.state}; conclusion ${round.conclusion ?? 'not concluded'}; ` +
    `delivery to the previous Builder session: ${delivery}${delivery === 'delivered' ? ', not proof that it was consumed' : ''}). Content ` +
    `${round.handoff.summary?.content?.sha256 ?? 'unknown'} at HEAD ${round.handoff.summary?.head ?? 'unknown'}. This is context only: inspect the current ` +
    (options.carry ? 'state; when you hand off, the Factory re-obtains only what is missing and keeps the valid opinions if the proposal is unchanged; '
      : 'state; when you hand off, the Factory obtains new opinions of both reviewers; ') + 'treat the findings of the results it then delivers to you ' +
    '(their round), never these.\n';
  let body = JSON.stringify(reviewers);
  if (Buffer.byteLength(head + body) > maxBytes) body = JSON.stringify(reviewers.map(item => ({ role: item.role, conclusion: item.conclusion, findings: item.findings.map(finding => finding.id) })));
  if (Buffer.byteLength(head + body) > maxBytes) body = JSON.stringify(reviewers.map(item => ({ role: item.role, conclusion: item.conclusion })));
  return head + fenced(body);
}
