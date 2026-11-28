import https from 'node:https';

/**
 * One closed REST v3 request of the Jira adapter. `path` is always `/rest/api/3/...` built by the adapter; the host transport supplies the
 * configured HTTPS origin and the credential (never the adapter, the Control or the agent).
 */
export type JiraRequest = { method: 'GET' | 'POST' | 'PUT'; path: string; query?: Record<string, string>; body?: unknown };
/** A known response (any HTTP status the transport passes through as data) or a failure that concludes nothing. */
export type JiraResponse =
  | { ok: true; status: number; body: unknown; observedAt: string }
  | { ok: false; code: string; status?: number; waitSeconds?: number; observedAt: string; nextStep: string };
export interface JiraTransport {
  request(input: JiraRequest): Promise<JiraResponse>;
}

/** Host access of one configured Jira site: the credential is read lazily by the host, never carried by Control, prompts or the agent. */
export type JiraHostSite = { siteId: string; url: string; email: string; credential: () => Promise<string> };
/** One raw HTTPS exchange toward the configured origin (headers in lower case). Tests inject a recording double. */
export type JiraHttpExchange = { method: JiraRequest['method']; url: string; headers: Record<string, string>; body?: string };
export type JiraHttpResult =
  { kind: 'response'; status: number; headers: Record<string, string>; body: string } | { kind: 'failed'; reason: 'timeout' | 'network' | 'too-large' };

const maxResponseBytes = 4 * 1024 * 1024;
const timeoutMs = 15000;
const maxWaitSeconds = 3600;
const defaultWaitSeconds = 60;

/** Production exchange: TLS verified, no shared agent, bounded headers/body/time; any doubt is a failure, never a partial body. */
function httpsSend(exchange: JiraHttpExchange): Promise<JiraHttpResult> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: JiraHttpResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const url = new URL(exchange.url);
    const req = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        method: exchange.method,
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: true,
        agent: false,
        maxHeaderSize: 16384,
        headers: { ...exchange.headers, ...(exchange.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(exchange.body)) }) },
      },
      response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('error', () => finish({ kind: 'failed', reason: 'network' }));
        response.on('aborted', () => finish({ kind: 'failed', reason: 'network' }));
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            finish({ kind: 'failed', reason: 'too-large' });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (!response.complete || !response.statusCode) {
            finish({ kind: 'failed', reason: 'network' });
            return;
          }
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) if (typeof value === 'string') headers[name.toLowerCase()] = value;
          finish({ kind: 'response', status: response.statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', () => finish({ kind: 'failed', reason: 'network' }));
    const timer = setTimeout(() => {
      finish({ kind: 'failed', reason: 'timeout' });
      req.destroy();
    }, timeoutMs);
    req.end(exchange.body);
  });
}

/** Seconds to wait from `Retry-After` (delta seconds or HTTP date), bounded; absent or unreadable = a conservative default. */
function retryAfter(value: string | undefined, now: Date): number {
  if (value === undefined) return defaultWaitSeconds;
  const seconds = /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : Math.ceil((Date.parse(value) - now.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return defaultWaitSeconds;
  return Math.min(maxWaitSeconds, Math.max(1, seconds));
}

const failures = {
  JIRA_REQUEST_REFUSED: 'Only REST v3 paths of the configured site are requested; nothing was sent.',
  JIRA_SITE_URL_INVALID: 'The configured Jira URL is not an HTTPS origin; fix `url` in the configuration. Nothing was sent.',
  JIRA_CREDENTIAL_UNAVAILABLE:
    'The Jira token file could not be read safely on the host; check the configured `tokenFile` (private regular file of this user). Nothing was sent.',
  JIRA_UNAUTHENTICATED: 'Jira refused the e-mail and API token; check the account e-mail and replace the token file on the host.',
  JIRA_FORBIDDEN: 'The Jira account lacks a permission for this read; grant it to the account (the Factory never widens its own access).',
  JIRA_NOT_FOUND: 'Jira answered not found, which may also mean no permission; check that the account can browse it. Nothing is concluded.',
  JIRA_RATE_LIMITED: 'Jira limited the request rate; the next read waits the indicated time.',
  JIRA_UNAVAILABLE: 'Jira is unavailable; the next poll reads again.',
  JIRA_REQUEST_REJECTED: 'Jira rejected the request; nothing is concluded.',
  JIRA_TIMEOUT: 'Jira did not answer in time; nothing is concluded, the next poll reads again.',
  JIRA_TRANSPORT_UNAVAILABLE: 'Jira could not be reached; nothing is concluded, the next poll reads again.',
  JIRA_RESPONSE_TOO_LARGE: 'The Jira answer exceeded the size limit; nothing is concluded.',
  JIRA_RESPONSE_INVALID: 'Jira answered something that is not a verifiable JSON response; nothing is concluded.',
} as const satisfies Record<string, string>;

type FailureCode = keyof typeof failures;
const failure = (now: () => Date, code: FailureCode, extra: { status?: number; waitSeconds?: number } = {}): JiraResponse => ({
  ok: false,
  code,
  ...extra,
  observedAt: now().toISOString(),
  nextStep: failures[code],
});

/** The configured origin, only when `url` is exactly an HTTPS origin without credentials. */
function siteOrigin(url: string): URL | null {
  let origin: URL;
  try {
    origin = new URL(url);
  } catch {
    return null;
  }
  if (origin.protocol !== 'https:' || origin.origin !== url.replace(/\/$/, '') || origin.username || origin.password) return null;
  return origin;
}

/** The request URL toward the origin, only for a closed `/rest/api/3/...` path that resolves to itself. */
function requestUrl(input: JiraRequest, origin: URL): URL | null {
  if (!/^\/rest\/api\/3\/[A-Za-z0-9._~%-]+(\/[A-Za-z0-9._~%-]+)*$/.test(input.path) || input.path.split('/').some(part => part === '.' || part === '..'))
    return null;
  const url = new URL(input.path, origin.origin);
  for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value);
  // The resolved path must be the one requested: WHATWG URL resolves percent-encoded dot segments (`%2e%2e`).
  if (url.origin !== origin.origin || url.pathname !== input.path) return null;
  return url;
}

function exchangeOf(input: JiraRequest, url: URL, authorization: string): JiraHttpExchange {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  return {
    method: input.method,
    url: url.toString(),
    headers: {
      authorization,
      accept: 'application/json',
      'user-agent': 'software-factory-controller',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  };
}

const transportFailureCode = (reason: Extract<JiraHttpResult, { kind: 'failed' }>['reason']): FailureCode =>
  reason === 'timeout' ? 'JIRA_TIMEOUT' : reason === 'too-large' ? 'JIRA_RESPONSE_TOO_LARGE' : 'JIRA_TRANSPORT_UNAVAILABLE';

type HttpAnswer = Extract<JiraHttpResult, { kind: 'response' }>;
/** The typed failure of a non-2xx status (`null` for 2xx). */
function statusFailure(result: HttpAnswer, now: () => Date): JiraResponse | null {
  const { status } = result;
  if (status === 401) return failure(now, 'JIRA_UNAUTHENTICATED', { status });
  if (status === 403) return failure(now, 'JIRA_FORBIDDEN', { status });
  if (status === 404) return failure(now, 'JIRA_NOT_FOUND', { status });
  if (status === 429) return failure(now, 'JIRA_RATE_LIMITED', { status, waitSeconds: retryAfter(result.headers['retry-after'], now()) });
  if (status >= 500)
    return failure(now, 'JIRA_UNAVAILABLE', {
      status,
      ...(result.headers['retry-after'] !== undefined ? { waitSeconds: retryAfter(result.headers['retry-after'], now()) } : {}),
    });
  if (status < 200 || status >= 300) return failure(now, 'JIRA_REQUEST_REJECTED', { status });
  return null;
}

/** A 2xx answer: bounded JSON that never echoes the credential (or an empty 204), or a failure. */
function answerOf(result: HttpAnswer, credential: { token: string; authorization: string }, now: () => Date): JiraResponse {
  const { status } = result;
  // No Content (the answer of an issue edit): there is no body to verify, and none is invented.
  if (status === 204 && result.body === '') return { ok: true, status, body: null, observedAt: now().toISOString() };
  if (!/^application\/json(?:;|$)/i.test(result.headers['content-type'] ?? '') || Buffer.byteLength(result.body) > maxResponseBytes)
    return failure(now, 'JIRA_RESPONSE_INVALID', { status });
  // An answer that echoes the credential is never handed on (it could reach an observation, a log or a comment).
  if (result.body.includes(credential.token) || result.body.includes(credential.authorization)) return failure(now, 'JIRA_RESPONSE_INVALID', { status });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body) as unknown;
  } catch {
    return failure(now, 'JIRA_RESPONSE_INVALID', { status });
  }
  return { ok: true, status, body: parsed, observedAt: now().toISOString() };
}

/**
 * The host's Jira Cloud REST v3 transport for ONE configured site. The origin is fixed by the configured `url`; callers only name
 * `/rest/api/3/...` paths (no URL, `..`, `//`, query or fragment inside the path). The API token is read on the host at each request and
 * sent only as basic auth toward that origin; failures carry a fixed code and next step, never a response text, so no observation, log or
 * comment can carry the token. Any 2xx JSON answer is returned as data; HTTP failures are typed (401/403/404/429/5xx, timeout).
 */
export function createJiraHttpTransport(
  site: JiraHostSite,
  options: { send?: (exchange: JiraHttpExchange) => Promise<JiraHttpResult>; now?: () => Date } = {},
): JiraTransport {
  const send = options.send ?? httpsSend;
  const now = options.now ?? (() => new Date());
  return {
    async request(input: JiraRequest): Promise<JiraResponse> {
      const origin = siteOrigin(site.url);
      if (!origin) return failure(now, 'JIRA_SITE_URL_INVALID');
      const url = requestUrl(input, origin);
      if (!url) return failure(now, 'JIRA_REQUEST_REFUSED');
      let token: string;
      try {
        token = await site.credential();
      } catch {
        return failure(now, 'JIRA_CREDENTIAL_UNAVAILABLE');
      }
      const authorization = `Basic ${Buffer.from(`${site.email}:${token}`).toString('base64')}`;
      const result = await send(exchangeOf(input, url, authorization));
      if (result.kind === 'failed') return failure(now, transportFailureCode(result.reason));
      return statusFailure(result, now) ?? answerOf(result, { token, authorization }, now);
    },
  };
}
