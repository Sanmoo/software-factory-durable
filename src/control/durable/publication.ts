import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionView, PublicationDiscovery, PublicationView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { descriptionCheck, guestEffectOutOfScope, publicationAttempted, publicationMarker, publicationStep, publishableContent, type DiscoveryDecision } from '../rules/publication.js';
import { ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

// Durable commits of ticket 14's publication dimension (spec §3.3/§9.1). Every remote observation happens OUTSIDE these commits; each
// commit re-checks that the Work, its basis and the Execution it observed are still the same before recording anything.

const history = (work: WorkRecord, event: Extract<WorkRecord['history'][number], { origin: 'controller-publication' }>['event'], executionId: string | null, detail: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-publication', executionId, detail: detail.slice(0, 512) });
const executions = (work: WorkRecord) => [...(work.previousExecutions ?? []), ...(work.execution ? [work.execution] : [])];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const publicationImpediment = 'PUBLICATION_BLOCKED';
export const guestEffectImpediment = 'GUEST_EFFECT_OUT_OF_SCOPE';

/** `reconcile`: the discovery/observation commits, also allowed on a cancelled or closed-unmerged Work (review MED: never a request/advance). */
async function onWork<T>(session: Session, work_id: string, change: (work: WorkRecord) => T, reconcile = false): Promise<T | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    // Ticket 25: a cancelled Work's attempted publication is still reconciled (publicationStep gates what may happen to it).
    const ended = work?.result === 'cancelled' || work?.result === 'closed-unmerged';
    if (!work || !(work.result === 'open' || (reconcile && ended)) || (index.tickets[ticketKey(work.ticket)]?.current !== work_id && !(reconcile && work.result === 'cancelled'))) return 'stale' as const;
    return change(work);
  }, BACKGROUND_CONTEXT);
}

/**
 * Records the publication basis of a NEW completed implementation Execution: `awaiting-discovery` with the verified content (ticket 13's
 * verification) or `not-publishable` with its reasons. Never requests anything by itself: the discovery decides.
 */
export async function evaluatePublication(session: Session, work_id: string, basisExecutionId: string): Promise<PublicationView | 'stale'> {
  return onWork(session, work_id, work => {
    const step = publicationStep(work);
    const basis = executions(work).find(item => item.executionId === basisExecutionId);
    if (step.kind !== 'evaluate' || step.basisExecutionId !== basisExecutionId || !basis) return 'stale' as const;
    const decision = publishableContent(basis);
    const now = new Date().toISOString();
    const earlier = work.publication ?? null;
    // Attempts, linked heads and the linked own PR survive a new basis: an attempted head is never requested again, and a later verified
    // head updates the same own PR instead of creating another.
    work.publication = { state: decision.ok ? 'awaiting-discovery' : 'not-publishable', basisExecutionId, marker: publicationMarker(work.work_id),
      branch: basis.request.branch, base: basis.request.base, verified: decision.ok ? decision.verified : null, expectedRemote: null, requestedAt: null,
      pullRequest: earlier?.pullRequest ?? null, description: earlier?.description ?? null, discoveries: earlier?.discoveries ?? [],
      attempts: earlier?.attempts ?? [], linkedHeads: earlier?.linkedHeads ?? [], refsBefore: null, update: null, reasons: decision.ok ? [] : decision.reasons,
      nextStep: decision.ok ? 'The own publication is discovered (Git remote + pull requests) before anything is requested.'
        : 'Nothing is published: the Execution content is not verified (reasons). A new verified Execution (correction/scope update) is needed.', updatedAt: now };
    history(work, 'publication-evaluated', basisExecutionId, `${work.publication.state}${decision.ok ? `:${decision.verified.head}` : `:${decision.reasons.join(',')}`}`);
    return copy(work.publication);
  });
}

/**
 * The publication activation is ATTEMPTED from its activation commit ("activation-requested", before any launch or receipt): from now on
 * only a discovery after cessation decides, and this verified head is never requested again, whatever happens to the receipt.
 */
export function markPublicationAttempt(work: WorkRecord, execution: ExecutionView, at: string) {
  const publication = work.publication;
  const request = execution.request.publication;
  if (!request || !publication || publication.state !== 'requested' || publication.basisExecutionId !== request.basisExecutionId) return;
  publication.attempts = [...(publication.attempts ?? []), { executionId: execution.executionId, head: request.head, at, expectedRemote: { ...request.expectedRemote } }].slice(-20);
  Object.assign(publication, { state: 'awaiting-discovery', updatedAt: at, nextStep: 'A publication activation was requested: its effects are discovered after its cessation, never assumed.' });
  work.history.push({ at, event: 'publication-started', origin: 'controller-publication', executionId: execution.executionId, detail: request.head });
}

const own = (pull: NonNullable<Extract<DiscoveryDecision, { outcome: 'linked' }>['pullRequest']>, at: string): NonNullable<PublicationView['pullRequest']> => ({
  pullRequestId: pull.pullRequestId, nodeId: pull.nodeId, number: pull.number, url: pull.url, state: pull.state, merged: pull.merged, draft: pull.draft,
  headRef: pull.headRef, headSha: pull.headSha, base: pull.baseRef, author: { ...pull.author }, linkedAt: at,
  bodySha256: pull.body === null ? null : createHash('sha256').update(pull.body).digest('hex') });

/**
 * Records one discovery decision. Applies only when the Work is still awaiting discovery for the SAME basis and the observed Execution is
 * still its current one (no activity started meanwhile). `linked`: the own PR is associated (opening never ends the Ticket/Work);
 * `absent`: publication requested through the queue with the observed lease expectation; `blocked`: explicit impediment, never repeated
 * automatically; `incomplete`: recorded, nothing decided.
 */
export async function recordDiscovery(session: Session, work_id: string, input: { basisExecutionId: string; executionId: string | null; trigger: PublicationDiscovery['trigger'];
  observedAt: string | null; branch: PublicationDiscovery['branch']; decision: DiscoveryDecision; ticketNumber: number }): Promise<PublicationView | 'stale'> {
  return onWork(session, work_id, work => {
    const publication = work.publication;
    if (!publication || publication.state !== 'awaiting-discovery' || publication.basisExecutionId !== input.basisExecutionId ||
      (work.execution?.executionId ?? null) !== input.executionId || publicationStep(work).kind !== 'discover') return 'stale' as const;
    const { decision } = input;
    const at = new Date().toISOString();
    const previous = publication.discoveries.at(-1);
    const repeated = decision.outcome === 'incomplete' && previous?.outcome === 'incomplete' && JSON.stringify(previous.reasons) === JSON.stringify(decision.reasons);
    // Bounded: the latest 20 observations (an incomplete read repeated identically is counted once).
    if (!repeated) publication.discoveries = [...publication.discoveries, { at, observedAt: input.observedAt, trigger: input.trigger, outcome: decision.outcome,
      reasons: [...decision.reasons], branch: copy(input.branch), candidates: copy(decision.candidates) }].slice(-20);
    publication.updatedAt = at;
    publication.reasons = [...decision.reasons];
    const link = (pull: Parameters<typeof own>[0]) => {
      publication.pullRequest = own(pull, at);
      publication.description = descriptionCheck(pull.body, { workId: work.work_id, ticketNumber: input.ticketNumber });
      work.pullRequest = { number: pull.number, url: pull.url };
    };
    if (decision.outcome === 'linked') {
      link(decision.pullRequest);
      publication.state = 'published';
      publication.linkedHeads = [...new Set([...(publication.linkedHeads ?? []), decision.pullRequest.headSha])].slice(-20);
      publication.nextStep = 'Own draft pull request linked. Opening it does not end the Ticket or the Work; readiness and human merge are separate.';
      history(work, 'publication-linked', input.executionId, `#${decision.pullRequest.number}:${decision.pullRequest.headSha}`);
    } else if (decision.outcome === 'absent' && work.result !== 'open') {
      // Cancelled / closed-unmerged: the attempted effect is reconciled, nothing is requested again.
      const code = work.result === 'cancelled' ? 'WORK_CANCELLED' : 'PULL_REQUEST_CLOSED_UNMERGED';
      Object.assign(publication, { state: 'not-publishable', reasons: [code], nextStep: `The publication attempt left no own pull request and the Work is ${work.result}: nothing is requested.` });
      history(work, 'publication-evaluated', input.executionId, `not-publishable:${code}`);
    } else if (decision.outcome === 'absent') {
      Object.assign(publication, { state: 'requested', expectedRemote: decision.expectedRemote, requestedAt: at, refsBefore: decision.refs, update: decision.update?.number ?? null,
        nextStep: decision.recovery ? 'The attempt pushed the own branch (absent before the window) at exactly the verified head but no pull request exists: ONE publication ' +
            'activation is queued to create only the pull request (no push). Never repeated after it.'
          : decision.update ? `A later verified basis: a publication activation is queued to update the own pull request #${decision.update.number} (lease on its current head).`
          : 'No own publication exists (complete read): a publication activation of the Builder is queued with the observed lease expectation.' });
      work.queue = { ...work.queue, pending: true };
      history(work, 'publication-requested', input.executionId, `${decision.recovery ? `${decision.recovery}:` : ''}${decision.expectedRemote.state === 'absent' ? 'remote:absent' : `remote:${decision.expectedRemote.sha}`}`);
    } else if (decision.outcome === 'blocked') {
      if (decision.pullRequest) link(decision.pullRequest);
      publication.state = 'blocked';
      publication.nextStep = `Publication is not repeated or adopted automatically (${decision.reasons.join(', ')}). Operator must inspect the branch and pull requests on GitHub and decide explicitly (ticket 26).`;
      if (!work.impediments.some(item => item.code === publicationImpediment)) work.impediments.push({ code: publicationImpediment, scope: 'work', since: at, nextStep: publication.nextStep });
      const outOfScope = publicationAttempted(work) ? guestEffectOutOfScope(decision.reasons) : [];
      if (outOfScope.length && !work.impediments.some(item => item.code === guestEffectImpediment)) work.impediments.push({ code: guestEffectImpediment, scope: 'work', since: at,
        nextStep: `The publish-only session's effects exceeded its scope (${outOfScope.join(', ')}): GitHub permissions cannot separate push from merge, so Control ` +
          'verified it after the activation. Nothing is repaired or repeated; operator must inspect the repository (refs, pull requests) and decide explicitly.' });
      history(work, 'publication-blocked', input.executionId, decision.reasons.join(','));
    } else if (decision.outcome === 'held') {
      publication.nextStep = 'A pull request associated with this Ticket is not recognised as the Factory\'s own: it is neither adopted nor ignored, and nothing is ' +
        'requested. Operator must decide on GitHub (handle the Ticket manually, or remove the association: edit the closing keyword/reference out of that pull request, ' +
        'or unlink it from Development); the discovery re-reads it on later cycles.';
      if (!repeated) history(work, 'publication-discovery-incomplete', input.executionId, decision.reasons.join(','));
    } else {
      publication.nextStep = 'The discovery read was incomplete: nothing is concluded or repeated; the safe read is retried on a later cycle.';
      if (!repeated) history(work, 'publication-discovery-incomplete', input.executionId, decision.reasons.join(','));
    }
    return copy(publication);
  }, true);
}
