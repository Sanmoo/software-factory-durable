import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bootRef = z.string().regex(/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const bindingSchema = z.strictObject({ workId: z.string().min(1).max(512),
  environmentRef: z.string().regex(/^env-[a-f0-9]{64}$/), bootRef,
  invocationId: z.string().min(1).max(128), role: z.enum(['standards', 'spec']) });
const hostSchema = z.strictObject({ workId: z.string().min(1).max(512),
  environmentRef: z.string().regex(/^env-[a-f0-9]{64}$/), bootRef,
  unit: z.string(), invocation: z.string().regex(/^[a-f0-9]{32}$/), cgroup: z.string(),
  cgroupNamespace: z.string().regex(/^cgroup:\[[0-9]+\]$/), mountNamespace: z.string().regex(/^mnt:\[[0-9]+\]$/),
  runtimeDirectory: z.string().min(1) });

/** Technical input from the boot owner's existing supervision/runtime gates.
 * This DTO is not authorization, an independent observation, or a new group. */
export type WorkerBootHost = z.infer<typeof hostSchema>;

/** Non-executable plan ONLY. No spawn, bootstrap, SDK or receipt is implemented
 * here. In particular, this result must never be reported as worker-started.
 * The fixed worker.js target is reserved, not yet an executable release asset. */
export function planWorkerLaunch(hostInput: unknown, bindingInput: unknown) {
  const host = hostSchema.safeParse(hostInput);
  const binding = bindingSchema.safeParse(bindingInput);
  if (!host.success || !binding.success) throw new Error('WORKER_LAUNCH_INVALID');
  const boot = host.data;
  const request = binding.data;
  const unit = `factory-sandbox-${boot.bootRef}.service`;
  const uid = process.getuid?.();
  const cgroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;
  if (boot.workId !== request.workId || boot.environmentRef !== request.environmentRef || boot.bootRef !== request.bootRef ||
      boot.unit !== unit || boot.cgroup !== cgroup || !isAbsolute(boot.runtimeDirectory) ||
      resolve(boot.runtimeDirectory) !== boot.runtimeDirectory) throw new Error('WORKER_BOOT_MISMATCH');
  if (process.versions.node.split('.')[0] !== '24' || !isAbsolute(process.execPath)) throw new Error('WORKER_NODE24_REQUIRED');
  return {
    executionEnabled: false as const,
    executable: process.execPath,
    argv: [fileURLToPath(new URL('../../entrypoints/worker.js', import.meta.url))],
    // A future launcher must use this closed FD projection, not inherited stdio
    // or the controller's lock FD. Planning alone does not prove FD isolation.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as const,
    detached: false as const,
    env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1',
      TMPDIR: join(boot.runtimeDirectory, 't'), XDG_CACHE_HOME: join(boot.runtimeDirectory, 'c') },
    binding: request,
    supervision: { unit: boot.unit, invocation: boot.invocation, cgroup: boot.cgroup,
      cgroupNamespace: boot.cgroupNamespace, mountNamespace: boot.mountNamespace },
  };
}
