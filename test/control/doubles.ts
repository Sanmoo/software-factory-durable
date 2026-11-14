// Test doubles for the IssueTracker/CodeRepository contracts and the polling clock.
// They replace GitHub only; Control, Pi Durable and SQLite stay real in every flow test.
import type { IssueTracker, TicketRef, CandidateObservation, TicketObservation, TrackerScope } from '../../src/issue-tracker/index.js';
import type { CodeRepository, PublicationObservation, PullRequestCandidate } from '../../src/code-repository/index.js';
import type { PollingClock } from '../../src/control/types.js';

export type RemoteIssue = { ref: TicketRef; state: 'open' | 'closed'; labels: { id: number; name: string }[]; pullRequest?: boolean; reread?: Partial<TicketRef> };
export type Unavailable = { code: string; waitSeconds?: number };
export type Remote = {
  issues: RemoteIssue[];
  pulls: Record<number, PullRequestCandidate[]>;
  listFailure?: Unavailable; readFailure?: Unavailable; publicationFailure?: Unavailable;
  /** Per-Ticket incomplete association (e.g. timeline unavailable). */
  incompleteAssociation?: Record<number, Unavailable>;
  /** readTicket throws (unexpected adapter failure). */
  readThrows?: boolean;
  /** Extra refs returned by the listing, e.g. from another repository. */
  extraListed?: TicketRef[];
  hang?: Promise<void>;
};
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
    headRef: `human/${number}`, headRepositoryId: 3, author: { id: 10, login: 'someone', type: 'User' }, association: ['closing-reference'], ...overrides };
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
        state: found.state, stateReason: null, labels: found.labels, pullRequest: found.pullRequest ?? false };
    }),
    readDependencyGraph: ref => track('readDependencyGraph', () => ({ kind: 'observed' as const, source: 'github-rest' as const, observedAt: observedAt(), root: ref,
      completeness: 'complete' as const, principals: [], problems: [], limitations: [], nodes: [{ issueId: ref.issueId, nodeId: ref.nodeId, repository: ref.repository,
        repositoryId: ref.repositoryId, number: ref.number, url: ref.url, state: 'open' as const, stateReason: null, access: 'read' as const, repositoryRole: 'executable' as const, blockedBy: [] }] }), ref),
  };
  const repository: CodeRepository = {
    checkAccess() { throw new Error('not used by admission'); },
    findPublication: correlation => track('findPublication', (): PublicationObservation => remote.publicationFailure ? failure(correlation.repo.repository, remote.publicationFailure) : ({
      kind: 'observed', source: 'github-rest', observedAt: observedAt(), repository: correlation.repo.repository, repositoryId: 3, limitations: ['synthetic'],
      issues: Object.fromEntries(correlation.issueNumbers.map(n => [String(n), remote.incompleteAssociation?.[n]
        ? { completeness: 'incomplete' as const, code: remote.incompleteAssociation[n].code, nextStep: 'synthetic' }
        : { completeness: 'complete' as const, candidates: remote.pulls[n] ?? [] }])) }), correlation),
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
