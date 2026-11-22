import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJiraHttpTransport,
  createJiraTracker,
  type JiraHttpExchange,
  type JiraHttpResult,
  type JiraRequest,
  type JiraResponse,
  type JiraTicketRef,
} from '../../src/issue-tracker/index.js';

// Jira ticket 05 (spec §4 last paragraph): the Jira adapter's automatic comments. A Platform comment in ADF with no visibility restriction
// (the Card's own audience), every visible comment read over all pages for reconciliation, and the configured account read on demand.
const scope = { tracker: 'jira' as const, siteId: 'site-A', url: 'https://equipe.atlassian.net', projectId: '10010', label: 'factory-ready' };
const ref: JiraTicketRef = { tracker: 'jira', siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' };
const at = '2026-11-21T10:00:00.000Z';
const adf = (...lines: string[]) => ({ type: 'doc', version: 1, content: lines.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

function recording(respond: (request: JiraRequest) => JiraResponse) {
  const calls: JiraRequest[] = [];
  return {
    calls,
    transport: {
      request: async (request: JiraRequest) => {
        calls.push(request);
        return respond(request);
      },
    },
  };
}
const answer = (body: unknown, status = 200): JiraResponse => ({ ok: true, status, body, observedAt: at });
const failure = (code: string, status?: number): JiraResponse => ({ ok: false, code, ...(status ? { status } : {}), observedAt: at, nextStep: 'fixed step' });

test('publishComment POSTs one ADF paragraph per line, without visibility, and reports the created comment', async () => {
  const { calls, transport } = recording(() => answer({ id: '10041', created: '2026-11-21T10:00:01.000+0000', author: { accountId: 'acc-factory' } }, 201));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  const result = await tracker.publishComment(ref, { lines: ['[Software Factory · Impedimento I-1]', 'Fix it.'] });
  assert.deepEqual(calls, [
    { method: 'POST', path: '/rest/api/3/issue/81017/comment', body: { body: adf('[Software Factory · Impedimento I-1]', 'Fix it.') } },
  ]);
  assert.deepEqual(result, {
    kind: 'published',
    observedAt: at,
    commentId: '10041',
    createdAt: '2026-11-21T10:00:01.000+0000',
    authorAccountId: 'acc-factory',
    url: 'https://equipe.atlassian.net/browse/PAG-42?focusedCommentId=10041',
  });
});

test('a refused POST is a known failure; a lost or unreadable answer is unknown (the comment may exist)', async () => {
  const outcome = async (response: JiraResponse) => {
    const result = await createJiraTracker({ scopes: [scope], transport: () => recording(() => response).transport }).publishComment(ref, { lines: ['x'] });
    return `${result.kind}:${result.kind === 'published' ? '' : result.code}`;
  };
  for (const [code, status] of [
    ['JIRA_FORBIDDEN', 403],
    ['JIRA_UNAUTHENTICATED', 401],
    ['JIRA_NOT_FOUND', 404],
    ['JIRA_RATE_LIMITED', 429],
    ['JIRA_REQUEST_REJECTED', 400],
    ['JIRA_REQUEST_REFUSED', undefined],
    ['JIRA_CREDENTIAL_UNAVAILABLE', undefined],
  ] as const) {
    assert.equal(await outcome(failure(code, status)), `failed:${code}`);
  }
  for (const code of ['JIRA_TIMEOUT', 'JIRA_TRANSPORT_UNAVAILABLE', 'JIRA_UNAVAILABLE', 'JIRA_RESPONSE_INVALID', 'JIRA_RESPONSE_TOO_LARGE']) {
    assert.equal(await outcome(failure(code)), `unknown:${code}`);
  }
  assert.equal(await outcome(answer({ unexpected: true }, 201)), 'unknown:JIRA_COMMENT_RESPONSE_INVALID');
  const unconfigured = await createJiraTracker({ scopes: [scope], transport: () => recording(() => answer({})).transport }).publishComment(
    { ...ref, siteId: 'site-B' },
    { lines: ['x'] },
  );
  assert.equal(unconfigured.kind, 'failed');
});

const comment = (id: string, lines: string[], accountId = 'acc-factory', extra: Record<string, unknown> = {}) => ({
  id,
  author: { accountId },
  body: adf(...lines),
  created: `2026-11-21T10:0${id.at(-1)}:00.000+0000`,
  updated: `2026-11-21T10:0${id.at(-1)}:00.000+0000`,
  ...extra,
});

test('listComments reads every page in creation order and projects ADF to text', async () => {
  const pages: Record<string, unknown> = {
    0: {
      startAt: 0,
      maxResults: 2,
      total: 3,
      comments: [comment('101', ['a', 'b']), comment('102', ['c'], 'acc-human', { visibility: { type: 'role', value: 'Developers' } })],
    },
    2: { startAt: 2, maxResults: 2, total: 3, comments: [comment('103', ['d'])] },
  };
  const { calls, transport } = recording(request => answer(pages[request.query?.startAt ?? '']));
  const listing = await createJiraTracker({ scopes: [scope], transport: () => transport }).listComments(ref);
  assert.deepEqual(
    calls.map(call => [call.method, call.path, call.query]),
    [
      ['GET', '/rest/api/3/issue/81017/comment', { startAt: '0', maxResults: '100', orderBy: 'created' }],
      ['GET', '/rest/api/3/issue/81017/comment', { startAt: '2', maxResults: '100', orderBy: 'created' }],
    ],
  );
  assert.equal(listing.kind, 'observed');
  if (listing.kind !== 'observed') return;
  assert.deepEqual(
    listing.comments.map(item => [item.commentId, item.authorAccountId, item.text, item.restricted]),
    [
      ['101', 'acc-factory', 'a\nb', false],
      ['102', 'acc-human', 'c', true],
      ['103', 'acc-factory', 'd', false],
    ],
  );
});

test('a failed, empty-before-total or malformed comment page makes the listing unavailable, never a shorter list', async () => {
  const first = { startAt: 0, maxResults: 1, total: 2, comments: [comment('101', ['a'])] };
  const cases: [string, (request: JiraRequest) => JiraResponse][] = [
    ['JIRA_UNAVAILABLE', request => (request.query?.startAt === '0' ? answer(first) : failure('JIRA_UNAVAILABLE', 500))],
    ['JIRA_FORBIDDEN', () => failure('JIRA_FORBIDDEN', 403)],
    ['JIRA_COMMENTS_INCOMPLETE', request => (request.query?.startAt === '0' ? answer(first) : answer({ startAt: 1, maxResults: 1, total: 2, comments: [] }))],
    ['JIRA_OBSERVATION_INVALID', () => answer({ comments: 'no' })],
  ];
  for (const [code, respond] of cases) {
    const listing = await createJiraTracker({ scopes: [scope], transport: () => recording(respond).transport }).listComments(ref);
    assert.equal(listing.kind === 'unavailable' && listing.code, code);
  }
});

test('readAccount reads the configured account on demand', async () => {
  const { calls, transport } = recording(() => answer({ accountId: 'acc-factory', displayName: 'Pessoa' }));
  const account = await createJiraTracker({ scopes: [scope], transport: () => transport }).readAccount('site-A');
  assert.deepEqual(calls, [{ method: 'GET', path: '/rest/api/3/myself' }]);
  assert.deepEqual(account, { kind: 'observed', source: 'jira-rest', observedAt: at, siteId: 'site-A', accountId: 'acc-factory' });
});

test('over the host transport the comment goes to the configured origin with the credential, and the token never appears in the body', async () => {
  const sentinel = 'synthetic-jira-token-SENTINEL';
  const exchanges: JiraHttpExchange[] = [];
  const send = async (exchange: JiraHttpExchange): Promise<JiraHttpResult> => {
    exchanges.push(exchange);
    return {
      kind: 'response',
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '10041', created: at, author: { accountId: 'acc' } }),
    };
  };
  const transport = createJiraHttpTransport({ siteId: 'site-A', url: scope.url, email: 'fabrica@example.org', credential: async () => sentinel }, { send });
  const result = await createJiraTracker({ scopes: [scope], transport: () => transport }).publishComment(ref, { lines: ['hello'] });
  assert.equal(result.kind, 'published');
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]!.url, 'https://equipe.atlassian.net/rest/api/3/issue/81017/comment');
  assert.equal(exchanges[0]!.headers.authorization, `Basic ${Buffer.from(`fabrica@example.org:${sentinel}`).toString('base64')}`);
  assert.doesNotMatch(exchanges[0]!.body ?? '', /SENTINEL/);
  assert.deepEqual(JSON.parse(exchanges[0]!.body!), { body: adf('hello') });
});

// Jira ticket 06: the inputs of a Work are every visible comment of its origin Card, ordered by (created, id), after the processed cursor.
test('readInputs lists every comment after the cursor, in (created, id) order, with author, audience and edit times', async () => {
  const page = {
    startAt: 0,
    maxResults: 100,
    total: 4,
    comments: [
      comment('104', ['/factory sim'], 'acc-human', { created: '2026-11-21T10:05:00.000+0000', updated: '2026-11-21T10:06:00.000+0000' }),
      comment('101', ['antes']),
      comment('103', ['/factory restrito'], 'acc-human', { visibility: { type: 'role', value: 'Developers' } }),
      comment('102', ['[Software Factory · Pergunta Q-1]', '/factory x']),
    ],
  };
  const { calls, transport } = recording(() => answer(page));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  const all = await tracker.readInputs(ref, null);
  assert.equal(all.kind, 'observed');
  if (all.kind !== 'observed') return;
  assert.deepEqual(
    all.comments.map(item => item.ref.commentId),
    ['101', '102', '103', '104'],
  );
  assert.deepEqual(all.comments[3], {
    ref: { tracker: 'jira', siteId: 'site-A', issueId: '81017', commentId: '104' },
    url: 'https://equipe.atlassian.net/browse/PAG-42?focusedCommentId=104',
    author: { tracker: 'jira', accountId: 'acc-human' },
    body: '/factory sim',
    createdAt: '2026-11-21T10:05:00.000+0000',
    updatedAt: '2026-11-21T10:06:00.000+0000',
    restricted: false,
  });
  assert.equal(all.comments[2]!.restricted, true);
  assert.deepEqual(all.cursor, { tracker: 'jira', createdAt: '2026-11-21T10:05:00.000+0000', commentId: '104' });
  const after = await tracker.readInputs(ref, { tracker: 'jira', createdAt: '2026-11-21T10:02:00.000+0000', commentId: '102' });
  assert.deepEqual(after.kind === 'observed' && after.comments.map(item => item.ref.commentId), ['103', '104']);
  // Nothing new: the cursor stays where it was.
  const none = await tracker.readInputs(ref, { tracker: 'jira', createdAt: '2026-11-21T10:05:00.000+0000', commentId: '104' });
  assert.deepEqual(none.kind === 'observed' && [none.comments, none.cursor], [
    [],
    { tracker: 'jira', createdAt: '2026-11-21T10:05:00.000+0000', commentId: '104' },
  ]);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('readInputs concludes nothing from an incomplete comment listing', async () => {
  const { transport } = recording(() => answer({ startAt: 0, maxResults: 100, total: 3, comments: [] }));
  const inputs = await createJiraTracker({ scopes: [scope], transport: () => transport }).readInputs(ref, null);
  assert.deepEqual([inputs.kind, inputs.kind === 'unavailable' && inputs.code], ['unavailable', 'JIRA_COMMENTS_INCOMPLETE']);
});

test('a comment without author or with a body that is not an ADF document is reported as such, never as an empty author or text', async () => {
  const page = {
    startAt: 0,
    maxResults: 100,
    total: 3,
    comments: [
      { ...comment('101', ['/factory sim']), author: undefined },
      { ...comment('102', ['/factory sim']), author: { accountId: '' } },
      { ...comment('103', ['x']), body: { type: 'paragraph', content: 'not adf' } },
    ],
  };
  const { transport } = recording(() => answer(page));
  const tracker = createJiraTracker({ scopes: [scope], transport: () => transport });
  const listing = await tracker.listComments(ref);
  assert.deepEqual(listing.kind === 'observed' && listing.comments.map(item => [item.commentId, item.authorAccountId, item.text]), [
    ['101', null, '/factory sim'],
    ['102', null, '/factory sim'],
    ['103', 'acc-factory', null],
  ]);
  const inputs = await tracker.readInputs(ref, null);
  assert.deepEqual(inputs.kind === 'observed' && inputs.comments.map(item => [item.ref.commentId, item.author, item.body]), [
    ['101', null, '/factory sim'],
    ['102', null, '/factory sim'],
    ['103', { tracker: 'jira', accountId: 'acc-factory' }, null],
  ]);
  assert.deepEqual(inputs.kind === 'observed' && inputs.cursor, { tracker: 'jira', createdAt: '2026-11-21T10:03:00.000+0000', commentId: '103' });
});
