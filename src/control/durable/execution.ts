import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import type { BuilderGrantMetadata, RevocationResult } from '../../contracts/index.js';
import type { CredentialGrantRecord, CredentialWithdrawal, ExecutionCharge, ExecutionView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { chargeDecision, classifyOverrun, exhaustionImpediment, initialBudget, overrunNotExcludedImpediment, timeoutImpediment, timeoutReached, type Motive } from '../rules/budget.js';
import { dispatchBlockers } from '../rules/dependencies.js';
import { installation, legacyCredentialLifecycle, ticketIndex, works, type WorkRecord } from './admission.js';
import { questions } from './questions.js';
import { pendingScope } from './scope.js';
import { markPublicationAttempt } from './publication.js';
import type { Session } from './store.js';
import { classifyInterruption } from '../rules/recovery.js';
import { applyRecoveryRequest, backoffRunning } from './recovery-request.js';

/** The interruption basis still describes the Work: its current Execution ended stopped, or failed with a pending operational recovery. */
export function interruptionBasis(work: Pick<WorkRecord, 'execution' | 'pendingRecovery'>): NonNullable<ExecutionView['interruption']> | null {
  const execution = work.execution ?? null;
  if (!execution) return null;
  // Released before its start: it never ran, so the basis it was admitted with still holds.
  if (execution.state === 'released' && !execution.start) return execution.interruption ?? null;
  if (execution.state !== 'ended' || execution.slot.held || !execution.end) return null;
  if (execution.end.outcome === 'stopped') return { previousExecutionId: execution.executionId, reason: 'ADMINISTRATIVE_STOP', code: execution.end.code ?? 'ADMINISTRATIVE_STOP' };
  if (execution.end.outcome === 'failure' && work.pendingRecovery) return { previousExecutionId: execution.executionId, reason: 'OPERATIONAL_RECOVERY', code: execution.end.code ?? 'CONTROLLER_CRASH' };
  return null;
}
const interruptionHolds = (work: WorkRecord, basis: NonNullable<ExecutionView['interruption']>) => JSON.stringify(interruptionBasis(work)) === JSON.stringify(basis);

/** Installation-level Slot occupancy, committed with every reservation/release (spec §3.4 "Admitir Execução"). */
export const slots = defineDoc<{ held: Record<string, string> }>({ kind: 'factory.slots', version: 1, scope: 'session',
  initial: () => ({ held: {} }), checkpointWhen: () => true });

export async function initializeSlots(session: Session) {
  await session.commit(async tx => { await tx.doc(slots); }, BACKGROUND_CONTEXT);
}
export async function heldSlots(session: Session): Promise<number> {
  return Object.keys((await session.snapshot(slots, BACKGROUND_CONTEXT))?.held ?? {}).length;
}

/** The Execution a resumption continues from: the latest one that actually ENDED (one released before its start never ran). */
export function resumeBasis(work: Pick<WorkRecord, 'execution' | 'previousExecutions'>): ExecutionView | null {
  return [work.execution ?? null, ...[...(work.previousExecutions ?? [])].reverse()].find(item => item?.end) ?? null;
}
export type Admission = { kind: 'reserved'; execution: ExecutionView } | { kind: 'refused'; reasons: string[] };
const history = (work: WorkRecord, event: Extract<WorkRecord['history'][number], { origin: 'controller-dispatch' }>['event'], executionId: string, detail?: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-dispatch', executionId, ...(detail ? { detail } : {}) });
/** An ended Execution whose own boot ceased and whose Slot was released no longer blocks a NEW Execution (e.g. after an answer). */
export const activeExecution = (execution: ExecutionView | null) => execution !== null && execution.state !== 'released' && !(execution.state === 'ended' && !execution.slot.held);

/**
 * "Admitir Execução" (spec §3.4): in ONE commit, the Work is still open, pending and the Ticket's current cycle; the global pause is off;
 * it has no impediment; the native dependency evaluation is the one produced by THIS dispatch attempt and is satisfied; a Slot is free.
 * Writes the Execution identity, its Slot, the dispatch intent and the Work's own branch. Nothing external happens before this commit.
 */
export async function admitExecution(session: Session, input: { work_id: string; attemptId: string; capacity: number; authorizationObservedAt: string;
  request: Omit<ExecutionView['request'], 'baseCommit' | 'checkout' | 'promptSha256' | 'skillPack' | 'resume' | 'scopeUpdateIds' | 'session' | 'publication'> & {
    /** Ticket 14: present only for a publication activation; re-checked against the Work's requested publication in this commit. */
    publication?: ExecutionView['request']['publication'] };
  /** Configured limits of the repository: initialize a budget absent on a pre-19 Work, and the per-Execution timeout (absent = none). */
  limits?: { correctionLimit?: number | undefined; recoveryLimit?: number | undefined; timeoutSeconds?: number | undefined };
  /** Recovery basis after an answered Question; re-checked in this commit (the answer and the previous Execution must still match). */
  resume?: NonNullable<ExecutionView['request']['resume']>;
  /** Ticket 26: basis after an interrupted Execution (operational recovery or continuation after a clean stop); re-checked here. */
  interruption?: NonNullable<ExecutionView['interruption']>;
  /** Ticket 26: calendar instant of this attempt (ms), against the persisted recovery wait. */
  now?: number }): Promise<Admission> {
  return session.commit(async tx => {
    const reasons: string[] = [];
    if ((await tx.doc(installation)).paused) reasons.push('GLOBAL_PAUSE');
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, input.work_id, null);
    const work = document.work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== input.work_id) return { kind: 'refused' as const, reasons: ['WORK_NOT_CURRENT'] };
    if (!work.queue.pending || activeExecution(work.execution ?? null)) reasons.push('EXECUTION_ALREADY_ACTIVE');
    const latest = work.dependencies?.latest ?? null;
    reasons.push(...dispatchBlockers({ impediments: work.impediments, evaluation: latest, currentAttempt: input.attemptId }));
    if (latest && latest.conclusion !== 'satisfied' && !reasons.length) reasons.push('DEPENDENCIES_NOT_SATISFIED');
    const occupancy = await tx.doc(slots);
    if (Object.keys(occupancy.held).length >= input.capacity) reasons.push('NO_SLOT_AVAILABLE');
    // Ticket 26: the persisted recovery wait is never anticipated, and an interruption basis must still name the Work's current Execution.
    if (backoffRunning(work, input.now ?? Date.now())) reasons.push('RECOVERY_BACKOFF');
    if (input.interruption && !interruptionHolds(work, input.interruption)) reasons.push('INTERRUPTION_BASIS_CHANGED');
    const previous = resumeBasis(work);
    // Every pending authorized scope change is bound to THIS Execution (ticket 11), and the resumption basis must name exactly them.
    const scopeUpdateIds = pendingScope(work).map(update => update.scopeUpdateId);
    const sameScope = JSON.stringify(input.resume?.scopeUpdateIds ?? []) === JSON.stringify(scopeUpdateIds);
    if (previous?.end?.outcome === 'question') {
      const question = input.resume?.questionId ? (await tx.doc(questions, input.resume.questionId, null)).question : null;
      if (!input.resume || input.resume.reason !== 'QUESTION_ANSWERED' || input.resume.previousExecutionId !== previous.executionId || input.resume.questionId !== previous.end.questionId ||
          question?.state !== 'answered' || question.answer?.sha256 !== input.resume.answerSha256 || question.workId !== input.work_id ||
          question.executionId !== previous.executionId || !sameScope) reasons.push('RESUME_BASIS_CHANGED');
    } else if (previous?.end?.outcome === 'completed' && scopeUpdateIds.length) {
      // After a COMPLETED Execution only an authorized concrete scope change resumes the Work (never a later Ticket/link edit).
      if (!input.resume || input.resume.reason !== 'SCOPE_UPDATED' || input.resume.previousExecutionId !== previous.executionId || input.resume.questionId !== null || !sameScope) reasons.push('RESUME_BASIS_CHANGED');
    } else if (work.publication?.state === 'requested' && previous?.end?.outcome === 'completed' && previous.executionId === work.publication.basisExecutionId) {
      // Ticket 14: the publication activation carries exactly the requested basis, verified commit, branch/base, marker and lease expectation.
      const requested = work.publication;
      const asked = input.request.publication;
      if (!input.resume || input.resume.reason !== 'PUBLICATION_REQUESTED' || input.resume.previousExecutionId !== previous.executionId || input.resume.questionId !== null ||
          !asked || !requested.verified || asked.basisExecutionId !== requested.basisExecutionId || asked.head !== requested.verified.head || asked.branch !== requested.branch ||
          asked.base !== requested.base || asked.marker !== requested.marker || JSON.stringify(asked.expectedRemote) !== JSON.stringify(requested.expectedRemote) ||
          (asked.pullRequest ?? null) !== (requested.update ?? null) || publicationAttemptedHead(requested, asked.head) ||
          input.request.branch !== requested.branch) reasons.push('RESUME_BASIS_CHANGED');
    } else if (input.resume) reasons.push('RESUME_BASIS_CHANGED');
    // A publication activation started earlier and its effects are not discovered yet: nothing else runs before the discovery (spec §9.1).
    if (work.publication?.state === 'awaiting-discovery') reasons.push('PUBLICATION_DISCOVERY_PENDING');
    if (input.request.publication && input.resume?.reason !== 'PUBLICATION_REQUESTED') reasons.push('RESUME_BASIS_CHANGED');
    if (reasons.length) return { kind: 'refused' as const, reasons: [...new Set(reasons)] };
    const now = new Date().toISOString();
    // Budget reservation in THIS commit (spec §3.4): the correction once, each operational recovery once, the initial implementation never.
    work.budget ??= initialBudget(input.limits ?? {}, work.repository.repository, now);
    const decision = chargeDecision(work.budget, motiveOf(work));
    if (decision.kind === 'exhausted') {
      // Durable, visible exhaustion: the impediment keeps the Work out of selection (no automatic loop) until an explicit grant.
      if (!work.impediments.some(item => item.code === decision.code)) {
        work.impediments.push(exhaustionImpediment(decision.counter, work.work_id, now));
        budgetHistory(work, 'budget-exhausted', null, `${decision.counter}:${work.budget[decision.counter].consumed}/${work.budget[decision.counter].limit + work.budget[decision.counter].granted}`);
      }
      return { kind: 'refused' as const, reasons: [decision.code] };
    }
    const executionId = randomUUID();
    const charge: ExecutionCharge = decision.kind === 'reserve' ? { kind: decision.counter === 'corrections' ? 'correction' : 'recovery', correctionId: decision.correctionId,
      counter: decision.counter, state: 'reserved', settledAt: null }
      : decision.kind === 'preserve' ? { kind: 'correction', correctionId: decision.correctionId, counter: 'corrections', state: 'preserved', settledAt: now }
        : { kind: 'none', correctionId: null, counter: null, state: 'none', settledAt: null };
    if (decision.kind === 'reserve') {
      work.budget[decision.counter].reserved = executionId;
      budgetHistory(work, 'budget-reserved', executionId, decision.counter);
    }
    const execution: ExecutionView = {
      executionId, invocationId: `builder-${executionId}`, mode: input.resume ? 'recovery' : 'initial', state: 'reserved',
      slot: { held: true, capacity: input.capacity, reservedAt: now, releasedAt: null },
      admission: { attemptId: input.attemptId, evaluationId: latest!.evaluationId, authorizationObservedAt: input.authorizationObservedAt, activationAttemptId: null, activationEvaluationId: null },
      dispatch: { intent: 'prepare-start-activate', phase: 'reserved', environment: null, boot: null, updatedAt: now },
      request: { ...requestOf(input.request), baseCommit: null, checkout: null, promptSha256: null, skillPack: null, resume: input.resume ?? null, scopeUpdateIds, session: null,
        ...(input.request.publication ? { publication: structuredClone(input.request.publication) } : {}) },
      credential: null, credentialIssuance: null, credentialRenewals: [],
      credentialLifecycle: { state: 'none', withdrawnAt: null, reason: null, renewal: 'enabled', renewalStop: null, workerNotice: null },
      start: null, end: null, held: null,
      completion: { automatic: false, reason: input.request.publication
        ? 'Publication activation: its effects are discovered by Control after cessation (own branch tip and own draft pull request); the Builder\'s message is not evidence.'
        : 'An ended Builder Execution never completes the Work automatically: publication requires the end-of-Execution verification and a discovery; readiness is not enabled in this Factory version.' },
      charge, timing: { timeoutSeconds: input.limits?.timeoutSeconds ?? null, clock: 'controller-monotonic', origin: null, startedAt: null, lastActivity: null,
        duration: null, timeout: null, overrun: null },
      interruption: input.interruption ?? null,
    };
    occupancy.held[executionId] = input.work_id;
    if (work.execution) work.previousExecutions = [...(work.previousExecutions ?? []), work.execution];
    work.execution = execution;
    work.branch = input.request.branch;
    work.queue = { ...work.queue, pending: false };
    history(work, 'execution-reserved', executionId);
    return { kind: 'reserved' as const, execution: structuredClone(execution) };
  }, BACKGROUND_CONTEXT);
}

/** The head was already attempted (recorded at an activation commit): never admitted again. */
const publicationAttemptedHead = (publication: NonNullable<WorkRecord['publication']>, head: string) => (publication.attempts ?? []).some(item => item.head === head);
const requestOf = <T extends { publication?: unknown }>(request: T): Omit<T, 'publication'> => { const { publication: _publication, ...rest } = request; return rest; };
/** Motive of the next activation: a pending operational recovery, else the open correction (charged once), else nothing to charge. */
function motiveOf(work: WorkRecord): Motive {
  if (work.pendingRecovery) return { kind: 'recovery', correctionId: work.correction?.correctionId ?? null };
  if (work.correction) return { kind: 'correction', correctionId: work.correction.correctionId, consumed: work.correction.consumed };
  return { kind: 'none' };
}
export const budgetHistory = (work: WorkRecord, event: 'budget-reserved' | 'budget-consumed' | 'budget-released' | 'budget-exhausted', executionId: string | null, detail: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-budget', executionId, detail });

/** Consumption exactly once with the confirmed start (spec §3.4 "Confirmar início"); events, tests, pushes and renewals never charge. */
export function consumeReservation(work: WorkRecord, execution: ExecutionView, at: string) {
  const charge = execution.charge;
  if (!charge || charge.state !== 'reserved' || !charge.counter || !work.budget) return;
  const counter = work.budget[charge.counter];
  if (counter.reserved === execution.executionId) counter.reserved = null;
  counter.consumed += 1;
  Object.assign(charge, { state: 'consumed', settledAt: at });
  if (charge.kind === 'correction' && work.correction?.correctionId === charge.correctionId) work.correction.consumed = true;
  if (charge.kind === 'recovery') work.pendingRecovery = null;
  budgetHistory(work, 'budget-consumed', execution.executionId, charge.counter);
}
/** Proven non-start (spec §4.4): the reservation is released without consumption; the correction/recovery stays pending. */
export function releaseReservation(work: WorkRecord, execution: ExecutionView, at: string) {
  const charge = execution.charge;
  if (!charge || charge.state !== 'reserved' || !charge.counter || !work.budget) return;
  if (work.budget[charge.counter].reserved === execution.executionId) work.budget[charge.counter].reserved = null;
  Object.assign(charge, { state: 'released', settledAt: at });
  budgetHistory(work, 'budget-released', execution.executionId, charge.counter);
}

type Expect = { state: ExecutionView['state']; phases: ExecutionView['dispatch']['phase'][] };
/** Phase transition only when the Execution is still the Work's current one in the expected state/phase (currency check in the commit). */
export async function advance(session: Session, work_id: string, executionId: string, expect: Expect,
  mutate: (execution: ExecutionView, work: WorkRecord, facts: { paused: boolean }) => void | string[]): Promise<{ kind: 'advanced'; execution: ExecutionView } | { kind: 'stale' } | { kind: 'refused'; reasons: string[] }> {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.state !== expect.state || !expect.phases.includes(execution.dispatch.phase)) return { kind: 'stale' as const };
    const refused = mutate(execution, work, { paused: (await tx.doc(installation)).paused });
    if (refused?.length) return { kind: 'refused' as const, reasons: refused };
    execution.dispatch.updatedAt = new Date().toISOString();
    return { kind: 'advanced' as const, execution: JSON.parse(JSON.stringify(execution)) as ExecutionView };
  }, BACKGROUND_CONTEXT);
}

export const recordPhase = (session: Session, work_id: string, executionId: string, from: ExecutionView['dispatch']['phase'],
  to: ExecutionView['dispatch']['phase'], event: 'execution-prepared' | 'execution-booted', patch: (execution: ExecutionView) => void) =>
  advance(session, work_id, executionId, { state: 'reserved', phases: [from] }, (execution, work) => { patch(execution); execution.dispatch.phase = to; history(work, event, executionId); });

/**
 * Revalidation commit immediately before activation: still current, Slot held, no impediment and an evaluation of THIS activation attempt
 * that is satisfied. Records the token-free grant metadata with the activation intent.
 */
export const confirmActivation = (session: Session, work_id: string, executionId: string, attemptId: string, credential: BuilderGrantMetadata, promptSha256: string,
  /** Resumed Builder: the continue/replace decision and its reason, recorded with the activation intent (ticket 11). */
  sessionDecision: ExecutionView['request']['session'] = null) =>
  advance(session, work_id, executionId, { state: 'reserved', phases: ['booted'] }, (execution, work, facts) => {
    const reasons = facts.paused ? ['GLOBAL_PAUSE'] : [];
    reasons.push(...dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies?.latest ?? null, currentAttempt: attemptId }));
    if (work.dependencies?.latest?.conclusion !== 'satisfied' && !reasons.length) reasons.push('DEPENDENCIES_NOT_SATISFIED');
    if (!execution.slot.held) reasons.push('SLOT_NOT_HELD');
    // Ticket 14: only a publication activation holds a publication grant, and it always does.
    if (credential.purpose !== purposeOf(execution)) reasons.push('CREDENTIAL_PURPOSE_MISMATCH');
    if (reasons.length) return reasons;
    execution.admission.activationAttemptId = attemptId;
    execution.admission.activationEvaluationId = work.dependencies!.latest!.evaluationId;
    execution.credential = credential;
    execution.request.promptSha256 = promptSha256;
    execution.request.session = sessionDecision;
    execution.dispatch.phase = 'activation-requested';
    history(work, 'activation-requested', executionId);
    // Ticket 14: the attempt is durable BEFORE any launch: a lost receipt or crash can never lead to a blind second publication.
    markPublicationAttempt(work, execution, new Date().toISOString());
    return [];
  });

/** The fixed grant purpose of an activity (spec §8): publication activations publish; every other Builder activation only reads. */
export const purposeOf = (execution: Pick<ExecutionView, 'request'>) => execution.request.publication ? 'builder-publish' as const : 'builder-start' as const;
const blankGrant = (): CredentialGrantRecord => ({ requestedAt: new Date().toISOString(), outcome: 'requested', code: null, metadata: null,
  revocation: null, revocationCode: null, risk: null, revocationAttemptedAt: null });
// Records written before ticket 20 lack these fields; every credential commit completes them in place.
function lifecycleOf(execution: ExecutionView) {
  execution.credentialRenewals ??= [];
  execution.credentialLifecycle ??= legacyCredentialLifecycle(execution);
  execution.credentialLifecycle.workerNotice ??= null;
  return execution.credentialLifecycle;
}
async function onExecution<T>(session: Session, work_id: string, executionId: string, change: (execution: ExecutionView) => T): Promise<T | 'stale'> {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!execution || execution.executionId !== executionId) return 'stale' as const;
    lifecycleOf(execution);
    return change(execution);
  }, BACKGROUND_CONTEXT);
}

/** Initial grant record of the current Execution (any state): intent before the call, then outcome/metadata. Never the token. */
export async function recordIssuance(session: Session, work_id: string, executionId: string, update: Partial<CredentialGrantRecord>) {
  return onExecution(session, work_id, executionId, execution => {
    if (!execution.credentialIssuance && update.outcome !== 'requested') return 'stale' as const;
    execution.credentialIssuance = { ...(execution.credentialIssuance ?? blankGrant()), ...update };
    if (update.outcome === 'issued' && execution.credentialLifecycle.state === 'none') execution.credentialLifecycle.state = 'active';
    return 'recorded' as const;
  });
}

/**
 * Renewal intent (spec §8.1: "nova issue após revalidar autorização da atividade"): in ONE commit, the Execution is the Work's current one,
 * its activity is started and not ended/held, the Work is open, the credential lifecycle is active with renewal enabled, the repository is
 * still configured for execution and the purpose is the activity's own. Eligibility for a NEXT activation (label, pause, dependencies) is
 * deliberately NOT a condition: its withdrawal does not cut an activity that is still authorized.
 */
export async function beginRenewal(session: Session, work_id: string, executionId: string, facts: { repositoryConfigured: boolean }):
  Promise<{ kind: 'begun'; sequence: number } | { kind: 'refused'; reasons: string[] }> {
  const result = await session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId) return { kind: 'refused' as const, reasons: ['EXECUTION_NOT_CURRENT'] };
    const lifecycle = lifecycleOf(execution);
    const reasons: string[] = [];
    if (work.result !== 'open') reasons.push('WORK_NOT_OPEN');
    if (execution.state !== 'started' || execution.dispatch.phase !== 'started' || execution.held) reasons.push('ACTIVITY_NOT_AUTHORIZED');
    if (lifecycle.state !== 'active') reasons.push('CREDENTIALS_WITHDRAWN');
    if (lifecycle.renewal !== 'enabled') reasons.push('RENEWAL_STOPPED');
    if (!facts.repositoryConfigured) reasons.push('REPOSITORY_NOT_CONFIGURED');
    if (execution.credential?.purpose !== purposeOf(execution)) reasons.push('PURPOSE_MISMATCH');
    if (reasons.length) return { kind: 'refused' as const, reasons };
    const sequence = execution.credentialRenewals.length + 1;
    execution.credentialRenewals.push({ ...blankGrant(), sequence, delivery: null });
    return { kind: 'begun' as const, sequence };
  }, BACKGROUND_CONTEXT);
  return result;
}

/** Outcome/metadata/delivery of one renewal. Returns whether the lifecycle is still active, so a grant issued after a withdrawal is never delivered. */
export async function recordRenewal(session: Session, work_id: string, executionId: string, sequence: number,
  update: Partial<CredentialGrantRecord & { delivery: 'delivered' | 'failed' | 'not-delivered' }>) {
  return onExecution(session, work_id, executionId, execution => {
    const renewal = execution.credentialRenewals.find(item => item.sequence === sequence);
    if (!renewal) return 'stale' as const;
    Object.assign(renewal, update);
    return execution.credentialLifecycle.state === 'active' ? 'active' as const : 'withdrawn' as const;
  });
}

/** No further renewal for this activity (failed/unknown issuance or delivery): recorded, never retried blindly, never a restart. */
export const stopRenewal = (session: Session, work_id: string, executionId: string, code: string) =>
  onExecution(session, work_id, executionId, execution => {
    if (execution.credentialLifecycle.renewal === 'enabled') Object.assign(execution.credentialLifecycle, { renewal: 'stopped', renewalStop: code });
    return 'recorded' as const;
  });

/** Withdrawal commit (end/external wait/cancellation/hold/owner stop): no new delivery or renewal afterwards. The first reason is kept. */
export const withdrawCredentials = (session: Session, work_id: string, executionId: string, reason: CredentialWithdrawal) =>
  onExecution(session, work_id, executionId, execution => {
    const lifecycle = execution.credentialLifecycle;
    if (lifecycle.state === 'withdrawn') return 'already-withdrawn' as const;
    Object.assign(lifecycle, { state: 'withdrawn', withdrawnAt: new Date().toISOString(), reason });
    return 'withdrawn' as const;
  });

const grantRecord = (execution: ExecutionView, grant: 'initial' | number) =>
  grant === 'initial' ? execution.credentialIssuance : execution.credentialRenewals.find(item => item.sequence === grant);

/** Durable revocation intent, committed BEFORE the request is sent. */
export const recordRevocationIntent = (session: Session, work_id: string, executionId: string, grant: 'initial' | number) =>
  onExecution(session, work_id, executionId, execution => {
    const record = grantRecord(execution, grant);
    if (!record) return 'stale' as const;
    record.revocationAttemptedAt = new Date().toISOString();
    return 'recorded' as const;
  });

/** Durable result of the withdraw-credential directive to the live worker. */
export const recordWorkerNotice = (session: Session, work_id: string, executionId: string, notice: string) =>
  onExecution(session, work_id, executionId, execution => { execution.credentialLifecycle.workerNotice = notice; return 'recorded' as const; });

/** Outcome of the single revocation attempt of one known grant. */
export const recordRevocation = (session: Session, work_id: string, executionId: string, grant: 'initial' | number, result: RevocationResult) =>
  onExecution(session, work_id, executionId, execution => {
    const record = grantRecord(execution, grant);
    if (!record) return 'stale' as const;
    Object.assign(record, { revocation: result.kind, revocationCode: result.code ?? null });
    return 'recorded' as const;
  });

/**
 * Boot reconciliation of grants a previous controller process held only in memory (spec §8: "valor perdido pode impedir revogação"): every
 * known grant without a revocation outcome becomes `impossible` with its external-validity risk. Nothing is recovered from logs/sessions,
 * no revocation or cessation is claimed, and no impediment, pause or dispatch reason is added because of it.
 */
export async function reconcileLostCredentials(session: Session, live: (executionId: string) => boolean): Promise<number> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  let reconciled = 0;
  for (const id of index?.order ?? []) {
    reconciled += await session.commit(async tx => {
      const document = await tx.doc(works, id, null);
      const execution = document.work?.execution ?? null;
      // Grants still held in THIS process's memory (another run/Control in-process) are live, never relabelled.
      if (!execution || live(execution.executionId)) return 0;
      const lifecycle = lifecycleOf(execution);
      let count = 0;
      for (const grant of [execution.credentialIssuance, ...execution.credentialRenewals]) {
        if (!grant || grant.outcome === 'failed' || grant.outcome === 'not-attempted') continue;
        const until = grant.metadata?.expiresAt ?? `at most one hour after ${grant.requestedAt} (issuance outcome ${grant.outcome})`;
        if (grant.revocation === 'not-attempted' && !grant.risk) {
          grant.risk = `Revocation was not attempted (record from before the active credential lifecycle); the grant may have remained valid externally until ${until}. Expiry is not proof of cessation.`;
          count++;
          continue;
        }
        if (grant.revocation !== null) continue;
        if (grant.revocationAttemptedAt) Object.assign(grant, { revocation: 'unknown', revocationCode: 'REVOCATION_OUTCOME_LOST_AFTER_RESTART',
          risk: `A revocation was attempted at ${grant.revocationAttemptedAt} by a previous controller process whose outcome is unknown; the grant may remain valid externally until ${until}. Not repeated (the value is lost); expiry is not proof of cessation; this alone does not suspend the installation.` });
        else Object.assign(grant, { revocation: 'impossible', revocationCode: 'VALUE_LOST_AFTER_RESTART',
          risk: `The grant value was held only in the memory of a previous controller process and is lost; it cannot be revoked and may remain valid externally (including copies made by code that received it) until ${until}. Expiry is not proof of cessation; this alone does not suspend the installation.` });
        count++;
      }
      if (count && lifecycle.state !== 'withdrawn') Object.assign(lifecycle, { state: 'withdrawn', withdrawnAt: new Date().toISOString(), reason: 'controller-restart' });
      return count;
    }, BACKGROUND_CONTEXT);
  }
  return reconciled;
}

/** "Confirmar início" (spec §3.4/5.3): the receipt of THIS Execution is consumed exactly once; a different receipt is a conflict. */
export async function confirmStart(session: Session, work_id: string, executionId: string, receipt: { workId: string; id: string; executionId: string; invocationId: string },
  /** Identity of THIS controller process: the origin of the monotonic elapsed values of this Execution. */
  origin: string | null = null):
  Promise<'confirmed' | 'already-confirmed' | 'conflict' | 'stale'> {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!document.work || !execution || execution.executionId !== executionId || receipt.workId !== work_id) return 'stale' as const;
    if (receipt.executionId !== execution.executionId || receipt.invocationId !== execution.invocationId) return 'conflict' as const;
    if (execution.start) return execution.start.receiptId === receipt.id ? 'already-confirmed' as const : 'conflict' as const;
    if (execution.state !== 'reserved' || execution.dispatch.phase !== 'activation-requested') return 'stale' as const;
    execution.start = { receiptId: receipt.id, confirmedAt: new Date().toISOString() };
    execution.state = 'started';
    execution.dispatch.phase = 'started';
    execution.dispatch.updatedAt = execution.start.confirmedAt;
    history(document.work, 'execution-started', executionId, receipt.id);
    // The single consumption of the reservation, in the same commit as the confirmed start.
    consumeReservation(document.work, execution, execution.start.confirmedAt);
    if (execution.timing) Object.assign(execution.timing, { origin, startedAt: execution.start.confirmedAt,
      lastActivity: { at: execution.start.confirmedAt, elapsedMs: 0, event: 'started' } });
    // The scope changes bound at admission were sent in THIS activation's first prompt: delivered (context), not proof of consumption.
    for (const update of document.work.scopeUpdates ?? []) {
      if (update.state !== 'pending' || !(execution.request.scopeUpdateIds ?? []).includes(update.scopeUpdateId)) continue;
      Object.assign(update, { state: 'delivered', executionId, deliveredAt: execution.start.confirmedAt });
      document.work.history.push({ at: execution.start.confirmedAt, event: 'scope-update-delivered', origin: 'controller-dispatch', scopeUpdateId: update.scopeUpdateId, detail: executionId });
    }
    return 'confirmed' as const;
  }, BACKGROUND_CONTEXT);
}

/** A scope update delivered by this Execution but not yet consumed (delivery alone never proves the Builder consumed it). */
/** A delivery is not consumption: unless this Execution completed, its scope updates are offered again (same concrete text). */
export function reofferUnlessCompleted(work: WorkRecord, executionId: string, outcome: string, at: string) {
  if (outcome !== 'completed') for (const update of deliveredBy(work, executionId)) {
    Object.assign(update, { state: 'pending', executionId: null, reoffers: (update.reoffers ?? 0) + 1 });
    work.history.push({ at, event: 'scope-update-reoffered', origin: 'controller-dispatch', scopeUpdateId: update.scopeUpdateId, detail: outcome });
  }
}
const deliveredBy = (work: WorkRecord, executionId: string) => (work.scopeUpdates ?? []).filter(update => update.state === 'delivered' && update.executionId === executionId);
export const recordEnd = (session: Session, work_id: string, executionId: string, outcome: 'completed' | 'failure' | 'question' | 'timeout' | 'stopped', code: string | null,
  questionId: string | null = null, elapsedMs: number | null = null,
  /** Host-observed preserved session of the Builder (ticket 11); never invented when the completion did not carry it. */
  preserved: NonNullable<ExecutionView['end']>['session'] = null) =>
  advance(session, work_id, executionId, { state: 'started', phases: ['started'] }, (execution, work) => {
    execution.state = 'ended';
    execution.dispatch.phase = 'completed';
    execution.end = { at: new Date().toISOString(), outcome, code, cessation: 'not-attempted', ...(outcome === 'question' ? { questionId } : {}), session: preserved };
    reofferUnlessCompleted(work, executionId, outcome, execution.end.at);
    history(work, 'execution-ended', executionId, code ?? outcome);
    // The activity (and its clock) ends here, also for an external wait; a reached timeout is never bypassed by ending.
    if (execution.timing && elapsedMs !== null) {
      execution.timing.duration = { kind: 'measured', elapsedMs, endedAt: execution.end.at };
      execution.timing.lastActivity = { at: execution.end.at, elapsedMs, event: `ended-${outcome}` };
      const overrun = classifyOverrun({ timeoutSeconds: execution.timing.timeoutSeconds, measuredMs: elapsedMs, lowerBoundMs: null });
      execution.timing.overrun = execution.timing.overrun === 'proven' ? 'proven' : overrun;
      if (overrun === 'proven') markTimeout(work, execution, elapsedMs, 'measured', execution.end.at);
    }
  });

/** Durable timeout record + Work impediment (once): interrupted/blocked for intervention; nothing restarts its clock. */
function markTimeout(work: WorkRecord, execution: ExecutionView, elapsedMs: number, evidence: 'measured' | 'lower-bound', at: string) {
  const timing = execution.timing!;
  timing.overrun = 'proven';
  if (timing.timeout) return;
  timing.timeout = { reachedAt: at, elapsedMs, evidence };
  if (!work.impediments.some(item => item.code === 'EXECUTION_TIMEOUT')) work.impediments.push(timeoutImpediment(timing.timeoutSeconds!, at, evidence));
  work.history.push({ at, event: 'timeout-reached', origin: 'controller-clock', executionId: execution.executionId, detail: `${evidence}:${elapsedMs}ms>=${timing.timeoutSeconds}s` });
}

/** The live timer of THIS process reached the configured timeout of the CURRENT Execution (measured monotonic elapsed value). */
export async function recordTimeout(session: Session, work_id: string, executionId: string, elapsedMs: number) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!document.work || !execution || execution.executionId !== executionId || !execution.timing || !timeoutReached(execution.timing.timeoutSeconds, elapsedMs)) return 'stale' as const;
    const at = new Date().toISOString();
    markTimeout(document.work, execution, elapsedMs, 'measured', at);
    // The proven value is also the last durable activity of THIS origin: reconciliation after a crash must never lower it.
    if ((execution.timing.lastActivity?.elapsedMs ?? -1) < elapsedMs) execution.timing.lastActivity = { at, elapsedMs, event: 'timeout-reached' };
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/** Last activity observed by the controller (start, handoff, reviewers, question...): presentation and the proven lower bound after a crash. */
export async function recordActivity(session: Session, work_id: string, executionId: string, event: string, elapsedMs: number) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!execution || execution.executionId !== executionId || !execution.timing?.startedAt || execution.timing.duration) return 'stale' as const;
    if ((execution.timing.lastActivity?.elapsedMs ?? 0) > elapsedMs) return 'stale' as const;
    execution.timing.lastActivity = { at: new Date().toISOString(), elapsedMs, event };
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Boot reconciliation of durations measured by a previous controller process (spec §5.7): a started Execution without a measured end gets
 * its proven lower bound (last durable observation of ITS origin) and a calendar estimate that is not proof. With a configured timeout, a
 * proven overrun blocks (EXECUTION_TIMEOUT) and an overrun that cannot be excluded blocks automatic resumption (TIMEOUT_OVERRUN_NOT_EXCLUDED).
 * Without timeout the gap is only observability. Never zero; never compared with this process's monotonic origin.
 */
export async function reconcileDurations(session: Session, live: (executionId: string) => boolean): Promise<number> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  let reconciled = 0;
  for (const id of index?.order ?? []) {
    reconciled += await session.commit(async tx => {
      const document = await tx.doc(works, id, null);
      const work = document.work;
      const execution = work?.execution ?? null;
      const timing = execution?.timing;
      if (!work || !execution || !timing?.startedAt || timing.duration || live(execution.executionId)) return 0;
      const now = new Date().toISOString();
      // A durable timeout measurement is evidence of ITS origin; the lower bound never discards it.
      const provenMs = Math.max(timing.lastActivity?.elapsedMs ?? 0, timing.timeout?.elapsedMs ?? 0);
      const estimate = Date.parse(now) - Date.parse(timing.startedAt);
      timing.duration = { kind: 'lower-bound', provenMs, calendarEstimateMs: Number.isFinite(estimate) && estimate >= 0 ? estimate : null, reconciledAt: now };
      const overrun = classifyOverrun({ timeoutSeconds: timing.timeoutSeconds, measuredMs: null, lowerBoundMs: provenMs });
      if (overrun === 'proven') markTimeout(work, execution, provenMs, 'lower-bound', now);
      else if (timing.overrun !== 'proven') {
        timing.overrun = overrun;
        if (overrun === 'not-excludable' && !work.impediments.some(item => item.code === 'TIMEOUT_OVERRUN_NOT_EXCLUDED')) work.impediments.push(overrunNotExcludedImpediment(timing.timeoutSeconds!, now));
      }
      work.history.push({ at: now, event: 'duration-reconciled', origin: 'controller-clock', executionId: execution.executionId, detail: `lower-bound:${provenMs}ms:${overrun}` });
      return 1;
    }, BACKGROUND_CONTEXT);
  }
  return reconciled;
}

/** Slot is released only after confirmed cessation of the Execution's own boot (spec §5.3: "Slot só após cessação"). */
export async function releaseAfterCessation(session: Session, work_id: string, executionId: string, cessation: 'confirmed' | 'unconfirmed') {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!document.work || !execution || execution.executionId !== executionId || !execution.end) return 'stale' as const;
    execution.end.cessation = cessation;
    execution.dispatch.phase = 'stopped';
    if (cessation !== 'confirmed') return 'kept' as const;
    applyConfirmedCessation(document.work, execution, await tx.doc(slots));
    return 'released' as const;
  }, BACKGROUND_CONTEXT);
}


/**
 * Inside a commit, after CONFIRMED cessation of an ended Execution (shared by the live release and the boot reconciliation, ticket 26): the
 * Slot is released and the outcome decides the queue — question/timeout/stopped keep the same position; completed consumes the scope updates
 * it delivered and requeues for pending ones (ticket 11); a transient failure becomes ONE operational recovery.
 */
export function applyConfirmedCessation(work: WorkRecord, execution: ExecutionView, occupancy: { held: Record<string, string> }) {
  const executionId = execution.executionId;
  const end = execution.end!;
  end.cessation = 'confirmed';
  execution.dispatch.phase = 'stopped';
  delete occupancy.held[executionId];
  execution.slot = { ...execution.slot, held: false, releasedAt: new Date().toISOString() };
  // A Question wait occupies no Slot: the Work returns to its SAME category/position; its impediment (until answered) still blocks.
  // A timeout keeps the same position too, blocked by its EXECUTION_TIMEOUT impediment until an explicit decision.
  if (end.outcome === 'question' || end.outcome === 'timeout') work.queue = { ...work.queue, pending: true };
  // A COMPLETED Execution with confirmed cessation consumed the scope updates it delivered; anything still pending (accepted during the
  // activity) waited for it to cease and is the next safe activation's.
  if (end.outcome === 'completed') for (const update of deliveredBy(work, executionId)) {
    Object.assign(update, { state: 'consumed', consumedAt: execution.slot.releasedAt, consumption: 'execution-completed' });
    work.history.push({ at: execution.slot.releasedAt!, event: 'scope-update-consumed', origin: 'controller-dispatch', scopeUpdateId: update.scopeUpdateId, detail: executionId });
  }
  if (end.outcome === 'completed' && pendingScope(work).length) work.queue = { ...work.queue, pending: true };
  // Ticket 26: a clean administrative stop continues in a new Execution without a recovery charge; a transient operational failure comes
  // back through the queue as ONE operational recovery after its persisted wait (same commit as the cessation, never lost by a crash).
  if (end.outcome === 'stopped') work.queue = { ...work.queue, pending: true };
  if (end.outcome === 'failure' && classifyInterruption(end.code).kind === 'recoverable') {
    applyRecoveryRequest(work, { executionId, code: end.code ?? 'CONTROLLER_CRASH', at: execution.slot.releasedAt! });
  }
  history(work, 'slot-released', executionId);
}

/**
 * Explicit, durable hold: the Execution stops advancing, keeps its Slot (no proof of non-start/cessation) and is never retried
 * automatically. Operator recovery is ticket 26.
 */
export async function holdExecution(session: Session, work_id: string, executionId: string, code: string, nextStep: string,
  /** Proven non-start (no worker was ever activated): the reservation is released without consumption; the hold still blocks retry. */
  provenNonStart = false) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!document.work || !execution || execution.executionId !== executionId || execution.state === 'released') return 'stale' as const;
    execution.held = { code, phase: execution.dispatch.phase, at: new Date().toISOString(), nextStep };
    // An explicit hold means the outcome is unknown: the scope changes it delivered are offered again, not lost.
    for (const update of deliveredBy(document.work, executionId)) {
      Object.assign(update, { state: 'pending', executionId: null, reoffers: (update.reoffers ?? 0) + 1 });
      document.work.history.push({ at: execution.held.at, event: 'scope-update-reoffered', origin: 'controller-dispatch', scopeUpdateId: update.scopeUpdateId, detail: code });
    }
    if (execution.state !== 'ended') execution.state = 'held';
    if (provenNonStart) releaseReservation(document.work, execution, execution.held.at);
    history(document.work, 'execution-held', executionId, code);
    return 'held' as const;
  }, BACKGROUND_CONTEXT);
}

/** Activation refused by revalidation BEFORE any worker request, after the own boot ceased: release Slot, Work back to its FIFO turn. */
export async function releaseBeforeStart(session: Session, work_id: string, executionId: string, reasons: string[],
  code = 'ACTIVATION_REVALIDATION_REFUSED') {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.state !== 'reserved' || execution.start) return 'stale' as const;
    const occupancy = await tx.doc(slots);
    delete occupancy.held[executionId];
    execution.state = 'released';
    execution.slot = { ...execution.slot, held: false, releasedAt: new Date().toISOString() };
    execution.held = { code, phase: execution.dispatch.phase, at: new Date().toISOString(), nextStep: reasons.join(', ') };
    // Non-start proven (refused before any worker request, own boot ceased): no consumption.
    releaseReservation(work, execution, execution.held.at);
    work.queue = { ...work.queue, pending: true };
    history(work, 'execution-released', executionId, reasons.join(','));
    return 'released' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Activation refused BEFORE any credential/worker request because its resumption context is insufficient or its prompt exceeds the budget
 * (ticket 11, spec §5.5/§6.1): after the own boot ceased, the Slot and the budget reservation are released (proven non-start) and the Work
 * keeps its queue position, blocked by an explicit impediment. Never an empty continue/recovery.
 */
export async function blockBeforeStart(session: Session, work_id: string, executionId: string, code: string, nextStep: string) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.state !== 'reserved' || execution.start) return 'stale' as const;
    const occupancy = await tx.doc(slots);
    delete occupancy.held[executionId];
    const now = new Date().toISOString();
    execution.state = 'released';
    execution.slot = { ...execution.slot, held: false, releasedAt: now };
    execution.held = { code, phase: execution.dispatch.phase, at: now, nextStep };
    // Proven non-start (no worker request was ever made, own boot ceased): the budget reservation is released, never consumed (ticket 19).
    releaseReservation(work, execution, now);
    if (!work.impediments.some(item => item.code === code)) work.impediments.push({ code, scope: 'work', since: now, nextStep });
    work.queue = { ...work.queue, pending: true };
    history(work, 'execution-released', executionId, code);
    return 'blocked' as const;
  }, BACKGROUND_CONTEXT);
}
