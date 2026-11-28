import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfiguration } from '../../src/entrypoints/configuration.js';
import { composeProductionAccess, composeProductionExecution, composeProductionTriage } from '../../src/entrypoints/controller/composition.js';
import { productionProfile } from '../../src/entrypoints/release.js';
import type { JiraHttpExchange } from '../../src/issue-tracker/index.js';
import { createGitHubAccess, type GitHubAccess } from '../../src/platform/github/index.js';
import { inspectStorage } from '../../src/control/index.js';
import type { AccessDependencies, ExecutionPorts, ListView, ShowView, TriagePorts, TriageRequest, WorkView } from '../../src/control/index.js';
import { githubDoubles, type Remote } from '../control/doubles.js';
import { app, executionDoubles, facts, ownPull, type Activation, type Script } from '../control/publication-doubles.js';
import { call, firstPrompt, toolResults, triageWorld, type ModelTurn } from '../control/triage-investigation-fixture.js';
import { untilHolds } from '../runner/budget.js';
import { builderGh, githubWorld, issue } from './github-world-fixture.js';
import { jiraHttpServer, jiraHttpWorld, jiraOrigin, type HttpCard } from './jira-http-world.js';

// The journey of one Ticket from `needs-triage` to its admitted Work, one case per origin, with
// the Control restarted between the publication of the Verdict and the discovery of the admission label.
//
// What runs: `config.yaml` schema 3 read by `readConfiguration`, then the PRODUCTION access composition (`composeProductionAccess`) over
// the gh world (GitHub case: real adapters, issuer and `gh` transport) or over the Jira HTTP world served on a local port (Jira case:
// the production transport, its raw exchange sent to 127.0.0.1); real Control, Pi Durable and SQLite; the real Triager agent and session
// under a scripted model provider. The Triage ports take their numbers (limits, time, capacity, attempts) from `composeProductionTriage`.
//
// What is substituted, and therefore NOT proven here: the Investigation Environment is the in-process one (the real unit is the subject
// of triager-agent.test.ts), the Triager's model profile is the fixture key profile, never the production OAuth one, the candidate is
// cloned from a local upstream, and the Builder, the reviewers and the Sandbox are scripted doubles. In the Jira case the GitHub side of
// the destination repository is `githubDoubles`. No model, credential, tenant or VM is real.
const model = `{provider: ${productionProfile.model.providerId}, model: ${productionProfile.model.modelId}}`;
const head = `schemaVersion: 3
operators: [operator-one]
models:
  builder: ${model}
  standards: ${model}
  spec: ${model}
  triager: ${model}
githubApp: {appId: 1, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: acme/project, base: main, installationId: 2, workflows: false, label: ready-for-agent}
`;
const githubYaml = `${head}ticketSources:
  - {tracker: github, repository: acme/project, discover: true, triage: {}}
`;
const jiraYaml = `${head}ticketSources:
  - {tracker: github, repository: acme/project, discover: true}
  - tracker: jira
    discover: true
    siteId: site-A
    url: ${jiraOrigin}
    email: fabrica@example.org
    tokenFile: credentials/jira-token
    projectId: '10010'
    label: factory-ready
    triage: {}
    routes:
      - {componentId: '10022', repository: acme/project}
`;

/** Only in the Triager's session (a tool result of its investigation): raw evidence, which the Verdict does not transcribe. */
const rawEvidence = 'RAW-EVIDENCE-7f3a91';
const verdictText = [
  'Observed: `total` in cart.js sums the prices and never subtracts the coupon.',
  'Inferred: the discount is lost in the cart total, not in the checkout.',
  'Brief: subtract the coupon value in `total` and cover it with a test of a cart with one coupon.',
].join('\n');
/** The investigation: one command in the environment (its output is the raw evidence), then the Verdict. */
const investigation = (verdict: object): ModelTurn[] => [
  () => call('bash', { command: `echo ${rawEvidence}` }),
  body => {
    assert.ok(
      toolResults(body).some(result => result.includes(rawEvidence)),
      'the command ran in the Investigation Environment',
    );
    return call('concluir_triagem', verdict);
  },
];
const sha = 'd'.repeat(40);
type World = Awaited<ReturnType<typeof triageWorld>>;

async function effectiveOf(root: string, yaml: string) {
  await writeFile(join(root, 'config.yaml'), yaml);
  const { configuration } = await readConfiguration(root, undefined, { triageHost: async () => [] });
  assert.equal(configuration.valid, true, JSON.stringify(configuration));
  if (!configuration.valid) throw new Error('unreachable');
  assert.deepEqual(configuration.effective.triage, { status: 'on' });
  return configuration.effective;
}
/** What the production composition decides of the Triage ports; the environment, the Triager and the clones stay the fixture's. */
async function productionTriageNumbers(input: Parameters<typeof composeProductionTriage>[0]): Promise<Partial<TriagePorts>> {
  const composed = await composeProductionTriage(input);
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') throw new Error('unreachable');
  const { release, limits, investigationMinutes, capacity, attempts } = composed.ports;
  return { release, limits, investigationMinutes, capacity, attempts };
}

const works = async (w: World) => ((await w.control().inspect({ kind: 'list' })) as ListView).works as WorkView[];
const shown = async (w: World, work: WorkView) => (await w.control().inspect({ kind: 'show', work_id: work.work_id })) as Extract<ShowView, { kind: 'work' }>;
/** Polls until the condition holds; bounded by the runner budget, never by a count. */
const settle = (w: World, label: string, predicate: () => Promise<boolean>) =>
  untilHolds(
    label,
    async () => {
      if (await predicate()) return true;
      await w.poll();
      return false;
    },
    5,
  );
/** The request once its Verdict is published, with the Control asleep right after that pass: no polling cycle ran since. */
async function published(w: World): Promise<TriageRequest> {
  await settle(w, 'the Verdict published', async () => ['concluded', 'abandoned', 'failed'].includes((await w.requests())[0]?.state ?? ''));
  const [request] = await w.requests();
  assert.deepEqual([request!.state, request!.end?.code], ['concluded', 'VERDICT_PUBLISHED'], JSON.stringify(request));
  assert.deepEqual(
    request!.intended!.map(effect => effect.status),
    request!.intended!.map(() => 'confirmed'),
  );
  return request!;
}
/** Every text of `value` without the comment published on the Ticket (the one thing of the Triage the tracker carries on). */
const withoutPublished = (value: unknown, comment: string) => {
  const lines = comment.split('\n').filter(line => line.trim());
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' ? lines.reduce((text, line) => text.split(line).join(''), item.replace(/\r\n?/g, '\n')) : item,
  );
};
/** Nothing of the Triage request beyond the published comment: no identity, attempt, Verdict record, raw evidence or mention. */
function assertNoTriageTrace(subject: string, value: unknown, request: TriageRequest, comment: string) {
  const whole = JSON.stringify(value);
  const forbidden = [rawEvidence, request.verdict!.textSha256, ...request.attempts!.map(attempt => attempt.attempt)];
  for (const item of forbidden) assert.ok(!whole.includes(item), `${subject} carries ${item}`);
  const rest = withoutPublished(value, comment);
  assert.ok(!rest.includes(request.triage_request_id), `${subject} carries the request identity outside the published comment`);
  // ("verdict" alone is not searched: the reviewers' own prompt names their JSON verdict.)
  const mention = /triag|needs-info|ready-for-human|wontfix/i.exec(rest);
  assert.equal(
    mention && rest.slice(Math.max(0, mention.index - 200), mention.index + 200),
    null,
    `${subject} mentions the Triage outside the published comment`,
  );
}
const activations = (execution: ReturnType<typeof executionDoubles>) =>
  execution.calls.filter(item => item.kind === 'activate').map(item => item.detail as Activation);

test('GitHub: a needs-triage issue is investigated, its Verdict published, and after a restart of the Control ONE Work is born by the discovery of the admission label, with nothing of the request beyond the published comment', async t => {
  const human = { id: 9, login: 'human', type: 'User' };
  const tip = 'b'.repeat(40);
  const world = await githubWorld(t, {
    issues: [
      issue(7, {
        title: 'Total errado no carrinho',
        body: 'O total ignora o desconto do cupom.',
        labels: [{ id: 56, name: 'needs-triage' }],
        timeline: [
          { id: 11, event: 'labeled', label: { name: 'needs-triage' }, created_at: '2026-11-20T10:00:11Z', actor: human, performed_via_github_app: null },
        ],
      }),
    ],
    comments: [{ id: 501, issue: 7, body: 'Acontece desde a versão 3.', user: { id: 12, login: 'maria', type: 'User' }, author_association: 'MEMBER' }],
    pulls: [],
    refs: {},
    rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } },
    checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      rules: { main: [{ type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' }] },
      checkRuns: { [sha]: [] },
      statuses: { [sha]: [] },
      compare: { [`${tip}...${sha}`]: { status: 'ahead', ahead_by: 1, behind_by: 0 } },
    },
  });
  const effective = await effectiveOf(world.root, githubYaml);
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const composed = await composeProductionExecution({
    root: world.root,
    effective,
    guestAssets: { directory: join(world.root, 'guest'), manifestSha256: 'a'.repeat(64) },
    github,
  });
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') return;
  /** The Builder publishes with ITS grant through the world's gh: its branch at the verified commit, then one draft PR closing the issue. */
  const publish = async (_remote: Remote, activation: Activation) => {
    const { workId, branch, head } = facts(activation.prompt);
    const body = [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Subtracts the coupon. Closes #7', '## Validation', 'Gate t1 passed.'].join('\n');
    assert.equal(await builderGh(world.executable, activation.token, '/repos/acme/project/git/refs', { ref: `refs/heads/${branch}`, sha: head }), 201);
    assert.equal(
      await builderGh(world.executable, activation.token, '/repos/acme/project/pulls', {
        title: 'Coupon in the total',
        head: branch,
        base: 'main',
        body,
        draft: true,
      }),
      201,
    );
  };
  const scripts: Script[] = [
    { kind: 'implement', head: sha },
    { kind: 'publish', publish, end: 'success' },
  ];
  const builders = executionDoubles({ issues: [], pulls: {} }, scripts);
  // Substituted in the execution: the Sandbox lifecycle and the agents. Credentials, policies and capacity stay the production composition's.
  const execution: ExecutionPorts = { ...composed.ports, sandbox: builders.ports.sandbox, workers: builders.ports.workers };
  const w = await triageWorld(t, {
    sources: [],
    script: investigation({ outcome: 'ready-for-agent', category: 'bug', text: verdictText }),
    ports: await productionTriageNumbers({ root: world.root, release: 'release-under-test', effective, github }),
    execution,
    access: () => composeProductionAccess({ root: world.root, github, effective }),
  });
  const state = async () => {
    let snapshot!: Parameters<Parameters<typeof world.update>[0]>[0];
    await world.update(current => void (snapshot = structuredClone(current)));
    return snapshot;
  };

  await w.start();
  const request = await published(w);
  // The Triager got the Ticket through the production adapters: text, every comment with its author's association.
  const triagerPrompt = firstPrompt(w.bodies[0]!);
  assert.match(triagerPrompt, /Title: Total errado no carrinho/);
  assert.match(triagerPrompt, /by @maria \(association with the origin: MEMBER\)/);
  // The publication wrote on the issue, as the App, and nothing else: one comment, the admission label, the withdrawal of needs-triage.
  const afterPublication = await state();
  const [, verdictComment] = afterPublication.comments!;
  assert.equal(afterPublication.comments!.length, 2);
  assert.ok(verdictComment!.body!.startsWith(`<!-- software-factory:triage:${request.triage_request_id} -->\n**Triage Verdict, generated by AI.**`));
  assert.ok(verdictComment!.body!.endsWith(verdictText));
  assert.deepEqual(
    afterPublication.issues[0]!.labels.map(label => label.name),
    ['ready-for-agent'],
  );
  assert.deepEqual(
    (await world.trace())
      .filter(entry => entry.method !== 'GET' && !entry.endpoint.includes('access_tokens') && entry.endpoint !== '/installation/token')
      .map(entry => `${entry.method} ${entry.endpoint}`),
    ['POST /repos/acme/project/issues/7/comments', 'POST /repos/acme/project/issues/7/labels', 'DELETE /repos/acme/project/issues/7/labels/needs-triage'],
  );
  // The publication created no Work: the label is on the issue and no polling cycle ran since.
  assert.deepEqual(await works(w), [], 'no Work is born of the publication');
  assert.deepEqual(activations(builders), []);

  // Restart between the publication and the discovery: a new Control on the same storage, composed anew.
  await w.stop();
  await w.start();
  const admitted = await works(w);
  assert.equal(admitted.length, 1, 'the first polling cycle of the new Control admits the Ticket');
  const [work] = admitted;
  assert.deepEqual([work!.ticket.tracker, work!.ticket.tracker === 'github' && work!.ticket.number], ['github', 7]);
  assert.equal(work!.authorization.source, 'github-rest');
  if (work!.authorization.source !== 'github-rest') return;
  assert.deepEqual(
    [work!.authorization.state, work!.authorization.basis.label.name, work!.authorization.basis.issueState],
    ['authorized', 'ready-for-agent', 'open'],
    'born by the normal discovery of the admission label',
  );

  await settle(w, 'the own PR linked', async () => (await works(w))[0]?.pullRequest != null);
  await w.poll();
  await w.poll();
  const final = await works(w);
  assert.equal(final.length, 1, 'one Work only');
  assert.deepEqual([(await w.requests()).length, (await w.requests())[0]!.state], [1, 'concluded'], 'no second request, the first stays concluded');
  assert.equal(w.bodies.length, 2, 'the model of the Triager was called for the investigation only');

  // The Builder's first prompt carries the published Verdict through the comment delivery, with the person's comment before it.
  const [first, ...later] = activations(builders);
  assert.equal(first!.phaseId, 'builder-initial');
  assert.match(first!.prompt, /Ticket comments: GitHub issue https:\/\/github\.com\/acme\/project\/issues\/7, read by the Factory controller/);
  assert.ok(first!.prompt.includes(verdictText), 'the Verdict text reaches the Builder whole');
  assert.ok(first!.prompt.includes('**Triage Verdict, generated by AI.**'));
  assert.ok(first!.prompt.indexOf('Acontece desde a versão 3.') < first!.prompt.indexOf(verdictText));
  assert.match(first!.prompt, /FACTORY/);
  assert.ok(later.some(activation => activation.phaseId === 'builder-publication'));

  // Nothing of the request beyond what is published on the Ticket: the Builder, the reviewers, the Work and the PR.
  const comment = verdictComment!.body!;
  assertNoTriageTrace('what the Builder and the reviewers received', builders.calls, request, comment);
  assertNoTriageTrace('the Work', [final[0], await shown(w, final[0]!)], request, comment);
  const pulls = (await state()).pulls;
  assert.equal(pulls.length, 1);
  assertNoTriageTrace('the pull request', pulls, request, comment);
  assert.ok(!JSON.stringify(pulls).includes(request.triage_request_id));
});

/** The GitHub boundary of the Jira case: never reached (the GitHub contracts of the destination are doubled), every call recorded. */
function unreachableGitHub() {
  const calls: string[] = [];
  const github = new Proxy({ appId: 1 } as unknown as GitHubAccess, {
    get(_target, property) {
      if (property === 'appId') return 1;
      if (property === 'then') return undefined;
      return async () => {
        calls.push(String(property));
        throw new Error('GITHUB_BOUNDARY_NOT_USED');
      };
    },
  });
  return { calls, github };
}

/** The world of the Jira case, not started: the site with one Card to triage, the production access over it, the Triager and the Builder. */
async function cardJourney(t: Parameters<typeof triageWorld>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'factory-triage-journey-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  await writeFile(join(root, 'credentials', 'jira-token'), 'synthetic-jira-token\n', { mode: 0o600 });
  const effective = await effectiveOf(root, jiraYaml);
  // The Card as a person left it: no component, `needs-triage` applied by a person (its changelog says so), one comment.
  const card: HttpCard = { id: '81042', key: 'PAG-42', projectId: '10010', labels: [], components: [], summary: 'Total errado no carrinho' };
  card.description = 'O total ignora o desconto do cupom.';
  const jira = jiraHttpWorld([card]);
  jira.edit(card, { labels: [{ add: 'needs-triage' }] });
  jira.write('81042', 'Acontece desde a versão 3.', 'acc-person');
  const server = await jiraHttpServer(jira);
  let afterExchange: (exchange: JiraHttpExchange) => void = () => {};
  const send = async (exchange: JiraHttpExchange) => {
    const result = await server.send(exchange);
    afterExchange(exchange);
    return result;
  };
  t.after(() => server.close());
  const boundary = unreachableGitHub();
  const remote: Remote = { issues: [], pulls: {} };
  const destination = githubDoubles(remote);
  const cardUrl = `${jiraOrigin}/browse/PAG-42`;
  /** The Builder of the Card's Work publishes its own PR from its own branch, with the Card reference. */
  const publish = (_remote: Remote, activation: Activation) => {
    const { workId, branch, head } = facts(activation.prompt);
    (remote.refs ??= {})[branch] = head;
    const body = [
      `<!-- software-factory:work:${workId} -->`,
      '## Summary',
      'Subtracts the coupon.',
      `Jira Card PAG-42: ${cardUrl}`,
      '## Validation',
      'Gate t1 passed.',
    ];
    remote.pulls[0] = [ownPull(workId, branch, head, { association: ['known-branch'], body: body.join('\n') })];
  };
  const scripts: Script[] = [
    { kind: 'implement', head: sha },
    { kind: 'publish', publish, end: 'success' },
  ];
  const builders = executionDoubles(remote, scripts);
  const w = await triageWorld(t, {
    sources: [],
    script: investigation({ outcome: 'ready-for-agent', category: 'bug', text: verdictText, component: '10022' }),
    ports: await productionTriageNumbers({ root, release: 'release-under-test', effective, github: boundary.github }),
    execution: builders.ports,
    access: (): AccessDependencies => ({
      ...composeProductionAccess({ root, github: boundary.github, effective, jira: { send } }),
      tracker: { ...destination.tracker, checkAccess: async () => ({ status: 'ok' }) as never },
      repository: { ...destination.repository, checkAccess: async () => ({ status: 'ok' }) as never },
      factoryApp: async () => app,
    }),
  });
  const writes = () => jira.requests().filter(request => !request.startsWith('GET ') && request !== 'POST /rest/api/3/search/jql');

  return {
    w,
    jira,
    card,
    remote,
    builders,
    boundary,
    writes,
    /** Observes every raw exchange the production transport completed with the site, right after its answer. */
    onExchange: (observer: (exchange: JiraHttpExchange) => void) => void (afterExchange = observer),
  };
}

test('Jira: a needs-triage Card is investigated, its Verdict and route published in one comment and one edit, and after a restart of the Control ONE Work is born by the discovery of the admission label, with nothing of the request beyond the published comment', async t => {
  const { w, jira, card, remote, builders, boundary, writes } = await cardJourney(t);

  await w.start();
  const request = await published(w);
  const triagerPrompt = firstPrompt(w.bodies[0]!);
  assert.match(triagerPrompt, /Total errado no carrinho/);
  assert.match(triagerPrompt, /Acontece desde a versão 3\./);
  // The publication wrote on the Card, as the configured account: one comment, then ONE edit with the label change and the component.
  assert.deepEqual(writes(), ['POST /rest/api/3/issue/81042/comment', 'PUT /rest/api/3/issue/81042']);
  assert.deepEqual(jira.unexpected, []);
  assert.deepEqual([card.labels, card.components], [['factory-ready'], ['10022']]);
  const comments = jira.comments['81042']!;
  assert.equal(comments.length, 2);
  const comment = comments[1]!.text;
  assert.ok(comment.startsWith(`<!-- software-factory:triage:${request.triage_request_id} -->\n**Triage Verdict, generated by AI.**`));
  assert.ok(comment.endsWith(verdictText));
  assert.match(comment, /the same edit adds the component 10022, which routes to the repository `acme\/project`/);
  assert.deepEqual(await works(w), [], 'no Work is born of the publication');
  assert.deepEqual(activations(builders), []);

  // Restart between the publication and the discovery: a new Control on the same storage, composed anew over the same site.
  await w.stop();
  await w.start();
  const admitted = await works(w);
  assert.equal(admitted.length, 1, 'the first polling cycle of the new Control admits the Card');
  const [work] = admitted;
  assert.deepEqual(
    [work!.ticket.tracker, work!.ticket.tracker === 'jira' && work!.ticket.key, work!.repository.repository],
    ['jira', 'PAG-42', 'acme/project'],
  );
  assert.equal(work!.authorization.source, 'jira-rest');
  if (work!.authorization.source !== 'jira-rest') return;
  assert.deepEqual(
    [work!.authorization.state, work!.authorization.basis.label.name, work!.authorization.basis.route],
    ['authorized', 'factory-ready', { componentIds: ['10022'], repository: 'acme/project' }],
    'born by the normal discovery of the admission label, routed by the component the publication wrote',
  );

  await settle(w, 'the own PR linked', async () => (await works(w))[0]?.pullRequest != null);
  await w.poll();
  await w.poll();
  const final = await works(w);
  assert.equal(final.length, 1, 'one Work only');
  assert.deepEqual([(await w.requests()).length, (await w.requests())[0]!.state], [1, 'concluded'], 'no second request, the first stays concluded');
  assert.equal(w.bodies.length, 2, 'the model of the Triager was called for the investigation only');
  assert.deepEqual(
    writes().filter(item => !/\/remotelink$/.test(item)),
    ['POST /rest/api/3/issue/81042/comment', 'PUT /rest/api/3/issue/81042'],
    'the Card is never edited again, and no second Triage comment is written',
  );
  assert.deepEqual(jira.unexpected, []);
  assert.deepEqual(boundary.calls, []);

  // The Builder's first prompt carries the published Verdict in the Ticket content, with the person's comment before it.
  const [first, ...later] = activations(builders);
  assert.equal(first!.phaseId, 'builder-initial');
  assert.match(first!.prompt, /Comments of the Card/);
  assert.ok(first!.prompt.includes('Brief: subtract the coupon value in `total` and cover it with a test of a cart with one coupon.'));
  assert.ok(first!.prompt.includes('**Triage Verdict, generated by AI.**'));
  assert.ok(first!.prompt.indexOf('Acontece desde a versão 3.') < first!.prompt.indexOf('**Triage Verdict, generated by AI.**'));
  assert.ok(later.some(activation => activation.phaseId === 'builder-publication'));

  assertNoTriageTrace('what the Builder and the reviewers received', builders.calls, request, comment);
  assertNoTriageTrace('the Work', [final[0], await shown(w, final[0]!)], request, comment);
  assertNoTriageTrace('the pull request', remote.pulls, request, comment);
});

test('Jira: a Control stopped right after the edit of the Card, before reading it back, leaves ONE Work to the discovery of the next Control, which then recognises its own publication and writes nothing again', async t => {
  const { w, jira, card, builders, writes, onExchange } = await cardJourney(t);
  // The stop arrives when the site has answered the edit: the Card carries the admission label and the request has not recorded it.
  let stopped: Promise<void> | undefined;
  const edited = new Promise<void>(resolve =>
    onExchange(exchange => {
      if (exchange.method !== 'PUT' || stopped) return;
      stopped = w.stop();
      resolve();
    }),
  );
  await w.start();
  await untilHolds(
    'the edit of the Card sent',
    async () => {
      if (!stopped) await Promise.race([w.poll(), edited]);
      return stopped !== undefined;
    },
    5,
  );
  await stopped;
  assert.deepEqual(writes(), ['POST /rest/api/3/issue/81042/comment', 'PUT /rest/api/3/issue/81042']);
  assert.deepEqual([card.labels, card.components], [['factory-ready'], ['10022']]);
  assert.deepEqual(activations(builders), [], 'no Builder before the restart');
  // What the stopped Control left: the request still `publishing` (the edit was attempted and never read back).
  const left = await inspectStorage(w.storagePath);
  assert.equal(left.kind === 'storage' && left.triage.requests.publishing, 1);

  // The next Control: its first polling cycle admits the Card by the label, and only then its publication pass reads the Card back.
  await w.start();
  const [request] = await w.requests();
  assert.deepEqual([request!.state, request!.end?.code], ['concluded', 'VERDICT_PUBLISHED'], JSON.stringify(request));
  assert.deepEqual(
    request!.intended!.map(effect => [effect.status, effect.attempts]),
    request!.intended!.map(() => ['confirmed', 1]),
    'each effect was written once, by the first Control, and confirmed by the second from a read',
  );
  const admitted = await works(w);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]!.authorization.source === 'jira-rest' && admitted[0]!.authorization.basis.label.name, 'factory-ready');
  await w.poll();
  await w.poll();
  assert.equal((await works(w)).length, 1, 'one Work only');
  assert.equal((await w.requests()).length, 1, 'no second request');
  assert.deepEqual(
    writes().filter(item => !/\/remotelink$/.test(item)),
    ['POST /rest/api/3/issue/81042/comment', 'PUT /rest/api/3/issue/81042'],
    'nothing is published twice',
  );
  assert.equal(jira.comments['81042']!.length, 2);
  assert.deepEqual(jira.unexpected, []);
});
