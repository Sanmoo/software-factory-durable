import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import type {
  AccessDependencies,
  AccessView,
  Control,
  ControlStatus,
  DetailInventory,
  ShowView,
  DispatchReason,
  ExecutionPorts,
  Impediment,
  LimitsView,
  ListView,
  PollingOptions,
  PollingView,
  TriagePorts,
  TriageAuthorshipImpediment,
  TriageRequest,
  TriageRequestsView,
  QuestionQueryView,
  RecoveryView,
  RuntimeInventory,
  WorkView,
} from '../types.js';
import { heldSlots, initializeSlots, reconcileDurations, reconcileLostCredentials } from './execution.js';
import { createDispatcher, isLiveCredentialExecution, isLiveExecution } from './dispatch.js';
import { createChecksTracker } from './checks.js';
import { acceptReadinessAuthorization, createReadinessDesk } from './readiness.js';
import { openStore, type Session } from './store.js';
import { recordRunEnd, recordRunStart } from './migration.js';
import { currentFormat } from './format.js';
import {
  acceptPauseCommand,
  admitTicket,
  indexedWork,
  initialize,
  ownCycles,
  pendingJiraWorks,
  pendingWorks,
  recordTicketPresentation,
  readForgotten,
  readForgottenWork,
  readInstallation,
  readRequest,
  readWork,
  readWorks,
  recordDependencies,
  recordEnvironment,
  type WorkRecord,
} from './admission.js';
import { acceptForgetConfirm, acceptForgetPlan } from './forget.js';
import { ticketKey } from '../rules/admission.js';
import { forgottenNextStep, forgottenNotRecoverable } from '../rules/forget.js';
import { createPoller, systemClock } from './polling.js';
import { holdsTriageCapacity, triageImpediments } from '../rules/triage.js';
import { createTriageDiscovery } from './triage-discovery.js';
import { createTriageInvestigations } from './triage-investigation.js';
import { createTriagePublications } from './triage-publication.js';
import { githubTriagePublisher } from './triage-publication-github.js';
import { readTriageRequests } from './triage-requests.js';
import { createQuestionDesk } from './question-desk.js';
import { jiraNoticeStatus, noticeJiraImpediments } from './jira-impediments.js';
import { jiraConversationOwners, prepareJiraQuestions } from './jira-questions.js';
import { createJiraInputDesk } from './jira-inputs.js';
import { createJiraLinkDesk, jiraLinkStatus } from './jira-links.js';
import { jiraDeliveryOwner } from './jira-deliveries.js';
import { acceptAnswer, readQuestion, readQuestions } from './questions.js';
import { acceptScopeUpdate } from './scope.js';
import { acceptPublicationReevaluation } from './publication.js';
import { dispatchBlockers, selectNext } from '../rules/dependencies.js';
import { counterView, defaultLimits, durationView, maxGrantAmount } from '../rules/budget.js';
import { grantBudget, openCorrection, requestOperationalRecovery } from './budget.js';
import { reconcileBoot } from './recovery.js';
import { dispatchGate } from '../rules/recovery.js';
import { capabilityImpediment, missingCapabilities, sandboxCapabilityImpediment } from '../rules/capabilities.js';
import { blockedReferencePattern, blockedStartCodePattern, startRetryRemedies } from '../../contracts/index.js';
import { backoffRunning, bootDeferralRunning } from './recovery-request.js';
import { createDeliveryDesk } from './delivery-desk.js';
import { acceptCancel, acceptNewCycle, acceptReopen, acceptResume, createCycleDesk, recordAuthorization } from './cycles.js';
import { createRetentionDesk } from './retention-desk.js';
import { acceptCleanupConfirm, acceptCleanupPlan, plannedResourcesOf } from './retention.js';
import { planCleanup } from '../rules/delivery.js';
import { retentionProtections, type PlanFacts } from '../rules/retention.js';
import { createRepairDesk } from './repair.js';
import { acceptRepairRequest, createFeedbackDesk } from './feedback.js';
import { queueOrder } from '../rules/repair.js';
import { chainOf, compactWork, executionsOf, fitPage, inspectionLimits, page } from '../rules/inspection.js';
import { inspectHistory, inspectLog, inspectLogs, inspectUsage, viewBudgetBytes } from './inspection.js';

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const inputSchema = z.union([
  z.strictObject({ request_id: requestId, operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli') }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('grant'),
    work_id: z.uuid(),
    counter: z.enum(['corrections', 'recoveries', 'continuations']),
    amount: z.number().int().min(1).max(maxGrantAmount),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('answer'),
    question_id: z.uuid(),
    origin: z.literal('local-cli'),
    text: z
      .string()
      .max(2000)
      .refine(text => text.trim().length > 0 && text === text.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)),
  }),
  // Ticket 11: concreteness is a durable decision of the commit (queryable `not-applied`), only the shape is checked here.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('update-scope'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('authorize-readiness'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  // Ticket 23: concreteness and the phase answer are durable decisions of the commit; only the shape is checked here.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('repair'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  // Ticket 61: eligibility (blocked only by unexpected ref changes after an attempt) is a durable decision of the commit.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('reevaluate-publication'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  // Ticket 25 (spec §11.3).
  z.strictObject({ request_id: requestId, operation: z.literal('cancel'), work_id: z.uuid(), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('resume'), work_id: z.uuid(), origin: z.literal('local-cli') }),
  // Ticket 41: explicit exit of a recovery blocked by a lost Builder request (the exact blocked reference).
  z.strictObject({
    request_id: requestId,
    operation: z.literal('resume'),
    work_id: z.uuid(),
    override_blocked_recovery: z.string().regex(blockedReferencePattern),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('resume'),
    work_id: z.uuid(),
    new_review_round: z.literal(true),
    origin: z.literal('local-cli'),
  }),
  // Ticket 50: Control checks the exact blocking refusal and the remedy; only their shared shapes are checked here.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('resume'),
    work_id: z.uuid(),
    retry_blocked_start: z.string().regex(blockedStartCodePattern),
    remedy: z.enum(startRetryRemedies).optional(),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({ request_id: requestId, operation: z.literal('reopen'), work_id: z.uuid(), origin: z.literal('local-cli') }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('new'),
    ticket: z.strictObject({
      repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
      number: z
        .number()
        .int()
        .positive()
        .max(2 ** 31),
    }),
    keepPredecessorPullRequest: z.boolean(),
    origin: z.literal('local-cli'),
  }),
  // Ticket 30 (spec §12.4): explicit cleanup plan and its confirmation.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('cleanup-plan'),
    work_id: z.uuid(),
    select: z
      .array(z.enum(['logs', 'sessions', 'environment', 'remote-branch']))
      .min(1)
      .max(4),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({ request_id: requestId, operation: z.literal('cleanup-confirm'), work_id: z.uuid(), plan_id: z.uuid(), origin: z.literal('local-cli') }),
  // Ticket 31 (spec §12.4): explicit history deletion plan and its confirmation.
  z.strictObject({ request_id: requestId, operation: z.literal('forget-plan'), work_id: z.uuid(), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('forget-confirm'), work_id: z.uuid(), plan_id: z.uuid(), origin: z.literal('local-cli') }),
]);
const workIdSchema = z.uuid();
const sum = (works: WorkRecord[], value: (work: WorkRecord) => number | undefined) => works.reduce((total, work) => total + (value(work) ?? 0), 0);
const limitations = [
  'Candidate observations are in-memory results of the latest poll, not authority; they are rebuilt after restart.',
  'A failed or partial query, or absence from a listing, never proves absence of a Ticket, label or pull request, nor withdrawal of authorization.',
  'Dispatch opens only after the boot reconciliation: execution boundaries composed, no unknown runtime resource, task or orphan Slot; interrupted Executions are ceased (never adopted) and settled from durable evidence. A Work whose own cessation or start stays uncertain keeps its Slot/reservation and is blocked; independents proceed with the remaining capacity. Each dispatch then revalidates authorization and dependencies of its own attempt before reserving.',
  'An operational recovery waits its persisted delay (5/15/45 s by recoveries already consumed, never anticipated by events or restarts) and is checked again at the next polling round after it.',
  'An ended Builder Execution never completes the Work automatically and nothing is retried automatically. Publication (ticket 14) requires the end-of-Execution verification of a committed content; the Builder pushes its own branch and opens its own draft PR directly, only in a publication activation Control requested after a complete discovery found nothing. Control links its own PR only by correlation (marker, App bot author, own branch/repository/base, verified head); opening it never ends the Ticket.',
  "Readiness (ticket 16) is the controller's evaluation of current evidence (published own PR, verified content and two current opinions, treatments, gates, GitHub required checks of the current head, confirmed absence of conflict, no impediment or concurrent activity), confirmed by a fresh recheck immediately before any draft/ready conversion. The conversion is a Factory effect under a fresh single-use grant, intended before, observed and confirmed after, never repeated implicitly; a ready flag alone certifies nothing. Human review, approval and merge are human only.",
  'Native dependency evaluations are re-done every polling round; only an evaluation of the current round can release, never an older or pre-restart one.',
  'A Question waiting for an answer occupies no Slot; an accepted answer removes only its own impediment and never starts an agent directly: the Work resumes through its queue position after revalidation.',
  'A resumed Builder continues its previous session only when that session was recorded, is intact and compatible; otherwise it is replaced with a recorded reason and an explicit recovery instruction. Delivering context is not proof that the Builder consumed it.',
  'Only `update-scope` (or an accepted answer) authorizes a concrete change of the request, for the next safe activation; a later Ticket or link edit is never a trigger or an authorization.',
  "Delivery (ticket 17) is only a human merge of the Work's own pull request, confirmed by its identity; closing the Ticket or the pull request, or any agent message, is not delivery. The Factory never merges.",
  'Ticket 25: an observed label removal or issue closure suspends next activations (an active Execution may conclude/publish); restoring them never lifts the suspension: `resume` does, confirmed by the next complete Ticket read. `cancel` records the prohibition first, withdraws the activity credentials, then requests the stop; the Slot is released only after confirmed cessation and nothing on GitHub (branch, PR) is undone. A confirmed merge still delivers a cancelled cycle. An own PR closed without merge keeps the cycle current and undelivered (no automatic reopen/replacement/resume); `reopen` reopens only it and grants nothing. `new` is the only way to another cycle, after delivery or a ceased cancellation.',
  "Repairs (ticket 22) follow the SAME own pull request: only an effective impediment of its current Factory head (confirmed conflict, a current required check that failed, a strict rule that requires updating the branch) opens or extends the Work's correction, charged once at its confirmed start; pending CI/review, unknown mergeability, optional/old results, a base merely advancing, operational causes, base rules that block the merge and human flags never do. Reasons are read again right before admission (gone = withdrawn without charge); a repeated event on the same head blocks instead of spending again. The Factory never bypasses, approves or merges.",
  "Human feedback (ticket 23) is evidence only from configured operators: a CHANGES_REQUESTED review of the own PR (whatever commit it was on; a push never removes it) and an explicit `repair` (local CLI or a strict `/factory repair` comment on the Ticket or the own PR) are recorded with identity/origin/version/content, folded into the Work's correction at its next safe activation (commit order) and charged once to `corrections`; prose, bots and third parties grant nothing. A later approval or a dismissal removes only that review's trigger and never means the human merge approval is satisfied. Nothing is delivered to a running activity, nothing is launched by a command, and nothing approves, merges or bypasses.",
  'Cleanup after delivery removes only own resources (own environments with their checkout/local branch/temporaries, the own remote branch under its own cleanup grant), after confirmed cessation and preserved evidence; base, shared cache, other Works and Docker are never touched. A failed or pending cleanup is shown separately and never undoes delivery.',
  'Ticket 30: logs and sessions of a delivered Work become eligible `retentionDays` (default 30) after the confirmed merge and are removed by the sweep at each controller boot (after reconciliation) and daily, unless still needed (pending Question/effect/cleanup/recovery, activity, unconfirmed cessation); the end of a protection never starts another period. Undelivered Works (open, blocked, cancelled, closed without merge) keep everything until an explicit `factory cleanup`, which plans the losses, needs confirmation, is revalidated at execution and requires `cancel` first for a cycle that can still continue. Summary, history, references, reviews, decisions and preserved evidence stay until explicit history deletion.',
  'Ticket 31: `factory forget <work>` (plan of losses, then `forget-confirm`) deletes the history of ONE ended Work (delivered, or cancelled with confirmed cessation; an own PR closed without merge needs `cancel` first) once nothing is pending: its Records area, Work record, Questions and request texts. Only the minimal cycle memory stays (Ticket/repository/Work, cycle order and link, result, PR and confirmed merge of a delivery): the Ticket is never re-admitted automatically and stays an own blocker (delivered satisfies, cancelled does not). It never touches GitHub, backups or external copies. Totals and aggregates then cover only remembered Works.',
];

// Module-internal seam for the external-wait/cancellation flows of this module (not part of the public Control contract).
const dispatchers = new WeakMap<Control, ReturnType<typeof createDispatcher>>();
// Module-internal seam for the correction (tickets 22/23) and recovery (ticket 26) triggers; not part of the public Control contract.
const triggers = new WeakMap<
  Control,
  { correction(work_id: string, reason: string): Promise<string>; recovery(work_id: string, reason: string): Promise<string> }
>();
/** Opens a correction of a Work (charged once at its confirmed start); `refused` while an Execution is active or the Work is not current. */
export async function requestCorrection(control: Control, work_id: string, reason: string): Promise<string> {
  return triggers.get(control)?.correction(work_id, reason) ?? 'refused';
}
/** Requests an operational recovery of a Work (one recovery unit at its confirmed start). */
export async function requestRecovery(control: Control, work_id: string, reason: string): Promise<string> {
  return triggers.get(control)?.recovery(work_id, reason) ?? 'refused';
}
/** Withdraws the active Execution's credentials of a Work (external wait or cancellation) and attempts revocation of its known grants. */
export async function withdrawActivityCredentials(
  control: Control,
  work_id: string,
  reason: 'external-wait' | 'cancelled',
): Promise<'withdrawn' | 'not-active'> {
  return dispatchers.get(control)?.withdraw(work_id, reason) ?? 'not-active';
}

/** The Jira adapter when this owner polls: the Jira desks need both (no adapter composed, or no polling: no Jira desk). */
/** Spec #68 (ticket #71): the Triage rounds as `status` shows them: no candidate list, only how many Tickets wait for a person. */
const triageStatus = (polling: PollingView): Pick<PollingView, 'triage'> =>
  polling.triage
    ? {
        triage: polling.triage.map(({ candidates, ...source }) => ({
          ...source,
          candidates: null,
          held: candidates?.filter(candidate => candidate.outcome === 'held').length ?? 0,
        })),
      }
    : {};
/** Spec #68 (ticket #71): every Triage request in arrival order and the queue, metadata only. */
async function triageRequestsView(session: Session, capacity: number | null): Promise<TriageRequestsView> {
  const requests = await readTriageRequests(session);
  const holding = requests.flatMap(request => request.attempts ?? []).filter(holdsTriageCapacity);
  return {
    kind: 'triage-requests',
    capacity: { configured: capacity, investigating: holding.filter(attempt => !attempt.end).length, retained: holding.filter(attempt => attempt.end).length },
    impediments: requests.flatMap(request => [...triageImpediments(request), ...authorshipImpediments(request)]),
    requests,
    queue: requests.filter(request => request.state === 'queued').map(request => request.triage_request_id),
  };
}
/** Ticket #75: the investigation desk when the Triage ports, the access and the polling are all composed; a desk that does nothing otherwise. */
function triageInvestigations(
  options: { triage?: TriagePorts | undefined; access?: AccessDependencies | undefined },
  session: Session,
  poller: { repositoryId(repository: string): number | undefined } | undefined,
  stopped: () => boolean,
): Pick<ReturnType<typeof createTriageInvestigations>, 'pass' | 'stop'> {
  if (!options.triage || !options.access || !poller) return { pass: async () => {}, stop: async () => {} };
  return createTriageInvestigations({
    session,
    access: options.access,
    ports: options.triage,
    paused: async () => (await readInstallation(session)).paused,
    stopped,
    repositoryId: repository => poller.repositoryId(repository),
  });
}
/** Ticket #77: the ambiguous-authorship Impediment of a request, open only while it is still `publishing`. */
const authorshipImpediments = (request: TriageRequest): TriageAuthorshipImpediment[] =>
  request.state === 'publishing' && request.publication?.impediment
    ? [{ ...request.publication.impediment, scope: 'triage-request', triage_request_id: request.triage_request_id }]
    : [];
/** Ticket #77: the publication desk with the publisher of each tracker (ticket #78 adds Jira's); a desk that does nothing without polling or without a source with Triage. */
function triagePublications(access: AccessDependencies | undefined, session: Session, polling: boolean, stopped: () => boolean) {
  // Without a `triage` block in some source no request is live (the sweep abandons them), so the pass has nothing to read.
  if (!access || !polling || !access.sources?.some(source => source.triage)) return { pass: async () => {} };
  const paused = async () => (await readInstallation(session)).paused;
  return createTriagePublications({ session, stopped, paused, publishers: { github: githubTriagePublisher(access) } });
}
const pollingJira = (options: { access?: AccessDependencies | undefined; polling?: PollingOptions | undefined }) =>
  options.polling ? options.access?.trackers?.jira : undefined;

/** Jira ticket 10: each configured Jira source, through its own adapter (a read of the account's project permissions; never on YAML v1). */
async function jiraAccessResults(access: AccessDependencies) {
  const jiraResults = [];
  const jira = access.trackers?.jira;
  for (const source of access.sources ?? [])
    if (source.tracker === 'jira' && jira)
      jiraResults.push(await jira.checkAccess({ tracker: 'jira', siteId: source.siteId, url: source.url, projectId: source.projectId, label: source.label }));
  return jiraResults;
}
/** The retention desk reads the injected calendar when one is composed (its own clock otherwise). */
const retentionClock = (options: { execution?: ExecutionPorts | undefined }) =>
  options.execution?.calendar ? { now: () => options.execution!.calendar!.now() } : {};

/** Bootstrap must already hold the stable canonical-storage flock for this owner's entire lifetime. */
export async function openControl(options: {
  storagePath: string;
  /** Host inventory of own runtime resources taken after the lock (ticket 26). `empty`/`unknown` are the coarse legacy forms. */
  runtimeInventory: 'empty' | 'unknown' | RuntimeInventory;
  access?: AccessDependencies;
  polling?: PollingOptions;
  /** Execution boundaries (sandbox lifecycle, Workers activation, Builder credentials). Absent: dispatch stays closed (EXECUTION_NOT_ENABLED). */
  execution?: ExecutionPorts;
  /** Spec #68 (ticket #75): what composes a Triager attempt. Absent: Triage requests are created and queued, never investigated. */
  triage?: TriagePorts;
}): Promise<Control> {
  // Closed before any storage open; this increment exposes no dispatch, task, or external-effect entrypoint.
  let dispatchReason: DispatchReason | null = 'RECONCILIATION_REQUIRED';
  const controller_run_id = randomUUID();
  const store = await openStore(options.storagePath);
  const state = store.session;
  try {
    await initialize(state);
    await initializeSlots(state);
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
  let dispatcher: ReturnType<typeof createDispatcher> | undefined;
  let stopped = false;
  let recovery: RecoveryView | null = null;
  const calendar = options.execution?.calendar ?? { now: () => Date.now() };
  // v2 (V2-04): a Work whose pinned declaration requires a capability the installation's sandbox does not declare never starts. Derived at
  // each read from the pin and the declared capabilities (both fixed for this run), never stored: no fallback, nothing prepared on a guess.
  const capabilityGate = (work: WorkRecord): Impediment | null => {
    if (work.result !== 'open' || work.environment?.state !== 'pinned') return null;
    const missing = missingCapabilities(work.environment.pin.declaration, options.execution?.sandbox.capabilities);
    return missing.length ? { ...capabilityImpediment(missing, { repository: work.repository.repository }), since: work.environment.pinnedAt } : null;
  };
  // Boot facts of THIS run (ticket 26): a repository whose host Git cache was being prepared stays blocked (a fetch/clone may still run).
  const runBlockers = (work: WorkRecord): string[] => [
    ...(recovery?.cachePreparing.includes(work.repository.repositoryId) ? ['CACHE_RECONCILIATION_REQUIRED'] : []),
    ...(backoffRunning(work, calendar.now()) ? ['RECOVERY_BACKOFF'] : []),
    ...(bootDeferralRunning(work, calendar.now()) ? ['BOOT_CAPACITY_WAIT'] : []),
    ...(capabilityGate(work) ? [sandboxCapabilityImpediment] : []),
  ];
  const configuredRepository = (repository: string) => options.access?.repositories.find(scope => scope.repository.toLowerCase() === repository.toLowerCase());
  // Question publication and answer ingestion need the tracker; they run whatever the dispatch barrier (no spawn involved).
  const jiraTracker = pollingJira(options);
  const jiraLinks = jiraTracker ? createJiraLinkDesk({ session: state, tracker: jiraTracker, stopped: () => stopped }) : undefined;
  const desk =
    options.access && options.polling
      ? createQuestionDesk({
          session: state,
          tracker: options.access.tracker,
          operators: options.access.operators ?? [],
          readWorks: () => readWorks(state),
          stopped: () => stopped,
        })
      : undefined;
  // Jira ticket 06: answers (and guidance) read from the origin Card of each Jira Work; publication goes through the Jira source round below.
  // Jira ticket 07: an accepted `/factory cancel` is interrupted like the local `cancel` (credentials first, then stop), after its commit.
  const jiraInputs = jiraTracker
    ? createJiraInputDesk({
        session: state,
        tracker: jiraTracker,
        readWorks: () => readWorks(state),
        stopped: () => stopped,
        cancelled: work_id => {
          void dispatcher?.cancel(work_id).catch(() => {});
        },
      })
    : undefined;
  const poller =
    options.access && options.polling
      ? createPoller({
          access: options.access,
          intervalSeconds: options.polling.intervalSeconds,
          clock: options.polling.clock ?? systemClock,
          paused: async () => (await readInstallation(state)).paused,
          indexed: ticket => indexedWork(state, ticket),
          admit: evidence => admitTicket(state, evidence, configuredRepository(evidence.repository.repository) ?? {}),
          pending: repositoryId => pendingWorks(state, repositoryId),
          pendingJira: source => pendingJiraWorks(state, source),
          // Jira ticket 05: notices on the Card for this round's evaluated Cards (needs the Jira adapter; none composed = nothing to tell).
          noticeImpediments: async (source, candidates) => {
            const tracker = options.access?.trackers?.jira;
            if (!tracker) return;
            // Jira ticket 06: Questions of Jira Works get their comment intent first, then ONE desk pass posts/reconciles every purpose.
            await prepareJiraQuestions(state, () => readWorks(state));
            await noticeJiraImpediments({
              session: state,
              tracker,
              source,
              evaluation: { kind: 'candidates', candidates },
              stopped: () => stopped,
              // Jira ticket 09: delivery notices share the single comment desk pass (posted/reconciled whatever the Work's result or cleanup).
              owners: { ...jiraConversationOwners, delivery: jiraDeliveryOwner },
            });
          },
          presentation: async (work_id, fresh) => {
            const current = await readWork(state, work_id);
            if (current?.ticket.tracker === 'jira' && (current.ticket.key !== fresh.key || current.ticket.url !== fresh.url))
              await recordTicketPresentation(state, work_id, fresh);
          },
          ownCycles: issueIds => ownCycles(state, issueIds),
          record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation),
          recordEnvironment: (work_id, observation) => recordEnvironment(state, work_id, observation),
          triage: createTriageDiscovery({ session: state, access: options.access }),
          // Ticket 15: required-checks tracking after the dispatch tick (off its critical path), whatever the dispatch barrier or pause.
          // Ticket 16: readiness after the checks explanation (its evidence), whatever the pause (tracking, not a new trigger).
          afterCycle: async () => {
            await delivery?.cycle().catch(() => {});
            await retention?.cycle().catch(() => {});
            await cycles?.cycle().catch(() => {});
            await desk?.cycle();
            await jiraInputs?.pass();
            // Jira ticket 08: the Works' links on their Cards (latest desired state, upsert by globalId), whatever the Work's result or cleanup.
            await jiraLinks?.pass().catch(() => {});
            // Ticket 23: human feedback of the own PRs is recorded before the tick (whatever the Work is doing; recording is never delivery).
            await feedback?.pass().catch(() => {});
            if (dispatchReason === null) await dispatcher?.tick();
            await afterTick();
          },
        })
      : undefined;
  const tracking = new AbortController();
  const checks =
    options.access && options.polling
      ? createChecksTracker({
          session: state,
          access: options.access,
          readWorks: () => readWorks(state),
          busy: work_id => dispatcher?.active(work_id) ?? false,
          clock: options.polling.clock ?? systemClock,
          minIntervalMs: options.polling.intervalSeconds * 1000,
        })
      : undefined;
  const readiness =
    options.access && options.polling
      ? createReadinessDesk({
          session: state,
          access: options.access,
          readWorks: () => readWorks(state),
          installation: () => (dispatchReason === 'RECONCILIATION_REQUIRED' ? 'reconciliation-required' : 'settled'),
          dependencies: {
            ownCycles: issueIds => ownCycles(state, issueIds),
            record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation, { published: true }),
          },
          clock: options.polling.clock ?? systemClock,
          minIntervalMs: options.polling.intervalSeconds * 1000,
        })
      : undefined;
  const feedback =
    options.access && options.polling && options.access.repository.readFeedback
      ? createFeedbackDesk({
          session: state,
          repository: options.access.repository,
          operators: options.access.operators ?? [],
          repo: configuredRepository,
          readWorks: () => readWorks(state),
          stopped: () => stopped,
        })
      : undefined;
  // Ticket 22: repairs need the execution boundaries (a correction is only useful if a Builder can run it).
  const repair =
    options.access && options.polling && options.execution
      ? createRepairDesk({
          session: state,
          readWorks: () => readWorks(state),
          busy: work_id => dispatcher?.active(work_id) ?? false,
          limits: configuredRepository,
        })
      : undefined;
  // Spec #68 §6-§7 (ticket #75): queued Triage requests are investigated by a Triager when the Triage ports are composed.
  const investigations = triageInvestigations(options, state, poller, () => stopped);
  // Spec #68 §8 (ticket #77): a recorded Verdict is published on its Ticket, whether or not this run can investigate (a release that
  // restarts with requests in `publishing` completes them). Ticket #78 adds the Jira publisher here.
  const publications = triagePublications(options.access, state, poller !== undefined, () => stopped);
  // Ticket 15/16: checks and readiness after the dispatch tick (off its critical path).
  const afterTick = async () => {
    await investigations.pass().catch(() => {});
    await publications.pass().catch(() => {});
    await checks?.pass(tracking.signal).catch(() => {});
    await readiness?.pass(tracking.signal).catch(() => {});
    // Ticket 22: effective impediments of the latest explanation become the Work's correction (selected by the NEXT tick, revalidated first).
    await repair?.pass(tracking.signal).catch(() => {});
  };
  if (options.execution && options.access && poller)
    dispatcher = createDispatcher({
      session: state,
      access: options.access,
      ports: options.execution,
      currentAttempt: work => poller.currentAttempt(work),
      readWorks: () => readWorks(state),
      ownCycles: issueIds => ownCycles(state, issueIds),
      record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation),
      paused: async () => (await readInstallation(state)).paused,
      heldSlots: () => heldSlots(state),
      questionRecorded: () => desk?.kick(),
      controllerRunId: controller_run_id,
      runBlockers,
      authorizationWithdrawn: (work_id, codes) => recordAuthorization(state, work_id, { kind: 'withdrawn', codes }),
    });
  // Ticket 25: authorization tracking of open Works and the reopen effects, before the dispatcher tick (a withdrawal observed now blocks it).
  const cycles =
    options.access && options.polling
      ? createCycleDesk({ session: state, access: options.access, readWorks: () => readWorks(state), stopped: () => stopped })
      : undefined;
  // Ticket 17: delivery observation and owned cleanup, in the same owner loop (tracking reads run whatever the dispatch barrier; cleanup
  // itself revalidates cessation per Work). Before the dispatcher tick, so a merge observed now is never followed by a new activation.
  const delivery =
    options.access && options.polling
      ? createDeliveryDesk({
          session: state,
          repository: options.access.repository,
          repositories: options.access.repositories,
          cleanup: options.execution?.cleanup,
          running: work_id => dispatcher?.running(work_id) ?? false,
          interrupt: async work_id => dispatcher?.interruptDelivered(work_id),
          readWorks: () => readWorks(state),
          stopped: () => stopped,
          protections: async work =>
            retentionProtections(work, { running: dispatcher?.running(work.work_id) ?? false, questions: await readQuestions(state, work) }),
        })
      : undefined;
  // Ticket 30: detail retention (boot sweep after the reconciliation, then daily) and explicit cleanup plans, after the resource cleanup.
  const retention =
    options.access && options.polling
      ? createRetentionDesk({
          session: state,
          storage: store,
          details: options.execution?.cleanup?.details,
          repositories: options.access.repositories,
          days: options.execution?.cleanup?.retentionDays,
          sweepSeconds: options.execution?.cleanup?.sweepSeconds,
          readWorks: () => readWorks(state),
          readQuestions: work => readQuestions(state, work),
          running: work_id => dispatcher?.running(work_id) ?? false,
          settled: () => dispatchReason !== 'RECONCILIATION_REQUIRED',
          stopped: () => stopped,
          ...retentionClock(options),
        })
      : undefined;
  /** Facts of an explicit cleanup plan/confirmation, read just before its commit (inventory included). */
  const cleanupFacts = async (work_id: string): Promise<(work: WorkRecord) => PlanFacts> => {
    const work = await readWork(state, work_id);
    const questions = work ? await readQuestions(state, work) : [];
    const details = options.execution?.cleanup?.details;
    const inventory: DetailInventory | null = details ? await details.list({ workId: work_id }).catch(() => null) : null;
    const running = dispatcher?.running(work_id) ?? false;
    return current => {
      const configured = configuredRepository(current.repository.repository) !== undefined;
      return {
        running,
        questions,
        inventory,
        repositoryConfigured: configured,
        plannedResources: plannedResourcesOf(current, planCleanup(current, { repositoryConfigured: configured }).resources),
      };
    };
  };
  /** Ticket 31: facts of a forget plan/confirmation (the Records tree inspected just before its commit; Questions are read inside it). */
  const forgetFacts = async (work_id: string) => {
    const details = options.execution?.cleanup?.details;
    const tree = details?.inspectTree ? await details.inspectTree({ workId: work_id }).catch(() => null) : null;
    const running = dispatcher?.running(work_id) ?? false;
    return (current: WorkRecord) => ({ running, tree, repositoryConfigured: configuredRepository(current.repository.repository) !== undefined });
  };
  const pollingView = (): PollingView =>
    poller?.view() ?? { state: 'disabled', intervalSeconds: null, cycles: 0, lastCycleAt: null, source: 'in-memory-observation', repositories: [] };
  // Work-level reasons preventing a start now; the dependency evaluation must belong to the repository's current polling round.
  const blockers = (work: WorkRecord) => [
    ...dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies.latest, currentAttempt: poller?.currentAttempt(work) ?? null }),
    ...runBlockers(work),
  ];
  const present = (work: WorkRecord, paused: boolean): WorkView => {
    const capability = capabilityGate(work);
    const impediments: Impediment[] = [
      ...work.impediments,
      ...(capability ? [capability] : []),
      ...(paused
        ? [{ code: 'GLOBAL_PAUSE', scope: 'installation' as const, nextStep: 'Unpause to allow new triggers; unpausing removes no individual impediment.' }]
        : []),
    ];
    // A Question wait whose boot ceased occupies nothing: the Work shows its queue blockers (QUESTION_PENDING...), not "executing".
    // Likewise an ended, ceased Execution whose Work is pending again (correction/recovery/timeout): its queue blockers are shown.
    const waiting = work.execution?.state === 'ended' && !work.execution.slot.held && (work.execution.end?.outcome === 'question' || work.queue.pending);
    const execution = work.execution && work.execution.state !== 'released' && !waiting ? work.execution : null;
    const reasons = [...(execution ? [] : blockers(work)), ...(dispatchReason ? [dispatchReason] : []), ...(paused ? ['GLOBAL_PAUSE'] : [])];
    const deferral = reasons.includes('BOOT_CAPACITY_WAIT') ? (work.bootDeferral ?? null) : null;
    return {
      ...work,
      impediments,
      dispatch: {
        state: execution ? 'executing' : reasons.length ? 'held' : 'eligible',
        reasons,
        ...(deferral
          ? {
              capacityWait: {
                code: deferral.code,
                cause: deferral.detail ?? null,
                notBefore: deferral.notBefore,
                waitSeconds: deferral.waitSeconds,
                attempt: deferral.attempt,
              },
            }
          : {}),
      },
      limits: limitsOf(work, impediments),
    };
  };
  // Presentation of limits/reservations/consumption, timeout, duration (live monotonic when THIS process runs it) and the action required.
  const limitsOf = (work: WorkRecord, impediments: Impediment[]): LimitsView => {
    const execution = work.execution;
    const live = execution ? (dispatcher?.liveElapsed(execution.executionId) ?? null) : null;
    const timing = execution?.timing ?? null;
    return {
      corrections: work.budget ? counterView(work.budget.corrections) : null,
      recoveries: work.budget ? counterView(work.budget.recoveries) : null,
      continuations: work.budget
        ? counterView(work.budget.continuations ?? { limit: defaultLimits.continuations, granted: 0, consumed: 0, reserved: null })
        : null,
      grants: work.budget?.grants.length ?? 0,
      timeout: {
        seconds: timing ? timing.timeoutSeconds : (configuredRepository(work.repository.repository)?.timeoutSeconds ?? null),
        scope: 'per-execution',
        reached: timing?.timeout ?? null,
        overrun: timing?.overrun ?? null,
      },
      duration: durationView(timing, live === null ? null : { elapsedMs: live }),
      actions: impediments.map(item => ({ code: item.code, nextStep: item.nextStep })),
    };
  };
  // Ticket 22 (spec §4.3): repairs first, FIFO in each category; impeded Works are skipped without losing their position.
  const selection = (works: WorkRecord[]) =>
    selectNext(
      queueOrder(works.filter(work => work.result === 'open' && work.queue.pending)).map(work => ({ work_id: work.work_id, blockers: blockers(work) })),
    );
  const queued = (works: WorkRecord[], category: 'normal' | 'repair') =>
    queueOrder(works.filter(work => work.queue.pending && work.queue.category === category)).map(work => work.work_id);
  // Ticket 29 (spec §12.1): global impediments by code and non-token consumption, from the authority (tokens/cost: `usage`).
  const consumptionOf = (works: WorkRecord[]): Pick<ControlStatus, 'impediments' | 'consumption'> => {
    const open = works.filter(work => work.result === 'open');
    const codes: Record<string, number> = {};
    for (const work of open) for (const item of work.impediments) codes[item.code] = (codes[item.code] ?? 0) + 1;
    const executions = works.flatMap(work => executionsOf(work));
    let measuredMs = 0,
      lowerBoundMs = 0,
      unknown = 0;
    for (const execution of executions) {
      const duration = execution.timing?.duration;
      if (duration?.kind === 'measured') measuredMs += duration.elapsedMs;
      else if (duration?.kind === 'lower-bound') lowerBoundMs += duration.provenMs;
      else if (execution.start) unknown++;
    }
    const sum = (key: 'corrections' | 'recoveries') => ({
      consumed: works.reduce((total, work) => total + (work.budget?.[key].consumed ?? 0), 0),
      reserved: works.filter(work => work.budget?.[key].reserved).length,
    });
    return {
      impediments: { works: open.filter(work => work.impediments.length > 0).length, codes },
      consumption: {
        executions: { total: executions.length, active: executions.filter(item => item.slot.held).length },
        corrections: sum('corrections'),
        recoveries: sum('recoveries'),
        time: {
          measuredMs,
          lowerBoundMs,
          unknown,
          measurement: executions.length === 0 ? 'unavailable' : unknown === 0 && lowerBoundMs === 0 ? 'complete' : 'partial',
        },
        usage: { query: 'usage' },
      },
    };
  };
  // Ticket 29: a big Work stays inspectable — the full view when it fits one frame, else compacted (history/earlier Executions/questions
  // left out with the paged commands that show them) and `chain.executions` paged by cursor/limit.
  const fitShow = (
    view: Extract<ShowView, { kind: 'work' }>,
    query: { cursor?: number | undefined; limit?: number | undefined },
  ): Extract<ShowView, { kind: 'work' }> => {
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    // In-process callers (no page argument) get the full view; the socket always pages (`answerInspection`), compacting only what does not fit.
    const paging = query.cursor !== undefined || query.limit !== undefined;
    if (!paging || (query.cursor === undefined && bytes(view) <= viewBudgetBytes)) return view;
    const id = view.work.work_id;
    const nextSteps = [
      `factory history ${id} --limit 50`,
      `factory show ${id} --cursor <n> --limit <n>`,
      ...view.questions.map(item => `factory question ${item.questionId}`),
    ];
    const compact = { ...view, work: compactWork(view.work) };
    const questions = bytes(compact) > viewBudgetBytes / 2 ? [] : view.questions;
    const base = { ...compact, questions, chain: { ...view.chain, executions: [] } };
    const paged = page(view.chain.executions, view.chain.executions.length, { cursor: query.cursor, limit: query.limit ?? inspectionLimits.maxPage });
    const fitted = fitPage(
      paged.items,
      paged.page,
      items => bytes(items),
      viewBudgetBytes - bytes(base) - 1024,
      item => ({ ...item, reviews: [] }),
    );
    return {
      ...base,
      chain: { ...view.chain, executions: fitted.items },
      omitted: {
        history: view.work.history.length,
        previousExecutions: view.work.previousExecutions.length,
        questions: view.questions.length - questions.length,
        executions: fitted.page,
        nextSteps,
      },
    };
  };
  /** `access` diagnostics, in memory only: no token or issuer result enters a durable task/commit. */
  const accessDiagnostics = async (): Promise<AccessView> => {
    if (!options.access) throw new Error('AUTHENTICATED_DIAGNOSTICS_UNAVAILABLE');
    const results = [];
    // In-memory observations only: no token or issuer result enters a durable task/commit.
    for (const repo of options.access.repositories)
      results.push({
        tracker: await options.access.tracker.checkAccess(repo),
        repository: await options.access.repository.checkAccess(repo, repo.base),
      });
    const dependencyResults = [];
    for (const repo of options.access.dependencyRepositories ?? [])
      dependencyResults.push(await options.access.tracker.checkAccess({ ...repo, role: 'dependency-only' }));
    const jiraResults = await jiraAccessResults(options.access);
    return { kind: 'access', scope: 'authenticated', results, dependencyResults, ...(jiraResults.length ? { jiraResults } : {}) };
  };
  /** One Question by identity; a Question of a forgotten Work is reported as forgotten, never as unknown. */
  const questionView = async (question_id: string): Promise<QuestionQueryView> => {
    if (!workIdSchema.safeParse(question_id).success) throw new Error('INVALID_QUESTION_ID');
    const question = await readQuestion(state, question_id);
    if (question) return { kind: 'question', question };
    // Ticket 31 (review LOW): a Question of a forgotten Work is gone with its history; it is never reported as unknown.
    const owner = question ? undefined : (await readForgotten(state)).find(item => item.questions?.includes(question_id));
    if (owner)
      return {
        kind: 'question-forgotten',
        question_id,
        work_id: owner.work_id,
        nextStep: `This Question belonged to Work ${owner.work_id}, whose history \`forget\` deleted at ${owner.forgottenAt}: its text and answer are not recoverable.`,
      };
    return { kind: 'question-not-found', question_id, nextStep: 'No Question with this identity; use `factory show <work>`.' };
  };
  let running = false;
  // Ticket 33: how the previous run of this storage ended, read when THIS run records its start (null before that or when never recorded).
  let previousRun: ControlStatus['storage']['previousRun'] = null;
  const control: Control = {
    async accept(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'INVALID_COMMAND' };
      // Local CLI under the administrator account's trust; correlation/single answer are checked in the commit.
      // Ticket 11: recorded for the next safe activation; never delivered to a running Builder, never a launch.
      if (parsed.data.operation === 'update-scope') return acceptScopeUpdate(state, parsed.data);
      if (parsed.data.operation === 'authorize-readiness') return acceptReadinessAuthorization(state, parsed.data);
      // Ticket 23: recorded for the next safe activation (accepted / deferred / already covered / refused); never a launch.
      if (parsed.data.operation === 'repair')
        return acceptRepairRequest(state, {
          request_id: parsed.data.request_id,
          work_id: parsed.data.work_id,
          reason: parsed.data.reason,
          origin: { kind: 'local-cli' },
        });
      // Ticket 61: recorded for the next discovery pass (which re-reads the remote); never a publication or an adoption.
      if (parsed.data.operation === 'reevaluate-publication') return acceptPublicationReevaluation(state, parsed.data);
      if (parsed.data.operation === 'answer')
        return acceptAnswer(state, {
          request_id: parsed.data.request_id,
          question_id: parsed.data.question_id,
          text: parsed.data.text,
          origin: { kind: 'local-cli' },
        });
      if (parsed.data.operation === 'grant') return grantBudget(state, parsed.data, configuredRepository);
      if (parsed.data.operation === 'cancel') {
        const receipt = await acceptCancel(state, parsed.data);
        // The prohibition is durable; the interruption (credentials first, then stop) proceeds after the ACK, never proved by it.
        if (receipt.kind === 'durable' && receipt.outcome === 'accepted') void dispatcher?.cancel(parsed.data.work_id).catch(() => {});
        return receipt;
      }
      if (parsed.data.operation === 'resume') return acceptResume(state, parsed.data, { running: work_id => dispatcher?.running(work_id) ?? false });
      // Ticket 30: the plan never removes anything; the confirmation is executed by the desks after the ACK (revalidated per item).
      if (parsed.data.operation === 'cleanup-plan') return acceptCleanupPlan(state, parsed.data, await cleanupFacts(parsed.data.work_id));
      if (parsed.data.operation === 'cleanup-confirm') return acceptCleanupConfirm(state, parsed.data, await cleanupFacts(parsed.data.work_id));
      // Ticket 31: the plan deletes nothing; a confirmed plan is executed by the retention desk after the ACK (revalidated again in its intent).
      if (parsed.data.operation === 'forget-plan') return acceptForgetPlan(state, parsed.data, await forgetFacts(parsed.data.work_id));
      if (parsed.data.operation === 'forget-confirm') return acceptForgetConfirm(state, parsed.data, await forgetFacts(parsed.data.work_id));
      if (parsed.data.operation === 'reopen') return acceptReopen(state, parsed.data);
      // Without GitHub access no fresh Ticket read is possible: the request is recorded as not applied (AUTHORIZATION_READ_UNAVAILABLE).
      if (parsed.data.operation === 'new')
        return acceptNewCycle(state, parsed.data, {
          configured: configuredRepository,
          tracker: options.access?.tracker ?? { readTicket: () => Promise.reject(new Error('TRACKER_NOT_COMPOSED')) },
        });
      return acceptPauseCommand(state, parsed.data);
    },
    async inspect(query) {
      // Jira ticket 05: the Jira notice documents are read first (absent ones are loaded from storage), awaited with the rest of the status.
      const jiraNotices =
        query.kind === 'status'
          ? jiraNoticeStatus(state).then(
              value => ({ value }),
              (error: unknown) => ({ error }),
            )
          : null;
      const linkStatus =
        query.kind === 'status'
          ? jiraLinkStatus(state).then(
              value => ({ value }),
              (error: unknown) => ({ error }),
            )
          : null;
      if (query.kind === 'access') return accessDiagnostics();
      if (query.kind === 'request') {
        if (!requestId.safeParse(query.request_id).success) throw new Error('INVALID_REQUEST_ID');
        return { kind: 'request', receipt: await readRequest(state, query.request_id) };
      }
      if (query.kind === 'question') return questionView(query.question_id);
      // Ticket 29: history, logs, one log page and consumption (read-only; logs/usage through the injected Records/Workers observation ports).
      if (query.kind === 'history' || query.kind === 'logs' || query.kind === 'log' || (query.kind === 'usage' && query.work_id !== undefined)) {
        const id = query.work_id!;
        if (!workIdSchema.safeParse(id).success) throw new Error('INVALID_WORK_ID');
        const work = await readWork(state, id);
        // Ticket 31: a forgotten Work answers with its minimal memory (its history, logs and sessions were deleted), never "not found".
        const forgotten = work ? undefined : await readForgottenWork(state, id);
        if (forgotten)
          return {
            kind: 'work-forgotten',
            work_id: id,
            memory: forgotten,
            notRecoverable: [...forgottenNotRecoverable],
            nextStep: forgottenNextStep(forgotten),
          };
        if (!work) return { kind: 'work-not-found', work_id: id, nextStep: 'No Work with this identity in the controller authority; use `factory list`.' };
        if (query.kind === 'history') return inspectHistory(work, query);
        if (query.kind === 'logs') return inspectLogs(work, query, options.execution);
        if (query.kind === 'log') return inspectLog(work, query, options.execution);
        return inspectUsage([work], 'work', options.execution, { capacity: options.execution?.capacity ?? 0, held: await heldSlots(state) }, calendar.now());
      }
      if (query.kind === 'usage') {
        const usage = await inspectUsage(
          await readWorks(state),
          'installation',
          options.execution,
          { capacity: options.execution?.capacity ?? 0, held: await heldSlots(state) },
          calendar.now(),
          { cursor: query.cursor, limit: query.limit },
        );
        // Ticket 31: forgotten Works keep no usage; the installation total covers only the Works still remembered.
        const forgotten = (await readForgotten(state)).length;
        return forgotten
          ? { ...usage, limitations: [...usage.limitations, `${forgotten} Work(s) forgotten: their usage is not recoverable and not in this total.`] }
          : usage;
      }
      const current = await readInstallation(state);
      if (query.kind === 'show') {
        if (!workIdSchema.safeParse(query.work_id).success) throw new Error('INVALID_WORK_ID');
        const work = await readWork(state, query.work_id);
        const forgotten = work ? undefined : await readForgottenWork(state, query.work_id);
        if (forgotten)
          return {
            kind: 'work-forgotten',
            work_id: query.work_id,
            memory: forgotten,
            notRecoverable: [...forgottenNotRecoverable],
            nextStep: forgottenNextStep(forgotten),
          };
        if (!work)
          return { kind: 'work-not-found', work_id: query.work_id, nextStep: 'No Work with this identity in the controller authority; use `factory list`.' };
        // Jira ticket 04: a Jira Work was last polled by its ORIGIN source round, not by its destination repository's.
        const view = pollingView();
        const polled =
          work.ticket.tracker === 'jira'
            ? view.sources?.find(
                source =>
                  work.ticket.tracker === 'jira' &&
                  source.siteId === work.ticket.siteId &&
                  work.authorization.source === 'jira-rest' &&
                  source.projectId === work.authorization.basis.projectId,
              )
            : view.repositories.find(repo => repo.repository.toLowerCase() === work.repository.repository.toLowerCase());
        const lastPolled =
          [...view.repositories, ...(view.sources ?? [])]
            .flatMap(repo => repo.candidates ?? [])
            .find(candidate => ticketKey(candidate.ticket) === ticketKey(work.ticket)) ?? null;
        const questions = await readQuestions(state, work);
        const chain = chainOf(work, questions, {
          ageSeconds: at => {
            const time = at ? Date.parse(at) : Number.NaN;
            return Number.isFinite(time) ? Math.max(0, Math.round((calendar.now() - time) / 1000)) : null;
          },
          timeoutSeconds: configuredRepository(work.repository.repository)?.timeoutSeconds ?? null,
          lastPolledAt: lastPolled?.observedAt ?? null,
          lastPolledCompleteness: lastPolled ? (polled?.completeness ?? null) : null,
        });
        return fitShow({ kind: 'work', work: present(work, current.paused), lastPolled, questions, chain, omitted: null }, query);
      }
      const works = await readWorks(state);
      if (query.kind === 'list') {
        const view: ListView = {
          kind: 'list',
          paused: current.paused,
          dispatch: dispatchReason ? 'closed' : 'open',
          dispatchReason,
          slots: { capacity: options.execution?.capacity ?? 0, held: await heldSlots(state) },
          works: [],
          queues: { normal: queued(works, 'normal'), repair: queued(works, 'repair') },
          selection: selection(works),
          polling: pollingView(),
          limitations,
          forgotten: await readForgotten(state),
          page: { cursor: 0, limit: works.length, returned: works.length, filtered: works.length, total: works.length, nextCursor: null, fitted: false },
        };
        // Ticket 29: without page arguments the full list (in-process callers); with them, one page fitted to one frame (the socket always pages).
        if (query.cursor === undefined && query.limit === undefined) return { ...view, works: works.map(work => present(work, current.paused)) };
        const paged = page(works, works.length, { cursor: query.cursor, limit: query.limit });
        const presented = paged.items.map(work => present(work, current.paused));
        const fitted = fitPage(
          presented,
          paged.page,
          items => Buffer.byteLength(JSON.stringify(items)),
          viewBudgetBytes - Buffer.byteLength(JSON.stringify(view)),
          compactWork,
        );
        return { ...view, works: fitted.items, page: fitted.page };
      }
      const polling = pollingView();
      const allQuestions = (await Promise.all(works.map(work => readQuestions(state, work)))).flat();
      const notices = async () => {
        const read = await jiraNotices!;
        if ('error' in read) throw read.error;
        return read.value;
      };
      const links = async () => {
        const read = await linkStatus!;
        if ('error' in read) throw read.error;
        return read.value;
      };
      return {
        controller_run_id,
        paused: current.paused,
        dispatch: dispatchReason ? 'closed' : 'open',
        dispatchReason,
        slots: { capacity: options.execution?.capacity ?? 0, held: await heldSlots(state) },
        historyLength: current.history.length,
        works: {
          total: works.length,
          open: works.filter(work => work.result === 'open').length,
          cancelled: works.filter(work => work.result === 'cancelled').length,
          closedUnmerged: works.filter(work => work.result === 'closed-unmerged').length,
        },
        delivery: {
          delivered: works.filter(work => work.result === 'delivered').length,
          cleanup: {
            waiting: works.filter(work => work.cleanup?.state === 'waiting').length,
            pending: works.filter(work => work.cleanup?.state === 'pending').length,
            complete: works.filter(work => work.cleanup?.state === 'complete').length,
          },
        },
        retention: {
          ...(retention?.view().status ?? { sweeps: 0, lastSweepAt: null, days: null }),
          works: {
            undelivered: works.filter(work => work.result !== 'delivered').length,
            retained: works.filter(work => (work.retention?.state ?? 'retained') === 'retained').length,
            protected: works.filter(work => work.retention?.state === 'protected').length,
            eligible: works.filter(work => work.retention?.state === 'eligible').length,
            expired: works.filter(work => work.retention?.state === 'expired').length,
          },
          details: {
            logs: sum(works, work => work.retention?.inventory?.logs),
            sessions: sum(works, work => work.retention?.inventory?.sessions),
            bytes: sum(works, work => work.retention?.inventory?.bytes),
          },
          removed: {
            logs: sum(works, work => work.retention?.removed.logs),
            sessions: sum(works, work => work.retention?.removed.sessions),
            bytes: sum(works, work => work.retention?.removed.bytes),
          },
          unsettled: sum(
            works,
            work =>
              work.retention?.removals.filter(item => item.outcome === 'indeterminate' || item.outcome === 'intended' || item.outcome === 'failed').length,
          ),
        },
        forgotten: await readForgotten(state).then(items => ({
          works: items.length,
          delivered: items.filter(item => item.result === 'delivered').length,
          cancelled: items.filter(item => item.result === 'cancelled').length,
          scrubPending: items.filter(item => item.scrub?.state !== 'scrubbed').length,
          note: items.length
            ? `${items.length} Work(s) forgotten: every other total and aggregate here covers only the Works still remembered, never the whole life of the installation.`
            : 'No Work forgotten: totals cover every admitted Work.',
        })),
        queues: { normal: queued(works, 'normal').length, repair: queued(works, 'repair').length },
        dependencies: {
          satisfied: works.filter(work => work.dependencies.latest?.conclusion === 'satisfied').length,
          pending: works.filter(work => work.dependencies.latest?.conclusion === 'pending').length,
          inconclusive: works.filter(work => work.dependencies.latest?.conclusion === 'inconclusive').length,
          notEvaluated: works.filter(work => !work.dependencies.latest).length,
        },
        questions: {
          open: allQuestions.filter(item => item.state === 'open').length,
          answered: allQuestions.filter(item => item.state === 'answered').length,
          unpublished: allQuestions.filter(item => item.state === 'open' && item.publication.state !== 'published').length,
        },
        selection: { next: selection(works).next },
        polling: {
          ...polling,
          repositories: polling.repositories.map(({ candidates: _candidates, ...repo }) => repo),
          ...(polling.sources ? { sources: polling.sources.map(({ candidates: _candidates, ...source }) => source) } : {}),
          ...triageStatus(polling),
        },
        persistence: store.persistence,
        recovery,
        storage: { format: currentFormat, previousRun },
        ...consumptionOf(works),
        ...(await notices()),
        ...(await links()),
      } satisfies ControlStatus;
    },
    async run(signal) {
      if (running) throw new Error('CONTROL_ALREADY_RUNNING');
      running = true;
      const loop = new AbortController();
      let polling: Promise<void> = Promise.resolve();
      try {
        // Authoritative persisted task inventory, not an empty fake scheduler. Unknown runtime resources stay closed.
        const tasks = await state.commit(tx => tx.scanTasks({}, 1), BACKGROUND_CONTEXT);
        const inventory = options.runtimeInventory;
        const decide = async () => {
          // Without a reconciliation (no execution boundaries to observe/stop with), every listed resource stays unreconciled: never free capacity.
          const unreconciled =
            typeof inventory === 'object' && !recovery
              ? [
                  ...inventory.unknown.map(item => `UNKNOWN_RESOURCE:${item}`),
                  ...inventory.environments.map(item => `ENVIRONMENT_NOT_RECONCILED:${item.environment}`),
                  ...inventory.cache.filter(item => item.state !== 'idle').map(item => `CACHE_NOT_RECONCILED:${item.repositoryId ?? 'unknown'}`),
                ]
              : [];
          const gate = dispatchGate({
            executionComposed: dispatcher !== undefined,
            inventory: typeof inventory === 'object' ? 'listed' : inventory,
            tasks: tasks.items.length,
            unknownResources: recovery?.global ?? unreconciled,
            orphanSlots: [],
          });
          // Without a reconciliation (inventory unknown, read-only inspection) a Slot still held from an earlier owner keeps dispatch closed.
          dispatchReason = gate.reason ?? (recovery === null && (await heldSlots(state)) > 0 ? 'RECONCILIATION_REQUIRED' : null);
          if (recovery && gate.closing.length) recovery = { ...recovery, global: gate.closing };
        };
        // Nothing to reconcile without execution boundaries: the gate is known at once (closed either way).
        if (!dispatcher) await decide();
        // Ticket 33: this run's start is durable before anything else of the run; a later crash leaves it without an end (never a clean stop).
        let started = false;
        if (!signal.aborted) {
          previousRun = await recordRunStart(state, controller_run_id);
          started = true;
        }
        // Grants of a previous process were memory-only: record them as impossible to revoke, with their risk (never blocks by itself).
        // Before polling starts, so no dispatch of this run precedes it. A run stopped before it starts (read-only inspection) writes nothing.
        if (!signal.aborted) await reconcileLostCredentials(state, isLiveCredentialExecution);
        // Durations measured by a previous process: proven lower bound + calendar estimate; overrun blocks when it cannot be excluded.
        if (!signal.aborted) await reconcileDurations(state, isLiveExecution);
        // Ticket 26 (spec §5.2 steps 3-5), barrier still closed: own survivors are stopped (not adopted), interrupted Executions settled from
        // durable evidence; only then the gate opens, unless unknown resources, tasks or orphan Slots keep the installation closed.
        if (!signal.aborted && dispatcher && options.execution && inventory !== 'unknown') {
          recovery = await reconcileBoot({
            session: state,
            ports: options.execution,
            controllerRunId: controller_run_id,
            inventory,
            live: isLiveExecution,
            ...(options.access ? { access: options.access } : {}),
          });
        }
        await decide();
        const aborted = new Promise<'stop'>(resolve => {
          if (signal.aborted) resolve('stop');
          else signal.addEventListener('abort', () => resolve('stop'), { once: true });
        });
        // Polling is tracking/admission only; it never dispatches. A durable-authority failure ends the owner as failed.
        if (poller) polling = poller.run(loop.signal);
        const outcome = await Promise.race([
          aborted,
          state.closed.then(() => 'closed' as const),
          ...(poller
            ? [
                polling.then(
                  () => 'polling-ended' as const,
                  () => 'polling-failed' as const,
                ),
              ]
            : []),
        ]);
        loop.abort();
        tracking.abort();
        stopped = true;
        await polling.catch(() => {});
        // An administrative stop is clean only after the confirmed cessation and persistence of every own activity (spec §11.4).
        const uncertain = (await dispatcher?.stop())?.uncertain ?? 0;
        await investigations.stop();
        await desk?.idle();
        // Ticket 33 + 26: ONE outcome (single source) for the run result and its durable end: clean only for a requested stop whose own
        // activities ticket 26's dispatcher stop confirmed ceased and persisted; otherwise `uncertain`. The intention to stop never makes an
        // interruption clean; the next boot reconciles it (26). This end is the LAST commit of the run.
        const kind = outcome !== 'stop' ? ('failed' as const) : uncertain ? ('uncertain' as const) : ('clean' as const);
        if (started) await recordRunEnd(state, controller_run_id, kind, { reconciled: recovery !== null });
        await state.close(BACKGROUND_CONTEXT);
        const end = await state.closed;
        return { kind: end.kind === 'closed' ? kind : 'failed' };
      } catch {
        loop.abort();
        tracking.abort();
        stopped = true;
        await polling.catch(() => {});
        await dispatcher?.stop().catch(() => {});
        await investigations.stop().catch(() => {});
        await desk?.idle().catch(() => {});
        await state.close(BACKGROUND_CONTEXT).catch(() => {});
        return { kind: 'failed' };
      }
    },
  };
  if (dispatcher) dispatchers.set(control, dispatcher);
  triggers.set(control, {
    correction: (work_id, reason) => openCorrection(state, work_id, reason, configuredRepository),
    recovery: (work_id, reason) => requestOperationalRecovery(state, work_id, reason, configuredRepository),
  });
  // Spec #68 (ticket #71): Triage requests are read beside the Work views, never through them.
  const inspectWorks = control.inspect;
  control.inspect = query => (query.kind === 'triage-requests' ? triageRequestsView(state, options.triage?.capacity ?? null) : inspectWorks(query));
  return control;
}
