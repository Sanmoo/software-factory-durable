import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraTracker, type JiraRequest, type JiraResponse, type JiraTicketRef } from '../../src/issue-tracker/index.js';

// Jira ticket 01: the Jira adapter behind the common contract; the transport is the host's (origin + credential), the adapter only
// names closed REST v3 paths and validates what comes back. Discovery/blockers/comments arrive with tickets 03/05/06.
const scope = { tracker: 'jira' as const, siteId: 'site-A', url: 'https://equipe.atlassian.net', projectId: '10010', label: 'factory-ready' };
const ref: JiraTicketRef = { tracker: 'jira', siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' };
const blocksType = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const issue = { id: '81017', key: 'PAG-42', fields: { labels: ['factory-ready'], components: [{ id: '10022', name: 'Pagamentos' }], project: { id: '10010' },
  status: { statusCategory: { key: 'indeterminate' } }, summary: 'Cobrar em reais',
  issuelinks: [{ id: '811', type: blocksType, inwardIssue: { id: '70202', key: 'OPS-9', fields: { status: { name: 'Em validação' } } } },
    { id: '812', type: blocksType, outwardIssue: { id: '70203', key: 'PAG-50' } }] } };

function recording(respond: (request: JiraRequest) => JiraResponse) {
  const calls: JiraRequest[] = [];
  return { calls, transport: { request: async (request: JiraRequest) => { calls.push(request); return respond(request); } } };
}
const ok = (body: unknown): JiraResponse => ({ ok: true, status: 200, body, observedAt: '2026-11-21T10:00:00.000Z' });

test('readTicket re-reads the Ticket by its stable ID and reports labels, components and status category', async () => {
  const { calls, transport } = recording(() => ok(issue));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  const observation = await tracker.readTicket(ref);
  assert.deepEqual(calls, [{ method: 'GET', path: '/rest/api/3/issue/81017', query: { fields: 'labels,components,issuelinks,status,summary,project' } }]);
  assert.deepEqual(observation, { kind: 'observed', source: 'jira-rest', observedAt: '2026-11-21T10:00:00.000Z', completeness: 'complete', ticket: ref,
    projectId: '10010', labels: ['factory-ready'], components: [{ id: '10022', name: 'Pagamentos' }], statusCategory: 'indeterminate', summary: 'Cobrar em reais',
    links: [{ linkId: '811', type: blocksType, end: 'inward', issue: { issueId: '70202', key: 'OPS-9' } },
      { linkId: '812', type: blocksType, end: 'outward', issue: { issueId: '70203', key: 'PAG-50' } }] });
});

test('a renamed key is reported as presentation of the same Ticket', async () => {
  const { transport } = recording(() => ok({ ...issue, key: 'FIN-18' }));
  const observation = await createJiraTracker({ scopes: [scope], transport: () => transport }).readTicket(ref);
  assert.equal(observation.kind, 'observed');
  if (observation.kind !== 'observed') return;
  assert.deepEqual(observation.ticket, { ...ref, key: 'FIN-18', url: 'https://equipe.atlassian.net/browse/FIN-18' });
});

test('an unconfigured site, a failed transport or an unexpected payload is unavailable, never an empty observation', async () => {
  const none = recording(() => ok(issue));
  const unconfigured = await createJiraTracker({ scopes: [scope], transport: () => none.transport }).readTicket({ ...ref, siteId: 'site-B' });
  assert.equal(unconfigured.kind, 'unavailable');
  assert.equal(unconfigured.kind === 'unavailable' && unconfigured.code, 'JIRA_SITE_NOT_CONFIGURED');
  assert.equal(none.calls.length, 0, 'nothing is sent to an unconfigured site');

  const failed = recording(() => ({ ok: false, code: 'JIRA_HTTP_403', status: 403, observedAt: '2026-11-21T10:00:00.000Z', nextStep: 'Check the account permissions.' }));
  const forbidden = await createJiraTracker({ scopes: [scope], transport: () => failed.transport }).readTicket(ref);
  assert.deepEqual(forbidden, { kind: 'unavailable', source: 'jira-rest', observedAt: '2026-11-21T10:00:00.000Z', siteId: 'site-A', completeness: 'incomplete',
    code: 'JIRA_HTTP_403', nextStep: 'Check the account permissions.' });

  for (const body of [{ ...issue, id: '99999' }, { ...issue, fields: { ...issue.fields, labels: undefined } }, { ...issue, key: 'not a key' }, 'html']) {
    const { transport } = recording(() => ok(body));
    const observation = await createJiraTracker({ scopes: [scope], transport: () => transport }).readTicket(ref);
    assert.equal(observation.kind === 'unavailable' && observation.code, 'JIRA_OBSERVATION_INVALID', JSON.stringify(body));
  }
});

test('a missing component or link field is a partial read (null), never an empty list', async () => {
  const { transport } = recording(() => ok({ ...issue, fields: { ...issue.fields, components: undefined, issuelinks: undefined } }));
  const observation = await createJiraTracker({ scopes: [scope], transport: () => transport }).readTicket(ref);
  assert.equal(observation.kind === 'observed' && observation.components, null);
  assert.equal(observation.kind === 'observed' && observation.links, null);
  const malformed = recording(() => ok({ ...issue, fields: { ...issue.fields, issuelinks: [{ id: '811', type: blocksType }] } }));
  const partial = await createJiraTracker({ scopes: [scope], transport: () => malformed.transport }).readTicket(ref);
  assert.equal(partial.kind === 'observed' && partial.links, null, 'a link without a neighbour end cannot be interpreted');
});

const page = (ids: string[], next: { isLast: boolean; nextPageToken?: string }) =>
  ok({ issues: ids.map(id => ({ id, key: `PAG-${id.slice(-2)}`, fields: { project: { id: '10010' } } })), ...next });

test('listCandidates searches by project and label over every JQL page and collapses duplicates', async () => {
  const pages: Record<string, JiraResponse> = { first: page(['81017', '81018'], { isLast: false, nextPageToken: 'T2' }),
    T2: page(['81018', '81019'], { isLast: false, nextPageToken: 'T3' }), T3: page([], { isLast: true }) };
  const { calls, transport } = recording(request => pages[(request.body as { nextPageToken?: string }).nextPageToken ?? 'first']!);
  const observation = await createJiraTracker({ scopes: [scope], transport: () => transport }).listCandidates(scope);
  assert.deepEqual(calls[0], { method: 'POST', path: '/rest/api/3/search/jql',
    body: { jql: 'project = 10010 AND labels = "factory-ready"', fields: ['project'], maxResults: 100 } });
  assert.deepEqual(calls.map(call => (call.body as { nextPageToken?: string }).nextPageToken), [undefined, 'T2', 'T3'], 'all pages, short page is not the last');
  assert.equal(observation.kind, 'observed');
  if (observation.kind !== 'observed') return;
  assert.deepEqual(observation.candidates.map(item => item.issueId), ['81017', '81018', '81019']);
  assert.deepEqual(observation.candidates[0], { tracker: 'jira', siteId: 'site-A', issueId: '81017', key: 'PAG-17', url: 'https://equipe.atlassian.net/browse/PAG-17' });
  assert.ok(observation.limitations.length > 0, 'visible coverage only, never global completeness');
});

test('a missing, failed, looping or malformed JQL page makes the listing unavailable, never a shorter list', async () => {
  const cases: [string, (request: JiraRequest) => JiraResponse, string][] = [
    ['no next token', () => page(['81017'], { isLast: false }), 'JIRA_SEARCH_INCOMPLETE'],
    ['second page fails', request => (request.body as { nextPageToken?: string }).nextPageToken
      ? { ok: false, code: 'JIRA_TIMEOUT', observedAt: '2026-11-21T10:00:01.000Z', nextStep: 'Retry.' } : page(['81017'], { isLast: false, nextPageToken: 'T2' }), 'JIRA_TIMEOUT'],
    ['repeated token', () => page(['81017'], { isLast: false, nextPageToken: 'T2' }), 'JIRA_SEARCH_INCOMPLETE'],
    ['no isLast', () => ok({ issues: [] }), 'JIRA_OBSERVATION_INVALID'],
    ['other project', () => ok({ issues: [{ id: '81017', key: 'OPS-1', fields: { project: { id: '10099' } } }], isLast: true }), 'JIRA_OBSERVATION_INVALID'],
  ];
  for (const [name, respond, code] of cases) {
    const { transport } = recording(respond);
    const observation = await createJiraTracker({ scopes: [scope], transport: () => transport }).listCandidates(scope);
    assert.equal(observation.kind === 'unavailable' && observation.code, code, name);
  }
});

test('the link type catalogue and a neighbour status category are read by ID from the configured site', async () => {
  const { calls, transport } = recording(request => request.path === '/rest/api/3/issueLinkType' ? ok({ issueLinkTypes: [blocksType] })
    : ok({ id: '70202', key: 'OPS-9', fields: { status: { name: 'Em validação', statusCategory: { key: 'indeterminate' } } } }));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  assert.deepEqual(await tracker.readLinkTypes('site-A'), { kind: 'observed', source: 'jira-rest', observedAt: '2026-11-21T10:00:00.000Z', siteId: 'site-A', types: [blocksType] });
  assert.deepEqual(await tracker.readIssueStatus('site-A', '70202'),
    { kind: 'observed', source: 'jira-rest', observedAt: '2026-11-21T10:00:00.000Z', siteId: 'site-A', issueId: '70202', key: 'OPS-9', statusCategory: 'indeterminate' });
  assert.deepEqual(calls, [{ method: 'GET', path: '/rest/api/3/issueLinkType' }, { method: 'GET', path: '/rest/api/3/issue/70202', query: { fields: 'status' } }]);

  const missing = recording(() => ok({ id: '70202', key: 'OPS-9', fields: { status: { name: 'Done' } } }));
  const unknown = await createJiraTracker({ scopes: [scope], transport: () => missing.transport }).readIssueStatus('site-A', '70202');
  assert.equal(unknown.kind === 'unavailable' && unknown.code, 'JIRA_OBSERVATION_INVALID', 'a status name without its category concludes nothing');
});

test('capabilities not built yet answer unavailable without any call; remote links are a Jira-only capability', async () => {
  const { calls, transport } = recording(() => ok(issue));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  for (const observation of [await tracker.readDependencyGraph(ref), await tracker.readInputs(ref, null),
    await tracker.findQuestion(ref, '7d9f8a52-6a1f-4f0e-9a43-2f3a7f1f0c11')]) {
    assert.equal(observation.kind === 'unavailable' && observation.code, 'JIRA_CAPABILITY_NOT_AVAILABLE');
  }
  const posted = await tracker.postComment(ref, { kind: 'question', questionId: '7d9f8a52-6a1f-4f0e-9a43-2f3a7f1f0c11', body: 'x' },
    { effectId: 'e', questionId: '7d9f8a52-6a1f-4f0e-9a43-2f3a7f1f0c11' });
  assert.equal(posted.kind, 'failed', 'nothing was sent, so nothing can exist');
  const linked = await tracker.upsertRemoteLink(ref, { globalId: 'software-factory:work:1', url: 'https://github.com/equipe/payments-api/pull/1', title: 'T' });
  assert.equal(linked.kind, 'failed');
  assert.equal(calls.length, 0);
});

test('Jira ticket 04: readTicketContent reads summary and description by ID and hands the description over as bounded plain text', async () => {
  const description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cobrar em reais' }] }] };
  const { calls, transport } = recording(() => ok({ id: '81017', key: 'FIN-18', fields: { summary: 'Cobrança', description } }));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  assert.deepEqual(await tracker.readTicketContent(ref), { kind: 'observed', source: 'jira-rest', observedAt: '2026-11-21T10:00:00.000Z',
    ticket: { ...ref, key: 'FIN-18', url: 'https://equipe.atlassian.net/browse/FIN-18' }, summary: 'Cobrança', description: 'Cobrar em reais', truncated: false });
  assert.deepEqual(calls, [{ method: 'GET', path: '/rest/api/3/issue/81017', query: { fields: 'summary,description' } }]);
  const empty = await createJiraTracker({ scopes: [scope], transport: () => recording(() => ok({ id: '81017', key: 'PAG-42', fields: { summary: null, description: null } })).transport })
    .readTicketContent(ref);
  assert.deepEqual(empty.kind === 'observed' && [empty.summary, empty.description], [null, null]);
  for (const body of [{ id: '81017', key: 'PAG-42', fields: { description: 'plain string, not ADF' } }, { id: '99', key: 'PAG-42', fields: {} }]) {
    const read = await createJiraTracker({ scopes: [scope], transport: () => recording(() => ok(body)).transport }).readTicketContent(ref);
    assert.deepEqual(read.kind === 'unavailable' && read.code, 'JIRA_OBSERVATION_INVALID');
  }
});
