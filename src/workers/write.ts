import { randomUUID } from 'node:crypto';
import { createWriteTool, type ToolDefinition } from '#factory-pi';
import type { ToolContext, ToolProjection } from '../sandbox/index.js';

// Sound optional extension over upstream declarations; only host construction
// supplies it. No model/context/env mode or SDK-version fallback exists.
type LexicalWriteOptions = NonNullable<Parameters<typeof createWriteTool>[1]> & {
  mutationQueueMode: 'lexical';
};

/** Narrow Builder vertical: native schema/path normalization/queue/results, BOTH
 * local callbacks replaced. New or existing regular files; all symlinks denied.
 * Callback cwd/env never grants authority; the owner independently binds context.
 */
export function builderWrite(context: ToolContext, sandbox: ToolProjection, onCritical: () => void = () => {}): ToolDefinition {
  const native = (cwd: string) => {
    const operation = async (call: Parameters<ToolProjection['executeTool']>[1]) => {
      const result = await sandbox.executeTool(context, call);
      if (result.status === 'failure') {
        if (
          [
            'PROTECTED_WRITE_UNAVAILABLE',
            'WRITE_EFFECTS_UNCERTAIN',
            'WRITE_EVIDENCE_OR_EFFECTS_UNCERTAIN',
            'TOOL_CHANNEL_CLOSED',
            'STALE_TOOL_CONTEXT',
          ].includes(result.code)
        )
          onCritical();
        throw new Error(result.code);
      }
    };
    const options: LexicalWriteOptions = {
      mutationQueueMode: 'lexical',
      operations: {
        mkdir: path => operation({ name: 'write', operation: 'mkdir', path, callId: randomUUID() }),
        writeFile: (path, content) => operation({ name: 'write', operation: 'create', path, content, callId: randomUUID() }),
      },
    };
    return createWriteTool(cwd, options);
  };
  // Fixed host composition: the shared channel admits one tool at a time.
  return {
    name: 'write',
    label: 'write',
    executionMode: 'sequential',
    description:
      'Create or overwrite a regular file in the confined guest. All symlinks are denied. Non-atomic direct writes preserve existing inode/mode; truncation, partial data or directories may remain on failure, including empty writes. Development transport content limit: 8192 characters and 49152 encoded bytes.',
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
