import type { ExecutionPorts, ExecutionView } from '../../src/control/index.js';
import type { WorkerCompletion } from '../../src/workers/index.js';
import { readBounded, sessionToolCalls, snapshotStorage } from './review12-qualification.js';
import { ticketBody } from './review13-qualification.js';

// TEST ONLY. Ticket 28 one-shot real qualification recipe (partial review recovery inside one Execution). Import and `--plan` are inert.
// Every other phase is a REAL effect and requires an explicit operator grant: real GitHub (App, read-only grants), a real Gondolin/KVM VM
// and the real model for ONE Builder and its Standards/Spec reviewers. Two DECLARED provocations, both at the recipe's own seams:
//   (1) reviewer failure: the Spec reviewer of round 1, attempt 1 is launched with a 20 s Host deadline (its real worker is interrupted by its
//       own deadline and preserves a `cancelled` opinion) -> Control must re-obtain ONLY Spec, attempt 2, after the persisted 5 s wait;
//   (2) lost notification: the completion of the Standards reviewer of round 1, attempt 1 is forwarded to Control WITHOUT its opinion (the
//       real worker preserved the real opinion in the real Records) -> Control must locate it there and never rerun Standards for it.
// The Builder keeps the ticket 13 provocation (first proposal omits ## Rollback), so a later round has CHANGED content: both reviewers again.
// A controller cut during the handoff (crash + carried opinions) needs ticket 26's recovery in the composition and is NOT part of this
// revision (see docs/evidence/28-partial-review-recovery.md). Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed
// phase never reruns. No GitHub write is possible: every grant is read-only and publication is not part of ticket 28.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q28-partial-v1`;
const revision = 'q28-partial-v1';
const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const runDeadlineMs = 75 * 60 * 1000;
const rounds = { max: 4 } as const;
/** Spec: one retry in the whole run (the provoked failure); Standards: none (its lost notification must be recovered from Records). */
const activationsMax = { standards: rounds.max, spec: rounds.max + 1 } as const;
const provokedDeadlineMs = 20_000;
/** Guard refusals tolerated before the run stops activating (each one is a known never-started refusal, never retried). */
const maxGuardRefusals = 2;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never push, open pull ' +
    'requests, change GitHub state, request broader access or use another credential. Report blockers instead of working around them. ' +
    'QUALIFICATION RULES (this run tests the Factory partial review recovery; the operator authorized them): (1) in your FIRST proposal deliberately leave out ' +
    'the `## Rollback` section the Ticket requires, still run the documented validation command and hand off with its real (failing) result; add the section ' +
    'only after a reviewer reports it, then re-run the validation and hand off again with your treatments. (2) Treat every other finding normally.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const skillPack = 'factory-skills-v5' as const;

export function plan() {
  const total = 60 + 24 * (activationsMax.standards + activationsMax.spec);
  return { revision, root, observations, phases, repository, expectedTicket, configuration, guestAssets,
    model: { provider: 'openai', model: 'gpt-6-luna', api: 'openai-responses', auth: 'factory-oauth (operator first-login store under root/credentials)', sameModelForAllRoles: true,
      builder: { skillPack, budget: 'builder-v1', maxRequests: 60, maxToolCalls: 120, deadlineMinutes: 30, captures: rounds.max },
      reviewers: { roles: ['standards', 'spec'], budget: 'reviewer-v1', maxRequestsEach: 24, maxToolCallsEach: 80, deadlineMinutesEach: 15, tools: ['read'],
        maxActivations: activationsMax, retries: { standards: 0, spec: 1 } },
      maxRequestsTotal: total, providerRetries: 0, sdkRetries: 0, providerBillingHardCap: false },
    ticket: { number: expectedTicket.number, body: ticketBody, provocation: 'Builder system prompt: first proposal omits ## Rollback (changed content in a later round)' },
    provocations: [
      `spec r1a1: Host deadlineMs ${provokedDeadlineMs} on that ONE invocation (real worker interrupted by its own deadline; preserved cancelled opinion)`,
      'standards r1a1: its completion reaches Control without the opinion (notification loss at the recipe facade hop; the real record stays in Records)',
    ],
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only', reviewerCredentials: 'none',
      writes: 'none (no POST/PATCH/PUT/DELETE besides access_tokens issuance)' },
    effects: [
      'preflight: read-only GitHub: listing of the configured label must contain exactly Ticket #3; ticket and native blocked_by read',
      'run: new Control storage under observations; production-equivalent Execution ports with reviews {rounds max 4, partialRecovery true}; ONE Execution (capacity 1), 1 new VM, ' +
        'ONE Builder, reviewers in parallel on the same boot; the two provocations above; Sandbox.stop; Slot release; 75 min deadline',
      'inspect: read-only on exclusive COPIES: the storage copy (Control view: rounds, attempts, sources, charges, budget, history) and a private copy of the Work\'s ' +
        'Records (listing of every reviewer invocation on the copy); worker session JSONL read-only (bounded reads, tool-call names)',
      'stop-environment: own boot of the recorded Execution when it may still run: public Sandbox.stop of that exact boot',
    ],
    guards: [`guard refusals are known pre-launch refusals (WORKER_LAUNCH_INVALID: never-started, reservation released, not retried); more than ${maxGuardRefusals} stop the run`, 'one-shot intent tombstones', 'prepare once and only for the Work of Ticket #3', 'one Builder; per role at most the activations above, all of the same Execution, ' +
      'each a distinct (round, attempt); a Spec attempt > 1 only for round 1', 'no remove/cleanup', 'no push/PR (read-only grants)'],
    expected: [
      'round 1: standards.source records-discovery, state ended, attempt 1, NO second standards activation for round 1',
      'round 1: spec.attempts[0] {attempt 1, opinion conclusion cancelled code REVIEWER_INTERRUPTED (or failure WORKER_* with cessation completion-observed)}; spec.attempt 2, ' +
        'spec.retry.waitSeconds 5, spec.charge consumed; budget.recoveries.consumed 1, reserved null; the round delivery after BOTH ended',
      'if instead spec r1a1 ends as REVIEWER_OUTCOME_UNCERTAIN (channel closed by the deadline): the Execution is held REVIEWER_CESSATION_UNCONFIRMED (no retry on unknown cessation) — record as a finding',
      'a later round with changed content: both reviewers activated again (attempt 1), sources notification; no carried opinion inside one Execution',
      'execution ended, slot released after confirmed cessation; review.verification present (verified or explicit reasons); no token in storage/observations',
    ],
  };
}

/** Activation guard of ONE Execution: one Builder; per reviewer role a bounded number of DISTINCT (round, attempt); Spec retries only in round 1. */
export function activationGuard(max: { standards: number; spec: number } = activationsMax) {
  let execution: string | undefined;
  const seen: Record<string, Set<string>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; executionId: string }, review?: { round: number; attempt: number }) => {
    if (context.role === 'builder') { if (execution) return false; execution = context.executionId; return true; }
    const keys = seen[context.role];
    const limit = context.role === 'spec' ? max.spec : context.role === 'standards' ? max.standards : 0;
    if (!keys || !execution || context.executionId !== execution || !review) return false;
    const key = `${review.round}/${review.attempt}`;
    if (keys.has(key) || keys.size >= limit || (review.attempt > 1 && (context.role !== 'spec' || review.round !== 1 || review.attempt !== 2))) return false;
    keys.add(key);
    return true;
  };
}

/** The recipe's provocations, applied to ONE invocation each (first round of the Execution, attempt 1); everything else is forwarded as is. */
export function provocation(first: number) {
  return {
    deadline: (context: { role: string }, review?: { round: number; attempt: number }) =>
      context.role === 'spec' && review?.round === first && review.attempt === 1 ? provokedDeadlineMs : undefined,
    dropOpinion: (context: { role: string }, review: { round: number; attempt: number } | undefined, completion: WorkerCompletion): WorkerCompletion =>
      context.role === 'standards' && review?.round === first && review.attempt === 1 && completion.status === 'success' && completion.opinion
        ? { status: 'success', receipt: completion.receipt } : completion,
  };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
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
      const ticket = await tracker.readTicket(listing.candidates[0]!);
      const graph = await tracker.readDependencyGraph(listing.candidates[0]!);
      await save('preflight-result', { status: 'success', ticket, graph: { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems } });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'run') {
      const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
      const { createSandbox } = await import('../../src/sandbox/index.js');
      const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
      const reviewPack = builderSkillPacks[skillPack];
      const { openControl } = await import('../../src/control/index.js');
      const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
        artifactSeeds: [{ name: reviewPack.seedName, directory: reviewPack.directory }] });
      const workers = createWorkers({ root, knownSecrets: [], profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
        profiles: { builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model }, standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
          spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model } } });
      const credentials = createBuilderCredentials({ github, repositories: [repository] });
      const events: unknown[] = [];
      const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry }); };
      let prepared = 0;
      let refusals = 0;
      const stop = new AbortController();
      const guard = activationGuard();
      const provoke = provocation(1); // new storage: the Work's first round is round 1
      const allowed = async (workId: string) => {
        const shown = await control.inspect({ kind: 'show', work_id: workId });
        return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
      };
      const ports: ExecutionPorts = { configuration, capacity: 1, credentials, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
        reviews: { reviewer, rounds, partialRecovery: true },
        sandbox: {
          async prepare(input) {
            log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
            if (++prepared !== 1 || !await allowed(input.workId)) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
            const result = await sandbox.prepare(input);
            log({ call: 'prepare-result', result });
            return result;
          },
          async start(input) { const result = await sandbox.start(input); log({ call: 'start', result }); return result; },
          async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
          async observeProposal(input) { const result = await sandbox.observeProposal(input); log({ call: 'observe-proposal', round: input.round, result }); return result; },
          async verifyPreservedSource(input) { return sandbox.verifyPreservedSource(input); },
        },
        workers: {
          async observeOpinion(input) { const result = await workers.observeOpinion(input); log({ call: 'observe-opinion', input, kind: result.kind, ...(result.kind === 'uncertain' ? { code: result.code } : {}) }); return result; },
          async deliver(worker, directive) {
            log({ call: 'deliver', kind: directive.kind, ...(directive.kind === 'review-results' ? { round: directive.round, end: directive.end === true, bytes: Buffer.byteLength(directive.prompt) } : {}) });
            const result = await workers.deliver(worker, directive);
            log({ call: 'delivered', kind: directive.kind, result });
            return result;
          },
          async activate(invocation, delivery, activationEvents) {
            const deadlineMs = provoke.deadline(invocation.context, invocation.review);
            log({ call: 'activate', context: invocation.context, review: invocation.review ?? null, provokedDeadlineMs: deadlineMs ?? null, credentialDelivered: delivery?.credential !== undefined });
            // A guard refusal is a KNOWN pre-launch refusal (never-started: its reservation is released and it is not transient), so it can
            // never cascade into free retries; after a bounded number of refusals the run stops activating anything.
            if (!guard(invocation.context, invocation.review)) { refusals++; if (refusals > maxGuardRefusals) stop.abort(); throw new Error('WORKER_LAUNCH_INVALID'); }
            const handle = await workers.activate(deadlineMs ? { ...invocation, deadlineMs } : invocation, delivery, activationEvents);
            const role = invocation.context.role;
            const completed = handle.completed.then(done => {
              const forwarded = provoke.dropOpinion(invocation.context, invocation.review, done);
              log({ call: 'completed', role, review: invocation.review ?? null, status: done.status, opinionDropped: forwarded !== done,
                ...(done.status === 'success' && done.opinion ? { conclusion: done.opinion.conclusion, code: done.opinion.code, findings: done.opinion.findings.length } : {}),
                ...(done.status === 'failure' ? { code: done.code } : {}) });
              return forwarded;
            }, error => { log({ call: 'completion-uncertain', role }); throw error; });
            return { ...handle, completed };
          },
        } };
      const control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty',
        access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] }, polling: { intervalSeconds: 30 }, execution: ports });
      const running = control.run(stop.signal);
      const deadline = Date.now() + runDeadlineMs;
      let final: unknown;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const list = await control.inspect({ kind: 'list' });
        const execution = 'kind' in list && list.kind === 'list' ? list.works.find(work => work.execution)?.execution : undefined;
        if (execution && (['held', 'released'].includes(execution.state) || (execution.state === 'ended' && execution.dispatch.phase === 'stopped'))) { final = list; break; }
      }
      final ??= await control.inspect({ kind: 'list' });
      const status = await control.inspect({ kind: 'status' });
      stop.abort();
      const outcome = await running;
      await save('run-result', { status: 'observed', outcome, final, controlStatus: status, events, deadlineReached: Date.now() >= deadline });
      return;
    }
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const stopped = new AbortController(); stopped.abort();
    await stored.run(stopped.signal);
    const work = 'kind' in list && list.kind === 'list' ? list.works.find(item => item.execution) : undefined;
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    if (phase === 'inspect') {
      const shown = await stored.inspect({ kind: 'show', work_id: work.work_id });
      // Read-only: the Work's protected Records are COPIED into a private directory of the observations, and only the copy is opened.
      const { createRecords } = await import('../../src/records/index.js');
      const recordsCopy = `${observations}/inspect-records-copy`;
      await fs.mkdir(recordsCopy, { mode: 0o700 });
      await fs.cp(`${root}/${work.work_id}`, `${recordsCopy}/${work.work_id}`, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      const records = await createRecords({ root: recordsCopy });
      const invocations = (work.execution.review?.rounds ?? []).slice(0, 8).flatMap(round => (['standards', 'spec'] as const).flatMap(role =>
        [...(round.reviewers[role].attempts ?? []).map(item => item.invocationId), round.reviewers[role].invocationId].map(invocationId => ({ round: round.round, role, invocationId }))));
      const opinionRecords = [];
      for (const item of invocations.slice(0, 32)) {
        const found = await records.find({ workId: work.work_id, executionId: work.execution.executionId, invocationId: item.invocationId, callId: 'review-opinion' }).catch(() => null);
        opinionRecords.push({ ...item, completeness: found?.completeness ?? 'unavailable', captures: found?.captures.map(capture => ({ id: capture.reference.id, state: capture.state })) ?? [] });
      }
      const sessions: Record<string, unknown>[] = [];
      if (work.execution.dispatch.boot) {
        const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
        const runtime = workerRuntimeDirectory(root, work.execution.dispatch.boot);
        for (const launch of (await fs.readdir(runtime).catch(() => [])).filter(name => name.startsWith('w-')).sort().slice(0, 24)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            sessions.push('text' in read ? { launch, file: String(file), toolCalls: sessionToolCalls(read.text), tokenPattern: /ghs_|PRIVATE KEY/.test(read.text) } : { launch, file: String(file), ...read });
          }
        }
      }
      await save('inspect-result', { execution: work.execution, work: 'work' in shown ? { budget: shown.work.budget, history: shown.work.history } : null, opinionRecords, sessions });
      return;
    }
    const { needsStop } = await import('./builder09-qualification.js');
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q28 explicit stop of own boot' }) : null;
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
