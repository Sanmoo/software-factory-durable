import { holdsTriageCapacity } from './triage.js';

// What an upgrade reads of the Triage requests of a storage. Pure, and from metadata only (the state of each
// request and how each of its attempts ended): never a Ticket text, a Verdict or a transcript.

/** The facts of one stored Triage request the settlement reads. */
export type TriageSettlementFacts = {
  state: string;
  attempts?: readonly { attempt?: string; end: { cessation: { cessationConfirmed: boolean } } | null }[] | undefined;
};
/**
 * The Triage requests of a storage by situation. Each request is counted once, in the first situation that applies:
 * `investigating` (an attempt of it is open, or the request is recorded as being investigated), `stopUnconfirmed` (an ended attempt of
 * it whose stop the Investigation Environment never confirmed, whatever the request's state), then its own state: `queued`,
 * `suspended`, `publishing` (a recorded Verdict whose publication is incomplete) and `ended` (terminal).
 * `capacity`: the units of Triage capacity held, by open attempts (`investigating`) and by ended ones (`retained`).
 * `unsettled`: the references of the attempts holding a unit.
 */
export type TriageSettlement = {
  requests: { queued: number; suspended: number; investigating: number; stopUnconfirmed: number; publishing: number; ended: number };
  capacity: { investigating: number; retained: number };
  unsettled: string[];
};
type Situation = keyof TriageSettlement['requests'];

function situation(request: TriageSettlementFacts): Situation {
  const attempts = request.attempts ?? [];
  if (request.state === 'investigating' || attempts.some(attempt => !attempt.end)) return 'investigating';
  if (attempts.some(holdsTriageCapacity)) return 'stopUnconfirmed';
  return request.state === 'queued' || request.state === 'suspended' || request.state === 'publishing' ? request.state : 'ended';
}

export function triageSettlement(requests: readonly TriageSettlementFacts[]): TriageSettlement {
  const settlement: TriageSettlement = {
    requests: { queued: 0, suspended: 0, investigating: 0, stopUnconfirmed: 0, publishing: 0, ended: 0 },
    capacity: { investigating: 0, retained: 0 },
    unsettled: [],
  };
  for (const request of requests) {
    settlement.requests[situation(request)]++;
    for (const attempt of (request.attempts ?? []).filter(holdsTriageCapacity)) {
      settlement.capacity[attempt.end ? 'retained' : 'investigating']++;
      if (attempt.attempt) settlement.unsettled.push(attempt.attempt);
    }
  }
  return settlement;
}

/**
 * What blocks an upgrade: an investigation under way, a stop not confirmed or a retained unit of Triage capacity, until a
 * reconciling boot settles it. A queued request and a pending publication never do: the new release takes them up from the same record.
 */
export const triageUnsettled = (settlement: TriageSettlement) =>
  settlement.requests.investigating + settlement.requests.stopUnconfirmed + settlement.capacity.investigating + settlement.capacity.retained > 0;
