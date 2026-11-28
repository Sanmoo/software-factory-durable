import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { TicketRef } from '../../issue-tracker/index.js';
import type { TriageAttempt, TriageRequest, TriageSourceRef, TriageTimelineEntry } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { isTerminalTriageState, triageTransitionAllowed, type TriageLabelApplication, type TriageRequestState } from '../rules/triage.js';
import { ticketIndex } from './admission.js';
import type { Session } from './store.js';

// The durable Triage request. One document per request (`factory.triage-request`), even if no Work ever
// exists, plus the installation index of arrival order, live requests and the requests of each Ticket (`factory.triage-index`). Every
// change is one Session commit; nothing here reads or writes a tracker.

export const triageRequests = defineDocFamily<{ request: TriageRequest | null }, null>({
  kind: 'factory.triage-request',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ request: null }),
  checkpointWhen: () => true,
});
/** `order`: every request id by arrival; `live`: the ones not in a terminal state; `tickets`: request ids per Ticket key, oldest first. */
type TriageIndex = { sequence: number; order: string[]; live: string[]; tickets: Record<string, string[]> };
const triageIndex = defineDoc<TriageIndex>({
  kind: 'factory.triage-index',
  version: 1,
  scope: 'session',
  initial: () => ({ sequence: 0, order: [], live: [], tickets: {} }),
  checkpointWhen: () => true,
});

/**
 * The text of a recorded Verdict, apart from the request so that the request stays metadata and the text can expire alone.
 * Written in the commit that moves the request to `publishing`; `null` = no Verdict, or its text was removed.
 */
export const triageVerdicts = defineDocFamily<{ verdict: { triage_request_id: string; text: string } | null }, null>({
  kind: 'factory.triage-verdict',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ verdict: null }),
  checkpointWhen: () => true,
});
type Transaction = Parameters<Parameters<Session['commit']>[0]>[0];

/** A plain copy of a request read inside a commit (the transaction's draft is not a cloneable object and must not leave it). */
const copy = (request: TriageRequest): TriageRequest => JSON.parse(JSON.stringify(request)) as TriageRequest;

type TriageRequestResult =
  | { kind: 'requested'; request: TriageRequest }
  /** The Ticket's latest request is not the one the caller evaluated (a concurrent creation): nothing was created. */
  | { kind: 'existing'; request: TriageRequest }
  /** The Ticket has a Work in some state (checked in the same commit as the creation): it is never triaged. */
  | { kind: 'work-exists'; work_id: string };

/**
 * Create-request transaction: the absence of a Work for the Ticket, the Ticket's latest request being the evaluated one (`after`: its id,
 * or null for a first request) and terminal, the request document, the index entry and the arrival sequence are read and written in ONE
 * commit. The new request is `queued` with nothing spent: it never inherits from an earlier request of the Ticket.
 */
export async function requestTriage(
  session: Session,
  input: {
    ticket: TicketRef;
    source: TriageSourceRef;
    after: string | null;
    authorization: { label: string; observedAt: string; application: TriageLabelApplication | null };
  },
): Promise<TriageRequestResult> {
  const key = ticketKey(input.ticket);
  return session.commit(async tx => {
    const work = (await tx.doc(ticketIndex)).tickets[key];
    if (work) return { kind: 'work-exists' as const, work_id: work.current };
    const index = await tx.doc(triageIndex);
    const previous = index.tickets[key] ?? [];
    const latestId = previous.at(-1) ?? null;
    const latest = latestId ? (await tx.doc(triageRequests, latestId, null)).request : null;
    if (latest && (latestId !== input.after || !isTerminalTriageState(latest.state))) return { kind: 'existing' as const, request: copy(latest) };
    const triage_request_id = randomUUID();
    const document = await tx.doc(triageRequests, triage_request_id, null);
    if (document.request) throw new Error('TRIAGE_REQUEST_IDENTITY_COLLISION');
    const requestedAt = new Date().toISOString();
    const sequence = index.sequence + 1;
    const request: TriageRequest = {
      triage_request_id,
      sequence,
      ordinal: previous.length + 1,
      previous: [...previous],
      ticket: input.ticket,
      source: input.source,
      state: 'queued',
      authorization: structuredClone(input.authorization),
      suspension: null,
      end: null,
      requestedAt,
      timeline: [{ at: requestedAt, event: 'requested' }],
    };
    document.request = request;
    index.sequence = sequence;
    index.order.push(triage_request_id);
    index.live.push(triage_request_id);
    index.tickets[key] = [...previous, triage_request_id];
    return { kind: 'requested' as const, request: copy(request) };
  }, BACKGROUND_CONTEXT);
}

type TriageTransition = {
  /** The states the caller evaluated the request in; any other current state leaves it unchanged (`not-applied`). */
  from: readonly TriageRequestState[];
  to: TriageRequestState;
  /** Timeline entry of the change (`event`) and its code: required to end a request (`end.code`). */
  event: string;
  code?: string;
  /** Entering `suspended`: the state labels in conflict. */
  labels?: string[];
  /** The instant of the change when the caller already holds it (the end of an attempt, on the investigation clock); default: now. */
  at?: string;
};
/** The request after an allowed transition: state, timeline entry, `suspension` only while suspended, `end` once terminal. */
function applyTransition(request: TriageRequest, change: TriageTransition, at: string) {
  const entry: TriageTimelineEntry = { at, event: change.event };
  if (change.code) entry.code = change.code;
  if (change.labels) entry.labels = [...change.labels];
  request.state = change.to;
  request.suspension = change.to === 'suspended' ? { code: 'TRIAGE_LABEL_CONFLICT', labels: [...(change.labels ?? [])], since: at } : null;
  request.timeline.push(entry);
  if (isTerminalTriageState(change.to)) request.end = { at, code: change.code ?? change.to.toUpperCase() };
}
type TriageTransitionResult = { kind: 'applied'; request: TriageRequest } | { kind: 'not-applied'; state: TriageRequestState | null };

/**
 * The one way a request changes state, in ONE commit: the current state is revalidated against `from` and the transition table, the
 * timeline, `suspension`, `end` and the live index follow, and `also` lets the caller write its own fields of the request in the same
 * commit (attempts, budget, Verdict, effects). Fields this function does not own are left as they are, so a
 * request that leaves `suspended` keeps whatever it had spent.
 */
export async function transitionTriageRequest(
  session: Session,
  triage_request_id: string,
  change: TriageTransition,
  also?: (request: TriageRequest, tx: Transaction) => void | Promise<void>,
): Promise<TriageTransitionResult> {
  return session.commit(tx => transitionTriageRequestIn(tx, triage_request_id, change, also), BACKGROUND_CONTEXT);
}
/** The same transition inside a commit the caller already holds (an operator command decides and records its receipt in it). */
export async function transitionTriageRequestIn(
  tx: Transaction,
  triage_request_id: string,
  change: TriageTransition,
  also?: (request: TriageRequest, tx: Transaction) => void | Promise<void>,
): Promise<TriageTransitionResult> {
  const document = await tx.doc(triageRequests, triage_request_id, null);
  const request = document.request;
  if (!request) return { kind: 'not-applied' as const, state: null };
  if (!change.from.includes(request.state) || !triageTransitionAllowed(request.state, change.to)) return { kind: 'not-applied' as const, state: request.state };
  applyTransition(request, change, change.at ?? new Date().toISOString());
  if (request.end) {
    const index = await tx.doc(triageIndex);
    index.live = index.live.filter(id => id !== triage_request_id);
  }
  await also?.(request, tx);
  return { kind: 'applied' as const, request: copy(request) };
}

export async function readTriageRequest(session: Session, triage_request_id: string): Promise<TriageRequest | undefined> {
  return (await session.snapshot(triageRequests, triage_request_id, BACKGROUND_CONTEXT))?.request ?? undefined;
}
async function readMany(session: Session, ids: readonly string[]): Promise<TriageRequest[]> {
  const result: TriageRequest[] = [];
  for (const id of ids) {
    const request = await readTriageRequest(session, id);
    if (!request) throw new Error('TRIAGE_INDEX_INCONSISTENT');
    result.push(request);
  }
  return result;
}
/** Every request, in arrival order. */
export async function readTriageRequests(session: Session): Promise<TriageRequest[]> {
  return readMany(session, (await session.snapshot(triageIndex, BACKGROUND_CONTEXT))?.order ?? []);
}
/** The requests not in a terminal state, in arrival order. */
export async function liveTriageRequests(session: Session): Promise<TriageRequest[]> {
  return readMany(session, (await session.snapshot(triageIndex, BACKGROUND_CONTEXT))?.live ?? []);
}
/** The single installation-wide queue: `queued` requests, first arrived first. */
export async function triageQueue(session: Session): Promise<TriageRequest[]> {
  return (await liveTriageRequests(session)).filter(request => request.state === 'queued').sort((a, b) => a.sequence - b.sequence);
}
/** Every request of one Ticket, oldest first (the last one is its latest). */
export async function ticketTriageRequests(session: Session, ticket: TicketRef): Promise<TriageRequest[]> {
  return readMany(session, (await session.snapshot(triageIndex, BACKGROUND_CONTEXT))?.tickets[ticketKey(ticket)] ?? []);
}

/** Changes one attempt of a request in its own commit, whatever the request's state (an attempt outlives an abandoned request). */
export async function updateTriageAttempt(session: Session, triage_request_id: string, attempt: string, change: (attempt: TriageAttempt) => void) {
  return session.commit(async tx => {
    const found = (await tx.doc(triageRequests, triage_request_id, null)).request?.attempts?.find(item => item.attempt === attempt);
    if (found) change(found);
    return found !== undefined;
  }, BACKGROUND_CONTEXT);
}
/**
 * A `queued` request whose Ticket could not be read when its turn came: the code is kept on the request for the operator (`start-held` in
 * the timeline, once per code), nothing is spent and its arrival position stays. Any other state is left as it is.
 */
export async function holdTriageStart(session: Session, triage_request_id: string, code: string, at: string): Promise<void> {
  await session.commit(async tx => {
    const request = (await tx.doc(triageRequests, triage_request_id, null)).request;
    if (request?.state !== 'queued' || request.startHold?.code === code) return;
    request.startHold = { code, since: at };
    request.timeline.push({ at, event: 'start-held', code });
  }, BACKGROUND_CONTEXT);
}
/**
 * The end of one attempt, in ONE commit: its `end`, the timeline (`attempt-ended` with the attempt's code, `capacity-retained`
 * when the stop is not confirmed) and, when the request is still `investigating` (no Verdict moved it on), where it goes: `decide` reads
 * the request with the ended attempt and answers `queued` (event `requeued`) or `failed`. A request already elsewhere (publishing,
 * abandoned) keeps its state. An attempt that already has an end is left as it is (undefined).
 */
export async function endTriageAttempt(
  session: Session,
  triage_request_id: string,
  attempt: string,
  ended: (attempt: TriageAttempt) => NonNullable<TriageAttempt['end']>,
  decide: (request: TriageRequest) => { to: 'queued' } | { to: 'failed'; code: string },
): Promise<TriageRequest | undefined> {
  return session.commit(async tx => {
    const request = (await tx.doc(triageRequests, triage_request_id, null)).request;
    const found = request?.attempts?.find(item => item.attempt === attempt);
    if (!request || !found || found.end) return undefined;
    const end = ended(found);
    found.end = end;
    request.timeline.push({ at: end.at, event: 'attempt-ended', code: end.code, attempt });
    if (!end.cessation.cessationConfirmed) request.timeline.push({ at: end.at, event: 'capacity-retained', code: end.cessation.code, attempt });
    if (request.state === 'investigating') {
      const next = decide(copy(request));
      const from = ['investigating'] as const;
      const change = next.to === 'queued' ? { to: 'queued' as const, event: 'requeued' } : { to: 'failed' as const, event: 'failed', code: next.code };
      await transitionTriageRequestIn(tx, triage_request_id, { from, ...change, at: end.at });
    }
    return copy(request);
  }, BACKGROUND_CONTEXT);
}
/**
 * A later answer to the stop of an ENDED attempt whose cessation was not confirmed. Confirmed: the capacity is free
 * (`capacity-released` in the timeline). Still unconfirmed: only the latest code and instant are kept. Nothing else of the request moves.
 * `false`: the attempt is not ended, or its stop is already confirmed.
 */
export async function recordTriageCessation(
  session: Session,
  triage_request_id: string,
  attempt: string,
  cessation: NonNullable<TriageAttempt['end']>['cessation'],
  at: string,
): Promise<boolean> {
  return session.commit(async tx => {
    const request = (await tx.doc(triageRequests, triage_request_id, null)).request;
    const end = request?.attempts?.find(item => item.attempt === attempt)?.end;
    if (!request || !end || end.cessation.cessationConfirmed) return false;
    end.cessation = cessation;
    end.cessationObservedAt = at;
    // A unit the operator's attestation already freed is not released twice: the confirmation is recorded as what it is.
    if (cessation.cessationConfirmed)
      request.timeline.push({ at, event: end.attestation ? 'stop-confirmed' : 'capacity-released', code: cessation.evidence, attempt });
    return true;
  }, BACKGROUND_CONTEXT);
}
/** The text of the recorded Verdict of a request (undefined: none recorded, or already removed). */
export async function readTriageVerdictText(session: Session, triage_request_id: string): Promise<string | undefined> {
  return (await session.snapshot(triageVerdicts, triage_request_id, BACKGROUND_CONTEXT))?.verdict?.text;
}

/**
 * Changes a request that is still `publishing`, in its own commit (the effects' situation, the publication record). A request
 * that left `publishing` meanwhile is left as it is (`false`).
 */
export async function updatePublishingRequest(session: Session, triage_request_id: string, change: (request: TriageRequest) => void): Promise<boolean> {
  return session.commit(async tx => {
    const request = (await tx.doc(triageRequests, triage_request_id, null)).request;
    if (request?.state !== 'publishing') return false;
    change(request);
    return true;
  }, BACKGROUND_CONTEXT);
}
