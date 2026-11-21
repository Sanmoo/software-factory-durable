import { questionMarkerPrefix } from '../../contracts/index.js';
import { fenced, scopeSection, type ScopeText } from './continuation.js';

// Pure rules for durable Questions (spec §5.5/§11.3): command parsing, authorization of the author, answer acceptance, destination,
// published text and the explicit recovery instruction. No I/O, clock or randomness: callers supply every fact.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Characters. Bounded so the recovery instruction (question + answer, context when it fits) stays within the Builder prompt budget. */
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const questionLimits = Object.freeze({ question: 2000, context: 4000, answer: 2000 });
const promptBudgetBytes = 15000;

export type FactoryCommand =
  { kind: 'answer'; questionId: string; text: string } | { kind: 'repair'; reason: string } | { kind: 'prose' } | { kind: 'invalid'; code: string };
/**
 * Strict prefix: the comment body must START with `/factory ` (no leading space, quote or prose). Anything else is prose and grants nothing.
 * `/factory answer <question-id> <text>`: the text is the rest of the body (multi-line allowed), trailing whitespace trimmed.
 * Ticket 23: `/factory repair <reason>`: the reason is the rest of the body (its concreteness is decided by the repair commit).
 */
export function parseFactoryCommand(body: string): FactoryCommand {
  const normalized = body.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('/factory ')) return { kind: 'prose' };
  const repair = /^\/factory repair(?:[ \t\n]+([\s\S]*))?$/.exec(normalized.trimEnd());
  if (repair) {
    const reason = (repair[1] ?? '').trim();
    if (!reason) return { kind: 'invalid', code: 'REPAIR_REASON_MISSING' };
    if (reason.length > questionLimits.answer || control.test(reason)) return { kind: 'invalid', code: 'REPAIR_REASON_INVALID' };
    return { kind: 'repair', reason };
  }
  const match = /^\/factory answer(?:[ \t]+(\S+))?(?:[ \t]+([\s\S]*))?$/.exec(normalized.trimEnd());
  if (!match) return { kind: 'invalid', code: 'COMMAND_NOT_SUPPORTED' };
  if (!match[1] || !uuid.test(match[1])) return { kind: 'invalid', code: 'QUESTION_ID_INVALID' };
  const text = (match[2] ?? '').trim();
  if (!text) return { kind: 'invalid', code: 'ANSWER_TEXT_MISSING' };
  if (text.length > questionLimits.answer) return { kind: 'invalid', code: 'ANSWER_TOO_LONG' };
  // Same rule as the local CLI: no control characters except tab/newline.
  if (control.test(text)) return { kind: 'invalid', code: 'ANSWER_TEXT_INVALID' };
  return { kind: 'answer', questionId: match[1], text };
}

export type CommentAuthor = { id: number; login: string; type: string };
/** A configured operator: login, and optionally the pinned immutable GitHub user id (then ONLY the id matches). */
export type OperatorRef = string | { login: string; id?: number };
/**
 * Configured GitHub operators, human accounts only. An operator with a pinned id matches by id alone (renames are fine, a reused login is
 * not); a login-only operator matches by login (case-insensitive). Bots, App-performed comments and third parties never authorize.
 */
export function authorizeCommentAuthor(
  author: CommentAuthor,
  operators: readonly OperatorRef[],
  viaApp: number | null = null,
): { authorized: true } | { authorized: false; code: 'AUTHOR_IS_BOT' | 'AUTHOR_NOT_OPERATOR' | 'AUTHOR_VIA_APP' } {
  if (author.type === 'Bot' || /\[bot\]$/i.test(author.login)) return { authorized: false, code: 'AUTHOR_IS_BOT' };
  if (viaApp !== null) return { authorized: false, code: 'AUTHOR_VIA_APP' };
  const matches = (operator: OperatorRef) =>
    typeof operator === 'string'
      ? operator.toLowerCase() === author.login.toLowerCase()
      : operator.id !== undefined
        ? operator.id === author.id
        : operator.login.toLowerCase() === author.login.toLowerCase();
  if (author.type !== 'User' || !operators.some(matches)) return { authorized: false, code: 'AUTHOR_NOT_OPERATOR' };
  return { authorized: true };
}

/**
 * An answer comment must be unedited (its text is what the operator wrote once) and written after the Question was recorded and after its
 * published comment. Times are epoch milliseconds supplied by the caller (GitHub createdAt/updatedAt, local recordedAt).
 */
export function commentEligibility(
  comment: { commentId: number; createdAt: number; updatedAt: number },
  question: { recordedAt: number; publishedCommentId: number | null },
): { eligible: true } | { eligible: false; code: 'COMMENT_EDITED' | 'COMMENT_PREDATES_QUESTION' | 'COMMENT_TIME_INVALID' } {
  if (!Number.isFinite(comment.createdAt) || !Number.isFinite(comment.updatedAt) || !Number.isFinite(question.recordedAt))
    return { eligible: false, code: 'COMMENT_TIME_INVALID' };
  if (comment.updatedAt !== comment.createdAt) return { eligible: false, code: 'COMMENT_EDITED' };
  if (comment.createdAt < question.recordedAt || (question.publishedCommentId !== null && comment.commentId <= question.publishedCommentId)) {
    return { eligible: false, code: 'COMMENT_PREDATES_QUESTION' };
  }
  return { eligible: true };
}

export type AnswerContext = { kind: 'local-cli' } | { kind: 'github-comment'; workId: string };
/**
 * One accepted answer per Question: the first authorized, correlated answer that reaches a durable commit. A comment only answers a
 * Question of the Work whose Ticket/PR hosts it. Closed results (cancelled/delivered/closed unmerged) are never reactivated.
 */
export function answerDecision(input: {
  question: { questionId: string; workId: string; state: 'open' | 'answered' } | null;
  work: { work_id: string; result: string; current: boolean } | null;
  context: AnswerContext;
}): { kind: 'accept' } | { kind: 'refuse'; code: string } {
  if (!input.question || !input.work || input.work.work_id !== input.question.workId) return { kind: 'refuse', code: 'QUESTION_NOT_FOUND' };
  if (input.context.kind === 'github-comment' && input.context.workId !== input.question.workId) return { kind: 'refuse', code: 'QUESTION_NOT_IN_CONTEXT' };
  if (input.work.result !== 'open') return { kind: 'refuse', code: 'WORK_NOT_OPEN' };
  if (!input.work.current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (input.question.state !== 'open') return { kind: 'refuse', code: 'QUESTION_ALREADY_ANSWERED' };
  return { kind: 'accept' };
}

/** Shape of an ask_user request before any commit; the worker assigned the identity and preserved the request first. */
export function validateQuestionRequest(input: { questionId: unknown; question: unknown; context: unknown }): { valid: true } | { valid: false; code: string } {
  if (typeof input.questionId !== 'string' || !uuid.test(input.questionId)) return { valid: false, code: 'QUESTION_ID_INVALID' };
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > questionLimits.question || control.test(input.question))
    return { valid: false, code: 'QUESTION_TEXT_INVALID' };
  if (typeof input.context !== 'string' || input.context.length > questionLimits.context || control.test(input.context))
    return { valid: false, code: 'QUESTION_CONTEXT_INVALID' };
  if (`${input.question}\n${input.context}`.includes(questionMarkerPrefix)) return { valid: false, code: 'QUESTION_MARKER_FORBIDDEN' };
  return { valid: true };
}

/** Ticket 27: a publication attempt (`begin` committed right before the POST) may have reached GitHub; only discovery decides it. */
export type QuestionPublicationState = 'intended' | 'attempting' | 'published' | 'ambiguous' | 'unconfirmed' | 'failed' | 'conflict';
export type QuestionDiscovery = { kind: 'incomplete' } | { kind: 'observed'; candidates: number };
/**
 * Ticket 27 (spec §5.5/§9.1, operator decision "an uncertain effect is discovered, never blindly repeated"): the publication state after
 * ONE discovery of the Question marker following a possibly sent POST. Exactly one own comment = published (linked, never reposted);
 * several = conflict (none chosen); an incomplete read concludes nothing; a COMPLETE empty listing is NOT proof of absence after a send
 * (lost transport, lagging listing): `unconfirmed`, discovered again on later cycles and never reposted automatically.
 */
export function questionDiscoveryNext(state: QuestionPublicationState, discovery: QuestionDiscovery): QuestionPublicationState {
  if (state !== 'attempting' && state !== 'ambiguous' && state !== 'unconfirmed') return state;
  if (discovery.kind === 'incomplete') return state === 'attempting' ? 'ambiguous' : state;
  if (discovery.candidates === 1) return 'published';
  if (discovery.candidates > 1) return 'conflict';
  return 'unconfirmed';
}
/** States whose effect may exist on GitHub: discovered (a safe read) before anything else, every pass. */
export const questionNeedsDiscovery = (state: QuestionPublicationState) => state === 'attempting' || state === 'ambiguous' || state === 'unconfirmed';
/**
 * Whether a POST may be sent now: only a Question never sent (`intended`), or one whose every earlier POST was a KNOWN failure (GitHub
 * refused it or it was refused locally: nothing was created), within a bound. Never after an unknown outcome.
 */
export function questionPublishAllowed(state: QuestionPublicationState, knownFailures: number, maxKnownFailures = 5): boolean {
  return state === 'intended' || (state === 'failed' && knownFailures < maxKnownFailures);
}

export type RecoveredQuestion =
  { kind: 'question'; questionId: string; sha256: string; intact: boolean; refused: string | null } | { kind: 'absent' } | { kind: 'uncertain'; code: string };
/** Uncertain codes that are a POSITIVE finding of a preserved ask_user record (partial, several, mismatched, unreadable content). Any other
 * uncertainty (Records unavailable, listing incomplete, facet failure) says nothing about whether a question was asked. */
export const questionRecordFound = (code: string) => /^QUESTION_RECORD_/.test(code);
/**
 * Ticket 27 (spec §5.5): what boot reconciliation does with the `ask_user` request a Builder invocation preserved in Records, when the Control
 * has no Question of that Execution (its notification/ACK was lost). Only a POSITIVE finding changes the ordinary recovery: an intact request
 * is RECORDED with its own identity (or bound when that same Question already exists); one the Control refused live keeps that refusal; a
 * found record that is not intact, conflicting or unreadable BLOCKS (never invented). A transient read failure (`unresolved`) or a complete
 * listing without a request leaves the ordinary path untouched.
 */
export function recoveredQuestionDecision(input: {
  observation: RecoveredQuestion | null;
  workId: string;
  executionId: string;
  existing: { workId: string; executionId: string; sha256: string } | null;
  /** Ticket 25: the Work's result; a request found for a Work that is no longer open (cancelled) is never turned into a new open Question. */
  result?: string;
}):
  | { kind: 'none'; unresolved: string | null }
  | { kind: 'record' }
  | { kind: 'bind' }
  | { kind: 'honor-refusal'; code: string }
  | { kind: 'block'; code: string }
  | { kind: 'skip'; code: string } {
  const seen = input.observation;
  if (!seen || seen.kind === 'absent') return { kind: 'none', unresolved: null };
  if (input.result !== undefined && input.result !== 'open') return { kind: 'skip', code: input.result === 'cancelled' ? 'WORK_CANCELLED' : 'WORK_NOT_OPEN' };
  if (seen.kind === 'uncertain') return questionRecordFound(seen.code) ? { kind: 'block', code: seen.code } : { kind: 'none', unresolved: seen.code };
  if (seen.refused) return { kind: 'honor-refusal', code: seen.refused };
  if (!seen.intact) return { kind: 'block', code: 'QUESTION_RECORD_NOT_INTACT' };
  if (!input.existing) return { kind: 'record' };
  return input.existing.workId === input.workId && input.existing.executionId === input.executionId && input.existing.sha256 === seen.sha256
    ? { kind: 'bind' }
    : { kind: 'block', code: 'QUESTION_ID_CONFLICT' };
}

/**
 * Ticket 27: the end of an interrupted Execution reconciled at boot. A Question recorded live binds the end (`question`). A Question recovered
 * from Records is recorded, but an ADMINISTRATIVE stop keeps its intent (`stopped`, the Question attached): never silently turned into a
 * question wait. A blocking finding is a failure with its code; otherwise stop or the ordinary crash.
 */
export function interruptedEnd(input: { questionId: string | null; recovered: boolean; trigger: string; blocked: string | null; heldCode: string | null }): {
  outcome: 'question' | 'stopped' | 'failure';
  code: string | null;
  questionId: string | null;
} {
  const stop = input.trigger === 'administrative-stop';
  if (input.blocked) return { outcome: 'failure', code: input.blocked, questionId: null };
  if (input.questionId && !(input.recovered && stop)) return { outcome: 'question', code: null, questionId: input.questionId };
  if (stop) return { outcome: 'stopped', code: 'ADMINISTRATIVE_STOP', questionId: input.questionId };
  return { outcome: 'failure', code: input.heldCode ?? 'CONTROLLER_CRASH', questionId: null };
}

export type QuestionDestination<T> = { kind: 'issue'; ticket: T } | { kind: 'pull-request'; pullRequest: { number: number; url: string } };
/** Own pull request when the Work has one (questions then belong to that surface); otherwise the Ticket issue. */
export function questionDestination<T>(work: { ticket: T; pullRequest: { number: number; url: string } | null }): QuestionDestination<T> {
  // Real run q21-human-v5: the PR surface is not enabled in this version, so a Question asked after the own PR is linked goes to the Ticket
  // issue (where its answers are read), like the divergence Questions — never refused (a refused ask_user left a finding untreated).
  void work.pullRequest;
  return { kind: 'issue', ticket: work.ticket };
}

/** Visible body of a published Question. Model text is fenced (no mentions, markup or line that could look like a command). */
export function questionCommentBody(input: { questionId: string; workId: string; executionId: string; question: string; context: string }): string {
  return [
    `**Software Factory question** \`${input.questionId}\``,
    '',
    `Work \`${input.workId}\` (Execution \`${input.executionId}\`) is waiting for an answer from a configured operator. It no longer occupies a Slot.`,
    '',
    'Question:',
    '',
    fenced(input.question),
    '',
    ...(input.context ? ['Context:', '', fenced(input.context), ''] : []),
    'Reply in a new comment that starts exactly with:',
    '',
    '```',
    `/factory answer ${input.questionId} <your answer>`,
    '```',
    '',
    'Only configured operators can answer. Prose, bots and other accounts are ignored. The first valid answer recorded by the Factory is final; ' +
      'a correction needs a new question. Answering does not start an agent directly: the Work returns to its queue position.',
  ].join('\n');
}

/** Recoverable context known by the Factory (spec §6.1): earlier Executions, Questions, Host-observed versions/head and scope updates. */
export type KnownContext = {
  previousExecutions: { executionId: string; outcome: string; at: string | null }[];
  questions: { questionId: string; state: string; comment: string | null }[];
  /** Latest Host-captured handoff of an earlier Execution (ticket 12), when one exists: preserved versions and proposal head. */
  versions: { spec: string | null; instructions: string | null; head: string | null } | null;
  scopeUpdates: readonly ScopeText[];
  /** Ticket 28: the preserved review state of the previous Execution (`preservedReviewContext`, already fenced/bounded), context only. */
  review?: string | null;
};
/** Identifiers the Factory itself produced may be quoted; anything else is omitted rather than rendered as prompt text. */
const versionId = /^v[1-9][0-9]{0,3}$/;
const commitId = /^[0-9a-f]{40}$/;
/**
 * Explicit replacement instruction for a resumed activation whose session is NOT continued (new boot, new session; spec §5.5/§6.1): the
 * reason of the replacement and the recoverable context — Work, preserved request/instructions, Git, artifacts, known effects — plus what
 * authorizes the resumption (the accepted answer and/or concrete scope changes). Never a bare `continue`. Bounded: if even the smallest
 * form exceeds the Builder prompt budget the caller must BLOCK, never truncate a requirement.
 */
export function recoveryPrompt(input: {
  ticketUrl: string;
  repository: string;
  base: string;
  baseCommit: string;
  branch: string;
  checkout: string;
  /** Guest directory of the Builder pack of this Execution (e.g. /artifacts/factory/skill-pack/factory-skills-v2). */
  skillDirectory: string;
  workId: string;
  executionId: string;
  previousExecutionId: string;
  question: { questionId: string; question: string; context: string } | null;
  answer: { text: string; author: string; origin: string } | null;
  /** Why the previous session is replaced (ticket 11); absent = the ticket-10 default (new boot, new session). */
  replacement?: { reason: string };
  known?: KnownContext;
  /** Ticket 13: the recovered Builder keeps the multi-round review handoff (its rounds continue the Work's numbering). */
  reviewRounds?: boolean;
  /** Ticket 22: the repair section (effective impediments of the own PR), never dropped under the size bound. */
  repair?: readonly string[];
  /** Ticket 53: ticket 48's bounded state summary with EVERY answered Question of the Work (never dropped under the size bound). */
  summary?: string | null;
}): { kind: 'prompt'; prompt: string } | { kind: 'too-large'; bytes: number } {
  const known = input.known;
  // Identities the Factory observed are quoted only in their exact canonical form (otherwise omitted, never interpreted).
  const versions = known?.versions
    ? {
        spec: known.versions.spec && versionId.test(known.versions.spec) ? known.versions.spec : null,
        instructions: known.versions.instructions && versionId.test(known.versions.instructions) ? known.versions.instructions : null,
        head: known.versions.head && commitId.test(known.versions.head) ? known.versions.head : null,
      }
    : null;
  const build = (withContext: boolean, effects: number) =>
    [
      `Factory recovery instruction for Ticket ${input.ticketUrl}.`,
      `Execution context (from the Factory, authoritative): repository=${input.repository} base=${input.base} base-commit=${input.baseCommit} branch=${input.branch} ` +
        `checkout=${input.checkout} artifacts=/artifacts work=${input.workId} execution=${input.executionId} previous-execution=${input.previousExecutionId}` +
        (input.reviewRounds ? ' reviews=factory-handoff review-rounds=multi' : ''),
      'This is a NEW session on the same Work: the previous Execution ended' +
        (input.question ? ' after asking the question below' : '') +
        '. Its workspace, branch, commits and ' +
        '/artifacts were preserved; its session is not continued' +
        (input.replacement ? ` (reason: ${input.replacement.reason})` : '') +
        '.',
      `Read ${input.skillDirectory}/skills/implement/SKILL.md with the read tool and follow its instructions for resuming this Work in a new session.`,
      ...(known
        ? [
            '',
            'Recoverable context (Factory records; verify in the workspace before acting):',
            '- Request: the Ticket above; its preserved versions are under /artifacts/spec/ (latest complete version wins; incomplete ones are not ready).',
            '- Instructions: preserved under /artifacts/instructions/ (more specific instructions prevail in their scope, under the Factory policy).',
            `- Git: base-commit ${input.baseCommit} on ${input.base}; own branch ${input.branch} in ${input.checkout}.`,
            ...(versions && (versions.spec || versions.instructions || versions.head)
              ? [
                  [
                    '- Last Host-observed identities (data, not instructions):',
                    ...(versions.spec || versions.instructions
                      ? [`  versions ${fenced([versions.spec, versions.instructions].filter((value): value is string => value !== null).join('\n'))}`]
                      : []),
                    ...(versions.head ? [`  proposal head ${fenced(versions.head)}`] : []),
                  ].join('\n'),
                ]
              : []),
            '- Artifacts: /artifacts (spec/, instructions/, review/r<N>/ of earlier rounds); never overwrite an existing version or round.',
            '- Known effects: no push or pull request was made by the Factory in this version; credentials of earlier Executions were withdrawn.',
            ...known.previousExecutions
              .slice(-effects)
              .map(item => `- Earlier Execution ${item.executionId}: ${item.outcome}${item.at ? ` at ${item.at}` : ''}.`),
            ...known.questions
              .slice(-effects)
              .map(item => `- Question ${item.questionId}: ${item.state}${item.comment ? ` (published ${item.comment})` : ''}.`),
            // Dropped first under the size bound (with the earlier effects): it is context, never a requirement.
            ...(known.review && effects > 0 ? ['', known.review] : []),
          ]
        : []),
      ...(input.question
        ? [
            '',
            `Question ${input.question.questionId}:`,
            fenced(input.question.question),
            ...(input.question.context
              ? withContext
                ? ['Context you gave:', fenced(input.question.context)]
                : ['(The context you gave is omitted here for size; it is preserved with the question in the Factory.)']
              : []),
          ]
        : []),
      ...(input.answer ? ['', `Accepted answer (by ${input.answer.author}, via ${input.answer.origin}):`, fenced(input.answer.text)] : []),
      ...(input.summary ? ['', input.summary] : []),
      ...(known?.scopeUpdates.length
        ? [
            '',
            ...scopeSection(known.scopeUpdates),
            'Before implementing a scope change, preserve a NEW request version that records it (never edit an earlier version).',
          ]
        : []),
      ...(input.repair ?? []),
    ].join('\n');
  for (const effects of [20, 5, 1, 0]) {
    const full = build(true, effects);
    if (new TextEncoder().encode(full).length <= promptBudgetBytes) return { kind: 'prompt', prompt: full };
  }
  for (const effects of [5, 1, 0]) {
    const reduced = build(false, effects);
    if (new TextEncoder().encode(reduced).length <= promptBudgetBytes) return { kind: 'prompt', prompt: reduced };
  }
  return { kind: 'too-large', bytes: new TextEncoder().encode(build(false, 0)).length };
}
