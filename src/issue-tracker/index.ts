import { z } from 'zod';
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess, type GitHubRead } from '../platform/github/index.js';

/** Origin of Tickets: one configured repository plus its effective entry label. */
export type TrackerScope = GitHubScope & { label: string };
/** Qualified, stable GitHub identity of a Ticket; number/url are presentation, never identity on their own. */
export type TicketRef = { tracker: 'github'; repository: string; repositoryId: number; issueId: number; nodeId: string; number: number; url: string };
export type TrackerUnavailable = { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; completeness: 'incomplete';
  code: string; waitSeconds?: number; nextStep: string };
/** A listing never admits Work; an unavailable listing never proves the absence of candidates. */
export type CandidateObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; repository: string; repositoryId: number; label: string;
  completeness: 'complete'; candidates: TicketRef[]; limitations: string[] } | TrackerUnavailable;
/** Entry facts only: no body/spec ingestion and no persistent authorization. */
export type TicketObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; completeness: 'complete'; ticket: TicketRef;
  state: 'open' | 'closed'; stateReason: string | null; labels: { id: number; name: string }[]; pullRequest: boolean } | TrackerUnavailable;

export interface IssueTracker {
  checkAccess(scope: TrackerScope): Promise<AccessDiagnostic>;
  listCandidates(scope: TrackerScope): Promise<CandidateObservation>;
  readTicket(ticket: TicketRef): Promise<TicketObservation>;
}

const issueSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), number: z.number().int().positive().safe(),
  html_url: z.string().url(), repository_url: z.string().url(), state: z.enum(['open', 'closed']), state_reason: z.string().nullable().optional(),
  labels: z.array(z.object({ id: z.number().int().positive().safe(), name: z.string().min(1).max(256) })),
  pull_request: z.unknown().optional(),
});
type Issue = z.infer<typeof issueSchema>;

export function createIssueTracker(options: { github: GitHubAccess; scopes?: TrackerScope[] }): IssueTracker {
  const unavailable = (repository: string, read: Extract<GitHubRead<unknown>, { ok: false }>): TrackerUnavailable => ({
    kind: 'unavailable', source: 'github-rest', observedAt: read.observedAt, repository, completeness: 'incomplete', code: read.code,
    ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: read.nextStep });
  const reference = (scope: GitHubScope, repositoryId: number, issue: Issue): TicketRef => {
    if (issue.repository_url !== `https://api.github.com/repos/${scope.repository}` ||
      issue.html_url !== `https://github.com/${scope.repository}/issues/${issue.number}`) throw new InvalidGitHubObservation();
    return { tracker: 'github', repository: scope.repository, repositoryId, issueId: issue.id, nodeId: issue.node_id, number: issue.number, url: issue.html_url };
  };
  return {
    checkAccess(scope) {
      return options.github.diagnose(scope, 'tracker', async session => {
        const issues = await session.list(`/repos/${scope.repository}/issues`);
        const issue = z.object({ id: z.number().int().positive(), number: z.number().int().positive(), repository_url: z.literal(`https://api.github.com/repos/${scope.repository}`) });
        const parsed = z.array(issue.passthrough()).safeParse(issues);
        if (!parsed.success) throw new InvalidGitHubObservation();
        const sample = parsed.data.find(item => !item.pull_request);
        if (sample) {
          const dependencies = await session.list(`/repos/${scope.repository}/issues/${sample.number}/dependencies/blocked_by`);
          if (!z.array(z.object({ id: z.number().int().positive(), number: z.number().int().positive(), repository_url: z.string().url(), state: z.enum(['open', 'closed']) })).safeParse(dependencies).success) throw new InvalidGitHubObservation();
        }
        const comments = await session.list(`/repos/${scope.repository}/issues/comments`);
        const comment = z.object({ id: z.number().int().positive(), user: z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() }) });
        if (!z.array(comment).safeParse(comments).success) throw new InvalidGitHubObservation();
        return sample ? ['Native dependencies probed on one accessible issue only; hidden relations and other repositories are not certified.'] :
          ['No issue available for a native dependency probe; native dependency access remains unverified.'];
      });
    },
    async listCandidates(scope) {
      const read = await options.github.read(scope, 'tracker-read', async session => {
        const query = new URLSearchParams({ state: 'open', labels: scope.label });
        const parsed = z.array(issueSchema).safeParse(await session.list(`/repos/${scope.repository}/issues?${query.toString()}`));
        if (!parsed.success) throw new InvalidGitHubObservation();
        const seen = new Set<number>();
        const candidates: TicketRef[] = [];
        for (const issue of parsed.data) {
          // The issues endpoint also returns pull requests; those are never Tickets. Duplicates across pages are collapsed by identity.
          if (issue.pull_request !== undefined || issue.state !== 'open' || seen.has(issue.id)) continue;
          seen.add(issue.id);
          candidates.push(reference(scope, session.repositoryId, issue));
        }
        return candidates;
      });
      if (!read.ok) return unavailable(scope.repository, read);
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, repository: scope.repository, repositoryId: read.repositoryId, label: scope.label,
        completeness: 'complete', candidates: read.value,
        limitations: ['Listing is not an atomic remote snapshot and does not admit Work; each candidate is re-read before admission.'] };
    },
    async readTicket(ticket) {
      const scope = options.scopes?.find(candidate => candidate.repository.toLowerCase() === ticket.repository.toLowerCase());
      if (!scope) return { kind: 'unavailable', source: 'github-rest', observedAt: new Date().toISOString(), repository: ticket.repository, completeness: 'incomplete',
        code: 'REPOSITORY_NOT_CONFIGURED', nextStep: 'Only explicitly configured repositories are read; add it to the configuration and restart if intended.' };
      const read = await options.github.read(scope, 'tracker-read', async session => {
        const parsed = issueSchema.safeParse(await session.get(`/repos/${scope.repository}/issues/${ticket.number}`));
        if (!parsed.success) throw new InvalidGitHubObservation();
        return { ref: reference(scope, session.repositoryId, parsed.data), issue: parsed.data };
      });
      if (!read.ok) return unavailable(scope.repository, read);
      const { ref, issue } = read.value;
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, completeness: 'complete', ticket: ref, state: issue.state,
        stateReason: issue.state_reason ?? null, labels: issue.labels.map(label => ({ id: label.id, name: label.name })), pullRequest: issue.pull_request !== undefined };
    },
  };
}
