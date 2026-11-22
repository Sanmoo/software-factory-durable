import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { jiraInputOrder } from '../../contracts/index.js';
import type { DocFamilyToken } from '@earendil-works/pi-durable';
import type { JiraComment, JiraInputCursor, JiraTicketRef } from '../../issue-tracker/index.js';
import type { ControlReceipt, JiraOriginTracker, QuestionView } from '../types.js';
import { jiraCancelComment, jiraCommentDecision, jiraGuidanceComment, jiraRequestId, type JiraCommentDecision } from '../rules/jira-conversation.js';
import { requests, works, type WorkRecord } from './admission.js';
import { cancelIn } from './cycles.js';
import { intendJiraComment } from './jira-comments.js';
import { answerIn, questions, readQuestions } from './questions.js';
import type { Session } from './store.js';

// Jira ticket 06 (spec §4): the inputs of a Jira Work are the ordinary Platform comments of its origin Card, read completely (or not at all).
// The single ingestion of one comment decides and records in ONE commit: its ingress identity `(siteId, issueId, commentId)` with its receipt
// and the transition it causes (answer accepted, guidance intended). A re-read after a restart returns the stored receipt (never a second
// answer, never undone by a later edit). The cursor advances only over processed comments.
// Jira ticket 07: `/factory cancel` is the SAME cancellation as the local `cancel` (`cancelIn`), of THIS Card's Work only, in the same commit as
// its request identity, receipt and the reply intent on the Card. The Jira comment permission is the whole authorization (no operator list).

export type JiraIngestOutcome =
  | { kind: 'none' }
  | { kind: 'replayed'; receipt: ControlReceipt | null }
  | { kind: 'recorded'; receipt: ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' } };

/** One comment of the Work's origin Card. Conversation and reserved (automatic) text record nothing; every `/factory` comment gets a receipt. */
export async function ingestJiraComment(session: Session, work_id: string, comment: JiraComment): Promise<JiraIngestOutcome> {
  const request_id = jiraRequestId(comment.ref);
  return session.commit(async (tx): Promise<JiraIngestOutcome> => {
    const request = await tx.doc(requests, request_id, null);
    if (request.input) return replayed(request.receipt);
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || !onOriginCard(work, comment)) return { kind: 'none' };
    const known = await jiraQuestionsOf(tx, work);
    const accountId = authorOf(comment);
    const decision = jiraCommentDecision({ comment: commentFacts(comment, accountId), questions: known.map(cardQuestion) });
    if (decision.kind === 'none') return { kind: 'none' };
    const { siteId, issueId, commentId } = comment.ref;
    const ingress = { siteId, issueId, commentId, accountId };
    if (decision.kind === 'cancel' || decision.kind === 'accept') {
      // The rule never applies a comment whose author was not observed; an unobserved author here would be a broken invariant.
      if (accountId === null) throw new Error('JIRA_COMMENT_AUTHOR_UNOBSERVED');
      if (decision.kind === 'accept') {
        return {
          kind: 'recorded',
          receipt: await answerIn(tx, {
            request_id,
            question_id: decision.questionId,
            text: decision.text,
            origin: { kind: 'jira-comment', workId: work.work_id, comment: { siteId, issueId, commentId, url: comment.url, accountId } },
          }),
        };
      }
      return recordJiraCancel(tx, request, work, request_id, { ...ingress, accountId });
    }
    return recordJiraCommentReceipt(tx, request, work, request_id, decision, ingress);
  }, BACKGROUND_CONTEXT);
}

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
type IngressRequest = typeof requests extends DocFamilyToken<infer T, infer _I, infer _D> ? T : never;
type JiraWork = WorkRecord & { ticket: JiraTicketRef };
type Ingress = { siteId: string; issueId: string; commentId: string; accountId: string | null };

/** A copy: the stored receipt is a view of this commit's overlay, unusable once it settled. */
const replayed = (receipt: ControlReceipt | null): JiraIngestOutcome => ({
  kind: 'replayed',
  receipt: receipt ? (JSON.parse(JSON.stringify(receipt)) as ControlReceipt) : null,
});
/** The comment belongs to the Work's own origin Card (same site and issue). */
const onOriginCard = (work: WorkRecord, comment: JiraComment): work is JiraWork =>
  work.ticket.tracker === 'jira' && work.ticket.siteId === comment.ref.siteId && work.ticket.issueId === comment.ref.issueId;
const authorOf = (comment: JiraComment) => comment.author?.accountId ?? null;
const commentFacts = (comment: JiraComment, accountId: string | null) => ({
  text: comment.body,
  authorObserved: accountId !== null,
  createdAt: Date.parse(comment.createdAt),
  updatedAt: Date.parse(comment.updatedAt),
  restricted: comment.restricted,
});
const cardQuestion = (question: QuestionView) => ({
  questionId: question.questionId,
  ref: question.jira!.ref,
  state: question.state,
  since: Date.parse(question.jira!.publishedAt ?? question.recordedAt),
});
/** The Work's Questions published on its Card, in the Work's order. */
async function jiraQuestionsOf(tx: Tx, work: WorkRecord): Promise<QuestionView[]> {
  const known: QuestionView[] = [];
  for (const id of work.questions ?? []) {
    const question = (await tx.doc(questions, id, null)).question;
    if (question?.jira) known.push(question);
  }
  return known;
}
/** `/factory cancel`: the same cancellation as the local `cancel`, its reply intended on the Card, in the commit of its receipt. */
async function recordJiraCancel(
  tx: Tx,
  request: IngressRequest,
  work: JiraWork,
  request_id: string,
  ingress: Ingress & { accountId: string },
): Promise<JiraIngestOutcome> {
  const { accountId, commentId } = ingress;
  const cancelled = await cancelIn(tx, { request_id, operation: 'cancel', work_id: work.work_id }, { kind: 'jira-comment', accountId, commentId });
  const effect = await intendJiraComment(tx, {
    destination: work.ticket,
    purpose: { kind: 'reply', workId: work.work_id, request_id },
    refPrefix: 'R',
    content: ref => jiraCancelComment({ ref, commentId, outcome: cancelled.outcome, reason: cancelled.reason }),
  });
  const receipt: ControlReceipt = { ...cancelled, reply: effect.logicalRef };
  request.input = { request_id, operation: 'cancel', work_id: work.work_id, origin: 'jira-comment', comment: { ...ingress } };
  request.receipt = receipt;
  return { kind: 'recorded', receipt: structuredClone(receipt) };
}
/** A `/factory` comment that did not apply: guided (its guidance intended on the Card) or ignored, with its receipt. */
async function recordJiraCommentReceipt(
  tx: Tx,
  request: IngressRequest,
  work: JiraWork,
  request_id: string,
  decision: Extract<JiraCommentDecision, { kind: 'guide' | 'ignore' }>,
  ingress: Ingress,
): Promise<JiraIngestOutcome> {
  let reply: string | null = null;
  if (decision.kind === 'guide') {
    const effect = await intendJiraComment(tx, {
      destination: work.ticket,
      purpose: { kind: 'reply', workId: work.work_id, request_id },
      refPrefix: 'R',
      content: ref => jiraGuidanceComment({ ref, code: decision.code, refs: decision.refs, commentId: ingress.commentId }),
    });
    reply = effect.logicalRef;
  }
  const receipt: ControlReceipt = {
    kind: 'durable',
    request_id,
    operation: 'jira-comment',
    work_id: work.work_id,
    outcome: decision.kind === 'guide' ? 'guided' : 'ignored',
    reason: decision.code,
    reply,
  };
  request.input = { request_id, operation: 'jira-comment', work_id: work.work_id, origin: 'jira-comment', comment: ingress };
  request.receipt = receipt;
  return { kind: 'recorded', receipt: structuredClone(receipt) };
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

/** Which open Jira Works have their Card read every pass: like GitHub, once they ran or have an open Question. */
export type JiraInputScope = (work: WorkRecord, questions: readonly QuestionView[]) => boolean;
const ranOrAsks: JiraInputScope = (work, known) =>
  known.some(question => question.state === 'open') || Boolean(work.pullRequest || work.correction || work.execution);
/** Jira ticket 07: open Jira Works outside the scope (admitted, never ran: `/factory cancel` must reach them) read per pass, least recently read first. */
export const idleReadsPerPass = 8;

/** The Jira cursor of the Work's Card, if one was recorded. */
function jiraCursorOf(work: WorkRecord): JiraInputCursor | null {
  const known = work.inputs?.cursor ?? null;
  return known !== null && typeof known === 'object' ? known : null;
}
/** An ingested `/factory cancel` whose cancellation was accepted. */
const acceptedCancel = (outcome: JiraIngestOutcome) =>
  outcome.kind === 'recorded' && outcome.receipt.kind === 'durable' && outcome.receipt.operation === 'cancel' && outcome.receipt.outcome === 'accepted';

/**
 * The input pass of the owner loop: for each open Jira Work in scope, ONE complete read of its Card's comments after the cursor, each one
 * ingested in order, then the cursor. An unavailable/partial read concludes nothing and moves nothing. Never launches anything: an accepted
 * answer only removes its Question's impediment (the Work resumes through its queue).
 */
export function createJiraInputDesk(deps: {
  session: Session;
  tracker: JiraOriginTracker;
  readWorks(): Promise<WorkRecord[]>;
  stopped(): boolean;
  scope?: JiraInputScope;
  /** Jira ticket 07: an accepted `/factory cancel` (already durable): the caller withdraws credentials and requests the stop, as for the local `cancel`. */
  cancelled?(work_id: string): void;
  idleReads?: number;
}) {
  const scope = deps.scope ?? ranOrAsks;
  const idleReads = deps.idleReads ?? idleReadsPerPass;
  // In memory only (a restart starts over): when each idle Work's Card was last read, so every one is reached within a bounded number of passes.
  const lastRead = new Map<string, number>();
  let passes = 0;
  async function read(work: WorkRecord) {
    if (work.ticket.tracker !== 'jira') return;
    lastRead.set(work.work_id, passes);
    const inputs = await deps.tracker.readInputs(work.ticket, jiraCursorOf(work)).catch(() => undefined);
    if (!inputs || inputs.kind !== 'observed') return;
    for (const comment of inputs.comments) {
      const outcome = await ingestJiraComment(deps.session, work.work_id, comment);
      if (acceptedCancel(outcome)) deps.cancelled?.(work.work_id);
    }
    if (inputs.cursor) await recordJiraInputsCursor(deps.session, work.work_id, inputs.cursor);
  }
  return {
    async pass() {
      passes++;
      const idle: WorkRecord[] = [];
      for (const work of await deps.readWorks()) {
        if (deps.stopped()) return;
        if (work.result !== 'open' || work.ticket.tracker !== 'jira') continue;
        if (!scope(work, await readQuestions(deps.session, work))) {
          idle.push(work);
          continue;
        }
        await read(work);
      }
      const due = idle
        .map((work, order) => ({ work, order, at: lastRead.get(work.work_id) ?? -1 }))
        .sort((a, b) => a.at - b.at || a.order - b.order)
        .slice(0, idleReads);
      for (const { work } of due) {
        if (deps.stopped()) return;
        await read(work);
      }
    },
  };
}
