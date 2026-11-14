import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ControlInput, ControlReceipt, ScopeUpdateView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { scopeReasonDecision, scopeUpdateDecision } from '../rules/continuation.js';
import { requests, ticketIndex, works, type WorkRecord } from './admission.js';
import type { Session } from './store.js';

type Receipt = Extract<ControlReceipt, { operation: 'update-scope' }>;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const pendingScope = (work: Pick<WorkRecord, 'scopeUpdates'>) => (work.scopeUpdates ?? []).filter(update => update.state === 'pending');
/** Updates the Builder will still be (or already is) told about: a duplicate authorization of one of them is refused. */
export const unconsumedScope = (work: Pick<WorkRecord, 'scopeUpdates'>) => (work.scopeUpdates ?? []).filter(update => update.state !== 'consumed');

/**
 * "Aceitar comando" for `update-scope` (spec §3.4/§11.3): deduplication by request identity, the concrete-reason rule, the Work's
 * currency and where the change lands (next activation; never the running one) share ONE commit. Nothing is delivered to a live Builder
 * and nothing is launched: an idle Work after a completed Execution only re-enters its queue position (same category/sequence).
 */
export async function acceptScopeUpdate(session: Session, input: Extract<ControlInput, { operation: 'update-scope' }>): Promise<Receipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const request = await tx.doc(requests, input.request_id, null);
    if (request.input) {
      if (JSON.stringify(request.input) !== JSON.stringify(input)) return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      return JSON.parse(JSON.stringify(request.receipt)) as Receipt;
    }
    const document = await tx.doc(works, input.work_id, null);
    const work = document.work;
    const index = await tx.doc(ticketIndex);
    const hash = sha256(input.reason);
    const refuse = (code: string): Receipt => ({ kind: 'durable', request_id: input.request_id, operation: 'update-scope', work_id: input.work_id, outcome: 'not-applied',
      reason: code, scopeUpdateId: null, appliesAt: null });
    let receipt: Receipt;
    const reason = scopeReasonDecision(input.reason);
    if (!work) receipt = refuse('WORK_NOT_FOUND');
    else if (!reason.concrete) receipt = refuse(reason.code);
    else {
      const execution = work.execution ?? null;
      const decision = scopeUpdateDecision({ result: work.result, current: index.tickets[ticketKey(work.ticket)]?.current === work.work_id,
        pending: unconsumedScope(work).map(update => update.sha256), sha256: hash,
        execution: execution ? { state: execution.state, slotHeld: execution.slot.held, outcome: execution.end?.outcome ?? null } : null });
      if (decision.outcome === 'not-applied') receipt = refuse(decision.code);
      else {
        const now = new Date().toISOString();
        const update: ScopeUpdateView = { scopeUpdateId: `scope-${input.request_id}`, reason: input.reason, sha256: hash, acceptedAt: now,
          origin: { kind: 'local-cli', request_id: input.request_id }, acceptedDuring: decision.during, state: 'pending', executionId: null, deliveredAt: null,
          consumedAt: null, consumption: null, reoffers: 0 };
        work.scopeUpdates = [...(work.scopeUpdates ?? []), update];
        // Only an idle Work whose last Execution COMPLETED re-enters the queue, at its own category/sequence; impediments still apply.
        if (decision.requeue) work.queue = { ...work.queue, pending: true };
        work.history.push({ at: now, event: 'scope-update-accepted', origin: 'local-cli', scopeUpdateId: update.scopeUpdateId, detail: decision.outcome });
        receipt = { kind: 'durable', request_id: input.request_id, operation: 'update-scope', work_id: work.work_id, outcome: decision.outcome, reason: null,
          scopeUpdateId: update.scopeUpdateId, appliesAt: 'next-activation' };
      }
    }
    request.input = input;
    request.receipt = receipt;
    return JSON.parse(JSON.stringify(receipt)) as Receipt;
  }, BACKGROUND_CONTEXT);
}
