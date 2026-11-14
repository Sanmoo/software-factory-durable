import { createHash, randomUUID } from 'node:crypto';
import type { ToolDefinition } from '#factory-pi';
import type { ToolContext } from '../sandbox/index.js';
import type { WorkerQuestionRequest as WorkerQuestion } from '../platform/host/index.js';

export type AskedQuestion = WorkerQuestion & { acknowledged: boolean };
type Send = (question: WorkerQuestion) => Promise<{ status: 'recorded' } | { status: 'refused'; code: string } | { status: 'unacknowledged' }>;
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const parameters = {
  type: 'object', additionalProperties: false, required: ['question'],
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 2000, description: 'One complete, self-contained question or approval request for the operator.' },
    context: { type: 'string', maxLength: 4000, description: 'What you already checked and why you cannot proceed without the answer (optional).' },
  },
};

/**
 * Builder `ask_user` (spec §5.5): the worker assigns a stable identity, PRESERVES the complete request as protected evidence, then notifies
 * the Control and waits only for its durable ACK (bounded). Whatever the ACK, the activation then ends: no Promise waits for a human.
 * A refused request (invalid/stale) is reported to the model as an error and nothing is pending.
 */
export function builderAskUser(context: ToolContext, hooks: { preserve(question: Omit<WorkerQuestion, 'reference'>, toolCallId: string): Promise<{ workId: string; id: string }>;
  send: Send; containsSecret(text: string): boolean; asked(question: AskedQuestion): void; onCritical(): void }): ToolDefinition {
  let used = false;
  return { name: 'ask_user', label: 'ask_user', executionMode: 'sequential',
    description: 'Ask the Factory operator when you need information or an approval you do not have (a required source that is missing or ' +
      'inaccessible, an approval a skill requires, an unresolved conflict). The Factory records the question durably, publishes it on the ' +
      'Ticket and ENDS this activation; nothing waits for the answer. After an authorized answer the Work resumes in a new activation that ' +
      'receives the question and the answer. Ask at most once per activation. Never include secrets.',
    parameters: parameters as unknown as ToolDefinition['parameters'],
    async execute(toolCallId, args) {
      if (context.role !== 'builder') throw new Error('ASK_USER_ROLE_DENIED');
      if (used) throw new Error('QUESTION_ALREADY_ASKED');
      const input = args as { question?: unknown; context?: unknown };
      const question = typeof input.question === 'string' ? input.question.trim() : '';
      const details = typeof input.context === 'string' ? input.context.trim() : '';
      if (!question || question.length > 2000 || details.length > 4000 || control.test(question) || control.test(details)) throw new Error('QUESTION_INVALID');
      if (hooks.containsSecret(`${question}\n${details}`)) throw new Error('QUESTION_CONTAINS_SECRET');
      used = true;
      const request = { questionId: randomUUID(), question, context: details, sha256: createHash('sha256').update(JSON.stringify({ question, context: details })).digest('hex') };
      let reference: { workId: string; id: string };
      // Preserved BEFORE any notification; without durable evidence nothing is sent and the activation is interrupted.
      try { reference = await hooks.preserve(request, toolCallId); } catch { hooks.onCritical(); throw new Error('QUESTION_NOT_PRESERVED'); }
      const full: WorkerQuestion = { ...request, reference: { workId: reference.workId, id: reference.id } };
      const ack = await hooks.send(full);
      if (ack.status === 'refused') { used = false; throw new Error(`QUESTION_REFUSED_${ack.code}`.slice(0, 96)); }
      hooks.asked({ ...full, acknowledged: ack.status === 'recorded' });
      const text = ack.status === 'recorded'
        ? `Question ${full.questionId} was recorded durably by the Factory. This activation ends now; do not continue. The Factory resumes the Work after an authorized answer.`
        : `Question ${full.questionId} was preserved but its durable recording was not confirmed. This activation ends now; do not continue. The Factory recovers it by its identity.`;
      return { content: [{ type: 'text', text }], details: { questionId: full.questionId, status: ack.status }, terminate: true };
    },
  };
}
