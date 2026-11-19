import { z } from 'zod';
import { builderBudgetMaximumFactor, builderBudgetV1, factorySkillPackIds } from '../../contracts/index.js';
import { sessionRefSchema } from './worker-session-file.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const text = z.string().min(1).max(4096);
const cost = z.number().finite().nonnegative();
const deliveredFindingId = z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/);
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
  skillPack: z.enum(factorySkillPackIds).optional(),
  modelBudget: z.enum(['builder-v1', 'reviewer-v1']).optional(),
  // Ticket 48: the repository's Builder budget adjustment of builder-v1 (never above 2x of 150 requests / 300 tools / 60 min per request).
  builderBudget: z.strictObject({ requests: z.number().int().min(1).max(builderBudgetV1.requests * builderBudgetMaximumFactor),
    tools: z.number().int().min(1).max(builderBudgetV1.toolCalls * builderBudgetMaximumFactor),
    deadlineMs: z.number().int().min(60_000).max(builderBudgetV1.requestTimeoutMinutes * builderBudgetMaximumFactor * 60_000).multipleOf(60_000) }).optional(),
  deadlineMs: z.number().int().positive().max(86_400_000).optional(),
  // Ticket 37: how long the worker waits for the owner's ACK of a secret registration before failing closed. Absent (production) is
  // the publisher's 5000 ms default; a Host may only shorten it (a fixture proving the held-ACK path need not wait 5 s).
  secretAckTimeoutMs: z.number().int().positive().max(5000).optional(),
  // Host-derived exact guest paths of the seeded files of `skillPack` (Builder Read authority of the pack only).
  skillPackFiles: z.array(z.string().max(512).regex(/^\/artifacts\/factory\/skill-pack\/factory-skills-v[0-9]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
    .refine(path => !path.split('/').some(part => part === '.' || part === '..'))).min(1).max(64).readonly().optional(),
  // Ticket 12 Host policies: the Builder handoff (base commit of the Execution) and the reviewer's round input; never model input.
  handoff: z.strictObject({ baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    // Ticket 13: repeated capture rounds of this invocation (first round number, at most `max` captures including the closing one).
    rounds: z.strictObject({ first: z.number().int().min(1).max(98), max: z.number().int().min(2).max(8),
      // R-CAND v2: findings delivered in earlier rounds of the Executions this one continues after a Question (Control's record).
      delivered: z.array(z.strictObject({ round: z.number().int().min(1).max(97), standards: z.array(deliveredFindingId).max(40).readonly(),
        spec: z.array(deliveredFindingId).max(40).readonly() })).max(16).readonly().optional() })
      .refine(value => value.first + value.max - 1 <= 99)
      .refine(value => (value.delivered ?? []).every(item => item.round < value.first), 'delivered rounds precede the first round').optional(),
    // Ticket 21: the authorized remote tip the capture checks as an ancestor of HEAD (reconciliation Execution only).
    preserve: z.string().regex(/^[0-9a-f]{40}$/).optional() }).optional(),
  // Ticket 21 review: the exact push of a publication activation (Builder only).
  pushPolicy: z.strictObject({ branch: z.string().regex(/^factory\/[0-9]+-[0-9a-f]{8}$/), expected: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    head: z.string().regex(/^[0-9a-f]{40}$/),
    remote: z.string().regex(/^(origin|https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git)$/).optional() }).optional(),
  review: z.strictObject({ round: z.number().int().min(1).max(99), attempt: z.number().int().min(1).max(9), handoffIndexSha256: z.string().regex(/^[0-9a-f]{64}$/),
    required: z.array(z.string().max(1024).regex(/^\/(workspace|artifacts)\//)).max(32).readonly(),
    missing: z.array(z.enum(['handoff-index', 'spec-version', 'instructions-version'])).max(3).readonly(),
    // Ticket 13: Control names the previous round's session of the same role; only the owner launcher turns it into `session`.
    continueFrom: z.string().max(4096).regex(/^\//).optional(),
    session: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('continued'), from: z.string().max(4096), file: z.string().max(4096).regex(/^\//) }),
      z.strictObject({ mode: z.literal('replaced'), from: z.string().max(4096), code: z.string().regex(/^[A-Z_]{1,64}$/) })]).optional() }).optional(),
  // Ticket 11, Builder only. Launch: the Host-observed preserved session to continue (copied by the owner before the worker exists).
  continueSession: sessionRefSchema.pick({ ref: true, sha256: true, sessionId: true, bytes: true }).strict().optional(),
  // Worker bootstrap: that owner copy inside this worker's own private sessions directory.
  continuedSession: z.strictObject({ file: text, sha256: z.string().regex(/^[0-9a-f]{64}$/), sessionId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/) }).optional(),
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
  skillPack?: string | undefined; modelBudget?: string | undefined; builderBudget?: unknown; handoff?: unknown; pushPolicy?: unknown; review?: unknown; continueSession?: unknown; continuedSession?: unknown }) {
  if (input.pushPolicy !== undefined && input.context.role !== 'builder') return false;
  if (input.builderBudget !== undefined && (input.context.role !== 'builder' || input.modelBudget !== 'builder-v1')) return false;
  // A session continuation is a Builder policy only, and never both the launch form and the bootstrap form.
  if ((input.continueSession !== undefined || input.continuedSession !== undefined) && (input.context.role !== 'builder' ||
      (input.continueSession !== undefined && input.continuedSession !== undefined))) return false;
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
export const workerLaunchSchema =  bootstrap.pick({ context: true, knownSecrets: true, prompt: true, imageSourceMaxBytes: true, editSourceMaxBytes: true, copyOutput: true, selectedOutputCopies: true, skillPack: true, skillPackFiles: true, modelBudget: true, builderBudget: true, deadlineMs: true, secretAckTimeoutMs: true, handoff: true, pushPolicy: true, review: true, continueSession: true }).extend({ profile: launchProfile }).strict().refine(rolePolicies, 'WORKER_POLICY_ROLE_DENIED')
  // The continued session is resolved by the owner launcher from `continueFrom`, never supplied by the launch request.
  .refine(input => input.review?.session === undefined, 'WORKER_POLICY_ROLE_DENIED');
export type WorkerLaunch = z.infer<typeof workerLaunchSchema>;
