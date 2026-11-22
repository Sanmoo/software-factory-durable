import type { ExecutionPorts, ExecutionView, ListView, RuntimeInventory, WorkView } from '../../src/control/index.js';

// TEST ONLY. Ticket 26 one-shot real recovery qualification recipe. Import and `--plan` are inert. Every other phase is a REAL effect requiring
// an explicit operator grant: real GitHub App installation tokens (read-only grants: issuance and self-revocation), real Gondolin/KVM VMs under
// the user systemd manager and real Builder workers. The model is replaced by the scripted local provider (recovery26-provider.ts), which runs
// in the ORCHESTRATOR process: no model request. The `run` phase orchestrates FOUR controller children on the SAME storage, each launched as
// the production owner is (`flock --exclusive --nonblock --no-fork <lock> node …`), and SIGKILLs or stops them at defined cuts:
//   a-tool        activation 1 runs a long guest command → the controller is SIGKILLed (VM + worker survive under systemd)
//   b-reservation boot reconciliation stops the survivor (real host stop) and requests ONE recovery (5 s wait) → SIGKILL at the recovery's
//                 preparation entry (reservation committed, nothing started)
//   c-spawn       boot reconciliation releases that reservation (proven non-start) → SIGKILL right after the recovery's Workers.activate request
//   d-final       boot reconciliation discovers (or proves absent) the start receipt after host cessation → the recovery completes on the preserved
//                 checkout with the explicit recovery instruction → clean administrative stop (exit 0)
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.

const root = '/home/sanmoo/software-factory-test/y5';
// v1 was consumed by the first real run (its tool-cut oracle could not pass: see docs/evidence/26-*.md).
const observations = `${root}/q26-recovery-v2`;
const revision = 'q26-recovery-v2';
const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const steps = ['a-tool', 'b-reservation', 'c-spawn', 'd-final'] as const;
type Step = typeof steps[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const pollingSeconds = 30;
const stepDeadlineMs = 10 * 60 * 1000;
/** Per child: initial grant + at most one more; whole run: one grant per activation (4 max). */
const maxIssuancesPerStep = 2;
const node = '/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node';

export function plan() {
  return { revision, root, observations, phases, steps, repository, expectedTicket, configuration, guestAssets, pollingSeconds,
    model: 'none: scripted local provider on 127.0.0.1:18726 in the orchestrator process (openai-completions SSE): activation 1 = `/implement` (listing, then `sleep 600`); activations 2-4 must be the Factory recovery instruction (listing, then Complete); at most 4 activations / 12 requests; no OAuth/model request',
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only',
      writes: 'POST /app/installations/{id}/access_tokens (issuance) and DELETE /installation/token (self-revocation); nothing else' },
    effects: [
      'preflight: read-only GitHub (label listing must contain exactly Ticket #3; ticket + native blocked_by); read-only host inventory of root (environments/cache/run) recorded as the PRE-EXISTING set; every pre-existing environment observed (Sandbox.observe host path) and required ceased',
      `run: new Control storage in observations; 4 controller children, each under \`flock --exclusive --nonblock --no-fork ${observations}/control.lock\` with verifyControllerLock, a fresh listed host inventory (minus the recorded pre-existing set) and polling ${pollingSeconds} s; cuts a-tool (SIGKILL during a running guest command), b-reservation (SIGKILL at the recovery's preparation entry), c-spawn (SIGKILL right after the recovery's activation request), d-final (reconcile, complete on the preserved checkout, clean stop); ${stepDeadlineMs / 60000} min deadline per child`,
      'inspect: read-only: an exclusive private COPY of the run storage is opened (never the original); Records receipts listed (read-only find); secret-shape scan (counts only); no host git, no guest-writable tree read',
      'stop-environment: only if the recorded Execution may still run: Sandbox.observe of its environment, Sandbox.stop of the exact current boot when observed active',
    ],
    guards: ['one-shot intent tombstones per phase AND per child step', `at most ${maxIssuancesPerStep} Builder issuances per child`, 'prepare/activate only for the Work of Ticket #3, at most once per child',
      'no retry; a held step ends the run', 'no remove/cleanup', 'no push/PR (read-only grants)', 'Records/host reads are confined, no-follow; host git never runs in a guest-writable tree'],
    expected: [
      'a-tool: the orchestrator SIGKILLs the child only after the guest start marker /workspace/.q26-a1-c1-started is OBSERVED by a confined no-follow host read of the environment workspace (and the end marker is absent); its boot stays active under systemd (observed by b)',
      'b-reservation: status.recovery {reconciled 1, ceased 1}; Execution 1: end failure CONTROLLER_CRASH, cessation confirmed (sandbox-stop of the survivor boot), recovery[0] {start confirmed:notification, decision operational-recovery}; pendingRecovery waitSeconds 5; the survivor unit inactive with an empty cgroup before any new prepare',
      'c-spawn: Execution 2 (recovery basis OPERATIONAL_RECOVERY) reconciled as not-started (no-boot-before-preparation-recorded), reservation released (recoveries.consumed unchanged), Work requeued',
      'd-final: Execution 3 (spawn cut) cessation confirmed; start either receipt-discovered (consumed exactly once) or not-started (receipt absent after cessation); Execution 4 activated only after Execution 3\'s boot stopped, on a NEW boot of the SAME environment with checkout reused, phaseId builder-recovery, ends completed with cessation confirmed; the d child exits 0 (clean stop)',
      'budget: recoveries.consumed == number of confirmed recovery starts (1 or 2), reserved null; activations <= 4; provider: activation 1 call 1 (the long command) emitted, never its result (no a1-c1-end); toolCut: start marker present, end marker absent at inspect; every later activation prompt is the recovery instruction',
      'no ghs_/PRIVATE KEY in storage, observations or records',
    ],
  };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(text)) throw new Error('OBSERVATION_SECRET_SHAPE');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const read = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8')) as Record<string, unknown>;
  return { fs, save, exists, read };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}

/** Listed host inventory minus the environments recorded as pre-existing at preflight (earlier qualifications of this root, not this storage). */
export function ownInventory(listed: Omit<RuntimeInventory, 'kind' | 'observedAt'>, preexisting: string[], at: string): RuntimeInventory {
  return { kind: 'listed', observedAt: at, environments: listed.environments.filter(item => !preexisting.includes(item.environment)),
    cache: listed.cache.filter(item => item.repositoryId === expectedTicket.repositoryId), unknown: listed.unknown };
}

export function needsStop(execution: ExecutionView): boolean {
  if (!execution.dispatch.environment || execution.state === 'released') return false;
  return !(execution.state === 'ended' && execution.end?.cessation === 'confirmed');
}

type Event = { at: string; step: Step } & Record<string, unknown>;
/** Verdict from the stored Work, the child events and the provider observation (no secret involved). */
/** Guest markers read on the host: the long command had started (durable file) and had not finished when the controller was killed. */
export function toolCutProof(markers: { started: Buffer | null; ended: Buffer | null }) {
  const started = markers.started?.toString('utf8') === 'started\n';
  const ended = markers.ended !== null;
  return { started, ended, proven: started && !ended };
}
type ProviderObservation = { activations: number; results: { markers: string[]; activation?: number }[]; emitted: { activation: number; call: number }[];
  prompts: { activation: number; kind: string }[]; held: boolean };
/** The provider sees a tool OUTPUT only in the next request, which a cut during c1 never sends: require c1 emitted and never answered. */
export function providerScheduleCheck(provider: ProviderObservation): boolean {
  const markers = provider.results.flatMap(result => result.markers);
  return !provider.held && provider.activations <= 4 && provider.emitted.some(item => item.activation === 1 && item.call === 1) && !markers.includes('a1-c1-end') &&
    !provider.results.some(result => result.activation === 1 && result.markers.some(marker => marker.startsWith('a1-c1'))) &&
    provider.prompts.every(prompt => prompt.activation === 1 ? prompt.kind === 'implement' : prompt.kind === 'recovery');
}
export function assess(input: { work: WorkView | undefined; events: Event[]; exits: Record<string, string>; provider: ProviderObservation;
  toolCut?: { started: boolean; ended: boolean; proven: boolean } }) {
  const all = input.work ? [...input.work.previousExecutions, ...(input.work.execution ? [input.work.execution] : [])] : [];
  const [e1, e2, e3, e4] = all;
  const at = (step: Step, call: string) => input.events.filter(item => item.step === step && item.call === call);
  const stopBeforeActivate = (() => {
    const d = input.events.filter(item => item.step === 'd-final');
    const stop = d.findIndex(item => item.call === 'stop' && (item.input as { boot?: string } | undefined)?.boot === e3?.dispatch.boot && (item.result as { cessationConfirmed?: boolean } | undefined)?.cessationConfirmed);
    const activate = d.findIndex(item => item.call === 'activate');
    return e3?.dispatch.boot ? stop >= 0 && activate > stop : activate >= 0;
  })();
  const e3Start = e3?.recovery?.[0]?.start;
  const confirmedRecoveries = [e2, e3, e4].filter(item => item?.charge?.kind === 'recovery' && item.charge.state === 'consumed').length;
  const checks = {
    toolCutReconciled: e1?.end?.outcome === 'failure' && e1.end.code === 'CONTROLLER_CRASH' && e1.end.cessation === 'confirmed' && e1.recovery?.[0]?.cessation.basis === 'sandbox-stop' &&
      e1.recovery[0].decision === 'operational-recovery' && e1.recovery[0].start.kind === 'confirmed',
    survivorStoppedBeforeNewWork: at('b-reservation', 'stop').some(item => (item.input as { boot?: string }).boot === e1?.dispatch.boot && (item.result as { cessationConfirmed?: boolean }).cessationConfirmed) &&
      input.events.findIndex(item => item.step === 'b-reservation' && item.call === 'stop') < input.events.findIndex(item => item.step === 'b-reservation' && item.call === 'prepare'),
    reservationCutReleased: e2?.state === 'released' && e2.recovery?.[0]?.start.kind === 'not-started' && e2.charge?.state === 'released' && e2.interruption?.reason === 'OPERATIONAL_RECOVERY',
    spawnCutSettled: e3?.recovery?.[0]?.cessation.result === 'confirmed' && (e3Start?.kind === 'confirmed' ? e3.charge?.state === 'consumed' : e3Start?.kind === 'not-started' && e3.charge?.state === 'released'),
    noTwoWriters: stopBeforeActivate,
    recoveryCompletedOnPreservedContext: e4?.end?.outcome === 'completed' && e4.end.cessation === 'confirmed' && e4.interruption?.reason === 'OPERATIONAL_RECOVERY' &&
      e4.request.checkout === e1?.request.checkout && e4.request.branch === e1?.request.branch && e4.dispatch.environment === e1?.dispatch.environment && e4.dispatch.boot !== e1?.dispatch.boot &&
      at('d-final', 'prepare-result').some(item => (item.result as { checkout?: { reused?: boolean } }).checkout?.reused === true),
    singleConsumption: input.work?.budget?.recoveries.consumed === confirmedRecoveries && input.work.budget.recoveries.reserved === null,
    cleanFinalStop: input.exits['d-final'] === 'exit:0',
    providerSchedule: providerScheduleCheck(input.provider),
    toolCutProven: input.toolCut?.proven === true,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

/** One controller child (production-like owner under flock). Events are appended durably so a SIGKILL never loses what happened before it. */
async function child(step: Step) {
  const { fs } = await io();
  const { appendFileSync } = await import('node:fs');
  const events = `${observations}/${step}-events.jsonl`;
  const log = (event: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), step, ...event });
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(line)) throw new Error('OBSERVATION_SECRET_SHAPE');
    appendFileSync(events, `${line}\n`, { mode: 0o600 });
  };
  // Only the orchestrator launches a step: its intent tombstone must exist, and a step runs once (exclusive start marker).
  if (!(await fs.access(`${observations}/${step}-intent.json`).then(() => true, () => false))) throw new Error('STEP_INTENT_REQUIRED');
  const marker = await fs.open(`${observations}/${step}-child-started.json`, 'wx', 0o600);
  try { await marker.writeFile(JSON.stringify({ step, pid: process.pid, at: new Date().toISOString() })); await marker.sync(); } finally { await marker.close(); }
  const { verifyControllerLock } = await import('../../src/platform/host/index.js');
  await verifyControllerLock(`${observations}/control.lock`);
  const preexisting = (JSON.parse(await fs.readFile(`${observations}/preflight-result.json`, 'utf8')) as { preexisting: string[] }).preexisting;
  const { createSandbox, inventoryRuntime, reconcileInterruptedCaches } = await import('../../src/sandbox/index.js');
  // Same boot path as the production owner: repair-free cache reconciliation, then the listed inventory.
  const caches = await reconcileInterruptedCaches(root);
  log({ call: 'cache-reconciliation', caches });
  const inventory = ownInventory(await inventoryRuntime(root), preexisting, new Date().toISOString());
  log({ call: 'inventory', inventory });
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
  const { createWorkers } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const provider = await import('./recovery26-provider.js');
  const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }) });
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
    systemPrompt: 'Ticket 26 recovery qualification. Follow the scripted tool schedule.', providerId: 'q26-qualification-fixture', modelId: 'q26-model', apiKey: provider.apiKey,
    provider: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.port}/q26-v1`, models: [{ id: 'q26-model', name: 'Q26', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } });
  const real = createBuilderCredentials({ github, repositories: [repository] });
  let issued = 0, prepared = 0, activated = 0;
  const allowed = async (workId: string) => {
    const shown = await control.inspect({ kind: 'show', work_id: workId });
    return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
  };
  const kill = (cut: string) => { log({ call: 'cut', cut }); process.kill(process.pid, 'SIGKILL'); };
  const ports: ExecutionPorts = { configuration, capacity: 1, builder: {},
    credentials: {
      async issue(context) { if (++issued > maxIssuancesPerStep) throw new Error('RECIPE_ISSUANCE_LIMIT'); log({ call: 'issue', context }); const grant = await real.issue(context); log({ call: 'issued', metadata: grant.metadata }); return grant; },
      async revoke(grant) { const result = await real.revoke(grant); log({ call: 'revoke', result }); return result; },
    },
    sandbox: {
      async prepare(input) {
        log({ call: 'prepare', workId: input.workId });
        if (step === 'b-reservation') kill('reservation');
        if (++prepared !== 1 || !await allowed(input.workId)) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
        const result = await sandbox.prepare(input); log({ call: 'prepare-result', result }); return result;
      },
      async start(input) { const result = await sandbox.start(input); log({ call: 'start', result }); return result; },
      async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
      async observe(input) { const result = await sandbox.observe(input); const { storage: _storage, ...lifecycle } = result; log({ call: 'observe', input, result: lifecycle }); return result; },
    },
    workers: {
      async activate(invocation, delivery, handlers) {
        log({ call: 'activate', context: invocation.context, credentialDelivered: delivery?.credential !== undefined });
        // A refusal known to precede any launch (proven non-start for the Control), never an uncertain start.
        if (++activated !== 1) throw new Error('WORKER_LAUNCH_INVALID');
        const handle = await workers.activate(invocation, delivery, handlers);
        log({ call: 'activation-requested', worker: handle.worker });
        if (step === 'c-spawn') kill('spawn');
        void handle.started.then(start => log({ call: 'started', receipt: start.receipt }), (error: Error) => log({ call: 'start-uncertain', code: error.message.slice(0, 64) }));
        void handle.completed.then(done => log({ call: 'completed', status: done.status }), (error: Error) => log({ call: 'completion-uncertain', code: error.message.slice(0, 64) }));
        return handle;
      },
      async deliver(worker, directive) { const result = await workers.deliver(worker, directive); log({ call: 'deliver', directive: directive.kind, result }); return result; },
      async observeStart(input) { const result = await workers.observeStart(input); log({ call: 'observe-start', input, result }); return result; },
    } };
  const control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: inventory,
    access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] }, polling: { intervalSeconds: pollingSeconds }, execution: ports });
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  const running = control.run(stop.signal);
  const deadline = Date.now() + stepDeadlineMs;
  const list = async () => await control.inspect({ kind: 'list' }) as ListView;
  let reported = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await control.inspect({ kind: 'status' }) as { recovery: unknown; dispatch: string; dispatchReason: string | null };
    if (!reported && status.recovery) { reported = true; log({ call: 'reconciled', status }); process.stdout.write('RECONCILED\n'); }
    const work = (await list()).works.find(item => item.ticket.number === expectedTicket.number);
    const execution = work?.execution;
    if (step === 'a-tool' && execution?.state === 'started' && activated === 1) process.stdout.write('STARTED\n');
    if (step === 'd-final' && activated === 1 && execution?.state === 'ended' && execution.slot.held === false) break;
    if (execution && ['held'].includes(execution.state)) { log({ call: 'held', execution }); break; }
  }
  log({ call: 'final', list: await list() });
  stop.abort();
  const outcome = await running;
  log({ call: 'outcome', outcome });
  process.exit(outcome.kind === 'clean' ? 0 : 1);
}

async function runChild(step: Step, cut: (output: string, killChild: () => void) => Promise<void> | void) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { save } = await io();
  await save(`${step}-intent`, { revision, step, at: new Date().toISOString() });
  const owner = spawn('flock', ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '73', `${observations}/control.lock`, node,
    fileURLToPath(import.meta.url), 'child', step], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1',
      // systemd --user of THIS account (Sandbox start/stop/observe), derived from the uid like the other recipes; no other inherited variable.
      HOME: process.env.HOME ?? '', XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus` } });
  let output = '';
  const timer = setTimeout(() => owner.kill('SIGTERM'), stepDeadlineMs + 60000);
  const ended = new Promise<string>(resolve => owner.once('exit', (code, signal) => resolve(signal ? `signal:${signal}` : `exit:${code}`)));
  owner.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); void cut(output, () => owner.kill('SIGKILL')); });
  const result = await ended;
  clearTimeout(timer);
  return result;
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists, read } = await io();
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { tracker } = await compose();
      const listing = await tracker.listCandidates(repository);
      if (listing.kind !== 'observed' || listing.candidates.length !== 1 || listing.candidates[0]!.number !== expectedTicket.number ||
        listing.repositoryId !== expectedTicket.repositoryId) { await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD'); }
      const graph = await tracker.readDependencyGraph(listing.candidates[0]!);
      const { createSandbox, inventoryRuntime } = await import('../../src/sandbox/index.js');
      const listed = await inventoryRuntime(root);
      const sandbox = createSandbox({ root, guestAssets });
      const observed = [];
      for (const item of listed.environments) {
        const { storage: _storage, ...lifecycle } = await sandbox.observe({ environment: item.environment as never });
        observed.push({ environment: item.environment, condition: lifecycle.condition, cessationConfirmed: lifecycle.cessationConfirmed });
      }
      const ceased = observed.every(item => item.cessationConfirmed || item.condition === 'removed');
      const cache = listed.cache.filter(item => item.repositoryId === expectedTicket.repositoryId);
      if (!ceased || listed.unknown.length || cache.some(item => item.state !== 'idle')) { await save('preflight-held', { observed, unknown: listed.unknown, cache }); throw new Error('PRECONDITION_HELD'); }
      // Recipe decision: every environment present now belongs to an EARLIER qualification (not this new storage) and is ceased.
      await save('preflight-result', { status: 'success', ticket: listing.candidates[0], graph: { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems },
        preexisting: listed.environments.map(item => item.environment), observed, cache });
      const lock = await fs.open(`${observations}/control.lock`, 'wx', 0o600); await lock.close();
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'run') {
      const provider = await import('./recovery26-provider.js');
      const model = await provider.startProvider();
      const exits: Record<string, string> = {};
      try {
        // a-tool: SIGKILL only once the guest start marker of the long command is OBSERVED on the host (confined, no-follow, bounded read of the
        // environment's workspace) and its end marker is absent; the environment comes from the child's own durable prepare event.
        const { readConfined } = await import('../../src/sandbox/index.js');
        const markers = async () => {
          const text = await fs.readFile(`${observations}/a-tool-events.jsonl`, 'utf8').catch(() => '');
          const prepared = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Event).find(item => item.call === 'prepare-result');
          const environment = (prepared?.result as { environment?: string } | undefined)?.environment;
          if (!environment || !/^env-[a-f0-9]{64}$/.test(environment)) return null;
          const workspace = `${root}/environments/${environment}/workspace`;
          const read = (name: string) => readConfined(workspace, name, 64).catch(() => null);
          return { environment, started: await read('.q26-a1-c1-started'), ended: await read('.q26-a1-c1-ended') };
        };
        let armed = false;
        exits['a-tool'] = await runChild('a-tool', (output, killChild) => {
          if (armed || !output.includes('STARTED')) return;
          const waitForMarker = async () => {
            for (let i = 0; i < 300; i++) {
              const observed = await markers();
              if (observed && toolCutProof(observed).proven) {
                await save('a-tool-cut', { at: new Date().toISOString(), environment: observed.environment, proof: toolCutProof(observed) });
                killChild(); return;
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            await save('a-tool-cut', { at: new Date().toISOString(), proof: null, code: 'START_MARKER_NOT_OBSERVED' });
            killChild();
          };
          armed = true; void waitForMarker();
        });
        if (exits['a-tool'] !== 'signal:SIGKILL') throw new Error('CUT_A_NOT_REACHED');
        // b/c kill themselves at their cut; d stops cleanly by itself.
        for (const step of ['b-reservation', 'c-spawn', 'd-final'] as const) {
          exits[step] = await runChild(step, () => {});
          if (step !== 'd-final' && exits[step] !== 'signal:SIGKILL') throw new Error(`CUT_${step.toUpperCase().replace('-', '_')}_NOT_REACHED`);
        }
      } finally {
        await save('run-provider', { provider: model.observation(), exits });
        await model.close();
      }
      return;
    }
    // Authority is the recipe's own storage, opened ONLY as a private copy (the original is never written by inspect/stop).
    const { openControl } = await import('../../src/control/index.js');
    const { snapshotStorage } = await import('./review12-qualification.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' }) as ListView;
    const halt = new AbortController(); halt.abort();
    await stored.run(halt.signal);
    const work = list.works.find(item => item.ticket.number === expectedTicket.number);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    if (phase === 'inspect') {
      const { secretScan } = await import('./credential20-qualification.js');
      const { createRecords } = await import('../../src/records/index.js');
      const events: Event[] = [];
      for (const step of steps) {
        const text = await fs.readFile(`${observations}/${step}-events.jsonl`, 'utf8').catch(() => '');
        for (const line of text.split('\n')) if (line) events.push(JSON.parse(line) as Event);
      }
      const provider = await read('run-provider') as { provider: Parameters<typeof assess>[0]['provider']; exits: Record<string, string> };
      const receipts = await (await createRecords({ root })).find({ workId: work.work_id, callId: 'worker-start' });
      // The cut proof again at inspect (read-only, confined): the long command started and never finished.
      const { readConfined } = await import('../../src/sandbox/index.js');
      const workspace = `${root}/environments/${work.execution.dispatch.environment}/workspace`;
      const toolCut = toolCutProof({ started: await readConfined(workspace, '.q26-a1-c1-started', 64).catch(() => null),
        ended: await readConfined(workspace, '.q26-a1-c1-ended', 64).catch(() => null) });
      await save('inspect-result', { verdict: assess({ work, events, exits: provider.exits, provider: provider.provider, toolCut }), toolCut, work, receipts,
        secretShapes: await secretScan([observations, `${root}/${work.work_id}`]) });
      return;
    }
    if (!needsStop(work.execution)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never;
    const before = await sandbox.observe({ environment });
    const result = before.condition === 'active' && before.boot ? await sandbox.stop({ environment, boot: before.boot, reason: 'q26 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before: { condition: before.condition, boot: before.boot ?? null }, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length === 2 && args[0] === 'child' && steps.includes(args[1] as Step)) { await child(args[1] as Step); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => { if (process.argv[2] !== 'child') process.exit(0); }, () => { console.error('Qualification held; no retry.'); process.exit(1); });
}
