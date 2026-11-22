import { createHash } from 'node:crypto';
import type { AccessDependencies, ConfiguredRepository, DetailPorts, ExecutionPorts, RuntimeInventory, TicketSource } from '../../control/index.js';
import {
  createIssueTracker,
  createJiraHttpTransport,
  createJiraTracker,
  type JiraHostSite,
  type JiraHttpExchange,
  type JiraHttpResult,
  type JiraTransport,
} from '../../issue-tracker/index.js';
import type { TicketSourceConfiguration } from '../configuration.js';
import { readJiraToken } from './jira-credential.js';
import { createCodeRepository } from '../../code-repository/index.js';
import {
  createPreparationVm,
  createSandbox,
  inventoryRuntime,
  reconcileInterruptedCaches,
  reconcileLambdaRuntime,
  selectSandboxAdapter,
  type GuestAssetPin,
  type GuestTransport,
  type LambdaBootClock,
  type LambdaImageWait,
  type LambdaServiceFactory,
  type LambdaObservationTimer,
  type LambdaWorkerLauncher,
} from '../../sandbox/index.js';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  forgetWorkRecords,
  inspectWorkRecords,
  listDetails,
  createRecords,
  preserveEvidence,
  preserveSessionCopy,
  removeRecordsDetail,
} from '../../records/index.js';
import { readConfinedFile, readSessionFile, sessionRefOfInvocation, workerRuntimeDirectory } from '../../platform/host/index.js';
import { createWorkers, skillPackContinues, skillPacks, type SkillPackId } from '../../workers/index.js';
import { createBuilderCredentials, createRepositoryFetchCredentials, type GitHubAccess } from '../../platform/github/index.js';
import { factorySkillPackIds, type GitHubScope } from '../../contracts/index.js';
import { latestContinuationPack, productionBuilderPrompt, productionProfile } from '../release.js';

export { latestContinuationPack };

/** Ticket 29: the read-only Records facets inspection uses, over the installation's protected Records root (no secret is registered: read only). */
export function inspectionRecords(root: string): NonNullable<ExecutionPorts['records']> {
  let opened: ReturnType<typeof createRecords> | undefined;
  const records = async () => {
    opened ??= createRecords({ root });
    try {
      return await opened;
    } catch (error) {
      opened = undefined;
      throw error;
    }
  };
  return {
    async find(selection) {
      return (await records()).find(selection);
    },
    async read(input) {
      return (await records()).read(input);
    },
  };
}

type Role = 'builder' | 'standards' | 'spec';
export type ProductionInput = {
  root: string;
  /** Validated effective configuration (subset used here); sandbox stays opaque, interpreted by the Sandbox only. */
  effective: {
    models: Record<Role, { provider: string; model: string }>;
    repositories: readonly GitHubScope[];
    concurrency: number;
    sandbox: unknown;
    /** Ticket 30: configuration `retentionDays` (default 30). */
    retentionDays?: number;
  };
  /** Guest asset pin of the VERIFIED running release (trusted composition data, never YAML). */
  guestAssets: GuestAssetPin;
  github: GitHubAccess;
  /**
   * v2 ticket 06: what stands UNDER the Lambda adapter (the AWS account, the transport to the guest, the clocks of its waits and the worker
   * process launch). Production passes none: the `aws` CLI, the host's `ssh`/`websocat`, the wall clock and the fixed worker executable.
   * The composed journey test passes the in-memory account and guest; nothing else of the composition changes.
   */
  lambda?: {
    service?: LambdaServiceFactory;
    transport?: GuestTransport;
    clock?: LambdaBootClock;
    imageWait?: LambdaImageWait;
    workerLauncher?: LambdaWorkerLauncher;
    /** v2 ticket 10: how the watch of a boot's environment waits between observations (tests move it by hand). */ observationTimer?: LambdaObservationTimer;
  };
};

/**
 * The runtime inventory the controller owner takes after the exclusive lock and BEFORE the storage opens (ticket 26, spec §5.2 boot step
 * 3): the host's own runtime resources, attributed and never ignored, with the repair-free reconciliation of host Git caches a dead owner
 * left in preparation. v2 ticket 15 (V2-33): under the Lambda adapter the installation's MicroVMs come from the account, by the
 * installation tag (`reconcileLambdaRuntime`): what a boot record still holds is listed like any own environment, so Control stops the
 * survivors of Executions that are not alive; what the adapter could not end or attribute is an unknown resource. An account that could
 * not be listed makes the WHOLE inventory `unknown` (dispatch stays closed), never an empty one. One function for the controller owner
 * and the crash scenario test.
 */
export async function composeRuntimeInventory(input: {
  root: string;
  effective: { sandbox: unknown };
  lambda?: Pick<NonNullable<ProductionInput['lambda']>, 'service' | 'clock'>;
}): Promise<{ runtimeInventory: RuntimeInventory | 'unknown'; unavailable?: { code: string; detail: string } }> {
  const caches = await reconcileInterruptedCaches(input.root);
  const listed = await inventoryRuntime(input.root);
  const account = await reconcileLambdaRuntime({
    root: input.root,
    configuration: input.effective.sandbox,
    ...(input.lambda?.service ? { lambdaService: input.lambda.service } : {}),
    ...(input.lambda?.clock ? { lambdaBootClock: input.lambda.clock } : {}),
  });
  if (account.status === 'unavailable') return { runtimeInventory: 'unknown', unavailable: { code: account.code, detail: account.detail } };
  const own = account.status === 'reconciled' ? account : { environments: [], unknown: [] };
  return {
    runtimeInventory: {
      kind: 'listed',
      observedAt: new Date().toISOString(),
      environments: [...listed.environments, ...own.environments],
      cache: listed.cache.map(item => ({ ...item, nextStep: caches.find(entry => entry.repositoryId === item.repositoryId)?.nextStep ?? null })),
      unknown: [...listed.unknown, ...own.unknown],
    },
  };
}

/**
 * Production composition of Control's GitHub access (the owner's tracking/admission, questions, publication discovery, checks, readiness,
 * delivery and branch cleanup): executable repositories are Ticket origins; dependency-only repositories are read solely for native
 * blocked_by, with their own installation; operators answer Questions; the Factory App bot identity is resolved lazily (ticket 14), never
 * configured. One function for the controller owner, the composed journey test and the ticket 18 recipe (no per-ticket wiring).
 */
/** Host access of one configured Jira site, given to its transport only: the credential is read lazily from the installation root. */
export type JiraSiteAccess = JiraHostSite;
/**
 * Owner access: GitHub as before and, only when the v2 configuration names Jira sources, the Jira adapter beside it (selected by the
 * Ticket's persisted origin, never by its destination). `repositories` stay the executable destinations; `sources` the Ticket sources.
 * On YAML v1 no Jira client is created and no Jira credential is opened. Jira ticket 10: a Jira source's `discover` is composed as configured;
 * `discover: false` stops only NEW admissions of that source (the adapter stays composed, so existing Works keep their origin).
 */
export function composeProductionAccess(input: {
  github: GitHubAccess;
  root?: string;
  effective: {
    repositories: ConfiguredRepository[];
    dependencyRepositories: readonly { repository: string; installationId: number }[];
    operators: (string | { login: string; id?: number })[];
    ticketSources?: readonly TicketSourceConfiguration[];
  };
  /**
   * Production: the host HTTPS REST v3 transport of each Jira site (ticket 03). Tests substitute the whole transport, or only its raw
   * HTTPS exchange (`send`) to keep the production origin/auth/failure handling under test.
   */
  jira?: { transport?: (site: JiraSiteAccess) => JiraTransport; send?: (exchange: JiraHttpExchange) => Promise<JiraHttpResult> };
}): AccessDependencies {
  const { github, effective } = input;
  const dependencyScopes = effective.dependencyRepositories.map(entry => ({
    repository: entry.repository,
    installationId: entry.installationId,
    workflows: false,
  }));
  const configured =
    effective.ticketSources ?? effective.repositories.map(item => ({ tracker: 'github' as const, repository: item.repository, discover: true }));
  const sources: TicketSource[] = configured.map(source =>
    source.tracker === 'github'
      ? { tracker: 'github', repository: source.repository, discover: source.discover }
      : {
          tracker: 'jira',
          siteId: source.siteId,
          url: source.url,
          projectId: source.projectId,
          label: source.label,
          discover: source.discover,
          routes: source.routes.map(route => ({ componentId: route.componentId, repository: route.repository })),
          linkTypes: source.linkTypes.map(item => ({ id: item.id, blocks: item.blocks })),
        },
  );
  const jiraSources = configured.filter(source => source.tracker === 'jira');
  const root = input.root;
  const send = input.jira?.send;
  const transport = input.jira?.transport ?? ((site: JiraSiteAccess) => createJiraHttpTransport(site, send ? { send } : {}));
  const jira = jiraSources.length
    ? createJiraTracker({
        scopes: jiraSources.map(source => ({ tracker: 'jira', siteId: source.siteId, url: source.url, projectId: source.projectId, label: source.label })),
        transport: scope => {
          // One account per site (validated by the configuration): its first source names the e-mail and token file.
          const account = jiraSources.find(source => source.siteId === scope.siteId)!;
          return transport({
            siteId: scope.siteId,
            url: scope.url,
            email: account.email,
            credential: () => {
              if (root === undefined) return Promise.reject(new Error('JIRA_CREDENTIAL_ROOT_UNKNOWN'));
              return readJiraToken(root, account.tokenFile);
            },
          });
        },
      })
    : undefined;
  return {
    tracker: createIssueTracker({ github, scopes: effective.repositories, dependencyScopes }),
    repository: createCodeRepository({ github }),
    repositories: effective.repositories,
    dependencyRepositories: dependencyScopes,
    operators: effective.operators,
    sources,
    ...(jira ? { trackers: { jira } } : {}),
    factoryApp: async () => (effective.repositories[0] ? github.appIdentity(effective.repositories[0]) : null),
  };
}

/**
 * Ticket 30: the Work details over the installation's Records area (host-only, never mounted): inventory, preservation of a recorded Builder
 * session out of its runtime tree (confined no-follow read, verified against the recorded hash) and confined removal of one detail.
 */
export function detailPorts(root: string): DetailPorts {
  return {
    list: ({ workId }) => listDetails(root, workId),
    // Every agent session of one boot (Builder and reviewers): each file read confined (private dirs, no-follow, header) for its hash.
    async runtimeSessions({ boot }) {
      const canonical = await realpath(root);
      const runtime = workerRuntimeDirectory(canonical, boot);
      const workers = await readdir(runtime).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
      });
      const found: ({ ref: string; sha256: string; bytes: number } | { ref: string; code: string })[] = [];
      for (const worker of workers.filter(name => /^w-[A-Za-z0-9]{1,64}$/.test(name)).sort()) {
        const directory = join(runtime, worker, 'profile', 'sessions');
        if (
          !(await lstat(directory).then(
            () => true,
            () => false,
          ))
        )
          continue;
        for (const name of (await readdir(directory)).filter(file => file.endsWith('.jsonl')).sort()) {
          const ref = relative(canonical, join(directory, name));
          // Review LOW: an empty or non-session file is kept as an opaque, hashed byte copy (never interpreted, never blocking); only an unsafe
          // path/file (symlink, foreign, writable by others) is reported with its code and keeps the environment.
          const read = await readConfinedFile(canonical, ref, { allowEmpty: true });
          found.push(read.state === 'read' ? { ref, sha256: read.sha256, bytes: read.data.length } : { ref, code: read.code });
        }
      }
      return found;
    },
    // Finding A7: the session of an invocation whose boot was lost, found by the launch record of its worker directory (never guessed).
    async lostSession({ workId, boot, executionId, invocationId }) {
      const canonical = await realpath(root);
      const found = await sessionRefOfInvocation(canonical, workerRuntimeDirectory(canonical, boot), { workId, executionId, invocationId });
      if (found.state !== 'found') return null;
      const read = await readSessionFile(canonical, found.ref);
      return read.state === 'read' ? { ref: found.ref, sha256: read.sha256, bytes: read.data.length } : null;
    },
    async preserveSession({ workId, executionId, name, session }) {
      // The recorded Builder session must keep its header; another agent's session (named copy) is copied as opaque bytes at its hash.
      const read = name
        ? await readConfinedFile(await realpath(root), session.ref, { allowEmpty: true })
        : await readSessionFile(await realpath(root), session.ref);
      if (read.state === 'lost') return { status: 'lost', code: read.code };
      if (read.state !== 'read') return { status: 'failed', code: read.code };
      if (read.sha256 !== session.sha256) return { status: 'failed', code: 'SESSION_ALTERED' };
      return preserveSessionCopy(root, workId, name ?? executionId, read.data, read.sha256);
    },
    remove: ({ workId, item, expectedSha256 }) => removeRecordsDetail(root, workId, item, expectedSha256),
    // Ticket 31: the Work's whole Records area for `forget` (inspection, then fail-closed deletion).
    inspectTree: ({ workId }) => inspectWorkRecords(root, workId),
    forget: ({ workId }) => forgetWorkRecords(root, workId),
  };
}

/** Production Builder skill pack: the latest registered Factory pack able to continue a preserved session (spec §5.5), verified by its manifest. */
export function productionSkillPack(): Promise<SkillPackId> {
  return latestContinuationPack(factorySkillPackIds, skillPackContinues);
}

/**
 * Production composition of the execution ports (ticket 32; deferred to the release by tickets 09/10/12/20): the same public Sandbox,
 * Workers and Builder credential implementations the qualification recipes composed, with the release's single worker profile, the
 * latest registered skill pack with the continuation capability, session observation (ticket 11), parallel multi-round reviews (ticket 13), configured capacity/sandbox and the release's guest assets.
 * No broker, scheduler or registry: plain objects handed to `openControl`. A role whose configured provider/model is not exactly the
 * release profile refuses the whole composition (spec §6.1: explicit per role, no default or fallback, no partial application).
 */
export async function composeProductionExecution(input: ProductionInput): Promise<
  | {
      status: 'composed';
      ports: ExecutionPorts;
      summary: {
        guestAssets: GuestAssetPin;
        artifactSeeds: string[];
        profiles: Record<Role, { id: string; auth: string; providerId: string; modelId: string; api: string; systemPromptSha256: string }>;
      };
    }
  | { status: 'refused'; code: 'WORKER_PROFILE_UNSUPPORTED'; roles: Role[] }
  /** v2 ticket 01 (V2-01/V2-04): the sandbox section selects no adapter this release can compose (never replaced by another one). */
  | { status: 'refused'; code: 'SANDBOX_CONFIGURATION_INVALID'; roles: [] }
> {
  const roles = ['builder', 'standards', 'spec'] as const;
  const unsupported = roles.filter(
    role =>
      input.effective.models[role].provider !== productionProfile.model.providerId || input.effective.models[role].model !== productionProfile.model.modelId,
  );
  if (unsupported.length > 0) return { status: 'refused', code: 'WORKER_PROFILE_UNSUPPORTED', roles: unsupported };
  // v2 ticket 01 (V2-01/V2-03): the installation's ONE adapter, selected statically from the configuration, and the capabilities it declares.
  // Control receives the capabilities only; the lifecycle below is that adapter's.
  const adapter = selectSandboxAdapter(input.effective.sandbox);
  if (adapter.status !== 'selected') return { status: 'refused', code: adapter.errors[0]?.code ?? 'SANDBOX_CONFIGURATION_INVALID', roles: [] };
  // v2 ticket 06: the Lambda adapter is composed with its own lifecycle. Its profile stays inside the composition: Control receives the
  // declared capabilities and an opaque `configuration` that is null for it (the profile is given to the Sandbox here, never through Control).
  const lambda = adapter.adapter === 'lambda';
  const profile = (role: Role) => ({
    id: productionProfile.sdkProfileId,
    systemPrompt: productionProfile.prompts[role],
    auth: productionProfile.model.auth,
    providerId: productionProfile.model.providerId,
    modelId: productionProfile.model.modelId,
    api: productionProfile.model.api,
  });
  const profiles = { builder: profile('builder'), standards: profile('standards'), spec: profile('spec') };
  const skillPack = await productionSkillPack();
  const pack = skillPacks[skillPack];
  const sandbox = createSandbox({
    root: input.root,
    guestAssets: input.guestAssets,
    repositoryFetch: createRepositoryFetchCredentials({ github: input.github, repositories: input.effective.repositories }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }],
    // Ticket 44: environment bases are prepared in their own supervised preparation VM (transient unit), never in the controller process.
    preparationVm: createPreparationVm({ root: input.root }),
    // v2 ticket 06: this process launches the workers, so it hosts the owner of every Lambda boot it starts.
    lambdaBootOwner: true,
    ...(input.lambda?.service ? { lambdaService: input.lambda.service } : {}),
    ...(input.lambda?.transport ? { lambdaTransport: input.lambda.transport } : {}),
    ...(input.lambda?.clock ? { lambdaBootClock: input.lambda.clock } : {}),
    ...(input.lambda?.imageWait ? { lambdaImageWait: input.lambda.imageWait } : {}),
    ...(input.lambda?.workerLauncher ? { lambdaWorkerLauncher: input.lambda.workerLauncher } : {}),
    ...(input.lambda?.observationTimer ? { lambdaObservationTimer: input.lambda.observationTimer } : {}),
  });
  // The adapter's configuration as the Sandbox reads it: Control's opaque value for Gondolin (unchanged), the composition's own for Lambda.
  const configured = <T extends { configuration: unknown }>(request: T): T => (lambda ? { ...request, configuration: input.effective.sandbox } : request);
  // Ticket 18: the Builder's system prompt is chosen per session mode, naming only the tools of that session.
  const workers = createWorkers({
    root: input.root,
    knownSecrets: [],
    profile: profiles.builder,
    profiles,
    builderPrompt: productionBuilderPrompt,
    // v2 ticket 06: the owner of a boot is found by the Sandbox (a Lambda boot's owner is served by this process).
    ...(lambda ? { ownerEndpoint: context => sandbox.workerOwnerEndpoint(context) } : {}),
  });
  const ports: ExecutionPorts = {
    sandbox: {
      capabilities: adapter.capabilities,
      prepare: request => sandbox.prepare(configured(request)),
      start: request => sandbox.start(configured(request)),
      stop: input => sandbox.stop(input),
      observeProposal: input => sandbox.observeProposal(input),
      // Ticket 48: Host fingerprint of the checkout (start of the Execution / after a budget end): progress decides continuation vs recovery.
      observeCheckout: input => sandbox.observeCheckout(input),
      // Ticket 13: confined Host confirmation of preserved-source authorizations (absent = none would ever correlate).
      verifyPreservedSource: input => sandbox.verifyPreservedSource(input),
      // Ticket 26: host observation (works without the old Gondolin owner) for boot reconciliation of survivors.
      observe: input => sandbox.observe(input),
      // v2 ticket 07 (V2-06): the preservation gate's observation in the guest; Control asks it only of a sandbox without a persistent disk.
      preservationGate: input => sandbox.preservationGate(input),
      // v2 ticket 11 (V2-21): asked only of a sandbox that declares channel recovery; the boot's own host record answers.
      channelReport: input => sandbox.channelReport(input),
      // v2 ticket 10 (V2-15): the boot owner of this process watches the environment; Control only waits for its confirmed end.
      awaitEnvironmentEnd: input => sandbox.awaitEnvironmentEnd(input),
      // v2 ticket 09 (V2-13): asked only of a sandbox that declares a boot duration, with half its rotation margin left.
      interruptCalls: input => sandbox.interruptCalls(input),
      // v2 ticket 14 (V2-32): boot seconds and environment builds, reported by a sandbox whose boots are measured by its service. The
      // sandbox with a persistent disk has no such report, and its usage view stays as it was.
      ...(lambda ? { usage: input => sandbox.usage(input), environmentBuilds: () => sandbox.environmentBuilds() } : {}),
    },
    workers: {
      activate: (invocation, delivery, events) => workers.activate(invocation, delivery, events),
      deliver: (worker, directive) => workers.deliver(worker, directive),
      observe: input => workers.observe(input),
      // Ticket 26: protected start receipt of an invocation, discovered without its notification.
      observeStart: input => workers.observeStart(input),
      // Ticket 28: a reviewer's complete opinion record located without its notification (partial review recovery).
      observeOpinion: input => workers.observeOpinion(input),
      observeQuestion: input => workers.observeQuestion(input),

      // Ticket 29: model usage of preserved sessions, for `factory usage` (read-only).
      observeUsage: input => workers.observeUsage(input),
    },
    // Ticket 29: read-only `Records.read(selection)` of the protected Records for `factory logs` (opened lazily; a failed open is retried).
    records: inspectionRecords(input.root),
    // Ticket 13: multi-round reviews (treatments, Host-evidenced gates, end-of-Execution verification) with the release's bound.
    // Ticket 28: partial review recovery (only the failed reviewer re-obtained on the unchanged proposal; lost notifications from Records).
    reviews: { reviewer: { ...productionProfile.reviewer }, rounds: { ...productionProfile.reviewRounds }, partialRecovery: true },
    credentials: createBuilderCredentials({ github: input.github, repositories: input.effective.repositories }),
    configuration: lambda ? null : input.effective.sandbox,
    capacity: input.effective.concurrency,
    // No `deadlineMs` policy: the worker gets no clock from production (spec §4.4). `modelBudget` bounds requests/tools/bytes only.
    // Per-repository correction/recovery limits and the optional `timeoutSeconds` (ticket 19) reach Control with the configured repositories.
    builder: { ...productionProfile.builder, skillPack },
    // Ticket 17: after a confirmed delivery, Control removes only OWN environments (the Sandbox re-proves ownership and cessation) once
    // their review/request/instruction evidence is preserved in the protected records area (the installation root, never mounted).
    cleanup: {
      remove: input => sandbox.remove(input),
      async preserve({ workId, environment }) {
        let absent = false;
        const result = await preserveEvidence({
          root: input.root,
          workId,
          label: environment,
          stage: async destination => {
            const exported = await sandbox.exportEvidence({ environment, destination });
            if (exported.status === 'absent') absent = true;
            else if (exported.status === 'failure') throw new Error(exported.code);
          },
        });
        return absent && result.status === 'preserved' ? { status: 'absent' } : result;
      },
      retrySeconds: 86400,
      // Ticket 30: logs/sessions retention (boot sweep after reconciliation, then daily) and explicit cleanup over the Records area.
      details: detailPorts(input.root),
      retentionDays: input.effective.retentionDays ?? 30,
      sweepSeconds: 86400,
    },
  };
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  return {
    status: 'composed',
    ports,
    summary: {
      guestAssets: input.guestAssets,
      artifactSeeds: [pack.seedName],
      profiles: Object.fromEntries(
        roles.map(role => {
          const { systemPrompt, ...rest } = profiles[role];
          return [role, { ...rest, systemPromptSha256: sha(systemPrompt) }];
        }),
      ) as Record<Role, { id: string; auth: string; providerId: string; modelId: string; api: string; systemPromptSha256: string }>,
    },
  };
}
