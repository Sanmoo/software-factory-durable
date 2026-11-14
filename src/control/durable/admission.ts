import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { TicketRef } from '../../issue-tracker/index.js';
import type { ControlInput, ControlReceipt, DependencyEvaluation, Impediment, WorkView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { dependencyImpedimentCodes, dependencyImpediments, ownCycleFor, type OwnCycle, type OwnCycleFacts } from '../rules/dependencies.js';
import type { Session } from './store.js';

type History = { request_id: string; operation: 'pause' | 'unpause'; before: boolean; after: boolean; origin: 'local-cli' };
type Installation = { paused: boolean; history: History[] };
export const installation = defineDoc<Installation>({ kind: 'factory.installation', version: 1, scope: 'session',
  initial: () => ({ paused: false, history: [] }), checkpointWhen: () => true });
/** Identified ingresses (CLI request ids, `github-comment-<id>` for comments) with their single durable result. */
export const requests = defineDocFamily<{ input: ControlInput | { request_id: string; operation: 'answer'; origin: 'github-comment' } | null; receipt: ControlReceipt | null }, null>({
  kind: 'factory.request', version: 1, scope: 'session', family: true, initial: () => ({ input: null, receipt: null }), checkpointWhen: () => true,
});
/** Installation-level Ticket → cycle index and FIFO admission sequence (spec §3.2), committed with each Work. */
/** `memory`: explicit minimal memory per Ticket key (spec §12.4) — cycle identity/order, result and confirmed merge; absent in pre-08 storage. */
type TicketIndex = { admissionSequence: number; tickets: Record<string, { current: string; previous: string[] }>; order: string[];
  memory?: Record<string, { cycles: OwnCycle[] }> };
export const ticketIndex = defineDoc<TicketIndex>({ kind: 'factory.ticket-index', version: 1, scope: 'session',
  initial: () => ({ admissionSequence: 0, tickets: {}, order: [] }), checkpointWhen: () => true });
export type WorkRecord = Omit<WorkView, 'dispatch'>;
export const works = defineDocFamily<{ work: WorkRecord | null }, null>({ kind: 'factory.work', version: 1, scope: 'session', family: true,
  initial: () => ({ work: null }), checkpointWhen: () => true });

export type AdmissionEvidence = {
  ticket: TicketRef; repository: { repository: string; repositoryId: number; base: string };
  observedAt: string; label: { id: number; name: string }; publication: { observedAt: string; limitations: string[] };
};
export type AdmissionResult = { kind: 'admitted'; work_id: string; sequence: number } | { kind: 'existing'; work_id: string } | { kind: 'paused' };

export async function initialize(session: Session) {
  await session.commit(async tx => { await tx.doc(installation); await tx.doc(ticketIndex); }, BACKGROUND_CONTEXT);
}

/**
 * Admit-Work transaction (spec §3.4): absence of a current cycle in the index, the global pause, the Work record, the index entry and the
 * admission sequence are read and written in ONE real Session commit. Concurrent or repeated callers serialise on Pi Durable's commit line.
 */
export async function admitTicket(session: Session, evidence: AdmissionEvidence): Promise<AdmissionResult> {
  const key = ticketKey(evidence.ticket);
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const existing = index.tickets[key];
    if (existing) return { kind: 'existing' as const, work_id: existing.current };
    if ((await tx.doc(installation)).paused) return { kind: 'paused' as const };
    const work_id = randomUUID();
    const document = await tx.doc(works, work_id, null);
    if (document.work) throw new Error('WORK_IDENTITY_COLLISION');
    const sequence = index.admissionSequence + 1;
    const admittedAt = new Date().toISOString();
    // Replaced by the first native dependency evaluation of the same polling round; a crash in between keeps the Work held.
    const impediments: Impediment[] = [{ code: 'DEPENDENCIES_NOT_EVALUATED', scope: 'work', since: admittedAt,
      nextStep: 'Native blocked_by evaluation must complete before any dispatch; the next polling round evaluates it.' }];
    document.work = {
      work_id, cycle: 1, predecessor: null, ticket: evidence.ticket, repository: evidence.repository, result: 'open',
      authorization: { state: 'authorized', source: 'github-rest', observedAt: evidence.observedAt,
        basis: { repositoryConfigured: true, issueState: 'open', label: evidence.label },
        publication: { observedAt: evidence.publication.observedAt, completeness: 'complete', associatedPullRequests: 0, limitations: evidence.publication.limitations },
        tracking: 'Authorization recorded at admission. Later label removal/closure tracking is not part of this increment; absence from a listing is never treated as withdrawal.' },
      queue: { category: 'normal', sequence, pending: true }, impediments, dependencies: { latest: null, lastComplete: null }, execution: null, branch: null, pullRequest: null,
      previousExecutions: [], questions: [], inputs: { cursor: null }, admittedAt,
      history: [{ at: admittedAt, event: 'admitted', origin: 'github-polling', sequence }],
    };
    index.admissionSequence = sequence;
    index.tickets[key] = { current: work_id, previous: [] };
    index.memory = { ...(index.memory ?? {}), [key]: { cycles: [...(index.memory?.[key]?.cycles ?? []), { work_id, cycle: 1, result: 'open', mergeConfirmed: false }] } };
    index.order.push(work_id);
    return { kind: 'admitted' as const, work_id, sequence };
  }, BACKGROUND_CONTEXT);
}

/**
 * Lifecycle of an Execution recorded before the credential lifecycle (ticket 20), derived from its execution state: an Execution that is no
 * longer reserved/started is `withdrawn` for an unknown legacy reason; otherwise `active` when it holds a grant.
 */
export function legacyCredentialLifecycle(execution: NonNullable<WorkRecord['execution']>): NonNullable<WorkRecord['execution']>['credentialLifecycle'] {
  const over = execution.end !== null || ['ended', 'released', 'held'].includes(execution.state);
  return { state: over ? 'withdrawn' : execution.credentialIssuance ? 'active' : 'none', withdrawnAt: null, reason: over ? 'legacy-unknown' : null,
    renewal: 'enabled', renewalStop: null, workerNotice: null };
}
const normalize = (work: WorkRecord): WorkRecord => ({ ...work, dependencies: work.dependencies ?? { latest: null, lastComplete: null },
  execution: work.execution ? { ...work.execution, credentialRenewals: work.execution.credentialRenewals ?? [],
    credentialLifecycle: work.execution.credentialLifecycle ? { ...work.execution.credentialLifecycle, workerNotice: work.execution.credentialLifecycle.workerNotice ?? null }
      : legacyCredentialLifecycle(work.execution) } : null,
  branch: work.branch ?? null,
  previousExecutions: work.previousExecutions ?? [], questions: work.questions ?? [], inputs: work.inputs ?? { cursor: null } });

/** Open Works with pending queue work of one repository (by immutable id), FIFO by admission sequence. */
export async function pendingWorks(session: Session, repositoryId: number): Promise<WorkRecord[]> {
  return (await readWorks(session)).filter(work => work.repository.repositoryId === repositoryId && work.result === 'open' && work.queue.pending);
}

/**
 * Local facts of blockers that are Factory Tickets, by GitHub issue id (globally unique). Sources: the index (current/previous cycles), the
 * explicit minimal memory written with each admission (kept even if an index entry or Work record disappears) and the Work records.
 * Classification itself is the pure `ownCycleFor`: indexed or remembered is own, never external; no record and no memory is 'missing'.
 */
export async function ownCycles(session: Session, issueIds: number[]): Promise<Record<number, OwnCycleFacts>> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  const issueOf = (key: string) => Number(/^github:repository:\d+:issue:(\d+)$/.exec(key)?.[1]);
  const indexed = new Map<number, { current: string; previous: string[] }>();
  for (const [key, entry] of Object.entries(index?.tickets ?? {})) if (Number.isSafeInteger(issueOf(key))) indexed.set(issueOf(key), entry);
  const memory = new Map<number, OwnCycle[]>();
  for (const [key, entry] of Object.entries(index?.memory ?? {})) if (Number.isSafeInteger(issueOf(key))) memory.set(issueOf(key), entry.cycles);
  const result: Record<number, OwnCycleFacts> = {};
  for (const issueId of new Set(issueIds)) {
    const entry = indexed.get(issueId), remembered = memory.get(issueId);
    if (!entry && !remembered) continue;
    const records: Record<string, OwnCycle | undefined> = {};
    for (const id of new Set([...(entry ? [entry.current, ...entry.previous] : []), ...(remembered ?? []).map(item => item.work_id)])) {
      const work = (await session.snapshot(works, id, BACKGROUND_CONTEXT))?.work;
      // Delivery/merge confirmation is not produced before publication tickets; a Work record is never delivered here.
      if (work) records[id] = { work_id: id, cycle: work.cycle, result: work.result, mergeConfirmed: false };
    }
    const facts = ownCycleFor({ ...(entry ? { indexed: entry } : {}), ...(remembered ? { memory: remembered } : {}), records });
    if (facts) result[issueId] = facts;
  }
  return result;
}

/**
 * Record one evaluation on the CURRENT cycle of its Ticket, in one commit: latest evaluation, last complete one, dependency impediments
 * (others untouched) and a history entry only when the conclusion changes. A Work no longer open/pending/current is left unchanged.
 */
export async function recordDependencies(session: Session, work_id: string, evaluation: DependencyEvaluation): Promise<'recorded' | 'skipped'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    // Pending queue work, or the Execution reserved for it (revalidation immediately before activation, spec §3.4).
    if (!work || work.result !== 'open' || !(work.queue.pending || work.execution?.state === 'reserved') ||
      index.tickets[ticketKey(work.ticket)]?.current !== work_id) return 'skipped' as const;
    const previous = work.dependencies ?? { latest: null, lastComplete: null };
    const before = previous.latest?.conclusion ?? null;
    const known = new Map(work.impediments.map(item => [item.code, item.since]));
    const derived = dependencyImpediments(evaluation, evaluation.evaluatedAt).map(item => ({ ...item, since: known.get(item.code) ?? item.since }));
    work.impediments = [...work.impediments.filter(item => !(dependencyImpedimentCodes as readonly string[]).includes(item.code)), ...derived];
    work.dependencies = { latest: evaluation, lastComplete: evaluation.completeness === 'complete' && evaluation.conclusion !== 'inconclusive'
      ? { evaluationId: evaluation.evaluationId, observedAt: evaluation.observedAt, conclusion: evaluation.conclusion } : previous.lastComplete };
    if (before !== evaluation.conclusion) work.history.push({ at: evaluation.evaluatedAt, event: 'dependencies-changed', origin: 'github-polling',
      before, after: evaluation.conclusion, evaluationId: evaluation.evaluationId });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

export async function indexedWork(session: Session, ticket: Pick<TicketRef, 'repositoryId' | 'issueId'>): Promise<string | undefined> {
  return (await session.snapshot(ticketIndex, BACKGROUND_CONTEXT))?.tickets[ticketKey(ticket)]?.current;
}
export async function readWorks(session: Session): Promise<WorkRecord[]> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  const result: WorkRecord[] = [];
  for (const id of index?.order ?? []) {
    const work = (await session.snapshot(works, id, BACKGROUND_CONTEXT))?.work;
    if (!work) throw new Error('WORK_INDEX_INCONSISTENT');
    result.push(normalize(work));
  }
  return result.sort((a, b) => a.queue.sequence - b.queue.sequence);
}
export async function readWork(session: Session, work_id: string): Promise<WorkRecord | undefined> {
  const work = (await session.snapshot(works, work_id, BACKGROUND_CONTEXT))?.work;
  return work ? normalize(work) : undefined;
}
export async function readInstallation(session: Session): Promise<Installation> {
  const current = await session.snapshot(installation, BACKGROUND_CONTEXT);
  if (!current) throw new Error('INSTALLATION_STATE_MISSING');
  return current;
}
export async function readRequest(session: Session, request_id: string): Promise<ControlReceipt | null> {
  return (await session.snapshot(requests, request_id, BACKGROUND_CONTEXT))?.receipt ?? null;
}

/** Pause/unpause: receipt, history and pause change share one real Session commit (no deferred persistence). */
export async function acceptPauseCommand(session: Session, command: Extract<ControlInput, { operation: 'pause' | 'unpause' }>): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const current = await tx.doc(installation);
    const request = await tx.doc(requests, command.request_id, null);
    if (request.input) {
      if (request.input.operation !== command.operation || request.input.origin !== command.origin) {
        return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      }
      return { ...request.receipt! };
    }
    const paused = command.operation === 'pause';
    const receipt: ControlReceipt = { kind: 'durable', request_id: command.request_id, operation: command.operation,
      paused, historySequence: current.history.length + 1 };
    current.history.push({ request_id: command.request_id, operation: command.operation, before: current.paused, after: paused, origin: command.origin });
    current.paused = paused;
    request.input = command;
    request.receipt = receipt;
    return receipt;
  }, BACKGROUND_CONTEXT);
}
