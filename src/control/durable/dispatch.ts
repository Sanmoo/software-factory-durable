import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BuilderGrant } from '../../contracts/index.js';
import type { BootRef, EnvironmentRef } from '../../sandbox/index.js';
import type { AccessDependencies, CredentialWithdrawal, DependencyEvaluation, ExecutionPorts, ExecutionView } from '../types.js';
import { evaluateEntry } from '../rules/admission.js';
import { dispatchBlockers, selectNext, type OwnCycleFacts } from '../rules/dependencies.js';
import { evaluateWorkDependencies } from './polling.js';
import type { WorkRecord } from './admission.js';
import { admitExecution, beginRenewal, confirmActivation, confirmStart, holdExecution, recordEnd, recordIssuance, recordPhase, recordRenewal, recordRevocation,
  recordRevocationIntent, recordWorkerNotice, releaseAfterCessation, releaseBeforeStart, stopRenewal, withdrawCredentials } from './execution.js';
import { intactRequest, readQuestion, recordContentLost, registerQuestion } from './questions.js';
import { recoveryPrompt } from '../rules/questions.js';
import type { WorkerQuestion } from '../../workers/index.js';
import type { Session } from './store.js';

export type DispatchObservation = { at: string; work_id: string | null; outcome: string; reasons: string[] };
const maxTimer = 2147483647;
const codeOf = (error: unknown, fallback: string) => error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : fallback;
// Executions whose grants are held in THIS process's memory: boot reconciliation of another run/Control in-process never relabels them.
const liveExecutions = new Set<string>();
export const isLiveCredentialExecution = (executionId: string) => liveExecutions.has(executionId);

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
  questionRecorded?(): void }) {
  const { session, ports } = deps;
  const running = new Map<string, Promise<void>>();
  const lifecycles = new Map<string, ReturnType<typeof credentialLifecycle>>();
  const stopping = new AbortController();
  let last: DispatchObservation | null = null;
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

  async function execute(work: WorkRecord, execution: ExecutionView) {
    const { executionId } = execution;
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase())!;
    let phase = 'prepare';
    let environment: EnvironmentRef | undefined;
    let boot: BootRef | undefined;
    let lifecycle: ReturnType<typeof credentialLifecycle> | undefined;
    // A held Execution is not authorized to advance: its credentials are withdrawn and known grants revocation is attempted, even if the
    // hold commit itself fails.
    const hold = async (code: string, nextStep: string) => {
      try { await holdExecution(session, work.work_id, executionId, code, nextStep); observe(work.work_id, 'held', [code]); }
      finally { await lifecycle?.withdraw('held', { notifyWorker: true }); }
    };
    const stopOwnBoot = async (reason: string) => environment && boot ? ports.sandbox.stop({ environment, boot, reason }).catch(() => ({ status: 'indeterminate' as const, cessationConfirmed: false as const, code: 'STOP_UNAVAILABLE' })) : undefined;
    try {
      checkStop();
      const prepared = await ports.sandbox.prepare({ workId: work.work_id, configuration: ports.configuration,
        checkout: { repository: work.repository.repository, repositoryId: work.repository.repositoryId, installationId: configured.installationId, base: work.repository.base, branch: execution.request.branch } });
      if (prepared.status !== 'success' || !('checkout' in prepared)) { await hold(`PREPARE_${prepared.status === 'success' ? 'CHECKOUT_MISSING' : prepared.code}`, 'Preparation did not complete; it is never retried automatically. Inspect the environment (ticket 26 recovery).'); return; }
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
      const started = await ports.sandbox.start({ environment, configuration: ports.configuration });
      if (started.status !== 'success') { await hold(`START_${started.code}`, 'The boot did not become operational; no automatic retry. Observe/stop the environment explicitly.'); return; }
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
      phase = 'credential';
      checkStop();
      // Durable issuance intent BEFORE the call: an issued token is never unknown to the authority.
      if (await recordIssuance(session, work.work_id, executionId, { requestedAt: new Date().toISOString(), outcome: 'requested' }) !== 'recorded') { observe(work.work_id, 'stale'); return; }
      let grant;
      const context = { workId: work.work_id, executionId, repository: { repository: configured.repository, installationId: configured.installationId, workflows: false } };
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
        await hold('ACTIVATION_CREDENTIALS_WITHDRAWN', 'The activity credentials were withdrawn before activation; the Builder was not activated. Slot kept (ticket 26).');
      };
      if (lifecycle.withdrawn) { await withdrawnBeforeActivation(); return; }
      const resume = execution.request.resume ?? null;
      const answered = resume ? await readQuestion(session, resume.questionId) : null;
      if (resume && (!answered?.answer || answered.answer.sha256 !== resume.answerSha256)) { await revoke(); await refuse(['RESUME_BASIS_CHANGED']); return; }
      // First activation: `/implement <ticket>`. After an answer: an explicit recovery instruction (new boot, new session), never a bare `continue`.
      const prompt = resume && answered?.answer ? recoveryPrompt({ ticketUrl: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
        baseCommit: prepared.checkout.baseCommit, branch: execution.request.branch, checkout: prepared.checkout.path, workId: work.work_id, executionId,
        previousExecutionId: resume.previousExecutionId, question: { questionId: answered.questionId, question: answered.content.question, context: answered.content.context },
        answer: { text: answered.answer.text, author: answered.answer.author.kind === 'github' ? answered.answer.author.login : 'local administrator', origin: answered.answer.origin.kind } })
        : [`/implement ${work.ticket.url}`, `repository=${work.repository.repository}`, `base=${work.repository.base}`, `base-commit=${prepared.checkout.baseCommit}`,
          `branch=${execution.request.branch}`, `checkout=${prepared.checkout.path}`, 'artifacts=/artifacts', `work=${work.work_id}`, `execution=${executionId}`].join(' ');
      const promptSha256 = createHash('sha256').update(prompt).digest('hex');
      const confirmed = await confirmActivation(session, work.work_id, executionId, attemptId, grant.metadata, promptSha256);
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
        deps.questionRecorded?.();
        // The activity now waits for an external answer: its credentials are withdrawn (no renewal) and revoked, independently of the ACK.
        void lifecycle!.withdraw('external-wait', { notifyWorker: true }).catch(() => {});
        return { status: 'recorded' as const };
      };
      const handle = await ports.workers.activate({ context: { workId: work.work_id, executionId, invocationId: execution.invocationId, role: 'builder',
        environmentRef: environment, bootRef: boot, phaseId: resume ? 'builder-recovery' : 'builder-initial' }, prompt, signal: stopping.signal, ...ports.builder },
      { credential: grant.delivery }, { question: onQuestion });
      await lifecycle.attach(handle.worker);
      try {
        phase = 'started';
        const start = await untilStopped(handle.started);
        let consumed: Awaited<ReturnType<typeof confirmStart>> | undefined;
        try { consumed = await confirmStart(session, work.work_id, executionId, { ...start.receipt, ...start.invocation }); }
        finally { startCommitted(consumed === 'confirmed'); }
        if (consumed !== 'confirmed') { await hold(`START_RECEIPT_${consumed.toUpperCase().replaceAll('-', '_')}`, 'Start receipt was not consumable for this Execution.'); return; }
        observe(work.work_id, 'started');
        phase = 'completed';
        // Renewal happens only while waiting for THIS activity; it never restarts, replays or recovers the Builder.
        const completed = await untilStopped(lifecycle.renewWhile(handle.completed));
        if (completed.status === 'question') {
          // Lost ACK/notification: the completion repeats the SAME identity and content; a missing record is registered once from it.
          // Content not intact and no record: explicit impediment, nothing invented or published.
          const request = completed.question;
          let code: string | null = null;
          const known = await readQuestion(session, request.questionId);
          if (intactRequest(request, work.work_id)) {
            const outcome = await registerQuestion(session, { work_id: work.work_id, executionId, invocationId: execution.invocationId, request, from: 'worker-completion' });
            if (outcome.kind === 'refused') {
              code = outcome.code;
              // A conflict keeps the ORIGINAL record (and its impediment); any other refusal leaves no record: block explicitly.
              if (code !== 'QUESTION_ID_CONFLICT') await recordContentLost(session, work.work_id, executionId, request.questionId, 'QUESTION_NOT_RECORDED', `it could not be recorded (${code})`);
            } else if (outcome.kind === 'recorded') deps.questionRecorded?.();
          } else if (!known || known.executionId !== executionId) {
            code = 'QUESTION_CONTENT_LOST';
            await recordContentLost(session, work.work_id, executionId, request.questionId);
          }
          await recordEnd(session, work.work_id, executionId, 'question', code, request.questionId);
        } else await recordEnd(session, work.work_id, executionId, completed.status === 'success' ? 'completed' : 'failure', completed.status === 'success' ? null : completed.code);
      } finally { startCommitted(false); handle.close(); }
      await lifecycle.withdraw('ended', { notifyWorker: false });
      phase = 'stop';
      const stop = await stopOwnBoot('builder execution ended');
      await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed');
      observe(work.work_id, stop?.cessationConfirmed ? 'ended-slot-released' : 'ended-cessation-unconfirmed');
    } catch (error) {
      if (stopping.signal.aborted) {
        // Owner stop: the host channel closes (worker revoked); the grants are still in memory, so their revocation is attempted.
        await lifecycle?.withdraw('owner-stopped', { notifyWorker: false }).catch(() => {});
        observe(work.work_id, 'owner-stopped', [phase]); return;
      }
      const code = codeOf(error, 'UNEXPECTED_FAILURE');
      await hold(`${phase.toUpperCase()}_${code}`, 'Execution outcome is uncertain at this phase; never retried automatically. Operator recovery (ticket 26).').catch(() => {});
    } finally { lifecycles.delete(work.work_id); liveExecutions.delete(executionId); }
  }

  return {
    view: () => ({ running: running.size, last }),
    /** External wait / cancellation entry (tickets 10/25): withdraws the active Execution's credentials and attempts their revocation. */
    async withdraw(work_id: string, reason: Extract<CredentialWithdrawal, 'external-wait' | 'cancelled'>): Promise<'withdrawn' | 'not-active'> {
      const lifecycle = lifecycles.get(work_id);
      if (!lifecycle) return 'not-active';
      await lifecycle.withdraw(reason, { notifyWorker: true });
      return 'withdrawn';
    },
    async tick() {
      if (stopping.signal.aborted || await deps.paused()) return;
      if (await deps.heldSlots() >= ports.capacity) { observe(null, 'no-slot-available'); return; }
      const works = await deps.readWorks();
      const candidates = works.filter(work => work.result === 'open' && work.queue.pending && work.queue.category === 'normal' && !running.has(work.work_id))
        .map(work => ({ work_id: work.work_id, blockers: dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies.latest,
          currentAttempt: deps.currentAttempt(work.repository.repository) }) }));
      const next = selectNext(candidates).next;
      if (!next) { observe(null, 'nothing-eligible'); return; }
      const work = works.find(item => item.work_id === next)!;
      const authorization = await revalidateAuthorization(work);
      if (!authorization.ok) { observe(work.work_id, 'authorization-not-confirmed', authorization.reasons); return; }
      // After a Question: only its accepted answer is a recovery basis (re-checked in the admission commit).
      const previous = work.execution;
      let resume: NonNullable<ExecutionView['request']['resume']> | undefined;
      if (previous?.end?.outcome === 'question') {
        const answered = previous.end.questionId ? await readQuestion(session, previous.end.questionId) : null;
        if (!answered?.answer) { observe(work.work_id, 'refused', ['QUESTION_NOT_ANSWERED']); return; }
        resume = { previousExecutionId: previous.executionId, questionId: answered.questionId, answerSha256: answered.answer.sha256, reason: 'NEW_BOOT_REPLACEMENT_SESSION' };
      }
      const { attemptId } = await freshEvaluation(work);
      const admission = await admitExecution(session, { work_id: work.work_id, attemptId, capacity: ports.capacity, authorizationObservedAt: authorization.observedAt,
        request: { ticket: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
          branch: `factory/${work.ticket.number}-${work.work_id.slice(0, 8)}`, policies: { ...ports.builder } }, ...(resume ? { resume } : {}) });
      if (admission.kind === 'refused') { observe(work.work_id, 'refused', admission.reasons); return; }
      observe(work.work_id, 'reserved');
      const task = execute(work, admission.execution).finally(() => running.delete(work.work_id));
      running.set(work.work_id, task);
    },
    async stop() { stopping.abort(); await Promise.allSettled(running.values()); },
  };
}
