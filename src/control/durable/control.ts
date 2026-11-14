import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import type { AccessDependencies, Control, ControlStatus, DispatchReason, ExecutionPorts, Impediment, ListView, PollingOptions, PollingView, WorkView } from '../types.js';
import { heldSlots, initializeSlots, reconcileLostCredentials } from './execution.js';
import { createDispatcher, isLiveCredentialExecution } from './dispatch.js';
import { openStore } from './store.js';
import { acceptPauseCommand, admitTicket, indexedWork, initialize, ownCycles, pendingWorks, readInstallation, readRequest, readWork, readWorks, recordDependencies,
  type WorkRecord } from './admission.js';
import { createPoller, systemClock } from './polling.js';
import { createQuestionDesk } from './question-desk.js';
import { acceptAnswer, readQuestion, readQuestions } from './questions.js';
import { dispatchBlockers, selectNext } from '../rules/dependencies.js';

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const inputSchema = z.union([z.strictObject({ request_id: requestId, operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('answer'), question_id: z.uuid(), origin: z.literal('local-cli'),
    text: z.string().max(2000).refine(text => text.trim().length > 0 && text === text.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) })]);
const workIdSchema = z.uuid();
const limitations = [
  'Candidate observations are in-memory results of the latest poll, not authority; they are rebuilt after restart.',
  'A failed or partial query, or absence from a listing, never proves absence of a Ticket, label or pull request, nor withdrawal of authorization.',
  'Dispatch opens only when execution boundaries are composed, the runtime inventory is empty and no Slot is held from an earlier run; it then revalidates authorization and dependencies of its own attempt before reserving.',
  'An ended Builder Execution never completes the Work automatically: reviews, publication (push/PR) and readiness are not enabled in this increment; nothing is retried automatically.',
  'Native dependency evaluations are re-done every polling round; only an evaluation of the current round can release, never an older or pre-restart one.',
  'A Question waiting for an answer occupies no Slot; an accepted answer removes only its own impediment and never starts an agent directly: the Work resumes through its queue position after revalidation.',
];

// Module-internal seam for the external-wait/cancellation flows of this module (not part of the public Control contract).
const dispatchers = new WeakMap<Control, ReturnType<typeof createDispatcher>>();
/** Withdraws the active Execution's credentials of a Work (external wait or cancellation) and attempts revocation of its known grants. */
export async function withdrawActivityCredentials(control: Control, work_id: string, reason: 'external-wait' | 'cancelled'): Promise<'withdrawn' | 'not-active'> {
  return dispatchers.get(control)?.withdraw(work_id, reason) ?? 'not-active';
}

/** Bootstrap must already hold the stable canonical-storage flock for this owner's entire lifetime. */
export async function openControl(options: { storagePath: string; runtimeInventory: 'empty' | 'unknown'; access?: AccessDependencies; polling?: PollingOptions;
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
  // Question publication and answer ingestion need the tracker; they run whatever the dispatch barrier (no spawn involved).
  const desk = options.access && options.polling ? createQuestionDesk({ session: state, tracker: options.access.tracker, operators: options.access.operators ?? [],
    readWorks: () => readWorks(state), stopped: () => stopped }) : undefined;
  const poller = options.access && options.polling ? createPoller({
    access: options.access, intervalSeconds: options.polling.intervalSeconds, clock: options.polling.clock ?? systemClock,
    paused: async () => (await readInstallation(state)).paused,
    indexed: ticket => indexedWork(state, ticket),
    admit: evidence => admitTicket(state, evidence),
    pending: repositoryId => pendingWorks(state, repositoryId),
    ownCycles: issueIds => ownCycles(state, issueIds),
    record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation),
    afterCycle: async () => { await desk?.cycle(); if (dispatchReason === null) await dispatcher?.tick(); },
  }) : undefined;
  if (options.execution && options.access && poller) dispatcher = createDispatcher({ session: state, access: options.access, ports: options.execution,
    currentAttempt: repository => poller.currentAttempt(repository), readWorks: () => readWorks(state), ownCycles: issueIds => ownCycles(state, issueIds),
    record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation), paused: async () => (await readInstallation(state)).paused,
    heldSlots: () => heldSlots(state), questionRecorded: () => desk?.kick() });
  const pollingView = (): PollingView => poller?.view() ?? { state: 'disabled', intervalSeconds: null, cycles: 0, lastCycleAt: null, source: 'in-memory-observation', repositories: [] };
  // Work-level reasons preventing a start now; the dependency evaluation must belong to the repository's current polling round.
  const blockers = (work: WorkRecord) => dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies.latest,
    currentAttempt: poller?.currentAttempt(work.repository.repository) ?? null });
  const present = (work: WorkRecord, paused: boolean): WorkView => {
    const impediments: Impediment[] = [...work.impediments,
      ...(paused ? [{ code: 'GLOBAL_PAUSE', scope: 'installation' as const, nextStep: 'Unpause to allow new triggers; unpausing removes no individual impediment.' }] : [])];
    // A Question wait whose boot ceased occupies nothing: the Work shows its queue blockers (QUESTION_PENDING...), not "executing".
    const waiting = work.execution?.state === 'ended' && work.execution.end?.outcome === 'question' && !work.execution.slot.held;
    const execution = work.execution && work.execution.state !== 'released' && !waiting ? work.execution : null;
    const reasons = [...(execution ? [] : blockers(work)), ...(dispatchReason ? [dispatchReason] : []), ...(paused ? ['GLOBAL_PAUSE'] : [])];
    return { ...work, impediments, dispatch: { state: execution ? 'executing' : reasons.length ? 'held' : 'eligible', reasons } };
  };
  const selection = (works: WorkRecord[]) => selectNext(works.filter(work => work.result === 'open' && work.queue.pending && work.queue.category === 'normal')
    .map(work => ({ work_id: work.work_id, blockers: blockers(work) })));
  let running = false;
  const control: Control = {
    async accept(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'INVALID_COMMAND' };
      // Local CLI under the administrator account's trust; correlation/single answer are checked in the commit.
      if (parsed.data.operation === 'answer') return acceptAnswer(state, { request_id: parsed.data.request_id, question_id: parsed.data.question_id, text: parsed.data.text, origin: { kind: 'local-cli' } });
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
        queues: { normal: works.filter(work => work.queue.pending && work.queue.category === 'normal').length, repair: 0 },
        dependencies: { satisfied: works.filter(work => work.dependencies.latest?.conclusion === 'satisfied').length,
          pending: works.filter(work => work.dependencies.latest?.conclusion === 'pending').length,
          inconclusive: works.filter(work => work.dependencies.latest?.conclusion === 'inconclusive').length,
          notEvaluated: works.filter(work => !work.dependencies.latest).length },
        questions: { open: allQuestions.filter(item => item.state === 'open').length, answered: allQuestions.filter(item => item.state === 'answered').length,
          unpublished: allQuestions.filter(item => item.state === 'open' && item.publication.state !== 'published').length },
        selection: { next: selection(works).next },
        polling: { ...polling, repositories: polling.repositories.map(({ candidates: _candidates, ...repo }) => repo) },
        persistence: store.persistence } satisfies ControlStatus;
    },
    async run(signal) {
      if (running) throw new Error('CONTROL_ALREADY_RUNNING');
      running = true;
      const loop = new AbortController();
      let polling: Promise<void> = Promise.resolve();
      try {
        // Authoritative persisted task inventory, not an empty fake scheduler. Unknown runtime resources stay closed.
        const tasks = await state.commit(tx => tx.scanTasks({}, 1), BACKGROUND_CONTEXT);
        // A Slot still held from an earlier owner means unknown runtime state: stay closed until recovery (ticket 26).
        if (tasks.items.length === 0 && options.runtimeInventory === 'empty') dispatchReason = dispatcher && await heldSlots(state) === 0 ? null : dispatcher ? 'RECONCILIATION_REQUIRED' : 'EXECUTION_NOT_ENABLED';
        // Grants of a previous process were memory-only: record them as impossible to revoke, with their risk (never blocks by itself).
        // Before polling starts, so no dispatch of this run precedes it. A run stopped before it starts (read-only inspection) writes nothing.
        if (!signal.aborted) await reconcileLostCredentials(state, isLiveCredentialExecution);
        const aborted = new Promise<'stop'>(resolve => {
          if (signal.aborted) resolve('stop');
          else signal.addEventListener('abort', () => resolve('stop'), { once: true });
        });
        // Polling is tracking/admission only; it never dispatches. A durable-authority failure ends the owner as failed.
        if (poller) polling = poller.run(loop.signal);
        const outcome = await Promise.race([aborted, state.closed.then(() => 'closed' as const),
          ...(poller ? [polling.then(() => 'polling-ended' as const, () => 'polling-failed' as const)] : [])]);
        loop.abort();
        stopped = true;
        await polling.catch(() => {});
        await dispatcher?.stop();
        await desk?.idle();
        await state.close(BACKGROUND_CONTEXT);
        const end = await state.closed;
        return { kind: outcome === 'stop' && end.kind === 'closed' ? 'clean' : 'failed' };
      } catch {
        loop.abort();
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
  return control;
}
