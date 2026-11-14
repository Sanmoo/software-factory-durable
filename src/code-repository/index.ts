import { z } from 'zod';
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess } from '../platform/github/index.js';

/** Known repository/branch identities and the Ticket number they serve; the caller decides ownership, never this adapter. */
export type PublicationCorrelation = { repo: GitHubScope; issueNumber: number; knownBranches: string[] };
export type PullRequestCandidate = {
  pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean;
  headRef: string; headRepositoryId: number | null; author: { id: number; login: string; type: string };
  association: ('closing-reference' | 'known-branch')[];
};
/** An unavailable query never proves the absence of an associated or own pull request. */
export type PublicationObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; repository: string; repositoryId: number;
  completeness: 'complete'; candidates: PullRequestCandidate[]; limitations: string[] } |
  { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; completeness: 'incomplete'; code: string; waitSeconds?: number; nextStep: string };

export interface CodeRepository {
  checkAccess(repo: GitHubScope, base: string): Promise<AccessDiagnostic>;
  findPublication(correlation: PublicationCorrelation): Promise<PublicationObservation>;
}

const pullSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), number: z.number().int().positive().safe(), html_url: z.string().url(),
  state: z.enum(['open', 'closed']), merged_at: z.string().nullable().optional(), title: z.string().nullable().optional(), body: z.string().nullable().optional(),
  head: z.object({ ref: z.string().min(1).max(512), repo: z.object({ id: z.number().int().positive().safe() }).nullable() }),
  user: z.object({ id: z.number().int().positive().safe(), login: z.string(), type: z.string() }),
});
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function createCodeRepository(options: { github: GitHubAccess }): CodeRepository {
  return {
    checkAccess(repo, base) {
      return options.github.diagnose(repo, 'repository', async session => {
        if (!base || /[\x00-\x20\x7f]/.test(base)) throw new InvalidGitHubObservation();
        const branch = await session.get(`/repos/${repo.repository}/branches/${encodeURIComponent(base)}`);
        if (!z.object({ name: z.literal(base), commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }).safeParse(branch).success) throw new InvalidGitHubObservation();
      });
    },
    async findPublication(correlation) {
      const { repo, issueNumber } = correlation;
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('INVALID_PUBLICATION_CORRELATION');
      // GitHub closing keywords referring to THIS repository's issue (#N, owner/repo#N or its URL); a mere mention is not an association.
      const target = `(?:(?:${escape(repo.repository)})?#${issueNumber}|https://github\\.com/${escape(repo.repository)}/issues/${issueNumber})(?![0-9A-Za-z_/-])`;
      const closing = new RegExp(`(?:^|[^A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+${target}`, 'i');
      const read = await options.github.read(repo, 'repository-read', async session => {
        const parsed = z.array(pullSchema).safeParse(await session.list(`/repos/${repo.repository}/pulls?state=all`));
        if (!parsed.success) throw new InvalidGitHubObservation();
        const seen = new Set<number>();
        const candidates: PullRequestCandidate[] = [];
        for (const pull of parsed.data) {
          if (seen.has(pull.id)) continue;
          seen.add(pull.id);
          if (pull.html_url !== `https://github.com/${repo.repository}/pull/${pull.number}`) throw new InvalidGitHubObservation();
          const association: PullRequestCandidate['association'] = [];
          if (closing.test(pull.title ?? '') || closing.test(pull.body ?? '')) association.push('closing-reference');
          if (correlation.knownBranches.includes(pull.head.ref) && pull.head.repo?.id === session.repositoryId) association.push('known-branch');
          if (!association.length) continue;
          candidates.push({ pullRequestId: pull.id, nodeId: pull.node_id, number: pull.number, url: pull.html_url, state: pull.state, merged: Boolean(pull.merged_at),
            headRef: pull.head.ref, headRepositoryId: pull.head.repo?.id ?? null, author: { id: pull.user.id, login: pull.user.login, type: pull.user.type }, association });
        }
        return candidates;
      });
      if (!read.ok) return { kind: 'unavailable', source: 'github-rest', observedAt: read.observedAt, repository: repo.repository, completeness: 'incomplete', code: read.code,
        ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: read.nextStep };
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, repository: repo.repository, repositoryId: read.repositoryId, completeness: 'complete',
        candidates: read.value, limitations: [
          'Association is detected from GitHub closing keywords in pull request title/body of this repository and from known own branches.',
          'Manual "Development" links and pull requests in other repositories are not observable through this listing; they are not certified absent.',
          'Listing is not an atomic remote snapshot.',
        ] };
    },
  };
}
