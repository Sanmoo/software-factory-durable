import { randomUUID } from 'node:crypto';
import type { TrackerKind } from '../../issue-tracker/index.js';
import type { TriagePublication, TriagePublicationImpediment, TriageRequest } from '../types.js';
import {
  publicationStep,
  triageComment,
  type CardRoute,
  type PublicationFacts,
  type PublicationMode,
  type PublicationNext,
  type PublicationStep,
  type RouteFallback,
  type TriageCommentInput,
} from '../rules/triage-publication.js';
import type { TriageRoles } from '../rules/triage.js';
import { intendedChanges, type TriageIntendedEffect } from '../rules/triage-verdict.js';
import { indexedWork } from './admission.js';
import type { Session } from './store.js';
import { liveTriageRequests, readTriageRequest, readTriageVerdictText, transitionTriageRequest, updatePublishingRequest } from './triage-requests.js';

// Spec #68 §8 (ticket #77): the publication of a recorded Verdict, common to both trackers. A request in `publishing` is driven from a
// fresh read of its Ticket before EVERY write: the pure rule decides the single next move, the attempt is committed before the write is
// sent, and an effect is confirmed only by the next read, never by the answer of the write. So a restart, a lost answer or a killed
// controller all recover the same way: read, recognise the Factory's own effects, write only what is missing. No model is ever called.

/**
 * What one tracker gives the publication (an issue's in `triage-publication-github.ts`, a Card's in `triage-publication-jira.ts`). It
 * reports facts and sends writes; every decision is a pure rule's (`publicationStep`, `cardRoute`).
 */
export type TriagePublisher = {
  /** Characters one comment of the tracker holds; a larger comment is refused whole. */
  commentLimit: number;
  /** Lines one comment may have, where the tracker stores a block per line; absent = any. */
  commentMaxLines?: number;
  caseSensitive: boolean;
  /**
   * Only where `ready-for-agent` depends on a route (a Card, spec §8 "Rota no Jira"). `check`: the route from a fresh read of the
   * Ticket, asked before the first write. `repositoryOf`: the repository a component routes to (null: none authorized).
   */
  route?: {
    check(request: TriageRequest): Promise<CardRoute | { kind: 'unavailable'; code: string }>;
    repositoryOf(request: TriageRequest, componentId: string): string | null;
  };
  /** The state labels of the request's source; undefined while its `triage` block is not there or not available (nothing is published). */
  roles(request: TriageRequest): TriageRoles | undefined;
  /** The write units of the intended effects, in order: the indexes one request to the tracker carries. */
  groups(intended: readonly TriageIntendedEffect[]): number[][];
  /** A fresh read of the Ticket. `comment`: the body this publication sends, to recognise the request's own comment by content. */
  observe(
    request: TriageRequest,
    comment: string,
  ): Promise<{ kind: 'observed'; facts: Omit<PublicationFacts, 'hasWork'> } | { kind: 'unavailable'; code: string }>;
  /**
   * Sends one write unit. `accepted` proves nothing until a read shows the effect. `fallback`: the tracker refused the unit that would
   * give the Ticket its route, nothing of it was applied, and the outcome falls to `needs-info`.
   */
  write(
    request: TriageRequest,
    group: readonly number[],
    comment: string,
  ): Promise<{ kind: 'accepted' } | { kind: 'failed' | 'unknown'; code: string; fallback?: RouteFallback }>;
};

const ambiguousNextStep = (triage_request_id: string, ref: string) =>
  'An effect of this publication is on the Ticket and the origin does not say who made it; nothing more is written. Inspect the Ticket, then: ' +
  `factory triage complete ${triage_request_id} --impediment ${ref} (takes it as the Factory’s and completes what is missing), or ` +
  `factory triage cancel ${triage_request_id} (ends the request with nothing more written).`;
const empty: TriagePublication = { mode: null, startedAt: null, impediment: null, hold: null };
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createTriagePublications(deps: {
  session: Session;
  stopped(): boolean;
  /** Whether the installation is paused, read from the installation document each time it is asked. */
  paused(): Promise<boolean>;
  publishers: Partial<Record<TrackerKind, TriagePublisher>>;
}) {
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

  /**
   * What the comment says of the outcome. After a fallback that came when the comment was already published, it is still composed as it
   * was sent (the Triager's outcome, with the component the edit would add): the one comment is recognised, never written twice.
   */
  function commentSubject(turn: Turn): Pick<TriageCommentInput, 'outcome' | 'intended' | 'route'> | undefined {
    const { request, roles, publisher } = turn;
    const { verdict } = request;
    if (!verdict) return undefined;
    const labels = { admission: roles.admission, needsInfo: roles.needsInfo };
    const { fallback, component } = verdict;
    const adds = (componentId: string, repository: string | null | undefined) =>
      repository ? { route: { ...labels, kind: 'adds' as const, componentId, repository } } : {};
    if (fallback?.afterComment && component) {
      const intended = intendedChanges({ outcome: fallback.from, component }, roles, request.ticket.tracker);
      return { outcome: fallback.from, intended, ...adds(component, fallback.repository) };
    }
    if (fallback) {
      const { code, componentId, repository } = fallback;
      return { outcome: verdict.outcome, intended: turn.intended, route: { ...labels, kind: 'fallback', code, componentId, repository } };
    }
    const added = turn.intended.find(effect => effect.kind === 'add-component');
    return {
      outcome: verdict.outcome,
      intended: turn.intended,
      ...(added ? adds(added.componentId, publisher.route?.repositoryOf(request, added.componentId)) : {}),
    };
  }
  async function commentOf(turn: Turn, mode: PublicationMode): Promise<string | { code: string }> {
    const { request, publisher } = turn;
    const text = await readTriageVerdictText(session, request.triage_request_id);
    const subject = commentSubject(turn);
    if (text === undefined || !request.verdict || !subject) return { code: 'TRIAGE_VERDICT_TEXT_MISSING' };
    const comment = triageComment({
      triage_request_id: request.triage_request_id,
      mode,
      category: request.verdict.category,
      text,
      ...subject,
      limit: publisher.commentLimit,
      ...(publisher.commentMaxLines === undefined ? {} : { maxLines: publisher.commentMaxLines }),
    });
    // Never cut: a comment the tracker cannot hold is not published at all, and the operator sees why.
    return comment.kind === 'comment' ? comment.body : { code: 'TRIAGE_COMMENT_TOO_LARGE' };
  }

  /** The outcome of a request still `publishing` falls to `needs-info` (spec §8, "Rota no Jira"), in ONE commit with its new effects. */
  async function fallBack(turn: Turn, fallback: RouteFallback, written: { observed: string } | null) {
    const at = new Date().toISOString();
    const effects = intendedChanges({ outcome: 'needs-info', component: null }, turn.roles, turn.request.ticket.tracker);
    await updatePublishingRequest(session, turn.request.triage_request_id, current => {
      if (!current.verdict || !current.intended) return;
      const from = current.verdict.outcome;
      current.verdict.outcome = 'needs-info';
      current.verdict.fallback = { from, ...fallback, at, afterComment: written !== null, ...(written ?? {}) };
      // The comment already published stays as the read left it; the label effects are the new outcome's, not yet attempted.
      current.intended = written ? [...current.intended.slice(0, 1), ...effects.slice(1)] : effects;
      if (current.publication) current.publication.hold = null;
      current.timeline.push({ at, event: 'outcome-fallback', code: fallback.code });
    });
  }
  /** The route port of the tracker, only for the first write of a `ready-for-agent` Verdict (nothing was attempted yet). */
  const routeOf = (turn: Turn, step: PublicationStep) =>
    step.next.action === 'write' && step.mode === 'verdict' && turn.publication.mode === null && turn.request.verdict?.outcome === 'ready-for-agent'
      ? turn.publisher.route
      : undefined;
  /**
   * Before the first write of a `ready-for-agent` Verdict where it needs a route: the effects follow a fresh read of the Ticket (the
   * component is written only when the Card has no routed one), or the outcome falls to `needs-info`. `changed`: read the request again.
   */
  async function routed(turn: Turn, step: PublicationStep): Promise<'same' | 'changed' | 'held'> {
    const { request, roles } = turn;
    const port = routeOf(turn, step);
    if (!port) return 'same';
    const route = await port.check(request).catch(() => ({ kind: 'unavailable' as const, code: 'POLLING_QUERY_FAILED' }));
    if (route.kind === 'unavailable') {
      await held(request, turn.intended, turn.publication, route.code);
      return 'held';
    }
    if (route.kind === 'fallback') {
      const { code, componentId, repository } = route;
      await fallBack(turn, { code, componentId, repository }, null);
      return 'changed';
    }
    const component = route.addComponent ? (request.verdict?.component ?? null) : null;
    const effects = intendedChanges({ outcome: 'ready-for-agent', component }, roles, request.ticket.tracker);
    if (sameJson(effects, turn.intended)) return 'same';
    await record(request, effects, turn.publication);
    return 'changed';
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
  async function write(turn: Turn, step: PublicationStep, next: Extract<PublicationNext, { action: 'write' }>, comment: string): Promise<'sent' | 'fell-back'> {
    const { publisher, request } = turn;
    const at = new Date().toISOString();
    const effects = step.effects.map((effect, index) =>
      next.group.includes(index) ? { ...effect, attempts: (effect.attempts ?? 0) + 1, attemptedAt: at } : effect,
    );
    const started = request.publication?.startedAt ?? null;
    const publication: TriagePublication = { mode: next.mode, startedAt: started ?? at, impediment: null, hold: null };
    await record(request, effects, publication, started ? undefined : { event: 'publication-started', code: next.mode });
    const result = await publisher.write(request, next.group, comment).catch(() => ({ kind: 'unknown' as const, code: 'TRIAGE_WRITE_FAILED' }));
    if (result.kind === 'failed' && result.fallback) {
      await fallBack(turn, result.fallback, { observed: result.code });
      return 'fell-back';
    }
    if (result.kind !== 'accepted') await held({ ...request, intended: effects, publication }, effects, publication, result.code);
    return 'sent';
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
    const { request, publication } = turn;
    const comment = next.mode === (publication.mode ?? 'verdict') ? expected : await commentOf(turn, next.mode);
    if (typeof comment !== 'string') {
      await held(request, step.effects, publication, comment.code);
      return false;
    }
    // After a fallback the effects of the unit are new ones, not yet attempted: the same pass writes them.
    if ((await write(turn, step, next, comment)) === 'sent') for (const index of next.group) written.add(index);
    return true;
  }

  /** One fresh read of the request and its single next move. `true`: something changed and the request must be read again. */
  async function advance(triage_request_id: string, ambiguousAsOwn: boolean, written: Set<number>): Promise<boolean> {
    const turn = await turnOf(triage_request_id);
    if (!turn) return false;
    const expected = await commentOf(turn, turn.publication.mode ?? 'verdict');
    if (typeof expected !== 'string') {
      await held(turn.request, turn.intended, turn.publication, expected.code);
      return false;
    }
    const step = await decide(turn, expected, ambiguousAsOwn);
    if (!step) return false;
    const route = await routed(turn, step);
    return route === 'same' ? act(turn, step, expected, written) : route === 'changed';
  }
  /** One request, until it leaves `publishing` or a pass can do no more: at most one write per unit and per pass. */
  async function publish(triage_request_id: string, options: { ambiguousAsOwn?: boolean } = {}) {
    const written = new Set<number>();
    while (!deps.stopped() && (await advance(triage_request_id, options.ambiguousAsOwn ?? false, written)));
  }

  return {
    /**
     * One pass, after each polling cycle: every request in `publishing`, in arrival order. A paused installation publishes no Verdict
     * (spec §11, ticket #82): the pause is read before each request, so the recorded Verdicts wait as they are and nothing is read from
     * or written to their Tickets until the installation is unpaused.
     */
    async pass() {
      for (const request of await liveTriageRequests(session)) {
        if (deps.stopped() || (await deps.paused())) return;
        if (request.state === 'publishing') await publish(request.triage_request_id).catch(() => {});
      }
    },
    /**
     * Drives one request now. `ambiguousAsOwn` is the operator's `triage complete` (ticket #81): effects without an attributable author
     * are taken as the Factory's, under every other rule of the publication. It does not read the pause: the command that calls it
     * refuses a paused installation first, with its own code.
     */
    publish,
  };
}
export type TriagePublications = ReturnType<typeof createTriagePublications>;
