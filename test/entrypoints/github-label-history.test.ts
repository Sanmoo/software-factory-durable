import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker, type TicketRef } from '../../src/issue-tracker/index.js';
import { crossReferenced, githubWorld, issue, worldScope, type World } from './github-world-fixture.js';

// Spec #68 §4.6 (ticket #71; TR-06): the label changes of an issue, from its timeline, are the origin's evidence that needs-triage was
// withdrawn and applied again. I-local: real adapter, issuer and gh transport over the local world; not evidence of the real boundary.
async function compose(t: Parameters<typeof githubWorld>[0], world: World) {
  const fixture = await githubWorld(t, world);
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  return { ...fixture, tracker: createIssueTracker({ github, scopes: [worldScope] }) };
}
const ticket: TicketRef = {
  tracker: 'github',
  repository: 'acme/project',
  repositoryId: 3,
  issueId: 7003,
  nodeId: 'I_node3',
  number: 3,
  url: 'https://github.com/acme/project/issues/3',
};
const human = { id: 9, login: 'human', type: 'User' };
const labelEvent = (id: number, event: 'labeled' | 'unlabeled', name: string, extra: object = {}) => ({
  id,
  event,
  label: { name, color: 'ededed' },
  created_at: `2026-11-20T10:00:${String(id % 60).padStart(2, '0')}Z`,
  actor: human,
  performed_via_github_app: null,
  ...extra,
});

test('TR-06: readLabelHistory reports every label change of the timeline in order, with who made it, under a read-only grant', async t => {
  const world = await compose(t, {
    issues: [
      issue(3, {
        timeline: [
          labelEvent(11, 'labeled', 'needs-triage'),
          crossReferenced(8),
          labelEvent(12, 'unlabeled', 'needs-triage', {
            actor: { id: 5, login: 'factory[bot]', type: 'Bot' },
            performed_via_github_app: { id: 1, slug: 'factory' },
          }),
          { id: 13, event: 'closed', created_at: '2026-11-20T10:01:00Z', actor: human },
          labelEvent(14, 'labeled', 'needs-triage', { actor: null }),
        ],
      }),
    ],
    pulls: [],
  });
  const history = await world.tracker.readLabelHistory!(ticket);
  assert.equal(history.kind, 'observed');
  if (history.kind !== 'observed') return;
  assert.equal(history.completeness, 'complete');
  assert.deepEqual(history.events, [
    { eventId: '11', action: 'added', label: 'needs-triage', at: '2026-11-20T10:00:11Z', actor: human, viaApp: null },
    { eventId: '12', action: 'removed', label: 'needs-triage', at: '2026-11-20T10:00:12Z', actor: { id: 5, login: 'factory[bot]', type: 'Bot' }, viaApp: 1 },
    { eventId: '14', action: 'added', label: 'needs-triage', at: '2026-11-20T10:00:14Z', actor: null, viaApp: null },
  ]);
  const trace = await world.trace();
  assert.ok(
    trace.every(entry => entry.method === 'GET' || entry.endpoint.includes('access_tokens')),
    'no write',
  );
  assert.ok(
    trace.filter(entry => entry.endpoint.includes('access_tokens')).every(entry => entry.permissions?.issues === 'read'),
    'issues:read only',
  );
});

test('a label event that cannot be verified, or an unconfigured repository, is unavailable and never a shorter history', async t => {
  const world = await compose(t, {
    issues: [issue(3, { timeline: [labelEvent(11, 'labeled', 'needs-triage'), { id: 12, event: 'unlabeled', created_at: '2026-11-20T10:00:12Z' }] })],
    pulls: [],
  });
  const invalid = await world.tracker.readLabelHistory!(ticket);
  assert.equal(invalid.kind === 'unavailable' && invalid.code, 'INVALID_GITHUB_PAYLOAD');
  const foreign = await world.tracker.readLabelHistory!({ ...ticket, repository: 'acme/elsewhere' });
  assert.equal(foreign.kind === 'unavailable' && foreign.code, 'REPOSITORY_NOT_CONFIGURED');
});
