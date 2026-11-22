import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraTracker, type JiraRequest, type JiraResponse, type JiraTicketRef } from '../../src/issue-tracker/index.js';

// Jira ticket 01: the Jira adapter behind the common contract; the transport is the host's (origin + credential), the adapter only
// names closed REST v3 paths and validates what comes back. Discovery/blockers/comments arrive with tickets 03/05/06.
const scope = { tracker: 'jira' as const, siteId: 'site-A', url: 'https://equipe.atlassian.net', projectId: '10010', label: 'factory-ready' };
const ref: JiraTicketRef = { tracker: 'jira', siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' };
const issue = { id: '81017', key: 'PAG-42', fields: { labels: ['factory-ready'], components: [{ id: '10022', name: 'Pagamentos' }], project: { id: '10010' },
  status: { statusCategory: { key: 'indeterminate' } } } };

function recording(respond: (request: JiraRequest) => JiraResponse) {
  const calls: JiraRequest[] = [];
  return { calls, transport: { request: async (request: JiraRequest) => { calls.push(request); return respond(request); } } };
}
const ok = (body: unknown): JiraResponse => ({ ok: true, status: 200, body, observedAt: '2026-11-21T10:00:00.000Z' });

test('readTicket re-reads the Ticket by its stable ID and reports labels, components and status category', async () => {
  const { calls, transport } = recording(() => ok(issue));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  const observation = await tracker.readTicket(ref);
  assert.deepEqual(calls, [{ method: 'GET', path: '/rest/api/3/issue/81017', query: { fields: 'labels,components,project,status' } }]);
  assert.deepEqual(observation, { kind: 'observed', source: 'jira-rest', observedAt: '2026-11-21T10:00:00.000Z', completeness: 'complete', ticket: ref,
    projectId: '10010', labels: ['factory-ready'], components: [{ id: '10022', name: 'Pagamentos' }], statusCategory: 'indeterminate' });
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

  for (const body of [{ ...issue, id: '99999' }, { ...issue, fields: { ...issue.fields, components: undefined } }, { ...issue, key: 'not a key' }, 'html']) {
    const { transport } = recording(() => ok(body));
    const observation = await createJiraTracker({ scopes: [scope], transport: () => transport }).readTicket(ref);
    assert.equal(observation.kind === 'unavailable' && observation.code, 'JIRA_OBSERVATION_INVALID', JSON.stringify(body));
  }
});

test('capabilities not built yet answer unavailable without any call; remote links are a Jira-only capability', async () => {
  const { calls, transport } = recording(() => ok(issue));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  for (const observation of [await tracker.listCandidates(scope), await tracker.readDependencyGraph(ref), await tracker.readInputs(ref, null),
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
