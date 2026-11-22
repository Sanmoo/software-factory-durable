import { z } from 'zod';
import { jiraInputOrder, questionMarkerPrefix, replyMarkerPrefix, type AccessDiagnostic, type GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, UnverifiedGitHubAccess, readPermissions, type GitHubAccess, type GitHubRead, type TokenRevocation } from '../platform/github/index.js';
import type { JiraRequest, JiraTransport } from './jira-http.js';

/** Origin of GitHub Tickets: one configured repository plus its effective entry label (shape unchanged since v1). */
export type GitHubTrackerScope = GitHubScope & { label: string };
/** Origin of Jira Tickets: one project of one configured Jira Cloud site, filtered by its entry label (identities by ID only). */
export type JiraTrackerScope = { tracker: 'jira'; siteId: string; url: string; projectId: string; label: string };
/** Scope of a Ticket origin, discriminated by provider (the GitHub variant carries no tag: persisted/configured shapes stay unchanged). */
export type TrackerScope = GitHubTrackerScope | JiraTrackerScope;
/** Repository readable ONLY for native dependency reads: never a Ticket origin, never executable. */
export type DependencyScope = GitHubScope & { role: 'dependency-only' };
/** Qualified, stable GitHub identity of a Ticket; number/url are presentation, never identity on their own. Persisted as-is (storage format 2). */
export type GitHubTicketRef = { tracker: 'github'; repository: string; repositoryId: number; issueId: number; nodeId: string; number: number; url: string };
/** Stable Jira identity of a Ticket: (siteId, issueId). `key` (e.g. PAG-42) and `url` are presentation only: a key change never makes another Ticket. */
export type JiraTicketRef = { tracker: 'jira'; siteId: string; issueId: string; key: string; url: string;
  /** Absent on Jira: reading a GitHub-only field without narrowing on `tracker` yields `undefined`, never a borrowed GitHub identity. */
  repository?: never; repositoryId?: never; nodeId?: never; number?: never };
/** Identity of a Ticket at its origin, discriminated by `tracker`. */
export type TicketRef = GitHubTicketRef | JiraTicketRef;
export type TrackerKind = TicketRef['tracker'];
export type TrackerUnavailable = { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; completeness: 'incomplete';
  code: string; waitSeconds?: number; nextStep: string };
/** A listing never admits Work; an unavailable listing never proves the absence of candidates. */
export type CandidateObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; repository: string; repositoryId: number; label: string;
  completeness: 'complete'; candidates: GitHubTicketRef[]; limitations: string[] } | TrackerUnavailable;
/** Entry facts only: no body/spec ingestion and no persistent authorization. */
export type TicketObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; completeness: 'complete'; ticket: GitHubTicketRef;
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
export type DependencyGraphObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; root: GitHubTicketRef; completeness: 'complete' | 'incomplete';
  principals: DependencyPrincipal[]; nodes: DependencyNode[]; problems: DependencyProblem[]; limitations: string[] };

/** Author of a comment as GitHub reports it (id is the identity; login/type are evidence for authorization by the Control). */
export type CommentAuthorRef = { id: number; login: string; type: string };
/** One issue comment. `viaApp`: id of the GitHub App that performed it (null for human/other comments). Never interpreted here. */
export type TrackerComment = { commentId: number; nodeId: string; url: string; author: CommentAuthorRef; body: string; createdAt: string; updatedAt: string; viaApp: number | null };
/** Comments after `cursor` (ascending id), from a COMPLETE listing only; an unavailable read never proves the absence of comments. */
export type InputsObservation = { kind: 'observed'; source: 'github-rest'; observedAt: string; ticket: GitHubTicketRef; completeness: 'complete';
  comments: TrackerComment[]; cursor: number | null; limitations: string[] } | TrackerUnavailable;
/** Comments of THIS installation's App carrying the stable marker of the Question; several candidates are reported, never chosen. */
export type QuestionSearch = { kind: 'observed'; source: 'github-rest'; observedAt: string; completeness: 'complete';
  candidates: { commentId: number; url: string; createdAt: string }[]; limitations: string[] } | TrackerUnavailable;
/** Concrete authorized Question text; the adapter prepends the stable marker for `questionId`. No arbitrary endpoint or label/state change. */
export type QuestionComment = { kind: 'question'; questionId: string; body: string } |
  /** Ticket 23: the controller's reply to a `/factory` command (marker `software-factory:reply:<id>`), on the Work's Ticket. */
  { kind: 'reply'; replyId: string; body: string };
/** Identity of the publication effect already persisted by the Control (correlation, not external idempotency). */
export type CommentEffect = { effectId: string; questionId: string } | { effectId: string; replyId: string };
/** Known success, known failure (nothing was created) or unknown outcome (the comment may exist: discover before republishing). */
/** `revocation`: what happened to the single-use write credential after the attempt (never claimed when not observed). */
export type CommentResult = ({ kind: 'published'; observedAt: string; commentId: number; url: string; createdAt: string } |
  { kind: 'failed'; observedAt: string; code: string; waitSeconds?: number; nextStep: string } |
  { kind: 'unknown'; observedAt: string; code: string; nextStep: string }) & { revocation?: TokenRevocation };

/*
 * Jira Cloud contracts (spec §1-§4). Facts only: listing, re-read, visible blockers, inputs and comments; never admission or authorization.
 * Ticket 01 fixes the shapes the Control routes by; tickets 03 (discovery/revalidation), 05/06 (comments/inputs) and 08/09 (remote links)
 * fill the REST behaviour behind them.
 */
export type JiraUnavailable = { kind: 'unavailable'; source: 'jira-rest'; observedAt: string; siteId: string; completeness: 'incomplete';
  code: string; waitSeconds?: number; nextStep: string };
/** One JQL search (project + label, all pages): candidates only, never authorization; each is re-read by ID before admission. */
export type JiraCandidateObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; projectId: string; label: string;
  completeness: 'complete'; candidates: JiraTicketRef[]; limitations: string[] } | JiraUnavailable;
/** Re-read by ID: entry facts. `components: null` = the list was not read completely (never "zero routes"). */
export type JiraTicketObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; completeness: 'complete'; ticket: JiraTicketRef;
  projectId: string; labels: string[]; components: { id: string; name: string }[] | null; statusCategory: string;
  /** Jira ticket 03: the Card's summary (null when absent) and its links as observed (`null` = not read completely: never "no link"). */
  summary: string | null; links: JiraLink[] | null } | JiraUnavailable;
/** One entry of the site's link type catalogue; the labels are the site administrator's (editable). */
export type JiraLinkType = { id: string; name: string; inward: string; outward: string };
/** A link of the read Ticket: `end: 'inward'` = the neighbour came as `inwardIssue` (to be read with `type.inward`). The type's meaning is the Control's rule. */
export type JiraLink = { linkId: string; type: JiraLinkType; end: 'inward' | 'outward'; issue: { issueId: string; key: string } };
export type JiraLinkTypesObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; types: JiraLinkType[] } | JiraUnavailable;
/** Status CATEGORY of one issue of the site read by ID (any project, with or without the label); never its local status name. */
export type JiraIssueStatusObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; issueId: string; key: string;
  statusCategory: string } | JiraUnavailable;
/** A visible "is blocked by" neighbour, judged by its status CATEGORY (never the local column name). */
export type JiraBlocker = { issueId: string; key: string; statusCategory: string };
/** Visible blockers of one Ticket. `coverage: 'visible'`: an empty list is a valid read of what this account sees, never global absence. */
export type JiraBlockersObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; root: JiraTicketRef; coverage: 'visible';
  blockers: JiraBlocker[]; limitations: string[] } | JiraUnavailable;
/** Author of a Jira comment: the observed `accountId` is the identity (a shared Factory account may also author human answers). */
export type JiraCommentAuthor = { tracker: 'jira'; accountId: string };
/** Stable reference of one Jira input: (siteId, issueId, commentId). */
export type JiraInputRef = { tracker: 'jira'; siteId: string; issueId: string; commentId: string };
/** One ordinary Platform comment of the origin Card; `body` is the plain text projected from validated ADF. */
export type JiraComment = { ref: JiraInputRef; url: string; author: JiraCommentAuthor; body: string; createdAt: string; updatedAt: string;
  /** A visibility restriction applies: its text is never applied nor projected to a broader audience. */
  restricted: boolean };
/** Read position in a Card's comments: the last processed comment (ascending created instant, then id); advanced only over processed inputs. */
export type JiraInputCursor = { tracker: 'jira'; createdAt: string; commentId: string };
export type JiraInputsObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; ticket: JiraTicketRef; completeness: 'complete';
  comments: JiraComment[]; cursor: JiraInputCursor | null; limitations: string[] } | JiraUnavailable;
export type JiraQuestionSearch = { kind: 'observed'; source: 'jira-rest'; observedAt: string; completeness: 'complete';
  candidates: { commentId: string; url: string; createdAt: string }[]; limitations: string[] } | JiraUnavailable;
export type JiraCommentResult = { kind: 'published'; observedAt: string; commentId: string; url: string; createdAt: string } |
  { kind: 'failed'; observedAt: string; code: string; waitSeconds?: number; nextStep: string } |
  { kind: 'unknown'; observedAt: string; code: string; nextStep: string };
/** Jira ticket 10: one capability the Factory needs on the configured project, as observed by the account's own permissions read. */
export type JiraCapabilityFact = 'granted' | 'missing' | 'unverified';
export type JiraAccessDiagnostic = { source: 'jira-rest'; purpose: 'tracker'; observedAt: string; siteId: string; projectId: string;
  status: 'ok' | 'blocked'; code: string; completeness: 'complete' | 'incomplete'; nextStep: string; limitations?: string[];
  /** Read project/issues/links/comments (Browse projects), create comments (Add comments), keep remote links (Link issues); audience and
   * visibility of what Jira hides from this account can never be proved by it. */
  facts?: { projectRead: JiraCapabilityFact; commentCreate: JiraCapabilityFact; remoteLinks: JiraCapabilityFact; commentAudience: 'unverified';
    blockerVisibility: 'unverified' } };

/** Author of an input, discriminated by provider (GitHub keeps its untagged `{id, login, type}`). */
export type TrackerCommentAuthor = CommentAuthorRef | JiraCommentAuthor;
/** Read position of inputs, discriminated by provider: GitHub = highest comment id (unchanged), Jira = {@link JiraInputCursor}. */
export type InputCursor = number | JiraInputCursor;

/** Per-provider shapes of the common tracker contract. A provider never simulates another's capability (no GitHub remote links). */
export type TrackerContracts = {
  github: { scope: GitHubTrackerScope; ticket: GitHubTicketRef; candidates: CandidateObservation; observation: TicketObservation;
    blockers: DependencyGraphObservation; inputs: InputsObservation; cursor: number; search: QuestionSearch; result: CommentResult; access: AccessDiagnostic };
  jira: { scope: JiraTrackerScope; ticket: JiraTicketRef; candidates: JiraCandidateObservation; observation: JiraTicketObservation;
    blockers: JiraBlockersObservation; inputs: JiraInputsObservation; cursor: JiraInputCursor; search: JiraQuestionSearch; result: JiraCommentResult; access: JiraAccessDiagnostic };
};

/**
 * Common contract of a Ticket origin, typed per provider: the Control selects the adapter by the Ticket's persisted `tracker`, never by the
 * destination repository. Defaults to GitHub so existing consumers read unchanged.
 */
export interface IssueTracker<P extends TrackerKind = 'github'> {
  checkAccess(scope: TrackerContracts[P]['scope'] | (P extends 'github' ? DependencyScope : never)): Promise<TrackerContracts[P]['access']>;
  listCandidates(scope: TrackerContracts[P]['scope']): Promise<TrackerContracts[P]['candidates']>;
  readTicket(ticket: TrackerContracts[P]['ticket']): Promise<TrackerContracts[P]['observation']>;
  /** GitHub: native blocked_by graph. Jira: visible "is blocked by" neighbours. Neither substitutes for the other. */
  readDependencyGraph(ticket: TrackerContracts[P]['ticket']): Promise<TrackerContracts[P]['blockers']>;
  readInputs(ticket: TrackerContracts[P]['ticket'], cursor: TrackerContracts[P]['cursor'] | null): Promise<TrackerContracts[P]['inputs']>;
  findQuestion(ticket: TrackerContracts[P]['ticket'], questionId: string): Promise<TrackerContracts[P]['search']>;
  postComment(ticket: TrackerContracts[P]['ticket'], comment: QuestionComment, effect: CommentEffect): Promise<TrackerContracts[P]['result']>;
  /** Ticket 23: comments of THIS installation's App carrying the reply marker; several candidates are reported, never chosen. */
  findReply?(ticket: TrackerContracts[P]['ticket'], replyId: string): Promise<TrackerContracts[P]['search']>;
}

/** Jira-only capability (spec §5): keep the Work's link on the Card, upserted by a stable `globalId` (e.g. `software-factory:work:<uuid>`). */
export type RemoteLink = { globalId: string; url: string; title: string };
/** `applied`: Jira created or updated the link with this globalId; `failed`: certainly not applied; `unknown`: may have been applied. An
 * upsert by globalId may be repeated in every case (it never makes a second link), unlike a comment POST. */
export type RemoteLinkResult = { kind: 'applied'; observedAt: string; linkId: string } |
  { kind: 'failed'; observedAt: string; code: string; waitSeconds?: number; nextStep: string } |
  { kind: 'unknown'; observedAt: string; code: string; nextStep: string };
export interface JiraRemoteLinks {
  upsertRemoteLink(ticket: JiraTicketRef, link: RemoteLink): Promise<RemoteLinkResult>;
}
/**
 * Jira-only reads behind the visible-blockers fact (Jira ticket 03): the site's link type catalogue and the status category of a neighbour.
 * The Control decides which links block (catalogue + direction rule) and reads only those neighbours.
 */
/**
 * Jira ticket 04: the Card's text for the Builder's context (the agent has no Jira client or token). Summary and description (ADF as plain
 * text, bounded with an explicit `truncated`); presentation data of the Ticket, never instructions to the Factory.
 */
export type JiraTicketContent = { kind: 'observed'; source: 'jira-rest'; observedAt: string; ticket: JiraTicketRef; summary: string | null;
  description: string | null; truncated: boolean } | JiraUnavailable;
export interface JiraContentReads {
  readTicketContent(ticket: JiraTicketRef): Promise<JiraTicketContent>;
}
export interface JiraBlockerReads {
  readLinkTypes(siteId: string): Promise<JiraLinkTypesObservation>;
  readIssueStatus(siteId: string, issueId: string): Promise<JiraIssueStatusObservation>;
}

/** Jira ticket 05: an automatic comment as plain lines (the first is the reserved header); the adapter writes one ADF paragraph per line. */
export type JiraFactoryComment = { lines: string[] };
/** Outcome of one comment POST: created (with the author Jira recorded), known refusal (nothing created) or unknown (it may exist). */
export type JiraCommentPost = { kind: 'published'; observedAt: string; commentId: string; url: string; createdAt: string; authorAccountId: string | null } |
  { kind: 'failed'; observedAt: string; code: string; waitSeconds?: number; nextStep: string } |
  { kind: 'unknown'; observedAt: string; code: string; nextStep: string };
/** One visible comment: author account, plain text projected from its current ADF, and whether a visibility restriction applies. */
export type JiraVisibleComment = { commentId: string; authorAccountId: string; text: string; createdAt: string; updatedAt: string; restricted: boolean };
/** Every visible comment of a Card, all pages (never a shorter list); what this account sees, not an atomic snapshot. */
export type JiraCommentListing = { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; issueId: string; completeness: 'complete';
  comments: JiraVisibleComment[]; limitations: string[] } | JiraUnavailable;
export type JiraAccountObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; accountId: string } | JiraUnavailable;
/**
 * Jira-only automatic comments (Jira ticket 05, reused by Questions and delivery notices): POST a Platform comment with NO visibility
 * restriction, list every visible comment for reconciliation after an uncertain POST, and read the configured account on demand (no
 * pre-registered accountId). Jira documents no idempotency key: reconciliation is the Control's rule.
 */
export interface JiraComments {
  publishComment(ticket: JiraTicketRef, comment: JiraFactoryComment): Promise<JiraCommentPost>;
  listComments(ticket: JiraTicketRef): Promise<JiraCommentListing>;
  readAccount(siteId: string): Promise<JiraAccountObservation>;
}

/**
 * Jira ticket 06: the inputs after `cursor` from a COMPLETE listing of the Card's comments (an incomplete one is returned as is: nothing
 * concluded). The observation's cursor is the last listed input (or the given cursor): the Control stores it only after processing them.
 */
export function jiraInputsOf(ticket: JiraTicketRef, listing: JiraCommentListing, cursor: JiraInputCursor | null): JiraInputsObservation {
  if (listing.kind !== 'observed') return listing;
  const comments = [...listing.comments].sort((a, b) => jiraInputOrder(a, b))
    .filter(item => cursor === null || jiraInputOrder(item, cursor) > 0)
    .map((item): JiraComment => ({ ref: { tracker: 'jira', siteId: ticket.siteId, issueId: ticket.issueId, commentId: item.commentId },
      url: `${ticket.url}?focusedCommentId=${item.commentId}`, author: { tracker: 'jira', accountId: item.authorAccountId }, body: item.text,
      createdAt: item.createdAt, updatedAt: item.updatedAt, restricted: item.restricted }));
  const last = comments.at(-1);
  return { kind: 'observed', source: 'jira-rest', observedAt: listing.observedAt, ticket, completeness: 'complete', comments,
    cursor: last ? { tracker: 'jira', createdAt: last.createdAt, commentId: last.ref.commentId } : cursor, limitations: [...listing.limitations] };
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
const commentSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1).max(256), html_url: z.string().url(),
  user: z.object({ id: z.number().int().positive().safe(), login: z.string().min(1).max(256), type: z.string().min(1).max(64) }),
  body: z.string().max(262144).nullable(), created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
  performed_via_github_app: z.object({ id: z.number().int().positive().safe() }).passthrough().nullable().optional(),
});
const maxCommentPages = 10;
const questionMarker = (questionId: string) => `<!-- ${questionMarkerPrefix}${questionId} -->`;
const replyMarker = (replyId: string) => `<!-- ${replyMarkerPrefix}${replyId} -->`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

export function createIssueTracker(options: { github: GitHubAccess; scopes?: GitHubTrackerScope[]; dependencyScopes?: GitHubScope[] }): IssueTracker {
  const unavailable = (repository: string, read: Extract<GitHubRead<unknown>, { ok: false }>): TrackerUnavailable => ({
    kind: 'unavailable', source: 'github-rest', observedAt: read.observedAt, repository, completeness: 'incomplete', code: read.code,
    ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}), nextStep: read.nextStep });
  const reference = (scope: GitHubScope, repositoryId: number, issue: Issue): GitHubTicketRef => {
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
  async function readDependencyGraph(ticket: GitHubTicketRef): Promise<DependencyGraphObservation> {
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

  const executableScope = (ticket: GitHubTicketRef) => options.scopes?.find(candidate => candidate.repository.toLowerCase() === ticket.repository.toLowerCase());
  const notConfigured = (ticket: GitHubTicketRef): TrackerUnavailable => ({ kind: 'unavailable', source: 'github-rest', observedAt: new Date().toISOString(), repository: ticket.repository,
    completeness: 'incomplete', code: 'REPOSITORY_NOT_CONFIGURED', nextStep: 'Only explicitly configured repositories are read or written.' });
  /** Complete comment listing of the Ticket issue, every entry validated; a single invalid entry fails the whole read (no partial result). */
  const comments = (scope: GitHubScope, ticket: GitHubTicketRef) => options.github.read(scope, 'tracker-read', async session => {
    if (session.repositoryId !== ticket.repositoryId) throw new InvalidGitHubObservation();
    // Bounded per read: more than maxCommentPages pages is incomplete (unavailable), never a truncated listing.
    const parsed = z.array(commentSchema).safeParse(await session.list(`/repos/${scope.repository}/issues/${ticket.number}/comments`, { maxPages: maxCommentPages }));
    if (!parsed.success) throw new InvalidGitHubObservation();
    const seen = new Set<number>();
    const result: TrackerComment[] = [];
    for (const comment of parsed.data) {
      if (comment.html_url.toLowerCase() !== `https://github.com/${scope.repository}/issues/${ticket.number}#issuecomment-${comment.id}`.toLowerCase()) throw new InvalidGitHubObservation();
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      result.push({ commentId: comment.id, nodeId: comment.node_id, url: comment.html_url, author: { id: comment.user.id, login: comment.user.login, type: comment.user.type },
        body: comment.body ?? '', createdAt: comment.created_at, updatedAt: comment.updated_at, viaApp: comment.performed_via_github_app?.id ?? null });
    }
    return result.sort((a, b) => a.commentId - b.commentId);
  });
  const ownMarked = (list: TrackerComment[], marker: string) => list.filter(comment => comment.viaApp === options.github.appId && comment.author.type === 'Bot' &&
    comment.body.startsWith(`${marker}\n`));
  const ownQuestions = (list: TrackerComment[], questionId: string) => ownMarked(list, questionMarker(questionId));

  return {
    async readInputs(ticket, cursor) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      const read = await comments(scope, ticket);
      if (!read.ok) return unavailable(scope.repository, read);
      const after = read.value.filter(comment => cursor === null || comment.commentId > cursor);
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, ticket, completeness: 'complete', comments: after,
        cursor: read.value.length ? Math.max(cursor ?? 0, read.value.at(-1)!.commentId) : cursor,
        limitations: ['Complete listing at one instant, not an atomic snapshot; edits after reading are not seen as new comments.', 'Comments are evidence; authorization and correlation are decided by the Control.'] };
    },
    async findQuestion(ticket, questionId) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      if (!uuid.test(questionId)) throw new Error('INVALID_QUESTION_ID');
      const read = await comments(scope, ticket);
      if (!read.ok) return unavailable(scope.repository, read);
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, completeness: 'complete',
        candidates: ownQuestions(read.value, questionId).map(comment => ({ commentId: comment.commentId, url: comment.url, createdAt: comment.createdAt })),
        limitations: ['Only comments performed by this installation\'s App with the exact marker line count; a listing is not an atomic snapshot.'] };
    },
    async findReply(ticket, replyId) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      if (!uuid.test(replyId)) throw new Error('INVALID_REPLY_ID');
      const read = await comments(scope, ticket);
      if (!read.ok) return unavailable(scope.repository, read);
      return { kind: 'observed', source: 'github-rest', observedAt: read.observedAt, completeness: 'complete',
        candidates: ownMarked(read.value, replyMarker(replyId)).map(comment => ({ commentId: comment.commentId, url: comment.url, createdAt: comment.createdAt })),
        limitations: ['Only comments performed by this installation\'s App with the exact reply marker count; a listing is not an atomic snapshot.'] };
    },
    async postComment(ticket, comment, effect) {
      const scope = executableScope(ticket);
      const observedAt = new Date().toISOString();
      if (!scope) return { kind: 'failed', observedAt, code: 'REPOSITORY_NOT_CONFIGURED', nextStep: 'Only configured repositories receive Questions.' };
      const id = comment.kind === 'question' ? comment.questionId : comment.kind === 'reply' ? comment.replyId : '';
      const correlated = comment.kind === 'question' ? 'questionId' in effect && effect.questionId === id : 'replyId' in effect && effect.replyId === id;
      if ((comment.kind !== 'question' && comment.kind !== 'reply') || !uuid.test(id) || !correlated || comment.body.includes(questionMarkerPrefix) || comment.body.includes(replyMarkerPrefix)) {
        return { kind: 'failed', observedAt, code: 'INVALID_QUESTION_COMMENT', nextStep: 'Rejected locally; nothing was sent.' };
      }
      const marker = comment.kind === 'question' ? questionMarker(id) : replyMarker(id);
      const written = await options.github.comment(scope, ticket.number, `${marker}\n${comment.body}`);
      const revocation = written.revocation;
      if (!written.ok) return written.outcome === 'unknown' ? { kind: 'unknown', observedAt: written.observedAt, code: written.code, nextStep: written.nextStep, revocation }
        : { kind: 'failed', observedAt: written.observedAt, code: written.code, ...(written.waitSeconds !== undefined ? { waitSeconds: written.waitSeconds } : {}), nextStep: written.nextStep, revocation };
      const parsed = commentSchema.safeParse(written.value);
      if (!parsed.success || written.repositoryId !== ticket.repositoryId || !parsed.data.body?.startsWith(`${marker}\n`) ||
          parsed.data.html_url.toLowerCase() !== `https://github.com/${scope.repository}/issues/${ticket.number}#issuecomment-${parsed.data.id}`.toLowerCase()) {
        return { kind: 'unknown', observedAt: written.observedAt, code: 'GITHUB_WRITE_UNVERIFIED', nextStep: 'GitHub accepted a write whose result could not be verified; discover the marker before any new publication.', revocation };
      }
      return { kind: 'published', observedAt: written.observedAt, commentId: parsed.data.id, url: parsed.data.html_url, createdAt: parsed.data.created_at, revocation };
    },
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
        const candidates: GitHubTicketRef[] = [];
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

export { adfPlainText } from './jira-adf-text.js';
import { adfPlainText } from './jira-adf-text.js';
export { createJiraHttpTransport, type JiraHostSite, type JiraHttpExchange, type JiraHttpResult, type JiraRequest, type JiraResponse, type JiraTransport } from './jira-http.js';

const jiraId = z.string().regex(/^[1-9][0-9]{0,17}$/);
const jiraKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]{0,17}$/);
const jiraLinkTypeSchema = z.object({ id: jiraId, name: z.string().min(1).max(255), inward: z.string().min(1).max(255), outward: z.string().min(1).max(255) });
const jiraLinkSchema = z.object({ id: jiraId, type: jiraLinkTypeSchema,
  inwardIssue: z.object({ id: jiraId, key: jiraKey }).optional(), outwardIssue: z.object({ id: jiraId, key: jiraKey }).optional() })
  .refine(link => (link.inwardIssue === undefined) !== (link.outwardIssue === undefined));
const jiraIssueSchema = z.object({
  id: jiraId, key: jiraKey,
  fields: z.object({
    labels: z.array(z.string().min(1).max(255)),
    // Absent = not read (failFast=false or not returned): a partial read, never an empty list.
    components: z.unknown().optional(),
    issuelinks: z.unknown().optional(),
    summary: z.string().max(4096).nullable().optional(),
    project: z.object({ id: jiraId }),
    status: z.object({ statusCategory: z.object({ key: z.string().min(1).max(64) }) }),
  }),
});
const jiraComponentsSchema = z.array(z.object({ id: jiraId, name: z.string().max(255) }));
const jiraStatusSchema = z.object({ id: jiraId, key: jiraKey, fields: z.object({ status: z.object({ statusCategory: z.object({ key: z.string().min(1).max(64) }) }) }) });
const jiraContentSchema = z.object({ id: jiraId, key: jiraKey, fields: z.object({ summary: z.string().max(4096).nullable().optional(), description: z.unknown().optional() }) });
/** Bound of the description handed to the Builder (characters of plain text); beyond it the text says it was cut. */
const maxDescriptionChars = 8000;
const jiraLinkTypesSchema = z.object({ issueLinkTypes: z.array(jiraLinkTypeSchema).max(500) });
const jiraSearchPageSchema = z.object({ issues: z.array(z.object({ id: jiraId, key: jiraKey, fields: z.object({ project: z.object({ id: jiraId }) }) })).max(5000),
  nextPageToken: z.string().min(1).max(4096).optional(), isLast: z.boolean() });
/** Bound of one listing: beyond it the listing is unavailable, never truncated. */
const maxSearchPages = 50;
const visibleOnly = 'Only what the configured account can see; the last page ends this query, it is neither global completeness nor an atomic snapshot.';
/** ADF node as read back (Jira may add attributes/marks); only text, hard breaks and nesting matter to the projection. */
type AdfNode = { type: string; text?: string | undefined; content?: AdfNode[] | undefined };
const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() => z.object({ type: z.string().max(64), text: z.string().max(65536).optional(),
  content: z.array(adfNodeSchema).max(2000).optional() }));
const adfDocSchema = z.object({ type: z.literal('doc'), content: z.array(adfNodeSchema).max(2000) });
/** Plain text of an ADF document: one line per top-level block, text nodes concatenated, hard breaks as new lines. */
const adfText = (doc: z.infer<typeof adfDocSchema>) => {
  const inline = (node: AdfNode): string => node.type === 'text' ? node.text ?? '' : node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(inline).join('');
  return doc.content.map(inline).join('\n');
};
const adfOf = (lines: readonly string[]) => ({ type: 'doc', version: 1,
  content: lines.map(text => text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }) });
const jiraCommentCreatedSchema = z.object({ id: jiraId, created: z.string().min(1).max(64), author: z.object({ accountId: z.string().min(1).max(128) }).optional() });
const jiraCommentSchema = z.object({ id: jiraId, author: z.object({ accountId: z.string().max(128).optional() }).optional(), body: z.unknown(),
  created: z.string().min(1).max(64), updated: z.string().min(1).max(64), visibility: z.object({ type: z.string(), value: z.string().optional() }).nullable().optional() });
const jiraCommentPageSchema = z.object({ startAt: z.number().int().min(0), total: z.number().int().min(0), comments: z.array(jiraCommentSchema).max(5000) });
/** Refusals that prove the comment was NOT created (Jira answered 4xx, or nothing was sent); anything else after a send may have created it. */
const commentNotCreated = new Set(['JIRA_UNAUTHENTICATED', 'JIRA_FORBIDDEN', 'JIRA_NOT_FOUND', 'JIRA_RATE_LIMITED', 'JIRA_REQUEST_REJECTED', 'JIRA_REQUEST_REFUSED',
  'JIRA_CREDENTIAL_UNAVAILABLE', 'JIRA_SITE_URL_INVALID']);
const maxJiraCommentPages = 50;

/** Jira ticket 10: project permissions the Factory's account needs (reads; ordinary comments; remote links). */
const jiraPermissions = [{ key: 'BROWSE_PROJECTS', name: 'Browse projects' }, { key: 'ADD_COMMENTS', name: 'Add comments' }, { key: 'LINK_ISSUES', name: 'Link issues' }] as const;
const jiraPermissionsSchema = z.object({ permissions: z.record(z.string(), z.object({ havePermission: z.boolean().optional() })) });
const accessLimitation = 'Permissions of the configured account only: who can see the Factory\'s comments, and blockers in projects it cannot read, are not verified.';

/** JQL string literal: quotes and backslashes escaped (labels are validated without spaces). */
const jqlString = (value: string) => `"${value.replace(/[\\"]/g, character => `\\${character}`)}"`;

/**
 * Jira Cloud adapter of the common tracker contract. Jira ticket 01: composition and the re-read by ID; ticket 03: the JQL listing (all
 * pages, `nextPageToken`/`isLast` of the enhanced search), the re-read with components and links, the link type catalogue and a
 * neighbour's status category. The transport of each configured site is created lazily, on the first request to that site; visible
 * blockers are assembled by the Control (direction is its rule), inputs and comments answer unavailable (tickets 05/06) and the remote link
 * is refused without any call (tickets 08/09). Nothing here admits Work or authorizes commands.
 */
export function createJiraTracker(options: { scopes: JiraTrackerScope[]; transport: (scope: JiraTrackerScope) => JiraTransport }):
  IssueTracker<'jira'> & JiraRemoteLinks & JiraBlockerReads & JiraContentReads & JiraComments {
  const transports = new Map<string, JiraTransport>();
  const site = (siteId: string) => options.scopes.find(scope => scope.siteId === siteId);
  const transportOf = (scope: JiraTrackerScope) => {
    let transport = transports.get(scope.siteId);
    if (!transport) { transport = options.transport(scope); transports.set(scope.siteId, transport); }
    return transport;
  };
  const unavailable = (siteId: string, code: string, nextStep: string, observedAt = new Date().toISOString(), waitSeconds?: number): JiraUnavailable => ({
    kind: 'unavailable', source: 'jira-rest', observedAt, siteId, completeness: 'incomplete', code, ...(waitSeconds !== undefined ? { waitSeconds } : {}), nextStep });
  const notConfigured = (siteId: string) => unavailable(siteId, 'JIRA_SITE_NOT_CONFIGURED', 'Only explicitly configured Jira sites are read.');
  const notAvailable = (siteId: string) => unavailable(siteId, 'JIRA_CAPABILITY_NOT_AVAILABLE', 'This release does not read it from Jira yet; nothing is concluded.');
  const invalid = (siteId: string, observedAt: string) => unavailable(siteId, 'JIRA_OBSERVATION_INVALID', 'Jira returned an answer that could not be verified; nothing is concluded.', observedAt);
  const notSent = () => ({ kind: 'failed' as const, observedAt: new Date().toISOString(), code: 'JIRA_CAPABILITY_NOT_AVAILABLE',
    nextStep: 'This release does not write to Jira yet; nothing was sent.' });
  /** One GET/POST of a configured site: the 200 body, or the unavailable fact that concludes nothing. */
  async function read(siteId: string, request: JiraRequest): Promise<{ ok: true; body: unknown; observedAt: string } | { ok: false; fact: JiraUnavailable }> {
    const scope = site(siteId);
    if (!scope) return { ok: false, fact: notConfigured(siteId) };
    const response = await transportOf(scope).request(request);
    if (!response.ok) return { ok: false, fact: unavailable(siteId, response.code, response.nextStep, response.observedAt, response.waitSeconds) };
    if (response.status !== 200) return { ok: false, fact: invalid(siteId, response.observedAt) };
    return { ok: true, body: response.body, observedAt: response.observedAt };
  }
  const tracker: ReturnType<typeof createJiraTracker> = {
    // Jira ticket 10: one read of the account's own permissions on the configured project (diagnosis only, never a request for more access).
    async checkAccess(scope) {
      const unverified = { projectRead: 'unverified', commentCreate: 'unverified', remoteLinks: 'unverified', commentAudience: 'unverified', blockerVisibility: 'unverified' } as const;
      const base = { source: 'jira-rest' as const, purpose: 'tracker' as const, siteId: scope.siteId, projectId: scope.projectId, limitations: [accessLimitation] };
      const answer = await read(scope.siteId, { method: 'GET', path: '/rest/api/3/mypermissions',
        query: { projectId: scope.projectId, permissions: jiraPermissions.map(item => item.key).join(',') } });
      if (!answer.ok) return { ...base, observedAt: answer.fact.observedAt, status: 'blocked', code: answer.fact.code, completeness: 'incomplete', nextStep: answer.fact.nextStep, facts: unverified };
      const parsed = jiraPermissionsSchema.safeParse(answer.body);
      if (!parsed.success) return { ...base, observedAt: answer.observedAt, status: 'blocked', code: 'JIRA_OBSERVATION_INVALID', completeness: 'incomplete',
        nextStep: 'Jira returned a permissions answer that could not be verified; nothing is concluded.', facts: unverified };
      const fact = (key: string): JiraCapabilityFact => {
        const have = parsed.data.permissions[key]?.havePermission;
        return have === true ? 'granted' : have === false ? 'missing' : 'unverified';
      };
      const facts = { ...unverified, projectRead: fact('BROWSE_PROJECTS'), commentCreate: fact('ADD_COMMENTS'), remoteLinks: fact('LINK_ISSUES') };
      const missing = jiraPermissions.filter(item => fact(item.key) === 'missing');
      const open = jiraPermissions.filter(item => fact(item.key) === 'unverified');
      const ok = !missing.length && !open.length;
      return { ...base, observedAt: answer.observedAt, status: ok ? 'ok' : 'blocked', code: ok ? 'JIRA_ACCESS_OK' : missing.length ? 'JIRA_PERMISSION_MISSING' : 'JIRA_PERMISSION_UNVERIFIED',
        completeness: open.length ? 'incomplete' : 'complete', facts,
        nextStep: ok ? 'The configured account holds the project permissions the Factory uses; comment audience and blocker visibility are not provable by it.'
          : missing.length ? `Ask a Jira administrator to grant the configured account ${missing.map(item => `"${item.name}"`).join(', ')} on project ${scope.projectId} ` +
            '(the Factory never requests or widens access itself).'
            : `Jira did not answer for ${open.map(item => `"${item.name}"`).join(', ')}; nothing is concluded.` };
    },
    async listCandidates(scope) {
      const configured = site(scope.siteId);
      if (!configured || configured.projectId !== scope.projectId || configured.label !== scope.label) return notConfigured(scope.siteId);
      const jql = `project = ${scope.projectId} AND labels = ${jqlString(scope.label)}`;
      const seen = new Map<string, JiraTicketRef>();
      const tokens = new Set<string>();
      let token: string | undefined;
      let observedAt = '';
      for (let pages = 0; ; pages += 1) {
        if (pages >= maxSearchPages) return unavailable(scope.siteId, 'JIRA_SEARCH_TOO_LARGE', `More than ${maxSearchPages} result pages; narrow the project/label. Nothing is concluded.`, observedAt);
        const answer = await read(scope.siteId, { method: 'POST', path: '/rest/api/3/search/jql',
          body: { jql, fields: ['project'], maxResults: 100, ...(token === undefined ? {} : { nextPageToken: token }) } });
        if (!answer.ok) return answer.fact;
        observedAt ||= answer.observedAt;
        const parsed = jiraSearchPageSchema.safeParse(answer.body);
        if (!parsed.success || parsed.data.issues.some(item => item.fields.project.id !== scope.projectId)) return invalid(scope.siteId, answer.observedAt);
        for (const item of parsed.data.issues) if (!seen.has(item.id)) seen.set(item.id, { tracker: 'jira', siteId: scope.siteId, issueId: item.id, key: item.key, url: `${configured.url}/browse/${item.key}` });
        if (parsed.data.isLast) break;
        token = parsed.data.nextPageToken;
        if (token === undefined || tokens.has(token)) return unavailable(scope.siteId, 'JIRA_SEARCH_INCOMPLETE', 'The JQL pages did not reach their end; nothing is concluded, the next poll lists again.', answer.observedAt);
        tokens.add(token);
      }
      return { kind: 'observed', source: 'jira-rest', observedAt, siteId: scope.siteId, projectId: scope.projectId, label: scope.label, completeness: 'complete',
        candidates: [...seen.values()], limitations: [visibleOnly] };
    },
    async readTicket(ticket) {
      const answer = await read(ticket.siteId, { method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}`,
        query: { fields: 'labels,components,issuelinks,status,summary,project' } });
      if (!answer.ok) return answer.fact;
      const parsed = jiraIssueSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.id !== ticket.issueId) return invalid(ticket.siteId, answer.observedAt);
      const { key, fields } = parsed.data;
      const components = jiraComponentsSchema.safeParse(fields.components);
      const links = z.array(jiraLinkSchema).max(1000).safeParse(fields.issuelinks);
      return { kind: 'observed', source: 'jira-rest', observedAt: answer.observedAt, completeness: 'complete',
        ticket: { tracker: 'jira', siteId: ticket.siteId, issueId: ticket.issueId, key, url: `${site(ticket.siteId)!.url}/browse/${key}` },
        projectId: fields.project.id, labels: fields.labels,
        components: components.success ? components.data.map(item => ({ id: item.id, name: item.name })) : null,
        statusCategory: fields.status.statusCategory.key, summary: fields.summary ?? null,
        links: links.success ? links.data.map(link => {
          const neighbour = (link.inwardIssue ?? link.outwardIssue)!;
          return { linkId: link.id, type: { id: link.type.id, name: link.type.name, inward: link.type.inward, outward: link.type.outward },
            end: link.inwardIssue ? 'inward' as const : 'outward' as const, issue: { issueId: neighbour.id, key: neighbour.key } };
        }) : null };
    },
    async readTicketContent(ticket) {
      const answer = await read(ticket.siteId, { method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}`, query: { fields: 'summary,description' } });
      if (!answer.ok) return answer.fact;
      const parsed = jiraContentSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.id !== ticket.issueId) return invalid(ticket.siteId, answer.observedAt);
      const { description } = parsed.data.fields;
      const text = description === null || description === undefined ? null : adfPlainText(description, maxDescriptionChars);
      // A description that is present but not an ADF document is not guessed at.
      if (description !== null && description !== undefined && text === null) return invalid(ticket.siteId, answer.observedAt);
      return { kind: 'observed', source: 'jira-rest', observedAt: answer.observedAt,
        ticket: { tracker: 'jira', siteId: ticket.siteId, issueId: ticket.issueId, key: parsed.data.key, url: `${site(ticket.siteId)!.url}/browse/${parsed.data.key}` },
        summary: parsed.data.fields.summary ?? null, description: text?.text ?? null, truncated: text?.truncated ?? false };
    },
    async readLinkTypes(siteId) {
      const answer = await read(siteId, { method: 'GET', path: '/rest/api/3/issueLinkType' });
      if (!answer.ok) return answer.fact;
      const parsed = jiraLinkTypesSchema.safeParse(answer.body);
      if (!parsed.success) return invalid(siteId, answer.observedAt);
      return { kind: 'observed', source: 'jira-rest', observedAt: answer.observedAt, siteId,
        types: parsed.data.issueLinkTypes.map(type => ({ id: type.id, name: type.name, inward: type.inward, outward: type.outward })) };
    },
    async readIssueStatus(siteId, issueId) {
      const answer = await read(siteId, { method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(issueId)}`, query: { fields: 'status' } });
      if (!answer.ok) return answer.fact;
      const parsed = jiraStatusSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.id !== issueId) return invalid(siteId, answer.observedAt);
      return { kind: 'observed', source: 'jira-rest', observedAt: answer.observedAt, siteId, issueId, key: parsed.data.key, statusCategory: parsed.data.fields.status.statusCategory.key };
    },
    async publishComment(ticket, comment) {
      const scope = site(ticket.siteId);
      if (!scope) return { kind: 'failed', observedAt: new Date().toISOString(), code: 'JIRA_SITE_NOT_CONFIGURED', nextStep: 'Only explicitly configured Jira sites are written; nothing was sent.' };
      const response = await transportOf(scope).request({ method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}/comment`,
        body: { body: adfOf(comment.lines) } });
      if (!response.ok) {
        return commentNotCreated.has(response.code)
          ? { kind: 'failed', observedAt: response.observedAt, code: response.code, ...(response.waitSeconds !== undefined ? { waitSeconds: response.waitSeconds } : {}), nextStep: response.nextStep }
          : { kind: 'unknown', observedAt: response.observedAt, code: response.code, nextStep: 'The comment may have been created; it is reconciled before any new POST.' };
      }
      const created = jiraCommentCreatedSchema.safeParse(response.body);
      if (!created.success) return { kind: 'unknown', observedAt: response.observedAt, code: 'JIRA_COMMENT_RESPONSE_INVALID', nextStep: 'Jira accepted the POST with an unreadable answer; it is reconciled before any new POST.' };
      return { kind: 'published', observedAt: response.observedAt, commentId: created.data.id, createdAt: created.data.created,
        authorAccountId: created.data.author?.accountId ?? null, url: `${scope.url}/browse/${ticket.key}?focusedCommentId=${created.data.id}` };
    },
    async listComments(ticket) {
      const comments = new Map<string, JiraVisibleComment>();
      let startAt = 0;
      let observedAt = '';
      for (let pages = 0; ; pages += 1) {
        if (pages >= maxJiraCommentPages) return unavailable(ticket.siteId, 'JIRA_COMMENTS_TOO_MANY', `More than ${maxJiraCommentPages} comment pages; nothing is concluded.`, observedAt || undefined);
        const answer = await read(ticket.siteId, { method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}/comment`,
          query: { startAt: String(startAt), maxResults: '100', orderBy: 'created' } });
        if (!answer.ok) return answer.fact;
        observedAt ||= answer.observedAt;
        const page = jiraCommentPageSchema.safeParse(answer.body);
        if (!page.success || page.data.startAt !== startAt) return invalid(ticket.siteId, answer.observedAt);
        for (const item of page.data.comments) {
          const body = adfDocSchema.safeParse(item.body);
          comments.set(item.id, { commentId: item.id, authorAccountId: item.author?.accountId ?? '', text: body.success ? adfText(body.data) : '',
            createdAt: item.created, updatedAt: item.updated, restricted: Boolean(item.visibility) });
        }
        startAt += page.data.comments.length;
        if (startAt >= page.data.total) break;
        if (!page.data.comments.length) return unavailable(ticket.siteId, 'JIRA_COMMENTS_INCOMPLETE', 'A comment page ended before the announced total; nothing is concluded, the next poll reads again.', answer.observedAt);
      }
      return { kind: 'observed', source: 'jira-rest', observedAt, siteId: ticket.siteId, issueId: ticket.issueId, completeness: 'complete',
        comments: [...comments.values()], limitations: [visibleOnly] };
    },
    async readAccount(siteId) {
      const answer = await read(siteId, { method: 'GET', path: '/rest/api/3/myself' });
      if (!answer.ok) return answer.fact;
      const parsed = z.object({ accountId: z.string().min(1).max(128) }).safeParse(answer.body);
      if (!parsed.success) return invalid(siteId, answer.observedAt);
      return { kind: 'observed', source: 'jira-rest', observedAt: answer.observedAt, siteId, accountId: parsed.data.accountId };
    },
    async readDependencyGraph(ticket) { return notAvailable(ticket.siteId); },
    // Jira ticket 06: the inputs of a Work are the visible comments of its origin Card after the processed cursor (all pages, or nothing).
    async readInputs(ticket, cursor) { return jiraInputsOf(ticket, await tracker.listComments(ticket), cursor); },
    async findQuestion(ticket) { return notAvailable(ticket.siteId); },
    async findReply(ticket) { return notAvailable(ticket.siteId); },
    async postComment() { return notSent(); },
    async upsertRemoteLink(ticket, link) {
      const at = new Date().toISOString();
      if (!/^software-factory:work:[0-9a-f-]{1,64}$/.test(link.globalId) || !/^https:\/\/[^\s]{1,2000}$/.test(link.url) || !link.title.trim() || link.title.length > 255) {
        return { kind: 'failed', observedAt: at, code: 'JIRA_REMOTE_LINK_INVALID', nextStep: 'The link was refused locally (globalId, https URL or title); nothing was sent.' };
      }
      const scope = site(ticket.siteId);
      if (!scope) return { kind: 'failed', observedAt: at, code: 'JIRA_SITE_NOT_CONFIGURED', nextStep: 'Only explicitly configured Jira sites are written; nothing was sent.' };
      const response = await transportOf(scope).request({ method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}/remotelink`,
        body: { globalId: link.globalId, object: { url: link.url, title: link.title } } });
      if (!response.ok) {
        return commentNotCreated.has(response.code)
          ? { kind: 'failed', observedAt: response.observedAt, code: response.code, ...(response.waitSeconds !== undefined ? { waitSeconds: response.waitSeconds } : {}), nextStep: response.nextStep }
          : { kind: 'unknown', observedAt: response.observedAt, code: response.code, nextStep: 'The link may have been applied; the same upsert by globalId is sent again later.' };
      }
      const applied = z.object({ id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]) }).safeParse(response.body);
      if (!applied.success) return { kind: 'unknown', observedAt: response.observedAt, code: 'JIRA_REMOTE_LINK_RESPONSE_INVALID', nextStep: 'Jira answered with an unreadable body; the same upsert is sent again later.' };
      return { kind: 'applied', observedAt: response.observedAt, linkId: String(applied.data.id) };
    },
  };
  return tracker;
}
