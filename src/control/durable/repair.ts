import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConfiguredRepository, RepairReason } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { exhaustionCodes } from '../rules/budget.js';
import {
  correctionClosure,
  correctionNextStep,
  fingerprint,
  observationDriven,
  repairCodes,
  repairDecision,
  repairTriggers,
  repeatedImpediment,
  type RepairDecision,
  type TriggerOutcome,
} from '../rules/repair.js';
import { humanReasons, isHumanReason, undeliveredHuman } from '../rules/feedback.js';
import { markInCorrection } from './feedback.js';
import { ticketIndex, works, type WorkRecord } from './admission.js';
import { closeCorrection, openCorrectionPending } from './budget.js';
import { activeExecution } from './execution.js';
import { pendingScope } from './scope.js';
import type { Session } from './store.js';

// Ticket 22 (spec §4.3, §10): the Factory follows the SAME own pull request and turns EFFECTIVE impediments of its latest recorded checks
// explanation (ticket 15) into the Work's existing correction — no extra queue, no per-event state machine, no consumption ACK. One commit
// per Work and pass; never while an Execution of the Work is active. Nothing is launched here: the dispatcher selects the repair (first,
// FIFO) and revalidates it with a fresh read before admission.

type Limits = Pick<ConfiguredRepository, 'correctionLimit' | 'recoveryLimit'>;
export type RepairObservation = { outcome: 'stale' | 'busy' | 'closed' | 'continued' | RepairDecision['kind']; correctionId: string | null; reasons: string[] };
const summary = (reasons: readonly RepairReason[]) =>
  reasons
    .map(item => `${item.code}${item.subject ? `:${item.subject}` : ''}`)
    .join(',')
    .slice(0, 200);

/**
 * One repair observation of a Work, in ONE commit, from its durable facts only: close a correction whose work is reconciled; otherwise
 * decide from the recorded explanation whether to open, consolidate, withdraw (no charge) or block a repeated event.
 */
export async function observeRepair(session: Session, work_id: string, limits: (repository: string) => Limits | undefined): Promise<RepairObservation> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id)
      return { outcome: 'stale' as const, correctionId: null, reasons: [] };
    // An active (reserved/started/held/not ceased) Execution: new facts wait for its next safe activation (no parallel writer).
    if (activeExecution(work.execution ?? null)) return { outcome: 'busy' as const, correctionId: work.correction?.correctionId ?? null, reasons: [] };
    const now = new Date().toISOString();
    const event = (name: 'repair-consolidated' | 'repair-withdrawn' | 'repair-repeated' | 'repair-continued', detail: string) =>
      work.history.push({
        at: now,
        event: name,
        origin: 'controller-repair',
        correctionId: work.correction?.correctionId ?? null,
        detail: detail.slice(0, 512),
      });
    const executions = [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];
    const head = work.publication?.verified?.head ?? work.checks?.latest.pullRequest.headSha ?? '';
    const requests = work.feedback?.requests ?? [];
    // Ticket 23 (spec §10 step 5): human requests recorded while a CHARGED correction is open entered it (commit order) and stay in the same
    // correction/charge; nothing reaches its running activity. They wait for its next safe activation (`continuing`).
    if (work.correction?.consumed) {
      const known = new Set((work.correction.reasons ?? []).map(fingerprint));
      const added = humanReasons(
        requests.filter(item => item.state === 'pending'),
        null,
        head,
      ).filter(item => !known.has(fingerprint(item)));
      if (added.length) {
        work.correction.reasons = [...(work.correction.reasons ?? []), ...added].slice(0, 32);
        markInCorrection(work, work.correction, head || null);
        adoptHuman(work);
        event('repair-consolidated', `+${summary(added)} (for its next safe activation)`);
      }
    }
    const closure = correctionClosure({
      correction: work.correction,
      execution: work.execution,
      previousExecutions: work.previousExecutions,
      publication: work.publication,
      queuePending: work.queue.pending,
    });
    if (closure.kind === 'close') {
      const correctionId = work.correction!.correctionId;
      const undelivered = undeliveredHuman(work.correction, executions);
      // Spec §10 step 6: never closed with relevant feedback of this correction still pending: activated again, same identity and charge —
      // ONCE per new published basis. An unpublishable/blocked/diverged result closes it; its undelivered requests return to pending.
      if (undelivered.length && closure.outcome === 'published' && work.correction!.continuedBasis !== closure.basisExecutionId) {
        work.correction!.continuing = true;
        work.correction!.continuedBasis = closure.basisExecutionId;
        work.queue = { ...work.queue, pending: true };
        event('repair-continued', summary(undelivered));
        return { outcome: 'continued' as const, correctionId, reasons: undelivered.map(item => item.subject ?? item.code) };
      }
      closeCorrection(work, now, closure.outcome, closure);
      noteWaiting(work, now);
      return { outcome: 'closed' as const, correctionId, reasons: [closure.outcome] };
    }
    const observed = repairTriggers({ checks: work.checks?.latest ?? null, publication: work.publication, readiness: work.readiness ?? null });
    // Ticket 23: human triggers join the observed ones — pending requests open/extend a correction only on the Work's published own PR.
    const published = work.publication?.state === 'published';
    const human = humanReasons(published ? requests : requests.filter(item => item.state === 'in-correction'), work.correction?.correctionId ?? null, head);
    const combined = [...(observed.kind === 'triggers' ? observed.reasons : []), ...human];
    // The checks' certainty decides only impediment reasons: a correction of human requests only, none of them left, is certainly empty.
    const humanOnlyCorrection = Boolean(work.correction?.reasons?.length) && (work.correction?.reasons ?? []).every(isHumanReason);
    const triggers: TriggerOutcome = combined.length
      ? { kind: 'triggers', reasons: combined }
      : observed.kind === 'none' && humanOnlyCorrection
        ? { ...observed, certain: true }
        : observed;
    const decision = repairDecision({ triggers, correction: work.correction, closed: work.corrections ?? [] });
    // A repeated-event block lasts while the repeated reasons are still observed; only a CERTAIN read (a new head/result) lifts it.
    const certain = triggers.kind === 'triggers' || triggers.certain;
    if (decision.kind !== 'repeated' && certain && work.impediments.some(item => item.code === repairCodes.repeated))
      work.impediments = work.impediments.filter(item => item.code !== repairCodes.repeated);
    switch (decision.kind) {
      case 'open': {
        const publication = work.publication!;
        const wasPending = work.queue.pending;
        const humanOnly = decision.reasons.every(isHumanReason);
        openCorrectionPending(
          work,
          index,
          now,
          `${humanOnly ? 'human feedback' : 'effective impediment'}: ${summary(decision.reasons)}`,
          limits(work.repository.repository),
          {
            reasons: decision.reasons,
            headSha: head || decision.reasons[0]!.headSha,
            basisExecutionId: publication.basisExecutionId,
            trigger: humanOnly ? 'human-feedback' : 'effective-impediment',
          },
        );
        if (work.correction) work.correction.queueWasPending = wasPending;
        markInCorrection(work, work.correction!, head || null);
        break;
      }
      case 'consolidate':
        work.correction!.reasons = decision.reasons;
        markInCorrection(work, work.correction!, head || null);
        adoptHuman(work);
        event('repair-consolidated', `+${summary(decision.added)}${decision.dropped.length ? ` -${summary(decision.dropped)}` : ''}`);
        break;
      case 'defer':
        // Charged correction: the new reasons wait (uncharged) for its next safe activation; never recorded as treated by it.
        work.correction!.pendingReasons = [...(work.correction!.pendingReasons ?? []), ...decision.added].slice(-16);
        event('repair-consolidated', `deferred +${summary(decision.added)}`);
        break;
      case 'withdraw': {
        event('repair-withdrawn', `-${summary(decision.dropped)}`);
        const wasPending = work.correction?.queueWasPending === true;
        closeCorrection(work, now, 'withdrawn', { head: null, basisExecutionId: null });
        // Nothing of the correction remains: no charge, no pending activation (unless something else is pending), no exhaustion block for it.
        work.queue = { ...work.queue, pending: wasPending || Boolean(work.pendingRecovery) || pendingScope(work).length > 0 };
        work.impediments = work.impediments.filter(item => item.code !== exhaustionCodes.corrections);
        break;
      }
      case 'repeated':
        if (!work.impediments.some(item => item.code === repairCodes.repeated)) {
          work.impediments.push(repeatedImpediment(decision.reasons, decision.correctionIds, now));
          event('repair-repeated', `${decision.reasons.map(fingerprint).join(',')}<-${decision.correctionIds.join(',')}`);
        }
        break;
      case 'none':
        break;
    }
    if (work.correction && work.correction.trigger !== 'internal' && (decision.kind === 'open' || decision.kind === 'consolidate')) {
      work.correction.nextStep = correctionNextStep(work.correction.reasons ?? [], work.budget?.corrections);
    }
    noteWaiting(work, now);
    return { outcome: decision.kind, correctionId: work.correction?.correctionId ?? null, reasons: decision.kind === 'none' ? decision.why : [] };
  }, BACKGROUND_CONTEXT);
}

/** Ticket 23: human reasons folded into an INTERNAL correction make it observation-driven (mixed): its Builder receives them like any repair. */
function adoptHuman(work: WorkRecord) {
  const correction = work.correction;
  if (!correction || observationDriven(correction) || !(correction.reasons ?? []).some(isHumanReason)) return;
  correction.trigger = 'human-feedback';
  correction.basisExecutionId ??= work.publication?.basisExecutionId ?? null;
}
const waitingStep =
  "Human requests are recorded and wait for this Work's published own pull request; they enter a correction on the next published result. " +
  'Nothing is retried meanwhile. Inspect with `factory show <work>`; to change the request instead, use `factory update-scope <work> --reason <text>`.';
/** Non-blocking note (no history growth): pending human requests with no correction and no published own PR to fold them into. */
function noteWaiting(work: WorkRecord, now: string) {
  const feedback = work.feedback;
  if (!feedback) return;
  const waiting = !work.correction && work.publication?.state !== 'published' && feedback.requests.some(item => item.state === 'pending');
  if (waiting && !feedback.waiting) feedback.waiting = { since: now, nextStep: waitingStep };
  else if (!waiting && feedback.waiting) feedback.waiting = null;
}

/** History of the fresh revalidation that let the repair proceed to admission (its reasons, as read immediately before). */
export const recordRepairRevalidation = (session: Session, work_id: string, correctionId: string, detail: string) =>
  session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    // Deduplicated: a revalidation repeated because admission was refused (e.g. no Slot) appends nothing new.
    const last = [...(document.work?.history ?? [])].reverse().find(item => item.event === 'repair-revalidated');
    if (last && 'correctionId' in last && last.correctionId === correctionId && last.detail === detail.slice(0, 512)) return;
    document.work?.history.push({
      at: new Date().toISOString(),
      event: 'repair-revalidated',
      origin: 'controller-repair',
      correctionId,
      detail: detail.slice(0, 512),
    });
  }, BACKGROUND_CONTEXT);

/** The repair pass of the owner loop (after checks and readiness): one observation per open published Work not running in this owner. */
export function createRepairDesk(deps: {
  session: Session;
  readWorks(): Promise<WorkRecord[]>;
  busy(work_id: string): boolean;
  limits(repository: string): Limits | undefined;
}) {
  return {
    async pass(signal: AbortSignal) {
      for (const work of await deps.readWorks()) {
        if (signal.aborted) return;
        const pending = (work.feedback?.requests ?? []).some(item => item.state === 'pending') || Boolean(work.feedback?.waiting);
        if (work.result !== 'open' || deps.busy(work.work_id) || (!work.correction && work.publication?.state !== 'published' && !pending)) continue;
        await observeRepair(deps.session, work.work_id, deps.limits);
      }
    },
  };
}
