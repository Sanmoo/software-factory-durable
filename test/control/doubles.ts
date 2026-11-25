// Test doubles for the IssueTracker/CodeRepository contracts and the polling clock.
// They replace GitHub only; Control, Pi Durable and SQLite stay real in every flow test.
import type {
  IssueTracker,
  GitHubTicketRef as TicketRef,
  CandidateObservation,
  TicketObservation,
  GitHubTrackerScope as TrackerScope,
  DependencyNode,
  DependencyProblem,
  LabelEvent,
  LabelHistoryObservation,
  TrackerComment,
} from '../../src/issue-tracker/index.js';
import type {
  BranchComparison,
  CodeRepository,
  ConversationCommentFact,
  FeedbackObservation,
  PublicationObservation,
  PullRequestCandidate,
  PullRequestObservation,
  ReviewCommentFact,
  ReviewFact,
} from '../../src/code-repository/index.js';
import type { PollingClock } from '../../src/control/types.js';
import type { EnvironmentDeclarationObservation } from '../../src/contracts/index.js';

/** Ticket 44: the declaration every double repository reports by default (JDK 25 at the base tip 'b'*40). */
export const declaredEnvironment = { schemaVersion: 1 as const, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }], images: [] };
export const declaredEnvironmentSha256 = 'e'.repeat(64);

export type RemoteIssue = {
  ref: TicketRef;
  state: 'open' | 'closed';
  labels: { id: number; name: string }[];
  pullRequest?: boolean;
  reread?: Partial<TicketRef>;
  stateReason?: string | null;
  /** Native blocked_by edges, by issue number in remote.issues. */ blockedBy?: number[];
  /** Spec #68: the issue's label changes as its timeline reports them (`applyLabel`/`removeLabel` keep it with `labels`). */
  labelEvents?: LabelEvent[];
};
export type Unavailable = { code: string; waitSeconds?: number };
export type Remote = {
  issues: RemoteIssue[];
  pulls: Record<number, PullRequestCandidate[]>;
  /** Ticket 14: remote tips of known branches (absent key = absent ref); `unknown` = the ref read failed. */
  refs?: Record<string, string | 'unknown'>;
  /** Ticket 14: tags (`refs/tags/<name>` → sha); main is always at 'b'*40. `refsUnknown`: the repository-wide listing fails. */
  tags?: Record<string, string>;
  refsUnknown?: boolean;
  /** Ticket 14: base protection as the adapter reports it (default: pull requests required by a ruleset the App cannot bypass). */
  baseProtection?: { state: 'pull-request-required'; sources: string[] } | { state: 'not-required'; reason: string } | { state: 'unknown'; code: string };
  listFailure?: Unavailable;
  readFailure?: Unavailable;
  /** Spec #68: readLabelHistory answers unavailable while set. */
  labelHistoryFailure?: Unavailable;
  publicationFailure?: Unavailable;
  /** Per-Ticket incomplete association (e.g. timeline unavailable). */
  incompleteAssociation?: Record<number, Unavailable>;
  /** readTicket throws (unexpected adapter failure). */
  readThrows?: boolean;
  /** Extra refs returned by the listing, e.g. from another repository. */
  extraListed?: TicketRef[];
  hang?: Promise<void>;
  /** Problems the dependency graph read reports for a root Ticket number (e.g. a rate-limited page). */
  dependencyProblems?: Record<number, DependencyProblem[]>;
  /** readDependencyGraph throws (unexpected adapter failure). */
  graphThrows?: boolean;
  /** Issue comments by issue number (ascending ids). postComment appends App-bot comments here. */
  comments?: Record<number, TrackerComment[]>;
  /** Spec #68 ticket #74: GitHub's `author_association` by author login (absent = NONE), as readTicketComments reports it. */
  associations?: Record<string, string>;
  /** Number of next readTicketComments calls that are incomplete (unavailable). */
  incompleteTicketComments?: number;
  /** Consumed one per postComment: unknown outcome (created or not) or known failure; absent = published. */
  postOutcomes?: ('unknown-created' | 'unknown-not-created' | 'failed')[];
  /** Number of next findQuestion calls that are incomplete (unavailable). */
  incompleteSearches?: number;
  /** Number of next readInputs calls that are incomplete (unavailable). */
  incompleteInputs?: number;
  /** Ticket 15: readPullRequest observations by PR number (absent = unavailable GITHUB_NOT_FOUND_OR_HIDDEN). */
  pullRequests?: Record<number, PullRequestObservation>;
  /** Ticket 16: setDraft outcomes consumed one per call (absent = applied). `unknown-*`: the caller learns nothing; whether the flag changed is
   * decided here. An applied conversion changes `pullRequests[n].pullRequest.draft` (the next readPullRequest observes it). */
  drafts?: ('applied' | 'known-failure' | 'unknown-applied' | 'unknown-not-applied')[];
  /** Ticket 21: comparisons by `from...to` (absent = one synthetic commit `to` linked to operator-one; `unknown` = the read fails). */
  comparisons?: Record<string, BranchComparison | 'unknown'>;
  /** Review HIGH: push activity of each branch (appended by the publication doubles and human pushes); `activityUnknown` fails it. */
  activity?: Record<string, { before: string; after: string; type: string; actor: { login: string; id: number } | null; at: string }[]>;
  activityUnknown?: boolean;
  /** Review HIGH: commit graph (sha -> parents) for ancestry comparisons, and the files changed between two commits (`from...to`). */
  graph?: Record<string, string[]>;
  changes?: Record<string, string[]>;
  /** Ticket 23: human feedback of own PRs by number (absent = empty complete listings); `unavailable` = the read fails. */
  feedback?: Record<number, { reviews?: ReviewFact[]; reviewComments?: ReviewCommentFact[]; comments?: ConversationCommentFact[] } | 'unavailable'>;
  /** Ticket 21: tip of the base `main` in the refs listing (default 'b'*40); changing it models the base merely advancing. */
  main?: string;
  /** Ticket 44: what readEnvironmentDeclaration observes (default: `declaredEnvironment` at the base tip); not tracked in `calls`. */
  environment?: EnvironmentDeclarationObservation extends infer O ? (O extends unknown ? Omit<O, 'observedAt'> : never) : never;
  environmentReads?: number;
};
let commentSequence = 80000;
/** A comment as the tracker adapter reports it. */
export function comment(
  body: string,
  author: { id: number; login: string; type: string } = { id: 1, login: 'operator', type: 'User' },
  issue = 3,
  viaApp: number | null = null,
): TrackerComment {
  const id = ++commentSequence;
  // One clock read: two reads can straddle a millisecond and make an unedited comment look edited (COMMENT_EDITED).
  const at = new Date().toISOString();
  return {
    commentId: id,
    nodeId: `IC_${id}`,
    url: `https://github.com/acme/project/issues/${issue}#issuecomment-${id}`,
    author,
    body,
    createdAt: at,
    updatedAt: at,
    viaApp,
  };
}
export const factoryAppId = 1;
export const dependencyPrincipal = {
  installationId: 2,
  repository: 'acme/project',
  repositoryId: 3,
  role: 'executable' as const,
  purpose: 'dependency-read' as const,
  permissions: { metadata: 'read' as const, issues: 'read' as const },
};
export const scope: TrackerScope & { base: string } = {
  repository: 'acme/project',
  installationId: 2,
  workflows: false,
  label: 'ready-for-agent',
  base: 'main',
};
export function ticket(number: number, overrides: Partial<TicketRef> = {}): TicketRef {
  return {
    tracker: 'github',
    repository: 'acme/project',
    repositoryId: 3,
    issueId: 7000 + number,
    nodeId: `I_node${number}`,
    number,
    url: `https://github.com/acme/project/issues/${number}`,
    ...overrides,
  };
}
export function remoteIssue(number: number, overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  return { ref: ticket(number), state: 'open', labels: [{ id: 55, name: 'ready-for-agent' }], ...overrides };
}
let labelEventSequence = 90000;
const labelEvent = (action: LabelEvent['action'], label: string, actor: LabelEvent['actor']): LabelEvent => ({
  eventId: String(++labelEventSequence),
  action,
  label,
  at: new Date().toISOString(),
  actor,
  viaApp: null,
});
/** Spec #68: a person applies a label to the issue (label set and timeline together), as any account allowed to label would. */
export function applyLabel(issue: RemoteIssue, name: string, actor: LabelEvent['actor'] = { id: 77, login: 'stranger', type: 'User' }) {
  if (!issue.labels.some(label => label.name === name)) issue.labels = [...issue.labels, { id: 500 + issue.labels.length, name }];
  issue.labelEvents = [...(issue.labelEvents ?? []), labelEvent('added', name, actor)];
}
export function removeLabel(issue: RemoteIssue, name: string, actor: LabelEvent['actor'] = { id: 77, login: 'stranger', type: 'User' }) {
  issue.labels = issue.labels.filter(label => label.name !== name);
  issue.labelEvents = [...(issue.labelEvents ?? []), labelEvent('removed', name, actor)];
}
export function foreignPull(number: number, overrides: Partial<PullRequestCandidate> = {}): PullRequestCandidate {
  return {
    pullRequestId: 9000 + number,
    nodeId: `PR_node${number}`,
    number,
    url: `https://github.com/acme/project/pull/${number}`,
    state: 'open',
    merged: false,
    headRef: `human/${number}`,
    headRepositoryId: 3,
    author: { id: 10, login: 'someone', type: 'User' },
    association: ['closing-reference'],
    headSha: 'c'.repeat(40),
    baseRef: 'main',
    draft: false,
    body: null,
    ...overrides,
  };
}

export function githubDoubles(remote: Remote) {
  const calls: { method: string; at: number; args?: unknown }[] = [];
  let active = 0;
  let maxActive = 0;
  const observedAt = () => new Date().toISOString();
  const track = async <T>(method: string, body: () => T | Promise<T>, args?: unknown): Promise<T> => {
    calls.push({ method, at: calls.length, args });
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (remote.hang) await remote.hang;
      return await body();
    } finally {
      active--;
    }
  };
  const failure = (repository: string, value: Unavailable) => ({
    kind: 'unavailable' as const,
    source: 'github-rest' as const,
    observedAt: observedAt(),
    repository,
    completeness: 'incomplete' as const,
    code: value.code,
    ...(value.waitSeconds !== undefined ? { waitSeconds: value.waitSeconds } : {}),
    nextStep: `synthetic ${value.code}`,
  });
  const tracker: IssueTracker = {
    checkAccess() {
      throw new Error('not used by admission');
    },
    listCandidates: s =>
      track('listCandidates', (): CandidateObservation =>
        remote.listFailure
          ? failure(s.repository, remote.listFailure)
          : {
              kind: 'observed',
              source: 'github-rest',
              observedAt: observedAt(),
              repository: s.repository,
              repositoryId: 3,
              label: s.label,
              completeness: 'complete',
              candidates: [
                ...remote.issues.filter(i => i.state === 'open' && i.labels.some(l => l.name === s.label)).map(i => i.ref),
                ...(remote.extraListed ?? []),
              ],
              limitations: [],
            },
      ),
    readTicket: ref =>
      track('readTicket', (): TicketObservation => {
        if (remote.readThrows) throw new Error('synthetic unexpected adapter failure');
        if (remote.readFailure) return failure(ref.repository, remote.readFailure);
        const found = remote.issues.find(i => i.ref.number === ref.number && i.ref.repository === ref.repository);
        if (!found) return failure(ref.repository, { code: 'GITHUB_NOT_FOUND_OR_HIDDEN' });
        return {
          kind: 'observed',
          source: 'github-rest',
          observedAt: observedAt(),
          completeness: 'complete',
          ticket: { ...found.ref, ...found.reread },
          state: found.state,
          stateReason: found.stateReason ?? null,
          labels: found.labels,
          pullRequest: found.pullRequest ?? false,
        };
      }),
    readLabelHistory: ref =>
      track(
        'readLabelHistory',
        (): LabelHistoryObservation => {
          const found = remote.issues.find(i => i.ref.number === ref.number && i.ref.repository === ref.repository);
          if (remote.labelHistoryFailure || !found) return failure(ref.repository, remote.labelHistoryFailure ?? { code: 'GITHUB_NOT_FOUND_OR_HIDDEN' });
          return {
            kind: 'observed',
            source: 'github-rest',
            observedAt: observedAt(),
            ticket: ref,
            completeness: 'complete',
            events: structuredClone(found.labelEvents ?? []),
            limitations: [],
          };
        },
        ref.number,
      ),
    // Reachable native graph over remote.issues (same repository), each node once; problems are injected per root Ticket.
    readDependencyGraph: ref =>
      track(
        'readDependencyGraph',
        () => {
          if (remote.graphThrows) throw new Error('synthetic unexpected adapter failure');
          const nodes: DependencyNode[] = [];
          const queue = [ref.number];
          const seen = new Set(queue);
          while (queue.length) {
            const found = remote.issues.find(i => i.ref.number === queue[0]);
            queue.shift();
            if (!found) continue;
            const blockers = (found.blockedBy ?? []).map(n => remote.issues.find(i => i.ref.number === n)!);
            nodes.push({
              issueId: found.ref.issueId,
              nodeId: found.ref.nodeId,
              repository: found.ref.repository,
              repositoryId: found.ref.repositoryId,
              number: found.ref.number,
              url: found.ref.url,
              state: found.state,
              stateReason: found.stateReason ?? null,
              access: 'read',
              repositoryRole: 'executable',
              blockedBy: blockers.map(b => b.ref.issueId),
            });
            for (const blocker of blockers)
              if (!seen.has(blocker.ref.number)) {
                seen.add(blocker.ref.number);
                queue.push(blocker.ref.number);
              }
          }
          const problems = remote.dependencyProblems?.[ref.number] ?? [];
          return {
            kind: 'observed' as const,
            source: 'github-rest' as const,
            observedAt: observedAt(),
            root: ref,
            completeness: problems.length ? ('incomplete' as const) : ('complete' as const),
            principals: [dependencyPrincipal],
            problems,
            limitations: ['synthetic graph'],
            nodes,
          };
        },
        ref,
      ),
    // Spec #68 ticket #74: every comment of the Ticket issue with the author's association and whether the Factory App performed it.
    readTicketComments: ref =>
      track(
        'readTicketComments',
        () => {
          if (remote.incompleteTicketComments) {
            remote.incompleteTicketComments--;
            return failure(ref.repository, { code: 'GITHUB_QUERY_FAILED' });
          }
          return {
            kind: 'observed' as const,
            source: 'github-rest' as const,
            observedAt: observedAt(),
            ticket: ref,
            completeness: 'complete' as const,
            comments: structuredClone(remote.comments?.[ref.number] ?? []).map(item => ({
              ...item,
              authorAssociation: remote.associations?.[item.author.login] ?? 'NONE',
              ownApp: item.viaApp === factoryAppId && item.author.type === 'Bot',
            })),
            limitations: ['synthetic'],
          };
        },
        { number: ref.number },
      ),
    readInputs: (ref, cursor) =>
      track(
        'readInputs',
        () => {
          if (remote.incompleteInputs) {
            remote.incompleteInputs--;
            return failure(ref.repository, { code: 'GITHUB_QUERY_FAILED' });
          }
          const all = remote.comments?.[ref.number] ?? [];
          const after = all.filter(item => cursor === null || item.commentId > cursor);
          return {
            kind: 'observed' as const,
            source: 'github-rest' as const,
            observedAt: observedAt(),
            ticket: ref,
            completeness: 'complete' as const,
            comments: structuredClone(after),
            cursor: all.length ? Math.max(cursor ?? 0, all.at(-1)!.commentId) : cursor,
            limitations: ['synthetic'],
          };
        },
        { number: ref.number, cursor },
      ),
    findQuestion: (ref, questionId) =>
      track(
        'findQuestion',
        () => {
          if (remote.incompleteSearches) {
            remote.incompleteSearches--;
            return failure(ref.repository, { code: 'GITHUB_QUERY_FAILED' });
          }
          const candidates = (remote.comments?.[ref.number] ?? [])
            .filter(item => item.viaApp === factoryAppId && item.body.startsWith(`<!-- software-factory:question:${questionId} -->\n`))
            .map(item => ({ commentId: item.commentId, url: item.url, createdAt: item.createdAt }));
          return {
            kind: 'observed' as const,
            source: 'github-rest' as const,
            observedAt: observedAt(),
            completeness: 'complete' as const,
            candidates,
            limitations: ['synthetic'],
          };
        },
        { number: ref.number, questionId },
      ),
    // Ticket 23: the controller's replies to `/factory` commands carry their own marker.
    findReply: (ref, replyId) =>
      track(
        'findReply',
        () => {
          const candidates = (remote.comments?.[ref.number] ?? [])
            .filter(item => item.viaApp === factoryAppId && item.body.startsWith(`<!-- software-factory:reply:${replyId} -->\n`))
            .map(item => ({ commentId: item.commentId, url: item.url, createdAt: item.createdAt }));
          return {
            kind: 'observed' as const,
            source: 'github-rest' as const,
            observedAt: observedAt(),
            completeness: 'complete' as const,
            candidates,
            limitations: ['synthetic'],
          };
        },
        { number: ref.number, replyId },
      ),
    postComment: (ref, posted, effect) =>
      track(
        'postComment',
        () => {
          const outcome = remote.postOutcomes?.shift();
          const marker = posted.kind === 'question' ? `software-factory:question:${posted.questionId}` : `software-factory:reply:${posted.replyId}`;
          const created = comment(`<!-- ${marker} -->\n${posted.body}`, { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, ref.number, factoryAppId);
          if (outcome !== 'unknown-not-created' && outcome !== 'failed')
            (remote.comments ??= {})[ref.number] = [...(remote.comments?.[ref.number] ?? []), created];
          if (outcome === 'failed') return { kind: 'failed' as const, observedAt: observedAt(), code: 'GITHUB_ACCESS_DENIED', nextStep: 'synthetic' };
          if (outcome) return { kind: 'unknown' as const, observedAt: observedAt(), code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'synthetic' };
          return { kind: 'published' as const, observedAt: observedAt(), commentId: created.commentId, url: created.url, createdAt: created.createdAt };
        },
        { number: ref.number, comment: posted, effect },
      ),
  };
  const repository: CodeRepository = {
    checkAccess() {
      throw new Error('not used by admission');
    },
    readEnvironmentDeclaration: async () => {
      remote.environmentReads = (remote.environmentReads ?? 0) + 1;
      return {
        observedAt: observedAt(),
        ...(remote.environment ?? {
          kind: 'declared',
          commit: remote.main ?? 'b'.repeat(40),
          sha256: declaredEnvironmentSha256,
          declaration: declaredEnvironment,
        }),
      } as EnvironmentDeclarationObservation;
    },
    findPublication: correlation =>
      track(
        'findPublication',
        (): PublicationObservation =>
          remote.publicationFailure
            ? failure(correlation.repo.repository, remote.publicationFailure)
            : {
                kind: 'observed',
                source: 'github-rest',
                observedAt: observedAt(),
                repository: correlation.repo.repository,
                repositoryId: 3,
                limitations: ['synthetic'],
                issues: Object.fromEntries(
                  correlation.issueNumbers.map(n => [
                    String(n),
                    remote.incompleteAssociation?.[n]
                      ? { completeness: 'incomplete' as const, code: remote.incompleteAssociation[n].code, nextStep: 'synthetic' }
                      : { completeness: 'complete' as const, candidates: [...(remote.pulls[n] ?? [])] },
                  ]),
                ),
                // Jira ticket 08: a branch-only correlation reports every pull request of each known branch in this repository (any issue key).
                ...(correlation.issueNumbers.length
                  ? {}
                  : {
                      branchCandidates: Object.fromEntries(
                        correlation.knownBranches.map(branch => [
                          branch,
                          [
                            ...new Map(
                              Object.values(remote.pulls)
                                .flat()
                                .filter(pull => pull.headRef === branch && pull.headRepositoryId === 3)
                                .map(pull => [pull.pullRequestId, structuredClone(pull)]),
                            ).values(),
                          ],
                        ]),
                      ),
                    }),
                branches: Object.fromEntries(
                  correlation.knownBranches.map(branch => [
                    branch,
                    remote.refs?.[branch] === 'unknown'
                      ? { state: 'unknown' as const, code: 'GITHUB_QUERY_FAILED', nextStep: 'synthetic' }
                      : remote.refs?.[branch]
                        ? { state: 'present' as const, sha: remote.refs[branch]! }
                        : { state: 'absent' as const },
                  ]),
                ),
                ...(correlation.refs
                  ? {
                      refs: remote.refsUnknown
                        ? { state: 'unknown' as const, code: 'GITHUB_QUERY_FAILED' }
                        : {
                            state: 'complete' as const,
                            refs: {
                              'refs/heads/main': remote.main ?? 'b'.repeat(40),
                              ...Object.fromEntries(
                                Object.entries(remote.refs ?? {})
                                  .filter(([, sha]) => sha !== 'unknown')
                                  .map(([name, sha]) => [`refs/heads/${name}`, sha]),
                              ),
                              ...Object.fromEntries(Object.entries(remote.tags ?? {}).map(([name, sha]) => [`refs/tags/${name}`, sha])),
                            },
                          },
                    }
                  : {}),
                ...(correlation.base !== undefined
                  ? { baseProtection: structuredClone(remote.baseProtection ?? { state: 'pull-request-required' as const, sources: ['ruleset:1'] }) }
                  : {}),
                ...comparisonOf(remote, correlation.compareFrom, correlation.knownBranches[0]),
                ...preservationOf(remote, correlation.preserve, correlation.knownBranches[0]),
              },
        correlation,
      ),
    readPullRequest: query =>
      track(
        'readPullRequest',
        (): PullRequestObservation => {
          const found = remote.pullRequests?.[query.number];
          if (
            found?.kind === 'observed' &&
            query.unless &&
            found.pullRequest.state === 'open' &&
            found.pullRequest.headSha === query.unless.headSha &&
            found.pullRequest.baseRef === query.unless.baseRef &&
            (query.unless.draft === undefined || found.pullRequest.draft === query.unless.draft)
          )
            return {
              kind: 'unchanged',
              source: 'github-rest',
              observedAt: observedAt(),
              repository: query.repo.repository,
              headSha: found.pullRequest.headSha,
              baseRef: found.pullRequest.baseRef,
            };
          return found
            ? structuredClone(found)
            : {
                kind: 'unavailable',
                source: 'github-rest',
                observedAt: observedAt(),
                repository: query.repo.repository,
                code: 'GITHUB_NOT_FOUND_OR_HIDDEN',
                nextStep: 'synthetic',
              };
        },
        query,
      ),
    readFeedback: query =>
      track(
        'readFeedback',
        (): FeedbackObservation => {
          const found = remote.feedback?.[query.number];
          if (found === 'unavailable')
            return {
              kind: 'unavailable',
              source: 'github-rest',
              observedAt: observedAt(),
              repository: query.repo.repository,
              code: 'GITHUB_QUERY_FAILED',
              nextStep: 'synthetic',
            };
          return {
            kind: 'observed',
            source: 'github-rest',
            observedAt: observedAt(),
            repository: query.repo.repository,
            number: query.number,
            reviews: structuredClone(found?.reviews ?? []),
            reviewComments: structuredClone(found?.reviewComments ?? []),
            comments: structuredClone(found?.comments ?? []),
            limitations: ['synthetic'],
          };
        },
        query,
      ),
    setDraft: (pr, draft, effect) =>
      track(
        'setDraft',
        () => {
          const outcome = remote.drafts?.shift() ?? 'applied';
          const found = remote.pullRequests?.[pr.number];
          if ((outcome === 'applied' || outcome === 'unknown-applied') && found?.kind === 'observed' && found.pullRequest.nodeId === pr.nodeId)
            found.pullRequest.draft = draft;
          if (outcome === 'applied')
            return {
              kind: 'applied' as const,
              observedAt: observedAt(),
              draft,
              headSha: found?.kind === 'observed' ? found.pullRequest.headSha : 'c'.repeat(40),
              revocation: 'revoked',
            };
          return {
            kind: outcome === 'known-failure' ? ('known-failure' as const) : ('unknown' as const),
            observedAt: observedAt(),
            code: outcome === 'known-failure' ? 'GITHUB_GRAPHQL_FORBIDDEN' : 'GITHUB_TRANSPORT_UNAVAILABLE',
            nextStep: 'synthetic',
            revocation: 'revoked',
          };
        },
        { pr, draft, effect },
      ),
  };
  return { tracker, repository, calls, concurrency: () => maxActive };
}

/** Controlled monotonic clock: each sleep waits for advance(), which moves time forward by the requested duration. */
export function manualClock() {
  let now = 0;
  let pending: { ms: number; resolve: () => void } | undefined;
  let waiter: ((ms: number) => void) | undefined;
  const clock: PollingClock = {
    monotonic: () => now,
    sleep(ms, signal) {
      return new Promise<void>(resolve => {
        if (pending) throw new Error('OVERLAPPING_SLEEP');
        const done = () => {
          if (pending?.resolve === finish) pending = undefined;
          resolve();
        };
        const finish = () => {
          now += ms;
          done();
        };
        pending = { ms, resolve: finish };
        signal.addEventListener('abort', done, { once: true });
        waiter?.(ms);
        waiter = undefined;
      });
    },
  };
  return {
    clock,
    /** Resolves with the requested delay once the poller has finished a cycle and is sleeping. */
    sleeping(): Promise<number> {
      if (pending) return Promise.resolve(pending.ms);
      return new Promise(resolve => {
        waiter = resolve;
      });
    },
    isSleeping: () => pending !== undefined,
    advance() {
      if (!pending) throw new Error('NOT_SLEEPING');
      pending.resolve();
    },
  };
}

/** Ticket 21: the comparison findPublication reports for `compareFrom...<tip of the first known branch>` when they differ. */
function comparisonOf(remote: Remote, from: string | undefined, branch: string | undefined): { comparison?: BranchComparison } {
  const to = branch === undefined ? undefined : remote.refs?.[branch];
  if (!from || !to || to === 'unknown' || to === from) return {};
  const configured = remote.comparisons?.[`${from}...${to}`];
  if (configured === 'unknown') return { comparison: { state: 'unknown', code: 'GITHUB_QUERY_FAILED' } };
  return {
    comparison: structuredClone(
      configured ?? {
        state: 'complete',
        from,
        to,
        status: 'ahead',
        aheadBy: 1,
        behindBy: 0,
        files: ['docs/a.md'],
        truncated: false,
        commits: [{ sha: to, author: { login: 'operator-one', id: 5 }, authorName: 'Operator One', subject: 'Human edit on the Factory branch' }],
      },
    ),
  };
}

/** Review HIGH: whether `ancestor` is reachable from `head` in the synthetic graph. */
export function reachable(remote: Remote, ancestor: string, head: string): boolean {
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length) {
    const sha = queue.shift()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    queue.push(...(remote.graph?.[sha] ?? []));
  }
  return false;
}
function preservationOf(remote: Remote, preserve: string[] | undefined, branch: string | undefined) {
  if (!preserve || branch === undefined) return {};
  const head = remote.refs?.[branch];
  const entries = remote.activity?.[branch] ?? [];
  const activity = remote.activityUnknown
    ? { state: 'unknown' as const, code: 'GITHUB_QUERY_FAILED' }
    : { state: 'complete' as const, entries: structuredClone(entries), truncated: false };
  if (!head || head === 'unknown') return { activity };
  const ancestry: Record<string, BranchComparison> = {};
  for (const tip of new Set([...preserve, ...entries.flatMap(item => [item.before, item.after])])) {
    if (/^0{40}$/.test(tip) || tip === head) continue;
    const status = tip === head ? 'identical' : reachable(remote, tip, head) ? 'ahead' : 'diverged';
    ancestry[tip] = {
      state: 'complete',
      from: tip,
      to: head,
      status,
      aheadBy: 1,
      behindBy: status === 'ahead' ? 0 : 1,
      commits: [],
      files: remote.changes?.[`${tip}...${head}`] ?? [],
      truncated: false,
    };
  }
  return { activity, ancestry };
}
