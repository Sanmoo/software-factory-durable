import https from 'node:https';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, mkdtemp, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { sign } from 'node:crypto';
import { z } from 'zod';
import type { AccessDiagnostic, BuilderCredentials, GitHubScope, RepositoryFetchCredentials, RevocationResult } from '../../contracts/index.js';

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
  // Ticket 14 publication activation (spec §8 Builder ceiling: Contents W, Pull requests W): the Builder pushes ITS branch and opens ITS
  // draft PR directly with Git/gh in the guest. Issued only after Control's verification and discovery; never Workflows/other repository.
  'builder-publish': { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'read' },
  // Discovery of the own publication (ticket 14): remote refs of the own branch (Contents R) + pull requests (R).
  'publication-read': { metadata: 'read', contents: 'read', pull_requests: 'read', administration: 'read' },
  // Host fetch into the Factory-exclusive bare cache (spec §8: clone/fetch uses Contents R).
  'repository-fetch': { metadata: 'read', contents: 'read' },
  // Controller publication of a durable Question on its Ticket issue (spec §5.5): one POST of an issue comment, nothing else.
  'question-publish': { metadata: 'read', issues: 'write' },
  // Ticket 15 required-checks explanation (spec §9.2), GET only: the own PR (Pull requests R), base branch tip/protection summary and
  // comparison (Contents R), classic required status checks (Administration R), check-runs (Checks R), commit statuses (Statuses R).
  'checks-read': { metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', administration: 'read' },
  // Ticket 16 readiness conversion (spec §9.2 step 7/§9.3), a controller effect: ONE draft/ready GraphQL mutation of the own PR, fresh grant
  // per conversion, used for that mutation only and revoked right after. Pull requests W is the narrowest App permission carrying it.
  'readiness-write': { metadata: 'read', pull_requests: 'write' },
  // Ticket 25 `reopen <work>` (spec §11.3), a controller effect: ONE reopenPullRequest GraphQL mutation of the Work's OWN pull request closed
  // without merge, fresh single-use grant revoked right after. Pull requests W only; never merge, review or any other state change.
  'pull-request-reopen': { metadata: 'read', pull_requests: 'write' },
  // Ticket 17: observation of the Work's own pull request (merge confirmation) and of its own branch tip. Read-only.
  'delivery-read': { metadata: 'read', contents: 'read', pull_requests: 'read' },
  // Ticket 23: human feedback of the own pull request (reviews, inline review comments and the PR conversation), GET only.
  'feedback-read': { metadata: 'read', pull_requests: 'read', issues: 'read' },
  // Ticket 17 (spec §8: "cleanup de branch remota própria recebe token próprio com Contents W"): ONE single-use grant per cleanup attempt,
  // never reused for tracking; the session can send only the closed DELETE of the selected own branch ref.
  'branch-cleanup': { metadata: 'read', contents: 'write', pull_requests: 'read' },
  // Ticket 44: the base branch tip and the `.factory/environment.yaml` file at that commit (Contents R), read by the controller host when a
  // Work is created; the file is only parsed and validated, never executed on the host.
  'environment-read': { metadata: 'read', contents: 'read' },
} as const;
/** The only two GraphQL documents the controller sends (ticket 16): the draft flag of one pull request, correlated by the effect identity.
 * Never review, approval, merge or any other mutation. */
export const draftMutations = {
  markPullRequestReadyForReview: 'mutation($id: ID!, $cid: String) { markPullRequestReadyForReview(input: {pullRequestId: $id, clientMutationId: $cid}) { clientMutationId pullRequest { id number isDraft headRefOid } } }',
  convertPullRequestToDraft: 'mutation($id: ID!, $cid: String) { convertPullRequestToDraft(input: {pullRequestId: $id, clientMutationId: $cid}) { clientMutationId pullRequest { id number isDraft headRefOid } } }',
  // Ticket 25: reopen of the Work's own pull request closed without merge (`factory reopen`), under its own single-use grant.
  reopenPullRequest: 'mutation($id: ID!, $cid: String) { reopenPullRequest(input: {pullRequestId: $id, clientMutationId: $cid}) { clientMutationId pullRequest { id number isDraft headRefOid state } } }',
} as const;
type Purpose = keyof typeof permissions;
type DiagnosticPurpose = 'tracker' | 'repository' | 'dependency';
export type ReadPurpose = 'tracker-read' | 'repository-read' | 'association-read' | 'dependency-read' | 'publication-read' | 'checks-read' | 'delivery-read' | 'feedback-read' | 'environment-read';
/** Token-free metadata of each reduced read grant (principal/scope evidence; never the token). */
export const readPermissions: Readonly<Record<ReadPurpose, Readonly<Record<string, 'read'>>>> = {
  'tracker-read': permissions['tracker-read'], 'repository-read': permissions['repository-read'],
  'association-read': permissions['association-read'], 'dependency-read': permissions['dependency-read'], 'publication-read': permissions['publication-read'], 'checks-read': permissions['checks-read'], 'delivery-read': permissions['delivery-read'],
  'feedback-read': permissions['feedback-read'], 'environment-read': permissions['environment-read'] };
const repositorySchema = z.object({ id: z.number().int().positive().safe(), full_name: z.string(), owner: z.object({ login: z.string() }) });
const permissionSchema = z.record(z.string(), z.enum(['read', 'write']));
class AccessFailure extends Error {
  constructor(readonly code: string, readonly waitSeconds?: number, readonly nextStep?: string, readonly status?: number) { super(code); }
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
  /** Complete listing of every Link page, or a failure; never a partial array. Query parameters other than paging are preserved.
   * `maxPages` (default 100): more pages than that is INCOMPLETE_GITHUB_QUERY, never a truncated result.
   * `items` (ticket 15): pages are objects `{ total_count, <items>: [...] }` (e.g. check-runs); a total_count that changes between pages or
   * differs from the collected count is INCOMPLETE_GITHUB_QUERY. */
  list(endpoint: string, options?: { maxPages?: number; items?: string }): Promise<unknown[]>;
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
  /** One self-revocation (`DELETE /installation/token` through gh, authenticated by the token itself) of a transient grant. Never retried;
   * distinguishes revoked / already-invalid / failed / unknown / impossible (no value). Never returns or logs the token. */
  revoke(token: string): Promise<RevocationResult>;
  /** The configured App identity: comments it performed carry `performed_via_github_app.id === appId` (question discovery). */
  readonly appId: number;
  /** Ticket 14: the App's bot user (`<slug>[bot]` from GET /app, its user id read with an installation token of `scope`); null when unknown. */
  appIdentity(scope: GitHubScope): Promise<{ login: string; id: number } | null>;
  /**
   * The ONLY write: one POST of an issue comment under a fresh reduced `question-publish` grant (issues:write, this repository only).
   * Never retried. `unknown` (transport loss, 5xx, unexpected success payload) means the comment may exist: discover it before posting again.
   */
  comment(scope: GitHubScope, issueNumber: number, body: string): Promise<GitHubWrite>;
  /**
   * Ticket 16: ONE GraphQL draft/ready mutation of one pull request node of `scope` (markPullRequestReadyForReview / convertPullRequestToDraft)
   * under a fresh single-use `readiness-write` grant used for nothing else and revoked right after. Never retried. `unknown` (transport loss,
   * 5xx, unexpected payload) means the flag may have changed: read the pull request before any repetition.
   */
  setDraft(scope: GitHubScope, pullRequest: { number: number; nodeId: string }, draft: boolean, clientMutationId: string): Promise<GitHubWrite>;
  /** Ticket 25: ONE `reopenPullRequest` mutation of one pull request node of `scope` under a fresh single-use `pull-request-reopen` grant, revoked
   * right after. Never retried; `unknown` means it may be open: read the pull request before any repetition. */
  reopen(scope: GitHubScope, pullRequest: { number: number; nodeId: string }, clientMutationId: string): Promise<GitHubWrite>;
  /**
   * Ticket 17: one FRESH single-use `branch-cleanup` grant for THIS repository (never cached, never the tracking token). `operate` reads with
   * GET and may send at most one closed ATOMIC conditional deletion of one branch ref (`deleteRefIfAt`, GraphQL `updateRefs` with
   * `beforeOid`); the grant is revoked right after, whatever happened. `unknown` only when that request left and its outcome is not conclusive.
   */
  cleanup<T>(scope: GitHubScope, operate: (session: GitHubCleanupSession) => Promise<T>): Promise<GitHubCleanup<T>>;
}
/**
 * Read session plus the single closed ATOMIC ref deletion of a cleanup attempt: GitHub deletes `refs/heads/<branch>` only if it still points
 * to `beforeOid` (GraphQL `updateRefs`, force false), otherwise changes nothing. A second call is refused locally (nothing sent).
 * `unavailable`: the token/schema offers no such mutation (nothing changed): the caller keeps the branch, never falls back to a plain DELETE.
 */
export interface GitHubCleanupSession extends GitHubSession {
  deleteRefIfAt(input: { repositoryNodeId: string; branch: string; beforeOid: string }): Promise<{ kind: 'deleted' } | { kind: 'rejected' | 'unavailable'; code: string }>;
}
export type GitHubCleanup<T> = { ok: true; observedAt: string; repositoryId: number; value: T; sent: boolean; revocation: TokenRevocation } |
  { ok: false; outcome: 'known-failure' | 'unknown'; observedAt: string; code: string; waitSeconds?: number; nextStep: string; sent: boolean; revocation: TokenRevocation };
/** `revocation`: outcome of the self-revocation (DELETE /installation/token) of the single-use grant after the POST attempt. */
export type TokenRevocation = RevocationResult['kind'] | 'not-issued';
export type GitHubWrite = { ok: true; observedAt: string; repositoryId: number; value: unknown; revocation: TokenRevocation } |
  { ok: false; outcome: 'known-failure' | 'unknown'; observedAt: string; code: string; waitSeconds?: number; nextStep: string; revocation: TokenRevocation };
export type TransientPurpose = 'builder-start' | 'builder-publish' | 'repository-fetch';
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
  // The App slug observed by GET /app (identity check of every issuance): the only non-repository endpoint a session may read is its bot user.
  let appSlug: string | undefined;
  const botEndpoint = (slug: string) => `/users/${encodeURIComponent(`${slug}[bot]`)}`;
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

  /** `graphql`: GraphQL has no REST API version (a selected-version header, when present, must still match) and reports its errors in a 200
   * body (gh then exits non-zero): the caller inspects that body. */
  function parseResponse(scope: GitHubScope, output: { stdout: string; failed: boolean }, endpoint: string, repositoryId?: number, graphql = false): { body: unknown; status: number; next?: string } {
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
    if (status === 401 || status === 403 || status === 404) throw new AccessFailure(status === 404 ? 'GITHUB_NOT_FOUND_OR_HIDDEN' : 'GITHUB_ACCESS_DENIED', undefined, undefined, status);
    if ((output.failed && !(graphql && status === 200)) || status < 200 || status >= 300) throw new AccessFailure('GITHUB_QUERY_FAILED', undefined, undefined, status);
    const selected = headers.get('x-github-api-version-selected');
    if (selected !== version && !(graphql && selected === undefined)) throw new AccessFailure('GITHUB_API_VERSION_MISMATCH');
    // A successful response that exhausts the quota defers the NEXT request; this one is still valid.
    if (exhausted && repositoryId !== undefined) rateLimit(scope, Math.min(resetWait ?? 60, 86400));
    let body: unknown;
    if (status === 204 && match[3] === '') body = null;
    else try { body = JSON.parse(match[3]!); } catch { throw new AccessFailure('INVALID_GITHUB_PAYLOAD'); }
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
    return { body, status, ...(next ? { next } : {}) };
  }

  /** `input`: JSON body of the single closed POST operation (question comment), sent on stdin; reads are GET without input. */
  async function gh(scope: GitHubScope, directory: string, token: string, endpoint: string, repositoryId?: number, input?: string, method?: 'DELETE'): Promise<{ body: unknown; status: number; next?: string }> {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//') || /[\r\n#\\]/.test(endpoint)) throw new AccessFailure('INVALID_ENDPOINT');
    return parseResponse(scope, await ghExec(directory, token, method ?? (input === undefined ? 'GET' : 'POST'), endpoint, input), endpoint, repositoryId);
  }

  /** gh api under one installation token in an isolated config directory; the token is in the explicit environment only, never argv.
   * `input` (POST only): JSON body on stdin. */
  function ghExec(directory: string, token: string, method: 'GET' | 'DELETE' | 'POST', endpoint: string, input?: string): Promise<{ stdout: string; failed: boolean }> {
    const argv = ['api', '--hostname', 'github.com', '--method', method, '--include', '-H', 'Accept: application/vnd.github+json', '-H', `X-GitHub-Api-Version: ${version}`,
      ...(input === undefined ? [] : ['--input', '-']), '--', endpoint];
    return new Promise<{ stdout: string; failed: boolean }>((resolve, reject) => {
      const child = execFile(options.executable ?? 'gh', argv, { cwd: directory, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, shell: false,
        env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C', GH_TOKEN: token, GH_HOST: 'github.com', GH_CONFIG_DIR: directory,
          HOME: directory, XDG_CONFIG_HOME: directory, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } },
      (error, stdout) => {
        if (error && (!stdout || !('code' in error) || typeof error.code !== 'number')) { reject(new AccessFailure('GITHUB_TRANSPORT_UNAVAILABLE')); return; }
        resolve({ stdout, failed: Boolean(error) });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
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
    const app = z.object({ id: z.literal(options.appId), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional() }).safeParse((await appRequest('identity')).body);
    if (!app.success) throw new AccessFailure('APP_IDENTITY_MISMATCH');
    if (app.data.slug) appSlug = app.data.slug;
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
      endpoint.startsWith(`/repositories/${grant.repositoryId}/`) || (appSlug !== undefined && endpoint === botEndpoint(appSlug));
    return { repositoryId: grant.repositoryId, async get(endpoint) {
      if (!allowed(endpoint)) throw new AccessFailure('CREDENTIAL_SCOPE_MISMATCH');
      return (await gh(scope, directory, grant.token, endpoint, grant.repositoryId)).body;
    }, async list(endpoint, listOptions) {
      const values: unknown[] = [];
      const seen = new Set<string>();
      const first = new URL(endpoint, 'https://api.github.com');
      if (first.searchParams.has('page') || first.searchParams.has('per_page')) throw new AccessFailure('INVALID_ENDPOINT');
      first.searchParams.set('per_page', '100');
      first.searchParams.set('page', '1');
      let page: string | undefined = first.pathname + first.search;
      const key = listOptions?.items;
      if (key !== undefined && !/^[a-z_]{1,64}$/.test(key)) throw new AccessFailure('INVALID_ENDPOINT');
      let total: number | undefined;
      while (page) {
        if (!allowed(page) || seen.has(page) || seen.size >= Math.min(100, listOptions?.maxPages ?? 100)) throw new AccessFailure('INCOMPLETE_GITHUB_QUERY');
        seen.add(page);
        const response = await gh(scope, directory, grant.token, page, grant.repositoryId);
        let items: unknown = response.body;
        if (key !== undefined) {
          const wrapped = response.body !== null && typeof response.body === 'object' && !Array.isArray(response.body) ? response.body as Record<string, unknown> : undefined;
          const count = wrapped?.total_count;
          if (!wrapped || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new AccessFailure('INVALID_GITHUB_PAYLOAD');
          if (total !== undefined && total !== count) throw new AccessFailure('INCOMPLETE_GITHUB_QUERY');
          total = count;
          items = wrapped[key];
        }
        if (!Array.isArray(items)) throw new AccessFailure('INVALID_GITHUB_PAYLOAD');
        values.push(...items);
        page = response.next;
      }
      if (total !== undefined && values.length !== total) throw new AccessFailure('INCOMPLETE_GITHUB_QUERY');
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

  async function revokeToken(token: string): Promise<RevocationResult> {
    // No value, no request: a lost grant (e.g. after a crash) cannot be revoked and may stay valid externally until its expiry.
    if (!token) return { kind: 'impossible', code: 'GRANT_VALUE_UNAVAILABLE', nextStep: 'The grant value is not available (never recovered from logs/sessions); it may remain valid externally until its expiresAt. Expiry is not proof of cessation.' };
    secrets.add(token);
    let directory: string | undefined;
    const unknown = { kind: 'unknown' as const, code: 'GITHUB_REVOCATION_OUTCOME_UNKNOWN', nextStep: 'GitHub gave no conclusive answer; the token may still be valid until its expiresAt. Not repeated automatically; not proof of cessation.' };
    try {
      directory = await mkdtemp(join(options.root, 'run', 'github-'));
      let output;
      try { output = await ghExec(directory, token, 'DELETE', '/installation/token'); } catch { return unknown; }
      const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(output.stdout)?.[1]);
      if (status === 204 && !output.failed) return { kind: 'revoked', code: 'GITHUB_TOKEN_REVOKED', nextStep: 'GitHub revoked this installation token. Copies already made by code that received it stop working, but this is not proof that the activity ceased.' };
      if (status === 401) return { kind: 'already-invalid', code: 'GITHUB_TOKEN_NOT_ACCEPTED', nextStep: 'GitHub no longer accepts this token (expired or revoked earlier). This is not proof of cessation and not a revocation by this attempt.' };
      if (status >= 400 && status < 500 && status !== 429) return { kind: 'failed', code: 'GITHUB_REVOCATION_REJECTED', nextStep: 'GitHub rejected the revocation; the token stays valid until its expiresAt. Not repeated automatically.' };
      return unknown;
    } catch { return unknown; } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }

  /** The single GraphQL call site of the controller's pull request mutations (tickets 16/25): draft/ready flag or reopen of ONE own pull request
   * node, fresh single-use grant per mutation, revoked right after, never retried. */
  async function pullMutation(scope: GitHubScope, pullRequest: { number: number; nodeId: string }, field: keyof typeof draftMutations | null, clientMutationId: string): Promise<GitHubWrite> {
    let directory: string | undefined;
    const observedAt = new Date().toISOString();
    const sanitized = <R>(value: R): R => JSON.parse(filter(JSON.stringify(value))) as R;
    if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0 || !/^[A-Za-z0-9_=-]{1,256}$/.test(pullRequest.nodeId) || field === null ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientMutationId)) {
      return { ok: false, outcome: 'known-failure', observedAt, code: 'INVALID_DRAFT_CONVERSION', nextStep: 'Conversion rejected locally; nothing was sent.', revocation: 'not-issued' };
    }
    const window = rateWindows.get(scope.installationId) ?? 0;
    if (window > Date.now()) return sanitized({ ok: false as const, outcome: 'known-failure' as const, observedAt, code: 'GITHUB_RATE_LIMITED',
      waitSeconds: Math.max(1, Math.ceil((window - Date.now()) / 1000)), nextStep: 'Rate-limit window still open; nothing was sent.', revocation: 'not-issued' as const });
    let grant: Grant;
    // Issuance failures happen BEFORE the mutation: the flag certainly did not change.
    try { grant = await issue(scope, field === 'reopenPullRequest' ? 'pull-request-reopen' : 'readiness-write'); } catch (error) {
      const typed = failure(error);
      return sanitized({ ok: false as const, outcome: 'known-failure' as const, observedAt, ...typed,
        code: error instanceof TokenIssuanceFailure && error.outcome === 'unknown' ? 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' : typed.code, revocation: 'not-issued' as const });
    }
    const draft = field === 'convertPullRequestToDraft';
    let revocation: TokenRevocation = 'unknown';
    let revoked = false;
    // Exactly one self-revocation attempt per conversion grant, whatever the mutation outcome.
    const revoke = async () => { if (revoked) return; revoked = true; revocation = (await revokeToken(grant.token)).kind; };
    const unknownStep = field === 'reopenPullRequest' ? 'The reopen may have been applied: read the pull request (its state) before any repetition; never resend blindly.'
      : 'The conversion may have been applied: read the pull request (its draft flag) before any repetition; never resend blindly.';
    try {
      directory = await mkdtemp(join(options.root, 'run', 'github-'));
      // The single-use grant serves this one mutation only (repository identity was verified at issuance), then its self-revocation.
      let output: { stdout: string; failed: boolean };
      try { output = await ghExec(directory, grant.token, 'POST', 'graphql', JSON.stringify({ query: draftMutations[field], variables: { id: pullRequest.nodeId, cid: clientMutationId } })); }
      catch (error) { await revoke(); return sanitized({ ok: false as const, outcome: 'unknown' as const, observedAt, ...failure(error), nextStep: unknownStep, revocation }); }
      await revoke();
      let response: { body: unknown; status: number };
      try { response = parseResponse(scope, output, '/graphql', grant.repositoryId, true); } catch (error) {
        if (error instanceof AccessFailure && error.code === 'GITHUB_RATE_LIMITED' && error.waitSeconds !== undefined) rateLimit(scope, error.waitSeconds);
        const typed = failure(error);
        // GitHub answered 4xx (nothing changed) or rate-limited: known. 5xx/unparseable: unknown.
        const known = error instanceof AccessFailure && (error.code === 'GITHUB_RATE_LIMITED' || (error.status !== undefined && error.status >= 400 && error.status < 500));
        return sanitized({ ok: false as const, outcome: known ? 'known-failure' as const : 'unknown' as const, observedAt, ...typed, nextStep: known ? typed.nextStep : unknownStep, revocation });
      }
      const parsed = z.object({ data: z.object({ [field]: z.object({ clientMutationId: z.string().nullable(), pullRequest: z.object({ id: z.string(), number: z.number().int(),
        isDraft: z.boolean(), headRefOid: z.string().regex(/^[0-9a-f]{40}$/), state: z.string().max(16).optional() }) }).nullable() }).nullable().optional(),
        errors: z.array(z.object({ type: z.string().max(64).optional() })).optional() }).safeParse(response.body);
      const result = parsed.success ? (parsed.data.data?.[field] ?? null) as { clientMutationId: string | null; pullRequest: { id: string; number: number; isDraft: boolean; headRefOid: string; state?: string } } | null : null;
      if (parsed.success && parsed.data.errors?.length && !result) {
        return sanitized({ ok: false as const, outcome: 'known-failure' as const, observedAt, code: `GITHUB_GRAPHQL_${(parsed.data.errors[0]!.type ?? 'ERROR').replace(/[^A-Z_]/g, '').slice(0, 40)}`,
          nextStep: 'GitHub refused the mutation: the flag did not change. Nothing is repeated automatically.', revocation });
      }
      if (!result || result.pullRequest.id !== pullRequest.nodeId || result.pullRequest.number !== pullRequest.number ||
        (field === 'reopenPullRequest' ? result.pullRequest.state !== 'OPEN' : result.pullRequest.isDraft !== draft) ||
        result.clientMutationId !== clientMutationId || parsed.data?.errors?.length) {
        return sanitized({ ok: false as const, outcome: 'unknown' as const, observedAt, code: 'GITHUB_WRITE_UNEXPECTED_PAYLOAD', nextStep: unknownStep, revocation });
      }
      return sanitized({ ok: true as const, observedAt, repositoryId: grant.repositoryId, value: { draft: result.pullRequest.isDraft, headSha: result.pullRequest.headRefOid, ...(field === 'reopenPullRequest' ? { state: 'open' } : {}) }, revocation });
    } catch (error) {
      await revoke();
      return sanitized({ ok: false as const, outcome: 'unknown' as const, observedAt, ...failure(error), nextStep: unknownStep, revocation });
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }

  return { revoke: revokeToken, appId: options.appId, async appIdentity(scope) {
    const read = await this.read(scope, 'publication-read', async session => {
      if (!appSlug) throw new InvalidGitHubObservation();
      const user = z.object({ login: z.literal(`${appSlug}[bot]`), id: z.number().int().positive().safe(), type: z.literal('Bot') }).safeParse(await session.get(botEndpoint(appSlug)));
      if (!user.success) throw new InvalidGitHubObservation();
      return { login: user.data.login, id: user.data.id };
    });
    return read.ok ? read.value : null;
  }, async comment(scope, issueNumber, body) {
    let directory: string | undefined;
    const observedAt = new Date().toISOString();
    const sanitized = <R>(value: R): R => JSON.parse(filter(JSON.stringify(value))) as R;
    const window = rateWindows.get(scope.installationId) ?? 0;
    if (window > Date.now()) return sanitized({ ok: false as const, outcome: 'known-failure' as const, observedAt, code: 'GITHUB_RATE_LIMITED',
      waitSeconds: Math.max(1, Math.ceil((window - Date.now()) / 1000)), nextStep: 'Rate-limit window still open; nothing was sent.', revocation: 'not-issued' as const });
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || typeof body !== 'string' || !body || body.length > 60000) {
      return { ok: false, outcome: 'known-failure', observedAt, code: 'INVALID_COMMENT', nextStep: 'Comment rejected locally; nothing was sent.', revocation: 'not-issued' };
    }
    let grant: Grant;
    // Issuance failures happen BEFORE the POST: the comment certainly was not created.
    try { grant = await issue(scope, 'question-publish'); } catch (error) {
      const typed = failure(error);
      return sanitized({ ok: false as const, outcome: 'known-failure' as const, observedAt, ...typed,
        code: error instanceof TokenIssuanceFailure && error.outcome === 'unknown' ? 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' : typed.code, revocation: 'not-issued' as const });
    }
    let sent = false;
    let revocation: TokenRevocation = 'unknown';
    // Single-use grant: revoke it right after the write attempt, whatever its outcome (204 = revoked; anything else is reported, never claimed).
    // Same self-revocation path as the Builder grants (distinct revoked/already-invalid/failed/unknown outcomes).
    const revoke = async () => { revocation = (await revokeToken(grant.token)).kind; };
    try {
      directory = await mkdtemp(join(options.root, 'run', 'github-'));
      await verifyRepository(scope, session(scope, directory, grant));
      sent = true;
      const response = await gh(scope, directory, grant.token, `/repos/${scope.repository}/issues/${issueNumber}/comments`, grant.repositoryId, JSON.stringify({ body }));
      await revoke();
      if (response.status !== 201) return sanitized({ ok: false as const, outcome: 'unknown' as const, observedAt, code: 'GITHUB_WRITE_UNEXPECTED_STATUS',
        nextStep: 'The comment may exist; discover it by its marker before any new publication.', revocation });
      return sanitized({ ok: true as const, observedAt, repositoryId: grant.repositoryId, value: response.body, revocation });
    } catch (error) {
      if (error instanceof AccessFailure && error.code === 'GITHUB_RATE_LIMITED' && error.waitSeconds !== undefined) rateLimit(scope, error.waitSeconds);
      await revoke();
      const typed = failure(error);
      // Known: refused before sending, or GitHub answered 4xx (nothing created). Unknown: transport loss, 5xx, unparseable success.
      const known = !sent || (error instanceof AccessFailure && (error.code === 'GITHUB_RATE_LIMITED' || (error.status !== undefined && error.status >= 400 && error.status < 500)));
      return sanitized({ ok: false as const, outcome: known ? 'known-failure' as const : 'unknown' as const, observedAt, ...typed,
        code: typed.code === 'GITHUB_DIAGNOSTIC_FAILED' ? 'GITHUB_WRITE_FAILED' : typed.code,
        nextStep: known ? typed.nextStep : 'Publication outcome is unknown: the comment may exist. Discover it by its marker before any new publication; never repost blindly.', revocation });
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }, setDraft(scope, pullRequest, draft, clientMutationId) {
    return pullMutation(scope, pullRequest, typeof draft !== 'boolean' ? null : draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview', clientMutationId);
  }, reopen(scope, pullRequest, clientMutationId) {
    return pullMutation(scope, pullRequest, 'reopenPullRequest', clientMutationId);
  }, async cleanup(scope, operate) {
    let directory: string | undefined;
    const observedAt = new Date().toISOString();
    const sanitized = <R>(value: R): R => JSON.parse(filter(JSON.stringify(value))) as R;
    const window = rateWindows.get(scope.installationId) ?? 0;
    if (window > Date.now()) return sanitized({ ok: false as const, outcome: 'known-failure' as const, observedAt, code: 'GITHUB_RATE_LIMITED',
      waitSeconds: Math.max(1, Math.ceil((window - Date.now()) / 1000)), nextStep: 'Rate-limit window still open; nothing was sent.', sent: false, revocation: 'not-issued' as const });
    let grant: Grant;
    // Issuance failures happen BEFORE any request: nothing was deleted.
    try { grant = await issue(scope, 'branch-cleanup'); } catch (error) {
      const typed = failure(error);
      return sanitized({ ok: false as const, outcome: 'known-failure' as const, observedAt, ...typed,
        code: error instanceof TokenIssuanceFailure && error.outcome === 'unknown' ? 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' : typed.code, sent: false, revocation: 'not-issued' as const });
    }
    let sent = false;
    let answered: number | undefined;
    let revocation: TokenRevocation = 'unknown';
    const revoke = async () => { revocation = (await revokeToken(grant.token)).kind; };
    try {
      directory = await mkdtemp(join(options.root, 'run', 'github-'));
      const reads = session(scope, directory, grant);
      await verifyRepository(scope, reads);
      const own = directory;
      const value = await operate({ ...reads, async deleteRefIfAt({ repositoryNodeId, branch, beforeOid }) {
        // Closed operation: one ref of THIS repository (its node id as GitHub reported it), a branch name the Factory validates, an exact
        // expected tip; no other mutation, ref, path or force.
        if (sent || !/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/.test(branch) || !/^[0-9a-f]{40}$/.test(beforeOid) ||
          !/^[A-Za-z0-9_=-]{1,128}$/.test(repositoryNodeId)) throw new AccessFailure('CLEANUP_OPERATION_REFUSED');
        sent = true;
        const query = 'mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }';
        const output = await ghExec(own, grant.token, 'POST', '/graphql', JSON.stringify({ query,
          variables: { repositoryId: repositoryNodeId, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid, afterOid: '0'.repeat(40), force: false }] } }));
        const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(output.stdout);
        if (!match) throw new AccessFailure('INVALID_GITHUB_RESPONSE');
        const status = Number(match[1]);
        // A 5xx answer leaves the outcome unknown (the caller re-reads before anything else); any other answer is conclusive.
        if (status >= 500) throw new AccessFailure('GITHUB_QUERY_FAILED');
        answered = status;
        if (status !== 200) return { kind: 'rejected', code: `GRAPHQL_HTTP_${status}` };
        let body: unknown;
        try { body = JSON.parse(match[2]!); } catch { throw new AccessFailure('INVALID_GITHUB_PAYLOAD'); }
        const parsed = z.object({ data: z.object({ updateRefs: z.object({}).passthrough().nullable() }).nullable().optional(),
          errors: z.array(z.object({ message: z.string().optional(), type: z.string().optional(), extensions: z.object({ code: z.string().optional() }).passthrough().optional() })).optional() }).safeParse(body);
        if (!parsed.success) throw new AccessFailure('INVALID_GITHUB_PAYLOAD');
        const errors = parsed.data.errors ?? [];
        if (errors.some(error => error.extensions?.code === 'undefinedField' || /doesn't exist on type 'Mutation'|Field 'updateRefs'/.test(error.message ?? ''))) {
          return { kind: 'unavailable', code: 'ATOMIC_DELETE_UNAVAILABLE' };
        }
        if (errors.length || !parsed.data.data?.updateRefs) return { kind: 'rejected', code: errors[0]?.type ? `GRAPHQL_${errors[0].type.replace(/[^A-Z_]/gi, '').toUpperCase().slice(0, 40)}` : 'GRAPHQL_REJECTED' };
        return { kind: 'deleted' };
      } });
      await revoke();
      return sanitized({ ok: true as const, observedAt, repositoryId: grant.repositoryId, value, sent, revocation });
    } catch (error) {
      if (error instanceof AccessFailure && error.code === 'GITHUB_RATE_LIMITED' && error.waitSeconds !== undefined) rateLimit(scope, error.waitSeconds);
      await revoke();
      const typed = failure(error);
      // Known: nothing sent or the atomic deletion answered conclusively. Unknown: it left and no conclusive answer came back.
      const known = !sent || answered !== undefined;
      return sanitized({ ok: false as const, outcome: known ? 'known-failure' as const : 'unknown' as const, observedAt, ...typed,
        code: typed.code === 'GITHUB_DIAGNOSTIC_FAILED' ? 'GITHUB_CLEANUP_FAILED' : typed.code,
        nextStep: known ? typed.nextStep : 'The branch deletion may have happened: re-read the ref before any new attempt; never repeated blindly.', sent, revocation });
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }, async transient(scope, purpose) {
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
 * Builder credential projection (spec §8.1): issues for the Work's OWN configured repository only, with the fixed purpose; the caller cannot
 * request permissions. Renewal is simply a NEW `issue` after the caller revalidated the activity (no `renew` method, cache or vault).
 * `revoke` makes one self-revocation attempt of that grant's value and reports its distinct outcome; it never claims cessation.
 */
export function createBuilderCredentials(options: { github: GitHubAccess; repositories: readonly GitHubScope[] }): BuilderCredentials {
  return {
    async issue(context) {
      const configured = options.repositories.find(scope => scope.repository.toLowerCase() === context.repository.repository.toLowerCase() &&
        scope.installationId === context.repository.installationId);
      if (!configured) throw new CredentialIssuanceError('BUILDER_REPOSITORY_NOT_CONFIGURED', 'known-rejected', 'Only configured executable repositories receive a Builder grant.');
      const purpose = context.purpose ?? 'builder-start';
      if (purpose !== 'builder-start' && purpose !== 'builder-publish') throw new CredentialIssuanceError('BUILDER_PURPOSE_INVALID', 'known-rejected', 'Only the fixed Builder purposes exist.');
      const issuedAt = new Date().toISOString();
      const grant = await options.github.transient({ ...configured, workflows: false }, purpose);
      return { delivery: Object.freeze({ token: grant.token }), metadata: { role: 'builder', purpose, repository: configured.repository,
        repositoryId: grant.repositoryId, installationId: configured.installationId, permissions: grant.permissions, issuedAt, expiresAt: grant.expiresAt } };
    },
    async revoke(grant) {
      return options.github.revoke(typeof grant.delivery?.token === 'string' ? grant.delivery.token : '');
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
  }, revoke(grant) {
    return options.github.revoke(typeof grant?.token === 'string' ? grant.token : '');
  } };
}
