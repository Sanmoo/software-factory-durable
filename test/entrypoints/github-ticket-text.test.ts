import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker, type GitHubTicketRef } from '../../src/issue-tracker/index.js';
import { githubWorld, issue, worldScope, type World } from './github-world-fixture.js';

// Spec #68 §7 (ticket #75; TR-37): the title and body of an issue, read by the Control for the first prompt of its Triager. I-local: real
// adapter, issuer and gh transport over the local world; not evidence of the real boundary.
async function compose(t: Parameters<typeof githubWorld>[0], world: World) {
  const fixture = await githubWorld(t, world);
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  return { ...fixture, tracker: createIssueTracker({ github, scopes: [worldScope] }) };
}
const ticket = (number: number): GitHubTicketRef => ({
  tracker: 'github',
  repository: 'acme/project',
  repositoryId: 3,
  issueId: 7000 + number,
  nodeId: `I_node${number}`,
  number,
  url: `https://github.com/acme/project/issues/${number}`,
});

test('TR-37: readTicketText reports the title and body of the issue as written, and an issue without a body as such', async t => {
  const world = await compose(t, {
    issues: [issue(3, { title: 'Total errado no carrinho', body: 'O total ignora o desconto.\n\n```js\ntotal(items)\n```' }), issue(4, { body: null })],
    pulls: [],
  });
  const text = await world.tracker.readTicketText!(ticket(3));
  assert.equal(text.kind, 'observed');
  if (text.kind !== 'observed') return;
  assert.deepEqual(
    [text.completeness, text.title, text.body],
    ['complete', 'Total errado no carrinho', 'O total ignora o desconto.\n\n```js\ntotal(items)\n```'],
  );
  assert.deepEqual(text.ticket, ticket(3));
  const empty = await world.tracker.readTicketText!(ticket(4));
  assert.deepEqual(empty.kind === 'observed' && [empty.title, empty.body], ['Ticket 4', null]);
});

test('TR-37: an issue that is not the recorded Ticket, or a repository that is not configured, is unavailable: never a guessed text', async t => {
  const world = await compose(t, { issues: [issue(3)], pulls: [] });
  const other = await world.tracker.readTicketText!({ ...ticket(3), issueId: 9999 });
  assert.equal(other.kind, 'unavailable', 'the issue behind the number is not the Ticket the request recorded');
  const missing = await world.tracker.readTicketText!(ticket(5));
  assert.equal(missing.kind, 'unavailable');
  const foreign = await world.tracker.readTicketText!({ ...ticket(3), repository: 'acme/elsewhere' });
  assert.deepEqual(foreign.kind === 'unavailable' && foreign.code, 'REPOSITORY_NOT_CONFIGURED');
});
