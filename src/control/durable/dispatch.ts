import { createHash, randomUUID } from 'node:crypto';
import type { BootRef, EnvironmentRef } from '../../sandbox/index.js';
import type { AccessDependencies, DependencyEvaluation, ExecutionPorts, ExecutionView } from '../types.js';
import { evaluateEntry } from '../rules/admission.js';
import { dispatchBlockers, selectNext, type OwnCycleFacts } from '../rules/dependencies.js';
import { evaluateWorkDependencies } from './polling.js';
import type { WorkRecord } from './admission.js';
import { admitExecution, confirmActivation, confirmStart, holdExecution, recordEnd, recordPhase, releaseAfterCessation, releaseBeforeStart } from './execution.js';
import type { Session } from './store.js';

export type DispatchObservation = { at: string; work_id: string | null; outcome: string; reasons: string[] };

/**
 * Dispatch inside the existing owner loop (no scheduler/broker): after a polling iteration, while a Slot is free, the FIFO-selected Work is
 * revalidated (current Ticket authorization + a FRESH native dependency evaluation of this dispatch attempt), reserved durably, and only then
 * prepared/started/activated. Each external effect follows intent -> call -> observation -> durable confirmation. No automatic retry:
 * any failure holds the Execution explicitly with its Slot. Push/PR/reviews/readiness are not part of this increment.
 */
export function createDispatcher(deps: { session: Session; access: AccessDependencies; ports: ExecutionPorts; currentAttempt(repository: string): string | null;
  readWorks(): Promise<WorkRecord[]>; ownCycles(issueIds: number[]): Promise<Record<number, OwnCycleFacts>>;
  record(work_id: string, evaluation: DependencyEvaluation): Promise<unknown>; paused(): Promise<boolean>; heldSlots(): Promise<number> }) {
  const { session, ports } = deps;
  const running = new Map<string, Promise<void>>();
  const stopping = new AbortController();
  let last: DispatchObservation | null = null;
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
    const hold = async (code: string, nextStep: string) => { await holdExecution(session, work.work_id, executionId, code, nextStep); observe(work.work_id, 'held', [code]); };
    const stopOwnBoot = async (reason: string) => environment && boot ? ports.sandbox.stop({ environment, boot, reason }).catch(() => ({ status: 'indeterminate' as const, cessationConfirmed: false as const, code: 'STOP_UNAVAILABLE' })) : undefined;
    try {
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
      const started = await ports.sandbox.start({ environment, configuration: ports.configuration });
      if (started.status !== 'success') { await hold(`START_${started.code}`, 'The boot did not become operational; no automatic retry. Observe/stop the environment explicitly.'); return; }
      boot = started.boot;
      if ((await recordPhase(session, work.work_id, executionId, 'prepared', 'booted', 'execution-booted', current => { current.dispatch.boot = started.boot; })).kind !== 'advanced') { observe(work.work_id, 'stale'); return; }
      // Revalidation immediately before activation: authorization and a FRESH dependency evaluation of THIS attempt.
      phase = 'revalidate';
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
      phase = 'credential';
      const grant = await ports.credentials.issue({ workId: work.work_id, executionId, repository: { repository: configured.repository, installationId: configured.installationId, workflows: false } });
      const prompt = [`/implement ${work.ticket.url}`, `repository=${work.repository.repository}`, `base=${work.repository.base}`, `base-commit=${prepared.checkout.baseCommit}`,
        `branch=${execution.request.branch}`, `checkout=${prepared.checkout.path}`, 'artifacts=/artifacts', `work=${work.work_id}`, `execution=${executionId}`].join(' ');
      const promptSha256 = createHash('sha256').update(prompt).digest('hex');
      const confirmed = await confirmActivation(session, work.work_id, executionId, attemptId, grant.metadata, promptSha256);
      if (confirmed.kind === 'refused') { await ports.credentials.revoke(grant).catch(() => {}); await refuse(confirmed.reasons); return; }
      if (confirmed.kind === 'stale') { observe(work.work_id, 'stale'); return; }
      phase = 'activate';
      const handle = await ports.workers.activate({ context: { workId: work.work_id, executionId, invocationId: execution.invocationId, role: 'builder',
        environmentRef: environment, bootRef: boot, phaseId: 'builder-initial' }, prompt, signal: new AbortController().signal, ...ports.builder },
      { credential: grant.delivery });
      try {
        phase = 'started';
        const start = await Promise.race([handle.started, new Promise<never>((_, reject) => stopping.signal.addEventListener('abort', () => reject(new Error('OWNER_STOPPING')), { once: true }))]);
        const consumed = await confirmStart(session, work.work_id, executionId, { ...start.receipt, ...start.invocation });
        if (consumed !== 'confirmed') { await hold(`START_RECEIPT_${consumed.toUpperCase().replaceAll('-', '_')}`, 'Start receipt was not consumable for this Execution.'); return; }
        observe(work.work_id, 'started');
        phase = 'completed';
        const completed = await Promise.race([handle.completed, new Promise<never>((_, reject) => stopping.signal.addEventListener('abort', () => reject(new Error('OWNER_STOPPING')), { once: true }))]);
        await recordEnd(session, work.work_id, executionId, completed.status === 'success' ? 'completed' : 'failure', completed.status === 'success' ? null : completed.code);
      } finally { handle.close(); }
      await ports.credentials.revoke(grant).catch(() => {});
      phase = 'stop';
      const stop = await stopOwnBoot('builder execution ended');
      await releaseAfterCessation(session, work.work_id, executionId, stop?.cessationConfirmed ? 'confirmed' : 'unconfirmed');
      observe(work.work_id, stop?.cessationConfirmed ? 'ended-slot-released' : 'ended-cessation-unconfirmed');
    } catch (error) {
      if (stopping.signal.aborted) { observe(work.work_id, 'owner-stopped', [phase]); return; }
      const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'UNEXPECTED_FAILURE';
      await hold(`${phase.toUpperCase()}_${code}`, 'Execution outcome is uncertain at this phase; never retried automatically. Operator recovery (ticket 26).').catch(() => {});
    }
  }

  return {
    view: () => ({ running: running.size, last }),
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
      const { attemptId } = await freshEvaluation(work);
      const admission = await admitExecution(session, { work_id: work.work_id, attemptId, capacity: ports.capacity, authorizationObservedAt: authorization.observedAt,
        request: { ticket: work.ticket.url, repository: work.repository.repository, base: work.repository.base,
          branch: `factory/${work.ticket.number}-${work.work_id.slice(0, 8)}`, policies: { ...ports.builder } } });
      if (admission.kind === 'refused') { observe(work.work_id, 'refused', admission.reasons); return; }
      observe(work.work_id, 'reserved');
      const task = execute(work, admission.execution).finally(() => running.delete(work.work_id));
      running.set(work.work_id, task);
    },
    async stop() { stopping.abort(); await Promise.allSettled(running.values()); },
  };
}
