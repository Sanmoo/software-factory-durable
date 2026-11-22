import type { IssueTracker } from '../../issue-tracker/index.js';
import { questionCommentBody, questionNeedsDiscovery, questionPublishAllowed, type OperatorRef } from '../rules/questions.js';
import type { WorkRecord } from './admission.js';
import { readQuestions, recordInputsCursor, recordPublication } from './questions.js';
import { ingestComment, recordReplyPublication } from './feedback.js';
import type { Session } from './store.js';

const maxKnownFailures = 5;

type QuestionSearch = Awaited<ReturnType<IssueTracker['findQuestion']>> | undefined;
type ReplySearch = Awaited<ReturnType<NonNullable<IssueTracker['findReply']>>> | undefined;
type PostResult = Awaited<ReturnType<IssueTracker['postComment']>> | undefined;
type PublicationUpdate = Parameters<typeof recordPublication>[2];
type ReplyUpdate = Parameters<typeof recordReplyPublication>[3];

/** The discovery of a Question's marker, as its publication records it: only one complete candidate is a discovery. */
function questionDiscoveryUpdate(search: QuestionSearch): PublicationUpdate {
  if (!search || search.kind !== 'observed')
    return { kind: 'discovery' as const, outcome: 'discovery-incomplete' as const, code: search?.code ?? 'TRACKER_UNEXPECTED_FAILURE' };
  if (search.candidates.length === 1)
    return {
      kind: 'discovery' as const,
      outcome: 'discovered' as const,
      comment: { commentId: search.candidates[0]!.commentId, url: search.candidates[0]!.url },
    };
  return search.candidates.length === 0
    ? { kind: 'discovery' as const, outcome: 'absent' as const }
    : { kind: 'discovery' as const, outcome: 'multiple' as const };
}

/** The outcome of a Question's POST, as its publication records it; no answer from the adapter is an unknown outcome. */
function questionPublicationResult(result: PostResult, revocation: { revocation?: string }): PublicationUpdate {
  if (!result)
    return { kind: 'result', outcome: 'unknown', code: 'TRACKER_UNEXPECTED_FAILURE', nextStep: 'Unexpected adapter failure; discover before republishing.' };
  if (result.kind === 'published') return { kind: 'result', outcome: 'published', comment: { commentId: result.commentId, url: result.url }, ...revocation };
  return { kind: 'result', outcome: result.kind === 'failed' ? 'failed' : 'unknown', code: result.code, nextStep: result.nextStep, ...revocation };
}

/** Ticket 23: the discovery of a reply's marker, as its publication records it. */
function replyDiscoveryUpdate(search: ReplySearch): ReplyUpdate {
  if (!search || search.kind !== 'observed') return { kind: 'undetermined', code: search?.code ?? 'TRACKER_UNEXPECTED_FAILURE' };
  if (search.candidates.length === 1) return { kind: 'discovered', comment: { commentId: search.candidates[0]!.commentId, url: search.candidates[0]!.url } };
  return search.candidates.length === 0 ? { kind: 'absent' } : { kind: 'undetermined', code: 'REPLY_MULTIPLE_CANDIDATES' };
}

/** Ticket 23: the outcome of a reply's POST, as its publication records it. */
function replyPublicationResult(result: PostResult): ReplyUpdate {
  if (!result) return { kind: 'unknown', code: 'TRACKER_UNEXPECTED_FAILURE' };
  if (result.kind === 'published') return { kind: 'published', comment: { commentId: result.commentId, url: result.url } };
  return { kind: result.kind, code: result.code };
}

/** Ticket 23: a Work that has run at least once (own PR, correction or Execution) may carry `/factory repair` on its Ticket. */
const hasRun = (work: WorkRecord) => Boolean(work.pullRequest || work.correction || work.execution);

/** The comment-listing cursor the Work recorded, when it is one. */
function inputsCursorOf(work: WorkRecord) {
  const cursor = work.inputs?.cursor ?? null;
  return typeof cursor === 'number' ? cursor : null;
}

/**
 * Question publication and answer ingestion inside the existing owner loop (after each polling iteration; no scheduler/broker).
 * Publication: intent (already committed with the Question) -> attempt commit -> postComment -> observation commit. After an
 * unknown outcome or an attempt interrupted by a crash, the marker is DISCOVERED first; an incomplete search never proves absence, several
 * candidates are never chosen and (ticket 27) a complete empty search after a possible send is `unconfirmed`, never a repost. Ingestion: complete comment listings of Works with open Questions; strict `/factory` prefix,
 * configured human operators and this Work's own Ticket only. Neither path launches anything.
 */
export function createQuestionDesk(deps: {
  session: Session;
  tracker: IssueTracker;
  operators: readonly OperatorRef[];
  readWorks(): Promise<WorkRecord[]>;
  stopped(): boolean;
}) {
  const { session, tracker } = deps;
  let chain: Promise<void> = Promise.resolve();
  const unexpected = () => undefined;

  async function publishPending() {
    for (const work of await deps.readWorks()) {
      // Ticket 27/25: a Work that is no longer open (cancelled, delivered, closed) gets NO new POST, but a POST that may already have been
      // sent is still DISCOVERED (safe read): late effects of a cancellation are reconciled, never repeated.
      const open = work.result === 'open';
      for (const question of await readQuestions(session, work)) {
        if (deps.stopped()) return;
        if (question.state !== 'open' || question.destination.kind !== 'issue') continue;
        // The GitHub desk publishes only on GitHub origins; another origin's Questions wait for its own publisher (never redirected).
        if (question.destination.ticket.tracker !== 'github') continue;
        if (!open && !questionNeedsDiscovery(question.publication.state)) continue;
        let state = question.publication.state;
        const ticket = question.destination.ticket;
        if (questionNeedsDiscovery(state)) {
          const search = await tracker.findQuestion(ticket, question.questionId).catch(unexpected);
          const update = questionDiscoveryUpdate(search);
          const next = await recordPublication(session, question.questionId, update);
          if (next === 'stale') continue;
          state = next;
        }
        const failures = question.publication.attempts.filter(item => item.outcome === 'failed').length;
        if (!open || !questionPublishAllowed(state, failures, maxKnownFailures) || deps.stopped()) continue;
        if ((await recordPublication(session, question.questionId, { kind: 'begin' })) !== 'attempting') continue;
        const body = questionCommentBody({
          questionId: question.questionId,
          workId: question.workId,
          executionId: question.executionId,
          question: question.content.question,
          context: question.content.context,
        });
        const result = await tracker
          .postComment(
            ticket,
            { kind: 'question', questionId: question.questionId, body },
            { effectId: question.publication.effectId, questionId: question.questionId },
          )
          .catch(unexpected);
        const revocation = result?.revocation ? { revocation: result.revocation } : {};
        await recordPublication(session, question.questionId, questionPublicationResult(result, revocation));
      }
    }
  }

  /** Ticket 23: the replies to `/factory` commands, on the Work's Ticket, with the same effect discipline as Questions. */
  async function publishReplies() {
    for (const work of await deps.readWorks()) {
      if (work.ticket.tracker !== 'github') continue;
      const ticket = work.ticket;
      for (const reply of work.feedback?.replies ?? []) {
        if (deps.stopped()) return;
        let state: string = reply.publication.state;
        if (state === 'attempting' || state === 'ambiguous') {
          if (!tracker.findReply) continue; // no discovery composed: never republish blindly
          const search = await tracker.findReply(ticket, reply.replyId).catch(unexpected);
          state = await recordReplyPublication(session, work.work_id, reply.replyId, replyDiscoveryUpdate(search));
        }
        if (!(state === 'intended' || (state === 'failed' && reply.publication.failures < maxKnownFailures)) || deps.stopped()) continue;
        if ((await recordReplyPublication(session, work.work_id, reply.replyId, { kind: 'begin' })) !== 'attempting') continue;
        const result = await tracker
          .postComment(ticket, { kind: 'reply', replyId: reply.replyId, body: reply.body }, { effectId: reply.publication.effectId, replyId: reply.replyId })
          .catch(unexpected);
        await recordReplyPublication(session, work.work_id, reply.replyId, replyPublicationResult(result));
      }
    }
  }

  async function ingestAnswers() {
    for (const work of await deps.readWorks()) {
      if (deps.stopped()) return;
      if (work.result !== 'open' || work.ticket.tracker !== 'github') continue;
      // Ticket 23: the Ticket also carries `/factory repair` once the Work has run at least once (answered, refused with its next step when
      // there is no own PR yet). A Work only admitted reads no comments (admission stays read-minimal); its later command is still eligible.
      const open = (await readQuestions(session, work)).some(question => question.state === 'open');
      if (!open && !hasRun(work)) continue;

      const inputs = await tracker.readInputs(work.ticket, inputsCursorOf(work)).catch(unexpected);
      // Unavailable/partial listing: no conclusion and the cursor does not move.
      if (!inputs || inputs.kind !== 'observed') continue;
      // The single ingestion of `/factory` comments (answers and repairs; ticket 23); unauthorized ones leave a bounded summary only.
      for (const comment of inputs.comments) await ingestComment(session, work, comment, deps.operators);
      await recordInputsCursor(session, work.work_id, inputs.cursor);
    }
  }

  // One pass at a time in this owner (chained, none skipped): a kick during a polling pass runs right after it.
  function serial(task: () => Promise<void>) {
    const next = chain.then(() => (deps.stopped() ? undefined : task()));
    chain = next.catch(() => {});
    return next;
  }
  return {
    /** Publication then ingestion; persistence failures propagate (the owner fails), adapter failures stay observations. */
    cycle: () =>
      serial(async () => {
        await publishPending();
        await ingestAnswers();
        await publishReplies();
      }),
    /** Publication right after a Question commit, independent of cessation (not awaited by the worker ACK). */
    kick() {
      void serial(publishPending).catch(() => {});
    },
    idle: () => chain,
  };
}
