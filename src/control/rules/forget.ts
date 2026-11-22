import type { ForgetPlan, ForgetTree, ForgottenWork, QuestionView, WorkView } from '../types.js';
import { concluded, ownPullRequestOf, planCleanup } from './delivery.js';
import { retentionProtections } from './retention.js';
import { ticketLabel } from './admission.js';

// Ticket 31 pure rules (spec §12.4 `forget`, §4.2, §12.1): which ended Work may have its history deleted, the plan of losses, and the minimal
// cycle memory kept instead. No I/O, storage or clock: callers pass the facts and the instant.

type Work = Omit<WorkView, 'dispatch' | 'limits'>;
export type ForgetFacts = { running: boolean; questions: Pick<QuestionView, 'questionId' | 'state' | 'publication'>[];
  /** The Work's whole Records area as inspected just before (null: no Records port composed). */ tree: ForgetTree | null; repositoryConfigured: boolean };
export type ForgetRefusal = { code: string; detail: string };
const executionsOf = (work: Pick<Work, 'execution' | 'previousExecutions'>) => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];

/**
 * Every reason this Work's history cannot be deleted now (empty = eligible). `forget` needs an ENDED Work (delivered with its confirmed merge, or
 * cancelled with confirmed cessation; an own PR closed without merge needs `cancel` first, never implicit) with no activity, open Question,
 * unsettled effect, pending recovery or cleanup, own resource left, or unsafe Records entry. It never changes anything to become eligible.
 */
export function forgetRefusals(work: Work, facts: ForgetFacts): ForgetRefusal[] {
  const refusals: ForgetRefusal[] = [];
  const refuse = (code: string, detail: string) => refusals.push({ code, detail });
  if (work.result === 'open') refuse('WORK_NOT_ENDED', 'The cycle is still open: only a delivered or cancelled Work can be forgotten (`factory cancel <work>` first; forget never cancels).');
  if (work.result === 'closed-unmerged') refuse('CANCEL_REQUIRED', 'The own pull request was closed without merge and the cycle can still continue (`reopen` + `resume`): `factory cancel <work>` first; forget never cancels implicitly.');
  if (work.result === 'delivered' && (work.delivery?.state !== 'delivered' || !work.delivery.merge)) refuse('DELIVERY_NOT_CONFIRMED', 'The delivery has no confirmed merge recorded.');
  if (work.result === 'cancelled') {
    if (work.cancellation?.state !== 'ceased') refuse('CANCELLATION_STOPPING', 'The cancellation has not confirmed the cessation of the cycle\'s activity yet.');
    // Spec §12.3: a confirmed merge still delivers a cancelled cycle; its own PR must be observed closed before the cycle is reduced to memory.
    if (ownPullRequestOf(work) && work.delivery?.observations.at(-1)?.outcome !== 'closed-unmerged') refuse('PULL_REQUEST_NOT_CLOSED',
      'The cancelled cycle\'s own pull request is not observed closed: a later human merge would still deliver it. Close it on GitHub; the Factory observes it, then plan again.');
  }
  const protections = retentionProtections(work, facts);
  if (protections.length) refuse('PROTECTED', `Still needed: ${protections.join(', ')}.`);
  if (work.pendingRecovery && !protections.includes('RECOVERY_PENDING')) refuse('RECOVERY_PENDING', 'An operational recovery is still pending for this Work.');
  const pending = pendingResources(work, facts.repositoryConfigured);
  if (pending.length) refuse('RESOURCES_PENDING', `Own resources are not removed or proven absent: ${pending.slice(0, 8).join(', ')}. ` +
    `Clean them first (\`factory cleanup <work> --select ${[...new Set(pending.map(id => id.startsWith('remote-branch:') ? 'remote-branch' : 'environment'))].join(',')}\`); forget never removes a resource.`);
  const unsettledPlans = (work.retention?.plans ?? []).filter(plan => plan.state === 'confirmed' && plan.items.some(item => item.state === 'planned' || item.state === 'intended'));
  if (unsettledPlans.length) refuse('CLEANUP_PLAN_PENDING', `A confirmed explicit cleanup is still executing (${unsettledPlans.map(plan => plan.planId).join(', ')}).`);
  // Review LOW: a detail removal of ticket 30 whose result is unknown (intended or indeterminate) is settled first: never deleted underneath it.
  const unsettled = (work.retention?.removals ?? []).filter(item => item.outcome === 'intended' || item.outcome === 'indeterminate');
  if (unsettled.length && !protections.includes('DETAIL_REMOVAL_UNSETTLED')) refuse('DETAIL_REMOVAL_UNSETTLED', `${unsettled.length} log/session removal(s) have an unknown result ` +
    `(${unsettled.slice(0, 4).map(item => item.id).join(', ')}): the next sweep settles an absent one; otherwise decide with \`factory cleanup <work> --select logs,sessions\`.`);
  // Only a deletion under way blocks; a confirmed plan not started yet is superseded by a newer eligible plan (never stuck, review LOW).
  if ((work.forget?.plans ?? []).some(plan => plan.state === 'removing')) refuse('FORGET_IN_PROGRESS', 'A forget of this Work is deleting its Records area now.');
  if (!facts.tree) refuse('RECORDS_NOT_COMPOSED', 'No Records area port is composed: the history cannot be deleted (nothing is assumed absent).');
  else if (facts.tree.completeness !== 'complete') refuse('RECORDS_TREE_UNSAFE', `The Records area holds entries that are never followed or removed (${facts.tree.unsafe.slice(0, 5).join(', ') || 'unreadable'}); inspect it as the administrator.`);
  return refusals;
}

/** Own resources of the Work that are not concluded (removed/absent): planned now, or recorded by its cleanup. */
export function pendingResources(work: Work, repositoryConfigured: boolean): string[] {
  const recorded = new Map((work.cleanup?.resources ?? []).map(item => [item.id, item.state]));
  const planned = planCleanup(work, { repositoryConfigured }).resources.map(item => item.id);
  return [...new Set([...planned, ...recorded.keys()])].filter(id => { const state = recorded.get(id); return !state || !concluded(state); });
}

/** The facts the plan was computed from; a change makes it obsolete (a confirmation never deletes more than the plan showed). */
export function forgetBasis(work: Work, facts: ForgetFacts): string {
  return JSON.stringify({ result: work.result, cancellation: work.cancellation?.state ?? null, delivery: work.delivery?.state ?? null, running: facts.running,
    executions: executionsOf(work).map(item => [item.executionId, item.state, item.end?.cessation ?? null]), questions: facts.questions.map(item => [item.questionId, item.state]),
    cleanup: work.cleanup ? work.cleanup.resources.map(item => [item.id, item.state]) : null,
    tree: facts.tree ? [facts.tree.completeness, facts.tree.present, facts.tree.leftover, facts.tree.files, facts.tree.bytes] : null });
}

/** The minimal cycle memory kept by `forget` (spec §12.4): identities, order/link, result, PR identity and confirmed merge of a delivery. */
export function minimalMemoryOf(work: Work, input: { at: string; request_id: string; planId: string }): ForgottenWork {
  const delivered = work.result === 'delivered' && work.delivery?.state === 'delivered' && Boolean(work.delivery.merge);
  const pull = delivered ? work.delivery!.pullRequest : null;
  const own = ownPullRequestOf(work);
  return { work_id: work.work_id, ticket: { ...work.ticket }, repository: { ...work.repository }, cycle: work.cycle, predecessor: work.predecessor, sequence: work.queue.sequence,
    result: work.result === 'delivered' ? 'delivered' : 'cancelled',
    pullRequest: pull ? { number: pull.number, pullRequestId: pull.pullRequestId, nodeId: pull.nodeId, url: pull.url } : null,
    mergeConfirmed: delivered, mergeConfirmedAt: delivered ? work.delivery!.merge!.confirmedAt : null,
    // A Jira entry label has no GitHub id: the memory keeps none (a new cycle of a Jira Ticket is re-authorized by its own re-read).
    label: work.authorization?.source !== 'jira-rest' && work.authorization?.basis?.label ? { id: work.authorization.basis.label.id, name: work.authorization.basis.label.name } : null,
    questions: [...(work.questions ?? [])],
    watch: !delivered && own ? { pullRequest: { ...own, heads: [...own.heads] }, branch: work.branch, state: 'watching', lastReadAt: null,
      lastOutcome: work.delivery?.observations.at(-1)?.outcome ?? null } : null,
    forgottenAt: input.at, request_id: input.request_id, planId: input.planId };
}

/** The plan of losses: what becomes unrecoverable, what stays (minimal memory) and what `forget` never reaches. */
export function forgetLosses(work: Work, facts: ForgetFacts): Pick<ForgetPlan, 'losses' | 'keeps' | 'warnings' | 'records'> {
  const tree = facts.tree;
  const memory = minimalMemoryOf(work, { at: '', request_id: '', planId: '' });
  const losses = [
    tree && (tree.present || tree.leftover) ? `The Work's whole Records area (${tree.files} file(s), ${tree.bytes} bytes): logs, start receipts, review opinions and their forwards, ` +
      'mutation intents/results, Question records, Host evidence, session copies and preserved evidence. None of it can be read, paged or recovered afterwards.'
      : 'The Work has no Records area left (nothing on disk to delete); only its controller record goes.',
    `The Work record: history (${work.history.length} event(s)), ${executionsOf(work).length} Execution(s) with their summaries, reviews, gates, decisions, scope updates, ` +
      'budget counters, delivery/cleanup/retention records and references.',
    `${work.questions.length} Question(s) with their texts and answers; the text or reason of this Work's answer/update-scope/authorize-readiness requests is erased from their receipts (a replay of those request ids is then refused, never re-applied).`,
    'This Work stops counting in installation totals and aggregates (status says how many Works are forgotten).',
  ];
  const keeps = [
    `Minimal memory: Ticket ${ticketLabel(work.ticket)} (issue ${work.ticket.issueId}), Work ${work.work_id}, cycle ${work.cycle}` +
      `${work.predecessor ? ` after ${work.predecessor}` : ''}, result ${memory.result}${memory.pullRequest ? `, pull request #${memory.pullRequest.number} with its merge confirmed at ${memory.mergeConfirmedAt}` : ''}.`,
    'The Ticket stays indexed: label, polling and restarts never admit it again; only an explicit `factory new <owner/repo#number>` starts another cycle, which becomes the evaluated one.',
    memory.result === 'delivered' ? 'As a native blocker it stays an OWN Ticket satisfied by this delivered cycle (until a new cycle exists); never re-evaluated as external.'
      : 'As a native blocker it stays an OWN Ticket NOT satisfied by this cancelled cycle; never re-evaluated as external.',
    ...(memory.watch ? [`The own pull request #${memory.watch.pullRequest.number} of this cancelled cycle stays watched from the memory: a later confirmed human merge still delivers it (spec §12.3).`] : []),
  ];
  const warnings = ['Not erased: GitHub (issue, comments, pull request, branch), copies outside the Records area (backups, exports, earlier copies of the storage, terminal output). After the forget the controller storage is scrubbed (VACUUM, then the WAL is truncated) so the deleted controller records do not stay in SQLite free pages or the WAL; `show <work>` says whether that scrub completed (`memory.scrub`). An external copy can bring deleted data back.'];
  return { losses, keeps, warnings, records: tree ? { files: tree.files, bytes: tree.bytes, present: tree.present, leftover: tree.leftover } : null };
}

export const forgetPlanNextStep = (plan: Pick<ForgetPlan, 'state' | 'planId' | 'refusals' | 'code'>): string => {
  switch (plan.state) {
    case 'planned': return `Review the losses, then \`factory forget-confirm <work> ${plan.planId}\`. Nothing was deleted; the plan is revalidated when confirmed and again just before the deletion.`;
    case 'refused': return `Not eligible (${plan.refusals.map(item => item.code).join(', ')}); nothing was deleted and nothing was changed to make it eligible.`;
    case 'superseded': return 'Superseded by a newer plan of this Work: it can no longer be confirmed.';
    case 'confirmed': return 'Confirmed: the retention desk (with the Records port composed) revalidates it again just before the deletion (intent recorded before it); then only the minimal memory remains. Until it starts, a newer eligible `factory forget` plan supersedes it.';
    case 'dropped': return `Dropped at revalidation (${plan.code}): nothing was deleted. Plan again if still wanted.`;
    case 'removing': return 'Deleting the Records area (intent recorded); the result follows.';
    case 'failed': return `The deletion did not complete (${plan.code}); the Work and what is left of its Records stay. Nothing is retried implicitly: inspect, then plan again.`;
    case 'indeterminate': return `The result of the deletion was not recorded (${plan.code}); the Work stays. Nothing is retried implicitly: \`factory forget <work>\` plans again from what is left.`;
    case 'forgotten': return 'Forgotten: only the minimal cycle memory remains.';
  }
};

export const forgottenNotRecoverable = ['history', 'logs', 'sessions', 'reviews and opinions', 'decisions and gates', 'Questions and answers', 'request content', 'preserved evidence', 'budget/usage of this Work'];
export const forgottenNextStep = (memory: ForgottenWork) => `History deleted by \`forget\` at ${memory.forgottenAt} (request ${memory.request_id}). This is not an expired or missing ` +
  'record: only the minimal cycle memory remains, and nothing else of this Work can be shown or recovered. ' +
  `The Ticket stays known (never re-admitted automatically); \`factory new ${ticketLabel(memory.ticket)}\` starts another cycle when wanted.` +
  (memory.scrub?.state === 'scrubbed' ? ` Controller storage scrubbed at ${memory.scrub.scrubbedAt}.`
    : ` Controller storage scrub PENDING${memory.scrub?.code ? ` (last attempt ${memory.scrub.lastAttemptAt}: ${memory.scrub.code})` : ''}: until it completes, the deleted controller records may remain in SQLite free pages/WAL; the running owner re-attempts it.`);
