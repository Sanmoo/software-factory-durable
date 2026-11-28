import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '#factory-pi';
import type { InvestigationShell } from '../sandbox/index.js';
import { openFactoryOAuth } from './factory-oauth.js';
import { budgetFor, qualifyOAuth, type QualificationLimits } from './oauth-qualification.js';
import { openTriagerMcp, type TriagerMcp } from './triager-mcp.js';
import { triagerTools, type TriagerHost } from './triager-tools.js';
import { sessionRefusal, thinkingLevelOf } from './worker-session.js';
import type { ReviewerProfile } from './worker-start.js';

/** The model budget of ONE attempt of a Triager, fixed in the release. */
const triagerModelBudget = 'triager-v1';

type TriagerSessionOptions = {
  profile: ReviewerProfile;
  /** The complete first prompt (the pack's activation template, already filled). Sent as it is: no template of the session expands it. */
  prompt: string;
  /** The shell of THIS attempt's Investigation Environment, held by the process that runs the session. */
  shell: InvestigationShell;
  host: TriagerHost;
  signal: AbortSignal;
  /** Installation root of an OAuth profile's credential store; a profile with its own key needs none. */
  factoryRoot?: string;
  /** The servers and selections of the active MCP Profiles (none: the session has no MCP tool). */
  mcp?: TriagerMcp | undefined;
};
/**
 * `concluded`: the Control accepted a Verdict in this session. `closedBy`: which Host count or failure closed a session that did not end
 * by itself (the attempt's distinct end codes are the Control's).
 */
type TriagerSessionResult = {
  status: 'completed' | 'interrupted';
  concluded: boolean;
  sessionFile: string | null;
  sessionTools: string[];
  /** How many calls of each session tool reached its implementation (operator metadata; never arguments or results). */
  toolCalls: Record<string, number>;
  closedBy: 'requests' | 'tools' | 'provider' | null;
};

const resources = (systemPrompt: string): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  // The `triage` skill travels inside the first prompt: the Triager's shell reaches no pack file, so nothing is offered for it to read.
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources() {},
  async reload() {},
});

/** The profile's model runtime: the Factory OAuth store for the release profile, the profile's own key otherwise. Never a personal one. */
async function openRuntime(options: TriagerSessionOptions, secrets: string[], signal: AbortSignal) {
  const { profile } = options;
  if ('apiKey' in profile) {
    const runtime = await ModelRuntime.create({
      authPath: join(profile.directory, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(profile.directory, 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal,
    });
    runtime.registerProvider(profile.providerId, profile.provider);
    await runtime.setRuntimeApiKey(profile.providerId, profile.apiKey, { signal });
    return { runtime, settle: () => runtime.settleCredentialWrites() };
  }
  if (!options.factoryRoot) throw new Error('WORKER_QUALIFICATION_CLOSED');
  const register = (value: string) => void (secrets.includes(value) || secrets.push(value));
  const store = await openFactoryOAuth({
    factoryRoot: options.factoryRoot,
    excludedRoots: {
      source: fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, ''),
      guest: join(options.factoryRoot, 'environments'),
      profiles: [join(options.factoryRoot, 'r'), join(options.factoryRoot, 'triage')],
    },
    records: { registerSecret: register },
    // No owner of a Sandbox stands behind a Triager: the session itself withholds any tool result carrying a registered value.
    acknowledgeSecrets: async values => values.forEach(register),
    profileDirectory: profile.directory,
    signal,
  });
  const runtime = await ModelRuntime.create({
    credentials: store.credentials,
    modelsPath: null,
    modelsStorePath: join(profile.directory, 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
  });
  return {
    runtime,
    async settle() {
      await runtime.settleCredentialWrites();
      await store.settleCredentialWrites();
    },
  };
}

type Qualification = Pick<ReturnType<typeof qualifyOAuth>, 'check' | 'tool' | 'failed' | 'exhausted' | 'providerFailed'>;

/**
 * The two counts of `triager-v1` for a profile with its own key, which has no OAuth qualification to hold them.
 * One request or tool call past its count closes the session, and a model request that ends in error while the Host did not abort is the
 * provider's failure. Host facts only; the byte bounds and the model pinning of the release profile stay with `qualifyOAuth`.
 */
function countBudget(runtime: ModelRuntime, signal: AbortSignal, abort: () => void, limits: QualificationLimits): Qualification {
  let requests = 0;
  let tools = 0;
  let failed = false;
  let exhausted: 'requests' | 'tools' | null = null;
  let providerFailed = false;
  const close = (by: 'requests' | 'tools') => {
    if (!failed) exhausted = by;
    failed = true;
    abort();
    return new Error('WORKER_QUALIFICATION_CLOSED');
  };
  const observe = (message: { stopReason?: string }) => {
    if (message.stopReason !== 'error' || failed || signal.aborted) return;
    providerFailed = true;
    failed = true;
  };
  const native = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (...args: Parameters<typeof native>) => {
    if (failed || signal.aborted) throw new Error('WORKER_QUALIFICATION_CLOSED');
    if (++requests > limits.requests) throw close('requests');
    const stream = native(...args);
    const push = stream.push.bind(stream);
    stream.push = event => {
      if (event.type === 'error') observe(event.error);
      else if (event.type === 'done') observe(event.message);
      push(event);
    };
    return stream;
  };
  return {
    check() {
      if (failed || signal.aborted) throw new Error('WORKER_QUALIFICATION_CLOSED');
    },
    failed: () => failed,
    exhausted: () => exhausted,
    providerFailed: () => providerFailed,
    tool: tool => ({
      ...tool,
      async execute(...args) {
        if (failed || signal.aborted) throw new Error('WORKER_QUALIFICATION_CLOSED');
        if (++tools > limits.tools) throw close('tools');
        return tool.execute(...args);
      },
    }),
  };
}
type Conversation = { concluded: boolean; interrupted: boolean; abort(): void };

/** The profile's model, and nothing else: an OAuth profile only ever speaks the Responses API. */
function modelOf(runtime: ModelRuntime, profile: ReviewerProfile) {
  const model = runtime.getModel(profile.providerId, profile.modelId);
  if (!model) throw new Error('WORKER_MODEL_UNAVAILABLE');
  if (!('apiKey' in profile) && model.api !== 'openai-responses') throw new Error('WORKER_MODEL_UNAVAILABLE');
  return model;
}

/** A new SDK session over the attempt's temporary directory, with exactly the Triager tools; refused when it is not the profile's model. */
async function openSession(options: TriagerSessionOptions, runtime: ModelRuntime, tools: ToolDefinition[], qualification: Qualification) {
  const { profile } = options;
  const manager = SessionManager.create(options.shell.temporary, join(profile.directory, 'sessions'));
  const { session } = await createAgentSession({
    cwd: options.shell.temporary,
    agentDir: profile.directory,
    modelRuntime: runtime,
    model: modelOf(runtime, profile),
    thinkingLevel: thinkingLevelOf(profile),
    tools: tools.map(tool => tool.name),
    customTools: tools.map(tool => qualification.tool(tool)),
    resourceLoader: resources(profile.systemPrompt),
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: 'off' }),
  });
  const refusal = sessionRefusal(session, profile, !('apiKey' in profile));
  if (refusal) {
    session.dispose();
    throw new Error(refusal);
  }
  return { session, manager };
}

/** How the session ended, from Host facts only: an accepted Verdict is a completed session whatever aborted it afterwards. */
function resultOf(state: Conversation, aborted: boolean, qualification: Qualification): Pick<TriagerSessionResult, 'status' | 'concluded' | 'closedBy'> {
  if (state.concluded) return { status: 'completed', concluded: true, closedBy: null };
  if (!aborted && !state.interrupted && !qualification.failed()) return { status: 'completed', concluded: false, closedBy: null };
  const provider = qualification.providerFailed() ? ('provider' as const) : null;
  return { status: 'interrupted', concluded: false, closedBy: qualification.exhausted() ?? provider };
}

/** The conversation itself: the first prompt, then whatever the model does with its tools until it concludes, stops or is closed. */
async function converse(options: TriagerSessionOptions, runtime: ModelRuntime, secrets: string[], signal: AbortSignal, qualification: Qualification) {
  const state: Conversation = { concluded: false, interrupted: false, abort() {} };
  // After the accepted Verdict the investigation is over: the request itself is refused, not merely aborted later.
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (...args: Parameters<typeof stream>) => {
    if (state.concluded) throw new Error('TRIAGE_CONCLUDED');
    return stream(...args);
  };
  qualification.check();
  const toolCalls: Record<string, number> = {};
  // The client of the active MCP Profiles lives in this process, configured by the attempt's bootstrap alone.
  const mcp = await openTriagerMcp(options.mcp, signal);
  secrets.push(...mcp.secrets);
  const tools = triagerTools(
    {
      shell: options.shell,
      host: options.host,
      withheld: text => secrets.some(secret => text.includes(secret)),
      concluded: () => state.concluded,
      onConcluded() {
        state.concluded = true;
        setImmediate(() => state.abort());
      },
      onCall: tool => void (toolCalls[tool] = (toolCalls[tool] ?? 0) + 1),
    },
    mcp.tools,
  );
  const { session, manager } = await openSession(options, runtime, tools, qualification).catch(async error => {
    await mcp.close();
    throw error;
  });
  state.abort = () => void session.abort().catch(() => {});
  const abort = () => {
    state.interrupted = true;
    state.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
    await session.prompt(options.prompt).catch(error => {
      if (!state.concluded) throw error;
    });
    return {
      ...resultOf(state, signal.aborted, qualification),
      sessionFile: manager.getSessionFile() ?? null,
      sessionTools: tools.map(tool => tool.name).sort(),
      toolCalls,
    };
  } finally {
    signal.removeEventListener('abort', abort);
    session.dispose();
    await mcp.close();
  }
}

/**
 * One session of the `triager` role. Its tools are the shell and read bound to the attempt's Investigation Environment, the
 * clone request, the tools of the active MCP Profiles and `concluir_triagem`; there is no tracker write and no `ask_user`. An accepted Verdict ends it: no further model
 * request or tool call starts. Never continued: every attempt is a new session.
 */
export async function runTriagerSession(options: TriagerSessionOptions): Promise<TriagerSessionResult> {
  const { profile } = options;
  if (options.signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
  const closed = new AbortController();
  const signal = AbortSignal.any([options.signal, closed.signal]);
  const limits = budgetFor('triager', triagerModelBudget);
  if (Buffer.byteLength(options.prompt) > limits.promptBytes) throw new Error('WORKER_QUALIFICATION_CLOSED');
  const secrets: string[] = 'apiKey' in profile ? [profile.apiKey] : [];
  const safe = () => !secrets.some(secret => options.prompt.includes(secret));
  const { runtime, settle } = await openRuntime(options, secrets, signal);
  try {
    // The Host budget of the attempt (`triager-v1`) bounds every session: the release profile's through its qualification (requests,
    // tool calls, bytes), a profile with its own key through the two counts.
    const qualification =
      'apiKey' in profile
        ? countBudget(runtime, signal, () => closed.abort(), limits)
        : qualifyOAuth(runtime, signal, safe, () => closed.abort(), limits, thinkingLevelOf(profile));
    return await converse(options, runtime, secrets, signal, qualification);
  } finally {
    await settle();
  }
}
