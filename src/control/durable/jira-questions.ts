import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { QuestionView } from '../types.js';
import { jiraQuestionComment } from '../rules/jira-conversation.js';
import { works, type WorkRecord } from './admission.js';
import { intendJiraComment, type JiraCommentEffect, type JiraCommentOwner } from './jira-comments.js';
import { questions, readQuestions } from './questions.js';
import type { Session } from './store.js';

// Jira ticket 06 (spec §4): a Question of a Jira Work is published on its persisted origin Card through the recoverable Jira comment
// (ticket 05): its short reference `Q-<n>` (installation-wide, never reused), destination and content are committed BEFORE any POST, an
// uncertain POST is reconciled (one exact own copy confirms; none in a complete read reposts the SAME reference; several/partial stay
// pending). A comment that merely carries a similar header neither confirms the publication nor closes the Question.

/** The impediment's next step in the Card's syntax: every `/factory answer <uuid>` becomes `/factory q<n>:` (keywords of divergence Questions kept). */
const cardStep = (nextStep: string, ref: string, questionId: string) =>
  nextStep
    .split(`/factory answer ${questionId}`)
    .join(`/factory q${ref.slice(2)}:`)
    .replace(' by a configured operator on the Ticket', ' on the Jira Card (any account allowed to comment)')
    .replace(' on the Ticket,', ' on the Jira Card,');

/**
 * For every open Question of an open Jira Work without a Jira publication yet: in ONE commit, its short reference and the comment intent
 * (destination = the Work's origin Card, by issue ID), and the impediment's next step in the Card's syntax. Idempotent (checked in the commit).
 */
export async function prepareJiraQuestions(session: Session, readWorks: () => Promise<WorkRecord[]>) {
  for (const work of await readWorks()) {
    if (work.result !== 'open' || work.ticket.tracker !== 'jira') continue;
    for (const known of await readQuestions(session, work)) {
      if (known.state !== 'open' || known.jira) continue;
      await session.commit(async tx => {
        const question = (await tx.doc(questions, known.questionId, null)).question;
        const current = (await tx.doc(works, known.workId, null)).work;
        if (!question || question.jira || question.state !== 'open' || !current || current.result !== 'open' || current.ticket.tracker !== 'jira') return;
        const effect = await intendJiraComment(tx, {
          destination: current.ticket,
          purpose: { kind: 'question', questionId: question.questionId, workId: current.work_id },
          refPrefix: 'Q',
          sequenced: true,
          content: ref => jiraQuestionComment({ ref, question: question.content.question, context: question.content.context }),
        });
        question.jira = { ref: effect.logicalRef, effectId: effect.effectId, publishedAt: null };
        for (const impediment of current.impediments) {
          if (impediment.code === 'QUESTION_PENDING' && impediment.questionId === question.questionId)
            impediment.nextStep = cardStep(impediment.nextStep, effect.logicalRef, question.questionId);
        }
      }, BACKGROUND_CONTEXT);
    }
  }
}

const publicationState = (effect: JiraCommentEffect): QuestionView['publication']['state'] => {
  switch (effect.state) {
    case 'intended':
      return 'intended';
    case 'attempting':
      return 'attempting';
    case 'published':
      return 'published';
    case 'unknown':
      return 'ambiguous';
    case 'pending':
      return effect.diagnostic?.code === 'JIRA_COMMENT_MULTIPLE' || effect.diagnostic?.code === 'JIRA_COMMENT_SIMILAR' ? 'conflict' : 'ambiguous';
    default:
      return 'failed';
  }
};

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
async function questionOf(tx: Tx, effect: JiraCommentEffect) {
  if (effect.purpose.kind !== 'question') return { question: null, work: null };
  const question = (await tx.doc(questions, effect.purpose.questionId, null)).question;
  if (!question || question.jira?.effectId !== effect.effectId) return { question: null, work: null };
  return { question, work: (await tx.doc(works, question.workId, null)).work };
}

/**
 * Owners of the conversation effects for the single Jira comment desk. A Question is posted while it is open and its Work open (an answer
 * accepted locally, a cancellation or a forgotten Work withdraw an unsent one; reconciliation of a possibly sent one continues regardless).
 * Its publication state is mirrored into the Question. A guidance reply is posted while its Work exists.
 */
export const jiraConversationOwners: { question: JiraCommentOwner; reply: JiraCommentOwner } = {
  question: {
    async wanted(tx, effect) {
      const { question, work } = await questionOf(tx, effect);
      return question && question.state === 'open' && work?.result === 'open' ? 'post' : 'withdraw';
    },
    async observed(tx, effect) {
      const { question, work } = await questionOf(tx, effect);
      if (!question) return;
      const publication = question.publication;
      const before = publication.state;
      publication.state = publicationState(effect);
      publication.updatedAt = effect.updatedAt;
      publication.nextStep =
        effect.state === 'withdrawn'
          ? 'The Question was no longer open when its Jira comment was due; it was not sent.'
          : (effect.diagnostic?.nextStep ?? null);
      if (effect.state === 'published' && effect.comment) {
        publication.comment = { commentId: effect.comment.commentId, url: effect.comment.url };
        question.jira!.publishedAt = effect.comment.createdAt ?? null;
        if (before !== 'published')
          work?.history.push({
            at: effect.updatedAt,
            event: 'question-published',
            origin: 'controller-publication',
            questionId: question.questionId,
            detail: effect.comment.url,
          });
      }
    },
  },
  reply: {
    async wanted(tx, effect) {
      if (effect.purpose.kind !== 'reply') return 'wait';
      return (await tx.doc(works, effect.purpose.workId, null)).work ? 'post' : 'withdraw';
    },
  },
};
