// TEST ONLY. Ticket 29 one-shot LOCAL qualification recipe: the correlated inspection and consumption through the REAL CLI on COPIES of real
// storages. Import and `--plan` are inert. The `run` phase reads the qualification root ONLY to copy (never opens or writes the sources):
// each source storage is copied into this recipe's own namespace and, if written before ticket 33, migrated explicitly ON THE COPY; the
// Records of that storage's Works and their session files are copied too. Each copy is opened by the public Control WITHOUT `run` (no
// polling, reconciliation, dispatch or GitHub), served READ-ONLY on the copy's private socket, and queried with the real CLI binary.
// No network, GitHub, VM, model or credential. One-shot: the namespace directory is the exclusive intent; a consumed run never reruns.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecutionPorts, ListView } from '../../src/control/index.js';
import { prepareAuthority } from './delivery17-qualification.js';

const root = '/home/sanmoo/software-factory-test/y5';
const revision = 'q29-inspect-v1';
const namespace = `${root}/${revision}`;
const sources = ['q18-journey-v4', 'q25-cancel-v1'] as const;
/** Bounds of the copy (bytes of Records + session files per source) and of each CLI output kept in the observations. */
const limits = { copyBytes: 1024 * 1024 * 1024, outputBytes: 256 * 1024, cliTimeoutMs: 30_000 } as const;
/** Known credential shapes (GitHub, OpenAI incl. sk-proj-, Anthropic sk-ant-, JWT, OAuth access/refresh, Google ya29., PEM keys, Bearer). */
export const secretPatterns = [/gh[opsur]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, /"(?:access|refresh|id)_token"\s*:\s*"[^"]+"/g, /\bya29\.[A-Za-z0-9._-]{20,}/g, /Bearer [A-Za-z0-9._~+/=-]{20,}/g];
/** Every match replaced BEFORE anything is kept or saved; returns the redacted text and how many matches were found. */
export function redact(text: string): { text: string; found: number } {
  let found = 0;
  for (const pattern of secretPatterns) text = text.replace(pattern, () => { found++; return '[REDACTED]'; });
  return { text, found };
}

export function plan() {
  return { revision, root, namespace, sources,
    requires: 'tickets 17/18/23/25/28/30 integrated with 29; the storages y5/q18-journey-v4 and y5/q25-cancel-v1 exist (their runs are consumed)',
    effects: [
      `run (one-shot, LOCAL): exclusive mkdir ${namespace}; per source: COPY ${root}/<source>/control.sqlite(-wal/-shm) into ${namespace}/<source>/data ` +
        '(format-1 copy migrated 1→2 with the digest-checked migrateStorage, never the source); COPY the Records tree of each Work of that storage ' +
        `(${root}/<work_id>/) and the preserved session files its Executions/opinions name (${root}/r/...) into ${namespace}/<source>/ (bounded, modes kept, no symlink followed)`,
      'open the public Control on the copy with runtimeInventory unknown and NO run (no polling/reconciliation/dispatch/GitHub); compose ONLY the read-only Records find/read and the Workers usage facet over the copy',
      'serve that Control read-only on <copy>/run/control.sock (every accept refused) and run the REAL CLI binary: status, list, show <w>, history <w> (page, next page, --execution, --role), ' +
        'logs <w> (listing, --role, --read of one text capture and its next page), usage <w>, usage; outputs bounded and stored in the namespace',
      'checks recorded: exit codes only 0/2/3, stable JSON on stdout, every view fits one frame, no known secret pattern in any output, unavailable usage never carries numbers, ' +
        'chain present for every Work, history filters consistent with the full history, logs listing complete or explained',
    ],
    never: ['open or write a source storage/Records', 'start a controller (`run`) or any polling/GitHub read', 'boot a VM, run a model, read a credential', 'rerun after the namespace exists'],
    expected: ['q18-journey-v4: a delivered Work with Executions, two-reviewer rounds, publication/readiness/delivery/cleanup in the chain; usage measured or explained per activity',
      'q25-cancel-v1: cancelled/new-cycle Works with predecessor links in the chain; history of the cancellation; usage partial/unavailable where sessions were removed',
      'logs: listing complete with per-capture state; raw captures never displayed; a large text capture paged as truncated with nextOffset'],
  };
}

type Cli = { args: string[]; code: number | null; json: unknown; bytes: number; truncated: boolean; stderr: string; secrets: number };

async function cli(copy: string, args: string[]): Promise<Cli> {
  const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', copy, '--json'], {
    env: { PATH: process.env.PATH ?? '', HOME: '/forbidden-personal-profile' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
  const timer = setTimeout(() => child.kill('SIGKILL'), limits.cliTimeoutMs);
  const code = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done); }).finally(() => clearTimeout(timer));
  const bytes = Buffer.byteLength(stdout);
  // Redacted before parsing/keeping: no secret-shaped text ever reaches memory kept for the observations or the disk.
  const out = redact(stdout), err = redact(stderr);
  let json: unknown = null;
  try { json = out.text ? JSON.parse(out.text) : null; } catch { json = { unparsable: true }; }
  return { args, code, json: bytes > limits.outputBytes ? { omitted: 'larger than the observation bound' } : json, bytes, truncated: bytes > limits.outputBytes, stderr: err.text,
    secrets: out.found + err.found };
}

/**
 * A recorded path is copied only when it is normalized, has no `.`/`..` segment, lies under `<root>/<prefix>` and its real path stays there;
 * the destination is the same relative path under the copy (checked to stay inside it). Returns the relative path or null (refused).
 */
export async function containedPath(root: string, copy: string, file: string, prefix: string): Promise<string | null> {
  const fs = await import('node:fs/promises');
  const { normalize, relative, resolve: absolute } = await import('node:path');
  if (normalize(file) !== file || absolute(file) !== file || file.split('/').some(part => part === '..' || part === '.')) return null;
  const inside = relative(root, file);
  if (inside.startsWith('..') || !inside.startsWith(`${prefix}/`)) return null;
  const real = await fs.realpath(file).catch(() => null);
  if (real === null || relative(await fs.realpath(root), real) !== inside) return null;
  const destination = absolute(copy, inside);
  return relative(copy, destination) === inside && !relative(copy, destination).startsWith('..') ? inside : null;
}

/** Copies a private tree (files/dirs only, modes kept, no symlink followed), bounded by `budget` bytes; returns the bytes copied. */
async function copyTree(from: string, to: string, budget: { left: number }): Promise<number> {
  const fs = await import('node:fs/promises');
  const info = await fs.lstat(from).catch(() => null);
  if (!info) return 0;
  if (info.isDirectory()) {
    await fs.mkdir(to, { mode: info.mode & 0o777 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    let total = 0;
    for (const name of (await fs.readdir(from)).sort()) total += await copyTree(`${from}/${name}`, `${to}/${name}`, budget);
    await fs.chmod(to, info.mode & 0o777);
    return total;
  }
  if (!info.isFile()) return 0;
  budget.left -= info.size;
  if (budget.left < 0) throw new Error('COPY_BOUND_EXCEEDED');
  await fs.copyFile(from, to, constants.COPYFILE_EXCL);
  await fs.chmod(to, info.mode & 0o777);
  return info.size;
}

/**
 * The inspection of ONE source through its copy. Parametrized (roots) so the storage test runs it over a temporary synthetic root.
 * Returns the observations and the checks; the caller saves them.
 */
export async function inspectCopy(input: { root: string; source: string; copy: string; upgradeId: string }) {
  const fs = await import('node:fs/promises');
  const { openControl } = await import('../../src/control/index.js');
  const { createRecords } = await import('../../src/records/index.js');
  const { createWorkers } = await import('../../src/workers/index.js');
  const { serveInspection } = await import('../../src/entrypoints/controller/inspection.js');
  await fs.mkdir(input.copy, { mode: 0o700 });
  for (const directory of ['run', 'environments']) await fs.mkdir(`${input.copy}/${directory}`, { mode: 0o700 });
  const authority = await prepareAuthority(`${input.root}/${input.source}`, `${input.copy}/data`, input.upgradeId);
  const { inspectStorage } = await import('../../src/control/index.js');
  const digest = async () => { const inspection = await inspectStorage(authority.storagePath); return inspection.kind === 'storage' ? inspection.stateDigest : null; };
  const before = await digest();
  // ONE Control on the copy, never `run` started: no polling, reconciliation, dispatch or GitHub (no `access` is composed, so no dispatcher
  // or boot reconciliation can exist); its Records/usage ports open lazily, after the copy below. Closed by an aborted `run` (writes nothing).
  const workers = createWorkers({ root: input.copy, knownSecrets: [], profile: { id: 'inspection-only' } as never });
  let records: ReturnType<typeof createRecords> | undefined;
  const opened = () => records ??= createRecords({ root: input.copy });
  const refuse = async () => { throw new Error('INSPECTION_ONLY'); };
  const ports: ExecutionPorts = { sandbox: { prepare: refuse, start: refuse, stop: refuse }, credentials: {} as never, configuration: {}, capacity: 0, builder: {},
    workers: { activate: refuse, deliver: refuse,
      // Reviewer session files are recorded as absolute paths of the source root: read the COPY of the same (contained) relative path.
      observeUsage: request => workers.observeUsage({ ...request, session: 'file' in request.session && request.session.file.startsWith(`${input.root}/`)
        ? { file: `${input.copy}/${request.session.file.slice(input.root.length + 1)}` } : request.session }) },
    records: { find: async selection => (await opened()).find(selection), read: async request => (await opened()).read(request) } };
  const control = await openControl({ storagePath: authority.storagePath, runtimeInventory: 'unknown', execution: ports });
  const list = await control.inspect({ kind: 'list' }) as ListView;
  const budget = { left: limits.copyBytes };
  const copied: Record<string, number> = {};
  const refused: string[] = [];
  for (const work of list.works) {
    copied[work.work_id] = await copyTree(`${input.root}/${work.work_id}`, `${input.copy}/${work.work_id}`, budget);
    for (const execution of [...work.previousExecutions, ...(work.execution ? [work.execution] : [])]) {
      const files = [execution.end?.session?.ref ? `${input.root}/${execution.end.session.ref}` : null,
        ...(execution.review?.rounds ?? []).flatMap(round => (['standards', 'spec'] as const).map(role => round.reviewers?.[role]?.opinion?.session.file ?? null))]
        .filter((file): file is string => !!file);
      for (const file of files) {
        const relative = await containedPath(input.root, input.copy, file, 'r');
        if (!relative) { refused.push(file.slice(0, 256)); continue; }
        let directory = input.copy;
        for (const part of relative.split('/').slice(0, -1)) { directory = `${directory}/${part}`; await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; }); }
        copied[relative] = await copyTree(file, `${input.copy}/${relative}`, budget).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') return 0; throw error; });
      }
    }
  }
  const server = await serveInspection(`${input.copy}/run/control.sock`, control);
  const results: Cli[] = [];
  try {
    const run = async (...args: string[]) => { const result = await cli(input.copy, args); results.push(result); return result; };
    await run('status'); await run('list'); await run('usage');
    for (const work of list.works) {
      const id = work.work_id;
      await run('show', id);
      const first = await run('history', id, '--limit', '50');
      const cursor = (first.json as { page?: { nextCursor?: number | null } })?.page?.nextCursor;
      if (typeof cursor === 'number') await run('history', id, '--cursor', String(cursor), '--limit', '50');
      const executionId = work.previousExecutions[0]?.executionId ?? work.execution?.executionId;
      if (executionId) await run('history', id, '--execution', executionId, '--limit', '200');
      await run('history', id, '--role', 'standards', '--limit', '200');
      const logs = await run('logs', id, '--limit', '200');
      await run('logs', id, '--role', 'builder', '--limit', '20');
      const text = ((logs.json as { captures?: { capture: string; format: string; state: string }[] })?.captures ?? []).find(item => item.format === 'text' && item.state === 'complete');
      if (text) {
        const page = await run('logs', id, '--read', text.capture);
        const next = (page.json as { nextOffset?: number | null })?.nextOffset;
        if (typeof next === 'number') await run('logs', id, '--read', text.capture, '--offset', String(next));
      }
      await run('usage', id);
    }
  } finally {
    await server.close();
    const stop = new AbortController(); stop.abort(); await control.run(stop.signal);
  }
  const after = await digest();
  return { source: input.source, authority, works: list.works.map(work => ({ work_id: work.work_id, ticket: `${work.ticket.repository}#${work.ticket.number}`, result: work.result,
    cycle: work.cycle, predecessor: work.predecessor, executions: work.previousExecutions.length + (work.execution ? 1 : 0) })), copied, refused, results,
    storage: { before, after }, checks: [...checks(results), { name: 'copy-unchanged', ok: before !== null && before === after, detail: 'state digest of the copy before/after the inspection' }] };
}

/** Recipe expectations over the CLI results (pure; tested on synthetic results). */
export function checks(results: Cli[]) {
  const text = (result: Cli) => JSON.stringify(result.json) + result.stderr;
  const outcome = (name: string, ok: boolean, detail: string) => ({ name, ok, detail });
  const shows = results.filter(item => item.args[0] === 'show');
  const usages = results.filter(item => item.args[0] === 'usage');
  const unavailableWithNumbers = usages.flatMap(item => ((item.json as { works?: { activities: { measurement: string; tokens: unknown; cost: unknown }[] }[] })?.works ?? [])
    .flatMap(work => work.activities).filter(activity => activity.measurement === 'unavailable' && (activity.tokens !== null || activity.cost !== null)));
  const histories = results.filter(item => item.args[0] === 'history');
  return [
    outcome('exit-codes', results.every(item => item.code === 0 || item.code === 2 || item.code === 3), results.map(item => `${item.args[0]}:${item.code}`).join(' ')),
    outcome('stable-json', results.every(item => item.json !== null && !(item.json as { unparsable?: boolean }).unparsable), 'every stdout is one JSON document'),
    outcome('frame-fit', results.every(item => item.bytes < 64 * 1024 && !(item.json as { code?: string })?.code?.startsWith('VIEW_TOO_LARGE')), 'no view exceeds one protocol frame'),
    outcome('no-secret', results.every(item => item.secrets === 0 && redact(text(item)).found === 0), `${results.reduce((sum, item) => sum + item.secrets, 0)} secret-shaped matches (redacted before saving)`),
    outcome('chain', shows.length > 0 && shows.every(item => (item.json as { chain?: unknown })?.chain !== undefined), `${shows.length} show views with a chain`),
    outcome('usage-never-false-zero', unavailableWithNumbers.length === 0, `${unavailableWithNumbers.length} unavailable activities with numbers`),
    outcome('history-paged', histories.every(item => item.code === 0 && (item.json as { page?: { returned: number } })?.page !== undefined), `${histories.length} history pages`),
    outcome('logs-explained', results.filter(item => item.args[0] === 'logs' && !item.args.includes('--read')).every(item => {
      const listing = (item.json as { listing?: { state: string; code: string | null } })?.listing;
      return listing !== undefined && (listing.state === 'complete' || listing.code !== null);
    }), 'every logs listing is complete or carries its code'),
  ];
}

export async function runPhase() {
  const fs = await import('node:fs/promises');
  await fs.mkdir(namespace, { mode: 0o700 }); // exclusive intent: an existing namespace means the run was consumed
  const save = async (name: string, data: unknown) => {
    const file = await fs.open(`${namespace}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(data, null, 1)); await file.sync(); } finally { await file.close(); }
  };
  const summary: { source: string; checks: { name: string; ok: boolean; detail: string }[] | null; error: string | null }[] = [];
  for (const source of sources) {
    try {
      const observed = await inspectCopy({ root, source, copy: `${namespace}/${source}`, upgradeId: `${revision}-${source}` });
      await save(`${source}-result`, observed);
      summary.push({ source, checks: observed.checks, error: null });
    } catch (error) {
      summary.push({ source, checks: null, error: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN' });
    }
  }
  const met = summary.every(item => item.checks?.every(check => check.ok));
  await save('run-result', { revision, met, summary, note: 'Consumed; no retry. A held source is recorded with its code; nothing was written outside this namespace.' });
  if (!met) throw new Error('QUALIFICATION_NOT_MET');
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || args[0] !== 'run') throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase();
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => { console.error('Qualification held or not met; no retry.'); process.exit(1); });
}

