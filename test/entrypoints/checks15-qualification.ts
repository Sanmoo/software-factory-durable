import type { ExecutionPorts, WorkView } from '../../src/control/index.js';
import { snapshotStorage } from './review12-qualification.js';
export { snapshotStorage };

// TEST ONLY. Ticket 15 one-shot real qualification recipe: explain the required checks of the own draft pull request that ticket 14's real
// run (q14-publication-v6, issue #3 of Sanmoo/java-springboot-event-sourcing) created and linked. Import and `--plan` are inert. Every other
// phase is a REAL effect and needs an explicit operator grant: real GitHub through the App (READ-ONLY: GET requests plus installation token
// issuance). No model, no VM/Docker, no GitHub write, no merge/approval/ready conversion. One-shot: an exclusive intent tombstone precedes
// effects; a consumed phase never reruns; nothing is retried. The ticket 14 run storage is only ever COPIED, never opened in place.

const root = '/home/sanmoo/software-factory-test/y5';
const q14 = `${root}/q14-publication-v6`;
const observations = `${root}/q15-checks-v1`;
const revision = 'q15-checks-v1';
const phases = ['preflight', 'evaluate', 'inspect'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const evaluateDeadlineMs = 5 * 60 * 1000;
/** Long cadence: the first polling cycle runs at start and its tick runs the checks pass; at most two cycles fit in the deadline. */
const pollingSeconds = 180;

export function plan() {
  return { revision, root, source: `${q14}/control.sqlite (copied, never opened in place)`, observations, phases, repository, expectedTicket,
    requires: ['ticket 14 integrated in the composed revision (WorkView.publication)', `${q14}/discover-result.json present: the own draft PR was linked by ticket 14's real run`,
      'ticket 14 run ended without a held Slot (its stop-environment phase done or not needed): otherwise dispatch stays closed and no tick runs'],
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read',
      'checks-read {metadata:read, contents:read, pull_requests:read, checks:read, statuses:read, administration:read}'],
      writes: ['App: access_tokens issuance POSTs only (reduced read grants, cached per purpose); no other non-GET request'],
      never: ['GitHub write of any kind', 'merge', 'approval', 'ready-for-review conversion', 'rerun/approve of workflows', 'branch/ruleset/protection change', 'comment'],
      requestBound: 'per evaluation: 1 PR + 1 branch + 0..1 required_status_checks + rules pages (<=10) + check-run pages (<=10) + status pages (<=10) + 0..1 compare + 1 PR re-read; ' +
        'at most 2 Works per tick and 2 ticks in the evaluate deadline; plus the normal polling reads of the configured label' },
    model: 'none', sandbox: 'none (every execution port refuses and is logged)',
    effects: [
      'preflight: exclusive observations directory; private COPY of the q14 storage; read-only Control view of the Work of Ticket #3 (publication published, own PR linked); ' +
        'read-only GitHub readPullRequest of that PR (raw facts saved)',
      'evaluate: ANOTHER private copy becomes the authority of one owner run (runtimeInventory empty, polling 180 s): the first cycle polls, its tick explains the checks ' +
        'of the linked PR with the real adapter and records WorkView.checks; stop as soon as recorded (or 5 min)',
      'inspect: private copy of the evaluate storage: Control show view (checks.latest, checks.history, checks-evaluated events); a second read-only readPullRequest for comparison'],
    guards: ['one-shot intent tombstones', 'no retry', 'execution ports refuse every prepare/start/stop/activate/deliver/issue/revoke and record the attempt',
      'q14 storage never opened in place', 'nothing under the repository changes'],
    expected: [
      'checks.latest.pullRequest = the linked own PR (number, head = ticket 14 linked head unless a later push), observedAt <= completedAt, completeness per read',
      'requirements = classic required status checks + active (also organization) ruleset required_status_checks of main, by context+integration, strict per source',
      'if main has NO required check configured: requiredSet empty-complete only when the branch read, classic detail and rules read were all complete; any 403/404 -> unknown, never empty',
      'outcome: satisfied | waiting | failing | blocked | indeterminate as GitHub really reports; workflows/merge_queue/required_deployments rules -> indeterminate RULE_NOT_INTERPRETABLE',
      'conflict tri-state from mergeable; strict.state from the base tip comparison; optional and other-SHA results only visible',
      'no execution effect attempted (events empty), no impediment/queue change on the Work, every installation request GET'],
  };
}

/** Execution ports of a tracking-only owner: every effect is refused and recorded (a violation of the recipe if it ever happens). */
export function refusingPorts(log: (entry: Record<string, unknown>) => void): ExecutionPorts {
  const refuse = (call: string) => async () => { log({ call, refused: true }); throw new Error('RECIPE_TRACKING_ONLY'); };
  return { configuration: { schemaVersion: 1 }, capacity: 1, builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true },
    sandbox: { prepare: refuse('prepare'), start: refuse('start'), stop: refuse('stop') }, workers: { activate: refuse('activate'), deliver: refuse('deliver') },
    credentials: { issue: refuse('issue'), revoke: refuse('revoke') } };
}

/** The Work of Ticket #3 with ticket 14's linked own PR, or the reason it is not one. */
export function linkedWork(list: unknown): { ok: true; work: WorkView; pullRequest: { number: number } } | { ok: false; reason: string } {
  const works = (list as { kind?: string; works?: WorkView[] }).kind === 'list' ? (list as { works: WorkView[] }).works : [];
  const work = works.find(item => item.ticket.number === expectedTicket.number && item.ticket.repositoryId === expectedTicket.repositoryId);
  if (!work) return { ok: false, reason: 'WORK_NOT_FOUND' };
  const publication = (work as { publication?: { state?: string; pullRequest?: { number?: unknown; state?: string } | null } | null }).publication;
  if (publication?.state !== 'published' || typeof publication.pullRequest?.number !== 'number') return { ok: false, reason: 'OWN_PULL_REQUEST_NOT_LINKED' };
  if (work.result !== 'open') return { ok: false, reason: 'WORK_NOT_OPEN' };
  return { ok: true, work, pullRequest: { number: publication.pullRequest.number } };
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
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp });
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
      const linked = linkedWork(await view(await snapshotStorage(q14, `${observations}/preflight-storage-copy`)));
      if (!linked.ok) { await save('preflight-held', { reason: linked.reason }); throw new Error(linked.reason); }
      const { codeRepository } = await compose();
      const facts = await codeRepository.readPullRequest({ repo: repository, number: linked.pullRequest.number });
      if (facts.kind !== 'observed' || facts.pullRequest.state !== 'open' || facts.pullRequest.merged) { await save('preflight-held', { facts }); throw new Error('OWN_PULL_REQUEST_NOT_OPEN'); }
      await save('preflight-result', { status: 'success', work_id: linked.work.work_id, publication: (linked.work as { publication?: unknown }).publication ?? null, facts });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'evaluate') {
      const { tracker, codeRepository } = await compose();
      const { openControl } = await import('../../src/control/index.js');
      const events: unknown[] = [];
      const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), ...entry }); };
      const storagePath = await snapshotStorage(q14, `${observations}/evaluate-storage`);
      const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: refusingPorts(log), polling: { intervalSeconds: pollingSeconds },
        access: { tracker, repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base), findPublication: correlation => codeRepository.findPublication(correlation),
          async readPullRequest(query) {
            const result = await codeRepository.readPullRequest(query);
            log({ call: 'read-pull-request', number: query.number, kind: result.kind, ...(result.kind === 'observed' ? { headSha: result.pullRequest.headSha } : { code: result.code }) });
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
      await save('evaluate-result', { status: 'observed', outcome, checks: linked.ok ? linked.work.checks ?? null : null, linked: linked.ok ? null : linked.reason,
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
