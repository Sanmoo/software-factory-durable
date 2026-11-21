import { z } from 'zod';
import type { createRecords } from '../records/index.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const contextSchema = z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
  role: z.enum(['standards', 'spec', 'builder']), environmentRef: identifier, bootRef: identifier, phaseId: identifier });
export type ToolContext = z.infer<typeof contextSchema>;
/**
 * One guest command's lifetime, linked to its binding by an explicit listener. Not `AbortSignal.any`: its dependent-signal propagation
 * was observed to miss aborts intermittently (native-owner-operation-ids: a completed command's exec signal stayed un-aborted).
 */
export function commandLifetime(parent: AbortSignal) {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (parent.aborted) controller.abort(); else parent.addEventListener('abort', forward, { once: true });
  return { signal: controller.signal, abort() { controller.abort(); parent.removeEventListener('abort', forward); } };
}
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
/** Adapter origins whose exec boundary is accepted for Builder output copies and the Builder Read: the Gondolin development profile and
 * the Lambda SSH channel (v2 ticket 05; the latter was never exercised against a real guest). */
export const qualifiedProfileOrigins = ['factory-development-gondolin-0.14.0-stdin-capacity-v1', 'factory-lambda-ssh-channel-v1'] as const;
export type QualifiedProfileOrigin = typeof qualifiedProfileOrigins[number];
export const profileQualified = (origin: string | undefined): boolean => origin !== undefined && (qualifiedProfileOrigins as readonly string[]).includes(origin);
// Structural external VM boundary; production supplier is adapter.ts's SAME instance.
export type GuestOwner = { exec(argv: string[], options: { stdout: 'pipe'; stderr: 'ignore' | 'pipe'; signal: AbortSignal;
  windowBytes: number; env?: Record<string, string>; cwd?: string; stdin?: string | AsyncIterable<Buffer>; stdinCapacity?: { maxChunkBytes: number } }): {
  output(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: Buffer }>;
  result: Promise<{ exitCode: number | null; signal?: number }>;
} };
export type ReadBinding = { endpoint: string; context: ToolContext; signal: AbortSignal;
  records: Awaited<ReturnType<typeof createRecords>>; imageSourceMaxBytes?: number;
  /** Host-only technical whole-source bound; absent disables edit-source. Not a product reservation. */
  editSourceMaxBytes?: number;
  /** Private same-VM adapter qualification, never accepted from tool JSON. */
  profileOrigin?: QualifiedProfileOrigin;
  /** Host-only guest conventions of the adapter, never accepted from tool JSON (v2 ticket 05). Absent: the Gondolin guest. `ssh-channel`
   * (Lambda): commands run as distinct Unix users over a channel with no ambient environment contract, so the Builder credential is the
   * command's explicit process environment (V2-24), Bash merges stderr inside the guest, and files the Builder tools create stay
   * readable by the reviewer's own read-only user (V2-23). */
  guestConventions?: 'ssh-channel';
  /** Trusted host precondition: selected native truncated Bash output. Default deny. */
  copyOutput?: boolean;
  /** Exact Host-selected reviewer copies; absent is empty, never Builder authority. */
  selectedOutputCopies?: readonly string[];
  /** Builder only: the exact guest paths of the files of the Execution's skill pack version, as seeded (Host manifest). These
   * paths, and nothing else new, become readable by the Builder Read; they are guest-writable copies (integrity not promised). */
  skillPackFiles?: readonly string[];
  /** Transient Builder credential delivered in memory by the host handshake (spec §8.1), already registered in `records` for filtering.
   * Never accepted from tool JSON, never persisted. `current()` is read once at each NEW Builder Bash command, which receives it as explicit
   * environment via stdin; a renewal replaces it for later commands only and a withdrawal makes it undefined (ticket 20). */
  credential?: Readonly<{ current(): string | undefined }>;
  /** Host configuration only: replaces the fixed Factory commit identity of Builder commands (never accepted from tool JSON or the model). */
  commitIdentity?: Readonly<{ name: string; email: string }> };
