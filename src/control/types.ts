import type { AccessDiagnostic, BuilderCredentials, BuilderGrantMetadata, GitHubScope, RevocationResult } from '../contracts/index.js';
import type { CheckoutRequest, EnvironmentRef, PreparedWork, StartResult, StopResult, BootRef } from '../sandbox/index.js';
import type { ActivationDelivery, DeliveryResult, ActivationEvents, Invocation, WorkerDirective, WorkerCompletion } from '../workers/index.js';
import type { IssueTracker, TicketRef } from '../issue-tracker/index.js';
import type { CodeRepository } from '../code-repository/index.js';
import type { Hold } from './rules/admission.js';
import type { BlockerView, DependencyReason } from './rules/dependencies.js';

/** `dependencyResults`: preflight of repositories accessible only for dependency reads (no issue/relation is created). */
export type AccessView = { kind: 'access'; scope: 'authenticated'; results: { tracker: AccessDiagnostic; repository: AccessDiagnostic }[]; dependencyResults: AccessDiagnostic[] };
export type ConfiguredRepository = GitHubScope & { base: string; label: string };
/** `repositories` are executable Ticket origins; `dependencyRepositories` are readable only for native blocked_by and never executable. */
/** `operators`: configured GitHub operator logins whose strict `/factory` comments on a Work's own Ticket may answer its Questions. */
export type AccessDependencies = { tracker: IssueTracker; repository: CodeRepository; repositories: ConfiguredRepository[]; dependencyRepositories?: GitHubScope[];
  /** Login, or `{login, id}` with the pinned GitHub user id (then matched by id only). */
  operators?: (string | { login: string; id?: number })[] };
/** Monotonic local clock for live polling cadence; calendar time is only used for observation instants. Tests substitute it. */
export type PollingClock = { monotonic(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
export type PollingOptions = { intervalSeconds: number; clock?: PollingClock };
export type ExecutionOptions = ExecutionPorts;
export type ControlInput = { request_id: string; operation: 'pause' | 'unpause'; origin: 'local-cli' } |
  { request_id: string; operation: 'answer'; question_id: string; text: string; origin: 'local-cli' };
/** `answer`: `accepted` removed only that Question's impediment; `not-applied` (already answered, unknown, closed Work...) changed nothing. */
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number } |
  { kind: 'durable'; request_id: string; operation: 'answer'; question_id: string; outcome: 'accepted' | 'not-applied'; reason: string | null; work_id: string | null };
export type ControlQuery = { kind: 'status' } | { kind: 'request'; request_id: string } | { kind: 'access' } | { kind: 'list' } | { kind: 'show'; work_id: string } |
  { kind: 'question'; question_id: string };
export type DispatchReason = 'RECONCILIATION_REQUIRED' | 'EXECUTION_NOT_ENABLED';

/** Injected execution boundaries (spec §2.4/Q11): public Sandbox lifecycle, Workers activation and the Builder credential projection. */
export type ExecutionPorts = {
  sandbox: {
    prepare(input: { workId: string; configuration: unknown; checkout: CheckoutRequest }): Promise<PreparedWork>;
    start(input: { environment: EnvironmentRef; configuration: unknown }): Promise<StartResult>;
    stop(input: { environment: EnvironmentRef; boot: BootRef; reason: string }): Promise<StopResult>;
  };
  workers: { activate(invocation: Invocation, delivery?: ActivationDelivery, events?: ActivationEvents): Promise<{ worker: string;
    started: Promise<{ receipt: { workId: string; id: string }; invocation: { executionId: string; invocationId: string } }>; completed: Promise<WorkerCompletion>;
    close(): void }>;
    /** Q6 `deliver`: renewed transient credential or its withdrawal to the CURRENT Builder; never persisted, not proof of consumption. */
    deliver(worker: string, directive: WorkerDirective): Promise<DeliveryResult> };
  credentials: BuilderCredentials;
  /** Renew a Builder grant this many seconds before its expiresAt while the activity stays authorized (default 600). */
  credentialRenewal?: { beforeExpirySeconds: number };
  /** Sandbox configuration as configured (interpreted by Sandbox only). */
  configuration: unknown;
  /** Slot capacity (configuration `concurrency`). */
  capacity: number;
  /** Host Builder policies applied to every initial Builder invocation. */
  builder: Pick<Invocation, 'skillPack' | 'modelBudget' | 'copyOutput' | 'editSourceMaxBytes'>;
};
export type CredentialWithdrawal = 'ended' | 'external-wait' | 'cancelled' | 'held' | 'refused' | 'owner-stopped' | 'controller-restart';
/** Token-free durable record of one known grant. `risk` explains what a revocation could not settle (e.g. value lost after a crash). */
export type CredentialGrantRecord = { requestedAt: string; outcome: 'requested' | 'issued' | 'failed' | 'unknown' | 'not-attempted'; code: string | null;
  metadata: BuilderGrantMetadata | null; revocation: RevocationResult['kind'] | null; revocationCode: string | null; risk: string | null;
  /** Durable intent written BEFORE the revocation request: a crash afterwards is reported as an attempted revocation of unknown outcome. */
  revocationAttemptedAt: string | null };
/** Durable Execution record (spec §3.2-3.4/5.3): identity, Slot, dispatch intent/phase, start receipt consumption and end. No secret. */
export type ExecutionView = {
  /** `recovery`: a NEW activation after an accepted answer (new boot, new session) with an explicit recovery instruction (spec §5.5). */
  executionId: string; invocationId: string; mode: 'initial' | 'recovery';
  state: 'reserved' | 'started' | 'ended' | 'held' | 'released';
  slot: { held: boolean; capacity: number; reservedAt: string; releasedAt: string | null };
  admission: { attemptId: string; evaluationId: string; authorizationObservedAt: string; activationAttemptId: string | null; activationEvaluationId: string | null };
  dispatch: { intent: 'prepare-start-activate'; phase: 'reserved' | 'prepared' | 'booted' | 'activation-requested' | 'started' | 'completed' | 'stopped';
    environment: string | null; boot: string | null; updatedAt: string };
  request: { ticket: string; repository: string; base: string; branch: string; baseCommit: string | null; checkout: string | null; promptSha256: string | null;
    skillPack: { name: string; manifestSha256: string } | null; policies: Pick<Invocation, 'skillPack' | 'modelBudget' | 'copyOutput' | 'editSourceMaxBytes'>;
    /** Recovery basis: the previous Execution, its answered Question and why the session is replaced (not continued). */
    resume?: { previousExecutionId: string; questionId: string; answerSha256: string; reason: 'NEW_BOOT_REPLACEMENT_SESSION' } | null };
  credential: BuilderGrantMetadata | null;
  /** Initial grant: durable issuance intent BEFORE the call, then outcome, token-free metadata and revocation result. Never the token. */
  credentialIssuance: CredentialGrantRecord | null;
  /** Renewals (ticket 20): each a NEW issuance for the same authorized activity, delivered to new commands only. */
  credentialRenewals: (CredentialGrantRecord & { sequence: number; delivery: 'delivered' | 'failed' | 'not-delivered' | null })[];
  /** Activity credential lifecycle: withdrawn on end/external wait/cancellation/hold/owner stop/restart; no delivery or renewal after it. */
  credentialLifecycle: { state: 'none' | 'active' | 'withdrawn'; withdrawnAt: string | null; reason: CredentialWithdrawal | 'legacy-unknown' | null;
    renewal: 'enabled' | 'stopped'; renewalStop: string | null;
    /** Result of the withdraw-credential directive to a live worker: 'withdrawn' or a failure code; null when not sent. */
    workerNotice: string | null };
  start: { receiptId: string; confirmedAt: string } | null;
  /** `question`: the activation ended after a durable Question (its id; `code` when the request content was lost and no Question exists). */
  end: { at: string; outcome: 'completed' | 'failure' | 'question'; code: string | null; cessation: 'confirmed' | 'unconfirmed' | 'not-attempted'; questionId?: string | null } | null;
  held: { code: string; phase: string; at: string; nextStep: string } | null;
  completion: { automatic: false; reason: string };
};

/**
 * Durable Question (spec §3.2/§5.5): identity assigned by the worker, origin Work/Execution, preserved content, destination, the
 * publication effect (intent -> attempt -> observation/discovery) and the single accepted answer with its author/origin.
 */
export type QuestionView = {
  questionId: string; workId: string; executionId: string; invocationId: string; recordedAt: string; recordedFrom: 'worker-notification' | 'worker-completion';
  content: { question: string; context: string; sha256: string; reference: { workId: string; id: string } };
  destination: { kind: 'issue'; ticket: TicketRef };
  state: 'open' | 'answered';
  publication: { effectId: string; state: 'intended' | 'attempting' | 'published' | 'ambiguous' | 'failed' | 'conflict'; updatedAt: string;
    attempts: { at: string; outcome: 'attempting' | 'published' | 'failed' | 'unknown' | 'discovered' | 'absent' | 'discovery-incomplete' | 'multiple'; code?: string;
      /** Self-revocation of the single-use publication credential after this attempt. */ revocation?: string }[];
    comment: { commentId: number; url: string } | null; nextStep: string | null };
  answer: { text: string; sha256: string; acceptedAt: string; author: { kind: 'github'; id: number; login: string } | { kind: 'local-administrator' };
    origin: { kind: 'github-comment'; commentId: number; url: string } | { kind: 'local-cli'; request_id: string } } | null;
  /** Bounded record of answers/commands that did not apply (duplicate, unauthorized, other Work...). */
  ignored: { at: string; origin: string; code: string }[];
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

export type Impediment = { code: string; scope: 'work' | 'installation'; since?: string; nextStep: string; questionId?: string };
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
  /** Earlier Executions of this Work, oldest first (a recovery Execution replaces `execution`, never erasing its predecessor). */
  previousExecutions: ExecutionView[];
  /** Question identities of this Work, in recording order. */
  questions: string[];
  /** Last processed comment of the Ticket issue (complete listings only). */
  inputs: { cursor: number | null };
  admittedAt: string;
  history: ({ at: string; event: 'admitted'; origin: 'github-polling'; sequence: number } |
    { at: string; event: 'dependencies-changed'; origin: 'github-polling'; before: DependencyEvaluation['conclusion'] | null; after: DependencyEvaluation['conclusion']; evaluationId: string } |
    { at: string; event: 'execution-reserved' | 'execution-prepared' | 'execution-booted' | 'activation-requested' | 'execution-started' | 'execution-ended' | 'execution-held' | 'execution-released' | 'slot-released';
      origin: 'controller-dispatch'; executionId: string; detail?: string } |
    { at: string; event: 'question-recorded' | 'question-published' | 'question-answered'; origin: 'controller-dispatch' | 'controller-publication' | 'github-comment' | 'local-cli';
      questionId: string; detail?: string })[];
};
export type ListView = { kind: 'list'; paused: boolean; dispatch: 'closed' | 'open'; dispatchReason: DispatchReason | null; slots: { capacity: number; held: number };
  queues: { normal: string[]; repair: string[] }; works: WorkView[]; selection: Selection; polling: PollingView; limitations: string[] };
export type ShowView = { kind: 'work'; work: WorkView; lastPolled: CandidateView | null; questions: QuestionView[] } | { kind: 'work-not-found'; work_id: string; nextStep: string };
export type QuestionQueryView = { kind: 'question'; question: QuestionView } | { kind: 'question-not-found'; question_id: string; nextStep: string };
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
  questions: { open: number; answered: number; unpublished: number };
  selection: { next: string | null };
  polling: Omit<PollingView, 'repositories'> & { repositories: Omit<RepositoryPollView, 'candidates'>[] };
  persistence: { sqliteVersion: string; sqliteSourceId: string; journalMode: 'wal'; synchronous: 'FULL' };
};
export interface Control {
  accept(input: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' }>;
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null } | AccessView | ListView | ShowView | QuestionQueryView>;
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' }>;
}
