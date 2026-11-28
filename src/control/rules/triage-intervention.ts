// Pure rules of the operator's interventions on a Triage request (`triage cancel | release | complete`).
// No I/O, clock or storage: the callers pass the records and what was just observed.
import type { TriageReceiptEffect } from '../types.js';
import type { PublicationStep } from './triage-publication.js';
import type { TriageIntendedEffect } from './triage-verdict.js';

/** The code a request cancelled by the operator ends with (`abandoned`), and that its interrupted attempt ends with. */
export const cancelledByOperator = 'CANCELLED_BY_OPERATOR';

/**
 * What a fresh observation of an attempt whose stop was never confirmed allows `triage release` to do. The Factory never frees a unit
 * against evidence of life (`alive`: the unit is active, or processes are left in its group). A confirmed stop frees it with no need of
 * the operator's word. The operator's attestation is taken only when nothing of the recorded invocation can be observed: the manager
 * does not answer, the group cannot be read, or what the Host shows under the attempt's name is not the recorded invocation.
 */
export function releaseObservation(observed: { cessationConfirmed: boolean; code?: string }): 'confirmed' | 'alive' | 'unobservable' {
  if (observed.cessationConfirmed) return 'confirmed';
  return observed.code === 'INVESTIGATION_UNIT_ACTIVE' || observed.code === 'INVESTIGATION_CGROUP_POPULATED' ? 'alive' : 'unobservable';
}

function receiptEffect(effect: TriageIntendedEffect, index: number): TriageReceiptEffect {
  return {
    index,
    kind: effect.kind,
    ...(effect.kind === 'add-label' || effect.kind === 'remove-label' ? { label: effect.label } : {}),
    ...(effect.kind === 'add-component' ? { componentId: effect.componentId } : {}),
    status: effect.status,
    attempted: effect.attemptedAt !== undefined,
    ...(effect.code === undefined ? {} : { code: effect.code }),
    ...(effect.reference === undefined ? {} : { reference: effect.reference }),
  };
}
/**
 * The intended effects of a request as a receipt lists them once nothing more will be written: `published` are the ones a read confirmed
 * on the Ticket; every other one is `discarded`, with the situation the last read left it in.
 */
export function receiptEffects(intended: readonly TriageIntendedEffect[]): { published: TriageReceiptEffect[]; discarded: TriageReceiptEffect[] } {
  const effects = intended.map(receiptEffect);
  return { published: effects.filter(effect => effect.status === 'confirmed'), discarded: effects.filter(effect => effect.status !== 'confirmed') };
}

/**
 * Why `triage complete` is refused, from the move the publication would make with the ambiguous effects taken as the Factory's (null: it
 * goes on). A Ticket that closed or got a Work is accepted and ends the request `abandoned`, whatever else changed on it. Any other
 * change of the Ticket that would discard an effect still to write (a state-label conflict, a label somebody changed) refuses the
 * command: nothing is recorded and the Impediment stays for the operator to decide again, or to cancel.
 */
export function completionRefusal(before: readonly TriageIntendedEffect[], step: PublicationStep, facts: { open: boolean; hasWork: boolean }): string | null {
  const { next } = step;
  if (!facts.open || facts.hasWork) return null;
  if (next.action === 'suspend') return 'TRIAGE_LABEL_CONFLICT';
  if (next.action !== 'end' || next.to !== 'abandoned') return null;
  const discards = step.effects.some((effect, index) => effect.status === 'no-longer-allowed' && before[index]?.status !== 'no-longer-allowed');
  return discards ? next.code : null;
}
