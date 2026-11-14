import { z } from 'zod';
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess } from '../platform/github/index.js';
import { createPullRequestReader, type PullRequestObservation, type PullRequestQuery } from './pull-request.js';

export type { BranchRule, CheckRunFact, ClassicChecks, Known, PullRequestFacts, PullRequestObservation, PullRequestQuery, RequiredCheck, StatusFact } from './pull-request.js';
import { deliveryOperations, type BranchCleanupResult, type BranchCleanupSelection, type CleanupEffect, type PullRequestObservation, type PullRequestRef } from './delivery.js';

/** Known repository/branch identities and the Ticket numbers they serve; the caller decides ownership, never this adapter.
 * Several Tickets of one repository share ONE pull request listing per call (bounded polling cost). */
export type PublicationCorrelation = { repo: GitHubScope; issueNumbers: number[]; knownBranches: string[];
  /** Ticket 14: also report every branch/tag tip of the repository (complete listings) and whether `base` requires pull requests with no
   * bypass for the reading App (rulesets / classic protection). Refs and rules are facts; Control decides. */
  refs?: boolean; base?: string };
/** Repository-wide branch/tag tips (`refs/heads/x`, `refs/tags/y`) from complete listings; a failed or capped read is unknown. */
export type RefsListing = { state: 'complete'; refs: Record<string, string> } | { state: 'unknown'; code: string };
/** `pull-request-required`: an active pull_request rule the App cannot bypass (ruleset `current_user_can_bypass: never`) or classic
 * required reviews without App bypass allowances. Never a certification of the team's barriers (spec §2.1/§8). */
export type BaseProtection = { state: 'pull-request-required'; sources: string[] } | { state: 'not-required'; reason: string } | { state: 'unknown'; code: string };
export type PullRequestCandidate = {
  pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean;
  headRef: string; headRepositoryId: number | null; author: { id: number; login: string; type: string };
  association: ('closing-reference' | 'cross-reference' | 'development-link' | 'known-branch')[];
  /** Ticket 14: facts Control needs to recognize its OWN publication (head commit, base, draft flag, body with the correlation marker). */
  headSha: string; baseRef: string; draft: boolean; body: string | null;
};
/** Tip of a known own branch as read from the remote: a complete listing proves `absent`; a failed read is `unknown`, never absence. */
export type BranchRef = { state: 'present'; sha: string } | { state: 'absent' } | { state: 'unknown'; code: string; nextStep: string };
/** Per Ticket: complete association, or incomplete (never an empty list standing in for absence). */
export type IssuePublication = { completeness: 'complete'; candidates: PullRequestCandidate[] } |
  { completeness: 'incomplete'; code: string; waitSeconds?: number; nextStep: string };
/** An unavailable query never proves the absence of an associated or own pull request. */
export type PublicationObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; repository: string; repositoryId: number;
  issues: Record<string, IssuePublication>; limitations: string[];
  /** One entry per known branch (empty when none was given, e.g. admission). */
  branches: Record<string, BranchRef>; refs?: RefsListing; baseProtection?: BaseProtection } |
  { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; completeness: 'incomplete'; code: string; waitSeconds?: number; nextStep: string };

/** Outcome of one draft/ready conversion. `applied`: GitHub's answer to the mutation (not yet the independent observation Control requires);
 * `known-failure`: certainly not applied; `unknown`: may have been applied — read the pull request before any repetition. */
export type DraftConversion = { kind: 'applied'; observedAt: string; draft: boolean; headSha: string; revocation: string } |
  { kind: 'known-failure' | 'unknown'; observedAt: string; code: string; waitSeconds?: number; nextStep: string; revocation: string };

export interface CodeRepository {
  checkAccess(repo: GitHubScope, base: string): Promise<AccessDiagnostic>;
  findPublication(correlation: PublicationCorrelation): Promise<PublicationObservation>;
  /** Q4B `readPullRequest` (ticket 15): current facts of a known own PR and the data its applicable checks need; never decides readiness. */
  readPullRequest(query: PullRequestQuery): Promise<PullRequestObservation>;
  /** Q4B `setDraft(pr, draft, effect)` (ticket 16): one draft/ready conversion of a known own PR, correlated by the effect identity. The
   * decision and its evidence belong to Control; a remote flag never stands in for internal readiness. Never review, approval or merge. */
  setDraft(pr: { repo: GitHubScope; number: number; nodeId: string }, draft: boolean, effect: { effectId: string }): Promise<DraftConversion>;
  /** Ticket 17 (Q4B): current facts of a KNOWN own pull request (merge/closure/head/base). Not a delivery decision. */
  readPullRequest?(pr: PullRequestRef): Promise<PullRequestObservation>;
  /** Ticket 17 (Q4B): delete ONE selected own branch under its own cleanup grant, revalidating ownership/concurrency first. */
  cleanupBranch?(selection: BranchCleanupSelection, effect: CleanupEffect): Promise<BranchCleanupResult>;
}
export type { PullRequestRef, PullRequestFacts, PullRequestObservation, BranchCleanupSelection, CleanupEffect, BranchCleanupResult } from './delivery.js';

const pullSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), number: z.number().int().positive().safe(), html_url: z.string().url(),
  state: z.enum(['open', 'closed']), merged_at: z.string().nullable().optional(), title: z.string().nullable().optional(), body: z.string().nullable().optional(),
  draft: z.boolean(),
  head: z.object({ ref: z.string().min(1).max(512), sha: z.string().regex(/^[0-9a-f]{40}$/), repo: z.object({ id: z.number().int().positive().safe() }).nullable() }),
  base: z.object({ ref: z.string().min(1).max(512) }),
  user: z.object({ id: z.number().int().positive().safe(), login: z.string(), type: z.string() }),
});
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const timelineSchema = z.array(z.object({ event: z.string(), source: z.object({ issue: z.object({
  number: z.number().int().positive().safe(), html_url: z.string().url(), pull_request: z.unknown().optional() }).optional() }).optional() }));
type Pull = z.infer<typeof pullSchema>;

export function createCodeRepository(options: { github: GitHubAccess }): CodeRepository {
  async function associate(repo: GitHubScope, issueNumber: number, pulls: Pull[], repositoryId: number, knownBranches: string[]): Promise<IssuePublication> {
    // GitHub closing keywords referring to THIS repository's issue (#N, owner/repo#N or its URL).
    const target = `(?:(?:${escape(repo.repository)})?#${issueNumber}|https://github\\.com/${escape(repo.repository)}/issues/${issueNumber})(?![0-9A-Za-z_/-])`;
    const closing = new RegExp(`(?:^|[^A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+${target}`, 'i');
    const timeline = await options.github.read(repo, 'association-read', async session => {
      const parsed = timelineSchema.safeParse(await session.list(`/repos/${repo.repository}/issues/${issueNumber}/timeline`));
      if (!parsed.success) throw new InvalidGitHubObservation();
      return parsed.data;
    });
    if (!timeline.ok) return { completeness: 'incomplete', code: timeline.code, ...(timeline.waitSeconds !== undefined ? { waitSeconds: timeline.waitSeconds } : {}),
      nextStep: `Issue timeline unavailable; associated pull requests are unknown. ${timeline.nextStep}` };
    const linked = new Map<number, Set<PullRequestCandidate['association'][number]>>();
    const add = (number: number, kind: PullRequestCandidate['association'][number]) => linked.set(number, (linked.get(number) ?? new Set()).add(kind));
    const ownPull = new RegExp(`^https://github\\.com/${escape(repo.repository)}/pull/(\\d+)$`, 'i');
    let unidentifiedLinks = 0;
    for (const event of timeline.value) {
      const source = event.source?.issue;
      const number = source && source.pull_request !== undefined ? Number(ownPull.exec(source.html_url)?.[1] ?? NaN) : NaN;
      if (event.event === 'cross-referenced' && Number.isSafeInteger(number)) add(number, 'cross-reference');
      else if (event.event === 'connected') { if (Number.isSafeInteger(number)) add(number, 'development-link'); else unidentifiedLinks++; }
      else if (event.event === 'disconnected') { if (Number.isSafeInteger(number)) linked.get(number)?.delete('development-link'); else unidentifiedLinks--; }
    }
    if (unidentifiedLinks > 0) return { completeness: 'incomplete', code: 'ASSOCIATION_UNIDENTIFIED',
      nextStep: 'The issue timeline shows a Development link without an identifiable pull request; associated pull requests cannot be ruled out. Operator must inspect the issue on GitHub.' };
    for (const pull of pulls) {
      if (closing.test(pull.title ?? '') || closing.test(pull.body ?? '')) add(pull.number, 'closing-reference');
      if (knownBranches.includes(pull.head.ref) && pull.head.repo?.id === repositoryId) add(pull.number, 'known-branch');
    }
    const order: PullRequestCandidate['association'] = ['closing-reference', 'cross-reference', 'development-link', 'known-branch'];
    const candidates: PullRequestCandidate[] = [];
    for (const [number, kinds] of [...linked].sort(([a], [b]) => a - b)) {
      if (!kinds.size) continue;
      const pull = pulls.find(item => item.number === number);
      if (!pull) return { completeness: 'incomplete', code: 'ASSOCIATED_PULL_REQUEST_NOT_LISTED',
        nextStep: `Pull request #${number} is associated by the timeline but absent from the complete listing; association cannot be evaluated.` };
      candidates.push({ pullRequestId: pull.id, nodeId: pull.node_id, number: pull.number, url: pull.html_url, state: pull.state, merged: Boolean(pull.merged_at),
        headRef: pull.head.ref, headRepositoryId: pull.head.repo?.id ?? null, author: { id: pull.user.id, login: pull.user.login, type: pull.user.type },
        association: order.filter(kind => kinds.has(kind)), headSha: pull.head.sha, baseRef: pull.base.ref, draft: pull.draft,
        // Bounded copy of the body: Control only looks for its correlation marker and checks the description's shape.
        body: typeof pull.body === 'string' ? pull.body.slice(0, 65536) : null });
    }
    return { completeness: 'complete', candidates };
  }
  /** Every branch and tag tip (bounded: more than 10 pages per kind is unknown, never a truncated snapshot). */
  async function refsListing(repo: GitHubScope): Promise<RefsListing> {
    const item = z.object({ ref: z.string().regex(/^refs\/(heads|tags)\//), object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) });
    const read = await options.github.read(repo, 'publication-read', async session => {
      const refs: Record<string, string> = {};
      for (const kind of ['heads', 'tags']) {
        const parsed = z.array(item).safeParse(await session.list(`/repos/${repo.repository}/git/matching-refs/${kind}`, { maxPages: 10 }));
        if (!parsed.success) throw new InvalidGitHubObservation();
        for (const entry of parsed.data) refs[entry.ref] = entry.object.sha;
      }
      return refs;
    });
    return read.ok ? { state: 'complete', refs: read.value } : { state: 'unknown', code: read.code };
  }
  /** Whether `base` requires a pull request for every update with no bypass for THIS App (the reading installation token is the App). */
  async function protection(repo: GitHubScope, base: string): Promise<BaseProtection> {
    if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(base)) return { state: 'unknown', code: 'INVALID_BRANCH' };
    const read = await options.github.read(repo, 'publication-read', async session => {
      const path = base.split('/').map(encodeURIComponent).join('/');
      const rules = z.array(z.object({ type: z.string(), ruleset_id: z.number().int().positive().optional() })).safeParse(await session.list(`/repos/${repo.repository}/rules/branches/${path}`));
      if (!rules.success) throw new InvalidGitHubObservation();
      const sources: string[] = [];
      for (const id of [...new Set(rules.data.filter(rule => rule.type === 'pull_request' && rule.ruleset_id).map(rule => rule.ruleset_id!))].slice(0, 10)) {
        const ruleset = z.object({ id: z.literal(id), enforcement: z.string(), current_user_can_bypass: z.string().optional() }).safeParse(await session.get(`/repos/${repo.repository}/rulesets/${id}`));
        if (!ruleset.success) throw new InvalidGitHubObservation();
        if (ruleset.data.enforcement === 'active' && ruleset.data.current_user_can_bypass === 'never') sources.push(`ruleset:${id}`);
      }
      let classic: unknown = null;
      try { classic = await session.get(`/repos/${repo.repository}/branches/${path}/protection`); }
      catch (error) { if (!(error instanceof Error && error.message === 'GITHUB_NOT_FOUND_OR_HIDDEN')) throw error; }
      const parsed = z.object({ required_pull_request_reviews: z.object({ bypass_pull_request_allowances: z.object({ apps: z.array(z.unknown()) }).optional() }).optional() }).safeParse(classic ?? {});
      if (!parsed.success) throw new InvalidGitHubObservation();
      const reviews = parsed.data.required_pull_request_reviews;
      if (reviews && !(reviews.bypass_pull_request_allowances?.apps.length)) sources.push('classic');
      return sources;
    });
    if (!read.ok) return { state: 'unknown', code: read.code };
    return read.value.length ? { state: 'pull-request-required', sources: read.value } : { state: 'not-required', reason: 'NO_PULL_REQUEST_RULE_WITHOUT_APP_BYPASS' };
  }
  /** Remote tip of one own branch: a complete matching-refs listing filtered to the exact ref (absence only from a complete listing). */
  async function branchRef(repo: GitHubScope, branch: string, repositoryId: number): Promise<BranchRef> {
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/.test(branch)) return { state: 'unknown', code: 'INVALID_BRANCH', nextStep: 'Branch name rejected locally; nothing was read.' };
    const read = await options.github.read(repo, 'publication-read', async session => {
      if (session.repositoryId !== repositoryId) throw new InvalidGitHubObservation();
      const parsed = z.array(z.object({ ref: z.string(), object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), type: z.string() }) }))
        .safeParse(await session.list(`/repos/${repo.repository}/git/matching-refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`));
      if (!parsed.success) throw new InvalidGitHubObservation();
      const exact = parsed.data.filter(item => item.ref === `refs/heads/${branch}`);
      if (exact.length > 1 || (exact[0] && exact[0].object.type !== 'commit')) throw new InvalidGitHubObservation();
      return exact[0]?.object.sha ?? null;
    });
    if (!read.ok) return { state: 'unknown', code: read.code, nextStep: `Remote branch unknown (absence not concluded). ${read.nextStep}` };
    return read.value === null ? { state: 'absent' } : { state: 'present', sha: read.value };
  }
  return {
    readPullRequest: createPullRequestReader(options),
    async setDraft(pr, draft, effect) {
      const written = await options.github.setDraft(pr.repo, { number: pr.number, nodeId: pr.nodeId }, draft, effect.effectId);
      if (written.ok) {
        const value = written.value as { draft: boolean; headSha: string };
        return { kind: 'applied', observedAt: written.observedAt, draft: value.draft, headSha: value.headSha, revocation: written.revocation };
      }
      return { kind: written.outcome, observedAt: written.observedAt, code: written.code, ...(written.waitSeconds !== undefined ? { waitSeconds: written.waitSeconds } : {}),
        nextStep: written.nextStep, revocation: written.revocation };
    },
    ...deliveryOperations(options),
    checkAccess(repo, base) {
      return options.github.diagnose(repo, 'repository', async session => {
        if (!base || /[\x00-\x20\x7f]/.test(base)) throw new InvalidGitHubObservation();
        const branch = await session.get(`/repos/${repo.repository}/branches/${encodeURIComponent(base)}`);
        if (!z.object({ name: z.literal(base), commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }).safeParse(branch).success) throw new InvalidGitHubObservation();
      });
    },
    async findPublication(correlation) {
      const { repo } = correlation;
      const numbers = [...new Set(correlation.issueNumbers)];
      if (!numbers.length || numbers.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('INVALID_PUBLICATION_CORRELATION');
      const pulls = await options.github.read(repo, 'repository-read', async session => {
        const parsed = z.array(pullSchema).safeParse(await session.list(`/repos/${repo.repository}/pulls?state=all`));
        if (!parsed.success) throw new InvalidGitHubObservation();
        const unique = new Map<number, z.infer<typeof pullSchema>>();
        for (const pull of parsed.data) {
          if (pull.html_url.toLowerCase() !== `https://github.com/${repo.repository}/pull/${pull.number}`.toLowerCase()) throw new InvalidGitHubObservation();
          unique.set(pull.number, pull);
        }
        return [...unique.values()];
      });
      if (!pulls.ok) return { kind: 'unavailable', source: 'github-rest', observedAt: pulls.observedAt, repository: repo.repository, completeness: 'incomplete', code: pulls.code,
        ...(pulls.waitSeconds !== undefined ? { waitSeconds: pulls.waitSeconds } : {}), nextStep: pulls.nextStep };
      const issues: Record<string, IssuePublication> = {};
      for (const issueNumber of numbers) issues[String(issueNumber)] = await associate(repo, issueNumber, pulls.value, pulls.repositoryId, correlation.knownBranches);
      const branches: Record<string, BranchRef> = {};
      for (const branch of [...new Set(correlation.knownBranches)]) branches[branch] = await branchRef(repo, branch, pulls.repositoryId);
      const refs = correlation.refs ? await refsListing(repo) : undefined;
      const baseProtection = correlation.base !== undefined ? await protection(repo, correlation.base) : undefined;
      return { kind: 'observed', source: 'github-rest', observedAt: pulls.observedAt, repository: repo.repository, repositoryId: pulls.repositoryId, issues, branches,
        ...(refs ? { refs } : {}), ...(baseProtection ? { baseProtection } : {}), limitations: [
        ...(correlation.knownBranches.length ? ['Own branch tips are read from the remote refs (Contents read) separately from the pull request listing.'] : []),
        'Association = GitHub closing keywords in pull request title/body, native issue-timeline cross-references and Development links (connected/disconnected) for pull requests of this repository, and known own branches.',
        'Pull requests in other repositories that reference the Ticket are not treated as associated (they cannot be own publications of this repository).',
        'A Development link whose pull request is not identified in the timeline makes the Ticket incomplete, never clear.',
        'Listing and timeline are separate reads, not an atomic remote snapshot.',
      ] };
    },
  };
}
