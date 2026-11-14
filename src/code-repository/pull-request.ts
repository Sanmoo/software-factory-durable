import { z } from 'zod';
import type { GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess, type GitHubRead, type GitHubSession } from '../platform/github/index.js';

// Q4B `readPullRequest(pr)` (ticket 15, spec §9.2): current facts of a KNOWN own pull request and the data its applicable checks need.
// Facts only, each with its own completeness: this module never decides which requirement applies, whether it is satisfied, or readiness.

/** A fact read completely, or unknown with the read's code (a failed/partial/hidden read never stands in for absence). */
export type Known<T> = { state: 'complete'; value: T } | { state: 'unknown'; code: string; waitSeconds?: number; nextStep: string };
/** A required check as GitHub declares it: context plus the integration (GitHub App id) it must come from; null = any source. */
export type RequiredCheck = { context: string; integrationId: number | null };
/** Classic branch protection's required status checks. `none` only from an authorized complete branch read. */
export type ClassicChecks = { kind: 'none'; evidence: 'BRANCH_NOT_PROTECTED' | 'STATUS_CHECKS_NOT_ENFORCED' } |
  { kind: 'required'; strict: boolean; enforcement: string; checks: RequiredCheck[] };
/** One ACTIVE rule GitHub applies to the base (repository, organization or enterprise ruleset); `statusChecks` for required_status_checks. */
export type BranchRule = { type: string; ruleset: { id: number | null; sourceType: string | null; source: string | null };
  statusChecks?: { strict: boolean; checks: RequiredCheck[] } };
export type CheckRunFact = { id: number; name: string; headSha: string; status: string; conclusion: string | null; appId: number | null; appSlug: string | null;
  checkSuiteId: number | null; startedAt: string | null; completedAt: string | null; url: string | null };
export type StatusFact = { id: number; context: string; state: string; creator: { id: number; login: string; type: string } | null; createdAt: string | null;
  updatedAt: string | null; url: string | null };
export type PullRequestFacts = { pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean; draft: boolean;
  headRef: string; headSha: string; headRepositoryId: number | null; baseRef: string; baseSha: string; mergeCommitSha: string | null;
  /** GitHub's tri-state: true, false, or null while it is still computing. */
  mergeable: boolean | null; mergeableState: string | null; author: { id: number; login: string; type: string } };
export type PullRequestQuery = { repo: GitHubScope; number: number };
/** Separate GET reads under one reduced `checks-read` grant: NOT an atomic snapshot; `recheck` re-reads the PR after the collection. */
export type PullRequestObservation = { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; code: string; waitSeconds?: number; nextStep: string } |
  { kind: 'observed'; source: 'github-rest'; observedAt: string; completedAt: string; repository: string; repositoryId: number; pullRequest: PullRequestFacts;
    baseTip: Known<string>; classic: Known<ClassicChecks>; rules: Known<BranchRule[]>; checkRuns: Known<CheckRunFact[]>; statuses: Known<StatusFact[]>;
    /** Base tip...head comparison (strict up-to-date facts); null when the base tip is unknown. */
    comparison: Known<{ status: string; aheadBy: number; behindBy: number }> | null;
    recheck: Known<{ headSha: string; baseRef: string; state: 'open' | 'closed'; merged: boolean }>; limitations: string[] };

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const id = z.number().int().positive().safe();
const user = z.object({ id, login: z.string().min(1).max(256), type: z.string().max(64) });
const pullSchema = z.object({ id, node_id: z.string().min(1).max(256), number: id, html_url: z.string().url(), state: z.enum(['open', 'closed']),
  draft: z.boolean(), merged: z.boolean(), mergeable: z.boolean().nullable(), mergeable_state: z.string().max(64).nullable().optional(), merge_commit_sha: sha.nullable().optional(),
  head: z.object({ ref: z.string().min(1).max(512), sha, repo: z.object({ id }).nullable() }), base: z.object({ ref: z.string().min(1).max(512), sha }), user });
const context = z.string().min(1).max(255);
// app_id/integration_id null, absent or non-positive (GitHub's "any source") is any source.
const integration = z.number().int().safe().nullable().optional().transform(value => value !== null && value !== undefined && value > 0 ? value : null);
const branchSchema = z.object({ commit: z.object({ sha }), protected: z.boolean(), protection: z.object({ enabled: z.boolean().optional(),
  required_status_checks: z.object({ enforcement_level: z.string().max(32).optional(), contexts: z.array(context).optional() }).optional() }).optional() });
const classicSchema = z.object({ strict: z.boolean(), contexts: z.array(context).max(500), checks: z.array(z.object({ context, app_id: integration })).max(500).optional() });
const ruleSchema = z.object({ type: z.string().min(1).max(64), ruleset_id: id.optional(), ruleset_source_type: z.string().max(64).optional(),
  ruleset_source: z.string().max(256).optional(), parameters: z.unknown().optional() });
const statusChecksParameters = z.object({ strict_required_status_checks_policy: z.boolean(),
  required_status_checks: z.array(z.object({ context, integration_id: integration })).max(500) });
const runSchema = z.object({ id, name: context, head_sha: sha, status: z.string().max(32), conclusion: z.string().max(32).nullable(),
  started_at: z.string().nullable().optional(), completed_at: z.string().nullable().optional(), app: z.object({ id, slug: z.string().max(256).optional() }).nullable().optional(),
  check_suite: z.object({ id }).nullable().optional(), html_url: z.string().nullable().optional() });
const statusSchema = z.object({ id, context, state: z.string().max(32), creator: user.nullable().optional(), created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(), target_url: z.string().max(2048).nullable().optional() });

const path = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
const known = <T>(read: GitHubRead<T>): Known<T> => read.ok ? { state: 'complete', value: read.value }
  : { state: 'unknown', code: read.code, ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: read.nextStep };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidGitHubObservation();
  return parsed.data;
};
const facts = (pull: z.infer<typeof pullSchema>): PullRequestFacts => ({ pullRequestId: pull.id, nodeId: pull.node_id, number: pull.number, url: pull.html_url,
  state: pull.state, merged: pull.merged, draft: pull.draft, headRef: pull.head.ref, headSha: pull.head.sha, headRepositoryId: pull.head.repo?.id ?? null,
  baseRef: pull.base.ref, baseSha: pull.base.sha, mergeCommitSha: pull.merge_commit_sha ?? null, mergeable: pull.mergeable, mergeableState: pull.mergeable_state ?? null,
  author: { id: pull.user.id, login: pull.user.login, type: pull.user.type } });

export function createPullRequestReader(options: { github: GitHubAccess }) {
  const read = <T>(repo: GitHubScope, inspect: (session: GitHubSession) => Promise<T>) => options.github.read(repo, 'checks-read', inspect);
  return async function readPullRequest(query: PullRequestQuery): Promise<PullRequestObservation> {
    const { repo, number } = query;
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('INVALID_PULL_REQUEST');
    const pullOf = async (session: GitHubSession) => {
      const pull = parse(pullSchema, await session.get(`/repos/${repo.repository}/pulls/${number}`));
      if (pull.number !== number || pull.html_url.toLowerCase() !== `https://github.com/${repo.repository}/pull/${number}`.toLowerCase()) throw new InvalidGitHubObservation();
      return pull;
    };
    const first = await read(repo, pullOf);
    if (!first.ok) return { kind: 'unavailable', source: 'github-rest', observedAt: first.observedAt, repository: repo.repository, code: first.code,
      ...(first.waitSeconds !== undefined ? { waitSeconds: first.waitSeconds } : {}), nextStep: `The pull request could not be read; nothing about its checks is concluded. ${first.nextStep}` };
    const pull = facts(first.value);
    const base = pull.baseRef;
    if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(base)) return { kind: 'unavailable', source: 'github-rest', observedAt: first.observedAt, repository: repo.repository,
      code: 'INVALID_GITHUB_PAYLOAD', nextStep: 'The pull request base is not a supported branch name; nothing about its checks is concluded.' };
    // Base branch: tip and the classic protection summary (enforcement of required status checks); strictness and integrations need the
    // protection detail. `none` only from this authorized complete read; a hidden/denied detail is unknown.
    const branch = await read(repo, async session => parse(branchSchema, await session.get(`/repos/${repo.repository}/branches/${path(base)}`)));
    const baseTip: Known<string> = branch.ok ? { state: 'complete', value: branch.value.commit.sha } : known(branch);
    let classic: Known<ClassicChecks>;
    if (!branch.ok) classic = known(branch);
    else if (!branch.value.protected) classic = { state: 'complete', value: { kind: 'none', evidence: 'BRANCH_NOT_PROTECTED' } };
    else if (!branch.value.protection?.required_status_checks?.enforcement_level) classic = { state: 'unknown', code: 'CLASSIC_PROTECTION_SUMMARY_ABSENT',
      nextStep: 'The base is protected but its required status checks summary was not returned; classic requirements are unknown.' };
    else if (branch.value.protection.enabled === false || branch.value.protection.required_status_checks.enforcement_level === 'off') {
      classic = { state: 'complete', value: { kind: 'none', evidence: 'STATUS_CHECKS_NOT_ENFORCED' } };
    } else {
      const enforcement = branch.value.protection.required_status_checks.enforcement_level;
      classic = known(await read(repo, async session => {
        const detail = parse(classicSchema, await session.get(`/repos/${repo.repository}/branches/${path(base)}/protection/required_status_checks`));
        const checks: RequiredCheck[] = (detail.checks ?? []).map(item => ({ context: item.context, integrationId: item.app_id }));
        // Legacy `contexts` without a `checks` entry: any source.
        for (const name of detail.contexts) if (!checks.some(item => item.context === name)) checks.push({ context: name, integrationId: null });
        return { kind: 'required' as const, strict: detail.strict, enforcement, checks };
      }));
    }
    // Active rules of the base, including those inherited from organization/enterprise rulesets (GitHub lists only active rules).
    const rules = known(await read(repo, async session => parse(z.array(ruleSchema), await session.list(`/repos/${repo.repository}/rules/branches/${path(base)}`, { maxPages: 10 }))
      .map((rule): BranchRule => ({ type: rule.type, ruleset: { id: rule.ruleset_id ?? null, sourceType: rule.ruleset_source_type ?? null, source: rule.ruleset_source ?? null },
        ...(rule.type === 'required_status_checks' ? { statusChecks: ((parameters: z.infer<typeof statusChecksParameters>) => ({
          strict: parameters.strict_required_status_checks_policy,
          checks: parameters.required_status_checks.map(item => ({ context: item.context, integrationId: item.integration_id })) }))(parse(statusChecksParameters, rule.parameters)) } : {}) }))));
    // Every attempt of every check run and every status of the CURRENT head (complete pagination; 1000 items at most, else unknown).
    const checkRuns = known(await read(repo, async session => parse(z.array(runSchema), await session.list(`/repos/${repo.repository}/commits/${pull.headSha}/check-runs?filter=all`,
      { maxPages: 10, items: 'check_runs' })).map((run): CheckRunFact => ({ id: run.id, name: run.name, headSha: run.head_sha, status: run.status, conclusion: run.conclusion,
      appId: run.app?.id ?? null, appSlug: run.app?.slug ?? null, checkSuiteId: run.check_suite?.id ?? null, startedAt: run.started_at ?? null, completedAt: run.completed_at ?? null,
      url: run.html_url ?? null }))));
    const statuses = known(await read(repo, async session => parse(z.array(statusSchema), await session.list(`/repos/${repo.repository}/commits/${pull.headSha}/statuses`, { maxPages: 10 }))
      .map((item): StatusFact => ({ id: item.id, context: item.context, state: item.state, creator: item.creator ?? null, createdAt: item.created_at ?? null,
        updatedAt: item.updated_at ?? null, url: item.target_url ?? null }))));
    const comparison = baseTip.state !== 'complete' ? null : known(await read(repo, async session => {
      const compared = parse(z.object({ status: z.string().max(32), ahead_by: z.number().int().nonnegative().safe(), behind_by: z.number().int().nonnegative().safe() }),
        await session.get(`/repos/${repo.repository}/compare/${baseTip.value}...${pull.headSha}`));
      return { status: compared.status, aheadBy: compared.ahead_by, behindBy: compared.behind_by };
    }));
    const again = await read(repo, pullOf);
    return { kind: 'observed', source: 'github-rest', observedAt: first.observedAt, completedAt: again.observedAt, repository: repo.repository, repositoryId: first.repositoryId,
      pullRequest: pull, baseTip, classic, rules, checkRuns, statuses, comparison,
      recheck: again.ok ? { state: 'complete', value: { headSha: again.value.head.sha, baseRef: again.value.base.ref, state: again.value.state, merged: again.value.merged } } : known(again),
      limitations: ['Separate GET reads between observedAt and completedAt: not an atomic snapshot of GitHub, its rules and CI; the pull request is re-read at the end.',
        'Results are read for the current head commit only; results attached to the test merge commit are not read.',
        'Rules are the active rules GitHub reports for the base branch (repository and inherited rulesets); classic protection is read separately.'] };
  };
}
