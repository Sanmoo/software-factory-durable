import { constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import type { Diagnostic } from '../contracts/index.js';
import { canAccess, inspectMemory, inspectStorage, versionOf } from '../platform/host/index.js';
import { createBootLedger } from './capacity.js';
import { inspectGuestAssets, type GuestAssetPin } from './guest-assets.js';
import { validateConfiguration } from './configuration.js';
import { prepareEnvironment, type PrepareResult } from './prepare.js';
export type { EnvironmentRef, PrepareResult } from './prepare.js';
import type { RepositoryFetchCredentials } from '../contracts/index.js';
import { createCheckouts, type CheckoutRequest, type CheckoutView } from './checkout.js';
import { seedArtifacts, type ArtifactSeed } from './artifact-seeds.js';
export type { CheckoutRequest, CheckoutView } from './checkout.js';
export type { ArtifactSeed } from './artifact-seeds.js';
// Host-side read-only observation of guest-writable trees (never host git/commands in them).
export { readConfined } from './confined.js';
export { bootMemoryAllows, capacityDiagnostic, createBootLedger, memoryFloorMiB, observeHostCapacity, type HostCapacity } from './capacity.js';
export { environmentDependencies, type EnvironmentDependency } from './asset-dependencies.js';
import { readConfined } from './confined.js';
export { inspectCheckout, type CheckoutInspection } from './checkout-inspection.js';
// Ticket 26: read-only host inventory of own runtime resources for the controller boot (composition only, never a worker tool).
export { inventoryRuntime, type RuntimeListing } from './inventory.js';
export { environmentIdentityDiagnostic } from './environment-identity.js';
export { reconcileInterruptedCaches, type CacheReconciliation } from './checkout.js';
import { observeProposal } from './proposal-identity.js';
import { fingerprintCheckout } from './checkout-fingerprint.js';
import type { CheckoutFingerprint } from '../contracts/index.js';
export type PreparedWork = PrepareResult | { status: 'success'; environment: EnvironmentRef; checkout: CheckoutView;
  seeds: { name: string; manifestSha256: string; reused: boolean; replaced?: string }[] };
export type { GuestAssetPin } from './guest-assets.js';
import { currentBoot, observeEnvironment, type BootRef } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';
export type { BootRef, StartupFailure } from './lifecycle.js';
import type { Observation as LifecycleObservation } from './lifecycle.js';
import { observeStorage, type StorageObservation } from './storage-observation.js';
export type { StorageObservation } from './storage-observation.js';
export type Observation = LifecycleObservation & { storage?: StorageObservation };
import { startEnvironment, type DiskRemedy, type StartResult } from './start.js';
export type { DiskRemedy, StartRemedyOutcome, StartResult } from './start.js';
export type { GuestStop, GuestStopReason } from './guest-shutdown.js';
import { stopEnvironment } from './stop.js';
export type { StopResult } from './stop.js';
import { removeEnvironment } from './remove.js';
import { exportEvidence } from './evidence-export.js';
export type { EvidenceExport } from './evidence-export.js';
export type { RemoveResult, ResourceRemoval } from './remove.js';
// Trusted process composition only; never projected as a worker tool.
export { runSandboxAdapter } from './adapter.js';
// Release build (ticket 32) only: the pinned private Gondolin profile prepared/verified inside a release tree; never at runtime.
export { prepareReleaseGondolinSdk, verifyDevelopmentGondolinSdk as verifyGondolinSdk, gondolinSdkProfile } from './gondolin-sdk-profile.js';
// Ticket 47 build tool (operator/supervisor only, never at runtime): a NEW guest asset version whose root ext4 has a journal.
export { deriveJournaledGuestAssets } from './guest-journal.js';
import { connectReadTools, type ToolCall, type ReadResult, type ToolContext } from './read-tools.js';
import { registerOwnerTools } from './owner-registration.js';
export type { ToolContext, ToolCall, ReadCall, ReadResult, ToolProjection, ReadBinding } from './read-tools.js';
export type { WriteCall } from './write-tools.js';

/**
 * `repositoryFetch`/`remoteUrl`/`artifactSeeds` are trusted composition inputs (controller only): the host Contents:read fetch credential,
 * the upstream fetch URL (GitHub by default) and read-only Factory material copied once per environment into /artifacts.
 */
export function createSandbox({ root, guestAssets, toolEndpoint, repositoryFetch, remoteUrl, artifactSeeds = [] }: { root: string; guestAssets?: GuestAssetPin; toolEndpoint?: string;
  repositoryFetch?: RepositoryFetchCredentials; remoteUrl?: (scope: { repository: string }) => string; artifactSeeds?: readonly ArtifactSeed[] }) {
  const checkouts = repositoryFetch ? createCheckouts({ root, fetch: repositoryFetch, ...(remoteUrl ? { remoteUrl } : {}) }) : undefined;
  const projections = new Map<string, Promise<Awaited<ReturnType<typeof connectReadTools>>>>();
  const bindings = new Map<string, string>();
  const bootLedger = createBootLedger(async () => (await inspectMemory())?.availableBytes);
  return {
    async executeTool(context: ToolContext, call: ToolCall, onData?: (data: Buffer) => void, signal?: AbortSignal): Promise<ReadResult> {
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
        return await (await projection).executeTool(call, onData, signal);
      } catch (error) {
        return { status: 'failure', code: error instanceof Error && error.message === 'STALE_TOOL_CONTEXT'
          ? 'STALE_TOOL_CONTEXT' : toolEndpoint ? 'TOOL_CHANNEL_CLOSED' : 'TOOL_CHANNEL_UNAVAILABLE' };
      }
    },
    /** Host-side identity of the handed-off proposal of `round` (confined reads; no host git, no guest command). */
    async observeProposal({ environment, round }: { environment: EnvironmentRef; round: number }) {
      if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'refused' as const, code: 'ENVIRONMENT_REF_INVALID' };
      return observeProposal(join(await realpath(root), 'environments', environment), round);
    },
    /** Ticket 48: Host fingerprint of the Work's checkout (confined Git metadata reads + bounded no-follow tree walk; no host git, no guest command). */
    async observeCheckout({ environment }: { environment: EnvironmentRef }): Promise<CheckoutFingerprint> {
      if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'unavailable', code: 'ENVIRONMENT_REF_INVALID' };
      return fingerprintCheckout(join(await realpath(root), 'environments', environment));
    },
    /**
     * Ticket 13 (review fix 3): Host confirmation of a preserved-source authorization. Confined, no-follow reads only: the referenced
     * file must exist under /artifacts/<kind>/<version>/ AND be listed in that version's sources.json. Control never trusts a path prefix.
     */
    async verifyPreservedSource({ environment, reference }: { environment: EnvironmentRef; reference: string }) {
      if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'invalid' as const, code: 'ENVIRONMENT_REF_INVALID' };
      const match = /^\/artifacts\/(spec|instructions)\/(v[1-9][0-9]{0,3})\/([^#]+)$/.exec(reference.split('#')[0]!);
      if (!match) return { status: 'invalid' as const, code: 'AUTHORIZATION_REFERENCE_INVALID' };
      const kind = match[1]!, version = match[2]!, file = match[3]!;
      if (file.split('/').some(part => part === '' || part === '.' || part === '..')) return { status: 'invalid' as const, code: 'AUTHORIZATION_REFERENCE_INVALID' };
      try {
        const artifacts = join(await realpath(root), 'environments', environment, 'artifacts');
        const index = await readConfined(artifacts, `${kind}/${version}/sources.json`, 4 * 1024 * 1024);
        if (!index) return { status: 'invalid' as const, code: 'PRESERVED_SOURCE_INDEX_MISSING' };
        const sources = JSON.parse(index.toString('utf8')) as { sources?: { copy?: unknown }[] };
        const listed = new Set((sources.sources ?? []).flatMap(entry => typeof entry.copy === 'string' ? [entry.copy.replace(/^\.\//, '')] : []));
        if (!listed.has(file)) return { status: 'invalid' as const, code: 'PRESERVED_SOURCE_NOT_LISTED' };
        const content = await readConfined(artifacts, `${kind}/${version}/${file}`, 16 * 1024 * 1024);
        if (!content) return { status: 'invalid' as const, code: 'PRESERVED_SOURCE_MISSING' };
        return { status: 'verified' as const, code: 'PRESERVED_SOURCE_VERIFIED' };
      } catch { return { status: 'invalid' as const, code: 'PRESERVED_SOURCE_UNSAFE' }; }
    },
    /** Ticket 17: copy the own environment's review/spec/instructions evidence into a caller-owned private directory before removal. */
    async exportEvidence({ environment, destination }: { environment: EnvironmentRef; destination: string }) {
      return exportEvidence(root, environment, destination);
    },
    async remove({ environment, cleanup }: { environment: EnvironmentRef; cleanup: unknown }) {
      return removeEnvironment(root, environment, cleanup);
    },
    async stop({ environment, boot, reason }: { environment: EnvironmentRef; boot: BootRef; reason: string }) {
      return stopEnvironment(root, environment, boot, reason);
    },
    /** `pass`: the dispatch pass that reserved this boot (ticket 24; correlation only). The memory precondition counts every other own
     * boot still launching, whatever its pass; this boot leaves that set when its start returns. */
    /** `diskRemedy` (ticket 47): the operator's explicit decision for a preserved disk that fails its check, applied by this start only. */
    async start({ environment, configuration, diskRemedy }: { environment: EnvironmentRef; configuration: unknown; pass?: string; diskRemedy?: DiskRemedy }): Promise<StartResult> {
      const parsed = validateConfiguration(configuration);
      if (!parsed.valid) return { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' };
      let release: (() => void) | null = null;
      try {
        return await startEnvironment(root, guestAssets, environment, parsed.effective, async () => (release = await bootLedger.admit(parsed.effective)) !== null,
          diskRemedy === 'repair-disk' || diskRemedy === 'replace-disk' ? diskRemedy : undefined);
      } finally { (release as (() => void) | null)?.(); }
    },
    async observe({ environment, boot }: { environment: EnvironmentRef; boot?: BootRef }): Promise<Observation> {
      // Ticket 26: without an explicit boot, the environment's published current boot is the one observed (and returned for a stop); an
      // owned, prepared environment that never published one is `not-booted` (no unit can exist for it).
      const current = boot === undefined ? await currentBoot(root, environment) : undefined;
      const lifecycle: LifecycleObservation = current === null ? { condition: 'not-booted', cessationConfirmed: true, consumption: 'unavailable', boot: null }
        : await observeEnvironment(root, environment, boot);
      const observation = current && (lifecycle.condition === 'active' || lifecycle.condition === 'stopped') ? { ...lifecycle, boot: current } : lifecycle;
      const storage = await observeStorage(root, environment, observation.condition === 'removed');
      return { ...observation, ...(storage ? { storage } : {}) };
    },
    /** With `checkout`, the environment also receives the Work's own checkout (spec §7.3) and the composed artifact seeds; never a boot or agent. */
    /** `recreateSeeds` (ticket 50): seeds the operator explicitly decided to recreate after an ARTIFACT_SEED_VERSION_CONFLICT. */
    async prepare({ workId, configuration, checkout, recreateSeeds }: { workId: string; configuration: unknown; checkout?: CheckoutRequest; recreateSeeds?: readonly string[] }): Promise<PreparedWork> {
      const parsed = validateConfiguration(configuration);
      if (!parsed.valid) return { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' };
      let prepared: PrepareResult;
      try { prepared = await prepareEnvironment(root, guestAssets, workId, parsed.effective); }
      catch { return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_UNAVAILABLE' }; }
      if (prepared.status !== 'success' || !checkout) return prepared;
      if (!checkouts) return { status: 'failure', code: 'CHECKOUT_NOT_COMPOSED' };
      const directory = join(await realpath(root), 'environments', prepared.environment);
      const result = await checkouts.prepare(directory, checkout);
      if (result.status !== 'success') return result;
      const seeds = await seedArtifacts(join(directory, 'artifacts'), artifactSeeds, recreateSeeds?.length ? { recreate: recreateSeeds } : {});
      if (seeds.status !== 'success') return seeds;
      return { status: 'success', environment: prepared.environment, checkout: result.checkout, seeds: seeds.seeds };
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
      checks.push({ id: 'sandbox-tool-channel', status: 'blocked',
        message: 'The approved boot/invocation/role-bound executeTool channel is not implemented; fixed readiness commands are not a Builder tool interface.',
        nextStep: 'Implement the approved confined tool projection and adapter transport before Docker qualification; do not expose arbitrary guestExec or the Gondolin SDK.' });
      checks.push({ id: 'sandbox-network-policy', status: 'unverified',
        message: 'Native public HTTP(S) mediation, synthetic DNS, no WebSockets/SSH/raw TCP/ingress and a private per-boot CA path are configured, not runtime-qualified. Built-in private-range guards plus known host-interface address exclusions do not identify every public host/Other Work endpoint or special IP range.',
        nextStep: 'Qualify DNS/connect/redirect isolation and guest/daemon/container TLS under separate authorization; Docker bridge/NAT/ports and container trust remain unproved. No unrestricted networking or insecure TLS fallback.' });
      checks.push({ id: 'docker-runtime', status: 'unverified', message: 'No VM boot, Docker or container/TLS test was performed.',
        nextStep: 'Run the authorized real Gondolin/Docker/TLS integration group; doctor is not that proof.' });
      return { configuration: validated, checks, versions };
    },
  };
}
