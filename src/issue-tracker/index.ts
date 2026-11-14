import { z } from 'zod';
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, UnverifiedGitHubAccess, readPermissions, type GitHubAccess, type GitHubRead } from '../platform/github/index.js';

/** Origin of Tickets: one configured repository plus its effective entry label. */
export type TrackerScope = GitHubScope & { label: string };
/** Repository readable ONLY for native dependency reads: never a Ticket origin, never executable. */
export type DependencyScope = GitHubScope & { role: 'dependency-only' };
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

/** One issue reached through native blocked_by; identity = GitHub issue id (globally unique) plus its repository. */
export type DependencyNode = {
  issueId: number; nodeId: string; repository: string; repositoryId: number | null; number: number; url: string;
  state: 'open' | 'closed'; stateReason: string | null;
  /** 'read' = issue and ALL its blocked_by pages read under its own repository grant; 'edge-only' = its own blockers are unknown. */
  access: 'read' | 'edge-only';
  repositoryRole: 'executable' | 'dependency-only' | 'not-configured';
  blockedBy: number[] | null;
};
export type DependencyProblem = { code: string; issueId?: number; repository?: string; observedCode?: string; waitSeconds?: number; nextStep: string };
/** Principal/scope of each read used (installation, repository, purpose, permissions); never a token. */
export type DependencyPrincipal = { installationId: number; repository: string; repositoryId: number | null; role: 'executable' | 'dependency-only';
  purpose: 'dependency-read'; permissions: Readonly<Record<string, 'read'>> };
/**
 * Reachable native blocked_by graph from one Ticket. Satisfaction (own cycles/merge) is NOT decided here. Any problem makes it incomplete;
 * a complete graph is not an atomic remote snapshot and does not certify the absence of relations GitHub does not show.
 */
export type DependencyGraphObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; root: TicketRef; completeness: 'complete' | 'incomplete';
  principals: DependencyPrincipal[]; nodes: DependencyNode[]; problems: DependencyProblem[]; limitations: string[] };

export interface IssueTracker {
  checkAccess(scope: TrackerScope | DependencyScope): Promise<AccessDiagnostic>;
  listCandidates(scope: TrackerScope): Promise<CandidateObservation>;
  readTicket(ticket: TicketRef): Promise<TicketObservation>;
  readDependencyGraph(ticket: TicketRef): Promise<DependencyGraphObservation>;
}

const issueSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), number: z.number().int().positive().safe(),
  html_url: z.string().url(), repository_url: z.string().url(), state: z.enum(['open', 'closed']), state_reason: z.string().nullable().optional(),
  labels: z.array(z.object({ id: z.number().int().positive().safe(), name: z.string().min(1).max(256) })),
  pull_request: z.unknown().optional(),
});
type Issue = z.infer<typeof issueSchema>;
const summarySchema = z.object({ blocked_by: z.number().int().nonnegative().safe(), total_blocked_by: z.number().int().nonnegative().safe() });
const edgeSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), number: z.number().int().positive().safe(),
  html_url: z.string().url(), repository_url: z.string().url(), state: z.enum(['open', 'closed']), state_reason: z.string().max(64).nullable().optional(),
  pull_request: z.unknown().optional(),
});
type Edge = z.infer<typeof edgeSchema>;
const maxGraphNodes = 100;
const repositoryName = /^https:\/\/api\.github\.com\/repos\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/;
/** Canonical repository of an issue payload; html_url must name the same repository and number (no pull request, no foreign URL). */
function edgeRepository(edge: Edge): string | undefined {
  const repository = repositoryName.exec(edge.repository_url)?.[1];
  if (!repository || repository.split('/').some(part => part === '.' || part === '..') || edge.pull_request !== undefined ||
    edge.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${edge.number}`.toLowerCase()) return undefined;
  return repository;
}
const graphLimitations = [
  'Only native blocked_by relations are read; prose, "Depends on", labels, duplicates and the inverse blocking relation are never substitutes.',
  'Reads of issues and pages are not an atomic remote snapshot; later changes are seen by the next evaluation.',
  'Equal counts (issue_dependencies_summary) do not certify the absence of relations GitHub does not show to this installation.',
];

export function createIssueTracker(options: { github: GitHubAccess; scopes?: TrackerScope[]; dependencyScopes?: GitHubScope[] }): IssueTracker {
  const unavailable = (repository: string, read: Extract<GitHubRead<unknown>, { ok: false }>): TrackerUnavailable => ({
    kind: 'unavailable', source: 'github-rest', observedAt: read.observedAt, repository, completeness: 'incomplete', code: read.code,
    ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: read.nextStep });
  const reference = (scope: GitHubScope, repositoryId: number, issue: Issue): TicketRef => {
    // GitHub owner/repository names are case-insensitive; the immutable ids carry identity.
    if (issue.repository_url.toLowerCase() !== `https://api.github.com/repos/${scope.repository}`.toLowerCase() ||
      issue.html_url.toLowerCase() !== `https://github.com/${scope.repository}/issues/${issue.number}`.toLowerCase()) throw new InvalidGitHubObservation();
    return { tracker: 'github', repository: scope.repository, repositoryId, issueId: issue.id, nodeId: issue.node_id, number: issue.number, url: issue.html_url };
  };
  const configuredFor = (repository: string): { scope: GitHubScope; role: 'executable' | 'dependency-only' } | undefined => {
    const lower = repository.toLowerCase();
    const executable = options.scopes?.find(scope => scope.repository.toLowerCase() === lower);
    if (executable) return { scope: executable, role: 'executable' };
    const dependency = options.dependencyScopes?.find(scope => scope.repository.toLowerCase() === lower);
    return dependency ? { scope: dependency, role: 'dependency-only' } : undefined;
  };

  /** Breadth-first traversal; each issue id is visited once per evaluation. Each node: GET issue, then the complete blocked_by listing. */
  async function readDependencyGraph(ticket: TicketRef): Promise<DependencyGraphObservation> {
    const observedAt = new Date().toISOString();
    const nodes = new Map<number, DependencyNode>();
    const problems: DependencyProblem[] = [];
    const principals = new Map<string, DependencyPrincipal>();
    type Item = { repository: string; number: number; issueId: number; nodeId: string; edge: Edge | null };
    const queue: Item[] = [{ repository: ticket.repository, number: ticket.number, issueId: ticket.issueId, nodeId: ticket.nodeId, edge: null }];
    const seen = new Set<number>([ticket.issueId]);
    const fromEdge = (item: Item, role: DependencyNode['repositoryRole'], repositoryId: number | null): DependencyNode | undefined => item.edge ? {
      issueId: item.edge.id, nodeId: item.edge.node_id, repository: item.repository, repositoryId, number: item.edge.number, url: item.edge.html_url,
      state: item.edge.state, stateReason: item.edge.state_reason ?? null, access: 'edge-only', repositoryRole: role, blockedBy: null } : undefined;
    const unavailable = (item: Item, read: Extract<GitHubRead<unknown>, { ok: false }>, what: string): DependencyProblem => ({
      code: 'DEPENDENCY_READ_UNAVAILABLE', issueId: item.issueId, repository: item.repository, observedCode: read.code,
      ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}),
      nextStep: `${what} of ${item.repository}#${item.number} could not be read completely (${read.code}); nothing is concluded from a partial read. ${read.nextStep}` });
    while (queue.length) {
      const item = queue.shift()!;
      if (nodes.size >= maxGraphNodes) {
        problems.push({ code: 'DEPENDENCY_GRAPH_TOO_LARGE', issueId: item.issueId, repository: item.repository,
          nextStep: `More than ${maxGraphNodes} reachable issues; the traversal was not completed and does not release. Operator must reduce or inspect the graph.` });
        break;
      }
      const configured = configuredFor(item.repository);
      if (!configured) {
        const node = fromEdge(item, 'not-configured', null);
        if (node) nodes.set(node.issueId, node);
        problems.push({ code: 'DEPENDENCY_REPOSITORY_NOT_CONFIGURED', issueId: item.issueId, repository: item.repository,
          nextStep: `Blocker ${item.repository}#${item.number} is in a repository not configured for this installation. Add it to dependencyRepositories ` +
            '(read-only, never executable) with the App installation that can read it, or remove the relation; it is never read with another identity.' });
        continue;
      }
      const { scope, role } = configured;
      const principal = (repositoryId: number | null) => {
        const key = `${scope.installationId}\n${scope.repository.toLowerCase()}`;
        const known = principals.get(key);
        if (!known || (known.repositoryId === null && repositoryId !== null)) principals.set(key, { installationId: scope.installationId, repository: scope.repository,
          repositoryId, role, purpose: 'dependency-read', permissions: readPermissions['dependency-read'] });
      };
      const issueRead = await options.github.read(scope, 'dependency-read', async session => {
        const parsed = issueSchema.extend({ issue_dependencies_summary: z.unknown().optional() })
          .safeParse(await session.get(`/repos/${scope.repository}/issues/${item.number}`));
        if (!parsed.success || edgeRepository(parsed.data)?.toLowerCase() !== scope.repository.toLowerCase()) throw new InvalidGitHubObservation();
        return parsed.data;
      });
      principal(issueRead.ok ? issueRead.repositoryId : null);
      if (!issueRead.ok) {
        const node = fromEdge(item, role, null);
        if (node) nodes.set(node.issueId, node);
        problems.push(unavailable(item, issueRead, 'Issue'));
        continue;
      }
      const issue = issueRead.value;
      const rootMismatch = !item.edge && (issueRead.repositoryId !== ticket.repositoryId || issue.number !== ticket.number);
      if (issue.id !== item.issueId || issue.node_id !== item.nodeId || rootMismatch) {
        const node = fromEdge(item, role, issueRead.repositoryId);
        if (node) nodes.set(node.issueId, node);
        problems.push({ code: item.edge ? 'INVALID_DEPENDENCY_RELATION' : 'DEPENDENCY_ROOT_MISMATCH', issueId: item.issueId, repository: item.repository,
          nextStep: `${item.repository}#${item.number} no longer carries the related qualified identity (transfer/renumbering?); operator must inspect it on GitHub.` });
        continue;
      }
      const node: DependencyNode = { issueId: issue.id, nodeId: issue.node_id, repository: scope.repository, repositoryId: issueRead.repositoryId, number: issue.number,
        url: issue.html_url, state: issue.state, stateReason: issue.state_reason ?? null, access: 'edge-only', repositoryRole: role, blockedBy: null };
      nodes.set(node.issueId, node);
      const listing = await options.github.read(scope, 'dependency-read', session => session.list(`/repos/${scope.repository}/issues/${item.number}/dependencies/blocked_by`));
      if (!listing.ok) { problems.push(unavailable(item, listing, 'Native blocked_by')); continue; }
      const edges: Edge[] = [];
      let invalid = 0, repeated = 0;
      for (const entry of listing.value) {
        const parsed = edgeSchema.safeParse(entry);
        const repository = parsed.success ? edgeRepository(parsed.data) : undefined;
        if (!parsed.success || !repository || parsed.data.id === issue.id) { invalid++; continue; }
        if (edges.some(edge => edge.id === parsed.data.id)) { repeated++; continue; }
        edges.push(parsed.data);
      }
      if (invalid) problems.push({ code: 'INVALID_DEPENDENCY_RELATION', issueId: issue.id, repository: scope.repository,
        nextStep: `${scope.repository}#${issue.number} lists ${invalid} invalid native blocked_by entr${invalid === 1 ? 'y' : 'ies'} (pull request, self, foreign URL or unexpected payload); operator must inspect the relations.` });
      if (repeated) problems.push({ code: 'DEPENDENCY_LISTING_UNSTABLE', issueId: issue.id, repository: scope.repository,
        nextStep: `${scope.repository}#${issue.number} returned the same blocker on several pages (concurrent change?); the listing may have skipped entries. Re-evaluated on the next poll.` });
      const parsedSummary = summarySchema.safeParse(issue.issue_dependencies_summary);
      const summary = parsedSummary.success ? parsedSummary.data : undefined;
      // Without GitHub's own count, an edge hidden from this installation is indistinguishable from no edge: never complete.
      if (!summary) problems.push({ code: 'DEPENDENCY_SUMMARY_UNAVAILABLE', issueId: issue.id, repository: scope.repository,
        nextStep: `${scope.repository}#${issue.number}: issue_dependencies_summary is absent or unparseable, so blockers GitHub omits for this installation ` +
          'cannot be detected. Nothing is released; the operator must verify the relations on GitHub (or the REST version/compatibility).' });
      else if (summary.total_blocked_by !== listing.value.length || (!invalid && !repeated && summary.blocked_by !== edges.filter(edge => edge.state === 'open').length)) {
        problems.push({ code: 'DEPENDENCY_COUNT_MISMATCH', issueId: issue.id, repository: scope.repository,
          nextStep: `${scope.repository}#${issue.number}: listed ${listing.value.length} native blocker(s) but GitHub reports ${summary.total_blocked_by} (open ${summary.blocked_by}); ` +
            'relations this installation cannot see, or a concurrent change, make the graph incomplete. Grant read access to the blocker repository or inspect it on GitHub.' });
      }
      node.blockedBy = edges.map(edge => edge.id);
      if (!invalid) node.access = 'read';
      for (const edge of edges) {
        if (seen.has(edge.id)) continue;
        seen.add(edge.id);
        queue.push({ repository: edgeRepository(edge)!, number: edge.number, issueId: edge.id, nodeId: edge.node_id, edge });
      }
    }
    return { kind: 'observed', source: 'github-rest', observedAt, root: ticket, completeness: problems.length ? 'incomplete' : 'complete',
      principals: [...principals.values()], nodes: [...nodes.values()], problems,
      limitations: graphLimitations };
  }

  return {
    readDependencyGraph,
    checkAccess(scope) {
      if ('role' in scope) return options.github.diagnose(scope, 'dependency', async session => {
        // One bounded sample page (no full listing of the repository).
        const issues = z.array(z.object({ id: z.number().int().positive(), number: z.number().int().positive(), pull_request: z.unknown().optional() }).passthrough())
          .safeParse(await session.get(`/repos/${scope.repository}/issues?state=all&per_page=100`));
        if (!issues.success) throw new InvalidGitHubObservation();
        const sample = issues.data.find(item => item.pull_request === undefined);
        if (!sample) throw new UnverifiedGitHubAccess('DEPENDENCY_ACCESS_UNVERIFIED', `${scope.repository}: the sample page has no issue (only pull requests or none), ` +
          'so native dependency reads were not verified; no issue or relation is created to test it. Blockers there are still read and checked in operation.');
        if (!z.array(edgeSchema.passthrough()).safeParse(await session.list(`/repos/${scope.repository}/issues/${sample.number}/dependencies/blocked_by`)).success) {
          throw new InvalidGitHubObservation();
        }
        return ['Dependency-only repository: issues and native blocked_by readable on one sample; pairs, hidden relations and other repositories are not certified.'];
      });
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
