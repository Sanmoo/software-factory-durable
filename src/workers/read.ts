import { randomUUID } from 'node:crypto';
import { createReadTool, type ReadOperations } from '#factory-pi';
import type { ToolContext, ToolProjection, ReadResult } from '../sandbox/index.js';

/** Private Workers integration; only the native read schema is presented to Pi.
 * Q5 calls below are implementation operations, not additional model tools. */
export function reviewerRead(context: ToolContext, sandbox: ToolProjection, criticalFailure = () => {}) {
  const definition = createReadTool('/workspace');
  return { ...definition,
    description: definition.description + '\nFactory development profile: UTF-8 text only; images/binary are explicitly unsupported and make dependent review incomplete.',
    async execute(...args: Parameters<typeof definition.execute>) {
      function failed(code: string): never {
        if (!['GUEST_READ_FAILED', 'READ_PATH_DENIED', 'READ_BINARY_UNSUPPORTED'].includes(code)) criticalFailure();
        throw new Error(code);
      }
      let capture: Extract<ReadResult, { status: 'success' }> | undefined;
      async function page(offset: number) {
        if (!capture) throw new Error('READ_CAPTURE_UNAVAILABLE');
        const result = await sandbox.executeTool(context, { name: 'read', operation: 'page', reference: capture.reference,
          offset, callId: randomUUID() });
        if (result.status !== 'success') failed(result.code);
        return result;
      }
      const operations: ReadOperations = {
        async access(path) {
          const result = await sandbox.executeTool(context, { name: 'read', operation: 'capture', path, callId: randomUUID() });
          if (result.status !== 'success') failed(result.code);
          capture = result;
        },
        // Records is a UTF-8 text capture in this slice. Binary/image input fails
        // closed there; do not invoke a host detector or claim image qualification.
        async detectImageMimeType() { return null; },
        async *createReadStream(_path, { signal }) {
          let offset = 0;
          while (capture && offset < capture.bytes) {
            if (signal?.aborted) throw new Error('READ_ABORTED');
            const result = await page(offset);
            if (result.nextOffset <= offset) throw new Error('READ_CAPTURE_UNAVAILABLE');
            offset = result.nextOffset;
            yield Buffer.from(result.data, 'base64');
          }
        },
        async readFile() {
          // Native non-integral/negative range fallback requires a whole buffer.
          // Reject rather than allocate an unbounded source or silently truncate.
          if (!capture || capture.bytes > 50000) throw new Error('READ_BUFFER_LIMIT');
          const chunks: Buffer[] = [];
          let offset = 0;
          while (offset < capture.bytes) {
            const result = await page(offset);
            if (result.nextOffset <= offset) throw new Error('READ_CAPTURE_UNAVAILABLE');
            chunks.push(Buffer.from(result.data, 'base64')); offset = result.nextOffset;
          }
          return Buffer.concat(chunks);
        },
      };
      return createReadTool('/workspace', { operations }).execute(...args);
  } };
}
