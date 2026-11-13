import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const text = z.string().min(1).max(4096);
const cost = z.number().finite().nonnegative();
export const workerBootstrapSchema = z.strictObject({
  version: z.literal(1),
  imageSourceMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  context: z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
    role: z.enum(['standards', 'spec', 'builder']), environmentRef: identifier, bootRef: identifier, phaseId: identifier }),
  endpoint: text, recordsRoot: text, knownSecrets: z.array(text).max(128), prompt: z.string().min(1).max(16384),
  profile: z.strictObject({ id: z.literal('factory-development-pi-1.5.2-read-async-bash-lexical-v3'), directory: text, systemPrompt: text,
    providerId: identifier, modelId: identifier, apiKey: text,
    provider: z.strictObject({ api: z.literal('openai-completions'), baseUrl: z.url().max(4096),
      models: z.array(z.strictObject({ id: identifier, name: text, reasoning: z.boolean(),
        input: z.array(z.enum(['text', 'image'])).min(1).max(2),
        cost: z.strictObject({ input: cost, output: cost, cacheRead: cost, cacheWrite: cost }),
        contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(),
      })).min(1).max(16),
    }),
  }),
});

export const workerLaunchSchema = workerBootstrapSchema.pick({ context: true, knownSecrets: true, prompt: true, imageSourceMaxBytes: true }).extend({ profile: workerBootstrapSchema.shape.profile.omit({ directory: true }) }).strict();
export type WorkerLaunch = z.infer<typeof workerLaunchSchema>;
