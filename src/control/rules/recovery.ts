// Pure recovery rules (ticket 26, spec §4.4/§5.2/§5.3/§5.4/§11.4). No I/O, clock or randomness: callers supply every fact.
import { blockedReferenceToken, blockedStartCodePattern, type StartRetryRemedy } from '../../contracts/index.js';
import type { Impediment } from '../types.js';

/** Persisted waits of the operational recoveries of one Work (spec §4.4): 5/15/45 s, the last one repeated for explicitly granted extra units. */
export const recoveryWaitsSeconds = [5, 15, 45] as const;

/**
 * Wait before the next operational recovery may start. `attempt` is the number of recoveries already consumed by the Work (never reset);
 * a larger wait indicated by the service prevails. Invalid service hints are ignored (never shorten the default).
 */
export function recoveryWait(input: { attempt: number; serviceSeconds?: number | null }): number {
  const index = Math.min(Math.max(0, Math.floor(input.attempt)), recoveryWaitsSeconds.length - 1);
  const base = recoveryWaitsSeconds[index]!;
  const service = input.serviceSeconds;
  return typeof service === 'number' && Number.isFinite(service) && service > base ? Math.ceil(service) : base;
}

export type RecoveryDecision = { kind: 'new' | 'fill'; waitSeconds: number; attempt: number; notBeforeMs: number } | { kind: 'keep' };
/**
 * One operational recovery request (spec §4.4), on calendar milliseconds supplied by the caller. The wait derives from the recoveries already
 * consumed (never reset by events/restarts). A pending request is kept as is — a repeated event neither brings its deadline forward nor opens
 * a second unit — except that a request recorded before ticket 26 (no deadline) is given one from its own request instant (`fill`).
 */
export function recoveryRequest(input: { pending: { notBeforeMs: number | null; requestedAtMs: number } | null; consumed: number; requestedAtMs: number;
  serviceSeconds?: number | null }): RecoveryDecision {
  const waitSeconds = recoveryWait({ attempt: input.consumed, serviceSeconds: input.serviceSeconds ?? null });
  if (input.pending && input.pending.notBeforeMs !== null) return { kind: 'keep' };
  const since = input.pending && Number.isFinite(input.pending.requestedAtMs) ? input.pending.requestedAtMs : input.requestedAtMs;
  return { kind: input.pending ? 'fill' : 'new', waitSeconds, attempt: input.consumed, notBeforeMs: since + waitSeconds * 1000 };
}

/** The persisted wait still runs (an unreadable deadline counts as running): no start yet, whatever events, restarts or polling say. */
export function recoveryBackoff(notBeforeMs: number | null, nowMs: number): boolean {
  if (notBeforeMs === null) return false;
  return !Number.isFinite(notBeforeMs) || notBeforeMs > nowMs;
}

// Transient model/transport/worker/channel failures (spec §4.4: "Recuperação transitória de modelo/transporte/worker"). Every other code —
// authorization, configuration, drift, integrity of records, preparation/boot failures, cancellation — blocks with a required action.
/**
 * v2 ticket 10 (V2-15): the end of an Execution whose environment the sandbox confirmed ended on its own. V2-10: the loss ends the
 * Execution and the substitute comes back through the queue consuming one operational recovery, so the code is transient.
 */
export const environmentEndedCode = 'SANDBOX_ENVIRONMENT_ENDED';
const transient = new Set([environmentEndedCode, 'WORKER_EXECUTION_UNCERTAIN', 'WORKER_CHANNEL_CLOSED', 'WORKER_START_UNCERTAIN', 'WORKER_LAUNCH_UNCERTAIN', 'WORKER_PROVIDER_UNAVAILABLE',
  'WORKER_MODEL_UNAVAILABLE', 'WORKER_INTERRUPTED', 'TOOL_CHANNEL_CLOSED', 'CONTROLLER_CRASH', 'REVIEWER_CESSATION_UNCONFIRMED', 'REVIEW_DELIVERY_UNCERTAIN',
  'REVIEW_DELIVERY_FAILED', 'OWNER_STOPPED_BEFORE_ACTIVATION_CESSATION_UNCONFIRMED', 'ACTIVATION_REFUSED_CESSATION_UNCONFIRMED', 'ADMINISTRATIVE_STOP_CESSATION_UNCONFIRMED',
  'ADMINISTRATIVE_STOP_FORCED', 'RECOVERY_CESSATION_UNCONFIRMED',
  // Ticket 48: a Builder budget end WITHOUT Host-observed progress is an operational recovery as before (with progress: a continuation).
  'WORKER_BUDGET_EXHAUSTED',
  // Ticket 59: the owner could not deliver a secret-sync ACK in time or at all (transport, like a lost channel). Every other refused sync
  // (`WORKER_SECRET_SYNC_LIMIT`, replay, schema...) is a Host protocol/limit fact and blocks.
  'WORKER_SECRET_SYNC_TIMEOUT', 'WORKER_SECRET_SYNC_SEND']);
// Phase prefixes of the dispatch holds (`${phase}_${code}`) that may wrap a transient worker failure.
const phases = ['ACTIVATE_', 'STARTED_', 'REVIEW_', 'COMPLETED_', 'STOP_'];

/**
 * Ticket 50: host capacity refusals raised BEFORE any boot/preparation effect (free memory or storage below what this guest needs NOW). They
 * pass when another guest ends or space is freed, so they are transient: the Work keeps its queue position behind a persisted capacity wait,
 * and nothing is charged because nothing started.
 */
export const bootCapacityCodes = ['START_INSUFFICIENT_MEMORY_FOR_BOOT', 'START_INSUFFICIENT_STORAGE_FOR_BOOT', 'PREPARE_INSUFFICIENT_STORAGE_FOR_PREPARATION'] as const;
export const isBootCapacityRefusal = (code: string | null | undefined) => (bootCapacityCodes as readonly string[]).includes(code ?? '');
/** Persisted capacity waits (ticket 50): 15 s, 60 s, then 300 s repeated while the host stays short (a refusal costs no budget). */
export const bootCapacityWaitsSeconds = [15, 60, 300] as const;
export function bootCapacityWait(attempt: number): number {
  return bootCapacityWaitsSeconds[Math.min(Math.max(0, Math.floor(attempt)), bootCapacityWaitsSeconds.length - 1)]!;
}

// Ticket 50: Sandbox.prepare refusals that complete before any native effect still runs (checks, or a refusal returned after the awaited
// work ended): the controller itself observed the end of the call, so its cessation is confirmed without a restart. Anything else (e.g. an
// incomplete or indeterminate preparation) keeps the Slot until the host evidence of the boot reconciliation.
const preparationRefusals = new Set(['ENVIRONMENT_CONFIGURATION_MISMATCH', 'ARTIFACT_SEED_VERSION_CONFLICT', 'ARTIFACT_SEED_SOURCE_DRIFT', 'ARTIFACT_SEED_INVALID',
  'ARTIFACT_SEED_PATH_UNSAFE', 'INSUFFICIENT_STORAGE_FOR_PREPARATION', 'GUEST_ASSETS_INVALID', 'ENVIRONMENT_CLEANUP_PENDING', 'SANDBOX_CONFIGURATION_INVALID',
  'CHECKOUT_NOT_COMPOSED',
  // Ticket 44: environment base refusals returned after the preparation VM's cessation was confirmed (or before any native effect).
  'ENVIRONMENT_BASE_PREPARATION_FAILED', 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE', 'ENVIRONMENT_PREPARATION_VM_NOT_COMPOSED', 'ENVIRONMENT_DECLARATION_INVALID',
  'ENVIRONMENT_NOT_PINNED']);
/** Ticket 44: refusals whose operator retry also retries the environment base preparation (the failed attempt is set aside, never deleted). */
export const environmentBaseRetryCodes = ['PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED', 'PREPARE_ENVIRONMENT_BASE_PREPARATION_INCOMPLETE'] as const;
export const retriesEnvironmentBase = (code: string) => (environmentBaseRetryCodes as readonly string[]).includes(code);
/**
 * Ticket 50: whether a returned Sandbox refusal proves that nothing of this Execution's preparation/boot still runs. A `start` failure is the
 * Sandbox's definitive refusal (no boot launched, or a boot whose cessation it confirmed); an `indeterminate` result never is.
 */
export function refusedWithoutActivity(input: { phase: 'prepare' | 'start'; status: 'failure' | 'indeterminate'; code: string }): boolean {
  if (input.status !== 'failure') return false;
  return input.phase === 'start' || preparationRefusals.has(input.code);
}
/** Ticket 50: a boot/preparation refusal (`PREPARE_*`/`START_*`) that blocks and can only be retried by an explicit operator decision. */
export const blockingStartRefusal = (code: string | null | undefined): code is string =>
  typeof code === 'string' && blockedStartCodePattern.test(code) && !isBootCapacityRefusal(code);

/** Whether an interrupted Execution may come back through the queue as an operational recovery (counter + persisted wait) or must block. */
export function classifyInterruption(code: string | null): { kind: 'recoverable' } | { kind: 'blocking'; code: string } {
  const value = code ?? 'CONTROLLER_CRASH';
  if (transient.has(value) || isBootCapacityRefusal(value)) return { kind: 'recoverable' };
  const prefix = phases.find(item => value.startsWith(item));
  if (prefix && transient.has(value.slice(prefix.length))) return { kind: 'recoverable' };
  return { kind: 'blocking', code: value };
}

/** What reconciliation established about the start of an interrupted Execution (spec §5.3). */
export type StartEvidence = { kind: 'confirmed'; receiptId: string; source: 'notification' | 'receipt-discovered' } |
  { kind: 'not-started'; basis: 'no-activation-request' | 'receipt-absent-after-cessation' } |
  { kind: 'uncertain'; code: string };

/**
 * Start decision of an Execution whose activity ceased (spec §5.3): a complete synchronized receipt confirms the start (and its single
 * consumption) even without notification; absence proves non-start only with an intact listing, no earlier activation request or a confirmed
 * cessation; anything else keeps the reservation.
 */
export function startDecision(input: { confirmed: { receiptId: string } | null; phase: string; cessation: 'confirmed' | 'unconfirmed';
  observation: { kind: 'receipt'; receiptId: string } | { kind: 'absent' } | { kind: 'uncertain'; code: string } | null }): StartEvidence {
  if (input.confirmed) return { kind: 'confirmed', receiptId: input.confirmed.receiptId, source: 'notification' };
  // The activation request is committed (`activation-requested`) BEFORE Workers.activate: earlier phases never reached a worker.
  if (['reserved', 'prepared', 'booted'].includes(input.phase)) return { kind: 'not-started', basis: 'no-activation-request' };
  if (input.cessation !== 'confirmed') return { kind: 'uncertain', code: 'RECOVERY_CESSATION_UNCONFIRMED' };
  if (!input.observation) return { kind: 'uncertain', code: 'START_RECEIPT_OBSERVATION_NOT_COMPOSED' };
  if (input.observation.kind === 'receipt') return { kind: 'confirmed', receiptId: input.observation.receiptId, source: 'receipt-discovered' };
  if (input.observation.kind === 'absent') return { kind: 'not-started', basis: 'receipt-absent-after-cessation' };
  return { kind: 'uncertain', code: input.observation.code };
}

/** Global dispatch gate after the boot inventory (spec §5.2): unknown resources or authority keep dispatch closed; local uncertainty does not. */
export function dispatchGate(input: { executionComposed: boolean; inventory: 'empty' | 'unknown' | 'listed'; tasks: number; unknownResources: string[];
  orphanSlots: string[] }): { reason: null | 'RECONCILIATION_REQUIRED' | 'EXECUTION_NOT_ENABLED'; closing: string[] } {
  const closing: string[] = [];
  if (input.inventory === 'unknown') closing.push('RUNTIME_INVENTORY_UNKNOWN');
  if (input.tasks > 0) closing.push('PERSISTED_TASKS_PRESENT');
  closing.push(...input.unknownResources);
  for (const item of input.orphanSlots) closing.push(`SLOT_WITHOUT_CURRENT_EXECUTION:${item}`);
  if (closing.length) return { reason: 'RECONCILIATION_REQUIRED', closing };
  return { reason: input.executionComposed ? null : 'EXECUTION_NOT_ENABLED', closing };
}

export function recoveryImpediment(code: 'RECOVERY_CESSATION_UNCONFIRMED' | 'RECOVERY_START_UNCERTAIN' | 'RECOVERY_BLOCKED', detail: string, since: string): Impediment {
  const nextStep = code === 'RECOVERY_CESSATION_UNCONFIRMED'
    ? `The host could not confirm the cessation of this Work's own boot/worker/subprocesses (${detail}); its Slot and reservation are kept and no ` +
      'substitute starts. Inspect the environment (`factory show`); the next controller boot observes and stops it again.'
    : code === 'RECOVERY_START_UNCERTAIN'
      ? `It cannot be established whether the interrupted Execution started (${detail}); its budget reservation is kept (never consumed or released ` +
        'by guess). Inspect the Records evidence of the Execution and decide explicitly.'
      : `The interrupted Execution ended with ${detail}, which is not a transient operational failure: nothing is retried automatically. Inspect ` +
        'the Execution evidence and decide explicitly.';
  return { code, scope: 'work', since, nextStep };
}

/**
 * Ticket 41: the token of a blocked request's reference — the invocation that preserved it, else its Records reference, else the Execution —
 * so a missing or odd identity still yields a reference the operator can name (`blockedRequestReference`, contracts).
 */
export function blockedRequestToken(input: { invocationId: string | null | undefined; records: readonly string[]; executionId: string }): string {
  for (const candidate of [input.invocationId, ...input.records, input.executionId]) if (candidate && blockedReferenceToken.test(candidate)) return candidate;
  return 'unidentified';
}

/**
 * Ticket 41: only a POSITIVE resolution of THAT request lifts the need for an override: its Question (by the blocked `questionId`, or — when the
 * record was unreadable — a Question of the same invocation) bound to the Execution, or a LATER reconciliation that recorded it from Records.
 * A later reconciliation that merely did not block (absent, unresolved...) resolves nothing.
 */
export function positiveResolution(input: { blocked: { questionId: string | null; at: string }; executionId: string; invocationId: string;
  questions: readonly { questionId: string; executionId: string; invocationId: string }[]; recovery: readonly { at: string; question?: string | undefined }[] }): boolean {
  const { blocked } = input;
  const own = input.questions.some(item => item.executionId === input.executionId && (blocked.questionId ? item.questionId === blocked.questionId : item.invocationId === input.invocationId));
  const later = input.recovery.some(item => item.at > blocked.at && item.question !== undefined && (blocked.questionId ? item.question === `recorded:${blocked.questionId}` : item.question.startsWith('recorded:')));
  return own || later;
}

/** `RECOVERY_BLOCKED` by a lost Builder request (ticket 27), with the explicit exit of ticket 41. */
export function blockedRequestImpediment(workId: string, reference: string, code: string, since: string): Impediment {
  return { code: 'RECOVERY_BLOCKED', scope: 'work', since, nextStep: `The interrupted Builder preserved a request in Records that could not be read intact (${code}); ` +
    'nothing is retried automatically and the lost request is never reconstructed. Inspect the Execution evidence; to continue WITHOUT it, ' +
    `\`factory resume ${workId} --override-blocked-recovery ${reference} --request-id <id>\` (one operational recovery unit), or \`factory cancel ${workId}\`.` };
}

export type OverrideFacts = {
  work: { result: string; current: boolean; impediments: readonly { code: string }[] } | null;
  execution: { state: string; slotHeld: boolean; end: { outcome: string; code: string | null; cessation: string } | null;
    blockedRequest?: { reference: string; code: string; override: { reference: string } | null } | undefined } | null;
  /** The reference the operator named. */
  reference: string;
  /** Live own activity of the Work in this controller process. */
  running: boolean;
  /** `positiveResolution` of the blocked request (its Question recorded by a later complete read). */
  resolved: boolean;
  /** The Work has a cancellation (stopping or ceased): never continued. */
  cancelling: boolean;
  /** An operational recovery is already pending: an override never opens a second or ambiguous one. */
  pendingRecovery: boolean };

/**
 * Ticket 41 (spec §5.5 "conteúdo perdido bloqueia" + explicit operator decision): whether the operator may continue a Work whose recovery is
 * blocked by a lost Builder request. Only for EXACTLY the blocked reference, after confirmed cessation, with no activity or Slot, and only
 * while no later complete read resolved the request. Accepting never reconstructs the request; it lifts only that block.
 */
export function overrideBlockedRecoveryDecision(input: OverrideFacts): { kind: 'accept'; code: string } | { kind: 'already'; code: string } | { kind: 'refuse'; code: string } {
  const { work, execution } = input;
  if (!work) return { kind: 'refuse', code: 'WORK_NOT_FOUND' };
  if (!work.current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (work.result !== 'open') return { kind: 'refuse', code: work.result === 'cancelled' ? 'WORK_CANCELLED' : work.result === 'delivered' ? 'WORK_DELIVERED' : 'WORK_NOT_OPEN' };
  if (input.cancelling) return { kind: 'refuse', code: 'WORK_CANCELLING' };
  const blocked = work.impediments.some(item => item.code === 'RECOVERY_BLOCKED');
  const request = execution?.blockedRequest;
  if (!blocked && request?.override?.reference === input.reference) return { kind: 'already', code: 'BLOCKED_RECOVERY_ALREADY_OVERRIDDEN' };
  if (!blocked) return { kind: 'refuse', code: 'RECOVERY_NOT_BLOCKED' };
  if (!execution || !request || request.override) return { kind: 'refuse', code: 'BLOCK_NOT_A_LOST_REQUEST' };
  if (request.reference !== input.reference) return { kind: 'refuse', code: 'BLOCKED_REFERENCE_MISMATCH' };
  if (input.running || execution.state !== 'ended') return { kind: 'refuse', code: 'EXECUTION_ACTIVE' };
  if (!execution.end || execution.end.cessation !== 'confirmed') return { kind: 'refuse', code: 'CESSATION_NOT_CONFIRMED' };
  if (execution.slotHeld) return { kind: 'refuse', code: 'SLOT_HELD' };
  if (input.resolved) return { kind: 'refuse', code: 'REQUEST_RESOLVED_BY_RECORDS' };
  if (execution.end.outcome !== 'failure' || execution.end.code !== request.code) return { kind: 'refuse', code: 'BLOCK_CHANGED' };
  if (input.pendingRecovery) return { kind: 'refuse', code: 'RECOVERY_ALREADY_PENDING' };
  return { kind: 'accept', code: request.code };
}

/** Ticket 50: which refusal codes each explicit remedy applies to; ticket 47: the disk remedies of a preserved disk that fails its check. */
export const startRetryRemedyCodes: Record<StartRetryRemedy, readonly string[]> = { 'recreate-artifact-seed': ['PREPARE_ARTIFACT_SEED_VERSION_CONFLICT'],
  'repair-disk': ['START_PRESERVED_DISK_CHECK_REQUIRED'], 'replace-disk': ['START_PRESERVED_DISK_CHECK_REQUIRED'] };
/** Ticket 47: the remedies applied by the boot (`Sandbox.start`), not by the preparation. */
export const isDiskRemedy = (remedy: StartRetryRemedy | null | undefined): remedy is 'repair-disk' | 'replace-disk' => remedy === 'repair-disk' || remedy === 'replace-disk';
const remedyEffects: Record<StartRetryRemedy, string> = {
  'recreate-artifact-seed': 'recreate-artifact-seed to set the divergent /artifacts copy aside and write a fresh seed',
  'repair-disk': 'repair-disk to run `e2fsck -p` on a copy of the preserved root disk and boot the repaired copy',
  'replace-disk': 'replace-disk to boot a NEW root disk from the pinned template (JDK, caches and Docker images on the old root are lost)',
};

/** Ticket 50: the remedies the operator may name for a refusal code (shown in the impediment). */
export const remediesFor = (code: string) => (Object.keys(startRetryRemedyCodes) as StartRetryRemedy[]).filter(remedy => startRetryRemedyCodes[remedy].includes(code));

/** `RECOVERY_BLOCKED` by a boot/preparation refusal (ticket 50), with its explicit exit (operator retry through one operational recovery). */
export function blockedStartImpediment(workId: string, code: string, detail: string | null, since: string): Impediment {
  const remedies = remediesFor(code);
  const why = code.endsWith('ENVIRONMENT_CONFIGURATION_MISMATCH') || code === 'START_GUEST_ASSET_PIN_MISMATCH'
    ? ' The configuration changed what identifies the prepared environment (profile, disk size or guest assets; memory/vCPU never do): restore it ' +
      'and retry, or `factory cancel` + `factory new` for a NEW environment (the current one and its unpublished work are not reused).'
    : retriesEnvironmentBase(code)
      ? ' The environment base (the base disk of the repository\'s declared .factory/environment.yaml) could not be prepared; the cause is above. ' +
        'Nothing else was installed instead (no other version or image). Fix the cause (e.g. a version no longer in the Alpine mirror: update the ' +
        'declaration on the base branch and start a NEW cycle, since this Work stays pinned to its declaration), or retry if it was transient: the ' +
        'retry sets the failed attempt aside and prepares the base again.'
      : '';
  return { code: 'RECOVERY_BLOCKED', scope: 'work', since, nextStep: `The Execution's boot/preparation was refused with ${code}${detail ? ` (${detail})` : ''}; ` +
    `nothing started and nothing is retried automatically.${why} After inspecting/fixing the cause, retry it explicitly: ` +
    `\`factory resume ${workId} --retry-blocked-start ${code} --request-id <id>\`` +
    (remedies.length ? ` (or with \`--remedy ${remedies.join('|')}\`: ${remedies.map(remedy => remedyEffects[remedy]).join('; ')}${remedies.some(isDiskRemedy)
      ? '; /workspace and /artifacts are kept and the old disk is set aside, never deleted' : ''})` : '') +
    `, one operational recovery unit; or \`factory cancel ${workId}\`.` };
}

export type StartRetryFacts = {
  work: { result: string; current: boolean; impediments: readonly { code: string }[] } | null;
  execution: { state: string; started: boolean; slotHeld: boolean;
    blockedStart?: { code: string; cessation: 'confirmed' | 'unconfirmed'; retry: { code: string } | null } | undefined } | null;
  /** The refusal code the operator named. */
  code: string;
  remedy: StartRetryRemedy | null;
  /** Live own activity of the Work in this controller process. */
  running: boolean;
  cancelling: boolean };

/**
 * Ticket 50 (generic operator retry of a refused boot/preparation; ticket 47 reuses it for START_PRESERVED_DISK_CHECK_REQUIRED): accepted
 * only for EXACTLY the refusal that blocked the Work, after confirmed cessation (the refused Execution was released: no activity, no Slot,
 * nothing started), and with a remedy only where it applies. Accepting lifts only that block; the Work returns through ONE operational recovery.
 */
export function retryBlockedStartDecision(input: StartRetryFacts): { kind: 'accept'; code: string } | { kind: 'already'; code: string } | { kind: 'refuse'; code: string } {
  const { work, execution } = input;
  if (!work) return { kind: 'refuse', code: 'WORK_NOT_FOUND' };
  if (!work.current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (work.result !== 'open') return { kind: 'refuse', code: work.result === 'cancelled' ? 'WORK_CANCELLED' : work.result === 'delivered' ? 'WORK_DELIVERED' : 'WORK_NOT_OPEN' };
  if (input.cancelling) return { kind: 'refuse', code: 'WORK_CANCELLING' };
  const blocked = work.impediments.some(item => item.code === 'RECOVERY_BLOCKED');
  const refusal = execution?.blockedStart;
  if (!blocked && refusal?.retry?.code === input.code) return { kind: 'already', code: 'BLOCKED_START_ALREADY_RETRIED' };
  if (!blocked) return { kind: 'refuse', code: 'RECOVERY_NOT_BLOCKED' };
  if (!execution || !refusal || refusal.retry) return { kind: 'refuse', code: 'BLOCK_NOT_A_START_REFUSAL' };
  if (refusal.code !== input.code) return { kind: 'refuse', code: 'BLOCKED_CODE_MISMATCH' };
  if (input.running || execution.state !== 'released') return { kind: 'refuse', code: 'EXECUTION_ACTIVE' };
  if (execution.started) return { kind: 'refuse', code: 'BLOCK_NOT_A_START_REFUSAL' };
  if (refusal.cessation !== 'confirmed') return { kind: 'refuse', code: 'CESSATION_NOT_CONFIRMED' };
  if (execution.slotHeld) return { kind: 'refuse', code: 'SLOT_HELD' };
  if (input.remedy && !startRetryRemedyCodes[input.remedy]?.includes(input.code)) return { kind: 'refuse', code: 'REMEDY_NOT_APPLICABLE' };
  return { kind: 'accept', code: input.code };
}

/** Ticket 51: the code of an Execution stopped because a reviewer failed again after its automatic retries in the round (ticket 28). */
export const reviewerRetryLimitCode = 'REVIEWER_RETRY_LIMIT';

/** Ticket 51: `RECOVERY_BLOCKED` by REVIEWER_RETRY_LIMIT, naming the only two operator decisions. */
export function reviewerRetryLimitImpediment(workId: string, since: string): Impediment {
  return { code: 'RECOVERY_BLOCKED', scope: 'work', since, nextStep: 'A reviewer failed again after its 2 automatic retries in the review round ' +
    '(REVIEWER_RETRY_LIMIT); its own boot was stopped and nothing is retried automatically. Inspect the reviewer failures (`factory show`), then decide: ' +
    `a new review round, \`factory resume ${workId} --new-review-round --request-id <id>\` (one operational recovery unit: the Builder resumes on the ` +
    `preserved workspace and hands off again for a new round with the current reviewer budget), or \`factory cancel ${workId}\`. The unverified round is never accepted as verified.` };
}

export type NewReviewRoundFacts = {
  work: { result: string; current: boolean; impediments: readonly { code: string }[] } | null;
  execution: { state: string; slotHeld: boolean; held: { code: string } | null; end: { outcome: string; code: string | null; cessation: string } | null;
    reviewRetryLimit: { decision: 'new-review-round' | 'cancel'; request_id: string } | null } | null;
  /** Live own activity of the Work in this controller process. */
  running: boolean;
  /** The Work has a cancellation (stopping or ceased): never continued. */
  cancelling: boolean;
  /** An operational recovery is already pending: the decision never opens a second one. */
  pendingRecovery: boolean };

/**
 * Ticket 51 (operator decision 2026-11-19): whether the operator may answer REVIEWER_RETRY_LIMIT with a NEW REVIEW ROUND. The other decision
 * is `cancel`; there is no decision that accepts the unverified round. Only for a current open Work whose Execution ended with that code after
 * confirmed cessation, with no activity or Slot, still blocked and with no recovery pending. The round itself is never re-reviewed in place:
 * the Work comes back through ONE operational recovery (ticket 26), whose Builder hands off again for a new round (ticket 28 carry rules).
 */
export function newReviewRoundDecision(input: NewReviewRoundFacts): { kind: 'accept' } | { kind: 'already'; code: string } | { kind: 'refuse'; code: string } {
  const { work, execution } = input;
  if (!work) return { kind: 'refuse', code: 'WORK_NOT_FOUND' };
  if (!work.current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  if (work.result !== 'open') return { kind: 'refuse', code: work.result === 'cancelled' ? 'WORK_CANCELLED' : work.result === 'delivered' ? 'WORK_DELIVERED' : 'WORK_NOT_OPEN' };
  if (input.cancelling) return { kind: 'refuse', code: 'WORK_CANCELLING' };
  if (execution?.reviewRetryLimit?.decision === 'new-review-round') return { kind: 'already', code: 'NEW_REVIEW_ROUND_ALREADY_DECIDED' };
  const limited = execution && (execution.end ? execution.end.code === reviewerRetryLimitCode : execution.held?.code === reviewerRetryLimitCode);
  if (!execution || !limited) return { kind: 'refuse', code: 'REVIEWER_RETRY_LIMIT_NOT_PENDING' };
  if (input.running) return { kind: 'refuse', code: 'EXECUTION_ACTIVE' };
  if (execution.state !== 'ended' || !execution.end || execution.end.cessation !== 'confirmed') return { kind: 'refuse', code: 'CESSATION_NOT_CONFIRMED' };
  if (execution.slotHeld) return { kind: 'refuse', code: 'SLOT_HELD' };
  if (!work.impediments.some(item => item.code === 'RECOVERY_BLOCKED')) return { kind: 'refuse', code: 'RECOVERY_NOT_BLOCKED' };
  if (input.pendingRecovery) return { kind: 'refuse', code: 'RECOVERY_ALREADY_PENDING' };
  return { kind: 'accept' };
}

const fenced = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
};

/**
 * Explicit substitute instruction after an interrupted Execution (spec §5.5: "Substituta: instrução explícita de recuperação com Trabalho e
 * artefatos; registrar motivo"). A new session on the same preserved workspace; the output of the last tool may be lost, so its effect must be
 * inspected before anything is repeated (never a blind replay).
 */
export function interruptionRecoveryPrompt(input: { ticketUrl: string; repository: string; base: string; baseCommit: string; branch: string; checkout: string;
  skillDirectory: string; workId: string; executionId: string; previousExecutionId: string; reason: 'OPERATIONAL_RECOVERY' | 'ADMINISTRATIVE_STOP' | 'BUDGET_CONTINUATION'; code: string;
  reviews: boolean;
  /** Ticket 48: the bounded state summary (`stateSummary`): last phase, last gates, answered Questions. */
  summary?: string | null }): string {
  const why = input.reason === 'ADMINISTRATIVE_STOP'
    ? 'The previous Execution was stopped administratively (clean stop with confirmed cessation); this continuation is not a failure recovery.'
    : input.reason === 'BUDGET_CONTINUATION'
      ? `The previous Execution reached its per-Execution Builder budget (${input.code}) after progress the Factory host observed in the checkout; its ` +
        'boot was stopped cleanly. This is a CONTINUATION of the same work, not a failure recovery: do not restart or redo finished work; continue ' +
        'from the preserved state and the summary below instead of re-reading everything.'
      : `The previous Execution was interrupted (${input.code}) and its activity ceased; the Factory starts this operational recovery after reconciliation.`;
  return [`Factory recovery instruction for Ticket ${input.ticketUrl}.`,
    `Execution context (from the Factory, authoritative): repository=${input.repository} base=${input.base} base-commit=${input.baseCommit} branch=${input.branch} ` +
      `checkout=${input.checkout} artifacts=/artifacts work=${input.workId} execution=${input.executionId} previous-execution=${input.previousExecutionId}` +
      (input.reviews ? ' reviews=factory-handoff' : ''),
    why,
    'This is a NEW session on the same Work: its workspace, branch, commits and /artifacts were preserved; the previous session is not continued and ' +
      'no process of it survives. The output of its last tool call may be lost: inspect the current state (files, git status/log, /artifacts) before ' +
      'repeating anything, and never repeat a tool call blindly.',
    `Read ${input.skillDirectory}/skills/implement/SKILL.md with the read tool and follow its instructions, resuming from the preserved state.`,
    ...(input.summary ? ['', input.summary] : []),
    '', 'Reason recorded by the Factory:', fenced(`${input.reason}:${input.code}`)].join('\n');
}
