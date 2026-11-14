import type { AccessDiagnostic, BuilderCredentials, BuilderGrantMetadata, GitHubScope } from '../contracts/index.js';
import type { CheckoutRequest, EnvironmentRef, PreparedWork, StartResult, StopResult, BootRef } from '../sandbox/index.js';
import type { ActivationDelivery, Invocation } from '../workers/index.js';
import type { IssueTracker, TicketRef } from '../issue-tracker/index.js';
import type { CodeRepository } from '../code-repository/index.js';
import type { Hold } from './rules/admission.js';
import type { BlockerView, DependencyReason } from './rules/dependencies.js';

/** `dependencyResults`: preflight of repositories accessible only for dependency reads (no issue/relation is created). */
export type AccessView = { kind: 'access'; scope: 'authenticated'; results: { tracker: AccessDiagnostic; repository: AccessDiagnostic }[]; dependencyResults: AccessDiagnostic[] };
export type ConfiguredRepository = GitHubScope & { base: string; label: string };
/** `repositories` are executable Ticket origins; `dependencyRepositories` are readable only for native blocked_by and never executable. */
export type AccessDependencies = { tracker: IssueTracker; repository: CodeRepository; repositories: ConfiguredRepository[]; dependencyRepositories?: GitHubScope[] };
/** Monotonic local clock for live polling cadence; calendar time is only used for observation instants. Tests substitute it. */
export type PollingClock = { monotonic(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
export type PollingOptions = { intervalSeconds: number; clock?: PollingClock };
export type ExecutionOptions = ExecutionPorts;
export type ControlInput = { request_id: string; operation: 'pause' | 'unpause'; origin: 'local-cli' };
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number };
export type ControlQuery = { kind: 'status' } | { kind: 'request'; request_id: string } | { kind: 'access' } | { kind: 'list' } | { kind: 'show'; work_id: string };
export type DispatchReason = 'RECONCILIATION_REQUIRED' | 'EXECUTION_NOT_ENABLED';

/** Injected execution boundaries (spec §2.4/Q11): public Sandbox lifecycle, Workers activation and the Builder credential projection. */
export type ExecutionPorts = {
  sandbox: {
    prepare(input: { workId: string; configuration: unknown; checkout: CheckoutRequest }): Promise<PreparedWork>;
    start(input: { environment: EnvironmentRef; configuration: unknown }): Promise<StartResult>;
    stop(input: { environment: EnvironmentRef; boot: BootRef; reason: string }): Promise<StopResult>;
  };
  workers: { activate(invocation: Invocation, delivery?: ActivationDelivery): Promise<{ worker: string;
    started: Promise<{ receipt: { workId: string; id: string }; invocation: { executionId: string; invocationId: string } }>; completed: Promise<{ status: 'success'; receipt: { workId: string; id: string } } | { status: 'failure'; code: string }>;
    close(): void }> };
  credentials: BuilderCredentials;
  /** Sandbox configuration as configured (interpreted by Sandbox only). */
  configuration: unknown;
  /** Slot capacity (configuration `concurrency`). */
  capacity: number;
  /** Host Builder policies applied to every initial Builder invocation. */
  builder: Pick<Invocation, 'skillPack' | 'modelBudget' | 'copyOutput' | 'editSourceMaxBytes'>;
};
/** Durable Execution record (spec §3.2-3.4/5.3): identity, Slot, dispatch intent/phase, start receipt consumption and end. No secret. */
export type ExecutionView = {
  executionId: string; invocationId: string; mode: 'initial';
  state: 'reserved' | 'started' | 'ended' | 'held' | 'released';
  slot: { held: boolean; capacity: number; reservedAt: string; releasedAt: string | null };
  admission: { attemptId: string; evaluationId: string; authorizationObservedAt: string; activationAttemptId: string | null; activationEvaluationId: string | null };
  dispatch: { intent: 'prepare-start-activate'; phase: 'reserved' | 'prepared' | 'booted' | 'activation-requested' | 'started' | 'completed' | 'stopped';
    environment: string | null; boot: string | null; updatedAt: string };
  request: { ticket: string; repository: string; base: string; branch: string; baseCommit: string | null; checkout: string | null; promptSha256: string | null;
    skillPack: { name: string; manifestSha256: string } | null; policies: Pick<Invocation, 'skillPack' | 'modelBudget' | 'copyOutput' | 'editSourceMaxBytes'> };
  credential: BuilderGrantMetadata | null;
  /** Durable issuance intent BEFORE the call, then its outcome, token-free metadata and revocation result: no live grant goes unrecorded. */
  credentialIssuance: { requestedAt: string; outcome: 'requested' | 'issued' | 'failed' | 'unknown'; code: string | null;
    metadata: BuilderGrantMetadata | null; revocation: 'revoked' | 'not-attempted' | 'unknown' | null } | null;
  start: { receiptId: string; confirmedAt: string } | null;
  end: { at: string; outcome: 'completed' | 'failure'; code: string | null; cessation: 'confirmed' | 'unconfirmed' | 'not-attempted' } | null;
  held: { code: string; phase: string; at: string; nextStep: string } | null;
  completion: { automatic: false; reason: string };
};

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
/**
 * Durable record of one native dependency evaluation (spec §4.2): origin, token-free principals/scopes, instants, completeness, the
 * reachable graph with classification/satisfaction, cycles/shared nodes and reasons. `attemptId` ties it to the polling round that
 * produced it: only an evaluation of the current round may release a start/resume/repair.
 */
export type DependencyEvaluation = {
  evaluationId: string; attemptId: string; source: 'github-rest'; observedAt: string; evaluatedAt: string;
  principals: { installationId: number; repository: string; repositoryId: number | null; role: 'executable' | 'dependency-only'; purpose: 'dependency-read';
    permissions: Readonly<Record<string, 'read'>> }[];
  completeness: 'complete' | 'incomplete'; conclusion: 'satisfied' | 'pending' | 'inconclusive';
  blockers: BlockerView[]; cycles: number[][]; shared: number[]; reasons: DependencyReason[]; limitations: string[];
};
export type DependencyState = { latest: DependencyEvaluation | null;
  lastComplete: { evaluationId: string; observedAt: string; conclusion: DependencyEvaluation['conclusion'] } | null };
export type Selection = { next: string | null; skipped: { work_id: string; reasons: string[] }[] };
/** Orthogonal dimensions of one Work (spec §3.3): result, authorization, queue, impediments, execution, publication. */
export type WorkView = {
  work_id: string; cycle: number; predecessor: string | null;
  ticket: TicketRef; repository: { repository: string; repositoryId: number; base: string };
  result: 'open';
  authorization: { state: 'authorized'; source: 'github-rest'; observedAt: string;
    basis: { repositoryConfigured: true; issueState: 'open'; label: { id: number; name: string } };
    publication: { observedAt: string; completeness: 'complete'; associatedPullRequests: 0; limitations: string[] };
    tracking: string };
  queue: { category: 'normal'; sequence: number; pending: boolean };
  impediments: Impediment[];
  dependencies: DependencyState;
  dispatch: { state: 'held' | 'eligible' | 'executing'; reasons: string[] };
  execution: ExecutionView | null; branch: string | null; pullRequest: null;
  admittedAt: string;
  history: ({ at: string; event: 'admitted'; origin: 'github-polling'; sequence: number } |
    { at: string; event: 'dependencies-changed'; origin: 'github-polling'; before: DependencyEvaluation['conclusion'] | null; after: DependencyEvaluation['conclusion']; evaluationId: string } |
    { at: string; event: 'execution-reserved' | 'execution-prepared' | 'execution-booted' | 'activation-requested' | 'execution-started' | 'execution-ended' | 'execution-held' | 'execution-released' | 'slot-released';
      origin: 'controller-dispatch'; executionId: string; detail?: string })[];
};
export type ListView = { kind: 'list'; paused: boolean; dispatch: 'closed' | 'open'; dispatchReason: DispatchReason | null; slots: { capacity: number; held: number };
  queues: { normal: string[]; repair: string[] }; works: WorkView[]; selection: Selection; polling: PollingView; limitations: string[] };
export type ShowView = { kind: 'work'; work: WorkView; lastPolled: CandidateView | null } | { kind: 'work-not-found'; work_id: string; nextStep: string };
export type ControlStatus = {
  controller_run_id: string;
  paused: boolean;
  dispatch: 'closed' | 'open';
  dispatchReason: DispatchReason | null;
  slots: { capacity: number; held: number };
  historyLength: number;
  works: { total: number; open: number };
  queues: { normal: number; repair: number };
  dependencies: { satisfied: number; pending: number; inconclusive: number; notEvaluated: number };
  selection: { next: string | null };
  polling: Omit<PollingView, 'repositories'> & { repositories: Omit<RepositoryPollView, 'candidates'>[] };
  persistence: { sqliteVersion: string; sqliteSourceId: string; journalMode: 'wal'; synchronous: 'FULL' };
};
export interface Control {
  accept(input: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' }>;
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null } | AccessView | ListView | ShowView>;
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' }>;
}
