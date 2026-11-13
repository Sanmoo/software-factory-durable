import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext } from '../sandbox/index.js';
import type { createRecords } from '../records/index.js';
import { sdkProfile } from './sdk-profile.js';

type ReviewerModel = { id: string; name: string; reasoning: boolean; input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number };
export type ReviewerProfile = { id: typeof sdkProfile.id; directory: string; systemPrompt: string;
  providerId: string; modelId: string; apiKey: string;
  provider: { api: 'openai-completions'; baseUrl: string; models: ReviewerModel[] } };
export type Invocation = { context: ToolContext; prompt: string; signal: AbortSignal; imageSourceMaxBytes?: number };

/** Critical protected evidence, never admission or proof of group/FD isolation. */
export async function startWorker(profile: ReviewerProfile, records: Awaited<ReturnType<typeof createRecords>>, invocation: Invocation) {
  if (profile.id !== sdkProfile.id || !profile.providerId || !profile.modelId || !profile.systemPrompt ||
      !profile.apiKey || !profile.provider.models?.some(model => model.id === profile.modelId) ||
      Object.keys(profile.provider).some(key => !['api', 'baseUrl', 'models'].includes(key))) throw new Error('WORKER_PROFILE_INVALID');
  for (const path of [profile.directory, join(profile.directory, 'sessions')]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('WORKER_PROFILE_NOT_PRIVATE');
  }
  if (invocation.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
  if (!['standards', 'spec', 'builder'].includes(invocation.context.role)) throw new Error('WORKER_ROLE_UNSUPPORTED');
  records.registerSecret(profile.apiKey);
  const { phaseId, ...context } = invocation.context;
  return records.record({ ...context, callId: 'worker-start' }, {
    version: 1, kind: 'worker-start', suppliedContext: invocation.context, phaseId, profile: sdkProfile,
    providerId: profile.providerId, modelId: profile.modelId, profileDirectory: profile.directory,
    startedAt: new Date().toISOString(),
    observedProcess: { pid: process.pid, parentPid: process.ppid, uid: process.getuid?.(),
      executable: process.execPath, nodeVersion: process.versions.node,
      timeOrigin: performance.timeOrigin, observedAt: new Date().toISOString() },
  });
}
