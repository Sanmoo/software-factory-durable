import { createHash } from 'node:crypto';
import type { AccessDependencies, ConfiguredRepository, DetailPorts, ExecutionPorts } from '../../control/index.js';
import { createIssueTracker } from '../../issue-tracker/index.js';
import { createCodeRepository } from '../../code-repository/index.js';
import { createSandbox, type GuestAssetPin } from '../../sandbox/index.js';
import { realpath } from 'node:fs/promises';
import { listDetails, preserveEvidence, preserveSessionCopy, removeRecordsDetail } from '../../records/index.js';
import { readSessionFile } from '../../platform/host/index.js';
import { createWorkers, skillPackContinues, skillPacks, type SkillPackId } from '../../workers/index.js';
import { createBuilderCredentials, createRepositoryFetchCredentials, type GitHubAccess } from '../../platform/github/index.js';
import { factorySkillPackIds, type GitHubScope } from '../../contracts/index.js';
import { latestContinuationPack, productionBuilderPrompt, productionProfile } from '../release.js';

export { latestContinuationPack };

type Role = 'builder' | 'standards' | 'spec';
export type ProductionInput = {
  root: string;
  /** Validated effective configuration (subset used here); sandbox stays opaque, interpreted by the Sandbox only. */
  effective: { models: Record<Role, { provider: string; model: string }>; repositories: readonly GitHubScope[]; concurrency: number; sandbox: unknown;
    /** Ticket 30: configuration `retentionDays` (default 30). */
    retentionDays?: number };
  /** Guest asset pin of the VERIFIED running release (trusted composition data, never YAML). */
  guestAssets: GuestAssetPin;
  github: GitHubAccess;
};

/**
 * Production composition of Control's GitHub access (the owner's tracking/admission, questions, publication discovery, checks, readiness,
 * delivery and branch cleanup): executable repositories are Ticket origins; dependency-only repositories are read solely for native
 * blocked_by, with their own installation; operators answer Questions; the Factory App bot identity is resolved lazily (ticket 14), never
 * configured. One function for the controller owner, the composed journey test and the ticket 18 recipe (no per-ticket wiring).
 */
export function composeProductionAccess(input: { github: GitHubAccess; effective: { repositories: ConfiguredRepository[];
  dependencyRepositories: readonly { repository: string; installationId: number }[]; operators: (string | { login: string; id?: number })[] } }): AccessDependencies {
  const { github, effective } = input;
  const dependencyScopes = effective.dependencyRepositories.map(entry => ({ repository: entry.repository, installationId: entry.installationId, workflows: false }));
  return { tracker: createIssueTracker({ github, scopes: effective.repositories, dependencyScopes }), repository: createCodeRepository({ github }),
    repositories: effective.repositories, dependencyRepositories: dependencyScopes, operators: effective.operators,
    factoryApp: async () => effective.repositories[0] ? github.appIdentity(effective.repositories[0]) : null };
}

/**
 * Ticket 30: the Work details over the installation's Records area (host-only, never mounted): inventory, preservation of a recorded Builder
 * session out of its runtime tree (confined no-follow read, verified against the recorded hash) and confined removal of one detail.
 */
export function detailPorts(root: string): DetailPorts {
  return {
    list: ({ workId }) => listDetails(root, workId),
    async preserveSession({ workId, executionId, session }) {
      const read = await readSessionFile(await realpath(root), session.ref);
      if (read.state === 'lost') return { status: 'lost', code: read.code };
      if (read.state !== 'read') return { status: 'failed', code: read.code };
      if (read.sha256 !== session.sha256) return { status: 'failed', code: 'SESSION_ALTERED' };
      return preserveSessionCopy(root, workId, executionId, read.data, read.sha256);
    },
    remove: ({ workId, item, expectedSha256 }) => removeRecordsDetail(root, workId, item, expectedSha256),
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
  { status: 'composed'; ports: ExecutionPorts; summary: { guestAssets: GuestAssetPin; artifactSeeds: string[];
    profiles: Record<Role, { id: string; auth: string; providerId: string; modelId: string; api: string; systemPromptSha256: string }> } } |
  { status: 'refused'; code: 'WORKER_PROFILE_UNSUPPORTED'; roles: Role[] }> {
  const roles = ['builder', 'standards', 'spec'] as const;
  const unsupported = roles.filter(role => input.effective.models[role].provider !== productionProfile.model.providerId ||
    input.effective.models[role].model !== productionProfile.model.modelId);
  if (unsupported.length > 0) return { status: 'refused', code: 'WORKER_PROFILE_UNSUPPORTED', roles: unsupported };
  const profile = (role: Role) => ({ id: productionProfile.sdkProfileId, systemPrompt: productionProfile.prompts[role],
    auth: productionProfile.model.auth, providerId: productionProfile.model.providerId, modelId: productionProfile.model.modelId, api: productionProfile.model.api });
  const profiles = { builder: profile('builder'), standards: profile('standards'), spec: profile('spec') };
  const skillPack = await productionSkillPack();
  const pack = skillPacks[skillPack];
  const sandbox = createSandbox({ root: input.root, guestAssets: input.guestAssets,
    repositoryFetch: createRepositoryFetchCredentials({ github: input.github, repositories: input.effective.repositories }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }] });
  // Ticket 18: the Builder's system prompt is chosen per session mode, naming only the tools of that session.
  const workers = createWorkers({ root: input.root, knownSecrets: [], profile: profiles.builder, profiles, builderPrompt: productionBuilderPrompt });
  const ports: ExecutionPorts = {
    sandbox: { prepare: input => sandbox.prepare(input), start: input => sandbox.start(input), stop: input => sandbox.stop(input),
      observeProposal: input => sandbox.observeProposal(input),
      // Ticket 13: confined Host confirmation of preserved-source authorizations (absent = none would ever correlate).
      verifyPreservedSource: input => sandbox.verifyPreservedSource(input),
      // Ticket 26: host observation (works without the old Gondolin owner) for boot reconciliation of survivors.
      observe: input => sandbox.observe(input) },
    workers: { activate: (invocation, delivery, events) => workers.activate(invocation, delivery, events), deliver: (worker, directive) => workers.deliver(worker, directive),
      observe: input => workers.observe(input),
      // Ticket 26: protected start receipt of an invocation, discovered without its notification.
      observeStart: input => workers.observeStart(input),
      // Ticket 28: a reviewer's complete opinion record located without its notification (partial review recovery).
      observeOpinion: input => workers.observeOpinion(input) },
    // Ticket 13: multi-round reviews (treatments, Host-evidenced gates, end-of-Execution verification) with the release's bound.
    // Ticket 28: partial review recovery (only the failed reviewer re-obtained on the unchanged proposal; lost notifications from Records).
    reviews: { reviewer: { ...productionProfile.reviewer }, rounds: { ...productionProfile.reviewRounds }, partialRecovery: true },
    credentials: createBuilderCredentials({ github: input.github, repositories: input.effective.repositories }),
    configuration: input.effective.sandbox,
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
        const result = await preserveEvidence({ root: input.root, workId, label: environment, stage: async destination => {
          const exported = await sandbox.exportEvidence({ environment, destination });
          if (exported.status === 'absent') absent = true;
          else if (exported.status === 'failure') throw new Error(exported.code);
        } });
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
  return { status: 'composed', ports, summary: { guestAssets: input.guestAssets, artifactSeeds: [pack.seedName],
    profiles: Object.fromEntries(roles.map(role => { const { systemPrompt, ...rest } = profiles[role]; return [role, { ...rest, systemPromptSha256: sha(systemPrompt) }]; })) as
      Record<Role, { id: string; auth: string; providerId: string; modelId: string; api: string; systemPromptSha256: string }> } };
}
