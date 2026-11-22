import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ControlInput, ControlReceipt, DivergenceView, ExecutionView, PublicationDiscovery, PublicationView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { authorizationInForce, divergenceQuestion, reconciliationAnswer } from '../rules/divergence.js';
import {
  descriptionCheck,
  type DescriptionTicket,
  guestEffectOutOfScope,
  publicationAttempted,
  publicationMarker,
  publicationStep,
  publishableContent,
  liveBasisRecoverable,
  reevaluationEligibility,
  reevaluationGuidance,
  undecidedRead,
  unpublishedBeforeStop,
  unpublishedBeforeStopStep,
  verifiedHeadOnOrigin,
  type DiscoveryDecision,
} from '../rules/publication.js';
import { answerAuthorLabel, validateQuestionRequest } from '../rules/questions.js';
import { linkRequest, requests, ticketIndex, works, type WorkRecord } from './admission.js';
import { questions, questionSha256 } from './questions.js';
import { desireJiraLink } from './jira-links.js';
import type { Session } from './store.js';

// Durable commits of ticket 14's publication dimension (spec §3.3/§9.1). Every remote observation happens OUTSIDE these commits; each
// commit re-checks that the Work, its basis and the Execution it observed are still the same before recording anything.

const history = (
  work: WorkRecord,
  event: Extract<WorkRecord['history'][number], { origin: 'controller-publication' }>['event'],
  executionId: string | null,
  detail: string,
) => work.history.push({ at: new Date().toISOString(), event, origin: 'controller-publication', executionId, detail: detail.slice(0, 512) });
const executions = (work: WorkRecord) => [...(work.previousExecutions ?? []), ...(work.execution ? [work.execution] : [])];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const publicationImpediment = 'PUBLICATION_BLOCKED';
export const guestEffectImpediment = 'GUEST_EFFECT_OUT_OF_SCOPE';
/** Ticket 21: a remote change not attributable to the Factory blocks the next write until the operator's answer is resolved. */
export const reconciliationImpediment = 'HUMAN_CHANGE_RECONCILIATION';
/** Ticket 21: the own PR's base was changed outside the Factory: no continuation until it is restored. */
export const baseChangeImpediment = 'BASE_TARGET_CHANGED';

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
/** `reconcile`: the discovery/observation commits, also allowed on a cancelled or closed-unmerged Work (review MED: never a request/advance). */
async function onWork<T>(session: Session, work_id: string, change: (work: WorkRecord, tx: Tx) => T | Promise<T>, reconcile = false): Promise<T | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    // Ticket 25: a cancelled Work's attempted publication is still reconciled (publicationStep gates what may happen to it).
    const ended = work?.result === 'cancelled' || work?.result === 'closed-unmerged';
    if (
      !work ||
      !(work.result === 'open' || (reconcile && ended)) ||
      (index.tickets[ticketKey(work.ticket)]?.current !== work_id && !(reconcile && work.result === 'cancelled'))
    )
      return 'stale' as const;
    return change(work, tx);
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
    // Review MED-HIGH: a reconciliation that produced nothing publishable (e.g. FETCH_HEAD was another tip, the tip was not preserved)
    // settles its authorization as FAILED with the reasons; the earlier verified result and expectation stay, and the branch is evaluated
    // again — a new Question when it still diverges. Never a stalled `executing` authorization.
    const reconciliation = earlier?.reconciliation ?? null;
    if (
      !decision.ok &&
      basis.request.reconciliation &&
      earlier?.verified &&
      reconciliation &&
      reconciliation.divergenceId === basis.request.reconciliation.divergenceId &&
      (reconciliation.state === 'executing' || reconciliation.state === 'authorized')
    ) {
      Object.assign(reconciliation, { state: 'failed', failure: decision.reasons.slice(0, 16) });
      Object.assign(earlier, {
        state: 'awaiting-discovery',
        basisExecutionId,
        reasons: ['RECONCILIATION_FAILED', ...decision.reasons.slice(0, 15)],
        updatedAt: now,
        nextStep:
          `The reconciliation Execution ${basisExecutionId} produced nothing publishable (${decision.reasons.join(', ')}); the earlier verified result is kept and the ` +
          'branch is evaluated again (a new Question when it still diverges).',
      });
      history(work, 'reconciliation-failed', basisExecutionId, decision.reasons.join(',').slice(0, 400));
      return copy(earlier);
    }
    // Attempts, linked heads and the linked own PR survive a new basis: an attempted head is never requested again, and a later verified
    // head updates the same own PR instead of creating another.
    work.publication = {
      state: decision.ok ? 'awaiting-discovery' : 'not-publishable',
      basisExecutionId,
      marker: publicationMarker(work.work_id),
      branch: basis.request.branch,
      base: basis.request.base,
      verified: decision.ok ? decision.verified : null,
      expectedRemote: null,
      requestedAt: null,
      pullRequest: earlier?.pullRequest ?? null,
      description: earlier?.description ?? null,
      discoveries: earlier?.discoveries ?? [],
      attempts: earlier?.attempts ?? [],
      linkedHeads: earlier?.linkedHeads ?? [],
      refsBefore: null,
      update: null,
      reasons: decision.ok ? [] : decision.reasons,
      // Ticket 21: divergences and the authorization in force survive a new basis (the reconciliation Execution's basis publishes under it).
      divergences: earlier?.divergences ?? [],
      reconciliation: earlier?.reconciliation ?? null,
      baseChange: earlier?.baseChange ?? null,
      nextStep: decision.ok
        ? 'The own publication is discovered (Git remote + pull requests) before anything is requested.'
        : 'Nothing is published: the Execution content is not verified (reasons). A new verified Execution (correction/scope update) is needed.',
      updatedAt: now,
    };
    history(
      work,
      'publication-evaluated',
      basisExecutionId,
      `${work.publication.state}${decision.ok ? `:${decision.verified.head}` : `:${decision.reasons.join(',')}`}`,
    );
    return copy(work.publication);
  });
}

/**
 * v2 ticket 06 (Operator decision 1A): the publication basis of a LIVE Execution, on a sandbox without a persistent disk. The Builder
 * activation completed and the verification was recorded, but the boot is still up: the verified commit exists only in its guest, so the
 * basis is evaluated NOW. `awaiting-discovery` with the verified content, or `not-publishable` with its reasons; nothing is requested here.
 */
export async function evaluateLivePublication(session: Session, work_id: string, executionId: string): Promise<PublicationView | 'stale'> {
  return onWork(session, work_id, work => {
    const basis = work.execution;
    if (
      !basis ||
      basis.executionId !== executionId ||
      !basis.request.publishInBoot ||
      basis.state !== 'started' ||
      basis.end ||
      work.publication?.basisExecutionId === executionId
    )
      return 'stale' as const;
    const decision = publishableContent(basis, { live: true });
    const now = new Date().toISOString();
    const earlier = work.publication ?? null;
    work.publication = {
      state: decision.ok ? 'awaiting-discovery' : 'not-publishable',
      basisExecutionId: executionId,
      marker: publicationMarker(work.work_id),
      branch: basis.request.branch,
      base: basis.request.base,
      verified: decision.ok ? decision.verified : null,
      expectedRemote: null,
      requestedAt: null,
      pullRequest: earlier?.pullRequest ?? null,
      description: earlier?.description ?? null,
      discoveries: earlier?.discoveries ?? [],
      attempts: earlier?.attempts ?? [],
      linkedHeads: earlier?.linkedHeads ?? [],
      refsBefore: null,
      update: null,
      reasons: decision.ok ? [] : decision.reasons,
      divergences: earlier?.divergences ?? [],
      reconciliation: earlier?.reconciliation ?? null,
      baseChange: earlier?.baseChange ?? null,
      nextStep: decision.ok
        ? 'The own publication is discovered (Git remote + pull requests) before the Builder publishes in this same boot.'
        : 'Nothing is published: the Execution content is not verified (reasons). A new verified Execution (correction/scope update) is needed.',
      updatedAt: now,
    };
    history(
      work,
      'publication-evaluated',
      executionId,
      `${work.publication.state}${decision.ok ? `:${decision.verified.head}` : `:${decision.reasons.join(',')}`}`,
    );
    return copy(work.publication);
  });
}

/**
 * v2 ticket 06: the same-boot publication activation is ATTEMPTED from this commit, before its worker is launched: the attempt is recorded
 * with the lease it carries and the Execution names the activation's own invocation. From now on only a discovery after cessation decides.
 */
export async function beginLivePublication(
  session: Session,
  work_id: string,
  executionId: string,
  invocationId: string,
): Promise<(NonNullable<ExecutionView['inBootPublication']> & { marker: string; base: string; verified: NonNullable<PublicationView['verified']> }) | 'stale'> {
  return onWork(session, work_id, work => {
    const execution = work.execution;
    const publication = work.publication;
    if (
      !execution ||
      execution.executionId !== executionId ||
      execution.state !== 'started' ||
      execution.end ||
      execution.inBootPublication ||
      !publication?.verified ||
      publication.state !== 'requested' ||
      publication.basisExecutionId !== executionId ||
      !publication.expectedRemote
    )
      return 'stale' as const;
    const at = new Date().toISOString();
    const head = publication.verified.head;
    execution.inBootPublication = {
      invocationId,
      head,
      branch: publication.branch,
      expectedRemote: { ...publication.expectedRemote },
      pullRequest: publication.update ?? null,
      requestedAt: at,
    };
    publication.attempts = [...(publication.attempts ?? []), { executionId, head, at, expectedRemote: { ...publication.expectedRemote } }].slice(-20);
    Object.assign(publication, {
      state: 'awaiting-discovery',
      updatedAt: at,
      nextStep: 'A publication activation was requested in the boot that verified the content: its effects are discovered after its cessation, never assumed.',
    });
    work.history.push({ at, event: 'publication-started', origin: 'controller-publication', executionId, detail: head });
    return { ...copy(execution.inBootPublication), marker: publication.marker, base: publication.base, verified: copy(publication.verified) };
  });
}

/** v2 ticket 06: how the same-boot publication activation ended (the worker's word; the publication itself is decided by discovery). */
export async function settleLivePublication(
  session: Session,
  work_id: string,
  executionId: string,
  outcome: { status: 'completed' | 'failure' | 'not-started'; code: string | null },
) {
  return onWork(session, work_id, work => {
    const execution = work.execution;
    if (!execution || execution.executionId !== executionId || !execution.inBootPublication || execution.inBootPublication.outcome) return 'stale' as const;
    execution.inBootPublication.outcome = { at: new Date().toISOString(), ...outcome };
    return 'recorded' as const;
  });
}

/**
 * v2 ticket 06: the live discovery could not decide (incomplete or held read) while the boot was up. Acceptance finding A6: when Control's own
 * evidence shows the verified commit on the Work's own branch on `origin`, nothing is lost with the boot — the publication stays awaiting
 * discovery and the ordinary discovery re-reads after cessation. Otherwise a later publication Execution would start from an `origin`
 * that may not have the commit: the publication is blocked explicitly instead of being queued (lifted by `liftLiveBlock`).
 */
export async function blockLivePublication(session: Session, work_id: string, executionId: string, reasons: string[]): Promise<PublicationView | 'stale'> {
  return onWork(session, work_id, work => {
    const publication = work.publication;
    if (
      !publication ||
      publication.basisExecutionId !== executionId ||
      work.execution?.executionId !== executionId ||
      (publication.state !== 'awaiting-discovery' && publication.state !== 'requested') ||
      publicationAttempted(work)
    )
      return 'stale' as const;
    const at = new Date().toISOString();
    if (publication.state === 'awaiting-discovery' && undecidedRead(reasons) && verifiedHeadOnOrigin(publication, work.preservation)) {
      Object.assign(publication, {
        updatedAt: at,
        nextStep:
          `The discovery read in the boot decided nothing (${reasons.join(', ')}), but the verified commit ${publication.verified?.head ?? ''} ` +
          'is on the Work branch on origin: nothing is blocked; the safe read is retried on later cycles and a complete read decides (only the pull request is missing).',
      });
      return copy(publication);
    }
    const nextStep = unpublishedBeforeStopStep(publication.verified?.head ?? '', reasons);
    Object.assign(publication, { state: 'blocked', reasons: [unpublishedBeforeStop, ...reasons].slice(0, 16), updatedAt: at, nextStep });
    if (!work.impediments.some(item => item.code === publicationImpediment))
      work.impediments.push({ code: publicationImpediment, scope: 'work', since: at, nextStep });
    history(work, 'publication-blocked', executionId, publication.reasons.join(','));
    return copy(publication);
  });
}
/**
 * Acceptance finding A6 (inside the caller's commit): a live-basis block whose verified commit Control now knows to be on the Work's own
 * branch (`liveBasisRecoverable`) returns to `awaiting-discovery` with the reasons of the undecided read. Nothing is requested here: the
 * ordinary discovery after cessation re-reads the remote and applies the rule in full. `by`: what lifted it (history).
 */
export function liftLiveBlock(work: WorkRecord, at: string, by: string): boolean {
  const publication = work.publication;
  if (!publication || !liveBasisRecoverable(publication, work.preservation)) return false;
  Object.assign(publication, {
    state: 'awaiting-discovery',
    reasons: publication.reasons.filter(reason => reason !== unpublishedBeforeStop),
    updatedAt: at,
    nextStep:
      `The verified commit ${publication.verified?.head ?? ''} is on the Work branch on origin: the block is lifted and the own publication is discovered again ` +
      '(a complete read decides; only the pull request is missing).',
  });
  work.impediments = work.impediments.filter(item => item.code !== publicationImpediment);
  history(work, 'publication-block-lifted', work.execution?.executionId ?? null, `${by}:${publication.verified?.head ?? ''}`);
  return true;
}

/**
 * The publication activation is ATTEMPTED from its activation commit ("activation-requested", before any launch or receipt): from now on
 * only a discovery after cessation decides, and this verified head is never requested again, whatever happens to the receipt.
 */
export function markPublicationAttempt(work: WorkRecord, execution: ExecutionView, at: string) {
  const publication = work.publication;
  const request = execution.request.publication;
  if (!request || !publication || publication.state !== 'requested' || publication.basisExecutionId !== request.basisExecutionId) return;
  publication.attempts = [
    ...(publication.attempts ?? []),
    { executionId: execution.executionId, head: request.head, at, expectedRemote: { ...request.expectedRemote } },
  ].slice(-20);
  Object.assign(publication, {
    state: 'awaiting-discovery',
    updatedAt: at,
    nextStep: 'A publication activation was requested: its effects are discovered after its cessation, never assumed.',
  });
  work.history.push({ at, event: 'publication-started', origin: 'controller-publication', executionId: execution.executionId, detail: request.head });
}

const own = (pull: NonNullable<Extract<DiscoveryDecision, { outcome: 'linked' }>['pullRequest']>, at: string): NonNullable<PublicationView['pullRequest']> => ({
  pullRequestId: pull.pullRequestId,
  nodeId: pull.nodeId,
  number: pull.number,
  url: pull.url,
  state: pull.state,
  merged: pull.merged,
  draft: pull.draft,
  headRef: pull.headRef,
  headSha: pull.headSha,
  base: pull.baseRef,
  author: { ...pull.author },
  linkedAt: at,
  bodySha256: pull.body === null ? null : createHash('sha256').update(pull.body).digest('hex'),
});

/**
 * Records one discovery decision. Applies only when the Work is still awaiting discovery for the SAME basis and the observed Execution is
 * still its current one (no activity started meanwhile). `linked`: the own PR is associated (opening never ends the Ticket/Work);
 * `absent`: publication requested through the queue with the observed lease expectation; `blocked`: explicit impediment, never repeated
 * automatically; `incomplete`: recorded, nothing decided.
 */
export async function recordDiscovery(
  session: Session,
  work_id: string,
  input: {
    basisExecutionId: string;
    executionId: string | null;
    trigger: PublicationDiscovery['trigger'];
    observedAt: string | null;
    branch: PublicationDiscovery['branch'];
    decision: DiscoveryDecision;
    /** v2 ticket 06: the discovery of a LIVE basis (same-boot publication): the Execution is running, nothing is queued. */ live?: boolean;
  } & DescriptionTicket,
): Promise<PublicationView | 'stale'> {
  return onWork(
    session,
    work_id,
    async (work, tx) => {
      const publication = work.publication;
      if (input.live) {
        const execution = work.execution;
        if (
          !publication ||
          publication.state !== 'awaiting-discovery' ||
          publication.basisExecutionId !== input.basisExecutionId ||
          !execution ||
          execution.executionId !== input.executionId ||
          execution.executionId !== input.basisExecutionId ||
          execution.state !== 'started' ||
          execution.end
        )
          return 'stale' as const;
      }
      // Ticket 61: a blocked publication is discovered again only for the operator's pending re-evaluation.
      const reevaluation = publication?.state === 'blocked' && publication.reevaluation?.state === 'pending' ? publication.reevaluation : null;
      if (
        !publication ||
        (publication.state !== 'awaiting-discovery' && publication.state !== 'base-changed' && !reevaluation) ||
        publication.basisExecutionId !== input.basisExecutionId ||
        (work.execution?.executionId ?? null) !== input.executionId ||
        (!input.live && publicationStep(work).kind !== 'discover')
      )
        return 'stale' as const;
      const { decision } = input;
      const at = new Date().toISOString();
      const previous = publication.discoveries.at(-1);
      const repeated =
        decision.outcome === 'incomplete' && previous?.outcome === 'incomplete' && JSON.stringify(previous.reasons) === JSON.stringify(decision.reasons);
      // Bounded: the latest 20 observations (an incomplete read repeated identically is counted once).
      if (!repeated)
        publication.discoveries = [
          ...publication.discoveries,
          {
            at,
            observedAt: input.observedAt,
            trigger: input.trigger,
            outcome: decision.outcome,
            reasons: [...decision.reasons],
            branch: copy(input.branch),
            candidates: copy(decision.candidates),
          },
        ].slice(-20);
      publication.updatedAt = at;
      if (reevaluation) {
        // An incomplete read decides nothing: the block and its reasons stay, the re-evaluation stays pending (read again on a later cycle).
        if (decision.outcome === 'incomplete' || decision.outcome === 'held') {
          if (!repeated)
            history(work, 'publication-discovery-incomplete', input.executionId, `reevaluation:${reevaluation.request_id}:${decision.reasons.join(',')}`);
          return copy(publication);
        }
        Object.assign(reevaluation, {
          settledAt: at,
          outcome: decision.outcome,
          reasons: [...decision.reasons],
          state: decision.outcome === 'blocked' ? 'still-blocked' : 'accepted',
        });
        history(
          work,
          'publication-reevaluated',
          input.executionId,
          `${reevaluation.request_id}:${reevaluation.state}${decision.outcome === 'blocked' ? `:${decision.reasons.join(',')}` : `:${decision.outcome}`}`,
        );
        if (decision.outcome === 'blocked') {
          // Still blocked: the block's reasons and impediments are those of THIS read (an out-of-scope effect impediment only while one is shown).
          work.impediments = work.impediments.filter(item => item.code !== publicationImpediment && item.code !== guestEffectImpediment);
        } else {
          // Accepted: the false positive's impediments lift and the decision applies exactly as a discovery after the attempt would have.
          work.impediments = work.impediments.filter(item => item.code !== publicationImpediment && item.code !== guestEffectImpediment);
          publication.state = 'awaiting-discovery';
        }
      }
      publication.reasons = [...decision.reasons];
      // Ticket 21: the changed base was restored (the linked own PR targets the Work's base again): the block lifts and the decision applies.
      if (publication.state === 'base-changed' && decision.outcome !== 'base-changed' && decision.outcome !== 'incomplete') {
        history(work, 'publication-base-restored', input.executionId, `${publication.baseChange?.to ?? '?'}->${publication.base}`);
        publication.baseChange = null;
        publication.state = 'awaiting-discovery';
        work.impediments = work.impediments.filter(item => item.code !== baseChangeImpediment);
        // Review MED (AC6): the restoring read never resumes the push. The next COMPLETE read re-evaluates everything (refs, base protection,
        // comparison, preservation); the verified content/reviews/instructions are bound to the same restored base, and checks are evaluated
        // again by ticket 15 on the head GitHub reports.
        publication.nextStep = `Base restored to ${publication.base}: nothing decided on this read; the next complete discovery re-evaluates before any write.`;
        return copy(publication);
      }
      const link = async (pull: Parameters<typeof own>[0]) => {
        publication.pullRequest = own(pull, at);
        publication.description = descriptionCheck(
          pull.body,
          input.card ? { workId: work.work_id, card: input.card } : { workId: work.work_id, ticketNumber: input.ticketNumber! },
        );
        work.pullRequest = { number: pull.number, url: pull.url };
        // Jira ticket 08 (spec §5): fixing the own PR (draft included) records, in THIS commit, the intent of the Work's link on its Card.
        await desireJiraLink(tx, { work, url: pull.url, desired: 'open' });
      };
      if (decision.outcome === 'linked') {
        await link(decision.pullRequest);
        publication.state = 'published';
        publication.linkedHeads = [...new Set([...(publication.linkedHeads ?? []), decision.pullRequest.headSha])].slice(-20);
        publication.nextStep = 'Own draft pull request linked. Opening it does not end the Ticket or the Work; readiness and human merge are separate.';
        history(work, 'publication-linked', input.executionId, `#${decision.pullRequest.number}:${decision.pullRequest.headSha}`);
        // Ticket 21: the authorization covered exactly this publication; it is consumed (a later change needs a new evaluation).
        const authorization = authorizationInForce(publication);
        if (authorization) {
          authorization.state = 'consumed';
          const divergence = publication.divergences?.find(item => item.divergenceId === authorization.divergenceId);
          if (divergence) Object.assign(divergence, { state: 'resolved', resolvedAt: divergence.resolvedAt ?? at });
        }
      } else if (decision.outcome === 'absent' && work.result !== 'open') {
        // Cancelled / closed-unmerged: the attempted effect is reconciled, nothing is requested again.
        const code = work.result === 'cancelled' ? 'WORK_CANCELLED' : 'PULL_REQUEST_CLOSED_UNMERGED';
        Object.assign(publication, {
          state: 'not-publishable',
          reasons: [code],
          nextStep: `The publication attempt left no own pull request and the Work is ${work.result}: nothing is requested.`,
        });
        history(work, 'publication-evaluated', input.executionId, `not-publishable:${code}`);
      } else if (decision.outcome === 'absent') {
        Object.assign(publication, {
          state: 'requested',
          expectedRemote: decision.expectedRemote,
          requestedAt: at,
          refsBefore: decision.refs,
          update: decision.update?.number ?? null,
          nextStep: decision.recovery
            ? 'The attempt pushed the own branch (absent before the window) at exactly the verified head but no pull request exists: ONE publication ' +
              'activation is queued to create only the pull request (no push). Never repeated after it.'
            : decision.update
              ? `A later verified basis: a publication activation is queued to update the own pull request #${decision.update.number} (lease on its current head).`
              : 'No own publication exists (complete read): a publication activation of the Builder is queued with the observed lease expectation.',
        });
        // A live basis is published by its own running Execution: nothing enters the queue.
        if (!input.live) work.queue = { ...work.queue, pending: true };
        history(
          work,
          'publication-requested',
          input.executionId,
          `${decision.recovery ? `${decision.recovery}:` : ''}${decision.expectedRemote.state === 'absent' ? 'remote:absent' : `remote:${decision.expectedRemote.sha}`}`,
        );
      } else if (decision.outcome === 'blocked') {
        if (decision.pullRequest) await link(decision.pullRequest);
        publication.state = 'blocked';
        publication.nextStep =
          `Publication is not repeated or adopted automatically (${decision.reasons.join(', ')}). Operator must inspect the branch and pull requests on GitHub and decide explicitly (ticket 26).` +
          // Ticket 61 / A14: where a new read may decide differently (another Work's own publication, a corrected marker) the command is named.
          reevaluationGuidance(decision.reasons, { workId: work.work_id, marker: publication.marker });
        if (!work.impediments.some(item => item.code === publicationImpediment))
          work.impediments.push({ code: publicationImpediment, scope: 'work', since: at, nextStep: publication.nextStep });
        const outOfScope = publicationAttempted(work) ? guestEffectOutOfScope(decision.reasons) : [];
        if (outOfScope.length && !work.impediments.some(item => item.code === guestEffectImpediment))
          work.impediments.push({
            code: guestEffectImpediment,
            scope: 'work',
            since: at,
            nextStep:
              `The publish-only session's effects exceeded its scope (${outOfScope.join(', ')}): GitHub permissions cannot separate push from merge, so Control ` +
              'verified it after the activation. Nothing is repaired or repeated; operator must inspect the repository (refs, pull requests) and decide explicitly.',
          });
        if (!reevaluation) history(work, 'publication-blocked', input.executionId, decision.reasons.join(','));
      } else if (decision.outcome === 'diverged') {
        // Ticket 21 (spec §10.1): never a recapture of the remote tip as a new lease. The divergence, its Question and the write block share
        // this commit; the local result and the earlier expectation stay as they are. An authorization in force for another tip is superseded.
        const authorization = authorizationInForce(publication);
        if (authorization) {
          authorization.state = 'superseded';
          const previous = publication.divergences?.find(item => item.divergenceId === authorization.divergenceId);
          if (previous) previous.state = 'superseded';
          history(work, 'reconciliation-superseded', input.executionId, `${authorization.authorizedRemote}->${decision.current}`);
        }
        const divergenceId = randomUUID();
        const questionId = randomUUID();
        const facts: Omit<DivergenceView, 'questionId' | 'state' | 'resolvedAt' | 'answer'> = {
          divergenceId,
          detectedAt: at,
          trigger: decision.trigger,
          repository: work.repository.repository,
          branch: publication.branch,
          base: publication.base,
          pullRequest: { number: decision.pullRequest.number, url: decision.pullRequest.url },
          expected: copy(decision.expected),
          current: decision.current,
          local: publication.verified?.head ?? null,
          comparison: copy(decision.comparison),
          uncertainties: [...decision.uncertainties],
          proposal: 'incorporate',
          kind: decision.kind ?? 'change',
        };
        const text = divergenceQuestion(facts, work.work_id);
        const reference = { workId: work.work_id, id: divergenceId };
        if (!validateQuestionRequest({ questionId, question: text.question, context: text.context }).valid) throw new Error('DIVERGENCE_QUESTION_INVALID');
        const basis = work.execution ?? null;
        const document = await tx.doc(questions, questionId, null);
        document.question = {
          questionId,
          workId: work.work_id,
          executionId: basis?.executionId ?? input.basisExecutionId,
          invocationId: basis?.invocationId ?? `builder-${input.basisExecutionId}`,
          recordedAt: at,
          recordedFrom: 'controller-divergence',
          content: { question: text.question, context: text.context, sha256: questionSha256(text.question, text.context), reference },
          // The PR surface is not enabled in this version: the Ticket issue carries the Question (its answers are read there).
          destination: { kind: 'issue', ticket: work.ticket },
          state: 'open',
          publication: { effectId: randomUUID(), state: 'intended', updatedAt: at, attempts: [], comment: null, nextStep: null },
          answer: null,
          ignored: [],
        };
        work.questions = [...(work.questions ?? []), questionId];
        publication.divergences = [
          ...(publication.divergences ?? []),
          { ...facts, questionId, state: 'awaiting-answer' as const, resolvedAt: null, answer: null },
        ].slice(-10);
        publication.state = 'diverged';
        publication.nextStep =
          `The branch holds commits the Factory did not make (${decision.current}); nothing is written until the operator answers Question ${questionId} ` +
          `(\`incorporate\` = preserve them, the default; \`discard ${decision.current}\` = discard exactly them).`;
        work.impediments.push({
          code: 'QUESTION_PENDING',
          scope: 'work',
          since: at,
          questionId,
          nextStep:
            `Answer with \`/factory answer ${questionId} incorporate\` (or ` +
            `\`discard ${decision.current}\`) on the Ticket, or locally with \`factory answer ${questionId} incorporate\`.`,
        });
        if (!work.impediments.some(item => item.code === reconciliationImpediment)) {
          work.impediments.push({ code: reconciliationImpediment, scope: 'work', since: at, questionId, nextStep: publication.nextStep });
        } else
          work.impediments = work.impediments.map(item =>
            item.code === reconciliationImpediment ? { ...item, questionId, nextStep: publication.nextStep! } : item,
          );
        work.history.push({ at, event: 'question-recorded', origin: 'controller-publication', questionId, detail: `divergence:${divergenceId}` });
        history(
          work,
          'publication-diverged',
          input.executionId,
          `${decision.trigger}:${decision.expected.state === 'present' ? decision.expected.sha : 'absent'}->${decision.current}`,
        );
      } else if (decision.outcome === 'base-changed') {
        if (publication.state !== 'base-changed') history(work, 'publication-base-changed', input.executionId, `${decision.from}->${decision.to}`);
        publication.state = 'base-changed';
        publication.baseChange = { from: decision.from, to: decision.to, observedAt: input.observedAt ?? at, pullRequest: decision.pullRequest.number };
        publication.nextStep =
          `The own pull request #${decision.pullRequest.number} now targets ${decision.to} instead of ${decision.from} (changed outside the Factory). Nothing ` +
          `continues until its base is restored to ${decision.from} on GitHub (re-read every cycle); a different base needs a configuration decision of the operator.`;
        if (!work.impediments.some(item => item.code === baseChangeImpediment))
          work.impediments.push({ code: baseChangeImpediment, scope: 'work', since: at, nextStep: publication.nextStep });
      } else if (decision.outcome === 'held') {
        publication.nextStep =
          "A pull request associated with this Ticket is not recognised as the Factory's own: it is neither adopted nor ignored, and nothing is " +
          'requested. Operator must decide on GitHub (handle the Ticket manually, or remove the association: edit the closing keyword/reference out of that pull request, ' +
          'or unlink it from Development); the discovery re-reads it on later cycles.';
        if (!repeated) history(work, 'publication-discovery-incomplete', input.executionId, decision.reasons.join(','));
      } else {
        publication.nextStep = 'The discovery read was incomplete: nothing is concluded or repeated; the safe read is retried on a later cycle.';
        if (!repeated) history(work, 'publication-discovery-incomplete', input.executionId, decision.reasons.join(','));
      }
      return copy(publication);
    },
    true,
  );
}

/**
 * Ticket 21: resolves the ACCEPTED answer of the pending divergence Question (spec §10.1 "Pergunta/resposta autoriza a divergência concreta").
 * `incorporate`: a reconciliation Execution is queued with exactly that remote tip as the one authorized expectation; `discard <tip>`: the
 * verified result is published with a lease on exactly that tip; anything else authorizes nothing and the divergence is evaluated again
 * (a new Question). Never renews scope or budget. `waiting`: no answer yet.
 */
export async function resolveDivergence(
  session: Session,
  work_id: string,
  divergenceId: string,
): Promise<{ decision: 'incorporate' | 'discard' | 'not-authorized'; code: string | null } | 'waiting' | 'stale'> {
  return onWork(session, work_id, async (work, tx) => {
    const publication = work.publication;
    const step = publicationStep(work);
    if (!publication || step.kind !== 'resolve' || step.divergenceId !== divergenceId) return 'stale' as const;
    const divergence = publication.divergences!.at(-1)!;
    const question = (await tx.doc(questions, divergence.questionId, null)).question;
    if (!question || question.state !== 'answered' || !question.answer) return 'waiting' as const;
    const answer = reconciliationAnswer(question.answer.text, divergence);
    const at = new Date().toISOString();
    const author = answerAuthorLabel(question.answer.author, true);
    divergence.resolvedAt = at;
    divergence.answer = { sha256: question.answer.sha256, author, decision: answer.decision, code: answer.decision === 'not-authorized' ? answer.code : null };
    work.impediments = work.impediments.filter(item => item.code !== reconciliationImpediment);
    if (answer.decision === 'not-authorized') {
      divergence.state = 'not-authorized';
      Object.assign(publication, {
        state: 'awaiting-discovery',
        updatedAt: at,
        nextStep: `The answer to Question ${divergence.questionId} authorized nothing (${answer.code}); the branch is evaluated again and a new Question is asked if it still diverges.`,
      });
      history(work, 'reconciliation-not-authorized', work.execution?.executionId ?? null, `${divergenceId}:${answer.code}`);
      return { decision: answer.decision, code: answer.code };
    }
    divergence.state = answer.decision === 'incorporate' ? 'authorized' : 'discard-authorized';
    if (answer.decision === 'discard') {
      // Exactly the presented commits stop being required at linking (the explicit authorization of their loss).
      const commits = divergence.comparison.state === 'complete' ? divergence.comparison.commits.map(item => item.sha) : [];
      publication.waived = [...new Set([...(publication.waived ?? []), divergence.current, ...commits])].slice(-100);
    }
    if (divergence.kind === 'lost') {
      Object.assign(publication, {
        state: 'awaiting-discovery',
        updatedAt: at,
        nextStep: `Loss of ${divergence.current} explicitly authorized: the own head is evaluated again.`,
      });
      history(work, 'reconciliation-authorized', work.execution?.executionId ?? null, `discard-lost:${divergence.current}`);
      return { decision: answer.decision, code: null };
    }
    publication.reconciliation = {
      divergenceId,
      questionId: divergence.questionId,
      answerSha256: question.answer.sha256,
      mode: answer.decision,
      authorizedRemote: divergence.current,
      expected: copy(divergence.expected),
      authorizedAt: at,
      author,
      state: 'authorized',
      executionId: null,
    };
    if (answer.decision === 'incorporate') {
      Object.assign(publication, {
        state: 'reconciling',
        updatedAt: at,
        nextStep:
          `Authorized: a reconciliation Execution incorporates exactly ${divergence.current} ` +
          '(human commits preserved, reviewed again), then the result is published with a lease on that tip. A later remote change needs a new answer.',
      });
      work.queue = { ...work.queue, pending: true };
    } else {
      Object.assign(publication, {
        state: 'awaiting-discovery',
        updatedAt: at,
        nextStep:
          `Discard authorized: the verified result is published with a lease on exactly ` + `${divergence.current}; a later remote change needs a new answer.`,
      });
    }
    history(work, 'reconciliation-authorized', work.execution?.executionId ?? null, `${answer.decision}:${divergence.current}`);
    return { decision: answer.decision, code: null };
  });
}

/** Ticket 21: binds the authorization in force to the reconciliation Execution admitted for it (same commit as the admission). */
export function markReconciliationExecution(work: WorkRecord, execution: ExecutionView) {
  const authorization = work.publication ? authorizationInForce(work.publication) : null;
  if (!authorization || execution.request.reconciliation?.divergenceId !== authorization.divergenceId) return;
  Object.assign(authorization, { state: 'executing', executionId: execution.executionId });
}

/**
 * Ticket 61 "Aceitar comando" for `reevaluate-publication <work> --reason`: records ONE pending re-evaluation of a publication blocked ONLY by
 * unexpected ref changes and/or unknown pull requests (A14) after an attempt (deduplicated by request identity). Nothing is read or decided here: the next discovery pass re-reads
 * the remote (complete read required) and re-applies the discovery rule to the persisted window with the current Control state. It never
 * repeats the publication nor adopts anything the rule does not accept.
 */
export async function acceptPublicationReevaluation(
  session: Session,
  input: Extract<ControlInput, { operation: 'reevaluate-publication' }>,
): Promise<Extract<ControlReceipt, { operation: 'reevaluate-publication' }> | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  type Receipt = Extract<ControlReceipt, { operation: 'reevaluate-publication' }>;
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return copy(request.receipt) as Receipt;
    }
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const base = { kind: 'durable' as const, request_id: input.request_id, operation: 'reevaluate-publication' as const, work_id: input.work_id };
    const refuse = (code: string): Receipt => ({ ...base, outcome: 'not-applied', reason: code, nextStep: null });
    const publication = work?.publication ?? null;
    let receipt: Receipt;
    if (!work) receipt = refuse('WORK_NOT_FOUND');
    else if (work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work.work_id) receipt = refuse('WORK_NOT_CURRENT');
    else if (!publication) receipt = refuse('PUBLICATION_NOT_BLOCKED');
    else if (publication.state === 'blocked' && publication.reevaluation?.state === 'pending') {
      receipt = { ...base, outcome: 'already-covered', reason: null, nextStep: `Re-evaluation ${publication.reevaluation.request_id} is already pending.` };
    } else {
      const eligible = reevaluationEligibility(publication, work.preservation ?? null);
      const at = new Date().toISOString();
      if (!eligible.ok) receipt = refuse(eligible.code);
      else if (eligible.liveBasis) {
        // A6: a Work already blocked with its verified commit on the own branch: the request itself lifts the block (nothing is read here).
        work.history.push({ at, event: 'publication-reevaluation-requested', origin: 'local-cli', detail: input.request_id });
        liftLiveBlock(work, at, `reevaluation:${input.request_id}`);
        publication.reevaluation = {
          request_id: input.request_id,
          reason: input.reason,
          requestedAt: at,
          state: 'accepted',
          settledAt: at,
          outcome: null,
          reasons: [],
        };
        receipt = {
          ...base,
          outcome: 'accepted',
          reason: null,
          nextStep:
            'The verified commit is on the Work branch on origin: the block is lifted and the next discovery pass ' +
            're-reads the remote (complete read required) and applies the discovery rule; nothing is published by this command.',
        };
      } else {
        publication.reevaluation = {
          request_id: input.request_id,
          reason: input.reason,
          requestedAt: at,
          state: 'pending',
          settledAt: null,
          outcome: null,
          reasons: [],
        };
        publication.updatedAt = at;
        work.history.push({ at, event: 'publication-reevaluation-requested', origin: 'local-cli', detail: input.request_id });
        receipt = {
          ...base,
          outcome: 'accepted',
          reason: null,
          nextStep:
            'The next discovery pass re-reads the remote (complete read required) and re-applies the ' +
            'discovery rule to the recorded window; nothing is published again.',
        };
      }
    }
    request.input = input;
    request.receipt = receipt;
    if (work) await linkRequest(tx, work.work_id, input.request_id);
    return copy(receipt);
  }, BACKGROUND_CONTEXT);
}
