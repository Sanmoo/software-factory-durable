import type { AccessDiagnostic, BuilderCredentials, BuilderGrantMetadata, GitHubScope, HandoffDeclarations, ProposalHandoff, ProposalIdentity, ReviewerRole, ReviewOpinion, RevocationResult } from '../contracts/index.js';
import type { CheckoutRequest, EnvironmentRef, PreparedWork, StartResult, StopResult, BootRef } from '../sandbox/index.js';
import type { ActivationDelivery, DeliveryResult, ActivationEvents, HandoffEvent, Invocation, WorkerDirective, WorkerCompletion, SessionObservation, WorkerSessionRef } from '../workers/index.js';
export type { SessionObservation, WorkerSessionRef as SessionRef } from '../workers/index.js';
import type { IssueTracker, TicketRef } from '../issue-tracker/index.js';
import type { CodeRepository } from '../code-repository/index.js';
import type { Hold } from './rules/admission.js';
import type { BlockerView, DependencyReason } from './rules/dependencies.js';

/** `dependencyResults`: preflight of repositories accessible only for dependency reads (no issue/relation is created). */
export type AccessView = { kind: 'access'; scope: 'authenticated'; results: { tracker: AccessDiagnostic; repository: AccessDiagnostic }[]; dependencyResults: AccessDiagnostic[] };
/** Per-repository limits of the validated configuration (spec §11.2): defaults 3/3, timeout absent (no implicit cut). */
export type ConfiguredRepository = GitHubScope & { base: string; label: string; correctionLimit?: number | undefined; recoveryLimit?: number | undefined; timeoutSeconds?: number | undefined };
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
  { request_id: string; operation: 'answer'; question_id: string; text: string; origin: 'local-cli' } |
  /** Explicit additional budget for ONE counter of a Work (spec §11.3 `grant`), from the authorized local ingress. */
  { request_id: string; operation: 'grant'; work_id: string; counter: 'corrections' | 'recoveries'; amount: number; origin: 'local-cli' } |
  /** Ticket 11 (spec §11.3): authorize ONE concrete new version of the Work's request; never applied to a running activity. */
  { request_id: string; operation: 'update-scope'; work_id: string; reason: string; origin: 'local-cli' };
/** `answer`: `accepted` removed only that Question's impediment; `not-applied` (already answered, unknown, closed Work...) changed nothing. */
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number } |
  { kind: 'durable'; request_id: string; operation: 'answer'; question_id: string; outcome: 'accepted' | 'not-applied'; reason: string | null; work_id: string | null } |
  /** `grant`: `accepted` added capacity (history kept, counters untouched); `not-applied` changed nothing (unknown/closed/old Work). */
  { kind: 'durable'; request_id: string; operation: 'grant'; work_id: string; counter: 'corrections' | 'recoveries'; amount: number;
    outcome: 'accepted' | 'not-applied'; reason: string | null; budget: CounterView | null } |
  /** `accepted`: recorded for the next activation (the Work re-enters its queue position if it was idle after a completed Execution);
   * `deferred`: an activity is running or held, nothing reaches it, the change waits for the next safe activation; `not-applied`: nothing changed. */
  { kind: 'durable'; request_id: string; operation: 'update-scope'; work_id: string; outcome: 'accepted' | 'deferred' | 'not-applied'; reason: string | null;
    scopeUpdateId: string | null; appliesAt: 'next-activation' | null };
export type ControlQuery = { kind: 'status' } | { kind: 'request'; request_id: string } | { kind: 'access' } | { kind: 'list' } | { kind: 'show'; work_id: string } |
  { kind: 'question'; question_id: string };
export type DispatchReason = 'RECONCILIATION_REQUIRED' | 'EXECUTION_NOT_ENABLED';
/**
 * Ticket 26: host listing of the installation's own runtime resources taken by the composition after the exclusive lock and BEFORE the
 * storage opens (spec §5.2 boot step 3). `environments` carries the attribution the Sandbox host read from each environment's own metadata
 * (null: unreadable/foreign); `cache` the per-repository host Git cache states (`preparing`: an interrupted fetch/clone may still run);
 * `unknown` every other entry the host cannot classify. Unknown resources are never ignored to declare free capacity.
 */
export type RuntimeInventory = { kind: 'listed'; observedAt: string; environments: { environment: string; workId: string | null }[];
  cache: { repositoryId: number | null; state: 'idle' | 'preparing' | 'unknown'; nextStep?: string | null }[]; unknown: string[] };
/** Ticket 26 Q6 `observe` facet: the complete synchronized start receipt of one invocation in the protected Records, if any. */
export type StartObservation = { kind: 'receipt'; receipt: { workId: string; id: string; executionId: string; invocationId: string }; recordedAt: string } |
  { kind: 'absent'; completeness: 'complete' } | { kind: 'uncertain'; code: string };
/** Durable boot/live reconciliation of one interrupted Execution (spec §5.2-5.4): what was observed and decided, by which controller run. */
export type RecoveryRecord = { at: string; controllerRunId: string; trigger: 'boot' | 'administrative-stop';
  /** Old evidence incorporated explicitly: the phase/hold/end found, and whose origin measured the Execution. */
  found: { state: ExecutionView['state']; phase: ExecutionView['dispatch']['phase']; held: string | null; end: string | null; origin: string | null };
  cessation: { result: 'confirmed' | 'unconfirmed'; basis: string; environment: string | null; boot: string | null };
  start: { kind: 'confirmed' | 'not-started' | 'uncertain'; detail: string };
  decision: 'operational-recovery' | 'requeued' | 'administrative-continuation' | 'blocked' | 'kept' | 'settled'; code: string | null };

/** Injected execution boundaries (spec §2.4/Q11): public Sandbox lifecycle, Workers activation and the Builder credential projection. */
export type ExecutionPorts = {
  sandbox: {
    prepare(input: { workId: string; configuration: unknown; checkout: CheckoutRequest }): Promise<PreparedWork>;
    start(input: { environment: EnvironmentRef; configuration: unknown }): Promise<StartResult>;
    stop(input: { environment: EnvironmentRef; boot: BootRef; reason: string }): Promise<StopResult>;
    /** Ticket 12: Host identity of a handed-off proposal (confined reads); required when `reviews` is composed. */
    observeProposal?(input: { environment: EnvironmentRef; round: number }): Promise<ProposalIdentity>;
    /** Ticket 13: Host confirmation of a preserved-source authorization (confined, no-follow read: the file exists and is listed in the
     * version's sources.json). Absent = no preserved-source authorization is ever correlated. */
    verifyPreservedSource?(input: { environment: EnvironmentRef; reference: string }): Promise<{ status: 'verified' | 'invalid'; code: string }>;
    /** Ticket 26: Sandbox `observe` (host path, works without the old Gondolin owner); without `boot`, the environment's current boot. */
    observe?(input: { environment: EnvironmentRef; boot?: BootRef }): Promise<{ condition: string; cessationConfirmed: boolean; boot?: BootRef | null }>;
  };
  workers: { activate(invocation: Invocation, delivery?: ActivationDelivery, events?: ActivationEvents): Promise<{ worker: string;
    started: Promise<{ receipt: { workId: string; id: string }; invocation: { executionId: string; invocationId: string } }>; completed: Promise<WorkerCompletion>;
    /** Builder with a handoff policy: next suspended handoff, or null once the worker completed. */
    handoffs?: { next(): Promise<HandoffEvent | null> };
    close(): void }>;
    /** Q6 `deliver`: renewed transient credential or its withdrawal, or (ticket 12) the review results, to the CURRENT Builder; never
     * persisted, not proof of consumption. */
    deliver(worker: string, directive: WorkerDirective): Promise<DeliveryResult>;
    /** Q6 `observe` (ticket 11): whether a preserved Builder session can be continued by the planned next Builder activation. Absent: replaced. */
    observe?(input: { workId: string; executionId: string; invocationId: string; session: WorkerSessionRef;
      next: Pick<Invocation, 'skillPack' | 'copyOutput' | 'editSourceMaxBytes'> & { handoff: boolean } }): Promise<{ session: SessionObservation; limitations: string[] }>;
    /** Ticket 26 (Q6 `observe`, receipt facet): the protected start receipt of an invocation, without notification and without rerunning. */
    observeStart?(input: { workId: string; executionId: string; invocationId: string }): Promise<StartObservation> };
  /** Ticket 12: when composed, the Builder hands off for parallel Standards/Spec reviews inside the SAME Execution/Slot/boot.
   * Ticket 13 `rounds.max`: repeated captures per Builder activation (handoffs with treatments/gates plus the Host's closing capture),
   * exemptions (unchanged content, identical commit) and the end-of-Execution verification. Absent = the single ticket 12 round.
   * PRODUCTION COMPOSITION (`composeProductionExecution`) passes `rounds: productionProfile.reviewRounds` (`{ max: 4 }`) so findings and
   * gates are treated without a new Execution. */
  reviews?: { reviewer: Pick<Invocation, 'modelBudget' | 'imageSourceMaxBytes'>; rounds?: { max: number } };
  credentials: BuilderCredentials;
  /** Local monotonic clock of live Execution duration/timeout (default `performance.now()`); separate from the polling clock. Tests substitute it. */
  clock?: PollingClock;
  /** Calendar clock of the persisted recovery waits (default `Date.now()`); never the monotonic clock. Tests substitute it. */
  calendar?: { now(): number };
  /** Renew a Builder grant this many seconds before its expiresAt while the activity stays authorized (default 600). */
  credentialRenewal?: { beforeExpirySeconds: number };
  /** Sandbox configuration as configured (interpreted by Sandbox only). */
  configuration: unknown;
  /** Slot capacity (configuration `concurrency`). */
  capacity: number;
  /** Host Builder policies applied to every initial Builder invocation. */
  builder: Pick<Invocation, 'skillPack' | 'modelBudget' | 'copyOutput' | 'editSourceMaxBytes'>;
};
export type CredentialWithdrawal = 'ended' | 'external-wait' | 'cancelled' | 'held' | 'refused' | 'owner-stopped' | 'controller-restart' | 'timeout';
/**
 * One budget counter of a Work (spec §4.4): the limit captured from the repository configuration at admission, explicit grants, the
 * consumptions (each one confirmed start) and the single Execution holding an atomic reservation (null when none).
 */
export type BudgetCounter = { limit: number; granted: number; consumed: number; reserved: string | null };
/** Explicit, auditable grant (spec §4.4/§11.3): never a counter reset; before/after keep the history. */
export type BudgetGrant = { at: string; request_id: string; origin: 'local-cli'; counter: 'corrections' | 'recoveries'; amount: number;
  before: BudgetCounter; after: BudgetCounter };
/** Corrections and operational recoveries, separate (spec §4.4). Changing the YAML later neither erases exhaustion nor replaces a grant. */
export type WorkBudget = { corrections: BudgetCounter; recoveries: BudgetCounter;
  source: { kind: 'repository-configuration'; repository: string; recordedAt: string }; grants: BudgetGrant[] };
/**
 * Budget charge of one Execution: `reserved` in the "Admitir Execução" commit, `consumed` once in "Confirmar início", `released` when non-start
 * is proven; an uncertain start keeps `reserved`. `preserved`: a continuation of a correction already charged (question/answer).
 */
export type ExecutionCharge = { kind: 'none' | 'correction' | 'recovery'; correctionId: string | null; counter: 'corrections' | 'recoveries' | null;
  state: 'none' | 'reserved' | 'consumed' | 'released' | 'preserved'; settledAt: string | null };
/**
 * Duration/timeout evidence of one Execution (spec §5.7). Elapsed values are measured on the monotonic clock of ONE controller process
 * (`origin`) from the confirmed start; they are never compared with another process's origin. Calendar instants are presentation/audit only.
 */
export type ExecutionTiming = {
  timeoutSeconds: number | null; clock: 'controller-monotonic'; origin: string | null; startedAt: string | null;
  lastActivity: { at: string; elapsedMs: number; event: string } | null;
  duration: { kind: 'measured'; elapsedMs: number; endedAt: string } |
    /** After a restart: proven at least `provenMs` (last durable observation); the calendar difference is an estimate, not proof. */
    { kind: 'lower-bound'; provenMs: number; calendarEstimateMs: number | null; reconciledAt: string } | null;
  timeout: { reachedAt: string; elapsedMs: number; evidence: 'measured' | 'lower-bound' } | null;
  overrun: 'not-applicable' | 'within' | 'proven' | 'not-excludable' | null;
};
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
    /** Resumption basis (re-checked in the admission commit): the previous Execution and what authorizes the new activation — its answered
     * Question and/or concrete scope updates. `NEW_BOOT_REPLACEMENT_SESSION` is the ticket-10 record of an answered Question. */
    resume?: { previousExecutionId: string; questionId: string | null; answerSha256: string | null; scopeUpdateIds?: string[];
      reason: 'QUESTION_ANSWERED' | 'SCOPE_UPDATED' | 'NEW_BOOT_REPLACEMENT_SESSION' } | null;
    /** Scope updates bound to this Execution at admission (delivered in its first prompt; `delivered` once its start is confirmed). */
    scopeUpdateIds?: string[];
    /** Session decision of a resumed Builder (spec §5.5/§6.1): `continue` the previous compatible session, or `replace` it with the reason. */
    session?: { mode: 'continue' | 'replace'; reason: string; previousExecutionId: string; previous: WorkerSessionRef | null; decidedAt: string } | null };
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
  end: { at: string; outcome: 'completed' | 'failure' | 'question' | 'timeout' | 'stopped'; code: string | null; cessation: 'confirmed' | 'unconfirmed' | 'not-attempted'; questionId?: string | null;
    /** Host-observed preserved Builder session (ticket 11); null/absent = not recorded. */
    session?: WorkerSessionRef | null } | null;
  held: { code: string; phase: string; at: string; nextStep: string } | null;
  completion: { automatic: false; reason: string };
  /** Review rounds of this Execution (ticket 12); absent when reviews are not composed. Reviewers never hold a Slot of their own.
   * Ticket 13: `firstRound` continues the round numbers of earlier Executions of the Work; `verification` is Control's presence/correlation
   * check of opinions, treatments, gates and waivers over the final captured content (never a semantic certification). */
  review?: { rounds: ReviewRoundView[]; firstRound?: number; verification?: VerificationView | null };
  /** Ticket 19 (absent on earlier records): budget charge and duration/timeout evidence of this Execution. */
  charge?: ExecutionCharge;
  timing?: ExecutionTiming;
  /** Ticket 26: reconciliations of this Execution after an interruption (boot or administrative stop), oldest first. */
  recovery?: RecoveryRecord[];
  /** Ticket 26: basis of an Execution that follows an interrupted one (operational recovery or continuation after a clean stop). */
  interruption?: { previousExecutionId: string; reason: 'OPERATIONAL_RECOVERY' | 'ADMINISTRATIVE_STOP'; code: string } | null;
};
/**
 * Ticket 13: end-of-Execution verification (spec §6.4/§9.3). `verified` only with no reason; every reason is independent and explicit.
 * It is committed BEFORE the Execution end is recorded, but it does NOT gate completion: an Execution can end `completed` while its
 * verification is `not-verified`. Publication/GitHub readiness (tickets 14/15) MUST consume this field and must never treat a
 * `completed` Execution as success without it.
 */
export type VerificationView = { at: string; status: 'verified' | 'not-verified'; reasons: string[];
  /** The review round whose two opinions apply to the final content, and how that applicability is demonstrated. */
  reviewedRound: number | null; finalRound: number | null; contentSha256: string | null;
  applicability: { kind: 'reviewed' | 'unchanged' | 'identical-commit' | 'none'; head: string | null; reviewedHead: string | null };
  gates: { id: string; outcome: string; current: boolean; boundToFinalContent: boolean; requiredCheck: string | null }[];
  treatments: { round: number; role: ReviewerRole; findingId: string; outcome: 'fixed' | 'not-adopted' | 'missing' }[];
  /** GitHub required checks named by gates: always still evaluated by the GitHub readiness (a waiver never satisfies them). */
  requiredChecks: string[] };
export type ReviewerView = { invocationId: string; phaseId: string; promptSha256: string; state: 'requested' | 'started' | 'ended' | 'failed' | 'not-required';
  requestedAt: string; receiptId: string | null; endedAt: string | null; opinion: ReviewOpinion | null; failure: { code: string } | null;
  /** How the end of this reviewer's activity is known: its completion was received, it never launched, or it is unconfirmed (round held). */
  cessation: 'completion-observed' | 'never-started' | 'unconfirmed' | null;
  input: { required: string[]; missing: string[] } };
/** One durable review round (spec §5.6/§6.4): handoff, identity before/after, both reviewers, conclusion and the delivery to the Builder. */
export type ReviewRoundView = {
  round: number; attempt: number; state: 'reviewing' | 'concluded' | 'delivered';
  /** Ticket 13: `exemption` = no reviewer ran because the content of the last reviewed round is demonstrably unchanged (`unchanged`) or
   * held exactly by a new commit (`identical-commit`); `closing` = the Host's capture after the Builder session ended. Absent = review. */
  kind?: 'review' | 'exemption'; closing?: boolean;
  exemption?: { kind: 'unchanged' | 'identical-commit'; reviewedRound: number; head: string; reviewedHead: string; contentSha256: string } | null;
  /** Treatments and Host gate evidence the Builder host attached to this capture. */
  declarations?: HandoffDeclarations | null;
  handoff: { at: string; invocationId: string; status: 'captured' | 'failure'; code: string | null; detail: string | null; summary: ProposalHandoff | null };
  versions: { spec: ProposalHandoff['spec']; instructions: ProposalHandoff['instructions']; base: string | null; head: string | null;
    profile: { skillPack: { name: string; manifestSha256: string } | null; builder: ExecutionView['request']['policies']; reviewer: Pick<Invocation, 'modelBudget' | 'imageSourceMaxBytes'> } };
  identity: { before: ProposalIdentity | null; after: ProposalIdentity | null };
  reviewers: Record<ReviewerRole, ReviewerView>;
  applicability: 'current' | 'invalidated' | 'unknown' | null; conclusion: 'clean' | 'findings' | 'incomplete' | null; reasons: string[]; concludedAt: string | null;
  delivery: { requestedAt: string; outcome: 'requested' | 'delivered' | 'failed' | 'uncertain'; code: string | null; promptSha256: string } | null;
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
  /** Ticket 19: budget snapshot (null on Works admitted before it, until their next budget commit). */
  budget: WorkBudget | null;
  /** The correction under way (identity kept across its activations); opened by the repair flows (tickets 22/23). */
  correction: { correctionId: string; reason: string; openedAt: string; consumed: boolean } | null;
  /** A pending operational recovery (ticket 26 decides it); consumed by the start of the recovery Execution. */
  pendingRecovery: { reason: string; requestedAt: string;
    /** Ticket 26: persisted wait (calendar) before the recovery may start, its length and the attempt index it was derived from. */
    notBefore?: string; waitSeconds?: number; attempt?: number; executionId?: string | null } | null;
  /** Presentation only (never persisted): limits/reservations/consumption, timeout, duration/last activity and the action required. */
  limits: LimitsView;
  /** Concrete scope updates authorized by the operator (ticket 11), in acceptance order. Later Ticket/link edits are never one. */
  scopeUpdates?: ScopeUpdateView[];
  admittedAt: string;
  history: ({ at: string; event: 'admitted'; origin: 'github-polling'; sequence: number } |
    { at: string; event: 'dependencies-changed'; origin: 'github-polling'; before: DependencyEvaluation['conclusion'] | null; after: DependencyEvaluation['conclusion']; evaluationId: string } |
    { at: string; event: 'execution-reserved' | 'execution-prepared' | 'execution-booted' | 'activation-requested' | 'execution-started' | 'execution-ended' | 'execution-held' | 'execution-released' | 'slot-released' |
      'review-handoff' | 'reviewer-started' | 'reviewer-ended' | 'review-concluded' | 'review-delivered' | 'review-exempted' | 'review-verified';
      origin: 'controller-dispatch'; executionId: string; detail?: string } |
    { at: string; event: 'question-recorded' | 'question-published' | 'question-answered'; origin: 'controller-dispatch' | 'controller-publication' | 'github-comment' | 'local-cli';
      questionId: string; detail?: string } |
    { at: string; event: 'budget-reserved' | 'budget-consumed' | 'budget-released' | 'budget-exhausted' | 'budget-granted' | 'correction-opened' | 'correction-reason-added' | 'recovery-requested';
      origin: 'controller-budget' | 'local-cli'; executionId: string | null; detail: string } |
    { at: string; event: 'timeout-reached' | 'duration-reconciled'; origin: 'controller-clock'; executionId: string; detail: string } |
    { at: string; event: 'scope-update-accepted' | 'scope-update-delivered' | 'scope-update-reoffered' | 'scope-update-consumed'; origin: 'local-cli' | 'controller-dispatch';
      scopeUpdateId: string; detail?: string } |
    { at: string; event: 'execution-reconciled' | 'recovery-wait-kept'; origin: 'controller-recovery'; executionId: string | null; detail: string })[];
};
export type CounterView = { limit: number; granted: number; effectiveLimit: number; consumed: number; reserved: 0 | 1; reservedBy: string | null; available: number; exhausted: boolean };
/** `elapsedMs` is a monotonic measurement (live or measured) or null; `unknown` is never shown as zero. */
export type DurationView = { state: 'not-recorded' | 'not-started' | 'running' | 'measured' | 'lower-bound' | 'unknown'; elapsedMs: number | null;
  lowerBoundMs: number | null; calendarEstimateMs: number | null; clock: 'controller-monotonic' | null; startedAt: string | null;
  lastActivity: ExecutionTiming['lastActivity']; note: string };
export type LimitsView = { corrections: CounterView | null; recoveries: CounterView | null; grants: number;
  timeout: { seconds: number | null; scope: 'per-execution'; reached: ExecutionTiming['timeout']; overrun: ExecutionTiming['overrun'] };
  duration: DurationView; actions: { code: string; nextStep: string }[] };
/** One authorized scope change (spec §6.2/§11.3), never applied to a running activity. `pending` = will go with the next activation;
 * `delivered` = sent in the first prompt of a started Execution but its consumption is not yet evidenced; `consumed` = that Execution
 * ended COMPLETED with confirmed cessation. A delivery whose Execution ended otherwise returns to `pending` (re-offered, never lost) — and
 * the concrete reason is re-offered as-is, never broadened. */
export type ScopeUpdateView = { scopeUpdateId: string; reason: string; sha256: string; acceptedAt: string; origin: { kind: 'local-cli'; request_id: string };
  acceptedDuring: 'idle' | 'question-wait' | 'activity'; state: 'pending' | 'delivered' | 'consumed'; executionId: string | null; deliveredAt: string | null;
  consumedAt: string | null; consumption: 'execution-completed' | null; reoffers: number };
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
  /** Ticket 26: boot reconciliation of THIS run (null before it ran or when nothing was composed to reconcile). */
  recovery: RecoveryView | null;
};
export type RecoveryView = { at: string; inventory: 'empty' | 'unknown' | 'listed'; reconciled: number; ceased: number; unconfirmed: number;
  global: string[]; cachePreparing: (number | null)[];
  /** Caches still left in preparation after the owner's repair-free reconciliation, with the explicit operator action. */
  cache: { repositoryId: number | null; state: string; nextStep: string | null }[] };
export interface Control {
  accept(input: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' }>;
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null } | AccessView | ListView | ShowView | QuestionQueryView>;
  /** `uncertain`: stopped, but the cessation of some activity could not be confirmed (the next boot reconciles it as an interruption). */
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' | 'uncertain' }>;
}
