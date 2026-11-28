import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardRoute,
  publicationStep,
  sameCommentText,
  triageComment,
  triageCommentMarker,
  type EffectFact,
  type PublicationFacts,
} from '../../src/control/rules/triage-publication.js';
import { boundTicketComments, ticketCommentsBound } from '../../src/control/rules/ticket-comments.js';
import { intendedChanges, verdictTextMaxBytes, type TriageIntendedEffect } from '../../src/control/rules/triage-verdict.js';

// Pure rules of the publication of a recorded Verdict, common to both trackers. No I/O, no clock.
const roles = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', admission: 'ready-for-agent' };
const at = '2026-11-25T12:00:00.000Z';
const id = '0b9c6a52-3d3e-4c8f-9a51-000000000077';
const absent: EffectFact = { holds: false, author: 'none' };
const own: EffectFact = { holds: true, author: 'own', reference: 'ref' };
const intended = (outcome: 'needs-info' | 'wontfix' = 'needs-info') =>
  intendedChanges({ outcome, category: 'bug', text: 't', component: null }, roles, 'github');
const singles = (effects: readonly unknown[]) => effects.map((_, index) => [index]);
const step = (
  effects: TriageIntendedEffect[],
  facts: Partial<PublicationFacts> & { effects: EffectFact[] },
  mode: 'verdict' | 'informative' | null = 'verdict',
  ambiguousAsOwn: number[] = [],
) =>
  publicationStep({
    roles,
    caseSensitive: false,
    mode,
    intended: effects,
    facts: { open: true, hasWork: false, labels: ['needs-triage'], ...facts },
    groups: singles(effects),
    at,
    ambiguousAsOwn,
  });
const attempted = (effects: TriageIntendedEffect[], ...indexes: number[]) =>
  effects.map((effect, index) => (indexes.includes(index) ? { ...effect, attempts: 1, attemptedAt: at } : effect));
const statuses = (effects: readonly TriageIntendedEffect[]) => effects.map(effect => effect.status);

test('a Ticket closed or with a Work on the re-read before the first write is abandoned with nothing published', () => {
  const closed = step(intended(), { open: false, effects: [absent, absent, absent] }, null);
  assert.deepEqual(closed.next, { action: 'end', to: 'abandoned', code: 'TICKET_CLOSED' });
  assert.deepEqual(statuses(closed.effects), ['no-longer-allowed', 'no-longer-allowed', 'no-longer-allowed']);
  assert.deepEqual(step(intended(), { hasWork: true, effects: [absent, absent, absent] }, null).next, { action: 'end', to: 'abandoned', code: 'WORK_EXISTS' });
});

test('a label conflict on the re-read before the first write suspends the request, with nothing written', () => {
  const result = step(intended(), { labels: ['needs-triage', 'wontfix'], effects: [absent, absent, absent] }, null);
  assert.deepEqual(result.next, { action: 'suspend', labels: ['wontfix'] });
  assert.deepEqual(statuses(result.effects), ['pending', 'pending', 'pending']);
});

test('the writes follow the recorded order, one unit at a time, each only after the previous one was read back', () => {
  const start = step(intended('wontfix'), { effects: [absent, absent, absent, absent] }, null);
  assert.deepEqual([start.mode, start.next], ['verdict', { action: 'write', mode: 'verdict', group: [0] }]);
  let effects = attempted(start.effects, 0);
  const second = step(effects, { effects: [own, absent, absent, absent] });
  assert.deepEqual(second.next, { action: 'write', mode: 'verdict', group: [1] });
  assert.deepEqual([second.effects[0]!.status, second.effects[0]!.reference, second.effects[0]!.settledAt], ['confirmed', 'ref', at]);
  effects = attempted(second.effects, 1);
  const third = step(effects, { labels: ['needs-triage', 'wontfix'], effects: [own, own, absent, absent] });
  assert.deepEqual(third.next, { action: 'write', mode: 'verdict', group: [2] });
  effects = attempted(third.effects, 2);
  const fourth = step(effects, { labels: ['wontfix'], effects: [own, own, own, absent] });
  assert.deepEqual(fourth.next, { action: 'write', mode: 'verdict', group: [3] });
  effects = attempted(fourth.effects, 3);
  const done = step(effects, { open: false, labels: ['wontfix'], effects: [own, own, own, own] });
  assert.deepEqual(done.next, { action: 'end', to: 'concluded', code: 'VERDICT_PUBLISHED' });
  assert.deepEqual(statuses(done.effects), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
});

test('a write unit of several effects (a Card: one PUT) is written and confirmed together', () => {
  const effects = attempted(intended(), 0);
  const result = publicationStep({
    roles,
    caseSensitive: true,
    mode: 'verdict',
    intended: effects,
    facts: { open: true, hasWork: false, labels: ['needs-triage'], effects: [own, absent, absent] },
    groups: [[0], [1, 2]],
    at,
  });
  assert.deepEqual(result.next, { action: 'write', mode: 'verdict', group: [1, 2] });
});

test('the pair outcome label plus needs-triage the publication itself created is not a conflict', () => {
  const effects = attempted(intended(), 0, 1);
  const result = step(effects, { labels: ['needs-triage', 'needs-info'], effects: [own, own, absent] });
  assert.deepEqual(result.next, { action: 'write', mode: 'verdict', group: [2] });
});

test('a label the API accepted and the read does not show stays pending and is never taken as written', () => {
  const effects = attempted(intended(), 0, 1);
  const result = step(effects, { effects: [own, absent, absent] });
  assert.deepEqual(result.next, { action: 'write', mode: 'verdict', group: [1] });
  assert.deepEqual(statuses(result.effects), ['confirmed', 'pending', 'pending']);
});

test('an effect that is present while the history does not show who made it yet waits for the history', () => {
  const effects = attempted(intended(), 0, 1);
  const result = step(effects, { labels: ['needs-triage', 'needs-info'], effects: [own, { holds: true, author: 'none' }, absent] });
  assert.deepEqual(result.next, { action: 'wait' });
  assert.deepEqual(statuses(result.effects), ['confirmed', 'pending', 'pending']);
});

test('an attempted effect present without an attributable author stops the publication with ambiguous authorship', () => {
  const effects = attempted(intended(), 0, 1);
  const facts = { labels: ['needs-triage', 'needs-info'], effects: [own, { holds: true, author: 'unknown' as const }, absent] };
  const result = step(effects, facts);
  assert.deepEqual(result.next, { action: 'impediment', effects: [1] });
  assert.deepEqual(statuses(result.effects), ['confirmed', 'ambiguous-authorship', 'pending']);
  // The operator's completion takes the ambiguous effect as the Factory's and goes on.
  const completed = step(result.effects, facts, 'verdict', [1]);
  assert.deepEqual(completed.next, { action: 'write', mode: 'verdict', group: [2] });
  assert.deepEqual(statuses(completed.effects), ['confirmed', 'confirmed', 'pending']);
  // Only the effects the operator named: another one found without an author still stops the publication.
  assert.deepEqual(step(result.effects, facts, 'verdict', [2]).next, { action: 'impediment', effects: [1] });
});

test('a human change between two writes marks every remaining effect as no longer allowed', () => {
  const afterComment = attempted(intended(), 0);
  // needs-triage withdrawn by a person after the comment.
  const withdrawn = step(afterComment, { labels: [], effects: [own, absent, { holds: true, author: 'other' }] });
  assert.deepEqual(withdrawn.next, { action: 'end', to: 'abandoned', code: 'NEEDS_TRIAGE_REMOVED' });
  assert.deepEqual(statuses(withdrawn.effects), ['confirmed', 'no-longer-allowed', 'no-longer-allowed']);
  assert.equal(withdrawn.effects[1]!.code, 'NEEDS_TRIAGE_REMOVED');
  // Another state label applied by a person.
  const relabelled = step(afterComment, { labels: ['needs-triage', 'ready-for-agent'], effects: [own, absent, absent] });
  assert.deepEqual(relabelled.next, { action: 'end', to: 'abandoned', code: 'TRIAGE_LABELS_CHANGED' });
  // The outcome label itself applied by a person before the Factory tried.
  const anticipated = step(afterComment, { labels: ['needs-triage', 'needs-info'], effects: [own, { holds: true, author: 'none' }, absent] });
  assert.deepEqual(anticipated.next, { action: 'end', to: 'abandoned', code: 'TRIAGE_LABELS_CHANGED' });
  // The Factory's own outcome label removed by a person before needs-triage was withdrawn.
  const undone = step(
    attempted(intended(), 0, 1).map((effect, index) => (index < 2 ? { ...effect, status: 'confirmed' as const } : effect)),
    { labels: ['needs-triage'], effects: [own, absent, absent] },
  );
  assert.deepEqual(undone.next, { action: 'end', to: 'abandoned', code: 'TRIAGE_LABELS_CHANGED' });
  // Closed by a person, or a Work appeared, with effects still to write.
  assert.deepEqual(step(afterComment, { open: false, effects: [own, absent, absent] }).next, { action: 'end', to: 'abandoned', code: 'TICKET_CLOSED' });
  assert.deepEqual(step(afterComment, { hasWork: true, effects: [own, absent, absent] }).next, { action: 'end', to: 'abandoned', code: 'WORK_EXISTS' });
});

test('a Work admitted by the last write does not undo a publication whose effects are all confirmed', () => {
  const effects = attempted(intended(), 0, 1, 2);
  const result = step(effects, { hasWork: true, labels: ['needs-info'], effects: [own, own, own] });
  assert.deepEqual(result.next, { action: 'end', to: 'concluded', code: 'VERDICT_PUBLISHED' });
});

test('needs-triage withdrawn before the first write leaves only the informative comment, then the request is abandoned', () => {
  const start = step(intended('wontfix'), { labels: ['ready-for-agent'], effects: [absent, absent, absent, absent] }, null);
  assert.deepEqual([start.mode, start.next], ['informative', { action: 'write', mode: 'informative', group: [0] }]);
  assert.deepEqual(statuses(start.effects), ['pending', 'no-longer-allowed', 'no-longer-allowed', 'no-longer-allowed']);
  const done = step(attempted(start.effects, 0), { labels: ['ready-for-agent'], effects: [own, absent, absent, absent] }, 'informative');
  assert.deepEqual(done.next, { action: 'end', to: 'abandoned', code: 'NEEDS_TRIAGE_REMOVED' });
  assert.deepEqual(statuses(done.effects), ['confirmed', 'no-longer-allowed', 'no-longer-allowed', 'no-longer-allowed']);
});

test('a comment whose marker is there with another content is not taken as this request’s effect', () => {
  const result = step(attempted(intended(), 0), { effects: [{ holds: true, author: 'unknown' }, absent, absent] });
  assert.deepEqual(result.next, { action: 'impediment', effects: [0] });
});

const comment = (overrides: Partial<Parameters<typeof triageComment>[0]> = {}) =>
  triageComment({
    triage_request_id: id,
    mode: 'verdict',
    outcome: 'wontfix',
    category: 'bug',
    text: 'Observado: o total já soma os preços.\nInferido: o pedido está atendido.\nAção: nenhuma.',
    intended: intended('wontfix'),
    limit: 65536,
    ...overrides,
  });

test('the comment carries the AI mark, the outcome, then the whole Verdict text, under the marker of the request', () => {
  const result = comment();
  assert.equal(result.kind, 'comment');
  if (result.kind !== 'comment') return;
  const lines = result.body.split('\n');
  assert.equal(lines[0], '<!-- software-factory:triage:0b9c6a52-3d3e-4c8f-9a51-000000000077 -->');
  assert.equal(lines[0], triageCommentMarker(id));
  assert.match(lines[1]!, /^\*\*Triage Verdict, generated by AI\.\*\*/);
  assert.match(result.body, /\*\*Outcome:\*\* `wontfix` \(category: `bug`\)/);
  assert.match(result.body, /adds the label `wontfix`, removes `needs-triage` and closes the Ticket as not planned/);
  assert.ok(result.body.indexOf('**Outcome:**') < result.body.indexOf('what was observed, what was inferred'));
  assert.ok(result.body.endsWith('Observado: o total já soma os preços.\nInferido: o pedido está atendido.\nAção: nenhuma.'), 'the text is whole and last');
});

test('a Verdict above the limit of the tracker is refused whole, never cut', () => {
  const text = 'é'.repeat(verdictTextMaxBytes / 2);
  const fits = comment({ text, limit: 32767 });
  assert.ok(fits.kind === 'comment' && fits.body.endsWith(text), 'the largest recorded Verdict fits a Jira comment whole');
  const large = comment({ text: 'x'.repeat(33000), limit: 32767 });
  assert.equal(large.kind, 'too-large');
  assert.deepEqual(large.kind === 'too-large' && [large.limit, large.characters > 33000], [32767, true]);
});

test('Jira: a comment with more lines than the tracker reads back is refused whole, never cut', () => {
  const text = 'a\n'.repeat(1900);
  const large = comment({ text, limit: 32767, maxLines: 1900 });
  assert.deepEqual(large.kind === 'too-large' && [large.maxLines, large.lines! > 1900], [1900, true]);
  assert.equal(comment({ text, limit: 32767 }).kind, 'comment');
});

const jiraRoutes = [
  { componentId: '10022', repository: 'acme/project' },
  { componentId: '10023', repository: 'acme/project' },
  { componentId: '10021', repository: 'acme/other' },
  { componentId: '10030', repository: 'acme/unauthorized' },
];
const route = (component: string | null, cardComponents: string[] | null) =>
  cardRoute({ component, cardComponents, routes: jiraRoutes, authorizedRepositories: ['acme/project', 'acme/other'] });

test('ready-for-agent stands only with a single route, and the component is added only to a Card without a routed one', () => {
  assert.deepEqual(route('10022', ['10099']), { kind: 'routed', addComponent: true });
  assert.deepEqual(route('10022', []), { kind: 'routed', addComponent: true });
  assert.deepEqual(route(null, ['10022', '10099']), { kind: 'routed', addComponent: false });
  assert.deepEqual(route('10023', ['10022']), { kind: 'routed', addComponent: false }, 'another component of the same repository changes nothing');
});

test('divergent routes, no single component and unreadable components fall to needs-info with what there is to suggest', () => {
  const suggested = { componentId: '10022', repository: 'acme/project' };
  assert.deepEqual(route('10022', ['10021']), { kind: 'fallback', code: 'TRIAGE_ROUTE_DIVERGENT', ...suggested });
  assert.deepEqual(route('10022', ['10022', '10021']), { kind: 'fallback', code: 'TRIAGE_ROUTE_DIVERGENT', ...suggested });
  assert.deepEqual(route(null, ['10022', '10021']), { kind: 'fallback', code: 'TRIAGE_ROUTE_DIVERGENT', componentId: null, repository: null });
  assert.deepEqual(route('10022', null), { kind: 'fallback', code: 'TRIAGE_COMPONENTS_UNREADABLE', ...suggested });
  assert.deepEqual(route(null, ['10099']), { kind: 'fallback', code: 'TRIAGE_COMPONENT_NOT_IDENTIFIED', componentId: null, repository: null });
  assert.deepEqual(route('10030', []), { kind: 'fallback', code: 'TRIAGE_COMPONENT_NOT_ROUTED', componentId: '10030', repository: null });
});

test('the comment of a Card says what happens to its route, and the suggestion when ready-for-agent is not applied', () => {
  const labels = { admission: 'factory-ready', needsInfo: 'needs-info' };
  const adds = comment({ route: { ...labels, kind: 'adds', componentId: '10022', repository: 'acme/project' } });
  assert.ok(adds.kind === 'comment');
  assert.match(
    adds.kind === 'comment' ? adds.body : '',
    /\*\*Route:\*\* .* adds the component 10022, which routes to the repository `acme\/project`\. If Jira refuses/,
  );
  const fallback = comment({ route: { ...labels, kind: 'fallback', code: 'TRIAGE_ROUTE_DIVERGENT', componentId: '10022', repository: 'acme/project' } });
  const body = fallback.kind === 'comment' ? fallback.body : '';
  assert.match(body, /applies `needs-info` instead because the components of the Card, with the one the Triager identified, route to more than one repository/);
  assert.match(body, /Suggested component: 10022, which routes to the repository `acme\/project`\./);
  assert.match(body, /replaces `needs-info` with `factory-ready`/);
  const informative = comment({ mode: 'informative', route: { ...labels, kind: 'adds', componentId: '10022', repository: 'acme/project' } });
  assert.ok(informative.kind === 'comment' && !informative.body.includes('**Route:**'), 'a recommendation promises no edit');
});

test('the largest Verdict comment a Triage publishes reaches the Builder whole in both origins, with later comments beside it', () => {
  const published = comment({
    text: 'x'.repeat(verdictTextMaxBytes),
    route: {
      admission: 'factory-ready',
      needsInfo: 'needs-info',
      kind: 'fallback',
      code: 'TRIAGE_ROUTE_DIVERGENT',
      componentId: '10022',
      repository: 'acme/project',
    },
  });
  assert.ok(published.kind === 'comment');
  if (published.kind !== 'comment') return;
  const fact = (id: string, body: string) => ({ id, author: 'a', association: 'FACTORY', createdAt: at, body });
  const delivered = boundTicketComments([fact('1', published.body), fact('2', 'y'.repeat(4000))], ticketCommentsBound);
  assert.deepEqual([delivered.omitted, delivered.comments.map(item => item.cut ?? false)], [0, [false, false]]);
});

test('the informative comment tells a recommendation from an action', () => {
  const result = comment({ mode: 'informative' });
  assert.ok(result.kind === 'comment');
  if (result.kind !== 'comment') return;
  assert.match(result.body, /generated by AI/);
  assert.match(result.body, /\*\*Outcome recommended:\*\* `wontfix`/);
  assert.match(result.body, /the Factory did not apply the outcome because `needs-triage` was removed/);
  assert.match(result.body, /changed no label and closed nothing/);
});

test('a comment is recognised by its content whatever the origin did to line endings and outer blanks', () => {
  assert.equal(sameCommentText('a\nb\n', 'a\r\nb'), true);
  assert.equal(sameCommentText('a\nb', 'a\nc'), false);
});
