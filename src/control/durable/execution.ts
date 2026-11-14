import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import type { BuilderGrantMetadata, RevocationResult } from '../../contracts/index.js';
import type { CredentialGrantRecord, CredentialWithdrawal, ExecutionView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { dispatchBlockers } from '../rules/dependencies.js';
import { installation, ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

/** Installation-level Slot occupancy, committed with every reservation/release (spec §3.4 "Admitir Execução"). */
const slots = defineDoc<{ held: Record<string, string> }>({ kind: 'factory.slots', version: 1, scope: 'session',
  initial: () => ({ held: {} }), checkpointWhen: () => true });

export async function initializeSlots(session: Session) {
  await session.commit(async tx => { await tx.doc(slots); }, BACKGROUND_CONTEXT);
}
export async function heldSlots(session: Session): Promise<number> {
  return Object.keys((await session.snapshot(slots, BACKGROUND_CONTEXT))?.held ?? {}).length;
}

export type Admission = { kind: 'reserved'; execution: ExecutionView } | { kind: 'refused'; reasons: string[] };
const history = (work: WorkRecord, event: Extract<WorkRecord['history'][number], { origin: 'controller-dispatch' }>['event'], executionId: string, detail?: string) =>
  work.history.push({ at: new Date().toISOString(), event, origin: 'controller-dispatch', executionId, ...(detail ? { detail } : {}) });
const active = (execution: ExecutionView | null) => execution !== null && execution.state !== 'released';

/**
 * "Admitir Execução" (spec §3.4): in ONE commit, the Work is still open, pending and the Ticket's current cycle; the global pause is off;
 * it has no impediment; the native dependency evaluation is the one produced by THIS dispatch attempt and is satisfied; a Slot is free.
 * Writes the Execution identity, its Slot, the dispatch intent and the Work's own branch. Nothing external happens before this commit.
 */
export async function admitExecution(session: Session, input: { work_id: string; attemptId: string; capacity: number; authorizationObservedAt: string;
  request: Omit<ExecutionView['request'], 'baseCommit' | 'checkout' | 'promptSha256' | 'skillPack'> }): Promise<Admission> {
  return session.commit(async tx => {
    const reasons: string[] = [];
    if ((await tx.doc(installation)).paused) reasons.push('GLOBAL_PAUSE');
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, input.work_id, null);
    const work = document.work;
    if (!work || work.result !== 'open' || index.tickets[ticketKey(work.ticket)]?.current !== input.work_id) return { kind: 'refused' as const, reasons: ['WORK_NOT_CURRENT'] };
    if (!work.queue.pending || active(work.execution ?? null)) reasons.push('EXECUTION_ALREADY_ACTIVE');
    const latest = work.dependencies?.latest ?? null;
    reasons.push(...dispatchBlockers({ impediments: work.impediments, evaluation: latest, currentAttempt: input.attemptId }));
    if (latest && latest.conclusion !== 'satisfied' && !reasons.length) reasons.push('DEPENDENCIES_NOT_SATISFIED');
    const occupancy = await tx.doc(slots);
    if (Object.keys(occupancy.held).length >= input.capacity) reasons.push('NO_SLOT_AVAILABLE');
    if (reasons.length) return { kind: 'refused' as const, reasons };
    const now = new Date().toISOString();
    const executionId = randomUUID();
    const execution: ExecutionView = {
      executionId, invocationId: `builder-${executionId}`, mode: 'initial', state: 'reserved',
      slot: { held: true, capacity: input.capacity, reservedAt: now, releasedAt: null },
      admission: { attemptId: input.attemptId, evaluationId: latest!.evaluationId, authorizationObservedAt: input.authorizationObservedAt, activationAttemptId: null, activationEvaluationId: null },
      dispatch: { intent: 'prepare-start-activate', phase: 'reserved', environment: null, boot: null, updatedAt: now },
      request: { ...input.request, baseCommit: null, checkout: null, promptSha256: null, skillPack: null },
      credential: null, credentialIssuance: null, credentialRenewals: [],
      credentialLifecycle: { state: 'none', withdrawnAt: null, reason: null, renewal: 'enabled', renewalStop: null },
      start: null, end: null, held: null,
      completion: { automatic: false, reason: 'Reviews, publication and readiness are not enabled in this Factory version; an ended Builder Execution never completes the Work automatically.' },
    };
    occupancy.held[executionId] = input.work_id;
    work.execution = execution;
    work.branch = input.request.branch;
    work.queue = { ...work.queue, pending: false };
    history(work, 'execution-reserved', executionId);
    return { kind: 'reserved' as const, execution: structuredClone(execution) };
  }, BACKGROUND_CONTEXT);
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
export const confirmActivation = (session: Session, work_id: string, executionId: string, attemptId: string, credential: BuilderGrantMetadata, promptSha256: string) =>
  advance(session, work_id, executionId, { state: 'reserved', phases: ['booted'] }, (execution, work, facts) => {
    const reasons = facts.paused ? ['GLOBAL_PAUSE'] : [];
    reasons.push(...dispatchBlockers({ impediments: work.impediments, evaluation: work.dependencies?.latest ?? null, currentAttempt: attemptId }));
    if (work.dependencies?.latest?.conclusion !== 'satisfied' && !reasons.length) reasons.push('DEPENDENCIES_NOT_SATISFIED');
    if (!execution.slot.held) reasons.push('SLOT_NOT_HELD');
    if (reasons.length) return reasons;
    execution.admission.activationAttemptId = attemptId;
    execution.admission.activationEvaluationId = work.dependencies!.latest!.evaluationId;
    execution.credential = credential;
    execution.request.promptSha256 = promptSha256;
    execution.dispatch.phase = 'activation-requested';
    history(work, 'activation-requested', executionId);
    return [];
  });

const blankGrant = (): CredentialGrantRecord => ({ requestedAt: new Date().toISOString(), outcome: 'requested', code: null, metadata: null,
  revocation: null, revocationCode: null, risk: null });
// Records written before ticket 20 lack these fields; every credential commit completes them in place.
function lifecycleOf(execution: ExecutionView) {
  execution.credentialRenewals ??= [];
  execution.credentialLifecycle ??= { state: execution.credentialIssuance ? 'active' : 'none', withdrawnAt: null, reason: null, renewal: 'enabled', renewalStop: null };
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
    if (execution.credential?.purpose !== 'builder-start') reasons.push('PURPOSE_MISMATCH');
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

/** Outcome of the single revocation attempt of one known grant. */
export const recordRevocation = (session: Session, work_id: string, executionId: string, grant: 'initial' | number, result: RevocationResult) =>
  onExecution(session, work_id, executionId, execution => {
    const record = grant === 'initial' ? execution.credentialIssuance : execution.credentialRenewals.find(item => item.sequence === grant);
    if (!record) return 'stale' as const;
    Object.assign(record, { revocation: result.kind, revocationCode: result.code ?? null });
    return 'recorded' as const;
  });

/**
 * Boot reconciliation of grants a previous controller process held only in memory (spec §8: "valor perdido pode impedir revogação"): every
 * known grant without a revocation outcome becomes `impossible` with its external-validity risk. Nothing is recovered from logs/sessions,
 * no revocation or cessation is claimed, and no impediment, pause or dispatch reason is added because of it.
 */
export async function reconcileLostCredentials(session: Session): Promise<number> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  let reconciled = 0;
  for (const id of index?.order ?? []) {
    reconciled += await session.commit(async tx => {
      const document = await tx.doc(works, id, null);
      const execution = document.work?.execution ?? null;
      if (!execution) return 0;
      const lifecycle = lifecycleOf(execution);
      let count = 0;
      for (const grant of [execution.credentialIssuance, ...execution.credentialRenewals]) {
        if (!grant || grant.revocation !== null || grant.outcome === 'failed') continue;
        const until = grant.metadata?.expiresAt ?? `at most one hour after ${grant.requestedAt} (issuance outcome ${grant.outcome})`;
        Object.assign(grant, { revocation: 'impossible', revocationCode: 'VALUE_LOST_AFTER_RESTART',
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
export async function confirmStart(session: Session, work_id: string, executionId: string, receipt: { workId: string; id: string; executionId: string; invocationId: string }):
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
    return 'confirmed' as const;
  }, BACKGROUND_CONTEXT);
}

export const recordEnd = (session: Session, work_id: string, executionId: string, outcome: 'completed' | 'failure', code: string | null) =>
  advance(session, work_id, executionId, { state: 'started', phases: ['started'] }, (execution, work) => {
    execution.state = 'ended';
    execution.dispatch.phase = 'completed';
    execution.end = { at: new Date().toISOString(), outcome, code, cessation: 'not-attempted' };
    history(work, 'execution-ended', executionId, code ?? outcome);
  });

/** Slot is released only after confirmed cessation of the Execution's own boot (spec §5.3: "Slot só após cessação"). */
export async function releaseAfterCessation(session: Session, work_id: string, executionId: string, cessation: 'confirmed' | 'unconfirmed') {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!document.work || !execution || execution.executionId !== executionId || !execution.end) return 'stale' as const;
    execution.end.cessation = cessation;
    execution.dispatch.phase = 'stopped';
    if (cessation !== 'confirmed') return 'kept' as const;
    const occupancy = await tx.doc(slots);
    delete occupancy.held[executionId];
    execution.slot = { ...execution.slot, held: false, releasedAt: new Date().toISOString() };
    history(document.work, 'slot-released', executionId);
    return 'released' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Explicit, durable hold: the Execution stops advancing, keeps its Slot (no proof of non-start/cessation) and is never retried
 * automatically. Operator recovery is ticket 26.
 */
export async function holdExecution(session: Session, work_id: string, executionId: string, code: string, nextStep: string) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const execution = document.work?.execution ?? null;
    if (!document.work || !execution || execution.executionId !== executionId || execution.state === 'released') return 'stale' as const;
    execution.held = { code, phase: execution.dispatch.phase, at: new Date().toISOString(), nextStep };
    if (execution.state !== 'ended') execution.state = 'held';
    history(document.work, 'execution-held', executionId, code);
    return 'held' as const;
  }, BACKGROUND_CONTEXT);
}

/** Activation refused by revalidation BEFORE any worker request, after the own boot ceased: release Slot, Work back to its FIFO turn. */
export async function releaseBeforeStart(session: Session, work_id: string, executionId: string, reasons: string[]) {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    const execution = work?.execution ?? null;
    if (!work || !execution || execution.executionId !== executionId || execution.state !== 'reserved' || execution.start) return 'stale' as const;
    const occupancy = await tx.doc(slots);
    delete occupancy.held[executionId];
    execution.state = 'released';
    execution.slot = { ...execution.slot, held: false, releasedAt: new Date().toISOString() };
    execution.held = { code: 'ACTIVATION_REVALIDATION_REFUSED', phase: execution.dispatch.phase, at: new Date().toISOString(), nextStep: reasons.join(', ') };
    work.queue = { ...work.queue, pending: true };
    history(work, 'execution-released', executionId, reasons.join(','));
    return 'released' as const;
  }, BACKGROUND_CONTEXT);
}
