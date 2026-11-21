import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';
import { works } from './admission.js';
import { recordPreserved, type GateDecision } from '../rules/preservation.js';
import type { ExecutionView, PreservationOccasion } from '../types.js';

// v2 ticket 07 (V2-05..V2-08): the durable trace of a preservation gate. Every check Control made is recorded with the Execution it
// preceded; an acceptance also records the confirmed commit on the WORK, where the next boot (ticket 08), a loss (ticket 12) and a
// substitute session (ticket 13) read it.

type Correction = NonNullable<NonNullable<ExecutionView['preservationGate']>['attempts'][number]['correction']>;

/** One check of the gate. An acceptance is the Work's new confirmed commit, in the same commit. */
export async function recordGateCheck(session: Session, work_id: string, executionId: string, input: { occasion: PreservationOccasion; boot: string; branch: string; decision: GateDecision }) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.end) return 'stale' as const;
    const at = new Date().toISOString();
    const { decision } = input;
    execution.preservationGate = { occasion: input.occasion, attempts: [...(execution.preservationGate?.attempts ?? []),
      decision.outcome === 'accepted' ? { at, outcome: 'accepted', code: null, commit: decision.commit } : { at, outcome: 'refused', code: decision.code, detail: decision.detail }] };
    if (decision.outcome === 'accepted') {
      work.preservation = recordPreserved(work.preservation, { commit: decision.commit, branch: input.branch, confirmedAt: at, executionId, boot: input.boot, occasion: input.occasion });
    }
    work.history.push({ at, event: decision.outcome === 'accepted' ? 'preservation-accepted' : 'preservation-refused', origin: 'controller-dispatch', executionId,
      detail: (decision.outcome === 'accepted' ? `${input.occasion}:${decision.commit}` : `${input.occasion}:${decision.code}:${decision.detail}`).slice(0, 512) });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** The Builder activation the last refusal was returned to: its invocation BEFORE the launch, then how it ended. */
export async function recordGateCorrection(session: Session, work_id: string, executionId: string, correction: Correction) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    const gate = execution?.executionId === executionId ? execution.preservationGate : undefined;
    const last = gate?.attempts.at(-1);
    if (!execution || !gate || !last || last.outcome !== 'refused' || (last.correction && last.correction.invocationId !== correction.invocationId)) return 'stale' as const;
    execution.preservationGate = { occasion: gate.occasion, attempts: [...gate.attempts.slice(0, -1), { ...last, correction: { ...last.correction, ...correction } }] };
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}
