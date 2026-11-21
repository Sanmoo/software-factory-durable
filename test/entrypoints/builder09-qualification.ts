import type { ExecutionView } from '../../src/control/index.js';

// TEST ONLY. Ticket 09 one-shot real Builder qualification recipe. Import and `--plan` are inert. Every other phase is a REAL effect and
// requires an explicit operator grant: real GitHub (App), a real Gondolin/KVM VM and a real model. Phases are one-shot: an exclusive
// intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically. Push/PR are impossible: the
// Builder grant is read-only (builder-start: metadata/contents/issues read) and publication is not part of ticket 09.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q09-builder-v2`;
const revision = 'q09-builder-v2';
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
const runDeadlineMs = 45 * 60 * 1000;
const systemPrompt =
  'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. ' +
  'Never push, open pull requests, change GitHub state, request broader access or use another credential. Report blockers instead of working around them.';

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
      budget: 'builder-v1',
      maxRequests: 60,
      maxToolCalls: 120,
      deadlineMinutes: 30,
      providerRetries: 0,
      sdkRetries: 0,
      providerBillingHardCap: false,
    },
    github: {
      app: githubApp,
      controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only',
      writes: 'none (no POST/PATCH/PUT/DELETE besides access_tokens issuance)',
    },
    effects: [
      'preflight: read-only GitHub: listing of the configured label must contain exactly Ticket #3; ticket and native blocked_by read; no token leaves the controller',
      'run: Control (new storage under observations) polls once per 30 s; dispatch reserves ONE Execution (capacity 1), then: host fetch into root/cache/git, no-hardlinks clone into the Work checkout, skill pack seed, Sandbox.prepare/start (1 new VM), fresh revalidation, Builder grant, Workers.activate (1 Builder, /implement), receipt consumption, wait for end, Sandbox.stop, Slot release; Control stops after the Execution leaves reserved/started or at the 45 min deadline',
      'inspect: read-only: Control storage view; confined no-follow reads of /artifacts manifests; checkout log/diff via a Factory-owned bare copy of its objects (never host git in the guest tree); start receipt',
      'stop-environment: own boot of the recorded Execution when it may still run (reserved/started/held, or ended without confirmed cessation) and is observed active: public Sandbox.stop of that exact boot',
    ],
    guards: [
      'one-shot intent tombstones',
      'prepare/activate allowed once and only for the Work of Ticket #3',
      'no retry',
      'no remove/cleanup',
      'no push/PR (read-only grant)',
    ],
    expected: [
      'execution.state ended, start.receiptId set, slot released after confirmed cessation',
      '/artifacts/spec/v1/{ticket.json,sources.json} and /artifacts/instructions/v1/sources.json complete, or a BLOCKED final message with complete:false',
      'commits on factory/3-<work8> in the checkout, never pushed',
      'no token in storage/receipt/session/observations',
    ],
  };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const load = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8'));
  const exists = (name: string) =>
    fs.access(`${observations}/${name}.json`).then(
      () => true,
      () => false,
    );
  return { fs, save, load, exists };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}

/** The recipe's own boot may still run unless the Execution was released or ended with confirmed cessation. */
export function needsStop(execution: ExecutionView): boolean {
  if (!execution.dispatch.boot || execution.state === 'released') return false;
  return !(execution.state === 'ended' && execution.end?.cessation === 'confirmed');
}

/**
 * Read-only host inspection of a guest-written environment: NO host git in the checkout (Factory-owned bare copy via Sandbox
 * inspectCheckout) and only confined, bounded, no-follow reads of /artifacts. Host-only checkout.json is outside the guest mounts.
 */
export async function inspectEnvironment(environmentDirectory: string, scratch: string, base?: string): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const { inspectCheckout, readConfined } = await import('../../src/sandbox/index.js');
  const artifacts = `${environmentDirectory}/artifacts`;
  const confined = async (relative: string) =>
    readConfined(artifacts, relative, 1024 * 1024).then(
      bytes => (bytes === null ? { absent: true } : { text: bytes.toString('utf8') }),
      (error: Error) => ({ error: error.message }),
    );
  const names: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8 || names.length > 2000) return;
    for (const name of (await fs.readdir(relative ? `${artifacts}/${relative}` : artifacts).catch(() => [])).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (path.startsWith('factory/skill-pack')) continue;
      const info = await fs.lstat(`${artifacts}/${path}`);
      if (info.isSymbolicLink()) names.push(`${path} (symlink, not followed)`);
      else if (info.isDirectory()) await walk(path, depth + 1);
      else names.push(info.isFile() ? path : `${path} (not a regular file)`);
    }
  };
  await walk('', 0);
  return {
    checkout: await fs.readFile(`${environmentDirectory}/checkout.json`, 'utf8').then(
      text => JSON.parse(text) as unknown,
      () => null,
    ),
    artifacts: names,
    specSources: await confined('spec/v1/sources.json'),
    instructionSources: await confined('instructions/v1/sources.json'),
    git: await inspectCheckout(environmentDirectory, { scratch, ...(base ? { base } : {}) }),
  };
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, load, exists } = await io();
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
      // Ticket 09 qualified v1; it stays pinned to v1 (the default Builder pack is now v2).
      const { createWorkers, skillPacks } = await import('../../src/workers/index.js');
      const builderSkillPack = skillPacks['factory-skills-v1'];
      const { openControl } = await import('../../src/control/index.js');
      const sandbox = createSandbox({
        root,
        guestAssets,
        repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
        artifactSeeds: [{ name: builderSkillPack.seedName, directory: builderSkillPack.directory }],
      });
      const workers = createWorkers({
        root,
        knownSecrets: [],
        profile: {
          id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
          systemPrompt,
          auth: 'factory-oauth',
          providerId: 'openai',
          modelId: 'gpt-6-luna',
          api: 'openai-responses',
        },
      });
      const credentials = createBuilderCredentials({ github, repositories: [repository] });
      const events: unknown[] = [];
      let prepared = 0,
        activated = 0;
      const allowed = async (workId: string) => {
        const shown = await control.inspect({ kind: 'show', work_id: workId });
        return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
      };
      const control = await openControl({
        storagePath: `${observations}/control.sqlite`,
        // Recipe decision: root/environments holds only earlier qualification resources (q05/q06), none owned by THIS new storage.
        runtimeInventory: 'empty',
        access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] },
        polling: { intervalSeconds: 30 },
        execution: {
          configuration,
          capacity: 1,
          credentials,
          builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
          sandbox: {
            async prepare(input) {
              events.push({ at: new Date().toISOString(), call: 'prepare', workId: input.workId, checkout: input.checkout });
              if (++prepared !== 1 || !(await allowed(input.workId))) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
              const result = await sandbox.prepare(input);
              events.push({ at: new Date().toISOString(), call: 'prepare-result', result });
              return result;
            },
            async start(input) {
              const result = await sandbox.start(input);
              events.push({ at: new Date().toISOString(), call: 'start', result });
              return result;
            },
            async stop(input) {
              const result = await sandbox.stop(input);
              events.push({ at: new Date().toISOString(), call: 'stop', input, result });
              return result;
            },
          },
          workers: {
            async activate(invocation, delivery) {
              events.push({
                at: new Date().toISOString(),
                call: 'activate',
                context: invocation.context,
                prompt: invocation.prompt,
                credentialDelivered: delivery?.credential !== undefined,
              });
              if (++activated !== 1) throw new Error('RECIPE_ONE_SHOT_GUARD');
              return workers.activate(invocation, delivery);
            },
            async deliver(worker, directive) {
              const result = await workers.deliver(worker, directive);
              events.push({ at: new Date().toISOString(), call: 'deliver', directive: directive.kind, result });
              return result;
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
    // Authority is the recipe's own storage (not run-result, which a crash could prevent): read-only inspect, then closed.
    const { openControl } = await import('../../src/control/index.js');
    const stored = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const stop = new AbortController();
    stop.abort();
    await stored.run(stop.signal);
    const work = 'kind' in list && list.kind === 'list' ? list.works.find(item => item.execution) : undefined;
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    const environmentDirectory = `${root}/environments/${work.execution.dispatch.environment}`;
    if (phase === 'inspect') {
      const receipt = work.execution.start
        ? await fs.readFile(`${root}/${work.work_id}/evidence/${work.execution.start.receiptId}/output`, 'utf8').then(
            text => text.slice(0, 65536),
            () => null,
          )
        : null;
      await save('inspect-result', {
        execution: work.execution,
        receipt,
        ...(await inspectEnvironment(environmentDirectory, observations, work.execution.request.baseCommit ?? undefined)),
      });
      return;
    }
    // stop-environment: only the recipe's own boot, in any state where it may still run.
    if (!needsStop(work.execution)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never,
      boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q09 explicit stop of own boot' }) : null;
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
