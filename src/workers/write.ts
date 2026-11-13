import { randomUUID } from 'node:crypto';
import { createWriteTool, type ToolDefinition } from '#factory-pi';
import type { ToolContext, ToolProjection } from '../sandbox/index.js';

/** Narrow Builder vertical: native schema/path normalization/queue/results, BOTH
 * local callbacks replaced. Only exclusive new files; not native overwrite parity.
 * Callback cwd/env never grants authority; the owner independently binds context.
 */
export function builderWrite(context: ToolContext, sandbox: ToolProjection, onCritical: () => void = () => {}): ToolDefinition {
  const native = (cwd: string) => {
    const operation = async (call: Parameters<ToolProjection['executeTool']>[1]) => {
      const result = await sandbox.executeTool(context, call);
      if (result.status === 'failure') {
        if (['PROTECTED_WRITE_UNAVAILABLE', 'WRITE_EFFECTS_UNCERTAIN', 'WRITE_EVIDENCE_OR_EFFECTS_UNCERTAIN',
          'TOOL_CHANNEL_CLOSED', 'STALE_TOOL_CONTEXT'].includes(result.code)) onCritical();
        throw new Error(result.code);
      }
    };
    return createWriteTool(cwd, { operations: {
      mkdir: path => operation({ name: 'write', operation: 'mkdir', path, callId: randomUUID() }),
      writeFile: (path, content) => operation({ name: 'write', operation: 'create', path, content, callId: randomUUID() }),
    } });
  };
  return { name: 'write', label: 'write',
    description: 'Create a NEW regular file in the confined guest. Existing files and all symlinks are denied. Non-atomic; partial files/directories may remain on failure. Development transport content limit: 8192 characters and 49152 encoded bytes.',
    parameters: native('/workspace').parameters,
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      if (context.role !== 'builder') throw new Error('WRITE_ROLE_DENIED');
      const input = args as { path: string; content: string };
      // Explicit transport limit before native mkdir can have effects.
      if (typeof input.content !== 'string' || input.content.length > 8192 || Buffer.byteLength(JSON.stringify(input)) > 45056) {
        throw new Error('WRITE_PAYLOAD_TOO_LARGE');
      }
      return native(ctx?.cwd || '/workspace').execute(toolCallId, input, signal, onUpdate);
    },
  };
}
