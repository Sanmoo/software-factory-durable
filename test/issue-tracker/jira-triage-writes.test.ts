import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraHttpTransport, createJiraTracker, type JiraTicketRef } from '../../src/issue-tracker/index.js';
import { jiraHttpWorld, jiraOrigin, type HttpCard } from '../entrypoints/jira-http-world.js';

// The writes of a Triage publication on a Card and the changelog that says who made them. The adapter runs
// behind the host's real transport; Jira is the stateful HTTP world, which keeps a changelog entry per edit with the `historyMetadata`
// its caller sent. Synthetic: whether Jira Cloud stores and returns that metadata is still to be confirmed.
const scope = { tracker: 'jira' as const, siteId: 'site-A', url: jiraOrigin, projectId: '10010', label: 'factory-ready' };
const ref: JiraTicketRef = { tracker: 'jira', siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: `${jiraOrigin}/browse/PAG-42` };
const mark = 'software-factory:triage:3f0c';
function site(card: Partial<HttpCard> = {}) {
  const item: HttpCard = { id: '81017', key: 'PAG-42', projectId: '10010', labels: ['needs-triage', 'bug'], components: ['10099'], summary: 'Total', ...card };
  const world = jiraHttpWorld([item]);
  const transport = createJiraHttpTransport(
    { siteId: 'site-A', url: jiraOrigin, email: 'fabrica@example.org', credential: async () => 'synthetic-jira-token-SENTINEL' },
    { send: world.send },
  );
  return { world, item, tracker: createJiraTracker({ scopes: [scope], transport: () => transport }) };
}
const edit = { kind: 'edit' as const, mark, addLabels: ['factory-ready'], removeLabels: ['needs-triage'], addComponents: ['10022'] };

test('Jira: the edit of a Triage is one PUT of relative operations that names only labels and components', async () => {
  const { world, item, tracker } = site();
  const result = await tracker.writeTriage!(ref, edit);
  assert.equal(result.kind, 'accepted');
  const puts = world.exchanges.filter(exchange => exchange.method === 'PUT');
  assert.deepEqual(
    puts.map(exchange => [new URL(exchange.url).pathname, JSON.parse(exchange.body!)]),
    [
      [
        '/rest/api/3/issue/81017',
        {
          update: { labels: [{ add: 'factory-ready' }, { remove: 'needs-triage' }], components: [{ add: { id: '10022' } }] },
          historyMetadata: { type: mark, description: 'Software Factory Triage' },
        },
      ],
    ],
  );
  assert.deepEqual(
    [item.labels, item.components],
    [
      ['bug', 'factory-ready'],
      ['10099', '10022'],
    ],
    'what was already on the Card stays',
  );
  assert.deepEqual(world.unexpected, []);
});

test('an edit without a component sends no `components` operation', async () => {
  const { world, tracker } = site();
  await tracker.writeTriage!(ref, { ...edit, addComponents: [] });
  assert.deepEqual(JSON.parse(world.exchanges[0]!.body!).update, { labels: [{ add: 'factory-ready' }, { remove: 'needs-triage' }] });
});

test('Jira: the changelog reports each label and component change with its author account and the mark of the edit', async () => {
  const { world, item, tracker } = site();
  world.edit(item, { labels: [{ add: 'urgent' }] }, { accountId: 'acc-factory' });
  world.edit(item, { components: [{ add: { id: '10021' } }] }, {});
  await tracker.writeTriage!(ref, edit);
  const history = await tracker.readLabelHistory!(ref);
  assert.equal(history.kind, 'observed');
  if (history.kind !== 'observed') return;
  const factory = { tracker: 'jira', accountId: 'acc-factory' };
  assert.deepEqual(
    history.events.map(event => [event.action, event.label, event.author, event.mark]),
    [
      ['added', 'urgent', factory, undefined],
      ['removed', 'needs-triage', factory, mark],
      ['added', 'factory-ready', factory, mark],
    ],
    'the same account without the mark is a person using it',
  );
  assert.deepEqual(
    history.components.map(event => [event.action, event.componentId, event.author, event.mark]),
    [
      ['added', '10021', null, undefined],
      ['added', '10022', factory, mark],
    ],
  );
  assert.equal(history.components[1]!.eventId, history.events[1]!.eventId, 'one edit is one changelog entry');
});

test('Jira: a refused edit is a known failure with nothing applied; a lost answer is an unknown outcome', async () => {
  for (const [status, kind, code] of [
    [403, 'failed', 'JIRA_FORBIDDEN'],
    [400, 'failed', 'JIRA_REQUEST_REJECTED'],
    [503, 'unknown', 'JIRA_UNAVAILABLE'],
  ] as const) {
    const { world, item, tracker } = site();
    world.editFaults.push(status);
    const result = await tracker.writeTriage!(ref, edit);
    assert.deepEqual([result.kind, result.kind !== 'accepted' && result.code], [kind, code]);
    assert.deepEqual([item.labels, item.components], [['needs-triage', 'bug'], ['10099']]);
  }
});

test('the comment of a Triage is one ordinary comment, a paragraph per line, read back as the same text', async () => {
  const { world, tracker } = site();
  const lines = ['<!-- software-factory:triage:3f0c -->', '**Triage Verdict, generated by AI.**', '', 'Observado: o total ignora o cupom.'];
  assert.equal((await tracker.writeTriage!(ref, { kind: 'comment', lines })).kind, 'accepted');
  const listing = await tracker.listComments(ref);
  assert.equal(listing.kind, 'observed');
  if (listing.kind !== 'observed') return;
  assert.deepEqual(
    listing.comments.map(comment => [comment.authorAccountId, comment.text]),
    [['acc-factory', lines.join('\n')]],
  );
  assert.deepEqual(world.requests(), ['POST /rest/api/3/issue/81017/comment', 'GET /rest/api/3/issue/81017/comment']);
});
