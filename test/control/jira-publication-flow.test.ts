import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ListView, WorkView } from '../../src/control/types.js';
import type { OwnPullRequestObservation, PullRequestCandidate, PublicationCorrelation } from '../../src/code-repository/index.js';
import { githubDoubles, manualClock, scope, type Remote } from './doubles.js';
import { card, jiraDoubles, jiraSource, type JiraRemote } from './jira-doubles.js';
import { app, executionDoubles, facts, ownPull, type Activation, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Jira ticket 08 (spec §5), flow level: real Control + Pi Durable + temporary SQLite; a Jira Work (admitted from its Card) is implemented
// with ticket 13's real review rounds and published by the scripted Builder. Its own PR is found on its own branch only (no issue number,
// no timeline), linked once, and the Work's ONE link on the Card is intended in the same commit and upserted by its stable globalId.
// Doubled: GitHub, Jira, clock and the execution boundaries. Not evidence of a real Jira remote link or GitHub.
const cardUrl = 'https://equipe.atlassian.net/browse/PAG-42';
const jiraBody = (workId: string) =>
  [
    `<!-- software-factory:work:${workId} -->`,
    '## Summary',
    'Adds the note.',
    `Jira Card PAG-42: ${cardUrl}`,
    '## Validation',
    'Gate t1 passed.',
    '## Risk',
    'Low.',
  ].join('\n');
/** The Builder's publication of a Jira Work: its own branch at the verified commit and its own draft PR with the readable Card reference. */
const publishJira =
  (overrides: Partial<PullRequestCandidate> = {}) =>
  (remote: Remote, activation: Activation) => {
    const { workId, branch, head } = facts(activation.prompt);
    (remote.refs ??= {})[branch] = head;
    remote.pulls[0] = [...(remote.pulls[0] ?? []), ownPull(workId, branch, head, { association: ['known-branch'], body: jiraBody(workId), ...overrides })];
  };

async function harness(t: { after(fn: () => Promise<void>): void }, scripts: Script[], jira: Partial<JiraRemote> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-jira-publication-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [] };
  const github = githubDoubles(remote);
  const jiraRemote: JiraRemote = { cards: [card('81017', 'PAG-42')], ...jira };
  const doubles = jiraDoubles(jiraRemote);
  const storagePath = join(dir, 'control.sqlite');
  const execution = executionDoubles(remote, scripts);
  // Ticket 17's narrow delivery read of the linked own PR, from the same synthetic remote.
  const readOwnMerge = async (pr: { number: number }): Promise<OwnPullRequestObservation> => {
    const pull = Object.values(remote.pulls)
      .flat()
      .find(item => item.number === pr.number)!;
    return {
      kind: 'observed',
      source: 'github-rest',
      observedAt: new Date().toISOString(),
      repositoryId: 3,
      pullRequest: {
        pullRequestId: pull.pullRequestId,
        nodeId: pull.nodeId,
        number: pull.number,
        url: pull.url,
        state: pull.state,
        draft: pull.draft,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: pull.headRef,
        headSha: pull.headSha,
        headRepositoryId: 3,
        baseRef: pull.baseRef,
        baseRepositoryId: 3,
        reported: { mergeCommitSha: 'null', merged: 'value' },
      },
    };
  };
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      execution: execution.ports,
      access: {
        tracker: github.tracker,
        repository: { ...github.repository, readOwnMerge },
        repositories: [scope],
        sources: [jiraSource()],
        trackers: { jira: doubles.tracker },
        operators: ['operator-one'],
        factoryApp: async () => app,
      },
      polling: { intervalSeconds: 60, clock: time.clock },
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() {
    current!.stop.abort();
    assert.deepEqual(await current!.running, { kind: 'clean' });
  }
  t.after(async () => {
    if (current && !current.stop.signal.aborted) await stop();
  });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView;
  const status = async () => (await current!.control.inspect({ kind: 'status' })) as ControlStatus;
  const settle = async (predicate: () => Promise<boolean>, label: string) => {
    await untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (current!.time.isSleeping()) current!.time.advance();
        return false;
      },
      5,
    );
  };
  const cycles = async (n: number) => {
    for (let i = 0; i < n; i++) {
      current!.time.advance();
      await current!.time.sleeping();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  const publicationReads = () => github.calls.filter(call => call.method === 'findPublication').map(call => call.args as PublicationCorrelation);
  const upserts = () =>
    doubles.calls
      .filter(call => call.method === 'upsertRemoteLink')
      .map(call => call.args as { issueId: string; globalId: string; url: string; title: string });
  return { remote, jiraRemote, jira: doubles, start, stop, work, status, settle, cycles, activations, publicationReads, upserts };
}

test('a Jira Work opens its own draft PR with the Card reference, is linked by branch only, and its Card link is intended in that commit then upserted once', async t => {
  const h = await harness(
    t,
    [
      { kind: 'implement', head: 'd'.repeat(40) },
      { kind: 'publish', publish: publishJira(), end: 'success' },
    ],
    { linkOutcomes: ['down', 'down'] },
  );
  await h.start();
  await h.settle(async () => (await h.work())?.publication?.state === 'published', 'published');
  const work = await h.work();
  assert.match(work.branch!, /^factory\/jira-81017-[0-9a-f]{8}$/);
  const publish = h.activations().find(item => item.phaseId === 'builder-publication')!;
  assert.ok(publish.prompt.includes(`"Jira Card PAG-42: ${cardUrl}"`) && !/Closes #/.test(publish.prompt));
  assert.deepEqual(work.publication!.description, { conformant: true, reasons: [] });
  assert.deepEqual(work.pullRequest, { number: 4, url: 'https://github.com/acme/project/pull/4' });
  assert.ok(h.publicationReads().length >= 2 && h.publicationReads().every(read => read.issueNumbers.length === 0), 'never an issue number, never a timeline');
  // Jira down: the intent recorded with the link is pending, with the Work's stable globalId, its PR URL and readable title.
  const pending = (await h.status()).jiraLinks!;
  assert.deepEqual(
    pending.pending.map(item => [item.workId, item.globalId, item.url, item.title, item.desired, item.state, item.destination.issueId]),
    [[work.work_id, `software-factory:work:${work.work_id}`, 'https://github.com/acme/project/pull/4', 'Trabalho T-1 · Abrir PR', 'open', 'pending', '81017']],
  );
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'link confirmed once Jira answers');
  assert.deepEqual(h.jira.links['81017'], {
    [`software-factory:work:${work.work_id}`]: { url: 'https://github.com/acme/project/pull/4', title: 'Trabalho T-1 · Abrir PR', id: '20001' },
  });
  assert.ok(h.upserts().every(item => item.globalId === `software-factory:work:${work.work_id}` && item.issueId === '81017'));
  const sent = h.upserts().length;
  await h.cycles(3);
  assert.equal(h.upserts().length, sent, 'a confirmed link is not sent again');
  assert.equal(h.activations().length, 2, 'no further activation after the link');
  assert.deepEqual(
    h.jira.methods().filter(method => method.startsWith('unexpected:') || method === 'publishComment'),
    [],
    'no comment, no other Jira write',
  );
});

test('lost publication answer + restart: the own PR is recovered from a complete read (never opened again); a lost link answer re-sends the same globalId', async t => {
  const h = await harness(
    t,
    [
      { kind: 'implement', head: 'd'.repeat(40) },
      { kind: 'publish', publish: publishJira(), end: 'failure' },
    ],
    { linkOutcomes: ['lost'] },
  );
  await h.start();
  await h.settle(
    async () => Boolean((await h.work())?.execution?.request.publication) && (await h.work()).execution!.end?.cessation === 'confirmed',
    'publication ended',
  );
  assert.equal((await h.work()).publication!.state, 'awaiting-discovery');
  await h.stop();
  await h.start();
  await h.settle(async () => (await h.work()).publication!.state === 'published', 'linked after restart');
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'link confirmed');
  await h.cycles(2);
  assert.equal(h.activations().length, 2, 'the push/PR were never repeated');
  const { work_id } = await h.work();
  assert.deepEqual(
    h.upserts().map(item => item.globalId),
    [`software-factory:work:${work_id}`, `software-factory:work:${work_id}`],
    'the lost answer re-sent the same upsert',
  );
  assert.equal(Object.keys(h.jira.links['81017']!).length, 1, 'one link on the Card');
});

test('a human PR on the own branch naming the Card is never adopted, nothing is opened again, nothing is linked on the Card', async t => {
  const human = (remote: Remote, activation: Activation) => {
    const { branch } = facts(activation.prompt);
    remote.pulls[0] = [
      ownPull('00000000-0000-4000-8000-000000000000', branch, 'e'.repeat(40), {
        number: 7,
        pullRequestId: 9007,
        url: 'https://github.com/acme/project/pull/7',
        author: { id: 5, login: 'operator-one', type: 'User' },
        body: 'Fixes PAG-42',
        association: ['known-branch'],
      }),
    ];
  };
  const h = await harness(t, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: human, end: 'success' },
  ]);
  await h.start();
  await h.settle(async () => (await h.work())?.publication?.state === 'blocked', 'blocked');
  await h.cycles(2);
  const work = await h.work();
  assert.ok(work.publication!.reasons.includes('UNKNOWN_PULL_REQUEST:7'), JSON.stringify(work.publication!.reasons));
  assert.equal(work.pullRequest, null);
  assert.equal(h.activations().length, 2);
  assert.deepEqual(h.upserts(), []);
  assert.equal((await h.status()).jiraLinks, undefined);
});

test('two own PRs on the own branch block: ambiguity is shown, nothing is linked or opened again', async t => {
  const twice = (remote: Remote, activation: Activation) => {
    publishJira()(remote, activation);
    publishJira({ number: 5, pullRequestId: 9005, url: 'https://github.com/acme/project/pull/5' })(remote, activation);
  };
  const h = await harness(t, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: twice, end: 'success' },
  ]);
  await h.start();
  await h.settle(async () => (await h.work())?.publication?.state === 'blocked', 'blocked');
  assert.deepEqual((await h.work()).publication!.reasons, ['MULTIPLE_OWN_PULL_REQUESTS:4,5']);
  assert.ok((await h.work()).impediments.some(item => item.code === 'PUBLICATION_BLOCKED'));
  assert.equal((await h.work()).pullRequest, null);
  assert.deepEqual(h.upserts(), []);
});

test('closed without merge: the same link (globalId, URL) only changes its title; the Work is not delivered', async t => {
  const h = await harness(t, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishJira(), end: 'success' },
  ]);
  await h.start();
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'link confirmed');
  const { work_id } = await h.work();
  h.remote.pulls[0]![0]!.state = 'closed';
  await h.settle(
    async () =>
      (await h.work()).result === 'closed-unmerged' &&
      (await h.status()).jiraLinks?.pending.length === 0 &&
      h.upserts().at(-1)?.title === 'Trabalho T-1 · PR fechado sem merge',
    'closure linked',
  );
  const work = await h.work();
  assert.notEqual(work.result, 'delivered');
  assert.deepEqual(h.jira.links['81017'], {
    [`software-factory:work:${work_id}`]: { url: 'https://github.com/acme/project/pull/4', title: 'Trabalho T-1 · PR fechado sem merge', id: '20001' },
  });
  assert.deepEqual(
    h.jira.methods().filter(method => method.startsWith('unexpected:') || method === 'publishComment'),
    [],
  );
});

test('key change after the link: the PR is re-read by its persisted identity; a closure while the open link is still pending applies only the latest state', async t => {
  const h = await harness(
    t,
    [
      { kind: 'implement', head: 'd'.repeat(40) },
      { kind: 'publish', publish: publishJira(), end: 'success' },
    ],
    { linkOutcomes: Array.from({ length: 50 }, () => 'down' as const) },
  );
  await h.start();
  await h.settle(async () => (await h.work())?.publication?.state === 'published', 'published');
  const { work_id } = await h.work();
  h.jiraRemote.cards[0]!.key = 'FIN-18';
  await h.settle(async () => {
    const { ticket } = await h.work();
    return ticket.tracker === 'jira' && ticket.key === 'FIN-18';
  }, 'key presentation updated');
  h.remote.pulls[0]![0]!.state = 'closed';
  await h.settle(async () => (await h.work()).result === 'closed-unmerged', 'closure observed by the persisted PR identity');
  assert.deepEqual(
    (await h.status()).jiraLinks!.pending.map(item => [item.title, item.revision, item.destination.key]),
    [['Trabalho T-1 · PR fechado sem merge', 2, 'FIN-18']],
  );
  h.jiraRemote.linkOutcomes = [];
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'latest state confirmed');
  assert.deepEqual(h.jira.links['81017'], {
    [`software-factory:work:${work_id}`]: { url: 'https://github.com/acme/project/pull/4', title: 'Trabalho T-1 · PR fechado sem merge', id: '20001' },
  });
  assert.equal((await h.work()).pullRequest?.number, 4, 'the same own PR, never re-correlated by the new key');
});
