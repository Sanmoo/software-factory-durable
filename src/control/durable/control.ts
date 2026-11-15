import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import type { AccessDependencies, Control, ControlStatus, DispatchReason, ExecutionPorts, Impediment, LimitsView, ListView, PollingOptions, PollingView, RecoveryView, RuntimeInventory,
  WorkView } from '../types.js';
import { heldSlots, initializeSlots, reconcileDurations, reconcileLostCredentials } from './execution.js';
import { createDispatcher, isLiveCredentialExecution, isLiveExecution } from './dispatch.js';
import { createChecksTracker } from './checks.js';
import { acceptReadinessAuthorization, createReadinessDesk } from './readiness.js';
import { openStore } from './store.js';
import { recordRunEnd, recordRunStart } from './migration.js';
import { currentFormat } from './format.js';
import { acceptPauseCommand, admitTicket, indexedWork, initialize, ownCycles, pendingWorks, readInstallation, readRequest, readWork, readWorks, recordDependencies,
  type WorkRecord } from './admission.js';
import { createPoller, systemClock } from './polling.js';
import { createQuestionDesk } from './question-desk.js';
import { acceptAnswer, readQuestion, readQuestions } from './questions.js';
import { acceptScopeUpdate } from './scope.js';
import { dispatchBlockers, selectNext } from '../rules/dependencies.js';
import { counterView, durationView, maxGrantAmount } from '../rules/budget.js';
import { grantBudget, openCorrection, requestOperationalRecovery } from './budget.js';
import { reconcileBoot } from './recovery.js';
import { dispatchGate } from '../rules/recovery.js';
import { backoffRunning } from './recovery-request.js';
import { createDeliveryDesk } from './delivery-desk.js';

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const inputSchema = z.union([z.strictObject({ request_id: requestId, operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('grant'), work_id: z.uuid(), counter: z.enum(['corrections', 'recoveries']),
    amount: z.number().int().min(1).max(maxGrantAmount), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('answer'), question_id: z.uuid(), origin: z.literal('local-cli'),
    text: z.string().max(2000).refine(text => text.trim().length > 0 && text === text.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) }),
  // Ticket 11: concreteness is a durable decision of the commit (queryable `not-applied`), only the shape is checked here.
  z.strictObject({ request_id: requestId, operation: z.literal('update-scope'), work_id: z.uuid(), reason: z.string().min(1).max(2000), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('authorize-readiness'), work_id: z.uuid(), reason: z.string().min(1).max(2000), origin: z.literal('local-cli') })]);
const workIdSchema = z.uuid();
const limitations = [
  'Candidate observations are in-memory results of the latest poll, not authority; they are rebuilt after restart.',
  'A failed or partial query, or absence from a listing, never proves absence of a Ticket, label or pull request, nor withdrawal of authorization.',
  'Dispatch opens only after the boot reconciliation: execution boundaries composed, no unknown runtime resource, task or orphan Slot; interrupted Executions are ceased (never adopted) and settled from durable evidence. A Work whose own cessation or start stays uncertain keeps its Slot/reservation and is blocked; independents proceed with the remaining capacity. Each dispatch then revalidates authorization and dependencies of its own attempt before reserving.',
  'An operational recovery waits its persisted delay (5/15/45 s by recoveries already consumed, never anticipated by events or restarts) and is checked again at the next polling round after it.',
  'An ended Builder Execution never completes the Work automatically and nothing is retried automatically. Publication (ticket 14) requires the end-of-Execution verification of a committed content; the Builder pushes its own branch and opens its own draft PR directly, only in a publication activation Control requested after a complete discovery found nothing. Control links its own PR only by correlation (marker, App bot author, own branch/repository/base, verified head); opening it never ends the Ticket.',
  'Readiness (ticket 16) is the controller\'s evaluation of current evidence (published own PR, verified content and two current opinions, treatments, gates, GitHub required checks of the current head, confirmed absence of conflict, no impediment or concurrent activity), confirmed by a fresh recheck immediately before any draft/ready conversion. The conversion is a Factory effect under a fresh single-use grant, intended before, observed and confirmed after, never repeated implicitly; a ready flag alone certifies nothing. Human review, approval and merge are human only.',
  'Native dependency evaluations are re-done every polling round; only an evaluation of the current round can release, never an older or pre-restart one.',
  'A Question waiting for an answer occupies no Slot; an accepted answer removes only its own impediment and never starts an agent directly: the Work resumes through its queue position after revalidation.',
  'A resumed Builder continues its previous session only when that session was recorded, is intact and compatible; otherwise it is replaced with a recorded reason and an explicit recovery instruction. Delivering context is not proof that the Builder consumed it.',
  'Only `update-scope` (or an accepted answer) authorizes a concrete change of the request, for the next safe activation; a later Ticket or link edit is never a trigger or an authorization.',
  'Delivery (ticket 17) is only a human merge of the Work\'s own pull request, confirmed by its identity; closing the Ticket or the pull request, or any agent message, is not delivery. The Factory never merges.',
  'Cleanup after delivery removes only own resources (own environments with their checkout/local branch/temporaries, the own remote branch under its own cleanup grant), after confirmed cessation and preserved evidence; base, shared cache, other Works and Docker are never touched. A failed or pending cleanup is shown separately and never undoes delivery.',
];

// Module-internal seam for the external-wait/cancellation flows of this module (not part of the public Control contract).
const dispatchers = new WeakMap<Control, ReturnType<typeof createDispatcher>>();
// Module-internal seam for the correction (tickets 22/23) and recovery (ticket 26) triggers; not part of the public Control contract.
const triggers = new WeakMap<Control, { correction(work_id: string, reason: string): Promise<string>; recovery(work_id: string, reason: string): Promise<string> }>();
/** Opens a correction of a Work (charged once at its confirmed start); `refused` while an Execution is active or the Work is not current. */
export async function requestCorrection(control: Control, work_id: string, reason: string): Promise<string> {
  return triggers.get(control)?.correction(work_id, reason) ?? 'refused';
}
/** Requests an operational recovery of a Work (one recovery unit at its confirmed start). */
export async function requestRecovery(control: Control, work_id: string, reason: string): Promise<string> {
  return triggers.get(control)?.recovery(work_id, reason) ?? 'refused';
}
/** Withdraws the active Execution's credentials of a Work (external wait or cancellation) and attempts revocation of its known grants. */
export async function withdrawActivityCredentials(control: Control, work_id: string, reason: 'external-wait' | 'cancelled'): Promise<'withdrawn' | 'not-active'> {
  return dispatchers.get(control)?.withdraw(work_id, reason) ?? 'not-active';
}

/** Bootstrap must already hold the stable canonical-storage flock for this owner's entire lifetime. */
export async function openControl(options: { storagePath: string;
  /** Host inventory of own runtime resources taken after the lock (ticket 26). `empty`/`unknown` are the coarse legacy forms. */
  runtimeInventory: 'empty' | 'unknown' | RuntimeInventory; access?: AccessDependencies; polling?: PollingOptions;
  /** Execution boundaries (sandbox lifecycle, Workers activation, Builder credentials). Absent: dispatch stays closed (EXECUTION_NOT_ENABLED). */
  execution?: ExecutionPorts }): Promise<Control> {
  // Closed before any storage open; this increment exposes no dispatch, task, or external-effect entrypoint.
  let dispatchReason: DispatchReason | null = 'RECONCILIATION_REQUIRED';
  const controller_run_id = randomUUID();
  const store = await openStore(options.storagePath);
  const state = store.session;
  try { await initialize(state); await initializeSlots(state); } catch (error) { await store.close().catch(() => {}); throw error; }
  let dispatcher: ReturnType<typeof createDispatcher> | undefined;
  let stopped = false;
  let recovery: RecoveryView | null = null;
  const calendar = options.execution?.calendar ?? { now: () => Date.now() };
  // Boot facts of THIS run (ticket 26): a repository whose host Git cache was being prepared stays blocked (a fetch/clone may still run).
  const runBlockers = (work: WorkRecord): string[] => [
    ...(recovery?.cachePreparing.includes(work.repository.repositoryId) ? ['CACHE_RECONCILIATION_REQUIRED'] : []),
    ...(backoffRunning(work, calendar.now()) ? ['RECOVERY_BACKOFF'] : [])];
  const configuredRepository = (repository: string) => options.access?.repositories.find(scope => scope.repository.toLowerCase() === repository.toLowerCase());
  // Question publication and answer ingestion need the tracker; they run whatever the dispatch barrier (no spawn involved).
  const desk = options.access && options.polling ? createQuestionDesk({ session: state, tracker: options.access.tracker, operators: options.access.operators ?? [],
    readWorks: () => readWorks(state), stopped: () => stopped }) : undefined;
  const poller = options.access && options.polling ? createPoller({
    access: options.access, intervalSeconds: options.polling.intervalSeconds, clock: options.polling.clock ?? systemClock,
    paused: async () => (await readInstallation(state)).paused,
    indexed: ticket => indexedWork(state, ticket),
    admit: evidence => admitTicket(state, evidence, configuredRepository(evidence.repository.repository) ?? {}),
    pending: repositoryId => pendingWorks(state, repositoryId),
    ownCycles: issueIds => ownCycles(state, issueIds),
    record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation),
    // Ticket 15: required-checks tracking after the dispatch tick (off its critical path), whatever the dispatch barrier or pause.
    // Ticket 16: readiness after the checks explanation (its evidence), whatever the pause (tracking, not a new trigger).
    afterCycle: async () => { await delivery?.cycle().catch(() => {}); await desk?.cycle(); if (dispatchReason === null) await dispatcher?.tick(); await checks?.pass(tracking.signal).catch(() => {});
      await readiness?.pass(tracking.signal).catch(() => {}); },
  }) : undefined;
  const tracking = new AbortController();
  const checks = options.access && options.polling ? createChecksTracker({ session: state, access: options.access, readWorks: () => readWorks(state),
    busy: work_id => dispatcher?.active(work_id) ?? false, clock: options.polling.clock ?? systemClock, minIntervalMs: options.polling.intervalSeconds * 1000 }) : undefined;
  const readiness = options.access && options.polling ? createReadinessDesk({ session: state, access: options.access, readWorks: () => readWorks(state),
    installation: () => dispatchReason === 'RECONCILIATION_REQUIRED' ? 'reconciliation-required' : 'settled',
    dependencies: { ownCycles: issueIds => ownCycles(state, issueIds), record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation, { published: true }) }, clock: options.polling.clock ?? systemClock,
    minIntervalMs: options.polling.intervalSeconds * 1000 }) : undefined;
  if (options.execution && options.access && poller) dispatcher = createDispatcher({ session: state, access: options.access, ports: options.execution,
    currentAttempt: repository => poller.currentAttempt(repository), readWorks: () => readWorks(state), ownCycles: issueIds => ownCycles(state, issueIds),
    record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation), paused: async () => (await readInstallation(state)).paused,
    heldSlots: () => heldSlots(state), questionRecorded: () => desk?.kick(), controllerRunId: controller_run_id, runBlockers });
  // Ticket 17: delivery observation and owned cleanup, in the same owner loop (tracking reads run whatever the dispatch barrier; cleanup
  // itself revalidates cessation per Work). Before the dispatcher tick, so a merge observed now is never followed by a new activation.
  const delivery = options.access && options.polling ? createDeliveryDesk({ session: state, repository: options.access.repository, repositories: options.access.repositories,
    cleanup: options.execution?.cleanup, running: work_id => dispatcher?.running(work_id) ?? false,
    interrupt: async work_id => dispatcher?.interruptDelivered(work_id), readWorks: () => readWorks(state), stopped: () => stopped }) : undefined;
  const pollingView = (): PollingView => poller?.view() ?? { state: 'disabled', intervalSeconds: null, cycles: 0, lastCycleAt: null, source: 'in-memory-observation', repositories: [] };
  // Work-level reasons preventing a start now; the dependency evaluation must belong to the repository's current polling round.
  const blockers = (work: WorkRecord) => [...dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies.latest,
    currentAttempt: poller?.currentAttempt(work.repository.repository) ?? null }), ...runBlockers(work)];
  const present = (work: WorkRecord, paused: boolean): WorkView => {
    const impediments: Impediment[] = [...work.impediments,
      ...(paused ? [{ code: 'GLOBAL_PAUSE', scope: 'installation' as const, nextStep: 'Unpause to allow new triggers; unpausing removes no individual impediment.' }] : [])];
    // A Question wait whose boot ceased occupies nothing: the Work shows its queue blockers (QUESTION_PENDING...), not "executing".
    // Likewise an ended, ceased Execution whose Work is pending again (correction/recovery/timeout): its queue blockers are shown.
    const waiting = work.execution?.state === 'ended' && !work.execution.slot.held && (work.execution.end?.outcome === 'question' || work.queue.pending);
    const execution = work.execution && work.execution.state !== 'released' && !waiting ? work.execution : null;
    const reasons = [...(execution ? [] : blockers(work)), ...(dispatchReason ? [dispatchReason] : []), ...(paused ? ['GLOBAL_PAUSE'] : [])];
    return { ...work, impediments, dispatch: { state: execution ? 'executing' : reasons.length ? 'held' : 'eligible', reasons }, limits: limitsOf(work, impediments) };
  };
  // Presentation of limits/reservations/consumption, timeout, duration (live monotonic when THIS process runs it) and the action required.
  const limitsOf = (work: WorkRecord, impediments: Impediment[]): LimitsView => {
    const execution = work.execution;
    const live = execution ? dispatcher?.liveElapsed(execution.executionId) ?? null : null;
    const timing = execution?.timing ?? null;
    return { corrections: work.budget ? counterView(work.budget.corrections) : null, recoveries: work.budget ? counterView(work.budget.recoveries) : null,
      grants: work.budget?.grants.length ?? 0,
      timeout: { seconds: timing ? timing.timeoutSeconds : configuredRepository(work.repository.repository)?.timeoutSeconds ?? null, scope: 'per-execution',
        reached: timing?.timeout ?? null, overrun: timing?.overrun ?? null },
      duration: durationView(timing, live === null ? null : { elapsedMs: live }),
      actions: impediments.map(item => ({ code: item.code, nextStep: item.nextStep })) };
  };
  const selection = (works: WorkRecord[]) => selectNext(works.filter(work => work.result === 'open' && work.queue.pending && work.queue.category === 'normal')
    .map(work => ({ work_id: work.work_id, blockers: blockers(work) })));
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
      if (parsed.data.operation === 'answer') return acceptAnswer(state, { request_id: parsed.data.request_id, question_id: parsed.data.question_id, text: parsed.data.text, origin: { kind: 'local-cli' } });
      if (parsed.data.operation === 'grant') return grantBudget(state, parsed.data, configuredRepository);
      return acceptPauseCommand(state, parsed.data);
    },
    async inspect(query) {
      if (query.kind === 'access') {
        if (!options.access) throw new Error('AUTHENTICATED_DIAGNOSTICS_UNAVAILABLE');
        const results = [];
        // In-memory observations only: no token or issuer result enters a durable task/commit.
        for (const repo of options.access.repositories) results.push({
          tracker: await options.access.tracker.checkAccess(repo),
          repository: await options.access.repository.checkAccess(repo, repo.base),
        });
        const dependencyResults = [];
        for (const repo of options.access.dependencyRepositories ?? []) dependencyResults.push(await options.access.tracker.checkAccess({ ...repo, role: 'dependency-only' }));
        return { kind: 'access', scope: 'authenticated', results, dependencyResults };
      }
      if (query.kind === 'request') {
        if (!requestId.safeParse(query.request_id).success) throw new Error('INVALID_REQUEST_ID');
        return { kind: 'request', receipt: await readRequest(state, query.request_id) };
      }
      if (query.kind === 'question') {
        if (!workIdSchema.safeParse(query.question_id).success) throw new Error('INVALID_QUESTION_ID');
        const question = await readQuestion(state, query.question_id);
        return question ? { kind: 'question', question } : { kind: 'question-not-found', question_id: query.question_id, nextStep: 'No Question with this identity; use `factory show <work>`.' };
      }
      const current = await readInstallation(state);
      if (query.kind === 'show') {
        if (!workIdSchema.safeParse(query.work_id).success) throw new Error('INVALID_WORK_ID');
        const work = await readWork(state, query.work_id);
        if (!work) return { kind: 'work-not-found', work_id: query.work_id, nextStep: 'No Work with this identity in the controller authority; use `factory list`.' };
        const lastPolled = pollingView().repositories.flatMap(repo => repo.candidates ?? [])
          .find(candidate => candidate.ticket.issueId === work.ticket.issueId && candidate.ticket.repositoryId === work.ticket.repositoryId) ?? null;
        return { kind: 'work', work: present(work, current.paused), lastPolled, questions: await readQuestions(state, work) };
      }
      const works = await readWorks(state);
      if (query.kind === 'list') {
        return { kind: 'list', paused: current.paused, dispatch: dispatchReason ? 'closed' : 'open', dispatchReason,
          slots: { capacity: options.execution?.capacity ?? 0, held: await heldSlots(state) }, works: works.map(work => present(work, current.paused)),
          queues: { normal: works.filter(work => work.queue.pending && work.queue.category === 'normal').map(work => work.work_id), repair: [] },
          selection: selection(works), polling: pollingView(), limitations } satisfies ListView;
      }
      const polling = pollingView();
      const allQuestions = (await Promise.all(works.map(work => readQuestions(state, work)))).flat();
      return { controller_run_id, paused: current.paused, dispatch: dispatchReason ? 'closed' : 'open', dispatchReason,
        slots: { capacity: options.execution?.capacity ?? 0, held: await heldSlots(state) }, historyLength: current.history.length,
        works: { total: works.length, open: works.filter(work => work.result === 'open').length },
        delivery: { delivered: works.filter(work => work.result === 'delivered').length, cleanup: {
          waiting: works.filter(work => work.cleanup?.state === 'waiting').length, pending: works.filter(work => work.cleanup?.state === 'pending').length,
          complete: works.filter(work => work.cleanup?.state === 'complete').length } },
        queues: { normal: works.filter(work => work.queue.pending && work.queue.category === 'normal').length, repair: 0 },
        dependencies: { satisfied: works.filter(work => work.dependencies.latest?.conclusion === 'satisfied').length,
          pending: works.filter(work => work.dependencies.latest?.conclusion === 'pending').length,
          inconclusive: works.filter(work => work.dependencies.latest?.conclusion === 'inconclusive').length,
          notEvaluated: works.filter(work => !work.dependencies.latest).length },
        questions: { open: allQuestions.filter(item => item.state === 'open').length, answered: allQuestions.filter(item => item.state === 'answered').length,
          unpublished: allQuestions.filter(item => item.state === 'open' && item.publication.state !== 'published').length },
        selection: { next: selection(works).next },
        polling: { ...polling, repositories: polling.repositories.map(({ candidates: _candidates, ...repo }) => repo) },
        persistence: store.persistence, recovery, storage: { format: currentFormat, previousRun } } satisfies ControlStatus;
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
          const unreconciled = typeof inventory === 'object' && !recovery ? [...inventory.unknown.map(item => `UNKNOWN_RESOURCE:${item}`),
            ...inventory.environments.map(item => `ENVIRONMENT_NOT_RECONCILED:${item.environment}`),
            ...inventory.cache.filter(item => item.state !== 'idle').map(item => `CACHE_NOT_RECONCILED:${item.repositoryId ?? 'unknown'}`)] : [];
          const gate = dispatchGate({ executionComposed: dispatcher !== undefined, inventory: typeof inventory === 'object' ? 'listed' : inventory, tasks: tasks.items.length,
            unknownResources: recovery?.global ?? unreconciled, orphanSlots: [] });
          // Without a reconciliation (inventory unknown, read-only inspection) a Slot still held from an earlier owner keeps dispatch closed.
          dispatchReason = gate.reason ?? (recovery === null && await heldSlots(state) > 0 ? 'RECONCILIATION_REQUIRED' : null);
          if (recovery && gate.closing.length) recovery = { ...recovery, global: gate.closing };
        };
        // Nothing to reconcile without execution boundaries: the gate is known at once (closed either way).
        if (!dispatcher) await decide();
        // Ticket 33: this run's start is durable before anything else of the run; a later crash leaves it without an end (never a clean stop).
        let started = false;
        if (!signal.aborted) { previousRun = await recordRunStart(state, controller_run_id); started = true; }
        // Grants of a previous process were memory-only: record them as impossible to revoke, with their risk (never blocks by itself).
        // Before polling starts, so no dispatch of this run precedes it. A run stopped before it starts (read-only inspection) writes nothing.
        if (!signal.aborted) await reconcileLostCredentials(state, isLiveCredentialExecution);
        // Durations measured by a previous process: proven lower bound + calendar estimate; overrun blocks when it cannot be excluded.
        if (!signal.aborted) await reconcileDurations(state, isLiveExecution);
        // Ticket 26 (spec §5.2 steps 3-5), barrier still closed: own survivors are stopped (not adopted), interrupted Executions settled from
        // durable evidence; only then the gate opens, unless unknown resources, tasks or orphan Slots keep the installation closed.
        if (!signal.aborted && dispatcher && options.execution && inventory !== 'unknown') {
          recovery = await reconcileBoot({ session: state, ports: options.execution, controllerRunId: controller_run_id, inventory, live: isLiveExecution });
        }
        await decide();
        const aborted = new Promise<'stop'>(resolve => {
          if (signal.aborted) resolve('stop');
          else signal.addEventListener('abort', () => resolve('stop'), { once: true });
        });
        // Polling is tracking/admission only; it never dispatches. A durable-authority failure ends the owner as failed.
        if (poller) polling = poller.run(loop.signal);
        const outcome = await Promise.race([aborted, state.closed.then(() => 'closed' as const),
          ...(poller ? [polling.then(() => 'polling-ended' as const, () => 'polling-failed' as const)] : [])]);
        loop.abort();
        tracking.abort();
        stopped = true;
        await polling.catch(() => {});
        // An administrative stop is clean only after the confirmed cessation and persistence of every own activity (spec §11.4).
        const uncertain = (await dispatcher?.stop())?.uncertain ?? 0;
        await desk?.idle();
        // Ticket 33 + 26: ONE outcome (single source) for the run result and its durable end: clean only for a requested stop whose own
        // activities ticket 26's dispatcher stop confirmed ceased and persisted; otherwise `uncertain`. The intention to stop never makes an
        // interruption clean; the next boot reconciles it (26). This end is the LAST commit of the run.
        const kind = outcome !== 'stop' ? 'failed' as const : uncertain ? 'uncertain' as const : 'clean' as const;
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
        await desk?.idle().catch(() => {});
        await state.close(BACKGROUND_CONTEXT).catch(() => {});
        return { kind: 'failed' };
      }
    },
  };
  if (dispatcher) dispatchers.set(control, dispatcher);
  triggers.set(control, { correction: (work_id, reason) => openCorrection(state, work_id, reason, configuredRepository),
    recovery: (work_id, reason) => requestOperationalRecovery(state, work_id, reason, configuredRepository) });
  return control;
}
