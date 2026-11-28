import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Control, ControlInput } from '../../control/index.js';
import { listen, protocolVersion, type Envelope } from '../../protocol/index.js';
import { answerInspection } from './inspection.js';
import { blockedReferencePattern, blockedStartCodePattern, startRetryRemedies, triageAttemptPattern, triageReferencePattern } from '../../contracts/index.js';

// The owner's local operator socket (spec §11.3): the SAME schema validation and Control accept/inspect path for every caller of the CLI.
// Shared by the controller owner and (ticket 25) the qualification recipes that must receive real CLI commands.
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const command = z.union([
  z.strictObject({ request_id: requestId, operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli') }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('answer'),
    question_id: z.uuid(),
    text: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('grant'),
    work_id: z.uuid(),
    counter: z.enum(['corrections', 'recoveries', 'continuations']),
    amount: z.number().int().min(1).max(100),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('update-scope'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  // Ticket 23: explicit repair inside the current scope (corrections budget); concreteness/phase decided by the commit.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('repair'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('authorize-readiness'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  // Ticket 61: re-evaluation of a publication blocked only by unexpected ref changes (eligibility decided by the commit).
  z.strictObject({
    request_id: requestId,
    operation: z.literal('reevaluate-publication'),
    work_id: z.uuid(),
    reason: z.string().min(1).max(2000),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({ request_id: requestId, operation: z.enum(['cancel', 'resume', 'reopen']), work_id: z.uuid(), origin: z.literal('local-cli') }),
  // Ticket 41: Control checks the exact blocked reference; only its shared shape is checked here.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('resume'),
    work_id: z.uuid(),
    override_blocked_recovery: z.string().regex(blockedReferencePattern),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('resume'),
    work_id: z.uuid(),
    new_review_round: z.literal(true),
    origin: z.literal('local-cli'),
  }),
  // Ticket 50: explicit retry of the boot/preparation refusal that blocked the recovery (exact code), optionally with a remedy.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('resume'),
    work_id: z.uuid(),
    retry_blocked_start: z.string().regex(blockedStartCodePattern),
    remedy: z.enum(startRetryRemedies).optional(),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('new'),
    ticket: z.strictObject({ repository: z.string().min(3).max(201), number: z.number().int().positive() }),
    keepPredecessorPullRequest: z.boolean(),
    origin: z.literal('local-cli'),
  }),
  // Ticket 30: explicit cleanup plan and confirmation (Control revalidates the selection and the plan).
  z.strictObject({
    request_id: requestId,
    operation: z.literal('cleanup-plan'),
    work_id: z.uuid(),
    select: z
      .array(z.enum(['logs', 'sessions', 'environment', 'remote-branch']))
      .min(1)
      .max(4),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({ request_id: requestId, operation: z.literal('cleanup-confirm'), work_id: z.uuid(), plan_id: z.uuid(), origin: z.literal('local-cli') }),
  // Ticket 31: explicit history deletion plan and confirmation (Control revalidates eligibility and the plan).
  z.strictObject({ request_id: requestId, operation: z.literal('forget-plan'), work_id: z.uuid(), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('forget-confirm'), work_id: z.uuid(), plan_id: z.uuid(), origin: z.literal('local-cli') }),
  // The interventions on one Triage request, named by its id or its Ticket reference.
  z.strictObject({
    request_id: requestId,
    operation: z.literal('triage-cancel'),
    request: z.string().regex(triageReferencePattern),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('triage-release'),
    request: z.string().regex(triageReferencePattern),
    attempt: z.string().regex(triageAttemptPattern).max(64),
    reason: z.string().trim().min(1).max(500),
    origin: z.literal('local-cli'),
  }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('triage-complete'),
    request: z.string().regex(triageReferencePattern),
    impediment: z.uuid(),
    origin: z.literal('local-cli'),
  }),
  // Early removal of the details of one Triage request.
  z.strictObject({ request_id: requestId, operation: z.literal('triage-cleanup-plan'), triage_request_id: z.uuid(), origin: z.literal('local-cli') }),
  z.strictObject({
    request_id: requestId,
    operation: z.literal('triage-cleanup-confirm'),
    triage_request_id: z.uuid(),
    plan_id: z.uuid(),
    origin: z.literal('local-cli'),
  }),
]);
/** Serves `control` on the private local socket `endpoint` for the `local-operator` CLI peer; a failed commit calls `onPersistenceFailure`. */
export async function serveControl(endpoint: string, control: Control, runId: string, onPersistenceFailure: () => void) {
  return listen(
    endpoint,
    {
      message: async (envelope, channel) => {
        const reply = async (kind: string, payload: Envelope['payload']) =>
          channel.send({ protocol_version: protocolVersion, controller_run_id: runId, message_id: randomUUID(), reply_to: envelope.message_id, kind, payload });
        if (
          envelope.reply_to !== null ||
          (envelope.controller_run_id !== runId && !(envelope.controller_run_id === null && envelope.kind === 'inspect' && envelope.payload.kind === 'status'))
        ) {
          await reply('error', { code: 'STALE_CONTROLLER' });
          return;
        }
        let result: Envelope['payload'];
        let responseKind: string;
        if (envelope.kind === 'accept') {
          const parsed = command.safeParse(envelope.payload);
          if (!parsed.success || envelope.message_id !== parsed.data.request_id) {
            await reply('error', { code: 'INVALID_COMMAND' });
            return;
          }
          try {
            result = await control.accept(parsed.data as ControlInput);
          } catch {
            // A failed commit is never a durable receipt; query/retry the SAME identity after recovery.
            await reply('error', { code: 'PERSISTENCE_UNAVAILABLE', outcome: 'indeterminate' }).catch(() => {});
            onPersistenceFailure();
            return;
          }
          responseKind = 'receipt';
        } else if (envelope.kind === 'inspect') {
          // Ticket 29: validated query → view, or a stable error (invalid, unavailable, too large for one frame naming a paged command).
          const answer = await answerInspection(control, envelope.payload);
          if (answer.kind === 'error') {
            await reply('error', answer.payload);
            return;
          }
          result = answer.payload;
          responseKind = 'view';
        } else {
          await reply('error', { code: 'INVALID_COMMAND' });
          return;
        }
        // Transport loss after a successful commit does NOT fail the authority or undo that commit.
        await reply(responseKind, result);
      },
    },
    'local-operator',
  );
}
