// Test doubles for the IssueTracker/CodeRepository contracts and the polling clock.
// They replace GitHub only; Control, Pi Durable and SQLite stay real in every flow test.
import type { IssueTracker, TicketRef, CandidateObservation, TicketObservation, TrackerScope, DependencyNode, DependencyProblem, TrackerComment } from '../../src/issue-tracker/index.js';
import type { CodeRepository, PublicationObservation, PullRequestCandidate, PullRequestObservation } from '../../src/code-repository/index.js';
import type { PollingClock } from '../../src/control/types.js';

export type RemoteIssue = { ref: TicketRef; state: 'open' | 'closed'; labels: { id: number; name: string }[]; pullRequest?: boolean; reread?: Partial<TicketRef>;
  stateReason?: string | null; /** Native blocked_by edges, by issue number in remote.issues. */ blockedBy?: number[] };
export type Unavailable = { code: string; waitSeconds?: number };
export type Remote = {
  issues: RemoteIssue[];
  pulls: Record<number, PullRequestCandidate[]>;
  /** Ticket 14: remote tips of known branches (absent key = absent ref); `unknown` = the ref read failed. */
  refs?: Record<string, string | 'unknown'>;
  /** Ticket 14: tags (`refs/tags/<name>` → sha); main is always at 'b'*40. `refsUnknown`: the repository-wide listing fails. */
  tags?: Record<string, string>; refsUnknown?: boolean;
  /** Ticket 14: base protection as the adapter reports it (default: pull requests required by a ruleset the App cannot bypass). */
  baseProtection?: { state: 'pull-request-required'; sources: string[] } | { state: 'not-required'; reason: string } | { state: 'unknown'; code: string };
  listFailure?: Unavailable; readFailure?: Unavailable; publicationFailure?: Unavailable;
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
  /** Consumed one per postComment: unknown outcome (created or not) or known failure; absent = published. */
  postOutcomes?: ('unknown-created' | 'unknown-not-created' | 'failed')[];
  /** Number of next findQuestion calls that are incomplete (unavailable). */
  incompleteSearches?: number;
  /** Number of next readInputs calls that are incomplete (unavailable). */
  incompleteInputs?: number;
  /** Ticket 15: readPullRequest observations by PR number (absent = unavailable GITHUB_NOT_FOUND_OR_HIDDEN). */
  pullRequests?: Record<number, PullRequestObservation>;
};
let commentSequence = 80000;
/** A comment as the tracker adapter reports it. */
export function comment(body: string, author: { id: number; login: string; type: string } = { id: 1, login: 'operator', type: 'User' }, issue = 3, viaApp: number | null = null): TrackerComment {
  const id = ++commentSequence;
  return { commentId: id, nodeId: `IC_${id}`, url: `https://github.com/acme/project/issues/${issue}#issuecomment-${id}`, author, body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), viaApp };
}
export const factoryAppId = 1;
export const dependencyPrincipal = { installationId: 2, repository: 'acme/project', repositoryId: 3, role: 'executable' as const, purpose: 'dependency-read' as const,
  permissions: { metadata: 'read' as const, issues: 'read' as const } };
export const scope: TrackerScope & { base: string } = { repository: 'acme/project', installationId: 2, workflows: false, label: 'ready-for-agent', base: 'main' };
export function ticket(number: number, overrides: Partial<TicketRef> = {}): TicketRef {
  return { tracker: 'github', repository: 'acme/project', repositoryId: 3, issueId: 7000 + number, nodeId: `I_node${number}`, number,
    url: `https://github.com/acme/project/issues/${number}`, ...overrides };
}
export function remoteIssue(number: number, overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  return { ref: ticket(number), state: 'open', labels: [{ id: 55, name: 'ready-for-agent' }], ...overrides };
}
export function foreignPull(number: number, overrides: Partial<PullRequestCandidate> = {}): PullRequestCandidate {
  return { pullRequestId: 9000 + number, nodeId: `PR_node${number}`, number, url: `https://github.com/acme/project/pull/${number}`, state: 'open', merged: false,
    headRef: `human/${number}`, headRepositoryId: 3, author: { id: 10, login: 'someone', type: 'User' }, association: ['closing-reference'],
    headSha: 'c'.repeat(40), baseRef: 'main', draft: false, body: null, ...overrides };
}

export function githubDoubles(remote: Remote) {
  const calls: { method: string; at: number; args?: unknown }[] = [];
  let active = 0;
  let maxActive = 0;
  const observedAt = () => new Date().toISOString();
  const track = async <T>(method: string, body: () => T | Promise<T>, args?: unknown): Promise<T> => {
    calls.push({ method, at: calls.length, args });
    active++; maxActive = Math.max(maxActive, active);
    try {
      if (remote.hang) await remote.hang;
      return await body();
    } finally { active--; }
  };
  const failure = (repository: string, value: Unavailable) => ({ kind: 'unavailable' as const, source: 'github-rest' as const, observedAt: observedAt(), repository,
    completeness: 'incomplete' as const, code: value.code, ...(value.waitSeconds !== undefined ? { waitSeconds: value.waitSeconds } : {}), nextStep: `synthetic ${value.code}` });
  const tracker: IssueTracker = {
    checkAccess() { throw new Error('not used by admission'); },
    listCandidates: s => track('listCandidates', (): CandidateObservation => remote.listFailure ? failure(s.repository, remote.listFailure) : ({
      kind: 'observed', source: 'github-rest', observedAt: observedAt(), repository: s.repository, repositoryId: 3, label: s.label, completeness: 'complete',
      candidates: [...remote.issues.filter(i => i.state === 'open' && i.labels.some(l => l.name === s.label)).map(i => i.ref), ...(remote.extraListed ?? [])], limitations: [] })),
    readTicket: ref => track('readTicket', (): TicketObservation => {
      if (remote.readThrows) throw new Error('synthetic unexpected adapter failure');
      if (remote.readFailure) return failure(ref.repository, remote.readFailure);
      const found = remote.issues.find(i => i.ref.number === ref.number && i.ref.repository === ref.repository);
      if (!found) return failure(ref.repository, { code: 'GITHUB_NOT_FOUND_OR_HIDDEN' });
      return { kind: 'observed', source: 'github-rest', observedAt: observedAt(), completeness: 'complete', ticket: { ...found.ref, ...found.reread },
        state: found.state, stateReason: found.stateReason ?? null, labels: found.labels, pullRequest: found.pullRequest ?? false };
    }),
    // Reachable native graph over remote.issues (same repository), each node once; problems are injected per root Ticket.
    readDependencyGraph: ref => track('readDependencyGraph', () => {
      if (remote.graphThrows) throw new Error('synthetic unexpected adapter failure');
      const nodes: DependencyNode[] = [];
      const queue = [ref.number];
      const seen = new Set(queue);
      while (queue.length) {
        const found = remote.issues.find(i => i.ref.number === queue[0]);
        queue.shift();
        if (!found) continue;
        const blockers = (found.blockedBy ?? []).map(n => remote.issues.find(i => i.ref.number === n)!);
        nodes.push({ issueId: found.ref.issueId, nodeId: found.ref.nodeId, repository: found.ref.repository, repositoryId: found.ref.repositoryId, number: found.ref.number,
          url: found.ref.url, state: found.state, stateReason: found.stateReason ?? null, access: 'read', repositoryRole: 'executable', blockedBy: blockers.map(b => b.ref.issueId) });
        for (const blocker of blockers) if (!seen.has(blocker.ref.number)) { seen.add(blocker.ref.number); queue.push(blocker.ref.number); }
      }
      const problems = remote.dependencyProblems?.[ref.number] ?? [];
      return { kind: 'observed' as const, source: 'github-rest' as const, observedAt: observedAt(), root: ref, completeness: problems.length ? 'incomplete' as const : 'complete' as const,
        principals: [dependencyPrincipal], problems, limitations: ['synthetic graph'], nodes };
    }, ref),
    readInputs: (ref, cursor) => track('readInputs', () => {
      if (remote.incompleteInputs) { remote.incompleteInputs--; return failure(ref.repository, { code: 'GITHUB_QUERY_FAILED' }); }
      const all = remote.comments?.[ref.number] ?? [];
      const after = all.filter(item => cursor === null || item.commentId > cursor);
      return { kind: 'observed' as const, source: 'github-rest' as const, observedAt: observedAt(), ticket: ref, completeness: 'complete' as const, comments: structuredClone(after),
        cursor: all.length ? Math.max(cursor ?? 0, all.at(-1)!.commentId) : cursor, limitations: ['synthetic'] };
    }, { number: ref.number, cursor }),
    findQuestion: (ref, questionId) => track('findQuestion', () => {
      if (remote.incompleteSearches) { remote.incompleteSearches--; return failure(ref.repository, { code: 'GITHUB_QUERY_FAILED' }); }
      const candidates = (remote.comments?.[ref.number] ?? []).filter(item => item.viaApp === factoryAppId && item.body.startsWith(`<!-- software-factory:question:${questionId} -->\n`))
        .map(item => ({ commentId: item.commentId, url: item.url, createdAt: item.createdAt }));
      return { kind: 'observed' as const, source: 'github-rest' as const, observedAt: observedAt(), completeness: 'complete' as const, candidates, limitations: ['synthetic'] };
    }, { number: ref.number, questionId }),
    postComment: (ref, posted, effect) => track('postComment', () => {
      const outcome = remote.postOutcomes?.shift();
      const created = comment(`<!-- software-factory:question:${posted.questionId} -->\n${posted.body}`, { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, ref.number, factoryAppId);
      if (outcome !== 'unknown-not-created' && outcome !== 'failed') (remote.comments ??= {})[ref.number] = [...(remote.comments?.[ref.number] ?? []), created];
      if (outcome === 'failed') return { kind: 'failed' as const, observedAt: observedAt(), code: 'GITHUB_ACCESS_DENIED', nextStep: 'synthetic' };
      if (outcome) return { kind: 'unknown' as const, observedAt: observedAt(), code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'synthetic' };
      return { kind: 'published' as const, observedAt: observedAt(), commentId: created.commentId, url: created.url, createdAt: created.createdAt };
    }, { number: ref.number, comment: posted, effect }),
  };
  const repository: CodeRepository = {
    checkAccess() { throw new Error('not used by admission'); },
    findPublication: correlation => track('findPublication', (): PublicationObservation => remote.publicationFailure ? failure(correlation.repo.repository, remote.publicationFailure) : ({
      kind: 'observed', source: 'github-rest', observedAt: observedAt(), repository: correlation.repo.repository, repositoryId: 3, limitations: ['synthetic'],
      issues: Object.fromEntries(correlation.issueNumbers.map(n => [String(n), remote.incompleteAssociation?.[n]
        ? { completeness: 'incomplete' as const, code: remote.incompleteAssociation[n].code, nextStep: 'synthetic' }
        : { completeness: 'complete' as const, candidates: [...(remote.pulls[n] ?? [])] }])),
      branches: Object.fromEntries(correlation.knownBranches.map(branch => [branch, remote.refs?.[branch] === 'unknown'
        ? { state: 'unknown' as const, code: 'GITHUB_QUERY_FAILED', nextStep: 'synthetic' }
        : remote.refs?.[branch] ? { state: 'present' as const, sha: remote.refs[branch]! } : { state: 'absent' as const }])),
      ...(correlation.refs ? { refs: remote.refsUnknown ? { state: 'unknown' as const, code: 'GITHUB_QUERY_FAILED' } : { state: 'complete' as const, refs: {
        'refs/heads/main': 'b'.repeat(40), ...Object.fromEntries(Object.entries(remote.refs ?? {}).filter(([, sha]) => sha !== 'unknown').map(([name, sha]) => [`refs/heads/${name}`, sha])),
        ...Object.fromEntries(Object.entries(remote.tags ?? {}).map(([name, sha]) => [`refs/tags/${name}`, sha])) } } } : {}),
      ...(correlation.base !== undefined ? { baseProtection: structuredClone(remote.baseProtection ?? { state: 'pull-request-required' as const, sources: ['ruleset:1'] }) } : {}) }), correlation),
    readPullRequest: query => track('readPullRequest', (): PullRequestObservation => {
      const found = remote.pullRequests?.[query.number];
      if (found?.kind === 'observed' && query.unless && found.pullRequest.state === 'open' && found.pullRequest.headSha === query.unless.headSha &&
        found.pullRequest.baseRef === query.unless.baseRef) return { kind: 'unchanged', source: 'github-rest', observedAt: observedAt(), repository: query.repo.repository,
        headSha: found.pullRequest.headSha, baseRef: found.pullRequest.baseRef };
      return found ??
      { kind: 'unavailable', source: 'github-rest', observedAt: observedAt(), repository: query.repo.repository, code: 'GITHUB_NOT_FOUND_OR_HIDDEN', nextStep: 'synthetic' };
    }, query),
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
        const done = () => { if (pending?.resolve === finish) pending = undefined; resolve(); };
        const finish = () => { now += ms; done(); };
        pending = { ms, resolve: finish };
        signal.addEventListener('abort', done, { once: true });
        waiter?.(ms); waiter = undefined;
      });
    },
  };
  return {
    clock,
    /** Resolves with the requested delay once the poller has finished a cycle and is sleeping. */
    sleeping(): Promise<number> {
      if (pending) return Promise.resolve(pending.ms);
      return new Promise(resolve => { waiter = resolve; });
    },
    isSleeping: () => pending !== undefined,
    advance() {
      if (!pending) throw new Error('NOT_SLEEPING');
      pending.resolve();
    },
  };
}
