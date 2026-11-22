import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { jiraInputOrder } from '../../contracts/index.js';
import type { JiraComment, JiraInputCursor } from '../../issue-tracker/index.js';
import type { ControlReceipt, JiraOriginTracker, QuestionView } from '../types.js';
import { jiraCommentDecision, jiraGuidanceComment, jiraRequestId } from '../rules/jira-conversation.js';
import { requests, works, type WorkRecord } from './admission.js';
import { intendJiraComment } from './jira-comments.js';
import { answerIn, questions, readQuestions } from './questions.js';
import type { Session } from './store.js';

// Jira ticket 06 (spec §4): the inputs of a Jira Work are the ordinary Platform comments of its origin Card, read completely (or not at all).
// The single ingestion of one comment decides and records in ONE commit: its ingress identity `(siteId, issueId, commentId)` with its receipt
// and the transition it causes (answer accepted, guidance intended). A re-read after a restart returns the stored receipt (never a second
// answer, never undone by a later edit). The cursor advances only over processed comments. Ticket 07 adds `/factory cancel` here.

export type JiraIngestOutcome = { kind: 'none' } | { kind: 'replayed'; receipt: ControlReceipt | null } |
  { kind: 'recorded'; receipt: ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' } };

/** One comment of the Work's origin Card. Conversation and reserved (automatic) text record nothing; every `/factory` comment gets a receipt. */
export async function ingestJiraComment(session: Session, work_id: string, comment: JiraComment): Promise<JiraIngestOutcome> {
  const request_id = jiraRequestId(comment.ref);
  return session.commit(async (tx): Promise<JiraIngestOutcome> => {
    const request = await tx.doc(requests, request_id, null);
    if (request.input) return { kind: 'replayed', receipt: request.receipt };
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || work.ticket.tracker !== 'jira' || work.ticket.siteId !== comment.ref.siteId || work.ticket.issueId !== comment.ref.issueId) return { kind: 'none' };
    const known: QuestionView[] = [];
    for (const id of work.questions ?? []) {
      const question = (await tx.doc(questions, id, null)).question;
      if (question?.jira) known.push(question);
    }
    const decision = jiraCommentDecision({ comment: { text: comment.body, createdAt: Date.parse(comment.createdAt), updatedAt: Date.parse(comment.updatedAt), restricted: comment.restricted },
      questions: known.map(question => ({ questionId: question.questionId, ref: question.jira!.ref, state: question.state,
        since: Date.parse(question.jira!.publishedAt ?? question.recordedAt) })) });
    if (decision.kind === 'none') return { kind: 'none' };
    const { siteId, issueId, commentId } = comment.ref;
    if (decision.kind === 'accept') {
      return { kind: 'recorded', receipt: await answerIn(tx, { request_id, question_id: decision.questionId, text: decision.text,
        origin: { kind: 'jira-comment', workId: work.work_id, comment: { siteId, issueId, commentId, url: comment.url, accountId: comment.author.accountId } } }) };
    }
    let reply: string | null = null;
    if (decision.kind === 'guide') {
      const effect = await intendJiraComment(tx, { destination: work.ticket, purpose: { kind: 'reply', workId: work.work_id, request_id }, refPrefix: 'R',
        content: ref => jiraGuidanceComment({ ref, code: decision.code, refs: decision.refs, commentId }) });
      reply = effect.logicalRef;
    }
    const receipt: ControlReceipt = { kind: 'durable', request_id, operation: 'jira-comment', work_id: work.work_id, outcome: decision.kind === 'guide' ? 'guided' : 'ignored',
      reason: decision.code, reply };
    request.input = { request_id, operation: 'jira-comment', work_id: work.work_id, origin: 'jira-comment', comment: { siteId, issueId, commentId, accountId: comment.author.accountId } };
    request.receipt = receipt;
    return { kind: 'recorded', receipt: structuredClone(receipt) };
  }, BACKGROUND_CONTEXT);
}

/** Monotone Jira cursor of the Work's origin Card (only after its comments were processed). */
export async function recordJiraInputsCursor(session: Session, work_id: string, cursor: JiraInputCursor) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work) return;
    const known = work.inputs?.cursor ?? null;
    if (known !== null && typeof known === 'object' && jiraInputOrder(cursor, known) <= 0) return;
    work.inputs = { cursor: { tracker: 'jira', createdAt: cursor.createdAt, commentId: cursor.commentId } };
  }, BACKGROUND_CONTEXT);
}

/** Which open Jira Works have their Card read this pass (default: like GitHub, once they ran or have an open Question). Ticket 07 widens it. */
export type JiraInputScope = (work: WorkRecord, questions: readonly QuestionView[]) => boolean;
const ranOrAsks: JiraInputScope = (work, known) => known.some(question => question.state === 'open') || Boolean(work.pullRequest || work.correction || work.execution);

/**
 * The input pass of the owner loop: for each open Jira Work in scope, ONE complete read of its Card's comments after the cursor, each one
 * ingested in order, then the cursor. An unavailable/partial read concludes nothing and moves nothing. Never launches anything: an accepted
 * answer only removes its Question's impediment (the Work resumes through its queue).
 */
export function createJiraInputDesk(deps: { session: Session; tracker: JiraOriginTracker; readWorks(): Promise<WorkRecord[]>; stopped(): boolean; scope?: JiraInputScope }) {
  const scope = deps.scope ?? ranOrAsks;
  return {
    async pass() {
      for (const work of await deps.readWorks()) {
        if (deps.stopped()) return;
        if (work.result !== 'open' || work.ticket.tracker !== 'jira') continue;
        if (!scope(work, await readQuestions(deps.session, work))) continue;
        const known = work.inputs?.cursor ?? null;
        const inputs = await deps.tracker.readInputs(work.ticket, known !== null && typeof known === 'object' ? known : null).catch(() => undefined);
        if (!inputs || inputs.kind !== 'observed') continue;
        for (const comment of inputs.comments) await ingestJiraComment(deps.session, work.work_id, comment);
        if (inputs.cursor) await recordJiraInputsCursor(deps.session, work.work_id, inputs.cursor);
      }
    },
  };
}
