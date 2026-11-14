import { createHash } from 'node:crypto';
import type { ExecutionPorts } from '../../control/index.js';
import { createSandbox, type GuestAssetPin } from '../../sandbox/index.js';
import { createWorkers, skillPackContinues, skillPacks, type SkillPackId } from '../../workers/index.js';
import { createBuilderCredentials, createRepositoryFetchCredentials, type GitHubAccess } from '../../platform/github/index.js';
import { factorySkillPackIds, type GitHubScope } from '../../contracts/index.js';
import { latestContinuationPack, productionProfile } from '../release.js';

export { latestContinuationPack };

type Role = 'builder' | 'standards' | 'spec';
export type ProductionInput = {
  root: string;
  /** Validated effective configuration (subset used here); sandbox stays opaque, interpreted by the Sandbox only. */
  effective: { models: Record<Role, { provider: string; model: string }>; repositories: readonly GitHubScope[]; concurrency: number; sandbox: unknown };
  /** Guest asset pin of the VERIFIED running release (trusted composition data, never YAML). */
  guestAssets: GuestAssetPin;
  github: GitHubAccess;
};

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
  const workers = createWorkers({ root: input.root, knownSecrets: [], profile: profiles.builder, profiles });
  const ports: ExecutionPorts = {
    sandbox: { prepare: input => sandbox.prepare(input), start: input => sandbox.start(input), stop: input => sandbox.stop(input),
      observeProposal: input => sandbox.observeProposal(input),
      // Ticket 13: confined Host confirmation of preserved-source authorizations (absent = none would ever correlate).
      verifyPreservedSource: input => sandbox.verifyPreservedSource(input) },
    workers: { activate: (invocation, delivery, events) => workers.activate(invocation, delivery, events), deliver: (worker, directive) => workers.deliver(worker, directive),
      observe: input => workers.observe(input) },
    // Ticket 13: multi-round reviews (treatments, Host-evidenced gates, end-of-Execution verification) with the release's bound.
    reviews: { reviewer: { ...productionProfile.reviewer }, rounds: { ...productionProfile.reviewRounds } },
    credentials: createBuilderCredentials({ github: input.github, repositories: input.effective.repositories }),
    configuration: input.effective.sandbox,
    capacity: input.effective.concurrency,
    // No `deadlineMs` policy: the worker gets no clock from production (spec §4.4). `modelBudget` bounds requests/tools/bytes only.
    // Per-repository correction/recovery limits and the optional `timeoutSeconds` (ticket 19) reach Control with the configured repositories.
    builder: { ...productionProfile.builder, skillPack },
  };
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  return { status: 'composed', ports, summary: { guestAssets: input.guestAssets, artifactSeeds: [pack.seedName],
    profiles: Object.fromEntries(roles.map(role => { const { systemPrompt, ...rest } = profiles[role]; return [role, { ...rest, systemPromptSha256: sha(systemPrompt) }]; })) as
      Record<Role, { id: string; auth: string; providerId: string; modelId: string; api: string; systemPromptSha256: string }> } };
}
