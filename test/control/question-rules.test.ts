import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerDecision, authorizeCommentAuthor, commentEligibility, parseFactoryCommand, questionCommentBody, questionDestination, questionDiscoveryNext, questionNeedsDiscovery,
  interruptedEnd, questionPublishAllowed, recoveredQuestionDecision, recoveryPrompt, validateQuestionRequest, type QuestionPublicationState } from '../../src/control/rules/questions.js';

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
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid} bell\u0007`), { kind: 'invalid', code: 'ANSWER_TEXT_INVALID' }, 'same control-character rule as the CLI');
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid} tab\tok`), { kind: 'answer', questionId: qid, text: 'tab\tok' });
  assert.deepEqual(parseFactoryCommand(`/factory answer ${qid} ${'x'.repeat(2001)}`), { kind: 'invalid', code: 'ANSWER_TOO_LONG' });
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
  // Review 3: an operator pinned by id matches by id only; App-performed comments never authorize.
  const pinned = [{ login: 'Sanmoo', id: 42 }];
  assert.deepEqual(authorizeCommentAuthor({ id: 42, login: 'renamed', type: 'User' }, pinned), { authorized: true });
  assert.deepEqual(authorizeCommentAuthor({ id: 43, login: 'Sanmoo', type: 'User' }, pinned), { authorized: false, code: 'AUTHOR_NOT_OPERATOR' });
  assert.deepEqual(authorizeCommentAuthor({ id: 42, login: 'Sanmoo', type: 'User' }, pinned, 9), { authorized: false, code: 'AUTHOR_VIA_APP' });
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
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'q'.repeat(2001), context: '' }), { valid: false, code: 'QUESTION_TEXT_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'q', context: 'c'.repeat(4001) }), { valid: false, code: 'QUESTION_CONTEXT_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'a\u0000b', context: '' }), { valid: false, code: 'QUESTION_TEXT_INVALID' });
  assert.deepEqual(validateQuestionRequest({ questionId: qid, question: 'see <!-- software-factory:question:x -->', context: '' }), { valid: false, code: 'QUESTION_MARKER_FORBIDDEN' });
});

test('AC2: the destination follows the context (own PR when known, else the Ticket issue)', () => {
  const ticket = { tracker: 'github' as const, repository: 'acme/project', repositoryId: 3, issueId: 7003, nodeId: 'I3', number: 3, url: 'https://github.com/acme/project/issues/3' };
  assert.deepEqual(questionDestination({ ticket, pullRequest: null }), { kind: 'issue', ticket });
  assert.deepEqual(questionDestination({ ticket, pullRequest: { number: 9, url: 'https://github.com/acme/project/pull/9' } }), { kind: 'issue', ticket }, 'ticket 21 v5: the PR surface is not enabled');
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
  const recovered = recoveryPrompt({ ticketUrl: 'https://github.com/acme/project/issues/3', repository: 'acme/project', base: 'main', baseCommit: 'a'.repeat(40), branch: 'factory/3-abc',
    checkout: '/workspace/checkout', workId: 'work-a', executionId: 'exec-2', previousExecutionId: 'exec-1', skillDirectory: '/artifacts/factory/skill-pack/factory-skills-v2',
    question: { questionId: qid, question: 'Which file?', context: 'none named' }, answer: { text: 'docs/a.md', author: 'sanmoo', origin: 'github-comment' } });
  assert.equal(recovered.kind, 'prompt');
  const prompt = recovered.kind === 'prompt' ? recovered.prompt : '';
  assert.match(prompt, /^Factory recovery instruction/);
  for (const part of ['https://github.com/acme/project/issues/3', 'branch=factory/3-abc', 'previous-execution=exec-1', qid, 'Which file?', 'docs/a.md', 'sanmoo',
    '/artifacts/factory/skill-pack/factory-skills-v2/skills/implement/SKILL.md']) assert.ok(prompt.includes(part), part);
  // The pack decides which section defines resumption: the Control never cites a section number (v1-v3 have no such section).
  assert.doesNotMatch(prompt, /section \d/i);
  assert.ok(Buffer.byteLength(prompt) < 16384);
  // Worst case (3-byte characters at every limit) still fits the Builder prompt budget: the context is then omitted, never the answer.
  const big = recoveryPrompt({ ticketUrl: 'u', repository: 'r', base: 'b', baseCommit: 'c', branch: 'br', checkout: '/w', workId: 'w', executionId: 'e', previousExecutionId: 'p', skillDirectory: '/s',
    question: { questionId: qid, question: 'é'.repeat(2000), context: '€'.repeat(4000) }, answer: { text: '€'.repeat(2000), author: 'a', origin: 'local-cli' } });
  assert.equal(big.kind, 'prompt');
  assert.ok(big.kind === 'prompt' && Buffer.byteLength(big.prompt) <= 15000);
  assert.ok(big.kind === 'prompt' && big.prompt.includes('€'.repeat(2000)) && big.prompt.includes('context you gave is omitted'));
  // Beyond the budget even without the context: an explicit too-large outcome (the caller blocks), never a truncated requirement.
  const huge = recoveryPrompt({ ticketUrl: 'u', repository: 'r', base: 'b', baseCommit: 'c', branch: 'br', checkout: '/w', workId: 'w', executionId: 'e', previousExecutionId: 'p', skillDirectory: '/s',
    question: null, answer: { text: '€'.repeat(2000), author: 'a', origin: 'local-cli' },
    known: { previousExecutions: [], questions: [], versions: null, scopeUpdates: [1, 2, 3].map(n => ({ scopeUpdateId: `s${n}`, reason: '€'.repeat(2000) })) } });
  assert.equal(huge.kind, 'too-large');
});

test('review 2: only an unedited comment written after the Question was recorded (and after its published comment) is eligible', () => {
  const question = { recordedAt: 1000, publishedCommentId: 50 };
  assert.deepEqual(commentEligibility({ commentId: 60, createdAt: 2000, updatedAt: 2000 }, question), { eligible: true });
  assert.deepEqual(commentEligibility({ commentId: 60, createdAt: 2000, updatedAt: 2500 }, question), { eligible: false, code: 'COMMENT_EDITED' });
  assert.deepEqual(commentEligibility({ commentId: 60, createdAt: 999, updatedAt: 999 }, question), { eligible: false, code: 'COMMENT_PREDATES_QUESTION' });
  assert.deepEqual(commentEligibility({ commentId: 40, createdAt: 2000, updatedAt: 2000 }, question), { eligible: false, code: 'COMMENT_PREDATES_QUESTION' });
  assert.deepEqual(commentEligibility({ commentId: 40, createdAt: 2000, updatedAt: 2000 }, { recordedAt: 1000, publishedCommentId: null }), { eligible: true });
  assert.deepEqual(commentEligibility({ commentId: 60, createdAt: Number.NaN, updatedAt: 2000 }, question), { eligible: false, code: 'COMMENT_TIME_INVALID' });
});

test('ticket 27 AC3/AC4 (cut battery, rule level): after a possibly sent POST only discovery decides; a complete empty listing is unconfirmed, never a repost', () => {
  const sent: QuestionPublicationState[] = ['attempting', 'ambiguous', 'unconfirmed'];
  for (const state of sent) {
    assert.equal(questionNeedsDiscovery(state), true, state);
    assert.equal(questionPublishAllowed(state, 0), false, `${state}: never a POST before discovery`);
    assert.equal(questionDiscoveryNext(state, { kind: 'observed', candidates: 1 }), 'published', `${state}: one own comment is linked`);
    assert.equal(questionDiscoveryNext(state, { kind: 'observed', candidates: 3 }), 'conflict', `${state}: several are never chosen`);
    assert.equal(questionDiscoveryNext(state, { kind: 'observed', candidates: 0 }), 'unconfirmed', `${state}: an empty listing is not absence after a send`);
    assert.notEqual(questionDiscoveryNext(state, { kind: 'observed', candidates: 0 }), 'intended');
  }
  // Incomplete reads conclude nothing (a crash-left attempt becomes ambiguous; the others stay).
  assert.deepEqual(sent.map(state => questionDiscoveryNext(state, { kind: 'incomplete' })), ['ambiguous', 'ambiguous', 'unconfirmed']);
  // Settled or never-sent states are not discovered and are not changed by a discovery.
  for (const state of ['intended', 'published', 'failed', 'conflict'] as const) {
    assert.equal(questionNeedsDiscovery(state), false, state);
    assert.equal(questionDiscoveryNext(state, { kind: 'observed', candidates: 0 }), state);
  }
  // Cut "before send": the intent (Question commit) without the attempt commit was never sent -> one POST. Known failures (nothing created) are
  // bounded; a conflict or a published comment is never posted again.
  assert.equal(questionPublishAllowed('intended', 0), true);
  assert.deepEqual([questionPublishAllowed('failed', 4), questionPublishAllowed('failed', 5), questionPublishAllowed('conflict', 0), questionPublishAllowed('published', 0)],
    [true, false, false, false]);
});

test('ticket 27 AC5 (rule level): only a POSITIVE finding changes the ordinary path; intact = recorded/bound; live refusal honored; found-but-lost content blocks', () => {
  const base = { workId: 'w1', executionId: 'e1' };
  const intact = { kind: 'question' as const, questionId: qid, sha256: 'a'.repeat(64), intact: true, refused: null };
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: null, existing: null }), { kind: 'none', unresolved: null }, 'facet not composed: as before');
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: { kind: 'absent' }, existing: null }), { kind: 'none', unresolved: null }, 'complete listing without a request');
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: intact, existing: null }), { kind: 'record' });
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: intact, existing: { ...base, sha256: 'a'.repeat(64) } }), { kind: 'bind' }, 'same identity and content: the same record');
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: intact, existing: { ...base, sha256: 'b'.repeat(64) } }), { kind: 'block', code: 'QUESTION_ID_CONFLICT' });
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: intact, existing: { workId: 'w2', executionId: 'e1', sha256: 'a'.repeat(64) } }), { kind: 'block', code: 'QUESTION_ID_CONFLICT' });
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: { ...intact, intact: false }, existing: null }), { kind: 'block', code: 'QUESTION_RECORD_NOT_INTACT' }, 'never invented or repaired');
  assert.deepEqual(recoveredQuestionDecision({ ...base, observation: { ...intact, refused: 'WORK_NOT_CURRENT' }, existing: null }), { kind: 'honor-refusal', code: 'WORK_NOT_CURRENT' },
    'refused live: never re-recorded at boot');
  // A found record (partial, several, mismatched, unreadable) blocks; a transient read failure says nothing: ordinary recovery, noted.
  for (const code of ['QUESTION_RECORD_INCOMPLETE', 'QUESTION_RECORD_MULTIPLE', 'QUESTION_RECORD_MISMATCH', 'QUESTION_RECORD_INVALID']) {
    assert.deepEqual(recoveredQuestionDecision({ ...base, observation: { kind: 'uncertain', code }, existing: null }), { kind: 'block', code }, code);
  }
  for (const code of ['QUESTION_LISTING_INCOMPLETE', 'RECORDS_UNAVAILABLE', 'QUESTION_OBSERVATION_FAILED', 'WORKER_EXECUTION_NOT_ENABLED']) {
    assert.deepEqual(recoveredQuestionDecision({ ...base, observation: { kind: 'uncertain', code }, existing: null }), { kind: 'none', unresolved: code }, code);
  }
});

test('ticket 27 (rule level): the reconciled end keeps an administrative stop even with a recovered Question; a live Question binds; a block is a failure', () => {
  const end = (input: Partial<Parameters<typeof interruptedEnd>[0]>) => interruptedEnd({ questionId: null, recovered: false, trigger: 'boot', blocked: null, heldCode: null, ...input });
  assert.deepEqual(end({ questionId: qid }), { outcome: 'question', code: null, questionId: qid });
  assert.deepEqual(end({ questionId: qid, recovered: true }), { outcome: 'question', code: null, questionId: qid });
  assert.deepEqual(end({ questionId: qid, recovered: true, trigger: 'administrative-stop' }), { outcome: 'stopped', code: 'ADMINISTRATIVE_STOP', questionId: qid },
    'the stop intent stays; the recovered Question is attached, never a silent question wait');
  assert.deepEqual(end({ questionId: qid, trigger: 'administrative-stop' }), { outcome: 'question', code: null, questionId: qid }, 'a Question recorded live before the stop (ticket 26)');
  assert.deepEqual(end({ trigger: 'administrative-stop' }), { outcome: 'stopped', code: 'ADMINISTRATIVE_STOP', questionId: null });
  assert.deepEqual(end({ blocked: 'QUESTION_RECORD_INCOMPLETE', trigger: 'administrative-stop' }), { outcome: 'failure', code: 'QUESTION_RECORD_INCOMPLETE', questionId: null });
  assert.deepEqual(end({ heldCode: 'WORKER_CHANNEL_LOST' }), { outcome: 'failure', code: 'WORKER_CHANNEL_LOST', questionId: null });
  assert.deepEqual(end({}), { outcome: 'failure', code: 'CONTROLLER_CRASH', questionId: null });
});
