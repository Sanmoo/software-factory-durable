import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFactoryOAuth } from './factory-oauth.js';
import { builderBudget, oauthQualification, qualifyOAuth } from './oauth-qualification.js';
import { createAgentSession, createExtensionRuntime, createSyntheticSourceInfo, ModelRuntime, SessionManager, SettingsManager,
  type PromptTemplate, type ResourceLoader, type Skill, type ToolDefinition } from '#factory-pi';
import { loadSkillPack, skillPacks } from './skill-pack.js';
import type { ToolProjection } from '../sandbox/index.js';
import type { createRecords, OutputReference } from '../records/index.js';
import { reviewerRead } from './read.js';
import { builderWrite } from './write.js';
import { builderBash } from './bash.js';
import { builderEdit } from './edit.js';
import { startWorker, type ReviewerProfile, type Invocation } from './worker-start.js';
import { builderAskUser, type AskedQuestion } from './ask-user.js';
import type { WorkerQuestionRequest } from '../platform/host/index.js';

type Options = { profile: ReviewerProfile; sandbox: ToolProjection; records: Awaited<ReturnType<typeof createRecords>>;
  oauth?: { factoryRoot: string; acknowledgeSecrets(values: readonly string[]): Promise<void>;
    registerSecret(value: string): void; publicInputIsSafe(): boolean };
  /** Builder ask_user: notification to the host (bounded wait for the Control ACK) and the known-secret check of the question text. */
  questions?: { send(question: WorkerQuestionRequest): Promise<{ status: 'recorded' } | { status: 'refused'; code: string } | { status: 'unacknowledged' }>;
    containsSecret(text: string): boolean } };

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
  // After a question no further model request or tool runs in this activation (spec §5.5: the activation ends, nothing waits).
  let asked: AskedQuestion | undefined;
  const limits = invocation.modelBudget === 'builder-v1' && invocation.context.role === 'builder' ? builderBudget : oauthQualification;
  const signal = oauth ? AbortSignal.any([invocation.signal, qualificationAbort.signal, AbortSignal.timeout(limits.deadlineMs)]) : invocation.signal;
  if (oauth && (!options.oauth || Buffer.byteLength(invocation.prompt) > limits.promptBytes)) throw new Error('WORKER_QUALIFICATION_CLOSED');
  // Explicit Factory resources only: the verified pack (guest-readable copies under /artifacts) or nothing; never a personal profile.
  const selected = invocation.skillPack !== undefined && invocation.context.role === 'builder' ? skillPacks[invocation.skillPack] : undefined;
  const pack = selected ? await loadSkillPack(selected.directory) : undefined;
  if (pack && pack.id !== selected!.id) throw new Error('WORKER_SKILL_PACK_DRIFT');
  const builderSkillPack = selected ?? skillPacks['factory-skills-v2'];
  const source = (path: string) => createSyntheticSourceInfo(`${builderSkillPack.guestDirectory}/${path}`, { source: `factory:${builderSkillPack.id}`, scope: 'temporary', origin: 'package' });
  const skills: Skill[] = pack ? pack.manifest.skills.map(skill => ({ name: skill.name, description: skill.description,
    filePath: `${builderSkillPack.guestDirectory}/${skill.path}`, baseDir: `${builderSkillPack.guestDirectory}/${skill.path.replace(/\/SKILL\.md$/, '')}`,
    sourceInfo: source(skill.path), disableModelInvocation: !skill.modelInvocation })) : [];
  const prompts: PromptTemplate[] = pack ? pack.prompts.map(prompt => ({ name: prompt.name, description: prompt.description, content: prompt.content,
    filePath: `${builderSkillPack.guestDirectory}/${prompt.path}`, sourceInfo: source(prompt.path) })) : [];
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
      const qualification = oauth ? qualifyOAuth(runtime, signal, options.oauth!.publicInputIsSafe, () => qualificationAbort.abort(), limits) : undefined;
      // After a question: no further model request of this activation, whatever the profile (outermost wrapper, before any auth/network).
      const stream = runtime.streamSimple.bind(runtime);
      runtime.streamSimple = (...args: Parameters<typeof stream>) => { if (asked) throw new Error('ACTIVATION_ENDED_AFTER_QUESTION'); return stream(...args); };
      qualification?.check();
      const model = runtime.getModel(profile.providerId, profile.modelId);
      if (!model || (oauth && model.api !== 'openai-responses')) throw new Error('WORKER_MODEL_UNAVAILABLE');
      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills, diagnostics: [] }), getPrompts: () => ({ prompts, diagnostics: [] }),
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
      // Builder Read: selected output copies (copyOutput) and/or the files of its own pack version (owner-enforced exact paths).
      if (invocation.context.role === 'builder' && (copyOutput || invocation.skillPack !== undefined)) {
        customTools.push(reviewerRead(invocation.context, options.sandbox, critical));
        tools.push('read');
      }
      if (editEnabled) {
        customTools.push(builderEdit(invocation.context, options.sandbox, critical));
        tools.push('edit');
      }
      if (invocation.context.role === 'builder' && options.questions) {
        const { phaseId, ...recordContext } = invocation.context;
        customTools.push(builderAskUser(invocation.context, {
          preserve: (question, toolCallId) => options.records.record({ ...recordContext, callId: `ask-user-${question.questionId}` },
            { version: 1, kind: 'ask-user', ...question, phaseId, toolCallId, askedAt: new Date().toISOString() }),
          send: question => options.questions!.send(question), containsSecret: text => options.questions!.containsSecret(text),
          asked: question => { asked = question; setImmediate(() => abortSession()); }, onCritical: critical }));
        tools.push('ask_user');
      }
      // Gate: once a question is asked, every other tool call of this activation is refused before any effect.
      const gated = customTools.map(tool => tool.name === 'ask_user' ? tool : { ...tool, async execute(...args: Parameters<ToolDefinition['execute']>) {
        if (asked) throw new Error('ACTIVATION_ENDED_AFTER_QUESTION');
        return tool.execute(...args);
      } } as ToolDefinition);
      const { session } = await createAgentSession({ cwd: '/workspace', agentDir: profile.directory, modelRuntime: runtime,
        model, thinkingLevel: 'off', tools, customTools: qualification ? gated.map(tool => qualification.tool(tool)) : gated, resourceLoader, sessionManager: manager,
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
        await session.prompt(invocation.prompt).catch(error => { if (!asked) throw error; });
        if (asked) return { status: 'question' as const, receipt, sessionFile: manager.getSessionFile() ?? null, question: asked };
        return { status: signal.aborted || interrupted || qualification?.failed() ? 'interrupted' as const : 'completed' as const,
          receipt, sessionFile: manager.getSessionFile() };
      } finally { signal.removeEventListener('abort', abort); session.dispose(); }
    } finally { await runtime.settleCredentialWrites(); }
  } finally { await store?.settleCredentialWrites(); }
}
