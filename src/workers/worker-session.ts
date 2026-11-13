import { join } from 'node:path';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader } from '#factory-pi';
import type { ToolProjection } from '../sandbox/index.js';
import type { createRecords, OutputReference } from '../records/index.js';
import { reviewerRead } from './read.js';
import { builderWrite } from './write.js';
import { startWorker, type ReviewerProfile, type Invocation } from './worker-start.js';

type Options = { profile: ReviewerProfile; sandbox: ToolProjection; records: Awaited<ReturnType<typeof createRecords>> };

/** Private SDK component seam; not host activation or process proof. */
export function createWorkerSession(options: Options) {
  return { async activate(invocation: Invocation) {
    const receipt = await startWorker(options.profile, options.records, invocation);
    return executeSession(options, invocation, receipt);
  } };
}

/** Called only after the worker composition has synced its start evidence. */
export async function executeSession(options: Options, invocation: Invocation, receipt: OutputReference) {
  const { profile } = options;
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
  const critical = () => { interrupted = true; abortSession(); };
  const tool = invocation.context.role === 'builder' ? builderWrite(invocation.context, options.sandbox, critical)
    : reviewerRead(invocation.context, options.sandbox, critical);
  const { session } = await createAgentSession({ cwd: '/workspace', agentDir: profile.directory, modelRuntime: runtime,
    model, thinkingLevel: 'off', tools: invocation.context.role === 'builder' ? ['write'] : ['read'], customTools: [tool], resourceLoader, sessionManager: manager,
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
}
