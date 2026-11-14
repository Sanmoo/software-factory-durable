import { isAbsolute, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { workerLaunchSchema, type WorkerLaunch } from './worker-bootstrap.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createOwnerSecretReceiver } from './worker-secret-ipc.js';

const run = promisify(execFile);

const bootRef = z.string().regex(/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const bindingSchema = z.strictObject({ workId: z.string().min(1).max(512),
  environmentRef: z.string().regex(/^env-[a-f0-9]{64}$/), bootRef,
  invocationId: z.string().min(1).max(128), role: z.enum(['standards', 'spec', 'builder']) });
const hostSchema = z.strictObject({ workId: z.string().min(1).max(512),
  environmentRef: z.string().regex(/^env-[a-f0-9]{64}$/), bootRef,
  unit: z.string(), invocation: z.string().regex(/^[a-f0-9]{32}$/), cgroup: z.string(),
  cgroupNamespace: z.string().regex(/^cgroup:\[[0-9]+\]$/), mountNamespace: z.string().regex(/^mnt:\[[0-9]+\]$/),
  runtimeDirectory: z.string().min(1) });

/** Technical input from the boot owner's existing supervision/runtime gates.
 * This DTO is not authorization, an independent observation, or a new group. */
export type WorkerBootHost = z.infer<typeof hostSchema>;

/** Pure technical projection, not a spawn/start observation or Control authority.
 * Only launchWorker below executes it inside the already bound boot owner. */
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

export async function unitState(unit: string) {
  // Read-only query of the exact name derived from a validated boot, never a caller-supplied command.
  const { stdout } = await run('systemctl', ['--user', 'show', unit,
    '--property=LoadState,ActiveState,SubState,InvocationID,ControlGroup,MainPID,Result'], { timeout: 10000, maxBuffer: 16384 });
  const result: Record<string, string> = {};
  for (const line of stdout.trim().split('\n')) {
    const index = line.indexOf('=');
    if (index < 1 || Object.hasOwn(result, line.slice(0, index))) throw new Error('INVALID_MANAGER_OBSERVATION');
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

export function workerRuntimeDirectory(root: string, boot: string) {
  bootRef.parse(boot);
  return join(root, 'r', Buffer.from(boot.slice(5).replaceAll('-', ''), 'hex').toString('base64url'));
}
async function privatePath(path: string) {
  const info = await lstat(path);
  if (await realpath(path) !== path || !info.isDirectory() || info.isSymbolicLink() ||
      info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('WORKER_PRIVATE_PATH_REQUIRED');
}
async function privateJson(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
      (info.mode & 0o077) || info.size > 65536) throw new Error('WORKER_BOOT_MISMATCH');
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKER_BOOT_MISMATCH');
    return value as Record<string, unknown>;
  } catch { throw new Error('WORKER_BOOT_MISMATCH'); }
}
/** Private Host discovery for the explicitly configured installation. Control
 * consumes only an opaque endpoint; no PID/group discovery in business rules. */
export async function workerOwnerEndpoint(root: string, context: WorkerLaunch['context']) {
  const binding = bindingSchema.parse({ workId: context.workId, environmentRef: context.environmentRef,
    bootRef: context.bootRef, invocationId: context.invocationId, role: context.role });
  await privatePath(root);
  const directory = join(root, 'environments', binding.environmentRef);
  await privatePath(join(root, 'environments')); await privatePath(directory);
  const owner = await privateJson(join(directory, 'owner.json'));
  const current = await privateJson(join(directory, 'current.json'));
  if (owner.workId !== binding.workId || owner.environment !== binding.environmentRef ||
      current.environment !== binding.environmentRef || current.boot !== binding.bootRef) throw new Error('WORKER_BOOT_MISMATCH');
  const runtime = workerRuntimeDirectory(root, binding.bootRef);
  await privatePath(join(root, 'r')); await privatePath(runtime);
  const runtimeOwner = await privateJson(join(runtime, 'owner.json'));
  if (runtimeOwner.environment !== binding.environmentRef || runtimeOwner.boot !== binding.bootRef) throw new Error('WORKER_BOOT_MISMATCH');
  return join(runtime, 'owner');
}

const reference = z.strictObject({ workId: z.string(), id: z.uuid() });
const startedInvocation = z.strictObject({ executionId: z.string(), invocationId: z.string() });
const completedSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), receipt: reference }),
  z.strictObject({ status: z.literal('failure'), code: z.string() }),
]);
/** Spawn only inside the existing correlated boot owner. Failures after claiming
 * remain uncertain: caller retains its invocation tombstone and must not retry. */
export async function launchWorker(host: WorkerBootHost, input: WorkerLaunch, endpoint: string, root: string, signal: AbortSignal,
  secrets: { registerSecret(value: string): void; revoke(): void }) {
  const request = workerLaunchSchema.parse(input);
  const plan = planWorkerLaunch(host, { workId: request.context.workId, environmentRef: request.context.environmentRef,
    bootRef: request.context.bootRef, invocationId: request.context.invocationId, role: request.context.role });
  await privatePath(host.runtimeDirectory);
  const directory = await mkdtemp(join(host.runtimeDirectory, 'w-'));
  const profileDirectory = join(directory, 'profile');
  for (const path of [profileDirectory, join(profileDirectory, 'sessions'), join(directory, 't'), join(directory, 'c')]) await mkdir(path, { mode: 0o700 });
  const bootstrap = { ...request, version: 1, profile: { ...request.profile, directory: profileDirectory }, endpoint, recordsRoot: root };
  if (Buffer.byteLength(JSON.stringify(bootstrap)) > 65536 || signal.aborted) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const state = await unitState(host.unit);
  if (state.ActiveState !== 'active' || state.MainPID !== String(process.pid) || state.InvocationID !== host.invocation ||
      state.ControlGroup !== host.cgroup || (await readFile('/proc/self/cgroup', 'utf8')).trim() !== `0::${host.cgroup}` ||
      await readlink('/proc/self/ns/cgroup') !== host.cgroupNamespace || await readlink('/proc/self/ns/mnt') !== host.mountNamespace ||
      await workerOwnerEndpoint(root, request.context) !== join(host.runtimeDirectory, 'owner') || signal.aborted) throw new Error('WORKER_BOOT_MISMATCH');
  const child = spawn(plan.executable, plan.argv, { stdio: [...plan.stdio], detached: plan.detached,
    env: { ...plan.env, TMPDIR: join(directory, 't'), XDG_CACHE_HOME: join(directory, 'c') } });
  let startResolve!: (value: { receipt: z.infer<typeof reference>; invocation: z.infer<typeof startedInvocation> }) => void;
  let startReject!: (error: Error) => void;
  const started = new Promise<{ receipt: z.infer<typeof reference>; invocation: z.infer<typeof startedInvocation> }>((resolve, reject) => { startResolve = resolve; startReject = reject; });
  // Attach immediately: owner may still be sending its request acknowledgement.
  void started.catch(() => {});
  let completeResolve!: (value: z.infer<typeof completedSchema>) => void;
  const completed = new Promise<z.infer<typeof completedSchema>>(resolve => { completeResolve = resolve; });
  const abort = () => { if (child.connected) child.send({ kind: 'abort' }, () => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let startReference: z.infer<typeof reference> | undefined;
  const secretReceiver = createOwnerSecretReceiver(child, request.context, signal, () => startReference !== undefined,
    value => secrets.registerSecret(value), () => {
      startReject(new Error('WORKER_START_UNCERTAIN'));
      completeResolve({ status: 'failure', code: 'WORKER_EXECUTION_UNCERTAIN' });
      secrets.revoke();
    });
  child.on('message', message => {
    if (!message || typeof message !== 'object') return;
    if ('kind' in message && message.kind === 'worker-started' && 'receipt' in message) {
      const parsed = z.strictObject({ kind: z.literal('worker-started'), receipt: reference, invocation: startedInvocation }).safeParse(message);
      // The start observation must name THIS Execution/invocation, not only the Work.
      if (parsed.success && parsed.data.receipt.workId === request.context.workId && parsed.data.invocation.executionId === request.context.executionId &&
          parsed.data.invocation.invocationId === request.context.invocationId && !startReference && !signal.aborted) {
        startReference = parsed.data.receipt;
        startResolve({ receipt: parsed.data.receipt, invocation: parsed.data.invocation });
      }
    }
    if ('kind' in message && message.kind === 'worker-result') {
      const parsed = z.discriminatedUnion('status', [
        z.strictObject({ kind: z.literal('worker-result'), status: z.enum(['completed', 'interrupted']), receipt: reference, sessionFile: z.string().nullable().optional() }),
        z.strictObject({ kind: z.literal('worker-result'), status: z.literal('failure'), code: z.string() }),
      ]).safeParse(message);
      if (parsed.success) {
        const result = parsed.data;
        if (result.status === 'completed' && startReference && result.receipt.id === startReference.id &&
            result.receipt.workId === startReference.workId) completeResolve({ status: 'success', receipt: result.receipt });
        else completeResolve({ status: 'failure', code: result.status === 'interrupted' ? 'WORKER_INTERRUPTED' : 'WORKER_EXECUTION_UNCERTAIN' });
        secretReceiver.close();
      }
    }
  });
  const lost = () => { secretReceiver.close(); startReject(new Error('WORKER_START_UNCERTAIN')); completeResolve({ status: 'failure', code: 'WORKER_EXECUTION_UNCERTAIN' }); signal.removeEventListener('abort', abort); };
  child.once('error', lost); child.once('exit', lost);
  child.send(bootstrap, error => { if (error) { lost(); abort(); } });
  if (signal.aborted) abort();
  return { started, completed };
}
