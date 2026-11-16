import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily } from '@earendil-works/pi-durable';
import type { WorkerQuestion } from '../../workers/index.js';
import type { ControlReceipt, QuestionView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { answerDecision, questionDestination, validateQuestionRequest } from '../rules/questions.js';
import { linkRequest, requests, ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

/** Durable Question records (spec §3.2), one document per worker-assigned identity. */
export const questions = defineDocFamily<{ question: QuestionView | null }, null>({ kind: 'factory.question', version: 1, scope: 'session', family: true,
  initial: () => ({ question: null }), checkpointWhen: () => true });

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** Canonical content hash of an ask_user request (worker and Control compute the same value). */
export const questionSha256 = (question: string, context: string) => sha256(JSON.stringify({ question, context }));
const keep = <T>(items: T[]) => items.slice(-50);
const pendingStep = (questionId: string) => `Answer with a comment \`/factory answer ${questionId} <text>\` by a configured operator on the Ticket, or locally with ` +
  `\`factory answer ${questionId} <text>\`. The Work then returns to its queue position; nothing starts directly.`;

export type RegisterOutcome = { kind: 'recorded' | 'known' } | { kind: 'refused'; code: string };
/** Whether a worker request is intact: valid shape, matching hash and a preserved-evidence reference of the same Work. */
export function intactRequest(request: WorkerQuestion, workId: string): boolean {
  return validateQuestionRequest(request).valid && questionSha256(request.question, request.context) === request.sha256 &&
    request.reference?.workId === workId && typeof request.reference.id === 'string';
}

/**
 * "Registrar pergunta" (spec §3.4): in ONE commit, the Question (content, destination), its Work impediment and the publication intent,
 * for the CURRENT started Execution of an open, current Work. Same identity + same content returns `known` (lost ACK); same identity with
 * other content is a conflict and never replaces the record. Cessation and Slot release come later, separately.
 */
export async function registerQuestion(session: Session, input: { work_id: string; executionId: string; invocationId: string; request: WorkerQuestion;
  from: QuestionView['recordedFrom'] }): Promise<RegisterOutcome> {
  if (!intactRequest(input.request, input.work_id)) return { kind: 'refused', code: 'QUESTION_REQUEST_INVALID' };
  const { request } = input;
  return session.commit(async tx => {
    const document = await tx.doc(questions, request.questionId, null);
    if (document.question) {
      const known = document.question;
      return known.workId === input.work_id && known.executionId === input.executionId && known.content.sha256 === request.sha256
        ? { kind: 'known' as const } : { kind: 'refused' as const, code: 'QUESTION_ID_CONFLICT' };
    }
    const index = await tx.doc(ticketIndex);
    const workDocument = await tx.doc(works, input.work_id, null);
    const work = workDocument.work;
    const execution = work?.execution ?? null;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== input.work_id) return { kind: 'refused' as const, code: 'WORK_NOT_CURRENT' };
    if (!execution || execution.executionId !== input.executionId || execution.invocationId !== input.invocationId || execution.state !== 'started') {
      return { kind: 'refused' as const, code: 'STALE_EXECUTION' };
    }
    const now = new Date().toISOString();
    const destination = questionDestination({ ticket: work.ticket, pullRequest: work.pullRequest });
    // Own pull requests do not exist before publication (ticket 14); the PR surface is not reachable in this Factory version.
    if (destination.kind !== 'issue') return { kind: 'refused' as const, code: 'QUESTION_DESTINATION_NOT_ENABLED' };
    document.question = { questionId: request.questionId, workId: input.work_id, executionId: input.executionId, invocationId: input.invocationId, recordedAt: now,
      recordedFrom: input.from, content: { question: request.question, context: request.context, sha256: request.sha256, reference: { ...request.reference } },
      destination, state: 'open',
      publication: { effectId: randomUUID(), state: 'intended', updatedAt: now, attempts: [], comment: null, nextStep: null }, answer: null, ignored: [] };
    work.impediments.push({ code: 'QUESTION_PENDING', scope: 'work', since: now, questionId: request.questionId, nextStep: pendingStep(request.questionId) });
    work.questions = [...(work.questions ?? []), request.questionId];
    work.history.push({ at: now, event: 'question-recorded', origin: 'controller-dispatch', questionId: request.questionId, detail: input.executionId });
    return { kind: 'recorded' as const };
  }, BACKGROUND_CONTEXT);
}

/**
 * The worker ended with a question that has no record: its content was not intact (`QUESTION_CONTENT_LOST`) or it could not be recorded
 * (`QUESTION_NOT_RECORDED`, e.g. the Work stopped being current). Block explicitly; never invent or publish a question.
 */
export async function recordContentLost(session: Session, work_id: string, executionId: string, questionId: string,
  code: 'QUESTION_CONTENT_LOST' | 'QUESTION_NOT_RECORDED' | 'QUESTION_ID_CONFLICT' | 'QUESTION_RECORDED_EXECUTION_UNCERTAIN' = 'QUESTION_CONTENT_LOST', reason = 'its complete request was not received intact',
  boundQuestionId?: string) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work || work.execution?.executionId !== executionId) return 'stale' as const;
    if (!work.impediments.some(item => item.code === code)) work.impediments.push({ code, scope: 'work', since: new Date().toISOString(), ...(boundQuestionId ? { questionId: boundQuestionId } : {}),
      nextStep: `Execution ${executionId} reported question ${/^[0-9a-f-]{36}$/.test(questionId) ? questionId : '(invalid id)'} but ${reason}; ` +
        'nothing was published or invented. Inspect the worker\'s preserved Records evidence and decide explicitly (recovery, ticket 26).' });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

export type AnswerOrigin = { kind: 'local-cli' } |
  { kind: 'github-comment'; workId: string; comment: { commentId: number; url: string; author: { id: number; login: string; type: string } } };
type Ingress = { request_id: string; operation: 'answer'; question_id: string; text: string; origin: 'local-cli' | 'github-comment'; commentId?: number };
const ingressOf = (input: { request_id: string; question_id: string; text: string; origin: AnswerOrigin }): Ingress => ({ request_id: input.request_id, operation: 'answer',
  question_id: input.question_id, text: input.text, origin: input.origin.kind, ...(input.origin.kind === 'github-comment' ? { commentId: input.origin.comment.commentId } : {}) });

/**
 * "Aceitar resposta/comando" (spec §3.4): deduplication by ingress identity, correlation, the single answer, the removal of ONLY this
 * Question's impediment and the history entry share one commit. No queue reordering, no spawn: the Work keeps its category/position and
 * waits for the normal dispatch revalidation. `refusal` carries an authorization failure decided before (bot/third party).
 */
export async function acceptAnswer(session: Session, input: { request_id: string; question_id: string; text: string; origin: AnswerOrigin; refusal?: string }):
  Promise<Extract<ControlReceipt, { operation: 'answer' }> | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  const ingress = ingressOf(input);
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(ingress)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return JSON.parse(JSON.stringify(request.receipt)) as Extract<ControlReceipt, { operation: 'answer' }>;
    }
    const document = await tx.doc(questions, input.question_id, null);
    const question = document.question;
    const workDocument = question ? await tx.doc(works, question.workId, null) : null;
    const work = workDocument?.work ?? null;
    const index = await tx.doc(ticketIndex);
    const decision = input.refusal ? { kind: 'refuse' as const, code: input.refusal } : answerDecision({ question, context: input.origin.kind === 'local-cli' ? { kind: 'local-cli' }
      : { kind: 'github-comment', workId: input.origin.workId }, work: work ? { work_id: work.work_id, result: work.result, current: index.tickets[ticketKey(work.ticket)]?.current === work.work_id } : null });
    const now = new Date().toISOString();
    const originLabel = input.origin.kind === 'github-comment' ? `github-comment:${input.origin.comment.commentId}` : `local-cli:${input.request_id}`;
    let receipt: Extract<ControlReceipt, { operation: 'answer' }>;
    if (decision.kind === 'refuse') {
      if (question) question.ignored = keep([...question.ignored, { at: now, origin: originLabel, code: decision.code }]);
      receipt = { kind: 'durable', request_id: input.request_id, operation: 'answer', question_id: input.question_id, outcome: 'not-applied', reason: decision.code, work_id: question?.workId ?? null };
    } else {
      question!.state = 'answered';
      question!.answer = { text: input.text, sha256: sha256(input.text), acceptedAt: now,
        author: input.origin.kind === 'github-comment' ? { kind: 'github', id: input.origin.comment.author.id, login: input.origin.comment.author.login } : { kind: 'local-administrator' },
        origin: input.origin.kind === 'github-comment' ? { kind: 'github-comment', commentId: input.origin.comment.commentId, url: input.origin.comment.url } : { kind: 'local-cli', request_id: input.request_id } };
      // Only THIS Question's impediment; authorization, dependencies, other Questions and limits are untouched.
      work!.impediments = work!.impediments.filter(item => !(item.code === 'QUESTION_PENDING' && item.questionId === input.question_id));
      work!.history.push({ at: now, event: 'question-answered', origin: input.origin.kind === 'github-comment' ? 'github-comment' : 'local-cli', questionId: input.question_id, detail: originLabel });
      receipt = { kind: 'durable', request_id: input.request_id, operation: 'answer', question_id: input.question_id, outcome: 'accepted', reason: null, work_id: work!.work_id };
    }
    request.input = ingress as never;
    request.receipt = receipt;
    // Ticket 31: the answer text is linked to the Question's Work whatever the outcome (forget erases it).
    if (question) await linkRequest(tx, question.workId, input.request_id);
    return JSON.parse(JSON.stringify(receipt)) as typeof receipt;
  }, BACKGROUND_CONTEXT);
}

type PublicationUpdate = { kind: 'begin' } | { kind: 'result'; outcome: 'published'; comment: { commentId: number; url: string }; revocation?: string } |
  { kind: 'result'; outcome: 'failed' | 'unknown'; code: string; nextStep: string; revocation?: string } |
  { kind: 'discovery'; outcome: 'discovered'; comment: { commentId: number; url: string } } | { kind: 'discovery'; outcome: 'absent' | 'discovery-incomplete' | 'multiple'; code?: string };
/** Publication effect transitions (intent -> attempt -> observation; discovery after uncertainty). Returns the new state or `stale`. */
export async function recordPublication(session: Session, questionId: string, update: PublicationUpdate): Promise<QuestionView['publication']['state'] | 'stale'> {
  return session.commit(async tx => {
    const document = await tx.doc(questions, questionId, null);
    const question = document.question;
    if (!question) return 'stale' as const;
    const publication = question.publication;
    const now = new Date().toISOString();
    const attempt = (outcome: QuestionView['publication']['attempts'][number]['outcome'], code?: string) => {
      const revocation = update.kind === 'result' && update.revocation ? { revocation: update.revocation } : {};
      publication.attempts = keep([...publication.attempts, { at: now, outcome, ...(code ? { code } : {}), ...revocation }]);
      publication.updatedAt = now;
    };
    const published = async (comment: { commentId: number; url: string }) => {
      publication.state = 'published'; publication.comment = comment; publication.nextStep = null;
      const work = (await tx.doc(works, question.workId, null)).work;
      work?.history.push({ at: now, event: 'question-published', origin: 'controller-publication', questionId, detail: comment.url });
      // Comments up to the Question's own comment can never answer it: start reading after it.
      if (work && (work.inputs?.cursor ?? 0) < comment.commentId) work.inputs = { cursor: comment.commentId };
    };
    if (update.kind === 'begin') {
      if (publication.state !== 'intended' && publication.state !== 'failed') return 'stale' as const;
      publication.state = 'attempting'; attempt('attempting');
    } else if (update.kind === 'result') {
      if (publication.state !== 'attempting') return 'stale' as const;
      attempt(update.outcome, update.outcome === 'published' ? undefined : update.code);
      if (update.outcome === 'published') await published(update.comment);
      else { publication.state = update.outcome === 'failed' ? 'failed' : 'ambiguous'; publication.nextStep = update.nextStep; }
    } else {
      if (publication.state !== 'attempting' && publication.state !== 'ambiguous') return 'stale' as const;
      attempt(update.outcome, update.outcome === 'discovered' ? undefined : update.code);
      if (update.outcome === 'discovered') await published(update.comment);
      else if (update.outcome === 'absent') { publication.state = 'intended'; publication.nextStep = null; }
      else if (update.outcome === 'multiple') {
        publication.state = 'conflict';
        publication.nextStep = 'Several comments carry this Question marker; none is chosen. Operator must inspect the Ticket (keep one, decide explicitly).';
      } else publication.state = publication.state === 'attempting' ? 'ambiguous' : publication.state;
    }
    return publication.state;
  }, BACKGROUND_CONTEXT);
}

/** Bounded summary of a comment that did not apply (unauthorized author, edited/older comment); deduplicated by origin, no request document. */
export async function recordIgnored(session: Session, questionId: string, origin: string, code: string) {
  return session.commit(async tx => {
    const document = await tx.doc(questions, questionId, null);
    const question = document.question;
    if (!question || question.ignored.some(item => item.origin === origin)) return;
    question.ignored = keep([...question.ignored, { at: new Date().toISOString(), origin, code }]);
  }, BACKGROUND_CONTEXT);
}

/** Last processed comment id of the Work's Ticket (only advanced after a complete listing was processed). */
export async function recordInputsCursor(session: Session, work_id: string, cursor: number | null) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    if (!document.work) return;
    if (cursor !== null && (document.work.inputs?.cursor ?? null) !== null && cursor <= document.work.inputs!.cursor!) return;
    document.work.inputs = { cursor };
  }, BACKGROUND_CONTEXT);
}

export async function readQuestion(session: Session, questionId: string): Promise<QuestionView | null> {
  return (await session.snapshot(questions, questionId, BACKGROUND_CONTEXT))?.question ?? null;
}
export async function readQuestions(session: Session, work: Pick<WorkRecord, 'questions'>): Promise<QuestionView[]> {
  const result: QuestionView[] = [];
  for (const id of work.questions ?? []) {
    const question = await readQuestion(session, id);
    if (!question) throw new Error('QUESTION_INDEX_INCONSISTENT');
    result.push(question);
  }
  return result;
}
