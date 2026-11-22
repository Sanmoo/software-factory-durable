import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration } from '../../src/entrypoints/configuration.js';
import { composeProductionAccess, type JiraSiteAccess } from '../../src/entrypoints/controller/composition.js';
import { createJiraHttpTransport, type JiraTransport } from '../../src/issue-tracker/index.js';
import { openControl } from '../../src/control/index.js';
import type { AccessDependencies, AccessView, Control, ControlStatus, ListView, WorkView } from '../../src/control/index.js';
import type { GitHubAccess } from '../../src/platform/github/index.js';
import type { OwnPullRequestObservation } from '../../src/code-repository/index.js';
import { githubDoubles, manualClock, remoteIssue, type Remote } from '../control/doubles.js';
import { app, executionDoubles, facts, ownPull, type Activation, type Script } from '../control/publication-doubles.js';
import { jiraHttpWorld, jiraOrigin, type HttpCard } from './jira-http-world.js';
import { untilHolds } from '../runner/budget.js';

// Jira ticket 10 (spec §1, §6.4-6.5, §7 "Coexistência"): the PRODUCTION composition of the Ticket sources and of the Jira adapter
// (`composeProductionAccess` over the real config.yaml, the host HTTPS transport with its token file read on every request, and a raw
// HTTP Jira double), with the GitHub contracts doubled (`githubDoubles`; the GitHub adapters over the gh fixture are the subject of
// journey-composed.test.ts) and real Control + Pi Durable + SQLite in mkdtemp, injected clock. Synthetic IDs; no real tenant.
const sentinel = 'synthetic-jira-token-SENTINEL-7d1e';
const cardUrl = `${jiraOrigin}/browse/PAG-42`;
const prUrl = 'https://github.com/acme/project/pull/4';
const qid = '0b9c6a52-3d3e-4c8f-9a51-000000000042';
const header = `operators: [operator-one]
models:
  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
githubApp: {appId: 1, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: acme/project, base: main, installationId: 2, workflows: false, label: ready-for-agent}
`;
const v1 = `schemaVersion: 1\n${header}`;
const v2 = (discover: boolean) => `schemaVersion: 2\n${header}ticketSources:
  - {tracker: github, repository: acme/project, discover: true}
  - tracker: jira
    discover: ${discover}
    siteId: site-A
    url: ${jiraOrigin}
    email: fabrica@example.org
    tokenFile: credentials/jira-token
    projectId: '10010'
    label: factory-ready
    routes:
      - {componentId: '10022', repository: acme/project}
`;
const pag = (id: string, key: string): HttpCard => ({ id, key, projectId: '10010', labels: ['factory-ready'], components: ['10022'], summary: `Summary ${key}`,
  description: 'Add the payment note.' });

/** The GitHub boundary the composition receives: never reached here (the GitHub contracts are doubled), every call recorded. */
function unreachableGitHub() {
  const calls: string[] = [];
  return { calls, github: new Proxy({ appId: 1 } as unknown as GitHubAccess, { get(_target, property) {
    if (property === 'appId') return 1;
    if (property === 'then') return undefined;
    return async () => { calls.push(String(property)); throw new Error('GITHUB_BOUNDARY_NOT_USED'); };
  } }) };
}

/** The Jira Work's Builder publishes its own PR from its own branch, with the Card reference (no closing keyword). */
const publishJira = (remote: Remote, activation: Activation) => {
  const { workId, branch, head } = facts(activation.prompt);
  (remote.refs ??= {})[branch] = head;
  const body = [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the note.', `Jira Card PAG-42: ${cardUrl}`, '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n');
  remote.pulls[0] = [...(remote.pulls[0] ?? []), ownPull(workId, branch, head, { association: ['known-branch'], body })];
};
/** A GitHub Work's Builder: its own PR closing its issue. */
const publishGitHub = (number: number) => (remote: Remote, activation: Activation) => {
  const { workId, branch, head } = facts(activation.prompt);
  (remote.refs ??= {})[branch] = head;
  const body = [`<!-- software-factory:work:${workId} -->`, '## Summary', `Adds the note. Closes #${number}`, '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n');
  remote.pulls[number] = [...(remote.pulls[number] ?? []), ownPull(workId, branch, head, { body })];
};

async function harness(t: { after(fn: () => Promise<void>): void }, options: { remote: Remote; cards: HttpCard[]; scripts: Script[] }) {
  const root = await mkdtemp(join(tmpdir(), 'factory-jira-coexistence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  const tokenPath = join(root, 'credentials', 'jira-token');
  const restoreToken = () => writeFile(tokenPath, `${sentinel}\n`, { mode: 0o600 });
  await restoreToken();
  const { remote } = options;
  const github = githubDoubles(remote);
  const world = jiraHttpWorld(options.cards);
  const githubBoundary = unreachableGitHub();
  const execution = executionDoubles(remote, options.scripts);
  // Every Jira site the composition creates and every credential read the host transport makes (v1 must show none).
  const sites: string[] = [];
  let credentialReads = 0;
  const transport = (site: JiraSiteAccess): JiraTransport => {
    sites.push(site.siteId);
    return createJiraHttpTransport({ ...site, credential: () => { credentialReads += 1; return site.credential(); } }, { send: world.send });
  };
  const readOwnMerge = async (pr: { number: number }): Promise<OwnPullRequestObservation> => {
    const pull = Object.values(remote.pulls).flat().find(item => item.number === pr.number)!;
    return { kind: 'observed', source: 'github-rest', observedAt: new Date().toISOString(), repositoryId: 3, pullRequest: { pullRequestId: pull.pullRequestId, nodeId: pull.nodeId,
      number: pull.number, url: pull.url, state: pull.state, draft: pull.draft, merged: pull.merged, mergedAt: pull.merged ? '2026-11-20T12:00:00Z' : null,
      mergeCommitSha: pull.merged ? 'b'.repeat(40) : null, headRef: pull.headRef, headSha: pull.headSha, headRepositoryId: 3, baseRef: pull.baseRef, baseRepositoryId: 3,
      reported: { mergeCommitSha: pull.merged ? 'value' : 'null', merged: 'value' } } };
  };
  const storagePath = join(root, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock>; access: AccessDependencies } | undefined;
  async function start(yaml: string) {
    await writeFile(join(root, 'config.yaml'), yaml);
    const configuration = (await readConfiguration(root)).configuration;
    assert.equal(configuration.valid, true, JSON.stringify(configuration));
    if (!configuration.valid) throw new Error('unreachable');
    const composed = composeProductionAccess({ root, github: githubBoundary.github, effective: configuration.effective, jira: { transport } });
    const tracker = { ...github.tracker, checkAccess: async () => ({ status: 'ok' }) as never };
    const access: AccessDependencies = { ...composed, tracker, repository: { ...github.repository, readOwnMerge, checkAccess: async () => ({ status: 'ok' }) as never }, factoryApp: async () => app };
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: execution.ports, access, polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time, access };
    await time.sleeping();
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const works = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works as WorkView[];
  const jiraWork = async () => (await works()).find(item => item.ticket.tracker === 'jira');
  const githubWork = async () => (await works()).find(item => item.ticket.tracker === 'github');
  const status = async () => (await current!.control.inspect({ kind: 'status' })) as ControlStatus;
  const doctor = async () => (await current!.control.inspect({ kind: 'access' })) as AccessView;
  const settle = (label: string, predicate: () => Promise<boolean>) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (current!.time.isSleeping()) current!.time.advance();
    return false;
  }, 5);
  const cycles = async (n: number) => { for (let i = 0; i < n; i++) { await current!.time.sleeping(); current!.time.advance(); } await current!.time.sleeping(); };
  const mergeAll = () => { for (const pull of Object.values(remote.pulls).flat()) { pull.state = 'closed'; pull.merged = true; } };
  /** Everything the sentinel must never reach: views, durable storage bytes, prompts, comments. */
  const leaks = async () => {
    const views = JSON.stringify([await works(), await status()]);
    const stored = (await Promise.all((await readdir(root)).filter(name => name.startsWith('control.sqlite')).map(name => readFile(join(root, name))))).map(item => item.toString('latin1')).join('');
    const prompts = JSON.stringify(execution.calls);
    const comments = JSON.stringify(world.comments);
    return { views: views.includes(sentinel), stored: stored.includes(sentinel), prompts: prompts.includes(sentinel), comments: comments.includes(sentinel) };
  };
  return { root, remote, github, world, execution, githubBoundary, sites, credentialReads: () => credentialReads, start, stop, works, jiraWork, githubWork, status, doctor, settle,
    cycles, mergeAll, leaks, restoreToken, removeToken: () => rm(tokenPath), access: () => current!.access };
}

/** Only reads plus the comment, remote link and JQL search POSTs: never a status, assignee or resolution write, never another origin. */
function onlyAllowedJira(world: ReturnType<typeof jiraHttpWorld>) {
  assert.deepEqual(world.unexpected, []);
  for (const request of world.requests()) assert.ok(request.startsWith('GET ') || /^POST \/rest\/api\/3\/(search\/jql|issue\/\d+\/(comment|remotelink))$/.test(request), request);
}

test('v2 with GitHub acme/project#42 and Jira PAG-42 to the same destination: two Works with distinct origins; the Card runs to its answer, PR, merge, link and notice', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(42, { blockedBy: [41] }), remoteIssue(41, { labels: [] })] };
  const h = await harness(t, { remote, cards: [pag('81042', 'PAG-42')], scripts: [
    { kind: 'ask', head: 'd'.repeat(40), question: 'Preservo a API v1?', questionId: qid }, { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishJira, end: 'success' }] });
  await h.start(v2(true));
  await h.settle('both Tickets admitted', async () => (await h.works()).length === 2);
  const [github, jira] = [(await h.githubWork())!, (await h.jiraWork())!];
  assert.deepEqual([github.ticket.tracker, github.ticket.number, github.repository.repository], ['github', 42, 'acme/project']);
  assert.equal(jira.ticket.tracker, 'jira');
  if (jira.ticket.tracker !== 'jira') return;
  assert.deepEqual([jira.ticket.key, jira.ticket.issueId, jira.ticket.siteId, jira.repository.repository], ['PAG-42', '81042', 'site-A', 'acme/project']);
  assert.notEqual(github.work_id, jira.work_id, 'same apparent number and destination, two identities');

  // The Jira Work asks; the Question goes to its origin Card (never to acme/project#42) and the answer comes from the Card.
  await h.settle('Question published on the Card', async () => h.world.posted('81042').some(text => text.startsWith('[Software Factory · Pergunta Q-1]')));
  h.world.write('81042', '/factory sim, preserve a API');
  await h.settle('answered, resumed, published and linked', async () => (await h.status()).jiraLinks?.confirmed === 1);
  assert.equal((await h.jiraWork())!.pullRequest?.url, prUrl);
  h.mergeAll();
  await h.settle('delivered, notice published', async () => (await h.jiraWork())!.result === 'delivered' &&
    h.world.posted('81042').some(text => text.startsWith('[Software Factory · Entrega T-')));
  await h.settle('link Entregue', async () => Object.values(h.world.links['81042'] ?? {}).some(link => link.title.endsWith('· Entregue')));
  await h.cycles(2);
  assert.deepEqual(Object.values(h.world.links['81042']!).map(link => [link.url, link.title]), [[prUrl, 'Trabalho T-2 · Entregue']]);
  assert.deepEqual(h.world.posted('81042').filter(text => text.startsWith('[Software Factory · Entrega')), [`[Software Factory · Entrega T-2] O PR foi integrado a main: ${prUrl}`],
    'told once, on the origin Card');

  // The GitHub Work keeps the GitHub rules (still waiting for its native blocker) and was never written by the Jira flow.
  const after = (await h.githubWork())!;
  assert.deepEqual([after.result, after.queue.pending, after.dispatch.reasons], ['open', true, ['DEPENDENCY_PENDING']]);
  assert.deepEqual(h.github.calls.filter(call => call.method === 'postComment'), [], 'no GitHub comment: the Question lived on the Card');
  onlyAllowedJira(h.world);
  // Positive control: the host transport did read the token file and send it as basic auth; it reached nothing else.
  assert.ok(h.credentialReads() > 0);
  assert.ok(h.world.exchanges.every(exchange => Buffer.from((exchange.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString() === `fabrica@example.org:${sentinel}`));
  assert.deepEqual(await h.leaks(), { views: false, stored: false, prompts: false, comments: false });
  assert.deepEqual(h.githubBoundary.calls, []);
});

test('discover: false admits no new Card of the source, yet the existing Work keeps its Card; without the token its effects stay pending locally and resume when it is restored', async t => {
  const cards = [pag('81042', 'PAG-42')];
  const h = await harness(t, { remote: { pulls: {}, issues: [] }, cards, scripts: [
    { kind: 'ask', head: 'd'.repeat(40), question: 'Preservo a API v1?', questionId: qid }, { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishJira, end: 'success' }] });
  await h.start(v2(true));
  await h.settle('Question published on the Card', async () => h.world.posted('81042').some(text => text.startsWith('[Software Factory · Pergunta Q-1]')));
  await h.stop();

  // Suspended: the source is still configured, discovery is off. A newly marked Card is never listed nor admitted.
  cards.push(pag('81043', 'PAG-43'));
  const searches = () => h.world.requests().filter(request => request === 'POST /rest/api/3/search/jql').length;
  const before = searches();
  await h.start(v2(false));
  assert.equal(h.access().sources?.find(source => source.tracker === 'jira')?.discover, false);
  h.world.write('81042', '/factory sim, preserve a API');
  await h.settle('answered on the persisted Card, resumed, published and linked', async () => (await h.status()).jiraLinks?.confirmed === 1);
  assert.equal(searches(), before, 'no Jira listing while discovery is off');
  assert.deepEqual((await h.works()).map(work => work.ticket.tracker === 'jira' ? work.ticket.key : null), ['PAG-42'], 'PAG-43 was not admitted');
  assert.ok(!h.world.requests().some(request => request.includes('/issue/81043')), 'the new Card is never read');

  // The token file is removed: the merge is still Delivered from GitHub; the Card's link and notice stay pending, diagnosed locally.
  await h.removeToken();
  h.mergeAll();
  await h.settle('delivered from GitHub alone', async () => (await h.jiraWork())!.result === 'delivered');
  const work = (await h.jiraWork())!;
  await h.cycles(8);
  const status = await h.status();
  const notice = status.jiraNotices!.unpublished.find(item => item.purpose.kind === 'delivery')!;
  assert.ok(notice, 'the delivery notice is pending, never abandoned while the credential is missing');
  assert.equal(notice.state, 'failed', 'retried every poll (nothing was sent), never abandoned while the credential is missing');
  assert.deepEqual([notice.destination.key, (notice.purpose as { workId?: string }).workId, notice.diagnostic?.code], ['PAG-42', work.work_id, 'JIRA_CREDENTIAL_UNAVAILABLE']);
  assert.match(notice.diagnostic!.nextStep, /tokenFile/);
  const link = status.jiraLinks!.pending.find(item => item.workId === work.work_id)!;
  assert.deepEqual([link.destination.key, link.desired, link.diagnostic?.code], ['PAG-42', 'delivered', 'JIRA_CREDENTIAL_UNAVAILABLE']);
  assert.equal(h.world.posted('81042').filter(text => text.startsWith('[Software Factory · Entrega')).length, 0, 'nothing sent without the token');

  // Restored: the same effects complete on the same Card, once; nothing is redirected to GitHub, no operator command is needed.
  await h.restoreToken();
  await h.settle('notice and link settled after the token returns', async () => (await h.status()).jiraLinks?.pending.length === 0 &&
    !(await h.status()).jiraNotices!.unpublished.some(item => item.purpose.kind === 'delivery'));
  await h.cycles(2);
  assert.deepEqual(h.world.posted('81042').filter(text => text.startsWith('[Software Factory · Entrega')), [`[Software Factory · Entrega T-1] O PR foi integrado a main: ${prUrl}`]);
  assert.deepEqual(Object.values(h.world.links['81042']!).map(item => item.title), ['Trabalho T-1 · Entregue']);
  assert.deepEqual(h.github.calls.filter(call => call.method === 'postComment'), [], 'never redirected to GitHub');
  onlyAllowedJira(h.world);
  assert.deepEqual(await h.leaks(), { views: false, stored: false, prompts: false, comments: false });
});

test('YAML v1: the GitHub flow runs to delivery without creating a Jira client, reading the Jira token or calling Jira', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(42)] };
  const h = await harness(t, { remote, cards: [pag('81042', 'PAG-42')], scripts: [{ kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishGitHub(42), end: 'success' }] });
  await h.start(v1);
  assert.equal(h.access().trackers?.jira, undefined);
  await h.settle('GitHub Work published', async () => (await h.githubWork())?.pullRequest?.number === 4);
  h.mergeAll();
  await h.settle('GitHub Work delivered', async () => (await h.githubWork())?.result === 'delivered');
  await h.cycles(2);
  assert.deepEqual((await h.works()).map(work => work.ticket.tracker), ['github']);
  // The marked Card exists in the Jira double (the v2 tests show it is listed and admitted there): here nothing reached it.
  assert.deepEqual([h.sites, h.credentialReads(), h.world.exchanges.length], [[], 0, 0]);
  assert.equal((await h.status()).jiraNotices, undefined);
  assert.equal((await h.status()).jiraLinks, undefined);
});

test('factory doctor diagnoses the Jira account beside GitHub: permissions as facts; a missing token blocks with a local diagnostic and nothing else', async t => {
  const h = await harness(t, { remote: { pulls: {}, issues: [] }, cards: [], scripts: [] });
  await h.start(v2(true));
  const granted = (await h.doctor()).jiraResults!;
  assert.deepEqual(granted.map(item => [item.siteId, item.projectId, item.status, item.code]), [['site-A', '10010', 'ok', 'JIRA_ACCESS_OK']]);
  assert.deepEqual(granted[0]!.facts, { projectRead: 'granted', commentCreate: 'granted', remoteLinks: 'granted', commentAudience: 'unverified', blockerVisibility: 'unverified' });
  await h.removeToken();
  const missing = (await h.doctor()).jiraResults![0]!;
  assert.deepEqual([missing.status, missing.code], ['blocked', 'JIRA_CREDENTIAL_UNAVAILABLE']);
  assert.match(missing.nextStep, /tokenFile/);
  assert.ok(h.world.requests().every(request => request.startsWith('GET ') || request === 'POST /rest/api/3/search/jql'), 'the diagnosis only reads');
  assert.doesNotMatch(JSON.stringify(await h.doctor()), /SENTINEL/);
});

test('an exact /factory cancel on the Card cancels only that Card\'s Work, with its reply on the Card; the GitHub Work of the same number is untouched', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(42, { blockedBy: [41] }), remoteIssue(41, { labels: [] })] };
  const h = await harness(t, { remote, cards: [pag('81042', 'PAG-42')], scripts: [{ kind: 'ask', head: 'd'.repeat(40), question: 'Preservo a API v1?', questionId: qid }] });
  await h.start(v2(false));
  await h.settle('GitHub Ticket admitted', async () => (await h.githubWork()) !== undefined);
  assert.equal(await h.jiraWork(), undefined, 'discover:false from the start: the marked Card is never admitted');
  assert.ok(!h.world.requests().includes('POST /rest/api/3/search/jql'));
  await h.stop();
  await h.start(v2(true));
  await h.settle('Question published on the Card', async () => h.world.posted('81042').some(text => text.startsWith('[Software Factory · Pergunta Q-1]')));
  h.world.write('81042', '/factory cancel', 'acc-human');
  await h.settle('cancelled, reply on the Card', async () => (await h.jiraWork())!.result === 'cancelled' &&
    h.world.posted('81042').some(text => text.startsWith('[Software Factory · Cancelamento R-')));
  const github = (await h.githubWork())!;
  assert.deepEqual([github.result, github.queue.pending], ['open', true]);
  assert.deepEqual(h.github.calls.filter(call => call.method === 'postComment'), [], 'no GitHub write');
  onlyAllowedJira(h.world);
});
