// A Control that investigates Triage requests, for the Triage integration tests. Real Control,
// SQLite, Triager session (the worker's own code, hosted in this process because the in-process environment only gives the shell here),
// real git for the clones. Doubled at the third-party boundary only: the trackers, the model provider (a scripted `fetch`) and the
// repository upstream (a local file:// repository with a credential double).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type {
  AccessDependencies,
  Control,
  ExecutionPorts,
  TicketSource,
  TriageClock,
  TriagePorts,
  TriageRequest,
  TriageRequestsView,
} from '../../src/control/types.js';
import { openStore } from '../../src/control/durable/store.js';
import { readTriageVerdictText } from '../../src/control/durable/triage-requests.js';
import { createInvestigationClones, type InvestigationAgent } from '../../src/sandbox/index.js';
import { createTriager, createTriagerDetails, runTriagerAgent, type McpRegistration } from '../../src/workers/index.js';
import { until } from '../runner/budget.js';
import { createInProcessInvestigationEnvironment } from '../sandbox/investigation-in-process.js';
import { githubDoubles, manualClock, scope, type Remote } from './doubles.js';
import { jiraDoubles, type JiraRemote } from './jira-doubles.js';

export const repositoryCanary = 'ghs_' + 'TRIAGErepositoryCANARY';
type ModelAnswer = { name: string; arguments: unknown }[] | string | typeof hang | typeof unavailable;
/**
 * One scripted answer of the model: the tool calls of the turn, or its final text. It receives the request body the SDK sent, and may
 * answer later (a promise the test resolves).
 */
export type ModelTurn = (body: string) => ModelAnswer | Promise<ModelAnswer>;
/** A model request that never answers: it ends only when the session aborts it. */
export const hang = Symbol('hang');
/** A model request the provider answers with an error. */
export const unavailable = Symbol('unavailable');
export const call = (name: string, input: unknown) => [{ name, arguments: input }];
/** What every scripted answer reports as its consumption (the Triages' line of `usage`). */
export const turnTokens = { input: 11, output: 7 };
const usage = { prompt_tokens: turnTokens.input, completion_tokens: turnTokens.output, total_tokens: turnTokens.input + turnTokens.output };
const sse = (choices: unknown[]) =>
  choices.map(choice => `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [choice] })}\n\n`).join('') +
  `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage })}\n\n` +
  'data: [DONE]\n\n';
function answer(turn: Exclude<ModelAnswer, typeof hang | typeof unavailable>, request: number): Response {
  const choices =
    typeof turn === 'string'
      ? [
          { index: 0, delta: { role: 'assistant', content: turn }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ]
      : [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: turn.map((item, index) => ({
                index,
                id: `call-${request}-${index}`,
                type: 'function',
                function: { name: item.name, arguments: JSON.stringify(item.arguments) },
              })),
            },
            finish_reason: null,
          },
          { index: 0, delta: {}, finish_reason: 'tool_calls' },
        ];
  return new Response(sse(choices), { headers: { 'Content-Type': 'text/event-stream' } });
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x',
    },
  }).trim();
const profile = {
  id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const,
  systemPrompt: 'Factory Triager policy.',
  providerId: 'fixture',
  modelId: 'm',
  apiKey: 'synthetic-key',
  provider: {
    api: 'openai-completions' as const,
    baseUrl: 'https://offline.invalid',
    models: [
      {
        id: 'm',
        name: 'm',
        reasoning: false,
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 1000,
      },
    ],
  },
};
/** The last text the session returned to the model for a tool call, as it travels in the next request body. */
export function toolResults(body: string): string[] {
  const { messages } = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
  return messages
    .filter(message => message.role === 'tool')
    .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
}
export const toolNames = (body: string) => (JSON.parse(body) as { tools: { function: { name: string } }[] }).tools.map(tool => tool.function.name).sort();
/** The first user message of the session: the Triager's first prompt. */
export function firstPrompt(body: string): string {
  const { messages } = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
  const { content } = messages.find(message => message.role === 'user')!;
  return typeof content === 'string' ? content : (content as { text?: string }[]).map(part => part.text ?? '').join('');
}

/**
 * The investigation clock of the tests: calendar time that only moves by `advance`, which also ends the sleeps then due. An
 * investigation therefore never runs out of time by itself.
 */
export function investigationClock(start = Date.UTC(2026, 0, 1)) {
  let now = start;
  let sleeps: { due: number; wake(): void }[] = [];
  const clock: TriageClock = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>(resolve => {
        const sleep = { due: now + ms, wake: resolve };
        sleeps.push(sleep);
        signal.addEventListener(
          'abort',
          () => {
            sleeps = sleeps.filter(item => item !== sleep);
            resolve();
          },
          { once: true },
        );
      }),
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      const due = sleeps.filter(sleep => sleep.due <= now);
      sleeps = sleeps.filter(sleep => sleep.due > now);
      for (const sleep of due) sleep.wake();
    },
  };
}

export async function triageWorld(
  t: { after(fn: () => Promise<void> | void): void },
  options: {
    github?: Remote;
    jira?: JiraRemote;
    sources: TicketSource[];
    script: ModelTurn[];
    ports?: Partial<TriagePorts>;
    /** Execution ports of the Control (Works and Slots beside the Triage). */
    execution?: ExecutionPorts;
    /** The executable repositories (default: `acme/project`, `acme/other` and `acme/third`). */
    repositories?: (typeof scope)[];
    /** The registered MCP servers and Profiles, and the active ones. */
    mcp?: McpRegistration;
    /** Private files written under `<root>/credentials` before the Control starts (name -> content). */
    credentials?: Record<string, string>;
    /** Wraps the in-process environment the Control uses (to inject what the Host would observe). */
    environment?: (port: TriagePorts['environment']) => TriagePorts['environment'];
    /**
     * The access of the Control, composed anew at every start, in place of the tracker doubles (`doubles` is what this
     * world would have used). A composed journey gives the production composition over the gh world or the Jira HTTP world here.
     */
    access?: (doubles: AccessDependencies) => AccessDependencies | Promise<AccessDependencies>;
  },
) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-triage-inv-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(dir, 'e'), { mode: 0o700 });
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  for (const [name, content] of Object.entries(options.credentials ?? {})) await writeFile(join(root, 'credentials', name), content, { mode: 0o600 });
  // The upstream every candidate is fetched from: two commits on `main`, so "with history" is observable.
  const upstream = join(dir, 'upstream');
  await mkdir(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'cart.js'), 'export const total = items => items.length;\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', 'cart: first total');
  await writeFile(join(upstream, 'cart.js'), 'export const total = items => items.reduce((sum, item) => sum + item.price, 0);\n');
  git(upstream, 'commit', '-q', '-am', 'cart: sum the prices');

  const bodies: string[] = [];
  const script = [...options.script];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    // Only the model provider is doubled here: a local MCP source of the test is reached for real.
    if (new URL(input instanceof Request ? input.url : input).hostname === '127.0.0.1') return originalFetch(input, init);
    const body = input instanceof Request ? await input.text() : String(init?.body);
    bodies.push(body);
    const turn = (await script.shift()?.(body)) ?? 'The scripted provider has no further turn.';
    if (turn === unavailable) return new Response('{"error":{"message":"overloaded"}}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    if (turn !== hang) return answer(turn, bodies.length);
    const signal = input instanceof Request ? input.signal : init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const aborted = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) aborted();
      else signal?.addEventListener('abort', aborted, { once: true });
    });
  };
  t.after(() => void (globalThis.fetch = originalFetch));

  const agents: InvestigationAgent[] = [];
  const environment = createInProcessInvestigationEnvironment({
    root: join(dir, 'e'),
    // The agent of the attempt, run here: the real Triager agent and session over the shell this environment gives.
    launch(agent) {
      agents.push(agent);
      const lifetime = new AbortController();
      const done = runTriagerAgent(agent.argv.at(-1)!, { signal: lifetime.signal, shell: attempt => environment.shell(attempt) }).catch(() => {});
      return {
        async stop() {
          lifetime.abort();
          await done;
        },
      };
    },
  });
  const triager = createTriager({
    root,
    profile,
    skillPack: 'factory-skills-v13',
    ...(options.mcp ? { mcp: options.mcp } : {}),
    agent: bootstrap => ({ executable: process.execPath, argv: [bootstrap], env: { PATH: '/usr/bin:/bin' } }),
  });
  const fetched: string[] = [];
  const clones = createInvestigationClones({
    root,
    fetch: {
      async fetch(request: { repository: string }) {
        fetched.push(request.repository);
        return { token: repositoryCanary, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
      async revoke() {
        return { kind: 'revoked' };
      },
    } as unknown as Parameters<typeof createInvestigationClones>[0]['fetch'],
    remoteUrl: () => `file://${upstream}`,
  });
  const time = investigationClock();
  const ports: TriagePorts = {
    release: 'release-under-test',
    environment: options.environment?.(environment) ?? environment,
    limits: { memoryGiB: 2, processes: 512, commandSeconds: 120 },
    investigationMinutes: 15,
    capacity: 1,
    attempts: 2,
    clock: time.clock,
    triager: { activate: request => triager.activate(request) },
    clones,
    ...options.ports,
  };
  const remote = options.github ?? { issues: [], pulls: {} };
  const github = githubDoubles(remote);
  const jira = jiraDoubles(options.jira ?? { cards: [] });
  const storagePath = join(dir, 'control.sqlite');
  const repositories = options.repositories ?? [scope, { ...scope, repository: 'acme/other' }, { ...scope, repository: 'acme/third' }];
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  /** Starts a Control over the same storage and waits for its first complete polling iteration (the first investigation pass included). */
  async function start() {
    const time = manualClock();
    const doubles: AccessDependencies = {
      tracker: github.tracker,
      repository: github.repository,
      repositories,
      sources: options.sources,
      trackers: { jira: jira.tracker },
    };
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      access: options.access ? await options.access(doubles) : doubles,
      polling: { intervalSeconds: 60, clock: time.clock },
      triage: ports,
      triageDetails: createTriagerDetails(root),
      ...(options.execution ? { execution: options.execution } : {}),
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() {
    current!.stop.abort();
    assert.deepEqual(await current!.running, { kind: 'clean' });
  }
  t.after(async () => {
    if (current && !current.stop.signal.aborted) await stop();
  });
  const poll = async () => {
    current!.time.advance();
    await current!.time.sleeping();
  };
  const view = async () => (await current!.control.inspect({ kind: 'triage-requests' })) as TriageRequestsView;
  const requests = async () => (await view()).requests;
  /** The request at `index` once it is in `state` and none of its attempts is open. */
  const settled = (index: number, state: TriageRequest['state']) => {
    let seen = 'nothing';
    return until(
      () => `request ${index} to be ${state} (last seen: ${seen}; ${bodies.length} model requests)`,
      async (): Promise<TriageRequest | undefined> => {
        const request = (await requests())[index];
        seen = request ? `${request.state} ${request.attempts?.map(attempt => attempt.end?.code ?? 'open').join(',') ?? ''}` : 'no request';
        return request?.state === state && request.attempts?.every(attempt => attempt.end) !== false ? request : undefined;
      },
    );
  };
  /** The first request once its latest attempt is over (its end recorded), whatever became of it. */
  const investigated = (index = 0) =>
    until(`the attempt of request ${index} to end`, async (): Promise<TriageRequest | undefined> => {
      const request = (await requests())[index];
      return request?.attempts?.at(-1)?.end ? request : undefined;
    });
  /** The recorded Verdict text, read from the storage after the Control stopped. */
  async function verdictText(triage_request_id: string) {
    const store = await openStore(storagePath);
    try {
      return await readTriageVerdictText(store.session, triage_request_id);
    } finally {
      await store.close();
    }
  }
  /** Every file of the attempts' private directories (bootstrap, session transcript), by path. */
  async function attemptFiles() {
    const base = join(root, 'triage');
    const files: Record<string, string> = {};
    for (const entry of await readdir(base, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) files[join(entry.parentPath, entry.name)] = await readFile(join(entry.parentPath, entry.name), 'utf8');
    return files;
  }
  const transcript = async (request: TriageRequest) => readFile(join(root, request.attempts!.at(-1)!.end!.transcript!), 'utf8');
  return {
    dir,
    root,
    /** The Control storage of this world (an upgrade inspects it; a live copy of it is what a killed controller leaves). */
    storagePath,
    /** The Triage ports every start of the Control composes; a test changes them between two starts (another release, another pack). */
    ports,
    upstream,
    git,
    bodies,
    agents,
    environment,
    fetched,
    github,
    remote,
    jira,
    start,
    stop,
    poll,
    requests,
    view,
    settled,
    time,
    control: () => current!.control,
    investigated,
    verdictText,
    attemptFiles,
    transcript,
  };
}
/** Every call that would write to a tracker, or that the doubles do not model. */
export const trackerWrites = (methods: string[]) =>
  methods.filter(method => method.startsWith('unexpected:') || /post|publish|upsert|write|close|component|label(?!History)/i.test(method));
