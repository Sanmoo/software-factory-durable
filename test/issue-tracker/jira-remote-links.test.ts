import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraTracker, type JiraRequest, type JiraResponse, type JiraTicketRef } from '../../src/issue-tracker/index.js';

// Jira ticket 08 (spec §5): the Work's link on the Card is ONE remote link upserted by its stable globalId; the same call creates it or
// updates its title, keeping the URL. Nothing else of the issue (status, assignee, resolution) is ever written.
const scope = { tracker: 'jira' as const, siteId: 'site-A', url: 'https://equipe.atlassian.net', projectId: '10010', label: 'factory-ready' };
const ref: JiraTicketRef = { tracker: 'jira', siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' };
const link = {
  globalId: 'software-factory:work:7d9f8a52-6a1f-4f0e-9a43-2f3a7f1f0c11',
  url: 'https://github.com/equipe/payments-api/pull/7',
  title: 'Trabalho T-17 · Abrir PR',
};
const at = '2026-11-21T10:00:00.000Z';

function recording(respond: (request: JiraRequest) => JiraResponse) {
  const calls: JiraRequest[] = [];
  return {
    calls,
    transport: {
      request: async (request: JiraRequest) => {
        calls.push(request);
        return respond(request);
      },
    },
  };
}

test('upsertRemoteLink POSTs the globalId and the PR object to the issue by ID; created (201) and updated (200) are both applied', async () => {
  for (const status of [201, 200]) {
    const { calls, transport } = recording(() => ({
      ok: true,
      status,
      body: { id: 10000, self: 'https://equipe.atlassian.net/rest/api/3/issue/81017/remotelink/10000' },
      observedAt: at,
    }));
    const result = await createJiraTracker({ scopes: [scope], transport: () => transport }).upsertRemoteLink(ref, link);
    assert.deepEqual(calls, [
      { method: 'POST', path: '/rest/api/3/issue/81017/remotelink', body: { globalId: link.globalId, object: { url: link.url, title: link.title } } },
    ]);
    assert.deepEqual(result, { kind: 'applied', observedAt: at, linkId: '10000' });
  }
});

test('a known refusal is failed (nothing applied), anything uncertain is unknown; an upsert by globalId may be repeated either way', async () => {
  const failed = await createJiraTracker({
    scopes: [scope],
    transport: () => recording(() => ({ ok: false, code: 'JIRA_RATE_LIMITED', waitSeconds: 30, observedAt: at, nextStep: 'wait' })).transport,
  }).upsertRemoteLink(ref, link);
  assert.deepEqual(failed, { kind: 'failed', observedAt: at, code: 'JIRA_RATE_LIMITED', waitSeconds: 30, nextStep: 'wait' });
  const forbidden = await createJiraTracker({
    scopes: [scope],
    transport: () => recording(() => ({ ok: false, code: 'JIRA_FORBIDDEN', status: 403, observedAt: at, nextStep: 'perm' })).transport,
  }).upsertRemoteLink(ref, link);
  assert.equal(forbidden.kind, 'failed');
  for (const response of [
    { ok: false as const, code: 'JIRA_TIMEOUT', observedAt: at, nextStep: 'x' },
    { ok: false as const, code: 'JIRA_UNAVAILABLE', status: 503, observedAt: at, nextStep: 'x' },
    { ok: true as const, status: 200, body: { unexpected: true }, observedAt: at },
  ]) {
    const result = await createJiraTracker({ scopes: [scope], transport: () => recording(() => response).transport }).upsertRemoteLink(ref, link);
    assert.equal(result.kind, 'unknown', JSON.stringify(response));
  }
  const unconfigured = recording(() => ({ ok: true, status: 200, body: { id: 1 }, observedAt: at }));
  const other = await createJiraTracker({ scopes: [scope], transport: () => unconfigured.transport }).upsertRemoteLink({ ...ref, siteId: 'site-B' }, link);
  assert.equal(other.kind === 'failed' && other.code, 'JIRA_SITE_NOT_CONFIGURED');
  assert.equal(unconfigured.calls.length, 0);
});

test('a link that is not a Factory work link of an https URL is refused locally, without any call', async () => {
  const { calls, transport } = recording(() => ({ ok: true, status: 200, body: { id: 1 }, observedAt: at }));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  for (const bad of [
    { ...link, globalId: 'other:1' },
    { ...link, url: 'http://github.com/x/y/pull/1' },
    { ...link, title: '' },
    { ...link, title: 'x'.repeat(256) },
  ]) {
    const result = await tracker.upsertRemoteLink(ref, bad);
    assert.equal(result.kind === 'failed' && result.code, 'JIRA_REMOTE_LINK_INVALID', JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);
});
