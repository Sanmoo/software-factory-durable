import type { ControlInput, ControlReceipt, ExecutionPorts, ListView, ShowView, WorkView } from '../../src/control/index.js';
import { prepareAuthority } from './delivery17-qualification.js';
import { copyRecords, localDoubles } from './retention30-qualification.js';

// TEST ONLY. Ticket 31 one-shot LOCAL qualification recipe. Import and `--plan` are inert. Every other phase writes only below its own namespace
// and requires an explicit operator grant. It works on COPIES of two real runs: ticket 17's delivered Work (q17-delivery-v4) and ticket 25's
// cancelled cycle (q25-cancel-v1, whose successor cycle 2 is open). Each storage is copied (a format-1 copy, and only the copy, is migrated with
// ticket 33's digest-checked migrateStorage); each Work's Records directory is copied privately (no symlink or special file is followed or
// copied). Nothing reaches GitHub, a VM or a model: tracker/repository are local doubles (calls counted, never a write), every Sandbox/Workers/
// credential port is refused. The ONLY local stand-in is the cancelled copy's explicit environment cleanup: the copy holds no environment, so a
// labelled recipe port answers it absent (it refuses if an environment directory exists under the copy); the real environment under
// q25-cancel-v1 is never touched. Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is
// retried. `inspect` writes the verdict file, whose checks fail on a no-op.

const root = '/home/sanmoo/software-factory-test/y5';
// v1 (met 21/21) was consumed; v2 follows the independent review (real environment path guard, Records sources hashed, nested memory keys).
const revision = 'q31-forget-v2';
const observations = `${root}/${revision}`;
const repositoryName = 'Sanmoo/java-springboot-event-sourcing';
/** Installation root of both source runs (Sandbox root): where the product keeps (and would remove) their environments. Only read (lstat). */
const environmentRoot = root;
const cases = {
  delivered: { storage: `${root}/q17-delivery-v4/authority`, records: root, number: 3, result: 'delivered' as const },
  cancelled: { storage: `${root}/q25-cancel-v1`, records: root, number: 18, result: 'cancelled' as const },
};
type CaseName = keyof typeof cases;
const phases = ['preflight', 'forget', 'inspect'] as const;
type Phase = (typeof phases)[number];
const day = 86_400_000;
const phaseDeadlineMs = 2 * 60 * 1000;
/** The only keys a minimal memory may carry (spec §12.4), per nested object: identities, order/link, result, PR identity/merge fact, label, Question
 * ids, the cancelled PR watch, the forget origin and (D-07) the storage scrub status. Any other key at any depth fails the verdict. */
export const memoryShape: Record<string, string[]> = {
  '': [
    'cycle',
    'forgottenAt',
    'label',
    'mergeConfirmed',
    'mergeConfirmedAt',
    'planId',
    'predecessor',
    'pullRequest',
    'questions',
    'repository',
    'request_id',
    'result',
    'scrub',
    'sequence',
    'ticket',
    'watch',
    'work_id',
  ],
  /** D-07: the storage scrub status (no content). */ scrub: ['attempts', 'code', 'lastAttemptAt', 'scrubbedAt', 'state'],
  ticket: ['issueId', 'nodeId', 'number', 'repository', 'repositoryId', 'tracker', 'url'],
  repository: ['base', 'repository', 'repositoryId'],
  pullRequest: ['nodeId', 'number', 'pullRequestId', 'url'],
  label: ['id', 'name'],
  watch: ['branch', 'lastOutcome', 'lastReadAt', 'pullRequest', 'state'],
  'watch.pullRequest': ['base', 'headRef', 'heads', 'nodeId', 'number', 'pullRequestId', 'url'],
};
/** Paths (`<object>.<key>`) of a memory that the shape does not allow; `questions` must be ids only and `heads` shas only. */
export function memoryViolations(memory: Record<string, unknown> | null): string[] {
  if (!memory) return ['<no memory>'];
  const violations: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item !== 'string' || !/^[0-9a-f-]{1,64}$/i.test(item)) violations.push(`${path}[]`);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const allowed = memoryShape[path];
      const childPath = path ? `${path}.${key}` : key;
      if (!allowed?.includes(key)) {
        violations.push(childPath);
        continue;
      }
      walk(child, childPath);
    }
  };
  walk(memory, '');
  return violations;
}

export function plan() {
  return {
    revision,
    observations,
    cases,
    phases,
    requires:
      'ticket 31 on top of 08/17/25/30; q17-delivery-v4 (delivered Work, cleanup complete) and q25-cancel-v1 (cancelled cycle 1 + open cycle 2) present under y5; nothing else',
    network: 'none: tracker/repository are local doubles (calls counted, never a write), no GitHub App key is copied or read, no VM/model',
    effects: [
      'preflight: EXCLUSIVE mkdir of the namespace; per case, COPY of the storage into <case>/authority (a format-1 copy is migrated 1→2, digests recorded; the source is never opened ' +
        'for writing); inert view of the copy (the case Work; for cancelled, its successor cycle); PRIVATE copy of <y5>/<work>/ into <case>/records/<work>/ (directories 0700, regular ' +
        'files only, symlinks/special files refused; absent = nothing copied); whole-tree inspection of the copy; sha256 of both source storages',
      "forget, run A (one owner per case on its copy, Records = <case>/records): delivered: forget-plan → forget-confirm → the desk deletes the copy's Records area and keeps the " +
        'minimal memory. cancelled: forget-plan FIRST (expected refused: RESOURCES_PENDING, the environment is an own resource), then cleanup-plan [environment] + cleanup-confirm ' +
        'answered by the labelled recipe environment port, which never removes anything: absent ONLY if the real environment at the source root (<y5>/environments/<env>) is gone, ' +
        'otherwise refused (then forget-plan again must stay refused and nothing is deleted); otherwise forget-plan → forget-confirm. Then one polling round lists the same Ticket ' +
        '(label still present) and must answer `existing`',
      'forget, run B (restart: new owner per case): the Ticket listed again must stay `existing`; delivered: an explicit `new` (fresh Ticket read answered locally as authorized) ' +
        'creates cycle 2 with the forgotten predecessor and becomes the current, evaluated cycle',
      'inspect (read-only): inert views of copies of both authorities; whole-tree inspection of the Records copies; sha256 of both sources again; verdict.json',
    ],
    guards: [
      'one-shot intent tombstones',
      'sources only copied',
      'every GitHub port is a local double, writes never answered',
      'Sandbox/Workers/credentials refused',
      'labelled recipe environment port refuses if an environment exists in the copy',
      'no retry inside a phase',
    ],
    verdict: [
      'plan accepted with losses (Records files > 0 for delivered)',
      'both Works shown as work-forgotten after run A and after the restart',
      'Records copies deleted (no tombstone)',
      'minimal memory: only the allowed keys at every depth; delivered keeps PR + merge confirmed, cancelled none (its own PR only in the watch)',
      'cancelled: refused before its environment cleanup; forgotten after it when the real environment is gone, still refused and untouched while it exists',
      'polling after forget and after restart answers existing (never admitted again)',
      'delivered: explicit new creates cycle 2 with the forgotten predecessor; it is the current one',
      'cancelled: the successor cycle stays open and current',
      'status/list show the forgotten Works and say totals cover only remembered Works',
      'source storages and real Records sources unchanged',
      'no remote effect: no write call to GitHub, no Sandbox/Workers/credential call',
    ],
  };
}

/** Local tracker double: lists the case Ticket; `authorized` answers a fresh read of it (open, labelled) — reads only, every call counted. */
function trackerOf(doubles: ReturnType<typeof localDoubles>, ticket: WorkView['ticket'], label: { id: number; name: string }, authorized: boolean) {
  const count = (name: string) => {
    doubles.calls[name] = (doubles.calls[name] ?? 0) + 1;
  };
  return {
    ...doubles.tracker,
    async listCandidates(scope: { repository: string; label: string }) {
      count('listCandidates');
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: new Date().toISOString(),
        repository: scope.repository,
        repositoryId: ticket.repositoryId,
        label: scope.label,
        completeness: 'complete',
        candidates: [ticket],
        limitations: ['recipe: local listing of the case Ticket'],
      };
    },
    async readTicket(ref: WorkView['ticket']) {
      if (!authorized || ref.number !== ticket.number) return doubles.tracker.readTicket();
      count('readTicket');
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: new Date().toISOString(),
        completeness: 'complete',
        ticket,
        state: 'open',
        stateReason: null,
        labels: [label],
        pullRequest: false,
      };
    },
  };
}

/**
 * Labelled recipe stand-in for the explicit environment cleanup of the CANCELLED copy. It never removes anything: it answers every resource
 * absent ONLY when the real environment the product would remove does not exist at the source run's root; if it exists it refuses (the
 * environment stays an own resource and forget stays refused).
 */
export function environmentPort(environmentRoot: string) {
  const calls: string[] = [];
  // Review MED: the path the PRODUCT would remove (`<installation root>/environments/<env>`, the source run's root), never a path of the copy.
  const present = async (environment: string) =>
    (await import('node:fs/promises')).lstat(`${environmentRoot}/environments/${environment}`).then(
      () => true,
      () => false,
    );
  return {
    calls,
    async remove(input: { environment: string }) {
      calls.push(`remove:${input.environment}`);
      if (await present(input.environment)) {
        calls.push(`refused-present:${input.environment}`);
        return { status: 'failure' as const, code: 'RECIPE_ENVIRONMENT_PRESENT', resources: [] };
      }
      calls.push(`absent:${input.environment}`);
      return {
        status: 'success' as const,
        resources: (['disk', 'workspace', 'artifacts', 'runtime'] as const).map(resource => ({ resource, status: 'absent' as const })),
      };
    },
    async preserve(input: { environment: string }) {
      calls.push(`preserve:${input.environment}`);
      if (await present(input.environment)) {
        calls.push(`refused-present:${input.environment}`);
        return { status: 'failed' as const, code: 'RECIPE_ENVIRONMENT_PRESENT' };
      }
      return { status: 'absent' as const };
    },
  };
}

type Step = 'forget' | 'cleanup-environment-then-forget' | 'new';
/** What one owner run observed (receipts and views as returned by the public Control). */
export type RunResult = {
  before?: unknown;
  firstPlan?: unknown;
  cleanupPlan?: unknown;
  cleanupConfirm?: unknown;
  secondPlan?: unknown;
  confirm?: unknown;
  new?: unknown;
  candidate?: unknown;
  shown?: unknown;
  list?: unknown;
  status?: unknown;
  outcome?: unknown;
  calls: Record<string, number>;
  recordsForget: string[];
  environmentPort: string[];
  deadlineReached: boolean;
};
/**
 * One owner run on an authority copy (production detail ports over `recordsRoot`, fixed calendar, local doubles). It waits for the boot sweep
 * (the desk is settled), performs the steps through `Control.accept` (the CLI's own path), waits for their execution and for a polling round
 * listing the same Ticket, then stops cleanly.
 */
export async function forgetOwnerRun(input: {
  storagePath: string;
  environmentRoot: string;
  recordsRoot: string;
  workId: string;
  ticket: WorkView['ticket'];
  label: { id: number; name: string };
  now: number;
  steps: Step[];
  requestPrefix: string;
  deadlineMs?: number;
  repositoryName?: string;
}): Promise<RunResult> {
  const { openControl } = await import('../../src/control/index.js');
  const { detailPorts } = await import('../../src/entrypoints/controller/composition.js');
  const doubles = localDoubles();
  const details = detailPorts(input.recordsRoot);
  const forgets: string[] = [];
  const counted = {
    ...details,
    forget: async (args: { workId: string }) => {
      forgets.push(args.workId);
      return details.forget!(args);
    },
  };
  const environment = environmentPort(input.environmentRoot);
  const base = doubles.ports(counted, input.now);
  const ports: ExecutionPorts = { ...base, cleanup: { ...base.cleanup!, remove: environment.remove as never, preserve: environment.preserve as never } };
  const repository = { repository: input.repositoryName ?? repositoryName, base: 'main', installationId: 177599217, workflows: false, label: input.label.name };
  const control = await openControl({
    storagePath: input.storagePath,
    runtimeInventory: { kind: 'listed', observedAt: new Date().toISOString(), environments: [], cache: [], unknown: [] },
    access: {
      tracker: trackerOf(doubles, input.ticket, input.label, input.steps.includes('new')) as never,
      repository: doubles.codeRepository as never,
      repositories: [repository],
      dependencyRepositories: [],
    },
    polling: { intervalSeconds: 1 },
    execution: ports,
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + (input.deadlineMs ?? phaseDeadlineMs);
  const wait = async (done: () => Promise<boolean>) => {
    while (Date.now() < deadline && !(await done())) await new Promise(resolve => setTimeout(resolve, 250));
  };
  const show = async () => (await control.inspect({ kind: 'show', work_id: input.workId })) as ShowView;
  const list = async () => (await control.inspect({ kind: 'list' })) as ListView;
  const accept = (command: Record<string, unknown>) =>
    control.accept({ ...command, origin: 'local-cli' } as ControlInput) as Promise<ControlReceipt | { kind: 'refused'; code: string }>;
  const planOf = (receipt: unknown) => (receipt as { plan?: { planId?: string; state?: string } | null } | null)?.plan ?? null;
  const sweeps = async () => {
    const status = await control.inspect({ kind: 'status' });
    return 'retention' in status ? (status.retention?.sweeps ?? 0) : 0;
  };
  await wait(async () => (await sweeps()) >= 1);
  const result: Omit<RunResult, 'calls' | 'recordsForget' | 'environmentPort' | 'deadlineReached'> = { before: (await show()).kind };
  if (input.steps.includes('forget') || input.steps.includes('cleanup-environment-then-forget')) {
    let receipt = await accept({ request_id: `${input.requestPrefix}-plan-1`, operation: 'forget-plan', work_id: input.workId });
    result.firstPlan = receipt;
    if (input.steps.includes('cleanup-environment-then-forget')) {
      const cleanup = await accept({ request_id: `${input.requestPrefix}-cleanup`, operation: 'cleanup-plan', work_id: input.workId, select: ['environment'] });
      result.cleanupPlan = cleanup;
      const cleanupId = (cleanup as { plan?: { planId?: string } | null }).plan?.planId;
      if (cleanupId)
        result.cleanupConfirm = await accept({
          request_id: `${input.requestPrefix}-cleanup-confirm`,
          operation: 'cleanup-confirm',
          work_id: input.workId,
          plan_id: cleanupId,
        });
      await wait(async () => {
        const view = await show();
        return view.kind === 'work' && view.work.cleanup?.explicit?.consumed === true;
      });
      receipt = await accept({ request_id: `${input.requestPrefix}-plan-2`, operation: 'forget-plan', work_id: input.workId });
      result.secondPlan = receipt;
    }
    const planned = planOf(receipt);
    if (planned?.state === 'planned' && planned.planId) {
      result.confirm = await accept({
        request_id: `${input.requestPrefix}-confirm`,
        operation: 'forget-confirm',
        work_id: input.workId,
        plan_id: planned.planId,
      });
      await wait(async () => {
        const view = await show();
        return (
          view.kind === 'work-forgotten' ||
          (view.kind === 'work' && ['failed', 'dropped', 'indeterminate'].includes(view.work.forget?.plans.at(-1)?.state ?? ''))
        );
      });
    }
  }
  if (input.steps.includes('new')) {
    result.new = await accept({
      request_id: `${input.requestPrefix}-new`,
      operation: 'new',
      ticket: { repository: input.ticket.repository, number: input.ticket.number },
      keepPredecessorPullRequest: false,
    });
  }
  // A polling round AFTER the steps lists the same Ticket (label present): it must answer `existing`, never admit it again.
  const cycles = (await list()).polling.cycles;
  await wait(async () => (await list()).polling.cycles >= cycles + 2);
  const after = await list();
  result.candidate = after.polling.repositories.flatMap(repo => repo.candidates ?? []).find(item => item.ticket.number === input.ticket.number) ?? null;
  result.shown = await show();
  result.list = {
    works: after.works.map(work => ({ work_id: work.work_id, cycle: work.cycle, predecessor: work.predecessor, result: work.result })),
    forgotten: after.forgotten ?? [],
  };
  const status = await control.inspect({ kind: 'status' });
  result.status = { forgotten: 'forgotten' in status ? (status.forgotten ?? null) : null, works: 'works' in status ? status.works : null };
  stop.abort();
  result.outcome = await running;
  return { ...result, calls: doubles.calls, recordsForget: forgets, environmentPort: environment.calls, deadlineReached: Date.now() >= deadline };
}

type Run = RunResult;
type Tree = { present: boolean; leftover: boolean; files: number; completeness: string };
/** `environmentPresent` (cancelled): the real environment the product would remove exists at the source root (observed at preflight). */
export type CaseObservation = { workId: string; successorId: string | null; before: Tree; after: Tree; runA: Run; runB: Run; environmentPresent?: boolean };

/** Verdict over the observations; every check names expectation and observation. A no-op (nothing forgotten) fails it. */
export function verdict(input: { delivered: CaseObservation; cancelled: CaseObservation; sourceBefore: unknown; sourceAfter: unknown }) {
  const shown = (run: Run) => (run.shown as { kind?: string } | undefined)?.kind ?? null;
  const memory = (run: Run) => (run.shown as { memory?: Record<string, unknown> } | undefined)?.memory ?? null;
  const receipt = (value: unknown) =>
    value as
      | {
          outcome?: string;
          reason?: string | null;
          created?: string | null;
          plan?: { state?: string; records?: { files?: number } | null; refusals?: { code: string }[] } | null;
        }
      | undefined;
  const candidate = (run: Run) => {
    const item = run.candidate as { outcome?: string; work_id?: string } | null;
    return item ? `${item.outcome}:${item.work_id}` : null;
  };
  const forgottenIds = (run: Run) => ((run.list as { forgotten?: { work_id: string }[] }).forgotten ?? []).map(item => item.work_id);
  const listed = (run: Run) => (run.list as { works?: { work_id: string; cycle: number; predecessor: string | null; result: string }[] }).works ?? [];
  const status = (run: Run) => (run.status as { forgotten?: { works: number; note: string } | null }).forgotten ?? null;
  const writes = [
    'postComment',
    'setDraft',
    'cleanupBranch',
    'reopenPullRequest',
    'sandbox.remove',
    'records.preserve',
    'sandbox.prepare',
    'sandbox.start',
    'sandbox.stop',
    'workers.activate',
    'workers.deliver',
    'credentials.issue',
  ];
  const d = input.delivered,
    c = input.cancelled;
  const remote = [d.runA, d.runB, c.runA, c.runB].reduce(
    (sum, run) => sum + writes.reduce((inner, name) => inner + ((run.calls as Record<string, number>)[name] ?? 0), 0),
    0,
  );
  const created = receipt(d.runB.new)?.created ?? null;
  const kept = c.environmentPresent === true;
  const checks = [
    {
      id: 'delivered-plan-accepted',
      expected: { outcome: 'accepted', state: 'planned', files: d.before.files },
      observed: {
        outcome: receipt(d.runA.firstPlan)?.outcome ?? null,
        state: receipt(d.runA.firstPlan)?.plan?.state ?? null,
        files: receipt(d.runA.firstPlan)?.plan?.records?.files ?? null,
      },
    },
    { id: 'delivered-records-present-before', expected: true, observed: d.before.present && d.before.files > 0 },
    { id: 'delivered-forgotten', expected: ['work-forgotten', 'work-forgotten'], observed: [shown(d.runA), shown(d.runB)] },
    {
      id: 'delivered-records-deleted',
      expected: { present: false, leftover: false, files: 0 },
      observed: { present: d.after.present, leftover: d.after.leftover, files: d.after.files },
    },
    { id: 'delivered-records-forget-once', expected: [d.workId], observed: [...(d.runA.recordsForget as string[]), ...(d.runB.recordsForget as string[])] },
    {
      id: 'delivered-memory',
      expected: { result: 'delivered', mergeConfirmed: true, pullRequest: true, keys: [] },
      observed: {
        result: memory(d.runA)?.result ?? null,
        mergeConfirmed: memory(d.runA)?.mergeConfirmed ?? null,
        pullRequest: Boolean(memory(d.runA)?.pullRequest),
        keys: memoryViolations(memory(d.runA)),
      },
    },
    { id: 'delivered-existing-after-forget', expected: `existing:${d.workId}`, observed: candidate(d.runA) },
    {
      id: 'delivered-new-explicit',
      expected: { outcome: 'accepted', cycle: 2, predecessor: d.workId },
      observed: {
        outcome: receipt(d.runB.new)?.outcome ?? null,
        cycle: listed(d.runB).find(item => item.work_id === created)?.cycle ?? null,
        predecessor: listed(d.runB).find(item => item.work_id === created)?.predecessor ?? null,
      },
    },
    { id: 'delivered-existing-after-restart', expected: `existing:${created}`, observed: candidate(d.runB) },
    {
      id: 'cancelled-refused-before-cleanup',
      expected: { outcome: 'not-applied', resources: true },
      observed: {
        outcome: receipt(c.runA.firstPlan)?.outcome ?? null,
        resources: (receipt(c.runA.firstPlan)?.plan?.refusals ?? []).some(item => item.code === 'RESOURCES_PENDING'),
      },
    },
    // The real environment exists: the stand-in refuses, the environment stays an own resource and forget stays refused (nothing deleted).
    // It does not: the stand-in answers it absent, then the cancelled cycle is forgotten.
    ...(kept
      ? [
          {
            id: 'cancelled-environment-kept',
            expected: { cleanup: 'accepted', port: 'refused-present' },
            observed: {
              cleanup: receipt(c.runA.cleanupConfirm)?.outcome ?? null,
              port:
                (c.runA.environmentPort as string[]).length && !(c.runA.environmentPort as string[]).some(item => item.startsWith('absent'))
                  ? 'refused-present'
                  : 'answered-absent',
            },
          },
          {
            id: 'cancelled-still-refused',
            expected: { outcome: 'not-applied', resources: true },
            observed: {
              outcome: receipt(c.runA.secondPlan)?.outcome ?? null,
              resources: (receipt(c.runA.secondPlan)?.plan?.refusals ?? []).some(item => item.code === 'RESOURCES_PENDING'),
            },
          },
          { id: 'cancelled-kept', expected: ['work', 'work'], observed: [shown(c.runA), shown(c.runB)] },
          { id: 'cancelled-records-kept', expected: { present: true, files: c.before.files }, observed: { present: c.after.present, files: c.after.files } },
        ]
      : [
          { id: 'cancelled-environment-cleanup', expected: 'accepted', observed: receipt(c.runA.cleanupConfirm)?.outcome ?? null },
          { id: 'cancelled-plan-accepted', expected: 'planned', observed: receipt(c.runA.secondPlan)?.plan?.state ?? null },
          { id: 'cancelled-forgotten', expected: ['work-forgotten', 'work-forgotten'], observed: [shown(c.runA), shown(c.runB)] },
          {
            id: 'cancelled-records-deleted',
            expected: { present: false, leftover: false },
            observed: { present: c.after.present, leftover: c.after.leftover },
          },
          {
            id: 'cancelled-memory',
            expected: { result: 'cancelled', mergeConfirmed: false, pullRequest: false, keys: [] },
            observed: {
              result: memory(c.runA)?.result ?? null,
              mergeConfirmed: memory(c.runA)?.mergeConfirmed ?? null,
              pullRequest: Boolean(memory(c.runA)?.pullRequest),
              keys: memoryViolations(memory(c.runA)),
            },
          },
        ]),
    {
      id: 'cancelled-successor-current',
      expected: [`existing:${c.successorId}`, `existing:${c.successorId}`, 'open'],
      observed: [candidate(c.runA), candidate(c.runB), listed(c.runB).find(item => item.work_id === c.successorId)?.result ?? null],
    },
    {
      id: 'list-and-status',
      expected: { delivered: true, cancelled: !kept, works: [1, kept ? 0 : 1] },
      observed: {
        delivered: forgottenIds(d.runB).includes(d.workId) && !listed(d.runB).some(item => item.work_id === d.workId),
        cancelled: forgottenIds(c.runB).includes(c.workId) && !listed(c.runB).some(item => item.work_id === c.workId),
        works: [status(d.runB)?.works ?? null, status(c.runB)?.works ?? null],
      },
    },
    { id: 'status-note', expected: true, observed: /covers only the Works still remembered/.test(status(d.runB)?.note ?? '') },
    {
      id: 'clean-stops',
      expected: ['clean', 'clean', 'clean', 'clean'],
      observed: [d.runA, d.runB, c.runA, c.runB].map(run => (run.outcome as { kind?: string }).kind ?? null),
    },
    // Review LOW: the source storages AND the real `<y5>/<work>/` Records sources are hashed (never touched).
    { id: 'sources-unchanged', expected: input.sourceBefore, observed: input.sourceAfter },
    { id: 'no-remote-effect', expected: 0, observed: remote },
  ].map(check => ({ ...check, met: JSON.stringify(check.expected) === JSON.stringify(check.observed) }));
  return { revision, overall: checks.every(check => check.met) ? 'met' : 'not-met', checks };
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
  const load = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8')) as Record<string, unknown>;
  const exists = (name: string) =>
    fs.access(`${observations}/${name}.json`).then(
      () => true,
      () => false,
    );
  return { fs, save, load, exists };
}
/** sha256 of a tree, never following anything (relative path, type and content or link target). */
async function treeDigest(path: string) {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const walk = async (current: string, relative: string) => {
    const info = await fs.lstat(current).catch(() => null);
    if (!info) {
      hash.update(`${relative}:absent`);
      return;
    }
    if (info.isSymbolicLink()) {
      hash.update(`${relative}:link:${await fs.readlink(current)}`);
      return;
    }
    if (info.isDirectory()) {
      hash.update(`${relative}:dir`);
      for (const name of (await fs.readdir(current)).sort()) await walk(`${current}/${name}`, `${relative}/${name}`);
      return;
    }
    if (info.isFile()) {
      hash.update(`${relative}:file:`).update(await fs.readFile(current));
      return;
    }
    hash.update(`${relative}:special`);
  };
  await walk(path, '.');
  return hash.digest('hex');
}
async function sourceDigest(workIds: Partial<Record<CaseName, string>> = {}) {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  for (const item of Object.values(cases))
    for (const name of ['control.sqlite', 'control.sqlite-wal', 'control.sqlite-shm']) {
      hash.update(`${item.storage}/${name}`).update(await fs.readFile(`${item.storage}/${name}`).catch(() => Buffer.from('absent')));
    }
  const records: Record<string, string> = {};
  for (const [name, workId] of Object.entries(workIds)) records[name] = await treeDigest(`${cases[name as CaseName].records}/${workId}`);
  return { storages: hash.digest('hex'), records };
}
/** Inert view (list) of an authority snapshot: no polling, no run beyond an aborted start. */
async function view(storagePath: string) {
  const { openControl } = await import('../../src/control/index.js');
  const stored = await openControl({ storagePath, runtimeInventory: 'unknown' });
  const list = (await stored.inspect({ kind: 'list' })) as ListView;
  const stopped = new AbortController();
  stopped.abort();
  await stored.run(stopped.signal);
  return list;
}
const treeOf = (tree: { present: boolean; leftover: boolean; files: number; completeness: string }): Tree => ({
  present: tree.present,
  leftover: tree.leftover,
  files: tree.files,
  completeness: tree.completeness,
});

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, load, exists } = await io();
  const { snapshotStorage } = await import('./review12-qualification.js');
  const { inspectWorkRecords } = await import('../../src/records/index.js');
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const prepared: Record<string, unknown> = {};
      const ids: Partial<Record<CaseName, string>> = {};
      for (const [name, item] of Object.entries(cases) as [CaseName, (typeof cases)[CaseName]][]) {
        const caseRoot = `${observations}/${name}`;
        await fs.mkdir(caseRoot, { mode: 0o700 });
        const authority = await prepareAuthority(item.storage, `${caseRoot}/authority`, `${revision}-${name}`);
        const list = await view(await snapshotStorage(`${caseRoot}/authority`, `${caseRoot}/preflight-storage-copy`));
        const work =
          list.works.find(entry => entry.ticket.repository === repositoryName && entry.ticket.number === item.number && entry.result === item.result) ?? null;
        if (!work) {
          await save(`preflight-held-${name}`, { works: list.works.map(entry => [entry.work_id, entry.ticket.number, entry.result]) });
          throw new Error('PRECONDITION_HELD');
        }
        const successor = list.works.find(entry => entry.predecessor === work.work_id) ?? null;
        await fs.mkdir(`${caseRoot}/records`, { mode: 0o700 });
        const source = `${item.records}/${work.work_id}`;
        const copied = (await fs.lstat(source).then(
          () => true,
          () => false,
        ))
          ? await copyRecords(source, `${caseRoot}/records/${work.work_id}`)
          : { files: 0, bytes: 0, absent: true };
        const tree = await inspectWorkRecords(await fs.realpath(`${caseRoot}/records`), work.work_id);
        ids[name] = work.work_id;
        // The environments the product would remove for this Work, at the SOURCE run's installation root (read-only lstat).
        const environments = [
          ...new Set(
            [...work.previousExecutions, ...(work.execution ? [work.execution] : [])]
              .map(item => item.dispatch.environment)
              .filter((env): env is string => typeof env === 'string' && /^env-[0-9a-f]{64}$/.test(env)),
          ),
        ];
        const present: Record<string, boolean> = {};
        for (const env of environments)
          present[env] = await fs.lstat(`${environmentRoot}/environments/${env}`).then(
            () => true,
            () => false,
          );
        prepared[name] = {
          authority,
          workId: work.work_id,
          successorId: successor?.work_id ?? null,
          ticket: work.ticket,
          label: work.authorization.basis.label,
          confirmedAt: work.delivery?.merge?.confirmedAt ?? null,
          copied,
          before: treeOf(tree),
          environments: present,
          environmentPresent: Object.values(present).some(Boolean),
        };
      }
      await save('preflight-result', { status: 'success', cases: prepared, workIds: ids, sourceBefore: await sourceDigest(ids) });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    const preflight = (await load('preflight-result')) as {
      cases: Record<
        CaseName,
        {
          workId: string;
          successorId: string | null;
          ticket: WorkView['ticket'];
          label: { id: number; name: string };
          confirmedAt: string | null;
          before: Tree;
          environmentPresent: boolean;
        }
      >;
      workIds: Partial<Record<CaseName, string>>;
      sourceBefore: unknown;
    };
    const caseInput = async (name: CaseName) => {
      const caseRoot = `${observations}/${name}`;
      const item = preflight.cases[name];
      return {
        storagePath: `${caseRoot}/authority/control.sqlite`,
        environmentRoot,
        recordsRoot: await fs.realpath(`${caseRoot}/records`),
        workId: item.workId,
        ticket: item.ticket,
        label: item.label,
        now: item.confirmedAt ? Date.parse(item.confirmedAt) + day : Date.now(),
      };
    };
    if (phase === 'forget') {
      const d = await caseInput('delivered'),
        c = await caseInput('cancelled');
      await save('forget-a-delivered-result', await forgetOwnerRun({ ...d, steps: ['forget'], requestPrefix: `${revision}-d-a` }));
      await save('forget-a-cancelled-result', await forgetOwnerRun({ ...c, steps: ['cleanup-environment-then-forget'], requestPrefix: `${revision}-c-a` }));
      await save('forget-b-delivered-result', await forgetOwnerRun({ ...d, steps: ['new'], requestPrefix: `${revision}-d-b` }));
      await save('forget-b-cancelled-result', await forgetOwnerRun({ ...c, steps: [], requestPrefix: `${revision}-c-b` }));
      return;
    }
    if (!(await exists('forget-b-cancelled-result'))) throw new Error('FORGET_REQUIRED');
    const observed = async (name: CaseName): Promise<CaseObservation> => {
      const item = preflight.cases[name];
      const after = await inspectWorkRecords(await fs.realpath(`${observations}/${name}/records`), item.workId);
      return {
        workId: item.workId,
        successorId: item.successorId,
        before: item.before,
        after: treeOf(after),
        environmentPresent: item.environmentPresent,
        runA: (await load(`forget-a-${name}-result`)) as never,
        runB: (await load(`forget-b-${name}-result`)) as never,
      };
    };
    const delivered = await observed('delivered'),
      cancelled = await observed('cancelled');
    const result = verdict({ delivered, cancelled, sourceBefore: preflight.sourceBefore, sourceAfter: await sourceDigest(preflight.workIds) });
    const views: Record<string, unknown> = {};
    for (const name of Object.keys(cases) as CaseName[]) {
      const list = await view(await snapshotStorage(`${observations}/${name}/authority`, `${observations}/${name}/inspect-storage-copy`));
      views[name] = {
        works: list.works.map(work => ({ work_id: work.work_id, cycle: work.cycle, predecessor: work.predecessor, result: work.result })),
        forgotten: list.forgotten ?? [],
      };
    }
    await save('inspect-result', { views, delivered: delivered.after, cancelled: cancelled.after });
    await save('verdict', result);
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
