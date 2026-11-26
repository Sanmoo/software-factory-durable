import { randomUUID } from 'node:crypto';
import type { TrackerKind } from '../../issue-tracker/index.js';
import type { TriagePublication, TriagePublicationImpediment, TriageRequest } from '../types.js';
import {
  publicationStep,
  triageComment,
  type PublicationFacts,
  type PublicationMode,
  type PublicationNext,
  type PublicationStep,
} from '../rules/triage-publication.js';
import type { TriageRoles } from '../rules/triage.js';
import type { TriageIntendedEffect } from '../rules/triage-verdict.js';
import { indexedWork } from './admission.js';
import type { Session } from './store.js';
import { liveTriageRequests, readTriageRequest, readTriageVerdictText, transitionTriageRequest, updatePublishingRequest } from './triage-requests.js';

// Spec #68 §8 (ticket #77): the publication of a recorded Verdict, common to both trackers. A request in `publishing` is driven from a
// fresh read of its Ticket before EVERY write: the pure rule decides the single next move, the attempt is committed before the write is
// sent, and an effect is confirmed only by the next read, never by the answer of the write. So a restart, a lost answer or a killed
// controller all recover the same way: read, recognise the Factory's own effects, write only what is missing. No model is ever called.

/**
 * What one tracker gives the publication (GitHub here; ticket #78 adds the Card's). It reports facts and sends writes; every decision
 * is `publicationStep`'s.
 */
export type TriagePublisher = {
  /** Characters one comment of the tracker holds; a larger comment is refused whole. */
  commentLimit: number;
  caseSensitive: boolean;
  /** The state labels of the request's source; undefined while its `triage` block is not there or not available (nothing is published). */
  roles(request: TriageRequest): TriageRoles | undefined;
  /** The write units of the intended effects, in order: the indexes one request to the tracker carries. */
  groups(intended: readonly TriageIntendedEffect[]): number[][];
  /** A fresh read of the Ticket. `comment`: the body this publication sends, to recognise the request's own comment by content. */
  observe(
    request: TriageRequest,
    comment: string,
  ): Promise<{ kind: 'observed'; facts: Omit<PublicationFacts, 'hasWork'> } | { kind: 'unavailable'; code: string }>;
  /** Sends one write unit. `accepted` proves nothing until a read shows the effect. */
  write(request: TriageRequest, group: readonly number[], comment: string): Promise<{ kind: 'accepted' } | { kind: 'failed' | 'unknown'; code: string }>;
};

const ambiguousNextStep = (triage_request_id: string, ref: string) =>
  'An effect of this publication is on the Ticket and the origin does not say who made it; nothing more is written. Inspect the Ticket, then: ' +
  `factory triage complete ${triage_request_id} --impediment ${ref} (takes it as the Factory’s and completes what is missing), or ` +
  `factory triage cancel ${triage_request_id} (ends the request with nothing more written).`;
const empty: TriagePublication = { mode: null, startedAt: null, impediment: null, hold: null };
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createTriagePublications(deps: { session: Session; stopped(): boolean; publishers: Partial<Record<TrackerKind, TriagePublisher>> }) {
  const { session } = deps;

  /** Records the effects and the publication of a request still `publishing`; an unchanged record costs no commit. */
  async function record(
    request: TriageRequest,
    effects: readonly TriageIntendedEffect[],
    publication: TriagePublication,
    event?: { event: string; code?: string },
  ) {
    if (!event && sameJson(request.intended, effects) && sameJson(request.publication ?? empty, publication)) return;
    await updatePublishingRequest(session, request.triage_request_id, current => {
      current.intended = structuredClone(effects) as TriageIntendedEffect[];
      current.publication = structuredClone(publication);
      if (event) current.timeline.push({ at: new Date().toISOString(), ...event });
    });
  }
  /** A pass that could not go on: the code is kept (with the instant it was first seen) until a pass goes on. */
  const held = (request: TriageRequest, effects: readonly TriageIntendedEffect[], publication: TriagePublication, code: string) =>
    record(request, effects, { ...publication, hold: publication.hold?.code === code ? publication.hold : { code, at: new Date().toISOString() } });

  async function commentOf(request: TriageRequest, mode: PublicationMode, limit: number): Promise<string | { code: string }> {
    const text = await readTriageVerdictText(session, request.triage_request_id);
    if (text === undefined || !request.verdict || !request.intended) return { code: 'TRIAGE_VERDICT_TEXT_MISSING' };
    const { outcome, category } = request.verdict;
    const comment = triageComment({ triage_request_id: request.triage_request_id, mode, outcome, category, text, intended: request.intended, limit });
    // Never cut: a comment the tracker cannot hold is not published at all, and the operator sees why.
    return comment.kind === 'comment' ? comment.body : { code: 'TRIAGE_COMMENT_TOO_LARGE' };
  }

  /** The request leaves `publishing`, with its effects as the last read left them, in ONE commit. */
  async function leave(request: TriageRequest, step: PublicationStep, next: Extract<PublicationNext, { action: 'end' | 'suspend' }>) {
    const change =
      next.action === 'suspend'
        ? { to: 'suspended' as const, event: 'suspended', code: 'TRIAGE_LABEL_CONFLICT', labels: next.labels }
        : { to: next.to, event: next.to === 'concluded' ? 'published' : 'publication-abandoned', code: next.code };
    await transitionTriageRequest(session, request.triage_request_id, { from: ['publishing'], ...change }, current => {
      current.intended = structuredClone(step.effects);
      current.publication = { ...(current.publication ?? empty), mode: step.mode, impediment: null, hold: null };
    });
  }

  /** The publication stops for the operator; the same ambiguous effects keep the same Impediment reference across passes. */
  async function impede(request: TriageRequest, step: PublicationStep, publication: TriagePublication, effects: number[]) {
    const known = publication.impediment && sameJson(publication.impediment.effects, effects) ? publication.impediment : null;
    const ref = randomUUID();
    const impediment: TriagePublicationImpediment = known ?? {
      ref,
      code: 'TRIAGE_EFFECT_AUTHORSHIP_AMBIGUOUS',
      since: new Date().toISOString(),
      effects,
      nextStep: ambiguousNextStep(request.triage_request_id, ref),
    };
    const event = known ? undefined : { event: 'publication-impeded', code: impediment.code };
    await record(request, step.effects, { ...publication, hold: null, impediment }, event);
  }

  /**
   * The attempt is committed BEFORE the write is sent (so an effect found later without it is never taken as the Factory's), then the
   * unit is written once. Whatever the tracker answers, only the next read confirms.
   */
  async function write(
    publisher: TriagePublisher,
    request: TriageRequest,
    step: PublicationStep,
    next: Extract<PublicationNext, { action: 'write' }>,
    comment: string,
  ) {
    const at = new Date().toISOString();
    const effects = step.effects.map((effect, index) =>
      next.group.includes(index) ? { ...effect, attempts: (effect.attempts ?? 0) + 1, attemptedAt: at } : effect,
    );
    const started = request.publication?.startedAt ?? null;
    const publication: TriagePublication = { mode: next.mode, startedAt: started ?? at, impediment: null, hold: null };
    await record(request, effects, publication, started ? undefined : { event: 'publication-started', code: next.mode });
    const result = await publisher.write(request, next.group, comment).catch(() => ({ kind: 'unknown' as const, code: 'TRIAGE_WRITE_FAILED' }));
    if (result.kind !== 'accepted') await held({ ...request, intended: effects, publication }, effects, publication, result.code);
  }

  type Turn = { request: TriageRequest; intended: TriageIntendedEffect[]; publisher: TriagePublisher; roles: TriageRoles; publication: TriagePublication };
  /** The request as it is now, while it is `publishing` in a source whose tracker and `triage` block are composed. */
  async function turnOf(triage_request_id: string): Promise<Turn | undefined> {
    const request = await readTriageRequest(session, triage_request_id);
    if (request?.state !== 'publishing' || !request.intended) return undefined;
    const publisher = deps.publishers[request.ticket.tracker];
    const roles = publisher?.roles(request);
    return publisher && roles ? { request, intended: request.intended, publisher, roles, publication: request.publication ?? empty } : undefined;
  }
  /** A fresh read of the Ticket and the rule's next move; a read that did not observe holds the pass and decides nothing. */
  async function decide(turn: Turn, expected: string, ambiguousAsOwn: boolean): Promise<PublicationStep | undefined> {
    const { request, publisher, publication } = turn;
    const observed = await publisher.observe(request, expected).catch(() => ({ kind: 'unavailable' as const, code: 'POLLING_QUERY_FAILED' }));
    if (observed.kind !== 'observed') {
      await held(request, turn.intended, publication, observed.code);
      return undefined;
    }
    return publicationStep({
      roles: turn.roles,
      caseSensitive: publisher.caseSensitive,
      mode: publication.mode,
      intended: turn.intended,
      facts: { ...observed.facts, hasWork: (await indexedWork(session, request.ticket)) !== undefined },
      groups: publisher.groups(turn.intended),
      at: new Date().toISOString(),
      ambiguousAsOwn,
    });
  }
  /** Carries out the move. `true`: a unit was written and the Ticket must be read again; `false`: this pass can do no more. */
  async function act(turn: Turn, step: PublicationStep, expected: string, written: Set<number>): Promise<boolean> {
    const { request, publication } = turn;
    const { next } = step;
    const waiting = { ...publication, impediment: null };
    if (next.action === 'end' || next.action === 'suspend') await leave(request, step, next);
    else if (next.action === 'impediment') await impede(request, step, publication, next.effects);
    else if (next.action === 'wait') await held(request, step.effects, waiting, 'TRIAGE_EFFECT_AUTHOR_NOT_VISIBLE');
    // Written in this pass and not shown by the read after it: the effect stays pending and the next pass writes it again.
    else if (next.group.some(index => written.has(index))) await held(request, step.effects, waiting, publication.hold?.code ?? 'TRIAGE_EFFECT_NOT_CONFIRMED');
    else return send(turn, step, next, expected, written);
    return false;
  }
  /** Sends the unit with the comment of its mode (the informative one is composed only when the publication starts in that mode). */
  async function send(turn: Turn, step: PublicationStep, next: Extract<PublicationNext, { action: 'write' }>, expected: string, written: Set<number>) {
    const { request, publisher, publication } = turn;
    const comment = next.mode === (publication.mode ?? 'verdict') ? expected : await commentOf(request, next.mode, publisher.commentLimit);
    if (typeof comment !== 'string') {
      await held(request, step.effects, publication, comment.code);
      return false;
    }
    await write(publisher, request, step, next, comment);
    for (const index of next.group) written.add(index);
    return true;
  }

  /** One request, until it leaves `publishing` or a pass can do no more: at most one write per unit and per pass. */
  async function publish(triage_request_id: string, options: { ambiguousAsOwn?: boolean } = {}) {
    const written = new Set<number>();
    while (!deps.stopped()) {
      const turn = await turnOf(triage_request_id);
      if (!turn) return;
      const expected = await commentOf(turn.request, turn.publication.mode ?? 'verdict', turn.publisher.commentLimit);
      if (typeof expected !== 'string') return held(turn.request, turn.intended, turn.publication, expected.code);
      const step = await decide(turn, expected, options.ambiguousAsOwn ?? false);
      if (!step || !(await act(turn, step, expected, written))) return;
    }
  }

  return {
    /**
     * One pass, after each polling cycle: every request in `publishing`, in arrival order. Ticket #82 holds the pass here while the
     * installation is paused (spec §11: a paused installation publishes no Verdict).
     */
    async pass() {
      for (const request of await liveTriageRequests(session))
        if (request.state === 'publishing' && !deps.stopped()) await publish(request.triage_request_id).catch(() => {});
    },
    /**
     * Drives one request now. `ambiguousAsOwn` is the operator's `triage complete` (ticket #81): effects without an attributable author
     * are taken as the Factory's, under every other rule of the publication.
     */
    publish,
  };
}
export type TriagePublications = ReturnType<typeof createTriagePublications>;
