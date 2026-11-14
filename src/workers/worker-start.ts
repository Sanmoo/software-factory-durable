import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext } from '../sandbox/index.js';
import type { createRecords } from '../records/index.js';
import { sdkProfile } from './sdk-profile.js';
import { createHash } from 'node:crypto';
import { loadSkillPack, skillPacks, type SkillPackId } from './skill-pack.js';

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
  /** Builder only: bounded OAuth Builder budget instead of the 05 qualification envelope. */
  modelBudget?: 'builder-v1' };

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
  if ((invocation.skillPack !== undefined || invocation.modelBudget !== undefined) && invocation.context.role !== 'builder') throw new Error('WORKER_POLICY_ROLE_DENIED');
  // The exact verified pack identity enters the start receipt; drift refuses the start before any model/tool.
  const pack = invocation.skillPack ? await loadSkillPack(skillPacks[invocation.skillPack].directory) : undefined;
  if (pack && pack.id !== invocation.skillPack) throw new Error('WORKER_SKILL_PACK_DRIFT');
  const { phaseId, ...context } = invocation.context;
  return records.record({ ...context, callId: 'worker-start' }, {
    version: 1, kind: 'worker-start', suppliedContext: invocation.context, phaseId, profile: sdkProfile,
    providerId: profile.providerId, modelId: profile.modelId, profileDirectory: profile.directory,
    promptSha256: createHash('sha256').update(invocation.prompt).digest('hex'),
    skillPack: pack ? { id: pack.id, version: pack.version, manifestSha256: pack.manifestSha256 } : null,
    modelBudget: invocation.modelBudget ?? null,
    startedAt: new Date().toISOString(),
    observedProcess: { pid: process.pid, parentPid: process.ppid, uid: process.getuid?.(),
      executable: process.execPath, nodeVersion: process.versions.node,
      timeOrigin: performance.timeOrigin, observedAt: new Date().toISOString() },
  });
}
