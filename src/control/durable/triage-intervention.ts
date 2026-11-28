import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { triageAttemptPattern, triageReferencePattern } from '../../contracts/index.js';
import type { InvestigationRecord, InvestigationStop } from '../../sandbox/index.js';
import type { ControlInput, ControlReceipt, TriageAttempt, TriageInterventionReceipt, TriageRequest } from '../types.js';
import { holdsTriageCapacity, isTerminalTriageState } from '../rules/triage.js';
import { cancelledByOperator, receiptEffects, releaseObservation } from '../rules/triage-intervention.js';
import { resolveTriageRequest } from '../rules/triage-operator.js';
import { readInstallation, requests as acceptedRequests } from './admission.js';
import type { Session } from './store.js';
import { readTriageRequest, readTriageRequests, ticketTriageRequests, transitionTriageRequestIn, triageRequests } from './triage-requests.js';

// The operator's interventions on one Triage request, only from the local CLI: `triage cancel`, `triage
// release` and `triage complete`. Each one is accepted once per request identity (the same identity and content returns the recorded
// receipt, other content is a conflict), decides on the request as it is read inside the commit, and answers `not-applied` with the
// reason when the request had already moved on by itself. None of them writes to a Ticket except `complete`, through the publication.

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
type Refused = { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' };
type Input = Extract<ControlInput, { operation: 'triage-cancel' | 'triage-release' | 'triage-complete' }>;
type Receipt = TriageInterventionReceipt;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The recorded result of a request identity: its receipt for the same content, a conflict for another, undefined when it is new. */
function recordedReceipt<R>(accepted: { input?: unknown; receipt?: unknown }, input: ControlInput): R | Refused | undefined {
  if (!accepted.input) return undefined;
  if (JSON.stringify(accepted.input) !== JSON.stringify(input)) return { kind: 'refused', code: 'REQUEST_ID_CONFLICT' };
  return copy(accepted.receipt) as R;
}
/**
 * Deduplicated acceptance of an operator command, in ONE commit: the same identity and content returns the recorded receipt, other
 * content is `REQUEST_ID_CONFLICT`, and a new identity is decided on what the commit reads and recorded with its receipt.
 */
export async function acceptOnce<I extends ControlInput, R extends ControlReceipt>(
  session: Session,
  input: I,
  decide: (tx: Tx) => Promise<R>,
): Promise<R | Refused> {
  return session.commit(async tx => {
    const accepted = await tx.doc(acceptedRequests, input.request_id, null);
    const known = recordedReceipt<R>(accepted, input);
    if (known) return known;
    const receipt = await decide(tx);
    accepted.input = input;
    accepted.receipt = receipt;
    return copy(receipt);
  }, BACKGROUND_CONTEXT);
}

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const reference = z.string().regex(triageReferencePattern);
const origin = z.literal('local-cli');
const schema = z.discriminatedUnion('operation', [
  z.strictObject({ request_id: requestId, operation: z.literal('triage-cancel'), request: reference, origin }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('triage-release'),
    request: reference,
    attempt: z.string().regex(triageAttemptPattern).max(64),
    reason: z.string().trim().min(1).max(500),
    origin,
  }),
  z.strictObject({ request_id: requestId, operation: z.literal('triage-complete'), request: reference, impediment: z.uuid(), origin }),
]);
/** Whether an operation is one of the three interventions. */
export const isTriageIntervention = (operation: unknown) => operation === 'triage-cancel' || operation === 'triage-release' || operation === 'triage-complete';

const steps = {
  shown: (id: string) => `factory triage ${id} shows the request as it is now.`,
  notFound: 'No Triage request with this id or Ticket reference; use `factory triages`.',
  cancelled:
    'The request is over and nothing was written to the Ticket. needs-triage standing on the Ticket does not request another Triage: remove and reapply it for a new request with a full budget.',
  interrupted: (id: string) =>
    `The request is over and its Triager is being stopped; its unit of Triage capacity is free only once the stop is confirmed (factory triage ${id}).`,
  released: 'The unit of Triage capacity is free; the attempt counts as spent.',
  alive: 'The Factory observes the Triager of this attempt alive and never frees a unit against that; it keeps asking it to stop.',
  paused: 'A paused installation publishes nothing: unpause it (factory unpause) and repeat the command with a new request identity.',
};
/** Why a command did not apply, with what the operator does next. */
const notApplied: Record<string, (id: string) => string> = {
  TRIAGE_REQUEST_NOT_FOUND: () => steps.notFound,
  TRIAGE_ATTEMPT_ALIVE: () => steps.alive,
  TRIAGE_COMPLETE_INSTALLATION_PAUSED: () => steps.paused,
  TRIAGE_IMPEDIMENT_REFERENCE_MISMATCH: id => `This is not the open Impediment of the request; read its reference again: factory triage ${id}.`,
  TRIAGE_IMPEDIMENT_CHANGED: id =>
    `The Ticket changed since this Impediment was shown; nothing was taken as the Factory's and nothing was written. The next poll acts on the Ticket as it is now; then read the request again: factory triage ${id}.`,
};
const conflictStep = (id: string) =>
  `The Ticket no longer allows the effects still to write, so nothing was written and the Impediment stays. Leave a single state label and repeat, or end the request: factory triage cancel ${id}.`;
const conflictCodes = ['TRIAGE_LABEL_CONFLICT', 'TRIAGE_LABELS_CHANGED', 'NEEDS_TRIAGE_REMOVED'];
function nextStepOf(reason: string, id: string | null): string {
  if (id === null) return steps.notFound;
  return conflictCodes.includes(reason) ? conflictStep(id) : (notApplied[reason]?.(id) ?? steps.shown(id));
}

/** The request as a receipt shows it after the command (all null when the command named none). */
function shown(request: TriageRequest | null | undefined): Pick<Receipt, 'triage_request_id' | 'state' | 'endCode' | 'impediment'> {
  if (!request) return { triage_request_id: null, state: null, endCode: null, impediment: null };
  const impediment = request.state === 'publishing' ? request.publication?.impediment : null;
  return { triage_request_id: request.triage_request_id, state: request.state, endCode: request.end?.code ?? null, impediment: impediment?.ref ?? null };
}
function receipt(
  input: Input,
  request: TriageRequest | null | undefined,
  outcome: Receipt['outcome'],
  reason: string | null,
  more: Partial<Receipt> = {},
): Receipt {
  const after = shown(request);
  const id = after.triage_request_id;
  return {
    kind: 'durable',
    request_id: input.request_id,
    operation: input.operation,
    request: input.request,
    ...after,
    outcome,
    reason,
    effects: null,
    attempt: null,
    release: null,
    nextStep: nextStepOf(reason ?? '', id),
    ...more,
  };
}

type Environment = { observe(record: InvestigationRecord): Promise<InvestigationStop>; close(record: InvestigationRecord): Promise<unknown> };
type Completion = { kind: 'completed' } | { kind: 'refused'; code: string };
/** A Control that composes no publication desk (no polling, or no source with Triage) completes nothing. */
const notComposed: Completion = { kind: 'refused', code: 'TRIAGE_PUBLICATION_NOT_COMPOSED' };

export function createTriageInterventions(deps: {
  session: Session;
  now(): number;
  /** The investigation desk of this Control, when it investigates: it stops the attempt of a cancelled request. */
  interrupt?: ((triage_request_id: string) => Promise<void>) | undefined;
  /** The publication desk of this Control, when it publishes. */
  publications: { complete?(triage_request_id: string, ref: string): Promise<Completion>; exclusive?<T>(work: () => Promise<T>): Promise<T> };
  /** The Triage ports, when composed: `triage release` observes the attempt again through their Investigation Environment. */
  ports: { environment: Environment } | undefined;
}) {
  const { session } = deps;
  const environment = deps.ports?.environment;
  const stamp = () => new Date(deps.now()).toISOString();
  const exclusive = <T>(work: () => Promise<T>) => deps.publications.exclusive?.(work) ?? work();

  /** The id of the request a command names: its id, or a Ticket reference, which is the Ticket's latest request. */
  const named = async (reference: string) => resolveTriageRequest(await readTriageRequests(session), reference)?.triage_request_id;
  const inCommit = async (tx: Tx, id: string | undefined) => (id ? (await tx.doc(triageRequests, id, null)).request : null);

  /**
   * `triage cancel`: any live state ends `abandoned` with `CANCELLED_BY_OPERATOR`, in the commit that records the receipt, so the intent
   * is durable before anything is interrupted. Nothing is written to the Ticket and the balance is dropped. The attempt of a request
   * under investigation is stopped after the commit and keeps its unit until that stop is confirmed.
   */
  async function cancel(input: Input & { operation: 'triage-cancel' }) {
    const id = await named(input.request);
    const result = await exclusive(() =>
      acceptOnce(session, input, async tx => {
        const request = await inCommit(tx, id);
        if (!request) return receipt(input, null, 'not-applied', 'TRIAGE_REQUEST_NOT_FOUND');
        if (isTerminalTriageState(request.state)) return receipt(input, request, 'not-applied', 'TRIAGE_REQUEST_ALREADY_ENDED');
        const effects = request.state === 'publishing' ? receiptEffects(request.intended ?? []) : null;
        const attempt = request.attempts?.find(item => !item.end)?.attempt ?? null;
        const moved = await transitionTriageRequestIn(
          tx,
          request.triage_request_id,
          { from: [request.state], to: 'abandoned', event: 'cancelled', code: cancelledByOperator },
          current => {
            // The request is over: its publication is no longer stopped for the operator, and its effects stay as the last read left them.
            if (current.publication) Object.assign(current.publication, { impediment: null, hold: null });
          },
        );
        if (moved.kind !== 'applied') return receipt(input, request, 'not-applied', 'TRIAGE_REQUEST_ALREADY_ENDED');
        const nextStep = attempt ? steps.interrupted(request.triage_request_id) : steps.cancelled;
        return receipt(input, moved.request, 'accepted', null, { effects, attempt, nextStep });
      }),
    );
    // After the receipt: the answer never waits for the stop, which the environment may take long to confirm.
    if (result.kind === 'durable' && result.attempt && result.triage_request_id) void deps.interrupt?.(result.triage_request_id).catch(() => {});
    return result;
  }

  /** The request that holds the named attempt: the named request, or for a Ticket reference whichever request of that Ticket has it. */
  async function holding(reference: string, attempt: string): Promise<TriageRequest | undefined> {
    const id = await named(reference);
    const request = id ? await readTriageRequest(session, id) : undefined;
    if (!request || request.triage_request_id === reference.toLowerCase()) return request;
    const family = await ticketTriageRequests(session, request.ticket);
    return family.findLast(item => item.attempts?.some(found => found.attempt === attempt)) ?? request;
  }
  type Ended = NonNullable<TriageAttempt['end']>;
  /** The named attempt when it is ended and still holds its unit, or why there is nothing to release. */
  function retained(request: TriageRequest | null | undefined, ref: string): { attempt: TriageAttempt; end: Ended } | string {
    if (!request) return 'TRIAGE_REQUEST_NOT_FOUND';
    const attempt = request.attempts?.find(item => item.attempt === ref);
    if (!attempt) return 'TRIAGE_ATTEMPT_NOT_FOUND';
    if (!attempt.end) return 'TRIAGE_ATTEMPT_NOT_ENDED';
    return holdsTriageCapacity(attempt) ? { attempt, end: attempt.end } : 'TRIAGE_CAPACITY_NOT_RETAINED';
  }
  const observeAgain = async (record: InvestigationRecord): Promise<InvestigationStop | { cessationConfirmed: false; code: string }> =>
    environment
      ? environment.observe(record).catch(() => ({ cessationConfirmed: false as const, code: 'INVESTIGATION_MANAGER_UNAVAILABLE' as const }))
      : { cessationConfirmed: false, code: 'INVESTIGATION_ENVIRONMENT_NOT_COMPOSED' };
  type Observed = Awaited<ReturnType<typeof observeAgain>>;
  /** Frees the unit in the commit, on the evidence of a confirmed stop or else on the operator's attestation; says on what basis. */
  function free(request: TriageRequest, attempt: string, end: Ended, observed: Observed, input: Input & { operation: 'triage-release' }): Receipt['release'] {
    const at = stamp();
    if (observed.cessationConfirmed) {
      Object.assign(end, { cessation: observed, cessationObservedAt: at });
      request.timeline.push({ at, event: 'capacity-released', code: observed.evidence, attempt });
      return { basis: 'stop-confirmed', observed: observed.evidence, author: null, at };
    }
    const author = 'local-operator' as const;
    end.attestation = { author, reason: input.reason, at, observed: observed.code, request_id: input.request_id };
    request.timeline.push({ at, event: 'capacity-released', code: 'OPERATOR_ATTESTATION', attempt, author, reason: input.reason });
    return { basis: 'operator-attestation', observed: observed.code, author, at };
  }
  /**
   * `triage release`: the last resort for a retained unit of Triage capacity, also of a request already terminal. The Factory observes the
   * attempt again first: alive, it refuses; confirmed stopped, it frees the unit on that evidence; nothing observable, it takes the
   * operator's attestation and records its author, reason and instant. The attempt was already spent when it ended.
   */
  async function release(input: Input & { operation: 'triage-release' }) {
    const read = await holding(input.request, input.attempt);
    const before = retained(read, input.attempt);
    const observed = typeof before === 'string' ? null : await observeAgain(before.attempt.environment);
    const result = await acceptOnce(session, input, async tx => {
      // Decided on the attempt as the commit reads it; one that only ended after the observation is not released on no observation.
      const request = await inCommit(tx, read?.triage_request_id);
      const now = retained(request, input.attempt);
      if (typeof now === 'string' || !request) return receipt(input, request, 'not-applied', typeof now === 'string' ? now : 'TRIAGE_REQUEST_NOT_FOUND');
      const attempt = now.attempt.attempt;
      if (!observed) return receipt(input, request, 'not-applied', 'TRIAGE_ATTEMPT_NOT_ENDED', { attempt });
      if (releaseObservation(observed) === 'alive') return receipt(input, request, 'not-applied', 'TRIAGE_ATTEMPT_ALIVE', { attempt });
      return receipt(input, request, 'accepted', null, { attempt, release: free(request, attempt, now.end, observed, input), nextStep: steps.released });
    });
    // A confirmed stop also lets the attempt's directories go, as at any reconciliation.
    if (typeof before !== 'string' && result.kind === 'durable' && result.release?.basis === 'stop-confirmed')
      await environment?.close(before.attempt.environment).catch(() => {});
    return result;
  }

  /** What `complete` did, read from the request after it: `concluded`, `abandoned` with its discarded effects, or still `publishing`. */
  async function completed(input: Input, id: string): Promise<Receipt> {
    const request = await readTriageRequest(session, id);
    return receipt(input, request, 'accepted', null, { effects: receiptEffects(request?.intended ?? []) });
  }
  /** The publication of the named request with the Impediment's effects taken as the Factory's, or why it was refused. */
  async function complete(input: Input & { operation: 'triage-complete' }, id: string | undefined): Promise<Receipt> {
    const request = id ? await readTriageRequest(session, id) : undefined;
    if (!request) return receipt(input, null, 'not-applied', 'TRIAGE_REQUEST_NOT_FOUND');
    // Read at the decision, never cached: a paused installation publishes nothing, and says so with its own code.
    if ((await readInstallation(session)).paused) return receipt(input, request, 'not-applied', 'TRIAGE_COMPLETE_INSTALLATION_PAUSED');
    const result = (await deps.publications.complete?.(request.triage_request_id, input.impediment)) ?? notComposed;
    if (result.kind === 'completed') return completed(input, request.triage_request_id);
    return receipt(input, await readTriageRequest(session, request.triage_request_id), 'not-applied', result.code);
  }
  /**
   * `triage complete`: it reads and writes the Ticket, so it cannot be one commit. It takes the publication's turn, answers a known
   * identity with its recorded receipt, and otherwise records the receipt of what it did once it is done.
   */
  async function acceptComplete(input: Input & { operation: 'triage-complete' }) {
    const id = await named(input.request);
    return exclusive(async () => {
      const accepted = await session.snapshot(acceptedRequests, input.request_id, BACKGROUND_CONTEXT);
      const known = recordedReceipt<Receipt>(accepted ?? {}, input);
      if (known) return known;
      const done = await complete(input, id);
      return acceptOnce(session, input, async () => done);
    });
  }

  return {
    async accept(input: ControlInput): Promise<Receipt | Refused> {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'INVALID_COMMAND' };
      const command = parsed.data;
      if (command.operation === 'triage-cancel') return cancel(command);
      return command.operation === 'triage-release' ? release(command) : acceptComplete(command);
    },
  };
}
