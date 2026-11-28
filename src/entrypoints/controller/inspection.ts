// Ticket 29: the controller's inspection answer (schema-validated query → Control view, or a stable error payload), shared by the owner's
// socket and by read-only qualification servers. Read-only: it never calls `accept`.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Control } from '../../control/index.js';
import { triageAttemptPattern, triageReferencePattern } from '../../contracts/index.js';
import { listen, maxFrameBytes, protocolVersion, type Envelope } from '../../protocol/index.js';

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const inspectionFilter = {
  execution: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    .optional(),
  role: z.enum(['builder', 'standards', 'spec']).optional(),
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};
const page = { cursor: inspectionFilter.cursor, limit: inspectionFilter.limit };
export const inspectionQuery = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({ kind: z.literal('access') }),
  z.strictObject({ kind: z.literal('list'), ...page }),
  z.strictObject({ kind: z.literal('show'), work_id: z.uuid(), ...page }),
  z.strictObject({ kind: z.literal('request'), request_id: requestId }),
  z.strictObject({ kind: z.literal('question'), question_id: z.uuid() }),
  // Ticket 29: paginated/filtered history and logs, one log page, consumption (read-only).
  z.strictObject({ kind: z.literal('history'), work_id: z.uuid(), ...inspectionFilter }),
  z.strictObject({
    kind: z.literal('logs'),
    work_id: z.uuid(),
    execution: inspectionFilter.execution,
    role: inspectionFilter.role,
    after: z.uuid().optional(),
    limit: inspectionFilter.limit,
  }),
  z.strictObject({
    kind: z.literal('log'),
    work_id: z.uuid(),
    capture: z.uuid(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(16384).optional(),
  }),
  z.strictObject({ kind: z.literal('usage'), work_id: z.uuid().optional(), ...page }),
  // The Triage requests (metadata) and, by name only, one page of a transcript or the Verdict text.
  z.strictObject({ kind: z.literal('triages'), ...page }),
  z.strictObject({ kind: z.literal('triage'), request: z.string().regex(triageReferencePattern) }),
  z.strictObject({
    kind: z.literal('triage-transcript'),
    triage_request_id: z.uuid(),
    attempt: z.string().regex(triageAttemptPattern).max(64).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    verdict: z.literal(true).optional(),
  }),
]);
/** Ticket 29: stable inspection error payloads (code, scope, next step; never a secret or a stack). */
export const inspectionErrors = {
  INVALID_QUERY: { code: 'INVALID_QUERY', scope: 'request', outcome: 'refused', nextStep: 'Fix the query arguments (`factory --help`); nothing was read.' },
  DIAGNOSTIC_UNAVAILABLE: {
    code: 'DIAGNOSTIC_UNAVAILABLE',
    scope: 'controller',
    outcome: 'unavailable',
    nextStep:
      'The controller could not answer this query now (authority or observation failure); retry, then inspect the controller log. Nothing is concluded.',
  },
  VIEW_TOO_LARGE: {
    code: 'VIEW_TOO_LARGE',
    scope: 'request',
    outcome: 'refused',
    nextStep: 'The view does not fit one protocol frame; use a smaller page (--limit <n>).',
  },
} as const;

/** Answer one inspect payload: a view, or a stable error (code/scope/outcome/next step, never a secret or stack). */
export async function answerInspection(control: Pick<Control, 'inspect'>, payload: unknown): Promise<{ kind: 'view' | 'error'; payload: Envelope['payload'] }> {
  const parsed = inspectionQuery.safeParse(payload);
  if (!parsed.success) return { kind: 'error', payload: inspectionErrors.INVALID_QUERY };
  // Over the socket `list` always pages (default first 50 Works), so a large installation is never refused as one view.
  const unpaged = (parsed.data.kind === 'list' || parsed.data.kind === 'show') && parsed.data.cursor === undefined && parsed.data.limit === undefined;
  // `show` gets the full view when it fits, else its compacted form with `chain.executions` paged (never VIEW_TOO_LARGE for a big Work).
  const query = unpaged ? { ...parsed.data, ...(parsed.data.kind === 'list' ? { cursor: 0, limit: 50 } : { limit: 200 }) } : parsed.data;
  let result: Envelope['payload'];
  try {
    result = (await control.inspect(query)) as Envelope['payload'];
  } catch {
    return { kind: 'error', payload: inspectionErrors.DIAGNOSTIC_UNAVAILABLE };
  }
  // A view that still cannot fit one frame is a stable refusal naming a PAGED command (never the same one), not a lost connection.
  if (Buffer.byteLength(JSON.stringify(result)) > maxFrameBytes - 1024) {
    const work = 'work_id' in query ? query.work_id : '<work>';
    const nextStep =
      query.kind === 'list'
        ? 'factory list --limit 1 (then follow page.nextCursor)'
        : query.kind === 'show'
          ? `factory show ${work} --limit 1, factory history ${work} --limit 10`
          : query.kind === 'history'
            ? `factory history ${work} --limit 1`
            : query.kind === 'logs'
              ? `factory logs ${work} --limit 1`
              : query.kind === 'usage'
                ? query.work_id
                  ? `factory history ${work} --limit 10`
                  : 'factory usage <work> for one Work'
                : 'factory list --limit 1, factory show <work> --limit 1';
    return { kind: 'error', payload: { ...inspectionErrors.VIEW_TOO_LARGE, nextStep } };
  }
  return { kind: 'view', payload: result };
}

/**
 * A READ-ONLY inspection endpoint over an already opened Control (qualification over a storage copy): same protocol, run identity and
 * answers as the owner's socket for `inspect`; every `accept` is refused (`READ_ONLY_INSPECTION`). Not a controller: no run, no lock.
 */
export async function serveInspection(endpoint: string, control: Pick<Control, 'inspect'>) {
  const runId = `inspection-${randomUUID()}`;
  return listen(
    endpoint,
    {
      message: async (envelope, channel) => {
        const reply = (kind: string, body: Envelope['payload']) =>
          channel.send({
            protocol_version: protocolVersion,
            controller_run_id: runId,
            message_id: randomUUID(),
            reply_to: envelope.message_id,
            kind,
            payload: body,
          });
        if (
          envelope.reply_to !== null ||
          (envelope.controller_run_id !== runId && !(envelope.controller_run_id === null && envelope.kind === 'inspect' && envelope.payload.kind === 'status'))
        ) {
          await reply('error', { code: 'STALE_CONTROLLER' });
          return;
        }
        if (envelope.kind !== 'inspect') {
          await reply('error', { code: 'READ_ONLY_INSPECTION', scope: 'request', outcome: 'refused', nextStep: 'This endpoint only inspects a copy.' });
          return;
        }
        const answer = await answerInspection(control, envelope.payload);
        await reply(answer.kind, answer.payload);
      },
    },
    'local-operator',
  );
}
