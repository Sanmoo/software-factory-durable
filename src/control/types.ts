import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import type { IssueTracker, TicketRef } from '../issue-tracker/index.js';
import type { CodeRepository } from '../code-repository/index.js';
import type { Hold } from './rules/admission.js';

export type AccessView = { kind: 'access'; scope: 'authenticated'; results: { tracker: AccessDiagnostic; repository: AccessDiagnostic }[] };
export type ConfiguredRepository = GitHubScope & { base: string; label: string };
export type AccessDependencies = { tracker: IssueTracker; repository: CodeRepository; repositories: ConfiguredRepository[] };
/** Monotonic local clock for live polling cadence; calendar time is only used for observation instants. Tests substitute it. */
export type PollingClock = { monotonic(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
export type PollingOptions = { intervalSeconds: number; clock?: PollingClock };
export type ControlInput = { request_id: string; operation: 'pause' | 'unpause'; origin: 'local-cli' };
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number };
export type ControlQuery = { kind: 'status' } | { kind: 'request'; request_id: string } | { kind: 'access' } | { kind: 'list' } | { kind: 'show'; work_id: string };
export type DispatchReason = 'RECONCILIATION_REQUIRED' | 'EXECUTION_NOT_ENABLED';

/** In-memory observation of the latest polling of one repository. Not authority; lost on restart and rebuilt by the next poll. */
export type CandidateView = { ticket: TicketRef; observedAt: string } & (
  { outcome: 'admitted' | 'existing'; work_id: string } | { outcome: 'held'; holds: Hold[] } | { outcome: 'not-evaluated'; reason: string });
export type RepositoryPollView = {
  repository: string; label: string; state: 'pending' | 'observed' | 'unavailable';
  observedAt: string | null; completeness: 'complete' | 'incomplete' | null; absenceProven: false;
  code?: string; waitSeconds?: number; nextStep?: string; consecutiveFailures: number; nextPollInSeconds: number | null;
  candidates: CandidateView[] | null;
};
export type PollingView = { state: 'disabled' | 'starting' | 'polling' | 'sleeping' | 'stopped'; intervalSeconds: number | null; cycles: number;
  lastCycleAt: string | null; source: 'in-memory-observation'; repositories: RepositoryPollView[] };

export type Impediment = { code: string; scope: 'work' | 'installation'; since?: string; nextStep: string };
/** Orthogonal dimensions of one Work (spec §3.3): result, authorization, queue, impediments, execution, publication. */
export type WorkView = {
  work_id: string; cycle: number; predecessor: string | null;
  ticket: TicketRef; repository: { repository: string; repositoryId: number; base: string };
  result: 'open';
  authorization: { state: 'authorized'; source: 'github-rest'; observedAt: string;
    basis: { repositoryConfigured: true; issueState: 'open'; label: { id: number; name: string } };
    publication: { observedAt: string; completeness: 'complete'; associatedPullRequests: 0; limitations: string[] };
    tracking: string };
  queue: { category: 'normal'; sequence: number; pending: true };
  impediments: Impediment[];
  dispatch: { state: 'held'; reasons: string[] };
  execution: null; branch: null; pullRequest: null;
  admittedAt: string;
  history: { at: string; event: 'admitted'; origin: 'github-polling'; sequence: number }[];
};
export type ListView = { kind: 'list'; paused: boolean; dispatch: 'closed'; dispatchReason: DispatchReason;
  queues: { normal: string[]; repair: string[] }; works: WorkView[]; polling: PollingView; limitations: string[] };
export type ShowView = { kind: 'work'; work: WorkView; lastPolled: CandidateView | null } | { kind: 'work-not-found'; work_id: string; nextStep: string };
export type ControlStatus = {
  controller_run_id: string;
  paused: boolean;
  dispatch: 'closed';
  dispatchReason: DispatchReason;
  historyLength: number;
  works: { total: number; open: number };
  queues: { normal: number; repair: number };
  polling: Omit<PollingView, 'repositories'> & { repositories: Omit<RepositoryPollView, 'candidates'>[] };
  persistence: { sqliteVersion: string; sqliteSourceId: string; journalMode: 'wal'; synchronous: 'FULL' };
};
export interface Control {
  accept(input: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' }>;
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null } | AccessView | ListView | ShowView>;
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' }>;
}
