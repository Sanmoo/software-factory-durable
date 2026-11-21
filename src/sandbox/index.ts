import { constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import type { Diagnostic } from '../contracts/index.js';
import { canAccess, inspectMemory, inspectStorage, versionOf } from '../platform/host/index.js';
import { createBootLedger } from './capacity.js';
import { inspectGuestAssets, type GuestAssetPin } from './guest-assets.js';
import { selectSandboxAdapter, validateConfiguration } from './configuration.js';
// v2 ticket 01: the installation's single adapter selection and the capabilities it declares (pure; composition and diagnostics).
export { selectSandboxAdapter, sandboxAdapters, type SandboxAdapter, type SandboxAdapterSelection } from './configuration.js';
// v2 ticket 02: the Lambda adapter's profile, the installation's account resources and the narrow port to the AWS account (CLI-backed in
// production; tests compose the in-memory account of `test/sandbox/lambda-service-fake.ts` through `lambdaService`).
import type { BootUsageReport, ChannelReport, EnvironmentBuildReport } from '../contracts/index.js';
import { lambdaEnvironmentUsage, lambdaImageBuilds } from './lambda/usage.js';
import { validateLambdaInstallation } from './lambda/validate.js';
import { createLambdaCliService } from './lambda/cli-service.js';
import type { LambdaServiceFactory } from './lambda/service.js';
export { createLambdaCliService, type AwsCliRunner } from './lambda/cli-service.js';
// v2 ticket 03: Prepare under the Lambda adapter guarantees the MicroVM image of the environment key (`lambda/image.ts`).
import { prepareLambdaImage, type LambdaImageWait } from './lambda/image.js';
export type { LambdaImageWait } from './lambda/image.js';
export type { LambdaImage, LambdaImageRequest, LambdaListedMicrovm, LambdaMicrovm, LambdaMicrovmRequest } from './lambda/service.js';
// v2 ticket 15: the inventory of the installation's MicroVMs at controller start (`lambda/reconciliation.ts`).
import { reconcileLambdaInstallation, type LambdaRuntimeReconciliation } from './lambda/reconciliation.js';
export { planLambdaReconciliation, type LambdaRuntimeReconciliation } from './lambda/reconciliation.js';
// v2 ticket 15: the explicit cleanup of the installation's MicroVM images (`lambda/image-cleanup.ts`).
import { cleanupInstallationImages, type ImageCleanupResult } from './lambda/image-cleanup.js';
export { planImageCleanup, type ImageCleanupItem, type ImageCleanupResult } from './lambda/image-cleanup.js';
export type { LambdaArchitecture, LambdaService, LambdaServiceFactory, LambdaServiceFailure, LambdaServiceResult } from './lambda/service.js';
export { lambdaBootSize, type LambdaProfile } from './lambda/profile.js';
// v2 ticket 04: a boot under the Lambda adapter (RunMicrovm, channel, clone in the guest; observe and stop by the service) and the seam
// to the guest: SSH over WebSocket in production (`createSshTransport`), an in-process guest in tests (`lambdaTransport`).
import { currentLambdaBoot, defaultLambdaBootClock, isLambdaEnvironment, listLambdaBoots, observeLambdaBoot, openLambdaBootChannel, readLambdaBoot, readLambdaChannelReport, startLambdaBoot, stopLambdaBoot,
  type BootBeginReason, type LambdaBootClock, type LambdaCheckout, type LambdaObservation, type LambdaObservationTimer } from './lambda/boot.js';
export type { LambdaObservationTimer } from './lambda/boot.js';
import { createSshTransport } from './lambda/ssh-transport.js';
// v2 ticket 05: the MVP role tools over a Lambda boot (`lambda/tools.ts`): the host binds each invocation to a role on the boot.
import { serveLambdaTools, type LambdaEnvironmentEnd } from './lambda/tools.js';
export type { LambdaEnvironmentEnd } from './lambda/tools.js';
export { environmentEndedCode } from './tool-binding.js';
// v2 ticket 06: the Lambda boot owner (worker launch in the host process), the channel observations that replace the host reads of the
// workspace, the evidence collection before a stop and Remove.
import { lambdaOwnerEndpoint, removeLambdaEnvironment, serveLambdaOwner, type LambdaWorkerLauncher } from './lambda/owner.js';
import { observeLambdaProposal, verifyLambdaPreservedSource } from './lambda/artifacts.js';
// v2 ticket 07: the preservation gate's observation (workspace, stash, HEAD, `ls-remote`), one fixed program over the boot's channel.
import { observeLambdaPreservation } from './lambda/preservation.js';
import { workerOwnerEndpoint, type WorkerLaunch } from '../platform/host/index.js';
export type { LambdaWorkerLauncher } from './lambda/owner.js';
export type { BootOwnerParts } from './owner-registration.js';
export { guestUserOfRole, lambdaToolOrigin, type LambdaToolBinding, type LambdaTools } from './lambda/tools.js';
import type { GuestTransport } from './lambda/transport.js';
export type { BootBeginReason, BootEndReason, LambdaBootClock, LambdaBootRecord, LambdaCheckout, LambdaObservation } from './lambda/boot.js';
export { createSshTransport, type SshRunner } from './lambda/ssh-transport.js';
export { guestKeepaliveSeconds, guestSshPort, sessionPublicKey, type GuestExecRequest, type GuestExecResult, type GuestRefusal, type GuestTarget, type GuestTransport,
  type GuestUser, type LambdaChannel } from './lambda/transport.js';
export { installationResources, installationTagKey, operationPolicy, workTagKey, type PolicyStatement } from './lambda/installation.js';
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
import type { CheckoutFingerprint, PreservationObservation, ProposalIdentity } from '../contracts/index.js';
export type PreparedWork = PrepareResult | { status: 'success'; environment: EnvironmentRef; checkout: CheckoutView;
  seeds: { name: string; manifestSha256: string; reused: boolean; replaced?: string }[];
  /** Ticket 44: the environment base the root disk was copied from (declaration hash + resolved manifest). */
  base?: EnvironmentBaseIdentity };
import type { EnvironmentBaseIdentity } from '../contracts/index.js';
import type { AlpineRepositories, EnvironmentRequest, PreparationVm } from './environment-base.js';
// Ticket 44: environment bases (pure parts exported for the controller composition and tests; the VM runs only through the port).
export { environmentBaseKey, guestAlpine, parseResolvedManifest, preparationEgress, preparationScript, preparationTimeoutSeconds,
  type AlpineRepositories, type EnvironmentRequest, type PreparationVm, type PreparationVmInput, type PreparationVmResult } from './environment-base.js';
export { createPreparationVm, runEnvironmentPreparation } from './preparation-vm.js';
export type { GuestAssetPin } from './guest-assets.js';
import { currentBoot, observeEnvironment, type BootRef } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';
export type { BootRef, StartupFailure } from './lifecycle.js';
import type { Observation as LifecycleObservation } from './lifecycle.js';
import { observeStorage, type StorageObservation } from './storage-observation.js';
export type { StorageObservation } from './storage-observation.js';
export type Observation = LifecycleObservation & { storage?: StorageObservation;
  /** v2 ticket 04: what the adapter's service said about the boot, when the condition comes from a service (the Lambda adapter). */ lifecycle?: LambdaObservation['lifecycle'] };
import { startEnvironment, type DiskRemedy, type StartResult } from './start.js';
export type { DiskRemedy, StartRemedyOutcome, StartResult } from './start.js';
export type { GuestStop, GuestStopReason } from './guest-shutdown.js';
import { stopEnvironment, type StopResult } from './stop.js';
export type { StopResult } from './stop.js';
import { removeEnvironment } from './remove.js';
import { exportEvidence } from './evidence-export.js';
export type { EvidenceExport } from './evidence-export.js';
import type { EvidenceExport } from './evidence-export.js';
import type { RemoveResult } from './remove.js';
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
/** `preparationVm`/`alpine` (ticket 44): the port that runs environment preparation VMs (absent: a declared environment is refused, never
 * replaced by the generic guest) and the Alpine repositories of the release guest assets. */
/**
 * v2 ticket 15 (V2-33): the Operator's explicit cleanup of MicroVM images. Without `confirm` it only plans (reads); an image in use is
 * never deleted, and naming one is refused (`IMAGE_IN_USE`). `null`: the installation's adapter has no MicroVM images.
 */
export async function cleanupLambdaImages({ root, configuration, lambdaService = createLambdaCliService, image, confirm }: { root: string; configuration: unknown;
  lambdaService?: LambdaServiceFactory; image?: string | undefined; confirm: boolean }): Promise<ImageCleanupResult | null> {
  const selection = selectSandboxAdapter(configuration);
  if (selection.status !== 'selected' || selection.adapter !== 'lambda') return null;
  const profile = selection.configuration;
  return cleanupInstallationImages({ root, service: lambdaService({ awsProfile: profile.awsProfile, region: profile.region }), profile, image, confirm });
}

/**
 * v2 ticket 15 (V2-33): the adapter's part of the controller start, for the process that has just taken exclusive ownership of the
 * installation and has started no boot yet. Under the Lambda adapter it inventories the account by the installation tag, ends the
 * MicroVMs no boot record holds and lists the ones a record still holds for Control to settle. Another adapter has no account:
 * `not-applicable`. `unavailable` means the inventory is UNKNOWN (never empty).
 */
export async function reconcileLambdaRuntime({ root, configuration, lambdaService = createLambdaCliService, lambdaBootClock = defaultLambdaBootClock }: { root: string; configuration: unknown;
  lambdaService?: LambdaServiceFactory; lambdaBootClock?: LambdaBootClock }): Promise<LambdaRuntimeReconciliation | { status: 'not-applicable' }> {
  const selection = selectSandboxAdapter(configuration);
  if (selection.status !== 'selected' || selection.adapter !== 'lambda') return { status: 'not-applicable' };
  try { return await reconcileLambdaInstallation({ root, service: lambdaService, clock: lambdaBootClock }, selection.configuration); }
  catch { return { status: 'unavailable', code: 'MICROVM_INVENTORY_UNAVAILABLE', detail: 'the inventory could not be completed or recorded' }; }
}

/** `lambdaService` (v2 ticket 02): how the Lambda adapter reaches the AWS account; the `aws` CLI with the configured profile name by default. */
export function createSandbox({ root, guestAssets, toolEndpoint, repositoryFetch, remoteUrl, artifactSeeds = [], preparationVm, alpine, lambdaService = createLambdaCliService, lambdaImageWait,
  lambdaTransport, lambdaBootClock = defaultLambdaBootClock, lambdaObservationTimer, lambdaBootOwner = false, lambdaWorkerLauncher }: { root: string; guestAssets?: GuestAssetPin; toolEndpoint?: string;
  repositoryFetch?: RepositoryFetchCredentials; remoteUrl?: (scope: { repository: string }) => string; artifactSeeds?: readonly ArtifactSeed[];
  preparationVm?: PreparationVm; alpine?: AlpineRepositories; lambdaService?: LambdaServiceFactory;
  /** v2 ticket 03: how Prepare waits for a MicroVM image build (tests inject a fake clock). */ lambdaImageWait?: LambdaImageWait;
  /** v2 ticket 04: the transport to the guest (SSH over WebSocket with the host's `ssh` and `websocat` by default) and the clock of the boot waits. */
  lambdaTransport?: GuestTransport; lambdaBootClock?: LambdaBootClock;
  /** v2 ticket 10: how the watch of a Lambda boot's environment waits between observations (tests move it by hand). */
  lambdaObservationTimer?: LambdaObservationTimer;
  /** v2 ticket 06: THIS process is the one that launches the workers of the boots it starts (the controller owner): each started Lambda boot
   * gets its boot owner here (owner endpoint, tool bindings, worker processes), closed by `stop`. Absent: boots are started without one. */
  lambdaBootOwner?: boolean;
  /** v2 ticket 06: how a worker process is launched under a Lambda boot owner (the fixed worker executable by default; tests script it). */
  lambdaWorkerLauncher?: LambdaWorkerLauncher }) {
  const checkouts = repositoryFetch ? createCheckouts({ root, fetch: repositoryFetch, ...(remoteUrl ? { remoteUrl } : {}) }) : undefined;
  const projections = new Map<string, Promise<Awaited<ReturnType<typeof connectReadTools>>>>();
  const bindings = new Map<string, string>();
  const bootLedger = createBootLedger(async () => (await inspectMemory())?.availableBytes);
  let sshTransport: GuestTransport | undefined;
  const lambdaBoots = () => ({ root, service: lambdaService, transport: lambdaTransport ?? (sshTransport ??= createSshTransport()), clock: lambdaBootClock,
    ...(lambdaObservationTimer ? { observationTimer: lambdaObservationTimer } : {}) });
  // v2 ticket 06: the boot owners THIS process serves (owner endpoint, tool bindings and workers of each active Lambda boot).
  const lambdaOwners = new Map<string, { close(): Promise<void>; ended: Promise<LambdaEnvironmentEnd> }>();
  /** One fixed observation program over the channel of the environment's CURRENT boot (decisions 1A and 2b-A): guest-attested. */
  const onCurrentBoot = async <T>(environment: EnvironmentRef, unavailable: T, read: (channel: Awaited<ReturnType<typeof openLambdaBootChannel>> & { status: 'open' }) => Promise<T>): Promise<T> => {
    try {
      const boot = await currentLambdaBoot(root, environment);
      const opened = boot ? await openLambdaBootChannel(lambdaBoots(), { environment, boot }) : null;
      if (!opened || opened.status !== 'open') return unavailable;
      try { return await read(opened); } finally { opened.channel.close(); }
    } catch { return unavailable; }
  };
  return {
    /**
     * v2 ticket 06: where the workers of a boot connect (the boot owner's private endpoint). A Lambda boot's owner lives in this process;
     * a Gondolin boot's owner is its own supervised process.
     */
    async workerOwnerEndpoint(context: WorkerLaunch['context']): Promise<string> {
      return await isLambdaEnvironment(root, context.environmentRef as EnvironmentRef) ? lambdaOwnerEndpoint(root, context) : workerOwnerEndpoint(root, context);
    },
    /** v2 ticket 04: the boots recorded for a Lambda environment (identity, reasons, size, start and end) and one of them; read-only. */
    async boots({ environment }: { environment: EnvironmentRef }) { return listLambdaBoots(root, environment); },
    async bootRecord({ environment, boot }: { environment: EnvironmentRef; boot: BootRef }) { return readLambdaBoot(root, environment, boot); },
    /**
     * v2 ticket 14 (V2-32): what the boots of one environment consumed, in adapter-neutral terms (seconds, size label, reasons), read from
     * the host records of every boot of the Work. An environment whose adapter does not measure boots is `unavailable`, never empty.
     */
    async usage({ environment }: { environment: EnvironmentRef }): Promise<BootUsageReport> { return lambdaEnvironmentUsage(root, environment); },
    /** v2 ticket 14 (V2-32): builds of the environment base per environment key, as this installation recorded them. */
    async environmentBuilds(): Promise<EnvironmentBuildReport> { return lambdaImageBuilds(root); },
    /** v2 ticket 04: the channel to an active Lambda boot, for trusted host composition only (tool calls bind a role on top of it, ticket 05). */
    async openChannel({ environment, boot }: { environment: EnvironmentRef; boot: BootRef }) { return openLambdaBootChannel(lambdaBoots(), { environment, boot }); },
    /**
     * v2 ticket 05 (V2-02 Executar ferramenta): the tool owner of an active Lambda boot, for the trusted host process that launches its
     * workers. `tools.bind` binds one invocation to its role on the boot and serves the unchanged worker tool endpoint; reviewers get
     * `read` only and run in the guest as the read-only `reviewer` user.
     */
    async serveTools({ environment, boot, environmentEnded }: { environment: EnvironmentRef; boot: BootRef;
      /** v2 ticket 10 (V2-15): told once when the service confirmed the end of the environment this owner watches. */ environmentEnded?: (observed: LambdaEnvironmentEnd) => void }) {
      return serveLambdaTools(lambdaBoots(), { environment, boot }, environmentEnded ? { environmentEnded } : {});
    },
    /**
     * v2 ticket 10 (V2-15): resolves when the adapter CONFIRMED, through the service, that the environment of this boot ended on its own;
     * `null` once `signal` aborts. Only the boot owner of this process watches, at the interval of the adapter's profile (never given to
     * the caller); a boot without an owner here never resolves.
     */
    awaitEnvironmentEnd({ environment, boot, signal }: { environment: EnvironmentRef; boot: BootRef; signal: AbortSignal }): Promise<LambdaEnvironmentEnd | null> {
      const owner = lambdaOwners.get(`${environment}/${boot}`);
      return new Promise(resolve => {
        if (signal.aborted) { resolve(null); return; }
        signal.addEventListener('abort', () => resolve(null), { once: true });
        void owner?.ended.then(resolve);
      });
    },
    /**
     * v2 ticket 11 (V2-21): what a dropped tool channel left unconfirmed on one boot, read from the boot's host record by any process:
     * the calls that started and whose result never arrived, and whether reconnection reached its limit. Empty for a boot without such
     * a record (every boot of an adapter that does not declare `channelRecovery`).
     */
    async channelReport({ environment, boot }: { environment: EnvironmentRef; boot: BootRef }): Promise<ChannelReport> { return readLambdaChannelReport(root, environment, boot); },
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
      // v2 ticket 06 (decision 1A): without a host workspace the identity is computed IN the guest by a fixed host-run program.
      if (await isLambdaEnvironment(root, environment)) return onCurrentBoot<ProposalIdentity>(environment, { status: 'unavailable', code: 'PROPOSAL_IDENTITY_UNAVAILABLE' },
        opened => observeLambdaProposal(opened.channel, round));
      return observeProposal(join(await realpath(root), 'environments', environment), round);
    },
    /**
     * v2 ticket 07 (V2-06): what the preservation gate observes IN the guest of a Lambda boot, by a fixed host-run program: tracked
     * changes, untracked files that are not ignored, stash, HEAD, and the Work branch tip `ls-remote` returns for the repository URL the
     * HOST names. `ls-remote` uses the host's one-fetch reduced credential (Contents:read), delivered as process environment of that
     * one `git` and revoked right after. Guest-attested: the caller confirms the tip with its own read of `origin`. An environment of
     * another adapter keeps its disk and has no gate.
     */
    async preservationGate({ environment, boot, repository, installationId, branch }: { environment: EnvironmentRef; boot: BootRef; repository: string; installationId: number; branch: string }): Promise<PreservationObservation> {
      if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'unavailable', code: 'ENVIRONMENT_REF_INVALID' };
      if (!await isLambdaEnvironment(root, environment)) return { status: 'unavailable', code: 'PRESERVATION_GATE_NOT_APPLICABLE' };
      if (!repositoryFetch) return { status: 'unavailable', code: 'CHECKOUT_NOT_COMPOSED' };
      let credential: { readonly token: string };
      try { credential = await repositoryFetch.fetch({ repository, installationId, workflows: false }); }
      catch { return { status: 'unavailable', code: 'CHECKOUT_CREDENTIAL_UNAVAILABLE' }; }
      try {
        const opened = await openLambdaBootChannel(lambdaBoots(), { environment, boot });
        if (opened.status !== 'open') return { status: 'unavailable', code: 'PRESERVATION_CHANNEL_UNAVAILABLE' };
        try { return await observeLambdaPreservation(opened.channel, { remote: (remoteUrl ?? ((scope: { repository: string }) => `https://github.com/${scope.repository}.git`))({ repository }), branch, token: credential.token }); }
        finally { opened.channel.close(); }
      } catch { return { status: 'unavailable', code: 'PRESERVATION_OBSERVATION_FAILED' }; }
      finally { await repositoryFetch.revoke(credential).catch(() => {}); }
    },
    /** Ticket 48: Host fingerprint of the Work's checkout (confined Git metadata reads + bounded no-follow tree walk; no host git, no guest command). */
    async observeCheckout({ environment }: { environment: EnvironmentRef }): Promise<CheckoutFingerprint> {
      if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'unavailable', code: 'ENVIRONMENT_REF_INVALID' };
      // v2 ticket 06 (decisions 2a/2d): there is no host checkout to fingerprint; progress is the Work branch on `origin` (Control's read).
      if (await isLambdaEnvironment(root, environment)) return { status: 'unavailable', code: 'CHECKOUT_NOT_ON_HOST' };
      return fingerprintCheckout(join(await realpath(root), 'environments', environment));
    },
    /**
     * Ticket 13 (review fix 3): Host confirmation of a preserved-source authorization. Confined, no-follow reads only: the referenced
     * file must exist under /artifacts/<kind>/<version>/ AND be listed in that version's sources.json. Control never trusts a path prefix.
     */
    async verifyPreservedSource({ environment, reference }: { environment: EnvironmentRef; reference: string }) {
      if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'invalid' as const, code: 'ENVIRONMENT_REF_INVALID' };
      // v2 ticket 06 (decision 2b-A): the same two facts, read over the channel while the boot lives.
      if (await isLambdaEnvironment(root, environment)) return onCurrentBoot<{ status: 'verified' | 'invalid'; code: string }>(environment,
        { status: 'invalid', code: 'PRESERVED_SOURCE_UNAVAILABLE' }, opened => verifyLambdaPreservedSource(opened.channel, reference));
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
    async exportEvidence({ environment, destination }: { environment: EnvironmentRef; destination: string }): Promise<EvidenceExport> {
      // v2 ticket 06 (decision 2c): a Lambda environment's evidence was collected before each boot stopped; nothing is left to export.
      if (await isLambdaEnvironment(root, environment)) return { status: 'absent' };
      return exportEvidence(root, environment, destination);
    },
    async remove({ environment, cleanup }: { environment: EnvironmentRef; cleanup: unknown }): Promise<RemoveResult> {
      if (await isLambdaEnvironment(root, environment)) {
        for (const [key, owner] of lambdaOwners) if (key.startsWith(`${environment}/`)) { lambdaOwners.delete(key); await owner.close().catch(() => {}); }
        try { return await removeLambdaEnvironment(lambdaBoots(), { environment, cleanup }); }
        catch { return { status: 'indeterminate', code: 'REMOVE_UNAVAILABLE', resources: [] }; }
      }
      return removeEnvironment(root, environment, cleanup);
    },
    async stop({ environment, boot, reason }: { environment: EnvironmentRef; boot: BootRef; reason: string }): Promise<StopResult> {
      // v2 ticket 04 (V2-02 Parar): a Lambda boot is ended by the service and confirmed by it; no disk is kept.
      if (await isLambdaEnvironment(root, environment)) {
        // v2 ticket 06: the boot owner of this process ends first (bindings, workers, channel); the stop then collects over its own connection.
        const owner = lambdaOwners.get(`${environment}/${boot}`);
        lambdaOwners.delete(`${environment}/${boot}`);
        await owner?.close().catch(() => {});
        try { return await stopLambdaBoot(lambdaBoots(), { environment, boot, reason }); }
        catch { return { status: 'indeterminate', code: 'STOP_UNAVAILABLE', cessationConfirmed: false }; }
      }
      return stopEnvironment(root, environment, boot, reason);
    },
    /** `pass`: the dispatch pass that reserved this boot (ticket 24; correlation only). The memory precondition counts every other own
     * boot still launching, whatever its pass; this boot leaves that set when its start returns. */
    /** `diskRemedy` (ticket 47): the operator's explicit decision for a preserved disk that fails its check, applied by this start only. */
    /** `checkout`/`reason` (v2 ticket 04): under the Lambda adapter the starting commit is cloned from `origin` INSIDE the guest with the
     * given in-memory credential, and the boot is recorded as a first start or a planned swap. The Gondolin adapter ignores both. */
    async start({ environment, configuration, diskRemedy, checkout, reason }: { environment: EnvironmentRef; configuration: unknown; pass?: string; diskRemedy?: DiskRemedy;
      checkout?: Omit<LambdaCheckout, 'credential'> & { credential?: LambdaCheckout['credential']; installationId?: number }; reason?: BootBeginReason }): Promise<StartResult> {
      const selection = selectSandboxAdapter(configuration);
      if (selection.adapter === 'lambda') {
        if (selection.status !== 'selected') return { status: 'failure', code: selection.errors[0]?.code ?? 'SANDBOX_CONFIGURATION_INVALID' };
        // v2 ticket 06 (V2-24): without a credential given, the clone uses the host's one-fetch reduced credential (Contents:read), delivered
        // as process environment of that one `git` in the guest and revoked right after (one attempt), never kept anywhere.
        let fetched: { readonly token: string } | null = null;
        if (checkout && !checkout.credential) {
          if (!repositoryFetch || checkout.installationId === undefined) return { status: 'failure', code: 'CHECKOUT_NOT_COMPOSED' };
          try { fetched = await repositoryFetch.fetch({ repository: checkout.repository, installationId: checkout.installationId, workflows: false }); }
          catch { return { status: 'failure', code: 'CHECKOUT_CREDENTIAL_UNAVAILABLE' }; }
        }
        let started: Awaited<ReturnType<typeof startLambdaBoot>>;
        try {
          const credential = checkout?.credential ?? fetched;
          started = await startLambdaBoot(lambdaBoots(), { environment, profile: selection.configuration, seeds: artifactSeeds,
            ...(checkout && credential ? { checkout: { repository: checkout.repository, commit: checkout.commit, ...(checkout.branch === undefined ? {} : { branch: checkout.branch }), credential } } : {}),
            ...(reason ? { reason } : {}), remoteUrl: remoteUrl ?? (scope => `https://github.com/${scope.repository}.git`) });
        } catch { return { status: 'indeterminate', code: 'START_UNAVAILABLE' }; }
        finally { if (fetched) await repositoryFetch!.revoke(fetched).catch(() => {}); }
        if (started.status !== 'success' || !lambdaBootOwner) return started;
        // The boot is usable only with its owner: the endpoint the workers of this boot connect to, served by this process.
        const owner = await serveLambdaOwner({ ...lambdaBoots(), ...(lambdaWorkerLauncher ? { launcher: lambdaWorkerLauncher } : {}) }, { environment, boot: started.boot })
          .catch(() => ({ status: 'unavailable' as const, code: 'BOOT_OWNER_UNAVAILABLE' }));
        if (owner.status !== 'serving') {
          const stopped = await stopLambdaBoot(lambdaBoots(), { environment, boot: started.boot, reason: 'end' }).catch(() => null);
          return stopped?.cessationConfirmed ? { status: 'failure', code: owner.code, boot: started.boot } : { status: 'indeterminate', code: 'CESSATION_NOT_CONFIRMED', boot: started.boot, detail: owner.code };
        }
        lambdaOwners.set(`${environment}/${started.boot}`, owner);
        return started;
      }
      const parsed = validateConfiguration(configuration);
      if (!parsed.valid) return { status: 'failure', code: parsed.errors[0]?.code ?? 'SANDBOX_CONFIGURATION_INVALID' };
      let release: (() => void) | null = null;
      try {
        return await startEnvironment(root, guestAssets, environment, parsed.effective, async () => (release = await bootLedger.admit(parsed.effective)) !== null,
          diskRemedy === 'repair-disk' || diskRemedy === 'replace-disk' ? diskRemedy : undefined);
      } finally { (release as (() => void) | null)?.(); }
    },
    async observe({ environment, boot }: { environment: EnvironmentRef; boot?: BootRef }): Promise<Observation> {
      // v2 ticket 04 (V2-02 Observar): the condition of a Lambda boot is the service's own answer, read by any process from the boot's record.
      if (await isLambdaEnvironment(root, environment)) {
        try { return await observeLambdaBoot(lambdaBoots(), { environment, ...(boot === undefined ? {} : { boot }) }); }
        catch { return { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable' }; }
      }
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
    /** `environment`/`retryEnvironmentBase` (ticket 44): the Work's pinned declaration and the operator's retry of a failed base preparation. */
    async prepare({ workId, configuration, checkout, recreateSeeds, environment, retryEnvironmentBase }: { workId: string; configuration: unknown; checkout?: CheckoutRequest;
      recreateSeeds?: readonly string[]; environment?: EnvironmentRequest; retryEnvironmentBase?: boolean }): Promise<PreparedWork> {
      // v2 ticket 03 (V2-02 Preparar): under the Lambda adapter Prepare guarantees the MicroVM image of the environment key. There is no host
      // checkout, disk or artifact seed (the clone happens in the guest at start, ticket 04): the result carries the environment and its base.
      const selection = selectSandboxAdapter(configuration);
      if (selection.status === 'selected' && selection.adapter === 'lambda') {
        const profile = selection.configuration;
        try {
          return await prepareLambdaImage({ root, workId, profile, environment, retry: retryEnvironmentBase,
            service: lambdaService({ awsProfile: profile.awsProfile, region: profile.region }), wait: lambdaImageWait, now: lambdaBootClock.now });
        } catch { return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_UNAVAILABLE' }; }
      }
      const parsed = validateConfiguration(configuration);
      if (!parsed.valid) return { status: 'failure', code: parsed.errors[0]?.code ?? 'SANDBOX_CONFIGURATION_INVALID' };
      let prepared: PrepareResult;
      try { prepared = await prepareEnvironment(root, guestAssets, workId, parsed.effective, { environment, retryEnvironmentBase, vm: preparationVm, alpine }); }
      catch { return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_UNAVAILABLE' }; }
      if (prepared.status !== 'success' || !checkout) return prepared;
      if (!checkouts) return { status: 'failure', code: 'CHECKOUT_NOT_COMPOSED' };
      const directory = join(await realpath(root), 'environments', prepared.environment);
      const result = await checkouts.prepare(directory, checkout);
      if (result.status !== 'success') return result;
      const seeds = await seedArtifacts(join(directory, 'artifacts'), artifactSeeds, recreateSeeds?.length ? { recreate: recreateSeeds } : {});
      if (seeds.status !== 'success') return seeds;
      return { status: 'success', environment: prepared.environment, checkout: result.checkout, seeds: seeds.seeds, ...(prepared.base ? { base: prepared.base } : {}) };
    },
    /** `concurrency` (V2-30): the installation's Builder concurrency, for the adapter's own capacity diagnostic. */
    async validate(configuration: unknown, { concurrency }: { concurrency?: number } = {}) {
      const selection = selectSandboxAdapter(configuration);
      // v2 ticket 02 (V2-02 Validar): a Lambda installation is diagnosed against its AWS account, never against this host's QEMU/KVM. An
      // invalid profile names no account, so nothing is contacted. Nothing is created or started.
      if (selection.adapter === 'lambda') {
        if (selection.status !== 'selected') return { configuration: { valid: false as const, errors: selection.errors }, checks: [] as Diagnostic[], versions: {} as Record<string, string | null> };
        const profile = selection.configuration;
        return { configuration: { valid: true as const, effective: profile }, versions: {} as Record<string, string | null>, checks: [
          ...await validateLambdaInstallation({ profile, concurrency, service: lambdaService({ awsProfile: profile.awsProfile, region: profile.region }) })] };
      }
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
