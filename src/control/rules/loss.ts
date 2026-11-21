import { lostMarkerRef } from '../../contracts/index.js';
import type { LossRecord, OriginObservation, PreservationView } from '../types.js';

// Pure rules of v2 ticket 12 (V2-16, V2-17): what Control records when the environment of an Execution died before its work was
// published. No I/O, clock or randomness. A loss exists only where the sandbox declares no persistent disk (the caller decides that
// from the capability): there, what was not on the Work branch of `origin` died with the environment.

/** Losses kept on one Work; older ones are dropped first (the history keeps the event of each). */
export const lossLimit = 16;
export type LostMarkersRead = { state: 'complete'; observedAt: string; markers: { ref: string; boot: string; sha: string }[] } | { state: 'unknown'; code: string };

/**
 * The marker of ONE boot, from Control's own listing of the Work's marker refs. Only the exact ref of that Work and boot counts; an
 * unreadable listing is `unknown`, never "absent".
 */
export function markerOf(input: { workId: string; boot: string; read: LostMarkersRead }): LossRecord['marker'] {
  const ref = lostMarkerRef(input.workId, input.boot);
  if (ref === null) return { ref: null, state: 'unknown', code: 'LOST_MARKER_REF_INVALID' };
  if (input.read.state !== 'complete') return { ref, state: 'unknown', code: input.read.code.slice(0, 64) };
  const found = input.read.markers.find(marker => marker.ref === ref);
  return found ? { ref, state: 'present', commit: found.sha, observedAt: input.read.observedAt } : { ref, state: 'absent', observedAt: input.read.observedAt };
}

/**
 * The last commit known to be on `origin`: the Work branch tip Control read at the loss; when that read did not conclude, the last
 * commit a preservation gate confirmed. The marker is never a source: it is not preservation.
 */
export function confirmedAt(input: { branch: string; origin: OriginObservation; preservation: Pick<PreservationView, 'commit' | 'branch'> | null }): LossRecord['confirmed'] {
  const { branch, origin, preservation } = input;
  if (origin.state === 'present') return { commit: origin.sha, source: 'origin-read', branch, origin };
  if (origin.state === 'unknown' && preservation && preservation.branch === branch) return { commit: preservation.commit, source: 'preservation-gate', branch, origin };
  return { commit: null, source: 'none', branch, origin };
}

export const recordLossOn = (losses: LossRecord[] | undefined, loss: LossRecord): LossRecord[] =>
  [...(losses ?? []).filter(item => !(item.executionId === loss.executionId && item.boot === loss.boot)), loss].slice(-lossLimit);

/** One line for the history and the operator. */
export function lossDetail(loss: LossRecord): string {
  const marker = loss.marker.state === 'present' ? `marker ${loss.marker.ref} at ${loss.marker.commit} (not preservation)` : loss.marker.state === 'absent' ? 'no marker ref' : `marker unknown (${loss.marker.code})`;
  return `${loss.boot}: local work after ${loss.confirmed.commit ?? 'the start (nothing confirmed on origin)'} is lost; ${marker}`.slice(0, 512);
}
