import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerDecision, authorizeCommentAuthor, parseFactoryCommand, questionCommentBody, questionDestination, recoveryPrompt, validateQuestionRequest } from '../../src/control/rules/questions.js';

// Rules level (Q11): deterministic functions over canonical inputs; no SQLite, GitHub or clock.
const qid = '0b9c6a52-3d3e-4c8f-9a51-2f7d1e0c4a11';

test('AC4: only a comment whose first characters are the strict /factory prefix is a command; prose never is', () => {
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid} Use docs/factory-smoke.md`), { kind: 'answer', questionId: qid, text: 'Use docs/factory-smoke.md' });
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid} line one\r\nline two\n\n`), { kind: 'answer', questionId: qid, text: 'line one\nline two' });
  for (const prose of [`I think /factory answer ${qid} yes`, ` /factory answer ${qid} yes`, `> /factory answer ${qid} yes`, `/Factory answer ${qid} yes`,
    '/factoryanswer x', 'Looks good to me', '']) assert.deepEqual(parseFactoryCommand(prose), { kind: 'prose' }, prose);
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid}`), { kind: 'invalid', code: 'ANSWER_TEXT_MISSING' });
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid}    `), { kind: 'invalid', code: 'ANSWER_TEXT_MISSING' });
  assert.deepEqual(parseFactoryCommand('/factory answer not-a-question yes'), { kind: 'invalid', code: 'QUESTION_ID_INVALID' });
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid.toUpperCase()} yes`), { kind: 'invalid', code: 'QUESTION_ID_INVALID' });
  assert.deepEqual(parseFactoryCommand('/factory resume'), { kind: 'invalid', code: 'COMMAND_NOT_SUPPORTED' });
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid} ${'x'.repeat(4001)}`), { kind: 'invalid', code: 'ANSWER_TOO_LONG' });
});

test('AC4: only a configured human operator (case-insensitive login, type User) is authorized; bots and third parties never are', () => {
  const operators = ['Sanmoo', 'other-op'];
  assert.deepEqual(authorizeCommentAuthor({ id: 1, login: 'sanmoo', type: 'User' }, operators), { authorized: true });
  assert.deepEqual(authorizeCommentAuthor({ id: 2, login: 'OTHER-OP', type: 'User' }, operators), { authorized: true });
  assert.deepEqual(authorizeCommentAuthor({ id: 3, login: 'sanmoo[bot]', type: 'Bot' }, operators), { authorized: false, code: 'AUTHOR_IS_BOT' });
  assert.deepEqual(authorizeCommentAuthor({ id: 4, login: 'Sanmoo', type: 'Bot' }, operators), { authorized: false, code: 'AUTHOR_IS_BOT' });
  assert.deepEqual(authorizeCommentAuthor({ id: 5, login: 'stranger', type: 'User' }, operators), { authorized: false, code: 'AUTHOR_NOT_OPERATOR' });
  assert.deepEqual(authorizeCommentAuthor({ id: 6, login: 'sanmoo', type: 'Organization' }, operators), { authorized: false, code: 'AUTHOR_NOT_OPERATOR' });
  assert.deepEqual(authorizeCommentAuthor({ id: 7, login: 'sanmoo', type: 'User' }, []), { authorized: false, code: 'AUTHOR_NOT_OPERATOR' });
});

const question = (overrides: Partial<Parameters<typeof answerDecision>[0]['question']> = {}) =>
  ({ questionId: qid, workId: 'work-a', state: 'open' as const, ...overrides });
test('AC5/AC6: the first valid correlated answer is accepted; duplicates, other Works, closed results and unknown questions never apply', () => {
  const work = { work_id: 'work-a', result: 'open' as const, current: true };
  assert.deepEqual(answerDecision({ question: question(), work, context: { kind: 'local-cli' } }), { kind: 'accept' });
  assert.deepEqual(answerDecision({ question: question(), work, context: { kind: 'github-comment', workId: 'work-a' } }), { kind: 'accept' });
  assert.deepEqual(answerDecision({ question: question(), work, context: { kind: 'github-comment', workId: 'work-b' } }), { kind: 'refuse', code: 'QUESTION_NOT_IN_CONTEXT' });
  assert.deepEqual(answerDecision({ question: null, work: null, context: { kind: 'local-cli' } }), { kind: 'refuse', code: 'QUESTION_NOT_FOUND' });
  assert.deepEqual(answerDecision({ question: question({ state: 'answered' }), work, context: { kind: 'local-cli' } }), { kind: 'refuse', code: 'QUESTION_ALREADY_ANSWERED' });
  for (const result of ['cancelled', 'delivered', 'closed-unmerged'] as const) {
    assert.deepEqual(answerDecision({ question: question(), work: { ...work, result }, context: { kind: 'local-cli' } }), { kind: 'refuse', code: 'WORK_NOT_OPEN' }, result);
  }
  assert.deepEqual(answerDecision({ question: question(), work: { ...work, current: false }, context: { kind: 'local-cli' } }), { kind: 'refuse', code: 'WORK_NOT_CURRENT' });
});

test('AC1: an ask_user request is bounded text with a stable UUID identity; anything else is refused before any commit', () => {
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'Which file name?', context: 'Ticket #3 names none.' }), { valid: true });
  assert.deepEqual(validateQuestionRequest({ questionId: 'x', question: 'q', context: '' }), { valid: false, code: 'QUESTION_ID_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: '   ', context: '' }), { valid: false, code: 'QUESTION_TEXT_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'q'.repeat(4001), context: '' }), { valid: false, code: 'QUESTION_TEXT_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'q', context: 'c'.repeat(8001) }), { valid: false, code: 'QUESTION_CONTEXT_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'a\u0000b', context: '' }), { valid: false, code: 'QUESTION_TEXT_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'see <!-- software-factory:question:x -->', context: '' }), { valid: false, code: 'QUESTION_MARKER_FORBIDDEN' });
});

test('AC2: the destination follows the context (own PR when known, else the Ticket issue)', () => {
  const ticket = { tracker: 'github' as const, repository: 'acme/project', repositoryId: 3, issueId: 7003, nodeId: 'I3', number: 3, url: 'https://github.com/acme/project/issues/3' };
  assert.deepEqual(questionDestination({ ticket, pullRequest: null }), { kind: 'issue', ticket });
  assert.deepEqual(questionDestination({ ticket, pullRequest: { number: 9, url: 'https://github.com/acme/project/pull/9' } }), { kind: 'pull-request', pullRequest: { number: 9, url: 'https://github.com/acme/project/pull/9' } });
});

test('AC2: the published comment carries the explicit reply instruction; model text is fenced so it cannot mention, format or fake a command', () => {
  const body = questionCommentBody({ questionId: qid, workId: 'work-a', executionId: 'exec-1', question: 'Ping @someone? ```', context: '/factory answer x yes' });
  assert.match(body, new RegExp(`Reply in a new comment that starts exactly with:\\n\\n\`\`\`\\n/factory answer ${qid} <your answer>\\n\`\`\``));
  assert.match(body, /\n````\nPing @someone\? ```\n````\n/, 'fence longer than any backtick run in the model text');
  assert.match(body, /\n```\n\/factory answer x yes\n```\n/, 'model text is fenced');
  assert.equal(parseFactoryCommand(body).kind, 'prose', 'the published comment itself is never a command');
  assert.ok(body.length < 20000);
});

test('AC6/spec 5.5: the recovery instruction is explicit (Work, artifacts, question and accepted answer), never a bare continue', () => {
  const prompt = recoveryPrompt({ ticketUrl: 'https://github.com/acme/project/issues/3', repository: 'acme/project', base: 'main', baseCommit: 'a'.repeat(40), branch: 'factory/3-abc',
    checkout: '/workspace/checkout', workId: 'work-a', executionId: 'exec-2', previousExecutionId: 'exec-1',
    question: { questionId: qid, question: 'Which file?', context: 'none named' }, answer: { text: 'docs/a.md', author: 'sanmoo', origin: 'github-comment' } });
  assert.match(prompt, /^Factory recovery instruction/);
  for (const part of ['https://github.com/acme/project/issues/3', 'branch=factory/3-abc', 'previous-execution=exec-1', qid, 'Which file?', 'docs/a.md', 'sanmoo',
    '/artifacts/factory/skill-pack/factory-skills-v1/skills/implement/SKILL.md', 'section 4']) assert.ok(prompt.includes(part), part);
  assert.ok(Buffer.byteLength(prompt) < 16384);
});
