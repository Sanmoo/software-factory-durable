import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker, type TicketRef } from '../../src/issue-tracker/index.js';
import { githubWorld, issue, worldScope, type World } from './github-world-fixture.js';

// I-local: real IssueTracker adapter, issuer and gh transport; only gh/GitHub (and the App HTTPS endpoints) are substituted by the
// local world fixture. NOT evidence of the real GitHub boundary (that is the ticket 10 real-run recipe).
async function compose(t: Parameters<typeof githubWorld>[0], world: World) {
  const fixture = await githubWorld(t, world);
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  return { ...fixture, tracker: createIssueTracker({ github, scopes: [worldScope] }) };
}
const ticket: TicketRef = { tracker: 'github', repository: 'acme/project', repositoryId: 3, issueId: 7003, nodeId: 'I_node3', number: 3, url: 'https://github.com/acme/project/issues/3' };
const qid = '0b9c6a52-3d3e-4c8f-9a51-2f7d1e0c4a11';
const effect = { effectId: '5f0c0e2e-0000-4000-8000-000000000001', questionId: qid };

test('AC2: postComment publishes ONE issue comment with the stable marker under a reduced issues:write grant; findQuestion discovers only it', async t => {
  const world = await compose(t, { issues: [issue(3)], pulls: [], comments: [
    // A human quoting the marker and a comment of another App are never candidates.
    { id: 10, issue: 3, body: `<!-- software-factory:question:${qid} -->\nfake`, user: { id: 9, login: 'human', type: 'User' } },
    { id: 11, issue: 3, body: `<!-- software-factory:question:${qid} -->\nother app`, user: { id: 8, login: 'other[bot]', type: 'Bot' }, performed_via_github_app: { id: 99 } },
  ] });
  const before = await world.tracker.findQuestion(ticket, qid);
  assert.deepEqual(before.kind === 'observed' ? [before.completeness, before.candidates] : before, ['complete', []]);
  const result = await world.tracker.postComment(ticket, { kind: 'question', questionId: qid, body: 'Which file?' }, effect);
  assert.equal(result.kind, 'published');
  if (result.kind !== 'published') return;
  assert.match(result.url, /^https:\/\/github\.com\/acme\/project\/issues\/3#issuecomment-\d+$/);
  const trace = await world.trace();
  const posts = trace.filter(entry => entry.method === 'POST' && entry.endpoint.includes('/comments'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.body, `<!-- software-factory:question:${qid} -->\nWhich file?`);
  assert.deepEqual(trace.find(entry => entry.endpoint.includes('access_tokens') && entry.permissions?.issues === 'write')?.permissions, { metadata: 'read', issues: 'write' });
  assert.ok(trace.every(entry => entry.method !== 'POST' || entry.endpoint.includes('access_tokens') || entry.endpoint === '/repos/acme/project/issues/3/comments'),
    'no other write: no label, assignee or state change');
  // Review 8: the single-use question-publish token is revoked right after its POST, and the outcome is reported.
  assert.equal(result.revocation, 'revoked');
  const deletes = trace.filter(entry => entry.method === 'DELETE');
  assert.deepEqual(deletes.map(entry => entry.endpoint), ['/installation/token']);
  assert.ok(trace.indexOf(deletes[0]!) > trace.indexOf(posts[0]!), 'revoked after the POST');
  const after = await world.tracker.findQuestion(ticket, qid);
  assert.deepEqual(after.kind === 'observed' ? after.candidates.map(item => item.commentId) : after, [result.commentId]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-installation-secret/);
});

test('AC2: a 5xx after the write is UNKNOWN (the comment may exist), a 4xx is a known failure; neither is retried by the adapter', async t => {
  const ambiguous = await compose(t, { issues: [issue(3)], pulls: [], postFault: { status: 502, created: true } });
  const unknown = await ambiguous.tracker.postComment(ticket, { kind: 'question', questionId: qid, body: 'Q' }, effect);
  assert.equal(unknown.kind, 'unknown');
  assert.equal((await ambiguous.trace()).filter(entry => entry.method === 'POST' && entry.endpoint.includes('/comments')).length, 1, 'no automatic retry');
  const found = await ambiguous.tracker.findQuestion(ticket, qid);
  assert.equal(found.kind === 'observed' ? found.candidates.length : -1, 1, 'discovery shows the comment did get created');
  assert.equal(unknown.kind === 'unknown' ? unknown.revocation : undefined, 'revoked', 'revocation is attempted whatever the POST outcome');
  const rejected = await compose(t, { issues: [issue(3)], pulls: [], postFault: { status: 422, created: false }, revokeFault: 403 });
  const failed = await rejected.tracker.postComment(ticket, { kind: 'question', questionId: qid, body: 'Q' }, effect);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.kind === 'failed' ? failed.revocation : undefined, 'failed', 'a rejected revocation is reported, never claimed');
  const inconclusive = await compose(t, { issues: [issue(3)], pulls: [], revokeFault: 502 });
  const published = await inconclusive.tracker.postComment(ticket, { kind: 'question', questionId: qid, body: 'Q' }, effect);
  assert.deepEqual([published.kind, published.revocation], ['published', 'unknown'], 'a 5xx revocation answer is inconclusive');
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-installation-secret/);
});

test('AC2: a partial comment listing is unavailable, never an empty search or proven absence', async t => {
  const world = await compose(t, { pageSize: 1, issues: [issue(3)], pulls: [], faults: { 'comments?per_page=100&page=2': { status: 503 } }, comments: [
    { id: 20, issue: 3, body: 'hello', user: { id: 9, login: 'human', type: 'User' } },
    { id: 21, issue: 3, body: 'world', user: { id: 9, login: 'human', type: 'User' } },
  ] });
  const search = await world.tracker.findQuestion(ticket, qid);
  assert.deepEqual([search.kind, search.completeness], ['unavailable', 'incomplete']);
  assert.equal('candidates' in search, false);
  const inputs = await world.tracker.readInputs(ticket, null);
  assert.deepEqual([inputs.kind, inputs.completeness], ['unavailable', 'incomplete']);
  assert.equal('comments' in inputs, false);
});

test('AC4: readInputs returns comments after the cursor with author identity/type and App attribution, uninterpreted', async t => {
  const world = await compose(t, { pageSize: 1, issues: [issue(3)], pulls: [], comments: [
    { id: 30, issue: 3, body: `/factory answer ${qid} old`, user: { id: 1, login: 'Sanmoo', type: 'User' } },
    { id: 31, issue: 3, body: `/factory answer ${qid} yes`, user: { id: 2, login: 'helper[bot]', type: 'Bot' }, performed_via_github_app: { id: 5 } },
    { id: 32, issue: 4, body: 'another issue', user: { id: 1, login: 'Sanmoo', type: 'User' } },
  ] });
  const all = await world.tracker.readInputs(ticket, null);
  assert.equal(all.kind, 'observed');
  if (all.kind !== 'observed') return;
  assert.deepEqual(all.comments.map(comment => [comment.commentId, comment.author.login, comment.author.type, comment.viaApp]), [[30, 'Sanmoo', 'User', null], [31, 'helper[bot]', 'Bot', 5]]);
  assert.equal(all.cursor, 31);
  const later = await world.tracker.readInputs(ticket, 30);
  assert.deepEqual(later.kind === 'observed' ? [later.comments.map(comment => comment.commentId), later.cursor] : later, [[31], 31]);
  const foreign = await world.tracker.readInputs({ ...ticket, repository: 'other/repo' }, null);
  assert.equal(foreign.kind === 'unavailable' ? foreign.code : '', 'REPOSITORY_NOT_CONFIGURED');
});

test('review 4: a comment listing beyond the page cap is incomplete (unavailable), never a partial result or absence', async t => {
  const comments = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, issue: 3, body: `c${i}`, user: { id: 9, login: 'human', type: 'User' } }));
  const world = await compose(t, { pageSize: 1, issues: [issue(3)], pulls: [], comments });
  const inputs = await world.tracker.readInputs(ticket, null);
  assert.deepEqual([inputs.kind, inputs.completeness, 'code' in inputs && inputs.code], ['unavailable', 'incomplete', 'INCOMPLETE_GITHUB_QUERY']);
  const pages = (await world.trace()).filter(entry => entry.endpoint.includes('/issues/3/comments')).length;
  assert.ok(pages <= 10, `at most 10 pages per read (${pages})`);
});
