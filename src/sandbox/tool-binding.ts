import { z } from 'zod';
import type { createRecords } from '../records/index.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const contextSchema = z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
  role: z.enum(['standards', 'spec', 'builder']), environmentRef: identifier, bootRef: identifier, phaseId: identifier });
export type ToolContext = z.infer<typeof contextSchema>;
export const referenceSchema = z.strictObject({ workId: identifier, id: z.uuid() });
const successSchema = z.strictObject({ status: z.literal('success'), reference: referenceSchema,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), encoding: z.literal('base64'),
  data: z.string().max(32768).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  nextOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export const readResultSchema = z.union([
  successSchema.extend({ format: z.literal('text'), exitCode: z.number().int().min(0).max(255).optional(),
    progressFrames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), sourceVersion: z.uuid().optional() }),
  successSchema.extend({ format: z.literal('raw'), imageSourceMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ status: z.literal('failure'), code: z.string().min(1).max(128) }),
]);
export type ReadResult = z.infer<typeof readResultSchema>;
// Structural external VM boundary; production supplier is adapter.ts's SAME instance.
export type GuestOwner = { exec(argv: string[], options: { stdout: 'pipe'; stderr: 'ignore' | 'pipe'; signal: AbortSignal;
  windowBytes: number; env?: Record<string, string>; cwd?: string; stdin?: string }): {
  output(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: Buffer }>;
  result: Promise<{ exitCode: number | null }>;
} };
export type ReadBinding = { endpoint: string; context: ToolContext; signal: AbortSignal;
  records: Awaited<ReturnType<typeof createRecords>>; imageSourceMaxBytes?: number;
  /** Host-only technical whole-source bound; absent disables edit-source. Not a product reservation. */
  editSourceMaxBytes?: number };
