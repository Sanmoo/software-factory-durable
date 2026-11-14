// Synthetic GitHub boundary for admission tests: a local executable stands in for gh/GitHub
// (and, through installNativeAppFixture, for the App HTTPS endpoints). Never used with real
// credentials, never connects to a network, and is not evidence of the real GitHub boundary.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installNativeAppFixture } from './native-app-fixture.js';

export type WorldIssue = {
  id: number; node_id: string; number: number; title: string; body: string | null; state: 'open' | 'closed'; state_reason: string | null;
  labels: { id: number; name: string }[]; user: { id: number; login: string; type: string }; pull_request?: object;
  /** Issue timeline events served at /issues/{n}/timeline (paginated). */
  timeline?: object[];
  /** Owning repository (default acme/project). Issue ids stay globally unique across repositories, like GitHub. */
  repository?: string;
  /** Native blocked_by edges served at /issues/{n}/dependencies/blocked_by (paginated) as full issue objects of the targets. */
  blocked_by?: { repository?: string; number: number }[];
  /** Edges GitHub counts in issue_dependencies_summary but does not list (simulated invisible blocker). */
  hidden_blocked_by?: number;
  /** Omit issue_dependencies_summary from the issue object. */
  no_summary?: boolean;
  /** Raw extra entries appended to the blocked_by listing (invalid relation payloads). */
  raw_blocked_by?: object[];
};
export type WorldPull = {
  id: number; node_id: string; number: number; title: string; body: string | null; state: 'open' | 'closed'; merged_at: string | null;
  head: { ref: string; repo: { id: number } | null }; user: { id: number; login: string; type: string };
};
export type World = {
  issues: WorldIssue[];
  pulls: WorldPull[];
  pageSize?: number;
  /** endpoint substring → synthetic failure. */
  faults?: Record<string, { status: number; headers?: Record<string, string>; /** Raw (possibly non-JSON) body. */ body?: string }>;
  /** Make every successful operational response report an exhausted rate limit until reset. */
  exhaustRateLimit?: boolean;
  /** Repositories and their App installations (default: acme/project id 3, installation 2). Owner = installation account. */
  repositories?: { name: string; id: number; installation: number }[];
};
export type TraceEntry = { method: string; endpoint: string; credential: 'app-jwt' | 'installation'; permissions?: Record<string, string> };

export function issue(number: number, overrides: Partial<WorldIssue> = {}): WorldIssue {
  return { id: 7000 + number, node_id: `I_node${number}`, number, title: `Ticket ${number}`, body: `SPEC-BODY-${number} must never be captured`,
    state: 'open', state_reason: null, labels: [{ id: 55, name: 'ready-for-agent' }], user: { id: 9, login: 'human', type: 'User' }, ...overrides };
}
export function pull(number: number, overrides: Partial<WorldPull> = {}): WorldPull {
  return { id: 9000 + number, node_id: `PR_node${number}`, number, title: `Change ${number}`, body: null, state: 'open', merged_at: null,
    head: { ref: `human/change-${number}`, repo: { id: 3 } }, user: { id: 10, login: 'someone', type: 'User' }, ...overrides };
}

export async function githubWorld(t: { after(fn: () => Promise<void> | void): void }, initial: World, scenario = 'world') {
  const root = await mkdtemp(join(tmpdir(), 'factory-gh-world-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  await mkdir(join(root, 'run'), { mode: 0o700 });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(join(root, 'credentials/app.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const worldFile = join(root, 'world.json');
  const traceFile = join(root, 'trace.jsonl');
  await writeFile(worldFile, JSON.stringify(initial));
  await writeFile(traceFile, '');
  const executable = join(root, 'gh');
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const endpoint = args.at(-1);
const method = args[args.indexOf('--method') + 1];
const token = process.env.GH_TOKEN ?? '';
const app = token.split('.').length === 3;
const native = process.env.NATIVE_FIXTURE === '1'; // App HTTPS stand-in only.
if (args[0] !== 'api' || !args.includes('--include') || !args.includes('X-GitHub-Api-Version: 2026-03-10') || args[args.indexOf('--hostname') + 1] !== 'github.com') process.exit(9);
if (app !== endpoint.startsWith('/app') || (app && !native)) process.exit(13);
const allowedEnv = ['NATIVE_FIXTURE','PATH','LANG','LC_ALL','GH_TOKEN','GH_HOST','GH_CONFIG_DIR','HOME','XDG_CONFIG_HOME','GH_PROMPT_DISABLED','GH_NO_UPDATE_NOTIFIER','GH_NO_EXTENSION_UPDATE_NOTIFIER','NO_COLOR'];
if (Object.keys(process.env).some(k => !allowedEnv.includes(k)) || args.some(a => token && a.includes(token))) process.exit(9);
if (!app && !token.startsWith('synthetic-installation-secret-')) process.exit(13);
const world = JSON.parse(readFileSync(${JSON.stringify(worldFile)}, 'utf8'));
const ceiling = { metadata: 'read', issues: 'write', contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read', administration: 'read' };
const repositories = world.repositories ?? [{ name: 'acme/project', id: 3, installation: 2 }];
const repoByName = name => repositories.find(r => r.name.toLowerCase() === String(name).toLowerCase());
let body, raw, status = 200, headers = '';
const trace = { method, endpoint, credential: app ? 'app-jwt' : 'installation' };
const url = new URL(endpoint, 'https://api.github.com');
// GitHub names are case-insensitive and may be addressed by numeric id.
let path = url.pathname.replace(/^\\/repositories\\/(\\d+)(?=\\/|$)/, (all, id) => { const r = repositories.find(r => r.id === Number(id)); return r ? '/repos/' + r.name : all; }).toLowerCase();
const match = /^\\/repos\\/([^/]+\\/[^/]+)(\\/.*)?$/.exec(path);
const repo = match ? repoByName(match[1]) : undefined;
const rest = match ? match[2] ?? '' : '';
if (!app && repo && token.split('-').at(-1) !== 'r' + repo.id) { // installation tokens are scoped to one repository
  process.stdout.write('HTTP/2.0 404 Test\\r\\nx-github-api-version-selected: 2026-03-10\\r\\n\\r\\n{"message":"Not Found"}');
  appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ ...trace, status: 404 }) + '\\n');
  process.exit(1);
}
const issuesOf = r => world.issues.filter(i => (i.repository ?? 'acme/project').toLowerCase() === r.name.toLowerCase());
const shape = i => {
  const r = repoByName(i.repository ?? 'acme/project');
  const { repository, blocked_by, hidden_blocked_by, no_summary, raw_blocked_by, timeline, ...plain } = i;
  const targets = (blocked_by ?? []).map(edge => world.issues.find(t => t.number === edge.number && (t.repository ?? 'acme/project').toLowerCase() === (edge.repository ?? 'acme/project').toLowerCase())).filter(Boolean);
  const summary = { blocked_by: targets.filter(t => t.state === 'open').length + (hidden_blocked_by ?? 0), blocking: 0,
    total_blocked_by: targets.length + (hidden_blocked_by ?? 0), total_blocking: 0 };
  return { ...plain, repository_url: 'https://api.github.com/repos/' + r.name, html_url: 'https://github.com/' + r.name + '/issues/' + i.number,
    ...(no_summary ? {} : { issue_dependencies_summary: summary }) };
};
function page(items) {
  const size = world.pageSize ?? 100;
  const number = Number(url.searchParams.get('page') ?? '1');
  if (url.searchParams.get('per_page') !== '100') process.exit(15);
  const slice = items.slice((number - 1) * size, number * size);
  if (number * size < items.length) {
    const next = new URL('https://api.github.com/repositories/' + repo.id + rest);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(number + 1));
    headers += 'link: <' + next.href + '>; rel="next"\\r\\n';
  }
  return slice;
}
const installation = Number(/^\\/app\\/installations\\/(\\d+)/.exec(endpoint)?.[1] ?? NaN);
const owned = repositories.filter(r => r.installation === installation);
if (endpoint === '/app' && method === 'GET') body = { id: 1 };
else if (/^\\/app\\/installations\\/\\d+$/.test(endpoint) && method === 'GET' && owned.length) body = { id: installation, app_id: 1, account: { login: owned[0].name.split('/')[0] }, suspended_at: null, permissions: ceiling };
else if (/^\\/app\\/installations\\/\\d+\\/access_tokens$/.test(endpoint) && method === 'POST' && owned.length) {
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  const target = owned.find(r => request.repositories?.length === 1 && r.name.split('/')[1].toLowerCase() === String(request.repositories[0]).toLowerCase());
  if (Object.keys(request).sort().join() !== 'permissions,repositories' || !target) process.exit(10);
  for (const [name, level] of Object.entries(request.permissions)) if (!ceiling[name] || (level === 'write' && ceiling[name] !== 'write')) process.exit(10);
  trace.permissions = request.permissions;
  trace.repository = target.name;
  const sequence = readFileSync(${JSON.stringify(traceFile)}, 'utf8').split('\\n').filter(line => line.includes('access_tokens')).length + 1;
  body = { token: 'synthetic-installation-secret-' + sequence + '-r' + target.id, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: request.permissions,
    repositories: [{ id: target.id, full_name: target.name, owner: { login: target.name.split('/')[0] } }] };
  status = 201;
} else if (method !== 'GET' || app) process.exit(16);
else if (!repo) process.exit(11);
else if (rest === '') body = { id: repo.id, full_name: repo.name, owner: { login: repo.name.split('/')[0] } };
else if (rest === '/issues') {
  const state = url.searchParams.get('state'); const label = url.searchParams.get('labels');
  body = page(issuesOf(repo).filter(i => (!state || state === 'all' || i.state === state) &&
    (!label || i.labels.some(l => l.name.toLowerCase() === label.toLowerCase()))).map(shape));
} else if (/^\\/issues\\/\\d+\\/timeline$/.test(rest)) {
  const found = issuesOf(repo).find(i => i.number === Number(rest.split('/')[2]));
  if (found) body = page(found.timeline ?? []);
  else { status = 404; body = { message: 'Not Found' }; }
} else if (/^\\/issues\\/\\d+\\/dependencies\\/blocked_by$/.test(rest)) {
  const found = issuesOf(repo).find(i => i.number === Number(rest.split('/')[2]));
  if (found) {
    const targets = (found.blocked_by ?? []).map(edge => world.issues.find(t => t.number === edge.number && (t.repository ?? 'acme/project').toLowerCase() === (edge.repository ?? 'acme/project').toLowerCase()));
    if (targets.some(t => !t)) process.exit(18);
    body = page([...targets.map(shape), ...(found.raw_blocked_by ?? [])]);
  } else { status = 404; body = { message: 'Not Found' }; }
} else if (/^\\/issues\\/\\d+$/.test(rest)) {
  const found = issuesOf(repo).find(i => i.number === Number(rest.split('/')[2]));
  if (found) body = shape(found);
  else { status = 404; body = { message: 'Not Found' }; }
} else if (rest === '/pulls' && repo.id === 3) {
  if (url.searchParams.get('state') !== 'all') process.exit(17);
  body = page(world.pulls.map(p => ({ ...p, html_url: 'https://github.com/acme/project/pull/' + p.number, base: { repo: { id: 3 } } })));
} else process.exit(11);
for (const [fragment, fault] of Object.entries(world.faults ?? {})) if (endpoint.includes(fragment) && !app) {
  status = fault.status; body = { message: 'synthetic-installation-secret-leak' }; if (fault.body !== undefined) raw = fault.body;
  for (const [name, value] of Object.entries(fault.headers ?? {})) headers += name + ': ' + value + '\\r\\n';
}
if (world.exhaustRateLimit && !app && status === 200) headers += 'x-ratelimit-remaining: 0\\r\\nx-ratelimit-reset: ' + (Math.floor(Date.now() / 1000) + 600) + '\\r\\n';
appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace) + '\\n');
process.stdout.write('HTTP/2.0 ' + status + ' Test\\r\\nx-github-api-version-selected: 2026-03-10\\r\\n' + headers + '\\r\\n' + (raw ?? JSON.stringify(body)));
process.exit(status >= 200 && status < 300 ? 0 : 1);
`, { mode: 0o700 });
  const preload = join(root, 'native-fixture.mjs');
  await writeFile(preload, `import { installNativeAppFixture } from ${JSON.stringify(pathToFileURL(resolve('dist/test/entrypoints/native-app-fixture.js')).href)}; installNativeAppFixture(${JSON.stringify(executable)}, ${JSON.stringify(scenario)});`);
  await writeFile(join(root, 'flock'), `#!${process.execPath}
import { spawn } from 'node:child_process';
const args=process.argv.slice(2); args.splice(7,0,'--import',${JSON.stringify(preload)});
const child=spawn('/usr/bin/flock',args,{stdio:'inherit'});
process.on('SIGTERM',()=>child.kill('SIGTERM')); process.on('SIGINT',()=>child.kill('SIGINT'));
child.on('exit',code=>{process.exitCode=code??1;});
`, { mode: 0o700 });
  const restore = installNativeAppFixture(executable, scenario);
  t.after(() => { restore(); });
  return {
    root, executable, native: restore.observation,
    async update(change: (world: World) => void) {
      const world = JSON.parse(await readFile(worldFile, 'utf8')) as World;
      change(world);
      await writeFile(worldFile, JSON.stringify(world));
    },
    async trace(): Promise<TraceEntry[]> {
      return (await readFile(traceFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as TraceEntry);
    },
  };
}
export const worldScope = { repository: 'acme/project', installationId: 2, workflows: false, label: 'ready-for-agent', base: 'main' };

/** GitHub timeline events as returned by REST for issue timelines. */
export function crossReferenced(pullNumber: number, repository = 'acme/project') {
  return { event: 'cross-referenced', source: { type: 'issue', issue: { id: 9000 + pullNumber, number: pullNumber,
    html_url: `https://github.com/${repository}/pull/${pullNumber}`, pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${pullNumber}` } } } };
}
export function connected(pullNumber?: number, event: 'connected' | 'disconnected' = 'connected') {
  return pullNumber === undefined ? { event } : { ...crossReferenced(pullNumber), event };
}
