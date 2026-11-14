// Pure recovery rules (ticket 26, spec §4.4/§5.2/§5.3/§5.4/§11.4). No I/O, clock or randomness: callers supply every fact.
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
const transient = new Set(['WORKER_EXECUTION_UNCERTAIN', 'WORKER_CHANNEL_CLOSED', 'WORKER_START_UNCERTAIN', 'WORKER_LAUNCH_UNCERTAIN', 'WORKER_PROVIDER_UNAVAILABLE',
  'WORKER_MODEL_UNAVAILABLE', 'WORKER_INTERRUPTED', 'TOOL_CHANNEL_CLOSED', 'CONTROLLER_CRASH', 'REVIEWER_CESSATION_UNCONFIRMED', 'REVIEW_DELIVERY_UNCERTAIN',
  'REVIEW_DELIVERY_FAILED', 'OWNER_STOPPED_BEFORE_ACTIVATION_CESSATION_UNCONFIRMED', 'ACTIVATION_REFUSED_CESSATION_UNCONFIRMED', 'ADMINISTRATIVE_STOP_CESSATION_UNCONFIRMED',
  'RECOVERY_CESSATION_UNCONFIRMED']);
// Phase prefixes of the dispatch holds (`${phase}_${code}`) that may wrap a transient worker failure.
const phases = ['ACTIVATE_', 'STARTED_', 'REVIEW_', 'COMPLETED_', 'STOP_'];

/** Whether an interrupted Execution may come back through the queue as an operational recovery (counter + persisted wait) or must block. */
export function classifyInterruption(code: string | null): { kind: 'recoverable' } | { kind: 'blocking'; code: string } {
  const value = code ?? 'CONTROLLER_CRASH';
  if (transient.has(value)) return { kind: 'recoverable' };
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
  skillDirectory: string; workId: string; executionId: string; previousExecutionId: string; reason: 'OPERATIONAL_RECOVERY' | 'ADMINISTRATIVE_STOP'; code: string;
  reviews: boolean }): string {
  const why = input.reason === 'ADMINISTRATIVE_STOP'
    ? 'The previous Execution was stopped administratively (clean stop with confirmed cessation); this continuation is not a failure recovery.'
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
    '', 'Reason recorded by the Factory:', fenced(`${input.reason}:${input.code}`)].join('\n');
}
