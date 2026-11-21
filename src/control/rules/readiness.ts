import type {
  ChecksEvaluation,
  DependencyState,
  ExecutionView,
  Impediment,
  PublicationView,
  ReadinessBasis,
  ReadinessEvaluation,
  ReadinessReason,
  ReadinessView,
  ScopeUpdateView,
} from '../types.js';
import { mergeStep } from './checks.js';
import { publicationStep, publishableContent } from './publication.js';

// Pure rules of ticket 16 (spec §3.3, §9.2 steps 1-7, §9.3): internal readiness of the Work's own PR from CURRENT evidence only, and which
// draft/ready conversion (a controller effect) applies. No I/O, clock or randomness. Ticket 15's checks explanation and ticket 14's
// publication/verification are consumed, never re-derived here; human review, approval and merge are never decided or performed.

export type ReadinessFacts = {
  result: string;
  current: boolean;
  publication?: PublicationView | null | undefined;
  execution: ExecutionView | null;
  previousExecutions: ExecutionView[];
  impediments: Impediment[];
  dependencies: DependencyState;
  queue: { pending: boolean };
  correction: { consumed: boolean } | null;
  pendingRecovery: unknown;
  scopeUpdates?: Pick<ScopeUpdateView, 'state'>[] | undefined;
};

const limitationsNote = 'Human review/approval is a human stage: it is never read as a blocker and never performed by the Factory; merge is human only.';
/** The requirement set as a comparable identity (context, integration, strictness, interpretations), never a hash of transient results. */
export function requirementsIdentity(checks: ChecksEvaluation): string {
  const requirements = checks.requirements
    .map(item => `${item.context}@${item.integrationId ?? '*'}${item.strict ? '!' : ''}<${[...item.sources].sort().join('+')}>`)
    .sort();
  // Ticket 39: the merge interpretation is part of the identity (a parameter change, e.g. the allowed merge methods, is a new basis).
  const modalities = checks.modalities
    .map(item => `${item.type}:${item.interpretation}${item.merge ? `/${item.merge}:${item.reason ?? ''}` : ''}@${item.source}`)
    .sort();
  return `${checks.requiredSet}|${requirements.join(',')}|${modalities.join(',')}|strict:${[...checks.strict.sources].sort().join('+')}`;
}

export function readinessBasis(input: {
  pullRequest: { number: number; nodeId: string };
  checks: ChecksEvaluation | null;
  verified: PublicationView['verified'] | null | undefined;
}): ReadinessBasis {
  const { checks } = input;
  return {
    pullRequest: input.pullRequest.number,
    nodeId: input.pullRequest.nodeId,
    headSha: checks?.pullRequest.headSha ?? null,
    baseRef: checks?.pullRequest.baseRef ?? null,
    baseTip: checks?.pullRequest.baseTip ?? null,
    strict: checks?.strict.required ?? false,
    requirements: checks ? requirementsIdentity(checks) : null,
    verifiedHead: input.verified?.head ?? null,
    contentSha256: input.verified?.contentSha256 ?? null,
    checksAt: checks?.completedAt ?? null,
    checksOutcome: checks?.outcome ?? null,
    draft: checks?.pullRequest.draft ?? null,
  };
}

/** Spec §9.2 step 6: identity/head/base/requirements (and the base tip only when strict applies) of two evaluations. Base advancing alone is no change. */
export function sameBasis(a: ReadinessBasis, b: ReadinessBasis): boolean {
  return (
    a.pullRequest === b.pullRequest &&
    a.nodeId === b.nodeId &&
    a.headSha === b.headSha &&
    a.baseRef === b.baseRef &&
    a.requirements === b.requirements &&
    a.verifiedHead === b.verifiedHead &&
    a.contentSha256 === b.contentSha256 &&
    a.strict === b.strict &&
    (!a.strict || a.baseTip === b.baseTip)
  );
}

const unsettled = (execution: ExecutionView | null) =>
  execution !== null &&
  (execution.state === 'reserved' ||
    execution.state === 'started' ||
    execution.state === 'held' ||
    execution.slot.held ||
    (execution.state === 'ended' && execution.end?.cessation !== 'confirmed'));

/**
 * Spec §9.2 steps 1-5 and §9.3: one evaluation from the given facts. Every unmet condition is an independent reason (none hides another).
 * `ready` only with no reason at all; any confirmed reason makes it `not-ready`; otherwise an uncertain one makes it `unknown`.
 */
export function evaluateReadiness(input: {
  at: string;
  source: ReadinessEvaluation['source'];
  facts: ReadinessFacts;
  checks: ChecksEvaluation | null;
  /** Installation-level reconciliation (ticket 26): `required` = global uncertainty about own runtime resources (a concurrent writer is not excluded). */
  installation: 'settled' | 'reconciliation-required';
  /** The dependency evaluation THIS evaluation read fresh (its attempt id): the recorded conclusion must be that one, otherwise it is stale
   * (uncertain). Null: not enforced (a recorded evaluation, which never converts nor confirms readiness by itself). */
  dependencyAttempt?: string | null;
}): ReadinessEvaluation {
  const { facts, checks } = input;
  const reasons: ReadinessReason[] = [];
  const notes: string[] = [limitationsNote];
  const add = (area: ReadinessReason['area'], certainty: ReadinessReason['certainty'], code: string, subject?: string) =>
    reasons.push({ area, certainty, code, ...(subject !== undefined ? { subject } : {}) });
  const publication = facts.publication ?? null;
  const pull = publication?.pullRequest ?? null;
  // 1. Ownership and state.
  if (facts.result !== 'open' || !facts.current) add('ownership', 'confirmed', 'WORK_NOT_CURRENT');
  // Ticket 14: the own PR is linked by correlation, its description conforms, and no newer basis is waiting to be evaluated/discovered.
  if (!publication || publication.state !== 'published' || !pull)
    add('publication', 'confirmed', 'OWN_PULL_REQUEST_NOT_PUBLISHED', publication?.state ?? 'none');
  else {
    if (publication.description?.conformant !== true) add('publication', 'confirmed', 'DESCRIPTION_NOT_CONFORMANT');
    if (publicationStep({ result: facts.result, execution: facts.execution, previousExecutions: facts.previousExecutions, publication }).kind !== 'none') {
      add('publication', 'confirmed', 'PUBLICATION_BASIS_PENDING');
    }
  }
  // 4. Content/spec/instructions/two current opinions/treatments/gates: ticket 13's verification of the basis Execution, as ticket 14 recorded it.
  const verified = publication?.verified ?? null;
  if (!verified) add('content', 'confirmed', 'CONTENT_NOT_VERIFIED');
  else {
    const basis = [...facts.previousExecutions, ...(facts.execution ? [facts.execution] : [])].find(item => item.executionId === verified.executionId);
    if (!basis) add('content', 'confirmed', 'VERIFIED_BASIS_NOT_FOUND');
    else {
      const decision = publishableContent(basis);
      if (!decision.ok) for (const code of decision.reasons.slice(0, 16)) add('content', 'confirmed', 'CONTENT_NOT_VERIFIED', code);
      else if (decision.verified.head !== verified.head || decision.verified.contentSha256 !== verified.contentSha256)
        add('content', 'confirmed', 'VERIFIED_CONTENT_MISMATCH');
    }
  }
  // 2-3. Ticket 15's explanation of the GitHub required checks of the CURRENT head (never borrowed from another head, PR or instant).
  if (!checks) add('checks', 'uncertain', 'CHECKS_NOT_EVALUATED');
  else if (pull && checks.pullRequest.number !== pull.number) add('checks', 'uncertain', 'CHECKS_OF_ANOTHER_PULL_REQUEST');
  else {
    const read = checks.completeness.pullRequest === 'complete';
    if (checks.pullRequest.merged || checks.pullRequest.state === 'closed' || checks.outcome === 'not-applicable')
      add('closed', 'confirmed', checks.pullRequest.merged ? 'PULL_REQUEST_MERGED' : 'PULL_REQUEST_CLOSED');
    if (read && verified && checks.pullRequest.headSha !== verified.head)
      add('content', 'confirmed', 'HEAD_NOT_VERIFIED_CONTENT', checks.pullRequest.headSha ?? 'unknown');
    for (const reason of checks.reasons) {
      if (reason.category === 'closed') continue;
      // Ticket 39: a base rule that blocks the human merge for anyone without bypass is a CONFIRMED impediment (never readiness); the Factory
      // never uses or recommends a bypass. After a Factory-placed ready it is a confirmed loss (back to draft, ticket 16).
      if (reason.category === 'merge') {
        add('merge', 'confirmed', `MERGE_BLOCKED_${reason.code}`, reason.subject);
        continue;
      }
      // A required result that is waiting, failed, operational, uncertain or behind a strict base is a CONFIRMED unmet requirement; only an
      // incomplete/unsupported/changed read is uncertain. Ownership mismatches are confirmed (never the own PR as linked).
      // Strict + base advanced (spec §9.3): the base moving alone never converts a ready PR to draft nor triggers reviews: uncertain only.
      const certainty = reason.category === 'indeterminate' || reason.category === 'strict' ? 'uncertain' : 'confirmed';
      // A head the Factory never linked is a CONTENT loss of its own PR (someone pushed to its branch), not a dispute of the PR's identity.
      const area = reason.code === 'HEAD_NOT_LINKED_BY_FACTORY' ? 'content' : reason.category === 'ownership' ? 'ownership' : 'checks';
      add(area, certainty, `CHECKS_${reason.code}`, reason.subject);
    }
    if (!checks.reasons.length && checks.outcome !== 'satisfied' && checks.outcome !== 'not-applicable')
      add('checks', 'uncertain', 'CHECKS_NOT_SATISFIED', checks.outcome);
    // Absence of conflict must be CONFIRMED (tri-state): unknown mergeability is uncertain, never a pass and never a repair trigger.
    if (!read) add('conflict', 'uncertain', 'MERGEABILITY_UNKNOWN');
    else if (checks.conflict === 'conflict') add('conflict', 'confirmed', 'MERGE_CONFLICT');
    else if (checks.conflict === 'unknown') add('conflict', 'uncertain', 'MERGEABILITY_UNKNOWN');
  }
  // Every pertinent impediment of the Work (authorization, question, limits, publication, recovery, timeout...), each independent.
  for (const impediment of facts.impediments.slice(0, 32)) add('impediment', 'confirmed', impediment.code, impediment.questionId);
  const conclusion = facts.dependencies.latest?.conclusion ?? null;
  if (input.dependencyAttempt && facts.dependencies.latest?.attemptId !== input.dependencyAttempt) add('dependencies', 'uncertain', 'DEPENDENCIES_NOT_CURRENT');
  if (conclusion === 'pending') add('dependencies', 'confirmed', 'DEPENDENCIES_PENDING');
  else if (conclusion !== 'satisfied') add('dependencies', 'uncertain', 'DEPENDENCIES_NOT_CONFIRMED', conclusion ?? 'not-evaluated');
  // Concurrency: an unsettled or queued activity may change the content; an installation reconciliation does not exclude a concurrent writer.
  if (unsettled(facts.execution)) add('concurrency', 'confirmed', 'ACTIVITY_UNSETTLED', facts.execution!.executionId);
  if (facts.queue.pending) add('concurrency', 'confirmed', 'ACTIVITY_PENDING');
  if (facts.pendingRecovery) add('concurrency', 'confirmed', 'RECOVERY_PENDING');
  if (facts.correction && !facts.correction.consumed) add('concurrency', 'confirmed', 'CORRECTION_OPEN');
  if ((facts.scopeUpdates ?? []).some(item => item.state !== 'consumed')) add('concurrency', 'confirmed', 'SCOPE_UPDATE_NOT_CONSUMED');
  if (input.installation === 'reconciliation-required') add('installation', 'uncertain', 'INSTALLATION_RECONCILIATION_REQUIRED');
  const decision = reasons.some(item => item.certainty === 'confirmed') ? 'not-ready' : reasons.length ? 'unknown' : 'ready';
  return {
    at: input.at,
    source: input.source,
    decision,
    reasons,
    notes,
    basis: readinessBasis({ pullRequest: pull ?? { number: checks?.pullRequest.number ?? 0, nodeId: '' }, checks, verified }),
  };
}

export type ReadinessAction = { action: 'none' | 'mark-ready' | 'convert-to-draft'; blocked: string[]; notes: string[]; authorization: string | null };
/**
 * Spec §9.3: which conversion applies to the OBSERVED flag. Ready → mark ready only when the Factory placed the draft (its publication or its
 * own conversion) or the operator authorized restoring an unexpected human draft; confirmed loss → back to draft only when the Factory placed
 * ready; unknown → nothing (no flag oscillation on a network failure). A not-applied conversion of the same basis is never repeated implicitly.
 */
export function readinessAction(input: {
  evaluation: ReadinessEvaluation;
  view: Pick<ReadinessView, 'flag' | 'humanDraft' | 'authorization' | 'effects'>;
  observed: 'draft' | 'ready' | 'unknown';
}): ReadinessAction {
  const { evaluation, view, observed } = input;
  const none = (blocked: string[] = [], notes: string[] = []): ReadinessAction => ({ action: 'none', blocked, notes, authorization: null });
  if (evaluation.reasons.some(item => item.area === 'closed') || observed === 'unknown') return none();
  const wanted =
    evaluation.decision === 'ready' && observed === 'draft'
      ? ('mark-ready' as const)
      : evaluation.decision === 'not-ready' && observed === 'ready'
        ? ('convert-to-draft' as const)
        : null;
  if (!wanted) return none();
  // A disputed ownership (another PR identity, author, branch, repository, base or a head the Factory never linked) blocks EVERY mutation.
  if (evaluation.reasons.some(item => item.area === 'ownership')) return none(['OWNERSHIP_DISPUTED']);
  if (wanted === 'convert-to-draft' && view.flag.factory !== 'ready') return none([], ['READY_FLAG_NOT_PLACED_BY_FACTORY']);
  let authorization: string | null = null;
  const granted = view.authorization;
  if (wanted === 'mark-ready' && view.humanDraft) {
    // Bound to THIS human draft occurrence (PR, head, instant observed): a later draft is another occurrence.
    const binding = granted?.binding;
    if (
      granted?.purpose !== 'human-draft' ||
      binding?.kind !== 'human-draft' ||
      binding.pullRequest !== evaluation.basis.pullRequest ||
      binding.headSha !== view.humanDraft.headSha ||
      binding.observedAt !== view.humanDraft.observedAt
    )
      return none(['HUMAN_DRAFT_AUTHORIZATION_REQUIRED']);
    authorization = granted.request_id;
  }
  const failed = [...view.effects].reverse().find(item => item.action === wanted);
  if (failed?.state === 'not-applied' && sameBasis(failed.basis, evaluation.basis) && !authorization) {
    // Provably never sent (crash/abort after the intent, before the request): ONE automatic re-evaluation per basis.
    const unsent = view.effects.filter(item => item.action === wanted && item.neverSent && sameBasis(item.basis, evaluation.basis)).length;
    if (!(failed.neverSent && unsent <= 1)) {
      const binding = granted?.binding;
      if (granted?.purpose !== 'repeat-conversion' || binding?.kind !== 'not-applied' || binding.effectId !== failed.effectId)
        return none(['CONVERSION_NOT_APPLIED_AUTHORIZATION_REQUIRED']);
      authorization = granted.request_id;
    }
  }
  return { action: wanted, blocked: [], notes: [], authorization };
}

/** Internal readiness after an evaluation: `ready` is only confirmed by a recheck (or kept for the same basis); otherwise withdrawn. */
export function internalReadiness(previous: Pick<ReadinessView, 'internal' | 'latest'> | null, evaluation: ReadinessEvaluation): ReadinessView['internal'] {
  if (evaluation.decision !== 'ready') return evaluation.decision;
  if (evaluation.source === 'recheck') return 'ready';
  return previous?.internal === 'ready' && sameBasis(previous.latest.basis, evaluation.basis) ? 'ready' : 'unknown';
}

/** The flag changes no Factory effect explains: a draft over the Factory's ready is a human draft; a ready over its draft a human ready. */
export function humanFlag(view: Pick<ReadinessView, 'flag'>, observed: 'draft' | 'ready' | 'unknown'): { humanDraft: boolean; humanReady: boolean } {
  return { humanDraft: observed === 'draft' && view.flag.factory === 'ready', humanReady: observed === 'ready' && view.flag.factory === 'draft' };
}

export const readinessFingerprint = (evaluation: ReadinessEvaluation) =>
  JSON.stringify({ ...evaluation, at: null, basis: { ...evaluation.basis, checksAt: null } });

export function readinessNextStep(view: Pick<ReadinessView, 'internal' | 'humanDraft' | 'effect' | 'latest'>, blocked: string[]): string {
  if (view.effect && view.effect.state !== 'confirmed' && view.effect.state !== 'not-applied') {
    return 'A conversion was sent or may have been sent: it is discovered (the flag is read again) before anything is repeated.';
  }
  if (blocked.includes('OWNERSHIP_DISPUTED'))
    return "The pull request no longer matches the Factory's own (identity, author, branch, repository or base): no conversion in either direction. Operator must inspect it on GitHub.";
  if (blocked.includes('HUMAN_DRAFT_AUTHORIZATION_REQUIRED'))
    return 'A human converted the PR back to draft: the Factory respects it. `factory authorize-readiness <work> --reason <text>` authorizes ONE restoration after a complete evaluation.';
  if (blocked.includes('CONVERSION_NOT_APPLIED_AUTHORIZATION_REQUIRED'))
    return 'The conversion was not applied: it is not repeated implicitly. Inspect the reason; `factory authorize-readiness <work> --reason <text>` authorizes ONE new attempt.';
  const merge = view.latest.reasons
    .filter(item => item.area === 'merge' && item.certainty === 'confirmed')
    .map(item => ({
      category: 'merge' as const,
      code: item.code.replace(/^MERGE_BLOCKED_/, ''),
      ...(item.subject !== undefined ? { subject: item.subject } : {}),
    }));
  const blockedMerge = mergeStep(merge);
  if (blockedMerge && view.internal !== 'ready') {
    const others = view.latest.reasons
      .filter(item => item.certainty === 'confirmed' && item.area !== 'merge')
      .map(item => item.code)
      .slice(0, 8);
    return `Not ready. ${blockedMerge}${others.length ? ` Also not ready: ${others.join(', ')}.` : ''}`;
  }
  if (view.internal === 'ready')
    return 'Ready for human review: the evidence is current. Human review, approval and merge are human only; the Factory never approves or merges.';
  if (view.internal === 'unknown')
    return 'Readiness is not confirmed (transient or incomplete evidence): the draft/ready flag is kept and the evidence is read again on a later cycle.';
  return `Not ready: ${view.latest.reasons
    .filter(item => item.certainty === 'confirmed')
    .map(item => item.code)
    .slice(0, 8)
    .join(', ')}.`;
}
