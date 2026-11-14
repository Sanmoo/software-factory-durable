import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFactoryOAuth } from './factory-oauth.js';
import { budgetFor, qualifyOAuth } from './oauth-qualification.js';
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
import { builderHandoff, captureHandoff, suspendable, type BuilderDirective, type HandoffEvent } from './builder-handoff.js';
import { composeOpinion, createReadObserver, opinionSchema } from './review.js';
import type { ReviewOpinion } from '../contracts/index.js';
export type { BuilderDirective, HandoffEvent } from './builder-handoff.js';

type Options = { profile: ReviewerProfile; sandbox: ToolProjection; records: Awaited<ReturnType<typeof createRecords>>;
  oauth?: { factoryRoot: string; acknowledgeSecrets(values: readonly string[]): Promise<void>;
    registerSecret(value: string): void; publicInputIsSafe(): boolean };
  /** Builder ask_user: notification to the host (bounded wait for the Control ACK) and the known-secret check of the question text. */
  questions?: { send(question: WorkerQuestionRequest): Promise<{ status: 'recorded' } | { status: 'refused'; code: string } | { status: 'unacknowledged' }>;
    containsSecret(text: string): boolean };
  /** Builder with a `handoff` policy: notifies the suspended handoff and waits for the Host directive (review results). */
  onHandoff?: (event: HandoffEvent) => Promise<BuilderDirective> };

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
  const limits = budgetFor(invocation.context.role, invocation.modelBudget);
  const role = invocation.context.role;
  if (invocation.handoff !== undefined && (role !== 'builder' || !options.onHandoff)) throw new Error('WORKER_HANDOFF_UNAVAILABLE');
  const signal = oauth ? AbortSignal.any([invocation.signal, qualificationAbort.signal, AbortSignal.timeout(limits.deadlineMs)]) : invocation.signal;
  if (oauth && (!options.oauth || Buffer.byteLength(invocation.prompt) > limits.promptBytes)) throw new Error('WORKER_QUALIFICATION_CLOSED');
  // Explicit Factory resources only: the verified pack (guest-readable copies under /artifacts) or nothing; never a personal profile.
  const selected = invocation.skillPack !== undefined && invocation.context.role === 'builder' ? skillPacks[invocation.skillPack] : undefined;
  const pack = selected ? await loadSkillPack(selected.directory, selected.id) : undefined;
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
      const observer = createReadObserver();
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
      // Reviewer with a review input: the SAME native read, observed by the Host (reads, failures, truncation) for the opinion checks.
      if (invocation.context.role !== 'builder' && invocation.review) {
        const reviewer = customTools[0]!;
        customTools[0] = { ...reviewer, async execute(...args: Parameters<ToolDefinition['execute']>) {
          try { const result = await reviewer.execute(...args); observer.observe(args[1], { details: result.details, ...(result.isError === undefined ? {} : { isError: result.isError }) }); return result; }
          catch (error) { observer.observe(args[1], { error }); throw error; }
        } };
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
      // Host suspension (spec §5.6): once the Builder hands off, EVERY Builder tool refuses and terminates the batch until the Host
      // delivers the review results; a new model turn while suspended interrupts the session (it is not merely a model phrase/agent_end).
      const gate = invocation.handoff ? builderHandoff() : undefined;
      const sessionTools = gate ? [...gated.map(tool => suspendable(tool, gate)), gate.tool] : gated;
      if (gate) {
        // Synchronous backstop: no provider request can even start while suspended (the request itself is refused, not just aborted later).
        const nativeStream = runtime.streamSimple.bind(runtime);
        runtime.streamSimple = (...args: Parameters<typeof nativeStream>) => {
          if (gate.suspended()) { critical(); throw new Error('BUILDER_SUSPENDED_FOR_REVIEW'); }
          return nativeStream(...args);
        };
      }
      if (gate) tools.push(gate.tool.name);
      const { session } = await createAgentSession({ cwd: '/workspace', agentDir: profile.directory, modelRuntime: runtime,
        model, thinkingLevel: 'off', tools, customTools: qualification ? sessionTools.map(tool => qualification.tool(tool)) : sessionTools, resourceLoader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } },
          compaction: { enabled: false }, cacheWarming: 'off' }) });
      if (session.model?.provider !== profile.providerId || session.model.id !== profile.modelId) {
        session.dispose(); throw new Error('WORKER_MODEL_MISMATCH');
      }
      abortSession = () => { void session.abort().catch(() => {}); };
      const abort = () => { interrupted = true; abortSession(); };
      signal.addEventListener('abort', abort, { once: true });
      const unsubscribe = session.subscribe(event => {
        if (event.type === 'turn_start' && gate?.suspended()) abort();
        if (event.type === 'message_end' && event.message.role === 'assistant' && 'content' in event.message && Array.isArray(event.message.content))
          gate?.batch(event.message.content.filter(block => block.type === 'toolCall').length);
      });
      try {
        if (signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
        qualification?.check();
        let prompt = invocation.prompt;
        while (true) {
          await session.prompt(prompt).catch(error => { if (!asked) throw error; });
          if (asked) return { status: 'question' as const, receipt, sessionFile: manager.getSessionFile() ?? null, question: asked };
          if (!gate?.pending() || signal.aborted || interrupted || qualification?.failed()) break;
          // Suspended: the Host (not the model) captures the proposal through the Builder's own binding, then waits for the directive.
          const event = await captureHandoff(invocation.context, options.sandbox, gate.round(), invocation.handoff!.baseCommit, signal);
          const directive = await options.onHandoff!(event);
          if (signal.aborted || interrupted || directive.kind !== 'review-results' || directive.round !== gate.round()) { interrupted = true; break; }
          gate.resume();
          prompt = directive.prompt;
        }
        const status = signal.aborted || interrupted || qualification?.failed() ? 'interrupted' as const : 'completed' as const;
        const sessionFile = manager.getSessionFile() ?? null;
        if (role === 'builder' || !invocation.review) return { status, receipt, sessionFile: manager.getSessionFile() };
        // Reviewer: the complete opinion from the FINAL assistant message is preserved durably BEFORE any notification.
        const last = [...session.messages].reverse().find(message => message.role === 'assistant');
        const finalText = last && 'content' in last && Array.isArray(last.content)
          ? last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : null;
        const composed = composeOpinion({ role, invocationId: invocation.context.invocationId, review: invocation.review, status, finalText, sessionFile,
          model: { providerId: profile.providerId, modelId: profile.modelId }, profile: { id: profile.id, modelBudget: invocation.modelBudget ?? null },
          host: observer.summary(invocation.review.required) });
        const { phaseId: _phase, ...context } = invocation.context;
        const recordedAt = new Date().toISOString();
        const reference = await options.records.record({ ...context, callId: 'review-opinion' }, { kind: 'review-opinion', ...composed, recordedAt });
        // Only the REDACTED protected record leaves this worker, never the raw composed text.
        const page = await options.records.read({ reference, offset: 0, limit: 65536 });
        if (page.state !== 'complete' || page.nextOffset !== page.bytes) throw new Error('PROTECTED_CAPTURE_UNAVAILABLE');
        const { kind: _kind, ...stored } = (JSON.parse(page.data.toString('utf8')) as { event: Record<string, unknown> }).event;
        const opinion: ReviewOpinion = opinionSchema.parse({ ...stored, reference }) as ReviewOpinion;
        return { status, receipt, sessionFile: manager.getSessionFile(), opinion };
      } finally { unsubscribe(); signal.removeEventListener('abort', abort); session.dispose(); }
    } finally { await runtime.settleCredentialWrites(); }
  } finally { await store?.settleCredentialWrites(); }
}
