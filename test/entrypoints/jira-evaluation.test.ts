import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration } from '../../src/entrypoints/configuration.js';
import { composeProductionAccess } from '../../src/entrypoints/controller/composition.js';
import { evaluateJiraSource } from '../../src/control/index.js';
import type { TicketSource } from '../../src/control/index.js';
import type { GitHubAccess } from '../../src/platform/github/index.js';
import type { JiraHttpExchange, JiraHttpResult } from '../../src/issue-tracker/index.js';

// Jira ticket 03 (spec §3 steps 1-3): the production composition (host HTTPS transport over a recording in-process HTTP double, token
// file on disk) evaluates the Jira source's candidates WITHOUT admission: it lists every JQL page, re-reads each candidate by ID and
// decides eligible / blocked / unverifiable / not-candidate. No Work, no comment, no dispatch: the only requests are reads.
const sentinel = 'synthetic-jira-token-SENTINEL';
const origin = 'https://equipe.atlassian.net';
const yaml = `schemaVersion: 2
operators: [operator-one]
models:
  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
githubApp: {appId: 123, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: equipe/checkout-web, base: main, installationId: 456, workflows: false}
  - {repository: equipe/payments-api, base: main, installationId: 456, workflows: false}
ticketSources:
  - tracker: jira
    discover: true
    siteId: site-A
    url: ${origin}
    email: fabrica@example.org
    tokenFile: credentials/jira-token
    projectId: '10010'
    label: factory-ready
    routes:
      - {componentId: '10021', repository: equipe/checkout-web}
      - {componentId: '10022', repository: equipe/payments-api}
`;

const blocks = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const blockedBy = (id: string, key: string) => ({ id: `9${id}`, type: blocks, inwardIssue: { id, key } });
const issue = (id: string, key: string, fields: { labels?: string[]; components?: string[]; issuelinks?: unknown[] }) => ({ id, key, fields: {
  labels: fields.labels ?? ['factory-ready'], components: (fields.components ?? ['10022']).map(component => ({ id: component, name: `c${component}` })),
  issuelinks: fields.issuelinks ?? [], summary: `Summary ${key}`, project: { id: '10010' }, status: { statusCategory: { key: 'new' } } } });

/** The Jira site as raw HTTP: every exchange is recorded, unexpected ones included (answered 404). */
function jiraWorld() {
  const exchanges: JiraHttpExchange[] = [];
  const unexpected: string[] = [];
  const json = (body: unknown, status = 200): JiraHttpResult => ({ kind: 'response', status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const tickets: Record<string, unknown> = {
    81017: issue('81017', 'PAG-42', { issuelinks: [blockedBy('70202', 'OPS-9'), { id: '9812', type: blocks, outwardIssue: { id: '70203', key: 'PAG-50' } }] }),
    81018: issue('81018', 'PAG-43', { issuelinks: [blockedBy('70301', 'OPS-10')] }),
    81019: issue('81019', 'PAG-44', { labels: ['other'] }),
    // Listed while it had Pagamentos; the re-read sees Checkout only: the current route wins.
    81020: issue('81020', 'PAG-45', { components: ['10021', '10099'] }),
    81021: issue('81021', 'PAG-46', { issuelinks: [blockedBy('70404', 'SEC-1')] }),
  };
  const statuses: Record<string, string> = { 70202: 'done', 70301: 'indeterminate' };
  const send = async (exchange: JiraHttpExchange): Promise<JiraHttpResult> => {
    exchanges.push(exchange);
    const url = new URL(exchange.url);
    if (exchange.method === 'POST' && url.pathname === '/rest/api/3/search/jql') {
      const body = JSON.parse(exchange.body!) as { nextPageToken?: string };
      const ids = body.nextPageToken === 'P2' ? ['81020', '81021'] : ['81017', '81018', '81019'];
      return json({ issues: ids.map(id => ({ id, key: (tickets[id] as { key: string }).key, fields: { project: { id: '10010' } } })),
        ...(body.nextPageToken === 'P2' ? { isLast: true } : { isLast: false, nextPageToken: 'P2' }) });
    }
    if (exchange.method === 'GET' && url.pathname === '/rest/api/3/issueLinkType') return json({ issueLinkTypes: [blocks] });
    const id = /^\/rest\/api\/3\/issue\/(\d+)$/.exec(url.pathname)?.[1];
    if (exchange.method === 'GET' && id && url.searchParams.get('fields') === 'status') {
      if (id === '70404') return json({ errorMessages: ['restricted'] }, 403);
      if (statuses[id]) return json({ id, key: `N-${id}`, fields: { status: { name: 'Local column', statusCategory: { key: statuses[id] } } } });
    }
    if (exchange.method === 'GET' && id && tickets[id] && url.searchParams.get('fields') !== 'status') return json(tickets[id]);
    unexpected.push(`${exchange.method} ${exchange.url}`);
    return json({}, 404);
  };
  return { exchanges, unexpected, send };
}

function recordingGitHub() {
  const calls: string[] = [];
  const github = new Proxy({ appId: 123 } as unknown as GitHubAccess, { get(_target, property) {
    if (property === 'appId') return 123;
    if (property === 'then') return undefined;
    return async () => { calls.push(String(property)); return { ok: false, observedAt: new Date().toISOString(), code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'synthetic' }; };
  } });
  return { github, calls };
}

async function composed(send: (exchange: JiraHttpExchange) => Promise<JiraHttpResult>, config = yaml) {
  const root = await mkdtemp(join(tmpdir(), 'factory-jira-evaluation-'));
  await chmod(root, 0o700);
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  await writeFile(join(root, 'credentials', 'jira-token'), `${sentinel}\n`, { mode: 0o600 });
  await writeFile(join(root, 'config.yaml'), config);
  const configuration = (await readConfiguration(root)).configuration;
  assert.equal(configuration.valid, true, JSON.stringify(configuration));
  if (!configuration.valid) throw new Error('unreachable');
  const github = recordingGitHub();
  const access = composeProductionAccess({ root, github: github.github, effective: configuration.effective, jira: { send } });
  const source = access.sources!.find((item): item is Extract<TicketSource, { tracker: 'jira' }> => item.tracker === 'jira')!;
  return { root, access, source, githubCalls: github.calls };
}

test('the Jira source is evaluated over the host transport: every page, a fresh re-read by ID and one decision per candidate, without admission', async () => {
  const world = jiraWorld();
  const { root, access, source, githubCalls } = await composed(world.send);
  try {
    const result = await evaluateJiraSource({ tracker: access.trackers!.jira!, source, authorizedRepositories: access.repositories.map(item => item.repository) });
    assert.equal(result.kind, 'evaluated');
    if (result.kind !== 'evaluated') return;
    const decisions = Object.fromEntries(result.candidates.map(item => [item.ticket.key, item.evaluation.decision]));
    assert.deepEqual(decisions, { 'PAG-42': 'eligible', 'PAG-43': 'blocked', 'PAG-44': 'not-candidate', 'PAG-45': 'eligible', 'PAG-46': 'unverifiable' });
    const byKey = (key: string) => result.candidates.find(item => item.ticket.key === key)!;
    assert.deepEqual(byKey('PAG-42').evaluation, { decision: 'eligible', repository: 'equipe/payments-api', reasons: [] });
    assert.deepEqual(byKey('PAG-45').evaluation, { decision: 'eligible', repository: 'equipe/checkout-web', reasons: [] }, 'route of the re-read, not of the listing');
    const fact = byKey('PAG-42').blockers;
    assert.equal(fact?.kind, 'observed');
    if (fact?.kind !== 'observed') return;
    assert.deepEqual([fact.source, fact.coverage, fact.root.issueId, fact.blockers], ['jira-rest', 'visible', '81017', [{ issueId: '70202', key: 'N-70202', statusCategory: 'done' }]]);
    assert.ok(fact.limitations.length > 0 && fact.observedAt.length > 0, 'origin, instant and visible coverage, never global completeness');
    assert.equal(byKey('PAG-46').blockers?.kind, 'unavailable', 'a 403 neighbour is unverifiable, never an empty list');
    assert.deepEqual(byKey('PAG-43').evaluation.reasons.map(reason => reason.code), ['JIRA_BLOCKER_NOT_DONE']);

    // Positive control and boundaries: calls were made, only reads, only toward the configured origin, each with basic auth.
    assert.ok(world.exchanges.length > 0);
    assert.deepEqual(world.unexpected, []);
    for (const exchange of world.exchanges) {
      assert.ok(exchange.url.startsWith(`${origin}/rest/api/3/`), exchange.url);
      assert.ok(exchange.method === 'GET' || new URL(exchange.url).pathname === '/rest/api/3/search/jql', `${exchange.method} ${exchange.url}`);
      assert.match(exchange.headers.authorization ?? '', /^Basic /);
    }
    const paths = world.exchanges.map(exchange => `${exchange.method} ${new URL(exchange.url).pathname}${new URL(exchange.url).search}`);
    assert.equal(paths.filter(path => path.startsWith('POST /rest/api/3/search/jql')).length, 2, 'both JQL pages');
    assert.equal(paths.filter(path => path === 'GET /rest/api/3/issueLinkType').length, 1, 'catalogue read once per evaluation');
    assert.ok(!paths.some(path => path.includes('/issue/70203')), 'the neighbour the Card blocks is never read');
    assert.ok(!paths.some(path => path.includes('/issue/81019?fields=status')), 'a removed label stops before any blocker read');
    assert.deepEqual(githubCalls, [], 'no GitHub call: nothing is admitted, published or dispatched');
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL/, 'the token never reaches an observation or a reason');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a listing that cannot reach its last page evaluates nothing and re-reads nothing', async () => {
  const world = jiraWorld();
  const send = async (exchange: JiraHttpExchange): Promise<JiraHttpResult> => {
    const body = exchange.body ? JSON.parse(exchange.body) as { nextPageToken?: string } : {};
    if (body.nextPageToken === 'P2') { world.exchanges.push(exchange); return { kind: 'failed', reason: 'timeout' }; }
    return world.send(exchange);
  };
  const { root, access, source } = await composed(send);
  try {
    const result = await evaluateJiraSource({ tracker: access.trackers!.jira!, source, authorizedRepositories: access.repositories.map(item => item.repository) });
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.kind === 'unavailable' && result.listing.code, 'JIRA_TIMEOUT');
    assert.deepEqual(world.exchanges.map(exchange => exchange.method), ['POST', 'POST'], 'no re-read after an incomplete listing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a custom link type blocks until the operator indicates it in the source\'s linkTypes; then its direction decides', async () => {
  const depends = { id: '10500', name: 'Depends', inward: 'depends on', outward: 'is depended on by' };
  const world = jiraWorld();
  const send = async (exchange: JiraHttpExchange): Promise<JiraHttpResult> => {
    const url = new URL(exchange.url);
    const json = (body: unknown): JiraHttpResult => ({ kind: 'response', status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (url.pathname === '/rest/api/3/issueLinkType') { world.exchanges.push(exchange); return json({ issueLinkTypes: [blocks, depends] }); }
    if (url.pathname === '/rest/api/3/issue/81018' && url.searchParams.get('fields') !== 'status') {
      world.exchanges.push(exchange);
      return json(issue('81018', 'PAG-43', { issuelinks: [{ id: '9900', type: depends, inwardIssue: { id: '70301', key: 'OPS-10' } }] }));
    }
    return world.send(exchange);
  };
  const decide = async (config: string) => {
    const { root, access, source } = await composed(send, config);
    try {
      const result = await evaluateJiraSource({ tracker: access.trackers!.jira!, source, authorizedRepositories: access.repositories.map(item => item.repository) });
      assert.equal(result.kind, 'evaluated');
      return result.kind === 'evaluated' ? result.candidates.find(item => item.ticket.key === 'PAG-43')!.evaluation : undefined;
    } finally { await rm(root, { recursive: true, force: true }); }
  };
  const unindicated = await decide(yaml);
  assert.deepEqual(unindicated?.reasons.map(reason => reason.code), ['JIRA_LINK_TYPE_CUSTOM']);
  assert.match(unindicated?.reasons[0]?.nextStep ?? '', /linkTypes.*10500/);
  const inward = await decide(yaml.replace('    routes:\n', "    linkTypes: [{id: '10500', blocks: inward}]\n    routes:\n"));
  assert.deepEqual(inward?.reasons.map(reason => reason.code), ['JIRA_BLOCKER_NOT_DONE'], 'the indicated neighbour is read and blocks');
  const none = await decide(yaml.replace('    routes:\n', "    linkTypes: [{id: '10500', blocks: none}]\n    routes:\n"));
  assert.deepEqual(none?.decision, 'eligible');
});
