import { constants } from 'node:fs';
import { platform, arch } from 'node:os';
import type { Diagnostic } from '../contracts/index.js';
import { canAccess, inspectStorage, versionOf } from '../platform/host/index.js';
import { inspectGuestAssets, type GuestAssetPin } from './guest-assets.js';
import { validateConfiguration } from './configuration.js';
import { prepareEnvironment, type PrepareResult } from './prepare.js';
export type { EnvironmentRef, PrepareResult } from './prepare.js';
export type { GuestAssetPin } from './guest-assets.js';
import { observeEnvironment, type BootRef } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';
export type { BootRef, StartupFailure } from './lifecycle.js';
import type { Observation as LifecycleObservation } from './lifecycle.js';
import { observeStorage, type StorageObservation } from './storage-observation.js';
export type { StorageObservation } from './storage-observation.js';
export type Observation = LifecycleObservation & { storage?: StorageObservation };
import { startEnvironment, type StartResult } from './start.js';
export type { StartResult } from './start.js';
import { stopEnvironment } from './stop.js';
export type { StopResult } from './stop.js';
import { removeEnvironment } from './remove.js';
export type { RemoveResult, ResourceRemoval } from './remove.js';
// Trusted process composition only; never projected as a worker tool.
export { runSandboxAdapter } from './adapter.js';
import { connectReadTools, type ReadCall, type ReadResult, type ToolContext } from './read-tools.js';
import { registerOwnerTools } from './owner-registration.js';
export type { ToolContext, ReadCall, ReadResult, ToolProjection, ReadBinding } from './read-tools.js';

export function createSandbox({ root, guestAssets, toolEndpoint }: { root: string; guestAssets?: GuestAssetPin; toolEndpoint?: string }) {
  const projections = new Map<string, Promise<Awaited<ReturnType<typeof connectReadTools>>>>();
  const bindings = new Map<string, string>();
  return {
    async executeTool(context: ToolContext, call: ReadCall): Promise<ReadResult> {
      const key = JSON.stringify(context);
      const previous = bindings.get(context.invocationId);
      if (previous !== undefined && previous !== key) return { status: 'failure', code: 'STALE_TOOL_CONTEXT' };
      try {
        let projection = projections.get(key);
        if (!projection) {
          const setup = toolEndpoint ? connectReadTools(toolEndpoint, context) : registerOwnerTools(root, context);
          const pending = setup.catch(error => {
            // Retry only failed setup, never an established/revoked projection.
            // Invocation context and owner-side reservations remain immutable.
            if (projections.get(key) === pending) projections.delete(key);
            throw error;
          });
          projection = pending;
          projections.set(key, projection);
          bindings.set(context.invocationId, key);
        }
        return await (await projection).executeTool(call);
      } catch (error) {
        return { status: 'failure', code: error instanceof Error && error.message === 'STALE_TOOL_CONTEXT'
          ? 'STALE_TOOL_CONTEXT' : toolEndpoint ? 'TOOL_CHANNEL_CLOSED' : 'TOOL_CHANNEL_UNAVAILABLE' };
      }
    },
    async remove({ environment, cleanup }: { environment: EnvironmentRef; cleanup: unknown }) {
      return removeEnvironment(root, environment, cleanup);
    },
    async stop({ environment, boot, reason }: { environment: EnvironmentRef; boot: BootRef; reason: string }) {
      return stopEnvironment(root, environment, boot, reason);
    },
    async start({ environment, configuration }: { environment: EnvironmentRef; configuration: unknown }): Promise<StartResult> {
      const parsed = validateConfiguration(configuration);
      if (!parsed.valid) return { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' };
      return startEnvironment(root, guestAssets, environment, parsed.effective);
    },
    async observe({ environment, boot }: { environment: EnvironmentRef; boot?: BootRef }): Promise<Observation> {
      const observation = await observeEnvironment(root, environment, boot);
      const storage = await observeStorage(root, environment, observation.condition === 'removed');
      return { ...observation, ...(storage ? { storage } : {}) };
    },
    async prepare({ workId, configuration }: { workId: string; configuration: unknown }): Promise<PrepareResult> {
      const parsed = validateConfiguration(configuration);
      if (!parsed.valid) return { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' };
      try { return await prepareEnvironment(root, guestAssets, workId, parsed.effective); }
      catch { return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_UNAVAILABLE' }; }
    },
    async validate(configuration: unknown) {
      const validated = validateConfiguration(configuration);
      const checks: Diagnostic[] = [
        ...await inspectGuestAssets(guestAssets),
        { id: 'sandbox-release', status: 'unverified',
          message: 'Development profile only; no distributed release or real sandbox qualification is available.',
          nextStep: 'Build and qualify the fixed Arch x86_64/QEMU/KVM/Alpine/Docker vfs composition before operation.' },
      ];
      const versions: Record<string, string | null> = {};
      for (const command of ['qemu-system-x86_64', 'qemu-img', 'systemctl']) {
        const version = versionOf(command);
        versions[command] = version ?? null;
        checks.push({ id: command, status: version ? 'ok' : 'blocked',
          message: version ? `Version ${version} found; not runtime qualification.` : 'Required executable unavailable or version unreadable.',
          nextStep: 'Administrator must provide the release-compatible executable; doctor never installs packages.' });
      }
      const filesystemTools = (await Promise.all(['/usr/bin/e2fsck', '/usr/bin/resize2fs']
        .map(path => canAccess(path, constants.X_OK)))).every(Boolean);
      checks.push({ id: 'filesystem-tools', status: filesystemTools ? 'ok' : 'blocked',
        message: filesystemTools ? 'Native ext4 check/growth utilities are executable; not filesystem or boot qualification.'
          : 'Required native ext4 utilities are unavailable.',
        nextStep: 'Administrator must provide e2fsck and resize2fs; the adapter never installs tools or mounts guest filesystems on the host.' });
      const kvm = await canAccess('/dev/kvm', constants.R_OK | constants.W_OK);
      checks.push({ id: 'kvm-access', status: kvm ? 'ok' : 'blocked',
        message: kvm ? '/dev/kvm is readable/writable by this account.' : '/dev/kvm is not readable/writable.',
        nextStep: 'Administrator must enable KVM/nested virtualization and grant this account access; no TCG fallback.' });
      checks.push({ id: 'kvm-functional', status: 'unverified', message: 'Access alone does not prove functional accelerated VM execution.',
        nextStep: 'Run the separately authorized real sandbox qualification before operation.' });
      const systemd = await canAccess('/run/systemd/system');
      checks.push({ id: 'systemd', status: systemd ? 'unverified' : 'blocked',
        message: systemd ? 'Systemd boot detected; environment supervision permissions are not proved offline.' : 'Systemd boot not detected.',
        nextStep: 'Administrator must prepare and qualify systemd supervision; doctor creates no unit or process group.' });
      checks.push({ id: 'host-platform', status: platform() === 'linux' && arch() === 'x64' ? 'ok' : 'blocked',
        message: `${platform()}/${arch()}; development diagnostics do not qualify a release on Arch Linux.`,
        nextStep: 'Use and qualify the fixed Linux x86_64 reference profile; no backend fallback.' });
      const storage = await inspectStorage(root);
      const enough = storage && (!validated.valid || BigInt(storage.availableBytes) >= BigInt(validated.effective.minFreeSpaceGiB) * 1073741824n);
      checks.push({ id: 'storage', status: storage && enough && !storage.unsuitable ? 'ok' : 'blocked',
        message: storage ? `Filesystem ${storage.type}; available ${storage.availableBytes} bytes. Virtual disk capacity is not reserved.` : 'Storage is unreadable.',
        nextStep: 'Provide persistent local storage above the configured free-space floor; preparation will also account for estimated copies.' });
      checks.push({ id: 'storage-lock-durability', status: 'unverified',
        message: 'Read-only diagnostics cannot prove filesystem lock/fsync/power-loss semantics.',
        nextStep: 'Qualify persistent storage and exclusive locking in the authorized storage integration group.' });
      checks.push({ id: 'docker-runtime', status: 'unverified', message: 'No VM boot, Docker or container/TLS test was performed.',
        nextStep: 'Run the authorized real Gondolin/Docker/TLS integration group; doctor is not that proof.' });
      return { configuration: validated, checks, versions };
    },
  };
}
