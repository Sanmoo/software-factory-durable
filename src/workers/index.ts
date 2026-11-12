import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader } from '#factory-pi';
import type { ToolContext, ToolProjection } from '../sandbox/index.js';
import type { createRecords } from '../records/index.js';
import { reviewerRead } from './read.js';
import { sdkProfile } from './sdk-profile.js';

type ReviewerModel = { id: string; name: string; reasoning: boolean; input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number };
export type ReviewerProfile = { id: typeof sdkProfile.id; directory: string; systemPrompt: string;
  providerId: string; modelId: string; apiKey: string;
  provider: { api: 'openai-completions'; baseUrl: string; models: ReviewerModel[] } };

/** Explicit Q9 development composition. Only reviewer activation is implemented;
 * admission/reservations remain the controller's responsibility before calling it.
 * No SDK object/session/loader is returned to callers. */
export function createWorkers(options: { profile: ReviewerProfile; sandbox: ToolProjection;
  records: Awaited<ReturnType<typeof createRecords>> }) {
  return {
    async activate(invocation: { context: ToolContext; prompt: string; signal: AbortSignal }) {
      const { profile } = options;
      if (profile.id !== sdkProfile.id || !profile.providerId || !profile.modelId || !profile.systemPrompt ||
          !profile.apiKey || !profile.provider.models?.some(model => model.id === profile.modelId) ||
          Object.keys(profile.provider).some(key => !['api', 'baseUrl', 'models'].includes(key))) throw new Error('WORKER_PROFILE_INVALID');
      for (const path of [profile.directory, join(profile.directory, 'sessions')]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('WORKER_PROFILE_NOT_PRIVATE');
      }
      if (invocation.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
      if (!['standards', 'spec'].includes(invocation.context.role)) throw new Error('WORKER_ROLE_UNSUPPORTED');
      options.records.registerSecret(profile.apiKey);
      const { phaseId, ...context } = invocation.context;
      // Critical protected publication completes before SDK/model/tool activity.
      const receipt = await options.records.record({ ...context, callId: 'worker-start' }, {
        version: 1, kind: 'worker-start', context: invocation.context, phaseId, profile: sdkProfile,
        providerId: profile.providerId, modelId: profile.modelId, startedAt: new Date().toISOString(),
      });
      if (invocation.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
      const runtime = await ModelRuntime.create({ authPath: join(profile.directory, 'auth.json'), modelsPath: null,
        modelsStorePath: join(profile.directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
      runtime.registerProvider(profile.providerId, profile.provider);
      await runtime.setRuntimeApiKey(profile.providerId, profile.apiKey, { signal: invocation.signal });
      const model = runtime.getModel(profile.providerId, profile.modelId);
      if (!model) throw new Error('WORKER_MODEL_UNAVAILABLE');
      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => profile.systemPrompt, getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
      };
      const manager = SessionManager.create('/workspace', join(profile.directory, 'sessions'));
      let interrupted = false;
      let abortSession = () => {};
      const read = reviewerRead(invocation.context, options.sandbox, () => { interrupted = true; abortSession(); });
      const { session } = await createAgentSession({ cwd: '/workspace', agentDir: profile.directory, modelRuntime: runtime,
        model, thinkingLevel: 'off', tools: ['read'], customTools: [read], resourceLoader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } },
          compaction: { enabled: false } }) });
      if (session.model?.provider !== profile.providerId || session.model.id !== profile.modelId) {
        session.dispose(); throw new Error('WORKER_MODEL_MISMATCH');
      }
      abortSession = () => { void session.abort().catch(() => {}); };
      const abort = () => { interrupted = true; abortSession(); };
      invocation.signal.addEventListener('abort', abort, { once: true });
      try {
        if (invocation.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
        await session.prompt(invocation.prompt);
        return { status: invocation.signal.aborted || interrupted ? 'interrupted' as const : 'completed' as const,
          receipt, sessionFile: manager.getSessionFile() };
      } finally { invocation.signal.removeEventListener('abort', abort); session.dispose(); }
    },
  };
}
