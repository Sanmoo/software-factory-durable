import type { ReviewOpinion } from '../contracts/index.js';
import type { createRecords } from '../records/index.js';
import { opinionSchema } from './review.js';

/** Bound of one opinion record read (the composed opinion is ≤ 20 KiB plus its record envelope). */
const opinionRecordMaxBytes = 256 * 1024;
type Records = Pick<Awaited<ReturnType<typeof createRecords>>, 'find' | 'read'>;
/**
 * Ticket 28: what the opinion facet of `observe` established about ONE reviewer invocation. `opinion` is the complete protected record
 * (synchronized, `complete.json` present, intact and correlated); `absent` is proven only by a complete listing; anything partial,
 * corrupt, multiple or unreadable is `uncertain` — never an opinion and never zero findings. Not proof of cessation.
 */
export type OpinionObservation = { kind: 'opinion'; opinion: ReviewOpinion } | { kind: 'absent' } | { kind: 'uncertain'; code: string };

/**
 * Locates the complete opinion a reviewer worker preserved in the protected Records BEFORE notifying (worker-session.ts), without its
 * notification and without rerunning anything. A streamed or half-written capture is never an opinion.
 */
export async function observeOpinionRecord(records: Records, input: { workId: string; executionId: string; invocationId: string }): Promise<OpinionObservation> {
  const found = await records.find({ workId: input.workId, executionId: input.executionId, invocationId: input.invocationId, callId: 'review-opinion' }).catch(() => null);
  if (!found || found.completeness !== 'complete') return { kind: 'uncertain', code: 'OPINION_LISTING_INCOMPLETE' };
  if (found.captures.length === 0) return { kind: 'absent' };
  if (found.captures.length > 1) return { kind: 'uncertain', code: 'OPINION_RECORD_MULTIPLE' };
  const capture = found.captures[0]!;
  if (capture.state !== 'complete') return { kind: 'uncertain', code: 'OPINION_RECORD_INCOMPLETE' };
  try {
    // Every page of the complete record, bounded (an opinion is at most 20 KiB; a larger record is never one).
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const page = await records.read({ reference: capture.reference, offset, limit: 65536 });
      if (page.state !== 'complete') return { kind: 'uncertain', code: 'OPINION_RECORD_INCOMPLETE' };
      chunks.push(page.data);
      if (page.nextOffset >= page.bytes) break;
      if (page.nextOffset <= offset || page.bytes > opinionRecordMaxBytes) return { kind: 'uncertain', code: 'OPINION_RECORD_INVALID' };
      offset = page.nextOffset;
    }
    const stored = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { context?: Record<string, unknown>; event?: Record<string, unknown> };
    const context = stored.context ?? {};
    if (context.workId !== input.workId || context.executionId !== input.executionId || context.invocationId !== input.invocationId ||
        context.callId !== 'review-opinion' || stored.event?.kind !== 'review-opinion') return { kind: 'uncertain', code: 'OPINION_RECORD_MISMATCH' };
    const { kind: _kind, ...event } = stored.event;
    const parsed = opinionSchema.safeParse({ ...event, reference: capture.reference });
    if (!parsed.success || parsed.data.invocationId !== input.invocationId) return { kind: 'uncertain', code: 'OPINION_RECORD_INVALID' };
    return { kind: 'opinion', opinion: parsed.data as ReviewOpinion };
  } catch { return { kind: 'uncertain', code: 'OPINION_RECORD_INVALID' }; }
}
