// Synthetic GitHub boundary for ticket 17 adapter tests: a local executable stands in for gh/GitHub (and, through installNativeAppFixture,
// for the App HTTPS endpoints). Never used with real credentials, never connects to a network, and is NOT evidence of the real boundary.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNativeAppFixture } from './native-app-fixture.js';

export type DeliveryPull = { id: number; node_id: string; number: number; state: 'open' | 'closed'; draft: boolean; merged: boolean; merged_at: string | null;
  merge_commit_sha: string | null; head: { ref: string; sha: string; repo: { id: number } | null }; base: { ref: string; repo: { id: number } | null } };
export type DeliveryWorld = {
  pulls: DeliveryPull[];
  /** Branch → tip of `refs/heads/<branch>` on the synthetic remote. */
  refs: Record<string, string>;
  defaultBranch?: string;
  /** Status the DELETE answers (default 204, and the ref is deleted only for 204 unless `deleteAnyway`). */
  deleteStatus?: number; deleteAnyway?: boolean;
  /** The atomic delete deletes the ref and then the transport dies (no answer): outcome unknown to the caller. */
  deleteTransportLost?: boolean;
  /** GraphQL `updateRefs` is not in the schema for this token (field unavailable). */
  graphqlUnavailable?: boolean;
  /** A human push lands right before the atomic delete is evaluated (race): the ref moves to this tip. */
  raceTip?: string;
  /** Endpoint substrings whose GET fails with this status. */
  faults?: Record<string, number>;
};
export type DeliveryTrace = { method: string; endpoint: string; permissions?: Record<string, string>; token?: string; body?: string };

export const ownSha = 'a'.repeat(40);
export const mergeSha = 'b'.repeat(40);
export function ownPull(overrides: Partial<DeliveryPull> = {}): DeliveryPull {
  return { id: 9042, node_id: 'PR_own42', number: 42, state: 'closed', draft: false, merged: true, merged_at: '2026-11-14T12:00:00Z', merge_commit_sha: mergeSha,
    head: { ref: 'factory/3-abcdef12', sha: ownSha, repo: { id: 3 } }, base: { ref: 'main', repo: { id: 3 } }, ...overrides };
}

export async function deliveryWorld(t: { after(fn: () => Promise<void> | void): void }, initial: DeliveryWorld) {
  const root = await mkdtemp(join(tmpdir(), 'factory-gh-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  await mkdir(join(root, 'run'), { mode: 0o700 });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(join(root, 'credentials/app.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const worldFile = join(root, 'world.json');
  const traceFile = join(root, 'trace.jsonl');
  const revokedFile = join(root, 'revoked.jsonl');
  await writeFile(worldFile, JSON.stringify(initial));
  await writeFile(traceFile, '');
  await writeFile(revokedFile, '');
  const executable = join(root, 'gh');
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const endpoint = args.at(-1);
const method = args[args.indexOf('--method') + 1];
const token = process.env.GH_TOKEN ?? '';
const app = token.split('.').length === 3;
if (args[0] !== 'api' || !args.includes('--include') || !args.includes('X-GitHub-Api-Version: 2026-03-10')) process.exit(9);
if (app !== endpoint.startsWith('/app') || (app && process.env.NATIVE_FIXTURE !== '1')) process.exit(13);
const world = JSON.parse(readFileSync(${JSON.stringify(worldFile)}, 'utf8'));
const trace = { method, endpoint };
const revoked = readFileSync(${JSON.stringify(revokedFile)}, 'utf8').split('\\n').filter(Boolean);
let status = 200, body = null, raw;
const ceiling = { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' };
const url = new URL(endpoint, 'https://api.github.com');
const path = url.pathname.replace(/^\\/repositories\\/3(?=\\/|$)/, '/repos/acme/project');
const rest = path.startsWith('/repos/acme/project') ? path.slice('/repos/acme/project'.length) : null;
if (!app && revoked.includes(token)) { status = 401; body = { message: 'Bad credentials' }; }
else if (endpoint === '/app' && method === 'GET') body = { id: 1 };
else if (endpoint === '/app/installations/2' && method === 'GET') body = { id: 2, app_id: 1, account: { login: 'acme' }, suspended_at: null, permissions: ceiling };
else if (endpoint === '/app/installations/2/access_tokens' && method === 'POST') {
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  if (JSON.stringify(request.repositories) !== '["project"]') process.exit(10);
  trace.permissions = request.permissions;
  const sequence = readFileSync(${JSON.stringify(traceFile)}, 'utf8').split('\\n').filter(line => line.includes('access_tokens')).length + 1;
  body = { token: 'synthetic-installation-secret-' + sequence, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: request.permissions,
    repositories: [{ id: 3, full_name: 'acme/project', owner: { login: 'acme' } }] };
  status = 201;
} else if (endpoint === '/installation/token' && method === 'DELETE') { status = 204; raw = ''; appendFileSync(${JSON.stringify(revokedFile)}, token + '\\n'); trace.token = token; }
else if (path === '/graphql' && method === 'POST') {
  if (!token.startsWith('synthetic-installation-secret-') || args[args.indexOf('--input') + 1] !== '-') process.exit(13);
  let input = ''; for await (const data of process.stdin) input += data;
  const request = JSON.parse(input);
  const update = request.variables?.refUpdates?.[0];
  if (!/mutation[\\s\\S]*updateRefs/.test(request.query) || request.variables.repositoryId !== 'R_3' || request.variables.refUpdates.length !== 1 ||
    update.afterOid !== '0'.repeat(40) || update.force !== false || !/^refs\\/heads\\//.test(update.name)) process.exit(21);
  trace.body = JSON.stringify(request.variables);
  const branch = update.name.slice('refs/heads/'.length);
  if (world.raceTip) world.refs[branch] = world.raceTip;
  if (world.graphqlUnavailable) body = { errors: [{ extensions: { code: 'undefinedField', fieldName: 'updateRefs' }, message: "Field 'updateRefs' doesn't exist on type 'Mutation'" }] };
  else if (world.refs[branch] !== update.beforeOid) body = { data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', message: 'A ref was not at its expected beforeOid' }] };
  else { delete world.refs[branch]; body = { data: { updateRefs: { clientMutationId: null } } }; }
  writeFileSync(${JSON.stringify(worldFile)}, JSON.stringify(world));
  if (world.deleteTransportLost) { appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace) + '\\n'); process.exit(2); }
  appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace) + '\\n');
  // GraphQL answers carry no REST API-version header.
  process.stdout.write('HTTP/2.0 200 Test\\r\\ncontent-type: application/json\\r\\n\\r\\n' + JSON.stringify(body));
  process.exit(0);
} else if (rest === null) process.exit(11);
else if (Object.entries(world.faults ?? {}).some(([fragment]) => endpoint.includes(fragment)) && method === 'GET') {
  status = Object.entries(world.faults).find(([fragment]) => endpoint.includes(fragment))[1]; body = { message: 'synthetic-installation-secret-leak' };
} else if (rest === '' && method === 'GET') body = { id: 3, node_id: 'R_3', full_name: 'acme/project', owner: { login: 'acme' }, default_branch: world.defaultBranch ?? 'main' };
else if (/^\\/pulls\\/\\d+$/.test(rest) && method === 'GET') {
  const found = world.pulls.find(p => p.number === Number(rest.split('/')[2]));
  if (found) body = { ...found, html_url: 'https://github.com/acme/project/pull/' + found.number }; else { status = 404; body = { message: 'Not Found' }; }
} else if (rest === '/pulls' && method === 'GET') {
  if (url.searchParams.get('state') !== 'open' || url.searchParams.get('per_page') !== '100') process.exit(17);
  const head = url.searchParams.get('head'); const base = url.searchParams.get('base');
  body = world.pulls.filter(p => p.state === 'open' && (!head || 'acme:' + p.head.ref === head) && (!base || p.base.ref === base)).map(p => ({ ...p, html_url: 'https://github.com/acme/project/pull/' + p.number }));
} else if (rest.startsWith('/git/matching-refs/heads/') && method === 'GET') {
  const prefix = decodeURIComponent(rest.slice('/git/matching-refs/heads/'.length));
  body = Object.entries(world.refs).filter(([name]) => name.startsWith(prefix)).map(([name, sha]) => ({ ref: 'refs/heads/' + name, object: { sha, type: 'commit' } }));
} else if (rest.startsWith('/git/refs/heads/') && method === 'DELETE') {
  if (!token.startsWith('synthetic-installation-secret-')) process.exit(13);
  const branch = decodeURIComponent(rest.slice('/git/refs/heads/'.length));
  status = world.deleteStatus ?? (branch in world.refs ? 204 : 422); raw = status === 204 ? '' : undefined; body = { message: 'Reference does not exist' };
  if ((status === 204 || world.deleteAnyway || world.deleteTransportLost) && branch in world.refs) { delete world.refs[branch]; writeFileSync(${JSON.stringify(worldFile)}, JSON.stringify(world)); }
  if (world.deleteTransportLost) { appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace) + '\\n'); process.exit(2); }
} else process.exit(16);
appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace) + '\\n');
process.stdout.write('HTTP/2.0 ' + status + ' Test\\r\\nx-github-api-version-selected: 2026-03-10\\r\\n\\r\\n' + (raw ?? JSON.stringify(body)));
process.exit(status >= 200 && status < 300 ? 0 : 1);
`, { mode: 0o700 });
  const restore = installNativeAppFixture(executable, 'delivery');
  t.after(() => { restore(); });
  return {
    root, executable,
    async world(): Promise<DeliveryWorld> { return JSON.parse(await readFile(worldFile, 'utf8')) as DeliveryWorld; },
    async update(change: (world: DeliveryWorld) => void) {
      const world = JSON.parse(await readFile(worldFile, 'utf8')) as DeliveryWorld;
      change(world);
      await writeFile(worldFile, JSON.stringify(world));
    },
    async revoked(): Promise<string[]> { return (await readFile(revokedFile, 'utf8')).split('\n').filter(Boolean); },
    async trace(): Promise<DeliveryTrace[]> { return (await readFile(traceFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as DeliveryTrace); },
  };
}
export const deliveryScope = { repository: 'acme/project', installationId: 2, workflows: false };
