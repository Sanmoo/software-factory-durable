import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import type { AccessDependencies, Control, ControlStatus, DispatchReason, Impediment, ListView, PollingOptions, PollingView, WorkView } from '../types.js';
import { openStore } from './store.js';
import { acceptPauseCommand, admitTicket, indexedWork, initialize, ownCycles, pendingWorks, readInstallation, readRequest, readWork, readWorks, recordDependencies,
  type WorkRecord } from './admission.js';
import { createPoller, systemClock } from './polling.js';
import { dispatchBlockers, selectNext } from '../rules/dependencies.js';

const inputSchema = z.strictObject({
  request_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli'),
});
const workIdSchema = z.uuid();
const limitations = [
  'Candidate observations are in-memory results of the latest poll, not authority; they are rebuilt after restart.',
  'A failed or partial query, or absence from a listing, never proves absence of a Ticket, label or pull request, nor withdrawal of authorization.',
  'Dispatch is held: execution activation is not part of this increment; selection shows what native dependency gating would allow.',
  'Native dependency evaluations are re-done every polling round; only an evaluation of the current round can release, never an older or pre-restart one.',
];

/** Bootstrap must already hold the stable canonical-storage flock for this owner's entire lifetime. */
export async function openControl(options: { storagePath: string; runtimeInventory: 'empty' | 'unknown'; access?: AccessDependencies; polling?: PollingOptions }): Promise<Control> {
  // Closed before any storage open; this increment exposes no dispatch, task, or external-effect entrypoint.
  let dispatchReason: DispatchReason = 'RECONCILIATION_REQUIRED';
  const controller_run_id = randomUUID();
  const store = await openStore(options.storagePath);
  const state = store.session;
  try { await initialize(state); } catch (error) { await store.close().catch(() => {}); throw error; }
  const poller = options.access && options.polling ? createPoller({
    access: options.access, intervalSeconds: options.polling.intervalSeconds, clock: options.polling.clock ?? systemClock,
    paused: async () => (await readInstallation(state)).paused,
    indexed: ticket => indexedWork(state, ticket),
    admit: evidence => admitTicket(state, evidence),
    pending: repositoryId => pendingWorks(state, repositoryId),
    ownCycles: issueIds => ownCycles(state, issueIds),
    record: (work_id, evaluation) => recordDependencies(state, work_id, evaluation),
  }) : undefined;
  const pollingView = (): PollingView => poller?.view() ?? { state: 'disabled', intervalSeconds: null, cycles: 0, lastCycleAt: null, source: 'in-memory-observation', repositories: [] };
  // Work-level reasons preventing a start now; the dependency evaluation must belong to the repository's current polling round.
  const blockers = (work: WorkRecord) => dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies.latest,
    currentAttempt: poller?.currentAttempt(work.repository.repository) ?? null });
  const present = (work: WorkRecord, paused: boolean): WorkView => {
    const impediments: Impediment[] = [...work.impediments,
      ...(paused ? [{ code: 'GLOBAL_PAUSE', scope: 'installation' as const, nextStep: 'Unpause to allow new triggers; unpausing removes no individual impediment.' }] : [])];
    return { ...work, impediments, dispatch: { state: 'held', reasons: [...blockers(work), dispatchReason, ...(paused ? ['GLOBAL_PAUSE'] : [])] } };
  };
  const selection = (works: WorkRecord[]) => selectNext(works.filter(work => work.result === 'open' && work.queue.pending && work.queue.category === 'normal')
    .map(work => ({ work_id: work.work_id, blockers: blockers(work) })));
  let running = false;
  return {
    async accept(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'INVALID_COMMAND' };
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
        if (!inputSchema.shape.request_id.safeParse(query.request_id).success) throw new Error('INVALID_REQUEST_ID');
        return { kind: 'request', receipt: await readRequest(state, query.request_id) };
      }
      const current = await readInstallation(state);
      if (query.kind === 'show') {
        if (!workIdSchema.safeParse(query.work_id).success) throw new Error('INVALID_WORK_ID');
        const work = await readWork(state, query.work_id);
        if (!work) return { kind: 'work-not-found', work_id: query.work_id, nextStep: 'No Work with this identity in the controller authority; use `factory list`.' };
        const lastPolled = pollingView().repositories.flatMap(repo => repo.candidates ?? [])
          .find(candidate => candidate.ticket.issueId === work.ticket.issueId && candidate.ticket.repositoryId === work.ticket.repositoryId) ?? null;
        return { kind: 'work', work: present(work, current.paused), lastPolled };
      }
      const works = await readWorks(state);
      if (query.kind === 'list') {
        return { kind: 'list', paused: current.paused, dispatch: 'closed', dispatchReason, works: works.map(work => present(work, current.paused)),
          queues: { normal: works.filter(work => work.queue.pending && work.queue.category === 'normal').map(work => work.work_id), repair: [] },
          selection: selection(works), polling: pollingView(), limitations } satisfies ListView;
      }
      const polling = pollingView();
      return { controller_run_id, paused: current.paused, dispatch: 'closed', dispatchReason, historyLength: current.history.length,
        works: { total: works.length, open: works.filter(work => work.result === 'open').length },
        queues: { normal: works.filter(work => work.queue.pending && work.queue.category === 'normal').length, repair: 0 },
        dependencies: { satisfied: works.filter(work => work.dependencies.latest?.conclusion === 'satisfied').length,
          pending: works.filter(work => work.dependencies.latest?.conclusion === 'pending').length,
          inconclusive: works.filter(work => work.dependencies.latest?.conclusion === 'inconclusive').length,
          notEvaluated: works.filter(work => !work.dependencies.latest).length },
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
        if (tasks.items.length === 0 && options.runtimeInventory === 'empty') dispatchReason = 'EXECUTION_NOT_ENABLED';
        const aborted = new Promise<'stop'>(resolve => {
          if (signal.aborted) resolve('stop');
          else signal.addEventListener('abort', () => resolve('stop'), { once: true });
        });
        // Polling is tracking/admission only; it never dispatches. A durable-authority failure ends the owner as failed.
        if (poller) polling = poller.run(loop.signal);
        const outcome = await Promise.race([aborted, state.closed.then(() => 'closed' as const),
          ...(poller ? [polling.then(() => 'polling-ended' as const, () => 'polling-failed' as const)] : [])]);
        loop.abort();
        await polling.catch(() => {});
        await state.close(BACKGROUND_CONTEXT);
        const end = await state.closed;
        return { kind: outcome === 'stop' && end.kind === 'closed' ? 'clean' : 'failed' };
      } catch {
        loop.abort();
        await polling.catch(() => {});
        await state.close(BACKGROUND_CONTEXT).catch(() => {});
        return { kind: 'failed' };
      }
    },
  };
}
