import type { WorkView } from '../../src/control/index.js';
import type { CodeRepository } from '../../src/code-repository/index.js';
import { linkedWork, migrateCopy, readOnlyTracker, snapshotStorage } from './checks15-qualification.js';
export { linkedWork };

// TEST ONLY. Ticket 16 one-shot real qualification recipe: the controller converts the own draft PR #5 (ticket 14's real run q14-publication-v8:
// head factory/3-99fe871b @ bfdd439, base main, issue #3 of Sanmoo/java-springboot-event-sourcing; already approved by the operator) to READY
// FOR REVIEW from current evidence. Import and `--plan` are inert. Every other phase is a REAL effect and needs an explicit operator grant.
// Exactly ONE GitHub mutation is possible: markPullRequestReadyForReview on PR #5's node, by the App installation token of a fresh
// `readiness-write` grant, revoked right after. Everything else is GET (gh behind a guard that traces every request). No model, VM, Docker,
// merge, approval or review. One-shot: exclusive intent tombstones precede effects; a consumed phase never reruns; nothing is retried. The
// ticket 14 storage is only COPIED, migrated explicitly on the copy (ticket 33), never opened in place; the real environment is never touched.

const root = '/home/sanmoo/software-factory-test/y5';
const q14 = `${root}/q14-publication-v8`;
const observations = `${root}/q16-readiness-v1`;
const revision = 'q16-readiness-v1';
const phases = ['preflight', 'convert', 'inspect'] as const;
type Phase = (typeof phases)[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
/** The own draft PR ticket 14's v8 run published and linked (docs/evidence/14-*.md, 15-*.md). */
const expectedPullRequest = {
  number: 5,
  nodeId: 'PR_kwDOSuqsXs8AAAABPTSKww',
  headRef: 'factory/3-99fe871b',
  head: 'bfdd439ceba20a424538647f41e55d5ab2d03217',
  base: 'main',
};
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const convertDeadlineMs = 5 * 60 * 1000;
const ghTrace = `${observations}/gh-trace.jsonl`;
/** Long cadence: the first polling cycle runs at start; its checks and readiness steps convert in that same cycle. */
const pollingSeconds = 120;

export function plan() {
  return {
    revision,
    root,
    source: `${q14}/control.sqlite (copied, never opened in place)`,
    observations,
    phases,
    repository,
    expectedTicket,
    expectedPullRequest,
    requires: [
      'tickets 14, 15 and 16 integrated in the composed revision',
      `${q14}/discover-result.json present (own draft PR linked by ticket 14's real run)`,
      'PR #5 still open, draft, at bfdd439 (preflight holds otherwise; a head moved since is never adopted)',
    ],
    github: {
      app: githubApp,
      controllerPurposes: [
        'tracker-read',
        'association-read',
        'dependency-read',
        'repository-read',
        'checks-read (ticket 15, GET only)',
        'readiness-write {metadata:read, pull_requests:write}: ONE fresh grant for the one mutation, revoked right after',
      ],
      writes: [
        'App: access_tokens issuance POSTs (native HTTPS, not gh): the cached read grants plus ONE readiness-write grant',
        'gh: exactly ONE POST graphql markPullRequestReadyForReview(pullRequestId: PR #5 node) and ONE DELETE /installation/token (its self-revocation)',
      ],
      guard:
        'every phase runs gh (GitHub access root = this namespace, never y5) behind a wrapper that traces every request and refuses (exit 97, nothing sent) anything but GET without input, except — only in the ' +
        "convert phase, only once each (wx tombstones) — the exact mark-ready document for PR #5's node and then one DELETE /installation/token authenticated by THAT token (matched by its hash, never logged); the CodeRepository " +
        "is wrapped so setDraft is refused locally unless it is draft=false for PR #5's node, once; the IssueTracker is read-only (postComment refused locally)",
      never: [
        'convertPullRequestToDraft',
        'merge',
        'approval or review',
        'comment',
        'push',
        'branch/ruleset/protection change',
        'rerun/approve of workflows',
        'a second mutation',
      ],
      requestBound:
        'convert: label poll + 1 checks collection + 1 recheck + 1 observation (each <= 1 PR + 1 branch + 0..1 classic + <=10 rules + <=10 check-run + <=10 status ' +
        'pages + 0..1 compare + 1 PR re-read), 1 mutation, 1 revocation',
    },
    model: 'none',
    sandbox: 'none',
    runtime:
      'no execution ports (dispatch EXECUTION_NOT_ENABLED). The owner uses a fresh PRIVATE runtime root inside the observations directory, listed by the real ' +
      "inventoryRuntime (empty), never the y5 root: the copied Work's Executions are settled in its durable record (checked in preflight: ended, cessation confirmed, " +
      'Slot released), so nothing needs reconciling and the real q14 environment is neither needed, stopped nor touched (preflight only records a read-only inventory of y5).',
    effects: [
      'preflight: exclusive observations directory; private COPY of the q14 storage migrated explicitly (format 1 -> current, digest-checked); read-only view of the ' +
        'Work of Ticket #3 (published PR #5, Executions settled, no readiness yet); read-only inventory of the y5 root (evidence only); GET-only readPullRequest of #5',
      'convert: ANOTHER private copy, migrated the same way, paused first (local pause on the copy: nothing admitted), becomes the authority of one owner run without ' +
        'execution ports, polling 120 s: the checks step explains #5, the readiness step evaluates it, rechecks it with a fresh read, records the intent, sends the ONE ' +
        'mutation, reads the flag again and confirms; stop as soon as the conversion settled (or 5 min)',
      'inspect: private copy of the convert storage: readiness view and events; a GET-only readPullRequest (draft false expected)',
    ],
    guards: [
      'one-shot intent tombstones',
      'no retry',
      'no execution ports',
      'read-only IssueTracker',
      'setDraft wrapper: mark-ready of PR #5 once',
      'gh guard: GET + one exact mutation + one revocation',
      'q14 storage never opened in place',
      'real environment never touched',
      'nothing under the repository changes',
    ],
    expected: [
      'convert: readiness.latest.decision ready (recheck), reasons []; one effect mark-ready: intent before the attempt, attempt applied with revocation revoked, observation draft=false, confirmed',
      'readiness.internal ready, flag.factory ready (origin readiness-effect), stages {internal ready, flag ready, humanReview human-stage, delivery not-delivered}',
      'checks.latest satisfied (empty-complete) with the ruleset pull_request rule as human-stage: the operator approval neither blocks nor is touched',
      'gh trace: every request GET except exactly one POST graphql (mark-ready, PR #5 node) and one DELETE /installation/token after it; no refused request',
      'inspect: PR #5 open, not merged, draft false, head bfdd439; Work result open (ready is not delivery), no impediment or queue change',
    ],
  };
}

/** The copied Work's Executions are durably settled (no activity a conversion could race), or the reason they are not. */
export function settledWork(work: WorkView): { ok: true } | { ok: false; reason: string } {
  const execution = work.execution;
  if (
    execution &&
    (execution.slot.held ||
      execution.state === 'reserved' ||
      execution.state === 'started' ||
      execution.state === 'held' ||
      (execution.state === 'ended' && execution.end?.cessation !== 'confirmed'))
  )
    return { ok: false, reason: 'EXECUTION_NOT_SETTLED' };
  if (work.queue.pending) return { ok: false, reason: 'WORK_PENDING' };
  if ((work as { readiness?: unknown }).readiness) return { ok: false, reason: 'READINESS_ALREADY_RECORDED' };
  return { ok: true };
}

/**
 * Text of the gh wrapper: traces every request; forwards a GET without input; forwards — only while `armed` exists and only once each (wx
 * tombstones) — the exact mark-ready document for `nodeId`, and then one DELETE /installation/token. Anything else: exit 97, gh never runs.
 */
export function readinessGuardScript(input: { node: string; gh: string; trace: string; directory: string; nodeId: string; document: string }) {
  return `#!${input.node}
import { appendFileSync, existsSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// The readiness token is tied to the mutation by its hash (never logged); only ITS self-revocation is allowed afterwards.
const tokenHash = createHash('sha256').update(process.env.GH_TOKEN ?? '').digest('hex');
const args = process.argv.slice(2);
const at = args.indexOf('--method');
const method = at >= 0 ? args[at + 1] : null;
const endpoint = args.at(-1);
const piped = args.includes('--input');
const once = name => { try { closeSync(openSync(${JSON.stringify(input.directory)} + '/' + name, 'wx', 0o600)); return true; } catch { return false; } };
let body;
let allowed = method === 'GET' && !piped;
let kind = allowed ? 'read' : 'refused';
if (method === 'POST' && endpoint === 'graphql' && piped && args[args.indexOf('--input') + 1] === '-') {
  body = readFileSync(0, 'utf8');
  let request = null; try { request = JSON.parse(body); } catch {}
  const exact = request && Object.keys(request).sort().join() === 'query,variables' && request.query === ${JSON.stringify(input.document)} &&
    Object.keys(request.variables ?? {}).sort().join() === 'cid,id' && request.variables.id === ${JSON.stringify(input.nodeId)} && typeof request.variables.cid === 'string';
  allowed = Boolean(exact) && Boolean(process.env.GH_TOKEN) && existsSync(${JSON.stringify(input.directory)} + '/convert-armed') && once('mutation.sent');
  if (allowed) writeFileSync(${JSON.stringify(input.directory)} + '/mutation-token.sha256', tokenHash, { flag: 'wx', mode: 0o600 });
  kind = allowed ? 'mark-ready' : 'refused-mutation';
} else if (method === 'DELETE' && endpoint === '/installation/token' && !piped) {
  let bound = null; try { bound = readFileSync(${JSON.stringify(input.directory)} + '/mutation-token.sha256', 'utf8'); } catch {}
  allowed = bound !== null && bound === tokenHash && once('revocation.sent');
  kind = allowed ? 'revocation' : 'refused-revocation';
}
appendFileSync(${JSON.stringify(input.trace)}, JSON.stringify({ at: new Date().toISOString(), method, endpoint, allowed, kind, ...(body !== undefined ? { body } : {}) }) + '\\n');
if (!allowed) { process.stderr.write('RECIPE_GUARD_REFUSED\\n'); process.exit(97); }
const result = spawnSync(${JSON.stringify(input.gh)}, args, body === undefined ? { stdio: 'inherit', env: process.env } : { input: body, stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
process.exit(result.status ?? 1);
`;
}

/**
 * Review MED 4: a phase runs only after the previous one SUCCEEDED (a held preflight/convert is consumed and never followed) and only once.
 * `results` are the saved result documents (absent = not saved).
 */
export function phaseGuard(
  phase: Phase,
  results: { preflight?: { status?: unknown } | null; convert?: { status?: unknown } | null },
  intents: ReadonlySet<string>,
): string | null {
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase === 'preflight') return null;
  if (results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  if (phase === 'inspect' && !results.convert) return 'CONVERT_RESULT_REQUIRED';
  return null;
}

/** setDraft only as draft=false for PR #5's node, once (local tombstone); everything else refused locally, nothing sent. Calls are logged. */
export function markReadyOnly(repository: CodeRepository, log: (entry: Record<string, unknown>) => void, claim: () => Promise<boolean>): CodeRepository {
  return {
    checkAccess: (repo, base) => repository.checkAccess(repo, base),
    findPublication: correlation => repository.findPublication(correlation),
    async readPullRequest(query) {
      const result = await repository.readPullRequest(query);
      log({
        call: 'read-pull-request',
        number: query.number,
        kind: result.kind,
        ...(result.kind === 'observed'
          ? { headSha: result.pullRequest.headSha, draft: result.pullRequest.draft }
          : result.kind === 'unavailable'
            ? { code: result.code }
            : { unchanged: result.headSha }),
      });
      return result;
    },
    async setDraft(pr, draft, effect) {
      const permitted = !draft && pr.number === expectedPullRequest.number && pr.nodeId === expectedPullRequest.nodeId && (await claim());
      if (!permitted) {
        log({ call: 'set-draft-refused', number: pr.number, draft });
        return {
          kind: 'known-failure',
          observedAt: new Date().toISOString(),
          code: 'RECIPE_ONLY_ONE_MARK_READY',
          nextStep: 'Refused locally; nothing was sent.',
          revocation: 'not-issued',
        };
      }
      const result = await repository.setDraft(pr, draft, effect);
      log({ call: 'set-draft', number: pr.number, draft, effectId: effect.effectId, result });
      return result;
    },
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
  const load = (name: string) =>
    fs.readFile(`${observations}/${name}.json`, 'utf8').then(
      text => JSON.parse(text) as { status?: unknown },
      () => null,
    );
  return { fs, save, exists, load };
}

async function guardedGh() {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { draftMutations } = await import('../../src/platform/github/index.js');
  const target = `${observations}/gh-guard.mjs`;
  if (
    !(await fs.access(target).then(
      () => true,
      () => false,
    ))
  ) {
    let gh: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(':').filter(item => item.startsWith('/'))) {
      if (
        await fs.access(`${directory}/gh`, constants.X_OK).then(
          () => true,
          () => false,
        )
      ) {
        gh = `${directory}/gh`;
        break;
      }
    }
    if (!gh) throw new Error('GH_NOT_FOUND');
    await fs.writeFile(
      target,
      readinessGuardScript({
        node: process.execPath,
        gh,
        trace: ghTrace,
        directory: observations,
        nodeId: expectedPullRequest.nodeId,
        document: draftMutations.markPullRequestReadyForReview,
      }),
      { mode: 0o700, flag: 'wx' },
    );
  }
  return target;
}

async function compose() {
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  // The recipe's OWN namespace is the GitHub access root (its run/ holds the transient gh dirs; never y5/run).
  const github = createGitHubAccess({ root: observations, ...githubApp, executable: await guardedGh() });
  return { tracker: createIssueTracker({ github, scopes: [repository], dependencyScopes: [] }), codeRepository: createCodeRepository({ github }) };
}

async function view(storagePath: string) {
  const { openControl } = await import('../../src/control/index.js');
  const stored = await openControl({ storagePath, runtimeInventory: 'unknown' });
  const list = await stored.inspect({ kind: 'list' });
  const stopped = new AbortController();
  stopped.abort();
  await stored.run(stopped.signal);
  return list;
}
const traceOf = async () => {
  const fs = await import('node:fs/promises');
  return (await fs.readFile(ghTrace, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { method: string | null; endpoint: string; allowed: boolean; kind: string });
};

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists, load } = await io();
  if (phase === 'preflight') {
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    // Own GitHub access root: private credentials/ (a copy of the App key, removed by inspect) and run/.
    const { constants } = await import('node:fs');
    await fs.mkdir(`${observations}/credentials`, { mode: 0o700 });
    await fs.mkdir(`${observations}/run`, { mode: 0o700 });
    await fs.copyFile(`${root}/${githubApp.privateKeyFile}`, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
    await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
  }
  const refused = phaseGuard(
    phase,
    { preflight: await load('preflight-result'), convert: await load('convert-result') },
    new Set(
      (await Promise.all(phases.map(async item => ((await exists(`${item}-intent`)) ? `${item}-intent` : null)))).filter(
        (item): item is string => item !== null,
      ),
    ),
  );
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      await fs.access(`${q14}/discover-result.json`);
      const copy = await snapshotStorage(q14, `${observations}/preflight-storage-copy`);
      await save('preflight-copy-migration', await migrateCopy(copy, observations, `${revision}-preflight-copy`));
      const linked = linkedWork(await view(copy));
      if (!linked.ok) {
        await save('preflight-held', { reason: linked.reason });
        throw new Error(linked.reason);
      }
      if (linked.pullRequest.number !== expectedPullRequest.number || linked.pullRequest.headRef !== expectedPullRequest.headRef)
        throw new Error('NOT_THE_EXPECTED_OWN_PULL_REQUEST');
      const settled = settledWork(linked.work);
      if (!settled.ok) throw new Error(settled.reason);
      // Evidence only (read-only, nothing created/changed/executed): the y5 root's runtime resources, including the q14 environment.
      const { inventoryRuntime } = await import('../../src/sandbox/index.js');
      const y5 = await inventoryRuntime(root).catch((error: Error) => ({ error: error.message.slice(0, 128) }));
      const { codeRepository } = await compose();
      const facts = await codeRepository.readPullRequest({ repo: repository, number: expectedPullRequest.number });
      const ok =
        facts.kind === 'observed' &&
        facts.pullRequest.state === 'open' &&
        !facts.pullRequest.merged &&
        facts.pullRequest.draft &&
        facts.pullRequest.headSha === expectedPullRequest.head &&
        facts.pullRequest.nodeId === expectedPullRequest.nodeId;
      await save('preflight-result', {
        status: ok ? 'success' : 'held',
        work_id: linked.work.work_id,
        publication: (linked.work as { publication?: unknown }).publication ?? null,
        execution: linked.work.execution,
        y5Inventory: y5,
        facts,
        trace: await traceOf(),
      });
      if (!ok) throw new Error('OWN_PULL_REQUEST_NOT_AS_EXPECTED');
      return;
    }
    if (phase === 'convert') {
      const { tracker, codeRepository } = await compose();
      const { openControl } = await import('../../src/control/index.js');
      const { inventoryRuntime } = await import('../../src/sandbox/index.js');
      const { randomUUID } = await import('node:crypto');
      const events: unknown[] = [];
      const log = (entry: Record<string, unknown>) => {
        events.push({ at: new Date().toISOString(), ...entry });
      };
      const storagePath = await snapshotStorage(q14, `${observations}/convert-storage`);
      await save('convert-copy-migration', await migrateCopy(storagePath, observations, `${revision}-convert-copy`));
      const pausing = await openControl({ storagePath, runtimeInventory: 'unknown' });
      const paused = await pausing.accept({ request_id: randomUUID(), operation: 'pause', origin: 'local-cli' });
      const pauseStop = new AbortController();
      pauseStop.abort();
      await pausing.run(pauseStop.signal);
      log({ call: 'pause-copy', receipt: paused });
      // A fresh private runtime root, listed for real: this owner has no runtime resource of its own.
      await fs.mkdir(`${observations}/runtime`, { mode: 0o700 });
      const listing = await inventoryRuntime(`${observations}/runtime`);
      if (listing.environments.length || listing.cache.length || listing.unknown.length) throw new Error('PRIVATE_RUNTIME_NOT_EMPTY');
      const claim = () =>
        fs.open(`${observations}/set-draft.claimed`, 'wx', 0o600).then(
          async file => {
            await file.close();
            return true;
          },
          () => false,
        );
      const control = await openControl({
        storagePath,
        runtimeInventory: { kind: 'listed', observedAt: new Date().toISOString(), ...listing },
        polling: { intervalSeconds: pollingSeconds },
        access: {
          tracker: readOnlyTracker(tracker, log),
          repository: markReadyOnly(codeRepository, log, claim),
          repositories: [repository],
          dependencyRepositories: [],
        },
      });
      await (await fs.open(`${observations}/convert-armed`, 'wx', 0o600)).close();
      const stop = new AbortController();
      const running = control.run(stop.signal);
      const deadline = Date.now() + convertDeadlineMs;
      const settled = (list: unknown) => {
        const linked = linkedWork(list);
        const readiness = linked.ok ? linked.work.readiness : null;
        return Boolean(readiness && !readiness.effect && readiness.effects.length);
      };
      let final: unknown;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const list = await control.inspect({ kind: 'list' });
        if (settled(list)) {
          final = list;
          break;
        }
      }
      final ??= await control.inspect({ kind: 'list' });
      const status = await control.inspect({ kind: 'status' });
      stop.abort();
      const outcome = await running;
      const linked = linkedWork(final);
      const trace = await traceOf();
      const others = trace.filter(entry => !(entry.method === 'GET' && entry.allowed));
      await save('convert-result', {
        status: settled(final) ? 'observed' : 'held',
        outcome,
        readiness: linked.ok ? (linked.work.readiness ?? null) : null,
        checks: linked.ok ? (linked.work.checks ?? null) : null,
        work: linked.ok
          ? {
              result: linked.work.result,
              queue: linked.work.queue,
              impediments: linked.work.impediments,
              history: linked.work.history.filter(item => item.origin === 'controller-readiness'),
            }
          : linked.reason,
        mutations: others.map(entry => [entry.method, entry.endpoint, entry.kind, entry.allowed]),
        exactlyOneMutation: others.length === 2 && others[0]!.kind === 'mark-ready' && others[1]!.kind === 'revocation' && others.every(entry => entry.allowed),
        requests: trace.length,
        controlStatus: status,
        events,
        deadlineReached: Date.now() >= deadline,
      });
      return;
    }
    const linked = linkedWork(await view(await snapshotStorage(`${observations}/convert-storage`, `${observations}/inspect-storage-copy`)));
    if (!linked.ok) throw new Error(linked.reason);
    const { codeRepository } = await compose();
    const again = await codeRepository.readPullRequest({ repo: repository, number: expectedPullRequest.number });
    await save('inspect-result', {
      readiness: linked.work.readiness ?? null,
      result: linked.work.result,
      impediments: linked.work.impediments,
      queue: linked.work.queue,
      history: linked.work.history.filter(item => item.origin === 'controller-readiness' || item.event === 'checks-evaluated'),
      rereadFacts: again,
      draftAfter: again.kind === 'observed' ? again.pullRequest.draft : null,
    });
    await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true });
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
