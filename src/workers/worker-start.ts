import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext } from '../sandbox/index.js';
import type { createRecords } from '../records/index.js';
import { sdkProfile } from './sdk-profile.js';
import { createHash } from 'node:crypto';
import { loadSkillPack, skillPacks, type SkillPackId } from './skill-pack.js';
import type { ReviewInput } from './review.js';
import type { WorkerSessionRef } from './session-ref.js';
import type { BuilderBudgetOverride } from './oauth-qualification.js';

type ReviewerModel = { id: string; name: string; reasoning: boolean; input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number };
type LegacyProfile = { id: typeof sdkProfile.id; directory: string; systemPrompt: string;
  providerId: string; modelId: string; apiKey: string;
  provider: { api: 'openai-completions'; baseUrl: string; models: ReviewerModel[] } };
export type ReviewerProfile = LegacyProfile | { id: typeof sdkProfile.id; directory: string; systemPrompt: string;
  auth: 'factory-oauth'; providerId: 'openai'; modelId: 'gpt-6-luna'; api: 'openai-responses' };
/** Optional tool policies are trusted Host inputs, never model/context claims. */
export type Invocation = { context: ToolContext; prompt: string; signal: AbortSignal; imageSourceMaxBytes?: number; editSourceMaxBytes?: number; copyOutput?: boolean; selectedOutputCopies?: readonly string[];
  /** Builder only: the Factory's own versioned skill pack (resource loader skills + /implement, /pr templates). */
  skillPack?: SkillPackId;
  /** Bounded OAuth budget instead of the 05 qualification envelope: `builder-v1` for the Builder, `reviewer-v1` for Standards/Spec. */
  modelBudget?: 'builder-v1' | 'reviewer-v1';
  /** Ticket 48, Builder only: the repository's adjustment of `builder-v1` (requests, tool calls, per-request timeout; at most 2x). */
  builderBudget?: BuilderBudgetOverride;
  /** Explicit invocational clock bound (ticket 19): only a Host policy may set it. Absent means NO implicit cut (spec §4.4);
   * the Execution-level clock is the repository's optional timeout, enforced by the controller. */
  deadlineMs?: number;
  /** Ticket 37: shorter secret-registration ACK wait (≤ 5000 ms); absent is the production 5000 ms. Only a Host policy may set it. */
  secretAckTimeoutMs?: number;
  /** Builder only (ticket 12): the Host handoff tool and suspension for the Factory reviews, with the Execution's base commit. */
  handoff?: { baseCommit: string;
    /** Ticket 13: repeated rounds (treatments, gates, closing capture); absent = the single ticket 12 round. */
    rounds?: { first: number; max: number; delivered?: readonly { round: number; standards: readonly string[]; spec: readonly string[] }[] | undefined } | undefined;
    /** Ticket 21: the authorized remote tip every capture checks as an ancestor of HEAD (reconciliation Execution only). */
    preserve?: string | undefined };
  /** Builder only (ticket 21 review): the exact push Control allows in a publication activation; absent = no push. */
  pushPolicy?: { branch: string; expected: string | null; head: string; remote?: string | undefined };
  /** Standards/Spec only (ticket 12): the round/attempt, handoff identity and the inputs that must be read for a clean conclusion. */
  review?: ReviewInput;
  /** Builder only (ticket 11): continue THIS preserved compatible session (Host-copied before the worker exists); the prompt is `continue ...`. */
  continuation?: { session: WorkerSessionRef };
  /** Worker side of `continuation`: the owner's private copy of that session in THIS worker's profile (identity and hash re-checked). */
  continuedSession?: { file: string; sha256: string; sessionId: string } };

/** Critical protected evidence, never admission or proof of group/FD isolation. */
export async function startWorker(profile: ReviewerProfile, records: Awaited<ReturnType<typeof createRecords>>, invocation: Invocation) {
  if (profile.id !== sdkProfile.id || !profile.providerId || !profile.modelId || !profile.systemPrompt ||
      ('apiKey' in profile ? (!profile.apiKey || !profile.provider.models?.some(model => model.id === profile.modelId) ||
      Object.keys(profile.provider).some(key => !['api', 'baseUrl', 'models'].includes(key))) :
      (profile.auth !== 'factory-oauth' || profile.providerId !== 'openai' || profile.modelId !== 'gpt-6-luna' || profile.api !== 'openai-responses'))) throw new Error('WORKER_PROFILE_INVALID');
  for (const path of [profile.directory, join(profile.directory, 'sessions')]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('WORKER_PROFILE_NOT_PRIVATE');
  }
  if (invocation.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
  if (!['standards', 'spec', 'builder'].includes(invocation.context.role)) throw new Error('WORKER_ROLE_UNSUPPORTED');
  if ('apiKey' in profile) records.registerSecret(profile.apiKey);
  const reviewer = invocation.context.role !== 'builder';
  if (((invocation.skillPack !== undefined || invocation.handoff !== undefined || invocation.modelBudget === 'builder-v1' || invocation.builderBudget !== undefined || invocation.continuedSession !== undefined) && reviewer) ||
      ((invocation.review !== undefined || invocation.modelBudget === 'reviewer-v1') && !reviewer)) throw new Error('WORKER_POLICY_ROLE_DENIED');
  // The exact verified pack identity enters the start receipt; drift refuses the start before any model/tool.
  const pack = invocation.skillPack ? await loadSkillPack(skillPacks[invocation.skillPack].directory, invocation.skillPack) : undefined;
  if (pack && pack.id !== invocation.skillPack) throw new Error('WORKER_SKILL_PACK_DRIFT');
  const { phaseId, ...context } = invocation.context;
  return records.record({ ...context, callId: 'worker-start' }, {
    version: 1, kind: 'worker-start', suppliedContext: invocation.context, phaseId, profile: sdkProfile,
    providerId: profile.providerId, modelId: profile.modelId, profileDirectory: profile.directory,
    promptSha256: createHash('sha256').update(invocation.prompt).digest('hex'),
    skillPack: pack ? { id: pack.id, version: pack.version, manifestSha256: pack.manifestSha256 } : null,
    modelBudget: invocation.modelBudget ?? null,
    ...(invocation.builderBudget ? { builderBudget: invocation.builderBudget } : {}),
    deadlineMs: invocation.deadlineMs ?? null,
    handoff: invocation.handoff ? { baseCommit: invocation.handoff.baseCommit, ...(invocation.handoff.preserve ? { preserve: invocation.handoff.preserve } : {}) } : null,
    // Ticket 11 (spec §6.1): the session format and whether this activation continues a preserved session (identity/hash) or starts one.
    session: { format: 'pi-session-jsonl-v3', mode: invocation.continuedSession ? 'continue' : 'new',
      ...(invocation.continuedSession ? { sessionId: invocation.continuedSession.sessionId, sha256: invocation.continuedSession.sha256 } : {}) },
    review: invocation.review ? { round: invocation.review.round, attempt: invocation.review.attempt, handoffIndexSha256: invocation.review.handoffIndexSha256,
      required: [...invocation.review.required], missing: [...invocation.review.missing] } : null,
    startedAt: new Date().toISOString(),
    observedProcess: { pid: process.pid, parentPid: process.ppid, uid: process.getuid?.(),
      executable: process.execPath, nodeVersion: process.versions.node,
      timeOrigin: performance.timeOrigin, observedAt: new Date().toISOString() },
  });
}
