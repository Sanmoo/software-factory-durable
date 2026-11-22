import { basename, isAbsolute, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { workerLaunchSchema, type WorkerLaunch } from './worker-bootstrap.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { builderBudgetV1, qualificationRequestsV1, reviewerBudgetV1 } from '../../contracts/index.js';
import { createOwnerSecretReceiver, secretSyncLimit, type SecretChannelFailure } from './worker-secret-ipc.js';
import { serveQuestionRelay, workerQuestionSchema, type QuestionRelayAck, type WorkerQuestionRequest } from './worker-question-ipc.js';
import { copyPreservedSession, observePreservedSession, recordWorkerLaunch } from './worker-session-file.js';

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

/**
 * v2 ticket 06: a boot whose guest is NOT a process of this host (no systemd unit owns it). Its workers are children of the trusted host
 * process that owns the boot's tool channel and its owner endpoint (the controller owner process); the boot identity and the private
 * runtime directory are what the launch is correlated with. `ownerEndpoint` is that process's own discovery of the endpoint it serves.
 */
export type HostedWorkerBoot = { supervision: 'host-process'; workId: string; environmentRef: string; bootRef: string; runtimeDirectory: string;
  ownerEndpoint(context: WorkerLaunch['context']): Promise<string> };
function planHostedLaunch(boot: HostedWorkerBoot, bindingInput: unknown) {
  const binding = bindingSchema.safeParse(bindingInput);
  if (!binding.success || !bootRef.safeParse(boot.bootRef).success) throw new Error('WORKER_LAUNCH_INVALID');
  const request = binding.data;
  if (boot.workId !== request.workId || boot.environmentRef !== request.environmentRef || boot.bootRef !== request.bootRef ||
      !isAbsolute(boot.runtimeDirectory) || resolve(boot.runtimeDirectory) !== boot.runtimeDirectory) throw new Error('WORKER_BOOT_MISMATCH');
  if (process.versions.node.split('.')[0] !== '24' || !isAbsolute(process.execPath)) throw new Error('WORKER_NODE24_REQUIRED');
  return { executable: process.execPath, argv: [fileURLToPath(new URL('../../entrypoints/worker.js', import.meta.url))],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as const, detached: false as const,
    env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(boot.runtimeDirectory, 't'), XDG_CACHE_HOME: join(boot.runtimeDirectory, 'c') } };
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
const askedSchema = workerQuestionSchema.extend({ acknowledged: z.boolean() });
const completedSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), receipt: reference, opinion: z.record(z.string(), z.json()).optional(), session: z.record(z.string(), z.json()).optional() }),
  z.strictObject({ status: z.literal('failure'), code: z.string() }),
  z.strictObject({ status: z.literal('question'), receipt: reference, question: askedSchema, session: z.record(z.string(), z.json()).optional() }),
  // v2 ticket 09 (V2-13): the Builder yielded at a call boundary because its boot is about to be swapped; its session is preserved.
  z.strictObject({ status: z.literal('boot-swap'), receipt: reference, session: z.record(z.string(), z.json()).optional() }),
]);
/**
 * Ticket 13 (spec §6.4 "novas rodadas preferem sessões compatíveis"): a later round of the same reviewer role continues its previous
 * session when that JSONL is a regular, non-linked file of an earlier worker profile of THIS boot owner's runtime directory. It is
 * COPIED (exclusive, 0600) into the new profile, so the earlier file is never written by two processes. Anything else is a recorded
 * replacement (new session), never a silent reuse.
 */
export async function prepareReviewerContinuation(runtimeDirectory: string, profileDirectory: string, from: string):
  Promise<{ mode: 'continued'; from: string; file: string } | { mode: 'replaced'; from: string; code: string }> {
  const replaced = (code: string) => ({ mode: 'replaced' as const, from, code });
  const parts = isAbsolute(from) && resolve(from) === from ? from.slice(runtimeDirectory.length).split('/') : [];
  if (!from.startsWith(`${runtimeDirectory}/`) || parts.length !== 5 || !/^w-[A-Za-z0-9]{6}$/.test(parts[1]!) || parts[2] !== 'profile' || parts[3] !== 'sessions' ||
      !/^[A-Za-z0-9._-]{1,200}\.jsonl$/.test(parts[4]!)) return replaced('SESSION_NOT_IN_BOOT');
  let handle;
  try { handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return replaced('SESSION_UNAVAILABLE'); }
  try {
    for (const directory of [join(runtimeDirectory, parts[1]!), join(runtimeDirectory, parts[1]!, 'profile'), join(runtimeDirectory, parts[1]!, 'profile', 'sessions')]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) return replaced('SESSION_UNSAFE');
    }
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 8 * 1024 * 1024) return replaced('SESSION_UNSAFE');
    const data = await handle.readFile();
    const file = join(profileDirectory, 'sessions', basename(from));
    await writeFile(file, data, { flag: 'wx', mode: 0o600 });
    return { mode: 'continued', from, file };
  } catch { return replaced('SESSION_COPY_FAILED'); } finally { await handle.close(); }
}

/**
 * Ticket 59: the maximum model requests of the session this launch starts, from the same Host policy the worker turns into its limits
 * (`budgetFor`): the repository's Builder override, `builder-v1`, `reviewer-v1`, else the bounded qualification.
 */
export function sessionRequestBudget(request: Pick<WorkerLaunch, 'context' | 'modelBudget' | 'builderBudget'>): number {
  const role = request.context.role;
  if (request.modelBudget === 'builder-v1' && role === 'builder') return request.builderBudget?.requests ?? builderBudgetV1.requests;
  if (request.modelBudget === 'reviewer-v1' && role !== 'builder') return reviewerBudgetV1.requests;
  return qualificationRequestsV1;
}
/**
 * Ticket 59: the Execution end of an owner-closed secret channel. Channel or lifetime loss (and the owner's own close) stays the uncertain
 * end it always was; a refused sync is its own cause (`WORKER_SECRET_SYNC_<REASON>`), never a provider failure or a silent uncertainty.
 */
export function secretChannelEndCode(reason: SecretChannelFailure): string {
  return reason === 'disconnect' || reason === 'abort' || reason === 'closed' ? 'WORKER_EXECUTION_UNCERTAIN'
    : `WORKER_SECRET_SYNC_${reason.toUpperCase().replace('-', '_')}`;
}

/** Spawn only inside the existing correlated boot owner. Failures after claiming
 * remain uncertain: caller retains its invocation tombstone and must not retry. */
export async function launchWorker(host: WorkerBootHost | HostedWorkerBoot, input: WorkerLaunch, endpoint: string, root: string, signal: AbortSignal,
  secrets: { registerSecret(value: string): void; revoke(): void },
  /** Builder ask_user relay: the owner forwards the preserved request to the Control and returns its ACK (spec §5.5). */
  relay?: { question(question: WorkerQuestionRequest): Promise<QuestionRelayAck> },
  /** Ticket 12: the suspended Builder's handoff notice, forwarded by the owner on the host-boot channel. */
  onHandoff: (event: Record<string, unknown>) => void = () => {}) {
  const request = workerLaunchSchema.parse(input);
  const binding = { workId: request.context.workId, environmentRef: request.context.environmentRef,
    bootRef: request.context.bootRef, invocationId: request.context.invocationId, role: request.context.role };
  const hosted = 'supervision' in host ? host : null;
  const plan = hosted ? planHostedLaunch(hosted, binding) : planWorkerLaunch(host, binding);
  // Ticket 59: derived before any effect, so an invalid budget never leaves a spawned child without its receiver.
  const secretSyncs = secretSyncLimit(sessionRequestBudget(request));
  await privatePath(host.runtimeDirectory);
  const directory = await mkdtemp(join(host.runtimeDirectory, 'w-'));
  const profileDirectory = join(directory, 'profile');
  const sessionsDirectory = join(profileDirectory, 'sessions');
  for (const path of [profileDirectory, sessionsDirectory, join(directory, 't'), join(directory, 'c')]) await mkdir(path, { mode: 0o700 });
  // Acceptance finding A7: the directory names its invocation, so the session of a worker that never returns (a lost boot) stays attributable.
  await recordWorkerLaunch(directory, { workId: request.context.workId, executionId: request.context.executionId, invocationId: request.context.invocationId, role: request.context.role });
  const { continueSession, ...launched } = request;
  // Ticket 11: the EXACT observed preserved session, copied into this worker's own private sessions directory before it exists.
  const continuedSession = continueSession ? await copyPreservedSession(root, sessionsDirectory, continueSession) : undefined;
  const session = request.review?.continueFrom === undefined ? undefined : await prepareReviewerContinuation(host.runtimeDirectory, profileDirectory, request.review.continueFrom);
  const bootstrap = { ...launched, ...(continuedSession ? { continuedSession } : {}), ...(request.review ? { review: { ...request.review, ...(session ? { session } : {}) } } : {}), version: 1,
    profile: { ...request.profile, directory: profileDirectory }, endpoint, recordsRoot: root };
  if (Buffer.byteLength(JSON.stringify(bootstrap)) > 65536 || signal.aborted) throw new Error('WORKER_BOOTSTRAP_INVALID');
  if (hosted) {
    // The owner endpoint this process serves for the boot must be the one of the runtime directory the worker is created in.
    if (await hosted.ownerEndpoint(request.context) !== join(host.runtimeDirectory, 'owner') || signal.aborted) throw new Error('WORKER_BOOT_MISMATCH');
  } else await supervisedByUnit(host as WorkerBootHost, request, root, signal);
  const child = spawn(plan.executable, plan.argv, { stdio: [...plan.stdio], detached: plan.detached,
    env: { ...plan.env, TMPDIR: join(directory, 't'), XDG_CACHE_HOME: join(directory, 'c') } });
  return superviseWorker(child, request, root, sessionsDirectory, signal, secrets, secretSyncs, relay, onHandoff, bootstrap);
}
async function supervisedByUnit(host: WorkerBootHost, request: WorkerLaunch, root: string, signal: AbortSignal) {
  const state = await unitState(host.unit);
  if (state.ActiveState !== 'active' || state.MainPID !== String(process.pid) || state.InvocationID !== host.invocation ||
      state.ControlGroup !== host.cgroup || (await readFile('/proc/self/cgroup', 'utf8')).trim() !== `0::${host.cgroup}` ||
      await readlink('/proc/self/ns/cgroup') !== host.cgroupNamespace || await readlink('/proc/self/ns/mnt') !== host.mountNamespace ||
      await workerOwnerEndpoint(root, request.context) !== join(host.runtimeDirectory, 'owner') || signal.aborted) throw new Error('WORKER_BOOT_MISMATCH');
}
/** The launched child's protocol (start receipt, result, handoff, secrets, questions): the same whatever supervises the boot. */
function superviseWorker(child: ReturnType<typeof spawn>, request: WorkerLaunch, root: string, sessionsDirectory: string, signal: AbortSignal,
  secrets: { registerSecret(value: string): void; revoke(): void }, secretSyncs: number,
  relay: { question(question: WorkerQuestionRequest): Promise<QuestionRelayAck> } | undefined, onHandoff: (event: Record<string, unknown>) => void, bootstrap: object) {
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
  let resulted = false;
  const secretReceiver = createOwnerSecretReceiver(child, request.context, signal, () => startReference !== undefined,
    value => secrets.registerSecret(value), reason => {
      startReject(new Error('WORKER_START_UNCERTAIN'));
      if (!resulted) completeResolve({ status: 'failure', code: secretChannelEndCode(reason) });
      secrets.revoke();
    }, secretSyncs);
  const questions = relay && request.context.role === 'builder'
    ? serveQuestionRelay(child, request.context, signal, () => startReference !== undefined, question => relay.question(question)) : undefined;
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
        z.strictObject({ kind: z.literal('worker-result'), status: z.enum(['completed', 'interrupted', 'boot-swap']), receipt: reference, sessionFile: z.string().nullable().optional(),
          sessionTools: z.array(z.string()).max(16).optional(), opinion: z.record(z.string(), z.json()).optional(), budgetExhausted: z.enum(['requests', 'tools']).optional(),
          providerUnavailable: z.literal(true).optional() }),
        z.strictObject({ kind: z.literal('worker-result'), status: z.literal('failure'), code: z.string() }),
        z.strictObject({ kind: z.literal('worker-result'), status: z.literal('question'), receipt: reference, sessionFile: z.string().nullable().optional(),
          sessionTools: z.array(z.string()).max(16).optional(), question: askedSchema }),
      ]).safeParse(message);
      if (parsed.success) {
        const result = parsed.data;
        const own = result.status !== 'failure' && startReference !== undefined && result.receipt.id === startReference.id && result.receipt.workId === startReference.workId;
        resulted = true; // the exit/secret-channel end that follows must not pre-empt this result while its session is observed
        // The preserved session is observed by this owner after the worker ended (no content leaves; absent if not observable).
        void (async () => {
          const session = result.status !== 'failure' && own ? await observePreservedSession(root, sessionsDirectory, result.sessionFile, result.sessionTools, request).catch(() => undefined) : undefined;
          const preserved = session ? { session } : {};
          if (result.status === 'question' && own && request.context.role === 'builder' && result.question.reference.workId === request.context.workId) {
            completeResolve({ status: 'question', receipt: result.receipt, question: result.question, ...preserved });
          } else if (result.status === 'completed' && own) completeResolve({ status: 'success', receipt: result.receipt, ...(result.opinion ? { opinion: result.opinion } : {}), ...preserved });
          // v2 ticket 09: only a Builder yields for a boot swap.
          else if (result.status === 'boot-swap' && own && request.context.role === 'builder') completeResolve({ status: 'boot-swap', receipt: result.receipt, ...preserved });
          // Ticket 48: a Builder closed by its own budget count (worker Host fact) is told apart from any other interruption. Ticket 57: so is a
          // Builder whose model request failed without a Host abort (an operational recovery, bounded by the Work's recoveries; never retried here).
          else completeResolve({ status: 'failure', code: result.status !== 'interrupted' ? 'WORKER_EXECUTION_UNCERTAIN'
            : own && request.context.role === 'builder' && result.budgetExhausted ? 'WORKER_BUDGET_EXHAUSTED'
              : own && request.context.role === 'builder' && result.providerUnavailable ? 'WORKER_PROVIDER_UNAVAILABLE' : 'WORKER_INTERRUPTED' });
          secretReceiver.close();
        })();
      }
    }
  });
  // Ticket 12: a started Builder with a handoff policy may notify its suspended handoff; the Host directive goes back on the same IPC.
  child.on('message', message => {
    const parsed = z.strictObject({ kind: z.literal('worker-handoff'), event: z.record(z.string(), z.json()) }).safeParse(message);
    if (parsed.success && startReference && request.context.role === 'builder' && request.handoff && !signal.aborted &&
        Buffer.byteLength(JSON.stringify(parsed.data.event)) <= 32768) onHandoff(parsed.data.event);
  });
  const lost = () => { questions?.close(); secretReceiver.close(); startReject(new Error('WORKER_START_UNCERTAIN'));
    if (!resulted) completeResolve({ status: 'failure', code: 'WORKER_EXECUTION_UNCERTAIN' }); signal.removeEventListener('abort', abort); };
  child.once('error', lost); child.once('exit', lost);
  child.send(bootstrap, error => { if (error) { lost(); abort(); } });
  if (signal.aborted) abort();
  const deliver = (directive: Record<string, unknown>) => new Promise<boolean>(resolve => {
    // Review results reach only a Builder launched with a handoff policy; the boot-swap notice (v2 ticket 09) any started Builder.
    if (!child.connected || signal.aborted || !startReference || request.context.role !== 'builder' || (directive.kind !== 'boot-swap' && !request.handoff)) { resolve(false); return; }
    child.send({ kind: 'deliver', directive }, error => resolve(!error));
  });
  return { started, completed, deliver };
}
