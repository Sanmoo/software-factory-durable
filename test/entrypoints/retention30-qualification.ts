import type { ControlInput, ExecutionPorts } from '../../src/control/index.js';
import { prepareAuthority } from './delivery17-qualification.js';

// TEST ONLY. Ticket 30 one-shot LOCAL qualification recipe (supervisor decision 5). Import and `--plan` are inert. Every other phase writes
// only below its own namespace and requires an explicit operator grant. It works on a COPY of ticket 17's delivered run q17-delivery-v4:
// the storage is copied (and, if format 1, the copy only is migrated with ticket 33's digest-checked migrateStorage); the delivered Work's
// Records directory is copied privately (no symlink or special file is followed or copied). Nothing reaches GitHub, a VM or a model: every
// tracker/repository call is a local refusing double (counted), every Sandbox/Workers/credential port is refused, and a selection of
// `remote-branch` is refused by the recipe before anything is sent. Phases are one-shot: an exclusive intent tombstone precedes effects; a
// consumed phase never reruns; nothing is retried. `inspect` writes the verdict file.

const root = '/home/sanmoo/software-factory-test/y5';
const source = { storage: `${root}/q17-delivery-v4/authority`, records: root };
const observations = `${root}/q30-retention-v1`;
const revision = 'q30-retention-v1';
const phases = ['preflight', 'sweep', 'inspect'] as const;
type Phase = typeof phases[number];
/** Ticket 17's delivered Work: Ticket #3 of the qualification repository (its id is read from the copy, never guessed). */
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const retentionDays = 30;
const day = 86_400_000;
const phaseDeadlineMs = 2 * 60 * 1000;
/** Explicit cleanup selections this LOCAL recipe may send (never `remote-branch`). */
const localSelection = ['logs', 'sessions', 'environment'] as const;

export function plan() {
  return { revision, observations, source, phases, expectedTicket, retentionDays, localSelection,
    requires: 'ticket 30 on top of 17/25; q17-delivery-v4 run (delivered Work, cleanup complete) present under y5; nothing else',
    network: 'none: tracker/repository are local refusing doubles (calls counted, must be reads only), no GitHub App key is copied or read, no VM/model',
    effects: [
      'preflight: EXCLUSIVE mkdir of the namespace; COPY of q17-delivery-v4/authority into authority/ (a format-1 copy is migrated 1→2, digests recorded; the source is never opened ' +
        'for writing); inert view of the copy: the delivered Work of Ticket #3 (merge confirmedAt); PRIVATE copy of <y5>/<work>/ into records/<work>/ (directories 0700, regular files ' +
        'only, symlinks/special files refused); inventory of the copy (listDetails); sha256 of the source storage files',
      `sweep: owner A on the authority copy, Records = records/, calendar = confirmedAt + 1 day: boot sweep → retained (dueAt = confirmedAt + ${retentionDays} days); an explicit ` +
        `cleanup-plan of [${localSelection.join(', ')}] is recorded (plan of losses only, NEVER confirmed); owner A stops. Owner B (new process view, boot sweep), calendar = confirmedAt + ` +
        `${retentionDays + 1} days: eligible logs/sessions of the COPY are removed (intent before effect); preserved evidence is kept`,
      'inspect (read-only): view of a copy of the authority; inventory of records/ after; sha256 of the source storage files again; verdict.json',
    ],
    guards: ['one-shot intent tombstones', 'source storage and Records only copied', 'remote-branch selection refused by the recipe', 'every GitHub port is a local refusing double',
      'no Sandbox removal/preservation, prepare/start/activate/credential (refused)', 'no retry inside a phase'],
    verdict: ['work still delivered with its merge facts', `retention.dueAt = confirmedAt + ${retentionDays} days`, 'run A: state retained, nothing removed',
      'run A: plan recorded with losses, state planned (not confirmed)', 'run B: state expired (or protected with named reasons), removed counts = logs/sessions before',
      'preserved evidence directories unchanged', 'source storage sha256 unchanged', 'no remote effect: cleanupBranch/setDraft/postComment never called, Sandbox ports never called'],
  };
}

/** The recipe never sends a remote cleanup selection (supervisor decision 5). */
export function localOnly(select: readonly string[]): ('logs' | 'sessions' | 'environment')[] {
  if (!select.length || select.some(item => !(localSelection as readonly string[]).includes(item))) throw new Error('RECIPE_REMOTE_SELECTION_REFUSED');
  return [...select] as ('logs' | 'sessions' | 'environment')[];
}

/** Private copy of one Work's Records directory: directories 0700, regular single-link files 0600, anything else refused. Exclusive destination. */
export async function copyRecords(from: string, to: string) {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { join } = await import('node:path');
  let files = 0, bytes = 0;
  const walk = async (a: string, b: string) => {
    const info = await fs.lstat(a);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('RECORDS_COPY_UNSAFE');
    await fs.mkdir(b, { mode: 0o700 });
    for (const name of (await fs.readdir(a)).sort()) {
      const child = await fs.lstat(join(a, name));
      if (child.isDirectory() && !child.isSymbolicLink()) { await walk(join(a, name), join(b, name)); continue; }
      if (!child.isFile() || child.nlink !== 1) throw new Error('RECORDS_COPY_UNSAFE');
      await fs.copyFile(join(a, name), join(b, name), constants.COPYFILE_EXCL);
      await fs.chmod(join(b, name), 0o600);
      files++; bytes += child.size;
    }
  };
  await walk(from, to);
  return { files, bytes };
}

/** Local refusing doubles of every remote port; each call is counted (the verdict requires no write call at all). */
export function localDoubles() {
  const calls: Record<string, number> = {};
  const refuse = (name: string) => async () => { calls[name] = (calls[name] ?? 0) + 1; throw new Error('RECIPE_LOCAL_ONLY'); };
  const tracker = { checkAccess: refuse('checkAccess'), listCandidates: refuse('listCandidates'), readTicket: refuse('readTicket'), readDependencyGraph: refuse('readDependencyGraph'),
    readInputs: refuse('readInputs'), findQuestion: refuse('findQuestion'), postComment: refuse('postComment') };
  const codeRepository = { checkAccess: refuse('repository.checkAccess'), findPublication: refuse('findPublication'), readPullRequest: refuse('readPullRequest'), setDraft: refuse('setDraft'),
    readOwnMerge: refuse('readOwnMerge'), cleanupBranch: refuse('cleanupBranch') };
  const refused = refuse;
  const ports = (details: NonNullable<NonNullable<ExecutionPorts['cleanup']>['details']>, now: number): ExecutionPorts => ({
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' }, capacity: 0, builder: { skillPack: 'factory-skills-v6' as never, modelBudget: 'builder-v1', copyOutput: true },
    credentials: { issue: refused('credentials.issue'), revoke: async () => ({ kind: 'not-attempted', nextStep: 'nothing issued' }) } as never,
    sandbox: { prepare: refused('sandbox.prepare'), start: refused('sandbox.start'), stop: refused('sandbox.stop') },
    workers: { activate: refused('workers.activate'), deliver: refused('workers.deliver') },
    calendar: { now: () => now },
    cleanup: { remove: refused('sandbox.remove'), preserve: refused('records.preserve'), retrySeconds: 86400, details, retentionDays, sweepSeconds: 86400 },
  });
  return { calls, tracker, codeRepository, ports };
}

/**
 * One owner run on the authority copy with the production detail ports over `recordsRoot`, a fixed calendar and local doubles: it waits for
 * the retention sweep of the Work, optionally records a cleanup PLAN (never confirmed), then stops cleanly.
 */
export async function ownerRun(input: { storagePath: string; recordsRoot: string; workId: string; now: number; planSelect?: readonly string[]; requestId?: string;
  deadlineMs?: number }) {
  const { openControl } = await import('../../src/control/index.js');
  const { detailPorts } = await import('../../src/entrypoints/controller/composition.js');
  const doubles = localDoubles();
  const control = await openControl({ storagePath: input.storagePath, runtimeInventory: { kind: 'listed', observedAt: new Date().toISOString(), environments: [], cache: [], unknown: [] },
    access: { tracker: doubles.tracker as never, repository: doubles.codeRepository as never, repositories: [repository], dependencyRepositories: [] },
    polling: { intervalSeconds: 1 }, execution: doubles.ports(detailPorts(input.recordsRoot), input.now) });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + (input.deadlineMs ?? phaseDeadlineMs);
  const show = async () => { const view = await control.inspect({ kind: 'show', work_id: input.workId }); return 'work' in view ? view.work : null; };
  let work = await show();
  const initialSweeps = work?.retention?.sweeps ?? 0;
  while (Date.now() < deadline && (work?.retention?.sweeps ?? 0) <= initialSweeps) { await new Promise(resolve => setTimeout(resolve, 250)); work = await show(); }
  let plan: unknown = null;
  if (input.planSelect) {
    const command = { request_id: input.requestId ?? `${revision}-plan`, operation: 'cleanup-plan', work_id: input.workId, select: localOnly(input.planSelect), origin: 'local-cli' } as ControlInput;
    plan = await control.accept(command);
    work = await show();
  }
  const status = await control.inspect({ kind: 'status' });
  stop.abort();
  const outcome = await running;
  return { work, plan, status, outcome, calls: doubles.calls, deadlineReached: Date.now() >= deadline };
}

/** Verdict over the observations; every check names expectation and observation. */
export function verdict(input: { confirmedAt: string; runA: Awaited<ReturnType<typeof ownerRun>>; runB: Awaited<ReturnType<typeof ownerRun>>;
  before: { logs: number; sessions: number; evidence: number }; after: { logs: number; sessions: number; evidence: number }; sourceBefore: string; sourceAfter: string }) {
  const due = new Date(Date.parse(input.confirmedAt) + retentionDays * day).toISOString();
  const a = input.runA.work?.retention, b = input.runB.work?.retention;
  const planned = input.runA.plan as { kind?: string; plan?: { state?: string; losses?: unknown[] } | null } | null;
  const remoteCalls = ['cleanupBranch', 'setDraft', 'postComment', 'sandbox.remove', 'records.preserve', 'sandbox.prepare', 'sandbox.start', 'workers.activate', 'credentials.issue']
    .reduce((sum, name) => sum + (input.runA.calls[name] ?? 0) + (input.runB.calls[name] ?? 0), 0);
  const checks = [
    { id: 'delivered', expected: 'delivered', observed: input.runB.work?.result ?? null },
    { id: 'due-at', expected: due, observed: b?.dueAt ?? null },
    { id: 'run-a-retained', expected: 'retained/0 removed', observed: `${a?.state ?? null}/${(a?.removed.logs ?? 0) + (a?.removed.sessions ?? 0)} removed` },
    { id: 'run-a-plan-recorded', expected: 'planned', observed: planned?.plan?.state ?? planned?.kind ?? null },
    { id: 'run-b-expired', expected: b?.state === 'protected' ? `protected (${b.protections.join(',')})` : 'expired', observed: b?.state ?? null },
    { id: 'run-b-removed', expected: b?.state === 'protected' ? 0 : input.before.logs + input.before.sessions, observed: (b?.removed.logs ?? 0) + (b?.removed.sessions ?? 0) },
    { id: 'evidence-kept', expected: input.before.evidence, observed: input.after.evidence },
    { id: 'source-unchanged', expected: input.sourceBefore, observed: input.sourceAfter },
    { id: 'no-remote-effect', expected: 0, observed: remoteCalls },
  ].map(check => ({ ...check, met: JSON.stringify(check.expected) === JSON.stringify(check.observed) }));
  return { revision, overall: checks.every(check => check.met) ? 'met' : 'not-met', checks };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(data, null, 1)); await file.sync(); } finally { await file.close(); }
  };
  const load = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8')) as Record<string, unknown>;
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  return { fs, save, load, exists };
}
async function sourceDigest() {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  for (const name of ['control.sqlite', 'control.sqlite-wal', 'control.sqlite-shm']) hash.update(name).update(await fs.readFile(`${source.storage}/${name}`).catch(() => Buffer.from('absent')));
  return hash.digest('hex');
}
async function view(storagePath: string) {
  const { openControl } = await import('../../src/control/index.js');
  const stored = await openControl({ storagePath, runtimeInventory: 'unknown' });
  const list = await stored.inspect({ kind: 'list' });
  const stopped = new AbortController(); stopped.abort();
  await stored.run(stopped.signal);
  return 'kind' in list && list.kind === 'list' ? list.works.find(item => item.ticket.number === expectedTicket.number && item.ticket.repositoryId === expectedTicket.repositoryId &&
    item.result === 'delivered') ?? null : null;
}
const counts = (inventory: { items: { kind: string }[]; evidence: number }) =>
  ({ logs: inventory.items.filter(item => item.kind === 'log').length, sessions: inventory.items.filter(item => item.kind === 'session').length, evidence: inventory.evidence });

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, load, exists } = await io();
  const { snapshotStorage } = await import('./review12-qualification.js');
  const { listDetails } = await import('../../src/records/index.js');
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const sourceBefore = await sourceDigest();
      const authority = await prepareAuthority(source.storage, `${observations}/authority`, revision);
      const work = await view(await snapshotStorage(`${observations}/authority`, `${observations}/preflight-storage-copy`));
      if (!work?.delivery?.merge) { await save('preflight-held', { work }); throw new Error('PRECONDITION_HELD'); }
      await fs.mkdir(`${observations}/records`, { mode: 0o700 });
      const copied = await copyRecords(`${source.records}/${work.work_id}`, `${observations}/records/${work.work_id}`);
      const inventory = await listDetails(`${observations}/records`, work.work_id);
      await save('preflight-result', { status: 'success', authority, workId: work.work_id, confirmedAt: work.delivery.merge.confirmedAt, copied, inventory, before: counts(inventory), sourceBefore });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    const preflight = await load('preflight-result') as { workId: string; confirmedAt: string; before: { logs: number; sessions: number; evidence: number }; sourceBefore: string };
    const storagePath = `${observations}/authority/control.sqlite`;
    const recordsRoot = await fs.realpath(`${observations}/records`);
    if (phase === 'sweep') {
      const at = Date.parse(preflight.confirmedAt);
      const runA = await ownerRun({ storagePath, recordsRoot, workId: preflight.workId, now: at + day, planSelect: localSelection, requestId: `${revision}-plan-a` });
      await save('sweep-a-result', runA);
      const runB = await ownerRun({ storagePath, recordsRoot, workId: preflight.workId, now: at + (retentionDays + 1) * day });
      await save('sweep-b-result', runB);
      return;
    }
    if (!(await exists('sweep-b-result'))) throw new Error('SWEEP_REQUIRED');
    const after = await listDetails(recordsRoot, preflight.workId);
    const result = verdict({ confirmedAt: preflight.confirmedAt, runA: await load('sweep-a-result') as never, runB: await load('sweep-b-result') as never,
      before: preflight.before, after: counts(after), sourceBefore: preflight.sourceBefore, sourceAfter: await sourceDigest() });
    await save('inspect-result', { work: await view(await snapshotStorage(`${observations}/authority`, `${observations}/inspect-storage-copy`)), after });
    await save('verdict', result);
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
