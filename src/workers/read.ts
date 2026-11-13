import { randomUUID } from 'node:crypto';
import { createReadTool, type ReadOperations } from '#factory-pi';
import { detectSupportedImageMimeType } from '#factory-image-mime';
import type { ToolContext, ToolProjection, ReadResult } from '../sandbox/index.js';

/** Private Workers integration; only the native read schema is presented to Pi.
 * Q5 calls below are implementation operations, not additional model tools. */
export function reviewerRead(context: ToolContext, sandbox: ToolProjection, criticalFailure = () => {}) {
  const definition = createReadTool('/workspace');
  return { ...definition,
    description: definition.description + '\nFactory development profile: PNG/JPEG require an explicit host source-byte budget. Other binary formats are not qualified.',
    async execute(...args: Parameters<typeof definition.execute>) {
      function failed(code: string): never {
        if (!['GUEST_READ_FAILED', 'READ_PATH_DENIED', 'READ_BINARY_UNSUPPORTED'].includes(code)) criticalFailure();
        throw new Error(code);
      }
      let capture: Extract<ReadResult, { status: 'success' }> | undefined;
      async function page(offset: number) {
        if (!capture) return failed('READ_CAPTURE_UNAVAILABLE');
        const result = await sandbox.executeTool(context, { name: 'read', operation: 'page', reference: capture.reference,
          ...(capture.format === 'raw' ? { format: 'raw' as const } : {}), offset, callId: randomUUID() });
        if (result.status !== 'success') return failed(result.code);
        const data = Buffer.from(result.data, 'base64');
        if (result.reference.id !== capture.reference.id || result.reference.workId !== capture.reference.workId ||
            result.format !== capture.format || result.encoding !== 'base64' || result.bytes !== capture.bytes ||
            (result.format === 'raw' && capture.format === 'raw' && result.imageSourceMaxBytes !== capture.imageSourceMaxBytes) ||
            data.length > 24576 ||
            data.toString('base64') !== result.data || !Number.isSafeInteger(result.nextOffset) ||
            result.nextOffset !== offset + data.length || result.nextOffset > capture.bytes ||
            (offset < capture.bytes && data.length === 0)) return failed('READ_CAPTURE_UNAVAILABLE');
        return { data, nextOffset: result.nextOffset };
      }
      const operations: ReadOperations = {
        async access(path) {
          const result = await sandbox.executeTool(context, { name: 'read', operation: 'capture', path, callId: randomUUID() });
          if (result.status !== 'success') return failed(result.code);
          if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.nextOffset !== 0 || result.data !== '' ||
              result.encoding !== 'base64' || !['text', 'raw'].includes(result.format) ||
              (result.format === 'raw' && (!Number.isSafeInteger(result.imageSourceMaxBytes) ||
                result.imageSourceMaxBytes <= 0 || result.bytes > result.imageSourceMaxBytes))) return failed('READ_CAPTURE_UNAVAILABLE');
          capture = result;
        },
        async detectImageMimeType() {
          if (capture?.format !== 'raw') return null;
          // Only a bounded prefix of the same completed, literal-byte-filtered
          // capture reaches the existing native classifier. No host path probes.
          const prefix = (await page(0)).data.subarray(0, 4100);
          const mime = detectSupportedImageMimeType(prefix);
          if (mime !== 'image/png' && mime !== 'image/jpeg') return failed('READ_IMAGE_UNAVAILABLE');
          return mime;
        },
        async *createReadStream(_path, { signal }) {
          if (capture?.format === 'raw') return failed('READ_IMAGE_UNAVAILABLE');
          let offset = 0;
          while (capture && offset < capture.bytes) {
            if (signal?.aborted) throw new Error('READ_ABORTED');
            const result = await page(offset);
            offset = result.nextOffset;
            yield result.data;
          }
        },
        async readFile() {
          // Raw capture already enforced the independently bound host budget
          // before append. Text unusual-range fallback keeps its legacy cap.
          if (!capture || (capture.format !== 'raw' && capture.bytes > 50000)) throw new Error('READ_BUFFER_LIMIT');
          const chunks: Buffer[] = [];
          let offset = 0;
          while (offset < capture.bytes) {
            const result = await page(offset);
            chunks.push(result.data); offset = result.nextOffset;
          }
          return Buffer.concat(chunks, capture.bytes);
        },
      };
      try {
        const result = await createReadTool('/workspace', { operations }).execute(...args);
        // Native omission/non-vision notes are not successful image delivery.
        if (capture?.format === 'raw' && !result.content.some(block => block.type === 'image')) return failed('READ_IMAGE_UNAVAILABLE');
        return result;
      } catch (error) {
        if (capture?.format === 'raw') criticalFailure();
        throw error;
      }
  } };
}
