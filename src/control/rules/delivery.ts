import type { BranchCleanupResult, CleanupOutcome, CleanupResourceKind, CleanupResourceView, CleanupView, DeliveryView, ExecutionView, MergeFacts,
  OwnPullRequestIdentity, PlannedCleanupResource, PublicationView, PullRequestFacts } from '../types.js';

// Ticket 17 pure rules (spec §12.3): delivery is a confirmed merge of the Work's own pull request; cleanup removes only resources the
// Factory owns and can prove, after merge, confirmed cessation and preserved evidence; results are per resource and never undo delivery.

const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * The own pull request linked by the publication discovery (ticket 14 `publication.pullRequest`, recognized by marker, App bot author,
 * own branch/repository/base) and the heads the Factory itself linked (`linkedHeads` + the linked head). Re-validated at runtime: an absent
 * or incomplete link, or no known own head, is no identity, and then nothing can be delivered.
 */
export function ownPullRequestOf(work: { publication?: PublicationView | null }): OwnPullRequestIdentity | null {
  const publication = work.publication;
  const pull = publication?.pullRequest;
  if (!pull || !positive(pull.pullRequestId) || !text(pull.nodeId, 256) || !positive(pull.number) || !text(pull.url, 2048) || !text(pull.headRef) || !text(pull.base)) return null;
  const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
  const heads = [...new Set([...(publication.linkedHeads ?? []), pull.headSha].filter(sha))];
  if (!heads.length) return null;
  return { pullRequestId: pull.pullRequestId, nodeId: pull.nodeId, number: pull.number, url: pull.url, headRef: pull.headRef, base: pull.base, heads };
}

export type MergeDecision = { outcome: 'merged'; merge: MergeFacts } |
  { outcome: 'open' | 'closed-unmerged' | 'identity-mismatch' | 'merge-unconfirmed'; reasons: string[] };

/**
 * Delivery of THIS cycle: the observed pull request must be the linked own one (id, node, own branch of this repository, base) and
 * GitHub must report it merged with its merge instant and commit. A closure without merge, an open PR, another identity or incomplete
 * merge evidence never deliver. Ticket/issue state and agent messages are not inputs at all.
 */
export function decideMerge(own: OwnPullRequestIdentity, expect: { repositoryId: number; branch: string | null; base: string }, facts: PullRequestFacts): MergeDecision {
  const reasons: string[] = [];
  if (facts.pullRequestId !== own.pullRequestId || facts.number !== own.number) reasons.push('PULL_REQUEST_ID_MISMATCH');
  if (facts.nodeId !== own.nodeId) reasons.push('PULL_REQUEST_NODE_MISMATCH');
  // The Work's own branch is Control's record, never derived from the linked PR itself (no self-comparison).
  if (!expect.branch) reasons.push('OWN_BRANCH_UNKNOWN');
  else if (facts.headRef !== expect.branch || own.headRef !== expect.branch) reasons.push('HEAD_BRANCH_MISMATCH');
  if (facts.headRepositoryId !== expect.repositoryId) reasons.push('HEAD_REPOSITORY_MISMATCH');
  if (facts.baseRef !== expect.base || own.base !== expect.base || facts.baseRepositoryId !== expect.repositoryId) reasons.push('BASE_MISMATCH');
  if (reasons.length) return { outcome: 'identity-mismatch', reasons };
  if (facts.state === 'open' && !facts.merged) return { outcome: 'open', reasons: [] };
  if (!facts.merged) return { outcome: 'closed-unmerged', reasons: ['CLOSED_WITHOUT_MERGE'] };
  if (facts.state !== 'closed' || !facts.mergedAt) return { outcome: 'merge-unconfirmed', reasons: ['MERGE_EVIDENCE_INCOMPLETE'] };
  // A merged head the Factory never published (e.g. a third-party push) is not the own content of this cycle.
  if (!own.heads.includes(facts.headSha)) return { outcome: 'identity-mismatch', reasons: ['HEAD_NOT_OWN_CONTENT'] };
  return { outcome: 'merged', merge: { mergedAt: facts.mergedAt, mergeCommitSha: facts.mergeCommitSha, headSha: facts.headSha, pullRequestId: facts.pullRequestId,
    number: facts.number, url: facts.url } };
}

type CleanupWork = { result: string; branch: string | null; repository: { repository: string; repositoryId: number; base: string };
  delivery?: Pick<DeliveryView, 'state'> & { merge: Pick<MergeFacts, 'headSha'> | null } | null; execution: ExecutionView | null; previousExecutions: ExecutionView[] };
const executionsOf = (work: Pick<CleanupWork, 'execution' | 'previousExecutions'>) => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];

/**
 * Automatic cleanup starts only after the confirmed merge AND confirmed cessation of every Execution of the Work (no activity running in
 * this owner, no Slot held, every booted Execution ended with confirmed cessation). Evidence preservation is checked per environment.
 */
export function cleanupEligibility(work: CleanupWork, running: boolean): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (work.result !== 'delivered' || work.delivery?.state !== 'delivered' || !work.delivery.merge) reasons.push('NOT_DELIVERED');
  if (running) reasons.push('ACTIVITY_RUNNING');
  for (const execution of executionsOf(work)) {
    if (execution.slot.held) reasons.push(`SLOT_HELD:${execution.executionId}`);
    if (execution.state === 'reserved' || execution.state === 'started') reasons.push(`ACTIVITY_NOT_ENDED:${execution.executionId}`);
    else if (execution.dispatch.boot !== null && execution.end?.cessation !== 'confirmed') reasons.push(`CESSATION_UNCONFIRMED:${execution.executionId}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

const environmentRef = /^env-[a-f0-9]{64}$/;
/** Environments the Work's own Executions recorded (Sandbox re-proves ownership by its owner record before deleting anything). */
export const ownEnvironments = (work: Pick<CleanupWork, 'execution' | 'previousExecutions'>) =>
  [...new Set(executionsOf(work).map(execution => execution.dispatch.environment).filter((ref): ref is string => typeof ref === 'string' && environmentRef.test(ref)))];

/**
 * Concrete plan of the Work's OWN resources: per own environment its disk, the Work checkout (worktree) and the local branch in it, the
 * temporaries (artifacts copy area and per-boot runtime directories); and the Work's remote branch. Protected, never targets: the base,
 * the Factory's shared bare cache, other Works/unknown resources, any Docker (host or guest daemon) and the retained history/records.
 */
export function planCleanup(work: CleanupWork, input: { repositoryConfigured: boolean }): { resources: PlannedCleanupResource[]; protected: { target: string; reason: string }[] } {
  const resources: PlannedCleanupResource[] = [];
  const branch = work.branch;
  for (const environment of ownEnvironments(work)) {
    const ownership = `Sandbox owner record of ${environment} names this Work (re-verified before removal)`;
    resources.push({ id: `environment:${environment}`, kind: 'environment', target: `${environment}/root.qcow2`, environment, ownership },
      { id: `checkout:${environment}`, kind: 'checkout', target: `${environment}/workspace/checkout`, environment, ownership },
      { id: `local-branch:${environment}`, kind: 'local-branch', target: `${environment}/workspace/checkout:refs/heads/${branch ?? '?'}`, environment, ownership },
      { id: `temporaries:${environment}`, kind: 'temporaries', target: `${environment}/artifacts + boot runtime directories`, environment, ownership });
  }
  if (branch && branch !== work.repository.base && input.repositoryConfigured) resources.push({ id: `remote-branch:${branch}`, kind: 'remote-branch',
    target: `${work.repository.repository}:refs/heads/${branch}`, environment: null,
    ownership: `The Work's own branch; deleted only while its tip is exactly the merged own pull request head ${work.delivery?.merge?.headSha ?? '?'}` });
  return { resources, protected: [
    { target: `${work.repository.repository}:refs/heads/${work.repository.base}`, reason: 'BASE_BRANCH' },
    { target: `cache/git/${work.repository.repositoryId}.git`, reason: 'SHARED_FACTORY_CACHE' },
    { target: 'environments, branches and pull requests of other Works or unknown origin', reason: 'NOT_OWNED' },
    { target: 'Docker images/containers/volumes (host and guest daemons)', reason: 'NO_GLOBAL_DOCKER_CLEANUP' },
    { target: 'controller history, records (sessions/logs/evidence), reviews and decisions', reason: 'RETAINED_HISTORY' },
  ] };
}

export const concluded = (state: CleanupResourceView['state']) => state === 'removed' || state === 'absent';
/** Re-planning keeps every recorded result/attempt and adds only newly planned own resources (an obsolete plan never deletes more). */
export function mergePlan(existing: CleanupResourceView[], planned: PlannedCleanupResource[]): CleanupResourceView[] {
  const known = new Map(existing.map(item => [item.id, item]));
  return [...existing, ...planned.filter(item => !known.has(item.id)).map(item => ({ ...item, state: 'pending' as const, attempts: [] }))];
}
/** An intent whose result was never recorded (crash/loss) is indeterminate: it is revalidated, never assumed done. */
export function recoverLostIntents(resources: CleanupResourceView[], at: string): CleanupResourceView[] {
  return resources.map(item => {
    const last = item.attempts.at(-1);
    if (!last || last.outcome !== 'intended') return item;
    return { ...item, state: 'indeterminate', attempts: [...item.attempts.slice(0, -1), { ...last, resultAt: at, outcome: 'indeterminate', code: 'RESULT_NOT_RECORDED' }] };
  });
}
/** Retried automatically after revalidation. `refused`/`kept` wait for an explicit operator decision (no fresh write grant for them). */
export const retryable = (state: CleanupResourceView['state']) => state === 'pending' || state === 'failed' || state === 'partial' || state === 'indeterminate';
export const selectPending = (resources: CleanupResourceView[]) => resources.filter(item => retryable(item.state));
export function cleanupState(input: { eligible: boolean; resources: CleanupResourceView[] }): CleanupView['state'] {
  if (input.resources.length && input.resources.every(item => concluded(item.state))) return 'complete';
  return input.eligible ? 'pending' : 'waiting';
}

type Removal = { status: 'success'; resources: { resource: string; status: string }[] } | { status: string; code: string; resources: { resource: string; status: string }[] };
const fromSandbox = (status: string | undefined): CleanupOutcome | undefined =>
  status === 'removed' || status === 'absent' || status === 'refused' || status === 'failed' ? status : undefined;
/** Per-resource outcome of ONE Sandbox removal of an own environment (disk, workspace with checkout/local branch, artifacts + runtime). */
export function environmentOutcomes(result: Removal): Record<Exclude<CleanupResourceKind, 'remote-branch'>, { outcome: CleanupOutcome; code: string | null }> {
  const code = 'code' in result ? result.code : null;
  const whole: CleanupOutcome | undefined = result.status === 'indeterminate' ? 'indeterminate'
    : result.status === 'failure' ? (code === 'CLEANUP_WORK_MISMATCH' ? 'refused' : 'failed') : undefined;
  const of = (...names: string[]) => {
    if (whole) return { outcome: whole, code };
    const states = names.map(name => fromSandbox(result.resources.find(item => item.resource === name)?.status));
    const outcome: CleanupOutcome = states.some(item => item === undefined) ? 'indeterminate' : states.includes('failed') ? 'failed' : states.includes('refused') ? 'refused'
      : states.every(item => item === 'absent') ? 'absent' : 'removed';
    return { outcome, code: outcome === 'removed' || outcome === 'absent' ? null : code ?? 'ENVIRONMENT_REMOVAL_INCOMPLETE' };
  };
  return { environment: of('disk'), checkout: of('workspace'), 'local-branch': of('workspace'), temporaries: of('artifacts', 'runtime') };
}
export const branchOutcome = (result: BranchCleanupResult): { outcome: CleanupOutcome; code: string | null } => ({ outcome: result.outcome, code: result.code });

/** Separate, operator-facing explanations (spec §12.1): delivery never depends on cleanup. */
export function deliveryNextStep(state: DeliveryView['state'], last: string | null): string {
  if (state === 'delivered') return 'Delivered: a human merged the own pull request and the Factory confirmed it. No new agent action follows; cleanup is reported separately.';
  if (last === 'closed-unmerged') return 'The own pull request was closed WITHOUT merge: the Work is not delivered (no automatic reopening, replacement or resumption).';
  if (last === 'identity-mismatch') return 'The observed pull request is not the linked own pull request of this cycle: nothing is delivered. Operator must inspect it on GitHub.';
  if (last === 'unavailable') return 'The own pull request could not be read: nothing is concluded; it is read again on a later cycle.';
  return 'Waiting for a human to merge the own pull request; the Factory never merges it. Ticket or pull request closure alone is not delivery.';
}
export function cleanupNextStep(view: Pick<CleanupView, 'state' | 'eligibility' | 'resources'>): string {
  if (view.state === 'complete') return 'Cleanup complete: every own resource is removed or proven absent. History, reviews, decisions and protected records are kept.';
  if (view.state === 'waiting') return `Cleanup waits (${view.eligibility.reasons.join(', ')}). Delivery is not affected.`;
  const open = view.resources.filter(item => !concluded(item.state));
  const automatic = open.filter(item => retryable(item.state));
  const operator = open.filter(item => !retryable(item.state));
  return `Cleanup pending for ${open.length} own resource(s) (${open.map(item => `${item.kind}:${item.state}`).join(', ')}). Delivery stands.` +
    (automatic.length ? ` ${automatic.length} retried automatically after revalidation (next controller boot or daily sweep).` : '') +
    (operator.length ? ` ${operator.length} refused/kept: never retried automatically; an operator decides (e.g. kept: atomic delete unavailable).` : '');
}
