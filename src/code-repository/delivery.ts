import { z } from 'zod';
import type { GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess, type GitHubSession } from '../platform/github/index.js';

// Ticket 17 operations of the approved CodeRepository contract (Q4B): `readPullRequest` (facts of a KNOWN own pull request, never a
// decision) and `cleanupBranch` (deletion of the selected own branch under its own cleanup grant, with ownership/concurrency checks).

/** The own pull request Control already linked (identity recorded by the publication discovery). */
export type PullRequestRef = { repo: GitHubScope; repositoryId: number; number: number; pullRequestId: number; nodeId: string };
/** Current facts of a pull request as GitHub reports them. `merged`/`mergedAt`/`mergeCommitSha` are reported, never inferred from `closed`. */
export type PullRequestFacts = { pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; draft: boolean;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; headSha: string; headRepositoryId: number | null;
  baseRef: string; baseRepositoryId: number | null };
/** An unavailable read never proves a merge, a closure or its absence. */
export type PullRequestObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; repositoryId: number; pullRequest: PullRequestFacts } |
  { kind: 'unavailable'; source: 'github-rest'; observedAt: string; code: string; waitSeconds?: number; nextStep: string };
/**
 * Selection of ONE own remote branch, already decided by Control: the Work's branch, its base (always protected), the tip the merged own
 * pull request had (the only tip the Factory can prove is its own delivered content) and that pull request.
 */
export type BranchCleanupSelection = { repo: GitHubScope; repositoryId: number; branch: string; base: string; expectedTip: string;
  pullRequest: { number: number; pullRequestId: number } };
/** Correlation of the attempt (Control's effect id); not an idempotency key on GitHub. */
export type CleanupEffect = { effectId: string };
/**
 * `removed`: deleted now and re-read absent; `absent`: a complete read found no such ref (nothing was sent); `refused`: an ownership or
 * concurrency precondition failed (the ref is kept); `failed`: a known failure, nothing deleted; `indeterminate`: the DELETE may have
 * happened (re-read before any new attempt). `revocation`: outcome of the single-use grant's self-revocation.
 */
export type BranchCleanupResult = { outcome: 'removed' | 'absent' | 'refused' | 'failed' | 'indeterminate'; code: string; observedAt: string;
  tip: string | null; revocation: string; nextStep: string; effectId: string };

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const pullSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), number: z.number().int().positive().safe(), html_url: z.string().url(),
  state: z.enum(['open', 'closed']), draft: z.boolean(), merged: z.boolean(), merged_at: z.string().nullable(), merge_commit_sha: sha.nullable(),
  head: z.object({ ref: z.string().min(1).max(512), sha, repo: z.object({ id: z.number().int().positive().safe() }).nullable() }),
  base: z.object({ ref: z.string().min(1).max(512), repo: z.object({ id: z.number().int().positive().safe() }).nullable() }),
});
const branchName = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const encode = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

/** Tip of one exact branch from a complete matching-refs listing: null = absent. */
async function branchTip(session: GitHubSession, repository: string, branch: string): Promise<string | null> {
  const parsed = z.array(z.object({ ref: z.string(), object: z.object({ sha, type: z.string() }) }))
    .safeParse(await session.list(`/repos/${repository}/git/matching-refs/heads/${encode(branch)}`, { maxPages: 10 }));
  if (!parsed.success) throw new InvalidGitHubObservation();
  const exact = parsed.data.filter(item => item.ref === `refs/heads/${branch}`);
  if (exact.length > 1 || (exact[0] && exact[0].object.type !== 'commit')) throw new InvalidGitHubObservation();
  return exact[0]?.object.sha ?? null;
}

export function deliveryOperations(options: { github: GitHubAccess }) {
  return {
    async readPullRequest(pr: PullRequestRef): Promise<PullRequestObservation> {
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error('INVALID_PULL_REQUEST_REF');
      const read = await options.github.read(pr.repo, 'delivery-read', async session => {
        if (session.repositoryId !== pr.repositoryId) throw new InvalidGitHubObservation();
        const parsed = pullSchema.safeParse(await session.get(`/repos/${pr.repo.repository}/pulls/${pr.number}`));
        if (!parsed.success || parsed.data.number !== pr.number ||
          parsed.data.html_url.toLowerCase() !== `https://github.com/${pr.repo.repository}/pull/${pr.number}`.toLowerCase()) throw new InvalidGitHubObservation();
        return parsed.data;
      });
      if (!read.ok) return { kind: 'unavailable', source: 'github-rest', observedAt: read.observedAt, code: read.code,
        ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: `Pull request state unknown (no merge, closure or absence concluded). ${read.nextStep}` };
      const pull = read.value;
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, repositoryId: read.repositoryId, pullRequest: {
        pullRequestId: pull.id, nodeId: pull.node_id, number: pull.number, url: pull.html_url, state: pull.state, draft: pull.draft, merged: pull.merged,
        mergedAt: pull.merged_at, mergeCommitSha: pull.merge_commit_sha, headRef: pull.head.ref, headSha: pull.head.sha, headRepositoryId: pull.head.repo?.id ?? null,
        baseRef: pull.base.ref, baseRepositoryId: pull.base.repo?.id ?? null } };
    },

    /**
     * Revalidates, under the cleanup grant and immediately before deleting: repository identity, that the branch is neither the base nor the
     * default branch, its tip is exactly the expected own tip, the own pull request is still merged from that exact head of this repository,
     * and no OPEN pull request uses the branch. Then sends the single DELETE and re-reads. GitHub REST has no conditional ref deletion: the
     * re-read just before the DELETE is the concurrency precondition (residual window documented in the ticket 17 evidence).
     */
    async cleanupBranch(selection: BranchCleanupSelection, effect: CleanupEffect): Promise<BranchCleanupResult> {
      const observedAt = new Date().toISOString();
      const local = (code: string, nextStep: string): BranchCleanupResult => ({ outcome: 'refused', code, observedAt, tip: null, revocation: 'not-issued', nextStep, effectId: effect.effectId });
      if (!branchName.test(selection.branch) || !branchName.test(selection.base) || !sha.safeParse(selection.expectedTip).success) return local('CLEANUP_SELECTION_INVALID', 'Selection rejected locally; nothing was read or sent.');
      if (selection.branch === selection.base) return local('BASE_BRANCH_PROTECTED', 'The base branch is never cleaned up.');
      const { repo } = selection;
      const refuse = (code: string, tip: string | null) => ({ outcome: 'refused' as const, tip, code });
      const result = await options.github.cleanup(repo, async session => {
        if (session.repositoryId !== selection.repositoryId) return refuse('REPOSITORY_IDENTITY_MISMATCH', null);
        const repository = z.object({ default_branch: z.string().min(1) }).safeParse(await session.get(`/repos/${repo.repository}`));
        if (!repository.success) throw new InvalidGitHubObservation();
        if (repository.data.default_branch === selection.branch) return refuse('DEFAULT_BRANCH_PROTECTED', null);
        const tip = await branchTip(session, repo.repository, selection.branch);
        if (tip === null) return { outcome: 'absent' as const, tip: null };
        if (tip !== selection.expectedTip) return refuse('BRANCH_TIP_CHANGED', tip);
        const pull = pullSchema.safeParse(await session.get(`/repos/${repo.repository}/pulls/${selection.pullRequest.number}`));
        if (!pull.success) throw new InvalidGitHubObservation();
        if (pull.data.id !== selection.pullRequest.pullRequestId || !pull.data.merged || pull.data.head.ref !== selection.branch ||
          pull.data.head.sha !== selection.expectedTip || pull.data.head.repo?.id !== selection.repositoryId) return refuse('OWN_PULL_REQUEST_NOT_CONFIRMED', tip);
        const owner = repo.repository.split('/')[0]!;
        const open = z.array(z.object({ number: z.number().int().positive() }))
          .safeParse(await session.list(`/repos/${repo.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${selection.branch}`)}`, { maxPages: 10 }));
        if (!open.success) throw new InvalidGitHubObservation();
        if (open.data.length) return refuse('BRANCH_IN_USE_BY_OPEN_PULL_REQUEST', tip);
        const deleted = await session.deleteBranch(selection.branch);
        // After the DELETE answered, the re-read is the observation: absent = removed (whatever the status said).
        const after = await branchTip(session, repo.repository, selection.branch).catch(() => undefined);
        if (after === null) return { outcome: 'removed' as const, tip };
        if (after === undefined) return { outcome: 'indeterminate' as const, tip, code: `DELETE_${deleted.status}_REREAD_FAILED` };
        return { outcome: deleted.status === 204 ? 'indeterminate' as const : 'failed' as const, tip: after, code: `DELETE_${deleted.status}` };
      }).catch((error: unknown) => ({ thrown: error }));
      if ('thrown' in result) return { outcome: 'indeterminate', code: 'CLEANUP_ADAPTER_FAILED', observedAt, tip: null, revocation: 'unknown', effectId: effect.effectId,
        nextStep: 'Unexpected adapter failure; re-read the branch before any new attempt.' };
      if (!result.ok) {
        return { outcome: result.outcome === 'unknown' ? 'indeterminate' : 'failed', code: result.code, observedAt: result.observedAt, tip: null,
          revocation: result.revocation, effectId: effect.effectId, nextStep: result.nextStep };
      }
      const value = result.value;
      const code = 'code' in value ? value.code : value.outcome === 'absent' ? 'BRANCH_ABSENT' : 'BRANCH_DELETED';
      return { outcome: value.outcome, code, observedAt: result.observedAt, tip: value.tip, revocation: result.revocation, effectId: effect.effectId,
        nextStep: value.outcome === 'removed' ? 'Own remote branch deleted and re-read absent.' : value.outcome === 'refused'
          ? 'Ownership/concurrency precondition failed: the branch is kept (not provably the Factory\'s delivered content). Operator decides on GitHub.' : value.outcome === 'absent'
          ? 'A complete read shows no such branch (e.g. GitHub deleted the head branch after merge); nothing was sent.'
          : 'The deletion outcome is not conclusive; the next sweep re-reads the branch before any new attempt.' };
    },
  };
}
