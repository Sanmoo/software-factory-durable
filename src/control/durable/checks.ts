import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AccessDependencies, ChecksEvaluation, ChecksView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { evaluateChecks, type ChecksExpectation, type ChecksObservation } from '../rules/checks.js';
import { ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

// Ticket 15 (spec §9.2): explanation of the GitHub required checks of the Work's linked own pull request (ticket 14), as TRACKING inside the
// existing owner loop: safe reads outside any commit, one commit per explanation, never a Slot, a queue entry, an impediment, a repair or a
// readiness decision. Nothing new: no broker, scheduler or registry.

/** Ticket 14's publication record as stored on the Work; read structurally (this module never re-derives or adopts the own PR). */
type Linked = { state?: unknown; base?: unknown; linkedHeads?: unknown; verified?: { requiredChecks?: unknown } | null;
  pullRequest?: { pullRequestId?: unknown; nodeId?: unknown; number?: unknown; headRef?: unknown; headSha?: unknown; author?: { id?: unknown } | null } | null };
export type ChecksTarget = { number: number; nodeId: string; expect: ChecksExpectation };
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The linked own PR of an open Work whose publication is `published` (ticket 14), or null: nothing else is ever evaluated. */
export function checksTarget(work: WorkRecord): ChecksTarget | null {
  if (work.result !== 'open') return null;
  const publication = (work as { publication?: unknown }).publication as Linked | null | undefined;
  const pull = publication?.state === 'published' ? publication.pullRequest : null;
  if (!pull || typeof pull.number !== 'number' || typeof pull.nodeId !== 'string' || typeof pull.pullRequestId !== 'number' || typeof pull.headRef !== 'string' ||
    typeof pull.headSha !== 'string' || typeof pull.author?.id !== 'number') return null;
  return { number: pull.number, nodeId: pull.nodeId, expect: {
    own: { pullRequestId: pull.pullRequestId, nodeId: pull.nodeId, number: pull.number, headRef: pull.headRef,
      base: typeof publication!.base === 'string' ? publication!.base : work.repository.base, authorId: pull.author.id },
    repositoryId: work.repository.repositoryId, linkedHeads: [...new Set([pull.headSha, ...strings(publication!.linkedHeads)])].slice(0, 20),
    localRequiredChecks: strings(publication!.verified?.requiredChecks).slice(0, 32) } };
}

const codes = (evaluation: ChecksEvaluation) => evaluation.reasons.map(reason => `${reason.category}:${reason.code}${reason.subject ? `:${reason.subject}` : ''}`);
const summary = (evaluation: ChecksEvaluation): ChecksView['history'][number] =>
  ({ at: evaluation.at, headSha: evaluation.pullRequest.headSha, outcome: evaluation.outcome, reasons: codes(evaluation) });

/**
 * Records one explanation for the PR it was computed for: only while the Work is still open, current and linked to that SAME own PR.
 * An identical explanation replaces the latest one; a different one (outcome, head or reasons) pushes the previous one to the bounded
 * history and appends one history event. Never touches queue, Slots, impediments or the publication record.
 */
export async function recordChecks(session: Session, work_id: string, target: Pick<ChecksTarget, 'number' | 'nodeId'>, evaluation: ChecksEvaluation): Promise<'recorded' | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id) return 'stale' as const;
    const current = checksTarget(work);
    if (!current || current.number !== target.number || current.nodeId !== target.nodeId) return 'stale' as const;
    const previous = work.checks?.latest ?? null;
    const changed = !previous || previous.outcome !== evaluation.outcome || previous.pullRequest.headSha !== evaluation.pullRequest.headSha ||
      JSON.stringify(codes(previous)) !== JSON.stringify(codes(evaluation));
    const history = work.checks?.history ?? [];
    work.checks = { latest: evaluation, history: changed && previous ? [...history, summary(previous)].slice(-10) : history };
    if (changed) work.history.push({ at: evaluation.at, event: 'checks-evaluated', origin: 'controller-checks',
      detail: `${evaluation.outcome}@${evaluation.pullRequest.headSha ?? 'unknown'}:${evaluation.reasons.map(reason => `${reason.code}${reason.subject ? `:${reason.subject}` : ''}`).join(',')}`.slice(0, 512) });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * The tracking pass run by the dispatcher tick (after each polling cycle). Bounded: at most `perPass` PR reads per tick, oldest explanation
 * first; a Work with a running activity is skipped. Each read is a GET-only `readPullRequest` of the configured repository.
 */
export function createChecksTracker(deps: { session: Session; access: AccessDependencies; readWorks(): Promise<WorkRecord[]>; busy(work_id: string): boolean; perPass?: number }) {
  const perPass = deps.perPass ?? 2;
  // In memory: order of the last explanation of each Work in THIS process (rotation only; the record itself is durable).
  const last = new Map<string, number>();
  let sequence = 0;
  return {
    async pass(signal: AbortSignal) {
      const candidates = (await deps.readWorks()).flatMap(work => { const target = checksTarget(work); return target && !deps.busy(work.work_id) ? [{ work, target }] : []; })
        .sort((a, b) => (last.get(a.work.work_id) ?? -1) - (last.get(b.work.work_id) ?? -1));
      for (const { work, target } of candidates.slice(0, perPass)) {
        if (signal.aborted) return;
        last.set(work.work_id, ++sequence);
        const configured = deps.access.repositories.find(item => item.repository.toLowerCase() === work.repository.repository.toLowerCase());
        const unavailable = (code: string): ChecksObservation => ({ kind: 'unavailable', source: 'github-rest', observedAt: new Date().toISOString(),
          repository: work.repository.repository, code, nextStep: 'Nothing about the checks is concluded; a later cycle reads again.' });
        let observation: ChecksObservation;
        if (!configured) observation = unavailable('REPOSITORY_NOT_CONFIGURED');
        else {
          try { observation = await deps.access.repository.readPullRequest({ repo: configured, number: target.number }); }
          catch { observation = unavailable('PULL_REQUEST_QUERY_FAILED'); }
        }
        if (signal.aborted) return;
        await recordChecks(deps.session, work.work_id, target, evaluateChecks({ at: new Date().toISOString(), expect: target.expect, observation }));
      }
    },
  };
}
