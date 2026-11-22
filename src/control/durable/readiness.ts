import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AccessDependencies, ChecksEvaluation, ControlInput, ControlReceipt, ReadinessEffect, ReadinessEvaluation, ReadinessView } from '../types.js';
import { githubOnly, ticketKey } from '../rules/admission.js';
import { evaluateChecks, type ChecksObservation } from '../rules/checks.js';
import { evaluateReadiness, humanFlag, internalReadiness, readinessAction, readinessFingerprint, readinessNextStep, sameBasis } from '../rules/readiness.js';
import { checksTarget, recordChecks, type ChecksTarget } from './checks.js';
import { evaluateWorkDependencies } from './polling.js';
import { evaluateJiraWorkOf } from './jira-evaluation.js';
import type { OwnCycleFacts } from '../rules/dependencies.js';
import type { DependencyEvaluation } from '../types.js';
import { linkRequest, requests, ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

// Ticket 16 (spec §3.4, §9.2 steps 6-7, §9.3): internal readiness of the linked own PR and its draft/ready conversion, a CONTROLLER effect:
// evaluation from current evidence (ticket 15's explanation, ticket 14's publication/verification), a fresh recheck immediately before any
// conversion, durable intent BEFORE the mutation, the mutation outside any commit, an independent observation and the durable confirmation.
// An uncertain conversion is discovered (the flag is read) before anything else; nothing is ever repeated implicitly. Runs in the existing
// owner loop after the checks pass: no broker, scheduler or registry; never a Slot, queue entry, review, approval or merge.

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const unsettled = (effect: ReadinessEffect | null | undefined): effect is ReadinessEffect =>
  Boolean(effect && (effect.state === 'intended' || effect.state === 'attempted'));
const codes = (evaluation: ReadinessEvaluation) => evaluation.reasons.map(item => `${item.code}${item.subject ? `:${item.subject}` : ''}`).join(',');
/** The flag as the explanation observed it (only from a complete read of the same own PR). */
export const observedFlag = (checks: ChecksEvaluation | null | undefined, number: number): ReadinessView['flag']['observed'] =>
  checks && checks.pullRequest.number === number && checks.completeness.pullRequest === 'complete' && checks.pullRequest.draft !== null
    ? checks.pullRequest.draft
      ? 'draft'
      : 'ready'
    : 'unknown';

async function onWork<T>(session: Session, work_id: string, nodeId: string, change: (work: WorkRecord) => T): Promise<T | 'stale'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work_id || checksTarget(work)?.nodeId !== nodeId)
      return 'stale' as const;
    return change(work);
  }, BACKGROUND_CONTEXT);
}
const history = (work: WorkRecord, event: Extract<WorkRecord['history'][number], { origin: 'controller-readiness' }>['event'], at: string, detail: string) =>
  work.history.push({ at, event, origin: 'controller-readiness', detail: detail.slice(0, 512) });

function present(view: ReadinessView, blocked: string[]) {
  view.stages = { internal: view.internal, flag: view.flag.observed, humanReview: 'human-stage', delivery: 'not-delivered' };
  view.nextStep = readinessNextStep(view, blocked);
}

/**
 * Records one evaluation and the flag it observed: internal readiness (confirmed only by a recheck), flag changes no Factory effect explains
 * (human draft/ready), and the latest evaluation (an identical one is not rewritten). Never changes queue, Slots, impediments or publication.
 */
export async function recordReadiness(
  session: Session,
  work_id: string,
  target: Pick<ChecksTarget, 'nodeId'>,
  evaluation: ReadinessEvaluation,
  observed: ReadinessView['flag']['observed'],
): Promise<ReadinessView | 'stale'> {
  return onWork(session, work_id, target.nodeId, work => {
    const at = evaluation.at;
    const pull = work.publication!.pullRequest!;
    const view: ReadinessView = work.readiness
      ? copy(work.readiness)
      : {
          internal: 'unknown',
          since: at,
          latest: evaluation,
          flag: { factory: pull.draft ? 'draft' : 'ready', origin: 'publication', at: pull.linkedAt, observed: 'unknown', observedAt: null },
          humanDraft: null,
          humanReady: null,
          authorization: null,
          effect: null,
          effects: [],
          stages: { internal: 'unknown', flag: 'unknown', humanReview: 'human-stage', delivery: 'not-delivered' },
          nextStep: '',
        };
    if (observed !== 'unknown') {
      if (view.flag.observed !== observed) {
        view.flag.observed = observed;
        view.flag.observedAt = at;
      }
      if (!unsettled(view.effect)) {
        const human = humanFlag(view, observed);
        if (human.humanDraft && !view.humanDraft) {
          view.humanDraft = { observedAt: at, headSha: evaluation.basis.headSha };
          history(work, 'readiness-human-flag', at, 'draft-not-placed-by-factory');
        }
        if (observed === 'ready') view.humanDraft = null;
        if (human.humanReady && !view.humanReady) {
          view.humanReady = { observedAt: at };
          history(work, 'readiness-human-flag', at, 'ready-not-placed-by-factory');
        }
        if (observed === 'draft') view.humanReady = null;
      }
    }
    const internal = internalReadiness(work.readiness ? view : null, evaluation);
    if (internal !== view.internal) view.since = at;
    view.internal = internal;
    const previous = work.readiness?.latest;
    if (!previous || previous.decision !== evaluation.decision || codes(previous) !== codes(evaluation)) {
      history(work, 'readiness-evaluated', at, `${evaluation.decision}(${evaluation.source}):${codes(evaluation)}`);
    }
    if (!previous || readinessFingerprint(previous) !== readinessFingerprint(evaluation) || previous.source !== evaluation.source) view.latest = evaluation;
    present(view, readinessAction({ evaluation, view, observed }).blocked);
    // Nothing changed (same evaluation, flag and stages): no rewrite.
    if (JSON.stringify(view) !== JSON.stringify(work.readiness ?? null)) work.readiness = view;
    return copy(view);
  });
}

/** "Confirmar intenção" (spec §3.4): recorded BEFORE the mutation, only for the evaluation the recheck just recorded and with no unsettled conversion. */
export async function intendConversion(
  session: Session,
  work_id: string,
  target: Pick<ChecksTarget, 'nodeId'>,
  input: { evaluation: ReadinessEvaluation; action: 'mark-ready' | 'convert-to-draft'; authorization: string | null },
): Promise<ReadinessEffect | 'stale'> {
  return onWork(session, work_id, target.nodeId, work => {
    const view = work.readiness;
    if (
      !view ||
      unsettled(view.effect) ||
      view.latest.source !== 'recheck' ||
      !sameBasis(view.latest.basis, input.evaluation.basis) ||
      readinessAction({ evaluation: view.latest, view, observed: view.flag.observed }).action !== input.action
    )
      return 'stale' as const;
    // Re-checked IN the intent commit: queue, impediments, Execution, correction, recovery, scope updates, publication/content as they are now.
    const local = evaluateReadiness({
      at: new Date().toISOString(),
      source: 'recheck',
      facts: { ...work, current: true },
      checks: view.latest.basis.headSha === work.checks?.latest.pullRequest.headSha ? (work.checks?.latest ?? null) : null,
      installation: 'settled',
      dependencyAttempt: null,
    });
    if (local.decision !== (input.action === 'mark-ready' ? 'ready' : 'not-ready') || local.reasons.some(item => item.area === 'ownership'))
      return 'stale' as const;
    const at = new Date().toISOString();
    const reason =
      input.action === 'mark-ready'
        ? 'READY_FROM_CURRENT_EVIDENCE'
        : `READINESS_LOST:${view.latest.reasons
            .filter(item => item.certainty === 'confirmed')
            .map(item => item.code)
            .slice(0, 8)
            .join(',')}`;
    const effect: ReadinessEffect = {
      effectId: randomUUID(),
      action: input.action,
      reason,
      basis: copy(view.latest.basis),
      intendedAt: at,
      state: 'intended',
      authorization: input.authorization,
      sendingAt: null,
      attempt: null,
      observation: null,
      settledAt: null,
      contradictions: 0,
      neverSent: false,
      headMismatch: null,
    };
    if (input.authorization && view.authorization?.request_id === input.authorization) view.authorization = null;
    view.effect = effect;
    present(view, []);
    history(work, 'readiness-intended', at, `${effect.action}:${effect.effectId}:${reason}`);
    return copy(effect);
  });
}

/** Committed right BEFORE the mutation starts: without it, an `intended` conversion provably never reached GitHub. */
export async function markSending(session: Session, work_id: string, target: Pick<ChecksTarget, 'nodeId'>, effectId: string): Promise<'recorded' | 'stale'> {
  return onWork(session, work_id, target.nodeId, work => {
    const effect = work.readiness?.effect;
    if (!effect || effect.effectId !== effectId || effect.state !== 'intended' || effect.sendingAt) return 'stale' as const;
    effect.sendingAt = new Date().toISOString();
    return 'recorded' as const;
  });
}

export async function recordAttempt(
  session: Session,
  work_id: string,
  target: Pick<ChecksTarget, 'nodeId'>,
  effectId: string,
  attempt: NonNullable<ReadinessEffect['attempt']>,
): Promise<'recorded' | 'stale'> {
  return onWork(session, work_id, target.nodeId, work => {
    const effect = work.readiness?.effect;
    if (!effect || effect.effectId !== effectId || effect.state !== 'intended') return 'stale' as const;
    effect.attempt = attempt;
    effect.state = 'attempted';
    history(
      work,
      'readiness-attempted',
      attempt.at,
      `${effect.action}:${attempt.outcome}${attempt.code ? `:${attempt.code}` : ''}:revocation=${attempt.revocation}`,
    );
    return 'recorded' as const;
  });
}

/** "Confirmar efeito" (spec §3.4): settles the conversion from an INDEPENDENT read of the flag; an unknown read keeps it pending (read again). */
export async function settleConversion(
  session: Session,
  work_id: string,
  target: Pick<ChecksTarget, 'nodeId'>,
  effectId: string,
  observation: NonNullable<ReadinessEffect['observation']>,
): Promise<ReadinessEffect | 'stale'> {
  return onWork(session, work_id, target.nodeId, work => {
    const view = work.readiness;
    const effect = view?.effect;
    if (!view || !effect || effect.effectId !== effectId || !unsettled(effect)) return 'stale' as const;
    effect.observation = observation;
    if (observation.draft === null) return copy(effect);
    const desired = effect.action === 'convert-to-draft';
    const at = observation.at;
    if (observation.draft !== desired && effect.attempt?.outcome === 'applied') {
      // GitHub's own mutation response (flag as desired, our clientMutationId) is the primary evidence: one contrary read is lag, never
      // "not applied" and never a human flag. Kept pending; read again on later passes.
      effect.contradictions = (effect.contradictions ?? 0) + 1;
      present(view, []);
      return copy(effect);
    }
    effect.state = observation.draft === desired ? 'confirmed' : 'not-applied';
    effect.settledAt = at;
    if (effect.state === 'not-applied' && !effect.sendingAt) effect.neverSent = true;
    view.flag.observed = observation.draft ? 'draft' : 'ready';
    view.flag.observedAt = at;
    if (effect.state === 'confirmed') {
      view.flag = { ...view.flag, factory: desired ? 'draft' : 'ready', origin: 'readiness-effect', at };
      view.humanDraft = null;
      view.humanReady = null;
      // A push between the recheck and the mutation: the flag is the Factory's, but on a head never evaluated. Internal readiness is withdrawn;
      // the next evaluation sees the head (confirmed loss) and may restore draft over this Factory-placed ready.
      const heads = [effect.attempt?.headSha ?? null, observation.headSha].filter((item): item is string => item !== null);
      const other = heads.find(item => item !== effect.basis.headSha);
      if (other !== undefined) {
        effect.headMismatch = { evaluated: effect.basis.headSha, observed: other };
        view.internal = 'unknown';
        view.since = at;
      }
    }
    view.effects = [...view.effects, effect].slice(-10);
    view.effect = null;
    history(
      work,
      effect.state === 'confirmed' ? 'readiness-confirmed' : 'readiness-not-applied',
      at,
      `${effect.action}:${effect.effectId}:draft=${observation.draft}` +
        `${effect.neverSent ? ':never-sent' : ''}${effect.headMismatch ? `:head-mismatch=${effect.headMismatch.observed}` : ''}`,
    );
    present(view, effect.state === 'not-applied' ? ['CONVERSION_NOT_APPLIED_AUTHORIZATION_REQUIRED'] : []);
    return copy(effect);
  });
}

/** "Aceitar comando" for `authorize-readiness`: one authorization for the pending purpose (human draft or a not-applied conversion), deduplicated. */
export async function acceptReadinessAuthorization(
  session: Session,
  input: Extract<ControlInput, { operation: 'authorize-readiness' }>,
): Promise<Extract<ControlReceipt, { operation: 'authorize-readiness' }> | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  type Receipt = Extract<ControlReceipt, { operation: 'authorize-readiness' }>;
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return copy(request.receipt) as Receipt;
    }
    const index = await tx.doc(ticketIndex);
    const work = (await tx.doc(works, input.work_id, null)).work;
    const refuse = (code: string): Receipt => ({
      kind: 'durable',
      request_id: input.request_id,
      operation: 'authorize-readiness',
      work_id: input.work_id,
      outcome: 'not-applied',
      reason: code,
      purpose: null,
    });
    const view = work?.readiness ?? null;
    const last = view?.effects.at(-1);
    let receipt: Receipt;
    if (!work) receipt = refuse('WORK_NOT_FOUND');
    else if (work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== work.work_id) receipt = refuse('WORK_NOT_CURRENT');
    else if (!view) receipt = refuse('READINESS_NOT_EVALUATED');
    else if (unsettled(view.effect)) receipt = refuse('CONVERSION_PENDING_DISCOVERY');
    else if (!view.humanDraft && last?.state !== 'not-applied') receipt = refuse('NOTHING_TO_AUTHORIZE');
    else {
      const at = new Date().toISOString();
      const purpose = view.humanDraft ? ('human-draft' as const) : ('repeat-conversion' as const);
      // Bound to the occurrence it answers; consumed once by the conversion that uses it.
      const binding = view.humanDraft
        ? {
            kind: 'human-draft' as const,
            pullRequest: work.publication?.pullRequest?.number ?? 0,
            headSha: view.humanDraft.headSha,
            observedAt: view.humanDraft.observedAt,
          }
        : { kind: 'not-applied' as const, effectId: last!.effectId };
      view.authorization = { request_id: input.request_id, at, reason: input.reason, purpose, binding };
      work.history.push({ at, event: 'readiness-authorized', origin: 'local-cli', detail: `${purpose}:${input.request_id}` });
      receipt = {
        kind: 'durable',
        request_id: input.request_id,
        operation: 'authorize-readiness',
        work_id: work.work_id,
        outcome: 'accepted',
        reason: null,
        purpose,
      };
    }
    request.input = input;
    request.receipt = receipt;
    if (work) await linkRequest(tx, work.work_id, input.request_id);
    return copy(receipt);
  }, BACKGROUND_CONTEXT);
}

export type ReadinessDeskOptions = {
  session: Session;
  access: AccessDependencies;
  readWorks(): Promise<WorkRecord[]>;
  /** Installation-level reconciliation state of THIS run (ticket 26). */
  installation(): 'settled' | 'reconciliation-required';
  /** Fresh native dependency evaluation before every recheck (spec §9.3: no dependency impediment, as of NOW). */
  dependencies: {
    ownCycles(issueIds: number[]): Promise<Record<number, OwnCycleFacts>>;
    record(work_id: string, evaluation: DependencyEvaluation): Promise<unknown>;
  };
  clock?: { monotonic(): number };
  /** Per-Work minimum interval between fresh rechecks (production: the polling interval). */
  minIntervalMs?: number;
  /** At most this many Works with remote reads/effects per pass. */
  perPass?: number;
};

/** The readiness pass, run by the owner loop AFTER the checks pass. Memory-only cadence (rebuilt after restart); the durable effect record decides. */
export function createReadinessDesk(deps: ReadinessDeskOptions) {
  const clock = deps.clock ?? { monotonic: () => performance.now() };
  const minIntervalMs = deps.minIntervalMs ?? 60000;
  const perPass = deps.perPass ?? 2;
  const due = new Map<string, number>();
  return {
    async pass(signal: AbortSignal) {
      let remote = 0;
      for (const work of await deps.readWorks()) {
        if (signal.aborted) return;
        const target = checksTarget(work);
        if (!target || remote >= perPass) continue;
        const configured = deps.access.repositories.find(item => item.repository.toLowerCase() === work.repository.repository.toLowerCase());
        if (!configured) continue;
        const now = clock.monotonic();
        const read = async (): Promise<ChecksEvaluation> => {
          let observation: ChecksObservation;
          try {
            const result = await deps.access.repository.readPullRequest({ repo: configured, number: target.number });
            observation =
              result.kind === 'unchanged'
                ? {
                    kind: 'unavailable',
                    source: 'github-rest',
                    observedAt: result.observedAt,
                    repository: result.repository,
                    code: 'UNEXPECTED_LIGHT_READ',
                    nextStep: 'A full read was requested.',
                  }
                : result;
          } catch {
            observation = {
              kind: 'unavailable',
              source: 'github-rest',
              observedAt: new Date().toISOString(),
              repository: work.repository.repository,
              code: 'PULL_REQUEST_QUERY_FAILED',
              nextStep: 'Nothing is concluded; a later cycle reads again.',
            };
          }
          const evaluation = evaluateChecks({ at: new Date().toISOString(), expect: target.expect, observation });
          await recordChecks(deps.session, work.work_id, target, evaluation);
          return evaluation;
        };
        const observe = async (effect: ReadinessEffect) => {
          const checks = await read();
          const flag = observedFlag(checks, target.number);
          return settleConversion(deps.session, work.work_id, target, effect.effectId, {
            at: new Date().toISOString(),
            draft: flag === 'unknown' ? null : flag === 'draft',
            headSha: checks.pullRequest.headSha,
            code: flag === 'unknown' ? (checks.reasons[0]?.subject ?? checks.reasons[0]?.code ?? 'FLAG_UNKNOWN') : null,
          });
        };
        // 0. A conversion that was (or may have been) sent is DISCOVERED first; the mutation itself is never resent from here.
        if (unsettled(work.readiness?.effect)) {
          remote++;
          await observe(work.readiness.effect);
          continue;
        }
        const facts = { ...work, current: true };
        const recorded = evaluateReadiness({
          at: new Date().toISOString(),
          source: 'recorded',
          facts,
          checks: work.checks?.latest ?? null,
          installation: deps.installation(),
        });
        const observed = observedFlag(work.checks?.latest, target.number);
        const view = await recordReadiness(deps.session, work.work_id, target, recorded, observed);
        if (view === 'stale') continue;
        const action = readinessAction({ evaluation: recorded, view, observed });
        const recheck = action.action !== 'none' || (recorded.decision === 'ready' && view.internal !== 'ready');
        if (!recheck || (due.get(work.work_id) ?? Number.NEGATIVE_INFINITY) > now) continue;
        remote++;
        due.set(work.work_id, now + minIntervalMs);
        // 6. Recheck identity/head/base/requirements immediately before converting (a fresh complete read, recorded as the checks explanation).
        const dependencyAttempt = randomUUID();
        let dependenciesRead = false;
        try {
          // Jira ticket 08: a Jira Work's dependencies are its Card's visible blockers at its origin (never the GitHub graph).
          const { evaluation } =
            work.ticket.tracker === 'jira'
              ? await evaluateJiraWorkOf(deps.access, work.ticket, dependencyAttempt)
              : await evaluateWorkDependencies(deps.access.tracker, deps.dependencies.ownCycles, githubOnly(work.ticket), dependencyAttempt);
          await deps.dependencies.record(work.work_id, evaluation);
          dependenciesRead = true;
        } catch {
          dependenciesRead = false;
        }
        const checks = await read();
        if (signal.aborted) return;
        const fresh = (await deps.readWorks()).find(item => item.work_id === work.work_id);
        if (!fresh) continue;
        const rechecked = evaluateReadiness({
          at: new Date().toISOString(),
          source: 'recheck',
          facts: { ...fresh, current: true },
          checks,
          installation: deps.installation(),
          dependencyAttempt: dependenciesRead ? dependencyAttempt : 'not-read',
        });
        const after = observedFlag(checks, target.number);
        if (!sameBasis(recorded.basis, rechecked.basis)) rechecked.notes.push('RECHECK_CHANGED_BASIS');
        const current = await recordReadiness(deps.session, work.work_id, target, rechecked, after);
        // A change between the evaluation and the recheck invalidates it: recalculated on a later pass, nothing converted now.
        if (current === 'stale' || !sameBasis(recorded.basis, rechecked.basis)) continue;
        const decided = readinessAction({ evaluation: rechecked, view: current, observed: after });
        if (decided.action === 'none' || decided.action !== action.action) continue;
        // 7. Intent → mutation outside the commit → attempt → independent observation → durable confirmation.
        const effect = await intendConversion(deps.session, work.work_id, target, {
          evaluation: rechecked,
          action: decided.action,
          authorization: decided.authorization,
        });
        // Aborted after the intent: nothing is sent (the discovery then settles it as never sent).
        if (effect === 'stale' || signal.aborted) continue;
        if ((await markSending(deps.session, work.work_id, target, effect.effectId)) === 'stale') continue;
        let attempt: NonNullable<ReadinessEffect['attempt']>;
        try {
          const result = await deps.access.repository.setDraft(
            { repo: configured, number: target.number, nodeId: target.nodeId },
            decided.action === 'convert-to-draft',
            { effectId: effect.effectId },
          );
          attempt = {
            at: new Date().toISOString(),
            outcome: result.kind,
            code: result.kind === 'applied' ? null : result.code,
            revocation: result.revocation,
            headSha: result.kind === 'applied' ? result.headSha : null,
          };
        } catch {
          attempt = { at: new Date().toISOString(), outcome: 'unknown', code: 'DRAFT_CONVERSION_FAILED', revocation: 'unknown' };
        }
        await recordAttempt(deps.session, work.work_id, target, effect.effectId, attempt);
        await observe(effect);
      }
    },
  };
}
