import type { AccessDiagnostic, BuilderCredentials, BuilderGrantMetadata, GitHubScope, HandoffDeclarations, ProposalHandoff, ProposalIdentity, ReviewerRole, ReviewOpinion, RevocationResult } from '../contracts/index.js';
import type { CheckoutRequest, EnvironmentRef, PreparedWork, RemoveResult, StartResult, StopResult, BootRef } from '../sandbox/index.js';
import type { ActivationDelivery, DeliveryResult, ActivationEvents, HandoffEvent, Invocation, WorkerDirective, WorkerCompletion, SessionObservation, WorkerSessionRef, OpinionObservation } from '../workers/index.js';
export type { SessionObservation, WorkerSessionRef as SessionRef } from '../workers/index.js';
import type { IssueTracker, TicketRef } from '../issue-tracker/index.js';
import type { BranchCleanupResult, CodeRepository, PullRequestFacts } from '../code-repository/index.js';
export type { BranchCleanupResult, PullRequestFacts } from '../code-repository/index.js';
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
  operators?: (string | { login: string; id?: number })[];
  /** Ticket 14: resolves the Factory App's bot identity (lazy, safe read); null/absent = unknown, and then nothing is publishable. */
  factoryApp?: () => Promise<FactoryAppIdentity | null> };
/** Monotonic local clock for live polling cadence; calendar time is only used for observation instants. Tests substitute it. */
export type PollingClock = { monotonic(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
export type PollingOptions = { intervalSeconds: number; clock?: PollingClock };
export type ExecutionOptions = ExecutionPorts;
export type ControlInput = { request_id: string; operation: 'pause' | 'unpause'; origin: 'local-cli' } |
  { request_id: string; operation: 'answer'; question_id: string; text: string; origin: 'local-cli' } |
  /** Explicit additional budget for ONE counter of a Work (spec §11.3 `grant`), from the authorized local ingress. */
  { request_id: string; operation: 'grant'; work_id: string; counter: 'corrections' | 'recoveries'; amount: number; origin: 'local-cli' } |
  /** Ticket 11 (spec §11.3): authorize ONE concrete new version of the Work's request; never applied to a running activity. */
  { request_id: string; operation: 'update-scope'; work_id: string; reason: string; origin: 'local-cli' } |
  /** Ticket 16 (spec §9.3): authorize ONE restoration of ready after an unexpected human draft, or ONE repeat of a conversion that was not
   * applied. Never a readiness certificate: the conversion still needs a complete current evaluation and the pre-conversion recheck. */
  { request_id: string; operation: 'authorize-readiness'; work_id: string; reason: string; origin: 'local-cli' };
/** `answer`: `accepted` removed only that Question's impediment; `not-applied` (already answered, unknown, closed Work...) changed nothing. */
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number } |
  { kind: 'durable'; request_id: string; operation: 'answer'; question_id: string; outcome: 'accepted' | 'not-applied'; reason: string | null; work_id: string | null } |
  /** `grant`: `accepted` added capacity (history kept, counters untouched); `not-applied` changed nothing (unknown/closed/old Work). */
  { kind: 'durable'; request_id: string; operation: 'grant'; work_id: string; counter: 'corrections' | 'recoveries'; amount: number;
    outcome: 'accepted' | 'not-applied'; reason: string | null; budget: CounterView | null } |
  /** `accepted`: recorded for the next activation (the Work re-enters its queue position if it was idle after a completed Execution);
   * `deferred`: an activity is running or held, nothing reaches it, the change waits for the next safe activation; `not-applied`: nothing changed. */
  { kind: 'durable'; request_id: string; operation: 'update-scope'; work_id: string; outcome: 'accepted' | 'deferred' | 'not-applied'; reason: string | null;
    scopeUpdateId: string | null; appliesAt: 'next-activation' | null } |
  /** `accepted`: recorded for the next conversion of that purpose (consumed once); `not-applied`: nothing to authorize, nothing changed. */
  { kind: 'durable'; request_id: string; operation: 'authorize-readiness'; work_id: string; outcome: 'accepted' | 'not-applied'; reason: string | null;
    purpose: 'human-draft' | 'repeat-conversion' | null };
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
    observeStart?(input: { workId: string; executionId: string; invocationId: string }): Promise<StartObservation>;
    /** Ticket 28 — Q6 `observe`, opinion facet: the complete opinion record a reviewer invocation preserved before its notification.
     * Absent = a reviewer outcome without its opinion is never recovered from Records (it stays a failure). Not proof of cessation. */
    observeOpinion?(input: { workId: string; executionId: string; invocationId: string }): Promise<OpinionObservation> };
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
      reason: 'QUESTION_ANSWERED' | 'SCOPE_UPDATED' | 'NEW_BOOT_REPLACEMENT_SESSION' | 'PUBLICATION_REQUESTED' } | null;
    /** Ticket 14: a publication activation requested by Control after discovery found no own pull request. It carries exactly the
     * verified commit, the Work's branch/base, the correlation marker and the remote expectation (lease) observed BEFORE preparation. */
    publication?: PublicationRequest | null;
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
/** Remote tip of the Work's own branch as observed by a complete read (`absent` = no such ref). */
export type BranchObservation = { state: 'absent' } | { state: 'present'; sha: string };
/** What one publication activation may publish (spec §9.1): fixed by Control, never chosen by the model. */
export type PublicationRequest = { basisExecutionId: string; head: string; branch: string; base: string; marker: string; expectedRemote: BranchObservation;
  /** An update of the Work's own pull request (a later verified basis): its number; null = create ONE draft pull request. */
  pullRequest?: number | null };
/** Pinned GitHub identity of the Factory App's bot user (from GET /app and the bot user), the only author an own PR may have. */
export type FactoryAppIdentity = { login: string; id: number };
/** The Work's own pull request, recognized by correlation (marker, App bot author, own branch/repository/base); never adopted otherwise. */
export type OwnPullRequest = { pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean; draft: boolean;
  headRef: string; headSha: string; base: string; author: { id: number; login: string; type: string }; linkedAt: string; bodySha256: string | null };
/** One discovery (safe read) of the own publication: Git remote ref + pull requests of the repository correlated to the Work. */
export type PublicationDiscovery = { at: string; observedAt: string | null; trigger: 'verified' | 'after-publication' | 'reconciliation';
  outcome: 'linked' | 'absent' | 'held' | 'incomplete' | 'blocked'; reasons: string[]; branch: BranchObservation | { state: 'unknown'; code: string };
  candidates: { number: number; url: string; own: boolean; reasons: string[] }[] };
/**
 * Publication dimension of a Work (spec §3.3/§9.1, ticket 14). `not-publishable`: the basis Execution's content is not verified (its
 * reasons; nothing is requested); `awaiting-discovery`: the next safe read decides; `requested`: discovery found nothing and a publication
 * activation of the Builder is queued; `published`: the own draft PR is linked (opening never ends the Ticket/Work); `blocked`: repeating or
 * linking would be unsafe (unknown PR/change, several candidates, outcome not confirmed after an attempt...), explicit operator decision.
 */
export type PublicationView = {
  state: 'not-publishable' | 'awaiting-discovery' | 'requested' | 'published' | 'blocked';
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
 * `charge`: a retry draws ONE unit of the Work's existing `recoveries` counter (no parallel review budget): reserved at the retry intent,
 * consumed with the reviewer's confirmed start, released on a proven non-start. `retry`: the persisted wait before that attempt.
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
/** Semantic state of one current result (spec §9.2 table): check-run and commit-status semantics are distinct. */
export type CheckClassification = 'satisfied' | 'waiting' | 'failed' | 'operational' | 'uncertain';
/** One current (or other-origin/other-SHA) result as GitHub reported it, with its attempt among same-name runs of its check suite. */
export type CheckResultView = { kind: 'check-run' | 'status'; id: number; name: string; sha: string; origin: string; status: string; conclusion: string | null;
  classification: CheckClassification; attempt: { suite: number | null; superseded: number } | null; url: string | null };
/** A requirement GitHub enforces for merging into the base: context + integration, accumulated from every source, with its pertinent SHA. */
export type CheckRequirementView = { context: string; integrationId: number | null; sources: string[]; strict: boolean; sha: string;
  state: CheckClassification | 'indeterminate'; results: CheckResultView[]; otherOrigin: CheckResultView[]; reasons: string[] };
/** An independent reason: `wait` (CI, no Slot), `repair` (pertinent failure), `operational`/`uncertain` (no Builder by guessing),
 * `indeterminate` (unknown/partial/unsupported), `ownership`, `strict`, `closed`. Several coexist; none erases another. */
export type CheckReason = { category: 'wait' | 'repair' | 'operational' | 'uncertain' | 'indeterminate' | 'ownership' | 'strict' | 'closed'; code: string; subject?: string };
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
  /** Every active rule of the base and how it was interpreted; `unsupported` makes the evaluation indeterminate. */
  modalities: { type: string; source: string; interpretation: 'required-checks' | 'not-check-related' | 'human-stage' | 'unsupported' }[];
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
export type ReadinessReason = { area: 'ownership' | 'publication' | 'content' | 'checks' | 'conflict' | 'impediment' | 'dependencies' | 'concurrency' | 'installation' | 'closed';
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
  /** `delivered` (ticket 17): a human merged the Work's own pull request and the Factory confirmed it; no new agent action follows. */
  result: 'open' | 'delivered';
  authorization: { state: 'authorized'; source: 'github-rest'; observedAt: string;
    basis: { repositoryConfigured: true; issueState: 'open'; label: { id: number; name: string } };
    publication: { observedAt: string; completeness: 'complete'; associatedPullRequests: 0; limitations: string[] };
    tracking: string };
  queue: { category: 'normal'; sequence: number; pending: boolean };
  impediments: Impediment[];
  dependencies: DependencyState;
  dispatch: { state: 'held' | 'eligible' | 'executing'; reasons: string[] };
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
  correction: { correctionId: string; reason: string; openedAt: string; consumed: boolean } | null;
  /** A pending operational recovery (ticket 26 decides it); consumed by the start of the recovery Execution. */
  pendingRecovery: { reason: string; requestedAt: string;
    /** Ticket 26: persisted wait (calendar) before the recovery may start, its length and the attempt index it was derived from. */
    notBefore?: string; waitSeconds?: number; attempt?: number; executionId?: string | null } | null;
  /** Presentation only (never persisted): limits/reservations/consumption, timeout, duration/last activity and the action required. */
  limits: LimitsView;
  /** Concrete scope updates authorized by the operator (ticket 11), in acceptance order. Later Ticket/link edits are never one. */
  scopeUpdates?: ScopeUpdateView[];
  /** Ticket 17 (absent on earlier records): observation of the own pull request and the confirmed merge that delivers the Work. */
  delivery?: DeliveryView | null;
  /** Ticket 17: cleanup of the Work's own resources after delivery, shown SEPARATELY from the delivery (a failed cleanup never undoes it). */
  cleanup?: CleanupView | null;
  admittedAt: string;
  history: ({ at: string; event: 'admitted'; origin: 'github-polling'; sequence: number } |
    { at: string; event: 'dependencies-changed'; origin: 'github-polling'; before: DependencyEvaluation['conclusion'] | null; after: DependencyEvaluation['conclusion']; evaluationId: string } |
    { at: string; event: 'execution-reserved' | 'execution-prepared' | 'execution-booted' | 'activation-requested' | 'execution-started' | 'execution-ended' | 'execution-held' | 'execution-released' | 'slot-released' |
      'review-handoff' | 'reviewer-started' | 'reviewer-ended' | 'review-concluded' | 'review-delivered' | 'review-exempted' | 'review-verified' |
      /* ticket 28 */ 'reviewer-retried' | 'reviewer-not-retried' | 'opinion-discovered' | 'opinion-carried';
      origin: 'controller-dispatch'; executionId: string; detail?: string } |
    { at: string; event: 'question-recorded' | 'question-published' | 'question-answered'; origin: 'controller-dispatch' | 'controller-publication' | 'github-comment' | 'local-cli';
      questionId: string; detail?: string } |
    { at: string; event: 'budget-reserved' | 'budget-consumed' | 'budget-released' | 'budget-exhausted' | 'budget-granted' | 'correction-opened' | 'correction-reason-added' | 'recovery-requested';
      origin: 'controller-budget' | 'local-cli'; executionId: string | null; detail: string } |
    { at: string; event: 'timeout-reached' | 'duration-reconciled'; origin: 'controller-clock'; executionId: string; detail: string } |
    { at: string; event: 'scope-update-accepted' | 'scope-update-delivered' | 'scope-update-reoffered' | 'scope-update-consumed'; origin: 'local-cli' | 'controller-dispatch';
      scopeUpdateId: string; detail?: string } |
    { at: string; event: 'execution-reconciled' | 'recovery-wait-kept'; origin: 'controller-recovery'; executionId: string | null; detail: string } |
    { at: string; event: 'publication-evaluated' | 'publication-requested' | 'publication-started' | 'publication-linked' | 'publication-blocked' | 'publication-discovery-incomplete';
      origin: 'controller-publication'; executionId: string | null; detail: string } |
    { at: string; event: 'checks-evaluated'; origin: 'controller-checks'; detail: string } |
    { at: string; event: 'readiness-evaluated' | 'readiness-intended' | 'readiness-attempted' | 'readiness-confirmed' | 'readiness-not-applied' | 'readiness-human-flag';
      origin: 'controller-readiness'; detail: string } |
    { at: string; event: 'readiness-authorized'; origin: 'local-cli'; detail: string } |
    { at: string; event: 'delivery-observed' | 'delivery-confirmed' | 'cleanup-evaluated' | 'evidence-preserved' | 'cleanup-intended' | 'cleanup-result';
      origin: 'controller-delivery'; detail: string })[];
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
  /** Ticket 33: storage format and how the previous controller run of this storage ended (`crash`: it never recorded an end). */
  storage: { format: number; previousRun: { runId: string; startedAt: string; endedAt?: string; end: 'clean' | 'uncertain' | 'failed' | 'crash' } | null };
};
export type RecoveryView = { at: string; inventory: 'empty' | 'unknown' | 'listed'; reconciled: number; ceased: number; unconfirmed: number;
  global: string[]; cachePreparing: (number | null)[];
  /** Caches still left in preparation after the owner's repair-free reconciliation, with the explicit operator action. */
  cache: { repositoryId: number | null; state: string; nextStep: string | null }[] };
export interface Control {
  accept(input: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' }>;
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null } | AccessView | ListView | ShowView | QuestionQueryView>;
  /** `uncertain`: stopped, but some own activity is not confirmed ceased or not durably settled (cessation unconfirmed, Slot held); the next boot reconciles it (ticket 26) and it is never a clean stop (ticket 33). */
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' | 'uncertain' }>;
}

// ---- Ticket 17: confirmed delivery and owned cleanup (spec §12.3) ----
/** Identity of the Work's own pull request as the publication discovery linked it (ticket 14); the only PR whose merge delivers the cycle. */
export type OwnPullRequestIdentity = { pullRequestId: number; nodeId: string; number: number; url: string; headRef: string; base: string };
/** One read of the own pull request. `unavailable` concludes nothing (no merge, closure or absence). */
export type MergeObservation = { at: string; observedAt: string | null;
  outcome: 'open' | 'closed-unmerged' | 'merged' | 'identity-mismatch' | 'merge-unconfirmed' | 'unavailable'; reasons: string[] };
/** Confirmed merge facts: what makes the Work delivered (never an issue/PR closure or a Builder message). */
export type MergeFacts = { mergedAt: string; mergeCommitSha: string; headSha: string; pullRequestId: number; number: number; url: string };
export type DeliveryView = {
  state: 'watching' | 'delivered';
  pullRequest: OwnPullRequestIdentity;
  /** Bounded latest observations (identical consecutive outcomes counted once). */
  observations: MergeObservation[];
  /** `duringActivity`: the Execution that was active when the merge was confirmed (it is interrupted; no new action follows). */
  merge: (MergeFacts & { confirmedAt: string; observedAt: string; duringActivity: string | null }) | null;
  nextStep: string;
};
export type CleanupResourceKind = 'environment' | 'checkout' | 'local-branch' | 'temporaries' | 'remote-branch';
export type CleanupOutcome = 'removed' | 'absent' | 'partial' | 'failed' | 'refused' | 'indeterminate';
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
  nextStep: string;
};
export type EvidencePreservation = { status: 'preserved'; reference: NonNullable<EvidencePreservationView['reference']> } | { status: 'absent' } | { status: 'failed'; code: string };
/** Ticket 17 trusted composition ports: Sandbox removal of an OWN environment and Records preservation of its evidence. */
export type CleanupPorts = {
  remove(input: { environment: EnvironmentRef; cleanup: unknown }): Promise<RemoveResult>;
  preserve(input: { workId: string; environment: EnvironmentRef }): Promise<EvidencePreservation>;
  /** Seconds between automatic retries of a pending cleanup (default 86400: daily), besides one sweep at each controller boot. */
  retrySeconds?: number;
};
