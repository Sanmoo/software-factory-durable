import { createHash } from 'node:crypto';
import type { ExecutionPorts } from '../../control/index.js';
import { createSandbox, type GuestAssetPin } from '../../sandbox/index.js';
import { createWorkers, skillPacks } from '../../workers/index.js';
import { createBuilderCredentials, createRepositoryFetchCredentials, type GitHubAccess } from '../../platform/github/index.js';
import type { GitHubScope } from '../../contracts/index.js';
import { productionProfile } from '../release.js';

type Role = 'builder' | 'standards' | 'spec';
export type ProductionInput = {
  root: string;
  /** Validated effective configuration (subset used here); sandbox stays opaque, interpreted by the Sandbox only. */
  effective: { models: Record<Role, { provider: string; model: string }>; repositories: readonly GitHubScope[]; concurrency: number; sandbox: unknown };
  /** Guest asset pin of the VERIFIED running release (trusted composition data, never YAML). */
  guestAssets: GuestAssetPin;
  github: GitHubAccess;
};

/**
 * Production composition of the execution ports (ticket 32; deferred to the release by tickets 09/10/12/20): the same public Sandbox,
 * Workers and Builder credential implementations the qualification recipes composed, with the release's single worker profile, the
 * Factory skill pack v3 (ask_user + review handoff), parallel reviews, configured capacity/sandbox and the release's guest assets.
 * No broker, scheduler or registry: plain objects handed to `openControl`. A role whose configured provider/model is not exactly the
 * release profile refuses the whole composition (spec §6.1: explicit per role, no default or fallback, no partial application).
 */
export function composeProductionExecution(input: ProductionInput):
  { status: 'composed'; ports: ExecutionPorts; summary: { guestAssets: GuestAssetPin; artifactSeeds: string[];
    profiles: Record<Role, { id: string; auth: string; providerId: string; modelId: string; api: string; systemPromptSha256: string }> } } |
  { status: 'refused'; code: 'WORKER_PROFILE_UNSUPPORTED'; roles: Role[] } {
  const roles = ['builder', 'standards', 'spec'] as const;
  const unsupported = roles.filter(role => input.effective.models[role].provider !== productionProfile.model.providerId ||
    input.effective.models[role].model !== productionProfile.model.modelId);
  if (unsupported.length > 0) return { status: 'refused', code: 'WORKER_PROFILE_UNSUPPORTED', roles: unsupported };
  const profile = (role: Role) => ({ id: productionProfile.sdkProfileId, systemPrompt: productionProfile.prompts[role],
    auth: productionProfile.model.auth, providerId: productionProfile.model.providerId, modelId: productionProfile.model.modelId, api: productionProfile.model.api });
  const profiles = { builder: profile('builder'), standards: profile('standards'), spec: profile('spec') };
  const pack = skillPacks[productionProfile.builder.skillPack];
  const sandbox = createSandbox({ root: input.root, guestAssets: input.guestAssets,
    repositoryFetch: createRepositoryFetchCredentials({ github: input.github, repositories: input.effective.repositories }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }] });
  const workers = createWorkers({ root: input.root, knownSecrets: [], profile: profiles.builder, profiles });
  const ports: ExecutionPorts = {
    sandbox: { prepare: input => sandbox.prepare(input), start: input => sandbox.start(input), stop: input => sandbox.stop(input),
      observeProposal: input => sandbox.observeProposal(input) },
    workers: { activate: (invocation, delivery, events) => workers.activate(invocation, delivery, events), deliver: (worker, directive) => workers.deliver(worker, directive) },
    reviews: { reviewer: { ...productionProfile.reviewer } },
    credentials: createBuilderCredentials({ github: input.github, repositories: input.effective.repositories }),
    configuration: input.effective.sandbox,
    capacity: input.effective.concurrency,
    builder: { ...productionProfile.builder },
  };
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  return { status: 'composed', ports, summary: { guestAssets: input.guestAssets, artifactSeeds: [pack.seedName],
    profiles: Object.fromEntries(roles.map(role => { const { systemPrompt, ...rest } = profiles[role]; return [role, { ...rest, systemPromptSha256: sha(systemPrompt) }]; })) as
      Record<Role, { id: string; auth: string; providerId: string; modelId: string; api: string; systemPromptSha256: string }> } };
}
