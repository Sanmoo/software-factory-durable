import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BuilderGrant } from '../../contracts/index.js';
import type { BootRef, EnvironmentRef } from '../../sandbox/index.js';
import type { ProposalIdentity } from '../../contracts/index.js';
import type { HandoffEvent } from '../../workers/index.js';
import { classifyCapture, deliveryPrompt, exemptionPrompt, lastReviewed, planReviews, type CaptureClass, type ReviewPlan } from '../rules/review.js';
import { createChecksTracker } from './checks.js';
import { recordConclusion, recordDelivery, recordHandoff, recordReviewerEnd, recordReviewerStart, recordVerification } from './review.js';
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
import { decideDiscovery, publicationAttempted, publicationPrompt, publicationResumes, publicationStep, type DiscoveryObservation } from '../rules/publication.js';
import { evaluatePublication, recordDiscovery } from './publication.js';
import { purposeOf } from './execution.js';
import type { SessionRef } from '../types.js';
import { interruptionRecoveryPrompt } from '../rules/recovery.js';
import { reconcileExecution } from './recovery.js';
import type { WorkerQuestion } from '../../workers/index.js';
import type { Session } from './store.js';

export type DispatchObservation = { at: string; work_id: string | null; outcome: string; reasons: string[] };
const maxTimer = 2147483647;
/** Publish-only Builder policies (review HIGH 1): the same pack/budget/output policy, without the edit tool (and never the handoff). */
const publishOnly = (policies: ExecutionPorts['builder']): ExecutionPorts['builder'] => {
  const { editSourceMaxBytes: _edit, ...rest } = policies;
  return rest;
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
  runBlockers?(work: WorkRecord): string[] }) {
  const { session, ports } = deps;
  // Live duration/timeout clock (spec §5.7): local monotonic, separate from the polling cadence and from Pi Durable's own timers.
  const clock = ports.clock ?? systemClock;
  // Monotonic start of each Execution running in THIS process (memory only): live duration for inspection.
  const startedAt = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  const lifecycles = new Map<string, ReturnType<typeof credentialLifecycle>>();
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
  // Ticket 15: explanation of the required checks of linked own PRs (safe reads, durable record); tracking, never a trigger.
  const checks = createChecksTracker({ session, access: deps.access, readWorks: deps.readWorks, busy: work_id => running.has(work_id) });

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
      ...(multi ? { previousSessions: { standards: previous?.reviewers.standards.opinion?.session.file ?? null, spec: previous?.reviewers.spec.opinion?.session.file ?? null } } : {}) }) : [];
    const recorded = await recordHandoff(session, work.work_id, executionId, { event, before, plans, reviewer: reviews.reviewer, failure,
      ...(multi ? { firstRound, classification } : {}) });
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
    const runReviewer = async (plan: ReviewPlan) => {
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
        await recordReviewerEnd(session, work.work_id, executionId, round, plan.role, { cessation: 'completion-observed', ...(completed.status === 'success' && completed.opinion
          ? { opinion: completed.opinion } : { failure: completed.status === 'failure' && /^[A-Z_]{1,64}$/.test(completed.code) ? completed.code : 'OPINION_MISSING' }) });
      } catch (error) {
        if (stopping.signal.aborted || scope.interrupted()) throw error;
        await recordReviewerEnd(session, work.work_id, executionId, round, plan.role, { failure: 'REVIEWER_OUTCOME_UNCERTAIN', cessation: 'unconfirmed' });
      } finally { reviewer.close(); }
    };
    if (!failure) await Promise.all(plans.map(runReviewer));
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

  async function stillRunning(work_id: string, executionId: string, round: number) {
    const shown = (await deps.readWorks()).find(item => item.work_id === work_id)?.execution;
    const current = shown?.executionId === executionId ? shown.review?.rounds.find(item => item.round === round) : undefined;
    return !current || Object.values(current.reviewers).some(reviewer => reviewer.cessation === 'unconfirmed');
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
    if (!resume && basis) {
      // Ticket 26: after an interrupted Execution, an explicit substitute instruction on the PRESERVED workspace (same base/branch/checkout,
      // reused environment) — the interruption is its trigger; never `/implement` again, never a blind replay of the last tool.
      const previous = current?.previousExecutions.find(item => item.executionId === basis.previousExecutionId) ?? null;
      if (!previous) return { kind: 'insufficient', reasons: ['PREVIOUS_EXECUTION_MISSING'] };
      const context = recoveryContext({ previous: { baseCommit: previous.request.baseCommit, branch: previous.request.branch, checkout: previous.request.checkout },
        prepared: { baseCommit: prepared.checkout.baseCommit, branch: prepared.checkout.branch, checkout: prepared.checkout.path, reused: prepared.checkout.reused },
        trigger: { answer: true, scopeUpdates: updates.length } });
      if (!context.sufficient) return { kind: 'insufficient', reasons: context.reasons };
      const prompt = [interruptionRecoveryPrompt({ ticketUrl: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
        baseCommit: prepared.checkout.baseCommit, branch: execution.request.branch, checkout: prepared.checkout.path, workId: work.work_id,
        executionId: execution.executionId, skillDirectory, previousExecutionId: basis.previousExecutionId, reason: basis.reason, code: basis.code,
        reviews: Boolean(ports.reviews) }), ...(updates.length ? ['', ...scopeSection(updates)] : [])].join('\n');
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
    const answered = resume.questionId ? await readQuestion(session, resume.questionId) : null;
    if (resume.questionId && (!answered?.answer || answered.answer.sha256 !== resume.answerSha256 || answered.workId !== work.work_id ||
        answered.executionId !== resume.previousExecutionId)) return { kind: 'refused', reasons: ['RESUME_BASIS_CHANGED'] };
    const previous = current?.previousExecutions.find(item => item.executionId === resume.previousExecutionId) ?? null;
    if (!previous) return { kind: 'insufficient', reasons: ['PREVIOUS_EXECUTION_MISSING'] };
    const context = recoveryContext({ previous: { baseCommit: previous.request.baseCommit, branch: previous.request.branch, checkout: previous.request.checkout },
      prepared: { baseCommit: prepared.checkout.baseCommit, branch: prepared.checkout.branch, checkout: prepared.checkout.path, reused: prepared.checkout.reused },
      trigger: { answer: Boolean(answered?.answer), scopeUpdates: updates.length } });
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
        answer: answered && answer ? { questionId: answered.questionId, ...answer } : null, scopeUpdates: updates, reviewRounds: Boolean(ports.reviews?.rounds) });
      if (continued.kind === 'insufficient') return { kind: 'insufficient', reasons: continued.reasons };
      return { kind: 'ready', prompt: continued.prompt, resume, decision, continuation: recorded };
    }
    const lastRound = [...(current?.previousExecutions ?? [])].reverse().flatMap(item => [...(item.review?.rounds ?? [])].reverse()).find(round => round.handoff.summary) ?? null;
    const known: KnownContext = {
      previousExecutions: (current?.previousExecutions ?? []).map(item => ({ executionId: item.executionId,
        outcome: item.end ? `${item.end.outcome}${item.end.code ? ` (${item.end.code})` : ''}` : item.held ? `released/held (${item.held.code})` : item.state, at: item.end?.at ?? item.held?.at ?? null })),
      questions: (current ? await readQuestions(session, current) : []).map(item => ({ questionId: item.questionId, state: item.state, comment: item.publication.comment?.url ?? null })),
      versions: lastRound ? { spec: lastRound.versions.spec?.version ?? null, instructions: lastRound.versions.instructions?.version ?? null, head: lastRound.handoff.summary?.head ?? null } : null,
      scopeUpdates: updates };
    const recovered = recoveryPrompt({ ticketUrl: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
      baseCommit: prepared.checkout.baseCommit, branch: execution.request.branch, checkout: prepared.checkout.path, workId: work.work_id, executionId: execution.executionId,
      skillDirectory, previousExecutionId: previous.executionId,
      question: answered ? { questionId: answered.questionId, question: answered.content.question, context: answered.content.context } : null,
      answer, replacement: { reason: decided.reason }, known, reviewRounds: Boolean(ports.reviews?.rounds) });
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
      pullRequest: request.pullRequest ?? null,
      verified: { reviewedRound: requested.verified.reviewedRound, gates: requested.verified.gates, requiredChecks: requested.verified.requiredChecks } });
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
    const attempts = (publication.attempts ?? []).filter(item => item.head === publication.verified?.head);
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
    if (step.kind !== 'discover') return false;
    const work = await readWork(session, listed.work_id);
    const publication = work?.publication;
    if (!work || !publication?.verified || running.has(work.work_id)) return false;
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
    const app = await appIdentity();
    let observation: DiscoveryObservation;
    let observedAt: string | null = null;
    if (!configured) observation = { kind: 'incomplete', code: 'REPOSITORY_NOT_CONFIGURED' };
    else {
      try {
        const read = await deps.access.repository.findPublication({ repo: configured, issueNumbers: [work.ticket.number], knownBranches: [publication.branch],
          refs: true, base: publication.base });
        observedAt = read.observedAt;
        const issue = read.kind === 'observed' ? read.issues[String(work.ticket.number)] : undefined;
        const tip = read.kind === 'observed' ? read.branches[publication.branch] : undefined;
        observation = read.kind !== 'observed' ? { kind: 'incomplete', code: read.code }
          : !issue ? { kind: 'incomplete', code: 'PUBLICATION_NOT_REPORTED' }
          : issue.completeness === 'incomplete' ? { kind: 'incomplete', code: issue.code }
          : { kind: 'observed', repositoryId: read.repositoryId, candidates: issue.candidates,
            branch: !tip ? { state: 'unknown', code: 'BRANCH_NOT_REPORTED' } : tip.state === 'unknown' ? { state: 'unknown', code: tip.code } : tip,
            refs: !read.refs ? { state: 'unknown', code: 'REFS_NOT_REPORTED' } : read.refs.state === 'complete' ? read.refs : { state: 'unknown', code: read.refs.code },
            baseProtection: !read.baseProtection ? { state: 'unknown', code: 'BASE_PROTECTION_NOT_REPORTED' } : read.baseProtection };
      } catch { observation = { kind: 'incomplete', code: 'PUBLICATION_QUERY_FAILED' }; }
    }
    const decision = decideDiscovery({ expect: { workId: work.work_id, ticketNumber: work.ticket.number, branch: publication.branch, base: publication.base,
      repositoryId: work.repository.repositoryId, head: publication.verified.head, app }, attempted: step.attempted, previousHeads: publication.linkedHeads ?? [],
      prOnlyRecovery: prOnlyRecovery(publication),
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
    const hold = async (code: string, nextStep: string, provenNonStart = false) => {
    try { await holdExecution(session, work.work_id, executionId, code, nextStep, provenNonStart); observe(work.work_id, 'held', [code]); }
    finally { await lifecycle?.withdraw('held', { notifyWorker: true }); }
  };
    // Activity scope of THIS Execution: the timeout interrupts it (Builder and reviewers) without stopping the owner.
    const interrupt = new AbortController();
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
    const stopOwnBoot = async (reason: string) => environment && boot ? ports.sandbox.stop({ environment, boot, reason }).catch(() => ({ status: 'indeterminate' as const, cessationConfirmed: false as const, code: 'STOP_UNAVAILABLE' })) : undefined;
    try {
      checkStop();
      const prepared = await ports.sandbox.prepare({ workId: work.work_id, configuration: ports.configuration,
        checkout: { repository: work.repository.repository, repositoryId: work.repository.repositoryId, installationId: configured.installationId, base: work.repository.base, branch: execution.request.branch } });
      if (prepared.status !== 'success' || !('checkout' in prepared)) { await hold(`PREPARE_${prepared.status === 'success' ? 'CHECKOUT_MISSING' : prepared.code}`, 'Preparation did not complete; it is never retried automatically. Inspect the environment (ticket 26 recovery).', true); return; }
      environment = prepared.environment;
      const pack = prepared.seeds.find(seed => seed.name.startsWith('factory/skill-pack/'));
      if ((await recordPhase(session, work.work_id, executionId, 'reserved', 'prepared', 'execution-prepared', current => {
        current.dispatch.environment = prepared.environment;
        current.request.baseCommit = prepared.checkout.baseCommit;
        current.request.checkout = prepared.checkout.path;
        current.request.skillPack = pack ? { name: pack.name, manifestSha256: pack.manifestSha256 } : null;
      })).kind !== 'advanced') { observe(work.work_id, 'stale'); return; }
      phase = 'start';
      checkStop();
      startRequested = true;
      const started = await ports.sandbox.start({ environment, configuration: ports.configuration });
      if (started.status !== 'success') { await hold(`START_${started.code}`, 'The boot did not become operational; no automatic retry. Observe/stop the environment explicitly.', true); return; }
      boot = started.boot;
      if ((await recordPhase(session, work.work_id, executionId, 'prepared', 'booted', 'execution-booted', current => { current.dispatch.boot = started.boot; })).kind !== 'advanced') { observe(work.work_id, 'stale'); return; }
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
        await stopOwnBoot('credentials withdrawn before activation');
        await hold('ACTIVATION_CREDENTIALS_WITHDRAWN', 'The activity credentials were withdrawn before activation; the Builder was not activated. No charge was consumed; the Slot is kept (ticket 26).', true);
      };
      if (lifecycle.withdrawn) { await withdrawnBeforeActivation(); return; }
      // Ticket 13: round numbers continue the earlier Executions of this Work (their /artifacts/review/r<N> directories are preserved).
      const firstRound = 1 + Math.max(0, ...[...(work.previousExecutions ?? []), ...(work.execution && work.execution.executionId !== executionId ? [work.execution] : [])]
        .flatMap(item => item.review?.rounds ?? []).map(item => item.round));
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
        environmentRef: environment, bootRef: boot, phaseId: execution.request.publication ? 'builder-publication' : plan.continuation ? 'builder-continuation' : resume || execution.interruption ? 'builder-recovery' : 'builder-initial' },
        prompt, signal: activitySignal, ...(execution.request.publication ? publishOnly(ports.builder) : ports.builder),
        // Publish-only (review HIGH 1): no handoff for a publication activation; its Builder can never open a review round.
        ...(ports.reviews && !execution.request.publication ? { handoff: { baseCommit: prepared.checkout.baseCommit, ...(ports.reviews.rounds ? { rounds: { first: firstRound, max: ports.reviews.rounds.max } } : {}) } } : {}), ...(plan.continuation ? { continuation: { session: plan.continuation } } : {}) },
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
          const reviewed = (async () => {
            for (let event = await wait(handoffs.next()); event; event = await wait(handoffs.next())) {
              if (!await reviewRound(work, execution, environment, boot, handle, event, hold, { wait, signal: activitySignal, interrupted, activity }, firstRound)) return false;
            }
            return true;
          })();
          if (!await wait(lifecycle.renewWhile(reviewed))) return;
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
            const shown = (await deps.readWorks()).find(item => item.work_id === work.work_id)?.execution;
            const references = [...new Set((shown?.review?.rounds ?? []).flatMap(item => [...(item.declarations?.treatments ?? []), ...(item.declarations?.gates ?? [])])
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
          if (completed.status === 'failure') await questionUncertain();
        }
      } finally { timerStop.abort(); startCommitted(false); handle.close(); }
      await lifecycle.withdraw('ended', { notifyWorker: false });
      phase = 'stop';
      const stop = await stopOwnBoot('builder execution ended');
      await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed');
      observe(work.work_id, stop?.cessationConfirmed ? 'ended-slot-released' : 'ended-cessation-unconfirmed');
    } catch (error) {
      if (interrupted() && !stopping.signal.aborted) {
        // Timeout (spec §4.4/§5.7): recorded before the interruption; credentials withdrawn, own boot stopped, Slot only after cessation.
        // Blocked by EXECUTION_TIMEOUT for intervention: no retry, no new clock for it.
        await timer?.catch(() => {});
        await lifecycle?.withdraw('timeout', { notifyWorker: false }).catch(() => {});
        await recordEnd(session, work.work_id, executionId, 'timeout', 'EXECUTION_TIMEOUT', null, elapsed()).catch(() => {});
        const stop = await stopOwnBoot('execution timeout');
        await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed').catch(() => {});
        observe(work.work_id, stop?.cessationConfirmed ? 'timeout-slot-released' : 'timeout-cessation-unconfirmed', ['EXECUTION_TIMEOUT']);
        return;
      }
      await questionUncertain().catch(() => {});
      if (stopping.signal.aborted) {
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
    } finally { timerStop.abort(); lifecycles.delete(work.work_id); liveExecutions.delete(executionId); startedAt.delete(executionId); }
  }

  return {
    view: () => ({ running: running.size, last }),
    /** Live monotonic duration of an Execution running in THIS process, or null (then the durable evidence is presented). */
    liveElapsed(executionId: string): number | null {
      const start = startedAt.get(executionId);
      return start === undefined ? null : Math.max(0, clock.monotonic() - start);
    },
    /** External wait / cancellation entry (tickets 10/25): withdraws the active Execution's credentials and attempts their revocation. */
    async withdraw(work_id: string, reason: Extract<CredentialWithdrawal, 'external-wait' | 'cancelled'>): Promise<'withdrawn' | 'not-active'> {
      const lifecycle = lifecycles.get(work_id);
      if (!lifecycle) return 'not-active';
      await lifecycle.withdraw(reason, { notifyWorker: true });
      return 'withdrawn';
    },
    async tick() {
      if (stopping.signal.aborted) return;
      // Discovery is tracking (safe reads), not a trigger: it runs while paused too, before any selection.
      await reconcilePublications();
      if (stopping.signal.aborted) return;
      // Ticket 15: required-checks tracking runs while paused too (it starts nothing), before any selection; a failure never stops dispatch.
      await checks.pass(stopping.signal).catch((error: unknown) => observe(null, 'checks-pass-failed', [codeOf(error, 'CHECKS_PASS_FAILED')]));
      if (stopping.signal.aborted || await deps.paused()) return;
      if (await deps.heldSlots() >= ports.capacity) { observe(null, 'no-slot-available'); return; }
      const works = await deps.readWorks();
      const candidates = works.filter(work => work.result === 'open' && work.queue.pending && work.queue.category === 'normal' && !running.has(work.work_id))
        .map(work => ({ work_id: work.work_id, blockers: dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies.latest,
          currentAttempt: deps.currentAttempt(work.repository.repository) }).concat(deps.runBlockers?.(work) ?? []) }));
      const next = selectNext(candidates).next;
      if (!next) { observe(null, 'nothing-eligible'); return; }
      const work = works.find(item => item.work_id === next)!;
      const authorization = await revalidateAuthorization(work);
      if (!authorization.ok) { observe(work.work_id, 'authorization-not-confirmed', authorization.reasons); return; }
      // After a Question: only its accepted answer is a recovery basis; after a COMPLETED Execution: only an authorized concrete scope
      // change (ticket 11). Both are re-checked in the admission commit; a later Ticket/link edit is never one.
      const previous = resumeBasis(work);
      const scopeUpdateIds = pendingScope(work).map(update => update.scopeUpdateId);
      let resume: NonNullable<ExecutionView['request']['resume']> | undefined;
      let publication: NonNullable<ExecutionView['request']['publication']> | undefined;
      if (previous?.end?.outcome === 'question') {
        const answered = previous.end.questionId ? await readQuestion(session, previous.end.questionId) : null;
        if (!answered?.answer || answered.workId !== work.work_id || answered.executionId !== previous.executionId) { observe(work.work_id, 'refused', ['QUESTION_NOT_ANSWERED']); return; }
        resume = { previousExecutionId: previous.executionId, questionId: answered.questionId, answerSha256: answered.answer.sha256, scopeUpdateIds, reason: 'QUESTION_ANSWERED' };
      } else if (previous?.end?.outcome === 'completed' && scopeUpdateIds.length) {
        resume = { previousExecutionId: previous.executionId, questionId: null, answerSha256: null, scopeUpdateIds, reason: 'SCOPE_UPDATED' };
      } else if (previous && work.publication?.state === 'requested' && work.publication.verified && work.publication.expectedRemote &&
          publicationResumes(previous, work.publication.basisExecutionId)) {
        // Ticket 14: the requested publication activation, with exactly the recorded verified commit and lease expectation (re-checked in the commit).
        resume = { previousExecutionId: previous.executionId, questionId: null, answerSha256: null, scopeUpdateIds, reason: 'PUBLICATION_REQUESTED' };
        publication = { basisExecutionId: work.publication.basisExecutionId, head: work.publication.verified.head, branch: work.publication.branch,
          base: work.publication.base, marker: work.publication.marker, expectedRemote: work.publication.expectedRemote, pullRequest: work.publication.update ?? null };
      }
      // Ticket 26: after an interrupted Execution, its basis (operational recovery or clean-stop continuation), re-checked in the commit.
      const interruption = interruptionBasis(work);
      const { attemptId } = await freshEvaluation(work);
      const admission = await admitExecution(session, { ...(interruption ? { interruption } : {}), now: (ports.calendar ?? Date).now(), work_id: work.work_id, attemptId, capacity: ports.capacity, authorizationObservedAt: authorization.observedAt,
        request: { ticket: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
          branch: `factory/${work.ticket.number}-${work.work_id.slice(0, 8)}`, policies: publication ? publishOnly(ports.builder) : { ...ports.builder }, ...(publication ? { publication } : {}) }, ...(resume ? { resume } : {}),
        limits: deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase()) ?? {} });
      if (admission.kind === 'refused') { observe(work.work_id, 'refused', admission.reasons); return; }
      observe(work.work_id, 'reserved');
      const task = execute(work, admission.execution).finally(() => running.delete(work.work_id));
      running.set(work.work_id, task);
    },
    async stop() { stopping.abort(); await Promise.allSettled(running.values()); return { uncertain: uncertainStops }; },
  };
}
