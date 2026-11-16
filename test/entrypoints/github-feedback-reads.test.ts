import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { readPermissions, type GitHubAccess, type GitHubSession } from '../../src/platform/github/index.js';

// Ticket 23 adapter level (I with a stubbed transport): the REAL `readFeedback` parses reviews, inline review comments and the PR
// conversation in the documented GitHub REST shapes (payloads written here after the REST reference, NOT verbatim real reads — the
// q23-feedback-v1 recipe records the real ones). Only the transport is stubbed; the purpose is the reduced GET-only `feedback-read`.
const repo = { repository: 'acme/project', installationId: 2, workflows: false };
const user = (id: number, login: string, type = 'User') => ({ id, login, type, node_id: 'U', site_admin: false });
const pull = 'https://github.com/acme/project/pull/4';
const sha = 'd'.repeat(40);
function stub(pages: Record<string, unknown[]>, seen: { purpose?: string; paths: string[] }): GitHubAccess {
  const list = async (path: string) => { seen.paths.push(path); const page = pages[path.replace(/^\/repos\/acme\/project/, '')]; if (!page) throw new Error(`UNEXPECTED_LIST:${path}`); return structuredClone(page); };
  return { async read(_scope: unknown, purpose: string, inspect: (session: GitHubSession) => Promise<unknown>) {
    seen.purpose = purpose;
    try { return { ok: true, observedAt: '2026-11-15T12:00:00.000Z', repositoryId: 3, value: await inspect({ repositoryId: 3, get: async () => { throw new Error('NO_GET'); }, list } as unknown as GitHubSession) }; }
    catch (error) { return { ok: false, observedAt: 'now', code: error instanceof Error ? error.message : 'X', nextStep: 'x' }; }
  } } as unknown as GitHubAccess;
}
const pages = () => ({
  '/pulls/4/reviews': [{ id: 80, node_id: 'PRR_1', user: user(7, 'operator-one'), body: 'Rename the flag.', state: 'CHANGES_REQUESTED', html_url: `${pull}#pullrequestreview-80`,
    pull_request_url: 'x', commit_id: sha, submitted_at: '2026-11-15T10:00:00Z', author_association: 'OWNER' },
  { id: 81, node_id: 'PRR_2', user: null, body: '', state: 'DISMISSED', html_url: `${pull}#pullrequestreview-81`, commit_id: sha, submitted_at: '2026-11-15T10:01:00Z' }],
  '/pulls/4/comments': [{ id: 90, pull_request_review_id: 80, user: user(7, 'operator-one'), body: 'here', path: 'docs/a.md', line: 3, original_line: 3, commit_id: sha,
    original_commit_id: sha, html_url: `${pull}#discussion_r90`, created_at: '2026-11-15T10:00:00Z', updated_at: '2026-11-15T10:00:00Z', diff_hunk: '@@' }],
  '/issues/4/comments': [{ id: 101, node_id: 'IC_2', user: user(41898282, 'factory-app[bot]', 'Bot'), body: 'Factory', html_url: `${pull}#issuecomment-101`,
    created_at: '2026-11-15T10:02:00Z', updated_at: '2026-11-15T10:02:00Z', performed_via_github_app: { id: 1 } },
  { id: 100, node_id: 'IC_1', user: user(7, 'operator-one'), body: '/factory repair Rename the flag to --dry-run.', html_url: `${pull}#issuecomment-100`,
    created_at: '2026-11-15T10:01:00Z', updated_at: '2026-11-15T10:01:00Z', performed_via_github_app: null }],
});

test('AC1/AC2: readFeedback reads the three complete listings under feedback-read (GET only) and keeps identity/author/commit/content as facts', async () => {
  const seen = { paths: [] as string[] } as { purpose?: string; paths: string[] };
  const observed = await createCodeRepository({ github: stub(pages(), seen) }).readFeedback!({ repo, number: 4 });
  assert.equal(seen.purpose, 'feedback-read');
  assert.deepEqual(readPermissions['feedback-read'], { metadata: 'read', pull_requests: 'read', issues: 'read' }, 'read-only: no write permission');
  assert.deepEqual(seen.paths, ['/repos/acme/project/pulls/4/reviews', '/repos/acme/project/pulls/4/comments', '/repos/acme/project/issues/4/comments']);
  assert.equal(observed.kind, 'observed');
  if (observed.kind !== 'observed') return;
  assert.deepEqual(observed.reviews.map(item => [item.reviewId, item.state, item.author?.login ?? null, item.commitId, item.body]), [
    [80, 'CHANGES_REQUESTED', 'operator-one', sha, 'Rename the flag.'], [81, 'DISMISSED', null, sha, '']]);
  assert.deepEqual(observed.reviewComments.map(item => [item.commentId, item.reviewId, item.path, item.line]), [[90, 80, 'docs/a.md', 3]]);
  assert.deepEqual(observed.comments.map(item => [item.commentId, item.viaApp, item.author.type]), [[100, null, 'User'], [101, 1, 'Bot']], 'ascending ids, App-performed marked');
});

test('AC1: a payload of another pull request, a malformed item or a failed listing is never a partial or empty observation', async () => {
  const foreign = pages();
  (foreign['/issues/4/comments'][0] as { html_url: string }).html_url = 'https://github.com/acme/project/pull/5#issuecomment-101';
  const malformed = pages();
  (malformed['/pulls/4/reviews'][0] as { state: unknown }).state = 7;
  const failing: Record<string, unknown[]> = pages();
  delete failing['/pulls/4/comments'];
  for (const [label, world] of [['foreign', foreign], ['malformed', malformed], ['failing', failing]] as const) {
    const observed = await createCodeRepository({ github: stub(world, { paths: [] }) }).readFeedback!({ repo, number: 4 });
    assert.equal(observed.kind, 'unavailable', label);
    if (observed.kind === 'unavailable') assert.match(observed.nextStep, /nothing is concluded/, label);
  }
});
