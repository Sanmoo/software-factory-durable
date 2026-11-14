import type { ExecutionView } from '../../src/control/index.js';
import { readBounded, sessionToolCalls, snapshotStorage } from './review12-qualification.js';
export { readBounded, sessionToolCalls, snapshotStorage };

// TEST ONLY. Ticket 13 one-shot real qualification recipe (findings treatment, repeated rounds, identical commit, gate evidence).
// Import and `--plan` are inert. Every other phase is a REAL effect and requires an explicit operator grant: real GitHub (App, read-only
// grants), a real Gondolin/KVM VM and the real model for ONE Builder and at most FOUR review rounds of its two reviewers (Standards, Spec).
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.
// No GitHub write is possible: every grant is read-only and publication is not part of ticket 13.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q13-rounds-v5`;
const revision = 'q13-rounds-v5';
const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const runDeadlineMs = 60 * 60 * 1000;
/** Captures per Builder activation (handoffs + the Host's closing capture) and reviewer rounds at most (each round = Standards + Spec). */
const rounds = { max: 4 } as const;
/** Equal to the captures: a correct run can never trip the guard (each capture is at most one reviewer round). */
const maxReviewerRounds = rounds.max;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
/**
 * The Builder system prompt carries ONE deliberate qualification provocation (declared in the evidence, not hidden): the first proposal
 * omits the Ticket's `## Rollback` section, so the Spec reviewer plausibly reports a requirement finding and the documented gate fails
 * for real; and the proposal stays uncommitted until a round is clean, so the final commit of exactly the reviewed content exercises
 * the identical-commit exemption. Everything else follows the v4 pack.
 */
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never push, open pull ' +
    'requests, change GitHub state, request broader access or use another credential. Report blockers instead of working around them. ' +
    'QUALIFICATION RULES (this run tests the Factory review loop; the operator authorized them): (1) in your FIRST proposal deliberately leave out the ' +
    '`## Rollback` section the Ticket requires, still run the documented validation command and hand off with its real (failing) result; add the section ' +
    'only after a reviewer reports it, then re-run the validation and hand off again with your treatments. (2) Keep the proposal UNCOMMITTED until a ' +
    'review round has no finding left to fix; then commit exactly the reviewed content (no other change), re-run the validation as your last command and ' +
    'hand off again. (3) Treat every other finding normally: fix it, or do not adopt it with a justification and evidence.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
/** v4: its `implement` hands off again with treatments and gates when `review-rounds=multi` is present (v1-v3 unchanged). */
const skillPack = 'factory-skills-v5' as const;
/** The Ticket text the operator puts on issue #3 for this run (documentation only; one documented gate). */
export const ticketBody = [
  'Add a short documentation page `docs/FACTORY_SMOKE.md`. This exact upper-case file name was decided by the operator: keep it even if other docs use another naming style.',
  '', 'Required content:',
  '1. A `# Factory smoke` title and one paragraph explaining that this file exists only to exercise the Software Factory review loop.',
  '2. A `## Steps` section with a numbered list of exactly three steps: build, review, merge.',
  '3. A `## Rollback` section saying the file can be deleted at any time without other changes.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && test -f docs/FACTORY_SMOKE.md && grep -q \'^## Steps\' docs/FACTORY_SMOKE.md && grep -q \'^## Rollback\' docs/FACTORY_SMOKE.md`'].join('\n');

export function plan() {
  return { revision, root, observations, phases, repository, expectedTicket, configuration, guestAssets,
    model: { provider: 'openai', model: 'gpt-6-luna', api: 'openai-responses', auth: 'factory-oauth (operator first-login store under root/credentials)', sameModelForAllRoles: true,
      builder: { skillPack, budget: 'builder-v1', maxRequests: 60, maxToolCalls: 120, deadlineMinutes: 30, clockIncludesReviews: true, captures: rounds.max },
      reviewers: { roles: ['standards', 'spec'], budget: 'reviewer-v1', maxRequestsEach: 24, maxToolCallsEach: 80, deadlineMinutesEach: 15, tools: ['read'],
        maxRounds: maxReviewerRounds, maxActivations: 2 * maxReviewerRounds, sessions: 'later rounds continue the same role session when compatible (copy in the same boot)' },
      maxRequestsTotal: 60 + 24 * 2 * maxReviewerRounds, providerRetries: 0, sdkRetries: 0, providerBillingHardCap: false },
    ticket: { number: expectedTicket.number, title: 'Factory smoke: document the review loop', body: ticketBody,
      provocation: 'Builder system prompt: first proposal omits ## Rollback (Spec finding + failing gate plausible); proposal uncommitted until clean (identical commit)' },
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only', reviewerCredentials: 'none',
      writes: 'none (no POST/PATCH/PUT/DELETE besides access_tokens issuance)' },
    effects: [
      'preflight: read-only GitHub: listing of the configured label must contain exactly Ticket #3; ticket and native blocked_by read',
      'run: new Control storage under observations; ONE Execution (capacity 1): fetch/clone/seed, Sandbox.prepare/start (1 new VM), revalidation, Builder grant, ONE Builder (/implement, ' +
        `handoff policy rounds {first: 1, max: ${rounds.max}}). Each handoff (with treatments and gates) is captured into /artifacts/review/r<N> (guest git); Control classifies it: a new round of ` +
        'Standards and Spec IN PARALLEL on the SAME boot/Execution/Slot (read-only, no credential, later rounds continue each role session), or an exemption (unchanged content / identical commit) ' +
        'with no reviewer; after the Builder session ends the Host captures once more (closing) and Control verifies opinions, treatments, gates and waivers before the end; Sandbox.stop; ' +
        'Slot release. Control stops when the Execution leaves reserved/started or at the 60 min deadline',
      'inspect: read-only, on an exclusive COPY of the storage: Control view; confined no-follow reads of /artifacts (review/r<N> index and patches of every round, spec/instructions sources); ' +
        'checkout via a Factory-owned bare copy (never host git on the guest tree); start receipts, opinion records and the protected outputs referenced by gates; tool-call names and read ' +
        'paths of each worker session JSONL (host runtime directory, not guest-writable)',
      'stop-environment: own boot of the recorded Execution when it may still run: public Sandbox.stop of that exact boot',
    ],
    guards: ['one-shot intent tombstones', 'prepare once and only for the Work of Ticket #3',
      `activate at most one Builder and, per reviewer role, at most ${maxReviewerRounds} activations of distinct rounds, all of the same Execution`,
      'no retry (Control never retries reviewers either)', 'no remove/cleanup', 'no push/PR (read-only grants)'],
    expected: ['execution.state ended, slot released after confirmed cessation; review.firstRound 1; every round delivered; the last round closing',
      'round 1: review; Spec finding on the missing Rollback section is plausible (not guaranteed); declarations.gates[validation] outcome failed with exitCode 1 and a protected output reference',
      'a later handoff with treatments (fixed / not-adopted with justification) -> a NEW review round of BOTH reviewers on the changed content; opinion.session.mode continued (or replaced with a code)',
      'after the commit of exactly the reviewed content: a round kind exemption, exemption.kind identical-commit, reviewers not-required, no reviewer activation for it',
      'closing capture: exemption (unchanged / identical-commit) delivered with end; or a forced review round when the content changed after the last handoff',
      'review.verification: status verified with reasons [] when every finding is treated and the validation gate passed current on the final content; otherwise explicit reasons (never success by absence)',
      'reviewer sessions: only read tool calls; Builder session: no tool call between a handoff result and the next Factory message',
      'no token in storage/receipts/sessions/observations'],
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

/** Activation guard of ONE Execution: one Builder, then per reviewer role at most `maxRounds` activations of DISTINCT rounds of that Execution. */
export function activationGuard(maxRounds = maxReviewerRounds) {
  let execution: string | undefined;
  const seen: Record<string, Set<number>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; executionId: string; invocationId: string }, review?: { round: number }) => {
    if (context.role === 'builder') { if (execution) return false; execution = context.executionId; return true; }
    const rounds = seen[context.role];
    if (!rounds || !execution || context.executionId !== execution || !review || rounds.has(review.round) || rounds.size >= maxRounds) return false;
    rounds.add(review.round);
    return true;
  };
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
      const guard = activationGuard();
      const allowed = async (workId: string) => {
        const shown = await control.inspect({ kind: 'show', work_id: workId });
        return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
      };
      const control = await openControl({ storagePath: `${observations}/control.sqlite`,
        // Recipe decision: root/environments holds only earlier qualification resources (q05/q06/q09), none owned by THIS new storage.
        runtimeInventory: 'empty',
        access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] }, polling: { intervalSeconds: 30 },
        execution: { configuration, capacity: 1, credentials, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
          reviews: { reviewer, rounds },
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
          },
          workers: { async deliver(worker, directive) {
            log({ call: 'deliver', kind: directive.kind, ...(directive.kind === 'review-results' ? { round: directive.round, end: directive.end === true, bytes: Buffer.byteLength(directive.prompt) } : {}) });
            const result = await workers.deliver(worker, directive);
            log({ call: 'delivered', kind: directive.kind, result });
            return result;
          }, async activate(invocation, delivery, events) {
            log({ call: 'activate', context: invocation.context, promptSha256: (await import('node:crypto')).createHash('sha256').update(invocation.prompt).digest('hex'),
              review: invocation.review ?? null, handoff: invocation.handoff ?? null, modelBudget: invocation.modelBudget ?? null, credentialDelivered: delivery?.credential !== undefined });
            if (!guard(invocation.context, invocation.review)) throw new Error('RECIPE_ONE_SHOT_GUARD');
            const handle = await workers.activate(invocation, delivery, events);
            const role = invocation.context.role;
            void handle.started.then(start => log({ call: 'started', role, receipt: start.receipt.id }), () => log({ call: 'start-failed', role }));
            void handle.completed.then(done => log({ call: 'completed', role, status: done.status, ...(done.status === 'success' && done.opinion ? { conclusion: done.opinion.conclusion, findings: done.opinion.findings.length } : {}),
              ...(done.status === 'failure' ? { code: done.code } : {}) }), () => log({ call: 'completion-uncertain', role }));
            const { handoffs } = handle;
            return { ...handle,
              handoffs: { async next() { const event = await handoffs!.next(); log({ call: 'handoff', event: event ? { round: event.round, status: event.status, closing: event.closing === true,
                content: event.status === 'captured' ? event.summary.content ?? null : null, head: event.status === 'captured' ? event.summary.head : null,
                treatments: event.declarations?.treatments.map(item => `${item.round}/${item.role}/${item.findingId}:${item.outcome}`) ?? [],
                gates: event.declarations?.gates.map(item => ({ id: item.id, outcome: item.outcome, exitCode: item.exitCode, current: item.current, code: item.code })) ?? [] } : null }); return event; } } };
          } } } });
      const stop = new AbortController();
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
    // Authority is the recipe's own storage, opened ONLY as a private copy (the original is never written by inspect/stop).
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const stopped = new AbortController(); stopped.abort();
    await stored.run(stopped.signal);
    const work = 'kind' in list && list.kind === 'list' ? list.works.find(item => item.execution) : undefined;
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    const environmentDirectory = `${root}/environments/${work.execution.dispatch.environment}`;
    const { inspectEnvironment, needsStop } = await import('./builder09-qualification.js');
    if (phase === 'inspect') {
      const { readConfined } = await import('../../src/sandbox/index.js');
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      // Records are host-owned evidence: read them with the same confined, no-follow, size-bounded read used for guest trees.
      const records = `${root}/${work.work_id}/evidence`;
      const evidence = async (id: string | null | undefined) => !id ? null
        : readConfined(records, `${id}/output`, 65536).then(bytes => bytes?.toString('utf8') ?? null, () => null);
      const artifacts = `${environmentDirectory}/artifacts`;
      const confined = async (relative: string, max = 1024 * 1024) => readConfined(artifacts, relative, max)
        .then(bytes => bytes === null ? { absent: true } : { bytes: bytes.length, text: bytes.toString('utf8').slice(0, 262144) }, (error: Error) => ({ error: error.message }));
      const reviewRounds = (work.execution.review?.rounds ?? []).slice(0, 8);
      const sessions: Record<string, unknown>[] = [];
      if (work.execution.dispatch.boot) {
        const runtime = workerRuntimeDirectory(root, work.execution.dispatch.boot);
        for (const launch of (await fs.readdir(runtime).catch(() => [])).filter(name => name.startsWith('w-')).sort().slice(0, 16)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            sessions.push('text' in read ? { launch, file: String(file), bytes: Buffer.byteLength(read.text), toolCalls: sessionToolCalls(read.text), tokenPattern: /ghs_|PRIVATE KEY/.test(read.text) }
              : { launch, file: String(file), ...read });
          }
        }
      }
      const perRound = [];
      for (const round of reviewRounds) {
        const directory = `review/r${round.round}`;
        perRound.push({ round: round.round, kind: round.kind ?? 'review', closing: round.closing ?? false,
          receipts: { standards: await evidence(round.reviewers.standards.receiptId), spec: await evidence(round.reviewers.spec.receiptId) },
          opinions: { standards: await evidence(round.reviewers.standards.opinion?.reference.id), spec: await evidence(round.reviewers.spec.opinion?.reference.id) },
          // The protected Bash outputs the Host referenced as gate evidence (Records of the boot owner, never a guest copy).
          gateOutputs: Object.fromEntries(await Promise.all((round.declarations?.gates ?? []).slice(0, 16).map(async gate => [gate.id, await evidence(gate.output?.id)] as const))),
          files: { index: await confined(`${directory}/index.json`, 16 * 1024 * 1024), committed: await confined(`${directory}/committed.patch`, 16 * 1024 * 1024),
            staged: await confined(`${directory}/staged.patch`, 16 * 1024 * 1024), unstaged: await confined(`${directory}/unstaged.patch`, 16 * 1024 * 1024) } });
      }
      await save('inspect-result', { execution: work.execution, receipts: { builder: await evidence(work.execution.start?.receiptId) }, rounds: perRound,
        sessions, ...await inspectEnvironment(environmentDirectory, observations, work.execution.request.baseCommit ?? undefined) });
      return;
    }
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q13 explicit stop of own boot' }) : null;
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
