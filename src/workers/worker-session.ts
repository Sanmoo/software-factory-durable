import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFactoryOAuth } from './factory-oauth.js';
import { oauthQualification, qualifyOAuth } from './oauth-qualification.js';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader, type ToolDefinition } from '#factory-pi';
import type { ToolProjection } from '../sandbox/index.js';
import type { createRecords, OutputReference } from '../records/index.js';
import { reviewerRead } from './read.js';
import { builderWrite } from './write.js';
import { builderBash } from './bash.js';
import { builderEdit } from './edit.js';
import { startWorker, type ReviewerProfile, type Invocation } from './worker-start.js';

type Options = { profile: ReviewerProfile; sandbox: ToolProjection; records: Awaited<ReturnType<typeof createRecords>>;
  oauth?: { factoryRoot: string; acknowledgeSecrets(values: readonly string[]): Promise<void>;
    registerSecret(value: string): void; publicInputIsSafe(): boolean } };

/** Private SDK component seam; not host activation or process proof. */
export function createWorkerSession(options: Options) {
  return { async activate(invocation: Invocation) {
    const snapshot = { ...invocation, copyOutput: invocation.copyOutput === true };
    const receipt = await startWorker(options.profile, options.records, snapshot);
    return executeSession(options, snapshot, receipt);
  } };
}

/** Called only after the worker composition has synced its start evidence. */
export async function executeSession(options: Options, invocation: Invocation, receipt: OutputReference) {
  const copyOutput = invocation.copyOutput === true;
  const { profile } = options;
  if (invocation.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
  const qualificationAbort = new AbortController();
  const oauth = !('apiKey' in profile);
  const signal = oauth ? AbortSignal.any([invocation.signal, qualificationAbort.signal, AbortSignal.timeout(oauthQualification.deadlineMs)]) : invocation.signal;
  if (oauth && (!options.oauth || Buffer.byteLength(invocation.prompt) > oauthQualification.promptBytes)) throw new Error('WORKER_QUALIFICATION_CLOSED');
  const store = oauth ? await openFactoryOAuth({ factoryRoot: options.oauth!.factoryRoot,
    excludedRoots: { source: fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, ''),
      guest: join(options.oauth!.factoryRoot, 'environments'), profiles: [join(options.oauth!.factoryRoot, 'r')] },
    records: { registerSecret: options.oauth!.registerSecret },
    acknowledgeSecrets: async values => {
      await options.oauth!.acknowledgeSecrets(values);
      if (!options.oauth!.publicInputIsSafe()) throw new Error('WORKER_BOOTSTRAP_INVALID');
    }, profileDirectory: profile.directory, signal }) : undefined;
  try {
    const runtime = await ModelRuntime.create({ ...(store ? { credentials: store.credentials } : { authPath: join(profile.directory, 'auth.json') }), modelsPath: null,
      modelsStorePath: join(profile.directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false, signal });
    try {
      if ('apiKey' in profile) {
        runtime.registerProvider(profile.providerId, profile.provider);
        await runtime.setRuntimeApiKey(profile.providerId, profile.apiKey, { signal });
      }
      const qualification = oauth ? qualifyOAuth(runtime, signal, options.oauth!.publicInputIsSafe, () => qualificationAbort.abort()) : undefined;
      qualification?.check();
      const model = runtime.getModel(profile.providerId, profile.modelId);
      if (!model || (oauth && model.api !== 'openai-responses')) throw new Error('WORKER_MODEL_UNAVAILABLE');
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
      const editEnabled = invocation.context.role === 'builder' && invocation.editSourceMaxBytes !== undefined;
      const customTools: ToolDefinition[] = invocation.context.role === 'builder'
        ? [builderWrite(invocation.context, options.sandbox, critical), builderBash(invocation.context, options.sandbox, critical, copyOutput)]
        : [reviewerRead(invocation.context, options.sandbox, critical)];
      const tools = invocation.context.role === 'builder' ? ['write', 'bash'] : ['read'];
      if (invocation.context.role === 'builder' && copyOutput) {
        customTools.push(reviewerRead(invocation.context, options.sandbox, critical));
        tools.push('read');
      }
      if (editEnabled) {
        customTools.push(builderEdit(invocation.context, options.sandbox, critical));
        tools.push('edit');
      }
      const { session } = await createAgentSession({ cwd: '/workspace', agentDir: profile.directory, modelRuntime: runtime,
        model, thinkingLevel: 'off', tools, customTools: qualification ? customTools.map(tool => qualification.tool(tool)) : customTools, resourceLoader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } },
          compaction: { enabled: false }, cacheWarming: 'off' }) });
      if (session.model?.provider !== profile.providerId || session.model.id !== profile.modelId) {
        session.dispose(); throw new Error('WORKER_MODEL_MISMATCH');
      }
      abortSession = () => { void session.abort().catch(() => {}); };
      const abort = () => { interrupted = true; abortSession(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
        qualification?.check();
        await session.prompt(invocation.prompt);
        return { status: signal.aborted || interrupted || qualification?.failed() ? 'interrupted' as const : 'completed' as const,
          receipt, sessionFile: manager.getSessionFile() };
      } finally { signal.removeEventListener('abort', abort); session.dispose(); }
    } finally { await runtime.settleCredentialWrites(); }
  } finally { await store?.settleCredentialWrites(); }
}
