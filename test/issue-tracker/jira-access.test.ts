import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraTracker, type JiraRequest, type JiraResponse } from '../../src/issue-tracker/index.js';

// Jira ticket 10 (spec §1): `factory doctor` diagnoses the configured Jira account with ONE read of its own project permissions. Each needed
// capability is a fact (granted / missing / unverified); comment audience and blocker visibility are never provable and stay unverified.
// A missing permission is a diagnostic, never an attempt to widen access (the only request is the read).
const scope = { tracker: 'jira' as const, siteId: 'site-A', url: 'https://equipe.atlassian.net', projectId: '10010', label: 'factory-ready' };
const at = '2026-11-22T10:00:00.000Z';
const permissions = (have: Record<string, boolean>) => ({ permissions: Object.fromEntries(Object.entries(have).map(([key, value]) => [key, { key, havePermission: value }])) });

function recording(respond: (request: JiraRequest) => JiraResponse) {
  const calls: JiraRequest[] = [];
  return { calls, tracker: createJiraTracker({ scopes: [scope], transport: () => ({ request: async (request: JiraRequest) => { calls.push(request); return respond(request); } }) }) };
}

test('every needed permission granted: ok, from one read of the project permissions; audience and visibility stay unverified', async () => {
  const { calls, tracker } = recording(() => ({ ok: true, status: 200, observedAt: at, body: permissions({ BROWSE_PROJECTS: true, ADD_COMMENTS: true, LINK_ISSUES: true }) }));
  const result = await tracker.checkAccess(scope);
  assert.deepEqual(calls, [{ method: 'GET', path: '/rest/api/3/mypermissions', query: { projectId: '10010', permissions: 'BROWSE_PROJECTS,ADD_COMMENTS,LINK_ISSUES' } }]);
  assert.equal(result.status, 'ok');
  assert.equal(result.code, 'JIRA_ACCESS_OK');
  assert.deepEqual(result.facts, { projectRead: 'granted', commentCreate: 'granted', remoteLinks: 'granted', commentAudience: 'unverified', blockerVisibility: 'unverified' });
  assert.deepEqual([result.siteId, result.projectId, result.observedAt], ['site-A', '10010', at]);
});

test('a missing permission is named and blocks; an absent answer for one is unverified, never granted', async () => {
  const { calls, tracker } = recording(() => ({ ok: true, status: 200, observedAt: at, body: permissions({ BROWSE_PROJECTS: true, ADD_COMMENTS: false }) }));
  const result = await tracker.checkAccess(scope);
  assert.equal(calls.length, 1, 'diagnosis only: nothing is requested or changed');
  assert.deepEqual([result.status, result.code], ['blocked', 'JIRA_PERMISSION_MISSING']);
  assert.deepEqual([result.facts?.commentCreate, result.facts?.remoteLinks], ['missing', 'unverified']);
  assert.match(result.nextStep, /Add comments/);
  assert.doesNotMatch(result.nextStep, /Link issues/, 'an unverified permission is not reported as missing');
});

test('an unreadable token or an unavailable site concludes nothing: blocked with the transport code, every capability unverified', async () => {
  for (const code of ['JIRA_CREDENTIAL_UNAVAILABLE', 'JIRA_UNAUTHENTICATED', 'JIRA_TIMEOUT']) {
    const { tracker } = recording(() => ({ ok: false, code, observedAt: at, nextStep: `synthetic ${code}` }));
    const result = await tracker.checkAccess(scope);
    assert.deepEqual([result.status, result.code, result.completeness], ['blocked', code, 'incomplete']);
    assert.deepEqual(result.facts, { projectRead: 'unverified', commentCreate: 'unverified', remoteLinks: 'unverified', commentAudience: 'unverified', blockerVisibility: 'unverified' });
  }
  const { tracker } = recording(() => ({ ok: true, status: 200, observedAt: at, body: { unexpected: true } }));
  assert.equal((await tracker.checkAccess(scope)).code, 'JIRA_OBSERVATION_INVALID');
});
