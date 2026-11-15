import type { WorkView } from '../../src/control/index.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';
import { snapshotStorage } from './review12-qualification.js';
export { snapshotStorage };

// TEST ONLY. Ticket 15 one-shot real qualification recipe: explain the required checks of the own draft pull request that ticket 14's real
// run (q14-publication-v8: draft PR #5, head factory/3-99fe871b @ bfdd439, base main, issue #3 of Sanmoo/java-springboot-event-sourcing) created and linked. Import and `--plan` are inert. Every other
// phase is a REAL effect and needs an explicit operator grant: real GitHub through the App (READ-ONLY: GET requests plus installation token
// issuance). No model, no VM/Docker, no GitHub write, no merge/approval/ready conversion. One-shot: an exclusive intent tombstone precedes
// effects; a consumed phase never reruns; nothing is retried. The ticket 14 run storage is only ever COPIED, never opened in place.

const root = '/home/sanmoo/software-factory-test/y5';
const q14 = `${root}/q14-publication-v8`;
const observations = `${root}/q15-checks-v2`;
const revision = 'q15-checks-v2';
const phases = ['preflight', 'evaluate', 'inspect'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
/** The own draft PR ticket 14's v8 run published and linked (docs/evidence/14-direct-draft-publication-and-discovery.md). */
const expectedPullRequest = { number: 5, headRef: 'factory/3-99fe871b', linkedHeadPrefix: 'bfdd439', base: 'main' };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const evaluateDeadlineMs = 5 * 60 * 1000;
const ghTrace = `${observations}/gh-trace.jsonl`;
/** Long cadence: the first polling cycle runs at start and its tick runs the checks pass; at most two cycles fit in the deadline. */
const pollingSeconds = 180;

export function plan() {
  return { revision, root, source: `${q14}/control.sqlite (copied, never opened in place)`, observations, phases, repository, expectedTicket, expectedPullRequest,
    requires: ['ticket 14 integrated in the composed revision (WorkView.publication)', `${q14}/discover-result.json present: the own draft PR was linked by ticket 14's real run`,
      'ticket 14 run ended without a held Slot (its stop-environment phase done or not needed): otherwise dispatch stays closed and no tick runs'],
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read',
      'checks-read {metadata:read, contents:read, pull_requests:read, checks:read, statuses:read, administration:read}'],
      writes: ['App: access_tokens issuance POSTs only (reduced read grants, cached per purpose; native HTTPS, not gh); no other non-GET request'],
      guard: 'evaluate and inspect use a gh wrapper that records every request in gh-trace.jsonl and refuses (exit 97, nothing sent) any method other than GET; the ' +
        'IssueTracker is read-only (postComment refused locally), so a pending Question copied from q14 can never be published',
      never: ['GitHub write of any kind', 'merge', 'approval', 'ready-for-review conversion', 'rerun/approve of workflows', 'branch/ruleset/protection change', 'comment'],
      requestBound: 'per evaluation: 1 PR + 1 branch + 0..1 required_status_checks + rules pages (<=10) + check-run pages (<=10) + status pages (<=10) + 0..1 compare + 1 PR re-read; ' +
        'at most 2 Works per tick and 2 ticks in the evaluate deadline; plus the normal polling reads of the configured label' },
    model: 'none', sandbox: 'none', dispatch: 'disabled (no execution ports composed: EXECUTION_NOT_ENABLED) and the copy is paused first, so no Work is admitted or started',
    effects: [
      'preflight: exclusive observations directory; private COPY of the q14 storage, explicitly migrated (format 1 -> current, ticket 33 migrateStorage with the preserved ' +
        'digest checked before and after; the original is never opened); read-only Control view of the Work of Ticket #3 (publication published, own PR linked); ' +
        'read-only GitHub readPullRequest of that PR (raw facts saved)',
      'evaluate: ANOTHER private copy, explicitly migrated the same way, becomes the authority of one owner run, paused first (local pause on the copy), without execution ports (dispatch disabled), ' +
        'polling 180 s, read-only tracker and GET-only gh guard: after the first polling cycle the checks tracking step explains the linked PR with the real adapter ' +
        'and records WorkView.checks; stop as soon as recorded (or 5 min); the gh trace must show GET only',
      'inspect: private copy of the evaluate storage: Control show view (checks.latest, checks.history, checks-evaluated events); a second read-only readPullRequest for comparison'],
    guards: ['one-shot intent tombstones', 'no retry', 'no execution ports (nothing can be prepared, started, activated or granted)', 'read-only IssueTracker',
      'gh wrapper: GET only, every request traced',
      'q14 storage never opened in place', 'nothing under the repository changes'],
    expected: [
      'checks.latest.pullRequest = the linked own PR (number, head = ticket 14 linked head unless a later push), observedAt <= completedAt, completeness per read',
      'requirements = classic required status checks + active (also organization) ruleset required_status_checks of main, by context+integration, strict per source',
      'if main has NO required check configured: requiredSet empty-complete only when the branch read, classic detail and rules read were all complete; any 403/404 -> unknown, never empty',
      'outcome: satisfied | waiting | failing | blocked | indeterminate as GitHub really reports; workflows/merge_queue/required_deployments rules -> indeterminate RULE_NOT_INTERPRETABLE',
      'conflict tri-state from mergeable; strict.state from the base tip comparison; optional and other-SHA results only visible',
      'no comment attempted (events empty), no impediment/queue change on the Work, gh-trace.jsonl: every request GET and allowed'],
  };
}

/** The IssueTracker of a tracking-only owner: every read delegates; `postComment` is refused locally (nothing is sent) and recorded. */
export function readOnlyTracker(tracker: IssueTracker, log: (entry: Record<string, unknown>) => void): IssueTracker {
  return { checkAccess: scope => tracker.checkAccess(scope), listCandidates: scope => tracker.listCandidates(scope), readTicket: ticket => tracker.readTicket(ticket),
    readDependencyGraph: ticket => tracker.readDependencyGraph(ticket), readInputs: (ticket, cursor) => tracker.readInputs(ticket, cursor),
    findQuestion: (ticket, questionId) => tracker.findQuestion(ticket, questionId),
    async postComment(ticket) {
      log({ call: 'post-comment', refused: true, ticket: ticket.number });
      return { kind: 'failed', observedAt: new Date().toISOString(), code: 'RECIPE_READ_ONLY', nextStep: 'The ticket 15 recipe never writes to GitHub; nothing was sent.' };
    } };
}

/** Text of the gh wrapper: records every request; refuses (exit 97, the real gh never runs) any request that is not an explicit GET without input. */
export function ghGuardScript(input: { node: string; gh: string; trace: string }) {
  return `#!${input.node}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const at = args.indexOf('--method');
const method = at >= 0 ? args[at + 1] : null;
const allowed = method === 'GET' && !args.includes('--input');
appendFileSync(${JSON.stringify(input.trace)}, JSON.stringify({ at: new Date().toISOString(), method, endpoint: args.at(-1), allowed }) + '\\n');
if (!allowed) { process.stderr.write('RECIPE_GET_ONLY\\n'); process.exit(97); }
const result = spawnSync(${JSON.stringify(input.gh)}, args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`;
}

/** The Work of Ticket #3 with ticket 14's linked own PR, or the reason it is not one. */
export function linkedWork(list: unknown): { ok: true; work: WorkView; pullRequest: { number: number; headRef: string | null } } | { ok: false; reason: string } {
  const works = (list as { kind?: string; works?: WorkView[] }).kind === 'list' ? (list as { works: WorkView[] }).works : [];
  const work = works.find(item => item.ticket.number === expectedTicket.number && item.ticket.repositoryId === expectedTicket.repositoryId);
  if (!work) return { ok: false, reason: 'WORK_NOT_FOUND' };
  const publication = (work as { publication?: { state?: string; pullRequest?: { number?: unknown; headRef?: unknown; state?: string } | null } | null }).publication;
  if (publication?.state !== 'published' || typeof publication.pullRequest?.number !== 'number') return { ok: false, reason: 'OWN_PULL_REQUEST_NOT_LINKED' };
  if (work.result !== 'open') return { ok: false, reason: 'WORK_NOT_OPEN' };
  return { ok: true, work, pullRequest: { number: publication.pullRequest.number, headRef: typeof publication.pullRequest.headRef === 'string' ? publication.pullRequest.headRef : null } };
}

/**
 * q14-v8 is format-1 storage (pre ticket 33) and the integrated code refuses an implicit migration (STORAGE_MIGRATION_REQUIRED). Only a
 * COPY inside `within` (the observations directory) is migrated, explicitly, with ticket 33's `migrateStorage`, checked against the preserved
 * digest recorded before it; the preserved digest must be identical afterwards. The original is never opened. Returns the digests.
 */
export async function migrateCopy(copy: string, within: string, upgradeId: string) {
  if (!copy.startsWith(`${within}/`) || copy.includes('/../')) throw new Error('MIGRATION_ONLY_ON_A_COPY');
  const { inspectStorage, migrateStorage } = await import('../../src/control/index.js');
  const before = await inspectStorage(copy);
  if (before.kind !== 'storage') throw new Error('COPY_NOT_STORAGE');
  const digests = (inspection: typeof before) => ({ format: inspection.format, preservedDigest: inspection.preserved?.digest ?? null, stateDigest: inspection.stateDigest });
  if (before.operational === 'ready') return { kind: 'not-needed' as const, before: digests(before) };
  if (before.operational !== 'migration-required' || !before.preserved) throw new Error('COPY_STORAGE_INCOMPATIBLE');
  const result = await migrateStorage(copy, { upgradeId, release: revision, previousRelease: null, expectedDigest: before.preserved.digest });
  if (result.kind !== 'migrated') throw new Error(result.kind === 'refused' ? `COPY_MIGRATION_${result.code}` : 'COPY_MIGRATION_NOT_APPLIED');
  const after = result.after;
  if (after.kind !== 'storage' || after.operational !== 'ready' || after.preserved?.digest !== before.preserved.digest) throw new Error('COPY_MIGRATION_DIGEST_MISMATCH');
  return { kind: 'migrated' as const, migration: result.migration, before: digests(before), after: digests(after) };
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

/** gh behind the GET-only guard (written once, exclusively, in the observations directory). */
async function guardedGh() {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const target = `${observations}/gh-guard.mjs`;
  if (!(await fs.access(target).then(() => true, () => false))) {
    let gh: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(':').filter(item => item.startsWith('/'))) {
      if (await fs.access(`${directory}/gh`, constants.X_OK).then(() => true, () => false)) { gh = `${directory}/gh`; break; }
    }
    if (!gh) throw new Error('GH_NOT_FOUND');
    await fs.writeFile(target, ghGuardScript({ node: process.execPath, gh, trace: ghTrace }), { mode: 0o700, flag: 'wx' });
  }
  return target;
}

async function compose() {
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp, executable: await guardedGh() });
  return { tracker: createIssueTracker({ github, scopes: [repository], dependencyScopes: [] }), codeRepository: createCodeRepository({ github }) };
}

/** Read-only view of a storage COPY (a run aborted before it starts writes nothing). */
async function view(storagePath: string) {
  const { openControl } = await import('../../src/control/index.js');
  const stored = await openControl({ storagePath, runtimeInventory: 'unknown' });
  const list = await stored.inspect({ kind: 'list' });
  const stopped = new AbortController(); stopped.abort();
  await stored.run(stopped.signal);
  return list;
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists } = await io();
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      await fs.access(`${q14}/discover-result.json`);
      const copy = await snapshotStorage(q14, `${observations}/preflight-storage-copy`);
      const migration = await migrateCopy(copy, observations, `${revision}-preflight-copy`);
      await save('preflight-copy-migration', migration);
      const linked = linkedWork(await view(copy));
      if (!linked.ok) { await save('preflight-held', { reason: linked.reason }); throw new Error(linked.reason); }
      if (linked.pullRequest.number !== expectedPullRequest.number || linked.pullRequest.headRef !== expectedPullRequest.headRef) {
        await save('preflight-held', { reason: 'NOT_THE_EXPECTED_OWN_PULL_REQUEST', linked: linked.pullRequest }); throw new Error('NOT_THE_EXPECTED_OWN_PULL_REQUEST');
      }
      const { codeRepository } = await compose();
      const facts = await codeRepository.readPullRequest({ repo: repository, number: linked.pullRequest.number });
      if (facts.kind !== 'observed' || facts.pullRequest.state !== 'open' || facts.pullRequest.merged) { await save('preflight-held', { facts }); throw new Error('OWN_PULL_REQUEST_NOT_OPEN'); }
      // A head moved since ticket 14 linked bfdd439 is recorded (the evaluation then explains it with HEAD_NOT_LINKED_BY_FACTORY), never adopted.
      await save('preflight-result', { status: 'success', work_id: linked.work.work_id, publication: (linked.work as { publication?: unknown }).publication ?? null, facts,
        headStillLinked: facts.pullRequest.headSha.startsWith(expectedPullRequest.linkedHeadPrefix) });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'evaluate') {
      const { tracker, codeRepository } = await compose();
      const { openControl } = await import('../../src/control/index.js');
      const events: unknown[] = [];
      const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), ...entry }); };
      const storagePath = await snapshotStorage(q14, `${observations}/evaluate-storage`);
      await save('evaluate-copy-migration', await migrateCopy(storagePath, observations, `${revision}-evaluate-copy`));
      // Pause the COPY first (a local administrative command on the copy): nothing is admitted; no execution ports: nothing can start.
      const pausing = await openControl({ storagePath, runtimeInventory: 'unknown' });
      const { randomUUID } = await import('node:crypto');
      const paused = await pausing.accept({ request_id: randomUUID(), operation: 'pause', origin: 'local-cli' });
      const pauseStop = new AbortController(); pauseStop.abort();
      await pausing.run(pauseStop.signal);
      log({ call: 'pause-copy', receipt: paused });
      const control = await openControl({ storagePath, runtimeInventory: 'unknown', polling: { intervalSeconds: pollingSeconds },
        access: { tracker: readOnlyTracker(tracker, log), repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base), findPublication: correlation => codeRepository.findPublication(correlation),
          setDraft: async () => ({ kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_NO_READINESS', nextStep: 'This recipe never converts draft/ready; nothing was sent.', revocation: 'not-issued' }),
          async readPullRequest(query) {
            const result = await codeRepository.readPullRequest(query);
            log({ call: 'read-pull-request', number: query.number, kind: result.kind, ...(result.kind === 'observed' ? { headSha: result.pullRequest.headSha } : result.kind === 'unavailable' ? { code: result.code } : { unchanged: result.headSha }) });
            return result;
          } }, repositories: [repository], dependencyRepositories: [] } });
      const stop = new AbortController();
      const running = control.run(stop.signal);
      const deadline = Date.now() + evaluateDeadlineMs;
      let final: unknown;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const list = await control.inspect({ kind: 'list' });
        const linked = linkedWork(list);
        if (linked.ok && linked.work.checks) { final = list; break; }
      }
      final ??= await control.inspect({ kind: 'list' });
      const status = await control.inspect({ kind: 'status' });
      stop.abort();
      const outcome = await running;
      const linked = linkedWork(final);
      const trace = (await fs.readFile(ghTrace, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string | null; allowed: boolean });
      await save('evaluate-result', { getOnly: trace.every(entry => entry.method === 'GET' && entry.allowed), requests: trace.length, status: 'observed', outcome, checks: linked.ok ? linked.work.checks ?? null : null, linked: linked.ok ? null : linked.reason,
        work: linked.ok ? { queue: linked.work.queue, impediments: linked.work.impediments, dispatch: linked.work.dispatch } : null, controlStatus: status, events,
        deadlineReached: Date.now() >= deadline });
      return;
    }
    if (!(await exists('evaluate-result'))) throw new Error('EVALUATE_REQUIRED');
    const linked = linkedWork(await view(await snapshotStorage(`${observations}/evaluate-storage`, `${observations}/inspect-storage-copy`)));
    if (!linked.ok) throw new Error(linked.reason);
    const { codeRepository } = await compose();
    const again = await codeRepository.readPullRequest({ repo: repository, number: linked.pullRequest.number });
    await save('inspect-result', { checks: linked.work.checks ?? null, history: linked.work.history.filter(item => item.event === 'checks-evaluated'),
      impediments: linked.work.impediments, queue: linked.work.queue, rereadFacts: again });
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
