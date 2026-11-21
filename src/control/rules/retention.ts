import type {
  DetailInventory,
  DetailItem,
  ExecutionView,
  ExplicitCleanupItem,
  ExplicitCleanupPlan,
  ExplicitCleanupSelection,
  QuestionView,
  RetentionView,
  WorkView,
} from '../types.js';
import { occupying } from './cycles.js';
import { concluded, retryable } from './delivery.js';

// Ticket 30 pure rules (spec §12.1/§12.3/§12.4): which details (logs, sessions) of a Work are retained, protected or eligible, and the
// explicit cleanup plan of losses. No I/O, storage or clock: callers pass the facts and the instant (milliseconds).

export const defaultRetentionDays = 30;
const dayMs = 86_400_000;
type Work = Pick<
  WorkView,
  | 'work_id'
  | 'result'
  | 'execution'
  | 'previousExecutions'
  | 'impediments'
  | 'cancellation'
  | 'closure'
  | 'delivery'
  | 'cleanup'
  | 'readiness'
  | 'publication'
  | 'pendingRecovery'
  | 'retention'
>;
type Facts = { running: boolean; questions: Pick<QuestionView, 'questionId' | 'state' | 'publication'>[] };
const executionsOf = (work: Pick<Work, 'execution' | 'previousExecutions'>): ExecutionView[] => [
  ...work.previousExecutions,
  ...(work.execution ? [work.execution] : []),
];
const recoveryImpediments = ['RECOVERY_BLOCKED', 'RECOVERY_CESSATION_UNCONFIRMED', 'RECOVERY_START_UNCERTAIN'];

/**
 * Delivered logs/sessions are eligible `days` after the CONFIRMED merge (`confirmedAtMs`, parsed by the caller); undelivered Works never
 * expire (spec §12.3 table). The deadline is anchored to the merge: the end of a later protection never starts another period.
 */
export function retentionDeadline(work: Pick<Work, 'result' | 'delivery'>, confirmedAtMs: number | null, days: number): number | null {
  if (work.result !== 'delivered' || work.delivery?.state !== 'delivered' || !work.delivery.merge || confirmedAtMs === null || !Number.isFinite(confirmedAtMs))
    return null;
  return confirmedAtMs + days * dayMs;
}

/**
 * Reasons the details of a Work are needed NOW, whatever the deadline (spec §12.3 "Evidência necessária a pendência/efeito/cleanup ... protegida
 * enquanto necessária"): an activity or a Slot, unconfirmed cessation, an open or unpublished Question, an unsettled effect, a pending resource
 * cleanup, a pending/blocked recovery of a cycle that can still continue, a cancellation still stopping, or a detail removal whose result is unknown.
 */
export function retentionProtections(work: Work, facts: Facts): string[] {
  const reasons: string[] = [];
  if (facts.running) reasons.push('ACTIVITY_RUNNING');
  for (const execution of executionsOf(work)) {
    if (occupying(execution)) reasons.push(`EXECUTION_OCCUPYING:${execution.executionId}`);
    else if (execution.dispatch.boot !== null && execution.end?.cessation !== 'confirmed') reasons.push(`CESSATION_UNCONFIRMED:${execution.executionId}`);
  }
  for (const question of facts.questions) {
    if (question.state === 'open') reasons.push(`QUESTION_OPEN:${question.questionId}`);
    else if (['intended', 'attempting', 'ambiguous'].includes(question.publication.state))
      reasons.push(`EFFECT_UNSETTLED:question-publication:${question.questionId}`);
  }
  const readinessEffect = work.readiness?.effect;
  if (readinessEffect && (readinessEffect.state === 'intended' || readinessEffect.state === 'attempted'))
    reasons.push(`EFFECT_UNSETTLED:readiness:${readinessEffect.effectId}`);
  const reopen = work.closure?.reopen;
  if (reopen && (reopen.state === 'intended' || reopen.state === 'attempted')) reasons.push(`EFFECT_UNSETTLED:reopen:${reopen.effectId}`);
  if (work.publication?.state === 'requested') reasons.push('EFFECT_UNSETTLED:publication');
  if (work.cancellation?.state === 'stopping') reasons.push('CANCELLATION_STOPPING');
  const continuable = work.result === 'open' || work.result === 'closed-unmerged';
  if (continuable && work.pendingRecovery) reasons.push('RECOVERY_PENDING');
  if (continuable) for (const item of work.impediments) if (recoveryImpediments.includes(item.code)) reasons.push(`IMPEDIMENT:${item.code}`);
  // A resource cleanup still in progress (spec §12.3): waiting, an automatically retried resource, or an explicit plan not swept yet. A resource
  // left refused/kept for an operator decision does NOT protect the details for ever (review LOW): its decision is `factory cleanup`.
  if (work.cleanup) {
    const automatic = work.cleanup.resources.some(item => !concluded(item.state) && retryable(item.state));
    if (work.cleanup.state === 'waiting' || automatic || (work.cleanup.explicit && !work.cleanup.explicit.consumed)) reasons.push('CLEANUP_PENDING');
  }
  if (work.retention?.removals.some(item => item.outcome === 'intended')) reasons.push('DETAIL_REMOVAL_UNSETTLED');
  return [...new Set(reasons)];
}

export type DetailDecision = { item: DetailItem; decision: 'retained' | 'protected' | 'in-use' | 'eligible'; reason: string };

/**
 * One sweep's decision per detail (spec §12.3): undelivered → retained until explicit cleanup (never removed to free space); delivered before
 * `dueAt` → retained; delivered after it → protected while any protection holds, otherwise eligible. A partial capture of an Execution that is
 * not ended with confirmed cessation is in use.
 */
export function classifyDetails(
  work: Work,
  inventory: Pick<DetailInventory, 'items'>,
  input: { protections: string[]; now: number; dueAtMs: number | null },
): DetailDecision[] {
  const dueAt = input.dueAtMs;
  return inventory.items.map(item => {
    if (inUse(work, item)) return { item, decision: 'in-use', reason: 'RESOURCE_IN_USE' };
    if (!ownDetail(work, item)) return { item, decision: 'retained', reason: 'NOT_OWN_EXECUTION' };
    if (work.result !== 'delivered' || dueAt === null) return { item, decision: 'retained', reason: 'UNDELIVERED_RETAINED_UNTIL_EXPLICIT_CLEANUP' };
    if (input.now < dueAt) return { item, decision: 'retained', reason: 'RETENTION_PERIOD_RUNNING' };
    if (input.protections.length) return { item, decision: 'protected', reason: input.protections.join(',') };
    return { item, decision: 'eligible', reason: 'RETENTION_EXPIRED' };
  });
}

/** Ownership of a session copy: named after an Execution of THIS Work (logs carry the Work identity in their own capture metadata). */
export const ownDetail = (work: Pick<Work, 'execution' | 'previousExecutions'>, item: Pick<DetailItem, 'kind' | 'executionId'>) =>
  item.kind !== 'session' || executionsOf(work).some(execution => execution.executionId === item.executionId);
/** Protections an explicit detail removal does not wait for: the resource cleanup never needs logs or session copies. */
const detailIndependent = (reason: string) => reason !== 'CLEANUP_PENDING' && reason !== 'DETAIL_REMOVAL_UNSETTLED';

/** A detail is in use while it may still be written: a partial capture of an Execution not ended with confirmed cessation, or any activity. */
export function inUse(work: Pick<Work, 'execution' | 'previousExecutions'>, item: DetailItem): boolean {
  const executions = executionsOf(work);
  if (executions.some(occupying)) return true;
  if (item.state !== 'partial') return false;
  const execution = executions.find(entry => entry.executionId === item.executionId);
  return !execution || execution.state !== 'ended' || (execution.dispatch.boot !== null && execution.end?.cessation !== 'confirmed');
}

export function retentionState(input: {
  class: RetentionView['class'];
  dueAtMs: number | null;
  now: number;
  protections: string[];
  remaining: number;
  explicit: boolean;
}): RetentionView['state'] {
  if (input.class === 'undelivered' || input.dueAtMs === null || input.now < input.dueAtMs) return input.explicit ? 'explicitly-cleaned' : 'retained';
  if (input.protections.length) return 'protected';
  return input.remaining === 0 ? 'expired' : 'eligible';
}

/** Operator explanation (spec §12.1): removed/expired details are named, never shown as an empty list. */
export function retentionNextStep(view: Pick<RetentionView, 'class' | 'dueAt' | 'protections' | 'state' | 'removed' | 'days'>): string {
  const removed = view.removed.logs + view.removed.sessions;
  const gone = removed
    ? ` Removed so far: ${view.removed.logs} log(s), ${view.removed.sessions} session(s), ${view.removed.bytes} bytes (see removals: they are not missing).`
    : '';
  if (view.class === 'undelivered')
    return 'Not delivered: logs and sessions are kept in full until an explicit `factory cleanup`; no deadline, never removed to free space.' + gone;
  if (view.state === 'retained')
    return (
      `Delivered: logs/sessions are kept until ${view.dueAt} (${view.days} days after the confirmed merge), then removed by the daily/boot sweep if nothing needs them.` +
      gone
    );
  if (view.state === 'protected')
    return (
      `Retention period ended (${view.dueAt}) but the details are still needed (${view.protections.join(', ')}); they become eligible at the first sweep after that ends, with no new period.` +
      gone
    );
  if (view.state === 'eligible') return `Retention period ended (${view.dueAt}); the next sweep removes the remaining logs/sessions.` + gone;
  if (view.state === 'explicitly-cleaned') return 'Details were removed by an explicit operator cleanup before any deadline.' + gone;
  return `Logs/sessions expired: removed by retention after ${view.dueAt}.${gone} Summary, history, references, reviews, decisions and preserved evidence stay until explicit history deletion.`;
}

// ---- Explicit cleanup (spec §12.4) ----

export type PlanFacts = Facts & {
  inventory: DetailInventory | null;
  repositoryConfigured: boolean;
  plannedResources: { id: string; kind: string; target: string }[];
};
const kindOfSelection: Record<'logs' | 'sessions', DetailItem['kind']> = { logs: 'log', sessions: 'session' };

/** The facts a plan depends on; any change between plan and confirmation makes the plan obsolete (revalidated, never trusted). */
export function planBasis(work: Work, facts: Pick<Facts, 'running'>): string {
  return JSON.stringify({
    result: work.result,
    cancellation: work.cancellation?.state ?? null,
    running: facts.running,
    executions: executionsOf(work).map(item => [item.executionId, item.state, item.slot.held, item.end?.cessation ?? null]),
    cleanup: work.cleanup ? [work.cleanup.state, work.cleanup.resources.map(item => [item.id, item.state])] : null,
    delivery: work.delivery?.state ?? null,
  });
}

/**
 * The plan of losses of an explicit cleanup selection, with every refusal explained. Destroying environment or context (logs, sessions) of a
 * Work that can still continue (open, or own PR closed without merge) requires a prior `cancel`; cleanup never cancels implicitly. Anything
 * protected or in use is refused. Preserved evidence, summary, history, reviews and decisions are never selectable (history deletion is `forget`).
 */
export function planExplicitCleanup(
  work: Work,
  select: ExplicitCleanupSelection[],
  facts: PlanFacts,
): Pick<ExplicitCleanupPlan, 'items' | 'refusals' | 'losses' | 'warnings'> {
  const items: ExplicitCleanupItem[] = [];
  const refusals: ExplicitCleanupPlan['refusals'] = [];
  const warnings: string[] = [];
  const losses: string[] = [];
  const protections = retentionProtections(work, facts);
  const selection = [...new Set(select)];
  if (work.result === 'open' || work.result === 'closed-unmerged') {
    for (const target of selection)
      refusals.push({
        target,
        code: 'CANCEL_REQUIRED',
        detail: `The Work can still continue (${work.result}): \`factory cancel <work>\` first; cleanup never cancels implicitly.`,
      });
    return { items, refusals, losses, warnings };
  }
  for (const target of selection) {
    if (target === 'logs' || target === 'sessions') {
      const blocking = protections.filter(detailIndependent);
      if (blocking.length) {
        refusals.push({ target, code: 'PROTECTED', detail: `Still needed: ${blocking.join(', ')}.` });
        continue;
      }
      // Review MED: an incomplete inventory plans NOTHING (the losses shown are exactly what may be removed).
      if (!facts.inventory || facts.inventory.completeness !== 'complete') {
        refusals.push({
          target,
          code: 'INVENTORY_INCOMPLETE',
          detail: "The Records inventory is incomplete: nothing is selected from it (absence is never assumed). Inspect the Work's Records area.",
        });
        continue;
      }
      const kind = kindOfSelection[target];
      const found = facts.inventory.items.filter(item => item.kind === kind);
      if (kind === 'session')
        for (const execution of executionsOf(work)) {
          if (execution.end?.session && !work.retention?.sessions.some(entry => entry.id === `session:${execution.executionId}`))
            refusals.push({
              target: `session:${execution.executionId}`,
              code: 'SESSION_IN_ENVIRONMENT',
              detail:
                'This recorded session still lives in its environment runtime: it is preserved when the environment is cleaned; plan `sessions` again after that.',
            });
        }
      if (!found.length) {
        refusals.push({ target, code: 'NOTHING_TO_REMOVE', detail: `No ${target} of this Work are present in the Records area.` });
        continue;
      }
      for (const item of found) {
        if (inUse(work, item)) {
          refusals.push({ target: item.id, code: 'RESOURCE_IN_USE', detail: 'Its Execution has not ended with confirmed cessation.' });
          continue;
        }
        if (!ownDetail(work, item) || (kind === 'session' && !item.sha256)) {
          refusals.push({
            target: item.id,
            code: 'NOT_OWN_EXECUTION',
            detail: 'This session copy is not named after an Execution of this Work (or has no hash): its ownership cannot be proved, it is kept.',
          });
          continue;
        }
        items.push({
          id: item.id,
          kind,
          target: item.id,
          bytes: item.bytes,
          sha256: item.sha256 ?? null,
          state: 'planned',
          code: null,
          loss:
            kind === 'log'
              ? `Log ${item.id} of Execution ${item.executionId ?? '?'} (${item.bytes} bytes) can no longer be read or paged.`
              : `Session of Execution ${item.executionId ?? '?'} (${item.bytes} bytes) is gone: it can never be continued or inspected again.`,
        });
      }
      if (kind === 'session' && items.some(item => item.kind === 'session')) {
        warnings.push(
          work.result === 'delivered'
            ? 'Removing sessions loses the agent conversation of a delivered Work; delivery and its history stand.'
            : 'Removing sessions of a cancelled cycle: no later command resumes them — `resume` does not recreate a session and `factory new` starts a new cycle with a new session.',
        );
      }
      if (kind === 'log' && items.some(item => item.kind === 'log'))
        warnings.push('Removing logs loses the tool outputs of this Work; summaries, reviews, decisions and preserved evidence are kept.');
      continue;
    }
    if (target === 'environment' || target === 'remote-branch') {
      if (target === 'remote-branch' && work.result !== 'delivered') {
        refusals.push({
          target,
          code: 'REMOTE_BRANCH_NOT_DELIVERED',
          detail: "Cancellation never deletes the branch or touches GitHub; only a delivered Work's own branch is cleaned.",
        });
        continue;
      }
      if (target === 'remote-branch' && !facts.repositoryConfigured) {
        refusals.push({ target, code: 'REPOSITORY_NOT_CONFIGURED', detail: 'No configured repository scope.' });
        continue;
      }
      const blocking = protections.filter(reason => reason !== 'CLEANUP_PENDING' && reason !== 'DETAIL_REMOVAL_UNSETTLED');
      if (blocking.length) {
        refusals.push({ target, code: 'PROTECTED', detail: `Still needed or in use: ${blocking.join(', ')}.` });
        continue;
      }
      if (work.cancellation && work.cancellation.state !== 'ceased' && work.result === 'cancelled') {
        refusals.push({ target, code: 'CANCELLATION_STOPPING', detail: 'Cessation of the cancelled activity is not confirmed yet.' });
        continue;
      }
      const kinds = target === 'environment' ? ['environment', 'checkout', 'local-branch', 'temporaries'] : ['remote-branch'];
      const open =
        work.result === 'delivered'
          ? (work.cleanup?.resources ?? [])
              .filter(item => kinds.includes(item.kind) && !concluded(item.state))
              .map(item => ({ id: item.id, kind: item.kind, target: item.target }))
          : facts.plannedResources.filter(
              item => kinds.includes(item.kind) && !work.cleanup?.resources.some(entry => entry.id === item.id && concluded(entry.state)),
            );
      if (!open.length) {
        refusals.push({ target, code: 'NOTHING_TO_REMOVE', detail: 'Every own resource of this kind is already removed or proven absent.' });
        continue;
      }
      for (const resource of open)
        items.push({
          id: resource.id,
          kind: target,
          target: resource.target,
          bytes: null,
          state: 'planned',
          code: null,
          loss:
            target === 'environment'
              ? `${resource.kind} ${resource.target} is removed after its evidence and recorded sessions are preserved.`
              : `Remote branch ${resource.target} is deleted only while its tip is still the merged own head.`,
        });
      if (target === 'environment')
        warnings.push(
          work.result === 'delivered'
            ? 'One fresh, revalidated attempt per own resource; a refused/kept resource is never forced.'
            : 'The environment of a cancelled cycle is destroyed (evidence and recorded sessions are preserved first); `factory new` never reuses it.',
        );
      continue;
    }
  }
  for (const item of items) losses.push(item.loss);
  return { items, refusals, losses, warnings };
}

/** At confirmation and before each effect: an item still allowed by the CURRENT facts, or the code that drops it (an old plan never removes it). */
export function revalidateItem(work: Work, item: ExplicitCleanupItem, facts: Facts & { inventory?: DetailInventory | null }): string | null {
  if (work.result === 'open' || work.result === 'closed-unmerged') return 'CANCEL_REQUIRED';
  // Neither a detail nor an own resource waits for the resource cleanup itself (review LOW: [logs, environment] executes both when allowed).
  const protections = retentionProtections(work, facts).filter(detailIndependent);
  if (protections.length) return `BECAME_PROTECTED:${protections.join(',')}`;
  if ((item.kind === 'log' || item.kind === 'session') && facts.inventory) {
    const current = facts.inventory.items.find(entry => entry.id === item.id);
    if (current && inUse(work, current)) return 'RESOURCE_IN_USE';
    if (current && item.kind === 'session' && current.sha256 !== item.sha256) return 'SESSION_CHANGED_SINCE_PLAN';
  }
  return null;
}

export const explicitPlanNextStep = (plan: Pick<ExplicitCleanupPlan, 'state' | 'planId' | 'items'>): string =>
  plan.state === 'planned'
    ? plan.items.length
      ? `Review the losses, then \`factory cleanup-confirm <work> ${plan.planId}\`. Nothing was removed; the plan is revalidated when confirmed and again per item.`
      : 'Nothing can be removed with this selection (see refusals). Nothing was removed.'
    : plan.state === 'superseded'
      ? 'Superseded by a newer plan of this Work: it can no longer be confirmed.'
      : plan.state === 'confirmed'
        ? 'Confirmed: each item is revalidated just before its removal; per-item results follow (an intent without result is indeterminate, never retried implicitly).'
        : "Executed: see each item's result. Failed/indeterminate items are not retried implicitly; plan again to decide.";
