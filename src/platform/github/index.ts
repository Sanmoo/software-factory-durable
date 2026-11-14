import https from 'node:https';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, mkdtemp, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { sign } from 'node:crypto';
import { z } from 'zod';
import type { AccessDiagnostic, BuilderCredentials, GitHubScope, RepositoryFetchCredentials } from '../../contracts/index.js';

const version = '2026-03-10';
const permissions = {
  tracker: { metadata: 'read', issues: 'write' },
  repository: { metadata: 'read', contents: 'read', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read', administration: 'read' },
  // Reduced polling/admission purposes: read-only, narrower than the diagnostic ceilings above.
  'tracker-read': { metadata: 'read', issues: 'read' },
  'repository-read': { metadata: 'read', pull_requests: 'read' },
  // Issue timeline (GitHub-native PR association) is an issues endpoint: issues:read, no pull request or write access.
  'association-read': { metadata: 'read', issues: 'read' },
  // Native blocked_by traversal (spec §4.2): issue + dependency reads only, in executable AND dependency-only repositories.
  'dependency-read': { metadata: 'read', issues: 'read' },
  // Preflight of a repository accessible only for dependency reads: never the tracker ceiling (issues:write).
  dependency: { metadata: 'read', issues: 'read' },
  // Initial Builder grant of ticket 09 (spec §8 ceiling Contents W/PR W is NOT needed before publication, ticket 14): read the Ticket and
  // repository sources of ITS repository only. Never Workflows, never another repository.
  'builder-start': { metadata: 'read', contents: 'read', issues: 'read' },
  // Host fetch into the Factory-exclusive bare cache (spec §8: clone/fetch uses Contents R).
  'repository-fetch': { metadata: 'read', contents: 'read' },
} as const;
type Purpose = keyof typeof permissions;
type DiagnosticPurpose = 'tracker' | 'repository' | 'dependency';
export type ReadPurpose = 'tracker-read' | 'repository-read' | 'association-read' | 'dependency-read';
/** Token-free metadata of each reduced read grant (principal/scope evidence; never the token). */
export const readPermissions: Readonly<Record<ReadPurpose, Readonly<Record<string, 'read'>>>> = {
  'tracker-read': permissions['tracker-read'], 'repository-read': permissions['repository-read'],
  'association-read': permissions['association-read'], 'dependency-read': permissions['dependency-read'] };
const repositorySchema = z.object({ id: z.number().int().positive().safe(), full_name: z.string(), owner: z.object({ login: z.string() }) });
const permissionSchema = z.record(z.string(), z.enum(['read', 'write']));
class AccessFailure extends Error {
  constructor(readonly code: string, readonly waitSeconds?: number, readonly nextStep?: string) { super(code); }
}
class TokenIssuanceFailure extends AccessFailure {
  constructor(readonly outcome: 'known-rejected' | 'unknown', code: string, waitSeconds?: number) {
    super(code, waitSeconds, outcome === 'unknown' ? 'Token issuance outcome is unknown. Do not repeat POST automatically; operator must reconcile the possible live grant and expiry before a deliberate new issuance.' : undefined);
  }
}
export class InvalidGitHubObservation extends Error {
  constructor() { super('INVALID_GITHUB_PAYLOAD'); }
}
/** An access check that could not verify the capability it exists for: reported blocked/incomplete, never ok. */
export class UnverifiedGitHubAccess extends AccessFailure {
  constructor(code: string, nextStep: string) { super(code, undefined, nextStep); }
}
export interface GitHubSession {
  repositoryId: number;
  get(endpoint: string): Promise<unknown>;
  /** Complete listing of every Link page, or a failure; never a partial array. Query parameters other than paging are preserved. */
  list(endpoint: string): Promise<unknown[]>;
}
/** Read outcome for controller polling: an observation or a typed failure, never a fabricated empty result. */
export type GitHubRead<T> = { ok: true; observedAt: string; repositoryId: number; value: T } |
  { ok: false; observedAt: string; code: string; waitSeconds?: number; nextStep: string };
export interface GitHubAccess {
  diagnose(scope: GitHubScope, purpose: DiagnosticPurpose, inspect: (session: GitHubSession) => Promise<void | string[]>): Promise<AccessDiagnostic>;
  /** GET-only reads under a reduced in-memory grant reused until near expiry; honours rate-limit windows without sending requests. */
  read<T>(scope: GitHubScope, purpose: ReadPurpose, inspect: (session: GitHubSession) => Promise<T>): Promise<GitHubRead<T>>;
  /** One NEW reduced grant whose token leaves this module transiently (Builder delivery or host cache fetch). Never cached or retried;
   * an unknown issuance outcome throws GITHUB_TOKEN_ISSUANCE_UNKNOWN. The token is registered for filtering before it is returned. */
  transient(scope: GitHubScope, purpose: TransientPurpose): Promise<TransientGrant>;
}
export type TransientPurpose = 'builder-start' | 'repository-fetch';
export type TransientGrant = { token: string; expiresAt: string; repositoryId: number; permissions: Readonly<Record<string, 'read' | 'write'>> };
/** Coded failure of a transient issuance; message is the code only (never a token or key). */
export class CredentialIssuanceError extends Error {
  constructor(readonly code: string, readonly outcome: 'known-rejected' | 'unknown', readonly nextStep: string) { super(code); }
}

const unknownIssuanceStep = 'Token issuance outcome is unknown. Do not repeat POST automatically; operator must reconcile the possible live grant and expiry before a deliberate new issuance (controller restart).';
type Grant = { token: string; expiresAt: string; expiry: number; repositoryId: number };

/** Controller composition only. No discovery, I/O or credential access occurs on import/construction. */
export function createGitHubAccess(options: { root: string; appId: number; privateKeyFile: string; executable?: string }): GitHubAccess {
  const secrets = new Set<string>();
  const filter = (text: string) => {
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  };
  // In-memory only: reduced grants per repository/purpose, unknown-issuance latches, and rate-limit windows per installation.
  const grants = new Map<string, Grant>();
  const unknownIssuance = new Set<string>();
  const rateWindows = new Map<number, number>();
  const rateLimit = (scope: GitHubScope, waitSeconds: number) => {
    const until = Date.now() + waitSeconds * 1000;
    rateWindows.set(scope.installationId, Math.max(rateWindows.get(scope.installationId) ?? 0, until));
  };

  function validate(scope: GitHubScope) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(scope.repository) ||
      scope.repository.split('/').some(part => part === '.' || part === '..') ||
      !Number.isSafeInteger(scope.installationId) || scope.installationId <= 0 || typeof scope.workflows !== 'boolean' ||
      !Number.isSafeInteger(options.appId) || options.appId <= 0 ||
      !/^credentials\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(options.privateKeyFile) ||
      (options.executable !== undefined && !isAbsolute(options.executable))) throw new AccessFailure('INVALID_ACCESS_CONFIGURATION');
  }

  function parseResponse(scope: GitHubScope, output: { stdout: string; failed: boolean }, endpoint: string, repositoryId?: number): { body: unknown; next?: string } {
    const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(output.stdout);
    if (!match) throw new AccessFailure('INVALID_GITHUB_RESPONSE');
    const status = Number(match[1]);
    const headers = new Map<string, string>();
    for (const line of match[2]!.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator <= 0) throw new AccessFailure('INVALID_GITHUB_HEADERS');
      const name = line.slice(0, separator).toLowerCase();
      if (headers.has(name)) throw new AccessFailure('INVALID_GITHUB_HEADERS');
      headers.set(name, line.slice(separator + 1).trim());
    }
    const retry = headers.get('retry-after');
    const exhausted = headers.get('x-ratelimit-remaining') === '0';
    const reset = headers.get('x-ratelimit-reset');
    const resetWait = reset && /^\d+$/.test(reset) ? Math.max(1, Number(reset) - Math.floor(Date.now() / 1000)) : undefined;
    if (status === 429 || ((status === 403) && (retry !== undefined || exhausted))) {
      // Retry-After is delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
      const retryDate = retry && !/^\d+$/.test(retry) ? Date.parse(retry) : NaN;
      const wait = retry && /^\d+$/.test(retry) ? Number(retry) : Number.isFinite(retryDate) ? Math.ceil((retryDate - Date.now()) / 1000) : resetWait ?? 60;
      throw new AccessFailure('GITHUB_RATE_LIMITED', Math.min(Math.max(wait, 1), 86400));
    }
    if (status === 401 || status === 403 || status === 404) throw new AccessFailure(status === 404 ? 'GITHUB_NOT_FOUND_OR_HIDDEN' : 'GITHUB_ACCESS_DENIED');
    if (output.failed || status < 200 || status >= 300) throw new AccessFailure('GITHUB_QUERY_FAILED');
    if (headers.get('x-github-api-version-selected') !== version) throw new AccessFailure('GITHUB_API_VERSION_MISMATCH');
    // A successful response that exhausts the quota defers the NEXT request; this one is still valid.
    if (exhausted && repositoryId !== undefined) rateLimit(scope, Math.min(resetWait ?? 60, 86400));
    let body: unknown;
    try { body = JSON.parse(match[3]!); } catch { throw new AccessFailure('INVALID_GITHUB_PAYLOAD'); }
    // Register a returned grant before validation or any subsequent use.
    if (body && typeof body === 'object' && 'token' in body && typeof body.token === 'string' && body.token) secrets.add(body.token);
    const link = headers.get('link');
    let next: string | undefined;
    if (link) {
      const current = new URL(endpoint, 'https://api.github.com');
      const prefix = `/repos/${scope.repository}`;
      // GitHub may address the same repository by numeric id in Link headers.
      const suffix = (pathname: string) => pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length)
        : repositoryId !== undefined && pathname.startsWith(`/repositories/${repositoryId}/`) ? pathname.slice(`/repositories/${repositoryId}`.length) : undefined;
      for (const entry of link.split(',')) {
        const parsed = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(entry);
        if (!parsed) throw new AccessFailure('INVALID_PAGINATION');
        const url = new URL(parsed[1]!);
        const fixed = [...current.searchParams.entries()].filter(([name]) => name !== 'page' && name !== 'per_page');
        const pathSuffix = suffix(url.pathname);
        if (url.origin !== 'https://api.github.com' || pathSuffix === undefined || pathSuffix !== suffix(current.pathname) || url.username || url.password || url.hash ||
          [...url.searchParams.keys()].some(name => !['page', 'per_page', ...fixed.map(([key]) => key)].includes(name)) ||
          fixed.some(([key, value]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) ||
          !/^\d+$/.test(url.searchParams.get('page') ?? '') || url.searchParams.get('per_page') !== '100') throw new AccessFailure('INVALID_PAGINATION');
        if (parsed[2] === 'next') {
          if (next) throw new AccessFailure('INVALID_PAGINATION');
          next = url.pathname + url.search;
        }
      }
    }
    return { body, ...(next ? { next } : {}) };
  }

  async function gh(scope: GitHubScope, directory: string, token: string, endpoint: string, repositoryId?: number): Promise<{ body: unknown; next?: string }> {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//') || /[\r\n#\\]/.test(endpoint)) throw new AccessFailure('INVALID_ENDPOINT');
    const argv = ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', `X-GitHub-Api-Version: ${version}`,
      '--', endpoint];
    const output = await new Promise<{ stdout: string; failed: boolean }>((resolve, reject) => {
      const child = execFile(options.executable ?? 'gh', argv, { cwd: directory, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, shell: false,
        env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C', GH_TOKEN: token, GH_HOST: 'github.com', GH_CONFIG_DIR: directory,
          HOME: directory, XDG_CONFIG_HOME: directory, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } },
      (error, stdout) => {
        if (error && (!stdout || !('code' in error) || typeof error.code !== 'number')) { reject(new AccessFailure('GITHUB_TRANSPORT_UNAVAILABLE')); return; }
        resolve({ stdout, failed: Boolean(error) });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    });
    return parseResponse(scope, output, endpoint, repositoryId);
  }

  /** Reads the protected key, verifies App/installation/permissions and issues one reduced grant. Throws typed failures. */
  async function issue(scope: GitHubScope, purpose: Purpose): Promise<Grant> {
    validate(scope);
    for (const path of [options.root, join(options.root, 'credentials'), join(options.root, 'run')]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new AccessFailure('UNSAFE_CREDENTIAL_PATH');
    }
    // O_NOFOLLOW plus descriptor checks prevent following a replaced key symlink.
    const file = await open(join(options.root, options.privateKeyFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let key: string;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.nlink !== 1 || info.size > 65536) throw new AccessFailure('UNSAFE_CREDENTIAL_FILE');
      key = await file.readFile('utf8');
      if (!key) throw new AccessFailure('INVALID_APP_KEY');
      secrets.add(key);
    } finally { await file.close(); }
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(options.appId) })).toString('base64url')}`;
    const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
    secrets.add(jwt);
    // Only this closed operation set may carry the App JWT. No caller supplies a URL.
    async function appRequest(operation: 'identity' | 'installation' | 'issue', input?: unknown): Promise<{ body: unknown; next?: string }> {
      const issuing = operation === 'issue';
      const endpoint = operation === 'identity' ? '/app' : `/app/installations/${scope.installationId}${issuing ? '/access_tokens' : ''}`;
      let knownRejected = false;
      try {
        const output = await new Promise<{ stdout: string; failed: boolean }>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout>;
          const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new AccessFailure('GITHUB_TRANSPORT_UNAVAILABLE')); } };
          const payload = input === undefined ? undefined : JSON.stringify(input);
          const req = https.request({ protocol: 'https:', hostname: 'api.github.com', port: 443,
            method: issuing ? 'POST' : 'GET', path: endpoint, rejectUnauthorized: true, agent: false, maxHeaderSize: 16384,
            headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': version, 'User-Agent': 'software-factory-controller',
              ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) } }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('error', fail);
            response.on('aborted', fail);
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) { fail(); req.destroy(); return; }
              chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              if (!response.complete || !response.statusCode || response.rawHeaders.length % 2) { fail(); return; }
              const headers: string[] = [];
              const names = new Set<string>();
              let contentType: string | undefined;
              for (let i = 0; i < response.rawHeaders.length; i += 2) {
                const name = response.rawHeaders[i]!.toLowerCase(), value = response.rawHeaders[i + 1]!;
                if (!/^[a-z0-9-]+$/.test(name) || /[\r\n]/.test(value) || names.has(name)) { fail(); return; }
                names.add(name); headers.push(`${name}: ${value}`);
                if (name === 'content-type') contentType = value;
              }
              if (contentType === undefined || !/^application\/json(?:;|$)/i.test(contentType)) { fail(); return; }
              knownRejected = response.statusCode >= 400 && response.statusCode < 500;
              settled = true; clearTimeout(timer);
              resolve({ stdout: `HTTP/1.1 ${response.statusCode} Response\r\n${headers.join('\r\n')}\r\n\r\n${Buffer.concat(chunks).toString('utf8')}`, failed: false });
            });
          });
          req.on('error', fail);
          timer = setTimeout(() => { fail(); req.destroy(); }, 15000);
          req.end(payload);
        });
        const status = Number(/^HTTP\/1\.1 (\d{3}) /.exec(output.stdout)?.[1]);
        if (status >= 200 && status < 300 && status !== (issuing ? 201 : 200)) throw new AccessFailure('GITHUB_QUERY_FAILED');
        return parseResponse(scope, output, endpoint);
      } catch (error) {
        if (issuing) throw new TokenIssuanceFailure(knownRejected ? 'known-rejected' : 'unknown', knownRejected && error instanceof AccessFailure ? error.code : 'GITHUB_TOKEN_ISSUANCE_UNKNOWN', knownRejected && error instanceof AccessFailure ? error.waitSeconds : undefined);
        throw error instanceof AccessFailure ? error : new AccessFailure('GITHUB_TRANSPORT_UNAVAILABLE');
      }
    }
    const app = z.object({ id: z.literal(options.appId) }).safeParse((await appRequest('identity')).body);
    if (!app.success) throw new AccessFailure('APP_IDENTITY_MISMATCH');
    const installation = z.object({ id: z.literal(scope.installationId), app_id: z.literal(options.appId), account: z.object({ login: z.string() }),
      suspended_at: z.null(), permissions: permissionSchema }).safeParse((await appRequest('installation')).body);
    const [owner, name] = scope.repository.split('/');
    if (!installation.success || installation.data.account.login.toLowerCase() !== owner!.toLowerCase()) throw new AccessFailure('INSTALLATION_IDENTITY_MISMATCH');
    const required = permissions[purpose];
    const missing = Object.entries(required).filter(([permission, level]) => {
      const installed = installation.data.permissions[permission];
      return !installed || (level === 'write' && installed !== 'write');
    });
    if (missing.length) throw new AccessFailure('INSUFFICIENT_APP_PERMISSIONS', undefined,
      `Operator must provide only the missing minimum installation permissions for ${purpose}: ${missing.map(([permission, level]) => `${permission}:${level}`).join(', ')}. Do not widen Workflows or retry issuance before correction.`);
    if (scope.workflows && installation.data.permissions.workflows !== 'write') throw new AccessFailure('WORKFLOWS_PERMISSION_MISSING');
    for (const permission of ['checks', 'statuses', 'actions', 'administration', 'secrets', 'environments', 'deployments']) {
      if (installation.data.permissions[permission] === 'write') throw new AccessFailure('UNSAFE_APP_PERMISSIONS');
    }
    // Installation tokens are opaque RFC 6750 token68, not an alphanumeric identifier.
    const issued = z.object({ token: z.string().min(1).max(1024).regex(/^[a-zA-Z0-9._~+/-]+=*$/), expires_at: z.iso.datetime(), permissions: permissionSchema, repositories: z.array(repositorySchema) })
      .safeParse((await appRequest('issue', { repositories: [name], permissions: required })).body);
    if (!issued.success) throw new AccessFailure('INVALID_CREDENTIAL_GRANT');
    const grant = issued.data;
    const expiry = Date.parse(grant.expires_at);
    if (expiry <= Date.now() + 30000 || expiry > Date.now() + 3660000 || JSON.stringify(Object.entries(grant.permissions).sort()) !== JSON.stringify(Object.entries(required).sort()) ||
      grant.repositories.length !== 1 || grant.repositories[0]!.full_name.toLowerCase() !== scope.repository.toLowerCase() || grant.repositories[0]!.owner.login.toLowerCase() !== owner!.toLowerCase()) throw new AccessFailure('CREDENTIAL_SCOPE_MISMATCH');
    return { token: grant.token, expiresAt: grant.expires_at, expiry, repositoryId: grant.repositories[0]!.id };
  }

  function session(scope: GitHubScope, directory: string, grant: Grant): GitHubSession {
    const allowed = (endpoint: string) => endpoint === `/repos/${scope.repository}` || endpoint.startsWith(`/repos/${scope.repository}/`) ||
      endpoint.startsWith(`/repositories/${grant.repositoryId}/`);
    return { repositoryId: grant.repositoryId, async get(endpoint) {
      if (!allowed(endpoint)) throw new AccessFailure('CREDENTIAL_SCOPE_MISMATCH');
      return (await gh(scope, directory, grant.token, endpoint, grant.repositoryId)).body;
    }, async list(endpoint) {
      const values: unknown[] = [];
      const seen = new Set<string>();
      const first = new URL(endpoint, 'https://api.github.com');
      if (first.searchParams.has('page') || first.searchParams.has('per_page')) throw new AccessFailure('INVALID_ENDPOINT');
      first.searchParams.set('per_page', '100');
      first.searchParams.set('page', '1');
      let page: string | undefined = first.pathname + first.search;
      while (page) {
        if (!allowed(page) || seen.has(page) || seen.size >= 100) throw new AccessFailure('INCOMPLETE_GITHUB_QUERY');
        seen.add(page);
        const response = await gh(scope, directory, grant.token, page, grant.repositoryId);
        if (!Array.isArray(response.body)) throw new AccessFailure('INVALID_GITHUB_PAYLOAD');
        values.push(...response.body);
        page = response.next;
      }
      return values;
    } };
  }

  async function verifyRepository(scope: GitHubScope, client: GitHubSession) {
    const [owner] = scope.repository.split('/');
    const repo = repositorySchema.safeParse(await client.get(`/repos/${scope.repository}`));
    if (!repo.success || repo.data.id !== client.repositoryId || repo.data.full_name.toLowerCase() !== scope.repository.toLowerCase() || repo.data.owner.login.toLowerCase() !== owner!.toLowerCase()) throw new AccessFailure('REPOSITORY_IDENTITY_MISMATCH');
  }

  const failure = (error: unknown) => ({
    code: error instanceof AccessFailure ? error.code : error instanceof InvalidGitHubObservation ? 'INVALID_GITHUB_PAYLOAD' : 'GITHUB_DIAGNOSTIC_FAILED',
    ...(error instanceof AccessFailure && error.waitSeconds !== undefined ? { waitSeconds: error.waitSeconds } : {}),
    nextStep: error instanceof AccessFailure && error.nextStep ? error.nextStep : error instanceof AccessFailure && error.code === 'GITHUB_RATE_LIMITED' ? 'Wait the reported seconds before retrying this repository/purpose; no automatic retry.' : 'Operator must verify the named repository, App/installation, private key, explicit Workflows setting, permissions and REST compatibility; no personal fallback or repair.',
  });

  return { async transient(scope, purpose) {
    try {
      const grant = await issue(scope, purpose);
      return { token: grant.token, expiresAt: grant.expiresAt, repositoryId: grant.repositoryId, permissions: permissions[purpose] };
    } catch (error) {
      const typed = failure(error);
      throw new CredentialIssuanceError(error instanceof TokenIssuanceFailure && error.outcome === 'unknown' ? 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' : typed.code,
        error instanceof TokenIssuanceFailure && error.outcome === 'unknown' ? 'unknown' : 'known-rejected', filter(typed.nextStep));
    }
  }, async diagnose(scope, purpose, inspect) {
    let directory: string | undefined;
    const observedAt = new Date().toISOString();
    const result = (report: Omit<AccessDiagnostic, 'observedAt' | 'repository' | 'certifiesMergeSafety' | 'source' | 'purpose'>): AccessDiagnostic =>
      JSON.parse(filter(JSON.stringify({ ...report, observedAt, repository: scope.repository, source: 'github-rest', purpose, certifiesMergeSafety: false })));
    try {
      const grant = await issue(scope, purpose);
      directory = await mkdtemp(join(options.root, 'run', 'github-'));
      const client = session(scope, directory, grant);
      await verifyRepository(scope, client);
      const limitations = await inspect(client);
      return result({ limitations: ['Reads are not an atomic remote snapshot.', 'Write operations are not exercised; authorization is checked against returned permissions.', ...(limitations ?? [])], workflows: scope.workflows, status: 'ok', code: 'OPERATIONAL_ACCESS_VERIFIED', completeness: 'complete',
        identity: { appId: options.appId, installationId: scope.installationId, repositoryId: grant.repositoryId },
        grant: { role: 'controller', purpose, permissions: permissions[purpose], expiresAt: grant.expiresAt },
        nextStep: 'Operational reads and declared permissions only; no remote write, merge/base/CI certification or invisible-capability proof.' });
    } catch (error) {
      return result({ status: 'blocked', completeness: 'incomplete', ...failure(error) });
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }, async read(scope, purpose, inspect) {
    let directory: string | undefined;
    const observedAt = new Date().toISOString();
    const key = `${scope.installationId}\n${scope.repository.toLowerCase()}\n${purpose}`;
    const sanitized = <R>(value: R): R => JSON.parse(filter(JSON.stringify(value))) as R;
    if (unknownIssuance.has(key)) return sanitized({ ok: false as const, observedAt, code: 'GITHUB_TOKEN_ISSUANCE_UNKNOWN', nextStep: unknownIssuanceStep });
    const window = rateWindows.get(scope.installationId) ?? 0;
    if (window > Date.now()) return sanitized({ ok: false as const, observedAt, code: 'GITHUB_RATE_LIMITED', waitSeconds: Math.max(1, Math.ceil((window - Date.now()) / 1000)),
      nextStep: 'Rate-limit window reported by GitHub is still open; no request was sent. Polling resumes after it.' });
    try {
      let grant = grants.get(key);
      const fresh = !grant || grant.expiry - Date.now() < 300000;
      if (fresh) {
        grants.delete(key);
        try { grant = await issue(scope, purpose); } catch (error) {
          if (error instanceof TokenIssuanceFailure && error.outcome === 'unknown') unknownIssuance.add(key);
          throw error;
        }
      }
      directory = await mkdtemp(join(options.root, 'run', 'github-'));
      const client = session(scope, directory, grant!);
      if (fresh) await verifyRepository(scope, client);
      grants.set(key, grant!);
      const value = await inspect(client);
      return sanitized({ ok: true as const, observedAt, repositoryId: grant!.repositoryId, value });
    } catch (error) {
      if (error instanceof AccessFailure && error.code === 'GITHUB_ACCESS_DENIED') grants.delete(key);
      if (error instanceof AccessFailure && error.code === 'GITHUB_RATE_LIMITED' && error.waitSeconds !== undefined) rateLimit(scope, error.waitSeconds);
      const typed = failure(error);
      return sanitized({ ok: false as const, observedAt, ...typed, code: typed.code === 'GITHUB_DIAGNOSTIC_FAILED' ? 'GITHUB_READ_FAILED' : typed.code });
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  } };
}

/**
 * Builder credential projection (spec §8.1): issues for the Work's OWN configured repository only, with the fixed initial purpose; the
 * caller cannot request permissions. Revocation is not implemented before the active credential lifecycle (ticket 20): it is reported as
 * not attempted, never as revoked; the grant expires at `expiresAt` (<= 1 h).
 */
export function createBuilderCredentials(options: { github: GitHubAccess; repositories: readonly GitHubScope[] }): BuilderCredentials {
  return {
    async issue(context) {
      const configured = options.repositories.find(scope => scope.repository.toLowerCase() === context.repository.repository.toLowerCase() &&
        scope.installationId === context.repository.installationId);
      if (!configured) throw new CredentialIssuanceError('BUILDER_REPOSITORY_NOT_CONFIGURED', 'known-rejected', 'Only configured executable repositories receive a Builder grant.');
      const issuedAt = new Date().toISOString();
      const grant = await options.github.transient({ ...configured, workflows: false }, 'builder-start');
      return { delivery: Object.freeze({ token: grant.token }), metadata: { role: 'builder', purpose: 'builder-start', repository: configured.repository,
        repositoryId: grant.repositoryId, installationId: configured.installationId, permissions: grant.permissions, issuedAt, expiresAt: grant.expiresAt } };
    },
    async revoke() {
      return { kind: 'not-attempted', nextStep: 'Revocation belongs to the active credential lifecycle (ticket 20); the grant expires at its expiresAt.' };
    },
  };
}

/** Host fetch credential for the Factory-exclusive cache (Contents R) of a configured executable repository. */
export function createRepositoryFetchCredentials(options: { github: GitHubAccess; repositories: readonly GitHubScope[] }): RepositoryFetchCredentials {
  return { async fetch(repository) {
    const configured = options.repositories.find(scope => scope.repository.toLowerCase() === repository.repository.toLowerCase() && scope.installationId === repository.installationId);
    if (!configured) throw new CredentialIssuanceError('FETCH_REPOSITORY_NOT_CONFIGURED', 'known-rejected', 'Only configured executable repositories are fetched.');
    const grant = await options.github.transient({ ...configured, workflows: false }, 'repository-fetch');
    return Object.freeze({ token: grant.token, expiresAt: grant.expiresAt });
  } };
}
