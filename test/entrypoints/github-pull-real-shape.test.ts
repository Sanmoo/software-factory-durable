import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createCodeRepository } from '../../src/code-repository/index.js';
import type { GitHubAccess, GitHubSession } from '../../src/platform/github/index.js';

// Ticket 17: the delivery read must accept GitHub's REAL single pull request payload. `fixtures/github-pull-5-real.json` is the verbatim
// read-only GET /repos/Sanmoo/java-springboot-event-sourcing/pulls/5 (open draft PR of ticket 14's v8 run; no secret). The merged and
// closed-unmerged variants change only the fields GitHub changes on those transitions.
const repo = { repository: 'Sanmoo/java-springboot-event-sourcing', installationId: 177599217, workflows: false };
const ref = { repo, repositoryId: 1256893534, number: 5, pullRequestId: 5321820867, nodeId: 'PR_kwDOSuqsXs8AAAABPTSKww' };
const real = async () => JSON.parse(await readFile('test/entrypoints/fixtures/github-pull-5-real.json', 'utf8')) as Record<string, unknown>;
// Only the transport is stubbed (it hands the adapter the payload); parsing and every check are the real adapter's.
const stub = (body: unknown, repositoryId = 1256893534): GitHubAccess =>
  ({
    async read(_scope: unknown, _purpose: unknown, inspect: (session: GitHubSession) => Promise<unknown>) {
      try {
        const session: GitHubSession = { repositoryId, get: async () => structuredClone(body), list: async () => [] };
        return { ok: true, observedAt: 'now', repositoryId, value: await inspect(session) };
      } catch (error) {
        return { ok: false, observedAt: 'now', code: error instanceof Error ? error.message : 'X', nextStep: 'x' };
      }
    },
  }) as unknown as GitHubAccess;

test('the verbatim real payload of open draft PR #5 parses into its facts', async () => {
  const observation = await createCodeRepository({ github: stub(await real()) }).readOwnMerge!(ref);
  assert.equal(observation.kind, 'observed');
  assert.deepEqual(observation.kind === 'observed' && observation.pullRequest, {
    pullRequestId: 5321820867,
    nodeId: 'PR_kwDOSuqsXs8AAAABPTSKww',
    number: 5,
    url: 'https://github.com/Sanmoo/java-springboot-event-sourcing/pull/5',
    state: 'open',
    draft: true,
    merged: false,
    mergedAt: null,
    mergeCommitSha: 'e43b2c7b3e86853f3bfcb7f7096408db5b6d47c0',
    headRef: 'factory/3-99fe871b',
    headSha: 'bfdd439ceba20a424538647f41e55d5ab2d03217',
    headRepositoryId: 1256893534,
    baseRef: 'main',
    baseRepositoryId: 1256893534,
    reported: { mergeCommitSha: 'value', merged: 'value' },
  });
});

test('merged and closed-unmerged transitions of the real payload parse; merge is never inferred from closed', async () => {
  const merged = {
    ...(await real()),
    state: 'closed',
    draft: false,
    merged: true,
    merged_at: '2026-11-15T12:00:00Z',
    closed_at: '2026-11-15T12:00:00Z',
    merge_commit_sha: 'c'.repeat(40),
    merged_by: { login: 'operator', id: 1, type: 'User' },
    mergeable: null,
    mergeable_state: 'unknown',
  };
  const facts = await createCodeRepository({ github: stub(merged) }).readOwnMerge!(ref);
  assert.deepEqual(
    facts.kind === 'observed' && [facts.pullRequest.state, facts.pullRequest.merged, facts.pullRequest.mergedAt, facts.pullRequest.mergeCommitSha],
    ['closed', true, '2026-11-15T12:00:00Z', 'c'.repeat(40)],
  );
  const closed = { ...(await real()), state: 'closed', closed_at: '2026-11-15T12:00:00Z' };
  const unmerged = await createCodeRepository({ github: stub(closed) }).readOwnMerge!(ref);
  assert.deepEqual(unmerged.kind === 'observed' && [unmerged.pullRequest.state, unmerged.pullRequest.merged, unmerged.pullRequest.mergedAt], [
    'closed',
    false,
    null,
  ]);
});

test('the REAL merge of PR #5 (merge commit eb6178d…, merged_by Sanmoo, 15:08:08Z) keeps merge_commit_sha; when GitHub does not send it the report says absent or null', async () => {
  const mergedReal = {
    ...(await real()),
    state: 'closed',
    draft: false,
    merged: true,
    merged_at: '2026-11-15T15:08:08Z',
    closed_at: '2026-11-15T15:08:08Z',
    merge_commit_sha: 'eb6178d666882a614a9b7716979c2a15bbd262fc',
    merged_by: { login: 'Sanmoo', id: 1, type: 'User' },
  };
  const kept = await createCodeRepository({ github: stub(mergedReal) }).readOwnMerge!(ref);
  assert.deepEqual(kept.kind === 'observed' && [kept.pullRequest.mergeCommitSha, kept.pullRequest.reported], [
    'eb6178d666882a614a9b7716979c2a15bbd262fc',
    { mergeCommitSha: 'value', merged: 'value' },
  ]);
  const { merge_commit_sha: _dropped, ...absent } = mergedReal;
  const withoutField = await createCodeRepository({ github: stub(absent) }).readOwnMerge!(ref);
  assert.deepEqual(withoutField.kind === 'observed' && [withoutField.pullRequest.mergeCommitSha, withoutField.pullRequest.reported.mergeCommitSha], [
    null,
    'absent',
  ]);
  const nullField = await createCodeRepository({ github: stub({ ...mergedReal, merge_commit_sha: null }) }).readOwnMerge!(ref);
  assert.deepEqual(nullField.kind === 'observed' && [nullField.pullRequest.mergeCommitSha, nullField.pullRequest.reported.mergeCommitSha], [null, 'null']);
});

test('API-version tolerance: without `merged`/`merge_commit_sha` the merge comes only from merged_at; contradictory facts are refused', async () => {
  const { merged: _m, merge_commit_sha: _c, ...lean } = await real();
  const open = await createCodeRepository({ github: stub(lean) }).readOwnMerge!(ref);
  assert.deepEqual(open.kind === 'observed' && [open.pullRequest.merged, open.pullRequest.mergeCommitSha], [false, null]);
  const contradictory = await createCodeRepository({ github: stub({ ...(await real()), merged: true, merged_at: null }) }).readOwnMerge!(ref);
  assert.deepEqual(contradictory.kind === 'unavailable' && contradictory.code, 'PULL_REQUEST_MERGE_FACTS_INCONSISTENT');
});

test('each failed check of the read is a DISTINCT code with field paths (never values), not a generic invalid payload', async () => {
  const repository = (body: unknown, id?: number) => createCodeRepository({ github: stub(body, id) }).readOwnMerge!(ref);
  const mismatch = await repository(await real(), 99);
  assert.deepEqual(mismatch.kind === 'unavailable' && mismatch.code, 'PULL_REQUEST_REPOSITORY_MISMATCH');
  const invalid = await repository({ ...(await real()), head: { ref: 'x' } });
  assert.deepEqual(invalid.kind === 'unavailable' && invalid.code, 'PULL_REQUEST_PAYLOAD_INVALID');
  assert.match(invalid.kind === 'unavailable' ? invalid.nextStep : '', /head\.sha/);
  assert.doesNotMatch(JSON.stringify(invalid), /bfdd439|factory\/3-99fe871b/, 'paths only, no payload values');
  const other = await repository({ ...(await real()), number: 6, html_url: 'https://github.com/Sanmoo/java-springboot-event-sourcing/pull/6' });
  assert.deepEqual(other.kind === 'unavailable' && other.code, 'PULL_REQUEST_IDENTITY_MISMATCH');
});
