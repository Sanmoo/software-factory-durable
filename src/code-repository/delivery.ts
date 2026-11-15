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
  baseRef: string; baseRepositoryId: number | null;
  /** What GitHub actually sent for the optional fields (`absent` = no key in the response): a null merge commit is explained, never guessed. */
  reported: { mergeCommitSha: 'value' | 'null' | 'absent'; merged: 'value' | 'absent' } };
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
 * `removed`: deleted now by the atomic conditional deletion and re-read absent; `absent`: a complete read found no such ref (nothing was
 * sent); `refused`: an ownership or concurrency precondition failed (the ref is kept); `kept`: no atomic conditional deletion is available
 * for this token, so the ref is deliberately kept (never deleted without a precondition); `failed`: a known failure, nothing deleted;
 * `indeterminate`: the deletion may have happened (re-read before any new attempt). `revocation`: the single-use grant's self-revocation.
 */
export type BranchCleanupResult = { outcome: 'removed' | 'absent' | 'refused' | 'kept' | 'failed' | 'indeterminate'; code: string; observedAt: string;
  tip: string | null; revocation: string; nextStep: string; effectId: string };

const sha = z.string().regex(/^[0-9a-f]{40}$/);
/**
 * Single pull request (GET /repos/{repo}/pulls/{n}). Required fields are the ones ticket 14's adapter already parses from REAL GitHub
 * responses (id, node_id, number, html_url, state, draft, merged_at, head ref/sha/repo, base ref); `merged`, `merge_commit_sha` and
 * `base.repo` are read when present (they are on the real payload of PR #5, fixture `github-pull-5-real.json`) but a response without them
 * still parses: the merge is then known ONLY from `merged_at`. Unknown fields are ignored.
 */
const pullSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), number: z.number().int().positive().safe(), html_url: z.string().url(),
  state: z.enum(['open', 'closed']), draft: z.boolean(), merged_at: z.string().min(1).nullable(),
  merged: z.boolean().optional(), merge_commit_sha: sha.nullable().optional(),
  head: z.object({ ref: z.string().min(1).max(512), sha, repo: z.object({ id: z.number().int().positive().safe() }).nullable() }),
  base: z.object({ ref: z.string().min(1).max(512), repo: z.object({ id: z.number().int().positive().safe() }).nullable().optional() }),
});
/** Field paths of a schema failure (never values): diagnosable without copying payload content into records. */
const paths = (error: z.ZodError) => [...new Set(error.issues.map(issue => issue.path.join('.') || '(root)'))].slice(0, 12).join(', ');
/** `merged` (when GitHub sends it) must agree with `merged_at`; a contradiction is never resolved by guessing. */
const mergedOf = (pull: z.infer<typeof pullSchema>) => pull.merged === undefined || pull.merged === (pull.merged_at !== null) ? pull.merged_at !== null : null;
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
      type Checked = { ok: true; pull: z.infer<typeof pullSchema>; merged: boolean } | { ok: false; code: string; detail: string };
      // Each check is reported by its own code (never one generic invalid payload), so a real-run hold names exactly what failed.
      const read = await options.github.read(pr.repo, 'delivery-read', async (session): Promise<Checked> => {
        if (session.repositoryId !== pr.repositoryId) return { ok: false, code: 'PULL_REQUEST_REPOSITORY_MISMATCH', detail: 'The read grant is for another repository id than the own Work.' };
        const parsed = pullSchema.safeParse(await session.get(`/repos/${pr.repo.repository}/pulls/${pr.number}`));
        if (!parsed.success) return { ok: false, code: 'PULL_REQUEST_PAYLOAD_INVALID', detail: `Unexpected pull request fields: ${paths(parsed.error)}.` };
        if (parsed.data.number !== pr.number || parsed.data.html_url.toLowerCase() !== `https://github.com/${pr.repo.repository}/pull/${pr.number}`.toLowerCase()) {
          return { ok: false, code: 'PULL_REQUEST_IDENTITY_MISMATCH', detail: 'GitHub answered with another pull request number/URL than the one read.' };
        }
        const merged = mergedOf(parsed.data);
        if (merged === null) return { ok: false, code: 'PULL_REQUEST_MERGE_FACTS_INCONSISTENT', detail: '`merged` contradicts `merged_at`.' };
        return { ok: true, pull: parsed.data, merged };
      });
      if (!read.ok) return { kind: 'unavailable', source: 'github-rest', observedAt: read.observedAt, code: read.code,
        ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: `Pull request state unknown (no merge, closure or absence concluded). ${read.nextStep}` };
      if (!read.value.ok) return { kind: 'unavailable', source: 'github-rest', observedAt: read.observedAt, code: read.value.code,
        nextStep: `Pull request state unknown (no merge, closure or absence concluded). ${read.value.detail}` };
      const { pull, merged } = read.value;
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, repositoryId: read.repositoryId, pullRequest: {
        pullRequestId: pull.id, nodeId: pull.node_id, number: pull.number, url: pull.html_url, state: pull.state, draft: pull.draft, merged,
        mergedAt: pull.merged_at, mergeCommitSha: pull.merge_commit_sha ?? null, headRef: pull.head.ref, headSha: pull.head.sha, headRepositoryId: pull.head.repo?.id ?? null,
        baseRef: pull.base.ref, baseRepositoryId: pull.base.repo?.id ?? null,
        reported: { mergeCommitSha: pull.merge_commit_sha === undefined ? 'absent' : pull.merge_commit_sha === null ? 'null' : 'value',
          merged: pull.merged === undefined ? 'absent' : 'value' } } };
    },

    /**
     * Revalidates under the cleanup grant: repository identity, not the base/default branch, the own pull request still merged from
     * exactly the expected own tip of this repository, no OPEN pull request using the branch as head or as BASE (a stacked PR would be
     * closed by the deletion). Then re-reads the tip and sends ONE atomic conditional deletion (`updateRefs`, beforeOid = expected tip):
     * a push landing in between makes GitHub change nothing. Without that mutation the branch is kept; a plain DELETE is never sent.
     */
    async cleanupBranch(selection: BranchCleanupSelection, effect: CleanupEffect): Promise<BranchCleanupResult> {
      const observedAt = new Date().toISOString();
      const local = (code: string, nextStep: string): BranchCleanupResult => ({ outcome: 'refused', code, observedAt, tip: null, revocation: 'not-issued', nextStep, effectId: effect.effectId });
      if (!branchName.test(selection.branch) || !branchName.test(selection.base) || !sha.safeParse(selection.expectedTip).success) return local('CLEANUP_SELECTION_INVALID', 'Selection rejected locally; nothing was read or sent.');
      if (selection.branch === selection.base) return local('BASE_BRANCH_PROTECTED', 'The base branch is never cleaned up.');
      const { repo } = selection;
      const refuse = (code: string, tip: string | null) => ({ outcome: 'refused' as const, tip, code });
      // A payload that does not have GitHub's shape is a known failure (nothing sent), named by what was read; retried after revalidation.
      const unreadable = (code: string) => ({ outcome: 'failed' as const, tip: null, code });
      const result = await options.github.cleanup(repo, async session => {
        if (session.repositoryId !== selection.repositoryId) return refuse('REPOSITORY_IDENTITY_MISMATCH', null);
        const repository = z.object({ node_id: z.string().min(1).max(128), default_branch: z.string().min(1) }).safeParse(await session.get(`/repos/${repo.repository}`));
        if (!repository.success) return unreadable('REPOSITORY_PAYLOAD_INVALID');
        if (repository.data.default_branch === selection.branch) return refuse('DEFAULT_BRANCH_PROTECTED', null);
        const pull = pullSchema.safeParse(await session.get(`/repos/${repo.repository}/pulls/${selection.pullRequest.number}`));
        if (!pull.success) return unreadable('PULL_REQUEST_PAYLOAD_INVALID');
        if (pull.data.id !== selection.pullRequest.pullRequestId || mergedOf(pull.data) !== true || pull.data.head.ref !== selection.branch ||
          pull.data.head.sha !== selection.expectedTip || pull.data.head.repo?.id !== selection.repositoryId) return refuse('OWN_PULL_REQUEST_NOT_CONFIRMED', null);
        const owner = repo.repository.split('/')[0]!;
        const open = z.array(z.object({ number: z.number().int().positive() }));
        const heads = open.safeParse(await session.list(`/repos/${repo.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${selection.branch}`)}`, { maxPages: 10 }));
        if (!heads.success) return unreadable('PULL_REQUEST_LIST_PAYLOAD_INVALID');
        if (heads.data.length) return refuse('BRANCH_IN_USE_BY_OPEN_PULL_REQUEST', null);
        const stacked = open.safeParse(await session.list(`/repos/${repo.repository}/pulls?state=open&base=${encodeURIComponent(selection.branch)}`, { maxPages: 10 }));
        if (!stacked.success) return unreadable('PULL_REQUEST_LIST_PAYLOAD_INVALID');
        if (stacked.data.length) return refuse('BRANCH_BASE_OF_OPEN_PULL_REQUEST', null);
        // Tip re-read immediately before the atomic deletion (a complete listing; a capped or failed listing throws: unknown, never absent).
        const tip = await branchTip(session, repo.repository, selection.branch);
        if (tip === null) return { outcome: 'absent' as const, tip: null };
        if (tip !== selection.expectedTip) return refuse('BRANCH_TIP_CHANGED', tip);
        const deleted = await session.deleteRefIfAt({ repositoryNodeId: repository.data.node_id, branch: selection.branch, beforeOid: selection.expectedTip });
        if (deleted.kind === 'unavailable') return { outcome: 'kept' as const, tip, code: deleted.code };
        // After the answer, the re-read is the observation.
        const after = await branchTip(session, repo.repository, selection.branch).then(value => value, () => undefined);
        if (after === undefined) return { outcome: 'indeterminate' as const, tip, code: `${deleted.kind === 'deleted' ? 'DELETED' : deleted.code}_REREAD_FAILED` };
        if (after === null) return { outcome: deleted.kind === 'deleted' ? 'removed' as const : 'absent' as const, tip };
        if (after !== selection.expectedTip) return refuse('BRANCH_TIP_CHANGED', after);
        return { outcome: deleted.kind === 'deleted' ? 'indeterminate' as const : 'failed' as const, tip: after, code: deleted.kind === 'deleted' ? 'DELETED_BUT_PRESENT' : deleted.code };
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
        nextStep: value.outcome === 'removed' ? 'Own remote branch deleted atomically and re-read absent.' : value.outcome === 'kept'
          ? 'kept: atomic delete unavailable for this token (no conditional deletion); the branch is kept and never deleted without a precondition. Operator decides.'
          : value.outcome === 'refused'
          ? 'Ownership/concurrency precondition failed: the branch is kept (not provably the Factory\'s delivered content). Operator decides on GitHub.' : value.outcome === 'absent'
          ? 'A complete read shows no such branch (e.g. GitHub deleted the head branch after merge); nothing was sent.'
          : 'The deletion outcome is not conclusive; the next sweep re-reads the branch before any new attempt.' };
    },
  };
}
