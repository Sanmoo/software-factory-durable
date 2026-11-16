import { inspectNamespace, observationWriter, y5 } from './prepilot34-qualification.js';
import { inspectCopy } from './inspect29-qualification.js';

// TEST ONLY. Pre-pilot group R-INSPECT (ticket 34: V-15.c), authorized by the operator on 2026-11-16. LOCAL only: the ticket 29 inspection
// recipe (`inspectCopy`: copy the storage, the Works' Records and the session files they name; open the public Control on the COPY without
// `run`; serve it read-only; query it with the real CLI) over a storage that still has sessions: q23-feedback-v3. The source is never opened
// or written: its control.sqlite(-wal/-shm) are copied first and hashed before and after; its namespace's run/ (a stale mount) is never
// entered (only `<y5>/<work_id>/` Records and `<y5>/r/...` session files the storage names are copied). No network, GitHub, VM, model or
// credential. Import and `--plan` are inert. One-shot: the namespace directory is the exclusive intent; a consumed run never reruns.

const revision = 'qinspect34-v1';
const namespace = inspectNamespace;
export const source = 'q23-feedback-v3';
export const roles = ['builder', 'standards', 'spec'] as const;

export function plan() {
  return { revision, group: 'R-INSPECT', obligations: ['V-15.c'], root: y5, source, namespace,
    effects: [`run (one-shot, LOCAL): exclusive mkdir ${namespace}; sha256 of ${y5}/${source}/control.sqlite(-wal) before; inspectCopy: COPY control.sqlite(-wal/-shm) into ` +
      `${namespace}/${source}/data (migrated ON THE COPY if older), COPY each Work's Records ${y5}/<work_id>/ and the session files its Executions/opinions name (${y5}/r/...), ` +
      `bounded 1 GiB, no symlink followed; open Control on the copy WITHOUT run; serve read-only; real CLI: status, list, usage, show, history (pages, --execution, --role), logs, usage <w>; ` +
      'sha256 of the source after (must be unchanged); verdict computed and saved'],
    never: [`enter ${y5}/${source}/run (stale mount) or any path not named by the storage`, 'open or write the source storage/Records/sessions', 'start a controller or poll GitHub',
      'boot a VM, run a model, read a credential', 'rerun after the namespace exists'],
    expected: ['usage measured (tokens > 0) for builder, standards and spec of at least one Work', 'a continued Builder session counted once: carriedEntries > 0 and, per shared session, ' +
      'the entries summed over its activities equal one full read (entries + carried) of it', 'every unavailable activity has tokens/cost null and a code; aggregates with an unavailable part are never complete; ' +
      'partial/unavailable exercised by the data or reported as not exercised'],
    bounds: { network: 'none', github: 'none', vm: 'none', model: 'none', credentials: 'none', copyGiB: 1, wallMinutes: 3, memoryMiB: 512 } };
}

type Activity = { executionId: string; role: string; measurement: string; code: string | null; carriedEntries: number; entries: number;
  session: { sessionId: string | null }; tokens: { total: number } | null; cost: unknown };
type WorkUsage = { work_id: string; activities: Activity[]; byRole: Record<string, { measured: number; unavailable: number; measurement: string; tokens: { total: number } | null }>;
  total: { measurement: string; measured: number; unavailable: number; tokens: { total: number } | null } };
type Check = { id: string; passed: boolean; observed: string };

/** V-15.c over the `usage <work>` views of the copy (pure; tested on synthetic views). */
export function usageVerdict(works: readonly WorkUsage[]): { proven: boolean; exercised: { partialOrAbsent: boolean }; checks: Check[] } {
  const check = (id: string, passed: boolean, observed: string): Check => ({ id, passed, observed: observed.slice(0, 400) });
  const measuredRoles = works.find(work => roles.every(role => (work.byRole[role]?.measured ?? 0) > 0 && (work.byRole[role]?.tokens?.total ?? 0) > 0));
  const activities = works.flatMap(work => work.activities.map(activity => ({ work: work.work_id, ...activity })));
  const shared = new Map<string, typeof activities>();
  for (const activity of activities) if (activity.session.sessionId && activity.measurement !== 'unavailable') {
    shared.set(activity.session.sessionId, [...(shared.get(activity.session.sessionId) ?? []), activity]);
  }
  const continued = [...shared.entries()].filter(([, items]) => items.length > 1);
  // Every activity reads the whole (shared) session file: an entry is summed once in total, so the summed entries equal one full read.
  const onceEach = continued.every(([, items]) => items.reduce((sum, item) => sum + item.entries, 0) === Math.max(...items.map(item => item.entries + item.carriedEntries)));
  const totalsConsistent = works.every(work => {
    const sum = work.activities.filter(item => item.measurement !== 'unavailable').reduce((total, item) => total + (item.tokens?.total ?? 0), 0);
    return work.total.measured === 0 ? work.total.tokens === null : work.total.tokens?.total === sum;
  });
  const unavailable = activities.filter(item => item.measurement === 'unavailable');
  const partial = activities.filter(item => item.measurement === 'partial');
  const neverZero = unavailable.every(item => item.tokens === null && item.cost === null && !!item.code) &&
    works.every(work => (work.total.unavailable === 0 || work.total.measurement !== 'complete') && Object.values(work.byRole).every(role => role.measured > 0 || role.tokens === null));
  const checks = [
    check('measured-three-roles', !!measuredRoles, measuredRoles ? roles.map(role => `${role}:${measuredRoles.byRole[role]?.measured}/${measuredRoles.byRole[role]?.tokens?.total}`).join(' ')
      : works.map(work => roles.map(role => `${role}:${work.byRole[role]?.measured ?? 0}`).join(',')).join(' | ')),
    check('resumed-session-counted-once', continued.length > 0 && continued.some(([, items]) => items.some(item => item.carriedEntries > 0)) && onceEach && totalsConsistent,
      `${continued.length} continued sessions; ${continued.map(([id, items]) => `${id.slice(0, 8)}:${items.map(item => `${item.entries}+${item.carriedEntries}`).join('/')}`).join(' ')}; totals ${totalsConsistent}`),
    check('partial-or-absent-never-zero', neverZero, `${unavailable.length} unavailable (${[...new Set(unavailable.map(item => item.code))].join(',')}); ${partial.length} partial`),
  ];
  return { proven: checks.every(item => item.passed) && (unavailable.length + partial.length > 0), exercised: { partialOrAbsent: unavailable.length + partial.length > 0 }, checks };
}

export async function runPhase() {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  await fs.mkdir(namespace, { mode: 0o700 }); // exclusive intent: an existing namespace means the run was consumed
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).stdout.trim().length > 0;
  const save = observationWriter(namespace, () => ({ revision, factory: { commit: head, dirty, cli: 'dist/src/entrypoints/cli.js of this checkout (R-INSPECT does not need the release)' } }));
  const digest = async () => Object.fromEntries(await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(async name =>
    [name, await fs.readFile(`${y5}/${source}/${name}`).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null)])));
  const before = await digest();
  try {
    const observed = await inspectCopy({ root: y5, source, copy: `${namespace}/${source}`, upgradeId: `${revision}-${source}` });
    const after = await digest();
    const usages = observed.results.filter(item => item.args[0] === 'usage' && item.args.length === 2)
      .flatMap(item => (item.json as { works?: WorkUsage[] } | null)?.works ?? []);
    const usage = usageVerdict(usages);
    const checks = [...observed.checks, { name: 'source-unchanged', ok: JSON.stringify(before) === JSON.stringify(after), detail: JSON.stringify({ before, after }) }];
    await save('run-result', { status: 'success', ...observed });
    const met = checks.every(item => item.ok) && usage.proven;
    await save('verdict-result', { status: met ? 'success' : 'not-met', obligation: { 'V-15.c': usage.proven ? 'proven' : 'not-proven' }, usage, checks,
      note: 'Computed from this run\'s CLI views of the copy; the source storage was hashed before and after.' });
    if (!met) throw new Error('QUALIFICATION_NOT_MET');
  } catch (error) {
    if (error instanceof Error && error.message === 'QUALIFICATION_NOT_MET') throw error; // the saved verdict says what was not met
    await save('run-held', { status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw error;
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || args[0] !== 'run') throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase();
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => { console.error('Qualification held or not met; no retry.'); process.exit(1); });
}
