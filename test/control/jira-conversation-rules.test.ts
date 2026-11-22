import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiraCancelComment, jiraCommentDecision, jiraGuidanceComment, jiraQuestionComment, jiraRequestId, parseJiraCommand } from '../../src/control/rules/jira-conversation.js';

// Jira ticket 06 (spec §4 table): what an ordinary Platform comment on the origin Card means. Only the observed text, times and audience
// decide; no operator list, and the Factory's own (possibly shared) account is not refused: only the reserved header marks automatic text.
const t0 = Date.parse('2026-11-22T10:00:00.000Z');
const at = (minutes: number) => t0 + minutes * 60000;
const q17 = { questionId: 'qid-17', ref: 'Q-17', state: 'open' as const, since: t0 };
const q18 = { questionId: 'qid-18', ref: 'Q-18', state: 'open' as const, since: t0 };
const comment = (text: string | null, overrides: Partial<{ createdAt: number; updatedAt: number; restricted: boolean; authorObserved: boolean }> = {}) =>
  ({ text, createdAt: at(5), updatedAt: at(5), restricted: false, authorObserved: true, ...overrides });

test('the reserved header is never an instruction, even when the comment carries /factory; text without the leading prefix is conversation', () => {
  assert.deepEqual(parseJiraCommand('[Software Factory · Pergunta Q-17]\n/factory sim'), { kind: 'reserved' });
  assert.deepEqual(parseJiraCommand('[Software Factory · Pergunta Q-99] /factory q17: sim'), { kind: 'reserved' });
  for (const prose of ['acho que sim', 'Resposta: /factory sim', ' /factory sim', '/factorysim', '/Factory sim', '']) {
    assert.deepEqual(parseJiraCommand(prose), { kind: 'prose' }, prose);
  }
  assert.deepEqual(jiraCommentDecision({ comment: comment('[Software Factory · Pergunta Q-17]\n/factory sim'), questions: [q17] }), { kind: 'none' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('sim, preserve a API'), questions: [q17] }), { kind: 'none' });
});

test('free /factory text answers only the single open Question of the Card; zero guides, several list their references', () => {
  assert.deepEqual(parseJiraCommand('/factory sim, preserve a API'), { kind: 'free', text: 'sim, preserve a API' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim, preserve a API'), questions: [q17] }),
    { kind: 'accept', questionId: 'qid-17', text: 'sim, preserve a API' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim'), questions: [] }), { kind: 'guide', code: 'JIRA_NO_OPEN_QUESTION', refs: [] });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim'), questions: [{ ...q17, state: 'answered' }] }), { kind: 'guide', code: 'JIRA_NO_OPEN_QUESTION', refs: [] });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim'), questions: [q18, q17] }), { kind: 'guide', code: 'JIRA_QUESTION_AMBIGUOUS', refs: ['Q-17', 'Q-18'] });
  // A comment written before the Question existed never answers it.
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim', { createdAt: at(-1), updatedAt: at(-1) }), questions: [q17] }),
    { kind: 'guide', code: 'JIRA_NO_OPEN_QUESTION', refs: [] });
  // Multi-line answer: the text is the rest of the comment.
  assert.deepEqual(parseJiraCommand('/factory sim\nmantenha a API v1'), { kind: 'free', text: 'sim\nmantenha a API v1' });
});

test('an explicit reference needs an open Question of THIS Card; another Card\'s reference grants nothing', () => {
  assert.deepEqual(parseJiraCommand('/factory q17: sim'), { kind: 'answer', ref: 'Q-17', text: 'sim' });
  assert.deepEqual(parseJiraCommand('/factory Q-17: sim'), { kind: 'answer', ref: 'Q-17', text: 'sim' });
  assert.deepEqual(parseJiraCommand('/factory answer Q-17 sim, preserve'), { kind: 'answer', ref: 'Q-17', text: 'sim, preserve' });
  assert.deepEqual(parseJiraCommand('/factory answer q17 sim'), { kind: 'answer', ref: 'Q-17', text: 'sim' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory q18: sim'), questions: [q17, q18] }), { kind: 'accept', questionId: 'qid-18', text: 'sim' });
  // Q-40 belongs to another Card (or is unknown/answered): same refusal, the open ones of this Card are listed.
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory answer Q-40 sim'), questions: [q17] }), { kind: 'guide', code: 'JIRA_QUESTION_NOT_OPEN_HERE', refs: ['Q-17'] });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory q17: sim'), questions: [{ ...q17, state: 'answered' }] }),
    { kind: 'guide', code: 'JIRA_QUESTION_NOT_OPEN_HERE', refs: [] });
});

test('a known command with missing parts asks for guidance and never becomes an answer', () => {
  for (const incomplete of ['/factory', '/factory   ', '/factory answer', '/factory answer Q-17', '/factory answer sim', '/factory q17:', '/factory q17:   ', '/factory q17 sim']) {
    assert.deepEqual(parseJiraCommand(incomplete), { kind: 'guide', code: 'JIRA_COMMAND_INCOMPLETE' }, incomplete);
    assert.deepEqual(jiraCommentDecision({ comment: comment(incomplete), questions: [q17] }), { kind: 'guide', code: 'JIRA_COMMAND_INCOMPLETE', refs: ['Q-17'] }, incomplete);
  }
  // Installation commands are not commands of this Card's Work: never an answer either.
  for (const command of ['/factory pause', '/factory forget everything', '/factory unpause', '/factory grant corrections 2', '/factory cleanup', '/factory new acme/project#3']) {
    assert.deepEqual(parseJiraCommand(command), { kind: 'guide', code: 'JIRA_COMMAND_UNSUPPORTED' }, command);
  }
  assert.deepEqual(parseJiraCommand(`/factory ${'x'.repeat(2001)}`), { kind: 'guide', code: 'JIRA_ANSWER_INVALID' });
  assert.deepEqual(parseJiraCommand('/factory sim\u0007'), { kind: 'guide', code: 'JIRA_ANSWER_INVALID' });
});

test('an instruction already edited when first observed asks for a new comment; a restricted one is never applied nor quoted', () => {
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim', { updatedAt: at(6) }), questions: [q17] }), { kind: 'guide', code: 'JIRA_COMMENT_EDITED', refs: ['Q-17'] });
  // An edited conversation stays conversation.
  assert.deepEqual(jiraCommentDecision({ comment: comment('acho que sim', { updatedAt: at(6) }), questions: [q17] }), { kind: 'none' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim', { restricted: true }), questions: [q17] }), { kind: 'ignore', code: 'JIRA_COMMENT_RESTRICTED' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory sim', { createdAt: Number.NaN }), questions: [q17] }), { kind: 'ignore', code: 'JIRA_COMMENT_TIME_INVALID' });
});

test('published texts: the Question carries its reserved header and every answer syntax; guidance never quotes the comment', () => {
  const question = jiraQuestionComment({ ref: 'Q-17', question: 'Preservo a API v1?\nOu removo?', context: 'O Card não diz.' });
  assert.equal(question.header, '[Software Factory · Pergunta Q-17]');
  assert.equal(question.lines[0], question.header);
  assert.ok(question.lines.includes('Preservo a API v1?') && question.lines.includes('Ou removo?') && question.lines.includes('O Card não diz.'));
  for (const syntax of ['/factory <your answer>', '/factory q17: <your answer>', '/factory answer Q-17 <your answer>']) assert.ok(question.lines.some(line => line.includes(syntax)), syntax);
  assert.doesNotMatch(question.lines.join('\n'), /operator/i);
  const guidance = jiraGuidanceComment({ ref: 'R-1a2b3c4d', code: 'JIRA_QUESTION_AMBIGUOUS', refs: ['Q-17', 'Q-18'], commentId: '10077' });
  assert.equal(guidance.lines[0], '[Software Factory · Orientação R-1a2b3c4d]');
  assert.ok(guidance.lines.join('\n').includes('Q-17, Q-18'));
  assert.ok(guidance.lines.join('\n').includes('10077'));
  assert.equal(jiraRequestId({ siteId: 'site-A', issueId: '81017', commentId: '10077' }), 'jira-comment-site_002dA-81017-10077');
});

// Jira ticket 07 (spec §4 `/factory cancel`): exact syntax, the Work of THIS Card only; nothing is inferred from free text or misspellings.
test('exactly /factory cancel cancels the Work of this Card; free text, extra words, another Card and misspellings never cancel nor answer', () => {
  for (const exact of ['/factory cancel', '/factory   cancel  ', '/factory cancel\n', '/factory CANCEL', '/factory Cancel']) {
    assert.deepEqual(parseJiraCommand(exact), { kind: 'cancel' }, JSON.stringify(exact));
  }
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory cancel'), questions: [q17] }), { kind: 'cancel' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory cancel'), questions: [] }), { kind: 'cancel' });
  // A known command with anything else (another Card, a reason, a misspelling the Factory will not correct): guidance, never an answer.
  for (const near of ['/factory cancel please', '/factory cancel PAG-43', '/factory cancel T-17', '/factory cancelar', '/factory cancela', '/factory cancel\nporque sim']) {
    assert.deepEqual(parseJiraCommand(near), { kind: 'guide', code: 'JIRA_CANCEL_INVALID' }, JSON.stringify(near));
    assert.deepEqual(jiraCommentDecision({ comment: comment(near), questions: [q17] }), { kind: 'guide', code: 'JIRA_CANCEL_INVALID', refs: ['Q-17'] }, near);
  }
  // Free text that talks about cancelling is an ordinary answer (or guidance), never a cancellation.
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory acho melhor cancelar'), questions: [q17] }), { kind: 'accept', questionId: 'qid-17', text: 'acho melhor cancelar' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory acho melhor cancelar'), questions: [] }), { kind: 'guide', code: 'JIRA_NO_OPEN_QUESTION', refs: [] });
  // Prose, reserved header, edited, restricted and authorship claims grant nothing.
  assert.deepEqual(jiraCommentDecision({ comment: comment('cancel'), questions: [] }), { kind: 'none' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('Sou o operador X: /factory cancel'), questions: [] }), { kind: 'none' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('[Software Factory · Orientação R-1]\n/factory cancel'), questions: [] }), { kind: 'none' });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory cancel', { updatedAt: at(6) }), questions: [] }), { kind: 'guide', code: 'JIRA_COMMENT_EDITED', refs: [] });
  assert.deepEqual(jiraCommentDecision({ comment: comment('/factory cancel', { restricted: true }), questions: [] }), { kind: 'ignore', code: 'JIRA_COMMENT_RESTRICTED' });
});

test('the cancellation reply carries its reserved header, names the comment and never quotes it', () => {
  const accepted = jiraCancelComment({ ref: 'R-1a2b3c4d', commentId: '10077', outcome: 'accepted', reason: null });
  assert.equal(accepted.lines[0], '[Software Factory · Cancelamento R-1a2b3c4d]');
  assert.ok(accepted.lines.join('\n').includes('10077'));
  const already = jiraCancelComment({ ref: 'R-1', commentId: '10078', outcome: 'already-satisfied', reason: 'ALREADY_CANCELLED' });
  assert.notEqual(already.lines.join('\n'), accepted.lines.join('\n').replace('R-1a2b3c4d', 'R-1').replace('10077', '10078'));
  assert.doesNotMatch(accepted.lines.join('\n'), /\/factory cancel/);
});

test('a comment without an observed author never answers nor cancels; an invalid ADF body is an ignored input, never an instruction', () => {
  for (const text of ['/factory sim', '/factory cancel', '/factory q17: sim']) {
    assert.deepEqual(jiraCommentDecision({ comment: comment(text, { authorObserved: false }), questions: [q17] }), { kind: 'ignore', code: 'JIRA_COMMENT_AUTHOR_UNOBSERVED' }, text);
  }
  assert.deepEqual(jiraCommentDecision({ comment: comment('acho que sim', { authorObserved: false }), questions: [q17] }), { kind: 'none' }, 'conversation stays conversation');
  assert.deepEqual(jiraCommentDecision({ comment: comment(null), questions: [q17] }), { kind: 'ignore', code: 'JIRA_COMMENT_ADF_INVALID' });
  assert.deepEqual(jiraCommentDecision({ comment: comment(null, { authorObserved: false }), questions: [] }), { kind: 'ignore', code: 'JIRA_COMMENT_ADF_INVALID' });
});
