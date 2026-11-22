import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AccessDependencies, ChecksEvaluation, ChecksView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { evaluateChecks, type ChecksExpectation, type ChecksObservation } from '../rules/checks.js';
import { ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

// Ticket 15 (spec §9.2): explanation of the GitHub required checks of the Work's linked own pull request (ticket 14), as TRACKING inside the
// existing owner loop: safe reads outside any commit, one commit per explanation, never a Slot, a queue entry, an impediment, a repair or a
// readiness decision. Nothing new: no broker, scheduler or registry.

export type ChecksTarget = { number: number; nodeId: string; expect: ChecksExpectation };

/** The linked own PR of an open Work whose ticket 14 publication is `published`, or null: nothing else is ever evaluated or adopted here. */
export function checksTarget(work: WorkRecord): ChecksTarget | null {
  const publication = work.result === 'open' && work.publication?.state === 'published' ? work.publication : null;
  const pull = publication?.pullRequest;
  if (!publication || !pull) return null;
  return {
    number: pull.number,
    nodeId: pull.nodeId,
    expect: {
      own: {
        pullRequestId: pull.pullRequestId,
        nodeId: pull.nodeId,
        number: pull.number,
        headRef: pull.headRef,
        base: publication.base,
        authorId: pull.author.id,
      },
      repositoryId: work.repository.repositoryId,
      linkedHeads: [...new Set([pull.headSha, ...(publication.linkedHeads ?? [])])].slice(0, 20),
      localRequiredChecks: [...(publication.verified?.requiredChecks ?? [])].slice(0, 32),
    },
  };
}

const codes = (evaluation: ChecksEvaluation) =>
  evaluation.reasons.map(reason => `${reason.category}:${reason.code}${reason.subject ? `:${reason.subject}` : ''}`);
const summary = (evaluation: ChecksEvaluation): ChecksView['history'][number] => ({
  at: evaluation.at,
  headSha: evaluation.pullRequest.headSha,
  outcome: evaluation.outcome,
  reasons: codes(evaluation),
});

/**
 * Records one explanation for the PR it was computed for: only while the Work is still open, current and linked to that SAME own PR.
 * An identical explanation replaces the latest one; a different one (outcome, head or reasons) pushes the previous one to the bounded
 * history and appends one history event. Never touches queue, Slots, impediments or the publication record.
 */
export async function recordChecks(
  session: Session,
  work_id: string,
  target: Pick<ChecksTarget, 'number' | 'nodeId'>,
  evaluation: ChecksEvaluation,
): Promise<'recorded' | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id) return 'stale' as const;
    const current = checksTarget(work);
    if (!current || current.number !== target.number || current.nodeId !== target.nodeId) return 'stale' as const;
    const previous = work.checks?.latest ?? null;
    const changed =
      !previous ||
      previous.outcome !== evaluation.outcome ||
      previous.pullRequest.headSha !== evaluation.pullRequest.headSha ||
      JSON.stringify(codes(previous)) !== JSON.stringify(codes(evaluation));
    const history = work.checks?.history ?? [];
    work.checks = { latest: evaluation, history: changed && previous ? [...history, summary(previous)].slice(-10) : history };
    if (changed)
      work.history.push({
        at: evaluation.at,
        event: 'checks-evaluated',
        origin: 'controller-checks',
        detail:
          `${evaluation.outcome}@${evaluation.pullRequest.headSha ?? 'unknown'}:${evaluation.reasons.map(reason => `${reason.code}${reason.subject ? `:${reason.subject}` : ''}`).join(',')}`.slice(
            0,
            512,
          ),
      });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** Equality of two explanations apart from their instants: an identical one is never rewritten (no commit). */
export const checksFingerprint = (evaluation: ChecksEvaluation) => JSON.stringify({ ...evaluation, at: null, observedAt: null, completedAt: null });
const stable = new Set<ChecksEvaluation['outcome']>(['satisfied', 'failing', 'blocked', 'not-applicable']);
/** Largest service-indicated wait (seconds) of any read of the observation (rate limit), or 0. */
const waitOf = (observation: ChecksObservation | { kind: 'unchanged' }) => {
  if (observation.kind === 'unchanged') return 0;
  if (observation.kind === 'unavailable') return observation.waitSeconds ?? 0;
  const reads = [
    observation.baseTip,
    observation.classic,
    observation.rules,
    observation.checkRuns,
    observation.statuses,
    observation.comparison,
    observation.recheck,
    observation.final.baseTip,
    observation.final.classic,
    observation.final.rules,
  ];
  return Math.max(0, ...reads.map(read => (read && read.state === 'unknown' ? (read.waitSeconds ?? 0) : 0)));
};

export type ChecksTrackerOptions = {
  session: Session;
  access: AccessDependencies;
  readWorks(): Promise<WorkRecord[]>;
  busy(work_id: string): boolean;
  /** Monotonic clock (the polling clock in production). */
  clock?: { monotonic(): number };
  /** Per-Work minimum interval between reads (production: the polling interval). */
  minIntervalMs?: number;
  /** A stable explanation (satisfied/failing/blocked/not-applicable) of an unchanged head is fully re-read only this often; in between a
   * light read of the PR alone detects a new head. Default: 10 x minIntervalMs. */
  stableIntervalMs?: number;
  /** At most this many PR reads per pass. */
  perPass?: number;
  /** Rate bound per unit of time: at most `reads` FULL collections per `ms` (sliding window) for the whole installation. */
  window?: { ms: number; reads: number };
};

/**
 * The checks tracking pass, run by the owner loop AFTER each polling cycle and its dispatch tick (never on the dispatch critical path).
 * Per Work: a minimum interval, exponential backoff on unavailable reads honouring GitHub's waits, light reads of an unchanged stable head,
 * and a global sliding-window bound on full collections. A Work with a running activity is skipped. An explanation identical to the
 * recorded one is not committed. Memory only (rebuilt after restart: then every linked PR is due once).
 */
export function createChecksTracker(deps: ChecksTrackerOptions) {
  const clock = deps.clock ?? { monotonic: () => performance.now() };
  const minIntervalMs = deps.minIntervalMs ?? 60000;
  const stableIntervalMs = deps.stableIntervalMs ?? 10 * minIntervalMs;
  const perPass = deps.perPass ?? 2;
  const window = deps.window ?? { ms: 10 * 60000, reads: 20 };
  const schedule = new Map<string, { dueAt: number; fullDueAt: number; failures: number }>();
  const full: number[] = [];
  return {
    async pass(signal: AbortSignal) {
      const now = clock.monotonic();
      while (full.length && full[0]! <= now - window.ms) full.shift();
      const due = (await deps.readWorks())
        .flatMap(work => {
          const target = checksTarget(work);
          const active = work.execution?.state === 'reserved' || work.execution?.state === 'started';
          const at = schedule.get(work.work_id)?.dueAt ?? Number.NEGATIVE_INFINITY;
          return target && !active && !deps.busy(work.work_id) && at <= now ? [{ work, target, at }] : [];
        })
        .sort((a, b) => a.at - b.at);
      let reads = 0;
      for (const { work, target } of due) {
        if (signal.aborted || reads >= perPass) return;
        const state = schedule.get(work.work_id) ?? { dueAt: 0, fullDueAt: Number.NEGATIVE_INFINITY, failures: 0 };
        const latest = work.checks?.latest ?? null;
        const light =
          latest !== null && stable.has(latest.outcome) && latest.pullRequest.headSha !== null && latest.pullRequest.baseRef !== null && now < state.fullDueAt;
        if (!light && full.length >= window.reads) continue;
        reads++;
        const configured = deps.access.repositories.find(item => item.repository.toLowerCase() === work.repository.repository.toLowerCase());
        const unavailable = (code: string): ChecksObservation => ({
          kind: 'unavailable',
          source: 'github-rest',
          observedAt: new Date().toISOString(),
          repository: work.repository.repository,
          code,
          nextStep: 'Nothing about the checks is concluded; a later cycle reads again.',
        });
        let observation: ChecksObservation | { kind: 'unchanged' };
        if (!configured) observation = unavailable('REPOSITORY_NOT_CONFIGURED');
        else {
          try {
            observation = await deps.access.repository.readPullRequest({
              repo: configured,
              number: target.number,
              ...(light
                ? {
                    unless: {
                      headSha: latest.pullRequest.headSha!,
                      baseRef: latest.pullRequest.baseRef!,
                      // Ticket 16: a draft/ready flip (e.g. a human draft) makes the light read a full one.
                      ...(latest.pullRequest.draft !== null ? { draft: latest.pullRequest.draft } : {}),
                    },
                  }
                : {}),
            });
          } catch {
            observation = unavailable('PULL_REQUEST_QUERY_FAILED');
          }
        }
        if (signal.aborted) return;
        // Every full collection counts against the window, including a light read that found a new head (the adapter then reads everything).
        if (observation.kind !== 'unchanged') full.push(now);
        const failures = observation.kind === 'unavailable' ? state.failures + 1 : 0;
        const delay = Math.max(minIntervalMs * 2 ** Math.min(failures, 4), waitOf(observation) * 1000);
        schedule.set(work.work_id, {
          dueAt: now + delay,
          failures,
          fullDueAt: observation.kind === 'observed' ? now + stableIntervalMs : observation.kind === 'unchanged' ? state.fullDueAt : 0,
        });
        if (observation.kind === 'unchanged') continue;
        const evaluation = evaluateChecks({ at: new Date().toISOString(), expect: target.expect, observation });
        if (latest && checksFingerprint(latest) === checksFingerprint(evaluation)) continue;
        await recordChecks(deps.session, work.work_id, target, evaluation);
      }
    },
  };
}
