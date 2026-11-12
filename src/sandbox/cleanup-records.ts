import { z } from 'zod';
import { join } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';

// Assertions from trusted host Control after its policy/reconciliation checks,
// NOT model arguments, bearer credentials or a second Work-state authority.
export const cleanupAuthorizationSchema = z.strictObject({
  workId: z.string().min(1).max(512),
  workDisposition: z.enum(['delivered', 'cancelled']),
  confirmed: z.literal(true),
  evidencePreserved: z.literal(true),
});
const boot = z.string().regex(/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const cleanupRequestSchema = cleanupAuthorizationSchema.extend({
  version: z.literal(1), environment: z.string().regex(/^env-[a-f0-9]{64}$/), boots: z.array(boot).min(1).max(1024),
});
export const removedSchema = z.strictObject({ version: z.literal(1),
  environment: z.string().regex(/^env-[a-f0-9]{64}$/), workId: z.string().min(1).max(512),
  boots: z.array(boot).min(1).max(1024) });

export const runtimeRemovalSchema = z.strictObject({ version: z.literal(1),
  environment: z.string().regex(/^env-[a-f0-9]{64}$/), boot,
  dev: z.string().regex(/^[0-9]+$/), ino: z.string().regex(/^[0-9]+$/),
  birthtimeNs: z.string().regex(/^[1-9][0-9]*$/), uid: z.string().regex(/^[0-9]+$/) });

/** Even an incomplete/unsafe intent fences re-creation; it never authorizes deletion. */
export async function cleanupRequested(directory: string): Promise<boolean> {
  try { await lstat(join(directory, 'cleanup-request.json')); return true; }
  catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
    return (await readdir(directory)).some(name => name.startsWith('cleanup-request.json.pending-'));
  }
}

/** Same fixed lossless boot UUID encoding as SDK runtime composition, never an input path. */
export function cleanupRuntime(root: string, ref: string) {
  boot.parse(ref);
  return join(root, 'r', Buffer.from(ref.slice(5).replaceAll('-', ''), 'hex').toString('base64url'));
}
