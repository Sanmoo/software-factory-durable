import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { TicketRef } from '../../issue-tracker/index.js';
import type { ControlInput, ControlReceipt, Impediment, WorkView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import type { Session } from './store.js';

type History = { request_id: string; operation: 'pause' | 'unpause'; before: boolean; after: boolean; origin: 'local-cli' };
type Installation = { paused: boolean; history: History[] };
export const installation = defineDoc<Installation>({ kind: 'factory.installation', version: 1, scope: 'session',
  initial: () => ({ paused: false, history: [] }), checkpointWhen: () => true });
const requests = defineDocFamily<{ input: ControlInput | null; receipt: ControlReceipt | null }, null>({
  kind: 'factory.request', version: 1, scope: 'session', family: true, initial: () => ({ input: null, receipt: null }), checkpointWhen: () => true,
});
/** Installation-level Ticket → cycle index and FIFO admission sequence (spec §3.2), committed with each Work. */
type TicketIndex = { admissionSequence: number; tickets: Record<string, { current: string; previous: string[] }>; order: string[] };
const ticketIndex = defineDoc<TicketIndex>({ kind: 'factory.ticket-index', version: 1, scope: 'session',
  initial: () => ({ admissionSequence: 0, tickets: {}, order: [] }), checkpointWhen: () => true });
export type WorkRecord = Omit<WorkView, 'dispatch'>;
const works = defineDocFamily<{ work: WorkRecord | null }, null>({ kind: 'factory.work', version: 1, scope: 'session', family: true,
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
    const impediments: Impediment[] = [{ code: 'DEPENDENCIES_NOT_EVALUATED', scope: 'work', since: admittedAt,
      nextStep: 'Native blocked_by evaluation must complete before any dispatch; not implemented in this increment.' }];
    document.work = {
      work_id, cycle: 1, predecessor: null, ticket: evidence.ticket, repository: evidence.repository, result: 'open',
      authorization: { state: 'authorized', source: 'github-rest', observedAt: evidence.observedAt,
        basis: { repositoryConfigured: true, issueState: 'open', label: evidence.label },
        publication: { observedAt: evidence.publication.observedAt, completeness: 'complete', associatedPullRequests: 0, limitations: evidence.publication.limitations },
        tracking: 'Authorization recorded at admission. Later label removal/closure tracking is not part of this increment; absence from a listing is never treated as withdrawal.' },
      queue: { category: 'normal', sequence, pending: true }, impediments, execution: null, branch: null, pullRequest: null, admittedAt,
      history: [{ at: admittedAt, event: 'admitted', origin: 'github-polling', sequence }],
    };
    index.admissionSequence = sequence;
    index.tickets[key] = { current: work_id, previous: [] };
    index.order.push(work_id);
    return { kind: 'admitted' as const, work_id, sequence };
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
    result.push(work);
  }
  return result.sort((a, b) => a.queue.sequence - b.queue.sequence);
}
export async function readWork(session: Session, work_id: string): Promise<WorkRecord | undefined> {
  return (await session.snapshot(works, work_id, BACKGROUND_CONTEXT))?.work ?? undefined;
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
export async function acceptPauseCommand(session: Session, command: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
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
