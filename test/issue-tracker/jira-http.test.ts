import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraHttpTransport, type JiraHttpExchange, type JiraHttpResult } from '../../src/issue-tracker/index.js';

// Jira ticket 03: the host's REST v3 transport. Fixed HTTPS origin = the configured site URL (the adapter names only `/rest/api/3/...`
// paths), basic auth `email:token` with the token read lazily on the host, bounded responses and typed failures. The raw HTTP exchange is
// injected so these tests record every request in process.
const sentinel = 'synthetic-jira-token-SENTINEL';
const now = () => new Date('2026-11-21T10:00:00.000Z');
const json = (status: number, body: unknown, headers: Record<string, string> = {}): JiraHttpResult => ({
  kind: 'response',
  status,
  headers: { 'content-type': 'application/json;charset=UTF-8', ...headers },
  body: JSON.stringify(body),
});

function site(respond: (exchange: JiraHttpExchange) => JiraHttpResult, credential: () => Promise<string> = async () => sentinel) {
  const exchanges: JiraHttpExchange[] = [];
  let reads = 0;
  const transport = createJiraHttpTransport(
    {
      siteId: 'site-A',
      url: 'https://equipe.atlassian.net',
      email: 'fabrica@example.org',
      credential: () => {
        reads += 1;
        return credential();
      },
    },
    {
      now,
      send: async exchange => {
        exchanges.push(exchange);
        return respond(exchange);
      },
    },
  );
  return { transport, exchanges, reads: () => reads };
}

test('a request goes only to the configured HTTPS origin with basic auth, and a JSON answer is returned as data', async () => {
  const { transport, exchanges } = site(() => json(200, { id: '81017' }));
  const response = await transport.request({ method: 'GET', path: '/rest/api/3/issue/81017', query: { fields: 'labels,components' } });
  assert.deepEqual(response, { ok: true, status: 200, body: { id: '81017' }, observedAt: '2026-11-21T10:00:00.000Z' });
  assert.equal(exchanges.length, 1, 'positive control: the call is made and recorded');
  const [exchange] = exchanges;
  assert.equal(exchange!.method, 'GET');
  assert.equal(exchange!.url, 'https://equipe.atlassian.net/rest/api/3/issue/81017?fields=labels%2Ccomponents');
  assert.equal(exchange!.headers.authorization, `Basic ${Buffer.from(`fabrica@example.org:${sentinel}`).toString('base64')}`);
  assert.equal(exchange!.headers.accept, 'application/json');
  assert.equal(exchange!.body, undefined);

  const posted = site(() => json(200, { issues: [] }));
  await posted.transport.request({ method: 'POST', path: '/rest/api/3/search/jql', body: { jql: 'project = 10010' } });
  assert.equal(posted.exchanges[0]!.body, '{"jql":"project = 10010"}');
  assert.equal(posted.exchanges[0]!.headers['content-type'], 'application/json');
});

test('a path outside the REST v3 API is refused before the credential is read or anything is sent', async () => {
  for (const path of [
    '/rest/api/2/issue/1',
    'https://evil.example/rest/api/3/issue/1',
    '/rest/api/3/../../x',
    '/rest/api/3//evil',
    '/rest/api/3/issue/1?x=1',
    '//evil.example/rest/api/3/issue',
    '/rest/api/3/issue/1#f',
    '/rest/api/3/%2e%2e/2/issue/1',
    '/rest/api/3/issue/%2E%2E/%2e%2e/x',
  ]) {
    const { transport, exchanges, reads } = site(() => json(200, {}));
    const response = await transport.request({ method: 'GET', path });
    assert.equal(response.ok === false && response.code, 'JIRA_REQUEST_REFUSED', path);
    assert.equal(exchanges.length, 0, path);
    assert.equal(reads(), 0, path);
  }
});

test('HTTP failures are typed with a safe next step; 429 and 5xx honour Retry-After; nothing echoes the token', async () => {
  const cases: [JiraHttpResult, string, number | undefined][] = [
    [json(401, { errorMessages: [sentinel] }), 'JIRA_UNAUTHENTICATED', undefined],
    [json(403, {}), 'JIRA_FORBIDDEN', undefined],
    [json(404, {}), 'JIRA_NOT_FOUND', undefined],
    [json(429, {}, { 'retry-after': '30' }), 'JIRA_RATE_LIMITED', 30],
    [json(429, {}), 'JIRA_RATE_LIMITED', 60],
    [json(429, {}, { 'retry-after': 'Sat, 21 Nov 2026 10:02:00 GMT' }), 'JIRA_RATE_LIMITED', 120],
    [json(503, {}, { 'retry-after': '5' }), 'JIRA_UNAVAILABLE', 5],
    [json(500, {}), 'JIRA_UNAVAILABLE', undefined],
    [json(400, {}), 'JIRA_REQUEST_REJECTED', undefined],
    [{ kind: 'failed', reason: 'timeout' }, 'JIRA_TIMEOUT', undefined],
    [{ kind: 'failed', reason: 'network' }, 'JIRA_TRANSPORT_UNAVAILABLE', undefined],
    [{ kind: 'failed', reason: 'too-large' }, 'JIRA_RESPONSE_TOO_LARGE', undefined],
    [{ kind: 'response', status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' }, 'JIRA_RESPONSE_INVALID', undefined],
    [{ kind: 'response', status: 200, headers: { 'content-type': 'application/json' }, body: '{' }, 'JIRA_RESPONSE_INVALID', undefined],
    [json(200, { echoed: `Basic ${sentinel}` }), 'JIRA_RESPONSE_INVALID', undefined],
  ];
  for (const [result, code, waitSeconds] of cases) {
    const { transport } = site(() => result);
    const response = await transport.request({ method: 'GET', path: '/rest/api/3/issue/81017' });
    assert.equal(response.ok, false, code);
    if (response.ok) continue;
    assert.equal(response.code, code);
    assert.equal(response.waitSeconds, waitSeconds, code);
    assert.ok(response.nextStep.length > 0);
    assert.doesNotMatch(JSON.stringify(response), /SENTINEL/, code);
  }
});

test('a credential that cannot be read sends nothing and is reported without its detail', async () => {
  const { transport, exchanges } = site(
    () => json(200, {}),
    async () => {
      throw new Error(`UNSAFE_CREDENTIAL_FILE ${sentinel}`);
    },
  );
  const response = await transport.request({ method: 'GET', path: '/rest/api/3/issue/81017' });
  assert.equal(response.ok === false && response.code, 'JIRA_CREDENTIAL_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(response), /SENTINEL/);
  assert.equal(exchanges.length, 0);
});
