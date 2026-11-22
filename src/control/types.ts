import type { AccessDiagnostic, BootUsage, BootUsageReport, PreservationObservation, ChannelReport, EnvironmentBuildReport, EnvironmentBuilds, IndeterminateEffect, EnvironmentBaseIdentity, EnvironmentDeclarationError, PinnedEnvironment, BudgetEndProgress, BuilderBudgetConfiguration, BuilderCredentials, CheckoutFingerprint, BuilderGrantMetadata, GitHubScope, HandoffDeclarations, ProposalHandoff, ProposalIdentity, ReviewerRole, ReviewOpinion, RevocationResult, SandboxCapabilities, StartRetryRemedy } from '../contracts/index.js';
import type { CheckoutRequest, EnvironmentRef, PreparedWork, RemoveResult, StartResult, StopResult, BootRef } from '../sandbox/index.js';
import type { ActivationDelivery, DeliveryResult, ActivationEvents, HandoffEvent, Invocation, WorkerDirective, WorkerCompletion, SessionObservation, WorkerSessionRef, OpinionObservation, QuestionObservation } from '../workers/index.js';
export type { SessionObservation, WorkerSessionRef as SessionRef } from '../workers/index.js';
import type { IssueTracker, JiraBlockerReads, JiraRemoteLinks, TicketRef } from '../issue-tracker/index.js';
import type { CodeRepository } from '../code-repository/index.js';
export type { BranchCleanupResult, OwnPullRequestFacts } from '../code-repository/index.js';
export type { ConversationCommentFact, FeedbackObservation, ReviewCommentFact, ReviewFact } from '../code-repository/index.js';
import type { Hold } from './rules/admission.js';
import type { BlockerView, DependencyReason } from './rules/dependencies.js';

/** `dependencyResults`: preflight of repositories accessible only for dependency reads (no issue/relation is created). */
export type AccessView = { kind: 'access'; scope: 'authenticated'; results: { tracker: AccessDiagnostic; repository: AccessDiagnostic }[]; dependencyResults: AccessDiagnostic[] };
/** Per-repository limits of the validated configuration (spec §11.2): defaults 3/3, timeout absent (no implicit cut). */
export type ConfiguredRepository = GitHubScope & { base: string; label: string; correctionLimit?: number | undefined; recoveryLimit?: number | undefined; timeoutSeconds?: number | undefined;
  /** Ticket 48: the repository's Builder budget adjustment (validated by the configuration: at most 2x the release values). */
  builderBudget?: BuilderBudgetConfiguration | undefined };
/** `repositories` are executable Ticket origins; `dependencyRepositories` are readable only for native blocked_by and never executable. */
/** `operators`: configured GitHub operator logins whose strict `/factory` comments on a Work's own Ticket may answer its Questions. */
export type AccessDependencies = { tracker: IssueTracker; repository: CodeRepository; repositories: ConfiguredRepository[]; dependencyRepositories?: GitHubScope[];
  /** Login, or `{login, id}` with the pinned GitHub user id (then matched by id only). */
  operators?: (string | { login: string; id?: number })[];
  /** Ticket 14: resolves the Factory App's bot identity (lazy, safe read); null/absent = unknown, and then nothing is publishable. */
  factoryApp?: () => Promise<FactoryAppIdentity | null>;
  /** Jira ticket 01: the configured Ticket sources (absent = every executable repository is a GitHub source with discovery on, YAML v1). */
  sources?: TicketSource[];
  /** Jira ticket 01: adapters of the other origins, selected by the Ticket's persisted `tracker` (`tracker` above stays the GitHub one). */
  trackers?: { jira?: JiraOriginTracker } };
/** Jira ticket 03: the Jira adapter as the Control uses it (common contract, remote links and the reads behind visible blockers). */
export type JiraOriginTracker = IssueTracker<'jira'> & JiraRemoteLinks & JiraBlockerReads;
/**
 * Jira ticket 01: one Ticket source. `discover` gates NEW admissions only: Works already admitted keep their origin, destination and
 * conversation. A Jira source routes components (by ID) to executable repositories; no credential is carried here.
 */
export type TicketSource = { tracker: 'github'; repository: string; discover: boolean } |
  { tracker: 'jira'; siteId: string; url: string; projectId: string; label: string; discover: boolean; routes: { componentId: string; repository: string }[] };
/** Monotonic local clock for live polling cadence; calendar time is only used for observation instants. Tests substitute it. */
export type PollingClock = { monotonic(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
export type PollingOptions = { intervalSeconds: number; clock?: PollingClock };
export type ExecutionOptions = ExecutionPorts;
export type ControlInput = { request_id: string; operation: 'pause' | 'unpause'; origin: 'local-cli' } |
  { request_id: string; operation: 'answer'; question_id: string; text: string; origin: 'local-cli' } |
  /** Explicit additional budget for ONE counter of a Work (spec §11.3 `grant`), from the authorized local ingress. */
  { request_id: string; operation: 'grant'; work_id: string; counter: 'corrections' | 'recoveries' | 'continuations'; amount: number; origin: 'local-cli' } |
  /** Ticket 11 (spec §11.3): authorize ONE concrete new version of the Work's request; never applied to a running activity. */
  { request_id: string; operation: 'update-scope'; work_id: string; reason: string; origin: 'local-cli' } |
  /** Ticket 16 (spec §9.3): authorize ONE restoration of ready after an unexpected human draft, or ONE repeat of a conversion that was not
   * applied. Never a readiness certificate: the conversion still needs a complete current evaluation and the pre-conversion recheck. */
  { request_id: string; operation: 'authorize-readiness'; work_id: string; reason: string; origin: 'local-cli' } |
  /** Ticket 25 (spec §4.1/§11.3/§12.3): `cancel` ends the cycle (prohibition first, stop requested, artifacts and GitHub untouched); `resume`
   * lifts ONLY the suspension of a withdrawn authorization or a reopened PR, revalidated on the next read; `reopen` reopens the Work's OWN pull
   * request closed without merge (never budget/scope/resume). */
  { request_id: string; operation: 'cancel' | 'resume' | 'reopen'; work_id: string; origin: 'local-cli' } |
  /** Ticket 41: `resume <work> --override-blocked-recovery <reference>` — the operator's explicit decision to continue a Work blocked
   * (`RECOVERY_BLOCKED`) by a lost Builder request whose blocked reference is EXACTLY `override_blocked_recovery`. Revalidated in the commit;
   * the lost request is never invented; the Work returns through ONE operational recovery (ticket 26). */
  { request_id: string; operation: 'resume'; work_id: string; override_blocked_recovery: string; origin: 'local-cli' } |
  /** Ticket 51: `resume <work> --new-review-round` — the operator's explicit decision, after REVIEWER_RETRY_LIMIT, to review again in a new round
   * (ONE operational recovery, ticket 26). The other decision is `cancel`; no input accepts the unverified round. */
  { request_id: string; operation: 'resume'; work_id: string; new_review_round: true; origin: 'local-cli' } |
  /** Ticket 50: explicit operator retry of the boot/preparation refusal that blocked the Work's recovery (exact code), optionally with a remedy. */
  { request_id: string; operation: 'resume'; work_id: string; retry_blocked_start: string; remedy?: StartRetryRemedy; origin: 'local-cli' } |
  /** Ticket 25: an explicit new cycle of a Ticket after delivery/cancellation (predecessor + own resources). `keepPredecessorPullRequest`: the
   * operator's explicit decision that a cancelled cycle's own PR that may still be open stays as it is (never adopted, closed or replaced). */
  { request_id: string; operation: 'new'; ticket: { repository: string; number: number }; keepPredecessorPullRequest: boolean; origin: 'local-cli' } |
  /** Ticket 30 (spec §12.4): explicit cleanup. `cleanup-plan` records a plan of losses for the selected details/resources of ONE Work (no effect);
   * `cleanup-confirm` confirms that plan, which is revalidated now and again per item at execution (an old plan never removes what became needed). */
  { request_id: string; operation: 'cleanup-plan'; work_id: string; select: ExplicitCleanupSelection[]; origin: 'local-cli' } |
  { request_id: string; operation: 'cleanup-confirm'; work_id: string; plan_id: string; origin: 'local-cli' } |
  /** Ticket 31 (spec §12.4 `forget`): explicit deletion of the history of ONE ended Work. `forget-plan` records the plan of losses (no effect);
   * `forget-confirm` confirms it; it is revalidated now and again just before the deletion, which keeps only the minimal cycle memory. */
  { request_id: string; operation: 'forget-plan'; work_id: string; origin: 'local-cli' } |
  { request_id: string; operation: 'forget-confirm'; work_id: string; plan_id: string; origin: 'local-cli' } |
  /** Ticket 23 (spec §11.3 `repair <work> --reason`): an explicit repair inside the current scope, charged to `corrections`; recorded for the
   * next safe activation, never delivered to a running activity, never a launch. */
  { request_id: string; operation: 'repair'; work_id: string; reason: string; origin: 'local-cli' } |
  /** Ticket 61: re-evaluate ONE publication blocked only by unexpected ref changes: the next discovery pass re-reads the remote (complete
   * read) and re-applies the discovery rule to the persisted window with the current Control state. Never repeats or adopts anything. */
  { request_id: string; operation: 'reevaluate-publication'; work_id: string; reason: string; origin: 'local-cli' };
/** `answer`: `accepted` removed only that Question's impediment; `not-applied` (already answered, unknown, closed Work...) changed nothing. */
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number } |
  { kind: 'durable'; request_id: string; operation: 'answer'; question_id: string; outcome: 'accepted' | 'not-applied'; reason: string | null; work_id: string | null } |
  /** `grant`: `accepted` added capacity (history kept, counters untouched); `not-applied` changed nothing (unknown/closed/old Work). */
  { kind: 'durable'; request_id: string; operation: 'grant'; work_id: string; counter: 'corrections' | 'recoveries' | 'continuations'; amount: number;
    outcome: 'accepted' | 'not-applied'; reason: string | null; budget: CounterView | null } |
  /** `accepted`: recorded for the next activation (the Work re-enters its queue position if it was idle after a completed Execution);
   * `deferred`: an activity is running or held, nothing reaches it, the change waits for the next safe activation; `not-applied`: nothing changed. */
  { kind: 'durable'; request_id: string; operation: 'update-scope'; work_id: string; outcome: 'accepted' | 'deferred' | 'not-applied'; reason: string | null;
    scopeUpdateId: string | null; appliesAt: 'next-activation' | null } |
  /** `accepted`: recorded for the next conversion of that purpose (consumed once); `not-applied`: nothing to authorize, nothing changed. */
  { kind: 'durable'; request_id: string; operation: 'authorize-readiness'; work_id: string; outcome: 'accepted' | 'not-applied'; reason: string | null;
    purpose: 'human-draft' | 'repeat-conversion' | null } |
  /** Ticket 25. `accepted`: recorded (cancel: prohibition durable, stop requested; reopen: effect intended, its result is observed later; resume:
   * suspension lifted pending the next authorization read; new: the new Work `created`); `already-satisfied`: nothing to do (e.g. already
   * cancelled, an activity already running for resume); `not-applied`: refused, nothing changed (`reason`). An ACK never proves cessation or effect. */
  { kind: 'durable'; request_id: string; operation: 'cancel' | 'resume' | 'reopen' | 'new'; work_id: string | null; outcome: 'accepted' | 'already-satisfied' | 'not-applied';
    reason: string | null; created: string | null } |
  /** Ticket 30. `cleanup-plan`: `accepted` = the plan (losses, warnings, refusals) is recorded and waits for `cleanup-confirm`; nothing was removed.
   * `cleanup-confirm`: `accepted` = confirmed after revalidation, the items still allowed are executed after the ACK (per-item results in
   * `factory show`); `already-satisfied` = this plan was already confirmed; `not-applied` = refused (`reason`), nothing changed. */
  { kind: 'durable'; request_id: string; operation: 'cleanup-plan' | 'cleanup-confirm'; work_id: string; outcome: 'accepted' | 'already-satisfied' | 'not-applied';
    reason: string | null; plan: ExplicitCleanupPlan | null } |
  /** Ticket 31. `forget-plan`: `accepted` = plan of losses recorded (nothing deleted), `not-applied` = refused with `reason` (the plan names every refusal);
   * `forget-confirm`: `accepted` = confirmed after revalidation, executed after the ACK (result in `factory show`: the Work, or its minimal memory once
   * forgotten); `already-satisfied` = already confirmed/forgotten; `not-applied` = refused, nothing changed. */
  { kind: 'durable'; request_id: string; operation: 'forget-plan' | 'forget-confirm'; work_id: string; outcome: 'accepted' | 'already-satisfied' | 'not-applied';
    reason: string | null; plan: ForgetPlan | null } |
  /** Ticket 23 `repair`: `accepted` (idle Work with its own PR: enters the Work's correction at the next repair pass), `deferred` (an
   * activity, review, Question or publication is under way: recorded for the next safe activation), `already-covered` (the same request
   * is already pending in this Work: nothing duplicated), `not-applied` (refused: nothing changed). */
  { kind: 'durable'; request_id: string; operation: 'repair'; work_id: string; outcome: 'accepted' | 'deferred' | 'already-covered' | 'not-applied';
    reason: string | null; feedbackId: string | null; appliesAt: 'next-activation' | null;
    /** What the operator can do next (refusals name the command that applies, e.g. `update-scope` without an own PR). */
    nextStep: string | null } |
  /** Ticket 61 `reevaluate-publication`: `accepted` (recorded; the next discovery pass decides, result in `show`/`history`), `already-covered`
   * (a re-evaluation is already pending), `not-applied` (refused with `reason`: nothing changed). */
  { kind: 'durable'; request_id: string; operation: 'reevaluate-publication'; work_id: string; outcome: 'accepted' | 'already-covered' | 'not-applied';
    reason: string | null; nextStep: string | null };
export type ControlQuery = { kind: 'status' } | { kind: 'request'; request_id: string } | { kind: 'access' } |
  /** Ticket 29: `cursor`/`limit` page the Works (admission order) and the page is fitted to one frame; neither = the full list. */
  { kind: 'list'; cursor?: number | undefined; limit?: number | undefined } |
  { kind: 'question'; question_id: string } |
  /** Ticket 29: `cursor`/`limit` page `chain.executions` of a big Work (the full view is returned when it fits one frame). */
  { kind: 'show'; work_id: string; cursor?: number | undefined; limit?: number | undefined } |
  /** Ticket 29: paginated/filtered history, logs listing, one log page and consumption (read-only). */
  HistoryQuery | LogsQuery | LogReadQuery | UsageQuery;
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
export type RecoveryRecord = { at: string; controllerRunId: string;
  /** `review-retry-limit` (ticket 51): the live cessation of an Execution held REVIEWER_RETRY_LIMIT, so it never stays held waiting for the operator. */
  trigger: 'boot' | 'administrative-stop' | 'review-retry-limit' | /* ticket 50 */ 'start-refused';
  /** Old evidence incorporated explicitly: the phase/hold/end found, and whose origin measured the Execution. */
  found: { state: ExecutionView['state']; phase: ExecutionView['dispatch']['phase']; held: string | null; end: string | null; origin: string | null };
  cessation: { result: 'confirmed' | 'unconfirmed'; basis: string; environment: string | null; boot: string | null };
  start: { kind: 'confirmed' | 'not-started' | 'uncertain'; detail: string };
  decision: 'operational-recovery' | 'requeued' | 'administrative-continuation' | 'blocked' | 'kept' | 'settled'; code: string | null;
  /** Ticket 27: what the Records question facet established (`absent`, `recorded:<id>`, `unresolved:<code>` after bounded retries...). */
  question?: string };

/** Injected execution boundaries (spec §2.4/Q11): public Sandbox lifecycle, Workers activation and the Builder credential projection. */
export type ExecutionPorts = {
  sandbox: {
    /**
     * v2 (V2-03): what the installation's single sandbox declares about itself. Control decides from these values only (never from which
     * sandbox or service is behind them): a repository requiring a capability that is not declared never starts (V2-04), and "stop
     * preserves the disk/workspace" holds only where `persistentDisk` is declared. Absent = composed without a declaration (before v2):
     * no capability gate. The production composition always declares it.
     */
    capabilities?: SandboxCapabilities;
    /** `recreateSeeds` (ticket 50): artifact seeds the operator explicitly decided to recreate (divergent copy set aside, never deleted). */
    /** `environment` (ticket 44): the Work's pinned declaration; a NEW environment is created from the base disk prepared for it (an existing one
     * keeps the base it was created from). `retryEnvironmentBase`: the operator's retry of a failed/incomplete base preparation. */
    prepare(input: { workId: string; configuration: unknown; checkout: CheckoutRequest; recreateSeeds?: readonly string[];
      environment?: PinnedEnvironment & { repository: string; repositoryId: number }; retryEnvironmentBase?: boolean }): Promise<PreparedWork>;
    /** `pass`: identity of the dispatch pass that reserved this Execution (ticket 24; correlation/evidence only). */
    /** `diskRemedy` (ticket 47): the operator's repair/replace decision for a preserved disk that fails its check, applied by this boot only. */
    /** `checkout` (v2 ticket 06): given ONLY when the sandbox declares no persistent disk and `prepare` returned no checkout: the boot clones
     * this commit of `origin` inside the guest, on the Work branch. Control names the commit from its own read of `origin`. The successful
     * result then also carries `seeds` (Factory material written into the guest of this boot). */
    /** `reason` (v2 ticket 09, V2-10): `planned-swap` when this boot replaces another boot of the same Execution; absent = `start`. */
    start(input: { environment: EnvironmentRef; configuration: unknown; pass?: string; diskRemedy?: 'repair-disk' | 'replace-disk';
      checkout?: { repository: string; installationId: number; commit: string; branch: string }; reason?: 'start' | 'planned-swap' }): Promise<StartResult>;
    stop(input: { environment: EnvironmentRef; boot: BootRef; reason: string }): Promise<StopResult>;
    /** Ticket 12: Host identity of a handed-off proposal (confined reads); required when `reviews` is composed. */
    observeProposal?(input: { environment: EnvironmentRef; round: number }): Promise<ProposalIdentity>;
    /** Ticket 13: Host confirmation of a preserved-source authorization (confined, no-follow read: the file exists and is listed in the
     * version's sources.json). Absent = no preserved-source authorization is ever correlated. */
    verifyPreservedSource?(input: { environment: EnvironmentRef; reference: string }): Promise<{ status: 'verified' | 'invalid'; code: string }>;
    /** Ticket 26: Sandbox `observe` (host path, works without the old Gondolin owner); without `boot`, the environment's current boot. */
    observe?(input: { environment: EnvironmentRef; boot?: BootRef }): Promise<{ condition: string; cessationConfirmed: boolean; boot?: BootRef | null }>;
    /** Ticket 48: Host fingerprint of the Work's checkout (confined reads of Git metadata + a bounded walk of the tree; no host git, no guest
     * command). Absent = progress after a budget end is never established (it goes to recovery). */
    observeCheckout?(input: { environment: EnvironmentRef }): Promise<CheckoutFingerprint>;
    /** v2 ticket 07 (V2-06): the preservation gate's observation, made IN the guest of the environment's current boot by a fixed program
     * the host runs (workspace state, stash, HEAD and `ls-remote` of the Work branch). Required of a sandbox that declares no persistent
     * disk; absent there, nothing is ever treated as preserved. */
    preservationGate?(input: { environment: EnvironmentRef; boot: BootRef; repository: string; installationId: number; branch: string }): Promise<PreservationObservation>;
    /** v2 ticket 11 (V2-21): what a dropped tool channel left unconfirmed on one boot. Read only when the sandbox declares
     * `channelRecovery`, before the Execution's end is recorded and again before its boot is stopped; the result is recorded durably. */
    channelReport?(input: { environment: EnvironmentRef; boot: BootRef }): Promise<ChannelReport>;
    /** v2 ticket 14 (V2-32): what the boots of one environment consumed, as the sandbox reports it (seconds, size label, reasons; its own
     * unit). Read for inspection only; Control sums and shows it and never derives a duration or a price. Absent = the installation's
     * sandbox has no such report and the usage view is unchanged. */
    usage?(input: { environment: EnvironmentRef }): Promise<BootUsageReport>;
    /** v2 ticket 14 (V2-32): builds of the environment base per environment key, for the installation usage view. Absent = not shown. */
    environmentBuilds?(): Promise<EnvironmentBuildReport>;
    /**
     * v2 ticket 10 (V2-15): resolves when the sandbox CONFIRMED that the environment of this boot ended on its own (`null` once `signal`
     * aborts). Asked only of a sandbox that declares `environmentWatch`, for the boot of a running Execution. How and how often the
     * sandbox observes is its own business: Control never learns an interval and keeps no watchdog over silent work.
     */
    awaitEnvironmentEnd?(input: { environment: EnvironmentRef; boot: BootRef; signal: AbortSignal }): Promise<{ reason: string | null; terminatedAt: string | null } | null>;
    /**
     * v2 ticket 09 (V2-13): half the rotation margin is left and the call of this invocation has not returned: the sandbox interrupts
     * it (the call then answers as one whose result is not known). Asked only of a sandbox that declares a boot duration. Absent or
     * `unavailable` = nothing is interrupted, and the boot ends with whatever the gate did not accept (the loss path).
     */
    interruptCalls?(input: { environment: EnvironmentRef; boot: BootRef; invocationId: string }): Promise<{ status: 'interrupted'; calls: number } | { status: 'unavailable'; code: string }>;
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
    observeStart?(input: { workId: string; executionId: string; invocationId: string }): Promise<StartObservation>;
    /** Ticket 28 — Q6 `observe`, opinion facet: the complete opinion record a reviewer invocation preserved before its notification.
     * Absent = a reviewer outcome without its opinion is never recovered from Records (it stays a failure). Not proof of cessation. */
    observeOpinion?(input: { workId: string; executionId: string; invocationId: string }): Promise<OpinionObservation>;
    /** Ticket 27 — Q6 `observe`, question facet: the complete `ask_user` request a Builder invocation preserved before its notification/ACK.
     * Absent = a Question whose notification and completion were both lost stays only in Records (the Execution then recovers as a failure). */
    observeQuestion?(input: { workId: string; executionId: string; invocationId: string }): Promise<QuestionObservation>;

    /** Ticket 29 — Q6 `observe`, usage facet: model usage entries of ONE preserved session (Builder `ref`+`sha256`, or a reviewer's recorded
     * session `file`), read-only and confined; absent = usage is `unavailable` (never zero). Not an invoice. */
    observeUsage?(input: { workId: string; /** The boot of the Execution the session belongs to (the session must lie in its runtime tree). */ boot: string | null;
      /** Ticket 30: `copy` = the Work's Records session copy `sessions/<name>.jsonl`, verified against `sha256`. */
      session: { ref: string; sha256: string } | { file: string } | { copy: { workId: string; name: string; sha256: string } } |
        /** Acceptance finding A7: the session a Builder invocation left in `boot` without returning it (a lost boot); read unverified. */
        { invocation: { executionId: string; invocationId: string } } }): Promise<UsageObservation> };
  /** Ticket 29 — `Records.read(selection)` for inspection: listing of a Work's protected captures and one bounded page of one of them.
   * Absent = logs are `unavailable` (never an empty list). Read-only. */
  records?: RecordsInspectionPort;
  /** Ticket 12: when composed, the Builder hands off for parallel Standards/Spec reviews inside the SAME Execution/Slot/boot.
   * Ticket 13 `rounds.max`: repeated captures per Builder activation (handoffs with treatments/gates plus the Host's closing capture),
   * exemptions (unchanged content, identical commit) and the end-of-Execution verification. Absent = the single ticket 12 round.
   * PRODUCTION COMPOSITION (`composeProductionExecution`) passes `rounds: productionProfile.reviewRounds` (`{ max: 4 }`) so findings and
   * gates are treated without a new Execution. */
  reviews?: { reviewer: Pick<Invocation, 'modelBudget' | 'imageSourceMaxBytes'>; rounds?: { max: number };
    /** Ticket 28: partial review recovery — a failed reviewer (known cessation, transient failure, unchanged proposal) is re-obtained alone
     * under the same round, drawing on the Work's `recoveries` counter with the persisted 5/15/45 s waits; a lost notification is recovered
     * from the reviewer's complete protected record; a recovery Execution carries the valid opinions of its interrupted round when the
     * proposal identity and context are unchanged. Absent = tickets 12/13 behaviour (no reviewer retry). Production composes it. */
    partialRecovery?: boolean };
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
  /** Ticket 17: removal of OWN environments and preservation of their evidence after a confirmed delivery. Absent = no environment cleanup. */
  cleanup?: CleanupPorts;
};
export type CredentialWithdrawal = 'ended' | 'external-wait' | 'cancelled' | 'held' | 'refused' | 'owner-stopped' | 'controller-restart' | 'timeout' | 'delivered';
/**
 * One budget counter of a Work (spec §4.4): the limit captured from the repository configuration at admission, explicit grants, the
 * consumptions (each one confirmed start) and the single Execution holding an atomic reservation (null when none).
 */
export type BudgetCounter = { limit: number; granted: number; consumed: number; reserved: string | null };
/** Explicit, auditable grant (spec §4.4/§11.3): never a counter reset; before/after keep the history. */
export type BudgetGrant = { at: string; request_id: string; origin: 'local-cli'; counter: 'corrections' | 'recoveries' | 'continuations'; amount: number;
  before: BudgetCounter; after: BudgetCounter };
/** Corrections and operational recoveries, separate (spec §4.4). Changing the YAML later neither erases exhaustion nor replaces a grant. */
export type WorkBudget = { corrections: BudgetCounter; recoveries: BudgetCounter;
  /** Ticket 48: continuations after a Builder budget end WITH Host-observed progress (5 per Work, grantable); absent on earlier records. */
  continuations?: BudgetCounter;
  source: { kind: 'repository-configuration'; repository: string; recordedAt: string }; grants: BudgetGrant[] };
/**
 * Budget charge of one Execution: `reserved` in the "Admitir Execução" commit, `consumed` once in "Confirmar início", `released` when non-start
 * is proven; an uncertain start keeps `reserved`. `preserved`: a continuation of a correction already charged (question/answer).
 */
export type ExecutionCharge = { kind: 'none' | 'correction' | 'recovery' | 'continuation'; correctionId: string | null; counter: 'corrections' | 'recoveries' | 'continuations' | null;
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
    skillPack: { name: string; manifestSha256: string } | null;
    /** Ticket 44: identity of the environment base this Execution's environment was created from (declaration hash + resolved manifest). */
    environment?: EnvironmentBaseIdentity | null;
    policies: Pick<Invocation, 'skillPack' | 'modelBudget' | 'copyOutput' | 'editSourceMaxBytes' | 'builderBudget'>;
    /** Resumption basis (re-checked in the admission commit): the previous Execution and what authorizes the new activation — its answered
     * Question and/or concrete scope updates. `NEW_BOOT_REPLACEMENT_SESSION` is the ticket-10 record of an answered Question. */
    resume?: { previousExecutionId: string; questionId: string | null; answerSha256: string | null; scopeUpdateIds?: string[];
      reason: 'QUESTION_ANSWERED' | 'SCOPE_UPDATED' | 'NEW_BOOT_REPLACEMENT_SESSION' | 'PUBLICATION_REQUESTED' | 'RECONCILIATION_AUTHORIZED' | 'REPAIR_REQUESTED' } | null;
    /** Ticket 22: the repair of a correction opened by effective impediments of the own PR (its reasons and evidence, revalidated before
     * admission); the Builder's push still happens only in a later publication activation with an explicit lease. */
    repair?: RepairRequest | null;
    /** Ticket 21: a reconciliation Execution incorporating ONE concrete remote divergence the operator authorized (its Question/answer),
     * with the expectation and the authorized remote tip captured BEFORE preparation; never a renewal of scope or budget. */
    reconciliation?: ReconciliationRequest | null;
    /** Ticket 14: a publication activation requested by Control after discovery found no own pull request. It carries exactly the
     * verified commit, the Work's branch/base, the correlation marker and the remote expectation (lease) observed BEFORE preparation. */
    publication?: PublicationRequest | null;
    /** Scope updates bound to this Execution at admission (delivered in its first prompt; `delivered` once its start is confirmed). */
    scopeUpdateIds?: string[];
    /**
     * v2 ticket 06 (Operator decision 1A): set at admission when the sandbox declares no persistent disk. The verified commit exists only in
     * the guest of the boot that produced it, so THIS Execution publishes it in the same boot (a publication activation after the
     * verification) and its grant has write access (purpose `builder-publish`); the Builder Host still refuses every push outside the one
     * leased push of that activation. Absent: the MVP flow (a separate publication Execution on the preserved workspace).
     */
    publishInBoot?: true;
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
  /** `detail` (ticket 50): what the Sandbox said about the refusal (changed identity fields, divergent seed file). */
  held: { code: string; phase: string; at: string; nextStep: string; detail?: string } | null;
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
  /** Ticket 27: ask_user requests the Control REFUSED live (validation, Work not current, stale Execution, conflict): honored at boot (never re-recorded from Records). */
  questionRefusals?: { questionId: string; code: string; at: string }[];
  /** Ticket 41: the Builder request preserved in Records that boot reconciliation found but could not read intact (ticket 27: partial,
   * multiple, unreadable, conflicting) and that blocked this Execution's recovery; `override` is the operator's explicit, audited decision.
   * Acceptance finding A9: also the blocking failure this Execution returned (`cause: 'returned-failure'`). */
  blockedRequest?: BlockedRequestView;
  /** Ticket 51: the operator's explicit, audited decision on this Execution's REVIEWER_RETRY_LIMIT (a new review round, or cancel). */
  reviewRetryLimit?: ReviewRetryLimitDecisionView;
  /** Ticket 50: the boot/preparation refusal that blocked this (never started) Execution's recovery and the operator's explicit retry. */
  blockedStart?: BlockedStartView;
  /** Ticket 26: basis of an Execution that follows an interrupted one (operational recovery or continuation after a clean stop). */
  /** Ticket 48: `BUDGET_CONTINUATION` = the previous Builder ended its budget WITH Host-observed progress (charged to `continuations`). */
  interruption?: { previousExecutionId: string; reason: 'OPERATIONAL_RECOVERY' | 'ADMINISTRATIVE_STOP' | 'BUDGET_CONTINUATION'; code: string } | null;
  /** Ticket 48: the Host's fingerprint of the Work's checkout when this Execution was prepared and, after a budget end, when its boot ceased,
   * with the progress decided from them (never from the model's claim). */
  checkout?: { atStart: CheckoutFingerprint | null; atEnd?: CheckoutFingerprint | null; progress?: BudgetEndProgress | null; guestStop?: string | null };
  /**
   * v2 ticket 06 (Operator decision 2a): without a persistent disk there is no checkout on the host to fingerprint. The tip of the Work
   * branch on `origin` as Control read it before the boot and, after a budget end, after the boot ceased; "progress" is that tip having
   * advanced (the only progress that survives the boot). `startCommit`: the commit Control named to the boot's clone.
   */
  origin?: { atStart: OriginObservation; startCommit: string; atEnd?: OriginObservation | null };
  /**
   * v2 ticket 08 (V2-11): the boot of the last Builder-session activation of this Execution (the implementation session; the gate
   * correction and the in-boot publication are other sessions of the same boot). "The last boot the session saw" of a Work is the newest
   * of these (`lastSessionBoot`); the fixed notice is due when the next activation happens in another boot.
   */
  sessionBoot?: string;
  /** v2 ticket 08 (V2-11, decision 3D): the fixed notice this Execution's first prompt started with, as facts (the text is in the prompt). */
  bootNotice?: BootNoticeRecord;
  /**
   * v2 ticket 06 (Operator decision 1A): the publication activation of THIS Execution, in the boot that verified the content: its own
   * invocation, the verified commit, the lease expectation and how it ended. The attempt is also recorded in the Work's publication.
   */
  inBootPublication?: { invocationId: string; head: string; branch: string; expectedRemote: BranchObservation; pullRequest: number | null; requestedAt: string;
    outcome?: { at: string; status: 'completed' | 'failure' | 'not-started'; code: string | null } };
  /**
   * v2 ticket 07 (V2-05..V2-07): the preservation gate of THIS Execution before it returned control: every check Control made, in order,
   * and the Builder activation each refusal was returned to. Three refusals in a row hold the Execution with the last diagnostic.
   */
  preservationGate?: { occasion: PreservationOccasion; attempts: { at: string; outcome: 'accepted' | 'refused'; code: string | null; detail?: string; commit?: string;
    /** The Builder activation (own invocation, same boot) the refusal was returned to, and how it ended. */
    correction?: { invocationId: string; status?: 'completed' | 'failure' | 'question' | 'not-started'; code?: string | null } }[] };
  /**
   * Final review, must-fix 1 (V2-17): what Control's single check found right before it ended `boot` itself (a failure, a timeout, a stop
   * of the controller). `published`: clean and on `origin` (also in `preservationGate`); `nothing-unpublished`: a clean workspace at the
   * commit the boot cloned; `unpublished`: a loss, with its reason. Read by the reconciliation when the end could not be settled live.
   */
  bootEndCheck?: { at: string; boot: string; outcome: 'published' | 'nothing-unpublished' | 'unpublished'; reason: string | null };
  /** v2 ticket 11 (V2-21): tool calls of this Execution that started and whose result never arrived (the channel dropped), as the sandbox
   * reported them. Their effects may have happened; a substitute session is told of them and never repeats one by assumption (V2-19). */
  indeterminateEffects?: IndeterminateEffectRecord[];
  /**
   * v2 ticket 10 (V2-15): the sandbox confirmed that the environment of this Execution's boot ended on its own while the activation ran.
   * Control then ended the activation (`end.code` = `SANDBOX_ENVIRONMENT_ENDED`). `reason` is what the sandbox reported, as given.
   */
  environmentEnd?: { at: string; boot: string; reason: string | null; terminatedAt: string | null };
  /**
   * v2 ticket 09 (V2-10, V2-13): the planned boot swaps of THIS Execution, in order. A swap keeps the Work, the Execution, the Slot, the
   * timeout clock and the Builder session; only `dispatch.boot` changes (and `invocationId`, the Builder activation that continues the
   * session in the new boot). It never consumes an operational recovery.
   */
  swaps?: BootSwapRecord[];
};
export type BootSwapRecord = { fromBoot: string; dueAt: string;
  /** The Builder activation that yielded for this swap (the working session). */ yieldedInvocationId: string;
  /** Half the margin was reached before the call in flight returned: the sandbox was asked to interrupt it. */ interrupted: boolean;
  /** The swap notice: its own activation of the SAME session in the old boot, recorded before its launch, and how it ended. */
  notice?: { invocationId: string; status?: 'completed' | 'failure' | 'question' | 'not-started'; code?: string | null };
  /** The Builder activation that continues the session in the new boot, recorded before its launch. */
  continuation?: { invocationId: string };
  /** Operator decision 5: the service refused the start of the new boot for capacity; the swap waits and tries again inside the Execution (the latest wait). */
  startWait?: { code: string; detail: string | null; attempt: number; waitSeconds: number; at: string };
  /**
   * `swapped`: gate accepted at `commit`, cessation of `fromBoot` confirmed, `toBoot` started. `lost`: the old boot ended before the gate
   * accepted (the loss path). `blocked`: V2-14. `held`: the gate or the cessation left the Execution held. `failed`: the new boot could
   * not be started or continued (`code`).
   */
  outcome?: { at: string; status: 'swapped' | 'lost' | 'blocked' | 'held' | 'failed'; code: string | null; commit?: string; toBoot?: string } };
/** v2 ticket 06: the Work branch tip on `origin` from Control's own read, or why it is not known. */
/** v2 ticket 07 (V2-05): where the gate applies. `question`: a Question to the human; `ci-wait`: the Execution completed and the waits on
 * GitHub follow (CI, readiness); `planned-swap` (ticket 09) and `substitute-end` (ticket 13) call the same gate. */
/** `boot-end`: the one non-correcting check before Control itself ends a boot outside a return of control (failure, timeout, stop). */
export type PreservationOccasion = 'question' | 'ci-wait' | 'planned-swap' | 'substitute-end' | 'boot-end';
/**
 * v2 ticket 07 (V2-06/V2-08): the last commit the gate confirmed on `origin` for this Work (the guest's `ls-remote` AND Control's own
 * read agreed with the guest's HEAD on a clean workspace). The next boot resumes from it. `heads`: every commit confirmed so far (bounded),
 * the Factory's own history on the Work branch besides its publication attempts.
 */
export type PreservationView = { commit: string; branch: string; confirmedAt: string; executionId: string; boot: string; occasion: PreservationOccasion; heads: string[] };
export type OriginObservation = BranchObservation | { state: 'unknown'; code: string };
/**
 * v2 ticket 09 (V2-10, V2-14): one ended boot of a Work on a sandbox without a persistent disk, as Control recorded it: why it began and
 * ended, and the Work branch tip on `origin` (Control's own reads) when it started and when it ended. `end`: `planned-swap`, `loss`, or
 * `end` for every ordinary return of control.
 */
export type BootLedgerEntry = { boot: string; executionId: string; begin: 'start' | 'planned-swap'; end: 'planned-swap' | 'loss' | 'end';
  startTip: OriginObservation; endTip: OriginObservation; at: string };
/** `commits`: how many commits the notice named as new since `confirmed` (the gate-confirmed commit; null = none was ever confirmed). */
export type BootNoticeRecord = { boot: string; previousBoot: string; startCommit: string; confirmed: string | null; commits: number; restored: string[]; lost: boolean;
  /** v2 ticket 13 (Operator decision 8): the notice said the history of the Work branch changed (`rewritten`) or that the Work restarts from the base (`restarted`). */
  origin?: 'rewritten' | 'restarted' };
/**
 * v2 ticket 13 (Operator decision 8 of 2026-11-21, amending V2-11 where the sandbox keeps no disk): what Control found on `origin` at a
 * resume when the Work branch no longer continues the commit a preservation gate confirmed, and what was decided. `history-rewritten`:
 * the remote is followed by a substitute session on one operational recovery, without a Question. `branch-absent`: an ordinary Question
 * (restart from the base, or end the Work); its answer decides.
 */
export type OriginDivergenceView = { kind: 'history-rewritten'; at: string; branch: string; confirmed: string; current: string; executionId: string } |
  { kind: 'branch-absent'; at: string; branch: string; confirmed: string; questionId: string; executionId: string;
    state: 'awaiting-answer' | 'restart-authorized' | 'end-authorized' | 'not-authorized'; resolvedAt: string | null };
/**
 * v2 ticket 12 (V2-17): one environment of this Work that died before its work was published, as Control recorded it when the sandbox
 * confirmed the end. Whatever the guest held that was not on the Work branch of `origin` is gone; nothing here says it was recovered.
 * A substitute session (ticket 13) reads this; the old session is evidence and is never continued.
 */
export type LossRecord = { at: string; executionId: string; boot: string; environment: string | null;
  /**
   * v2 ticket 13 (Operator decision 7 of 2026-11-21, amending V2-07): absent = the environment died on its own. `preservation-gate-refused`:
   * Control ended the boot itself because the preservation gate did not accept what the guest held (`reason` carries the last diagnostic).
   * `ended-unpublished`: Control ended the boot for another reason (a failure, a timeout, a stop of the controller; `reason` says which)
   * and its one check before the stop did not find the work on `origin`. `not-inspected`: the boot ended while the controller was down;
   * nobody could inspect it, so whatever it held beyond `confirmed` is taken as lost.
   */
  cause?: 'preservation-gate-refused' | 'ended-unpublished' | 'not-inspected';
  /** What the sandbox reported about the end, as given. */ reason: string | null; terminatedAt: string | null;
  /**
   * The last commit of the Work known to be on `origin` at the loss: the Work branch tip by Control's own read made then (`origin-read`),
   * else the last commit a preservation gate confirmed (`preservation-gate`), else none. Everything after it in the guest is lost.
   */
  confirmed: { commit: string | null; source: 'origin-read' | 'preservation-gate' | 'none'; branch: string; origin: OriginObservation };
  /** What the lost activation consumed, as far as Control measures it (MicroVM time of the boot: ticket 14, by `boot`). */
  consumption: { executionMs: number | null };
  /** The Builder session of the lost activation: kept where it was recorded, as evidence; no later activation continues it. */
  session: { invocationId: string; disposition: 'conserved-as-evidence' };
  /**
   * The loss marker ref (V2-16) by Control's OWN read of `origin`, never the guest's word. `present`: the terminate hook pushed the
   * committed HEAD there (`commit`), for a substitute to reuse instead of redoing; it is NOT preservation and satisfies no gate.
   * `absent`: a complete read found none. `unknown`: the read did not conclude.
   */
  marker: { ref: string; state: 'present'; commit: string; observedAt: string } | { ref: string; state: 'absent'; observedAt: string } | { ref: string | null; state: 'unknown'; code: string } };
/** One indeterminate effect as Control keeps it: the sandbox's report plus the boot it ran in and when Control recorded it. */
export type IndeterminateEffectRecord = IndeterminateEffect & { boot: string; recordedAt: string };
/** Remote tip of the Work's own branch as observed by a complete read (`absent` = no such ref). */
export type BranchObservation = { state: 'absent' } | { state: 'present'; sha: string };
/** What one publication activation may publish (spec §9.1): fixed by Control, never chosen by the model. */
export type PublicationRequest = { basisExecutionId: string; head: string; branch: string; base: string; marker: string; expectedRemote: BranchObservation;
  /** An update of the Work's own pull request (a later verified basis): its number; null = create ONE draft pull request. */
  pullRequest?: number | null };
/**
 * Ticket 21 (spec §10.1): what a reconciliation Execution may do. `authorizedRemote` is the remote tip of the divergence the answer
 * authorized: it must stay an ancestor of the new head (the capture checks it) and is the ONLY lease the next publication may use.
 * `strategy`: rebase of the Factory's own commits onto it by default, unless the repository's AGENTS documents another update strategy.
 */
export type ReconciliationRequest = { divergenceId: string; questionId: string; answerSha256: string; expected: BranchObservation; authorizedRemote: string;
  localHead: string; strategy: 'rebase-unless-agents-documents-another' };
/** One commit of a divergence as GitHub's comparison reports it (author when GitHub links it to an account; otherwise unproven). */
export type DivergenceCommit = { sha: string; author: { login: string; id: number } | null; authorName: string | null; subject: string };
/** Comparison of the Factory-known tip with the current remote tip of the own branch (`unknown`: differences not established). */
export type DivergenceComparison = { state: 'complete'; from: string; to: string; status: string; aheadBy: number; behindBy: number; commits: DivergenceCommit[];
  files: string[]; truncated: boolean } | { state: 'unknown'; code: string };
/**
 * Ticket 21 (spec §10.1): a remote change of the Work's own branch NOT attributable to the Factory (or a failed lease), presented to the
 * operator as a Question: identities, the known/current/local refs, differences, provable authorship, uncertainties and the proposal.
 * It blocks the next write. `authorized`/`discard-authorized`: the answer authorized exactly THIS divergence; `not-authorized`: the answer was
 * not an authorization (a new evaluation asks again); `superseded`: the remote changed again before the publication (new divergence).
 */
export type DivergenceView = { divergenceId: string; detectedAt: string; trigger: 'update' | 'lease-failed' | 'after-publication';
  repository: string; branch: string; base: string; pullRequest: { number: number; url: string } | null;
  expected: BranchObservation; current: string; local: string | null; comparison: DivergenceComparison; uncertainties: string[];
  proposal: 'incorporate';
  /** `lost` (review HIGH): the Factory's own head does NOT preserve a commit someone else pushed (`current` = that commit). */
  kind?: 'change' | 'lost';
  questionId: string; state: 'awaiting-answer' | 'authorized' | 'discard-authorized' | 'not-authorized' | 'superseded' | 'resolved';
  resolvedAt: string | null; answer: { sha256: string; author: string; decision: 'incorporate' | 'discard' | 'not-authorized'; code: string | null } | null };
/** Ticket 21: the authorization in force for the publication (one concrete divergence), consumed when the reconciled head is linked. */
export type ReconciliationView = { divergenceId: string; questionId: string; answerSha256: string; mode: 'incorporate' | 'discard'; authorizedRemote: string;
  expected: BranchObservation; authorizedAt: string; author: string; state: 'authorized' | 'executing' | 'consumed' | 'superseded' | 'failed'; executionId: string | null;
  /** `failed`: why the reconciliation produced nothing publishable (the branch is evaluated again and a new Question asked). */
  failure?: string[] | null };
/** Pinned GitHub identity of the Factory App's bot user (from GET /app and the bot user), the only author an own PR may have. */
export type FactoryAppIdentity = { login: string; id: number };
/** The Work's own pull request, recognized by correlation (marker, App bot author, own branch/repository/base); never adopted otherwise. */
export type OwnPullRequest = { pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean; draft: boolean;
  headRef: string; headSha: string; base: string; author: { id: number; login: string; type: string }; linkedAt: string; bodySha256: string | null };
/** One discovery (safe read) of the own publication: Git remote ref + pull requests of the repository correlated to the Work. */
export type PublicationDiscovery = { at: string; observedAt: string | null; trigger: 'verified' | 'after-publication' | 'reconciliation';
  outcome: 'linked' | 'absent' | 'held' | 'incomplete' | 'blocked' | 'diverged' | 'base-changed'; reasons: string[]; branch: BranchObservation | { state: 'unknown'; code: string };
  candidates: { number: number; url: string; own: boolean; reasons: string[] }[] };
/**
 * Publication dimension of a Work (spec §3.3/§9.1, ticket 14). `not-publishable`: the basis Execution's content is not verified (its
 * reasons; nothing is requested); `awaiting-discovery`: the next safe read decides; `requested`: discovery found nothing and a publication
 * activation of the Builder is queued; `published`: the own draft PR is linked (opening never ends the Ticket/Work); `blocked`: repeating or
 * linking would be unsafe (unknown PR/change, several candidates, outcome not confirmed after an attempt...), explicit operator decision.
 */
export type PublicationView = {
  /** Ticket 21: `diverged` = a remote change not attributable to the Factory waits for the operator's answer (Question); `reconciling` = the
   * answer authorized incorporating it and a reconciliation Execution is queued/running; `base-changed` = the own PR's base was changed by
   * someone else: nothing continues until the base is restored (re-read each cycle). */
  state: 'not-publishable' | 'awaiting-discovery' | 'requested' | 'published' | 'blocked' | 'diverged' | 'reconciling' | 'base-changed';
  basisExecutionId: string; marker: string; branch: string; base: string;
  /** The content the end-of-Execution verification (ticket 13) established: the only commit a publication may carry. */
  verified: { executionId: string; head: string; contentSha256: string; verifiedAt: string | null; reviewedRound: number | null;
    gates: { id: string; outcome: string }[]; requiredChecks: string[] } | null;
  /** Lease expectation observed BEFORE the publication activation and given to it (preserved, never recaptured as a new lease). */
  expectedRemote: BranchObservation | null;
  requestedAt: string | null;
  pullRequest: OwnPullRequest | null;
  /** Shape check of the linked PR description (short summary/validation/risk, marker, Ticket link, no transcript or local link). */
  description: { conformant: boolean; reasons: string[] } | null;
  discoveries: PublicationDiscovery[];
  reasons: string[]; nextStep: string | null; updatedAt: string;
  /** Publication activations recorded at their ACTIVATION commit (before any launch), bound to the verified head they carried. An attempted
   * head is never requested again; a later verified basis (another head) may update the same own PR. */
  attempts?: { executionId: string; head: string; at: string; expectedRemote?: BranchObservation }[];
  /** Heads the Factory linked as its own PR head (the remote tip an update may lease against). */
  linkedHeads?: string[];
  /** Branch/tag tips of the repository observed by the complete read that requested the publication: any other ref that changes during
   * the publication window blocks (Contents W is repository-wide; the own-branch rule is enforced by observation, not by the token). */
  refsBefore?: Record<string, string> | null;
  /** The own PR a requested publication updates (a later verified basis); null = create. */
  update?: number | null;
  /** Ticket 21: divergences of the own branch presented to the operator (latest last, bounded) and the authorization in force. */
  divergences?: DivergenceView[];
  reconciliation?: ReconciliationView | null;
  /** Ticket 21: the own PR's base observed changed (from the Work's base), until restored. */
  baseChange?: { from: string; to: string; observedAt: string; pullRequest: number } | null;
  /** Review HIGH: commits pushed by others whose loss the operator explicitly authorized (`discard <tip>`): no longer required at linking. */
  waived?: string[];
  /** Ticket 61: the latest operator re-evaluation of a block (`reevaluate-publication`). `pending`: the next discovery pass re-reads the remote
   * and re-applies the rule to `refsBefore`; `accepted`: the block lifted with the decision `outcome` (acceptance A6: `null` when the request itself returned a
   * live-basis block to the ordinary discovery, which then decides); `still-blocked`: `reasons` remain. */
  reevaluation?: { request_id: string; reason: string; requestedAt: string; state: 'pending' | 'accepted' | 'still-blocked'; settledAt: string | null;
    outcome: PublicationDiscovery['outcome'] | null; reasons: string[] } | null;
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
  /** How the end of this reviewer's activity is known: its completion was received, it never launched, or it is unconfirmed (round held).
   * `boot-ceased` (ticket 26): the Execution was interrupted mid round; the host confirmed the cessation of the shared boot (no survivor). */
  cessation: 'completion-observed' | 'never-started' | 'unconfirmed' | 'boot-ceased' | null;
  input: { required: string[]; missing: string[] } } & ReviewerRecoveryView;
/**
 * Ticket 28 partial review recovery (spec §5.6/§6.4; absent on earlier records = attempt 1, opinion by notification, no retry).
 * `attempt`/`attempts`: the current attempt of this role in this round and the earlier ones that failed with KNOWN cessation (oldest first).
 * `source`: how the effective opinion reached Control — its completion notification, discovery of its complete protected record (lost
 * notification), or `carried` from the interrupted round of the previous Execution with the SAME proposal identity and context.
 * `charge`: before ticket 57 a retry drew ONE unit of the Work's `recoveries` counter (reserved at the retry intent, consumed with the
 * reviewer's confirmed start, released on a proven non-start); such records are still settled. Since ticket 57 a retry records `null`: it
 * is bounded by the round's own limit (`maxReviewerRetries`) and charges nothing to the Work. `retry`: the persisted wait before that attempt.
 * `notRetried`: why a failure stays a failure (explicit; never zero findings).
 */
export type ReviewerRecoveryView = {
  attempt?: number;
  attempts?: ReviewerAttemptView[];
  source?: 'notification' | 'records-discovery' | 'carried';
  carried?: CarriedOpinionView | null;
  charge?: ReviewerCharge | null;
  retry?: { requestedAt: string; waitSeconds: number; notBefore: string; after: string } | null;
  notRetried?: { code: string; at: string } | null;
};
export type ReviewerAttemptView = { attempt: number; invocationId: string; promptSha256: string; state: ReviewerView['state']; receiptId: string | null;
  requestedAt: string; endedAt: string | null; failure: { code: string } | null; cessation: ReviewerView['cessation'];
  opinion: { reference: { workId: string; id: string }; conclusion: ReviewOpinion['conclusion']; code: string | null } | null;
  charge: ReviewerCharge | null };
export type ReviewerCharge = { counter: 'recoveries'; state: 'reserved' | 'consumed' | 'released'; settledAt: string | null };
/** Provenance of an opinion carried into a recovery Execution's round: the source round's identity, and whether it was found in Records. */
export type CarriedOpinionView = { executionId: string; round: number; attempt: number; invocationId: string; indexSha256: string; contentSha256: string;
  discovered: boolean };
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
  questionId: string; workId: string; executionId: string; invocationId: string; recordedAt: string;
  /** `controller-divergence` (ticket 21): asked by Control itself about a concrete remote divergence (no worker; `executionId` is the basis). */
  /** `records-recovery` (ticket 27): the complete request the worker preserved, recovered from Records at boot after its notification/ACK was lost. */
  recordedFrom: 'worker-notification' | 'worker-completion' | 'controller-divergence' | 'records-recovery';
  content: { question: string; context: string; sha256: string; reference: { workId: string; id: string } };
  destination: { kind: 'issue'; ticket: TicketRef };
  state: 'open' | 'answered';
  /** Ticket 27: `unconfirmed` = a possibly sent POST whose complete discovery found nothing (never reposted automatically; discovered again). */
  publication: { effectId: string; state: 'intended' | 'attempting' | 'published' | 'ambiguous' | 'unconfirmed' | 'failed' | 'conflict'; updatedAt: string;
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

/**
 * Ticket 44: the Work's environment declaration (`.factory/environment.yaml` at the base commit). Only `pinned` lets the Work start; it is
 * read once and never re-read (a later change of the file affects later Works only). The other states keep an impediment and are re-read.
 */
export type WorkEnvironment = { state: 'not-evaluated'; since: string; code: string | null } |
  { state: 'not-declared'; commit: string; observedAt: string } |
  { state: 'invalid'; commit: string; sha256: string | null; errors: EnvironmentDeclarationError[]; observedAt: string } |
  { state: 'pinned'; pin: PinnedEnvironment; pinnedAt: string; observedAt: string };
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
/**
 * Ticket 22: one EFFECTIVE impediment of the own PR the Builder can repair, with the head/base it was observed on and its evidence. Never a
 * pending/unknown/optional/old result, a base advancing, an operational cause or a base rule that needs the operator.
 */
export type RepairReason = { code: 'MERGE_CONFLICT' | 'REQUIRED_CHECK_FAILED' | 'STRICT_UPDATE_REQUIRED' | HumanFeedbackCode; subject: string | null; headSha: string; baseTip: string | null;
  observedAt: string; evidence: string[];
  /** Ticket 23: the human request this reason carries (identity, origin, version and content), for human codes only. */
  feedback?: HumanFeedback };
/** Ticket 23 (spec §10): human triggers — an authorized operator's `CHANGES_REQUESTED` review and an explicit authorized repair request. */
export type HumanFeedbackCode = 'HUMAN_CHANGES_REQUESTED' | 'EXPLICIT_REPAIR';
/** Identity/origin/version and relevant content of ONE human request, preserved as recorded (never rebuilt from a cursor or a transcript). */
export type HumanFeedback = { feedbackId: string; origin: 'github-review' | 'github-comment' | 'local-cli';
  author: { login: string; id: number | null } | null; url: string | null;
  /** The commit the review was submitted on, or the Factory head the request was recorded at (data; a push never removes the request). */
  version: string | null; submittedAt: string; sha256: string; content: string;
  /** Inline review comments of the review (bounded), as GitHub reported them. */
  comments: { path: string; line: number | null; body: string; url: string | null }[] };
/** Ticket 23: one human request recorded on the Work (single durable entry for reviews, comments and CLI repairs). `pending`: not yet in a
 * correction; `in-correction`: part of `correctionId`; `treated`: its charged correction closed (`outcome`); `withdrawn`: a later approval or
 * a dismissal removed the review's trigger before it was treated (independent requests are kept). */
export type FeedbackRequest = { feedbackId: string; code: HumanFeedbackCode; feedback: HumanFeedback; recordedAt: string; recordedHead: string | null;
  state: 'pending' | 'in-correction' | 'treated' | 'withdrawn'; correctionId: string | null; closedAt: string | null; outcome: string | null };
/** Ticket 23: the Work's human feedback (bounded): requests, the PR conversation cursor and a summary of what was ignored (never authority). */
export type FeedbackView = { requests: FeedbackRequest[]; pullRequestCursor: number | null; observedAt: string | null;
  ignored: { at: string; origin: string; code: string }[];
  /** Identities ever settled (treated/withdrawn), bounded: a still-live review whose record was evicted is never recorded (and charged) again. */
  settled?: string[];
  /** Non-blocking note: pending requests wait for a published own PR (they fold into a correction on the next published basis). */
  waiting?: { since: string; nextStep: string } | null;
  /** Ticket 23: replies to `/factory` commands, published on the Ticket by the controller (intent → attempt → observation; discovery after doubt). */
  replies?: FeedbackReply[] };
export type FeedbackReply = { replyId: string; request_id: string; source: { commentId: number; url: string }; body: string; recordedAt: string;
  publication: { effectId: string; state: 'intended' | 'attempting' | 'published' | 'ambiguous' | 'failed'; failures: number; comment: { commentId: number; url: string } | null;
    code: string | null; updatedAt: string } };
/** The correction under way (identity kept across its activations, charged once at its confirmed start). Ticket 22 fields are absent on
 * corrections opened before it (seams of ticket 19). */
export type WorkCorrection = { correctionId: string; reason: string; openedAt: string; consumed: boolean;
  trigger?: 'effective-impediment' | 'human-feedback' | 'internal'; sequence?: number; reasons?: RepairReason[]; headSha?: string | null; basisExecutionId?: string | null;
  /** Reasons observed AFTER the charge: not yet delivered to a Builder, never counted as treated; the next activation of this correction
   * (Question resume, recovery) delivers them, otherwise they are evaluated again after closure. */
  pendingReasons?: RepairReason[];
  /** Whether the Work was already pending for another cause when the correction opened (a withdrawal restores it). */
  queueWasPending?: boolean;
  /** What happens next for this correction (strict: every base advance costs a correction from the budget). */
  nextStep?: string;
  /** Ticket 23: the CHARGED correction is activated again (same identity/charge) for human requests that entered it during its activity and
   * that none of its Executions received yet. */
  continuing?: boolean;
  /** Ticket 23: the published basis a continuation was already requested for (one continuation per new basis, never per polling cycle). */
  continuedBasis?: string | null };
export type ClosedCorrection = { correctionId: string; sequence: number | null; openedAt: string; closedAt: string; charged: boolean;
  outcome: 'published' | 'not-publishable' | 'publication-blocked' | 'publication-diverged' | 'publication-base-changed' | 'withdrawn' | 'superseded';
  reasons: RepairReason[]; head: string | null; basisExecutionId: string | null };
export type RepairRequest = { correctionId: string; reasons: RepairReason[]; headSha: string; baseTip: string | null;
  /** Supervisor decision (ticket 22): non-own tips incorporated on the branch (ticket 21). Present = the base is MERGED into the branch (never a
   * rebase that rewrites them) and the Host capture must prove the latest one is an ancestor of the new head. */
  humanTips?: string[] };
/** Orthogonal dimensions of one Work (spec §3.3): result, authorization, queue, impediments, execution, publication. */
/** Semantic state of one current result (spec §9.2 table): check-run and commit-status semantics are distinct. */
export type CheckClassification = 'satisfied' | 'waiting' | 'failed' | 'operational' | 'uncertain';
/** One current (or other-origin/other-SHA) result as GitHub reported it, with its attempt among same-name runs of its check suite. */
export type CheckResultView = { kind: 'check-run' | 'status'; id: number; name: string; sha: string; origin: string; status: string; conclusion: string | null;
  classification: CheckClassification; attempt: { suite: number | null; superseded: number } | null; url: string | null };
/** A requirement GitHub enforces for merging into the base: context + integration, accumulated from every source, with its pertinent SHA. */
export type CheckRequirementView = { context: string; integrationId: number | null; sources: string[]; strict: boolean; sha: string;
  state: CheckClassification | 'indeterminate'; results: CheckResultView[]; otherOrigin: CheckResultView[]; reasons: string[] };
/** An independent reason: `wait` (CI, no Slot), `repair` (pertinent failure), `operational`/`uncertain` (no Builder by guessing),
 * `indeterminate` (unknown/partial/unsupported), `ownership`, `strict`, `closed`, `merge` (ticket 39: a base rule blocks the human merge for
 * anyone without bypass; the operator adjusts the protection). Several coexist; none erases another. */
export type CheckReason = { category: 'wait' | 'repair' | 'operational' | 'uncertain' | 'indeterminate' | 'ownership' | 'strict' | 'closed' | 'merge'; code: string; subject?: string };
/**
 * Ticket 39: how one active base rule was interpreted, with its source and reason. `merge`: whether it blocks a human merge of the PR for anyone
 * without bypass (`blocking`), does not affect it, belongs to the human review stage, is a required-checks requirement (ticket 15) or is
 * unknown (indeterminate, never ready). `merge`/`reason`/`notes` are absent in explanations recorded before ticket 39.
 */
export type ModalityView = { type: string; source: string; interpretation: 'required-checks' | 'not-check-related' | 'human-stage' | 'merge-blocking' | 'unsupported';
  merge?: 'blocking' | 'not-blocking' | 'human-stage' | 'checks' | 'unknown'; reason?: string; notes?: string[] };
/**
 * Ticket 15 (spec §9.2): explanation of the required checks of the own PR's current head at one instant. Not readiness (ticket 16), not
 * a repair trigger (ticket 22) and not a snapshot: separate reads between `observedAt` and `completedAt`, each with its completeness.
 * `satisfied` only with complete reads, every requirement satisfied and no other reason.
 */
export type ChecksEvaluation = {
  at: string; observedAt: string | null; completedAt: string | null;
  outcome: 'satisfied' | 'waiting' | 'failing' | 'blocked' | 'indeterminate' | 'not-applicable';
  reasons: CheckReason[];
  pullRequest: { number: number; url: string | null; headSha: string | null; headRef: string | null; baseRef: string | null; baseTip: string | null;
    mergeCommitSha: string | null; state: 'open' | 'closed' | null; merged: boolean | null; draft: boolean | null } ;
  /** GitHub mergeability: confirmed conflict, none, or unknown (still computing / unreadable). Not a checks reason by itself. */
  conflict: 'none' | 'conflict' | 'unknown';
  strict: { required: boolean; sources: string[]; state: 'not-required' | 'up-to-date' | 'behind' | 'unknown'; behindBy: number | null };
  requiredSet: 'empty-complete' | 'non-empty' | 'unknown';
  requirements: CheckRequirementView[];
  /** Current results no requirement names: visible only, never a repair by themselves (bounded). */
  optional: CheckResultView[];
  /** Results reported for another commit than the current head (never borrowed). */
  otherSha: CheckResultView[];
  /** Every active rule of the base and how it was interpreted; `unsupported` or an unknown merge impact makes the evaluation indeterminate,
   * a `merge-blocking` rule makes it blocked (ticket 39). */
  modalities: ModalityView[];
  completeness: Record<'pullRequest' | 'baseTip' | 'classic' | 'rules' | 'checkRuns' | 'statuses' | 'comparison' | 'recheck', string>;
  /** Local gates the Builder declared as GitHub required checks (ticket 13) versus what GitHub requires; a GitHub result never proves a local gate. */
  localGates: { declared: string[]; requiredByGitHub: string[]; notRequiredByGitHub: string[] };
  notes: string[]; nextStep: string; limitations: string[];
};
/** Latest explanation and a bounded history of earlier ones (old heads stay visible as history, never as current evidence). */
export type ChecksView = { latest: ChecksEvaluation; history: { at: string; headSha: string | null; outcome: ChecksEvaluation['outcome']; reasons: string[] }[] };
/**
 * Ticket 16 (spec §3.3/§9.3): one independent reason why readiness is not established. `confirmed`: the condition is known lost or unmet
 * (the Factory restores draft when it placed ready); `uncertain`: transient, incomplete or unknown (internal confirmation withdrawn, flag kept).
 */
export type ReadinessReason = { area: 'ownership' | 'publication' | 'content' | 'checks' | 'conflict' | 'merge' | 'impediment' | 'dependencies' | 'concurrency' | 'installation' | 'closed';
  certainty: 'confirmed' | 'uncertain'; code: string; subject?: string };
/** The correlated external facts one evaluation used. A change of identity/head/base/requirements before a conversion invalidates it. */
export type ReadinessBasis = { pullRequest: number; nodeId: string; headSha: string | null; baseRef: string | null; baseTip: string | null; strict: boolean;
  requirements: string | null; verifiedHead: string | null; contentSha256: string | null; checksAt: string | null; checksOutcome: ChecksEvaluation['outcome'] | null;
  draft: boolean | null };
/** `recheck`: computed from the fresh complete read taken immediately before a conversion; `recorded`: from the latest recorded explanation. */
export type ReadinessEvaluation = { at: string; source: 'recorded' | 'recheck'; decision: 'ready' | 'not-ready' | 'unknown'; reasons: ReadinessReason[];
  basis: ReadinessBasis; notes: string[] };
/**
 * One draft/ready conversion, a Factory (controller) effect: intent committed BEFORE the remote mutation, the attempt outside any commit, an
 * independent observation (discovery) and the durable confirmation. Never repeated implicitly: a `not-applied` conversion of the same basis
 * needs an operator authorization (or a new basis).
 */
export type ReadinessEffect = { effectId: string; action: 'mark-ready' | 'convert-to-draft'; reason: string; basis: ReadinessBasis; intendedAt: string;
  state: 'intended' | 'attempted' | 'confirmed' | 'not-applied';
  /** The operator authorization this conversion consumed (request id), if any. */
  authorization: string | null;
  /** Committed right before the mutation is started: an `intended` conversion WITHOUT it provably never reached GitHub (no grant, no request). */
  sendingAt?: string | null;
  /** `headSha`: the head GitHub's mutation response reported (headRefOid). */
  attempt: { at: string; outcome: 'applied' | 'known-failure' | 'unknown'; code: string | null; revocation: string; headSha?: string | null } | null;
  observation: { at: string; draft: boolean | null; headSha: string | null; code: string | null } | null; settledAt: string | null;
  /** Independent reads contradicting an APPLIED mutation response (lag), before the response is taken as the evidence. */
  contradictions?: number;
  /** Settled as not applied because it provably never reached GitHub (crash/abort after the intent, before sending). */
  neverSent?: boolean;
  /** The head the flag was changed on differs from the evaluated head (a push between the recheck and the mutation). */
  headMismatch?: { evaluated: string | null; observed: string | null } | null };
/**
 * Ticket 16: readiness dimension of a Work's own PR. Internal readiness (`internal`), the GitHub draft/ready flag (`flag`), human review and
 * delivery are distinct: a ready flag alone never certifies readiness; human review/approval and merge are never performed by the Factory.
 */
export type ReadinessView = {
  internal: 'ready' | 'not-ready' | 'unknown'; since: string;
  latest: ReadinessEvaluation;
  /** The flag the Factory itself established (`publication`: the draft it published; `readiness-effect`: a confirmed conversion;
   * `operator-authorized`: an unexpected human draft the operator authorized to restore), and the flag last observed on GitHub. */
  flag: { factory: 'draft' | 'ready'; origin: 'publication' | 'readiness-effect' | 'operator-authorized'; at: string; observed: 'draft' | 'ready' | 'unknown'; observedAt: string | null };
  /** Draft observed while the Factory had placed ready (not its own effect): respected; restoring it needs an operator authorization. */
  humanDraft: { observedAt: string; headSha: string | null } | null;
  /** Ready observed while the Factory had it as draft: visible only, never a certification nor a flag the Factory reverts. */
  humanReady: { observedAt: string } | null;
  /** One operator authorization, bound to the occurrence it answers (that human draft, or that not-applied conversion) and consumed once. */
  authorization: { request_id: string; at: string; reason: string; purpose: 'human-draft' | 'repeat-conversion';
    binding: { kind: 'human-draft'; pullRequest: number; headSha: string | null; observedAt: string } | { kind: 'not-applied'; effectId: string } } | null;
  effect: ReadinessEffect | null;
  /** Earlier settled conversions, oldest first (bounded). */
  effects: ReadinessEffect[];
  /** Presentation of the separate stages (spec §3.3): never merged into one status. */
  stages: { internal: 'ready' | 'not-ready' | 'unknown'; flag: 'draft' | 'ready' | 'unknown'; humanReview: 'human-stage'; delivery: 'not-delivered' };
  nextStep: string;
};
export type WorkView = {
  work_id: string; cycle: number; predecessor: string | null;
  ticket: TicketRef; repository: { repository: string; repositoryId: number; base: string };
  /** `delivered` (ticket 17): a human merged the Work's own pull request and the Factory confirmed it; no new agent action follows.
   * Ticket 25: `cancelled` (operator cancel; a later confirmed merge still delivers), `closed-unmerged` (own PR closed without merge: the cycle
   * stays current and undelivered with its counters; continuing needs `reopen` + `resume`, abandoning needs `cancel` + `new`). */
  result: 'open' | 'cancelled' | 'closed-unmerged' | 'delivered';
  authorization: { state: 'authorized' | 'withdrawn'; source: 'github-rest'; observedAt: string;
    basis: { repositoryConfigured: true; issueState: 'open'; label: { id: number; name: string } };
    publication: { observedAt: string; completeness: 'complete'; associatedPullRequests: 0; limitations: string[] };
    tracking: string;
    /** Ticket 25: the latest complete authorization read of the Ticket and an observed withdrawal (label removed / issue closed). */
    lastObservedAt?: string | null;
    withdrawal?: { observedAt: string; codes: string[]; restoredObservedAt: string | null } | null };
  /** Ticket 25 (spec §12.3): the operator's cancellation. `stopping` until every own activity is confirmed ceased (Slot released only then). */
  cancellation?: CancellationView | null;
  /** Ticket 25: own PR closed without merge and the `reopen` effect (intent → attempt → observation → confirmation; never repeated implicitly). */
  closure?: ClosureView | null;
  /** `repair` (ticket 22): an open correction; repairs are selected before normal Works, FIFO by `repairSequence`, without preemption. */
  queue: { category: 'normal' | 'repair'; sequence: number; pending: boolean; repairSequence?: number };
  impediments: Impediment[];
  dependencies: DependencyState;
  dispatch: { state: 'held' | 'eligible' | 'executing'; reasons: string[];
    /** The capacity wait behind `BOOT_CAPACITY_WAIT`, with its cause as the sandbox or its service gave it (Operator decision 5: the cause stays visible). */
    capacityWait?: { code: string; cause: string | null; notBefore: string; waitSeconds: number; attempt: number } };
  execution: ExecutionView | null; branch: string | null;
  /** Ticket 14: the own pull request once discovery linked it (questions then belong to its surface). */
  pullRequest: { number: number; url: string } | null;
  /** Ticket 14 (absent on earlier records): publication of the verified content, its discoveries and the linked own PR. */
  publication?: PublicationView | null;
  /** Ticket 15 (absent on earlier records): explanation of the GitHub required checks of the linked own PR's current head. */
  checks?: ChecksView | null;
  /** Ticket 16 (absent on earlier records): internal readiness, the draft/ready flag and the conversions of the own PR. */
  readiness?: ReadinessView | null;
  /** Earlier Executions of this Work, oldest first (a recovery Execution replaces `execution`, never erasing its predecessor). */
  previousExecutions: ExecutionView[];
  /** Question identities of this Work, in recording order. */
  questions: string[];
  /** Last processed comment of the Ticket issue (complete listings only). */
  inputs: { cursor: number | null };
  /** Ticket 19: budget snapshot (null on Works admitted before it, until their next budget commit). */
  budget: WorkBudget | null;
  /** The correction under way (identity kept across its activations); opened by the repair flows (tickets 22/23). */
  correction: WorkCorrection | null;
  /** Ticket 22: closed corrections of this Work, oldest first (bounded): what each treated, how it closed. A repeated event is never charged again. */
  corrections?: ClosedCorrection[];
  /** Ticket 23 (absent on earlier records): human feedback of the own PR/Ticket recorded for the next safe activation of a correction. */
  feedback?: FeedbackView | null;
  /** A pending operational recovery (ticket 26 decides it); consumed by the start of the recovery Execution. */
  /** v2 ticket 07: absent until a preservation gate accepted (only on a sandbox without a persistent disk). */
  preservation?: PreservationView;
  /** v2 ticket 09 (V2-14): the ended boots of this Work, oldest first and bounded, across its Executions (only on a sandbox without a
   * persistent disk). Two consecutive ones ended by a swap or a loss without a new commit on `origin` block the next boot. */
  bootLedger?: BootLedgerEntry[];
  /** v2 ticket 12 (V2-17): environments of this Work lost before publication, oldest first (bounded). Absent: none was recorded. */
  losses?: LossRecord[];
  /** v2 ticket 13 (Operator decision 8): the latest divergence of the Work branch found at a resume, and its decision. */
  originDivergence?: OriginDivergenceView;
  pendingRecovery: { reason: string; requestedAt: string;
  /** Ticket 26: persisted wait (calendar) before the recovery may start, its length and the attempt index it was derived from. */
  notBefore?: string; waitSeconds?: number; attempt?: number; executionId?: string | null;
  /** Ticket 48: a continuation after a budget end with progress (charged to `continuations`, no wait); absent = operational recovery. */
  kind?: 'budget-continuation' } | null;
  /** Ticket 50: persisted capacity wait after a boot/preparation refused for lack of host memory/storage (nothing started, nothing charged). */
  bootDeferral?: { code: string; executionId: string; requestedAt: string; notBefore: string; waitSeconds: number; attempt: number;
    /** v2 (Operator decision 5): the cause the sandbox gave for the refusal, when it gave one (the reason shown for the wait). */ detail?: string | null } | null;
  /** Ticket 50: operator remedy accepted with a retry, applied by the NEXT preparation (recreate the divergent artifact seeds) or, ticket 47, the
   * next boot (repair/replace a preserved disk that fails its check). */
  startRemedy?: { remedy: StartRetryRemedy; request_id: string; executionId: string; at: string; seeds: string[] } | null;
  /** Ticket 44: the environment declaration pinned in this Work (absent = Work admitted before ticket 44: generic guest, never re-evaluated). */
  environment?: WorkEnvironment;
  /** Ticket 44: the operator's retry of a failed/incomplete environment base preparation, consumed by the NEXT preparation only. */
  environmentRetry?: { request_id: string; executionId: string; at: string } | null;
  /** Presentation only (never persisted): limits/reservations/consumption, timeout, duration/last activity and the action required. */
  limits: LimitsView;
  /** Ticket 29, presentation only: this view is a compacted form of the Work (to fit one frame); the counts left out and where to read them. */
  compacted?: { history: number; previousExecutions: number; nextStep: string };
  /** Concrete scope updates authorized by the operator (ticket 11), in acceptance order. Later Ticket/link edits are never one. */
  scopeUpdates?: ScopeUpdateView[];
  /** Ticket 17 (absent on earlier records): observation of the own pull request and the confirmed merge that delivers the Work. */
  delivery?: DeliveryView | null;
  /** Ticket 17: cleanup of the Work's own resources after delivery, shown SEPARATELY from the delivery (a failed cleanup never undoes it).
   * Ticket 30: also the explicit, operator-confirmed environment cleanup of a cancelled Work (`explicit`). */
  cleanup?: CleanupView | null;
  /** Ticket 30 (absent on earlier records): retention of the Work's details (logs, sessions) and the explicit cleanup plans. */
  retention?: RetentionView | null;
  /** Ticket 31: explicit history deletion plans of this Work (once executed, the Work record itself is gone: see `ForgottenWork`). */
  forget?: { plans: ForgetPlan[] } | null;
  /** Ticket 31: ids of this Work's requests whose input carries operator text (answers, scope updates, readiness authorizations), any outcome. */
  contentRequests?: string[];
  admittedAt: string;
  history: ({ at: string; event: 'admitted'; origin: 'github-polling'; sequence: number } |
    { at: string; event: 'dependencies-changed'; origin: 'github-polling'; before: DependencyEvaluation['conclusion'] | null; after: DependencyEvaluation['conclusion']; evaluationId: string } |
    { at: string; event: 'execution-reserved' | 'execution-prepared' | 'execution-booted' | 'activation-requested' | 'execution-started' | 'execution-ended' | 'execution-held' | 'execution-released' | 'slot-released' |
      'review-handoff' | 'reviewer-started' | 'reviewer-ended' | 'review-concluded' | 'review-delivered' | 'review-exempted' | 'review-verified' |
      /* ticket 28 */ 'reviewer-retried' | 'reviewer-not-retried' | 'opinion-discovered' | 'opinion-carried' |
      /* v2 ticket 07 */ 'preservation-accepted' | 'preservation-refused' |
      /* v2 ticket 09 */ 'boot-swap-due' | 'boot-swap-notice' | 'boot-swapped' | 'boot-swap-ended' | 'boot-ended' | 'boot-loop-blocked' | /* v2 ticket 12 */ 'loss-recorded' | /* finding A9 */ 'recovery-blocked' | /* final review */ 'channel-report-unread' |
      /* v2 ticket 13 */ 'origin-rewrite-followed' | 'origin-branch-absent-asked' | 'origin-branch-absent-resolved';
      origin: 'controller-dispatch'; executionId: string; detail?: string } |
    { at: string; event: 'question-recorded' | 'question-published' | 'question-answered' | 'question-refused';
      origin: 'controller-dispatch' | 'controller-publication' | 'github-comment' | 'local-cli' | 'records-recovery';
      questionId: string; detail?: string } |
    { at: string; event: 'budget-reserved' | 'budget-consumed' | 'budget-released' | 'budget-exhausted' | 'budget-granted' | 'correction-opened' | 'correction-reason-added' | 'recovery-requested' |
      /* ticket 48 */ 'continuation-requested' | 'budget-end-observed';
      origin: 'controller-budget' | 'local-cli'; executionId: string | null; detail: string } |
    { at: string; event: 'timeout-reached' | 'duration-reconciled'; origin: 'controller-clock'; executionId: string; detail: string } |
    { at: string; event: 'repair-consolidated' | 'repair-withdrawn' | 'repair-revalidated' | 'repair-repeated' | 'correction-closed' | 'repair-continued'; origin: 'controller-repair';
      correctionId: string | null; detail: string } |
    { at: string; event: 'feedback-recorded' | 'feedback-withdrawn' | 'feedback-treated' | 'repair-requested' | 'resume-requested';
      origin: 'controller-feedback' | 'github-comment' | 'local-cli'; feedbackId: string | null; detail: string } |
    { at: string; event: 'scope-update-accepted' | 'scope-update-delivered' | 'scope-update-reoffered' | 'scope-update-consumed'; origin: 'local-cli' | 'controller-dispatch';
      scopeUpdateId: string; detail?: string } |
    { at: string; event: 'execution-reconciled' | 'recovery-wait-kept'; origin: 'controller-recovery'; executionId: string | null; detail: string } |
    { at: string; event: 'publication-evaluated' | 'publication-requested' | 'publication-started' | 'publication-linked' | 'publication-blocked' | 'publication-discovery-incomplete' |
      /* ticket 21 */ 'publication-diverged' | 'reconciliation-authorized' | 'reconciliation-not-authorized' | 'reconciliation-superseded' | 'publication-base-changed' | 'publication-base-restored' |
      'reconciliation-failed' | /* ticket 61 */ 'publication-reevaluated' | /* acceptance A6 */ 'publication-block-lifted';
      origin: 'controller-publication'; executionId: string | null; detail: string } |
    /** Ticket 61: the operator asked to re-evaluate a blocked publication (`<request id>`). */
    { at: string; event: 'publication-reevaluation-requested'; origin: 'local-cli'; detail: string } |
    { at: string; event: 'checks-evaluated'; origin: 'controller-checks'; detail: string } |
    /* ticket 44 */ { at: string; event: 'environment-evaluated'; origin: 'github-polling' | 'controller-dispatch'; detail: string } |
    { at: string; event: 'readiness-evaluated' | 'readiness-intended' | 'readiness-attempted' | 'readiness-confirmed' | 'readiness-not-applied' | 'readiness-human-flag';
      origin: 'controller-readiness'; detail: string } |
    { at: string; event: 'readiness-authorized'; origin: 'local-cli'; detail: string } |
    { at: string; event: 'delivery-observed' | 'delivery-confirmed' | 'cleanup-evaluated' | 'evidence-preserved' | 'cleanup-intended' | 'cleanup-result';
      origin: 'controller-delivery'; detail: string } |
    { at: string; event: CycleEvent; origin: 'controller-cycles' | 'local-cli' | /* the accepted answer of a Question Control asked */ 'controller-dispatch'; detail: string } |
    /** Ticket 41: correlated with the blocked Execution (ticket 29 `history --execution`). */
    { at: string; event: 'blocked-recovery-overridden'; origin: 'local-cli'; executionId: string; detail: string } |
    /** Ticket 51: the operator's decision on REVIEWER_RETRY_LIMIT (`<request id>:new-review-round` or `<request id>:cancel`). */
    { at: string; event: 'review-retry-limit-decided'; origin: 'local-cli'; executionId: string; detail: string } |
    /** Ticket 50: operator retry of a refused boot/preparation; capacity wait; remedy applied by a preparation (correlated with the Execution). */
    { at: string; event: 'blocked-start-retried'; origin: 'local-cli'; executionId: string; detail: string } |
    { at: string; event: 'boot-deferred' | 'start-remedy-applied'; origin: 'controller-recovery'; executionId: string; detail: string } |
    /** Ticket 47: how the environment's previous boot was stopped (`<boot>:clean|forced:<reason>`), recorded with the next boot. */
    { at: string; event: 'previous-boot-stop'; origin: 'controller-recovery'; executionId: string; detail: string } |
    { at: string; event: RetentionEvent; origin: 'controller-retention' | 'local-cli'; detail: string })[];
};
/** Ticket 50: a boot/preparation refusal that blocks recovery (cessation from the reconciliation) and the operator's explicit, audited retry. */
export type BlockedStartView = { code: string; detail: string | null; at: string; cessation: 'confirmed' | 'unconfirmed';
  retry: { request_id: string; operator: { kind: 'local-administrator' }; at: string; code: string; remedy: StartRetryRemedy | null;
    recoveryRequest: 'requested' | 'already-open' } | null };
/** Ticket 41: a lost Builder request that blocks recovery, and the operator's explicit decision to continue without it. */
export type BlockedRequestView = { reference: string; code: string; questionId: string | null; records: string[]; at: string;
  /** Acceptance finding A9: absent = a lost Builder request (ticket 27). `returned-failure` = the Execution itself returned a failure that is
   * not transient (no request was lost, `records` is empty): the same block, reference and explicit operator override. */
  cause?: 'returned-failure';
  override: { request_id: string; operator: { kind: 'local-administrator' }; at: string; reference: string; recoveryRequest: 'requested' } | null };
/** Ticket 51: the operator's decision on REVIEWER_RETRY_LIMIT. There is no decision that accepts the unverified round. */
export type ReviewRetryLimitDecisionView = { decision: 'new-review-round' | 'cancel'; request_id: string; operator: { kind: 'local-administrator' }; at: string };
/** Ticket 25 history events (cycle, authorization, cancellation, closure/reopen). */
export type CycleEvent = 'authorization-withdrawn' | 'authorization-restored-observed' | 'authorization-confirmed' | 'cancel-requested' | 'cancellation-ceased' |
  'resume-accepted' | 'resume-confirmed' | 'resume-not-confirmed' | 'pull-request-closed-unmerged' | 'reopen-intended' | 'reopen-attempted' | 'reopen-confirmed' |
  'reopen-not-applied' | 'cycle-created' | 'successor-created';
/** Ticket 25: cancellation of a Work (spec §3.4 "Interromper/cancelar": request, prohibitions and stop intent; physical confirmation later). */
export type CancellationView = { request_id: string; requestedAt: string; state: 'stopping' | 'ceased'; ceasedAt: string | null;
  /** The Execution active (or holding a Slot) when the cancellation was accepted, if any. */
  executionId: string | null; nextStep: string };
/** Ticket 25: closure of the own PR without merge and the single reopen effect requested by the operator. */
export type ClosureView = { observedAt: string; pullRequest: number;
  reopen: { effectId: string; request_id: string; intendedAt: string; state: 'intended' | 'attempted' | 'confirmed' | 'not-applied'; sendingAt: string | null;
    attempt: { at: string; outcome: string; code: string | null } | null; observation: { at: string; outcome: string } | null; settledAt: string | null } | null;
  nextStep: string };
export type CounterView = { limit: number; granted: number; effectiveLimit: number; consumed: number; reserved: 0 | 1; reservedBy: string | null; available: number; exhausted: boolean };
/** `elapsedMs` is a monotonic measurement (live or measured) or null; `unknown` is never shown as zero. */
export type DurationView = { state: 'not-recorded' | 'not-started' | 'running' | 'measured' | 'lower-bound' | 'unknown'; elapsedMs: number | null;
  lowerBoundMs: number | null; calendarEstimateMs: number | null; clock: 'controller-monotonic' | null; startedAt: string | null;
  lastActivity: ExecutionTiming['lastActivity']; note: string };
export type LimitsView = { corrections: CounterView | null; recoveries: CounterView | null; continuations: CounterView | null; grants: number;
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
  queues: { normal: string[]; repair: string[] }; works: WorkView[]; selection: Selection; polling: PollingView; limitations: string[];
  /** Ticket 31: Works whose history was deleted, as their minimal memory only. */ forgotten?: ForgottenWork[];
  /** Ticket 29: the page of `works` (queues/selection stay installation-wide). */
  page: PageView };
export type ShowView = { kind: 'work'; work: WorkView; lastPolled: CandidateView | null; questions: QuestionView[];
  /** Ticket 29: the correlated chain and the observations behind it (presentation; the dimensions above stay the authority). */
  chain: ChainView;
  /** Ticket 29: what was left out so the view fits one frame, and the paged commands that show it (null = nothing omitted). */
  omitted: { history: number; previousExecutions: number; questions: number; executions: PageView; nextSteps: string[] } | null } | { kind: 'work-not-found'; work_id: string; nextStep: string } |
  /** Ticket 31: the Work's history was deleted by `forget`; only its minimal cycle memory remains (never "not found", never "expired"). */
  { kind: 'work-forgotten'; work_id: string; memory: ForgottenWork; notRecoverable: string[]; nextStep: string };
export type QuestionQueryView = { kind: 'question'; question: QuestionView } | { kind: 'question-not-found'; question_id: string; nextStep: string } |
  /** Ticket 31: the Question belonged to a Work whose history `forget` deleted (its text and answer are gone, never "not found"). */
  { kind: 'question-forgotten'; question_id: string; work_id: string; nextStep: string };
export type ControlStatus = {
  controller_run_id: string;
  paused: boolean;
  dispatch: 'closed' | 'open';
  dispatchReason: DispatchReason | null;
  slots: { capacity: number; held: number };
  historyLength: number;
  works: { total: number; open: number;
    /** Ticket 25 (absent before it): cancelled Works and own PRs closed without merge, never confused with delivery. */
    cancelled?: number; closedUnmerged?: number };
  /** Ticket 17: delivered Works and their cleanup, counted separately (a pending cleanup never undoes a delivery). */
  delivery: { delivered: number; cleanup: { waiting: number; pending: number; complete: number } };
  /** Ticket 30 (absent before it): detail retention. Undelivered Works keep everything until explicit cleanup (their growth is visible here). */
  retention?: RetentionStatus;
  /** Ticket 31: Works forgotten so far; every other total/aggregate here covers only the Works still remembered (never the whole installation life). */
  forgotten?: { works: number; delivered: number; cancelled: number; note: string;
    /** D-07: forgotten Works whose storage scrub has not completed yet (re-attempted by the owner). */ scrubPending?: number };
  queues: { normal: number; repair: number };
  dependencies: { satisfied: number; pending: number; inconclusive: number; notEvaluated: number };
  questions: { open: number; answered: number; unpublished: number };
  selection: { next: string | null };
  polling: Omit<PollingView, 'repositories'> & { repositories: Omit<RepositoryPollView, 'candidates'>[] };
  persistence: { sqliteVersion: string; sqliteSourceId: string; journalMode: 'wal'; synchronous: 'FULL' };
  /** Ticket 26: boot reconciliation of THIS run (null before it ran or when nothing was composed to reconcile). */
  recovery: RecoveryView | null;
  /** Ticket 33: storage format and how the previous controller run of this storage ended (`crash`: it never recorded an end). */
  storage: { format: number; previousRun: { runId: string; startedAt: string; endedAt?: string; end: 'clean' | 'uncertain' | 'failed' | 'crash' } | null };
  /** Ticket 29 (spec §12.1): impediments of open Works by code, and non-token consumption (tokens/cost: `factory usage`). */
  impediments: { works: number; codes: Record<string, number> };
  consumption: { executions: { total: number; active: number }; corrections: { consumed: number; reserved: number }; recoveries: { consumed: number; reserved: number };
    time: { measuredMs: number; lowerBoundMs: number; unknown: number; measurement: UsageMeasurement }; usage: { query: 'usage' } };
};
export type RecoveryView = { at: string; inventory: 'empty' | 'unknown' | 'listed'; reconciled: number; ceased: number; unconfirmed: number;
  global: string[]; cachePreparing: (number | null)[];
  /** Caches still left in preparation after the owner's repair-free reconciliation, with the explicit operator action. */
  cache: { repositoryId: number | null; state: string; nextStep: string | null }[] };
export interface Control {
  accept(input: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' }>;
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null } | AccessView | ListView | ShowView | QuestionQueryView |
    HistoryView | LogsView | LogPageView | UsageView | { kind: 'work-not-found'; work_id: string; nextStep: string } |
    { kind: 'work-forgotten'; work_id: string; memory: ForgottenWork; notRecoverable: string[]; nextStep: string }>;
  /** `uncertain`: stopped, but some own activity is not confirmed ceased or not durably settled (cessation unconfirmed, Slot held); the next boot reconciles it (ticket 26) and it is never a clean stop (ticket 33). */
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' | 'uncertain' }>;
}

// ---- Ticket 17: confirmed delivery and owned cleanup (spec §12.3) ----
/** Identity of the Work's own pull request as the publication discovery linked it (ticket 14); the only PR whose merge delivers the cycle. */
export type OwnPullRequestIdentity = { pullRequestId: number; nodeId: string; number: number; url: string; headRef: string; base: string;
  /** Heads the Factory itself published/linked as this PR's head (ticket 14 `linkedHeads` + the linked head): the only own content. */
  heads: string[] };
/** One read of the own pull request. `unavailable` concludes nothing (no merge, closure or absence). */
export type MergeObservation = { at: string; observedAt: string | null;
  outcome: 'open' | 'closed-unmerged' | 'merged' | 'identity-mismatch' | 'merge-unconfirmed' | 'unavailable'; reasons: string[] };
/** Confirmed merge facts: what makes the Work delivered (never an issue/PR closure or a Builder message). */
/** `mergeCommitSha`: recorded when GitHub reports it; the merge itself is evidenced by `merged_at` on the closed own PR. */
export type MergeFacts = { mergedAt: string; mergeCommitSha: string | null; headSha: string; pullRequestId: number; number: number; url: string;
  /** Whether GitHub sent `merge_commit_sha` in the read that confirmed the merge (absent on records written before this field). */
  mergeCommitShaReport?: 'value' | 'null' | 'absent' };
export type DeliveryView = {
  state: 'watching' | 'delivered';
  pullRequest: OwnPullRequestIdentity;
  /** Bounded latest observations (identical consecutive outcomes counted once). */
  observations: MergeObservation[];
  /** `duringActivity`: the Execution that was active when the merge was confirmed (it is interrupted; no new action follows). */
  merge: (MergeFacts & { confirmedAt: string; observedAt: string; duringActivity: string | null }) | null;
  /** Last read of the own pull request (any outcome): the desk reads the least recently read Works first (no starvation). */
  lastReadAt?: string | null;
  nextStep: string;
};
/** `lost-markers` (v2 ticket 12): the Work's loss marker refs on `origin` (`refs/factory/lost/<work>/*`); never a branch. */
export type CleanupResourceKind = 'environment' | 'checkout' | 'local-branch' | 'temporaries' | 'remote-branch' | 'lost-markers';
/** `refused`/`kept` are never retried automatically: an operator decides (no fresh write grant is issued for them). */
export type CleanupOutcome = 'removed' | 'absent' | 'partial' | 'failed' | 'refused' | 'kept' | 'indeterminate';
/** Intent recorded BEFORE the effect, result after it; an intent without result (crash) becomes `indeterminate`, never success. */
export type CleanupAttempt = { effectId: string; intentAt: string; resultAt: string | null; outcome: CleanupOutcome | 'intended'; code: string | null };
export type CleanupResourceView = { id: string; kind: CleanupResourceKind; target: string; environment: string | null; ownership: string;
  state: 'pending' | CleanupOutcome; attempts: CleanupAttempt[] };
export type PlannedCleanupResource = Omit<CleanupResourceView, 'state' | 'attempts'>;
/** Evidence of an environment preserved in the protected records area BEFORE it may be removed. */
export type EvidencePreservationView = { environment: string; state: 'preserved' | 'absent' | 'failed'; at: string; code: string | null;
  reference: { workId: string; id: string; manifestSha256: string; files: number; bytes: number } | null };
export type CleanupView = {
  /** `waiting`: not eligible yet (reasons); `pending`: some own resource is not concluded (failed/partial/indeterminate/refused/not tried);
   * `complete`: every planned own resource is removed or proven absent. */
  state: 'waiting' | 'pending' | 'complete';
  eligibility: { eligible: boolean; reasons: string[]; checkedAt: string };
  evidence: EvidencePreservationView[];
  resources: CleanupResourceView[];
  protected: { target: string; reason: string }[];
  sweeps: number; lastSweepAt: string | null;
  /** Ticket 30: an operator-confirmed explicit cleanup plan executed by this resource cleanup: the environment of a cancelled Work, or ONE
   * fresh revalidated attempt of the refused/kept/failed own resources of a delivered Work. `consumed` once swept: never repeated implicitly. */
  explicit?: { request_id: string; planId: string; at: string; consumed: boolean; resources: string[] } | null;
  nextStep: string;
};
export type EvidencePreservation = { status: 'preserved'; reference: NonNullable<EvidencePreservationView['reference']> } | { status: 'absent' } | { status: 'failed'; code: string };
/** Ticket 17 trusted composition ports: Sandbox removal of an OWN environment and Records preservation of its evidence. */
export type CleanupPorts = {
  remove(input: { environment: EnvironmentRef; cleanup: unknown }): Promise<RemoveResult>;
  preserve(input: { workId: string; environment: EnvironmentRef }): Promise<EvidencePreservation>;
  /** Seconds between automatic retries of a pending cleanup (default 86400: daily), besides one sweep at each controller boot. */
  retrySeconds?: number;
  /** Ticket 30: the Work's details (Records logs and preserved sessions). Absent = no detail retention, preservation or removal is composed. */
  details?: DetailPorts;
  /** Ticket 30: days after the confirmed merge when a delivered Work's logs/sessions become eligible (configuration `retentionDays`, default 30). */
  retentionDays?: number;
  /** Ticket 30: seconds between retention sweeps (default 86400: daily), besides the sweep at each controller boot after reconciliation. */
  sweepSeconds?: number;
};

// ---- Ticket 29: correlated inspection and consumption (spec §2.3 `inspect`, §11.3 history/logs, §12.1-12.2) ----
export type InspectionRole = 'builder' | 'standards' | 'spec';
/** Page/filter of a history or logs query. `cursor` is the index of the first item in the FILTERED sequence (stable: history is append-only). */
export type InspectionFilter = { execution?: string | undefined; role?: InspectionRole | undefined; cursor?: number | undefined; limit?: number | undefined };
export type HistoryQuery = { kind: 'history'; work_id: string } & InspectionFilter;
/** Logs page by capture id (`after`, Records-level paging), so a Work with more captures than one listing allows stays listable. */
export type LogsQuery = { kind: 'logs'; work_id: string; execution?: string | undefined; role?: InspectionRole | undefined; after?: string | undefined; limit?: number | undefined };
/** One page of one protected capture (`offset` in bytes). */
export type LogReadQuery = { kind: 'log'; work_id: string; capture: string; offset?: number | undefined; limit?: number | undefined };
/** Installation scope pages the Works by `cursor`/`limit` (bounded); one Work ignores them. */
export type UsageQuery = { kind: 'usage'; work_id?: string | undefined; cursor?: number | undefined; limit?: number | undefined };
/** Presentation of one history entry: its position, what it links to and the role it belongs to (null = Work-level). */
export type HistoryEntryView = { sequence: number; role: InspectionRole | null; executionId: string | null; links: Record<string, string>;
  entry: WorkView['history'][number] };
export type PageView = { cursor: number; limit: number; returned: number; filtered: number; total: number; nextCursor: number | null;
  /** The page was cut to fit one protocol frame: fewer entries than `limit` although more exist (follow `nextCursor`). */
  fitted: boolean };
export type HistoryView = { kind: 'history'; work_id: string; filter: { execution: string | null; role: InspectionRole | null }; page: PageView;
  entries: HistoryEntryView[]; limitations: string[] };
/**
 * State of one piece of evidence as the inspection can establish it (spec §12.1/§12.2): `complete` (intact, fully readable), `truncated`
 * (this page/display is a part, the full content stays available by reference), `partial` (the capture itself is incomplete), `absent`
 * (provably not there under an intact store), `removed` (an own cleanup removed it), `expired` (a retention sweep removed it), `unknown`
 * (it cannot be established: never absence, never zero).
 */
export type EvidenceState = 'complete' | 'truncated' | 'partial' | 'absent' | 'removed' | 'expired' | 'unknown';
export type LogCaptureView = { capture: string; executionId: string; invocationId: string; role: InspectionRole; callId: string; environment: string; boot: string;
  format: 'text' | 'raw'; state: EvidenceState };
export type LogsView = { kind: 'logs'; work_id: string; filter: { execution: string | null; role: InspectionRole | null };
  /** `complete`: every capture of the Work was listed; `incomplete`/`unavailable`: the listing proves nothing about what is missing. */
  listing: { state: 'complete' | 'incomplete' | 'unavailable'; code: string | null; nextStep: string | null;
    /** Ticket 17 preserved-evidence folders in this page's range: protected evidence, never logs (read them as administrator, not through `logs`). */
    preservedEvidence?: number };
  page: { after: string | null; limit: number; returned: number; next: string | null; fitted: boolean }; captures: LogCaptureView[]; limitations: string[] };
export type LogPageView = { kind: 'log'; work_id: string; capture: string; state: EvidenceState; code: string | null;
  /** Filtered text of this page (text captures only; a raw capture's bytes are never displayed). */
  text: string | null; offset: number; nextOffset: number | null; bytes: number | null; nextStep: string | null;
  /** The text is captured tool/command output: untrusted data, never instructions or authority. */
  trust: 'untrusted-captured-output' };
/** Token/cost observation of one role activity. `measurement`: complete (every entry of a readable session), partial (some known gap),
 * unavailable (nothing measurable: never a zero). Numbers are present only when observed. */
export type UsageMeasurement = 'complete' | 'partial' | 'unavailable';
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
/** SDK estimate (spec §12.1): catalog price of the model as the SDK computed it; NOT an invoice; currency only when the SDK reports one. */
export type CostEstimate = { total: number; unit: 'sdk-catalog-estimate'; currency: string | null };
export type UsageObservation = { state: 'read'; sessionId: string; entries: UsageEntryObservation[]; malformed: number; integrity?: 'verified' | 'unverified' } |
  { state: 'lost' | 'unavailable' | 'altered'; code: string };
export type UsageEntryObservation = { id: string; provider: string | null; model: string | null; outcome: 'ok' | 'error' | 'aborted' | 'other';
  tokens: TokenUsage; cost: number | null };
export type UsageActivityView = { executionId: string; role: InspectionRole; round: number | null; attempt: number | null; invocationId: string | null;
  outcome: string | null; session: { sessionId: string | null; mode: string | null; state: EvidenceState };
  models: { provider: string | null; model: string | null }[]; measurement: UsageMeasurement; code: string | null;
  /** Entries of a continued session already counted for an earlier activity (never summed again). */
  carriedEntries: number; entries: number; failedOrAborted: number;
  tokens: TokenUsage | null; cost: CostEstimate | null };
export type UsageAggregate = { measurement: UsageMeasurement; activities: number; measured: number; unavailable: number;
  tokens: TokenUsage | null; cost: CostEstimate | null };
export type WorkUsageView = { work_id: string; ticket: string; activities: UsageActivityView[]; byRole: Record<InspectionRole, UsageAggregate>; total: UsageAggregate;
  /** Non-token consumption (spec §4.4/§5.7): budgets, Executions and their measured durations. */
  budget: { corrections: CounterView | null; recoveries: CounterView | null; continuations?: CounterView | null; grants: number };
  time: { executions: number; measuredMs: number; lowerBoundMs: number; unknown: number; measurement: UsageMeasurement };
  /** v2 ticket 14 (V2-32): present only when the installation's sandbox reports boot usage. Accumulated over every boot of every Execution. */
  boots?: BootConsumptionView };
/**
 * v2 ticket 14 (V2-32): the seconds of the sandbox's boots of one Work, in the sandbox's own `unit`, never restarted between boots or
 * Executions and never a monetary value. `seconds` sums the measured boots only. `lowerBound`: some boot is still running or its final
 * observation was not possible (`running`/`unknown` count them), so the real total is at least `seconds`; such a boot is never counted as
 * zero. `notRun`: starts refused before anything ran (they consumed nothing). `measurement` `unavailable` with `seconds` null: nothing
 * could be measured (`code` says why when the sandbox gave no report). `items`: the latest boots as reported (`omitted` earlier ones).
 */
export type BootConsumptionView = { unit: string | null; seconds: number | null; measured: number; running: number; unknown: number; notRun: number; lowerBound: boolean;
  measurement: UsageMeasurement; code: string | null; omitted: number; items: BootUsage[] };
/** v2 ticket 14 (V2-32): environment base builds per environment key as the sandbox recorded them (`builds`: total over the keys). */
export type EnvironmentBuildsView = { status: 'reported'; builds: number; omitted: number; keys: EnvironmentBuilds[] } | { status: 'unavailable'; code: string };
export type UsageView = { kind: 'usage'; scope: 'installation' | 'work'; at: string; works: WorkUsageView[];
  /** Total of THIS page's Works (the installation total only when the page holds every Work). */ total: UsageAggregate; page: PageView;
  slots: { capacity: number; held: number };
  /** Adapter RAM/CPU/I/O/disk are distinct from tokens/cost and from virtual/free capacity; not observed by this release. */
  resources: { state: 'unavailable'; code: 'ADAPTER_RESOURCE_METRICS_NOT_OBSERVED'; note: string };
  /** v2 ticket 14: installation scope only, and only when the sandbox reports builds. */
  environmentBuilds?: EnvironmentBuildsView;
  limitations: string[] };
/** One external/derived observation behind the view, with its instant, freshness and completeness (spec §12.1). */
export type ObservationView = { source: 'polling' | 'dependencies' | 'checks' | 'readiness' | 'delivery' | 'feedback' | 'publication';
  observedAt: string | null; ageSeconds: number | null; completeness: string };
/** Ticket 29: the correlated chain of one Work (Ticket → Work → cycle → Executions → reviews → publication/readiness/delivery/cleanup → references). */
export type ChainView = {
  /** GitHub `{repository, number, url}` (unchanged) or Jira `{key, url}` (presentation only). */
  ticket: { repository: string; number: number; url: string } | { key: string; url: string };
  work: { work_id: string; cycle: number; predecessor: string | null; result: WorkView['result']; admittedAt: string; branch: string | null };
  /** Phase/wait derived from the dimensions (presentation only; never authority): what the Work is doing or waiting for, and the next step. */
  phase: { code: string; waitingFor: string | null; nextStep: string | null };
  lastActivity: { at: string; event: string } | null;
  executions: ChainExecutionView[];
  questions: { questionId: string; executionId: string; state: QuestionView['state']; publication: string; url: string | null }[];
  corrections: { current: { correctionId: string; trigger: string | null; consumed: boolean } | null; closed: number; feedback: { pending: number; total: number } };
  publication: { state: string; pullRequest: { number: number; url: string; draft: boolean; state: string } | null; verifiedHead: string | null; nextStep: string | null } | null;
  checks: { outcome: string; headSha: string | null; at: string } | null;
  readiness: { internal: string; flag: string; nextStep: string } | null;
  delivery: { state: string; mergedAt: string | null; mergeCommitSha: string | null } | null;
  cleanup: { state: string; resources: { kind: string; state: string }[]; nextStep: string } | null;
  /** Protected references the history and decisions rest on (never their content). */
  references: { kind: 'question-content' | 'opinion' | 'start-receipt' | 'preserved-evidence' | 'builder-session' | 'reviewer-session'; executionId: string | null;
    reference: string }[];
  /** Models and configuration actually recorded for each role (session profiles, opinions, Builder policies). */
  models: { role: InspectionRole; provider: string; model: string; source: 'builder-session' | 'opinion' }[];
  configuration: { builder: ExecutionView['request']['policies'] | null; timeoutSeconds: number | null };
  observations: ObservationView[];
};
export type ChainExecutionView = { executionId: string; mode: ExecutionView['mode']; state: ExecutionView['state']; phase: ExecutionView['dispatch']['phase'];
  purpose: 'implementation' | 'publication' | 'repair' | 'reconciliation' | 'resumption' | 'recovery';
  outcome: string | null; code: string | null; environment: string | null; boot: string | null; startedAt: string | null; endedAt: string | null;
  charge: string | null; duration: DurationView['state']; verification: string | null; recoveries: number;
  /** Ticket 41: the lost Builder request that blocked this Execution's recovery and the operator's explicit decision, if any. */
  blockedRequest?: { reference: string; code: string; state: 'blocking' | 'overridden';
    override: { request_id: string; at: string; operator: { kind: 'local-administrator' } } | null } | null;
  /** Ticket 50: the boot/preparation refusal that blocked this Execution's recovery and the operator's retry, if any. */
  blockedStart?: { code: string; detail: string | null; state: 'blocking' | 'retried'; retry: { request_id: string; at: string; remedy: string | null } | null } | null;
  reviews: { round: number; attempt: number; kind: string; conclusion: string | null;
    reviewers: { role: 'standards' | 'spec'; state: string; attempt: number; conclusion: string | null; source: string | null; opinion: string | null }[] }[] };
/** Ticket 29: the read-only Records facets inspection uses (spec §2.3 `Records.read`). */
export type RecordsInspectionPort = {
  find(selection: { workId: string; executionId?: string; role?: InspectionRole; id?: string; after?: string; limit?: number }): Promise<{ completeness: 'complete' | 'incomplete';
    /** Last capture id examined when more remain (paged calls). */ next?: string | null;
    /** Ticket 17 preserved-evidence folders seen (known non-captures). */ preservedEvidence?: number;
    captures: { reference: { workId: string; id: string }; context: { workId: string; executionId: string; invocationId: string; role: InspectionRole; environmentRef: string;
      bootRef: string; callId: string }; state: 'complete' | 'partial'; format?: 'text' | 'raw' }[] }>;
  read(input: { reference: { workId: string; id: string }; offset: number; limit: number }): Promise<{ state: 'complete' | 'partial' | 'absent'; data: Uint8Array; nextOffset: number; bytes: number }>;
};

// ---- Ticket 30: retention and explicit cleanup (spec §12.1/§12.3/§12.4) ----
export type RetentionEvent = 'retention-evaluated' | 'details-preserved' | 'detail-removal-intended' | 'detail-removal-result' | 'cleanup-planned' | 'cleanup-confirmed' |
  'cleanup-item-dropped' | 'cleanup-explicit-resources' |
  /* ticket 31 */ 'forget-planned' | 'forget-confirmed' | 'forget-dropped' | 'forget-intended' | 'forget-result';
/** What explicit cleanup may select (spec §12.4): details (logs, sessions) and own resources (environment, remote branch). */
export type ExplicitCleanupSelection = 'logs' | 'sessions' | 'environment' | 'remote-branch';
/** One detail of a Work found by the Records inventory: a log is a Records capture, a session the preserved copy of a recorded Builder session. */
export type DetailItem = { id: string; kind: 'log' | 'session'; executionId: string | null; bytes: number;
  /** `partial`: the capture has no completion marker (it may still be written while its Execution runs). */
  state: 'complete' | 'partial';
  /** Sessions: content hash observed by the inventory (removal requires it unchanged). */
  sha256?: string | null };
/** `complete` only from an intact Records area; an incomplete inventory never proves absence. `evidence`: protected preserved directories (never targets). */
export type DetailInventory = { completeness: 'complete' | 'incomplete'; observedAt: string; items: DetailItem[]; evidence: number; unknown: string[];
  /** Captures history needs, kept until explicit history deletion (never targets), by class: `record:<kind>`, `host-evidence`, `unknown-kind`. */
  kept?: Record<string, number> };
export type DetailRemoval = { outcome: 'removed' | 'absent' | 'refused' | 'failed' | 'indeterminate'; code: string | null };
/** Ticket 30 trusted composition ports over the Records area (host-only, never mounted in a guest). */
export type DetailPorts = {
  list(input: { workId: string }): Promise<DetailInventory>;
  /** Every agent session file in one boot's runtime tree (every `w-<id>/profile/sessions/<file>.jsonl` under `r/<boot>`), read confined, with its current hash. */
  runtimeSessions?(input: { boot: string }): Promise<({ ref: string; sha256: string; bytes: number } | { ref: string; code: string })[]>;
  /** Acceptance finding A7: the session a Builder invocation left in `boot` without returning it (its boot was lost), with its current hash;
   * null when none can be attributed to that invocation. Preserved as the Execution's Builder session copy, like a recorded one. */
  lostSession?(input: { workId: string; boot: string; executionId: string; invocationId: string }): Promise<{ ref: string; sha256: string; bytes: number } | null>;
  /** Copies a session (verified by its hash) into the Work's Records `sessions/<name ?? executionId>.jsonl` BEFORE its environment is removed. */
  preserveSession(input: { workId: string; executionId: string; name?: string; session: Pick<WorkerSessionRef, 'ref' | 'sha256' | 'bytes'> }): Promise<{ status: 'preserved' | 'already'; sha256: string; bytes: number } |
    { status: 'lost' | 'failed'; code: string }>;
  /** Confined removal of ONE detail of this Work; a session is removed only while its content still has `expectedSha256`. */
  remove(input: { workId: string; item: Pick<DetailItem, 'id' | 'kind' | 'executionId'>; expectedSha256: string | null }): Promise<DetailRemoval>;
  /** Ticket 31: read-only inspection of the Work's WHOLE Records area (what `forget` deletes); `incomplete` (unsafe entry, unreadable) refuses it. */
  inspectTree?(input: { workId: string }): Promise<ForgetTree>;
  /** Ticket 31: deletion of the Work's whole Records area (fail-closed: an unsafe entry refuses it before anything is touched). */
  forget?(input: { workId: string }): Promise<ForgetRemoval>;
};
export type ForgetTree = { completeness: 'complete' | 'incomplete'; observedAt: string; present: boolean; leftover: boolean; files: number; directories: number; bytes: number; unsafe: string[] };
export type ForgetRemoval = { outcome: 'removed' | 'absent' | 'refused' | 'failed' | 'indeterminate'; code: string | null; files: number; bytes: number };
/** `builder`: the Execution's recorded Builder session; `reviewer`: another agent session found in the same boot runtime (not recorded by Control). */
export type PreservedSessionView = { id: string; role: 'builder' | 'reviewer'; executionId: string; sourceRef: string; sha256: string; bytes: number; at: string;
  state: 'preserved' | 'lost' | 'failed'; code: string | null };
/** One detail removal: intent recorded BEFORE the effect, result after it; an intent without result (crash) becomes `indeterminate`. */
export type DetailRemovalView = { effectId: string; id: string; kind: 'log' | 'session'; executionId: string | null; bytes: number;
  origin: 'retention' | 'explicit'; request_id: string | null; planId: string | null; intentAt: string; resultAt: string | null;
  outcome: DetailRemoval['outcome'] | 'intended'; code: string | null };
export type ExplicitCleanupItem = { id: string; kind: 'log' | 'session' | 'environment' | 'remote-branch'; target: string; bytes: number | null; loss: string;
  /** Sessions: hash planned (an item whose content changed since the plan is dropped). */ sha256?: string | null;
  /** `planned` → `intended` → result; `dropped`: revalidation found it needed/active now (never removed by this old plan); `handed-to-cleanup`:
   * an own resource executed by the resource cleanup (its per-resource result is in `cleanup.resources`). */
  state: 'planned' | 'dropped' | 'handed-to-cleanup' | DetailRemovalView['outcome']; code: string | null };
export type ExplicitCleanupPlan = { planId: string; request_id: string; work_id: string; createdAt: string; select: ExplicitCleanupSelection[];
  state: 'planned' | 'confirmed' | 'superseded' | 'executed'; confirmedBy: string | null; confirmedAt: string | null;
  /** The facts the plan was computed from (result, cancellation, Executions, cleanup); a change makes the plan obsolete and it is revalidated. */
  basis: string; items: ExplicitCleanupItem[]; refusals: { target: string; code: string; detail: string }[]; losses: string[]; warnings: string[]; nextStep: string };
export type RetentionView = {
  /** `undelivered`: kept in full until explicit cleanup (no deadline); `delivered`: logs/sessions eligible from `dueAt` when unprotected. */
  class: 'undelivered' | 'delivered'; days: number;
  /** Confirmed merge + `days` (fixed once: the end of a protection later never starts another period). */
  dueAt: string | null;
  /** Current reasons the details are protected whatever the deadline (pending Question/effect/cleanup/recovery, activity, cessation). */
  protections: string[];
  state: 'retained' | 'protected' | 'eligible' | 'expired' | 'explicitly-cleaned';
  inventory: { completeness: 'complete' | 'incomplete'; observedAt: string; logs: number; sessions: number; bytes: number; evidence: number; unknown: number;
    /** Records kept until explicit history deletion (receipts, opinions, Question records, Host evidence, unknown kinds). */ kept?: number } | null;
  sessions: PreservedSessionView[];
  removals: DetailRemovalView[];
  /** Every detail whose removal ended failed/refused/indeterminate, kept beyond the bounded `removals`: never removed implicitly again. */
  unsettledIds?: string[];
  /** Totals of everything removed (the bounded `removals` list keeps only the latest entries). */
  removed: { logs: number; sessions: number; bytes: number };
  plans: ExplicitCleanupPlan[];
  sweeps: number; lastSweepAt: string | null;
  nextStep: string;
};
// ---- Ticket 31: explicit history deletion (`forget`, spec §12.4) ----
/**
 * Minimal memory of a forgotten Work (spec §12.4): Ticket/repository/Work identity, cycle order and link, result and, when delivered, its pull
 * request identity and the fact of the confirmed merge. No request content, log, review, decision, Question or answer. It keeps the Ticket out
 * of automatic re-admission (the index still names the cycle) and keeps own-dependency evaluation (never external).
 */
export type ForgottenWork = { work_id: string; ticket: TicketRef; repository: { repository: string; repositoryId: number; base: string };
  cycle: number; predecessor: string | null; sequence: number; result: 'delivered' | 'cancelled';
  pullRequest: { number: number; pullRequestId: number; nodeId: string; url: string } | null; mergeConfirmed: boolean; mergeConfirmedAt: string | null;
  /** The configured label the cycle was admitted with (configuration fact; a later `new` re-reads the Ticket). */ label: { id: number; name: string } | null;
  /** Question identities only (no text): `question <id>` answers `question-forgotten`. */ questions: string[];
  /** Review MED: a cancelled cycle's own PR stays watched from the memory (spec §12.3: a confirmed merge still delivers it; a human may reopen and
   * merge it later). A confirmed merge turns this memory into a delivery (`result`, `mergeConfirmed`, `pullRequest`). */
  watch: { pullRequest: OwnPullRequestIdentity; branch: string | null; state: 'watching' | 'delivered'; lastReadAt: string | null; lastOutcome: string | null } | null;
  forgottenAt: string; request_id: string; planId: string;
  /** Operator decision D-07: the scrub of the controller storage after this forget (VACUUM + WAL truncation, so the deleted records do not stay in
   * SQLite free pages/WAL). `pending` until a scrub completed after the forget commit; a record forgotten before D-07 has none and counts as pending. */
  scrub?: ForgetScrub };
export type ForgetScrub = { state: 'pending' | 'scrubbed'; attempts: number; lastAttemptAt: string | null; code: string | null; scrubbedAt: string | null };
/** D-07: the controller storage's scrub port (the owner's own SQLite connection, serialized with every other operation on it). */
export type ScrubResult = { outcome: 'scrubbed' } | { outcome: 'failed'; code: string };
export type StorageScrub = { vacuum(): Promise<ScrubResult>; checkpoint(): Promise<ScrubResult> };
/** One `forget` plan. The deletion is intended BEFORE the Records effect and recorded after it; a lost intent is `indeterminate` (never retried). */
export type ForgetPlan = { planId: string; request_id: string; work_id: string; createdAt: string;
  state: 'planned' | 'refused' | 'superseded' | 'confirmed' | 'dropped' | 'removing' | 'failed' | 'indeterminate' | 'forgotten';
  basis: string; refusals: { code: string; detail: string }[]; losses: string[]; keeps: string[]; warnings: string[];
  records: { files: number; bytes: number; present: boolean; leftover: boolean } | null;
  confirmedBy: string | null; confirmedAt: string | null;
  effect: { effectId: string; intentAt: string; resultAt: string | null; outcome: ForgetRemoval['outcome'] | 'intended'; code: string | null } | null;
  code: string | null; nextStep: string };
export type RetentionStatus = { sweeps: number; lastSweepAt: string | null; days: number | null;
  works: { undelivered: number; retained: number; protected: number; eligible: number; expired: number };
  details: { logs: number; sessions: number; bytes: number }; removed: { logs: number; sessions: number; bytes: number }; unsettled: number };
