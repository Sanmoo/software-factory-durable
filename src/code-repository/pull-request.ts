import { z } from 'zod';
import type { GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess, type GitHubRead, type GitHubSession } from '../platform/github/index.js';

// Q4B `readPullRequest(pr)` (ticket 15, spec §9.2): current facts of a KNOWN own pull request and the data its applicable checks need.
// Facts only, each with its own completeness: this module never decides which requirement applies, whether it is satisfied, or readiness.

/** A fact read completely, or unknown with the read's code (a failed/partial/hidden read never stands in for absence). */
export type Known<T> = { state: 'complete'; value: T } | { state: 'unknown'; code: string; waitSeconds?: number; nextStep: string };
/** A required check as GitHub declares it: context plus the integration (GitHub App id) it must come from; null = any source. */
export type RequiredCheck = { context: string; integrationId: number | null };
/** V-09.f: classic protection settings that can block a human PR merge, read from the full protection (facts; Control interprets them). */
export type ClassicSettings = { lockBranch: boolean; requiredSignatures: boolean; requiredLinearHistory: boolean; pushRestrictions: boolean };
/** Classic branch protection's required status checks. `none` only from an authorized complete branch read. `settings`: null only when the
 * branch read proves there is no classic protection (not protected, or `protection.enabled: false` — a ruleset-only base); otherwise read. */
export type ClassicChecks = (
  | { kind: 'none'; evidence: 'BRANCH_NOT_PROTECTED' | 'STATUS_CHECKS_NOT_ENFORCED' }
  | { kind: 'required'; strict: boolean; enforcement: string; checks: RequiredCheck[] }
) & { settings: ClassicSettings | null };
/** Ticket 39: the parameters of the rules that can affect a human PR merge (GitHub REST ruleset rule parameters), as facts. */
export type RuleParameters =
  | { kind: 'update'; updateAllowsFetchAndMerge: boolean }
  | {
      kind: 'pull_request';
      allowedMergeMethods: string[] | null;
      requiredApprovingReviewCount: number | null;
      requireCodeOwnerReview: boolean | null;
      requireLastPushApproval: boolean | null;
      requiredReviewThreadResolution: boolean | null;
      dismissStaleReviewsOnPush: boolean | null;
    }
  | { kind: 'required_deployments'; environments: string[] };
/** One ACTIVE rule GitHub applies to the base (repository, organization or enterprise ruleset); `statusChecks` for required_status_checks,
 * `parameters` for update/pull_request/required_deployments (ticket 39).
 * `unparsed`: this rule (only this one) did not match the expected shape; its type is kept when readable ('unparsed' otherwise). */
export type BranchRule = {
  type: string;
  ruleset: { id: number | null; sourceType: string | null; source: string | null };
  statusChecks?: { strict: boolean; checks: RequiredCheck[] };
  parameters?: RuleParameters;
  unparsed?: true;
};
/** `status: 'unparsed'`: this item (only this one) did not match the expected shape; its name is kept when readable ('' otherwise). */
export type CheckRunFact = {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
  appSlug: string | null;
  checkSuiteId: number | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
};
/** `state: 'unparsed'`: this item (only this one) did not match the expected shape; its context is kept when readable ('' otherwise). */
export type StatusFact = {
  id: number;
  context: string;
  state: string;
  creator: { id: number; login: string; type: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
};
export type PullRequestFacts = {
  pullRequestId: number;
  nodeId: string;
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  headRepositoryId: number | null;
  baseRef: string;
  baseSha: string;
  mergeCommitSha: string | null;
  /** GitHub's tri-state: true, false, or null while it is still computing. */
  mergeable: boolean | null;
  mergeableState: string | null;
  author: { id: number; login: string; type: string };
};
/** `unless`: a light read — when the open PR still has exactly this head and base (and, ticket 16, this draft flag when given), only the PR is
 * read and `unchanged` is returned. */
export type PullRequestQuery = { repo: GitHubScope; number: number; unless?: { headSha: string; baseRef: string; draft?: boolean } };
/** Base tip and requirements (classic + rules), read at collection start and again at its end. */
export type Requirements = { baseTip: Known<string>; classic: Known<ClassicChecks>; rules: Known<BranchRule[]> };
/** Separate GET reads under one reduced `checks-read` grant: NOT an atomic snapshot; the PR and the requirements are re-read at the end. */
export type PullRequestObservation =
  | { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; code: string; waitSeconds?: number; nextStep: string }
  | { kind: 'unchanged'; source: 'github-rest'; observedAt: string; repository: string; headSha: string; baseRef: string }
  | ({
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      completedAt: string;
      repository: string;
      repositoryId: number;
      pullRequest: PullRequestFacts;
      checkRuns: Known<CheckRunFact[]>;
      statuses: Known<StatusFact[]>;
      /** Base tip...head comparison (strict up-to-date facts); null when the base tip is unknown. */
      comparison: Known<{ status: string; aheadBy: number; behindBy: number }> | null;
      recheck: Known<{ headSha: string; baseRef: string; state: 'open' | 'closed'; merged: boolean }>;
      /** Requirements re-read after the results (spec §9.2 step 6); a difference from the start invalidates the evaluation. */
      final: Requirements;
      limitations: string[];
    } & Requirements);

/** GitHub lists check runs of at most the latest 1000 check suites of a ref: a listing that reaches 1000 items may be capped. */
export const checkRunsCap = 1000;
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const id = z.number().int().positive().safe();
const user = z.object({ id, login: z.string().min(1).max(256), type: z.string().max(64) });
const pullSchema = z.object({
  id,
  node_id: z.string().min(1).max(256),
  number: id,
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string().max(64).nullable().optional(),
  merge_commit_sha: sha.nullable().optional(),
  head: z.object({ ref: z.string().min(1).max(512), sha, repo: z.object({ id }).nullable() }),
  base: z.object({ ref: z.string().min(1).max(512), sha }),
  user,
});
const context = z.string().min(1).max(255);
// app_id/integration_id null, absent or non-positive (GitHub's "any source") is any source.
const integration = z
  .number()
  .int()
  .safe()
  .nullable()
  .optional()
  .transform(value => (value !== null && value !== undefined && value > 0 ? value : null));
const branchSchema = z.object({
  commit: z.object({ sha }),
  protected: z.boolean(),
  protection: z
    .object({
      enabled: z.boolean().optional(),
      required_status_checks: z.object({ enforcement_level: z.string().max(32).optional(), contexts: z.array(context).optional() }).optional(),
    })
    .optional(),
});
const enabled = z.object({ enabled: z.boolean() });
// Every setting must be present: a missing one is unknown, never `false` (no green from an absent field).
const protectionSchema = z.object({
  lock_branch: enabled,
  required_signatures: enabled,
  required_linear_history: enabled,
  restrictions: z.unknown().optional(),
});
const classicSchema = z.object({
  strict: z.boolean(),
  contexts: z.array(context).max(500),
  checks: z
    .array(z.object({ context, app_id: integration }))
    .max(500)
    .optional(),
});
const ruleSchema = z.object({
  type: z.string().min(1).max(64),
  ruleset_id: id.optional(),
  ruleset_source_type: z.string().max(64).optional(),
  ruleset_source: z.string().max(256).optional(),
  parameters: z.unknown().optional(),
});
const statusChecksParameters = z.object({
  strict_required_status_checks_policy: z.boolean(),
  required_status_checks: z.array(z.object({ context, integration_id: integration })).max(500),
});
// Absent parameters are GitHub's defaults (no fetch-and-merge allowance; no restriction from the rule); a present but different shape is unparsed.
const updateParameters = z.object({ update_allows_fetch_and_merge: z.boolean().optional() }).optional();
const pullRequestParameters = z
  .object({
    allowed_merge_methods: z.array(z.string().min(1).max(32)).max(8).optional(),
    required_approving_review_count: z.number().int().nonnegative().safe().optional(),
    require_code_owner_review: z.boolean().optional(),
    require_last_push_approval: z.boolean().optional(),
    required_review_thread_resolution: z.boolean().optional(),
    dismiss_stale_reviews_on_push: z.boolean().optional(),
  })
  .optional();
const deploymentsParameters = z.object({ required_deployment_environments: z.array(z.string().min(1).max(255)).max(100) });
const runSchema = z.object({
  id,
  name: context,
  head_sha: sha,
  status: z.string().max(32),
  conclusion: z.string().max(32).nullable(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  app: z
    .object({ id, slug: z.string().max(256).optional() })
    .nullable()
    .optional(),
  check_suite: z.object({ id }).nullable().optional(),
  html_url: z.string().nullable().optional(),
});
const statusSchema = z.object({
  id,
  context,
  state: z.string().max(32),
  creator: user.nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  target_url: z.string().max(2048).nullable().optional(),
});

const path = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
const known = <T>(read: GitHubRead<T>): Known<T> =>
  read.ok
    ? { state: 'complete', value: read.value }
    : { state: 'unknown', code: read.code, ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: read.nextStep };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidGitHubObservation();
  return parsed.data;
};
/** The readable identity of an item that failed its schema (only that item becomes unknown). */
const field = (value: unknown, name: string, schema: z.ZodType<string | number>) => {
  const parsed = schema.safeParse(value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined);
  return parsed.success ? parsed.data : null;
};
const facts = (pull: z.infer<typeof pullSchema>): PullRequestFacts => ({
  pullRequestId: pull.id,
  nodeId: pull.node_id,
  number: pull.number,
  url: pull.html_url,
  state: pull.state,
  merged: pull.merged,
  draft: pull.draft,
  headRef: pull.head.ref,
  headSha: pull.head.sha,
  headRepositoryId: pull.head.repo?.id ?? null,
  baseRef: pull.base.ref,
  baseSha: pull.base.sha,
  mergeCommitSha: pull.merge_commit_sha ?? null,
  mergeable: pull.mergeable,
  mergeableState: pull.mergeable_state ?? null,
  author: { id: pull.user.id, login: pull.user.login, type: pull.user.type },
});
const rule = (raw: unknown): BranchRule => {
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success)
    return {
      type: (field(raw, 'type', z.string().min(1).max(64)) as string | null) ?? 'unparsed',
      ruleset: { id: field(raw, 'ruleset_id', id) as number | null, sourceType: null, source: null },
      unparsed: true,
    };
  const item = parsed.data;
  const ruleset = { id: item.ruleset_id ?? null, sourceType: item.ruleset_source_type ?? null, source: item.ruleset_source ?? null };
  if (item.type === 'update') {
    const parsed = updateParameters.safeParse(item.parameters);
    return parsed.success
      ? { type: item.type, ruleset, parameters: { kind: 'update', updateAllowsFetchAndMerge: parsed.data?.update_allows_fetch_and_merge ?? false } }
      : { type: item.type, ruleset, unparsed: true };
  }
  if (item.type === 'pull_request') {
    const parsed = pullRequestParameters.safeParse(item.parameters);
    if (!parsed.success) return { type: item.type, ruleset, unparsed: true };
    const value = parsed.data;
    return {
      type: item.type,
      ruleset,
      parameters: {
        kind: 'pull_request',
        allowedMergeMethods: value?.allowed_merge_methods ?? null,
        requiredApprovingReviewCount: value?.required_approving_review_count ?? null,
        requireCodeOwnerReview: value?.require_code_owner_review ?? null,
        requireLastPushApproval: value?.require_last_push_approval ?? null,
        requiredReviewThreadResolution: value?.required_review_thread_resolution ?? null,
        dismissStaleReviewsOnPush: value?.dismiss_stale_reviews_on_push ?? null,
      },
    };
  }
  if (item.type === 'required_deployments') {
    const parsed = deploymentsParameters.safeParse(item.parameters);
    return parsed.success
      ? { type: item.type, ruleset, parameters: { kind: 'required_deployments', environments: parsed.data.required_deployment_environments } }
      : { type: item.type, ruleset, unparsed: true };
  }
  if (item.type !== 'required_status_checks') return { type: item.type, ruleset };
  const parameters = statusChecksParameters.safeParse(item.parameters);
  return parameters.success
    ? {
        type: item.type,
        ruleset,
        statusChecks: {
          strict: parameters.data.strict_required_status_checks_policy,
          checks: parameters.data.required_status_checks.map(check => ({ context: check.context, integrationId: check.integration_id })),
        },
      }
    : { type: item.type, ruleset, unparsed: true };
};
const run = (raw: unknown, head: string): CheckRunFact => {
  const parsed = runSchema.safeParse(raw);
  if (!parsed.success)
    return {
      id: (field(raw, 'id', id) as number | null) ?? 0,
      name: (field(raw, 'name', context) as string | null) ?? '',
      headSha: head,
      status: 'unparsed',
      conclusion: null,
      appId: null,
      appSlug: null,
      checkSuiteId: null,
      startedAt: null,
      completedAt: null,
      url: null,
    };
  const item = parsed.data;
  return {
    id: item.id,
    name: item.name,
    headSha: item.head_sha,
    status: item.status,
    conclusion: item.conclusion,
    appId: item.app?.id ?? null,
    appSlug: item.app?.slug ?? null,
    checkSuiteId: item.check_suite?.id ?? null,
    startedAt: item.started_at ?? null,
    completedAt: item.completed_at ?? null,
    url: item.html_url ?? null,
  };
};
const status = (raw: unknown): StatusFact => {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success)
    return {
      id: (field(raw, 'id', id) as number | null) ?? 0,
      context: (field(raw, 'context', context) as string | null) ?? '',
      state: 'unparsed',
      creator: null,
      createdAt: null,
      updatedAt: null,
      url: null,
    };
  const item = parsed.data;
  return {
    id: item.id,
    context: item.context,
    state: item.state,
    creator: item.creator ?? null,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
    url: item.target_url ?? null,
  };
};

export function createPullRequestReader(options: { github: GitHubAccess }) {
  const read = <T>(repo: GitHubScope, inspect: (session: GitHubSession) => Promise<T>) => options.github.read(repo, 'checks-read', inspect);
  /** Base branch: tip and the classic protection summary; strictness/integrations from the protection detail; then every active rule. */
  async function requirements(repo: GitHubScope, base: string): Promise<Requirements> {
    const branch = await read(repo, async session => parse(branchSchema, await session.get(`/repos/${repo.repository}/branches/${path(base)}`)));
    const baseTip: Known<string> = branch.ok ? { state: 'complete', value: branch.value.commit.sha } : known(branch);
    let classic: Known<ClassicChecks>;
    const protection = branch.ok ? branch.value.protection : undefined;
    // V-09.f: classic protection exists unless the branch read proves otherwise; then its merge-blocking settings are read in full.
    const settings = async (): Promise<Known<ClassicSettings | null>> => {
      if (!branch.ok || !branch.value.protected || protection?.enabled === false) return { state: 'complete', value: null };
      return known(
        await read(repo, async session => {
          const full = parse(protectionSchema, await session.get(`/repos/${repo.repository}/branches/${path(base)}/protection`));
          return {
            lockBranch: full.lock_branch.enabled,
            requiredSignatures: full.required_signatures.enabled,
            requiredLinearHistory: full.required_linear_history.enabled,
            pushRestrictions: full.restrictions !== undefined && full.restrictions !== null,
          };
        }),
      );
    };
    let checks: Known<
      Omit<Extract<ClassicChecks, { kind: 'required' }>, 'settings'> | { kind: 'none'; evidence: 'BRANCH_NOT_PROTECTED' | 'STATUS_CHECKS_NOT_ENFORCED' }
    >;
    if (!branch.ok) checks = known(branch);
    else if (!branch.value.protected) checks = { state: 'complete', value: { kind: 'none', evidence: 'BRANCH_NOT_PROTECTED' } };
    else if (!protection?.required_status_checks?.enforcement_level)
      checks = {
        state: 'unknown',
        code: 'CLASSIC_PROTECTION_SUMMARY_ABSENT',
        nextStep: 'The base is protected but its required status checks summary was not returned; classic requirements are unknown.',
      };
    else if (protection.enabled === false || protection.required_status_checks.enforcement_level === 'off') {
      checks = { state: 'complete', value: { kind: 'none', evidence: 'STATUS_CHECKS_NOT_ENFORCED' } };
    } else {
      const enforcement = protection.required_status_checks.enforcement_level;
      checks = known(
        await read(repo, async session => {
          const detail = parse(classicSchema, await session.get(`/repos/${repo.repository}/branches/${path(base)}/protection/required_status_checks`));
          const found: RequiredCheck[] = (detail.checks ?? []).map(item => ({ context: item.context, integrationId: item.app_id }));
          // Legacy `contexts` without a `checks` entry: any source.
          for (const name of detail.contexts) if (!found.some(item => item.context === name)) found.push({ context: name, integrationId: null });
          return { kind: 'required' as const, strict: detail.strict, enforcement, checks: found };
        }),
      );
    }
    const merge = checks.state === 'complete' ? await settings() : null;
    classic =
      checks.state !== 'complete' ? checks : merge!.state !== 'complete' ? merge! : { state: 'complete', value: { ...checks.value, settings: merge!.value } };
    // Active rules of the base, including those inherited from organization/enterprise rulesets (GitHub lists only active rules).
    const rules = known(
      await read(repo, async session => (await session.list(`/repos/${repo.repository}/rules/branches/${path(base)}`, { maxPages: 10 })).map(rule)),
    );
    return { baseTip, classic, rules };
  }
  return async function readPullRequest(query: PullRequestQuery): Promise<PullRequestObservation> {
    const { repo, number } = query;
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('INVALID_PULL_REQUEST');
    const pullOf = async (session: GitHubSession) => {
      const pull = parse(pullSchema, await session.get(`/repos/${repo.repository}/pulls/${number}`));
      if (pull.number !== number || pull.html_url.toLowerCase() !== `https://github.com/${repo.repository}/pull/${number}`.toLowerCase())
        throw new InvalidGitHubObservation();
      return pull;
    };
    const first = await read(repo, pullOf);
    if (!first.ok)
      return {
        kind: 'unavailable',
        source: 'github-rest',
        observedAt: first.observedAt,
        repository: repo.repository,
        code: first.code,
        ...(first.waitSeconds !== undefined ? { waitSeconds: first.waitSeconds } : {}),
        nextStep: `The pull request could not be read; nothing about its checks is concluded. ${first.nextStep}`,
      };
    const pull = facts(first.value);
    if (
      query.unless &&
      pull.state === 'open' &&
      !pull.merged &&
      pull.headSha === query.unless.headSha &&
      pull.baseRef === query.unless.baseRef &&
      (query.unless.draft === undefined || pull.draft === query.unless.draft)
    ) {
      return {
        kind: 'unchanged',
        source: 'github-rest',
        observedAt: first.observedAt,
        repository: repo.repository,
        headSha: pull.headSha,
        baseRef: pull.baseRef,
      };
    }
    const base = pull.baseRef;
    if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(base))
      return {
        kind: 'unavailable',
        source: 'github-rest',
        observedAt: first.observedAt,
        repository: repo.repository,
        code: 'INVALID_GITHUB_PAYLOAD',
        nextStep: 'The pull request base is not a supported branch name; nothing about its checks is concluded.',
      };
    const start = await requirements(repo, base);
    // Every attempt of every check run and every status of the CURRENT head (complete pagination; an item that fails its schema is unknown alone).
    let checkRuns = known(
      await read(repo, async session =>
        (await session.list(`/repos/${repo.repository}/commits/${pull.headSha}/check-runs?filter=all`, { maxPages: 10, items: 'check_runs' })).map(item =>
          run(item, pull.headSha),
        ),
      ),
    );
    if (checkRuns.state === 'complete' && checkRuns.value.length >= checkRunsCap)
      checkRuns = {
        state: 'unknown',
        code: 'CHECK_RUNS_LIMIT_REACHED',
        nextStep: `GitHub lists check runs of at most ${checkRunsCap} check suites per ref: results may be missing, completeness is not concluded.`,
      };
    const statuses = known(
      await read(repo, async session => (await session.list(`/repos/${repo.repository}/commits/${pull.headSha}/statuses`, { maxPages: 10 })).map(status)),
    );
    const tip = start.baseTip;
    const comparison =
      tip.state !== 'complete'
        ? null
        : known(
            await read(repo, async session => {
              const compared = parse(
                z.object({ status: z.string().max(32), ahead_by: z.number().int().nonnegative().safe(), behind_by: z.number().int().nonnegative().safe() }),
                await session.get(`/repos/${repo.repository}/compare/${tip.value}...${pull.headSha}`),
              );
              return { status: compared.status, aheadBy: compared.ahead_by, behindBy: compared.behind_by };
            }),
          );
    const final = await requirements(repo, base);
    const again = await read(repo, pullOf);
    return {
      kind: 'observed',
      source: 'github-rest',
      observedAt: first.observedAt,
      completedAt: again.observedAt,
      repository: repo.repository,
      repositoryId: first.repositoryId,
      pullRequest: pull,
      ...start,
      checkRuns,
      statuses,
      comparison,
      final,
      recheck: again.ok
        ? { state: 'complete', value: { headSha: again.value.head.sha, baseRef: again.value.base.ref, state: again.value.state, merged: again.value.merged } }
        : known(again),
      limitations: [
        'Separate GET reads between observedAt and completedAt: not an atomic snapshot of GitHub, its rules and CI; the pull request and the requirements are re-read at the end.',
        'Results are read for the current head commit only; results attached to the test merge commit are not read.',
        'Rules are the active rules GitHub reports for the base branch (repository and inherited rulesets); classic protection is read separately.',
      ],
    };
  };
}
