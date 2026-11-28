import { z } from 'zod';
import { questionMarkerPrefix, replyMarkerPrefix, type GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, UnverifiedGitHubAccess, readPermissions, type GitHubAccess, type GitHubRead } from '../platform/github/index.js';
export * from './tracker-types.js';
export * from './jira-types.js';
export { createJiraTracker, jiraInputsOf } from './jira.js';
import type {
  DependencyGraphObservation,
  DependencyNode,
  DependencyPrincipal,
  DependencyProblem,
  GitHubTicketRef,
  GitHubTrackerScope,
  ClosureEvent,
  CommentAuthorRef,
  IssueTracker,
  LabelEvent,
  TicketCommentFact,
  TrackerComment,
  TrackerUnavailable,
} from './tracker-types.js';

const issueSchema = z.object({
  id: z.number().int().positive().safe(),
  node_id: z.string().min(1).max(256),
  number: z.number().int().positive().safe(),
  html_url: z.string().url(),
  repository_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullable().optional(),
  labels: z.array(z.object({ id: z.number().int().positive().safe(), name: z.string().min(1).max(256) })),
  pull_request: z.unknown().optional(),
  // The text of the issue, read only by `readTicketText`; absent or null is a valid issue without it.
  title: z.string().max(1024).nullable().optional(),
  body: z.string().max(262144).nullable().optional(),
});
type Issue = z.infer<typeof issueSchema>;
const summarySchema = z.object({ blocked_by: z.number().int().nonnegative().safe(), total_blocked_by: z.number().int().nonnegative().safe() });
const edgeSchema = z.object({
  id: z.number().int().positive().safe(),
  node_id: z.string().min(1).max(256),
  number: z.number().int().positive().safe(),
  html_url: z.string().url(),
  repository_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().max(64).nullable().optional(),
  pull_request: z.unknown().optional(),
});
type Edge = z.infer<typeof edgeSchema>;
const maxGraphNodes = 100;
const commentSchema = z.object({
  id: z.number().int().positive().safe(),
  node_id: z.string().min(1).max(256),
  html_url: z.string().url(),
  user: z.object({ id: z.number().int().positive().safe(), login: z.string().min(1).max(256), type: z.string().min(1).max(64) }),
  body: z.string().max(262144).nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  performed_via_github_app: z.object({ id: z.number().int().positive().safe() }).passthrough().nullable().optional(),
  author_association: z.string().min(1).max(64).optional(),
});
const maxCommentPages = 10;
/** A timeline entry that changes a label; every other kind of entry is skipped unread. */
const labelEventSchema = z.object({
  id: z.number().int().positive().safe(),
  event: z.enum(['labeled', 'unlabeled']),
  label: z.object({ name: z.string().min(1).max(256) }),
  created_at: z.iso.datetime(),
  actor: z
    .object({ id: z.number().int().positive().safe(), login: z.string().min(1).max(256), type: z.string().min(1).max(64) })
    .nullable()
    .optional(),
  performed_via_github_app: z.object({ id: z.number().int().positive().safe() }).passthrough().nullable().optional(),
});
const closureEventSchema = labelEventSchema.omit({ label: true }).extend({ event: z.enum(['closed', 'reopened']) });
/** Who made a timeline change: the actor GitHub names, the App it was performed through, and whether that is this installation's bot. */
function eventAuthor(event: { actor?: CommentAuthorRef | null | undefined; performed_via_github_app?: { id: number } | null | undefined }, appId: number) {
  const actor = event.actor ? { id: event.actor.id, login: event.actor.login, type: event.actor.type } : null;
  const viaApp = event.performed_via_github_app?.id ?? null;
  return { actor, viaApp, ownApp: viaApp === appId && actor?.type === 'Bot' };
}
const verified = <T>(parsed: { success: true; data: T } | { success: false }): T => {
  if (!parsed.success) throw new InvalidGitHubObservation();
  return parsed.data;
};
/** A label change of the timeline, or undefined for another kind of entry. */
function labelEventOf(kind: string, entry: unknown, appId: number): LabelEvent | undefined {
  if (kind !== 'labeled' && kind !== 'unlabeled') return undefined;
  const data = verified(labelEventSchema.safeParse(entry));
  const action = data.event === 'labeled' ? 'added' : 'removed';
  return { eventId: String(data.id), action, label: data.label.name, at: data.created_at, ...eventAuthor(data, appId) };
}
/** A closing or reopening of the timeline, or undefined for another kind of entry. */
function closureEventOf(kind: string, entry: unknown, appId: number): ClosureEvent | undefined {
  if (kind !== 'closed' && kind !== 'reopened') return undefined;
  const data = verified(closureEventSchema.safeParse(entry));
  return { eventId: String(data.id), action: data.event, at: data.created_at, ...eventAuthor(data, appId) };
}
/**
 * The label changes and the closings of a timeline, in its order. One such entry that cannot be verified fails the whole read (never a
 * shorter history); every other kind of entry is skipped unread.
 */
function timelineEvents(timeline: unknown[], appId: number): { events: LabelEvent[]; closures: ClosureEvent[] } {
  const events: LabelEvent[] = [];
  const closures: ClosureEvent[] = [];
  for (const entry of timeline) {
    const kind = verified(z.object({ event: z.string() }).safeParse(entry)).event;
    const label = labelEventOf(kind, entry, appId);
    const closure = closureEventOf(kind, entry, appId);
    if (label) events.push(label);
    if (closure) closures.push(closure);
  }
  return { events, closures };
}
/** One validated comment payload as a fact; `ownApp`: performed through `appId` by a bot author (this installation's App). */
function commentFact(comment: z.infer<typeof commentSchema>, appId: number): TicketCommentFact {
  const viaApp = comment.performed_via_github_app?.id ?? null;
  return {
    commentId: comment.id,
    nodeId: comment.node_id,
    url: comment.html_url,
    author: { id: comment.user.id, login: comment.user.login, type: comment.user.type },
    body: comment.body ?? '',
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    viaApp,
    authorAssociation: comment.author_association ?? 'NONE',
    ownApp: viaApp === appId && comment.user.type === 'Bot',
  };
}
const questionMarker = (questionId: string) => `<!-- ${questionMarkerPrefix}${questionId} -->`;
const replyMarker = (replyId: string) => `<!-- ${replyMarkerPrefix}${replyId} -->`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const repositoryName = /^https:\/\/api\.github\.com\/repos\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/;
/** Canonical repository of an issue payload; html_url must name the same repository and number (no pull request, no foreign URL). */
function edgeRepository(edge: Edge): string | undefined {
  const repository = repositoryName.exec(edge.repository_url)?.[1];
  if (
    !repository ||
    repository.split('/').some(part => part === '.' || part === '..') ||
    edge.pull_request !== undefined ||
    edge.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${edge.number}`.toLowerCase()
  )
    return undefined;
  return repository;
}
const graphLimitations = [
  'Only native blocked_by relations are read; prose, "Depends on", labels, duplicates and the inverse blocking relation are never substitutes.',
  'Reads of issues and pages are not an atomic remote snapshot; later changes are seen by the next evaluation.',
  'Equal counts (issue_dependencies_summary) do not certify the absence of relations GitHub does not show to this installation.',
];

export function createIssueTracker(options: { github: GitHubAccess; scopes?: GitHubTrackerScope[]; dependencyScopes?: GitHubScope[] }): IssueTracker {
  const unavailable = (repository: string, read: Extract<GitHubRead<unknown>, { ok: false }>): TrackerUnavailable => ({
    kind: 'unavailable',
    source: 'github-rest',
    observedAt: read.observedAt,
    repository,
    completeness: 'incomplete',
    code: read.code,
    ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}),
    nextStep: read.nextStep,
  });
  const reference = (scope: GitHubScope, repositoryId: number, issue: Issue): GitHubTicketRef => {
    // GitHub owner/repository names are case-insensitive; the immutable ids carry identity.
    if (
      issue.repository_url.toLowerCase() !== `https://api.github.com/repos/${scope.repository}`.toLowerCase() ||
      issue.html_url.toLowerCase() !== `https://github.com/${scope.repository}/issues/${issue.number}`.toLowerCase()
    )
      throw new InvalidGitHubObservation();
    return {
      tracker: 'github',
      repository: scope.repository,
      repositoryId,
      issueId: issue.id,
      nodeId: issue.node_id,
      number: issue.number,
      url: issue.html_url,
    };
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
    const fromEdge = (item: Item, role: DependencyNode['repositoryRole'], repositoryId: number | null): DependencyNode | undefined =>
      item.edge
        ? {
            issueId: item.edge.id,
            nodeId: item.edge.node_id,
            repository: item.repository,
            repositoryId,
            number: item.edge.number,
            url: item.edge.html_url,
            state: item.edge.state,
            stateReason: item.edge.state_reason ?? null,
            access: 'edge-only',
            repositoryRole: role,
            blockedBy: null,
          }
        : undefined;
    const unavailable = (item: Item, read: Extract<GitHubRead<unknown>, { ok: false }>, what: string): DependencyProblem => ({
      code: 'DEPENDENCY_READ_UNAVAILABLE',
      issueId: item.issueId,
      repository: item.repository,
      observedCode: read.code,
      ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}),
      nextStep: `${what} of ${item.repository}#${item.number} could not be read completely (${read.code}); nothing is concluded from a partial read. ${read.nextStep}`,
    });
    while (queue.length) {
      const item = queue.shift()!;
      if (nodes.size >= maxGraphNodes) {
        problems.push({
          code: 'DEPENDENCY_GRAPH_TOO_LARGE',
          issueId: item.issueId,
          repository: item.repository,
          nextStep: `More than ${maxGraphNodes} reachable issues; the traversal was not completed and does not release. Operator must reduce or inspect the graph.`,
        });
        break;
      }
      const configured = configuredFor(item.repository);
      if (!configured) {
        const node = fromEdge(item, 'not-configured', null);
        if (node) nodes.set(node.issueId, node);
        problems.push({
          code: 'DEPENDENCY_REPOSITORY_NOT_CONFIGURED',
          issueId: item.issueId,
          repository: item.repository,
          nextStep:
            `Blocker ${item.repository}#${item.number} is in a repository not configured for this installation. Add it to dependencyRepositories ` +
            '(read-only, never executable) with the App installation that can read it, or remove the relation; it is never read with another identity.',
        });
        continue;
      }
      const { scope, role } = configured;
      const principal = (repositoryId: number | null) => {
        const key = `${scope.installationId}\n${scope.repository.toLowerCase()}`;
        const known = principals.get(key);
        if (!known || (known.repositoryId === null && repositoryId !== null))
          principals.set(key, {
            installationId: scope.installationId,
            repository: scope.repository,
            repositoryId,
            role,
            purpose: 'dependency-read',
            permissions: readPermissions['dependency-read'],
          });
      };
      const issueRead = await options.github.read(scope, 'dependency-read', async session => {
        const parsed = issueSchema
          .extend({ issue_dependencies_summary: z.unknown().optional() })
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
        problems.push({
          code: item.edge ? 'INVALID_DEPENDENCY_RELATION' : 'DEPENDENCY_ROOT_MISMATCH',
          issueId: item.issueId,
          repository: item.repository,
          nextStep: `${item.repository}#${item.number} no longer carries the related qualified identity (transfer/renumbering?); operator must inspect it on GitHub.`,
        });
        continue;
      }
      const node: DependencyNode = {
        issueId: issue.id,
        nodeId: issue.node_id,
        repository: scope.repository,
        repositoryId: issueRead.repositoryId,
        number: issue.number,
        url: issue.html_url,
        state: issue.state,
        stateReason: issue.state_reason ?? null,
        access: 'edge-only',
        repositoryRole: role,
        blockedBy: null,
      };
      nodes.set(node.issueId, node);
      const listing = await options.github.read(scope, 'dependency-read', session =>
        session.list(`/repos/${scope.repository}/issues/${item.number}/dependencies/blocked_by`),
      );
      if (!listing.ok) {
        problems.push(unavailable(item, listing, 'Native blocked_by'));
        continue;
      }
      const edges: Edge[] = [];
      let invalid = 0,
        repeated = 0;
      for (const entry of listing.value) {
        const parsed = edgeSchema.safeParse(entry);
        const repository = parsed.success ? edgeRepository(parsed.data) : undefined;
        if (!parsed.success || !repository || parsed.data.id === issue.id) {
          invalid++;
          continue;
        }
        if (edges.some(edge => edge.id === parsed.data.id)) {
          repeated++;
          continue;
        }
        edges.push(parsed.data);
      }
      if (invalid)
        problems.push({
          code: 'INVALID_DEPENDENCY_RELATION',
          issueId: issue.id,
          repository: scope.repository,
          nextStep: `${scope.repository}#${issue.number} lists ${invalid} invalid native blocked_by entr${invalid === 1 ? 'y' : 'ies'} (pull request, self, foreign URL or unexpected payload); operator must inspect the relations.`,
        });
      if (repeated)
        problems.push({
          code: 'DEPENDENCY_LISTING_UNSTABLE',
          issueId: issue.id,
          repository: scope.repository,
          nextStep: `${scope.repository}#${issue.number} returned the same blocker on several pages (concurrent change?); the listing may have skipped entries. Re-evaluated on the next poll.`,
        });
      const parsedSummary = summarySchema.safeParse(issue.issue_dependencies_summary);
      const summary = parsedSummary.success ? parsedSummary.data : undefined;
      // Without GitHub's own count, an edge hidden from this installation is indistinguishable from no edge: never complete.
      if (!summary)
        problems.push({
          code: 'DEPENDENCY_SUMMARY_UNAVAILABLE',
          issueId: issue.id,
          repository: scope.repository,
          nextStep:
            `${scope.repository}#${issue.number}: issue_dependencies_summary is absent or unparseable, so blockers GitHub omits for this installation ` +
            'cannot be detected. Nothing is released; the operator must verify the relations on GitHub (or the REST version/compatibility).',
        });
      else if (
        summary.total_blocked_by !== listing.value.length ||
        (!invalid && !repeated && summary.blocked_by !== edges.filter(edge => edge.state === 'open').length)
      ) {
        problems.push({
          code: 'DEPENDENCY_COUNT_MISMATCH',
          issueId: issue.id,
          repository: scope.repository,
          nextStep:
            `${scope.repository}#${issue.number}: listed ${listing.value.length} native blocker(s) but GitHub reports ${summary.total_blocked_by} (open ${summary.blocked_by}); ` +
            'relations this installation cannot see, or a concurrent change, make the graph incomplete. Grant read access to the blocker repository or inspect it on GitHub.',
        });
      }
      node.blockedBy = edges.map(edge => edge.id);
      if (!invalid) node.access = 'read';
      for (const edge of edges) {
        if (seen.has(edge.id)) continue;
        seen.add(edge.id);
        queue.push({ repository: edgeRepository(edge)!, number: edge.number, issueId: edge.id, nodeId: edge.node_id, edge });
      }
    }
    return {
      kind: 'observed',
      source: 'github-rest',
      observedAt,
      root: ticket,
      completeness: problems.length ? 'incomplete' : 'complete',
      principals: [...principals.values()],
      nodes: [...nodes.values()],
      problems,
      limitations: graphLimitations,
    };
  }

  const executableScope = (ticket: GitHubTicketRef) =>
    options.scopes?.find(candidate => candidate.repository.toLowerCase() === ticket.repository.toLowerCase());
  const notConfigured = (ticket: GitHubTicketRef): TrackerUnavailable => ({
    kind: 'unavailable',
    source: 'github-rest',
    observedAt: new Date().toISOString(),
    repository: ticket.repository,
    completeness: 'incomplete',
    code: 'REPOSITORY_NOT_CONFIGURED',
    nextStep: 'Only explicitly configured repositories are read or written.',
  });
  /** Complete comment listing of the Ticket issue, every entry validated; a single invalid entry fails the whole read (no partial result). */
  const comments = (scope: GitHubScope, ticket: GitHubTicketRef) =>
    options.github.read(scope, 'tracker-read', async session => {
      if (session.repositoryId !== ticket.repositoryId) throw new InvalidGitHubObservation();
      // Bounded per read: more than maxCommentPages pages is incomplete (unavailable), never a truncated listing.
      const parsed = z
        .array(commentSchema)
        .safeParse(await session.list(`/repos/${scope.repository}/issues/${ticket.number}/comments`, { maxPages: maxCommentPages }));
      if (!parsed.success) throw new InvalidGitHubObservation();
      const seen = new Set<number>();
      const result: TicketCommentFact[] = [];
      for (const comment of parsed.data) {
        if (comment.html_url.toLowerCase() !== `https://github.com/${scope.repository}/issues/${ticket.number}#issuecomment-${comment.id}`.toLowerCase())
          throw new InvalidGitHubObservation();
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        result.push(commentFact(comment, options.github.appId));
      }
      return result.sort((a, b) => a.commentId - b.commentId);
    });
  const ownMarked = (list: TrackerComment[], marker: string) =>
    list.filter(comment => comment.viaApp === options.github.appId && comment.author.type === 'Bot' && comment.body.startsWith(`${marker}\n`));
  const ownQuestions = (list: TrackerComment[], questionId: string) => ownMarked(list, questionMarker(questionId));

  return {
    async readTicketComments(ticket) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      const read = await comments(scope, ticket);
      if (!read.ok) return unavailable(scope.repository, read);
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        ticket,
        completeness: 'complete',
        comments: read.value,
        limitations: [
          'Complete listing at one instant, not an atomic snapshot.',
          'Comments are facts; which of them compose the Ticket text is decided by the Control.',
        ],
      };
    },
    async readInputs(ticket, cursor) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      const read = await comments(scope, ticket);
      if (!read.ok) return unavailable(scope.repository, read);
      const after = read.value.filter(comment => cursor === null || comment.commentId > cursor);
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        ticket,
        completeness: 'complete',
        comments: after,
        cursor: read.value.length ? Math.max(cursor ?? 0, read.value.at(-1)!.commentId) : cursor,
        limitations: [
          'Complete listing at one instant, not an atomic snapshot; edits after reading are not seen as new comments.',
          'Comments are evidence; authorization and correlation are decided by the Control.',
        ],
      };
    },
    async findQuestion(ticket, questionId) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      if (!uuid.test(questionId)) throw new Error('INVALID_QUESTION_ID');
      const read = await comments(scope, ticket);
      if (!read.ok) return unavailable(scope.repository, read);
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        completeness: 'complete',
        candidates: ownQuestions(read.value, questionId).map(comment => ({ commentId: comment.commentId, url: comment.url, createdAt: comment.createdAt })),
        limitations: ["Only comments performed by this installation's App with the exact marker line count; a listing is not an atomic snapshot."],
      };
    },
    async findReply(ticket, replyId) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      if (!uuid.test(replyId)) throw new Error('INVALID_REPLY_ID');
      const read = await comments(scope, ticket);
      if (!read.ok) return unavailable(scope.repository, read);
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        completeness: 'complete',
        candidates: ownMarked(read.value, replyMarker(replyId)).map(comment => ({
          commentId: comment.commentId,
          url: comment.url,
          createdAt: comment.createdAt,
        })),
        limitations: ["Only comments performed by this installation's App with the exact reply marker count; a listing is not an atomic snapshot."],
      };
    },
    async postComment(ticket, comment, effect) {
      const scope = executableScope(ticket);
      const observedAt = new Date().toISOString();
      if (!scope) return { kind: 'failed', observedAt, code: 'REPOSITORY_NOT_CONFIGURED', nextStep: 'Only configured repositories receive Questions.' };
      const id = comment.kind === 'question' ? comment.questionId : comment.kind === 'reply' ? comment.replyId : '';
      const correlated = comment.kind === 'question' ? 'questionId' in effect && effect.questionId === id : 'replyId' in effect && effect.replyId === id;
      if (
        (comment.kind !== 'question' && comment.kind !== 'reply') ||
        !uuid.test(id) ||
        !correlated ||
        comment.body.includes(questionMarkerPrefix) ||
        comment.body.includes(replyMarkerPrefix)
      ) {
        return { kind: 'failed', observedAt, code: 'INVALID_QUESTION_COMMENT', nextStep: 'Rejected locally; nothing was sent.' };
      }
      const marker = comment.kind === 'question' ? questionMarker(id) : replyMarker(id);
      const written = await options.github.comment(scope, ticket.number, `${marker}\n${comment.body}`);
      const revocation = written.revocation;
      if (!written.ok)
        return written.outcome === 'unknown'
          ? { kind: 'unknown', observedAt: written.observedAt, code: written.code, nextStep: written.nextStep, revocation }
          : {
              kind: 'failed',
              observedAt: written.observedAt,
              code: written.code,
              ...(written.waitSeconds !== undefined ? { waitSeconds: written.waitSeconds } : {}),
              nextStep: written.nextStep,
              revocation,
            };
      const parsed = commentSchema.safeParse(written.value);
      if (
        !parsed.success ||
        written.repositoryId !== ticket.repositoryId ||
        !parsed.data.body?.startsWith(`${marker}\n`) ||
        parsed.data.html_url.toLowerCase() !== `https://github.com/${scope.repository}/issues/${ticket.number}#issuecomment-${parsed.data.id}`.toLowerCase()
      ) {
        return {
          kind: 'unknown',
          observedAt: written.observedAt,
          code: 'GITHUB_WRITE_UNVERIFIED',
          nextStep: 'GitHub accepted a write whose result could not be verified; discover the marker before any new publication.',
          revocation,
        };
      }
      return {
        kind: 'published',
        observedAt: written.observedAt,
        commentId: parsed.data.id,
        url: parsed.data.html_url,
        createdAt: parsed.data.created_at,
        revocation,
      };
    },
    readDependencyGraph,
    async writeTriage(ticket, write) {
      const scope = executableScope(ticket);
      const observedAt = new Date().toISOString();
      if (!scope) return { kind: 'failed', observedAt, code: 'REPOSITORY_NOT_CONFIGURED', nextStep: 'Only configured repositories are written.' };
      const written = await options.github.triageWrite(scope, ticket.number, write);
      if (!written.ok) {
        const { code, nextStep, waitSeconds } = written;
        if (written.outcome === 'unknown') return { kind: 'unknown', observedAt: written.observedAt, code, nextStep };
        return { kind: 'failed', observedAt: written.observedAt, code, ...(waitSeconds !== undefined ? { waitSeconds } : {}), nextStep };
      }
      if (written.repositoryId !== ticket.repositoryId)
        return {
          kind: 'unknown',
          observedAt: written.observedAt,
          code: 'GITHUB_WRITE_UNVERIFIED',
          nextStep: 'GitHub accepted a write on a repository that is not the one of the Ticket; read the issue before any new write.',
        };
      const comment = write.kind === 'comment' ? commentSchema.safeParse(written.value) : undefined;
      return {
        kind: 'accepted',
        observedAt: written.observedAt,
        ...(comment?.success ? { comment: { commentId: comment.data.id, url: comment.data.html_url } } : {}),
      };
    },
    async readLabelHistory(ticket) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      const read = await options.github.read(scope, 'tracker-read', async session => {
        if (session.repositoryId !== ticket.repositoryId) throw new InvalidGitHubObservation();
        return timelineEvents(await session.list(`/repos/${scope.repository}/issues/${ticket.number}/timeline`), options.github.appId);
      });
      if (!read.ok) return unavailable(scope.repository, read);
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        ticket,
        completeness: 'complete',
        events: read.value.events,
        closures: read.value.closures,
        limitations: ['The timeline is read at one instant, not an atomic snapshot; who changed a label is evidence, never an authorization.'],
      };
    },
    checkAccess(scope) {
      if ('role' in scope)
        return options.github.diagnose(scope, 'dependency', async session => {
          // One bounded sample page (no full listing of the repository).
          const issues = z
            .array(z.object({ id: z.number().int().positive(), number: z.number().int().positive(), pull_request: z.unknown().optional() }).passthrough())
            .safeParse(await session.get(`/repos/${scope.repository}/issues?state=all&per_page=100`));
          if (!issues.success) throw new InvalidGitHubObservation();
          const sample = issues.data.find(item => item.pull_request === undefined);
          if (!sample)
            throw new UnverifiedGitHubAccess(
              'DEPENDENCY_ACCESS_UNVERIFIED',
              `${scope.repository}: the sample page has no issue (only pull requests or none), ` +
                'so native dependency reads were not verified; no issue or relation is created to test it. Blockers there are still read and checked in operation.',
            );
          if (
            !z.array(edgeSchema.passthrough()).safeParse(await session.list(`/repos/${scope.repository}/issues/${sample.number}/dependencies/blocked_by`))
              .success
          ) {
            throw new InvalidGitHubObservation();
          }
          return [
            'Dependency-only repository: issues and native blocked_by readable on one sample; pairs, hidden relations and other repositories are not certified.',
          ];
        });
      return options.github.diagnose(scope, 'tracker', async session => {
        const issues = await session.list(`/repos/${scope.repository}/issues`);
        const issue = z.object({
          id: z.number().int().positive(),
          number: z.number().int().positive(),
          repository_url: z.literal(`https://api.github.com/repos/${scope.repository}`),
        });
        const parsed = z.array(issue.passthrough()).safeParse(issues);
        if (!parsed.success) throw new InvalidGitHubObservation();
        const sample = parsed.data.find(item => !item.pull_request);
        if (sample) {
          const dependencies = await session.list(`/repos/${scope.repository}/issues/${sample.number}/dependencies/blocked_by`);
          if (
            !z
              .array(
                z.object({
                  id: z.number().int().positive(),
                  number: z.number().int().positive(),
                  repository_url: z.string().url(),
                  state: z.enum(['open', 'closed']),
                }),
              )
              .safeParse(dependencies).success
          )
            throw new InvalidGitHubObservation();
        }
        const comments = await session.list(`/repos/${scope.repository}/issues/comments`);
        const comment = z.object({ id: z.number().int().positive(), user: z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() }) });
        if (!z.array(comment).safeParse(comments).success) throw new InvalidGitHubObservation();
        return sample
          ? ['Native dependencies probed on one accessible issue only; hidden relations and other repositories are not certified.']
          : ['No issue available for a native dependency probe; native dependency access remains unverified.'];
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
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        repository: scope.repository,
        repositoryId: read.repositoryId,
        label: scope.label,
        completeness: 'complete',
        candidates: read.value,
        limitations: ['Listing is not an atomic remote snapshot and does not admit Work; each candidate is re-read before admission.'],
      };
    },
    async readTicketText(ticket) {
      const scope = executableScope(ticket);
      if (!scope) return notConfigured(ticket);
      const read = await options.github.read(scope, 'tracker-read', async session => {
        const parsed = issueSchema.safeParse(await session.get(`/repos/${scope.repository}/issues/${ticket.number}`));
        if (!parsed.success || session.repositoryId !== ticket.repositoryId || parsed.data.id !== ticket.issueId) throw new InvalidGitHubObservation();
        return parsed.data;
      });
      if (!read.ok) return unavailable(scope.repository, read);
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        ticket,
        completeness: 'complete',
        title: read.value.title ?? null,
        body: read.value.body ?? null,
      };
    },
    async readTicket(ticket) {
      const scope = options.scopes?.find(candidate => candidate.repository.toLowerCase() === ticket.repository.toLowerCase());
      if (!scope)
        return {
          kind: 'unavailable',
          source: 'github-rest',
          observedAt: new Date().toISOString(),
          repository: ticket.repository,
          completeness: 'incomplete',
          code: 'REPOSITORY_NOT_CONFIGURED',
          nextStep: 'Only explicitly configured repositories are read; add it to the configuration and restart if intended.',
        };
      const read = await options.github.read(scope, 'tracker-read', async session => {
        const parsed = issueSchema.safeParse(await session.get(`/repos/${scope.repository}/issues/${ticket.number}`));
        if (!parsed.success) throw new InvalidGitHubObservation();
        return { ref: reference(scope, session.repositoryId, parsed.data), issue: parsed.data };
      });
      if (!read.ok) return unavailable(scope.repository, read);
      const { ref, issue } = read.value;
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        completeness: 'complete',
        ticket: ref,
        state: issue.state,
        stateReason: issue.state_reason ?? null,
        labels: issue.labels.map(label => ({ id: label.id, name: label.name })),
        pullRequest: issue.pull_request !== undefined,
      };
    },
  };
}

export { adfPlainText } from './jira-adf-text.js';
export {
  createJiraHttpTransport,
  type JiraHostSite,
  type JiraHttpExchange,
  type JiraHttpResult,
  type JiraRequest,
  type JiraResponse,
  type JiraTransport,
} from './jira-http.js';
