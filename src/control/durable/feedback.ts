import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CodeRepository, FeedbackObservation } from '../../code-repository/index.js';
import type { ControlReceipt, ConversationCommentFact, FeedbackRequest, FeedbackView, HumanFeedback, WorkCorrection } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { commentCommand, feedbackLimits, repairNextStep, repairPhase, repairReplyBody, repairRequestDecision, reviewRequests, undeliveredHuman } from '../rules/feedback.js';
import { commentEligibility, type OperatorRef } from '../rules/questions.js';
import { requests, ticketIndex, works, type WorkRecord } from './admission.js';
import { activeExecution } from './execution.js';
import { acceptAnswer, readQuestion, recordIgnored } from './questions.js';
import type { Session } from './store.js';

// Ticket 23 (spec §10, §11.3): human feedback — an operator's CHANGES_REQUESTED review of the own PR, an explicit `repair` (local CLI or a
// strict `/factory repair` comment on the Ticket or the own PR) — is RECORDED on the Work with its identity, origin, version and content,
// whatever the Work is doing; nothing is delivered to a running activity, nothing is launched, nothing is charged here. The repair
// observation (ticket 22's desk) folds the records into the Work's correction at its next safe point, in commit order.

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const emptyFeedback = (): FeedbackView => ({ requests: [], pullRequestCursor: null, observedAt: null, ignored: [] });
/** The Work's feedback record AS STORED in the document (assign first, then read back: never mutate a detached copy). */
function feedbackOf(work: WorkRecord): FeedbackView {
  if (!work.feedback) work.feedback = emptyFeedback();
  return work.feedback;
}
/** Bounded: every request still pending/in a correction is kept; settled ones only the latest. */
const bound = (items: FeedbackRequest[]) => {
  const open = items.filter(item => item.state === 'pending' || item.state === 'in-correction');
  const settled = items.filter(item => !open.includes(item)).slice(-Math.max(0, feedbackLimits.requests - open.length));
  return items.filter(item => open.includes(item) || settled.includes(item));
};
const isCurrent = (work: WorkRecord | null, index: { tickets: Record<string, { current?: string } | undefined> }) =>
  Boolean(work && work.result === 'open' && index.tickets[ticketKey(work.ticket)]?.current === work.work_id);
const headOf = (work: WorkRecord) => work.publication?.verified?.head ?? work.checks?.latest.pullRequest.headSha ?? null;
/** Inside a commit: the identity is settled for good (bounded tombstone; survives the eviction of the request record). */
function tombstone(work: WorkRecord, feedbackId: string) {
  const feedback = feedbackOf(work);
  if (!(feedback.settled ?? []).includes(feedbackId)) feedback.settled = [...(feedback.settled ?? []), feedbackId].slice(-500);
}
function ignore(feedback: FeedbackView, at: string, origin: string, code: string) {
  if (feedback.ignored.some(item => item.origin === origin)) return;
  feedback.ignored = [...feedback.ignored, { at, origin, code }].slice(-feedbackLimits.ignored);
}

/**
 * One commit per complete feedback observation of the Work's linked own PR: new operator CHANGES_REQUESTED reviews are recorded once
 * (content as submitted); a recorded review whose trigger a later approval/dismissal removed is withdrawn — only that one, never an
 * independent request, and never a statement that human merge approval is satisfied. Unauthorized reviews leave a bounded summary only.
 */
export async function recordReviewFeedback(session: Session, work_id: string, observation: Extract<FeedbackObservation, { kind: 'observed' }>, operators: readonly OperatorRef[]) {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || !isCurrent(work, index) || work.pullRequest?.number !== observation.number) return 'stale' as const;
    const now = new Date().toISOString();
    const feedback = feedbackOf(work);
    // A review submitted before this Work was admitted never triggers it (a pre-existing request must not charge a new cycle).
    const admitted = Date.parse(work.admittedAt);
    const older = observation.reviews.filter(item => item.state === 'CHANGES_REQUESTED' && item.submittedAt !== null && Date.parse(item.submittedAt) < admitted);
    for (const item of older) ignore(feedback, now, `github-review:${item.reviewId}`, 'REVIEW_PREDATES_WORK');
    const outcome = reviewRequests({ reviews: observation.reviews.filter(item => !older.includes(item)), reviewComments: observation.reviewComments, operators, digest });
    for (const item of outcome.ignored) ignore(feedback, now, item.origin, item.code);
    for (const request of outcome.active) {
      if (feedback.requests.some(item => item.feedbackId === request.feedbackId) || (feedback.settled ?? []).includes(request.feedbackId)) continue;
      feedback.requests.push({ feedbackId: request.feedbackId, code: 'HUMAN_CHANGES_REQUESTED', feedback: request, recordedAt: now, recordedHead: headOf(work),
        state: 'pending', correctionId: null, closedAt: null, outcome: null });
      work.history.push({ at: now, event: 'feedback-recorded', origin: 'controller-feedback', feedbackId: request.feedbackId, detail: `review:${request.author?.login ?? '?'}@${request.version ?? '?'}` });
    }
    const executionsBefore = [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];
    const undeliveredBefore = work.correction?.consumed ? undeliveredHuman(work.correction, executionsBefore).length : 0;
    for (const request of feedback.requests) {
      const removed = outcome.inactive[request.feedbackId];
      if (!removed || request.code !== 'HUMAN_CHANGES_REQUESTED' || (request.state !== 'pending' && request.state !== 'in-correction')) continue;
      // Already delivered to a charged correction's Builder: that treatment stands (it closes with its correction).
      if (request.state === 'in-correction' && work.correction?.consumed && !undeliveredHuman(work.correction, [...work.previousExecutions, ...(work.execution ? [work.execution] : [])])
        .some(item => item.subject === request.feedbackId)) continue;
      Object.assign(request, { state: 'withdrawn', closedAt: now, outcome: removed });
      tombstone(work, request.feedbackId);
      if (work.correction?.consumed) work.correction.reasons = (work.correction.reasons ?? []).filter(item => item.subject !== request.feedbackId);
      work.history.push({ at: now, event: 'feedback-withdrawn', origin: 'controller-feedback', feedbackId: request.feedbackId, detail: removed });
    }
    // A continuation (ticket 23) whose requests were all withdrawn BY THIS observation before it started has nothing left to deliver: no
    // activation for it. Real run q23-feedback-v3: never after the continuation delivered them (that would clear a pending publication).
    if (work.correction?.consumed && work.correction.continuing && undeliveredBefore > 0 && !activeExecution(work.execution ?? null) &&
        !undeliveredHuman(work.correction, executionsBefore).length) {
      work.correction.continuing = false;
      work.queue = { ...work.queue, pending: Boolean(work.pendingRecovery) || (work.scopeUpdates ?? []).some(update => update.state === 'pending') };
      work.history.push({ at: now, event: 'feedback-withdrawn', origin: 'controller-feedback', feedbackId: null, detail: 'continuation: nothing left to deliver' });
    }
    feedback.requests = bound(feedback.requests);
    feedback.observedAt = observation.observedAt;
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

type RepairOrigin = { kind: 'local-cli' } | { kind: 'github-comment'; comment: { commentId: number; url: string; author: { id: number; login: string }; createdAt: string } };
type RepairReceipt = Extract<ControlReceipt, { operation: 'repair' }>;
/**
 * "Aceitar comando" for `repair` (spec §11.3): dedupe by ingress identity, the concrete-reason rule, the phase answer (accepted / deferred /
 * already covered / refused) and the record share ONE commit. Charged to `corrections` only by the correction's confirmed start.
 */
export async function acceptRepairRequest(session: Session, input: { request_id: string; work_id: string; reason: string; origin: RepairOrigin }):
  Promise<RepairReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  const ingress = { request_id: input.request_id, operation: 'repair' as const, work_id: input.work_id, reason: input.reason, origin: input.origin.kind };
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(ingress)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return JSON.parse(JSON.stringify(request.receipt)) as RepairReceipt;
    }
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const sha256 = digest(input.reason);
    const base = { kind: 'durable' as const, request_id: input.request_id, operation: 'repair' as const, work_id: input.work_id };
    let receipt: RepairReceipt;
    if (!work) receipt = { ...base, outcome: 'not-applied', reason: 'WORK_NOT_FOUND', feedbackId: null, appliesAt: null, nextStep: 'No Work with this identity; use `factory list`.' };
    else {
      const execution = work.execution ?? null;
      const questionWait = execution?.state === 'ended' && execution.end?.outcome === 'question' && work.impediments.some(item => item.code === 'QUESTION_PENDING');
      const phase = repairPhase({ activeExecution: activeExecution(execution), questionWait, publication: work.publication?.state ?? null, anyExecution: Boolean(execution) });
      const unresolved = (work.feedback?.requests ?? []).filter(item => item.code === 'EXPLICIT_REPAIR' && (item.state === 'pending' || item.state === 'in-correction'))
        .map(item => item.feedback.sha256);
      const decision = repairRequestDecision({ result: work.result, current: isCurrent(work, index), reason: input.reason, sha256, unresolved, phase });
      const now = new Date().toISOString();
      if (decision.outcome === 'not-applied' || decision.outcome === 'already-covered') {
        receipt = { ...base, outcome: decision.outcome, reason: decision.code, feedbackId: null, appliesAt: null, nextStep: repairNextStep(input.work_id, decision.outcome, decision.code) };
      } else {
        const feedbackId = `repair-${input.request_id}`;
        const feedback: HumanFeedback = { feedbackId, origin: input.origin.kind, author: input.origin.kind === 'github-comment'
          ? { login: input.origin.comment.author.login, id: input.origin.comment.author.id } : null, url: input.origin.kind === 'github-comment' ? input.origin.comment.url : null,
        version: headOf(work), submittedAt: input.origin.kind === 'github-comment' ? input.origin.comment.createdAt : now, sha256, content: input.reason, comments: [] };
        const record = feedbackOf(work);
        record.requests = bound([...record.requests, { feedbackId, code: 'EXPLICIT_REPAIR', feedback, recordedAt: now, recordedHead: headOf(work), state: 'pending',
          correctionId: null, closedAt: null, outcome: null }]);
        work.history.push({ at: now, event: 'repair-requested', origin: input.origin.kind, feedbackId, detail: `${decision.outcome}:${decision.during}` });
        receipt = { ...base, outcome: decision.outcome, reason: null, feedbackId, appliesAt: 'next-activation', nextStep: repairNextStep(input.work_id, decision.outcome, null) };
      }
    }
    // Spec §11.3: an operator's comment command is answered on the Ticket (intent here, in the SAME commit; published by the question desk).
    if (work && input.origin.kind === 'github-comment') {
      const record = feedbackOf(work);
      const at = new Date().toISOString();
      record.replies = [...(record.replies ?? []), { replyId: randomUUID(), request_id: input.request_id, source: { commentId: input.origin.comment.commentId, url: input.origin.comment.url },
        body: repairReplyBody({ workId: work.work_id, source: input.origin.comment.url, outcome: receipt.outcome, reason: receipt.reason, nextStep: receipt.nextStep, feedbackId: receipt.feedbackId }),
        recordedAt: at, publication: { effectId: randomUUID(), state: 'intended' as const, failures: 0, comment: null, code: null, updatedAt: at } }].slice(-20);
    }
    request.input = ingress;
    request.receipt = receipt;
    return JSON.parse(JSON.stringify(receipt)) as RepairReceipt;
  }, BACKGROUND_CONTEXT);
}

/**
 * The single ingestion of a `/factory` comment of a Work (its Ticket or its own PR): one authentication/correlation rule for answers and
 * repairs. Unauthorized or ineligible commands leave a bounded summary only; prose is nothing.
 */
export async function ingestComment(session: Session, work: Pick<WorkRecord, 'work_id' | 'admittedAt'>, comment: ConversationCommentFact, operators: readonly OperatorRef[]) {
  const command = commentCommand({ ...comment, createdAt: Date.parse(comment.createdAt), updatedAt: Date.parse(comment.updatedAt) },
    { operators, admittedAt: Date.parse(work.admittedAt) });
  const origin = `github-comment:${comment.commentId}`;
  if (command.kind === 'prose') return;
  if (command.kind === 'ignored') {
    if (command.questionId) await recordIgnored(session, command.questionId, origin, command.code);
    else await recordWorkIgnored(session, work.work_id, origin, command.code);
    return;
  }
  if (command.kind === 'repair') {
    await acceptRepairRequest(session, { request_id: `github-comment-${comment.commentId}`, work_id: work.work_id, reason: command.reason,
      origin: { kind: 'github-comment', comment: { commentId: comment.commentId, url: comment.url, author: { id: comment.author.id, login: comment.author.login }, createdAt: comment.createdAt } } });
    return;
  }
  const question = await readQuestion(session, command.questionId);
  const eligibility = question ? commentEligibility({ commentId: comment.commentId, createdAt: Date.parse(comment.createdAt), updatedAt: Date.parse(comment.updatedAt) },
    { recordedAt: Date.parse(question.recordedAt), publishedCommentId: typeof question.publication.comment?.commentId === 'number' ? question.publication.comment.commentId : null }) : { eligible: true as const };
  if (!eligibility.eligible) { await recordIgnored(session, command.questionId, origin, eligibility.code); return; }
  await acceptAnswer(session, { request_id: `github-comment-${comment.commentId}`, question_id: command.questionId, text: command.text,
    origin: { kind: 'github-comment', workId: work.work_id, comment: { commentId: comment.commentId, url: comment.url, author: comment.author } } });
}

async function recordWorkIgnored(session: Session, work_id: string, origin: string, code: string) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work) return;
    ignore(feedbackOf(work), new Date().toISOString(), origin, code);
  }, BACKGROUND_CONTEXT);
}
async function recordPullRequestCursor(session: Session, work_id: string, cursor: number) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work) return;
    const feedback = feedbackOf(work);
    if (feedback.pullRequestCursor === null || cursor > feedback.pullRequestCursor) feedback.pullRequestCursor = cursor;
  }, BACKGROUND_CONTEXT);
}

/**
 * Reads the human feedback of each open Work's linked own PR and records it (reviews; `/factory` comments of the PR conversation through
 * the single ingestion). Runs whatever the Work is doing: recording is not delivery and never interrupts or launches anything. A failed or
 * partial read decides nothing (no withdrawal, cursor unchanged).
 */
export async function observeFeedback(deps: { session: Session; repository: Pick<CodeRepository, 'readFeedback'>; operators: readonly OperatorRef[];
  repo(repository: string): Parameters<NonNullable<CodeRepository['readFeedback']>>[0]['repo'] | undefined }, work: WorkRecord): Promise<'observed' | 'unavailable' | 'skipped'> {
  const repo = deps.repo(work.repository.repository);
  if (!deps.repository.readFeedback || !repo || !work.pullRequest || work.result !== 'open') return 'skipped';
  const observation = await deps.repository.readFeedback({ repo, number: work.pullRequest.number }).catch(() => null);
  if (!observation || observation.kind !== 'observed') return 'unavailable';
  if (await recordReviewFeedback(deps.session, work.work_id, observation, deps.operators) === 'stale') return 'skipped';
  const cursor = work.feedback?.pullRequestCursor ?? null;
  const fresh = observation.comments.filter(item => cursor === null || item.commentId > cursor);
  for (const comment of fresh) await ingestComment(deps.session, work, comment, deps.operators);
  if (fresh.length) await recordPullRequestCursor(deps.session, work.work_id, fresh.at(-1)!.commentId);
  return 'observed';
}

/** The feedback pass of the owner loop (before the dispatcher tick): every open Work with a linked own PR, one at a time. */
export function createFeedbackDesk(deps: Parameters<typeof observeFeedback>[0] & { readWorks(): Promise<WorkRecord[]>; stopped(): boolean }) {
  return {
    async pass() {
      for (const work of await deps.readWorks()) {
        if (deps.stopped()) return;
        if (work.result === 'open' && work.pullRequest) await observeFeedback(deps, work);
      }
    },
  };
}

type ReplyUpdate = { kind: 'begin' } | { kind: 'published'; comment: { commentId: number; url: string } } | { kind: 'failed' | 'unknown'; code: string } |
  { kind: 'discovered'; comment: { commentId: number; url: string } } | { kind: 'absent' } | { kind: 'undetermined'; code: string };
/** Reply publication transitions (intent → attempt → observation; discovery after doubt, never a blind republication). */
export async function recordReplyPublication(session: Session, work_id: string, replyId: string, update: ReplyUpdate): Promise<string> {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const reply = work?.feedback?.replies?.find(item => item.replyId === replyId);
    if (!reply) return 'stale';
    const publication = reply.publication;
    const at = new Date().toISOString();
    if (update.kind === 'begin') {
      if (publication.state !== 'intended' && publication.state !== 'failed') return 'stale';
      Object.assign(publication, { state: 'attempting', updatedAt: at });
    } else if (update.kind === 'published' || update.kind === 'discovered') Object.assign(publication, { state: 'published', comment: update.comment, code: null, updatedAt: at });
    else if (update.kind === 'failed') Object.assign(publication, { state: 'failed', failures: publication.failures + 1, code: update.code, updatedAt: at });
    else if (update.kind === 'unknown' || update.kind === 'undetermined') Object.assign(publication, { state: 'ambiguous', code: update.code, updatedAt: at });
    // Discovery proved no reply exists: it may be attempted again (the same intent).
    else Object.assign(publication, { state: 'intended', updatedAt: at });
    return publication.state;
  }, BACKGROUND_CONTEXT);
}

/** Inside a commit: the Work's pending human requests that were folded into `correction` become part of it (identity kept). */
export function markInCorrection(work: WorkRecord, correction: Pick<WorkCorrection, 'correctionId' | 'reasons'>, head: string | null) {
  const subjects = new Set((correction.reasons ?? []).map(item => item.subject));
  for (const request of work.feedback?.requests ?? []) {
    if (request.state !== 'pending' || !subjects.has(request.feedbackId)) continue;
    Object.assign(request, { state: 'in-correction', correctionId: correction.correctionId, recordedHead: request.recordedHead ?? head });
  }
}
/** Inside the closing commit of a correction: a charged one TREATED its human requests (outcome kept); otherwise they return to pending. */
export function settleFeedback(work: WorkRecord, correctionId: string, charged: boolean, at: string, outcome: string, undelivered: ReadonlySet<string> = new Set()) {
  for (const request of work.feedback?.requests ?? []) {
    if (request.state !== 'in-correction' || request.correctionId !== correctionId) continue;
    if (charged && !undelivered.has(request.feedbackId)) {
      Object.assign(request, { state: 'treated', closedAt: at, outcome });
      tombstone(work, request.feedbackId);
      work.history.push({ at, event: 'feedback-treated', origin: 'controller-feedback', feedbackId: request.feedbackId, detail: `${correctionId}:${outcome}` });
    } else Object.assign(request, { state: 'pending', correctionId: null });
  }
}
