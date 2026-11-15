import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Control, ControlInput } from '../../control/index.js';
import { listen, protocolVersion, type Envelope } from '../../protocol/index.js';

// The owner's local operator socket (spec §11.3): the SAME schema validation and Control accept/inspect path for every caller of the CLI.
// Shared by the controller owner and (ticket 25) the qualification recipes that must receive real CLI commands.
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const command = z.union([z.strictObject({ request_id: requestId, operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('answer'), question_id: z.uuid(), text: z.string().min(1).max(2000), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('grant'), work_id: z.uuid(), counter: z.enum(['corrections', 'recoveries']),
    amount: z.number().int().min(1).max(100), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('update-scope'), work_id: z.uuid(), reason: z.string().min(1).max(2000), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('authorize-readiness'), work_id: z.uuid(), reason: z.string().min(1).max(2000), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.enum(['cancel', 'resume', 'reopen']), work_id: z.uuid(), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('new'), ticket: z.strictObject({ repository: z.string().min(3).max(201), number: z.number().int().positive() }),
    keepPredecessorPullRequest: z.boolean(), origin: z.literal('local-cli') })]);
const query = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('status') }), z.strictObject({ kind: z.literal('access') }),
  z.strictObject({ kind: z.literal('list') }), z.strictObject({ kind: z.literal('show'), work_id: z.uuid() }),
  z.strictObject({ kind: z.literal('request'), request_id: requestId }), z.strictObject({ kind: z.literal('question'), question_id: z.uuid() })]);

/** Serves `control` on the private local socket `endpoint` for the `local-operator` CLI peer; a failed commit calls `onPersistenceFailure`. */
export async function serveControl(endpoint: string, control: Control, runId: string, onPersistenceFailure: () => void) {
  return listen(endpoint, { message: async (envelope, channel) => {
      const reply = async (kind: string, payload: Envelope['payload']) => channel.send({ protocol_version: protocolVersion,
        controller_run_id: runId, message_id: randomUUID(), reply_to: envelope.message_id, kind, payload });
      if (envelope.reply_to !== null || (envelope.controller_run_id !== runId &&
        !(envelope.controller_run_id === null && envelope.kind === 'inspect' && envelope.payload.kind === 'status'))) {
        await reply('error', { code: 'STALE_CONTROLLER' }); return;
      }
      let result: Envelope['payload'];
      let responseKind: string;
      if (envelope.kind === 'accept') {
        const parsed = command.safeParse(envelope.payload);
        if (!parsed.success || envelope.message_id !== parsed.data.request_id) { await reply('error', { code: 'INVALID_COMMAND' }); return; }
        try { result = await control.accept(parsed.data as ControlInput); }
        catch {
          // A failed commit is never a durable receipt; query/retry the SAME identity after recovery.
          await reply('error', { code: 'PERSISTENCE_UNAVAILABLE', outcome: 'indeterminate' }).catch(() => {});
          onPersistenceFailure(); return;
        }
        responseKind = 'receipt';
      } else if (envelope.kind === 'inspect') {
        const parsed = query.safeParse(envelope.payload);
        if (!parsed.success) { await reply('error', { code: 'INVALID_QUERY' }); return; }
        try { result = await control.inspect(parsed.data); }
        catch { await reply('error', { code: 'DIAGNOSTIC_UNAVAILABLE' }); return; }
        responseKind = 'view';
      } else { await reply('error', { code: 'INVALID_COMMAND' }); return; }
      // Transport loss after a successful commit does NOT fail the authority or undo that commit.
      await reply(responseKind, result);
  } }, 'local-operator');
}
