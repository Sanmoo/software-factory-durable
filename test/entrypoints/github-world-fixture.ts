// Synthetic GitHub boundary for admission tests: a local executable stands in for gh/GitHub
// (and, through installNativeAppFixture, for the App HTTPS endpoints). Never used with real
// credentials, never connects to a network, and is not evidence of the real GitHub boundary.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installNativeAppFixture } from './native-app-fixture.js';

export type WorldIssue = {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: { id: number; name: string }[];
  user: { id: number; login: string; type: string };
  pull_request?: object;
  /** Served as is (ticket 53: moved by every comment; the Factory never reads it). */
  updated_at?: string;
  comments?: number;
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
  /** Literal issue_dependencies_summary (overrides the computed one). */
  summary?: object;
  /** Raw extra entries appended to the blocked_by listing (invalid relation payloads). */
  raw_blocked_by?: object[];
};
export type WorldPull = {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: { ref: string; sha?: string; repo: { id: number } | null };
  user: { id: number; login: string; type: string };
  /** Ticket 14 (defaults: not draft, base main, head sha 'c'*40). */
  draft?: boolean;
  base?: { ref: string };
};
/** Issue comment as GitHub REST returns it (html_url/performed_via_github_app computed by the fixture when absent). */
export type WorldComment = {
  id: number;
  issue: number;
  repository?: string;
  node_id?: string;
  body: string | null;
  user: { id: number; login: string; type: string };
  created_at?: string;
  updated_at?: string;
  performed_via_github_app?: { id: number } | null;
  /** Spec #68 ticket #74: GitHub's association of the author with the repository (absent in the payload when not given). */
  author_association?: string;
  html_url?: string;
};
/** Ticket 44: the `.factory/environment.yaml` every fixture repository serves unless `environmentFiles` says otherwise. */
export const defaultEnvironmentFile = 'schemaVersion: 1\napk:\n  - name: openjdk25-jdk\n    version: 25.0.5.1_p2-r0\n';
export type World = {
  /** Ticket 44: `.factory/environment.yaml` content per repository name (null = absent: 404); default `defaultEnvironmentFile`. */
  environmentFiles?: Record<string, string | null>;
  issues: WorldIssue[];
  /** Issue comments served at /issues/{n}/comments (GET paginated, POST appends one created by the App bot). */
  comments?: WorldComment[];
  /** POST /issues/{n}/comments: answer with this status; `created` decides whether the comment was created anyway (ambiguous 5xx). */
  postFault?: { status: number; created: boolean; headers?: Record<string, string> };
  /** Spec #68 ticket #77: the label and closing writes answer with this status; `applied` decides whether the change happened anyway. */
  triageFault?: { status: number; applied: boolean };
  /** Status of DELETE /installation/token (default 204). */
  revokeFault?: number;
  pulls: WorldPull[];
  /** Ticket 14: branch tips of acme/project (`refs/heads/<name>` → commit sha), served at /git/matching-refs/heads/<prefix>.
   * POST /git/refs (contents:write) adds one; POST /pulls (pull_requests:write) creates a pull request authored by the App bot. */
  refs?: Record<string, string>;
  /** v2 ticket 12: loss marker refs of acme/project (FULL name `refs/factory/lost/<work>/<boot>` → sha), served at
   * /git/matching-refs/factory/<prefix> and deletable by the same atomic `updateRefs` as a branch. */
  factoryRefs?: Record<string, string>;
  /** POST /pulls: answer with this status; `created` decides whether the pull request was created anyway (ambiguous 5xx). */
  pullFault?: { status: number; created: boolean };
  /** Ticket 14: tags of acme/project (name → sha) served at /git/matching-refs/tags. */
  tags?: Record<string, string>;
  /** Ticket 14: rules applying to a branch (/rules/branches/<b>), rulesets by id (/rulesets/<id>) and classic protection (/branches/<b>/protection; absent = 404). */
  /** Ticket 21 review: push activity by ref (`refs/heads/x`), served at GET /activity?ref=. */
  activity?: Record<string, object[]>;
  branchRules?: Record<string, { type: string; ruleset_id?: number }[]>;
  rulesets?: Record<string, { enforcement: string; current_user_can_bypass?: string }>;
  classicProtection?: Record<string, object>;
  /** Ticket 14: the App slug served by GET /app (default factory-app) and whether its bot user exists. */
  appSlug?: string;
  pageSize?: number;
  /** endpoint substring → synthetic failure. */
  faults?: Record<string, { status: number; headers?: Record<string, string>; /** Raw (possibly non-JSON) body. */ body?: string }>;
  /** Make every successful operational response report an exhausted rate limit until reset. */
  exhaustRateLimit?: boolean;
  /** Repositories and their App installations (default: acme/project id 3, installation 2). Owner = installation account. */
  repositories?: { name: string; id: number; installation: number }[];
  /** Synthetic clock offset (seconds) of the fake GitHub, so tests that mock the controller Date see consistent token expiries. */
  clockOffsetSeconds?: number;
  /** Lifetime (seconds) of issued installation tokens (default 3600, like GitHub). */
  tokenLifetimeSeconds?: number;
  /** Endpoint substrings whose request fails at the transport (no response at all: outcome unknown to the caller). */
  transportFailures?: string[];
  /** Ticket 15: required-checks world of acme/project (read-only GET endpoints). */
  checks?: ChecksWorld;
  /** Ticket 16: POST graphql (draft mutations): answer with this status / GraphQL `errors`; `applied` decides whether the flag changed anyway;
   * `nodeId` reports another node in a success payload. */
  graphqlFault?: { status: number; errors?: object[]; applied: boolean; nodeId?: string };
};
/**
 * Ticket 15 (read-only): `GET /pulls/{n}` (the `pulls` entry + `details`), `GET /branches/{b}` (`branches`), `GET /branches/{b}/protection/
 * required_status_checks` (`requiredStatusChecks`, absent = 404), `GET /rules/branches/{b}` (`rules`, paginated), `GET /commits/{sha}/check-runs`
 * (`checkRuns`, paginated object pages with `total_count`), `GET /commits/{sha}/statuses` (`statuses`, paginated) and `GET /compare/{a}...{b}`.
 */
export type ChecksWorld = {
  /** Absent for a pull request: it is served as it is in `pulls` (head sha, base ref, draft). */
  details?: Record<
    number,
    {
      head_sha: string;
      base_ref?: string | undefined;
      base_sha?: string;
      draft?: boolean | undefined;
      merged?: boolean;
      mergeable?: boolean | null;
      mergeable_state?: string;
      merge_commit_sha?: string | null;
      /** From the `afterReads`-th read of this pull request on, it reports this head (a push during the collection). */
      change?: { afterReads: number; head_sha: string };
    }
  >;
  branches?: Record<string, { sha: string; protected: boolean; protection?: object }>;
  requiredStatusChecks?: Record<string, object>;
  rules?: Record<string, object[]>;
  /** From the `afterReads`-th read of a branch's rules on, these rules are served (a ruleset change during the collection). */
  rulesChange?: { afterReads: number; rules: Record<string, object[]> };
  checkRuns?: Record<string, object[]>;
  /** Added to the reported total_count of check-run pages (a listing GitHub truncated or that changed between pages). */
  checkRunsTotalOffset?: number;
  statuses?: Record<string, object[]>;
  /** Ticket 21: also the commit/file lists of a divergence comparison (`total_commits`, `commits`, `files`). */
  compare?: Record<string, { status: string; ahead_by: number; behind_by: number } & Record<string, unknown>>;
  /** Internal counter of pull request reads (written by the fixture). */
  reads?: Record<string, number>;
};
/** A check run as GitHub REST returns it (ticket 15 fixtures). */
export function checkRun(id: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    head_sha: 'd'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    started_at: `2026-11-14T10:${String(id % 60).padStart(2, '0')}:00Z`,
    completed_at: '2026-11-14T11:00:00Z',
    app: { id: 15368, slug: 'github-actions' },
    check_suite: { id: 500 },
    html_url: `https://github.com/acme/project/runs/${id}`,
    ...overrides,
  };
}
/** A commit status as GitHub REST returns it (ticket 15 fixtures). */
export function commitStatus(id: number, context: string, state: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    context,
    state,
    creator: { id: 77, login: 'ci-bot[bot]', type: 'Bot' },
    created_at: `2026-11-14T10:${String(id % 60).padStart(2, '0')}:00Z`,
    updated_at: '2026-11-14T10:59:00Z',
    target_url: `https://ci.example/${id}`,
    ...overrides,
  };
}
/** `sequence`: the issuance number of an access_tokens POST; `grant`: the issuance number of the installation token a request used. */
export type TraceEntry = {
  method: string;
  endpoint: string;
  credential: 'app-jwt' | 'installation';
  permissions?: Record<string, string>;
  body?: string;
  /** Spec #68 ticket #77: the JSON body of a label or closing write. */
  request?: object;
  sequence?: number;
  grant?: number;
};

export function issue(number: number, overrides: Partial<WorldIssue> = {}): WorldIssue {
  return {
    id: 7000 + number,
    node_id: `I_node${number}`,
    number,
    title: `Ticket ${number}`,
    body: `SPEC-BODY-${number} must never be captured`,
    state: 'open',
    state_reason: null,
    labels: [{ id: 55, name: 'ready-for-agent' }],
    user: { id: 9, login: 'human', type: 'User' },
    ...overrides,
  };
}
export function pull(number: number, overrides: Partial<WorldPull> = {}): WorldPull {
  return {
    id: 9000 + number,
    node_id: `PR_node${number}`,
    number,
    title: `Change ${number}`,
    body: null,
    state: 'open',
    merged_at: null,
    head: { ref: `human/change-${number}`, repo: { id: 3 } },
    user: { id: 10, login: 'someone', type: 'User' },
    ...overrides,
  };
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
  const issuedFile = join(root, 'issued.jsonl');
  const revokedFile = join(root, 'revoked.jsonl');
  const executable = join(root, 'gh');
  // Every read-modify-write of world.json (each gh request, and the test's update) runs under this lock, and every write is an
  // atomic rename: otherwise a gh process that read the world before the test's update and saved after it loses the update
  // (observed: the operator's /factory answer vanished under load and the journey waited forever). App (JWT) requests only read
  // the world and are issued by the in-process native fixture through spawnSync, so they never wait for the lock (no deadlock
  // with an update that holds it across the event loop).
  const worldLock = join(root, 'world.lock');
  const standIn = join(root, 'gh-world-stand-in');
  await writeFile(
    executable,
    `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const run = process.env.NATIVE_FIXTURE === '1' ? [process.execPath, ${JSON.stringify(standIn)}, ...args]
  : ['/usr/bin/flock', '--exclusive', ${JSON.stringify(worldLock)}, process.execPath, ${JSON.stringify(standIn)}, ...args];
const result = spawnSync(run[0], run.slice(1), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  await writeFile(
    standIn,
    `#!${process.execPath}
  import { readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
  const saveWorld = value => { const temporary = ${JSON.stringify(worldFile)} + '.' + process.pid; writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, ${JSON.stringify(worldFile)}); };
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
  const now = Date.now() + (world.clockOffsetSeconds ?? 0) * 1000;
  if ((world.transportFailures ?? []).some(fragment => endpoint.includes(fragment))) process.exit(2);
  // Installation tokens stop working once revoked (DELETE /installation/token) or expired, as on GitHub.
  const lines = file => { try { return readFileSync(file, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const issuedFile = ${JSON.stringify(issuedFile)};
  const revokedFile = ${JSON.stringify(revokedFile)};
  const known = lines(issuedFile).find(entry => entry.token === token);
  if (!app && token && (lines(revokedFile).some(entry => entry.token === token) || (known && Date.parse(known.expiresAt) <= now))) {
  process.stdout.write('HTTP/2.0 401 Test\\r\\nx-github-api-version-selected: 2026-03-10\\r\\n\\r\\n{"message":"Bad credentials"}');
  appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ method, endpoint, credential: 'installation', status: 401 }) + '\\n');
  process.exit(1);
  }
  const ceiling = { metadata: 'read', issues: 'write', contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read', administration: 'read' };
  const repositories = world.repositories ?? [{ name: 'acme/project', id: 3, installation: 2 }];
  const repoByName = name => repositories.find(r => r.name.toLowerCase() === String(name).toLowerCase());
  let body, raw, status = 200, headers = '';
  const trace = { method, endpoint, credential: app ? 'app-jwt' : 'installation', ...(!app && token ? { grant: Number(token.split('-')[3]) } : {}) };
  let graphqlErrors = false;
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
  // Spec #68 ticket #77: the writes of a Triage publication (a label added or removed by relative operation, the closing of an issue).
  const triageWrite = (method === 'POST' && /^\\/issues\\/\\d+\\/labels$/.test(rest)) || (method === 'DELETE' && /^\\/issues\\/\\d+\\/labels\\/[^/]+$/.test(rest)) || (method === 'PATCH' && /^\\/issues\\/\\d+$/.test(rest));
  const issuesOf = r => world.issues.filter(i => (i.repository ?? 'acme/project').toLowerCase() === r.name.toLowerCase());
  const shape = i => {
  const r = repoByName(i.repository ?? 'acme/project');
  const { repository, blocked_by, hidden_blocked_by, no_summary, raw_blocked_by, timeline, summary: literal, ...plain } = i;
  const targets = (blocked_by ?? []).map(edge => world.issues.find(t => t.number === edge.number && (t.repository ?? 'acme/project').toLowerCase() === (edge.repository ?? 'acme/project').toLowerCase())).filter(Boolean);
  const summary = { blocked_by: targets.filter(t => t.state === 'open').length + (hidden_blocked_by ?? 0), blocking: 0,
    total_blocked_by: targets.length + (hidden_blocked_by ?? 0), total_blocking: 0 };
  return { ...plain, repository_url: 'https://api.github.com/repos/' + r.name, html_url: 'https://github.com/' + r.name + '/issues/' + i.number,
    ...(no_summary ? {} : { issue_dependencies_summary: literal ?? summary }) };
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
  if (endpoint === '/app' && method === 'GET') body = { id: 1, slug: world.appSlug ?? 'factory-app' };
  else if (!app && method === 'GET' && /^\\/users\\/[^/]+$/.test(url.pathname)) {
    const login = decodeURIComponent(url.pathname.slice(7));
    if (login === (world.appSlug ?? 'factory-app') + '[bot]') body = { login, id: 41898282, type: 'Bot' };
    else { status = 404; body = { message: 'Not Found' }; }
  }
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
  trace.sequence = sequence;
  body = { token: 'synthetic-installation-secret-' + sequence + '-r' + target.id, expires_at: new Date(now + (world.tokenLifetimeSeconds ?? 3600) * 1000).toISOString(), permissions: request.permissions,
    repositories: [{ id: target.id, full_name: target.name, owner: { login: target.name.split('/')[0] } }] };
  appendFileSync(issuedFile, JSON.stringify({ token: body.token, expiresAt: body.expires_at, permissions: request.permissions }) + '\\n');
  status = 201;
  } else if (endpoint === '/installation/token' && method === 'DELETE' && !app) {
  // Self-revocation of the installation token used for the request: 204, no body; the token is invalid afterwards (a fault prevents it).
  status = world.revokeFault ?? 204; raw = '';
  if (status === 204 && !Object.keys(world.faults ?? {}).some(fragment => endpoint.includes(fragment))) appendFileSync(revokedFile, JSON.stringify({ token }) + '\\n');
  } else if (endpoint === 'graphql' && method === 'POST' && !app) {
  // Ticket 16: the two draft mutations of a pull request of the token's repository, nothing else (any other GraphQL document exits 22).
  if (args[args.indexOf('--input') + 1] !== '-') process.exit(19);
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  trace.body = input;
  const field = /^mutation\\(\\$id: ID!, \\$cid: String\\) \\{ (markPullRequestReadyForReview|convertPullRequestToDraft)\\(input: \\{pullRequestId: \\$id, clientMutationId: \\$cid\\}\\) \\{ clientMutationId pullRequest \\{ id number isDraft headRefOid \\} \\} \\}$/.exec(request.query ?? '')?.[1];
  if (!field || Object.keys(request).sort().join() !== 'query,variables' || Object.keys(request.variables ?? {}).sort().join() !== 'cid,id') process.exit(22);
  const target = world.pulls.find(p => p.node_id === request.variables.id && token.split('-').at(-1) === 'r3');
  const granted = known?.permissions ?? {};
  const fault = world.graphqlFault;
  const draft = field === 'convertPullRequestToDraft';
  const apply = () => { target.draft = draft; const detail = world.checks?.details?.[target.number]; if (detail) detail.draft = draft; saveWorld(world); };
  if (!target) { graphqlErrors = true; body = { data: { [field]: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] }; }
  else if (granted.pull_requests !== 'write') { graphqlErrors = true; body = { data: { [field]: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }; }
  else if (fault) {
    if (fault.applied) apply();
    status = fault.status;
    if (fault.errors) { graphqlErrors = true; body = { data: { [field]: null }, errors: fault.errors }; }
    else body = status === 200 ? { data: { [field]: { clientMutationId: request.variables.cid, pullRequest: { id: fault.nodeId ?? target.node_id, number: target.number, isDraft: draft, headRefOid: target.head.sha ?? 'c'.repeat(40) } } } } : { message: 'synthetic' };
  } else { apply(); body = { data: { [field]: { clientMutationId: request.variables.cid, pullRequest: { id: target.node_id, number: target.number, isDraft: draft, headRefOid: target.head.sha ?? 'c'.repeat(40) } } } }; }
  } else if (endpoint === '/graphql' && method === 'POST' && !app) {
  // Ticket 17 (journey, ticket 18): the atomic conditional deletion of ONE branch ref (updateRefs, beforeOid, afterOid zero, no force) of the
  // token's repository under a contents:write grant; any other document exits 23. A ref not at beforeOid changes nothing (GitHub semantics).
  if (args[args.indexOf('--input') + 1] !== '-') process.exit(19);
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  trace.body = input;
  const update = request.variables?.refUpdates?.[0];
  if (!/^mutation\\(\\$repositoryId: ID!, \\$refUpdates: \\[RefUpdate!\\]!\\) \\{ updateRefs\\(/.test(request.query ?? '') || request.variables.refUpdates.length !== 1 ||
    update.afterOid !== '0'.repeat(40) || update.force !== false || !/^refs\\/(heads\\/.|factory\\/lost\\/[0-9a-f-]{36}\\/boot-[0-9a-f-]{36}$)/.test(update.name)) process.exit(23);
  const target = repositories.find(r => 'R_' + r.id === request.variables.repositoryId && token.split('-').at(-1) === 'r' + r.id);
  const granted = known?.permissions ?? {};
  const marker = update.name.startsWith('refs/factory/');
  const branch = marker ? update.name : update.name.slice(11);
  const refs = (marker ? world.factoryRefs : world.refs) ?? {};
  if (!target) { graphqlErrors = true; body = { data: { updateRefs: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] }; }
  else if (granted.contents !== 'write') { graphqlErrors = true; body = { data: { updateRefs: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }; }
  else if (refs[branch] !== update.beforeOid) { graphqlErrors = true; body = { data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', message: 'A ref was not at its expected beforeOid' }] }; }
  else { delete refs[branch]; if (marker) world.factoryRefs = refs; else world.refs = refs; saveWorld(world); body = { data: { updateRefs: { clientMutationId: null } } }; }
  } else if (app || (method !== 'GET' && !(method === 'POST' && /^\\/repos\\/[^/]+\\/[^/]+\\/(issues\\/\\d+\\/comments|git\\/refs|pulls)$/.test(path)) && !triageWrite)) process.exit(16);
  else if (!repo) process.exit(11);
  else if (rest === '') body = { id: repo.id, node_id: 'R_' + repo.id, full_name: repo.name, default_branch: 'main', owner: { login: repo.name.split('/')[0] } };
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
  } else if (/^\\/issues\\/\\d+\\/comments$/.test(rest) && method === 'POST') {
  if (args[args.indexOf('--input') + 1] !== '-') process.exit(19);
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  const number = Number(rest.split('/')[2]);
  if (Object.keys(request).join() !== 'body' || typeof request.body !== 'string' || !issuesOf(repo).some(i => i.number === number)) process.exit(20);
  const fault = world.postFault;
  const created = !fault || fault.created;
  const comments = world.comments ?? [];
  const at = new Date().toISOString(); // one instant: a new comment is never edited (#61)
  const comment = { id: 60000 + comments.length + 1, issue: number, repository: repo.name, node_id: 'IC_' + (comments.length + 1), body: request.body,
    user: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, performed_via_github_app: { id: 1 }, created_at: at, updated_at: at };
  if (created) { world.comments = [...comments, comment]; saveWorld(world); }
  trace.body = request.body;
  if (fault) { status = fault.status; body = { message: 'synthetic-installation-secret-leak' }; for (const [name, value] of Object.entries(fault.headers ?? {})) headers += name + ': ' + value + '\\r\\n'; }
  else { status = 201; body = { ...comment, html_url: 'https://github.com/' + repo.name + '/issues/' + number + '#issuecomment-' + comment.id }; }
  } else if (triageWrite) {
  const known = lines(issuedFile).find(entry => entry.token === token);
  const found = issuesOf(repo).find(i => i.number === Number(rest.split('/')[2]));
  let request;
  if (method !== 'DELETE') { if (args[args.indexOf('--input') + 1] !== '-') process.exit(19); let input = ''; for await (const data of process.stdin) input += data; request = JSON.parse(input); trace.request = request; }
  const fault = world.triageFault;
  const name = method === 'DELETE' ? decodeURIComponent(url.pathname.split('/labels/')[1]) : undefined;
  const event = extra => ({ id: 70000 + (found.timeline ?? []).length + 1, created_at: new Date().toISOString(), actor: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, performed_via_github_app: { id: 1 }, ...extra });
  if (known?.permissions?.issues !== 'write') { status = 403; body = { message: 'Resource not accessible by integration' }; }
  else if (!found || (name !== undefined && !found.labels.some(l => l.name.toLowerCase() === name.toLowerCase()))) { status = 404; body = { message: 'Not Found' }; }
  else {
    if (method === 'POST' && (Object.keys(request).join() !== 'labels' || request.labels.length !== 1 || typeof request.labels[0] !== 'string')) process.exit(20);
    if (method === 'PATCH' && (Object.keys(request).sort().join() !== 'state,state_reason' || request.state !== 'closed' || request.state_reason !== 'not_planned')) process.exit(20);
    if (!fault || fault.applied) {
      if (method === 'POST') { if (!found.labels.some(l => l.name.toLowerCase() === request.labels[0].toLowerCase())) found.labels = [...found.labels, { id: 800 + found.labels.length, name: request.labels[0] }]; found.timeline = [...(found.timeline ?? []), event({ event: 'labeled', label: { name: request.labels[0] } })]; }
      else if (method === 'DELETE') { found.labels = found.labels.filter(l => l.name.toLowerCase() !== name.toLowerCase()); found.timeline = [...(found.timeline ?? []), event({ event: 'unlabeled', label: { name } })]; }
      else { found.state = 'closed'; found.state_reason = 'not_planned'; found.timeline = [...(found.timeline ?? []), event({ event: 'closed' })]; }
      saveWorld(world);
    }
    if (fault) { status = fault.status; body = { message: 'synthetic' }; }
    else body = method === 'PATCH' ? shape(found) : found.labels;
  }
  } else if ((rest === '/git/refs' || rest === '/pulls') && method === 'POST') {
  // Ticket 14: the Builder's direct publication (push = ref creation, PR creation) with ITS delivered grant; permissions are enforced.
  if (args[args.indexOf('--input') + 1] !== '-') process.exit(19);
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  const granted = known?.permissions ?? {};
  trace.body = input;
  const refs = world.refs ?? {};
  if (rest === '/git/refs') {
    if (granted.contents !== 'write') { status = 403; body = { message: 'Resource not accessible by integration' }; }
    else if (Object.keys(request).sort().join() !== 'ref,sha' || !/^refs\\/heads\\//.test(request.ref) || !/^[0-9a-f]{40}$/.test(request.sha)) process.exit(20);
    else if (refs[request.ref.slice(11)] !== undefined) { status = 422; body = { message: 'Reference already exists' }; }
    else { refs[request.ref.slice(11)] = request.sha; world.refs = refs; saveWorld(world);
      status = 201; body = { ref: request.ref, object: { sha: request.sha, type: 'commit' } }; }
  } else if (granted.pull_requests !== 'write') { status = 403; body = { message: 'Resource not accessible by integration' }; }
  else if (refs[request.head] === undefined) { status = 422; body = { message: 'Validation Failed: head does not exist' }; }
  else {
    const number = Math.max(0, ...world.pulls.map(p => p.number), ...world.issues.map(i => i.number)) + 1;
    const created = { id: 9000 + number, node_id: 'PR_node' + number, number, title: request.title, body: request.body ?? null, state: 'open', merged_at: null, draft: request.draft === true,
      head: { ref: request.head, sha: refs[request.head], repo: { id: repo.id } }, base: { ref: request.base }, user: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' } };
    const fault = world.pullFault;
    if (!fault || fault.created) { world.pulls = [...world.pulls, created]; saveWorld(world); }
    if (fault) { status = fault.status; body = { message: 'synthetic' }; }
    else { status = 201; body = { ...created, html_url: 'https://github.com/' + repo.name + '/pull/' + number }; }
  }
  } else if (method !== 'GET') process.exit(16);
  else if (/^\\/git\\/matching-refs\\/factory(\\/.*)?$/.test(rest)) {
  const prefix = 'refs/' + decodeURIComponent(url.pathname.split('/git/matching-refs/')[1]);
  body = page(Object.entries(world.factoryRefs ?? {}).filter(([name]) => name.startsWith(prefix)).sort()
    .map(([name, sha]) => ({ ref: name, node_id: 'REF_' + name, object: { sha, type: 'commit' } })));
  } else if (/^\\/git\\/matching-refs\\/(heads|tags)(\\/.*)?$/.test(rest)) {
  const [kind, ...parts] = url.pathname.split('/git/matching-refs/')[1].split('/');
  const prefix = decodeURIComponent(parts.join('/'));
  const source = kind === 'heads' ? { main: 'b'.repeat(40), ...(world.refs ?? {}) } : (world.tags ?? {});
  body = page(Object.entries(source).filter(([name]) => name.startsWith(prefix)).sort()
    .map(([name, sha]) => ({ ref: 'refs/' + kind + '/' + name, node_id: 'REF_' + name, object: { sha, type: 'commit' } })));
  } else if (/^\\/rules\\/branches\\/.+$/.test(rest) && !world.checks) {
  body = page((world.branchRules ?? {})[decodeURIComponent(url.pathname.split('/rules/branches/')[1])] ?? []);
  } else if (/^\\/rulesets\\/\\d+$/.test(rest)) {
  const found = (world.rulesets ?? {})[rest.split('/')[2]];
  if (found) body = { id: Number(rest.split('/')[2]), ...found }; else { status = 404; body = { message: 'Not Found' }; }
  } else if (/^\\/branches\\/.+\\/protection$/.test(rest)) {
  const found = (world.classicProtection ?? {})[decodeURIComponent(url.pathname.split('/branches/')[1].replace(/\\/protection$/, ''))];
  if (found) body = found; else { status = 404; body = { message: 'Branch not protected' }; }
  }
  else if (/^\\/issues\\/\\d+\\/comments$/.test(rest)) {
  const number = Number(rest.split('/')[2]);
  if (!issuesOf(repo).some(i => i.number === number)) { status = 404; body = { message: 'Not Found' }; }
  else body = page((world.comments ?? []).filter(c => c.issue === number && (c.repository ?? 'acme/project').toLowerCase() === repo.name.toLowerCase())
    .map(({ issue: _issue, repository: _repository, ...c }) => ({ node_id: 'IC_' + c.id, created_at: '2026-11-14T10:00:00Z', updated_at: '2026-11-14T10:00:00Z', performed_via_github_app: null,
      html_url: 'https://github.com/' + repo.name + '/issues/' + number + '#issuecomment-' + c.id, ...c })));
  } else if (world.checks && /^\\/(pulls\\/\\d+|branches\\/.+|rules\\/branches\\/.+|commits\\/[0-9a-f]{40}\\/(check-runs|statuses)|compare\\/[0-9a-f]{40}\\.\\.\\.[0-9a-f]{40})$/.test(rest) && repo.id === 3) {
  // Ticket 15 read-only required-checks world.
  const checks = world.checks;
  const notFound = () => { status = 404; body = { message: 'Not Found' }; };
  if (/^\\/pulls\\/\\d+$/.test(rest)) {
    const number = Number(rest.split('/')[2]);
    const found = world.pulls.find(p => p.number === number);
    // Without an explicit detail, the pull request as it is (e.g. the one the Builder created through POST /pulls, ticket 14).
    const detail = checks.details?.[number] ?? (found ? { head_sha: found.head.sha ?? 'c'.repeat(40), base_ref: found.base?.ref, draft: found.draft } : undefined);
    if (!found || !detail) notFound();
    else {
      const reads = (checks.reads ??= {})[number] = (checks.reads[number] ?? 0) + 1;
      saveWorld(world);
      const head = detail.change && reads >= detail.change.afterReads ? detail.change.head_sha : detail.head_sha;
      body = { ...found, html_url: 'https://github.com/acme/project/pull/' + number, draft: detail.draft ?? true, merged: detail.merged ?? Boolean(found.merged_at),
        mergeable: detail.mergeable === undefined ? true : detail.mergeable, mergeable_state: detail.mergeable_state ?? 'clean', merge_commit_sha: detail.merge_commit_sha ?? 'e'.repeat(40),
        head: { ...found.head, sha: head }, base: { ref: detail.base_ref ?? 'main', sha: detail.base_sha ?? 'a'.repeat(40), repo: { id: 3 } } };
    }
  } else if (/^\\/rules\\/branches\\/.+$/.test(rest)) {
    const name = decodeURIComponent(url.pathname.split('/rules/branches/')[1]);
    const reads = (checks.reads ??= {})['rules:' + name] = (checks.reads['rules:' + name] ?? 0) + (url.searchParams.get('page') === '1' ? 1 : 0);
    saveWorld(world);
    body = page((checks.rulesChange && reads >= checks.rulesChange.afterReads ? checks.rulesChange.rules : checks.rules ?? world.branchRules)?.[name] ?? []);
  } else if (/^\\/branches\\/.+\\/protection\\/required_status_checks$/.test(rest)) {
    const name = decodeURIComponent(url.pathname.split('/branches/')[1].replace(/\\/protection\\/required_status_checks$/, ''));
    if (checks.requiredStatusChecks?.[name]) body = checks.requiredStatusChecks[name]; else notFound();
  } else if (/^\\/branches\\/.+$/.test(rest)) {
    const name = decodeURIComponent(url.pathname.split('/branches/')[1]);
    const branch = checks.branches?.[name];
    if (branch) body = { name, commit: { sha: branch.sha }, protected: branch.protected, ...(branch.protection ? { protection: branch.protection } : {}) }; else notFound();
  } else if (/\\/check-runs$/.test(rest)) {
    if (url.searchParams.get('filter') !== 'all') process.exit(21);
    const runs = checks.checkRuns?.[rest.split('/')[2]] ?? [];
    body = { total_count: runs.length + (checks.checkRunsTotalOffset ?? 0), check_runs: page(runs) };
  } else if (/\\/statuses$/.test(rest)) body = page(checks.statuses?.[rest.split('/')[2]] ?? []);
  else {
    const compared = checks.compare?.[rest.slice('/compare/'.length)];
    if (compared) body = compared; else notFound();
  }
  } else if (rest === '/contents/.factory/environment.yaml') {
  // Ticket 44: the repository's environment declaration at ?ref=<commit> (default: a valid JDK 25 declaration; null = absent, 404).
  const files = world.environmentFiles ?? {};
  const text = Object.hasOwn(files, repo.name) ? files[repo.name] : ${JSON.stringify(defaultEnvironmentFile)};
  if (!/^[0-9a-f]{40}$/.test(url.searchParams.get('ref') ?? '')) process.exit(21);
  if (text === null) { status = 404; body = { message: 'Not Found' }; }
  else { const bytes = Buffer.from(text, 'utf8'); body = { type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length, path: '.factory/environment.yaml', sha: 'f'.repeat(40) }; }
} else if (/^\\/issues\\/\\d+$/.test(rest)) {
  const found = issuesOf(repo).find(i => i.number === Number(rest.split('/')[2]));
  if (found) body = shape(found);
  else { status = 404; body = { message: 'Not Found' }; }
  } else if (rest === '/activity' && repo.id === 3) {
  // Ticket 21 review: push activity of a branch (none recorded by this fixture unless given).
  body = page((world.activity ?? {})[url.searchParams.get('ref') ?? ''] ?? []);
  } else if (rest === '/pulls' && repo.id === 3) {
  const state = url.searchParams.get('state');
  const headFilter = url.searchParams.get('head'), baseFilter = url.searchParams.get('base');
  // Ticket 17: open pull requests by head (owner:branch) or base, as the branch cleanup revalidation lists them.
  if (state !== 'all' && !(state === 'open' && (headFilter || baseFilter))) process.exit(17);
  body = page(world.pulls.filter(p => state === 'all' || (p.state === 'open' && (!headFilter || 'acme:' + p.head.ref === headFilter) &&
    (!baseFilter || (p.base?.ref ?? 'main') === baseFilter))).map(p => ({ draft: false, ...p, head: { sha: 'c'.repeat(40), ...p.head }, html_url: 'https://github.com/acme/project/pull/' + p.number,
    base: { ref: p.base?.ref ?? 'main', repo: { id: 3 } } })));
  } else process.exit(11);
  for (const [fragment, fault] of Object.entries(world.faults ?? {})) if (endpoint.includes(fragment) && !app) {
  status = fault.status; body = { message: 'synthetic-installation-secret-leak' }; if (fault.body !== undefined) raw = fault.body;
  for (const [name, value] of Object.entries(fault.headers ?? {})) headers += name + ': ' + value + '\\r\\n';
  }
  if (world.exhaustRateLimit && !app && status === 200) headers += 'x-ratelimit-remaining: 0\\r\\nx-ratelimit-reset: ' + (Math.floor(Date.now() / 1000) + 600) + '\\r\\n';
  appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace) + '\\n');
  process.stdout.write('HTTP/2.0 ' + status + ' Test\\r\\nx-github-api-version-selected: 2026-03-10\\r\\n' + headers + '\\r\\n' + (raw ?? JSON.stringify(body)));
  process.exit(status >= 200 && status < 300 && !graphqlErrors ? 0 : 1);
  `,
    { mode: 0o700 },
  );
  const preload = join(root, 'native-fixture.mjs');
  await writeFile(
    preload,
    `import { installNativeAppFixture } from ${JSON.stringify(pathToFileURL(resolve('dist/test/entrypoints/native-app-fixture.js')).href)}; installNativeAppFixture(${JSON.stringify(executable)}, ${JSON.stringify(scenario)});`,
  );
  await writeFile(
    join(root, 'flock'),
    `#!${process.execPath}
import { spawn } from 'node:child_process';
const args=process.argv.slice(2); args.splice(7,0,'--import',${JSON.stringify(preload)});
const child=spawn('/usr/bin/flock',args,{stdio:'inherit'});
process.on('SIGTERM',()=>child.kill('SIGTERM')); process.on('SIGINT',()=>child.kill('SIGINT'));
child.on('exit',code=>{process.exitCode=code??1;});
`,
    { mode: 0o700 },
  );
  const restore = installNativeAppFixture(executable, scenario);
  t.after(() => {
    restore();
  });
  return {
    root,
    executable,
    native: restore.observation,
    async update(change: (world: World) => void) {
      await underWorldLock(worldLock, () => {
        const world = JSON.parse(readFileSync(worldFile, 'utf8')) as World;
        change(world);
        const temporary = `${worldFile}.update`;
        writeFileSync(temporary, JSON.stringify(world));
        renameSync(temporary, worldFile);
      });
    },
    /** Tokens revoked through DELETE /installation/token (synthetic values only). */
    async revoked(): Promise<string[]> {
      try {
        return (await readFile(revokedFile, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(line => (JSON.parse(line) as { token: string }).token);
      } catch {
        return [];
      }
    },
    async trace(): Promise<TraceEntry[]> {
      return (await readFile(traceFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as TraceEntry);
    },
  };
}
export const worldScope = { repository: 'acme/project', installationId: 2, workflows: false, label: 'ready-for-agent', base: 'main' };

/** GitHub timeline events as returned by REST for issue timelines. */
export function crossReferenced(pullNumber: number, repository = 'acme/project') {
  return {
    event: 'cross-referenced',
    source: {
      type: 'issue',
      issue: {
        id: 9000 + pullNumber,
        number: pullNumber,
        html_url: `https://github.com/${repository}/pull/${pullNumber}`,
        pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${pullNumber}` },
      },
    },
  };
}
export function connected(pullNumber?: number, event: 'connected' | 'disconnected' = 'connected') {
  return pullNumber === undefined ? { event } : { ...crossReferenced(pullNumber), event };
}

/** Runs `critical` (synchronous) while holding the world's flock, coordinated by events: the holder reports the lock, then holds it until its stdin closes. */
async function underWorldLock(lock: string, critical: () => void): Promise<void> {
  const holder = spawn('/usr/bin/flock', ['--exclusive', lock, '/bin/sh', '-c', 'echo locked; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<number | null>(resolve => holder.once('exit', code => resolve(code)));
  const acquired = await new Promise<boolean>(resolve => {
    holder.stdout.once('data', (data: Buffer) => resolve(data.toString().startsWith('locked')));
    holder.once('exit', () => resolve(false));
    holder.once('error', () => resolve(false));
  });
  if (!acquired) throw new Error('WORLD_LOCK_UNAVAILABLE');
  try {
    critical();
  } finally {
    holder.stdin.end();
    await exited;
  }
}
