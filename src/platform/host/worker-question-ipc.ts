import type { EventEmitter } from 'node:events';
import { z } from 'zod';

// Private technical host/worker seam over the already inherited child channel for `ask_user` (spec §5.5). The worker preserves the
// request BEFORE sending it; the owner relays it and returns the Control's answer. Not a tool, an authority, a queue or a retry path:
// one notification per activation, one bounded wait, and silence/loss is reported as `unacknowledged`, never as recorded.
type Wire = Pick<EventEmitter, 'on' | 'removeListener'> & {
  readonly connected?: boolean;
  send?: (message: Record<string, unknown>, callback: (error: Error | null) => void) => boolean;
};
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const contextSchema = z.strictObject({
  workId: identifier,
  executionId: identifier,
  invocationId: identifier,
  role: z.enum(['standards', 'spec', 'builder']),
  environmentRef: identifier,
  bootRef: identifier,
  phaseId: identifier,
});
type Context = z.infer<typeof contextSchema>;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** Complete ask_user request as preserved by the worker: identity, bounded text, canonical hash and the protected evidence reference. */
export const workerQuestionSchema = z.strictObject({
  questionId: uuid,
  question: z.string().min(1).max(2000),
  context: z.string().max(4000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reference: z.strictObject({ workId: identifier, id: z.uuid() }),
});
export type WorkerQuestionRequest = z.infer<typeof workerQuestionSchema>;
const requestSchema = z.strictObject({ kind: z.literal('worker-question'), version: z.literal(1), context: contextSchema, question: workerQuestionSchema });
const ackSchema = z.strictObject({
  kind: z.literal('worker-question-ack'),
  version: z.literal(1),
  context: contextSchema,
  questionId: uuid,
  status: z.enum(['recorded', 'refused']),
  code: z
    .string()
    .regex(/^[A-Z_]{1,64}$/)
    .optional(),
});
export type QuestionRelayAck = { status: 'recorded' } | { status: 'refused'; code: string };
const same = (left: Context, right: Context) => Object.keys(left).every(key => left[key as keyof Context] === right[key as keyof Context]);
/** Messages of this seam, so the other demultiplexers on the same channel ignore them instead of failing closed. */
export const isQuestionMessage = (value: unknown) => requestSchema.safeParse(value).success || ackSchema.safeParse(value).success;

/** Worker half: `ask` sends the already-preserved request once and resolves with the Control's ACK, or `unacknowledged` on silence/loss. */
export function createQuestionSender(wire: Wire, input: Context, signal: AbortSignal, timeoutMs = 30000) {
  const context = Object.freeze(contextSchema.parse(input));
  let used = false;
  return {
    ask(question: WorkerQuestionRequest): Promise<{ status: 'recorded' } | { status: 'refused'; code: string } | { status: 'unacknowledged' }> {
      const parsed = requestSchema.safeParse({ kind: 'worker-question', version: 1, context, question });
      if (used || !parsed.success || signal.aborted || wire.connected !== true || !wire.send || context.role !== 'builder')
        return Promise.resolve({ status: 'unacknowledged' });
      used = true;
      return new Promise(resolve => {
        let settled = false;
        const finish = (value: { status: 'recorded' } | { status: 'refused'; code: string } | { status: 'unacknowledged' }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wire.removeListener('message', message);
          signal.removeEventListener('abort', lost);
          for (const event of ['disconnect', 'exit', 'error', 'close']) wire.removeListener(event, lost);
          resolve(value);
        };
        const lost = () => finish({ status: 'unacknowledged' });
        const message = (value: unknown) => {
          const ack = ackSchema.safeParse(value);
          if (!ack.success || ack.data.questionId !== question.questionId || !same(ack.data.context, context)) return;
          finish(ack.data.status === 'recorded' ? { status: 'recorded' } : { status: 'refused', code: ack.data.code ?? 'QUESTION_REFUSED' });
        };
        const timer = setTimeout(lost, timeoutMs);
        wire.on('message', message);
        for (const event of ['disconnect', 'exit', 'error', 'close']) wire.on(event, lost);
        signal.addEventListener('abort', lost, { once: true });
        try {
          wire.send!(parsed.data, error => {
            if (error) lost();
          });
        } catch {
          lost();
        }
      });
    },
  };
}

/**
 * Owner half, bound to one expected child by listener installation: a request of THIS context (only after the durable start) is handed
 * to `onQuestion` (the Control's commit through the host-boot channel) and its result is returned. One question per invocation.
 */
export function serveQuestionRelay(
  wire: Wire,
  input: Context,
  signal: AbortSignal,
  started: () => boolean,
  onQuestion: (question: WorkerQuestionRequest) => Promise<QuestionRelayAck>,
) {
  const context = Object.freeze(contextSchema.parse(input));
  let seen: string | undefined;
  const reply = (questionId: string, ack: QuestionRelayAck) => {
    if (wire.connected !== true || !wire.send) return;
    try {
      wire.send({ kind: 'worker-question-ack', version: 1, context, questionId, ...ack }, () => {});
    } catch {
      /* lost ACK: the completion repeats the request */
    }
  };
  const message = (value: unknown) => {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return;
    const { question } = parsed.data;
    if (!same(parsed.data.context, context) || context.role !== 'builder' || !started() || signal.aborted || question.reference.workId !== context.workId) {
      reply(question.questionId, { status: 'refused', code: 'QUESTION_CONTEXT_INVALID' });
      return;
    }
    if (seen !== undefined) {
      reply(question.questionId, { status: 'refused', code: 'QUESTION_ALREADY_ASKED' });
      return;
    }
    seen = question.questionId;
    void onQuestion(question).then(
      ack => reply(question.questionId, ack),
      () => {
        /* unknown: no ACK; the worker reports unacknowledged */
      },
    );
  };
  wire.on('message', message);
  return {
    close() {
      wire.removeListener('message', message);
    },
  };
}
