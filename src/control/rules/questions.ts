import { questionMarkerPrefix } from '../../contracts/index.js';

// Pure rules for durable Questions (spec §5.5/§11.3): command parsing, authorization of the author, answer acceptance, destination,
// published text and the explicit recovery instruction. No I/O, clock or randomness: callers supply every fact.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Characters. Bounded so the recovery instruction (question + answer, context when it fits) stays within the Builder prompt budget. */
export const questionLimits = Object.freeze({ question: 2000, context: 4000, answer: 2000 });
const promptBudgetBytes = 15000;

export type FactoryCommand = { kind: 'answer'; questionId: string; text: string } | { kind: 'prose' } | { kind: 'invalid'; code: string };
/**
 * Strict prefix: the comment body must START with `/factory ` (no leading space, quote or prose). Anything else is prose and grants nothing.
 * `/factory answer <question-id> <text>`: the text is the rest of the body (multi-line allowed), trailing whitespace trimmed.
 */
export function parseFactoryCommand(body: string): FactoryCommand {
  const normalized = body.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('/factory ')) return { kind: 'prose' };
  const match = /^\/factory answer(?:[ \t]+(\S+))?(?:[ \t]+([\s\S]*))?$/.exec(normalized.trimEnd());
  if (!match) return { kind: 'invalid', code: 'COMMAND_NOT_SUPPORTED' };
  if (!match[1] || !uuid.test(match[1])) return { kind: 'invalid', code: 'QUESTION_ID_INVALID' };
  const text = (match[2] ?? '').trim();
  if (!text) return { kind: 'invalid', code: 'ANSWER_TEXT_MISSING' };
  if (text.length > questionLimits.answer) return { kind: 'invalid', code: 'ANSWER_TOO_LONG' };
  return { kind: 'answer', questionId: match[1], text };
}

export type CommentAuthor = { id: number; login: string; type: string };
/** Configured GitHub operators by login (case-insensitive), human accounts only. Bots, apps and third parties never authorize. */
export function authorizeCommentAuthor(author: CommentAuthor, operators: readonly string[]): { authorized: true } | { authorized: false; code: 'AUTHOR_IS_BOT' | 'AUTHOR_NOT_OPERATOR' } {
  if (author.type === 'Bot' || /\[bot\]$/i.test(author.login)) return { authorized: false, code: 'AUTHOR_IS_BOT' };
  if (author.type !== 'User' || !operators.some(login => login.toLowerCase() === author.login.toLowerCase())) return { authorized: false, code: 'AUTHOR_NOT_OPERATOR' };
  return { authorized: true };
}

export type AnswerContext = { kind: 'local-cli' } | { kind: 'github-comment'; workId: string };
/**
 * One accepted answer per Question: the first authorized, correlated answer that reaches a durable commit. A comment only answers a
 * Question of the Work whose Ticket/PR hosts it. Closed results (cancelled/delivered/closed unmerged) are never reactivated.
 */
export function answerDecision(input: { question: { questionId: string; workId: string; state: 'open' | 'answered' } | null;
  work: { work_id: string; result: string; current: boolean } | null; context: AnswerContext }): { kind: 'accept' } | { kind: 'refuse'; code: string } {
  if (!input.question || !input.work || input.work.work_id !== input.question.workId) return { kind: 'refuse', code: 'QUESTION_NOT_FOUND' };
  if (input.context.kind === 'github-comment' && input.context.workId !== input.question.workId) return { kind: 'refuse', code: 'QUESTION_NOT_IN_CONTEXT' };
  if (input.work.result !== 'open') return { kind: 'refuse', code: 'WORK_NOT_OPEN' };
  if (!input.work.current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (input.question.state !== 'open') return { kind: 'refuse', code: 'QUESTION_ALREADY_ANSWERED' };
  return { kind: 'accept' };
}

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Shape of an ask_user request before any commit; the worker assigned the identity and preserved the request first. */
export function validateQuestionRequest(input: { questionId: unknown; question: unknown; context: unknown }): { valid: true } | { valid: false; code: string } {
  if (typeof input.questionId !== 'string' || !uuid.test(input.questionId)) return { valid: false, code: 'QUESTION_ID_INVALID' };
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > questionLimits.question || control.test(input.question)) return { valid: false, code: 'QUESTION_TEXT_INVALID' };
  if (typeof input.context !== 'string' || input.context.length > questionLimits.context || control.test(input.context)) return { valid: false, code: 'QUESTION_CONTEXT_INVALID' };
  if (`${input.question}\n${input.context}`.includes(questionMarkerPrefix)) return { valid: false, code: 'QUESTION_MARKER_FORBIDDEN' };
  return { valid: true };
}

export type QuestionDestination<T> = { kind: 'issue'; ticket: T } | { kind: 'pull-request'; pullRequest: { number: number; url: string } };
/** Own pull request when the Work has one (questions then belong to that surface); otherwise the Ticket issue. */
export function questionDestination<T>(work: { ticket: T; pullRequest: { number: number; url: string } | null }): QuestionDestination<T> {
  return work.pullRequest ? { kind: 'pull-request', pullRequest: work.pullRequest } : { kind: 'issue', ticket: work.ticket };
}

const fenced = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
};
/** Visible body of a published Question. Model text is fenced (no mentions, markup or line that could look like a command). */
export function questionCommentBody(input: { questionId: string; workId: string; executionId: string; question: string; context: string }): string {
  return [`**Software Factory question** \`${input.questionId}\``, '',
    `Work \`${input.workId}\` (Execution \`${input.executionId}\`) is waiting for an answer from a configured operator. It no longer occupies a Slot.`, '',
    'Question:', '', fenced(input.question), '',
    ...(input.context ? ['Context:', '', fenced(input.context), ''] : []),
    'Reply in a new comment that starts exactly with:', '', '```', `/factory answer ${input.questionId} <your answer>`, '```', '',
    'Only configured operators can answer. Prose, bots and other accounts are ignored. The first valid answer recorded by the Factory is final; ' +
      'a correction needs a new question. Answering does not start an agent directly: the Work returns to its queue position.'].join('\n');
}

/** Explicit replacement instruction for the activation after an answer (new boot, new session): Work, artifacts, question and answer. */
export function recoveryPrompt(input: { ticketUrl: string; repository: string; base: string; baseCommit: string; branch: string; checkout: string;
  /** Guest directory of the Builder pack of this Execution (e.g. /artifacts/factory/skill-pack/factory-skills-v2). */
  skillDirectory: string;
  workId: string; executionId: string; previousExecutionId: string; question: { questionId: string; question: string; context: string };
  answer: { text: string; author: string; origin: string } }): string {
  const build = (withContext: boolean) => [`Factory recovery instruction for Ticket ${input.ticketUrl}.`,
    `Execution context (from the Factory, authoritative): repository=${input.repository} base=${input.base} base-commit=${input.baseCommit} branch=${input.branch} ` +
      `checkout=${input.checkout} artifacts=/artifacts work=${input.workId} execution=${input.executionId} previous-execution=${input.previousExecutionId}`,
    'This is a NEW session on the same Work: the previous Execution ended after asking the question below. Its workspace, branch, commits and ' +
      '/artifacts were preserved; its session is not continued.',
    `Read ${input.skillDirectory}/skills/implement/SKILL.md with the read tool and follow section 4 (resume after an answer).`,
    '', `Question ${input.question.questionId}:`, fenced(input.question.question),
    ...(input.question.context ? withContext ? ['Context you gave:', fenced(input.question.context)]
      : ['(The context you gave is omitted here for size; it is preserved with the question in the Factory.)'] : []),
    '', `Accepted answer (by ${input.answer.author}, via ${input.answer.origin}):`, fenced(input.answer.text)].join('\n');
  const full = build(true);
  return new TextEncoder().encode(full).length <= promptBudgetBytes ? full : build(false);
}
