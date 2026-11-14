import type { TicketRef } from '../../issue-tracker/index.js';
import type { AccessDependencies, CandidateView, ConfiguredRepository, PollingClock, PollingView, RepositoryPollView } from '../types.js';
import { evaluateEntry, evaluatePublication, pollDelaySeconds, type Hold } from '../rules/admission.js';
import type { AdmissionEvidence, AdmissionResult } from './admission.js';

const maxTimer = 2 ** 31 - 1;
export const systemClock: PollingClock = {
  monotonic: () => performance.now(),
  sleep: (ms, signal) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, Math.min(Math.max(ms, 0), maxTimer));
    const stop = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', stop, { once: true });
  }),
};

type Unavailable = { kind: 'unavailable'; observedAt: string; code: string; waitSeconds?: number; nextStep: string };
type RepositoryState = { scope: ConfiguredRepository; dueAt: number; failures: number; view: RepositoryPollView };

/**
 * Single sequential polling loop in the existing owner (no scheduler/broker). Each cycle visits due repositories one at a time, so
 * queries never overlap; the next wait honours service-indicated waits and backoff. Admission itself is the durable commit in admission.ts.
 */
export function createPoller(deps: {
  access: AccessDependencies; intervalSeconds: number; clock: PollingClock;
  paused(): Promise<boolean>; indexed(ticket: TicketRef): Promise<string | undefined>; admit(evidence: AdmissionEvidence): Promise<AdmissionResult>;
}) {
  const { tracker, repository } = deps.access;
  const interval = deps.intervalSeconds;
  const repositories: RepositoryState[] = deps.access.repositories.map(scope => ({ scope, dueAt: 0, failures: 0,
    view: { repository: scope.repository, label: scope.label, state: 'pending', observedAt: null, completeness: null, absenceProven: false,
      consecutiveFailures: 0, nextPollInSeconds: null, candidates: null } }));
  let state: PollingView['state'] = repositories.length ? 'starting' : 'disabled';
  let cycles = 0;
  let lastCycleAt: string | null = null;
  // Unexpected adapter exceptions are explicit failures of that observation, never empty/green results.
  const guarded = async <T>(repo: string, read: () => Promise<T>): Promise<T | Unavailable> => {
    try { return await read(); } catch {
      return { kind: 'unavailable', observedAt: new Date().toISOString(), code: 'POLLING_QUERY_FAILED',
        nextStep: `Unexpected failure while observing ${repo}; nothing is concluded from it. Inspect controller logs; polling retries with backoff.` };
    }
  };

  async function evaluate(entry: RepositoryState, ref: TicketRef): Promise<{ view: CandidateView; waitSeconds?: number }> {
    const held = (holds: Hold[], observedAt = new Date().toISOString()): CandidateView => ({ ticket: ref, observedAt, outcome: 'held', holds });
    const existing = await deps.indexed(ref);
    if (existing) return { view: { ticket: ref, observedAt: new Date().toISOString(), outcome: 'existing', work_id: existing } };
    if (await deps.paused()) return { view: held([{ code: 'GLOBAL_PAUSE', nextStep: 'Global pause holds new admissions; tracking continues. Unpause to admit on the next poll.' }]) };
    const configured = deps.access.repositories.find(scope => scope.repository.toLowerCase() === ref.repository.toLowerCase());
    if (!configured) {
      const result = evaluateEntry({ configuredLabel: undefined, listed: ref, facts: { kind: 'unavailable', code: 'NOT_READ', nextStep: '' } });
      return { view: held(result.authorized ? [] : result.holds) };
    }
    const facts = await guarded(configured.repository, () => tracker.readTicket(ref));
    const entryDecision = evaluateEntry({ configuredLabel: configured.label, listed: ref, facts });
    if (!entryDecision.authorized || facts.kind !== 'observed') {
      return { view: held(entryDecision.authorized ? [] : entryDecision.holds, facts.observedAt), ...(facts.kind === 'unavailable' && facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}) };
    }
    const publication = await guarded(configured.repository, () => repository.findPublication({ repo: configured, issueNumber: ref.number, knownBranches: [] }));
    const publicationDecision = evaluatePublication({ facts: publication, ownBranches: [] });
    if (!publicationDecision.clear || publication.kind !== 'observed') {
      return { view: held(publicationDecision.clear ? [] : publicationDecision.holds, publication.observedAt),
        ...(publication.kind === 'unavailable' && publication.waitSeconds !== undefined ? { waitSeconds: publication.waitSeconds } : {}) };
    }
    const admitted = await deps.admit({ ticket: facts.ticket, repository: { repository: configured.repository, repositoryId: facts.ticket.repositoryId, base: configured.base },
      observedAt: facts.observedAt, label: entryDecision.label, publication: { observedAt: publication.observedAt, limitations: publication.limitations } });
    if (admitted.kind === 'paused') return { view: held([{ code: 'GLOBAL_PAUSE', nextStep: 'Pause committed before admission; unpause to admit on the next poll.' }]) };
    return { view: { ticket: ref, observedAt: new Date().toISOString(), outcome: admitted.kind, work_id: admitted.work_id } };
  }

  async function cycle(entry: RepositoryState) {
    const listing = await guarded(entry.scope.repository, () => tracker.listCandidates(entry.scope));
    let delay: number;
    if (listing.kind !== 'observed') {
      entry.failures++;
      delay = pollDelaySeconds({ intervalSeconds: interval, outcome: 'unavailable', consecutiveFailures: entry.failures, ...(listing.waitSeconds !== undefined ? { waitSeconds: listing.waitSeconds } : {}) });
      entry.view = { repository: entry.scope.repository, label: entry.scope.label, state: 'unavailable', observedAt: listing.observedAt, completeness: 'incomplete',
        absenceProven: false, code: listing.code, ...(listing.waitSeconds !== undefined ? { waitSeconds: listing.waitSeconds } : {}),
        nextStep: `Listing unavailable; absence of Tickets, labels or pull requests is not concluded. ${listing.nextStep}`,
        consecutiveFailures: entry.failures, nextPollInSeconds: delay, candidates: null };
    } else {
      entry.failures = 0;
      const candidates: CandidateView[] = [];
      let waitSeconds: number | undefined;
      for (const ref of listing.candidates) {
        if (waitSeconds !== undefined) {
          candidates.push({ ticket: ref, observedAt: new Date().toISOString(), outcome: 'not-evaluated', reason: 'GitHub wait window open; evaluated on a later poll.' });
          continue;
        }
        const result = await evaluate(entry, ref);
        candidates.push(result.view);
        waitSeconds = result.waitSeconds;
      }
      delay = pollDelaySeconds({ intervalSeconds: interval, outcome: 'observed', consecutiveFailures: 0, ...(waitSeconds !== undefined ? { waitSeconds } : {}) });
      entry.view = { repository: entry.scope.repository, label: entry.scope.label, state: 'observed', observedAt: listing.observedAt, completeness: 'complete',
        absenceProven: false, ...(waitSeconds !== undefined ? { code: 'GITHUB_WAIT_WINDOW', waitSeconds } : {}), consecutiveFailures: 0, nextPollInSeconds: delay, candidates };
    }
    entry.dueAt = deps.clock.monotonic() + delay * 1000;
  }

  return {
    view(): PollingView {
      const now = deps.clock.monotonic();
      return { state, intervalSeconds: interval, cycles, lastCycleAt, source: 'in-memory-observation',
        repositories: repositories.map(entry => ({ ...entry.view, nextPollInSeconds: entry.view.state === 'pending' ? null : Math.max(0, Math.ceil((entry.dueAt - now) / 1000)) })) };
    },
    /** Resolves when signalled; rejects only for durable-authority failures (never for remote observation failures). */
    async run(signal: AbortSignal): Promise<void> {
      if (!repositories.length) {
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
        return;
      }
      try {
        while (!signal.aborted) {
          state = 'polling';
          for (const entry of repositories) {
            if (signal.aborted) break;
            if (entry.dueAt <= deps.clock.monotonic()) await cycle(entry);
          }
          cycles++;
          lastCycleAt = new Date().toISOString();
          if (signal.aborted) break;
          state = 'sleeping';
          await deps.clock.sleep(Math.max(0, Math.min(...repositories.map(entry => entry.dueAt)) - deps.clock.monotonic()), signal);
        }
      } finally { state = 'stopped'; }
    },
  };
}
