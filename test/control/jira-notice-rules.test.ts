import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentReconciliation, deliveryComment, impedimentComment, impedimentNotice } from '../../src/control/rules/jira-notices.js';
import type { JiraEvaluation } from '../../src/control/rules/jira-admission.js';

// Jira ticket 05 (spec §3 step 4, §4 last paragraph): when a refused Card is told why, and how an uncertain comment POST is reconciled.
const none: JiraEvaluation = { decision: 'blocked', reasons: [{ code: 'JIRA_ROUTE_NONE', nextStep: 'No component routes; set one.' }] };
const divergent = (repositories: string[]): JiraEvaluation => ({ decision: 'blocked', reasons: [{ code: 'JIRA_ROUTE_DIVERGENT', repositories, nextStep: `Different repositories (${repositories.join(', ')}).` }] });
const blockerA: JiraEvaluation = { decision: 'blocked', reasons: [{ code: 'JIRA_BLOCKER_NOT_DONE', blocker: { issueId: '70301', key: 'SEC-10' }, nextStep: 'A visible blocker is not Done.' }] };

test('a blocked Card with confirmed intent and audience is told once per impediment; a new reason is told again', () => {
  const first = impedimentNotice({ evaluation: divergent(['equipe/a', 'equipe/b']), audience: 'card', notified: null });
  assert.equal(first.kind, 'notify');
  const again = impedimentNotice({ evaluation: divergent(['equipe/a', 'equipe/b']), audience: 'card', notified: first.reasonKey });
  assert.equal(again.kind, 'already-notified');
  const changed = impedimentNotice({ evaluation: none, audience: 'card', notified: first.reasonKey });
  assert.equal(changed.kind, 'notify');
  assert.notEqual(changed.reasonKey, first.reasonKey);
  // Another divergent repository set is another impediment.
  assert.equal(impedimentNotice({ evaluation: divergent(['equipe/a', 'equipe/c']), audience: 'card', notified: first.reasonKey }).kind, 'notify');
});

test('another restricted blocker is the same Card-visible impediment, and the reason key never carries the neighbour', () => {
  const first = impedimentNotice({ evaluation: blockerA, audience: 'card', notified: null });
  const other: JiraEvaluation = { decision: 'blocked', reasons: [{ ...blockerA.reasons[0]!, blocker: { issueId: '70999', key: 'HR-3' } }] };
  assert.equal(impedimentNotice({ evaluation: other, audience: 'card', notified: first.reasonKey }).kind, 'already-notified');
  assert.doesNotMatch(first.reasonKey ?? '', /SEC-10|70301/);
});

test('label removed, unverifiable facts, eligibility or an uncertain audience never post: local diagnosis only', () => {
  assert.deepEqual(impedimentNotice({ evaluation: { decision: 'not-candidate', reasons: [] }, audience: 'card', notified: null }),
    { kind: 'local', code: 'JIRA_NOTICE_NOT_CANDIDATE', reasonKey: null });
  const unverifiable: JiraEvaluation = { decision: 'unverifiable', reasons: [{ code: 'JIRA_COMPONENTS_UNVERIFIABLE', nextStep: 'Read again.' }] };
  assert.equal(impedimentNotice({ evaluation: unverifiable, audience: 'card', notified: null }).kind, 'local');
  assert.equal(impedimentNotice({ evaluation: { decision: 'eligible', repository: 'equipe/a', reasons: [] }, audience: 'card', notified: null }).kind, 'local');
  const uncertain = impedimentNotice({ evaluation: none, audience: 'unknown', notified: null });
  assert.equal(uncertain.kind, 'local');
  assert.equal(uncertain.kind === 'local' && uncertain.code, 'JIRA_NOTICE_AUDIENCE_UNCERTAIN');
});

test('a blocked Card with an unverifiable side tells only the known impediments', () => {
  const mixed: JiraEvaluation = { decision: 'blocked', reasons: [none.reasons[0]!, { code: 'JIRA_BLOCKERS_UNVERIFIABLE', observedCode: 'JIRA_FORBIDDEN', nextStep: 'Could not verify.' }] };
  const decision = impedimentNotice({ evaluation: mixed, audience: 'card', notified: null });
  assert.equal(decision.kind, 'notify');
  assert.equal(decision.kind === 'notify' && decision.reasonKey, impedimentNotice({ evaluation: none, audience: 'card', notified: null }).reasonKey);
  assert.deepEqual(decision.kind === 'notify' && decision.steps, ['No component routes; set one.']);
});

test('the notice starts with the reserved header and carries only the Card-safe reason and corrective action', () => {
  const content = impedimentComment({ ref: 'I-1a2b3c4d', steps: ['A visible blocker is not Done.'] });
  assert.equal(content.header, '[Software Factory · Impedimento I-1a2b3c4d]');
  assert.equal(content.lines[0], content.header);
  assert.ok(content.lines.includes('- A visible blocker is not Done.'));
  assert.doesNotMatch(content.lines.join('\n'), /SEC-10|70301/);
});

const expected = impedimentComment({ ref: 'I-1a2b3c4d', steps: ['Fix it.'] });
const own = (commentId: string, lines = expected.lines, extra: { accountId?: string; restricted?: boolean } = {}) =>
  ({ commentId, accountId: extra.accountId ?? 'acc-factory', text: lines.join('\n'), restricted: extra.restricted ?? false });

test('reconciliation: one exact own comment confirms; zero in a complete read is absent', () => {
  assert.deepEqual(commentReconciliation({ listing: { kind: 'complete', comments: [own('100', ['hello']), own('101')] }, account: 'acc-factory', expected }),
    { kind: 'confirmed', commentId: '101' });
  assert.deepEqual(commentReconciliation({ listing: { kind: 'complete', comments: [own('100', ['hello'])] }, account: 'acc-factory', expected }), { kind: 'absent' });
  // The header copied by another account (or the same text by a human) proves nothing.
  assert.deepEqual(commentReconciliation({ listing: { kind: 'complete', comments: [own('102', expected.lines, { accountId: 'acc-human' })] }, account: 'acc-factory', expected }),
    { kind: 'absent' });
});

test('reconciliation: two copies, an edited or restricted own copy, an incomplete read or an unknown account stay pending', () => {
  const pending = (input: Parameters<typeof commentReconciliation>[0]) => { const result = commentReconciliation(input); return result.kind === 'pending' ? result.code : result.kind; };
  assert.equal(pending({ listing: { kind: 'complete', comments: [own('101'), own('102')] }, account: 'acc-factory', expected }), 'JIRA_COMMENT_MULTIPLE');
  assert.equal(pending({ listing: { kind: 'complete', comments: [own('101', [expected.header, 'edited'])] }, account: 'acc-factory', expected }), 'JIRA_COMMENT_SIMILAR');
  assert.equal(pending({ listing: { kind: 'complete', comments: [own('101', expected.lines, { restricted: true })] }, account: 'acc-factory', expected }), 'JIRA_COMMENT_SIMILAR');
  assert.equal(pending({ listing: { kind: 'incomplete', code: 'JIRA_COMMENTS_INCOMPLETE' }, account: 'acc-factory', expected }), 'JIRA_COMMENTS_INCOMPLETE');
  assert.equal(pending({ listing: { kind: 'complete', comments: [] }, account: null, expected }), 'JIRA_ACCOUNT_UNKNOWN');
});

test('Jira ticket 09: the delivery notice is ONE line led by its reserved header; reconciliation recognises it and a same-header variant stays ambiguous', () => {
  const expected = deliveryComment({ workRef: 'T-17', base: 'main', url: 'https://github.com/acme/payments-api/pull/9' });
  assert.deepEqual(expected, { header: '[Software Factory · Entrega T-17]', lines: ['[Software Factory · Entrega T-17] O PR foi integrado a main: https://github.com/acme/payments-api/pull/9'] });
  const comment = (commentId: string, text: string) => ({ commentId, accountId: 'acc-factory', text, restricted: false });
  const listing = (...comments: ReturnType<typeof comment>[]) => ({ listing: { kind: 'complete' as const, comments }, account: 'acc-factory', expected });
  assert.deepEqual(commentReconciliation(listing(comment('1', expected.lines[0]!))), { kind: 'confirmed', commentId: '1' });
  assert.deepEqual(commentReconciliation(listing(comment('1', expected.lines[0]!), comment('2', expected.lines[0]!))),
    { kind: 'pending', code: 'JIRA_COMMENT_MULTIPLE', candidates: ['1', '2'] });
  assert.deepEqual(commentReconciliation(listing(comment('3', '[Software Factory · Entrega T-17] O PR foi integrado a release: x'))),
    { kind: 'pending', code: 'JIRA_COMMENT_SIMILAR', candidates: ['3'] });
  assert.deepEqual(commentReconciliation(listing(comment('4', '[Software Factory · Entrega T-170] O PR foi integrado a main: x'))), { kind: 'absent' },
    'another Work\'s header is not a prefix match');
});
