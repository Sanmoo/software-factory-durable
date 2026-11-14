import type { ExecutionPorts, ExecutionView, ListView, ShowView, WorkView } from '../../src/control/index.js';

// TEST ONLY. Ticket 19 one-shot real limits/timeout qualification recipe. Import and `--plan` are inert. Every other phase is a REAL effect
// requiring an explicit operator grant: real GitHub App installation tokens (read-only grants, issuance and self-revocation), one real
// Gondolin/KVM VM and one real Builder worker. The model is replaced by the scripted local provider (limits19-provider.ts): no model request.
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.
// What it proves on the real boundary: the configured per-Execution timeout, measured on the controller's local monotonic clock, interrupts
// a REAL running guest command, the own boot is stopped with confirmed cessation, credentials are withdrawn/revoked, and the Work stays
// blocked (EXECUTION_TIMEOUT) through polling rounds, an explicit grant and a controller restart — no automatic loop.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q19-limits-v2`;
const revision = 'q19-limits-v2';
const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
// Limits under test: per-Execution timeout 90 s; correction/recovery limits captured at admission (1/0) to observe the snapshot and a grant.
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent',
  correctionLimit: 1, recoveryLimit: 0, timeoutSeconds: 90 };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const pollingSeconds = 30;
const runDeadlineMs = 15 * 60 * 1000;
/** After the timeout: polling rounds observed (no relaunch), before and after the grant, then once more after a restart. */
const observeRounds = 3;
const maxIssuances = 3; // initial Builder grant only (tokens live 1 h; the run is < 15 min); the recipe refuses more

export function plan() {
  return { revision, root, observations, phases, repository, expectedTicket, configuration, guestAssets, pollingSeconds,
    limits: { timeoutSeconds: repository.timeoutSeconds, scope: 'per Execution, controller monotonic clock (performance.now) from the confirmed start receipt',
      correctionLimit: repository.correctionLimit, recoveryLimit: repository.recoveryLimit, grant: 'local Control.accept grant --corrections 1 after the timeout (request id q19-grant-1)' },
    model: 'none: scripted local provider on 127.0.0.1:18719 (openai-completions SSE): ONE activation, c0 short listing, c1 `sleep 600` (Bash timeout 900) that the Factory timeout interrupts; no OAuth/model request; at most 3 requests',
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only',
      writes: 'POST /app/installations/{id}/access_tokens (issuance) and DELETE /installation/token (self-revocation of the fetch token and of the Builder grant at the timeout withdrawal); nothing else' },
    effects: [
      'preflight: read-only GitHub: listing of the configured label must contain exactly Ticket #3; ticket and native blocked_by read',
      `run: new Control storage; ONE Execution: host fetch into root/cache/git, clone, Sandbox.prepare/start (1 new VM), Builder grant, Workers.activate (1 Builder, scripted provider); live duration sampled every 10 s; at ${repository.timeoutSeconds} s monotonic the Control records EXECUTION_TIMEOUT, interrupts the activity (worker channel closed), withdraws/revokes the grant, Sandbox.stop of its own boot, Slot release after confirmed cessation; ${observeRounds} polling rounds observed; grant --corrections 1; ${observeRounds} more rounds; Control stopped and reopened on the SAME storage for ${observeRounds} rounds; 15 min deadline`,
      'inspect: read-only: an exclusive private COPY of the run storage is opened (never the original), start receipt evidence, secret-shape scan (counts only) of observations/storage/records/boot runtime; no host git, no guest-writable tree read',
      'stop-environment: own boot of the recorded Execution if it may still run and is observed active: public Sandbox.stop of that exact boot',
    ],
    guards: ['one-shot intent tombstones', `at most ${maxIssuances} Builder issuances`, 'prepare and activate allowed once and only for the Work of Ticket #3', 'no retry', 'no remove/cleanup',
      'no push/PR (read-only grants)', 'no correction/recovery trigger (none exists before tickets 22/23/26): budgets are observed as snapshot/grant only'],
    expected: [
      'execution: end.outcome timeout, end.code EXECUTION_TIMEOUT, end.cessation confirmed, slot.held false; timing.timeout.evidence measured, 90000 <= timing.timeout.elapsedMs < 120000; timing.duration measured; timing.origin = the run controller_run_id; credentialLifecycle withdrawn/timeout; grant revocation revoked',
      'samples during the activity: limits.duration.state running, clock controller-monotonic, elapsedMs increasing (a sample taken between the timer and the end commit may slightly exceed 90000); timeout.seconds 90 scope per-execution',
      'impediments: EXECUTION_TIMEOUT (with action text) before and after the grant and after the restart; activations stay 1; timeout-reached recorded once',
      'budget: corrections {limit 1, granted 1 after the grant, consumed 0, reserved null}, recoveries {limit 0}; execution.charge none (initial implementation); grant receipt accepted with history before/after',
      'provider: c0 result returned; c1-start never followed by c1-end; no request after c1', 'no ghs_/PRIVATE KEY in storage, observations, records or session',
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
  return { fs, save, exists };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}

export function needsStop(execution: ExecutionView): boolean {
  if (!execution.dispatch.boot || execution.state === 'released') return false;
  return !(execution.state === 'ended' && execution.end?.cessation === 'confirmed');
}

type Sample = { at: string; state: string; elapsedMs: number | null; clock: string | null };
/** Verdict from the stored Work, the duration samples, the observation rounds and the provider markers (no secret involved). */
export function assess(input: { work: WorkView | undefined; runId: string; samples: Sample[]; activationsAfter: number[]; grant: { outcome?: string } | undefined;
  impedimentsAfter: string[][]; markers: string[]; providerAttempts: number }) {
  const execution = input.work?.execution;
  const timing = execution?.timing;
  const running = input.samples.filter(sample => sample.state === 'running');
  const checks = {
    timedOutAndCeased: execution?.end?.outcome === 'timeout' && execution.end.code === 'EXECUTION_TIMEOUT' && execution.end.cessation === 'confirmed' && execution.slot.held === false,
    measuredOnLocalMonotonic: timing?.timeout?.evidence === 'measured' && timing.timeout.elapsedMs >= repository.timeoutSeconds * 1000 &&
      timing.timeout.elapsedMs < (repository.timeoutSeconds + 30) * 1000 && timing.duration?.kind === 'measured' && timing.origin === input.runId,
    liveDurationObserved: running.length >= 2 && running.every(sample => sample.clock === 'controller-monotonic' && sample.elapsedMs !== null && sample.elapsedMs < (repository.timeoutSeconds + 30) * 1000) &&
      running.every((sample, index) => index === 0 || sample.elapsedMs! >= running[index - 1]!.elapsedMs!),
    credentialsWithdrawnForTimeout: execution?.credentialLifecycle.state === 'withdrawn' && execution.credentialLifecycle.reason === 'timeout' && execution.credentialIssuance?.revocation === 'revoked',
    blockedWithoutLoop: input.activationsAfter.length >= observeRounds * 3 && input.activationsAfter.every(count => count === 1) &&
      input.impedimentsAfter.length > 0 && input.impedimentsAfter.every(codes => codes.includes('EXECUTION_TIMEOUT')),
    grantAcceptedWithoutBypass: input.grant?.outcome === 'accepted' && input.work?.budget?.corrections.granted === 1 && input.work.budget.corrections.consumed === 0 &&
      input.work.budget.grants.length === 1 && input.work.impediments.some(item => item.code === 'EXECUTION_TIMEOUT'),
    budgetSnapshot: input.work?.budget?.corrections.limit === repository.correctionLimit && input.work.budget.recoveries.limit === repository.recoveryLimit && execution?.charge?.kind === 'none',
    timeoutRecordedOnce: (input.work?.history.filter(item => item.event === 'timeout-reached').length ?? 0) === 1,
    runningCommandInterrupted: input.markers.some(marker => marker.startsWith('a1-c0')) && !input.markers.includes('a1-c1-end') && input.providerAttempts === 2,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists } = await io();
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { tracker } = await compose();
      const listing = await tracker.listCandidates(repository);
      if (listing.kind !== 'observed' || listing.candidates.length !== 1 || listing.candidates[0]!.number !== expectedTicket.number ||
        listing.repositoryId !== expectedTicket.repositoryId) { await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD'); }
      const graph = await tracker.readDependencyGraph(listing.candidates[0]!);
      await save('preflight-result', { status: 'success', ticket: listing.candidates[0], graph: { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems } });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'run') {
      const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
      const { createSandbox } = await import('../../src/sandbox/index.js');
      const { createWorkers } = await import('../../src/workers/index.js');
      const { openControl } = await import('../../src/control/index.js');
      const provider = await import('./limits19-provider.js');
      const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }) });
      const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
        systemPrompt: 'Ticket 19 limits qualification. Follow the scripted tool schedule.', providerId: 'q19-qualification-fixture', modelId: 'q19-model', apiKey: provider.apiKey,
        provider: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.port}/q19-v1`, models: [{ id: 'q19-model', name: 'Q19', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } });
      const real = createBuilderCredentials({ github, repositories: [repository] });
      const events: unknown[] = [];
      const log = (event: Record<string, unknown>) => events.push({ at: new Date().toISOString(), ...event });
      let issued = 0, prepared = 0, activated = 0;
      const credentials: typeof real = {
        async issue(context) { if (++issued > maxIssuances) throw new Error('RECIPE_ISSUANCE_LIMIT'); log({ call: 'issue', context }); const grant = await real.issue(context); log({ call: 'issued', metadata: grant.metadata }); return grant; },
        async revoke(grant) { const result = await real.revoke(grant); log({ call: 'revoke', result }); return result; },
      };
      let control: Awaited<ReturnType<typeof openControl>>;
      const allowed = async (workId: string) => {
        const shown = await control.inspect({ kind: 'show', work_id: workId });
        return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
      };
      const ports: ExecutionPorts = { configuration, capacity: 1, credentials, builder: {},
        sandbox: {
          async prepare(input) {
            log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
            if (++prepared !== 1 || !await allowed(input.workId)) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
            const result = await sandbox.prepare(input); log({ call: 'prepare-result', result }); return result;
          },
          async start(input) { const result = await sandbox.start(input); log({ call: 'start', result }); return result; },
          async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
        },
        workers: {
          async activate(invocation, delivery, handlers) {
            log({ call: 'activate', context: invocation.context, credentialDelivered: delivery?.credential !== undefined });
            if (++activated !== 1) throw new Error('RECIPE_ONE_SHOT_GUARD');
            const handle = await workers.activate(invocation, delivery, handlers);
            invocation.signal.addEventListener('abort', () => log({ call: 'activation-signal-aborted' }), { once: true });
            void handle.completed.then(done => log({ call: 'completed', status: done.status }), (error: Error) => log({ call: 'completion-uncertain', code: error.message.slice(0, 64) }));
            return handle;
          },
          async deliver(worker, directive) { const result = await workers.deliver(worker, directive); log({ call: 'deliver', directive: directive.kind, result }); return result; },
        } };
      const access = { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] };
      const model = await provider.startProvider();
      try {
        // Recipe decision: root/environments holds only earlier qualification resources, none owned by THIS new storage.
        control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty', access, polling: { intervalSeconds: pollingSeconds }, execution: ports });
        const status = await control.inspect({ kind: 'status' }) as { controller_run_id: string };
        const stop = new AbortController();
        const running = control.run(stop.signal);
        const deadline = Date.now() + runDeadlineMs;
        const list = async () => await control.inspect({ kind: 'list' }) as ListView;
        const current = async () => (await list()).works.find(work => work.ticket.number === expectedTicket.number);
        const samples: Sample[] = [];
        let work: WorkView | undefined;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10000));
          work = await current();
          if (work?.execution) samples.push({ at: new Date().toISOString(), state: work.limits.duration.state, elapsedMs: work.limits.duration.elapsedMs, clock: work.limits.duration.clock });
          const execution = work?.execution;
          if (execution && (['held', 'released'].includes(execution.state) || (execution.state === 'ended' && execution.dispatch.phase === 'stopped'))) break;
        }
        const atTimeout = work;
        const activationsAfter: number[] = [], impedimentsAfter: string[][] = [];
        const observe = async () => {
          for (let round = 0; round < observeRounds && Date.now() < deadline; round++) {
            await new Promise(resolve => setTimeout(resolve, pollingSeconds * 1000 + 2000));
            const shown = await current();
            activationsAfter.push(activated);
            impedimentsAfter.push(shown?.impediments.map(item => item.code) ?? []);
          }
        };
        await observe();
        const grant = work ? await control.accept({ request_id: 'q19-grant-1', operation: 'grant', work_id: work.work_id, counter: 'corrections', amount: 1, origin: 'local-cli' }) : undefined;
        log({ call: 'grant', receipt: grant });
        await observe();
        const beforeRestart = await control.inspect({ kind: 'list' });
        stop.abort();
        const outcome = await running;
        // Restart on the SAME storage (this phase's own): neither the restart nor the earlier grant relaunches a timed-out Execution.
        control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty', access, polling: { intervalSeconds: pollingSeconds }, execution: ports });
        const restartStop = new AbortController();
        const restarted = control.run(restartStop.signal);
        await observe();
        const final = await list();
        const shown = work ? await control.inspect({ kind: 'show', work_id: work.work_id }) as ShowView : null;
        restartStop.abort();
        const restartOutcome = await restarted;
        const observed = model.observation();
        const finalWork = final.works.find(item => item.ticket.number === expectedTicket.number);
        const verdict = assess({ work: finalWork, runId: status.controller_run_id, samples, activationsAfter, grant: grant as { outcome?: string } | undefined, impedimentsAfter,
          markers: observed.results.flatMap(result => result.markers), providerAttempts: observed.attempts });
        await save('run-result', { status: 'observed', verdict, outcome, restartOutcome, runId: status.controller_run_id, atTimeout, beforeRestart, final, shown, samples,
          activationsAfter, impedimentsAfter, grant, events, provider: observed, deadlineReached: Date.now() >= deadline });
      } finally { await model.close(); }
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
    const work = list.works.find(item => item.execution);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    if (phase === 'inspect') {
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const { readBounded } = await import('./review12-qualification.js');
      const { secretScan } = await import('./credential20-qualification.js');
      const receipt = work.execution.start ? await readBounded(`${root}/${work.work_id}/evidence/${work.execution.start.receiptId}/output`, 65536) : null;
      const scanned = [observations, `${root}/${work.work_id}`, ...(work.execution.dispatch.boot ? [workerRuntimeDirectory(root, work.execution.dispatch.boot)] : [])];
      await save('inspect-result', { work: { budget: work.budget, impediments: work.impediments, limits: work.limits, history: work.history }, execution: work.execution, receipt,
        secretShapes: await secretScan(scanned) });
      return;
    }
    if (!needsStop(work.execution)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q19 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => { console.error('Qualification held; no retry.'); process.exit(1); });
}
