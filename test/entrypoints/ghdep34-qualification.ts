import type { ControlInput, ControlReceipt, ExecutionPorts, ListView, ShowView, WorkView } from '../../src/control/index.js';
import { ghGuardScript } from './cancel25-qualification.js';
import { memoryViolations } from './forget31-qualification.js';
import { secretScan } from './ghchecks34-qualification.js';

// TEST ONLY. Ticket 34 pre-pilot group R-GH-DEP (operator authorization 2026-11-16; decision D-02: dependencies are cross-repository): one-shot
// REAL qualification recipe for V-05.c (a blocker in ANOTHER repository read with that repository's own App installation; a repository that is
// not configured is refused; an omission is detected), V-05.e (a forgotten own Ticket as a real native blocker) and V-14.f (the q25 cancelled
// cycle forgotten in real data after its environment is cleaned up). Import, `--plan`, `--setup-steps` and the pure helpers are inert or local.
// The Control storage is a COPY of q25-cancel-v1 (and a private copy of its Records): the source run is only hashed. The q25 environment is the
// ONE resource removed in place: it is a single real resource at <y5>/environments/<env>, owned by that Work; a copy of its 40 GiB disk would
// not be that environment, and removing it through the product's own Sandbox.remove (ownership and cessation re-proved) is the point of V-14.f.
// No VM boot, no model, no Builder (capacity 0). GitHub is read through a GET-only gh guard (plus token issuance/revocation); every GitHub
// change is a HUMAN step the recipe only writes (apply AND restore). Phases are one-shot: exclusive intent tombstones; no retry.

const root = '/home/sanmoo/software-factory-test/y5';
const revision = 'q34-ghdep-v1';
const observations = `${root}/${revision}`;
const setupDirectory = `${root}/q34-ghdep-setup`;
export const phases = ['preflight', 'cleanup-forget', 'unconfigured', 'configured', 'inspect'] as const;
export type Phase = typeof phases[number];
const installationId = 177599217;
const repositoryA = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId, workflows: false, label: 'ready-for-agent' };
const repositoryIdA = 1256893534;
/** Repository B: NEW, public, owned by Sanmoo, the App installed on it; configured ONLY as dependency-only (never executable). */
export const repositoryB = { repository: 'Sanmoo/factory-dependency-fixture', installationId };
/** Repository C: NEW, private, the App NOT installed: a blocker there is invisible to the installation (omission). Never configured. */
export const repositoryC = { repository: 'Sanmoo/factory-dependency-hidden' };
/** The Factory configuration entry for B (config.yaml); the executable list stays [A]. */
export const configurationEntry = `dependencyRepositories:\n  - {repository: ${repositoryB.repository}, installationId: ${installationId}}\n`;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
export const keySource = `${root}/${githubApp.privateKeyFile}`;
const operatorLogin = 'Sanmoo';
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
/** The q25 run (consumed): cycle 1 cancelled (#18), its environment still present; cycle 2 open (never dispatched); storage globally paused. */
export const q25 = { storage: `${root}/q25-cancel-v1`, records: root, number: 18, cycle1: 'e8801f16-09c1-4002-961b-a298515f1974', cycle2: '1299ce8d-99ee-4022-881c-7b93b1e330d2',
  environment: 'env-41d60b6ef380638cf56ce8cd6d8530188d61b613b492b752f8bc422764672fe9' } as const;
const pollingSeconds = 30;
const phaseMinutes = { 'cleanup-forget': 15, unconfigured: 20, configured: 40 } as const;
const humanStepMinutes = 30;

/** Issue numbers created by the setup step; 0 refuses every phase (TICKET_NOT_PINNED) until pinned in a reviewed commit. */
export const pinned = { a1: 0, a2: 0, a3: 0, b1: 0, c1: 0 } as const;
const isPinned = () => Object.values(pinned).every(value => value > 0);
const doc = (what: string) => `Factory qualification fixture (R-GH-DEP, ticket 34). ${what} Documentation only: nothing is to be implemented; ` +
  'the Software Factory only evaluates its native blocked_by relations and never starts a Builder for it (capacity 0).';
export const issues = {
  a1: { repository: repositoryA.repository, title: 'Factory qualification: blocked by an issue of another repository', body: doc(`Natively blocked by ${repositoryB.repository} (configured dependency-only repository).`), label: true },
  a2: { repository: repositoryA.repository, title: 'Factory qualification: blocked by an issue the App cannot see', body: doc(`Natively blocked by ${repositoryC.repository} (private, App not installed).`), label: true },
  a3: { repository: repositoryA.repository, title: 'Factory qualification: blocked by a forgotten own Ticket', body: doc(`Natively blocked by ${repositoryA.repository}#${q25.number} (a Factory Ticket whose cycles are forgotten).`), label: true },
  b1: { repository: repositoryB.repository, title: 'Factory qualification: cross-repository blocker', body: doc('Blocks an issue of Sanmoo/java-springboot-event-sourcing; closed as completed during the run.'), label: false },
  c1: { repository: repositoryC.repository, title: 'Factory qualification: hidden blocker', body: doc('Blocks an issue of Sanmoo/java-springboot-event-sourcing; invisible to the App.'), label: false },
} as const;

export type HumanStep = { name: string; apply: string[]; restore: string[]; expect: string; note: string };
const create = (key: keyof typeof issues) => {
  const item = issues[key];
  return `${key.toUpperCase()}=$(gh issue create --repo ${item.repository} --title ${JSON.stringify(item.title)} --body ${JSON.stringify(item.body)}${item.label ? ` --label ${repositoryA.label}` : ''} | sed 's#.*/##')`;
};
const relate = (from: string, to: string) => `gh api --method POST repos/${repositoryA.repository}/issues/$${from}/dependencies/blocked_by -F issue_id=$${to} --silent`;
/** Where the operator adds a repository to the App's (user) installation: the `/user/installations` API needs a GitHub App user access token,
 * which the operator's classic OAuth gh token is not (observed 2026-11-16: HTTP 403 "must authenticate with an access token authorized to a GitHub App"). */
export const installationUrl = `https://github.com/settings/installations/${installationId}`;
const probeCommand = `node dist/test/entrypoints/ghdep34-qualification.js --probe-installation   # from the recipe worktree (built); App key only, prints memberships, never a key or token`;
/** The exact HUMAN steps (operator's account; never the App, never this recipe). `setup` precedes the pin; the others are requested by phases. */
export function humanSteps(input: { b1?: number; c1?: number; a?: number[] } = {}): Record<'repositories' | 'installation' | 'issues' | 'close-blockers' | 'teardown', HumanStep> {
  return {
    repositories: { name: 'repositories', expect: `${repositoryB.repository} public and ${repositoryC.repository} private exist (no installation change yet)`,
      apply: [`gh auth status 2>&1 | grep -i 'token scopes' | grep -q delete_repo || { echo 'the gh token lacks the delete_repo scope (teardown deletes B and C): ` +
        `run gh auth refresh -s delete_repo first'; exit 1; }   # scopes only; the token itself is never printed`,
        `gh repo create ${repositoryB.repository} --public --add-readme --description 'Software Factory qualification fixture: cross-repository blocker (R-GH-DEP)'`,
        `gh repo create ${repositoryC.repository} --private --add-readme --description 'Software Factory qualification fixture: blocker hidden from the App (R-GH-DEP)'`],
      restore: [`gh repo delete ${repositoryB.repository} --yes   # needs the delete_repo scope; also removes B from the installation`, `gh repo delete ${repositoryC.repository} --yes`],
      note: `restore only at teardown. Factory configuration entry for B (config.yaml; executable repositories stay [A]):\n${configurationEntry}` },
    installation: { name: 'installation', expect: `${repositoryB.repository} in installation ${installationId}; ${repositoryC.repository} not (verified with the App key)`,
      apply: [`echo 'OPERATOR (browser, your account): open ${installationUrl} ; under "Repository access" keep "Only select repositories", add ${repositoryB.repository} ` +
        `(do NOT add ${repositoryC.repository}) and press Save. If the page offers only "All repositories", stop: C could not be hidden.'`,
        'read -r -p "Press Enter after saving the installation page... " _', probeCommand],
      restore: [], note: `nothing to undo before teardown: deleting ${repositoryB.repository} removes it from the installation` },
    issues: { name: 'issues', expect: 'A1..A3 open and labelled with one native blocked_by each (B1, C1, A#18); B1 and C1 open',
      apply: [create('b1'), create('c1'), create('a1'), create('a2'), create('a3'),
        `B1_ID=$(gh api repos/${repositoryB.repository}/issues/$B1 --jq .id)`, `C1_ID=$(gh api repos/${repositoryC.repository}/issues/$C1 --jq .id)`,
        `I18_ID=$(gh api repos/${repositoryA.repository}/issues/${q25.number} --jq .id)`, relate('A1', 'B1_ID'), relate('A2', 'C1_ID'), relate('A3', 'I18_ID'),
        'echo "pin in ghdep34-qualification.ts: a1=$A1 a2=$A2 a3=$A3 b1=$B1 c1=$C1"'],
      restore: [], note: 'issues are closed at teardown (the native relations go with them)' },
    'close-blockers': { name: 'close-blockers', expect: `${repositoryB.repository}#${input.b1 ?? '<b1>'} and ${repositoryA.repository}#${q25.number} closed as completed`,
      apply: [`gh issue close ${input.b1 ?? '<b1>'} --repo ${repositoryB.repository} --reason completed`, `gh issue close ${q25.number} --repo ${repositoryA.repository} --reason completed`],
      restore: [`gh issue reopen ${q25.number} --repo ${repositoryA.repository}   # #18 was open (q25); B1 stays closed (fixture)`], note: 'run restore when the phase ends' },
    teardown: { name: 'teardown', expect: 'A1..A3 unlabelled and closed; fixtures removed', note: 'B/C deletion needs the delete_repo scope; keep them if the pilot reuses B',
      apply: [...(input.a ?? []).map(number => `gh issue edit ${number} --repo ${repositoryA.repository} --remove-label ${repositoryA.label} && gh issue close ${number} --repo ${repositoryA.repository} --reason 'not planned'`),
        ...(input.c1 ? [`gh issue close ${input.c1} --repo ${repositoryC.repository} --reason 'not planned'`] : []),
        `gh repo delete ${repositoryB.repository} --yes   # also removes B from the installation`, `gh repo delete ${repositoryC.repository} --yes`], restore: [] },
  };
}

export function plan() {
  const steps = humanSteps();
  return { revision, root, observations, setupDirectory, phases, decision: 'D-02 (cross-repository dependencies required before the pilot)',
    repositories: { executable: { ...repositoryA, repositoryId: repositoryIdA }, dependencyOnly: repositoryB, hidden: { ...repositoryC, appInstalled: false } }, configurationEntry,
    issues: Object.fromEntries(Object.entries(issues).map(([key, item]) => [key, { ...item, number: pinned[key as keyof typeof pinned], pinned: pinned[key as keyof typeof pinned] > 0 }])),
    relations: { a1: 'B1 (configured dependency-only repository)', a2: 'C1 (repository the App cannot read)', a3: `A#${q25.number} (forgotten own Ticket: both q25 cycles forgotten in the copy)` },
    humanSteps: Object.fromEntries(Object.entries(steps).map(([key, step]) => [key, { expect: step.expect, apply: step.apply, restore: step.restore, note: step.note }])),
    q25: { ...q25, storagePolicy: 'COPY (prepareAuthority: digest-checked migration of the copy only) + private Records copy; the source storage and Records are hashed before/after',
      environmentPolicy: 'IN PLACE: the product\'s Sandbox.remove at the y5 installation root (the environment is the single real resource; a copy would not be it); evidence and ' +
        'sessions are preserved into the Records COPY before removal' },
    requires: ['setup steps run by the operator (`--setup-steps` writes them) and the five issue numbers pinned in a reviewed commit',
      `${keySource} present (copied O_EXCL into the namespace for GitHub phases only)`, `q25-cancel-v1 and its environment ${q25.environment} present`,
      'no other open issue in A with the label except A1..A3 and #18'],
    model: 'none', vm: 'none (capacity 0: nothing is dispatched; the environment removal is host-only)',
    github: { app: githubApp, purposes: ['dependency-read {metadata:read, issues:read} per repository with ITS installation', 'tracker/association/checks reads of A (GET)'],
      guard: 'gh behind the GET-only guard (cancel25): GET without input and DELETE /installation/token only; everything else exit 97, traced in gh-trace.jsonl',
      writes: ['App: access_tokens issuance POSTs and token self-revocation only', 'none by the controller (no comment, label or mutation)'],
      human: ['setup: repositories (create B public + C private), installation (browser: add B on the installation page; verified by --probe-installation with the App key) and ' +
        'issues (B1, C1, A1..A3 labelled, three native relations)',
        `configured: close-blockers (close B1 and A#${q25.number} as completed; restore reopens #${q25.number})`, 'teardown (written by inspect)'] },
    effects: [
      'preflight (GET-only): exclusive namespace; COPY of q25-cancel-v1 into authority/ (migrated copy only) and of its Records into records/; source digests; environment present; ' +
        'A listing = {A1,A2,A3} (+#18), titles/bodies exact; the raw blocked_by listings and summaries of A1..A3; B readable with its installation (dependency-only access check); ' +
        'C NOT readable by the App',
      'cleanup-forget (local + host, no GitHub): owner on the copy (capacity 0): forget-plan cycle 1 refused RESOURCES_PENDING -> cleanup-plan [environment] + confirm -> the product ' +
        'preserves evidence/sessions into the Records copy and removes the REAL environment (Sandbox.remove) -> forget-plan + confirm -> cycle 1 forgotten; then cancel cycle 2 (never ' +
        `dispatched) and forget it: #${q25.number} is a fully forgotten own Ticket (V-14.f; prepares V-05.e)`,
      `unconfigured (GET-only): unpause the copy; owner with dependencyRepositories [] polls A every ${pollingSeconds} s: A1 inconclusive DEPENDENCY_REPOSITORY_NOT_CONFIGURED (B never read), ` +
        `A2 incomplete (omission: DEPENDENCY_COUNT_MISMATCH expected), A3 pending own OWN_CYCLE_CANCELLED (forgotten memory), #${q25.number} existing (never re-admitted); nothing dispatched`,
      `configured (GET-only): new owner with dependencyRepositories [B]: A1 pending EXTERNAL_BLOCKER_OPEN read with B's own installation (dependency-only principal); human step ` +
        `close-blockers; A1 satisfied; A3 still pending OWN_CYCLE_CANCELLED although #${q25.number} is closed/completed (own, never external); A2 still not satisfied`,
      'inspect: inert view of a copy; source digests again; environment directory state; token scan of the namespace; verdict.json; human-step-teardown-requested.json'],
    openQuestion: 'a PRIVATE dependency-only repository WITH the App installed is not exercised: tokens are minted per repository, so A\'s blocked_by listing may omit its issues ' +
      '(the graph would then be incomplete, never released). Only a public B is proven here.',
  };
}

/** Phase order: each phase once; each after the previous one SUCCEEDED; inspect after a successful preflight. */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, ready = isPinned()): string | null {
  if (!ready) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase !== 'preflight' && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  const previous: Partial<Record<Phase, Phase>> = { unconfigured: 'cleanup-forget', configured: 'unconfigured' };
  const before = previous[phase];
  if (before && results[before]?.status !== 'success') return `${before.toUpperCase().replace('-', '_')}_SUCCESS_REQUIRED`;
  return null;
}

const pick = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((at, key) => at && typeof at === 'object' ? (at as Record<string, unknown>)[key as string] : undefined, value);
const list = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
/** The dependency facts of one Work as Control recorded them (latest evaluation). */
export function dependencyFacts(work: unknown) {
  const latest = pick(work, 'dependencies', 'latest');
  return { conclusion: pick(latest, 'conclusion') ?? null, completeness: pick(latest, 'completeness') ?? null,
    reasons: list(pick(latest, 'reasons')).map(item => `${item.code}${item.repository ? `:${item.repository}` : ''}`),
    blockers: list(pick(latest, 'blockers')).map(item => ({ repository: item.repository, number: item.number, state: item.state, stateReason: item.stateReason, role: item.repositoryRole,
      classification: item.classification, satisfied: item.satisfied, reason: item.reason, work_id: item.work_id })),
    principals: list(pick(latest, 'principals')).map(item => `${String(item.repository)}:${String(item.role)}:${String(item.installationId)}`),
    executions: pick(work, 'execution') ? 1 + list(pick(work, 'previousExecutions')).length : list(pick(work, 'previousExecutions')).length };
}
type Check = { id: string; obligation: string; expected: unknown; observed: unknown; met: boolean };
const lower = (text: unknown) => String(text).toLowerCase();
/** Expectations of the two GitHub phases over the Works (A1..A3) as recorded; `stage`: unconfigured, configured-open (B1 open) or configured-closed. */
export function dependencyChecks(stage: 'unconfigured' | 'configured-open' | 'configured-closed', works: Record<'a1' | 'a2' | 'a3', unknown>): Check[] {
  const [a1, a2, a3] = [dependencyFacts(works.a1), dependencyFacts(works.a2), dependencyFacts(works.a3)];
  const b = lower(repositoryB.repository), c = lower(repositoryC.repository);
  const blockerOf = (facts: ReturnType<typeof dependencyFacts>, repository: string) => facts.blockers.find(item => lower(item.repository) === repository);
  const own = blockerOf(a3, lower(repositoryA.repository));
  const checks: Check[] = [];
  const add = (id: string, obligation: string, expected: unknown, observed: unknown, met: boolean) => checks.push({ id: `${stage}.${id}`, obligation, expected, observed, met });
  if (stage === 'unconfigured') {
    add('a1-not-configured', 'V-05.c', { conclusion: 'inconclusive', reason: `DEPENDENCY_REPOSITORY_NOT_CONFIGURED:${repositoryB.repository}`, role: 'not-configured', bRead: false },
      { conclusion: a1.conclusion, reasons: a1.reasons, role: blockerOf(a1, b)?.role ?? null, principals: a1.principals },
      a1.conclusion === 'inconclusive' && a1.reasons.some(item => lower(item) === `dependency_repository_not_configured:${b}`) && blockerOf(a1, b)?.role === 'not-configured' &&
        !a1.principals.some(item => lower(item).startsWith(b)));
  } else {
    const blocker = blockerOf(a1, b);
    const open = stage === 'configured-open';
    add('a1-cross-repository', 'V-05.c', { conclusion: open ? 'pending' : 'satisfied', role: 'dependency-only', classification: 'external', principal: `${repositoryB.repository}:dependency-only:${installationId}`,
      reason: open ? 'EXTERNAL_BLOCKER_OPEN' : null }, { conclusion: a1.conclusion, blocker, principals: a1.principals },
    a1.conclusion === (open ? 'pending' : 'satisfied') && a1.completeness === 'complete' && blocker?.role === 'dependency-only' && blocker.classification === 'external' &&
      blocker.reason === (open ? 'EXTERNAL_BLOCKER_OPEN' : null) && a1.principals.some(item => lower(item) === `${b}:dependency-only:${installationId}`));
  }
  add('a2-omission-detected', 'V-05.c', { conclusion: 'not satisfied', completeness: 'incomplete', reason: 'DEPENDENCY_COUNT_MISMATCH (or C not configured)', cRead: false },
    { conclusion: a2.conclusion, completeness: a2.completeness, reasons: a2.reasons, principals: a2.principals },
    a2.conclusion !== 'satisfied' && a2.completeness === 'incomplete' && a2.reasons.some(item => /^DEPENDENCY_(COUNT_MISMATCH|REPOSITORY_NOT_CONFIGURED|SUMMARY_UNAVAILABLE)/.test(item)) &&
      !a2.principals.some(item => lower(item).startsWith(c)));
  add('a3-forgotten-own', 'V-05.e', { conclusion: 'pending', classification: 'own', reason: 'OWN_CYCLE_CANCELLED', work_id: q25.cycle2, state: stage === 'configured-closed' ? 'closed' : 'any' },
    { conclusion: a3.conclusion, blocker: own ?? null },
    a3.conclusion === 'pending' && own?.classification === 'own' && own.reason === 'OWN_CYCLE_CANCELLED' && own.work_id === q25.cycle2 && own.satisfied === false &&
      (stage !== 'configured-closed' || (own.state === 'closed' && own.stateReason === 'completed')));
  add('nothing-dispatched', 'V-05.c', 0, a1.executions + a2.executions + a3.executions, a1.executions + a2.executions + a3.executions === 0);
  return checks;
}
/** Expectations of the cleanup-forget phase (V-14.f, and the forgotten Ticket V-05.e relies on). */
export function forgetChecks(result: Record<string, unknown> | null, environment: { removedMarker: boolean; leftovers: string[] } | null): Check[] {
  const receipt = (name: string) => pick(result, name) as { outcome?: string; reason?: string | null; plan?: { state?: string; refusals?: { code: string }[] } | null } | undefined;
  const removals = list(pick(result, 'removals'));
  const memory = pick(result, 'shown1', 'memory') as Record<string, unknown> | null ?? null;
  return [
    { id: 'forget.refused-before-cleanup', obligation: 'V-14.f', expected: { outcome: 'not-applied', code: 'RESOURCES_PENDING' },
      observed: { outcome: receipt('firstPlan')?.outcome ?? null, refusals: receipt('firstPlan')?.plan?.refusals?.map(item => item.code) ?? null },
      met: receipt('firstPlan')?.outcome === 'not-applied' && Boolean(receipt('firstPlan')?.plan?.refusals?.some(item => item.code === 'RESOURCES_PENDING')) },
    { id: 'forget.environment-removed-in-place', obligation: 'V-14.f', expected: { cleanup: 'accepted', removals: [`${q25.environment}:success`], marker: true, leftovers: [] },
      observed: { cleanup: receipt('cleanupConfirm')?.outcome ?? null, removals: removals.map(item => `${String(item.environment)}:${String(item.status)}`), marker: environment?.removedMarker ?? null,
        leftovers: environment?.leftovers ?? null },
      met: receipt('cleanupConfirm')?.outcome === 'accepted' && removals.length === 1 && removals[0]!.environment === q25.environment && removals[0]!.status === 'success' &&
        environment?.removedMarker === true && environment.leftovers.length === 0 },
    { id: 'forget.cycle1-forgotten', obligation: 'V-14.f', expected: { plan: 'planned', shown: 'work-forgotten', result: 'cancelled', keys: [] },
      observed: { plan: receipt('secondPlan')?.plan?.state ?? null, shown: pick(result, 'shown1', 'kind') ?? null, result: memory?.result ?? null, keys: memoryViolations(memory) },
      met: receipt('secondPlan')?.plan?.state === 'planned' && pick(result, 'shown1', 'kind') === 'work-forgotten' && memory?.result === 'cancelled' && memoryViolations(memory).length === 0 },
    { id: 'forget.records-copy-deleted', obligation: 'V-14.f', expected: { present: false }, observed: pick(result, 'recordsAfter') ?? null, met: pick(result, 'recordsAfter', 'present') === false },
    { id: 'forget.cycle2-cancelled-and-forgotten', obligation: 'V-05.e', expected: { cancel: 'accepted', shown: 'work-forgotten', result: 'cancelled' },
      observed: { cancel: receipt('cancel2')?.outcome ?? null, shown: pick(result, 'shown2', 'kind') ?? null, result: pick(result, 'shown2', 'memory', 'result') ?? null },
      met: receipt('cancel2')?.outcome === 'accepted' && pick(result, 'shown2', 'kind') === 'work-forgotten' && pick(result, 'shown2', 'memory', 'result') === 'cancelled' },
    { id: 'forget.no-remote-call', obligation: 'V-14.f', expected: 0, observed: pick(result, 'remoteCalls') ?? null, met: pick(result, 'remoteCalls') === 0 },
  ];
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown, directory = observations) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${directory}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const load = (name: string) => fs.readFile(`${observations}/${name}.json`, 'utf8').then(text => JSON.parse(text) as { status?: unknown } & Record<string, unknown>, () => null);
  return { fs, save, exists, load };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** sha256 of a tree, never following anything (relative path, type and content or link target). */
async function treeDigest(path: string) {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const walk = async (current: string, relative: string): Promise<void> => {
    const info = await fs.lstat(current).catch(() => null);
    if (!info) { hash.update(`${relative}:absent`); return; }
    if (info.isSymbolicLink()) { hash.update(`${relative}:link:${await fs.readlink(current)}`); return; }
    if (info.isDirectory()) { hash.update(`${relative}:dir`); for (const name of (await fs.readdir(current)).sort()) await walk(`${current}/${name}`, `${relative}/${name}`); return; }
    if (info.isFile()) { hash.update(`${relative}:file:`).update(await fs.readFile(current)); return; }
    hash.update(`${relative}:special`);
  };
  await walk(path, '.');
  return hash.digest('hex');
}
/** Digests of the q25 SOURCE (storage files and both cycles' Records): must be identical before and after. */
async function sourceDigest() {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  for (const name of ['control.sqlite', 'control.sqlite-wal', 'control.sqlite-shm']) hash.update(name).update(await fs.readFile(`${q25.storage}/${name}`).catch(() => Buffer.from('absent')));
  return { storage: hash.digest('hex'), records1: await treeDigest(`${q25.records}/${q25.cycle1}`), records2: await treeDigest(`${q25.records}/${q25.cycle2}`) };
}
/** The q25 environment directory after removal: the product's removed.json marker and no disk/workspace/artifacts left. */
async function environmentState() {
  const fs = await import('node:fs/promises');
  const directory = `${root}/environments/${q25.environment}`;
  const present = async (name: string) => fs.lstat(`${directory}/${name}`).then(() => true, () => false);
  return { directory: await present('.'), removedMarker: await present('removed.json'),
    leftovers: (await Promise.all(['root.qcow2', 'workspace', 'artifacts'].map(async name => await present(name) ? name : null))).filter((item): item is string => item !== null) };
}

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
    await fs.writeFile(target, ghGuardScript({ node: process.execPath, gh, trace: `${observations}/gh-trace.jsonl` }), { mode: 0o700, flag: 'wx' });
  }
  return target;
}
async function compose(dependencies: { repository: string; installationId: number }[]) {
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp, executable: await guardedGh() });
  const dependencyScopes = dependencies.map(entry => ({ ...entry, workflows: false }));
  return { github, tracker: createIssueTracker({ github, scopes: [repositoryA], dependencyScopes }), codeRepository: createCodeRepository({ github }), dependencyScopes };
}
const traceOf = async () => {
  const fs = await import('node:fs/promises');
  return (await fs.readFile(`${observations}/gh-trace.jsonl`, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string | null; endpoint: string; allowed: boolean });
};

/** Refusing execution ports (capacity 0, nothing dispatched), the Records COPY for details, and an optional real cleanup at the y5 root. */
/** Port and double calls that would be an effect outside the recipe (a refused attempt counts too); reads of the refusing tracker are not. */
export const effectCalls = ['postComment', 'setDraft', 'cleanupBranch', 'reopenPullRequest', 'sandbox.prepare', 'sandbox.start', 'sandbox.stop', 'workers.activate', 'workers.deliver', 'credentials.issue'];
const effects = (calls: Record<string, number>) => effectCalls.reduce((sum, name) => sum + (calls[name] ?? 0), 0);
async function ports(recordsRoot: string, cleanup: 'refused' | 'real', removals: Record<string, unknown>[]): Promise<{ execution: ExecutionPorts; calls: Record<string, number> }> {
  const { localDoubles } = await import('./retention30-qualification.js');
  const { detailPorts } = await import('../../src/entrypoints/controller/composition.js');
  const doubles = localDoubles();
  const calls = doubles.calls;
  const copy = detailPorts(recordsRoot);
  const base = doubles.ports(copy, Date.now());
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  if (cleanup === 'refused') return { execution: base, calls };
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { preserveEvidence, preserveSessionCopy } = await import('../../src/records/index.js');
  const { readConfinedFile, readSessionFile } = await import('../../src/platform/host/index.js');
  const { realpath } = await import('node:fs/promises');
  const sandbox = createSandbox({ root, guestAssets });
  const real = detailPorts(root);
  // Recipe composition of the product's own cleanup over TWO roots: sessions are READ at the y5 root (where the q25 boot ran) and preserved into
  // the Records COPY (as composition.ts preserveSession does over one root); evidence is staged from the real environment into the copy.
  const details = { ...copy, runtimeSessions: real.runtimeSessions,
    async preserveSession(input: { workId: string; executionId: string; name?: string; session: { ref: string; sha256: string } }) {
      const canonical = await realpath(root);
      const read = input.name ? await readConfinedFile(canonical, input.session.ref, { allowEmpty: true }) : await readSessionFile(canonical, input.session.ref);
      if (read.state === 'lost') return { status: 'lost' as const, code: read.code };
      if (read.state !== 'read') return { status: 'failed' as const, code: read.code };
      if (read.sha256 !== input.session.sha256) return { status: 'failed' as const, code: 'SESSION_ALTERED' };
      return preserveSessionCopy(recordsRoot, input.workId, input.name ?? input.executionId, read.data, read.sha256);
    } } as typeof copy;
  return { calls, execution: { ...base, cleanup: { ...base.cleanup!, details,
    async remove(input) {
      count('sandbox.remove');
      const result = await sandbox.remove(input);
      removals.push({ environment: input.environment, status: result.status, ...('code' in result ? { code: result.code } : {}), resources: result.resources });
      return result;
    },
    async preserve({ workId, environment }) {
      count('records.preserve');
      let absent = false;
      const result = await preserveEvidence({ root: recordsRoot, workId, label: environment, stage: async destination => {
        const exported = await sandbox.exportEvidence({ environment, destination });
        if (exported.status === 'absent') absent = true;
        else if (exported.status === 'failure') throw new Error(exported.code);
      } });
      return absent && result.status === 'preserved' ? { status: 'absent' as const } : result;
    } } } };
}

type Accept = (command: Record<string, unknown>) => Promise<ControlReceipt | { kind: 'refused'; code: string }>;
/** One owner on the authority copy; `body` drives it through the public Control (the CLI's own path); it stops cleanly afterwards. */
async function owner<T>(input: { access: Record<string, unknown>; execution: ExecutionPorts; minutes: number },
  body: (tools: { accept: Accept; show: (workId: string) => Promise<ShowView>; list: () => Promise<ListView>; until: (condition: () => Promise<boolean>) => Promise<boolean>;
    sweeps: () => Promise<number> }) => Promise<T>) {
  const { openControl } = await import('../../src/control/index.js');
  const control = await openControl({ storagePath: `${observations}/authority/control.sqlite`,
    runtimeInventory: { kind: 'listed', observedAt: new Date().toISOString(), environments: [], cache: [], unknown: [] },
    access: input.access as never, polling: { intervalSeconds: pollingSeconds }, execution: input.execution });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + input.minutes * 60 * 1000;
  const until = async (condition: () => Promise<boolean>) => { while (Date.now() < deadline) { if (await condition()) return true; await sleep(500); } return false; };
  try {
    return { value: await body({ accept: command => control.accept({ ...command, origin: 'local-cli' } as ControlInput) as never,
      show: async workId => await control.inspect({ kind: 'show', work_id: workId }) as ShowView, list: async () => await control.inspect({ kind: 'list' }) as ListView, until,
      sweeps: async () => { const status = await control.inspect({ kind: 'status' }); return 'retention' in status ? status.retention?.sweeps ?? 0 : 0; } }),
    deadlineReached: Date.now() >= deadline };
  } finally { stop.abort(); await running; }
}
const planOf = (receipt: unknown) => (receipt as { plan?: { planId?: string; state?: string } | null } | null)?.plan ?? null;
const worksByIssue = (view: ListView) => Object.fromEntries((['a1', 'a2', 'a3'] as const).map(key =>
  [key, view.works.find(work => work.ticket.repository.toLowerCase() === repositoryA.repository.toLowerCase() && work.ticket.number === pinned[key]) ?? null])) as Record<'a1' | 'a2' | 'a3', WorkView | null>;
const evaluated = (view: ListView, attempt: Set<string>) => Object.values(worksByIssue(view)).every(work => {
  const latest = work?.dependencies.latest;
  return Boolean(latest) && !attempt.has(latest!.attemptId);
});

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (!isPinned()) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  const { requireKeySource } = await import('./humanchanges21-qualification.js');
  const usesGitHub = phase !== 'cleanup-forget';
  if (phase === 'preflight') {
    await requireKeySource(path => fs.access(path)); // before ANY effect
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    for (const name of ['credentials', 'run', 'records']) await fs.mkdir(`${observations}/${name}`, { mode: 0o700 });
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (usesGitHub) {
      await requireKeySource(path => fs.access(path));
      const { constants } = await import('node:fs');
      await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
      await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
    }
    const recordsRoot = await fs.realpath(`${observations}/records`);
    if (phase === 'preflight') {
      const sourceBefore = await sourceDigest();
      const environment = await environmentState();
      const { prepareAuthority } = await import('./delivery17-qualification.js');
      const { copyRecords } = await import('./retention30-qualification.js');
      const authority = await prepareAuthority(q25.storage, `${observations}/authority`, `${revision}-q25`);
      const { snapshotStorage } = await import('./review12-qualification.js');
      const { openControl } = await import('../../src/control/index.js');
      const inert = await openControl({ storagePath: await snapshotStorage(`${observations}/authority`, `${observations}/preflight-storage-copy`), runtimeInventory: 'unknown' });
      const view = await inert.inspect({ kind: 'list' }) as ListView;
      const stopped = new AbortController(); stopped.abort(); await inert.run(stopped.signal);
      const cycle1 = view.works.find(work => work.work_id === q25.cycle1), cycle2 = view.works.find(work => work.work_id === q25.cycle2);
      const copied: Record<string, unknown> = {};
      for (const id of [q25.cycle1, q25.cycle2]) copied[id] = await fs.lstat(`${q25.records}/${id}`).then(() => true, () => false) ? await copyRecords(`${q25.records}/${id}`, `${recordsRoot}/${id}`) : { absent: true };
      const { github, tracker } = await compose([]);
      const read = (scope: { repository: string; installationId: number }, path: string) => github.read({ ...scope, workflows: false }, 'dependency-read', session => session.get(path));
      const listing = await tracker.listCandidates(repositoryA);
      const raw: Record<string, unknown> = {};
      const reasons: string[] = [];
      for (const key of ['a1', 'a2', 'a3'] as const) {
        const issue = await read(repositoryA, `/repos/${repositoryA.repository}/issues/${pinned[key]}`);
        const blockedBy = await github.read(repositoryA, 'dependency-read', session => session.list(`/repos/${repositoryA.repository}/issues/${pinned[key]}/dependencies/blocked_by`));
        raw[key] = { issue: issue.ok ? { state: pick(issue.value, 'state'), title: pick(issue.value, 'title'), summary: pick(issue.value, 'issue_dependencies_summary'),
          labels: list(pick(issue.value, 'labels')).map(label => label.name) } : issue, blockedBy: blockedBy.ok ? list(blockedBy.value).map(item => item.html_url) : blockedBy };
        if (!issue.ok || pick(issue.value, 'state') !== 'open' || pick(issue.value, 'title') !== issues[key].title || lower(pick(issue.value, 'body')).replaceAll('\r\n', '\n') !== lower(issues[key].body)) reasons.push(`ISSUE_${key.toUpperCase()}`);
      }
      const b1 = await read(repositoryB, `/repos/${repositoryB.repository}/issues/${pinned.b1}`);
      const bAccess = await tracker.checkAccess({ ...repositoryB, workflows: false, role: 'dependency-only' });
      const cRead = await read({ repository: repositoryC.repository, installationId }, `/repos/${repositoryC.repository}`);
      const i18 = await read(repositoryA, `/repos/${repositoryA.repository}/issues/${q25.number}`);
      const listed = listing.kind === 'observed' ? listing.candidates.map(item => item.number).sort((x, y) => x - y) : null;
      const expected: number[] = [pinned.a1, pinned.a2, pinned.a3];
      if (!listed || !expected.every(number => listed.includes(number)) || listed.some(number => !expected.includes(number) && number !== q25.number)) reasons.push('LABEL_LISTING');
      if (!b1.ok || pick(b1.value, 'state') !== 'open') reasons.push('B1_NOT_OPEN');
      if (pick(bAccess, 'status') !== 'ok') reasons.push('B_ACCESS');
      if (cRead.ok) reasons.push('C_READABLE_BY_APP');
      if (!environment.directory || environment.removedMarker) reasons.push('Q25_ENVIRONMENT_NOT_PRESENT');
      if (cycle1?.result !== 'cancelled' || cycle1.cancellation?.state !== 'ceased' || cycle2?.result !== 'open' || cycle2.execution) reasons.push('Q25_STORAGE_UNEXPECTED');
      const owner = await github.read(repositoryA, 'tracker-read', session => session.get(`/repos/${repositoryA.repository}`));
      const { resolveOperator } = await import('./humanchanges21-qualification.js');
      const operator = owner.ok ? resolveOperator(owner.value, operatorLogin) : null;
      const trace = await traceOf();
      if (!trace.every(entry => entry.allowed)) reasons.push('NON_GET_REQUEST');
      const result = { status: reasons.length ? 'held' : 'success', reasons, operators: operator ? [operator] : [], authority, copied, environment, sourceBefore, listed, raw,
        b1: b1.ok ? { state: pick(b1.value, 'state'), id: pick(b1.value, 'id') } : b1, bAccess, cReadable: cRead.ok, issue18: i18.ok ? { state: pick(i18.value, 'state'), labels: list(pick(i18.value, 'labels')).map(label => label.name) } : i18,
        q25: { cycle1: cycle1 ? { result: cycle1.result, cancellation: cycle1.cancellation?.state } : null, cycle2: cycle2 ? { result: cycle2.result } : null } };
      await save('preflight-result', result);
      if (reasons.length) throw new Error('PRECONDITION_HELD');
      return;
    }
    const preflight = await load('preflight-result');
    const operators = (preflight?.operators as { login: string; id: number }[] | undefined) ?? [];
    if (phase === 'cleanup-forget') {
      const removals: Record<string, unknown>[] = [];
      const { localDoubles } = await import('./retention30-qualification.js');
      const doubles = localDoubles();
      const composed = await ports(recordsRoot, 'real', removals);
      const run = await owner({ access: { tracker: doubles.tracker, repository: doubles.codeRepository, repositories: [repositoryA], dependencyRepositories: [] },
        execution: composed.execution, minutes: phaseMinutes['cleanup-forget'] }, async ({ accept, show, until, sweeps }) => {
        const out: Record<string, unknown> = {};
        // The boot sweep settles the desks before any operator command (as the ticket 31 recipe).
        await until(async () => await sweeps() >= 1);
        const forget = async (workId: string, prefix: string) => {
          const receipt = await accept({ request_id: `${revision}-${prefix}-plan`, operation: 'forget-plan', work_id: workId });
          const planned = planOf(receipt);
          if (planned?.state !== 'planned' || !planned.planId) return { plan: receipt, confirm: null };
          const confirm = await accept({ request_id: `${revision}-${prefix}-confirm`, operation: 'forget-confirm', work_id: workId, plan_id: planned.planId });
          await until(async () => { const view = await show(workId); return view.kind === 'work-forgotten' || (view.kind === 'work' && ['failed', 'dropped', 'indeterminate'].includes(view.work.forget?.plans.at(-1)?.state ?? '')); });
          return { plan: receipt, confirm };
        };
        out.firstPlan = await accept({ request_id: `${revision}-c1-plan-1`, operation: 'forget-plan', work_id: q25.cycle1 });
        out.cleanupPlan = await accept({ request_id: `${revision}-c1-cleanup`, operation: 'cleanup-plan', work_id: q25.cycle1, select: ['environment'] });
        const cleanupId = planOf(out.cleanupPlan)?.planId;
        if (cleanupId) out.cleanupConfirm = await accept({ request_id: `${revision}-c1-cleanup-confirm`, operation: 'cleanup-confirm', work_id: q25.cycle1, plan_id: cleanupId });
        await until(async () => { const view = await show(q25.cycle1); return view.kind === 'work' && view.work.cleanup?.explicit?.consumed === true; });
        const second = await forget(q25.cycle1, 'c1-2');
        out.secondPlan = second.plan; out.confirm1 = second.confirm; out.shown1 = await show(q25.cycle1);
        out.cancel2 = await accept({ request_id: `${revision}-c2-cancel`, operation: 'cancel', work_id: q25.cycle2 });
        await until(async () => { const view = await show(q25.cycle2); return view.kind === 'work' && view.work.cancellation?.state === 'ceased'; });
        const third = await forget(q25.cycle2, 'c2');
        out.plan2 = third.plan; out.confirm2 = third.confirm; out.shown2 = await show(q25.cycle2);
        return out;
      });
      const { inspectWorkRecords } = await import('../../src/records/index.js');
      const records = await inspectWorkRecords(recordsRoot, q25.cycle1);
      const remoteCalls = effects(composed.calls) + effects(doubles.calls);
      const result = { ...run.value, removals, calls: { ports: composed.calls, doubles: doubles.calls }, remoteCalls, deadlineReached: run.deadlineReached,
        recordsAfter: { present: records.present, leftover: records.leftover, files: records.files } };
      const checks = forgetChecks(result, await environmentState());
      await save('cleanup-forget-result', { status: checks.every(item => item.met) ? 'success' : 'held', checks, ...result });
      if (!checks.every(item => item.met)) throw new Error('PHASE_NOT_AS_EXPECTED');
      return;
    }
    if (phase === 'unconfigured' || phase === 'configured') {
      const configured = phase === 'configured';
      const { github, tracker, codeRepository, dependencyScopes } = await compose(configured ? [repositoryB] : []);
      const access = { tracker, repository: codeRepository, repositories: [repositoryA], dependencyRepositories: dependencyScopes, operators, factoryApp: () => github.appIdentity(repositoryA) };
      const composed = await ports(recordsRoot, 'refused', []);
      const calls = composed.calls;
      const run = await owner({ access, execution: composed.execution, minutes: phaseMinutes[phase] }, async ({ accept, list: view, until }) => {
        const out: Record<string, unknown> = {};
        if (!configured) out.unpause = await accept({ request_id: `${revision}-unpause`, operation: 'unpause' });
        // Only evaluations of THIS owner count (a new attempt id per polling round; earlier ones are excluded).
        const earlier = new Set(Object.values(worksByIssue(await view())).flatMap(work => work?.dependencies.latest ? [work.dependencies.latest.attemptId] : []));
        await until(async () => evaluated(await view(), earlier));
        const first = await view();
        out.first = worksByIssue(first);
        out.candidates = first.polling.repositories.flatMap(repo => repo.candidates ?? []).map(item => ({ number: item.ticket.number, outcome: item.outcome, work_id: 'work_id' in item ? item.work_id : null }));
        if (configured) {
          out.human = await humanStepWait(save, humanSteps({ b1: pinned.b1 })['close-blockers'], async () => {
            const facts = dependencyFacts((worksByIssue(await view())).a1);
            return facts.conclusion === 'satisfied' ? { a1: 'satisfied' } : null;
          });
          const settledAttempt = new Set(Object.values(worksByIssue(await view())).flatMap(work => work?.dependencies.latest ? [work.dependencies.latest.attemptId] : []));
          await until(async () => evaluated(await view(), settledAttempt));
          out.after = worksByIssue(await view());
        }
        out.list = (await view()).works.map(work => ({ work_id: work.work_id, number: work.ticket.number, cycle: work.cycle, result: work.result, execution: Boolean(work.execution) }));
        out.forgotten = (await view()).forgotten ?? [];
        return out;
      });
      const value = run.value as Record<string, unknown>;
      const checks = [...dependencyChecks(configured ? 'configured-open' : 'unconfigured', value.first as never),
        ...(configured ? dependencyChecks('configured-closed', (value.after ?? {}) as never) : [])];
      const candidate = list(value.candidates).find(item => item.number === q25.number);
      if (candidate) checks.push({ id: `${phase}.issue18-existing`, obligation: 'V-05.e', expected: 'existing (never re-admitted)', observed: candidate.outcome, met: candidate.outcome === 'existing' });
      const trace = await traceOf();
      checks.push({ id: `${phase}.get-only`, obligation: 'V-05.c', expected: 'every gh request GET (or token self-revocation) and allowed', observed: trace.filter(entry => !entry.allowed).length,
        met: trace.length > 0 && trace.every(entry => entry.allowed) });
      checks.push({ id: `${phase}.no-port-call`, obligation: 'V-05.c', expected: 0, observed: calls, met: effects(calls) === 0 });
      await save(`${phase}-result`, { status: checks.every(item => item.met) ? 'success' : 'held', checks, deadlineReached: run.deadlineReached, ...value, requests: trace.length });
      if (!checks.every(item => item.met)) throw new Error('PHASE_NOT_AS_EXPECTED');
      return;
    }
    // inspect: inert view of a copy, source digests, environment, token scan, verdict, teardown request.
    const { snapshotStorage } = await import('./review12-qualification.js');
    const { openControl } = await import('../../src/control/index.js');
    const inert = await openControl({ storagePath: await snapshotStorage(`${observations}/authority`, `${observations}/inspect-storage-copy`), runtimeInventory: 'unknown' });
    const view = await inert.inspect({ kind: 'list' }) as ListView;
    const stopped = new AbortController(); stopped.abort(); await inert.run(stopped.signal);
    await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true });
    const sourceAfter = await sourceDigest();
    const secrets = await secretScan(observations);
    const saved = { cleanup: await load('cleanup-forget-result'), unconfigured: await load('unconfigured-result'), configured: await load('configured-result') };
    const checks: Check[] = [
      ...list(pick(saved.cleanup, 'checks')), ...list(pick(saved.unconfigured, 'checks')), ...list(pick(saved.configured, 'checks')),
    ] as unknown as Check[];
    checks.push({ id: 'sources-unchanged', obligation: 'V-14.f', expected: preflight?.sourceBefore, observed: sourceAfter, met: JSON.stringify(preflight?.sourceBefore) === JSON.stringify(sourceAfter) });
    checks.push({ id: 'forgotten-listed', obligation: 'V-14.f', expected: [q25.cycle1, q25.cycle2], observed: (view.forgotten ?? []).map(item => item.work_id),
      met: [q25.cycle1, q25.cycle2].every(id => (view.forgotten ?? []).some(item => item.work_id === id)) && !view.works.some(work => work.work_id === q25.cycle1 || work.work_id === q25.cycle2) });
    checks.push({ id: 'no-token', obligation: 'all', expected: [], observed: secrets.matches, met: secrets.matches.length === 0 });
    const verdict = { revision, overall: checks.length > 0 && checks.every(item => item.met) && [saved.cleanup, saved.unconfigured, saved.configured].every(item => item?.status === 'success') ? 'met' : 'not-met', checks };
    await save('inspect-result', { works: view.works.map(work => ({ work_id: work.work_id, number: work.ticket.number, result: work.result, dependencies: dependencyFacts(work) })),
      forgotten: view.forgotten ?? [], sourceAfter, environment: await environmentState(), secretScan: secrets });
    await save('verdict', verdict);
    const teardown = humanSteps({ b1: pinned.b1, c1: pinned.c1, a: [pinned.a1, pinned.a2, pinned.a3] }).teardown;
    await save('human-step-teardown-requested', { ...teardown, at: new Date().toISOString() });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    if (usesGitHub) await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}
/** Writes the request file of one human step and waits (bounded) until `observed` says the effect is visible; the phase is held otherwise. */
async function humanStepWait(save: (name: string, data: unknown) => Promise<void>, step: HumanStep, observed: () => Promise<unknown>) {
  await save(`human-step-${step.name}-requested`, { ...step, at: new Date().toISOString(),
    note: `${step.note}. Operator: run apply now with YOUR OWN account; ALWAYS run restore afterwards (when the phase ends, even held). The phase is waiting.` });
  const until = Date.now() + humanStepMinutes * 60 * 1000;
  while (Date.now() < until) {
    const value = await observed();
    if (value) { await save(`human-step-${step.name}-observed`, { name: step.name, at: new Date().toISOString(), value }); return value; }
    await sleep(15000);
  }
  throw new Error('RECIPE_HUMAN_STEP_TIMEOUT');
}

/** Membership of one repository in the installation, from the Factory's OWN token issuance for it: issued = installed; GitHub's 422 for a
 * repository outside the installation (GITHUB_QUERY_FAILED) = not installed; anything else (transport, unknown issuance) decides nothing. */
export type Membership = 'installed' | 'not-installed' | `unknown:${string}`;
export function membership(read: { ok: boolean; code?: string }): Membership {
  if (read.ok) return 'installed';
  return read.code === 'GITHUB_QUERY_FAILED' ? 'not-installed' : `unknown:${read.code ?? 'UNKNOWN'}`;
}
export function probeVerdict(b: Membership, c: Membership): { ok: boolean; reasons: string[] } {
  const reasons = [...(b === 'installed' ? [] : [`${repositoryB.repository}: ${b === 'not-installed' ? `not in installation ${installationId} (do the browser step)` : b}`]),
    ...(c === 'not-installed' ? [] : [`${repositoryC.repository}: ${c === 'installed' ? `in installation ${installationId} (remove it there; it must stay hidden)` : c}`])];
  return { ok: reasons.length === 0, reasons };
}
/**
 * Read-only installation probe (setup step `installation`): a PRIVATE temporary access root gets an O_EXCL copy of the App key, the Factory's own
 * GitHub access issues a short-lived dependency-read token per repository (App JWT inside the access layer) and one GET of each repository; the
 * root (key copy, gh dirs) is removed in `finally`. Prints repository memberships and codes only, never a key, JWT or token.
 */
export async function probeInstallation() {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { requireKeySource } = await import('./humanchanges21-qualification.js');
  await requireKeySource(path => fs.access(path));
  const directory = await fs.mkdtemp(`${root}/q34-ghdep-probe-`);
  try {
    for (const name of ['credentials', 'run']) await fs.mkdir(`${directory}/${name}`, { mode: 0o700 });
    await fs.copyFile(keySource, `${directory}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
    await fs.chmod(`${directory}/${githubApp.privateKeyFile}`, 0o600);
    const { createGitHubAccess } = await import('../../src/platform/github/index.js');
    const github = createGitHubAccess({ root: directory, ...githubApp });
    const probe = async (repository: string) => {
      const read = await github.read({ repository, installationId, workflows: false }, 'dependency-read', session => session.get(`/repos/${repository}`));
      return membership(read.ok ? { ok: true } : { ok: false, code: read.code });
    };
    const b = await probe(repositoryB.repository), c = await probe(repositoryC.repository);
    return { installationId, memberships: { [repositoryB.repository]: b, [repositoryC.repository]: c }, ...probeVerdict(b, c) };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Writes the setup human steps (repositories, issues) into a NEW local directory; no GitHub, no namespace, no pin needed. */
export async function writeSetupSteps(directory = setupDirectory) {
  const { fs, save } = await io();
  await fs.mkdir(directory, { mode: 0o700 });
  const steps = humanSteps();
  await save('human-step-repositories-requested', { ...steps.repositories, at: new Date().toISOString() }, directory);
  await save('human-step-installation-requested', { ...steps.installation, at: new Date().toISOString() }, directory);
  await save('human-step-issues-requested', { ...steps.issues, at: new Date().toISOString() }, directory);
  await fs.writeFile(`${directory}/configuration-entry.yaml`, configurationEntry, { mode: 0o600, flag: 'wx' });
  return directory;
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length === 1 && args[0] === '--setup-steps') { console.log(await writeSetupSteps()); return; }
  if (args.length === 1 && args[0] === '--probe-installation') {
    const result = await probeInstallation();
    console.log(JSON.stringify(result, null, 1));
    if (!result.ok) throw new Error('INSTALLATION_NOT_AS_EXPECTED');
    return;
  }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' || message === 'INSTALLATION_NOT_AS_EXPECTED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
