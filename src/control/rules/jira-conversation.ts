// Jira ticket 06 (spec §4 table): pure rules of the conversation on a Jira origin Card. What an ordinary Platform comment means for the
// Work of THAT Card, the text of the published Question and of the guidance reply. No operator list (Jira comment permission suffices),
// and the Factory's own account is not refused (it may be shared with a human): only the reserved header marks automatic text.
// No I/O, clock, storage or Jira types.
import { questionLimits } from './questions.js';
import { reservedHeader, type FactoryCommentContent } from './jira-notices.js';

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** First line of every automatic Factory comment (`[Software Factory · <Kind> <ref>]`). */
const reservedPrefix = '[Software Factory ·';
/** Installation-level or other-Work commands: never commands of a Card's Work, and never an answer. Ticket 07 turns `cancel` into a command. */
const unsupported: ReadonlySet<string> = new Set(['cancel', 'pause', 'unpause', 'resume', 'repair', 'forget', 'cleanup', 'grant', 'new', 'reopen', 'help']);

export type JiraGuidanceCode = 'JIRA_COMMAND_INCOMPLETE' | 'JIRA_COMMAND_UNSUPPORTED' | 'JIRA_ANSWER_INVALID' | 'JIRA_NO_OPEN_QUESTION' | 'JIRA_QUESTION_AMBIGUOUS' |
  'JIRA_QUESTION_NOT_OPEN_HERE' | 'JIRA_COMMENT_EDITED';
export type JiraCommand = { kind: 'reserved' } | { kind: 'prose' } | { kind: 'free'; text: string } | { kind: 'answer'; ref: string; text: string } |
  { kind: 'guide'; code: Extract<JiraGuidanceCode, 'JIRA_COMMAND_INCOMPLETE' | 'JIRA_COMMAND_UNSUPPORTED' | 'JIRA_ANSWER_INVALID'> };

const answerText = (text: string): JiraCommand => {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'guide', code: 'JIRA_COMMAND_INCOMPLETE' };
  if (trimmed.length > questionLimits.answer || control.test(trimmed)) return { kind: 'guide', code: 'JIRA_ANSWER_INVALID' };
  return { kind: 'free', text: trimmed };
};
const withRef = (ref: string, text: string): JiraCommand => {
  const parsed = answerText(text);
  return parsed.kind === 'free' ? { kind: 'answer', ref, text: parsed.text } : parsed;
};
const refOf = (digits: string) => `Q-${Number(digits)}`;

/**
 * The comment's projected text. A first line with the reserved header is never an instruction (even with `/factory`). Anything not starting
 * EXACTLY with `/factory` (then whitespace or end) is conversation. Known commands have exact syntax (`/factory q17: <text>`,
 * `/factory answer Q-17 <text>`); a known command with missing parts asks for guidance and never becomes an answer; otherwise the rest
 * is a free answer (multi-line allowed, trimmed).
 */
export function parseJiraCommand(body: string): JiraCommand {
  const text = body.replace(/\r\n?/g, '\n');
  if ((text.split('\n')[0] ?? '').trimStart().startsWith(reservedPrefix)) return { kind: 'reserved' };
  if (!/^\/factory(?=\s|$)/.test(text)) return { kind: 'prose' };
  const rest = text.slice('/factory'.length).trim();
  if (!rest) return { kind: 'guide', code: 'JIRA_COMMAND_INCOMPLETE' };
  const word = (/^\S+/.exec(rest)?.[0] ?? '').toLowerCase();
  if (word === 'answer') {
    const match = /^answer(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(rest);
    const ref = /^q-?(\d{1,9})$/i.exec(match?.[1] ?? '');
    return ref ? withRef(refOf(ref[1]!), match?.[2] ?? '') : { kind: 'guide', code: 'JIRA_COMMAND_INCOMPLETE' };
  }
  const short = /^q-?(\d{1,9}):([\s\S]*)$/i.exec(rest);
  if (short) return withRef(refOf(short[1]!), short[2]!);
  if (/^q-?\d{1,9}(?=\s|$)/i.test(rest)) return { kind: 'guide', code: 'JIRA_COMMAND_INCOMPLETE' };
  if (unsupported.has(word)) return { kind: 'guide', code: 'JIRA_COMMAND_UNSUPPORTED' };
  return answerText(rest);
}

/** A Question of the Work of THIS Card: its short reference and the instant after which a comment may answer it (epoch ms). */
export type CardQuestion = { questionId: string; ref: string; state: 'open' | 'answered'; since: number };
export type JiraCommentDecision = { kind: 'none' } | { kind: 'ignore'; code: 'JIRA_COMMENT_RESTRICTED' | 'JIRA_COMMENT_TIME_INVALID' } |
  { kind: 'accept'; questionId: string; text: string } | { kind: 'guide'; code: JiraGuidanceCode; refs: string[] };

/**
 * What one comment does, given the Questions of the Card's Work. Conversation and reserved text: nothing. A restricted comment is never
 * applied nor quoted to a broader audience (no reply either). An instruction already edited when first observed asks for a new comment.
 * Times are epoch milliseconds observed by Jira (`created`/`updated`).
 * Free text answers only when exactly ONE Question is open (and was asked before the comment); an explicit reference must be one of them.
 */
export function jiraCommentDecision(input: { comment: { text: string; createdAt: number; updatedAt: number; restricted: boolean }; questions: readonly CardQuestion[] }):
  JiraCommentDecision {
  const command = parseJiraCommand(input.comment.text);
  if (command.kind === 'reserved' || command.kind === 'prose') return { kind: 'none' };
  if (input.comment.restricted) return { kind: 'ignore', code: 'JIRA_COMMENT_RESTRICTED' };
  const { createdAt: created, updatedAt: updated } = input.comment;
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return { kind: 'ignore', code: 'JIRA_COMMENT_TIME_INVALID' };
  const open = input.questions.filter(question => question.state === 'open' && created > question.since)
    .sort((a, b) => Number(a.ref.slice(2)) - Number(b.ref.slice(2)) || a.ref.localeCompare(b.ref));
  const refs = open.map(question => question.ref);
  if (updated !== created) return { kind: 'guide', code: 'JIRA_COMMENT_EDITED', refs };
  if (command.kind === 'guide') return { kind: 'guide', code: command.code, refs };
  if (command.kind === 'answer') {
    const target = open.find(question => question.ref === command.ref);
    return target ? { kind: 'accept', questionId: target.questionId, text: command.text } : { kind: 'guide', code: 'JIRA_QUESTION_NOT_OPEN_HERE', refs };
  }
  if (open.length === 1) return { kind: 'accept', questionId: open[0]!.questionId, text: command.text };
  return { kind: 'guide', code: open.length ? 'JIRA_QUESTION_AMBIGUOUS' : 'JIRA_NO_OPEN_QUESTION', refs };
}

/**
 * Stable, collision-free ingress identity of one Jira comment: `(siteId, issueId, commentId)` joined by `-`, every character of a part other
 * than [A-Za-z0-9] escaped as `_` + 4 hex digits (request ids allow only [A-Za-z0-9_-]).
 */
export const jiraRequestId = (ref: { siteId: string; issueId: string; commentId: string }) =>
  `jira-comment-${[ref.siteId, ref.issueId, ref.commentId].map(part => part.replace(/[^A-Za-z0-9]/g, c => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('-')}`;

/** Published Question on the Card: model text as plain paragraphs (ADF text nodes carry no markup or mentions), then every answer syntax. */
export function jiraQuestionComment(input: { ref: string; question: string; context: string }): FactoryCommentContent {
  const header = reservedHeader('Pergunta', input.ref);
  const short = `q${input.ref.slice(2)}`;
  return { header, lines: [header, 'The Software Factory needs an answer to continue the Work of this Card. It no longer occupies a Slot.', 'Question:',
    ...input.question.split('\n'), ...(input.context ? ['Context:', ...input.context.split('\n')] : []),
    'Answer in a NEW comment that starts with one of:',
    '/factory <your answer>   (only while this is the single open question of this Card)',
    `/factory ${short}: <your answer>`, `/factory answer ${input.ref} <your answer>`,
    'Comments without that prefix are conversation and are not read as instructions. An edited comment is ignored: post a new one. ' +
      'The first valid answer is final. Answering does not start an agent directly: the Work returns to its queue position.'] };
}

const guidanceText: Record<JiraGuidanceCode, string> = {
  JIRA_COMMAND_INCOMPLETE: 'the command is incomplete; use `/factory q<n>: <answer>` or `/factory answer Q-<n> <answer>`.',
  JIRA_COMMAND_UNSUPPORTED: 'this command is not available from a Card; only answers to this Card\'s questions are.',
  JIRA_ANSWER_INVALID: 'the answer is too long or carries control characters.',
  JIRA_NO_OPEN_QUESTION: 'this Card has no open question it could answer.',
  JIRA_QUESTION_AMBIGUOUS: 'several questions of this Card are open; name one with `/factory q<n>: <answer>`.',
  JIRA_QUESTION_NOT_OPEN_HERE: 'that reference is not an open question of this Card.',
  JIRA_COMMENT_EDITED: 'the comment was edited before the Factory read it; post the instruction again in a new comment.',
};
/** Guidance reply to a `/factory` comment that did not apply. It names the comment by id and NEVER quotes its text. */
export function jiraGuidanceComment(input: { ref: string; code: JiraGuidanceCode; refs: readonly string[]; commentId: string }): FactoryCommentContent {
  const header = reservedHeader('Orientação', input.ref);
  return { header, lines: [header, `Comment ${input.commentId} was not applied: ${guidanceText[input.code]}`,
    input.refs.length ? `Open questions of this Card: ${input.refs.join(', ')}.` : 'Open questions of this Card: none.',
    'Nothing changed in the Work.'] };
}
