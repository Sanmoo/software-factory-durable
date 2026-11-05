import { z } from 'zod';
import { constants } from 'node:fs';
import { platform, arch } from 'node:os';
import type { Diagnostic } from '../contracts/index.js';
import { canAccess, inspectStorage, versionOf } from '../platform/host/index.js';

// Development profile identity only: no distributed assets or qualified release yet.
const configurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal('gondolin-qemu-alpine-dev-v1'),
  memoryMiB: z.number().int().positive().safe().default(2048),
  vcpus: z.number().int().positive().safe().default(2),
  diskGiB: z.number().int().positive().safe().default(40),
  shutdownGraceSeconds: z.number().int().positive().safe().default(30),
  minFreeSpaceGiB: z.number().int().positive().safe().default(4),
});

function validateConfiguration(configuration: unknown) {
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success) {
    return { valid: false as const, errors: parsed.error.issues.map(issue => ({
      code: 'SANDBOX_CONFIGURATION_INVALID', path: ['sandbox', ...issue.path].join('.'),
    })) };
  }
  return { valid: true as const, effective: parsed.data };
}

export function createSandbox({ root }: { root: string }) {
  return {
    async validate(configuration: unknown) {
      const validated = validateConfiguration(configuration);
      const checks: Diagnostic[] = [];
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
