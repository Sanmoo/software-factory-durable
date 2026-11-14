import { z } from 'zod';
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess } from '../platform/github/index.js';

/** Known repository/branch identities and the Ticket numbers they serve; the caller decides ownership, never this adapter.
 * Several Tickets of one repository share ONE pull request listing per call (bounded polling cost). */
export type PublicationCorrelation = { repo: GitHubScope; issueNumbers: number[]; knownBranches: string[] };
export type PullRequestCandidate = {
  pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean;
  headRef: string; headRepositoryId: number | null; author: { id: number; login: string; type: string };
  association: ('closing-reference' | 'cross-reference' | 'development-link' | 'known-branch')[];
};
/** Per Ticket: complete association, or incomplete (never an empty list standing in for absence). */
export type IssuePublication = { completeness: 'complete'; candidates: PullRequestCandidate[] } |
  { completeness: 'incomplete'; code: string; waitSeconds?: number; nextStep: string };
/** An unavailable query never proves the absence of an associated or own pull request. */
export type PublicationObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; repository: string; repositoryId: number;
  issues: Record<string, IssuePublication>; limitations: string[] } |
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
        association: order.filter(kind => kinds.has(kind)) });
    }
    return { completeness: 'complete', candidates };
  }
  return {
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
      return { kind: 'observed', source: 'github-rest', observedAt: pulls.observedAt, repository: repo.repository, repositoryId: pulls.repositoryId, issues, limitations: [
        'Association = GitHub closing keywords in pull request title/body, native issue-timeline cross-references and Development links (connected/disconnected) for pull requests of this repository, and known own branches.',
        'Pull requests in other repositories that reference the Ticket are not treated as associated (they cannot be own publications of this repository).',
        'A Development link whose pull request is not identified in the timeline makes the Ticket incomplete, never clear.',
        'Listing and timeline are separate reads, not an atomic remote snapshot.',
      ] };
    },
  };
}
