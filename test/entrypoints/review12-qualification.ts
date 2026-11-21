import type { ExecutionView } from '../../src/control/index.js';

// TEST ONLY. Ticket 12 one-shot real review qualification recipe. Import and `--plan` are inert. Every other phase is a REAL effect and
// requires an explicit operator grant: real GitHub (App, read-only grants), a real Gondolin/KVM VM and the real model for ONE Builder and
// its two reviewers (Standards, Spec). Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns;
// nothing is retried automatically. No GitHub write is possible: every grant is read-only and publication is not part of ticket 12.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q12-review-v4`;
const revision = 'q12-review-v4';
const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
type Phase = (typeof phases)[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = {
  schemaVersion: 1,
  profile: 'gondolin-qemu-alpine-dev-v1',
  memoryMiB: 4096,
  vcpus: 2,
  diskGiB: 40,
  shutdownGraceSeconds: 30,
  minFreeSpaceGiB: 4,
} as const;
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
} as const;
const runDeadlineMs = 50 * 60 * 1000;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder:
    'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never push, open pull ' +
    'requests, change GitHub state, request broader access or use another credential. Report blockers instead of working around them. When your proposal is ' +
    'complete, call the handoff tool once (alone) for the Factory Standards and Spec reviews and stop; when the results arrive, treat every finding and finish.',
  standards:
    'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec:
    'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
/** v3: its `implement` ends with the review handoff when `reviews=factory-handoff` is present (v1 stays for ticket 09; v2 is ticket 10's). */
const skillPack = 'factory-skills-v3' as const;

export function plan() {
  return {
    revision,
    root,
    observations,
    phases,
    repository,
    expectedTicket,
    configuration,
    guestAssets,
    model: {
      provider: 'openai',
      model: 'gpt-6-luna',
      api: 'openai-responses',
      auth: 'factory-oauth (operator first-login store under root/credentials)',
      sameModelForAllRoles: true,
      builder: { skillPack, budget: 'builder-v1', maxRequests: 60, maxToolCalls: 120, deadlineMinutes: 30, clockIncludesReviews: true },
      reviewers: { roles: ['standards', 'spec'], budget: 'reviewer-v1', maxRequestsEach: 24, maxToolCallsEach: 80, deadlineMinutesEach: 15, tools: ['read'] },
      maxRequestsTotal: 108,
      providerRetries: 0,
      sdkRetries: 0,
      providerBillingHardCap: false,
    },
    github: {
      app: githubApp,
      controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only',
      reviewerCredentials: 'none',
      writes: 'none (no POST/PATCH/PUT/DELETE besides access_tokens issuance)',
    },
    effects: [
      'preflight: read-only GitHub: listing of the configured label must contain exactly Ticket #3; ticket and native blocked_by read',
      'run: new Control storage under observations; ONE Execution (capacity 1): fetch/clone/seed, Sandbox.prepare/start (1 new VM), revalidation, Builder grant, ONE Builder (/implement, handoff policy). ' +
        'At its handoff the Builder host suspends it and captures index/diffs into /artifacts/review/r1 (guest git); Control records the round and the host identity, then activates ' +
        'Standards and Spec IN PARALLEL on the SAME boot/Execution/Slot (read-only, no credential); both complete opinions are recorded, the identity is re-observed, the round concluded ' +
        'and the results delivered to the SAME Builder session; Builder ends; Sandbox.stop; Slot release. Control stops when the Execution leaves reserved/started or at the 50 min deadline',
      'inspect: read-only: Control storage view; confined no-follow reads of /artifacts (review/r1 index and patches, spec/instructions sources); checkout via a Factory-owned bare copy; ' +
        'start receipts and opinion records; tool-call names and read paths of each worker session JSONL (host runtime directory, not guest-writable)',
      'stop-environment: own boot of the recorded Execution when it may still run: public Sandbox.stop of that exact boot',
    ],
    guards: [
      'one-shot intent tombstones',
      'prepare once and only for the Work of Ticket #3',
      'activate at most one Builder, one Standards and one Spec, all of the same Execution',
      'no retry (Control never retries reviewers either)',
      'no remove/cleanup',
      'no push/PR (read-only grants)',
    ],
    expected: [
      'execution.state ended, slot released after confirmed cessation, review.rounds[0].state delivered',
      'round handoff captured: counts, head/branch/base, spec/instructions versions; identity before/after observed and equal (applicability current) unless the guest changed files',
      'reviewers standards/spec: same executionId/environment/boot, phaseId review-r1, distinct invocation ids, started receipts, opinions with model gpt-6-luna and conclusion clean|findings|incomplete (failure is recorded, never zero findings)',
      'activation order: both reviewers activated before either completes; delivery after both ended',
      'reviewer sessions: only read tool calls; Builder session: no tool call between the handoff result and the delivered results',
      'no token in storage/receipts/sessions/observations',
    ],
  };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const exists = (name: string) =>
    fs.access(`${observations}/${name}.json`).then(
      () => true,
      () => false,
    );
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

/** Per-role one-shot activation guard of ONE Execution: at most one Builder, then at most one Standards and one Spec of that same Execution. */
export function activationGuard() {
  const seen = new Map<string, string>();
  let execution: string | undefined;
  return (context: { role: string; executionId: string; invocationId: string }) => {
    if (seen.has(context.role)) return false;
    if (context.role === 'builder') execution = context.executionId;
    else if (!execution || context.executionId !== execution) return false;
    seen.set(context.role, context.invocationId);
    return true;
  };
}

/** Tool-call names (and read paths) of one worker session JSONL, bounded; the session lives in the host runtime directory. */
export function sessionToolCalls(jsonl: string) {
  const calls: { name: string; path?: string }[] = [];
  for (const line of jsonl.split('\n').slice(0, 20000)) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: string; content?: { type?: string; name?: string; arguments?: { path?: unknown } }[] } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content)
      if (block.type === 'toolCall' && typeof block.name === 'string')
        calls.push({ name: block.name, ...(typeof block.arguments?.path === 'string' ? { path: block.arguments.path.slice(0, 512) } : {}) });
  }
  return calls.slice(0, 500);
}

/**
 * Read-only use of the recipe storage: the SQLite files are copied exclusively into a new private directory and ONLY the copy is opened,
 * so inspection/stop can never write the run's own storage (no recovery transition, no checkpoint).
 */
export async function snapshotStorage(source: string, destination: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  await fs.mkdir(destination, { mode: 0o700 });
  for (const name of ['control.sqlite', 'control.sqlite-wal', 'control.sqlite-shm']) {
    await fs.copyFile(`${source}/${name}`, `${destination}/${name}`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (!(error.code === 'ENOENT' && name !== 'control.sqlite')) throw error;
    });
  }
  return `${destination}/control.sqlite`;
}

/** Bounded read of a host file: regular, not a symlink, at most `maxBytes`; otherwise a reason, never the content. */
export async function readBounded(path: string, maxBytes: number): Promise<{ text: string } | { skipped: string }> {
  const fs = await import('node:fs/promises');
  const info = await fs.lstat(path).catch(() => null);
  if (!info) return { skipped: 'absent' };
  if (!info.isFile()) return { skipped: 'not-a-regular-file' };
  if (info.size > maxBytes) return { skipped: `larger-than-${maxBytes}` };
  return { text: await fs.readFile(path, 'utf8') };
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
      if (
        listing.kind !== 'observed' ||
        listing.candidates.length !== 1 ||
        listing.candidates[0]!.number !== expectedTicket.number ||
        listing.repositoryId !== expectedTicket.repositoryId
      ) {
        await save('preflight-held', { listing });
        throw new Error('PRECONDITION_HELD');
      }
      const ticket = await tracker.readTicket(listing.candidates[0]!);
      const graph = await tracker.readDependencyGraph(listing.candidates[0]!);
      await save('preflight-result', {
        status: 'success',
        ticket,
        graph: { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems },
      });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'run') {
      const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
      const { createSandbox } = await import('../../src/sandbox/index.js');
      const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
      const reviewPack = builderSkillPacks[skillPack];
      const { openControl } = await import('../../src/control/index.js');
      const sandbox = createSandbox({
        root,
        guestAssets,
        repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
        artifactSeeds: [{ name: reviewPack.seedName, directory: reviewPack.directory }],
      });
      const workers = createWorkers({
        root,
        knownSecrets: [],
        profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
        profiles: {
          builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
          standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
          spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model },
        },
      });
      const credentials = createBuilderCredentials({ github, repositories: [repository] });
      const events: unknown[] = [];
      const log = (entry: Record<string, unknown>) => {
        events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry });
      };
      let prepared = 0;
      const guard = activationGuard();
      const allowed = async (workId: string) => {
        const shown = await control.inspect({ kind: 'show', work_id: workId });
        return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
      };
      const control = await openControl({
        storagePath: `${observations}/control.sqlite`,
        // Recipe decision: root/environments holds only earlier qualification resources (q05/q06/q09), none owned by THIS new storage.
        runtimeInventory: 'empty',
        access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] },
        polling: { intervalSeconds: 30 },
        execution: {
          configuration,
          capacity: 1,
          credentials,
          builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
          reviews: { reviewer },
          sandbox: {
            async prepare(input) {
              log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
              if (++prepared !== 1 || !(await allowed(input.workId))) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
              const result = await sandbox.prepare(input);
              log({ call: 'prepare-result', result });
              return result;
            },
            async start(input) {
              const result = await sandbox.start(input);
              log({ call: 'start', result });
              return result;
            },
            async stop(input) {
              const result = await sandbox.stop(input);
              log({ call: 'stop', input, result });
              return result;
            },
            async observeProposal(input) {
              const result = await sandbox.observeProposal(input);
              log({ call: 'observe-proposal', round: input.round, result });
              return result;
            },
          },
          workers: {
            async deliver(worker, directive) {
              log({
                call: 'deliver',
                kind: directive.kind,
                ...(directive.kind === 'review-results' ? { round: directive.round, bytes: Buffer.byteLength(directive.prompt) } : {}),
              });
              const result = await workers.deliver(worker, directive);
              log({ call: 'delivered', kind: directive.kind, result });
              return result;
            },
            async activate(invocation, delivery, events) {
              log({
                call: 'activate',
                context: invocation.context,
                promptSha256: (await import('node:crypto')).createHash('sha256').update(invocation.prompt).digest('hex'),
                review: invocation.review ?? null,
                handoff: invocation.handoff ?? null,
                modelBudget: invocation.modelBudget ?? null,
                credentialDelivered: delivery?.credential !== undefined,
              });
              if (!guard(invocation.context)) throw new Error('RECIPE_ONE_SHOT_GUARD');
              const handle = await workers.activate(invocation, delivery, events);
              const role = invocation.context.role;
              void handle.started.then(
                start => log({ call: 'started', role, receipt: start.receipt.id }),
                () => log({ call: 'start-failed', role }),
              );
              void handle.completed.then(
                done =>
                  log({
                    call: 'completed',
                    role,
                    status: done.status,
                    ...(done.status === 'success' && done.opinion ? { conclusion: done.opinion.conclusion, findings: done.opinion.findings.length } : {}),
                    ...(done.status === 'failure' ? { code: done.code } : {}),
                  }),
                () => log({ call: 'completion-uncertain', role }),
              );
              const { handoffs } = handle;
              return {
                ...handle,
                handoffs: {
                  async next() {
                    const event = await handoffs.next();
                    log({ call: 'handoff', event: event ? { round: event.round, status: event.status } : null });
                    return event;
                  },
                },
              };
            },
          },
        },
      });
      const stop = new AbortController();
      const running = control.run(stop.signal);
      const deadline = Date.now() + runDeadlineMs;
      let final: unknown;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const list = await control.inspect({ kind: 'list' });
        const execution = 'kind' in list && list.kind === 'list' ? list.works.find(work => work.execution)?.execution : undefined;
        if (execution && (['held', 'released'].includes(execution.state) || (execution.state === 'ended' && execution.dispatch.phase === 'stopped'))) {
          final = list;
          break;
        }
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
    const stopped = new AbortController();
    stopped.abort();
    await stored.run(stopped.signal);
    const work = 'kind' in list && list.kind === 'list' ? list.works.find(item => item.execution) : undefined;
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    const environmentDirectory = `${root}/environments/${work.execution.dispatch.environment}`;
    const { inspectEnvironment, needsStop } = await import('./builder09-qualification.js');
    if (phase === 'inspect') {
      const { readConfined } = await import('../../src/sandbox/index.js');
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const evidence = async (id: string | null | undefined) =>
        id
          ? fs.readFile(`${root}/${work.work_id}/evidence/${id}/output`, 'utf8').then(
              text => text.slice(0, 65536),
              () => null,
            )
          : null;
      const artifacts = `${environmentDirectory}/artifacts`;
      const confined = async (relative: string, max = 1024 * 1024) =>
        readConfined(artifacts, relative, max).then(
          bytes => (bytes === null ? { absent: true } : { bytes: bytes.length, text: bytes.toString('utf8').slice(0, 262144) }),
          (error: Error) => ({ error: error.message }),
        );
      const round = work.execution.review?.rounds[0];
      const sessions: Record<string, unknown>[] = [];
      if (work.execution.dispatch.boot) {
        const runtime = workerRuntimeDirectory(root, work.execution.dispatch.boot);
        for (const launch of (await fs.readdir(runtime).catch(() => []))
          .filter(name => name.startsWith('w-'))
          .sort()
          .slice(0, 8)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            sessions.push(
              'text' in read
                ? {
                    launch,
                    file: String(file),
                    bytes: Buffer.byteLength(read.text),
                    toolCalls: sessionToolCalls(read.text),
                    tokenPattern: /ghs_|PRIVATE KEY/.test(read.text),
                  }
                : { launch, file: String(file), ...read },
            );
          }
        }
      }
      await save('inspect-result', {
        execution: work.execution,
        receipts: {
          builder: await evidence(work.execution.start?.receiptId),
          standards: await evidence(round?.reviewers.standards.receiptId),
          spec: await evidence(round?.reviewers.spec.receiptId),
        },
        opinions: {
          standards: await evidence(round?.reviewers.standards.opinion?.reference.id),
          spec: await evidence(round?.reviewers.spec.opinion?.reference.id),
        },
        review: {
          index: await confined('review/r1/index.json', 16 * 1024 * 1024),
          committed: await confined('review/r1/committed.patch', 16 * 1024 * 1024),
          staged: await confined('review/r1/staged.patch', 16 * 1024 * 1024),
          unstaged: await confined('review/r1/unstaged.patch', 16 * 1024 * 1024),
        },
        sessions,
        ...(await inspectEnvironment(environmentDirectory, observations, work.execution.request.baseCommit ?? undefined)),
      });
      return;
    }
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never,
      boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q12 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
  } catch (error) {
    await save(`${phase}-held`, {
      phase,
      status: 'held',
      code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN',
      note: 'Consumed; no retry.',
    }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify(plan(), null, 2));
    return;
  }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    () => {
      console.error('Qualification held; no retry.');
      process.exit(1);
    },
  );
}
