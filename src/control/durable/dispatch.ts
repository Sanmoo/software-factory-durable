import { confirmedWithdrawal } from '../rules/cycles.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BuilderGrant } from '../../contracts/index.js';
import type { BootRef, EnvironmentRef } from '../../sandbox/index.js';
import type { ProposalIdentity, ReviewOpinion } from '../../contracts/index.js';
import type { HandoffEvent } from '../../workers/index.js';
import { classifyCapture, deliveryPrompt, exemptionPrompt, inheritedFindings, inheritedRounds, lastReviewed, planReviews, type CaptureClass, type ReviewPlan } from '../rules/review.js';
import { recordConclusion, recordDelivery, recordHandoff, recordReviewerEnd, recordReviewerStart, recordVerification } from './review.js';
import { carryBasis, carryPlan, carrySource, identityChange, preservedReviewContext, reviewerFailure, incorporable, retryDecision, reviewProfile, undiscovered, type CarryPlan } from '../rules/review-recovery.js';
import { recordNotRetried, recordReviewerRetry, releaseReviewerRetry } from './review-recovery.js';
import type { AccessDependencies, CredentialWithdrawal, DependencyEvaluation, ExecutionPorts, ExecutionView, FactoryAppIdentity } from '../types.js';
import { evaluateEntry } from '../rules/admission.js';
import { dispatchBlockers, selectNext, type OwnCycleFacts } from '../rules/dependencies.js';
import { evaluateWorkDependencies } from './polling.js';
import { readWork, type WorkRecord } from './admission.js';
import { admitExecution, interruptionBasis, beginRenewal, blockBeforeStart, confirmActivation, confirmStart, holdExecution, recordActivity, recordEnd, recordIssuance, recordPhase, recordRenewal, recordRevocation,
  recordRevocationIntent, recordTimeout, recordWorkerNotice, releaseAfterCessation, releaseBeforeStart, resumeBasis, stopRenewal, withdrawCredentials } from './execution.js';
import { systemClock } from './polling.js';
import { timeoutReached } from '../rules/budget.js';
import { intactRequest, readQuestion, readQuestions, recordContentLost, registerQuestion } from './questions.js';
import { pendingScope } from './scope.js';
import { recoveryPrompt, type KnownContext } from '../rules/questions.js';
import { continuationPrompt, initialPrompt, promptBudgetBytes, recoveryContext, scopeSection, sessionDecision } from '../rules/continuation.js';
import { attemptsOf, decideDiscovery, publicationAttempted, publicationPrompt, publicationResumes, publicationStep, type DiscoveryObservation } from '../rules/publication.js';
import { humanTips, authorizationInForce, comparisonBase, knownRemote, preservationTips, reconciliationNotice, reconciliationPrompt } from '../rules/divergence.js';
import { evaluatePublication, recordDiscovery, resolveDivergence } from './publication.js';
import { purposeOf } from './execution.js';
import type { SessionRef } from '../types.js';
import { interruptionRecoveryPrompt, isDiskRemedy, reviewerRetryLimitCode, refusedWithoutActivity } from '../rules/recovery.js';
import { budgetExhaustedCode, builderBudgetPolicy, stateSummary, type AnsweredQuestion, type SummaryInput } from '../rules/budget-continuation.js';
import { reconcileExecution } from './recovery.js';
import type { WorkerQuestion } from '../../workers/index.js';
import type { Session } from './store.js';
import { fingerprint, queueOrder, repairPreserve, repairSection, repairTriggers, observationDriven, updateTarget } from '../rules/repair.js';
import { observeRepair, recordRepairRevalidation } from './repair.js';
import { observeFeedback } from './feedback.js';
import { isHumanReason, undeliveredHuman } from '../rules/feedback.js';
import { checksTarget, recordChecks } from './checks.js';
import { evaluateChecks } from '../rules/checks.js';

export type DispatchObservation = { at: string; work_id: string | null; outcome: string; reasons: string[] };
const maxTimer = 2147483647;
/** Ticket 24 (review LOW): refused revalidations tolerated in ONE dispatch pass before it ends (each costs Ticket/graph reads). A refused
 * Work keeps its position, so as long as this many Works ahead keep being refused the ones behind wait: the cap bounds reads, not order. */
export const refusalsPerPass = 4;
/** Publish-only Builder policies (review HIGH 1): the same pack/budget/output policy, without the edit tool (and never the handoff). */
const publishOnly = (policies: ExecutionPorts['builder']): ExecutionPorts['builder'] => {
  const { editSourceMaxBytes: _edit, ...rest } = policies;
  return rest;
};
/** Ticket 21/18: the ONE remote token of the publish-only instruction and of the Builder push policy (same value, never two forms). */
/** The configured repository's URL (ticket 18: never the guest-writable `origin`). */
const publicationRemote = (repository: string) => `https://github.com/${repository}.git`;
/** Real run q21-human-v4: the authorization is `executing`, bound to exactly the previous (reconciliation) Execution, interrupted for a recovery. */
const reconciliationInterrupted = (work: WorkRecord, previous: ExecutionView) => {
  const authorization = work.publication ? authorizationInForce(work.publication) : null;
  const interruption = interruptionBasis(work);
  return Boolean(authorization && authorization.state === 'executing' && authorization.executionId === previous.executionId && interruption &&
    interruption.previousExecutionId === previous.executionId && previous.request.reconciliation?.divergenceId === authorization.divergenceId);
};
const codeOf = (error: unknown, fallback: string) => error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : fallback;
// Executions whose grants are held in THIS process's memory: boot reconciliation of another run/Control in-process never relabels them.
const liveExecutions = new Set<string>();
export const isLiveCredentialExecution = (executionId: string) => liveExecutions.has(executionId);
/** Executions measured by THIS process (credentials and duration evidence of another process are reconciled at boot, never these). */
export const isLiveExecution = isLiveCredentialExecution;

/**
 * Credential lifecycle of ONE active Execution (spec §8/§8.1, ticket 20), held in the memory of its execution task only. Renewal is a NEW
 * `issue` after the durable revalidation commit, delivered with `Workers.deliver` before expires_at; the wait for it is a deadline inside
 * the Execution's existing task (no scheduler/broker). Withdrawal stops new deliveries/renewals and makes ONE revocation attempt per known
 * grant; outcomes are recorded distinctly and never claim cessation.
 */
function credentialLifecycle(deps: { session: Session; ports: ExecutionPorts; work_id: string; executionId: string; repositoryConfigured(): boolean;
  context: Parameters<ExecutionPorts['credentials']['issue']>[0]; stopping: AbortSignal }) {
  const { session, ports, work_id, executionId } = deps;
  const margin = Math.max(0, (ports.credentialRenewal?.beforeExpirySeconds ?? 600) * 1000);
  const known: { ref: 'initial' | number; grant: BuilderGrant; revoked: boolean }[] = [];
  const withdrawn = new AbortController();
  let current: BuilderGrant | undefined;
  let worker: string | undefined;
  let issuing: Promise<unknown> | undefined;
  let renewing: Promise<boolean> | undefined;
  let withdrawing: Promise<void> | undefined;
  let renewal = true;
  const notify = async () => {
    if (!worker) return;
    const result = await ports.workers.deliver(worker, { kind: 'withdraw-credential' }).catch(() => ({ status: 'failure' as const, code: 'CREDENTIAL_WITHDRAWAL_UNCERTAIN' }));
    await recordWorkerNotice(session, work_id, executionId, result.status === 'failure' ? result.code : result.status).catch(() => {});
  };
  const revoke = async (entry: (typeof known)[number]) => {
    if (entry.revoked) return;
    entry.revoked = true; // one attempt per grant; never repeated automatically
    // Durable intent BEFORE the request: a crash meanwhile is later reported as attempted with unknown outcome, not as a lost value.
    await recordRevocationIntent(session, work_id, executionId, entry.ref).catch(() => {});
    const result = await ports.credentials.revoke(entry.grant).catch(() => ({ kind: 'unknown' as const, code: 'REVOCATION_CALL_FAILED', nextStep: 'Revocation call failed; outcome unknown.' }));
    await recordRevocation(session, work_id, executionId, entry.ref, result).catch(() => {});
  };
  const stop = async (code: string) => { renewal = false; await stopRenewal(session, work_id, executionId, code).catch(() => {}); };

  async function renew(): Promise<boolean> {
    const begun = await beginRenewal(session, work_id, executionId, { repositoryConfigured: deps.repositoryConfigured() });
    if (begun.kind !== 'begun') { if (!withdrawn.signal.aborted) await stop(`RENEWAL_REFUSED_${begun.reasons[0]}`); return false; }
    // A withdrawal or owner stop that began while the intent was committed: nothing is issued.
    if (withdrawn.signal.aborted || deps.stopping.aborted) {
      await recordRenewal(session, work_id, executionId, begun.sequence, { outcome: 'not-attempted', code: 'CREDENTIALS_WITHDRAWN' }).catch(() => {});
      return false;
    }
    let grant: BuilderGrant;
    try { grant = await ports.credentials.issue(deps.context); } catch (error) {
      const code = codeOf(error, 'CREDENTIAL_ISSUANCE_FAILED');
      await recordRenewal(session, work_id, executionId, begun.sequence, { outcome: (error as { outcome?: string }).outcome === 'known-rejected' ? 'failed' : 'unknown', code }).catch(() => {});
      await stop(code);
      return false;
    }
    const entry = { ref: begun.sequence, grant, revoked: false };
    known.push(entry); // known BEFORE any await: a concurrent withdrawal revokes it
    const recorded = await recordRenewal(session, work_id, executionId, begun.sequence, { outcome: 'issued', metadata: grant.metadata }).catch(() => 'stale' as const);
    if (recorded !== 'active' || withdrawn.signal.aborted || !worker) {
      await recordRenewal(session, work_id, executionId, begun.sequence, { delivery: 'not-delivered' }).catch(() => {});
      await revoke(entry);
      return false;
    }
    const delivered = await ports.workers.deliver(worker, { kind: 'credential', credential: grant.delivery })
      .catch(() => ({ status: 'failure' as const, code: 'CREDENTIAL_DELIVERY_UNCERTAIN' }));
    if (delivered.status !== 'delivered') {
      await recordRenewal(session, work_id, executionId, begun.sequence, { delivery: 'failed' }).catch(() => {});
      await revoke(entry);
      await stop('code' in delivered ? delivered.code : 'CREDENTIAL_DELIVERY_FAILED');
      return false;
    }
    await recordRenewal(session, work_id, executionId, begun.sequence, { delivery: 'delivered' }).catch(() => {});
    current = grant;
    const expiry = Date.parse(grant.metadata.expiresAt);
    if (!Number.isFinite(expiry)) { await stop('GRANT_EXPIRY_INVALID'); return false; }
    // A renewal that is already due again would loop: renewal stops, visibly, instead of hammering the issuer.
    if (expiry - margin <= Date.now()) { await stop('GRANT_LIFETIME_BELOW_RENEWAL_MARGIN'); return false; }
    return true;
  }

  return {
    get withdrawn() { return withdrawn.signal.aborted; },
    /** Initial issuance, visible to a concurrent withdrawal while in flight (its grant is then revoked, never delivered). */
    async issueInitial(): Promise<BuilderGrant> {
      const pending = ports.credentials.issue(deps.context).then(grant => { known.push({ ref: 'initial', grant, revoked: false }); current = grant; return grant; });
      issuing = pending.catch(() => {});
      return pending;
    },
    /** The live recipient, set once the Builder was activated. A withdrawal that already ran reaches it immediately. */
    async attach(name: string) { worker = name; if (withdrawing) { await withdrawing; await notify(); } },
    /** Waits for `done` while renewing the current grant before its expiry, as long as the activity stays authorized. */
    async renewWhile<T>(done: Promise<T>): Promise<T> {
      const finished = new AbortController();
      void done.then(() => finished.abort(), () => finished.abort());
      const signal = AbortSignal.any([finished.signal, withdrawn.signal, deps.stopping]);
      while (renewal && !signal.aborted && current) {
        const expiry = Date.parse(current.metadata.expiresAt);
        if (!Number.isFinite(expiry)) { await stop('GRANT_EXPIRY_INVALID'); break; }
        const wait = Math.min(maxTimer, Math.max(0, expiry - margin - Date.now()));
        try { await delay(wait, undefined, { signal }); } catch { break; }
        renewing = renew();
        const continued = await renewing.catch(() => false);
        renewing = undefined;
        if (!continued) break;
      }
      return done;
    },
    /** Withdraws the activity's credentials once (first reason kept) and tries to revoke every known grant exactly once. */
    withdraw(reason: CredentialWithdrawal, options: { notifyWorker: boolean }) {
      return withdrawing ??= (async () => {
        withdrawn.abort();
        renewal = false;
        await withdrawCredentials(session, work_id, executionId, reason).catch(() => {});
        await issuing;
        await renewing?.catch(() => {});
        // New commands of a still-running Builder lose the credential before the revocation attempts.
        if (options.notifyWorker && worker) await notify();
        for (const entry of known) await revoke(entry);
      })();
    },
  };
}

/**
 * Dispatch inside the existing owner loop (no scheduler/broker): after a polling iteration, while a Slot is free, the FIFO-selected Work is
 * revalidated (current Ticket authorization + a FRESH native dependency evaluation of this dispatch attempt), reserved durably, and only then
 * prepared/started/activated. Each external effect follows intent -> call -> observation -> durable confirmation. No automatic retry:
 * any failure holds the Execution explicitly with its Slot. Push/PR/reviews/readiness are not part of this increment.
 */
export function createDispatcher(deps: { session: Session; access: AccessDependencies; ports: ExecutionPorts; currentAttempt(repository: string): string | null;
  readWorks(): Promise<WorkRecord[]>; ownCycles(issueIds: number[]): Promise<Record<number, OwnCycleFacts>>;
  record(work_id: string, evaluation: DependencyEvaluation): Promise<unknown>; paused(): Promise<boolean>; heldSlots(): Promise<number>;
  /** A Question was durably recorded: publication proceeds independently of cessation (not awaited by the ACK). */
  questionRecorded?(): void;
  /** Identity of this controller process: origin of the monotonic elapsed values it records. */
  controllerRunId?: string;
  /** Ticket 26: boot facts of this run and the persisted recovery wait, blocking a Work's start beyond its durable impediments. */
  runBlockers?(work: WorkRecord): string[];
  /** Ticket 25: a dispatch revalidation that observed the Ticket no longer authorizing work (label removed, issue closed) records it durably. */
  authorizationWithdrawn?(work_id: string, codes: string[]): Promise<unknown> }) {
  const { session, ports } = deps;
  // Live duration/timeout clock (spec §5.7): local monotonic, separate from the polling cadence and from Pi Durable's own timers.
  const clock = ports.clock ?? systemClock;
  // Monotonic start of each Execution running in THIS process (memory only): live duration for inspection.
  const startedAt = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  // Ticket 24: the dispatch pass that reserved each running Execution (memory only), handed to Sandbox.start as evidence.
  const passes = new Map<string, string>();
  const lifecycles = new Map<string, ReturnType<typeof credentialLifecycle>>();
  // Ticket 17/25: interruption of a running activity whose Work was delivered (merge confirmed) or cancelled meanwhile.
  const interrupts = new Map<string, (reason: 'delivered' | 'cancelled') => void>();
  const stopping = new AbortController();
  let last: DispatchObservation | null = null;
  // Ticket 26: activities whose cessation an administrative stop could not confirm (the stop is then uncertain, never clean).
  let uncertainStops = 0;
  // Owner stop: no NEW effect starts after it (checked before every call), and pending waits end at once, even if already aborted.
  const checkStop = () => { if (stopping.signal.aborted) throw new Error('OWNER_STOPPING'); };
  const untilStopped = <T>(promise: Promise<T>): Promise<T> => {
    if (stopping.signal.aborted) return Promise.reject(new Error('OWNER_STOPPING'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('OWNER_STOPPING'));
      stopping.signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { stopping.signal.removeEventListener('abort', abort); resolve(value); },
        error => { stopping.signal.removeEventListener('abort', abort); reject(error); });
    });
  };
  const observe = (work_id: string | null, outcome: string, reasons: string[] = []) => { last = { at: new Date().toISOString(), work_id, outcome, reasons }; };

  async function revalidateAuthorization(work: WorkRecord): Promise<{ ok: true; observedAt: string } | { ok: false; reasons: string[] }> {
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
    let facts;
    try { facts = await deps.access.tracker.readTicket(work.ticket); } catch { return { ok: false, reasons: ['TICKET_READ_UNAVAILABLE'] }; }
    const decision = evaluateEntry({ configuredLabel: configured?.label, listed: work.ticket, facts });
    if (!decision.authorized) return { ok: false, reasons: decision.holds.map(hold => hold.code) };
    return { ok: true, observedAt: facts.kind === 'observed' ? facts.observedAt : new Date().toISOString() };
  }
  async function freshEvaluation(work: WorkRecord) {
    const attemptId = randomUUID();
    const { evaluation } = await evaluateWorkDependencies(deps.access.tracker, deps.ownCycles, work.ticket, attemptId);
    await deps.record(work.work_id, evaluation);
    return { attemptId, evaluation };
  }

  type Handle = Awaited<ReturnType<ExecutionPorts['workers']['activate']>>;
  const unavailable = (code: string): ProposalIdentity => ({ status: 'unavailable', code });
  /**
   * One review round inside the SAME Execution/Slot/boot (spec §5.6/§6.4): the Builder is already suspended by its Host; the handoff and
   * both reviewer intents are durable before any reviewer starts; Standards and Spec run in parallel; each complete opinion (or failure)
   * is committed; only after BOTH reviewers' activity ended (completion observed, tool binding closed) the identity is re-observed, the
   * round concluded durably and the effective results delivered to the preserved Builder session. No reviewer retry, no new Slot.
   */
  async function reviewRound(work: WorkRecord, execution: ExecutionView, environment: EnvironmentRef, boot: BootRef, handle: Handle, event: HandoffEvent,
    holdExecutionAndWithdraw: (code: string, nextStep: string) => Promise<void>,
    /** The Execution's activity scope: reviewers share its clock/timeout (spec §5.6/§5.7); an interruption ends the round at once. */
    scope: { wait<T>(promise: Promise<T>): Promise<T>; signal: AbortSignal; interrupted(): boolean; activity(event: string): Promise<void> }, firstRound = 1): Promise<boolean> {
    const { executionId } = execution;
    const { round } = event;
    const reviews = ports.reviews!;
    // Ticket 13: repeated captures (handoffs and the Host's closing capture) with exemptions; absent = the single ticket 12 round.
    const multi = reviews.rounds !== undefined;
    const lastSlot = multi && round >= firstRound + reviews.rounds!.max - 1;
    const prior = multi ? ((await deps.readWorks()).find(item => item.work_id === work.work_id)?.execution?.review?.rounds ?? []) : [];
    // The Execution's own hold: also withdraws the Builder credentials (ticket 20), even while it is suspended for review.
    const hold = async (code: string, nextStep: string) => { await holdExecutionAndWithdraw(code, nextStep); return false; };
    const observeProposal = async () => ports.sandbox.observeProposal ? ports.sandbox.observeProposal({ environment, round }).catch(() => unavailable('PROPOSAL_IDENTITY_UNAVAILABLE')) : unavailable('PROPOSAL_IDENTITY_NOT_COMPOSED');
    let failure: string | null = event.status === 'failure' ? 'HANDOFF_UNAVAILABLE' : null;
    checkStop();
    const before = failure ? null : await observeProposal();
    if (!failure && before?.status !== 'observed') failure = 'PROPOSAL_IDENTITY_UNAVAILABLE';
    // The host-read index must be the very index the Builder host reported; otherwise no reviewer starts on it.
    if (!failure && event.status === 'captured' && before?.status === 'observed' && before.indexSha256 !== event.summary.indexSha256) failure = 'PROPOSAL_INDEX_MISMATCH';
    // No new round only when demonstrably unchanged or held exactly by a new commit (spec §6.4); an old approval is never reused otherwise.
    const classification: CaptureClass = multi && !failure && event.status === 'captured' ? classifyCapture({ summary: event.summary, identity: before, rounds: prior }) : { kind: 'review' };
    // A later round prefers each role's compatible session of the last reviewed round (the Workers decide and record continuation/replacement).
    const previous = lastReviewed(prior);
    const plans: ReviewPlan[] = event.status === 'captured' && classification.kind === 'review' ? planReviews({ executionId, round, attempt: 1, handoff: event.summary,
      authorizedChanges: await authorizedChangesOf(work.work_id, execution), operatorRequests: await operatorRequestsOf(work.work_id),
      ...(multi ? { previousSessions: { standards: previous?.reviewers.standards.opinion?.session.file ?? null, spec: previous?.reviewers.spec.opinion?.session.file ?? null } } : {}) }) : [];
    // Ticket 28: partial review recovery (opt-in composition). The first review round of a recovery Execution carries the valid opinions of
    // the interrupted round when the proposal and context are unchanged; only the missing/failed roles are reviewed again.
    const recovery = reviews.partialRecovery === true;
    const fresh = recovery ? (await deps.readWorks()).find(item => item.work_id === work.work_id) : undefined;
    let carried: CarryPlan = {};
    if (recovery && !failure && event.status === 'captured' && classification.kind === 'review' && !(fresh?.execution?.review?.rounds ?? []).some(item => (item.kind ?? 'review') === 'review')) {
      const source = carrySource(interruptedPrevious(fresh, executionId));
      if (source) {
        // Lost notifications: the complete opinion record of a reviewer whose outcome was never recorded (the previous Execution ceased).
        const discovered: Partial<Record<'standards' | 'spec', ReviewOpinion | null>> = {};
        for (const role of undiscovered(source.round)) {
          const found = ports.workers.observeOpinion ? await ports.workers.observeOpinion({ workId: work.work_id, executionId: source.executionId,
            invocationId: source.round.reviewers[role].invocationId }).catch(() => null) : null;
          discovered[role] = found?.kind === 'opinion' ? found.opinion : null;
        }
        const current = fresh?.execution;
        // The SAME construction as the round's recorded `versions.profile` (normalized pack identity on both sides).
        carried = current ? carryPlan({ source, summary: event.summary, identity: before, discovered, profile: reviewProfile(current.request, reviews.reviewer) }) : {};
      }
    }
    const recorded = await recordHandoff(session, work.work_id, executionId, { event, before, plans, reviewer: reviews.reviewer, failure,
      ...(multi ? { firstRound, classification } : {}), ...(Object.keys(carried).length ? { carried } : {}) });
    if (recorded !== 'recorded') return hold(`REVIEW_HANDOFF_${recorded.toUpperCase()}`, 'The handoff could not be recorded for this Execution; the Builder stays suspended. Operator recovery (ticket 26).');
    observe(work.work_id, failure ? 'review-handoff-failed' : classification.kind === 'exemption' ? 'review-exempted' : 'reviewing', failure ? [failure] : []);
    await scope.activity(`review-handoff-r${round}`);
    // Ticket 13: the finding ids of each role's effective opinion travel with the results, so the Builder's handoff refuses unknown treatments.
    const deliver = async (prompt: string, end: boolean, findings?: { standards: string[]; spec: string[] }) => {
      if (await recordDelivery(session, work.work_id, executionId, round, { promptSha256: createHash('sha256').update(prompt).digest('hex') }) !== 'recorded') return hold('REVIEW_DELIVERY_STALE', 'Delivery intent not recordable.');
      checkStop();
      // Q6 deliver (same union as the credential directives of ticket 20): the results to the CURRENT Builder of this Execution.
      const delivered = await scope.wait(ports.workers.deliver(handle.worker, { kind: 'review-results', round, prompt, ...(end ? { end: true as const } : {}),
        ...(multi && findings ? { findings } : {}) }));
      // A refusal is a known non-delivery; anything else may have reached the Builder (it might have resumed): uncertain, never "failed".
      const refused = delivered.status === 'failure' && ['DELIVERY_DENIED', 'DELIVERY_NOT_APPLICABLE', 'WORKER_NOT_CURRENT'].includes(delivered.code);
      await recordDelivery(session, work.work_id, executionId, round, delivered.status === 'delivered' ? { outcome: 'delivered', code: null }
        : { outcome: refused ? 'failed' : 'uncertain', code: delivered.status === 'failure' ? delivered.code : 'DELIVERY_UNEXPECTED' });
      if (delivered.status !== 'delivered') return hold(refused ? 'REVIEW_DELIVERY_FAILED' : 'REVIEW_DELIVERY_UNCERTAIN',
        refused ? 'The review results were refused before reaching the suspended Builder; never retried automatically. Operator recovery (ticket 26).'
          : 'It is unknown whether the Builder received the results (it may have resumed); never redelivered automatically. Operator recovery (ticket 26).');
      return true;
    };
    if (classification.kind === 'exemption') {
      const reviewed = lastReviewed(prior);
      const ok = await deliver(exemptionPrompt({ round, exemption: classification.exemption, conclusion: reviewed?.conclusion ?? 'unknown' }), event.closing === true,
        { standards: [], spec: [] });
      if (ok) { observe(work.work_id, 'review-delivered', [`exempt:${classification.exemption.kind}`]); await scope.activity(`review-delivered-r${round}`); }
      return ok;
    }
    const attemptReviewer = async (plan: ReviewPlan) => {
      let reviewer: Handle;
      try {
        checkStop();
        reviewer = await ports.workers.activate({ context: { workId: work.work_id, executionId, invocationId: plan.invocationId, role: plan.role,
          environmentRef: environment, bootRef: boot, phaseId: plan.phaseId }, prompt: plan.prompt, signal: scope.signal, review: plan.review, ...reviews.reviewer });
      } catch (error) {
        if (stopping.signal.aborted || scope.interrupted()) throw error;
        // Only a refusal known to precede any launch proves the reviewer never ran; anything else may have launched it.
        const known = error instanceof Error && ['WORKER_LAUNCH_INVALID', 'STALE_TOOL_CONTEXT', 'WORKER_EXECUTION_NOT_ENABLED', 'WORKER_PROFILE_NOT_CONFIGURED'].includes(error.message);
        await recordReviewerEnd(session, work.work_id, executionId, round, plan.role, { failure: known ? 'REVIEWER_UNAVAILABLE' : 'REVIEWER_LAUNCH_UNCERTAIN',
          cessation: known ? 'never-started' : 'unconfirmed' });
        return;
      }
      try {
        const start = await scope.wait(reviewer.started);
        if (await recordReviewerStart(session, work.work_id, executionId, round, plan.role, { id: start.receipt.id, ...start.invocation }) !== 'recorded') {
          await recordReviewerEnd(session, work.work_id, executionId, round, plan.role, { failure: 'REVIEWER_START_RECEIPT_CONFLICT', cessation: 'unconfirmed' });
          return;
        }
        await scope.activity(`reviewer-started-${plan.role}`);
        const completed = await scope.wait(reviewer.completed);
        // Ticket 28: a completion observed WITHOUT its opinion (lost/invalid notification): the reviewer preserved the complete opinion in
        // its protected record before notifying, so it is located there and incorporated once; never rerun for it, never zero findings.
        const notified = completed.status === 'success' && completed.opinion ? completed.opinion : null;
        const found = !notified && recovery && ports.workers.observeOpinion ? await ports.workers.observeOpinion({ workId: work.work_id, executionId,
          invocationId: plan.invocationId }).catch(() => null) : null;
        const discovered = found?.kind === 'opinion' && event.status === 'captured' && incorporable(found.opinion, { role: plan.role, round, attempt: plan.review.attempt,
          invocationId: plan.invocationId, handoffIndexSha256: event.summary.indexSha256 }) ? found.opinion : null;
        await recordReviewerEnd(session, work.work_id, executionId, round, plan.role, { cessation: 'completion-observed', ...(notified
          ? { opinion: notified, ...(recovery ? { source: 'notification' as const } : {}) } : discovered ? { opinion: discovered, source: 'records-discovery' as const }
            : { failure: completed.status === 'failure' && /^[A-Z_]{1,64}$/.test(completed.code) ? completed.code : 'OPINION_MISSING' }) });
      } catch (error) {
        if (stopping.signal.aborted || scope.interrupted()) throw error;
        await recordReviewerEnd(session, work.work_id, executionId, round, plan.role, { failure: 'REVIEWER_OUTCOME_UNCERTAIN', cessation: 'unconfirmed' });
      } finally { reviewer.close(); }
    };
    /**
     * Ticket 28: only the failed reviewer is re-obtained, alone, in the same round, while the Builder stays suspended and the other opinion
     * stays as recorded — under a re-observed UNCHANGED proposal identity, with known cessation, a transient failure and a retry left in the
     * round's own limit (`maxReviewerRetries`, persisted 5/15 s wait). Ticket 57: nothing is reserved from the Work's recoveries, so each
     * role retries on its own (no shared reservation to serialize on). Anything else stays an explicit failure in the round.
     */
    let retryLimited = false;
    const retryOnce = async (plan: ReviewPlan): Promise<ReviewPlan | null> => {
      if (event.status !== 'captured') return null;
      const shown = (await deps.readWorks()).find(item => item.work_id === work.work_id);
      const reviewer = shown?.execution?.executionId === executionId ? shown.execution.review?.rounds.find(item => item.round === round)?.reviewers[plan.role] : undefined;
      // A real result needs nothing (and no Host observation).
      if (!reviewer || !reviewerFailure(reviewer)) return null;
      checkStop();
      const decision = retryDecision({ reviewer, before, now: reviewer.cessation === 'unconfirmed' ? null : await observeProposal() });
      if (decision.kind === 'none') return null;
      if (decision.kind === 'not-retried') {
        // Unconfirmed cessation keeps the existing hold path (the round is never concluded on it); the rest is recorded explicitly.
        if (decision.code !== 'REVIEWER_CESSATION_UNCONFIRMED') await recordNotRetried(session, work.work_id, executionId, round, plan.role, decision.code);
        if (decision.code === 'REVIEWER_RETRY_LIMIT') retryLimited = true;
        return null;
      }
      const next = planReviews({ executionId, round, attempt: decision.attempt, handoff: event.summary, authorizedChanges: await authorizedChangesOf(work.work_id, execution),
        operatorRequests: await operatorRequestsOf(work.work_id),
        ...(plan.review.continueFrom ? { previousSessions: { [plan.role]: plan.review.continueFrom } } : {}) }).find(item => item.role === plan.role)!;
      const retried = await recordReviewerRetry(session, work.work_id, executionId, round, plan.role, { plan: next, attempt: decision.attempt, waitSeconds: decision.waitSeconds });
      if (typeof retried === 'string' || retried.kind !== 'recorded') return null;
      let launched = false;
      try {
        observe(work.work_id, 'reviewer-retrying', [`${plan.role}:a${decision.attempt}`]);
        await scope.activity(`reviewer-retry-${plan.role}-a${decision.attempt}`);
        // The persisted wait runs on the Execution's clock (its timeout still applies); an interruption ends it at once.
        await scope.wait(clock.sleep(decision.waitSeconds * 1000, scope.signal));
        if (scope.interrupted()) throw new Error('EXECUTION_TIMEOUT');
        checkStop();
        // The proposal is re-observed right before the launch: a change during the wait is never reviewed on the old input.
        const changed = identityChange(before, await observeProposal());
        if (changed) {
          await releaseReviewerRetry(session, work.work_id, executionId, round, plan.role, { attempt: decision.attempt, code: changed });
          return null;
        }
        launched = true;
        await attemptReviewer(next);
      } catch (error) {
        // Recorded but never launched (interruption, owner stop, failure before the launch): a proven non-start, recorded as such.
        if (!launched) await releaseReviewerRetry(session, work.work_id, executionId, round, plan.role, { attempt: decision.attempt, code: 'RETRY_NOT_LAUNCHED' }).catch(() => {});
        throw error;
      }
      return next;
    };
    const runReviewer = async (first: ReviewPlan) => {
      await attemptReviewer(first);
      if (!recovery) return;
      for (let plan: ReviewPlan | null = first; plan;) plan = await retryOnce(plan);
    };
    if (!failure) {
      // Every role's activity is awaited even if one recovery loop fails: never conclude/deliver while a sibling reviewer may still run.
      const settled = await Promise.allSettled(plans.filter(plan => !carried[plan.role]).map(runReviewer));
      const rejected = settled.find(item => item.status === 'rejected');
      if (rejected) {
        if (stopping.signal.aborted || scope.interrupted()) throw rejected.reason;
        if (!await stillRunning(work.work_id, executionId, round)) return hold('REVIEWER_RECOVERY_FAILED',
          'The partial review recovery failed unexpectedly; both reviewers ended, nothing is retried automatically and the Builder stays suspended. Operator recovery (ticket 26/28).');
      }
      // Operator decision 2026-11-15: two failed retries of the same role in this round hold the Execution, whatever budget remains.
      if (retryLimited && !await stillRunning(work.work_id, executionId, round)) return hold('REVIEWER_RETRY_LIMIT',
        'A reviewer failed again after its 2 automatic retries in this round; nothing more is retried. The own boot is stopped now (ticket 51); then decide: ' +
        '`factory resume <work> --new-review-round --request-id <id>` or `factory cancel <work>`.');
    }
    checkStop();
    if (await stillRunning(work.work_id, executionId, round)) return hold('REVIEWER_CESSATION_UNCONFIRMED',
      'A reviewer may still be active; the Builder stays suspended and no result is delivered until its cessation is confirmed (operator recovery, ticket 26/28).');
    const after = failure ? null : await observeProposal();
    const concluded = await recordConclusion(session, work.work_id, executionId, round, after);
    if (typeof concluded === 'string') return hold(`REVIEW_CONCLUSION_${concluded.toUpperCase()}`, 'The review round could not be concluded; the Builder stays suspended. Operator recovery (ticket 26/28).');
    const prompt = deliveryPrompt({ round, conclusion: concluded.conclusion!, applicability: concluded.applicability ?? 'unknown', reasons: concluded.reasons,
      reviewers: { standards: concluded.reviewers.standards, spec: concluded.reviewers.spec }, ...(multi ? { multi: !lastSlot } : {}) });
    // The closing capture in the last slot cannot be followed by another capture, and a failed closing capture has nothing to treat:
    // its results are recorded and the activation ends (the verification then reports it).
    const listed = (role: 'standards' | 'spec') => (concluded.reviewers[role].opinion?.findings ?? []).map(item => item.id).slice(0, 40);
    if (!await deliver(prompt, event.closing === true && (lastSlot || failure !== null), { standards: listed('standards'), spec: listed('spec') })) return false;
    observe(work.work_id, 'review-delivered', [concluded.conclusion!]);
    await scope.activity(`review-delivered-r${round}`);
    return true;
  }

  /** The Execution interrupted before this one when ticket 26 readmitted the Work through the queue (`interruption`), or null. */
  /** Ticket 21 (real run q21-human-v7): the preserved remote commits/files of the reconciliation this Execution carries, for its reviewers. */
  /** Ticket 23 (real run q23-feedback-v2): the operator requests this Work accepted (treated or in its correction), for its reviewers. */
  async function operatorRequestsOf(work_id: string) {
    return ((await readWork(session, work_id))?.feedback?.requests ?? []).filter(item => item.state === 'treated' || item.state === 'in-correction')
      .map(item => ({ feedbackId: item.feedbackId, code: item.code, author: item.feedback.author?.login ?? 'local administrator', content: item.feedback.content }));
  }
  async function authorizedChangesOf(work_id: string, execution: ExecutionView) {
    const request = execution.request.reconciliation;
    if (!request) return null;
    const divergence = (await readWork(session, work_id))?.publication?.divergences?.find(item => item.divergenceId === request.divergenceId);
    const comparison = divergence?.comparison.state === 'complete' ? divergence.comparison : null;
    return { questionId: request.questionId, commits: [...new Set([...(comparison?.commits.map(item => item.sha) ?? []), request.authorizedRemote])], files: comparison?.files ?? [] };
  }
  function interruptedPrevious(work: WorkRecord | undefined, executionId: string): ExecutionView | null {
    const execution = work?.execution;
    if (!execution || execution.executionId !== executionId) return null;
    // Ticket 26's interruption basis, ONLY an operational recovery (operator decision 2026-11-15; after an administrative stop both review again).
    const previousId = carryBasis(execution.interruption);
    return previousId ? work.previousExecutions.find(item => item.executionId === previousId) ?? null : null;
  }

  async function stillRunning(work_id: string, executionId: string, round: number) {
    const shown = (await deps.readWorks()).find(item => item.work_id === work_id)?.execution;
    const current = shown?.executionId === executionId ? shown.review?.rounds.find(item => item.round === round) : undefined;
    return !current || Object.values(current.reviewers).some(reviewer => reviewer.cessation === 'unconfirmed');
  }

  /** Ticket 48/53: every answered Question of the Work with its accepted answer, oldest first. */
  async function answeredOf(current: WorkRecord | null | undefined): Promise<AnsweredQuestion[]> {
    return current ? (await readQuestions(session, current)).filter(item => item.state === 'answered' && item.answer)
      .map(item => ({ questionId: item.questionId, question: item.content.question, answer: item.answer!.text })) : [];
  }
  /** Ticket 48/53: the bounded state summary of the Work (review rounds of its earlier Executions) for a new Builder session. */
  function workSummary(current: WorkRecord | null | undefined, execution: ExecutionView, input: Omit<SummaryInput, 'rounds'>): string {
    return stateSummary({ ...input,
      rounds: [...(current?.previousExecutions ?? []), ...(current?.execution && current.execution.executionId !== execution.executionId ? [current.execution] : [])]
        .flatMap(item => item.review?.rounds ?? []).map(round => ({ round: round.round, state: round.state, closing: round.closing === true, conclusion: round.conclusion,
          head: round.handoff.summary?.head ?? null, gates: round.declarations?.gates ?? [] })) });
  }

  type Plan = { kind: 'ready'; prompt: string; resume: ExecutionView['request']['resume']; decision: ExecutionView['request']['session']; continuation: SessionRef | null } |
    { kind: 'refused'; reasons: string[] } | { kind: 'insufficient'; reasons: string[] };
  /**
   * First prompt of a Builder activation (spec §5.5/§6.1/§6.2): `/implement <ticket>` at the start (with any authorized scope change);
   * after an answer or an authorized scope change, `continue` in the previous session when it is recorded, intact and compatible, or an
   * explicit recovery instruction with the replacement reason and the recoverable context. Insufficient context blocks.
   */
  async function activationPlan(work: WorkRecord, execution: ExecutionView,
    prepared: { checkout: { baseCommit: string; branch: string; path: string; reused: boolean } }, pack: ExecutionView['request']['skillPack']): Promise<Plan> {
    const current = await readWork(session, work.work_id);
    const resume = execution.request.resume ?? null;
    const updates = (current?.scopeUpdates ?? []).filter(update => (execution.request.scopeUpdateIds ?? []).includes(update.scopeUpdateId))
      .map(update => ({ scopeUpdateId: update.scopeUpdateId, reason: update.reason }));
    if ((execution.request.scopeUpdateIds ?? []).length !== updates.length) return { kind: 'insufficient', reasons: ['SCOPE_UPDATE_CONTENT_MISSING'] };
    const skillDirectory = `/artifacts/factory/skill-pack/${execution.request.policies.skillPack ?? 'factory-skills-v2'}`;
    const basis = execution.interruption ?? null;
    // Ticket 22: the effective impediments travel with the first prompt of the repair (and of its continuation after a Question).
    const repairRequest = execution.request.repair ?? null;
    const repair = repairRequest ? repairSection({ correctionId: repairRequest.correctionId, base: work.repository.base, branch: execution.request.branch,
      checkout: prepared.checkout.path, reasons: repairRequest.reasons, humanTips: repairRequest.humanTips ?? [] }) : undefined;
    // Ticket 23: a continuation of a CHARGED correction (human requests that entered during its activity) runs under its preserved charge.
    if (resume?.reason === 'REPAIR_REQUESTED' && (!repairRequest || current?.correction?.correctionId !== repairRequest.correctionId ||
        (current.correction.consumed && execution.charge?.state !== 'preserved'))) {
      return { kind: 'refused', reasons: ['REPAIR_BASIS_CHANGED'] };
    }
    if (!resume && basis) {
      // Ticket 26: after an interrupted Execution, an explicit substitute instruction on the PRESERVED workspace (same base/branch/checkout,
      // reused environment) — the interruption is its trigger; never `/implement` again, never a blind replay of the last tool.
      const previous = current?.previousExecutions.find(item => item.executionId === basis.previousExecutionId) ?? null;
      if (!previous) return { kind: 'insufficient', reasons: ['PREVIOUS_EXECUTION_MISSING'] };
      const context = recoveryContext({ previous: { baseCommit: previous.request.baseCommit, branch: previous.request.branch, checkout: previous.request.checkout },
        prepared: { baseCommit: prepared.checkout.baseCommit, branch: prepared.checkout.branch, checkout: prepared.checkout.path, reused: prepared.checkout.reused },
        trigger: { answer: true, scopeUpdates: updates.length } });
      if (!context.sufficient) return { kind: 'insufficient', reasons: context.reasons };
      const reconciling = execution.request.reconciliation ? reconciliationNotice(execution.request.reconciliation, execution.request.branch, prepared.checkout.path,
        publicationRemote(work.repository.repository)) : null;
      // Ticket 48: a continuation after a budget end gets the bounded state summary (last phase, gates, answered Questions); an operational
      // recovery gets it when the Work has answered Questions, so an answer already given is never asked again (ticket 45 seams). Ticket 53:
      // so does the continuation after an administrative stop.
      const answered = await answeredOf(current);
      const summary = basis.reason === 'BUDGET_CONTINUATION' || basis.reason === 'ADMINISTRATIVE_STOP' || (basis.reason === 'OPERATIONAL_RECOVERY' && answered.length)
        ? workSummary(current, execution, { previousExecutionId: basis.previousExecutionId, code: basis.code,
          progress: basis.reason === 'BUDGET_CONTINUATION' && previous.checkout?.progress ? { decision: previous.checkout.progress, start: previous.checkout.atStart, end: previous.checkout.atEnd ?? null } : null,
          answered }) : null;
      const prompt = [...(reconciling ? [reconciling, ''] : []), interruptionRecoveryPrompt({ ticketUrl: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
        baseCommit: prepared.checkout.baseCommit, branch: execution.request.branch, checkout: prepared.checkout.path, workId: work.work_id,
        executionId: execution.executionId, skillDirectory, previousExecutionId: basis.previousExecutionId, reason: basis.reason, code: basis.code,
        reviews: Boolean(ports.reviews), summary }), ...(updates.length ? ['', ...scopeSection(updates)] : []), ...(repair ?? [])].join('\n');
      // Ticket 28 (spec §5.6): the preserved review state of the interrupted Execution, context only (a delivery to the old session is not
      // proof it was consumed); its valid opinions are carried at the next handoff when the proposal is unchanged. Dropped under the bound.
      const review = ports.reviews?.partialRecovery ? preservedReviewContext(previous.review?.rounds ?? [], 6000, { carry: true }) : null;
      const withReview = review ? `${prompt}\n\n${review}` : prompt;
      if (new TextEncoder().encode(withReview).length <= promptBudgetBytes) return { kind: 'ready', prompt: withReview, resume: null, decision: null, continuation: null };
      if (new TextEncoder().encode(prompt).length > promptBudgetBytes) return { kind: 'insufficient', reasons: ['PROMPT_TOO_LARGE'] };
      return { kind: 'ready', prompt, resume: null, decision: null, continuation: null };
    }
    if (!resume) {
      // Bounded like every resumption prompt: an over-large initial prompt blocks explicitly instead of being truncated.
      const initial = initialPrompt({ ticketUrl: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
        baseCommit: prepared.checkout.baseCommit, branch: execution.request.branch, checkout: prepared.checkout.path, workId: work.work_id,
        executionId: execution.executionId, reviews: Boolean(ports.reviews), scopeUpdates: updates, reviewRounds: Boolean(ports.reviews?.rounds) });
      if (initial.kind === 'too-large') return { kind: 'insufficient', reasons: ['PROMPT_TOO_LARGE'] };
      return { kind: 'ready', prompt: initial.prompt, resume: null, decision: null, continuation: null };
    }
    if (resume.reason === 'PUBLICATION_REQUESTED') return publicationPlan(work, execution, prepared, pack, current ?? null, skillDirectory);
    if (resume.reason === 'RECONCILIATION_AUTHORIZED') return reconciliationPlan(work, execution, prepared, current ?? null, skillDirectory);
    const answered = resume.questionId ? await readQuestion(session, resume.questionId) : null;
    if (resume.questionId && (!answered?.answer || answered.answer.sha256 !== resume.answerSha256 || answered.workId !== work.work_id ||
        answered.executionId !== resume.previousExecutionId)) return { kind: 'refused', reasons: ['RESUME_BASIS_CHANGED'] };
    const previous = current?.previousExecutions.find(item => item.executionId === resume.previousExecutionId) ?? null;
    if (!previous) return { kind: 'insufficient', reasons: ['PREVIOUS_EXECUTION_MISSING'] };
    const context = recoveryContext({ previous: { baseCommit: previous.request.baseCommit, branch: previous.request.branch, checkout: previous.request.checkout },
      prepared: { baseCommit: prepared.checkout.baseCommit, branch: prepared.checkout.branch, checkout: prepared.checkout.path, reused: prepared.checkout.reused },
      trigger: { answer: Boolean(answered?.answer), scopeUpdates: updates.length, repair: resume.reason === 'REPAIR_REQUESTED' } });
    if (!context.sufficient) return { kind: 'insufficient', reasons: context.reasons };
    const recorded = previous.end?.session ?? null;
    let observation = null;
    if (recorded && ports.workers.observe) {
      observation = (await ports.workers.observe({ workId: work.work_id, executionId: previous.executionId, invocationId: previous.invocationId, session: recorded,
        next: { ...(execution.request.policies.skillPack ? { skillPack: execution.request.policies.skillPack } : {}),
          ...(execution.request.policies.copyOutput === undefined ? {} : { copyOutput: execution.request.policies.copyOutput }),
          ...(execution.request.policies.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: execution.request.policies.editSourceMaxBytes }), handoff: Boolean(ports.reviews) } })
        .catch(() => ({ session: { state: 'unavailable' as const, code: 'SESSION_OBSERVATION_FAILED', differences: [] }, limitations: [] }))).session;
    }
    const decided = sessionDecision({ previous: { session: recorded, skillPack: previous.request.skillPack, policies: previous.request.policies },
      next: { skillPack: pack, policies: execution.request.policies }, observation });
    const decision = { mode: decided.mode, reason: decided.reason, previousExecutionId: previous.executionId, previous: recorded, decidedAt: new Date().toISOString() };
    const answer = answered?.answer ? { text: answered.answer.text, author: answered.answer.author.kind === 'github' ? answered.answer.author.login : 'local administrator',
      origin: answered.answer.origin.kind } : null;
    if (decided.mode === 'continue') {
      const continued = continuationPrompt({ executionId: execution.executionId, previousExecutionId: previous.executionId, skillDirectory,
        answer: answered && answer ? { questionId: answered.questionId, ...answer } : null, scopeUpdates: updates, reviewRounds: Boolean(ports.reviews?.rounds),
        ...(repair ? { repair } : {}) });
      if (continued.kind === 'insufficient') return { kind: 'insufficient', reasons: continued.reasons };
      return { kind: 'ready', prompt: continued.prompt, resume, decision, continuation: recorded };
    }
    const allAnswered = await answeredOf(current);
    const lastRound = [...(current?.previousExecutions ?? [])].reverse().flatMap(item => [...(item.review?.rounds ?? [])].reverse()).find(round => round.handoff.summary) ?? null;
    const known: KnownContext = {
      previousExecutions: (current?.previousExecutions ?? []).map(item => ({ executionId: item.executionId,
        outcome: item.end ? `${item.end.outcome}${item.end.code ? ` (${item.end.code})` : ''}` : item.held ? `released/held (${item.held.code})` : item.state, at: item.end?.at ?? item.held?.at ?? null })),
      questions: (current ? await readQuestions(session, current) : []).map(item => ({ questionId: item.questionId, state: item.state, comment: item.publication.comment?.url ?? null })),
      versions: lastRound ? { spec: lastRound.versions.spec?.version ?? null, instructions: lastRound.versions.instructions?.version ?? null, head: lastRound.handoff.summary?.head ?? null } : null,
      scopeUpdates: updates,
      // Ticket 28 (spec §5.6): the substitute session gets the preserved review state of the previous Execution as context only — a
      // delivery to the old session is not proof it was consumed. No carry here (the answer may change the context): both review again.
      ...(ports.reviews?.partialRecovery ? { review: preservedReviewContext(previous.review?.rounds ?? [], 6000, { carry: false }) } : {}) };
    const recovered = recoveryPrompt({ ticketUrl: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
      baseCommit: prepared.checkout.baseCommit, branch: execution.request.branch, checkout: prepared.checkout.path, workId: work.work_id, executionId: execution.executionId,
      skillDirectory, previousExecutionId: previous.executionId,
      question: answered ? { questionId: answered.questionId, question: answered.content.question, context: answered.content.context } : null,
      answer, replacement: { reason: decided.reason }, known, reviewRounds: Boolean(ports.reviews?.rounds), ...(repair ? { repair } : {}),
      // Ticket 53: a replacement session gets EVERY answered Question of the Work (ticket 48's bounded block), not only the current answer.
      summary: allAnswered.length ? workSummary(current, execution, { previousExecutionId: previous.executionId,
        code: previous.end?.code ?? previous.end?.outcome ?? previous.state, progress: null, answered: allAnswered }) : null });
    if (recovered.kind === 'too-large') return { kind: 'insufficient', reasons: ['PROMPT_TOO_LARGE'] };
    return { kind: 'ready', prompt: recovered.prompt, resume, decision, continuation: null };
  }

  /**
   * Ticket 14 (spec §9.1): the publication activation's first prompt. The SAME compatible session is continued with a `publish` message, or
   * replaced by a self-contained publication instruction; the request (verified commit, branch/base, marker, lease expectation) is the one
   * recorded at admission and must still be the Work's requested publication. Insufficient context blocks before any credential.
   */
  async function publicationPlan(work: WorkRecord, execution: ExecutionView, prepared: { checkout: { baseCommit: string; branch: string; path: string; reused: boolean } },
    pack: ExecutionView['request']['skillPack'], current: WorkRecord | null, skillDirectory: string): Promise<Plan> {
    const request = execution.request.publication;
    const resume = execution.request.resume!;
    const requested = current?.publication;
    if (!request || !requested?.verified || requested.state !== 'requested' || requested.basisExecutionId !== request.basisExecutionId || requested.verified.head !== request.head) {
      return { kind: 'refused', reasons: ['PUBLICATION_BASIS_CHANGED'] };
    }
    const previous = current?.previousExecutions.find(item => item.executionId === resume.previousExecutionId) ?? null;
    if (!previous) return { kind: 'insufficient', reasons: ['PREVIOUS_EXECUTION_MISSING'] };
    const context = recoveryContext({ previous: { baseCommit: previous.request.baseCommit, branch: previous.request.branch, checkout: previous.request.checkout },
      prepared: { baseCommit: prepared.checkout.baseCommit, branch: prepared.checkout.branch, checkout: prepared.checkout.path, reused: prepared.checkout.reused },
      trigger: { answer: false, scopeUpdates: 0, publication: true } });
    if (!context.sufficient) return { kind: 'insufficient', reasons: context.reasons };
    // Publish-only (review HIGH 1): ALWAYS a new session without the handoff and edit tools; the implementation session is never continued
    // with a write grant. Its tools cannot make another content publishable: discovery accepts only the verified head.
    void pack;
    const decision = { mode: 'replace' as const, reason: 'PUBLISH_ONLY_SESSION', previousExecutionId: previous.executionId, previous: previous.end?.session ?? null,
      decidedAt: new Date().toISOString() };
    const prompt = publicationPrompt({ reason: decision.reason, executionId: execution.executionId, previousExecutionId: previous.executionId, skillDirectory,
      repository: work.repository.repository, base: request.base, branch: request.branch, head: request.head, marker: request.marker,
      ticket: { number: work.ticket.number, url: work.ticket.url }, workId: work.work_id, checkout: prepared.checkout.path, expectedRemote: request.expectedRemote,
      pullRequest: request.pullRequest ?? null, remote: publicationRemote(work.repository.repository),
      verified: { reviewedRound: requested.verified.reviewedRound, gates: requested.verified.gates, requiredChecks: requested.verified.requiredChecks } });
    if (prompt.kind === 'too-large') return { kind: 'insufficient', reasons: ['PROMPT_TOO_LARGE'] };
    return { kind: 'ready', prompt: prompt.prompt, resume, decision, continuation: null };
  }

  /**
   * Ticket 21 (spec §10.1): the reconciliation Execution's first prompt — ALWAYS a new session with a self-contained instruction carrying the
   * one authorized divergence (expectation, authorized remote tip, local result, the remote commits to preserve). Refused when the
   * authorization changed since admission; insufficient context blocks before any credential.
   */
  async function reconciliationPlan(work: WorkRecord, execution: ExecutionView, prepared: { checkout: { baseCommit: string; branch: string; path: string; reused: boolean } },
    current: WorkRecord | null, skillDirectory: string): Promise<Plan> {
    const request = execution.request.reconciliation;
    const resume = execution.request.resume!;
    const authorization = current?.publication ? authorizationInForce(current.publication) : null;
    if (!request || !authorization || authorization.divergenceId !== request.divergenceId || authorization.authorizedRemote !== request.authorizedRemote ||
        authorization.executionId !== execution.executionId) return { kind: 'refused', reasons: ['RECONCILIATION_BASIS_CHANGED'] };
    const answered = await readQuestion(session, request.questionId);
    if (!answered?.answer || answered.answer.sha256 !== request.answerSha256 || answered.workId !== work.work_id) return { kind: 'refused', reasons: ['RECONCILIATION_BASIS_CHANGED'] };
    const previous = current?.previousExecutions.find(item => item.executionId === resume.previousExecutionId) ?? null;
    if (!previous) return { kind: 'insufficient', reasons: ['PREVIOUS_EXECUTION_MISSING'] };
    const context = recoveryContext({ previous: { baseCommit: previous.request.baseCommit, branch: previous.request.branch, checkout: previous.request.checkout },
      prepared: { baseCommit: prepared.checkout.baseCommit, branch: prepared.checkout.branch, checkout: prepared.checkout.path, reused: prepared.checkout.reused },
      trigger: { answer: true, scopeUpdates: 0 } });
    if (!context.sufficient) return { kind: 'insufficient', reasons: context.reasons };
    const divergence = current?.publication?.divergences?.find(item => item.divergenceId === request.divergenceId) ?? null;
    const commits = divergence?.comparison.state === 'complete' ? divergence.comparison.commits.map(commit => ({ sha: commit.sha,
      label: `${commit.author ? `@${commit.author.login}` : 'account unproven'} ${commit.subject}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 140) })) : [];
    const decision = { mode: 'replace' as const, reason: 'RECONCILIATION_SESSION', previousExecutionId: previous.executionId, previous: previous.end?.session ?? null,
      decidedAt: new Date().toISOString() };
    const note = ''; // exact answers only (review LOW): nothing beyond the keyword reaches the Builder
    const prompt = reconciliationPrompt({ executionId: execution.executionId, previousExecutionId: previous.executionId, skillDirectory, ticketUrl: work.ticket.url,
      workId: work.work_id, repository: work.repository.repository, base: work.repository.base, baseCommit: prepared.checkout.baseCommit, branch: execution.request.branch,
      checkout: prepared.checkout.path, pullRequest: current?.pullRequest ?? null, expected: request.expected, authorizedRemote: request.authorizedRemote,
      localHead: request.localHead, questionId: request.questionId,
      answer: { author: answered.answer.author.kind === 'github' ? `@${answered.answer.author.login}` : 'local administrator', note }, commits });
    if (prompt.kind === 'too-large') return { kind: 'insufficient', reasons: ['PROMPT_TOO_LARGE'] };
    return { kind: 'ready', prompt: prompt.prompt, resume, decision, continuation: null };
  }

  /**
   * Ticket 14 discovery pass (spec §9.1), in the same owner loop before selection: for each Work whose Execution ceased, record a NEW verified
   * basis, then discover the own publication (Git remote ref + correlated pull requests) with a safe read and record the decision. Never
   * while an activity of the Work is running; an incomplete read decides nothing and is simply read again on a later cycle.
   */
  // Pinned Factory App identity (review MED 3), resolved lazily by a safe read and kept for this process; unknown = nothing is own.
  let factoryApp: FactoryAppIdentity | null = null;
  const appIdentity = async () => factoryApp ??= await deps.access.factoryApp?.().catch(() => null) ?? null;
  /** At most this many discovery reads (each a few GitHub requests) per tick; the rest wait for a later cycle. */
  const discoveriesPerTick = 4;
  async function reconcilePublications() {
    let reads = 0;
    for (const listed of await deps.readWorks()) {
      if (stopping.signal.aborted || reads >= discoveriesPerTick) return;
      if (running.has(listed.work_id)) continue;
      // One Work's failure is recorded and never stops the others (review LOW).
      try { if (await reconcileOne(listed)) reads++; }
      catch (error) { observe(listed.work_id, 'publication-reconcile-failed', [codeOf(error, 'PUBLICATION_RECONCILE_FAILED')]); }
    }
  }
  /** The single attempt of the verified head pushed (expected the branch absent): one PR-only continuation is still possible. */
  const prOnlyRecovery = (publication: NonNullable<WorkRecord['publication']>) => {
    const attempts = publication.verified ? attemptsOf(publication, publication.verified.head) : [];
    return attempts.length === 1 && attempts[0]!.expectedRemote?.state === 'absent';
  };
  /** Returns whether a discovery read was made. */
  async function reconcileOne(listed: WorkRecord): Promise<boolean> {
    let step = publicationStep(listed);
    if (step.kind === 'evaluate') {
      const evaluated = await evaluatePublication(session, listed.work_id, step.basisExecutionId);
      if (evaluated === 'stale' || evaluated.state !== 'awaiting-discovery') { observe(listed.work_id, 'publication-evaluated', evaluated === 'stale' ? ['STALE'] : evaluated.reasons); return false; }
      const attempted = publicationAttempted({ publication: evaluated });
      step = { kind: 'discover', trigger: attempted ? 'after-publication' : 'verified', attempted };
    }
    if (step.kind === 'resolve') {
      // Ticket 21: the accepted answer of the divergence Question (a local read; the answer itself arrived by the Question desk).
      const resolved = await resolveDivergence(session, listed.work_id, step.divergenceId);
      if (resolved !== 'waiting' && resolved !== 'stale') observe(listed.work_id, `reconciliation-${resolved.decision}`, resolved.code ? [resolved.code] : []);
      return false;
    }
    if (step.kind !== 'discover') return false;
    const work = await readWork(session, listed.work_id);
    const publication = work?.publication;
    if (!work || !publication?.verified || running.has(work.work_id)) return false;
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
    const app = await appIdentity();
    // Ticket 21: the Factory's own remote history and the authorization in force (its basis must be the reconciliation Execution).
    const authorization = authorizationInForce(publication);
    const basis = [...(work.previousExecutions ?? []), ...(work.execution ? [work.execution] : [])].find(item => item.executionId === publication.basisExecutionId);
    const known = knownRemote(publication, step.attempted, Boolean(authorization && basis?.request.reconciliation?.divergenceId === authorization.divergenceId));
    const compareFrom = comparisonBase(known);
    let observation: DiscoveryObservation;
    let observedAt: string | null = null;
    if (!configured) observation = { kind: 'incomplete', code: 'REPOSITORY_NOT_CONFIGURED' };
    else {
      try {
        const read = await deps.access.repository.findPublication({ repo: configured, issueNumbers: [work.ticket.number], knownBranches: [publication.branch],
          refs: true, base: publication.base, ...(compareFrom ? { compareFrom } : {}),
          preserve: preservationTips(known) });
        observedAt = read.observedAt;
        const issue = read.kind === 'observed' ? read.issues[String(work.ticket.number)] : undefined;
        const tip = read.kind === 'observed' ? read.branches[publication.branch] : undefined;
        observation = read.kind !== 'observed' ? { kind: 'incomplete', code: read.code }
          : !issue ? { kind: 'incomplete', code: 'PUBLICATION_NOT_REPORTED' }
          : issue.completeness === 'incomplete' ? { kind: 'incomplete', code: issue.code }
          : { kind: 'observed', repositoryId: read.repositoryId, candidates: issue.candidates,
            branch: !tip ? { state: 'unknown', code: 'BRANCH_NOT_REPORTED' } : tip.state === 'unknown' ? { state: 'unknown', code: tip.code } : tip,
            refs: !read.refs ? { state: 'unknown', code: 'REFS_NOT_REPORTED' } : read.refs.state === 'complete' ? read.refs : { state: 'unknown', code: read.refs.code },
            baseProtection: !read.baseProtection ? { state: 'unknown', code: 'BASE_PROTECTION_NOT_REPORTED' } : read.baseProtection,
            ...(read.comparison ? { comparison: read.comparison } : {}), ...(read.activity ? { activity: read.activity } : {}),
            ...(read.ancestry ? { ancestry: read.ancestry } : {}) };
      } catch { observation = { kind: 'incomplete', code: 'PUBLICATION_QUERY_FAILED' }; }
    }
    const decision = decideDiscovery({ expect: { workId: work.work_id, ticketNumber: work.ticket.number, branch: publication.branch, base: publication.base,
      repositoryId: work.repository.repositoryId, head: publication.verified.head, app }, attempted: step.attempted, previousHeads: publication.linkedHeads ?? [],
      prOnlyRecovery: prOnlyRecovery(publication), known,
      refsBefore: publication.refsBefore ?? null, observation });
    const recorded = await recordDiscovery(session, work.work_id, { basisExecutionId: publication.basisExecutionId, executionId: work.execution?.executionId ?? null,
      trigger: step.trigger, observedAt, ticketNumber: work.ticket.number, decision,
      branch: observation.kind === 'observed' ? observation.branch : { state: 'unknown', code: observation.code } });
    observe(work.work_id, recorded === 'stale' ? 'publication-stale' : `publication-${decision.outcome}`, decision.reasons);
    return true;
  }

  async function execute(work: WorkRecord, execution: ExecutionView) {
    const { executionId } = execution;
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase())!;
    let phase = 'prepare';
    let environment: EnvironmentRef | undefined;
    let boot: BootRef | undefined;
    // A Question recorded by THIS Execution whose activation then failed or became uncertain: explicit impediment, never a silent wait.
    const questionUncertain = async () => {
      for (const id of (await readWork(session, work.work_id))?.questions ?? []) {
        const question = await readQuestion(session, id);
        if (question?.executionId !== executionId || question.workId !== work.work_id) continue;
        await recordContentLost(session, work.work_id, executionId, id, 'QUESTION_RECORDED_EXECUTION_UNCERTAIN',
          'the activation then ended with a failure or uncertain outcome (the Question stays recorded and publishable)', id);
      }
    };
    let lifecycle: ReturnType<typeof credentialLifecycle> | undefined;
    // Set only once the Host actually activated the Builder: before that no worker request exists, so a failure or an owner stop
    // is a PROVEN non-start (AC2: no consumption) and never an uncertain outcome.
    let activated = false;
    // Ticket 26: whether Sandbox.start was ever requested by this Execution (before it, no boot of it can exist).
    let startRequested = false;
    /** Refusals the Host raises BEFORE any launch request: they prove no worker ran. Anything else at the activation phase may have. */
    const provenNonStartOf = (error: unknown) => !activated && (phase !== 'activate' ||
      (error instanceof Error && ['WORKER_LAUNCH_INVALID', 'STALE_TOOL_CONTEXT', 'WORKER_EXECUTION_NOT_ENABLED', 'WORKER_PROFILE_NOT_CONFIGURED', 'WORKER_POLICY_ROLE_DENIED'].includes(error.message)));
    // A held Execution is not authorized to advance: its credentials are withdrawn and known grants revocation is attempted, even if the
    // hold commit itself fails.
    const hold = async (code: string, nextStep: string, provenNonStart = false, detail?: string) => {
    try { await holdExecution(session, work.work_id, executionId, code, nextStep, provenNonStart, detail); observe(work.work_id, 'held', [code]); }
    finally { await lifecycle?.withdraw('held', { notifyWorker: true }); }
  };
    /**
     * Ticket 50: a boot/preparation the Sandbox REFUSED (a returned definitive refusal: nothing of it still runs) is settled at once by the
     * ordinary reconciliation with that confirmed cessation — Slot freed, proven non-start — instead of waiting for a controller restart: a
     * capacity refusal returns to the queue behind its wait, any other one blocks with the explicit operator retry. Indeterminate results keep
     * the hold (host evidence at the next boot).
     */
    const refused = async (phaseOf: 'prepare' | 'start', result: { status: 'failure' | 'indeterminate'; code: string; detail?: string; boot?: BootRef }) => {
      const code = `${phaseOf === 'prepare' ? 'PREPARE' : 'START'}_${result.code}`;
      await hold(code, phaseOf === 'prepare' ? 'Preparation did not complete; it is never retried automatically. Inspect the environment (ticket 26 recovery).'
        : 'The boot did not become operational; no automatic retry. Observe/stop the environment explicitly.', true, result.detail);
      if (!refusedWithoutActivity({ phase: phaseOf, status: result.status, code: result.code })) return;
      const shown = await readWork(session, work.work_id);
      if (shown?.execution?.executionId !== executionId || shown.execution.state !== 'held') return;
      await reconcileExecution({ session, ports, controllerRunId: deps.controllerRunId ?? 'unknown', inventory: 'empty' }, shown, 'start-refused',
        { result: 'confirmed', basis: `${phaseOf}-refused:${result.code}`.slice(0, 160), environment: phaseOf === 'start' ? environment ?? null : null, boot: result.boot ?? null })
        .catch(() => { /* the hold stands; the next controller boot reconciles it */ });
    };
    // Activity scope of THIS Execution: the timeout interrupts it (Builder and reviewers) without stopping the owner.
    const interrupt = new AbortController();
    // Ticket 17: why the activity scope was interrupted — the timeout (default) or a confirmed delivery (merge observed meanwhile).
    // Ticket 25: `cancelled` — the operator cancelled the Work (its credentials were withdrawn first). The first reason is kept.
    const interruption: { reason: 'timeout' | 'delivered' | 'cancelled' } = { reason: 'timeout' };
    interrupts.set(work.work_id, reason => { if (!interrupt.signal.aborted) interruption.reason = reason; interrupt.abort(); });
    const activitySignal = AbortSignal.any([stopping.signal, interrupt.signal]);
    const interrupted = () => interrupt.signal.aborted;
    const wait = <T>(promise: Promise<T>): Promise<T> => untilStopped(new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('EXECUTION_TIMEOUT'));
      if (interrupt.signal.aborted) { abort(); return; }
      interrupt.signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { interrupt.signal.removeEventListener('abort', abort); resolve(value); },
        error => { interrupt.signal.removeEventListener('abort', abort); reject(error); });
    }));
    let startMono: number | null = null;
    const elapsed = () => startMono === null ? null : Math.max(0, clock.monotonic() - startMono);
    const activity = async (event: string) => { const ms = elapsed(); if (ms !== null) await recordActivity(session, work.work_id, executionId, event, ms).catch(() => {}); };
    const timerStop = new AbortController();
    let timer: Promise<void> | undefined;
    // Timer independent of logs/activity: on the configured limit it records the timeout durably, then interrupts the activity.
    const armTimeout = (timeoutSeconds: number | null) => {
      if (timeoutSeconds === null) return; // no timeout: no implicit cut of any length
      timer = (async () => {
        const signal = AbortSignal.any([timerStop.signal, stopping.signal]);
        while (!signal.aborted) {
          const ms = elapsed()!;
          if (timeoutReached(timeoutSeconds, ms)) {
            await recordTimeout(session, work.work_id, executionId, ms).catch(() => {});
            interrupt.abort();
            return;
          }
          await clock.sleep(timeoutSeconds * 1000 - ms, signal);
        }
      })();
    };
    // Clean administrative stop after confirmed cessation (one end commit with the measured duration, then the Slot release commit). Before a
    // confirmed start, the receipt facet decides whether it started (consumed once) or not (reservation released): never by guess.
    // A FORCED termination (grace period expired) is not a clean stop: it keeps the failure treatment (one operational recovery).
    const administrativeStop = async (current: WorkRecord, id: string, env: EnvironmentRef, ownBoot: BootRef, forced: boolean): Promise<boolean> => {
      const shown = await readWork(session, current.work_id);
      if (shown?.execution?.executionId !== id) return false;
      if (shown.execution.state === 'started') {
        const ended = forced ? await recordEnd(session, current.work_id, id, 'failure', 'ADMINISTRATIVE_STOP_FORCED', null, elapsed())
          : await recordEnd(session, current.work_id, id, 'stopped', 'ADMINISTRATIVE_STOP', null, elapsed());
        if (ended.kind !== 'advanced') return false;
        if (forced) { await releaseAfterCessation(session, current.work_id, id, 'confirmed'); return false; }
        return await releaseAfterCessation(session, current.work_id, id, 'confirmed') === 'released';
      }
      if (forced) return false; // held below; the next boot reconciles it with the failure treatment
      const { decision } = await reconcileExecution({ session, ports, controllerRunId: deps.controllerRunId ?? 'unknown', inventory: 'empty' }, shown, 'administrative-stop',
        { result: 'confirmed', basis: 'sandbox-stop', environment: env, boot: ownBoot });
      return decision !== 'stale' && decision !== 'kept' && decision !== 'blocked';
    };
    // The review loop of this Execution: an interruption/stop waits for it to settle (ticket 28: a retry that was never launched releases
    // its reservation) before the end is recorded.
    let reviewTask: Promise<boolean> | undefined;
    let endCode: string | null = null;
    const stopOwnBoot = async (reason: string) => environment && boot ? ports.sandbox.stop({ environment, boot, reason }).catch(() => ({ status: 'indeterminate' as const, cessationConfirmed: false as const, code: 'STOP_UNAVAILABLE' })) : undefined;
    try {
      checkStop();
      // Ticket 50: an operator remedy accepted with a retry (recreate the divergent artifact seeds) is applied by THIS preparation only.
      const remedy = work.startRemedy ?? null;
      // Ticket 44: the declaration pinned in the Work (a Work admitted before ticket 44 has none and keeps the generic guest). A Work gated by
      // its environment never gets here (its impediment blocks the selection); a defensive refusal never prepares it on a guess.
      const pinned = work.environment?.state === 'pinned' ? work.environment.pin : null;
      if (work.environment && !pinned) { await refused('prepare', { status: 'failure', code: 'ENVIRONMENT_NOT_PINNED', detail: `environment ${work.environment.state}` }); return; }
      const environmentRetry = work.environmentRetry ?? null;
      const prepared = await ports.sandbox.prepare({ workId: work.work_id, configuration: ports.configuration,
        checkout: { repository: work.repository.repository, repositoryId: work.repository.repositoryId, installationId: configured.installationId, base: work.repository.base, branch: execution.request.branch },
        ...(remedy?.remedy === 'recreate-artifact-seed' ? { recreateSeeds: remedy.seeds } : {}),
        ...(pinned ? { environment: { ...pinned, repository: work.repository.repository, repositoryId: work.repository.repositoryId } } : {}),
        ...(environmentRetry ? { retryEnvironmentBase: true } : {}) });
      if (prepared.status === 'success' && !('checkout' in prepared)) { await hold('PREPARE_CHECKOUT_MISSING', 'Preparation did not complete; it is never retried automatically. Inspect the environment (ticket 26 recovery).', true); return; }
      if (prepared.status !== 'success') { await refused('prepare', prepared); return; }
      environment = prepared.environment;
      const pack = prepared.seeds.find(seed => seed.name.startsWith('factory/skill-pack/'));
      // Ticket 48: the Host fingerprint of the checkout BEFORE any boot of this Execution (progress at a budget end is measured from it).
      const atStart = ports.sandbox.observeCheckout ? await ports.sandbox.observeCheckout({ environment: prepared.environment })
        .catch(() => ({ status: 'unavailable' as const, code: 'CHECKOUT_OBSERVATION_FAILED' })) : null;
      if ((await recordPhase(session, work.work_id, executionId, 'reserved', 'prepared', 'execution-prepared', current => {
        current.dispatch.environment = prepared.environment;
        current.checkout = { atStart };
        current.request.baseCommit = prepared.checkout.baseCommit;
        current.request.checkout = prepared.checkout.path;
        current.request.skillPack = pack ? { name: pack.name, manifestSha256: pack.manifestSha256 } : null;
        // Ticket 44: what this environment was created from (declaration hash + resolved manifest), recorded with the Execution.
        if ('base' in prepared && prepared.base) current.request.environment = prepared.base;
      }, current => {
        if ('base' in prepared && prepared.base) current.history.push({ at: new Date().toISOString(), event: 'environment-evaluated', origin: 'controller-dispatch',
          detail: `environment-base:${prepared.base.base}:${prepared.base.declarationSha256}:${prepared.base.manifestSha256}:${prepared.base.reused ? 'reused' : 'created'}` });
        if (environmentRetry && current.environmentRetry?.request_id === environmentRetry.request_id) current.environmentRetry = null;
        // Ticket 47: a disk remedy is the boot's, settled by the boot phase commit below.
        if (!remedy || isDiskRemedy(remedy.remedy) || current.startRemedy?.request_id !== remedy.request_id) return;
        const replaced = prepared.seeds.filter(seed => seed.replaced).map(seed => `${seed.name}->${seed.replaced}`);
        current.history.push({ at: new Date().toISOString(), event: 'start-remedy-applied', origin: 'controller-recovery', executionId,
          detail: `${remedy.request_id}:${remedy.remedy}:${replaced.length ? replaced.join(',') : 'no divergent copy found'}`.slice(0, 512) });
        current.startRemedy = null;
      })).kind !== 'advanced') { observe(work.work_id, 'stale'); return; }
      phase = 'start';
      checkStop();
      startRequested = true;
      const pass = passes.get(work.work_id);
      // Ticket 47: the operator's disk remedy (repair/replace of a preserved disk that failed its check) is applied by THIS boot only.
      const diskRemedy = remedy && isDiskRemedy(remedy.remedy) ? remedy.remedy : null;
      const started = await ports.sandbox.start({ environment, configuration: ports.configuration, ...(pass ? { pass } : {}), ...(diskRemedy ? { diskRemedy } : {}) });
      if (started.status !== 'success') { await refused('start', started); return; }
      boot = started.boot;
      if ((await recordPhase(session, work.work_id, executionId, 'prepared', 'booted', 'execution-booted', current => { current.dispatch.boot = started.boot; }, current => {
        const at = new Date().toISOString();
        // Ticket 47: how the previous boot of this environment was stopped (clean = its root left read-only; forced otherwise), on the record.
        if (started.previousStop) current.history.push({ at, event: 'previous-boot-stop', origin: 'controller-recovery', executionId,
          detail: `${started.previousStop.boot}:${started.previousStop.result}:${started.previousStop.reason}` });
        if (!remedy || !diskRemedy || current.startRemedy?.request_id !== remedy.request_id) return;
        current.history.push({ at, event: 'start-remedy-applied', origin: 'controller-recovery', executionId,
          detail: `${remedy.request_id}:${remedy.remedy}:${started.remedy ? `${started.remedy.outcome}:${started.remedy.detail}` : 'not reported'}`.slice(0, 512) });
        current.startRemedy = null;
      })).kind !== 'advanced') { observe(work.work_id, 'stale'); return; }
      // Revalidation immediately before activation: authorization and a FRESH dependency evaluation of THIS attempt.
      phase = 'revalidate';
      checkStop();
      const authorization = await revalidateAuthorization(work);
      const { attemptId, evaluation } = await freshEvaluation(work);
      const refuse = async (reasons: string[]) => {
        const stop = await stopOwnBoot('activation revalidation refused');
        if (stop?.cessationConfirmed) await releaseBeforeStart(session, work.work_id, executionId, reasons);
        else await hold('ACTIVATION_REFUSED_CESSATION_UNCONFIRMED', `Refused before activation (${reasons.join(', ')}) but the boot cessation is not confirmed; Slot kept.`);
        observe(work.work_id, 'released-before-start', reasons);
      };
      if (!authorization.ok) { await refuse(authorization.reasons); return; }
      // Cheap pre-check so no credential is issued for a refused activation; the commit below re-checks the same facts.
      if (evaluation.conclusion !== 'satisfied') { await refuse([`DEPENDENCIES_${evaluation.conclusion.toUpperCase()}`]); return; }
      if (await deps.paused()) { await refuse(['GLOBAL_PAUSE']); return; }
      // The first prompt and, for a resumption, the continue/replace decision are planned BEFORE any credential is issued.
      const plan = await activationPlan(work, execution, prepared, pack ? { name: pack.name, manifestSha256: pack.manifestSha256 } : null);
      if (plan.kind === 'refused') { await refuse(plan.reasons); return; }
      if (plan.kind === 'insufficient') {
        // Spec §5.5/§6.1: insufficient recovery context blocks explicitly (before any credential), never a `continue`/recovery without context.
        const stop = await stopOwnBoot('recovery context insufficient');
        const nextStep = `The resumption context is insufficient (${plan.reasons.join(', ')}); no Builder was activated. Inspect the Work and its preserved artifacts and decide explicitly (ticket 26).`;
        const code = plan.reasons.some(reason => reason.includes('TOO_LARGE')) ? 'PROMPT_TOO_LARGE' : 'RECOVERY_CONTEXT_INSUFFICIENT';
        if (stop?.cessationConfirmed) await blockBeforeStart(session, work.work_id, executionId, code, nextStep);
        // Still a proven non-start (refused before any credential or worker request): the reservation is released; the Slot is kept.
        else await hold(`${code}_CESSATION_UNCONFIRMED`, nextStep, true);
        observe(work.work_id, 'recovery-context-insufficient', plan.reasons);
        return;
      }
      const { prompt, resume } = plan;
      // Ticket 25: cancelled (or delivered) meanwhile: refused BEFORE any credential is issued (the commit below re-checks it anyway).
      if (interrupted() || (await readWork(session, work.work_id))?.result !== 'open') { await refuse(['WORK_NOT_OPEN']); return; }
      phase = 'credential';
      checkStop();
      // Durable issuance intent BEFORE the call: an issued token is never unknown to the authority.
      if (await recordIssuance(session, work.work_id, executionId, { requestedAt: new Date().toISOString(), outcome: 'requested' }) !== 'recorded') { observe(work.work_id, 'stale'); return; }
      let grant;
      // Ticket 14: the purpose is Control's, fixed by the activity (publication activations only); never chosen by the model.
      const context = { workId: work.work_id, executionId, repository: { repository: configured.repository, installationId: configured.installationId, workflows: false },
        purpose: purposeOf(execution) };
      // Registered BEFORE issuing: a concurrent withdrawal sees the issuance in flight and revokes its grant.
      lifecycle = credentialLifecycle({ session, ports, work_id: work.work_id, executionId, stopping: stopping.signal, context,
        repositoryConfigured: () => deps.access.repositories.some(scope => scope.repository.toLowerCase() === configured.repository.toLowerCase() && scope.installationId === configured.installationId) });
      lifecycles.set(work.work_id, lifecycle);
      liveExecutions.add(executionId);
      try { grant = await lifecycle.issueInitial(); }
      catch (error) {
        const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'CREDENTIAL_ISSUANCE_FAILED';
        await recordIssuance(session, work.work_id, executionId, { outcome: (error as { outcome?: string }).outcome === 'known-rejected' ? 'failed' : 'unknown', code });
        throw error;
      }
      await recordIssuance(session, work.work_id, executionId, { outcome: 'issued', metadata: grant.metadata });
      const revoke = () => lifecycle!.withdraw('refused', { notifyWorker: false });
      // Withdrawn while issuing or before activation: the Builder is never activated with that grant; the own boot is stopped and held.
      const withdrawnBeforeActivation = async () => {
        // Ticket 25: a cancellation before activation is a proven non-start; the Slot is released once the own boot cessation is confirmed.
        if (interrupted() && interruption.reason === 'cancelled') { await refuse(['WORK_CANCELLED']); return; }
        await stopOwnBoot('credentials withdrawn before activation');
        await hold('ACTIVATION_CREDENTIALS_WITHDRAWN', 'The activity credentials were withdrawn before activation; the Builder was not activated. No charge was consumed; the Slot is kept (ticket 26).', true);
      };
      if (lifecycle.withdrawn) { await withdrawnBeforeActivation(); return; }
      // Ticket 13: round numbers continue the earlier Executions of this Work (their /artifacts/review/r<N> directories are preserved).
      const earlier = [...(work.previousExecutions ?? []), ...(work.execution && work.execution.executionId !== executionId ? [work.execution] : [])];
      const firstRound = 1 + Math.max(0, ...earlier.flatMap(item => item.review?.rounds ?? []).map(item => item.round));
      // Real run R-CAND v2: a continuation after a Question may treat the findings its predecessor delivered (its session holds them); its handoff
      // must know them (otherwise HANDOFF_TREATMENT_UNKNOWN_FINDING refuses every treatment of the earlier round).
      const delivered = inheritedFindings(inheritedRounds(execution, earlier));
      const promptSha256 = createHash('sha256').update(prompt).digest('hex');
      const confirmed = await confirmActivation(session, work.work_id, executionId, attemptId, grant.metadata, promptSha256, plan.decision);
      if (confirmed.kind === 'refused') { await revoke(); await refuse(confirmed.reasons); return; }
      if (confirmed.kind === 'stale') { await revoke(); observe(work.work_id, 'stale'); return; }
      phase = 'activate';
      checkStop(); // owner stop: the catch below withdraws and attempts revocation
      if (lifecycle.withdrawn) { await withdrawnBeforeActivation(); return; }
      // ask_user: the ACK is sent only after the durable commit of Question + impediment + publication intent (spec §5.5).
      // A question can only follow the start: wait until THIS process committed "Confirmar início" (message order is not commit order).
      let startCommitted!: (confirmed: boolean) => void;
      const startConfirmed = new Promise<boolean>(resolve => { startCommitted = resolve; });
      const onQuestion = async (request: WorkerQuestion) => {
        if (!await untilStopped(startConfirmed)) return { status: 'refused' as const, code: 'START_NOT_CONFIRMED' };
        const outcome = await registerQuestion(session, { work_id: work.work_id, executionId, invocationId: execution.invocationId, request, from: 'worker-notification' });
        if (outcome.kind === 'refused') return { status: 'refused' as const, code: outcome.code };
        await activity('question-recorded');
        deps.questionRecorded?.();
        // The activity now waits for an external answer: its credentials are withdrawn (no renewal) and revoked, independently of the ACK.
        void lifecycle!.withdraw('external-wait', { notifyWorker: true }).catch(() => {});
        return { status: 'recorded' as const };
      };
      const handle = await ports.workers.activate({ context: { workId: work.work_id, executionId, invocationId: execution.invocationId, role: 'builder',
        environmentRef: environment, bootRef: boot, phaseId: execution.request.publication ? 'builder-publication' : execution.request.reconciliation && resume?.reason !== 'QUESTION_ANSWERED' ? 'builder-reconciliation'
          : plan.continuation ? 'builder-continuation' : resume || execution.interruption ? 'builder-recovery' : 'builder-initial' },
        prompt, signal: activitySignal, ...(execution.request.publication ? publishOnly(ports.builder) : ports.builder),
        // Ticket 48: the repository's Builder budget adjustment recorded with this Execution's policies.
        ...(execution.request.policies.builderBudget ? { builderBudget: { ...execution.request.policies.builderBudget } } : {}),
        // Ticket 21 review: the exact leased push Control derived; any other push form is refused by the Builder Host.
        ...(execution.request.publication ? { pushPolicy: { branch: execution.request.publication.branch, head: execution.request.publication.head, remote: publicationRemote(work.repository.repository),
          expected: execution.request.publication.expectedRemote.state === 'present' ? execution.request.publication.expectedRemote.sha : null } } : {}),
        // Publish-only (review HIGH 1): no handoff for a publication activation; its Builder can never open a review round.
        // Ticket 22: a repair that updates the branch onto the current base is reviewed against THAT base tip (never the stale prepared base).
        ...(ports.reviews && !execution.request.publication ? { handoff: { baseCommit: (execution.request.repair && updateTarget(execution.request.repair.reasons)?.tip) || prepared.checkout.baseCommit, ...(ports.reviews.rounds ? { rounds: { first: firstRound, max: ports.reviews.rounds.max, ...(delivered.length ? { delivered } : {}) } } : {}),
          // Ticket 21: every capture of a reconciliation Execution checks that the authorized remote tip is still an ancestor of HEAD.
          ...(execution.request.reconciliation ? { preserve: execution.request.reconciliation.authorizedRemote }
            // Ticket 22: a repair over human commits — every capture proves the latest incorporated tip is still an ancestor of HEAD.
            : repairPreserve(execution.request.repair) ? { preserve: repairPreserve(execution.request.repair)! } : {}) } } : {}), ...(plan.continuation ? { continuation: { session: plan.continuation } } : {}) },
      { credential: grant.delivery }, { question: onQuestion });
      activated = true;
      await lifecycle.attach(handle.worker);
      try {
        phase = 'started';
        const start = await untilStopped(handle.started);
        // The local monotonic clock of this Execution starts with the start receipt observation (never another process's origin).
        const startMark = clock.monotonic();
        let consumed: Awaited<ReturnType<typeof confirmStart>> | undefined;
        try { consumed = await confirmStart(session, work.work_id, executionId, { ...start.receipt, ...start.invocation }, deps.controllerRunId ?? null); }
        finally { startCommitted(consumed === 'confirmed'); }
        if (consumed !== 'confirmed') { await hold(`START_RECEIPT_${consumed.toUpperCase().replaceAll('-', '_')}`, 'Start receipt was not consumable for this Execution.'); return; }
        startMono = startMark;
        startedAt.set(executionId, startMark);
        armTimeout(execution.timing?.timeoutSeconds ?? null);
        observe(work.work_id, 'started');
        if (ports.reviews && handle.handoffs) {
          phase = 'review';
          const handoffs = handle.handoffs;
          // The grant keeps its time-based renewal while the Builder is suspended for review (tools stay refused by its Host);
          // reviewers never receive it.
          const reviewed = reviewTask = (async () => {
            for (let event = await wait(handoffs.next()); event; event = await wait(handoffs.next())) {
              if (!await reviewRound(work, execution, environment, boot, handle, event, hold, { wait, signal: activitySignal, interrupted, activity }, firstRound)) return false;
            }
            return true;
          })();
          if (!await wait(lifecycle.renewWhile(reviewed))) {
            // Ticket 51: REVIEWER_RETRY_LIMIT waits for an operator decision (new review round or cancel) with nothing running: the own boot
            // (suspended Builder) is stopped now and the Execution settled like an interruption, so its Slot is released and it never
            // stays held. Unconfirmed cessation keeps it held (RECOVERY_CESSATION_UNCONFIRMED) for the next boot, as usual.
            const shown = await readWork(session, work.work_id);
            if (shown?.execution?.executionId === executionId && shown.execution.state === 'held' && shown.execution.held?.code === reviewerRetryLimitCode) {
              timerStop.abort();
              const stop = await stopOwnBoot('reviewer retry limit: waiting for the operator decision');
              const { decision } = await reconcileExecution({ session, ports, controllerRunId: deps.controllerRunId ?? 'unknown', inventory: 'empty' }, shown, 'review-retry-limit',
                { result: stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed', basis: stop?.cessationConfirmed ? 'sandbox-stop' : `sandbox-stop:${stop && 'code' in stop ? stop.code : 'UNCONFIRMED'}`,
                  environment, boot }).catch(() => ({ decision: 'stale' as const }));
              observe(work.work_id, 'review-retry-limit-settled', [String(decision)]);
            }
            return;
          }
        }
        phase = 'completed';
        // Renewal happens only while waiting for THIS activity; it never restarts, replays or recovers the Builder.
        const completed = await wait(lifecycle.renewWhile(handle.completed));
        timerStop.abort(); // the activity ended: its clock stops (also before an external wait)
        if (completed.status === 'question') {
          // Lost ACK/notification: the completion repeats the SAME identity and content; a missing record is registered once from it.
          // Content not intact and no record: explicit impediment, nothing invented or published.
          const request = completed.question;
          let code: string | null = null;
          const known = await readQuestion(session, request.questionId);
          // Only a record of THIS Work and THIS Execution may ever be bound to the end (and later to a recovery).
          const own = (question: typeof known) => question !== null && question.workId === work.work_id && question.executionId === executionId;
          if (intactRequest(request, work.work_id)) {
            const outcome = await registerQuestion(session, { work_id: work.work_id, executionId, invocationId: execution.invocationId, request, from: 'worker-completion' });
            if (outcome.kind === 'refused') {
              code = outcome.code;
              // Conflict: the existing record is kept untouched; this Work is blocked explicitly. Any other refusal leaves no record.
              await recordContentLost(session, work.work_id, executionId, request.questionId, code === 'QUESTION_ID_CONFLICT' ? 'QUESTION_ID_CONFLICT' : 'QUESTION_NOT_RECORDED',
                code === 'QUESTION_ID_CONFLICT' ? 'the identity is already recorded with other content or for another Work/Execution' : `it could not be recorded (${code})`);
            } else if (outcome.kind === 'recorded') deps.questionRecorded?.();
          } else if (!own(known)) {
            code = 'QUESTION_CONTENT_LOST';
            await recordContentLost(session, work.work_id, executionId, request.questionId);
          }
          const bound = own(await readQuestion(session, request.questionId));
          await recordEnd(session, work.work_id, executionId, 'question', code, bound ? request.questionId : null, elapsed(), completed.session ?? null);
        } else {
          // Ticket 13: Control's presence/correlation verification of opinions, treatments, gates and waivers, committed BEFORE the end.
          // It does not gate completion (a `completed` Execution may be `not-verified`); GitHub readiness (tickets 14/15) must consume it.
          // Preserved-source authorizations are confirmed by the Host first (confined no-follow read); unverified ones never count.
          if (ports.reviews?.rounds && completed.status === 'success') {
            const fresh = (await deps.readWorks()).find(item => item.work_id === work.work_id);
            const shown = fresh?.execution;
            const inherited = shown ? inheritedRounds(shown, fresh?.previousExecutions ?? []) : [];
            const references = [...new Set([...inherited, ...(shown?.review?.rounds ?? [])].flatMap(item => [...(item.declarations?.treatments ?? []), ...(item.declarations?.gates ?? [])])
              .flatMap(entry => entry.authorization?.kind === 'preserved-source' ? [entry.authorization.reference.split('#')[0]!] : []))].slice(0, 32);
            const sources: string[] = [];
            for (const reference of references) {
              const result = ports.sandbox.verifyPreservedSource
                ? await ports.sandbox.verifyPreservedSource({ environment: environment!, reference }).catch(() => ({ status: 'invalid' as const, code: 'PRESERVED_SOURCE_UNAVAILABLE' }))
                : { status: 'invalid' as const, code: 'PRESERVED_SOURCE_NOT_COMPOSED' };
              if (result.status === 'verified') sources.push(reference);
            }
            await recordVerification(session, work.work_id, executionId, { sources });
          }
          await recordEnd(session, work.work_id, executionId, completed.status === 'success' ? 'completed' : 'failure', completed.status === 'success' ? null : completed.code,
            null, elapsed(), completed.status === 'success' ? completed.session ?? null : null);
          if (completed.status === 'failure') endCode = completed.code;
          if (completed.status === 'failure') await questionUncertain();
        }
      } finally { timerStop.abort(); startCommitted(false); handle.close(); }
      await lifecycle.withdraw('ended', { notifyWorker: false });
      phase = 'stop';
      // Ticket 47: the budget end stops through the same clean stop as every end (guest shutdown, root read-only, then the VMM).
      const stop = await stopOwnBoot('builder execution ended');
      // Ticket 48: after a budget end whose boot ceased, the Host fingerprints the checkout again; progress decides continuation vs recovery.
      const budgetEnd = endCode === budgetExhaustedCode && stop?.cessationConfirmed && environment ? {
        atEnd: ports.sandbox.observeCheckout ? await ports.sandbox.observeCheckout({ environment }).catch(() => ({ status: 'unavailable' as const, code: 'CHECKOUT_OBSERVATION_FAILED' })) : null,
        guestStop: 'guestShutdown' in stop && stop.guestShutdown ? `${stop.guestShutdown.result}:${stop.guestShutdown.reason}` : null } : undefined;
      await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed', budgetEnd);
      observe(work.work_id, stop?.cessationConfirmed ? 'ended-slot-released' : 'ended-cessation-unconfirmed');
    } catch (error) {
      if (interrupted() && !stopping.signal.aborted && interruption.reason === 'cancelled') {
        // Ticket 25 (spec §5.4/§12.3): the prohibition is durable and the credentials were withdrawn BEFORE this interruption (SDK abort through
        // the activity signal). A request already sent may conclude; nothing is rolled back. The end is recorded, the own boot stopped and the
        // Slot released ONLY after confirmed cessation; otherwise it stays held and the next boot reconciles it.
        await timer?.catch(() => {});
        await reviewTask?.catch(() => {});
        await lifecycle?.withdraw('cancelled', { notifyWorker: true }).catch(() => {});
        const ended = await recordEnd(session, work.work_id, executionId, 'stopped', 'WORK_CANCELLED', null, elapsed()).catch(() => ({ kind: 'stale' as const }));
        const stop = await stopOwnBoot('work cancelled');
        if (ended.kind === 'advanced') await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed').catch(() => {});
        else await hold('CANCELLED_START_UNCONFIRMED', 'Cancelled while the start of the activity was not confirmed; the Slot is kept and the next controller boot reconciles it (ticket 26).').catch(() => {});
        observe(work.work_id, stop?.cessationConfirmed && ended.kind === 'advanced' ? 'cancelled-slot-released' : 'cancelled-cessation-unconfirmed', ['WORK_CANCELLED']);
        return;
      }
      if (interrupted() && !stopping.signal.aborted && interruption.reason === 'delivered') {
        // Ticket 17: the own PR was merged while this activity ran. Delivery is already recorded; the agent takes no new action: its
        // credentials are withdrawn/revoked, its own boot stopped and the Slot released only after confirmed cessation (cleanup waits for it).
        await lifecycle?.withdraw('delivered', { notifyWorker: true }).catch(() => {});
        await recordEnd(session, work.work_id, executionId, 'failure', 'WORK_DELIVERED', null, elapsed()).catch(() => {});
        const stop = await stopOwnBoot('work delivered');
        await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed').catch(() => {});
        observe(work.work_id, stop?.cessationConfirmed ? 'delivered-slot-released' : 'delivered-cessation-unconfirmed', ['WORK_DELIVERED']);
        return;
      }
      if (interrupted() && !stopping.signal.aborted) {
        // Timeout (spec §4.4/§5.7): recorded before the interruption; credentials withdrawn, own boot stopped, Slot only after cessation.
        // Blocked by EXECUTION_TIMEOUT for intervention: no retry, no new clock for it.
        await timer?.catch(() => {});
        await reviewTask?.catch(() => {});
        await lifecycle?.withdraw('timeout', { notifyWorker: false }).catch(() => {});
        await recordEnd(session, work.work_id, executionId, 'timeout', 'EXECUTION_TIMEOUT', null, elapsed()).catch(() => {});
        const stop = await stopOwnBoot('execution timeout');
        await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed').catch(() => {});
        observe(work.work_id, stop?.cessationConfirmed ? 'timeout-slot-released' : 'timeout-cessation-unconfirmed', ['EXECUTION_TIMEOUT']);
        return;
      }
      await questionUncertain().catch(() => {});
      if (stopping.signal.aborted) {
        await reviewTask?.catch(() => {});
        // Owner stop: the host channel closes (worker revoked); the grants are still in memory, so their revocation is attempted.
        await lifecycle?.withdraw('owner-stopped', { notifyWorker: false }).catch(() => {});
        // Stopped before the activation phase: no worker request exists. Nothing is retried because nothing started. If nothing was
        // booted or the own boot cessation is proven, the Slot is released and the Work returns to its queue position; otherwise
        // the reservation is still released without consumption but the Slot is kept under hold. At the activation phase itself the
        // outcome stays uncertain (a request may have reached the worker).
        if (activated || phase === 'activate') {
          // Ticket 26 (spec §11.4): administrative stop of a requested/started activity. Clean only after the host confirmed cessation and the
          // end was persisted; it then continues in a new Execution without a recovery charge. Otherwise it stays an interruption.
          const stop = await stopOwnBoot('administrative stop');
          const forced = stop?.status === 'success' && stop.termination === 'forced';
          const settled = stop?.cessationConfirmed ? await administrativeStop(work, executionId, environment!, boot!, forced).catch(() => false) : false;
          if (forced) {
            uncertainStops++;
            if ((await readWork(session, work.work_id))?.execution?.state !== 'ended') await hold('ADMINISTRATIVE_STOP_FORCED',
              'The own boot had to be terminated forcibly (grace period expired): not a clean stop; the next controller boot reconciles it as an interruption.').catch(() => {});
          } else if (!settled) {
            uncertainStops++;
            await hold('ADMINISTRATIVE_STOP_CESSATION_UNCONFIRMED', 'The owner stopped; the cessation of this activity (or its durable end) is not confirmed. ' +
              'The next controller boot reconciles it as an interruption (failure treatment, not a clean stop).').catch(() => {});
          }
        } else {
          const stop = await stopOwnBoot('owner stopped before activation');
          // Nothing was booted, or the own boot cessation is confirmed: the Slot can be released. Otherwise no worker was launched
          // (the reservation is released without consumption) but the Slot is kept, exactly like a refused revalidation.
          if (environment === undefined || !startRequested || stop?.cessationConfirmed) {
            await releaseBeforeStart(session, work.work_id, executionId, ['OWNER_STOPPED_BEFORE_ACTIVATION'], 'OWNER_STOPPED_BEFORE_ACTIVATION').catch(() => {});
          } else {
            uncertainStops++;
            await hold('OWNER_STOPPED_BEFORE_ACTIVATION_CESSATION_UNCONFIRMED',
              'The owner stopped before activation; no worker was launched and the reservation was released without consumption. The own boot cessation is not confirmed, so the Slot is kept (ticket 26).', true).catch(() => {});
          }
        }
        observe(work.work_id, 'owner-stopped', [phase]); return;
      }
      const code = codeOf(error, 'UNEXPECTED_FAILURE');
      const proven = provenNonStartOf(error);
      await hold(`${phase.toUpperCase()}_${code}`, proven
        ? 'No worker was launched; the reservation was released without consumption. Never retried automatically.'
        : 'Execution outcome is uncertain at this phase; never retried automatically. Operator recovery (ticket 26).', proven).catch(() => {});
    } finally { timerStop.abort(); lifecycles.delete(work.work_id); interrupts.delete(work.work_id); liveExecutions.delete(executionId); startedAt.delete(executionId); }
  }

  /**
   * Ticket 22: fresh complete read of the own PR (ticket 15 explanation, recorded), then the repair observation decides again in its own
   * commit. Only a correction still open, not charged, with its reasons current proceeds to admission; a failed read decides nothing.
   */
  async function revalidateRepair(work: WorkRecord, continuation = false): Promise<{ kind: 'repair'; basisExecutionId: string; request: NonNullable<ExecutionView['request']['repair']> } |
    { kind: 'repair-withdrawn' | 'repair-not-revalidated'; reasons: string[] }> {
    const target = checksTarget(work);
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
    if (!target || !configured) return { kind: 'repair-not-revalidated', reasons: [target ? 'REPOSITORY_NOT_CONFIGURED' : 'OWN_PULL_REQUEST_NOT_PUBLISHED'] };
    // Ticket 23: the human feedback is read again too — a review approved/dismissed just before the start withdraws ITS reason (no charge
    // when nothing remains); an unreadable feedback never confirms a review request that is still relevant.
    const feedback = await observeFeedback({ session, repository: deps.access.repository, operators: deps.access.operators ?? [], repo: () => configured }, work);
    if (feedback !== 'observed' && (work.correction?.reasons ?? []).some(item => item.code === 'HUMAN_CHANGES_REQUESTED')) {
      return { kind: 'repair-not-revalidated', reasons: ['PULL_REQUEST_FEEDBACK_NOT_READ'] };
    }
    let observation;
    try { observation = await deps.access.repository.readPullRequest({ repo: configured, number: target.number }); }
    catch { return { kind: 'repair-not-revalidated', reasons: ['PULL_REQUEST_QUERY_FAILED'] }; }
    if (observation.kind !== 'observed') return { kind: 'repair-not-revalidated', reasons: [observation.kind === 'unavailable' ? observation.code : 'PULL_REQUEST_NOT_READ'] };
    const evaluation = evaluateChecks({ at: new Date().toISOString(), expect: target.expect, observation });
    if (await recordChecks(session, work.work_id, target, evaluation) === 'stale') return { kind: 'repair-not-revalidated', reasons: ['STALE'] };
    // An uncertain/ineligible fresh read decides nothing (never admits on stale reasons, never withdraws).
    const fresh0 = repairTriggers({ checks: evaluation, publication: work.publication, readiness: work.readiness ?? null });
    // (Ticket 23: a correction of human requests only does not depend on the checks being conclusive.)
    if (fresh0.kind === 'none' && !fresh0.certain && (work.correction?.reasons ?? []).some(item => !isHumanReason(item))) return { kind: 'repair-not-revalidated', reasons: fresh0.why };
    const observed = await observeRepair(session, work.work_id, () => deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase()));
    const fresh = await readWork(session, work.work_id);
    const correction = fresh?.correction ?? null;
    const continues = continuation && correction?.consumed === true && correction.continuing === true && fresh !== undefined &&
      undeliveredHuman(correction, [...fresh.previousExecutions, ...(fresh.execution ? [fresh.execution] : [])]).length > 0;
    if (!fresh || !correction || correction.correctionId !== work.correction?.correctionId || (correction.consumed && !continues) || fresh.publication?.state !== 'published') {
      return { kind: 'repair-withdrawn', reasons: [observed.outcome, ...observed.reasons] };
    }
    const reasons = correction.reasons ?? [];
    if (!reasons.length) return { kind: 'repair-not-revalidated', reasons: ['REPAIR_REASONS_MISSING'] };
    await recordRepairRevalidation(session, fresh.work_id, correction.correctionId, reasons.map(item => `${item.code}${item.subject ? `:${item.subject}` : ''}@${item.headSha}`).join(','));
    return { kind: 'repair', basisExecutionId: fresh.publication.basisExecutionId,
      request: { correctionId: correction.correctionId, reasons: structuredClone(reasons), headSha: reasons[0]!.headSha, baseTip: evaluation.pullRequest.baseTip,
        ...(humanTips(fresh.publication).length ? { humanTips: humanTips(fresh.publication) } : {}) } };
  }
  const reservedIn = (tried: ReadonlySet<string>) => [...tried].filter(id => running.has(id)).length;
  const dispatcher = {
    view: () => ({ running: running.size, last }),
    /** Whether an activity of this Work runs in THIS process (ticket 15 tracking skips it). */
    active: (work_id: string) => running.has(work_id),
    /** Live monotonic duration of an Execution running in THIS process, or null (then the durable evidence is presented). */
    liveElapsed(executionId: string): number | null {
      const start = startedAt.get(executionId);
      return start === undefined ? null : Math.max(0, clock.monotonic() - start);
    },
    /** External wait / cancellation entry (tickets 10/25): withdraws the active Execution's credentials and attempts their revocation. */
    /** Ticket 17: whether an Execution of this Work runs in THIS owner (cleanup never touches a Work in use). */
    running: (work_id: string) => running.has(work_id),
    /** Ticket 17: a confirmed delivery interrupts the Work's running activity (before activation, `confirmActivation` refuses it). */
    interruptDelivered(work_id: string): 'interrupted' | 'not-running' {
      const stop = interrupts.get(work_id);
      if (!stop) return 'not-running';
      stop('delivered');
      return 'interrupted';
    },
    /**
     * Ticket 25: after the durable cancellation commit, the running activity of THIS owner has its credentials withdrawn (renewal stopped,
     * worker notified, revocation attempted) FIRST, then its activity scope is interrupted (SDK abort, own boot stop, Slot after cessation).
     */
    async cancel(work_id: string): Promise<'interrupted' | 'not-running'> {
      const stop = interrupts.get(work_id);
      if (!stop) return 'not-running';
      await lifecycles.get(work_id)?.withdraw('cancelled', { notifyWorker: true }).catch(() => {});
      stop('cancelled');
      return 'interrupted';
    },
    async withdraw(work_id: string, reason: Extract<CredentialWithdrawal, 'external-wait' | 'cancelled'>): Promise<'withdrawn' | 'not-active'> {
      const lifecycle = lifecycles.get(work_id);
      if (!lifecycle) return 'not-active';
      await lifecycle.withdraw(reason, { notifyWorker: true });
      return 'withdrawn';
    },
    /**
     * One dispatch pass of the owner loop (ticket 24, spec §4.3): every free Slot is filled in THIS pass, in queue order (repairs first, FIFO in
     * each category, no preemption, no global or per-repository mutex). Each candidate is revalidated and admitted on its own; a candidate
     * refused by its own attempt is skipped for the rest of the pass, keeps its position and never blocks the independents behind it. Each
     * admission re-checks the capacity in its commit (held Slots, including uncertain ones, are never free). At most `refusalsPerPass`
     * refused attempts per pass (bounded GitHub reads); the rest waits for the next pass, in place.
     */
    async tick() {
      if (stopping.signal.aborted) return;
      // Discovery is tracking (safe reads), not a trigger: it runs while paused too, before any selection.
      await reconcilePublications();
      const tried = new Set<string>();
      const pass = randomUUID();
      for (;;) {
        if (stopping.signal.aborted || await deps.paused()) return;
        if (tried.size - reservedIn(tried) >= refusalsPerPass) { observe(null, 'pass-refusal-limit', [`REFUSED_${refusalsPerPass}`]); return; }
        // The first observation of the pass is kept when a later step merely finds nothing more to do.
        if (await deps.heldSlots() >= ports.capacity) { if (!tried.size) observe(null, 'no-slot-available'); return; }
        if (!await dispatchOne(tried, pass)) { if (!tried.size) observe(null, 'nothing-eligible'); return; }
      }
    },
    async stop() { stopping.abort(); await Promise.allSettled(running.values()); return { uncertain: uncertainStops }; },
  };

  /** One candidate of the pass: false when none is left. A refused attempt is recorded in `tried` and observed, never retried in this pass. */
  async function dispatchOne(tried: Set<string>, pass: string): Promise<boolean> {
    const works = await deps.readWorks();
    // Ticket 22 (spec §4.3): repairs before normal Works, FIFO in each category, no preemption of a running activity.
    const candidates = queueOrder(works.filter(work => work.result === 'open' && work.queue.pending && !running.has(work.work_id) && !tried.has(work.work_id)))
      .map(work => ({ work_id: work.work_id, blockers: dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies.latest,
        currentAttempt: deps.currentAttempt(work.repository.repository) }).concat(deps.runBlockers?.(work) ?? []) }));
    // Ticket 22: a repair whose fresh revalidation cannot conclude (read failed, not configured, stale) or that was withdrawn is skipped for
    // THIS pass, keeping its position; the next eligible Work is tried (one impeded repair never stalls the dispatch). Ticket 24: such a
    // skip is a refused attempt of the pass (`tried`), counted against `refusalsPerPass`.
    const skipped = new Set<string>();
    let work!: WorkRecord;
    let revalidated: Extract<Awaited<ReturnType<typeof revalidateRepair>>, { kind: 'repair' }> | undefined;
    for (;;) {
      if (skipped.size && tried.size - reservedIn(tried) >= refusalsPerPass) return false;
      const next = selectNext(candidates.filter(item => !skipped.has(item.work_id))).next;
      if (!next) { if (skipped.size) observe(null, 'nothing-eligible', [...skipped]); return false; }
      tried.add(next);
      const candidate = works.find(item => item.work_id === next)!;
      const pending = candidate.correction;
      // Ticket 23: or the continuation of a CHARGED correction that received human requests during its activity (same charge, preserved).
      const continuation = Boolean(pending?.consumed && pending.continuing && candidate.publication?.state === 'published' &&
        undeliveredHuman(pending, [...candidate.previousExecutions, ...(candidate.execution ? [candidate.execution] : [])]).length);
      if (resumeBasis(candidate)?.end?.outcome === 'question' || !pending || (pending.consumed && !continuation) || !observationDriven(pending)) { work = candidate; break; }
      // Ticket 22 (spec §10 step 2): immediately before admission, the requirements and reasons are read AGAIN (fresh complete read of the
      // own PR); reasons that disappeared are dropped and a correction left without any is withdrawn without charge.
      const result = await revalidateRepair(candidate, continuation);
      if (result.kind === 'repair') { work = candidate; revalidated = result; break; }
      observe(candidate.work_id, result.kind, result.reasons);
      skipped.add(candidate.work_id);
    }
    const authorization = await revalidateAuthorization(work);
    if (!authorization.ok) {
      // Ticket 25: an observed withdrawal suspends the Work durably (only `resume` lifts it); an unavailable read concludes nothing.
      // Review MED: only a confirmed closure/label absence is durable; every other code is transient.
      const withdrawal = confirmedWithdrawal(authorization.reasons);
      if (withdrawal.kind === 'withdrawn') await deps.authorizationWithdrawn?.(work.work_id, withdrawal.codes);
      observe(work.work_id, 'authorization-not-confirmed', authorization.reasons); return true;
    }
    // After a Question: only its accepted answer is a recovery basis; after a COMPLETED Execution: only an authorized concrete scope
    // change (ticket 11). Both are re-checked in the admission commit; a later Ticket/link edit is never one.
    const previous = resumeBasis(work);
    const scopeUpdateIds = pendingScope(work).map(update => update.scopeUpdateId);
    let resume: NonNullable<ExecutionView['request']['resume']> | undefined;
    let publication: NonNullable<ExecutionView['request']['publication']> | undefined;
    let reconciliation: NonNullable<ExecutionView['request']['reconciliation']> | undefined;
    let repair: NonNullable<ExecutionView['request']['repair']> | undefined;
    if (revalidated) {
      resume = { previousExecutionId: revalidated.basisExecutionId, questionId: null, answerSha256: null, scopeUpdateIds, reason: 'REPAIR_REQUESTED' };
      repair = revalidated.request;
    }
    if (resume) { /* ticket 22 repair resumption decided above */ }
    else if (previous?.end?.outcome === 'question') {
      const answered = previous.end.questionId ? await readQuestion(session, previous.end.questionId) : null;
      if (!answered?.answer || answered.workId !== work.work_id || answered.executionId !== previous.executionId) { observe(work.work_id, 'refused', ['QUESTION_NOT_ANSWERED']); return true; }
      resume = { previousExecutionId: previous.executionId, questionId: answered.questionId, answerSha256: answered.answer.sha256, scopeUpdateIds, reason: 'QUESTION_ANSWERED' };
      // Ticket 21: a reconciliation Execution that asked keeps its reconciliation request (the same authorization, the same preservation check).
      if (previous.request.reconciliation) reconciliation = structuredClone(previous.request.reconciliation);
      // Ticket 22: a repair Execution that asked keeps its repair request (same correction, same reasons, same charge).
      if (previous.request.repair) repair = structuredClone(previous.request.repair);
    } else if (previous && work.publication?.state === 'reconciling' && reconciliationInterrupted(work, previous)) {
      // Real run q21-human-v4: the reconciliation Execution was interrupted (transient worker failure): ticket 26's operational recovery
      // continues it with the SAME reconciliation request (preserve check, later lease) and the authorization stays bound (no resume).
      reconciliation = structuredClone(previous.request.reconciliation!);
    } else if (previous && work.publication?.state === 'reconciling') {
      // Ticket 21: the ONE divergence the accepted answer authorized to incorporate (re-checked in the admission commit).
      const authorization = authorizationInForce(work.publication);
      const divergence = work.publication.divergences?.find(item => item.divergenceId === authorization?.divergenceId);
      if (!authorization || authorization.mode !== 'incorporate' || authorization.state !== 'authorized' || !divergence) { observe(work.work_id, 'refused', ['RECONCILIATION_NOT_AUTHORIZED']); return true; }
      resume = { previousExecutionId: previous.executionId, questionId: authorization.questionId, answerSha256: authorization.answerSha256, scopeUpdateIds: [], reason: 'RECONCILIATION_AUTHORIZED' };
      reconciliation = { divergenceId: authorization.divergenceId, questionId: authorization.questionId, answerSha256: authorization.answerSha256,
        expected: structuredClone(authorization.expected), authorizedRemote: authorization.authorizedRemote, localHead: divergence.local ?? previous.review?.rounds.at(-1)?.handoff.summary?.head ?? '',
        strategy: 'rebase-unless-agents-documents-another' };
    } else if (previous?.end?.outcome === 'completed' && scopeUpdateIds.length) {
      resume = { previousExecutionId: previous.executionId, questionId: null, answerSha256: null, scopeUpdateIds, reason: 'SCOPE_UPDATED' };
    } else if (previous && work.publication?.state === 'requested' && work.publication.verified && work.publication.expectedRemote &&
        publicationResumes(previous, work.publication.basisExecutionId)) {
      // Ticket 14: the requested publication activation, with exactly the recorded verified commit and lease expectation (re-checked in the commit).
      resume = { previousExecutionId: previous.executionId, questionId: null, answerSha256: null, scopeUpdateIds, reason: 'PUBLICATION_REQUESTED' };
      publication = { basisExecutionId: work.publication.basisExecutionId, head: work.publication.verified.head, branch: work.publication.branch,
        base: work.publication.base, marker: work.publication.marker, expectedRemote: work.publication.expectedRemote, pullRequest: work.publication.update ?? null };
    }
    // Ticket 22: every later activation of a CHARGED correction (Question resume, ticket 26 interruption recovery or continuation) keeps its
    // repair request — reasons, human tips, base tip — and delivers the reasons deferred since the charge (re-checked in the admission commit).
    if (!publication && !reconciliation && work.correction?.consumed && work.correction.trigger === 'effective-impediment') {
      const id = work.correction.correctionId;
      const last = repair ?? [...work.previousExecutions, ...(work.execution ? [work.execution] : [])].reverse().find(item => item.request.repair?.correctionId === id)?.request.repair;
      if (last) {
        const known = new Set(last.reasons.map(fingerprint));
        repair = { ...structuredClone(last), reasons: [...last.reasons, ...(work.correction.pendingReasons ?? []).filter(item => !known.has(fingerprint(item)))].slice(0, 16) };
      }
    }
    // Ticket 26: after an interrupted Execution, its basis (operational recovery or clean-stop continuation), re-checked in the commit.
    const interruption = interruptionBasis(work);
    const { attemptId } = await freshEvaluation(work);
    const configuredScope = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
    // Ticket 48: the repository's Builder budget adjustment (validated by the configuration: at most 2x) travels with the Execution's policies.
    let builderBudget: ReturnType<typeof builderBudgetPolicy>;
    try { builderBudget = ports.builder.modelBudget === 'builder-v1' ? builderBudgetPolicy(configuredScope?.builderBudget) : null; }
    catch { observe(work.work_id, 'refused', ['BUILDER_BUDGET_ABOVE_MAXIMUM']); return true; }
    const policies = { ...(publication ? publishOnly(ports.builder) : ports.builder), ...(builderBudget ? { builderBudget } : {}) };
    const admission = await admitExecution(session, { ...(interruption ? { interruption } : {}), now: (ports.calendar ?? Date).now(), work_id: work.work_id, attemptId, capacity: ports.capacity, authorizationObservedAt: authorization.observedAt,
      request: { ticket: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
        branch: `factory/${work.ticket.number}-${work.work_id.slice(0, 8)}`, policies, ...(publication ? { publication } : {}),
        ...(reconciliation ? { reconciliation } : {}), ...(repair ? { repair } : {}) }, ...(resume ? { resume } : {}),
      limits: configuredScope ?? {} });
    if (admission.kind === 'refused') { observe(work.work_id, 'refused', admission.reasons); return true; }
    observe(work.work_id, 'reserved');
    passes.set(work.work_id, pass);
    const task = execute(work, admission.execution).finally(() => { running.delete(work.work_id); passes.delete(work.work_id); });
    running.set(work.work_id, task);
    return true;

  }
  return dispatcher;
}
