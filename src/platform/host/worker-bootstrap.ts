import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const text = z.string().min(1).max(4096);
const cost = z.number().finite().nonnegative();
const publicProfile = { id: z.literal('factory-development-pi-1.5.2-read-async-bash-lexical-v3'), systemPrompt: text };
const oauthProfile = z.strictObject({ ...publicProfile, auth: z.literal('factory-oauth'),
  providerId: z.literal('openai'), modelId: z.literal('gpt-6-luna'), api: z.literal('openai-responses') });
const legacyProfile = z.strictObject({ ...publicProfile,
    providerId: identifier, modelId: identifier, apiKey: text,
    provider: z.strictObject({ api: z.literal('openai-completions'), baseUrl: z.url().max(4096),
      models: z.array(z.strictObject({ id: identifier, name: text, reasoning: z.boolean(),
        input: z.array(z.enum(['text', 'image'])).min(1).max(2),
        cost: z.strictObject({ input: cost, output: cost, cacheRead: cost, cacheWrite: cost }),
        contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(),
      })).min(1).max(16),
    }),
  });
const launchProfile = z.union([legacyProfile, oauthProfile]);
const bootstrap = z.strictObject({
  version: z.literal(1),
  copyOutput: z.boolean().optional(),
  // Host-selected Builder start policies (ticket 09): the Factory skill pack and the bounded Builder model budget.
  skillPack: z.enum(['factory-skills-v1', 'factory-skills-v2', 'factory-skills-v3']).optional(),
  modelBudget: z.enum(['builder-v1', 'reviewer-v1']).optional(),
  // Host-derived exact guest paths of the seeded files of `skillPack` (Builder Read authority of the pack only).
  skillPackFiles: z.array(z.string().max(512).regex(/^\/artifacts\/factory\/skill-pack\/factory-skills-v[0-9]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
    .refine(path => !path.split('/').some(part => part === '.' || part === '..'))).min(1).max(64).readonly().optional(),
  // Ticket 12 Host policies: the Builder handoff (base commit of the Execution) and the reviewer's round input; never model input.
  handoff: z.strictObject({ baseCommit: z.string().regex(/^[0-9a-f]{40}$/) }).optional(),
  review: z.strictObject({ round: z.number().int().min(1).max(99), attempt: z.number().int().min(1).max(9), handoffIndexSha256: z.string().regex(/^[0-9a-f]{64}$/),
    required: z.array(z.string().max(1024).regex(/^\/(workspace|artifacts)\//)).max(32).readonly(),
    missing: z.array(z.enum(['handoff-index', 'spec-version', 'instructions-version'])).max(3).readonly() }).optional(),
  selectedOutputCopies: z.array(z.string().regex(/^\/artifacts\/factory-output-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/)).max(32).readonly().optional(),
  editSourceMaxBytes: z.number().int().nonnegative().max(8192).optional(),
  imageSourceMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  context: z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
    role: z.enum(['standards', 'spec', 'builder']), environmentRef: identifier, bootRef: identifier, phaseId: identifier }),
  endpoint: text, recordsRoot: text, knownSecrets: z.array(text).max(128), prompt: z.string().min(1).max(16384),
  profile: z.union([legacyProfile.extend({ directory: text }), oauthProfile.extend({ directory: text })]),
});

function rolePolicies(input: { context: { role: string }; copyOutput?: boolean | undefined; selectedOutputCopies?: readonly string[] | undefined;
  skillPackFiles?: readonly string[] | undefined;
  skillPack?: string | undefined; modelBudget?: string | undefined; handoff?: unknown; review?: unknown }) {
  // Pack files: Builder only, with its pack, all under exactly that pack version's guest directory.
  if (input.skillPackFiles !== undefined && (input.context.role !== 'builder' || input.skillPack === undefined ||
      input.skillPackFiles.some(path => !path.startsWith(`/artifacts/factory/skill-pack/${input.skillPack}/`)))) return false;
  const builder = input.context.role === 'builder';
  return !(builder && input.selectedOutputCopies !== undefined) &&
    !(!builder && (input.skillPack !== undefined || input.handoff !== undefined || input.modelBudget === 'builder-v1')) &&
    !(builder && (input.review !== undefined || input.modelBudget === 'reviewer-v1')) &&
    !(input.context.role !== 'builder' && input.copyOutput === true);
}
export const workerBootstrapSchema = bootstrap.refine(rolePolicies, 'WORKER_POLICY_ROLE_DENIED');
export const workerLaunchSchema = bootstrap.pick({ context: true, knownSecrets: true, prompt: true, imageSourceMaxBytes: true, editSourceMaxBytes: true, copyOutput: true, selectedOutputCopies: true, skillPack: true, skillPackFiles: true, modelBudget: true, handoff: true, review: true }).extend({ profile: launchProfile }).strict().refine(rolePolicies, 'WORKER_POLICY_ROLE_DENIED');
export type WorkerLaunch = z.infer<typeof workerLaunchSchema>;
