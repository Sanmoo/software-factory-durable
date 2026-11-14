import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { ToolDefinition } from '#factory-pi';
import type { ProposalHandoff } from '../contracts/index.js';
import type { ToolContext, ToolProjection } from '../sandbox/index.js';
import { handoffCommand, parseHandoffSummary } from './handoff.js';

export type HandoffEvent = { round: number } & ({ status: 'captured'; summary: ProposalHandoff } | { status: 'failure'; code: string; detail?: string });
/** Host directive to a suspended Builder: the effective review results of that round, as the continuation of the SAME session. */
export type BuilderDirective = { kind: 'review-results'; round: number; prompt: string };

const suspendedResult = (text: string) => ({ content: [{ type: 'text' as const, text }], details: { suspended: true }, isError: true, terminate: true });

/**
 * Host-owned handoff state of one Builder invocation. One review round per invocation in this Factory version (ticket 12); a second
 * request is refused with an explicit result, never silently accepted.
 */
export function builderHandoff() {
  let suspended = false, pending = false, rounds = 0, batch = 0;
  const tool: ToolDefinition = {
    name: 'handoff', label: 'handoff', executionMode: 'sequential',
    description: 'Factory review handoff. Call it exactly once, alone, when your proposal is complete in /workspace/checkout (committed or not; a clean ' +
      'tree is not required). The Factory then suspends ALL your tools and turns, records the proposal (index and diffs under /artifacts/review/r<N>/) ' +
      'and runs independent Standards and Spec reviewers. Their effective results (or failures) arrive as your next message; then treat each finding ' +
      '(fix it, or justify not adopting it) and finish. Do not simulate the reviews.',
    promptSnippet: 'handoff: request the Factory Standards/Spec reviews of the complete proposal (once).',
    parameters: Type.Object({}),
    async execute() {
      if (suspended) return suspendedResult('The Factory already suspended your tools for review. Stop now.');
      if (batch !== 1) return { content: [{ type: 'text' as const, text: 'HANDOFF_MUST_BE_ALONE: no handoff happened. Call handoff alone, with no other tool call in the same turn.' }],
        details: { refused: true }, isError: true };
      if (rounds >= 1) return { content: [{ type: 'text' as const, text: 'Only one review round is available in this Factory version. Finish with your final message.' }], details: { refused: true }, isError: true };
      rounds++; suspended = true; pending = true;
      return { content: [{ type: 'text' as const, text: `Handoff accepted for review round ${rounds}. Your tools are suspended; stop now and wait for the review results.` }],
        details: { round: rounds }, terminate: true };
    },
  };
  return { tool, suspended: () => suspended, pending: () => pending, round: () => rounds,
    /** Tool calls of the assistant message being executed (from its message_end, before its tools run). */
    batch(count: number) { batch = count; },
    resume() { pending = false; suspended = false; } };
}

/** Every Builder tool refuses (and ends the batch) while suspended, before any Sandbox call. */
export function suspendable(tool: ToolDefinition, gate: ReturnType<typeof builderHandoff>): ToolDefinition {
  return { ...tool, async execute(...args: Parameters<ToolDefinition['execute']>) {
    if (gate.suspended()) return suspendedResult('BUILDER_SUSPENDED_FOR_REVIEW: the Factory suspended your tools for review. Stop now.');
    return tool.execute(...args);
  } };
}

/** Host-originated fixed capture through the Builder's own binding (no model input); output reaches the Host only via filtered progress. */
export async function captureHandoff(context: ToolContext, sandbox: ToolProjection, round: number, baseCommit: string, signal: AbortSignal): Promise<HandoffEvent> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const result = await sandbox.executeTool(context, { name: 'bash', command: handoffCommand(round, baseCommit), timeout: 300, callId: `handoff-${randomUUID()}` }, data => {
      bytes += data.length;
      if (bytes <= 65536) chunks.push(Buffer.from(data));
    }, signal);
    if (result.status !== 'success' || result.format !== 'text' || result.exitCode !== 0) {
      // The constant program always writes one machine line on failure; surface its code/stage (never free text).
      const line = /FACTORY_HANDOFF_ERROR ([A-Z_]{1,32}) ([a-z-]{1,32})/.exec(Buffer.concat(chunks).toString('utf8'));
      return { round, status: 'failure', code: 'HANDOFF_CAPTURE_FAILED', ...(line ? { detail: `${line[1]}:${line[2]}` } : {}) };
    }
    if (bytes > 65536) return { round, status: 'failure', code: 'HANDOFF_CAPTURE_TOO_LARGE' };
    return { round, status: 'captured', summary: parseHandoffSummary(Buffer.concat(chunks).toString('utf8'), round, baseCommit) };
  } catch { return { round, status: 'failure', code: 'HANDOFF_CAPTURE_INVALID' }; }
}
