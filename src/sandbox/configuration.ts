import { z } from 'zod';

// Development profile identity only: no distributed assets or qualified release yet.
export const configurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal('gondolin-qemu-alpine-dev-v1'),
  memoryMiB: z.number().int().positive().safe().default(2048),
  vcpus: z.number().int().positive().safe().default(2),
  diskGiB: z.number().int().positive().safe().default(40),
  shutdownGraceSeconds: z.number().int().positive().safe().default(30),
  minFreeSpaceGiB: z.number().int().positive().safe().default(4),
  /** Host MemAvailable floor above the guest memory at each boot (ticket 24). Read here only (backward compatibility with environments that
   * recorded it); optional WITHOUT a schema default, so the effective configuration and the identity of environments prepared without it
   * are unchanged. Ticket 24 applies it as a boot precondition (`capacity.ts`), never a reservation. */
  minFreeMemoryMiB: z.number().int().positive().safe().optional(),
});
/** Ticket 24: the floor applied when `minFreeMemoryMiB` is absent (boot memory precondition in `capacity.ts`). */
export const defaultMinFreeMemoryMiB = 1024;

export function validateConfiguration(configuration: unknown) {
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success) {
    return { valid: false as const, errors: parsed.error.issues.map(issue => ({
      code: 'SANDBOX_CONFIGURATION_INVALID', path: ['sandbox', ...issue.path].join('.'),
    })) };
  }
  return { valid: true as const, effective: parsed.data };
}

export type SandboxConfiguration = z.infer<typeof configurationSchema>;
