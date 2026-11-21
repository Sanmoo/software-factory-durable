import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchWorker, workerRuntimeDirectory, type HostedWorkerBoot, type WorkerLaunch } from '../../platform/host/index.js';
import type { BootRef } from '../lifecycle.js';
import { serveBootOwner, type BootOwnerParts } from '../owner-registration.js';
import type { EnvironmentRef } from '../prepare.js';
import { cleanupAuthorizationSchema } from '../cleanup-records.js';
import type { RemoveResult } from '../remove.js';
import { currentLambdaBoot, listLambdaBoots, readLambdaBoot, stopLambdaBoot, type LambdaBootDependencies } from './boot.js';
import { serveLambdaTools, type LambdaEnvironmentEnd } from './tools.js';

/**
 * v2 ticket 06: the boot owner of a Lambda boot. The guest is not a process of this host, so no per-boot systemd unit exists: the owner
 * endpoint, the tool bindings of every invocation and the worker processes all live in the trusted host process that started the boot
 * (the controller owner). The endpoint protocol and the worker launch contract are the ones of the Gondolin boot owner; the adapter
 * supplies only its parts (`BootOwnerParts`): the boot's SSH channel bound per role, and a hosted worker launch.
 */
export type LambdaWorkerLauncher = BootOwnerParts['launch'];

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/**
 * Where the workers of an ACTIVE Lambda boot connect: the owner endpoint in the boot's private runtime directory. Refused for a context
 * that is not the Work, environment and CURRENT boot the host recorded (never a path built from an unchecked reference).
 */
export async function lambdaOwnerEndpoint(root: string, context: Pick<WorkerLaunch['context'], 'workId' | 'environmentRef' | 'bootRef'>): Promise<string> {
  const record = await readLambdaBoot(root, context.environmentRef as EnvironmentRef, context.bootRef as BootRef);
  if (!record || record.workId !== context.workId || record.phase !== 'active' ||
      await currentLambdaBoot(root, context.environmentRef as EnvironmentRef) !== context.bootRef) throw new Error('WORKER_BOOT_MISMATCH');
  return join(workerRuntimeDirectory(await realpath(root), record.boot), 'owner');
}

/**
 * Serves the owner endpoint of one active boot in THIS process. `close` ends every binding, worker lifetime and connection of the boot's
 * channel; it must happen before the boot is stopped (stop collects the last evidence over its own connection).
 *
 * v2 ticket 10 (V2-15): the tool owner watches the environment. When the service confirms its end, the tools are already denied and the
 * calls in flight answered; this owner then aborts the lifetime of EVERY worker it launched (the signal the worker launch supervises: the
 * worker process is told to abort its session, so it makes no further model request) and resolves `ended` for Control.
 */
export async function serveLambdaOwner(dependencies: LambdaBootDependencies & { launcher?: LambdaWorkerLauncher }, { environment, boot }: { environment: EnvironmentRef; boot: BootRef }):
  Promise<{ status: 'serving'; close(): Promise<void>; /** Resolves once, when the service confirmed the end of the environment. */ ended: Promise<LambdaEnvironmentEnd> } | { status: 'unavailable'; code: string }> {
  const record = await readLambdaBoot(dependencies.root, environment, boot);
  if (!record) return { status: 'unavailable', code: 'BOOT_NOT_FOUND' };
  const environmentGone = new AbortController();
  let reportEnd!: (observed: LambdaEnvironmentEnd) => void;
  const ended = new Promise<LambdaEnvironmentEnd>(resolve => { reportEnd = resolve; });
  const served = await serveLambdaTools(dependencies, { environment, boot }, { environmentEnded: observed => { environmentGone.abort(); reportEnd(observed); } });
  if (served.status !== 'serving') return served;
  const { tools } = served;
  try {
    const root = await realpath(dependencies.root);
    const runtimeDirectory = workerRuntimeDirectory(root, boot);
    await privateDirectory(join(root, 'r'));
    await privateDirectory(runtimeDirectory);
    await writeFile(join(runtimeDirectory, 'owner.json'), JSON.stringify({ version: 1, environment, boot }), { mode: 0o600 });
    const host: HostedWorkerBoot = { supervision: 'host-process', workId: record.workId, environmentRef: environment, bootRef: boot, runtimeDirectory,
      ownerEndpoint: context => lambdaOwnerEndpoint(root, context) };
    const owner = await serveBootOwner(root, { workId: record.workId, environmentRef: environment, bootRef: boot }, {
      directory: runtimeDirectory,
      // The adapter's own qualification (`lambdaToolOrigin`, stated by `tools.bind`): the Builder output copy and Builder Read are served.
      copyOutput: true,
      async add(binding) {
        const bound = await tools.bind(binding);
        if (bound.status !== 'bound') throw new Error(bound.code);
      },
      close: () => tools.close(),
      launch: async (request, endpoint, lifetime, secrets, relay, onHandoff) => {
        // No worker starts on an environment that ended, and none outlives it.
        if (environmentGone.signal.aborted) throw new Error('ENVIRONMENT_ENDED');
        const signal = AbortSignal.any([lifetime, environmentGone.signal]);
        return dependencies.launcher ? dependencies.launcher(request, endpoint, signal, secrets, relay, onHandoff) : launchWorker(host, request, endpoint, root, signal, secrets, relay, onHandoff);
      },
    });
    return { status: 'serving', close: () => owner.close(), ended };
  } catch {
    await tools.close();
    return { status: 'unavailable', code: 'BOOT_OWNER_UNAVAILABLE' };
  }
}

/**
 * Remover (V2-02, partial; ticket 12 adds the lost-marker ref): ends whatever of the Work's environment still runs, confirmed by the
 * service, removes the boots' private host runtime directories and records the removal. It never touches the Work branch nor the pull
 * request, and there is no disk, workspace or artifacts tree on the host to delete (`absent`). The boot records stay: they are the
 * consumption history (ticket 14); the image record stays for the image cleanup (ticket 15).
 */
export async function removeLambdaEnvironment(dependencies: LambdaBootDependencies, { environment, cleanup }: { environment: EnvironmentRef; cleanup: unknown }): Promise<RemoveResult> {
  const none = (status: 'refused' | 'absent') => (['disk', 'workspace', 'artifacts', 'runtime'] as const).map(resource => ({ resource, status: resource === 'runtime' ? status : 'absent' as const }));
  const authorization = cleanupAuthorizationSchema.safeParse(cleanup);
  if (!authorization.success) return { status: 'failure', code: 'CLEANUP_NOT_AUTHORIZED', resources: none('refused') };
  const boots = await listLambdaBoots(dependencies.root, environment);
  if (boots.some(record => record.workId !== authorization.data.workId)) return { status: 'failure', code: 'ENVIRONMENT_NOT_OWNED', resources: none('refused') };
  for (const record of boots) {
    if (record.phase === 'ended') continue;
    const stopped = await stopLambdaBoot(dependencies, { environment, boot: record.boot as BootRef, reason: 'end' }).catch(() => null);
    // Never a removal over something that may still run: the next attempt observes it again.
    if (!stopped?.cessationConfirmed) return { status: 'indeterminate', code: 'CESSATION_NOT_CONFIRMED', resources: none('refused') };
  }
  const root = await realpath(dependencies.root);
  let removed = false;
  try {
    for (const record of boots) {
      const runtime = workerRuntimeDirectory(root, record.boot);
      if (await rm(runtime, { recursive: true }).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; })) removed = true;
    }
    await writeFile(join(root, 'lambda', 'works', environment, 'removal.json'), JSON.stringify({ version: 1, environment, workId: authorization.data.workId,
      workDisposition: authorization.data.workDisposition, at: new Date(dependencies.clock.now()).toISOString(), boots: boots.map(record => record.boot) }), { mode: 0o600 });
  } catch { return { status: 'partial', code: 'RUNTIME_REMOVAL_FAILED', resources: none('refused').map(item => item.resource === 'runtime' ? { ...item, status: 'failed' as const } : item) }; }
  return { status: 'success', resources: none(removed ? 'refused' : 'absent').map(item => item.resource === 'runtime' && removed ? { ...item, status: 'removed' as const } : item) };
}
