// Pure budget/timeout rules (spec §4.4/§5.7). No I/O, clock or randomness: callers pass the configuration, instants and elapsed values.
import type { BudgetCounter, CounterView, DurationView, ExecutionTiming, Impediment, WorkBudget } from '../types.js';
import { continuationsPerWork } from '../../contracts/index.js';

/** Ticket 48: `continuations` (budget ends with progress) is fixed per Work by the release (5), not configured; only grants add to it. */
export const defaultLimits = { corrections: 3, recoveries: 3, continuations: continuationsPerWork } as const;
/** Upper bound of ONE grant command (typo guard); successive grants accumulate with history. */
export const maxGrantAmount = 100;
export type BudgetCounterName = 'corrections' | 'recoveries' | 'continuations';
export const exhaustionCodes = { corrections: 'CORRECTION_LIMIT_REACHED', recoveries: 'RECOVERY_LIMIT_REACHED', continuations: 'CONTINUATION_LIMIT_REACHED' } as const;

/** Snapshot at admission of the repository configuration (defaults three/three). Later YAML changes never alter it. */
export function initialBudget(limits: { correctionLimit?: number | undefined; recoveryLimit?: number | undefined }, repository: string, recordedAt: string): WorkBudget {
  const counter = (limit: number): BudgetCounter => ({ limit, granted: 0, consumed: 0, reserved: null });
  return { corrections: counter(limits.correctionLimit ?? defaultLimits.corrections), recoveries: counter(limits.recoveryLimit ?? defaultLimits.recoveries),
    continuations: counter(defaultLimits.continuations), source: { kind: 'repository-configuration', repository, recordedAt }, grants: [] };
}

/** Ticket 48: the counter as stored; a budget recorded before ticket 48 gets its `continuations` counter (release value) on first use. */
export function counterOf(budget: WorkBudget, name: BudgetCounterName): BudgetCounter {
  if (name === 'continuations' && !budget.continuations) budget.continuations = { limit: defaultLimits.continuations, granted: 0, consumed: 0, reserved: null };
  return name === 'continuations' ? budget.continuations! : budget[name];
}

/** Remaining capacity: limit + grants - consumptions - an outstanding (possibly uncertain) reservation; never negative. */
export function availableOf(counter: BudgetCounter): number {
  return Math.max(0, counter.limit + counter.granted - counter.consumed - (counter.reserved ? 1 : 0));
}
export function counterView(counter: BudgetCounter): CounterView {
  const available = availableOf(counter);
  return { limit: counter.limit, granted: counter.granted, effectiveLimit: counter.limit + counter.granted, consumed: counter.consumed,
    reserved: counter.reserved ? 1 : 0, reservedBy: counter.reserved, available, exhausted: available === 0 };
}

/** Why the next activation of a Work runs: the initial implementation charges nothing; a correction once; each operational recovery once. */
export type Motive = { kind: 'none' } | { kind: 'correction'; correctionId: string; consumed: boolean } | { kind: 'recovery'; correctionId: string | null } |
  /** Ticket 48: a continuation after a Builder budget end with progress (charged once to `continuations`, never to `recoveries`). */
  { kind: 'continuation'; correctionId: string | null };
export type ChargeDecision = { kind: 'none' } | { kind: 'preserve'; correctionId: string } |
  { kind: 'reserve'; counter: BudgetCounterName; correctionId: string | null } |
  { kind: 'exhausted'; counter: BudgetCounterName; code: typeof exhaustionCodes[BudgetCounterName] };

/** Charge of the next Execution. A correction already consumed is preserved (question/continuation), even with no budget left. */
export function chargeDecision(budget: WorkBudget, motive: Motive): ChargeDecision {
  if (motive.kind === 'none') return { kind: 'none' };
  if (motive.kind === 'correction' && motive.consumed) return { kind: 'preserve', correctionId: motive.correctionId };
  const counter: BudgetCounterName = motive.kind === 'correction' ? 'corrections' : motive.kind === 'continuation' ? 'continuations' : 'recoveries';
  if (availableOf(counterOf(budget, counter)) === 0) return { kind: 'exhausted', counter, code: exhaustionCodes[counter] };
  return { kind: 'reserve', counter, correctionId: motive.correctionId };
}

export function exhaustionImpediment(counter: BudgetCounterName, work_id: string, since: string): Impediment {
  if (counter === 'continuations') return { code: exhaustionCodes.continuations, scope: 'work', since, nextStep: 'The Builder reached its per-Execution ' +
    'budget again after progress, and the continuations of this Work are exhausted; nothing continues automatically. Inspect the progress ' +
    `(\`factory show ${work_id}\`), then grant more explicitly with \`factory grant ${work_id} --continuations <n>\` (history is kept, counters are ` +
    `never reset), or \`factory cancel ${work_id}\`.` };
  const flag = counter === 'corrections' ? '--corrections' : '--recoveries';
  return { code: exhaustionCodes[counter], scope: 'work', since, nextStep: `The ${counter === 'corrections' ? 'correction' : 'operational recovery'} budget of this Work is ` +
    `exhausted; nothing is retried automatically. Grant more explicitly with \`factory grant ${work_id} ${flag} <n>\` (history is kept, counters are never reset).` };
}

/** Explicit grant through an authorized ingress: an open, current Work and a positive integer amount. */
export function grantDecision(input: { work: { result: string; current: boolean } | null; amount: number }): { kind: 'apply' } | { kind: 'refuse'; code: string } {
  if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > maxGrantAmount) return { kind: 'refuse', code: 'GRANT_AMOUNT_INVALID' };
  if (!input.work) return { kind: 'refuse', code: 'WORK_NOT_FOUND' };
  if (input.work.result !== 'open') return { kind: 'refuse', code: 'WORK_NOT_OPEN' };
  if (!input.work.current) return { kind: 'refuse', code: 'WORK_NOT_CURRENT' };
  return { kind: 'apply' };
}

/** Timeout on the live local monotonic elapsed value only. Absent timeout: never reached (no implicit 60 min or other cut). */
export function timeoutReached(timeoutSeconds: number | null, elapsedMs: number): boolean {
  return timeoutSeconds !== null && elapsedMs >= timeoutSeconds * 1000;
}

/**
 * Overrun classification (spec §5.7) from a measured duration (end observed by the measuring process) or, after a restart, the proven lower
 * bound. Without timeout imprecision is an observability gap, never a block. A lost end cannot exclude an overrun: it blocks automatic resumption.
 */
export function classifyOverrun(input: { timeoutSeconds: number | null; measuredMs: number | null; lowerBoundMs: number | null }): NonNullable<ExecutionTiming['overrun']> {
  if (input.timeoutSeconds === null) return 'not-applicable';
  if (input.measuredMs !== null) return timeoutReached(input.timeoutSeconds, input.measuredMs) ? 'proven' : 'within';
  if (input.lowerBoundMs !== null && timeoutReached(input.timeoutSeconds, input.lowerBoundMs)) return 'proven';
  return 'not-excludable';
}

export function timeoutImpediment(timeoutSeconds: number, since: string, evidence: 'measured' | 'lower-bound'): Impediment {
  return { code: 'EXECUTION_TIMEOUT', scope: 'work', since, nextStep: `The Execution reached its configured timeout (${timeoutSeconds} s per Execution, ` +
    `${evidence === 'measured' ? 'measured' : 'proven lower bound'} on the controller monotonic clock); it is interrupted/blocked for intervention. Nothing is ` +
    'retried automatically and no new clock is started for it; answers and grants do not remove this impediment. Inspect with `factory show`.' };
}
export function overrunNotExcludedImpediment(timeoutSeconds: number, since: string): Impediment {
  return { code: 'TIMEOUT_OVERRUN_NOT_EXCLUDED', scope: 'work', since, nextStep: `The end of the previous Execution was lost (controller restart); with a ` +
    `configured timeout of ${timeoutSeconds} s an overrun cannot be excluded from the evidence, so it is not resumed automatically. Inspect the ` +
    'Execution and decide explicitly (recovery, ticket 26).' };
}

const silence = 'Silence is not a stall: tools and commands may run silently; cancellation remains an explicit operator decision.';
/** Presentation of the duration evidence: live monotonic, measured, lower bound (+ calendar estimate) or unknown — never zero by default. */
export function durationView(timing: ExecutionTiming | null | undefined, live: { elapsedMs: number } | null): DurationView {
  const base = { clock: timing ? timing.clock : null, startedAt: timing?.startedAt ?? null, lastActivity: timing?.lastActivity ?? null,
    lowerBoundMs: null as number | null, calendarEstimateMs: null as number | null };
  if (!timing) return { ...base, state: 'not-recorded', elapsedMs: null, note: 'No duration evidence was recorded for this Execution (earlier Factory version).' };
  if (!timing.startedAt) return { ...base, state: 'not-started', elapsedMs: null, note: 'No confirmed start: no active duration.' };
  if (timing.duration?.kind === 'measured') return { ...base, state: 'measured', elapsedMs: timing.duration.elapsedMs, note: 'Measured by the controller monotonic clock from the confirmed start to the observed end.' };
  if (timing.duration?.kind === 'lower-bound') return { ...base, state: 'lower-bound', elapsedMs: null, lowerBoundMs: timing.duration.provenMs,
    calendarEstimateMs: timing.duration.calendarEstimateMs, note: 'The end was lost (restart): at least the proven lower bound elapsed; the calendar estimate is not proof (clock adjustments, reboot).' };
  if (live) return { ...base, state: 'running', elapsedMs: live.elapsedMs, note: `Live monotonic duration of the running Execution. ${silence}` };
  return { ...base, state: 'unknown', elapsedMs: null, lowerBoundMs: timing.lastActivity?.elapsedMs ?? null,
    note: `Not measured by this controller process: the duration is unknown (never zero) until reconciled. ${silence}` };
}
