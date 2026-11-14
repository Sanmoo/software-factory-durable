import type { IssueTracker } from '../../issue-tracker/index.js';
import { authorizeCommentAuthor, commentEligibility, parseFactoryCommand, questionCommentBody, type OperatorRef } from '../rules/questions.js';
import type { WorkRecord } from './admission.js';
import { acceptAnswer, readQuestion, readQuestions, recordIgnored, recordInputsCursor, recordPublication } from './questions.js';
import type { Session } from './store.js';

const maxKnownFailures = 5;

/**
 * Question publication and answer ingestion inside the existing owner loop (after each polling iteration; no scheduler/broker).
 * Publication: intent (already committed with the Question) -> attempt commit -> postComment -> observation commit. After an
 * unknown outcome or an attempt interrupted by a crash, the marker is DISCOVERED first; an incomplete search never proves absence and
 * several candidates are never chosen. Ingestion: complete comment listings of Works with open Questions; strict `/factory` prefix,
 * configured human operators and this Work's own Ticket only. Neither path launches anything.
 */
export function createQuestionDesk(deps: { session: Session; tracker: IssueTracker; operators: readonly OperatorRef[]; readWorks(): Promise<WorkRecord[]>; stopped(): boolean }) {
  const { session, tracker } = deps;
  let chain: Promise<void> = Promise.resolve();
  const unexpected = () => undefined;

  async function publishPending() {
    for (const work of await deps.readWorks()) {
      if (work.result !== 'open') continue;
      for (const question of await readQuestions(session, work)) {
        if (deps.stopped()) return;
        if (question.state !== 'open' || question.destination.kind !== 'issue') continue;
        let state = question.publication.state;
        const ticket = question.destination.ticket;
        if (state === 'attempting' || state === 'ambiguous') {
          const search = await tracker.findQuestion(ticket, question.questionId).catch(unexpected);
          const update = !search || search.kind !== 'observed' ? { kind: 'discovery' as const, outcome: 'discovery-incomplete' as const, code: search?.code ?? 'TRACKER_UNEXPECTED_FAILURE' }
            : search.candidates.length === 1 ? { kind: 'discovery' as const, outcome: 'discovered' as const, comment: { commentId: search.candidates[0]!.commentId, url: search.candidates[0]!.url } }
            : search.candidates.length === 0 ? { kind: 'discovery' as const, outcome: 'absent' as const } : { kind: 'discovery' as const, outcome: 'multiple' as const };
          const next = await recordPublication(session, question.questionId, update);
          if (next === 'stale') continue;
          state = next;
        }
        const failures = question.publication.attempts.filter(item => item.outcome === 'failed').length;
        if (!(state === 'intended' || (state === 'failed' && failures < maxKnownFailures)) || deps.stopped()) continue;
        if (await recordPublication(session, question.questionId, { kind: 'begin' }) !== 'attempting') continue;
        const body = questionCommentBody({ questionId: question.questionId, workId: question.workId, executionId: question.executionId,
          question: question.content.question, context: question.content.context });
        const result = await tracker.postComment(ticket, { kind: 'question', questionId: question.questionId, body },
          { effectId: question.publication.effectId, questionId: question.questionId }).catch(unexpected);
        const revocation = result?.revocation ? { revocation: result.revocation } : {};
        await recordPublication(session, question.questionId, !result ? { kind: 'result', outcome: 'unknown', code: 'TRACKER_UNEXPECTED_FAILURE', nextStep: 'Unexpected adapter failure; discover before republishing.' }
          : result.kind === 'published' ? { kind: 'result', outcome: 'published', comment: { commentId: result.commentId, url: result.url }, ...revocation }
          : { kind: 'result', outcome: result.kind === 'failed' ? 'failed' : 'unknown', code: result.code, nextStep: result.nextStep, ...revocation });
      }
    }
  }

  async function ingestAnswers() {
    for (const work of await deps.readWorks()) {
      if (deps.stopped()) return;
      if (work.result !== 'open') continue;
      const open = (await readQuestions(session, work)).some(question => question.state === 'open');
      if (!open) continue;
      const inputs = await tracker.readInputs(work.ticket, work.inputs?.cursor ?? null).catch(unexpected);
      // Unavailable/partial listing: no conclusion and the cursor does not move.
      if (!inputs || inputs.kind !== 'observed') continue;
      for (const comment of inputs.comments) {
        const command = parseFactoryCommand(comment.body);
        if (command.kind !== 'answer') continue;
        const origin = `github-comment:${comment.commentId}`;
        const author = authorizeCommentAuthor(comment.author, deps.operators, comment.viaApp);
        // Unauthorized: a bounded summary on the Question only, never a durable request document per comment.
        if (!author.authorized) { await recordIgnored(session, command.questionId, origin, author.code); continue; }
        const question = await readQuestion(session, command.questionId);
        const eligibility = question ? commentEligibility({ commentId: comment.commentId, createdAt: Date.parse(comment.createdAt), updatedAt: Date.parse(comment.updatedAt) },
          { recordedAt: Date.parse(question.recordedAt), publishedCommentId: question.publication.comment?.commentId ?? null }) : { eligible: true as const };
        if (!eligibility.eligible) { await recordIgnored(session, command.questionId, origin, eligibility.code); continue; }
        await acceptAnswer(session, { request_id: `github-comment-${comment.commentId}`, question_id: command.questionId, text: command.text,
          origin: { kind: 'github-comment', workId: work.work_id, comment: { commentId: comment.commentId, url: comment.url, author: comment.author } } });
      }
      await recordInputsCursor(session, work.work_id, inputs.cursor);
    }
  }

  // One pass at a time in this owner (chained, none skipped): a kick during a polling pass runs right after it.
  function serial(task: () => Promise<void>) {
    const next = chain.then(() => deps.stopped() ? undefined : task());
    chain = next.catch(() => {});
    return next;
  }
  return {
    /** Publication then ingestion; persistence failures propagate (the owner fails), adapter failures stay observations. */
    cycle: () => serial(async () => { await publishPending(); await ingestAnswers(); }),
    /** Publication right after a Question commit, independent of cessation (not awaited by the worker ACK). */
    kick() { void serial(publishPending).catch(() => {}); },
    idle: () => chain,
  };
}
