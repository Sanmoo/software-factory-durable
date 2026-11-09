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
export type { BootRef, Observation } from './lifecycle.js';
import { startEnvironment, type StartResult } from './start.js';
export type { StartResult } from './start.js';
import { stopEnvironment } from './stop.js';
export type { StopResult } from './stop.js';
// Trusted process composition only; never projected as a worker tool.
export { runSandboxAdapter } from './adapter.js';

export function createSandbox({ root, guestAssets }: { root: string; guestAssets?: GuestAssetPin }) {
  return {
    async stop({ environment, boot, reason }: { environment: EnvironmentRef; boot: BootRef; reason: string }) {
      return stopEnvironment(root, environment, boot, reason);
    },
    async start({ environment, configuration }: { environment: EnvironmentRef; configuration: unknown }): Promise<StartResult> {
      const parsed = validateConfiguration(configuration);
      if (!parsed.valid) return { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' };
      return startEnvironment(root, guestAssets, environment, parsed.effective);
    },
    async observe({ environment, boot }: { environment: EnvironmentRef; boot?: BootRef }) {
      return observeEnvironment(root, environment, boot);
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
