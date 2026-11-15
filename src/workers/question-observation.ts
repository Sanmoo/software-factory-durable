import type { createRecords } from '../records/index.js';
import type { WorkerQuestionRequest as WorkerQuestion } from '../platform/host/index.js';

/** Bound of one ask_user record read (question ≤ 2000 + context ≤ 4000 characters plus the record envelope). */
const questionRecordMaxBytes = 64 * 1024;
type Records = Pick<Awaited<ReturnType<typeof createRecords>>, 'find' | 'read'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;

/**
 * Ticket 27: what the question facet of `observe` established about ONE Builder invocation. `question` is the complete protected `ask_user`
 * request the worker preserved BEFORE notifying the Control (ask-user.ts), with its stable identity and Records reference; `absent` is
 * proven only by a complete listing; anything partial, corrupt, multiple or unreadable is `uncertain` — never a question and never
 * "nothing was asked". The content is returned as recorded; the Control re-checks its hash. Not proof of cessation.
 */
export type QuestionObservation = { kind: 'question'; request: WorkerQuestion; askedAt: string | null } | { kind: 'absent' } | { kind: 'uncertain'; code: string };

/** Locates the preserved `ask_user` request of an invocation whose notification/ACK was lost, without that notification and without rerunning anything. */
export async function observeQuestionRecord(records: Records, input: { workId: string; executionId: string; invocationId: string }): Promise<QuestionObservation> {
  const found = await records.find({ workId: input.workId, executionId: input.executionId, invocationId: input.invocationId }).catch(() => null);
  if (!found || found.completeness !== 'complete') return { kind: 'uncertain', code: 'QUESTION_LISTING_INCOMPLETE' };
  const asked = found.captures.filter(capture => capture.context.callId?.startsWith('ask-user-'));
  if (asked.length === 0) return { kind: 'absent' };
  if (asked.length > 1) return { kind: 'uncertain', code: 'QUESTION_RECORD_MULTIPLE' };
  const capture = asked[0]!;
  if (capture.state !== 'complete') return { kind: 'uncertain', code: 'QUESTION_RECORD_INCOMPLETE' };
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const page = await records.read({ reference: capture.reference, offset, limit: 65536 });
      if (page.state !== 'complete') return { kind: 'uncertain', code: 'QUESTION_RECORD_INCOMPLETE' };
      chunks.push(page.data);
      if (page.bytes > questionRecordMaxBytes) return { kind: 'uncertain', code: 'QUESTION_RECORD_INVALID' };
      if (page.nextOffset >= page.bytes) break;
      if (page.nextOffset <= offset) return { kind: 'uncertain', code: 'QUESTION_RECORD_INVALID' };
      offset = page.nextOffset;
    }
    const stored = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { context?: Record<string, unknown>; event?: Record<string, unknown> };
    const context = stored.context ?? {};
    const event = stored.event ?? {};
    if (context.workId !== input.workId || context.executionId !== input.executionId || context.invocationId !== input.invocationId || event.kind !== 'ask-user' ||
        typeof event.questionId !== 'string' || !uuid.test(event.questionId) || context.callId !== `ask-user-${event.questionId}`) return { kind: 'uncertain', code: 'QUESTION_RECORD_MISMATCH' };
    if (typeof event.question !== 'string' || typeof event.context !== 'string' || typeof event.sha256 !== 'string' || !sha.test(event.sha256)) {
      return { kind: 'uncertain', code: 'QUESTION_RECORD_INVALID' };
    }
    return { kind: 'question', askedAt: typeof event.askedAt === 'string' ? event.askedAt : null,
      request: { questionId: event.questionId, question: event.question, context: event.context, sha256: event.sha256, reference: { workId: capture.reference.workId, id: capture.reference.id } } };
  } catch { return { kind: 'uncertain', code: 'QUESTION_RECORD_INVALID' }; }
}
