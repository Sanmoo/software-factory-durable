import type { ExecutionView } from '../../src/control/index.js';

// TEST ONLY. Ticket 20 one-shot real credential-lifecycle qualification recipe. Import and `--plan` are inert. Every other phase is a REAL
// effect requiring an explicit operator grant: real GitHub App installation tokens (issuance AND self-revocation), one real Gondolin/KVM VM
// and one real Builder worker. The model is replaced by the scripted local provider (credential20-provider.ts): no model request is made.
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.
// All grants are read-only (builder-start: metadata/contents/issues read); push/PR/GitHub writes are impossible.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q20-credentials-v1`;
const revision = 'q20-credentials-v1';
const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
// Real tokens live 3600 s; renewing 3510 s before expiry renews every ~90 s, so a ~5 min activity sees >= 2 renewals.
const beforeExpirySeconds = 3510;
const runDeadlineMs = 15 * 60 * 1000;
const maxIssuances = 8; // initial + renewals; the recipe refuses more (bounded POSTs)

export function plan() {
  return { revision, root, observations, phases, repository, expectedTicket, configuration, guestAssets,
    renewal: { beforeExpirySeconds, expectedIntervalSeconds: 3600 - beforeExpirySeconds, maxIssuances },
    model: 'none: scripted local provider on 127.0.0.1:18720 (openai-completions SSE), fixed 5-command Bash schedule, then "Complete."; no OAuth/model request',
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only (initial + each renewal)',
      writes: 'POST /app/installations/{id}/access_tokens (issuance) and DELETE /installation/token (self-revocation of the host fetch token right after the fetch, of each Builder grant at the end, then one post-check DELETE per Builder grant expecting 401); nothing else' },
    effects: [
      'preflight: read-only GitHub: listing of the configured label must contain exactly Ticket #3; ticket and native blocked_by read',
      'run: new Control storage; ONE Execution: host fetch into root/cache/git, clone, Sandbox.prepare/start (1 new VM), Builder grant, Workers.activate (1 Builder, scripted provider), renewals every ~90 s delivered over the host channel, end, withdrawal + self-revocation of every known grant, Sandbox.stop, Slot release; post-check revocation of each grant (expects already-invalid); Control stops after the Execution leaves reserved/started or at the 15 min deadline',
      'inspect: read-only: Control storage view, start receipt, secret-shape scan (counts only) of storage/observations/records/session',
      'stop-environment: own boot of the recorded Execution if it may still run and is observed active: public Sandbox.stop of that exact boot',
    ],
    guards: ['one-shot intent tombstones', `at most ${maxIssuances} Builder issuances`, 'prepare/activate allowed once and only for the Work of Ticket #3', 'no retry', 'no remove/cleanup', 'no push/PR (read-only grants)',
      'only sha256 12-hex fingerprints of grants are recorded, never values'],
    expected: [
      'execution ended, slot released after confirmed cessation; credentialRenewals >= 2, each issued + delivered, revocation revoked; credentialIssuance revocation revoked; lifecycle withdrawn reason ended',
      'provider markers: c0 = fp(grant 1); c1a = c1b = fp(grant 1) although grant 2 was delivered during c1 (running command keeps its environment); c2 = fp(grant 2); c3 = fp(grant 2) or fp(grant 3) depending on timing; c4 = fp(latest delivered grant); every gh read prints the repository full_name',
      'post-check: every grant already-invalid (GitHub no longer accepts it)', 'no ghs_/PRIVATE KEY in storage, observations, records or session',
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

/**
 * Verdict of the run from fingerprints only: c0 saw grant 1; c1 kept ONE value while spanning a renewal; c2 saw a renewed, delivered grant;
 * c4 saw the latest delivered grant; every gh read worked; >= 2 renewals delivered; every grant revoked at the end and rejected afterwards.
 */
export function assess(input: { issued: string[]; delivered: string[]; markers: string[][]; revocations: string[]; postCheck: string[];
  /** c1 ran between these instants; deliveredAt lists renewal deliveries. */ c1: { start: string; end: string } | undefined; deliveredAt: string[] }) {
  const marker = (label: string) => input.markers.flat().find(item => item.startsWith(`${label}:`))?.slice(label.length + 1);
  const checks = {
    initialGrantFirst: marker('c0') === input.issued[0],
    runningCommandKeptItsValue: marker('c1a') !== undefined && marker('c1a') === marker('c1b') && marker('c1a') === input.issued[0],
    renewalDeliveredWhileC1Ran: input.c1 !== undefined && input.deliveredAt.some(at => at > input.c1!.start && at < input.c1!.end),
    newCommandGotRenewal: marker('c2') !== undefined && marker('c2') !== input.issued[0] && input.delivered.includes(marker('c2')!),
    latestDeliveredReachedLastCommand: marker('c4') !== undefined && marker('c4') === input.delivered.at(-1),
    everyReadWorked: input.markers.flat().filter(item => item === 'gh:Sanmoo/java-springboot-event-sourcing').length === 5,
    atLeastTwoRenewalsDelivered: input.delivered.length >= 3,
    everyGrantRevoked: input.revocations.length === input.issued.length && input.revocations.every(kind => kind === 'revoked'),
    githubRejectsEveryGrantAfterwards: input.postCheck.length === input.issued.length && input.postCheck.every(kind => kind === 'already-invalid'),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

/** Counts of secret-shaped values in files (never the values). */
export async function secretScan(directories: string[]) {
  const fs = await import('node:fs/promises');
  const counts: Record<string, number> = {};
  for (const directory of directories) {
    let files = 0, hits = 0;
    const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // Regular host files only: a guest-planted symlink or device is never followed, and each file is bounded.
      if (!entry.isFile() || entry.isSymbolicLink() || files >= 5000) continue;
      files++;
      // Bound the READ, not only the scan: never materialize a multi-GB guest-written file in this process.
      const handle = await fs.open(`${entry.parentPath}/${entry.name}`, 'r').catch(() => undefined);
      let bytes = Buffer.alloc(0);
      if (handle) {
        try { const buffer = Buffer.alloc(1024 * 1024); const read = await handle.read(buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, read.bytesRead); }
        catch { /* unreadable file counts as no hit */ } finally { await handle.close().catch(() => {}); }
      }
      hits += (bytes.toString('latin1').match(/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/g) ?? []).length;
    }
    counts[directory] = hits;
  }
  return counts;
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
      const { createHash } = await import('node:crypto');
      const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
      const { createSandbox } = await import('../../src/sandbox/index.js');
      const { createWorkers } = await import('../../src/workers/index.js');
      const { openControl } = await import('../../src/control/index.js');
      const provider = await import('./credential20-provider.js');
      const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }) });
      const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
        systemPrompt: 'Ticket 20 credential qualification. Follow the scripted tool schedule.', providerId: 'q20-qualification-fixture', modelId: 'q20-model', apiKey: provider.apiKey,
        provider: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.port}/q20-v1`, models: [{ id: 'q20-model', name: 'Q20', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } });
      const real = createBuilderCredentials({ github, repositories: [repository] });
      const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 12);
      // Grants stay in this process's memory only (post-check); only fingerprints/metadata are recorded.
      const grants: Parameters<typeof real.revoke>[0][] = [];
      const events: unknown[] = [];
      const credentials: typeof real = {
        async issue(context) {
          if (grants.length >= maxIssuances) throw new Error('RECIPE_ISSUANCE_LIMIT');
          events.push({ at: new Date().toISOString(), call: 'issue', context });
          const grant = await real.issue(context);
          grants.push(grant);
          events.push({ at: new Date().toISOString(), call: 'issued', sequence: grants.length, fingerprint: fingerprint(grant.delivery.token), metadata: grant.metadata });
          return grant;
        },
        async revoke(grant) {
          const result = await real.revoke(grant);
          events.push({ at: new Date().toISOString(), call: 'revoke', fingerprint: fingerprint(grant.delivery.token), result });
          return result;
        },
      };
      let prepared = 0, activated = 0;
      const allowed = async (workId: string) => {
        const shown = await control.inspect({ kind: 'show', work_id: workId });
        return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
      };
      const model = await provider.startProvider();
      let control: Awaited<ReturnType<typeof openControl>>;
      try {
        control = await openControl({ storagePath: `${observations}/control.sqlite`,
          // Recipe decision: root/environments holds only earlier qualification resources, none owned by THIS new storage.
          runtimeInventory: 'empty',
          access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] }, polling: { intervalSeconds: 30 },
          execution: { configuration, capacity: 1, credentials, builder: {}, credentialRenewal: { beforeExpirySeconds },
            sandbox: {
              async prepare(input) {
                events.push({ at: new Date().toISOString(), call: 'prepare', workId: input.workId, checkout: input.checkout });
                if (++prepared !== 1 || !await allowed(input.workId)) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
                const result = await sandbox.prepare(input);
                events.push({ at: new Date().toISOString(), call: 'prepare-result', result });
                return result;
              },
              async start(input) { const result = await sandbox.start(input); events.push({ at: new Date().toISOString(), call: 'start', result }); return result; },
              async stop(input) { const result = await sandbox.stop(input); events.push({ at: new Date().toISOString(), call: 'stop', input, result }); return result; },
            },
            workers: {
              async activate(invocation, delivery) {
                events.push({ at: new Date().toISOString(), call: 'activate', context: invocation.context, credentialDelivered: delivery?.credential !== undefined });
                if (++activated !== 1) throw new Error('RECIPE_ONE_SHOT_GUARD');
                return workers.activate(invocation, delivery);
              },
              async deliver(worker, directive) {
                const result = await workers.deliver(worker, directive);
                events.push({ at: new Date().toISOString(), call: 'deliver', directive: directive.kind,
                  ...(directive.kind === 'credential' ? { fingerprint: fingerprint(directive.credential.token) } : {}), result });
                return result;
              },
            } } });
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
        // Post-check: GitHub must no longer accept any grant (one DELETE each, expected 401 -> already-invalid). Never retried.
        const postCheck = [];
        for (const grant of grants) postCheck.push({ fingerprint: fingerprint(grant.delivery.token), result: await real.revoke(grant) });
        grants.length = 0;
        const typed = events as { call: string; fingerprint?: string; directive?: string; result?: { kind?: string; status?: string } }[];
        const observed = model.observation();
        const verdict = assess({ c1: observed.emitted[1] && observed.results[1] ? { start: observed.emitted[1], end: observed.results[1].at } : undefined,
          deliveredAt: typed.filter(event => event.call === 'deliver' && event.directive === 'credential' && event.result?.status === 'delivered').map(event => (event as { at?: string }).at ?? ''), issued: typed.filter(event => event.call === 'issued').map(event => event.fingerprint!),
          delivered: [typed.find(event => event.call === 'issued')?.fingerprint ?? '', ...typed.filter(event => event.call === 'deliver' && event.directive === 'credential' && event.result?.status === 'delivered').map(event => event.fingerprint!)],
          markers: model.observation().results.map(result => result.markers),
          revocations: typed.filter(event => event.call === 'revoke').map(event => event.result?.kind ?? ''), postCheck: postCheck.map(entry => entry.result.kind) });
        await save('run-result', { status: 'observed', verdict, outcome, final, controlStatus: status, events, postCheck, provider: model.observation(), deadlineReached: Date.now() >= deadline });
      } finally { await model.close(); }
      return;
    }
    const { openControl } = await import('../../src/control/index.js');
    const stored = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const halt = new AbortController(); halt.abort();
    await stored.run(halt.signal);
    const work = 'kind' in list && list.kind === 'list' ? list.works.find(item => item.execution) : undefined;
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    if (phase === 'inspect') {
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const receipt = work.execution.start ? await fs.readFile(`${root}/${work.work_id}/evidence/${work.execution.start.receiptId}/output`, 'utf8').then(text => text.slice(0, 65536), () => null) : null;
      const scanned = [observations, `${root}/${work.work_id}`, ...(work.execution.dispatch.boot ? [workerRuntimeDirectory(root, work.execution.dispatch.boot)] : [])];
      await save('inspect-result', { execution: work.execution, receipt, secretShapes: await secretScan(scanned) });
      return;
    }
    if (!needsStop(work.execution)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q20 explicit stop of own boot' }) : null;
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
