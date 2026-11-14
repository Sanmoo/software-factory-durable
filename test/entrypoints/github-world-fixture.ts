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
  faults?: Record<string, { status: number; headers?: Record<string, string> }>;
  /** Make every successful operational response report an exhausted rate limit until reset. */
  exhaustRateLimit?: boolean;
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
let body, status = 200, headers = '';
const trace = { method, endpoint, credential: app ? 'app-jwt' : 'installation' };
const url = new URL(endpoint, 'https://api.github.com');
const path = url.pathname.replace(/^\\/repositories\\/3(?=\\/|$)/, '/repos/acme/project').toLowerCase(); // GitHub names are case-insensitive
function page(items) {
  const size = world.pageSize ?? 100;
  const number = Number(url.searchParams.get('page') ?? '1');
  if (url.searchParams.get('per_page') !== '100') process.exit(15);
  const slice = items.slice((number - 1) * size, number * size);
  if (number * size < items.length) {
    const next = new URL('https://api.github.com/repositories/3' + path.slice('/repos/acme/project'.length));
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(number + 1));
    headers += 'link: <' + next.href + '>; rel="next"\\r\\n';
  }
  return slice;
}
if (endpoint === '/app' && method === 'GET') body = { id: 1 };
else if (endpoint === '/app/installations/2' && method === 'GET') body = { id: 2, app_id: 1, account: { login: 'acme' }, suspended_at: null, permissions: ceiling };
else if (endpoint === '/app/installations/2/access_tokens' && method === 'POST') {
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  if (Object.keys(request).sort().join() !== 'permissions,repositories' || JSON.stringify(request.repositories.map(name => name.toLowerCase())) !== '["project"]') process.exit(10);
  for (const [name, level] of Object.entries(request.permissions)) if (!ceiling[name] || (level === 'write' && ceiling[name] !== 'write')) process.exit(10);
  trace.permissions = request.permissions;
  const sequence = readFileSync(${JSON.stringify(traceFile)}, 'utf8').split('\\n').filter(line => line.includes('access_tokens')).length + 1;
  body = { token: 'synthetic-installation-secret-' + sequence, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: request.permissions,
    repositories: [{ id: 3, full_name: 'acme/project', owner: { login: 'acme' } }] };
  status = 201;
} else if (method !== 'GET') process.exit(16);
else if (path === '/repos/acme/project') body = { id: 3, full_name: 'acme/project', owner: { login: 'acme' } };
else if (path === '/repos/acme/project/issues') {
  const state = url.searchParams.get('state'); const label = url.searchParams.get('labels');
  body = page(world.issues.filter(i => (!state || state === 'all' || i.state === state) &&
    (!label || i.labels.some(l => l.name.toLowerCase() === label.toLowerCase()))).map(i => ({ ...i, repository_url: 'https://api.github.com/repos/acme/project', html_url: 'https://github.com/acme/project/issues/' + i.number })));
} else if (/^\\/repos\\/acme\\/project\\/issues\\/\\d+\\/timeline$/.test(path)) {
  const found = world.issues.find(i => i.number === Number(path.split('/').at(-2)));
  if (found) body = page(found.timeline ?? []);
  else { status = 404; body = { message: 'Not Found' }; }
} else if (/^\\/repos\\/acme\\/project\\/issues\\/\\d+$/.test(path)) {
  const found = world.issues.find(i => i.number === Number(path.split('/').at(-1)));
  if (found) body = { ...found, repository_url: 'https://api.github.com/repos/acme/project', html_url: 'https://github.com/acme/project/issues/' + found.number };
  else { status = 404; body = { message: 'Not Found' }; }
} else if (path === '/repos/acme/project/pulls') {
  if (url.searchParams.get('state') !== 'all') process.exit(17);
  body = page(world.pulls.map(p => ({ ...p, html_url: 'https://github.com/acme/project/pull/' + p.number, base: { repo: { id: 3 } } })));
} else process.exit(11);
for (const [fragment, fault] of Object.entries(world.faults ?? {})) if (endpoint.includes(fragment) && !app) {
  status = fault.status; body = { message: 'synthetic-installation-secret-leak' };
  for (const [name, value] of Object.entries(fault.headers ?? {})) headers += name + ': ' + value + '\\r\\n';
}
if (world.exhaustRateLimit && !app && status === 200) headers += 'x-ratelimit-remaining: 0\\r\\nx-ratelimit-reset: ' + (Math.floor(Date.now() / 1000) + 600) + '\\r\\n';
appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace) + '\\n');
process.stdout.write('HTTP/2.0 ' + status + ' Test\\r\\nx-github-api-version-selected: 2026-03-10\\r\\n' + headers + '\\r\\n' + JSON.stringify(body));
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
