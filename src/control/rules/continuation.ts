import type { ExecutionView, SessionObservation, SessionRef } from '../types.js';

// Pure rules of ticket 11 (spec §5.5/§6.1/§6.2/§11.3): concrete scope updates, the continue/replace session decision, the sufficiency of
// the recovery context and the `continue` message. No I/O, clock or randomness: callers supply every fact.

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const scopeLimits = Object.freeze({ reason: 2000, minimum: 12 });
const generic = /^(ok(ay)?|yes|y|sim|s|pode|lgtm|approved?|aprovad[oa]|go( ahead)?|do it|proceed|continue|fine|sure|agreed?|de acordo)[\s.!]*$/i;

/** A scope update must state a concrete change: a bounded, single-text reason that is not a bare/generic approval. */
export function scopeReasonDecision(reason: string): { concrete: true } | { concrete: false; code: 'SCOPE_REASON_NOT_CONCRETE' | 'SCOPE_REASON_INVALID' } {
  if (typeof reason !== 'string' || reason !== reason.trim() || reason.length > scopeLimits.reason || control.test(reason)) return { concrete: false, code: 'SCOPE_REASON_INVALID' };
  if (reason.length < scopeLimits.minimum || generic.test(reason)) return { concrete: false, code: 'SCOPE_REASON_NOT_CONCRETE' };
  return { concrete: true };
}

export type ScopeDecision = { outcome: 'accepted'; requeue: boolean; during: 'idle' | 'question-wait' } | { outcome: 'deferred'; requeue: false; during: 'activity' } |
  { outcome: 'not-applied'; code: string };
/**
 * Where an authorized scope change lands (spec §11.3: "durante atividade, repair/update-scope ficam para próxima ativação segura"). A
 * running, reserved, held or not-yet-ceased Execution never receives it (no parallel writer, no injection): `deferred`. An idle Work after a
 * COMPLETED Execution re-enters its queue position (`requeue`); a Question wait or a pending Work simply carries it to its next activation.
 */
export function scopeUpdateDecision(input: { result: string; current: boolean; pending: string[]; sha256: string;
  execution: { state: ExecutionView['state']; slotHeld: boolean; outcome: NonNullable<ExecutionView['end']>['outcome'] | null } | null }): ScopeDecision {
  if (input.result !== 'open') return { outcome: 'not-applied', code: 'WORK_NOT_OPEN' };
  if (!input.current) return { outcome: 'not-applied', code: 'WORK_NOT_CURRENT' };
  if (input.pending.includes(input.sha256)) return { outcome: 'not-applied', code: 'SCOPE_UPDATE_ALREADY_PENDING' };
  const execution = input.execution;
  if (execution && (execution.slotHeld || ['reserved', 'started', 'held'].includes(execution.state))) return { outcome: 'deferred', requeue: false, during: 'activity' };
  if (execution?.state === 'ended' && execution.outcome === 'question') return { outcome: 'accepted', requeue: false, during: 'question-wait' };
  if (execution?.state === 'ended' && execution.outcome === 'completed') return { outcome: 'accepted', requeue: true, during: 'idle' };
  return { outcome: 'accepted', requeue: false, during: 'idle' };
}

type Facts = { skillPack: ExecutionView['request']['skillPack']; policies: ExecutionView['request']['policies'] };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const canonical = (policies: Facts['policies']) => Object.fromEntries(Object.entries(policies).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
/**
 * Spec §6.1: "Preferir sessão compatível; incompatível/perdida exige substituição registrada". Continue only the RECORDED session, observed
 * intact and compatible by the Host, with the same pack identity and Host policies; every other case replaces it with its reason.
 */
export function sessionDecision(input: { previous: Facts & { session: SessionRef | null }; next: Facts; observation: SessionObservation | null }):
  { mode: 'continue'; reason: 'SESSION_COMPATIBLE' } | { mode: 'replace'; reason: 'SESSION_NOT_RECORDED' | 'SESSION_OBSERVATION_NOT_COMPOSED' | 'SESSION_LOST' | 'SESSION_ALTERED' |
    'SESSION_INCOMPATIBLE' | 'SESSION_UNAVAILABLE' | 'SESSION_CONTINUATION_UNSUPPORTED' } {
  if (!input.previous.session) return { mode: 'replace', reason: 'SESSION_NOT_RECORDED' };
  if (!input.observation) return { mode: 'replace', reason: 'SESSION_OBSERVATION_NOT_COMPOSED' };
  const observed = input.observation;
  if (observed.state === 'lost') return { mode: 'replace', reason: 'SESSION_LOST' };
  if (observed.state === 'altered') return { mode: 'replace', reason: 'SESSION_ALTERED' };
  // The Host names why it cannot continue; a pack without the continue protocol is not the same as a changed profile.
  if (observed.state === 'incompatible') return { mode: 'replace', reason: observed.code === 'SESSION_CONTINUATION_UNSUPPORTED' ? 'SESSION_CONTINUATION_UNSUPPORTED' : 'SESSION_INCOMPATIBLE' };
  if (observed.state !== 'compatible') return { mode: 'replace', reason: 'SESSION_UNAVAILABLE' };
  if (!same(observed.session, input.previous.session)) return { mode: 'replace', reason: 'SESSION_ALTERED' };
  if (!same(input.previous.skillPack, input.next.skillPack) || !same(canonical(input.previous.policies), canonical(input.next.policies))) return { mode: 'replace', reason: 'SESSION_INCOMPATIBLE' };
  return { mode: 'continue', reason: 'SESSION_COMPATIBLE' };
}

/** The guest path of the Work's checkout (MVP §7.3): where a sandbox without a host workspace clones it. */
export const guestCheckoutPath = '/workspace/checkout';
type Git = { baseCommit: string | null; branch: string | null; checkout: string | null };
/**
 * Spec §5.5/§6.1: a resumption must reference the SAME Work context (base commit, own branch, checkout) that was actually PRESERVED — the
 * prepare must have reused the previous environment/checkout, not created a fresh clone that merely happens to sit at the same commit — and
 * carry what authorizes it (an accepted answer or a concrete scope update). Otherwise the context is insufficient: block, never an empty
 * continue/recovery that claims preservation it cannot prove.
 */
export function recoveryContext(input: { previous: Git; prepared: Git & { reused: boolean }; trigger: { answer: boolean; scopeUpdates: number; publication?: boolean;
  /** Ticket 22: an open correction with effective impediments of the own PR. */ repair?: boolean } }):
  { sufficient: true } | { sufficient: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.previous.baseCommit || !input.previous.branch || !input.previous.checkout) reasons.push('PREVIOUS_GIT_CONTEXT_MISSING');
  else if (input.previous.baseCommit !== input.prepared.baseCommit || input.previous.branch !== input.prepared.branch || input.previous.checkout !== input.prepared.checkout) reasons.push('GIT_CONTEXT_CHANGED');
  else if (!input.prepared.reused) reasons.push('PREVIOUS_ENVIRONMENT_NOT_REUSED');
  if (!input.trigger.answer && input.trigger.scopeUpdates === 0 && !input.trigger.publication && !input.trigger.repair) reasons.push('RESUME_TRIGGER_MISSING');
  return reasons.length ? { sufficient: false, reasons } : { sufficient: true };
}

export const fenced = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
};
export type ScopeText = { scopeUpdateId: string; reason: string };
/** Operator-authorized scope changes, fenced (operator text is data for the Builder, never Factory instructions or wider powers). */
export function scopeSection(updates: readonly ScopeText[]): string[] {
  return updates.flatMap(update => [`Authorized scope change ${update.scopeUpdateId} (operator, concrete; only this change is authorized):`, fenced(update.reason)]);
}
export const promptBudgetBytes = 15000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
/**
 * The `continue` message to the SAME compatible session (spec §5.5: "Sessão compatível: `continue` com resposta/feedback/motivo"). It never
 * restarts `/implement`; it carries the accepted answer and/or the authorized scope changes, and refuses to be empty. It cites only the
 * pack's own `implement` file — which section defines the continuation protocol is the PACK's business, so a new pack version needs no
 * Control change.
 */
export function continuationPrompt(input: { executionId: string; previousExecutionId: string; skillDirectory: string;
  answer: { questionId: string; text: string; author: string; origin: string } | null; scopeUpdates: readonly ScopeText[];
  /** Ticket 13: the continued Builder keeps the multi-round review handoff (its rounds continue the Work's numbering). */
  reviewRounds?: boolean;
  /** Ticket 22: the repair section (effective impediments of the own PR); a trigger by itself. */
  repair?: readonly string[] }):
  { kind: 'prompt'; prompt: string } | { kind: 'insufficient'; reasons: ['RESUME_TRIGGER_MISSING' | 'CONTINUATION_TOO_LARGE'] } {
  if (!input.answer && input.scopeUpdates.length === 0 && !input.repair?.length) return { kind: 'insufficient', reasons: ['RESUME_TRIGGER_MISSING'] };
  const prompt = ['continue',
    `Factory continuation of the SAME session: Execution ${input.executionId} continues after Execution ${input.previousExecutionId} ended. ` +
      'Your workspace, branch, commits and /artifacts were preserved; check the effect of your last tool call before repeating anything.',
    `Read ${input.skillDirectory}/skills/implement/SKILL.md with the read tool and follow its instructions for continuing this Work in the same session.`,
    ...(input.reviewRounds ? ['Execution context: reviews=factory-handoff review-rounds=multi'] : []),
    ...(input.answer ? ['', `Accepted answer to your question ${input.answer.questionId} (by ${input.answer.author}, via ${input.answer.origin}):`, fenced(input.answer.text)] : []),
    ...(input.scopeUpdates.length ? ['', ...scopeSection(input.scopeUpdates),
      'Before implementing a scope change, preserve a NEW request version that records it (never edit an earlier version).'] : []), ...(input.repair ?? [])].join('\n');
  if (bytes(prompt) > promptBudgetBytes) return { kind: 'insufficient', reasons: ['CONTINUATION_TOO_LARGE'] };
  return { kind: 'prompt', prompt };
}

/** First prompt of an initial Builder activation: `/implement <ticket>` plus the authorized scope changes, bounded (never a silent truncation). */
export function initialPrompt(input: { ticketUrl: string; repository: string; base: string; baseCommit: string; branch: string; checkout: string; workId: string;
  executionId: string; reviews: boolean; scopeUpdates: readonly ScopeText[];
  /** Ticket 13: the composition repeats review rounds inside the Execution (`review-rounds=multi`). */
  reviewRounds?: boolean }): { kind: 'prompt'; prompt: string } | { kind: 'too-large'; bytes: number } {
  const prompt = [[`/implement ${input.ticketUrl}`, `repository=${input.repository}`, `base=${input.base}`, `base-commit=${input.baseCommit}`,
    `branch=${input.branch}`, `checkout=${input.checkout}`, 'artifacts=/artifacts', `work=${input.workId}`, `execution=${input.executionId}`,
    ...(input.reviews ? ['reviews=factory-handoff'] : []), ...(input.reviews && input.reviewRounds ? ['review-rounds=multi'] : [])].join(' '), ...(input.scopeUpdates.length ? ['', ...scopeSection(input.scopeUpdates),
    'Before implementing a scope change, preserve a NEW request version that records it (never edit an earlier version).'] : [])].join('\n');
  const size = bytes(prompt);
  return size <= promptBudgetBytes ? { kind: 'prompt', prompt } : { kind: 'too-large', bytes: size };
}
