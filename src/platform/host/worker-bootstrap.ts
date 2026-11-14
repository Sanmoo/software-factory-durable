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
  skillPack: z.enum(['factory-skills-v1', 'factory-skills-v2']).optional(),
  modelBudget: z.literal('builder-v1').optional(),
  selectedOutputCopies: z.array(z.string().regex(/^\/artifacts\/factory-output-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/)).max(32).readonly().optional(),
  editSourceMaxBytes: z.number().int().nonnegative().max(8192).optional(),
  imageSourceMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  context: z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
    role: z.enum(['standards', 'spec', 'builder']), environmentRef: identifier, bootRef: identifier, phaseId: identifier }),
  endpoint: text, recordsRoot: text, knownSecrets: z.array(text).max(128), prompt: z.string().min(1).max(16384),
  profile: z.union([legacyProfile.extend({ directory: text }), oauthProfile.extend({ directory: text })]),
});

function rolePolicies(input: { context: { role: string }; copyOutput?: boolean | undefined; selectedOutputCopies?: readonly string[] | undefined;
  skillPack?: string | undefined; modelBudget?: string | undefined }) {
  return !(input.context.role === 'builder' && input.selectedOutputCopies !== undefined) &&
    !(input.context.role !== 'builder' && (input.skillPack !== undefined || input.modelBudget !== undefined)) &&
    !(input.context.role !== 'builder' && input.copyOutput === true);
}
export const workerBootstrapSchema = bootstrap.refine(rolePolicies, 'WORKER_POLICY_ROLE_DENIED');
export const workerLaunchSchema = bootstrap.pick({ context: true, knownSecrets: true, prompt: true, imageSourceMaxBytes: true, editSourceMaxBytes: true, copyOutput: true, selectedOutputCopies: true, skillPack: true, modelBudget: true }).extend({ profile: launchProfile }).strict().refine(rolePolicies, 'WORKER_POLICY_ROLE_DENIED');
export type WorkerLaunch = z.infer<typeof workerLaunchSchema>;
