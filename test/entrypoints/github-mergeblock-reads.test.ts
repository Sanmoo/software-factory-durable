import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { evaluateChecks, interpretBaseRules } from '../../src/control/index.js';
import type { GitHubAccess, GitHubSession } from '../../src/platform/github/index.js';

// Ticket 39 adapter level (I with a stubbed transport): the REAL Q4B readPullRequest parses GitHub's rules payload of ruleset 26435808
// (fixtures/github-rules-main-26435808.json: the VERBATIM real q39 read, with GitHub's extra keys such as required_reviewers) and the verbatim real PR #5 payload (fixtures/github-pull-5-real.json,
// mergeable_state "blocked"); Control's public interpretation then classifies `update` as merge-blocking. Not evidence of real GitHub
// (the q39-mergeblock-v1 recipe is).
const repo = { repository: 'Sanmoo/java-springboot-event-sourcing', installationId: 177599217, workflows: false };
const head = 'bfdd439ceba20a424538647f41e55d5ab2d03217';
const tip = '8c058c90b3a0371d5966892ef5f0fd4758cdf90c';
const src = 'ruleset:26435808:Repository:Sanmoo/java-springboot-event-sourcing';
const fixture = async (name: string) => JSON.parse(await readFile(`test/entrypoints/fixtures/${name}`, 'utf8')) as Record<string, unknown>;
/** Only the transport is stubbed; every path the adapter asks for is answered as GitHub answered the q16 run (classic checks not enforced, no CI). */
function stub(input: { pull: unknown; rules: unknown[] }): GitHubAccess {
  const get = async (path: string) => {
    if (path.endsWith('/pulls/5')) return structuredClone(input.pull);
    if (path.endsWith('/branches/main'))
      return { commit: { sha: tip }, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } };
    if (path.includes('/compare/')) return { status: 'ahead', ahead_by: 1, behind_by: 0 };
    throw new Error(`UNEXPECTED_GET:${path}`);
  };
  const list = async (path: string) => (path.includes('/rules/branches/main') ? structuredClone(input.rules) : []);
  return {
    async read(_scope: unknown, _purpose: unknown, inspect: (session: GitHubSession) => Promise<unknown>) {
      try {
        return {
          ok: true,
          observedAt: '2026-11-15T12:00:00.000Z',
          repositoryId: 1256893534,
          value: await inspect({ repositoryId: 1256893534, get, list } as unknown as GitHubSession),
        };
      } catch (error) {
        return { ok: false, observedAt: 'now', code: error instanceof Error ? error.message : 'X', nextStep: 'x' };
      }
    },
  } as unknown as GitHubAccess;
}
const expect = {
  own: { pullRequestId: 5321820867, nodeId: 'PR_kwDOSuqsXs8AAAABPTSKww', number: 5, headRef: 'factory/3-99fe871b', base: 'main', authorId: 351187749 },
  repositoryId: 1256893534,
  linkedHeads: [head],
  localRequiredChecks: [],
};

test('AC1/AC5: the real rules payload of ruleset 26435808 parses with its parameters; update is merge-blocking with its source; mergeable_state blocked is no conflict', async () => {
  const rules = (await fixture('github-rules-main-26435808.json')).rules as unknown[];
  const observed = await createCodeRepository({ github: stub({ pull: await fixture('github-pull-5-real.json'), rules }) }).readPullRequest({ repo, number: 5 });
  assert.equal(observed.kind, 'observed');
  if (observed.kind !== 'observed' || observed.rules.state !== 'complete') return;
  assert.equal(observed.pullRequest.mergeableState, 'blocked');
  assert.deepEqual(
    observed.rules.value.map(rule => [rule.type, rule.ruleset.id, rule.parameters ?? null, rule.unparsed ?? false]),
    [
      [
        'pull_request',
        26435808,
        {
          kind: 'pull_request',
          allowedMergeMethods: ['merge', 'squash', 'rebase'],
          requiredApprovingReviewCount: 1,
          requireCodeOwnerReview: false,
          requireLastPushApproval: false,
          requiredReviewThreadResolution: false,
          dismissStaleReviewsOnPush: true,
        },
        false,
      ],
      ['non_fast_forward', 26435808, null, false],
      ['deletion', 26435808, null, false],
      ['update', 26435808, { kind: 'update', updateAllowsFetchAndMerge: false }, false],
    ],
    'GitHub sends update WITHOUT parameters: the default (no fetch-and-merge)',
  );
  assert.deepEqual(
    interpretBaseRules(observed.rules.value).map(item => [item.type, item.merge, item.reason, item.source]),
    [
      ['pull_request', 'human-stage', 'HUMAN_REVIEW_STAGE', src],
      ['non_fast_forward', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE', src],
      ['deletion', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE', src],
      ['update', 'blocking', 'UPDATE_RESTRICTED', src],
    ],
  );
  const checks = evaluateChecks({ at: '2026-11-15T12:00:05.000Z', expect, observation: observed });
  assert.deepEqual(
    [checks.outcome, checks.conflict, checks.reasons],
    ['blocked', 'none', [{ category: 'merge', code: 'UPDATE_RESTRICTED', subject: `update@${src}` }]],
    'the aggregated mergeable_state blocked is neither a conflict nor a failed check',
  );
  assert.match(checks.nextStep, /Operator: adjust the base protection/);
});

test('AC1: rule parameters of another shape make only that rule indeterminate; deployments and merge queue as GitHub sends them', async () => {
  const at = { ruleset_source_type: 'Organization', ruleset_source: 'acme', ruleset_id: 9 };
  const rules = [
    { type: 'update', parameters: { update_allows_fetch_and_merge: 'yes' }, ...at },
    { type: 'pull_request', parameters: { allowed_merge_methods: 'squash' }, ...at },
    { type: 'required_deployments', parameters: { required_deployment_environments: ['production'] }, ...at },
    { type: 'required_deployments', ...at },
    {
      type: 'merge_queue',
      parameters: {
        merge_method: 'MERGE',
        grouping_strategy: 'ALLGREEN',
        max_entries_to_build: 5,
        min_entries_to_merge: 1,
        max_entries_to_merge: 5,
        min_entries_to_merge_wait_minutes: 5,
        check_response_timeout_minutes: 60,
      },
      ...at,
    },
  ];
  const observed = await createCodeRepository({ github: stub({ pull: await fixture('github-pull-5-real.json'), rules }) }).readPullRequest({ repo, number: 5 });
  assert.ok(observed.kind === 'observed' && observed.rules.state === 'complete');
  if (observed.kind !== 'observed' || observed.rules.state !== 'complete') return;
  assert.deepEqual(
    interpretBaseRules(observed.rules.value).map(item => [item.type, item.interpretation, item.merge, item.reason]),
    [
      ['update', 'unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE'],
      ['pull_request', 'unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE'],
      ['required_deployments', 'merge-blocking', 'blocking', 'DEPLOYMENTS_REQUIRED'],
      ['required_deployments', 'unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE'],
      ['merge_queue', 'merge-blocking', 'blocking', 'MERGE_QUEUE_NOT_SUPPORTED'],
    ],
  );
});
