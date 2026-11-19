import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { identitySchema, metadata, observeEnvironment, ownedEnvironment, privateDirectory,
  startedSchema, supervisionHierarchy, unitState, type BootRef } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';
import { durableJson } from './start.js';
import { readGuestStop, type GuestStop } from './guest-shutdown.js';

export type StopResult = { status: 'success'; cessationConfirmed: true;
  termination: 'forced' | 'unconfirmed'; guestFinalization: 'observed' | 'unavailable';
  /** Ticket 47: whether the guest left its root filesystem clean (read-only before the VMM closed) or the stop was forced; absent = not read. */
  guestShutdown?: GuestStop } |
  { status: 'failure' | 'indeterminate'; code: string; cessationConfirmed: false };
const run = promisify(execFile);
const stopRequestSchema = z.strictObject({ version: z.literal(1), boot: identitySchema.shape.boot,
  reason: z.string().min(1).max(256) });
const syncedSchema = z.strictObject({ version: z.literal(1), boot: identitySchema.shape.boot });

/** Stops only the manager invocation correlated to this owned boot, even without its SDK owner. */
export async function stopEnvironment(root: string, environment: EnvironmentRef, boot: BootRef, reason: string): Promise<StopResult> {
  const unknown: StopResult = { status: 'indeterminate', code: 'ENVIRONMENT_STOP_UNCONFIRMED', cessationConfirmed: false };
  if (!stopRequestSchema.shape.reason.safeParse(reason).success) {
    return { status: 'failure', code: 'STOP_REASON_INVALID', cessationConfirmed: false };
  }
  try {
    identitySchema.shape.boot.parse(boot);
    const { directory } = await ownedEnvironment(root, environment);
    const path = join(directory, boot);
    await privateDirectory(path);
    const identity = await metadata(join(path, 'identity.json'), identitySchema);
    const unit = `factory-sandbox-${boot}.service`;
    if (identity.environment !== environment || identity.boot !== boot || identity.unit !== unit ||
        identity.hostBoot !== (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()) return unknown;
    const started = await metadata(join(path, 'started.json'), startedSchema);
    const uid = process.getuid?.();
    const cgroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;
    if (started.boot !== boot || started.unit !== unit || started.cgroup !== cgroup) return unknown;
    await supervisionHierarchy(started);
    let observed = await observeEnvironment(root, environment, boot);
    if (!observed.cessationConfirmed) {
      const state = await unitState(unit);
      if (!['active', 'activating', 'deactivating'].includes(state.ActiveState ?? '') ||
          state.InvocationID !== started.invocation || state.ControlGroup !== cgroup) return unknown;
      const requestPath = join(path, 'stop-request.json');
      try { await durableJson(requestPath, { version: 1, boot, reason }); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const previous = await metadata(requestPath, stopRequestSchema, { durable: true });
        if (previous.boot !== boot) return unknown;
      }
      // This queues a job for the exact private invocation; no PID/global-prefix kill.
      // Timeout bounds this new manager client, never directly terminates a VM.
      await run('systemctl', ['--user', '--no-block', 'stop', unit], { timeout: 10000, maxBuffer: 16384 });
      const deadline = Date.now() + identity.configuration.shutdownGraceSeconds * 1000 + 10000;
      do {
        observed = await observeEnvironment(root, environment, boot);
        if (observed.cessationConfirmed) break;
        await delay(250);
      } while (Date.now() < deadline);
    }
    if (!observed.cessationConfirmed) return unknown;
    // Cessation is established separately above. Sync/manager result only describe
    // finalization and known forced termination, never manufacture graceful shutdown.
    let guestFinalization: 'observed' | 'unavailable' = 'unavailable';
    try {
      if ((await metadata(join(path, 'guest-synced.json'), syncedSchema)).boot === boot) guestFinalization = 'observed';
    } catch { /* Missing or invalid evidence is unavailable, not successful sync. */ }
    const state = await unitState(unit);
    if (state.InvocationID && state.InvocationID !== started.invocation) return unknown;
    return { status: 'success', cessationConfirmed: true,
      termination: state.Result === 'timeout' || state.Result === 'oom-kill' ? 'forced' : 'unconfirmed', guestFinalization,
      guestShutdown: await readGuestStop(path, boot) };
  } catch { return unknown; }
}
