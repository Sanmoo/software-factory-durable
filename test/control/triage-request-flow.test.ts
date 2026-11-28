import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ListView, SourceTriage, TicketSource, TriageCandidateView, TriageRequestsView } from '../../src/control/types.js';
import { openStore } from '../../src/control/durable/store.js';
import { transitionTriageRequest } from '../../src/control/durable/triage-requests.js';
import { applyLabel, githubDoubles, manualClock, remoteIssue, removeLabel, scope, type Remote, type RemoteIssue } from './doubles.js';
import { card, jiraDoubles, jiraSource, relabel, type JiraRemote } from './jira-doubles.js';

// Triage requests from `needs-triage` up to `queued`. Real Control + Pi Durable + SQLite; GitHub and Jira are
// doubles that record every call, so "no write" is asserted on what the Control asked of them.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const githubSource = (overrides: Partial<Extract<TicketSource, { tracker: 'github' }>> = {}): TicketSource => ({
  tracker: 'github',
  repository: 'acme/project',
  discover: true,
  triage,
  ...overrides,
});
const other = { ...scope, repository: 'acme/other' };
/** An issue a person labelled `needs-triage` (and nothing else), with the label event in its timeline. */
function triageIssue(number: number, overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  const issue = remoteIssue(number, { labels: [], ...overrides });
  applyLabel(issue, 'needs-triage');
  return issue;
}
const triageCard = (issueId: string, key: string, overrides: Parameters<typeof card>[2] = {}) => {
  const item = card(issueId, key, { labels: [], ...overrides });
  relabel(item, { add: ['needs-triage'] });
  return item;
};

async function harness(
  t: { after(fn: () => Promise<void>): void },
  options: { github?: Remote; jira?: JiraRemote; sources: TicketSource[]; operators?: string[] },
) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-triage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = options.github ?? { issues: [], pulls: {} };
  const github = githubDoubles(remote);
  const jira = jiraDoubles(options.jira ?? { cards: [] });
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  /** Starts a Control over the same storage and waits for its first complete polling iteration. */
  async function start(sources: TicketSource[] = options.sources) {
    const time = manualClock();
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      access: {
        tracker: github.tracker,
        repository: github.repository,
        repositories: [scope, other],
        sources,
        trackers: { jira: jira.tracker },
        ...(options.operators ? { operators: options.operators } : {}),
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
  const poll = async () => {
    current!.time.advance();
    await current!.time.sleeping();
  };
  const list = async () => (await current!.control.inspect({ kind: 'list' })) as ListView;
  const status = async () => (await current!.control.inspect({ kind: 'status' })) as ControlStatus;
  const requests = async () => ((await current!.control.inspect({ kind: 'triage-requests' })) as TriageRequestsView).requests;
  const queue = async () => ((await current!.control.inspect({ kind: 'triage-requests' })) as TriageRequestsView).queue;
  /** What the operator sees for the Tickets of the first source with Triage. */
  const seen = async (): Promise<TriageCandidateView[]> => (await list()).polling.triage?.[0]?.candidates ?? [];
  const control = () => current!.control;
  return { github, remote, jira, storagePath, start, stop, poll, list, status, requests, queue, seen, control };
}
/** Every call that would write to a tracker (a comment, a label, a link) or that the doubles do not model. */
const writes = (methods: string[]) => methods.filter(method => method.startsWith('unexpected:') || /post|publish|upsert|write|label(?!History)/i.test(method));
const githubWrites = (h: Awaited<ReturnType<typeof harness>>) =>
  writes(h.github.calls.map(call => call.method).filter(method => method !== 'readLabelHistory'));
const holds = (candidate: TriageCandidateView | undefined) => (candidate?.outcome === 'held' ? candidate.holds.map(hold => hold.code) : candidate?.outcome);
const summary = (items: { state: string; ordinal: number; end: { code: string } | null }[]) =>
  items.map(item => [item.state, item.ordinal, item.end?.code ?? null]);

test('GitHub: a source without the triage block creates no request for needs-triage and admits as before', async t => {
  const both = remoteIssue(2);
  applyLabel(both, 'needs-triage');
  const h = await harness(t, {
    github: { issues: [triageIssue(1), both], pulls: {} },
    sources: [{ tracker: 'github', repository: 'acme/project', discover: true }],
  });
  await h.start();
  await h.poll();
  assert.deepEqual(await h.requests(), []);
  const { works, polling } = await h.list();
  assert.deepEqual(
    works.map(work => work.ticket.tracker === 'github' && work.ticket.number),
    [2],
    'the admission label admits as today, needs-triage or not',
  );
  assert.equal(polling.triage, undefined);
  assert.deepEqual(githubWrites(h), []);
  assert.ok(
    h.github.calls.every(
      call => call.method !== 'readLabelHistory' && !(call.method === 'listCandidates' && JSON.stringify(call.args ?? '').includes('needs-triage')),
    ),
    'nothing of Triage is even read',
  );
});

test('Jira: a source without the triage block creates no request for needs-triage and admits as before', async t => {
  const both = card('81018', 'PAG-43');
  relabel(both, { add: ['needs-triage'] });
  const h = await harness(t, { jira: { cards: [triageCard('81017', 'PAG-42'), both] }, sources: [jiraSource()] });
  await h.start();
  await h.poll();
  assert.deepEqual(await h.requests(), []);
  assert.deepEqual(
    (await h.list()).works.map(work => work.ticket.tracker === 'jira' && work.ticket.key),
    ['PAG-43'],
  );
  assert.ok(!h.jira.methods().includes('readLabelHistory'));
});

test('only an open Ticket without Work gets a request, queued in arrival order; the label author is not checked against operators', async t => {
  const admitted = remoteIssue(3);
  const remote: Remote = { issues: [triageIssue(1), triageIssue(2, { state: 'closed' }), admitted, triageIssue(4)], pulls: {} };
  const h = await harness(t, { github: remote, sources: [githubSource()], operators: ['operator'] });
  await h.start();
  const first = await h.requests();
  assert.deepEqual(
    first.map(request => [request.ticket.tracker === 'github' && request.ticket.number, request.state, request.sequence, request.ordinal]),
    [
      [1, 'queued', 1, 1],
      [4, 'queued', 2, 1],
    ],
  );
  assert.deepEqual(
    await h.queue(),
    first.map(request => request.triage_request_id),
  );
  assert.deepEqual(first[0]!.source, { tracker: 'github', repository: 'acme/project' });
  assert.equal(first[0]!.authorization.label, 'needs-triage');
  assert.equal(first[0]!.authorization.application?.eventId, remote.issues[0]!.labelEvents![0]!.eventId);
  assert.deepEqual(
    first[0]!.timeline.map(entry => entry.event),
    ['requested'],
  );
  assert.equal(remote.issues[0]!.labelEvents![0]!.actor!.login, 'stranger', 'the person who labelled is no operator');

  // Issue 3 has a Work (admitted by its admission label). A person swaps its label to needs-triage: a Ticket with a Work is never triaged,
  // active or cancelled.
  const work = (await h.list()).works.find(item => item.ticket.tracker === 'github' && item.ticket.number === 3)!;
  removeLabel(admitted, 'ready-for-agent');
  applyLabel(admitted, 'needs-triage');
  await h.poll();
  const heldForWork = async () => holds((await h.seen()).find(candidate => candidate.ticket.tracker === 'github' && candidate.ticket.number === 3));
  assert.deepEqual(await heldForWork(), ['TRIAGE_WORK_EXISTS']);
  const cancelled = await h.control().accept({ request_id: 'cancel-work-3', operation: 'cancel', work_id: work.work_id, origin: 'local-cli' });
  assert.equal('kind' in cancelled && cancelled.kind, 'durable');
  await h.poll();
  assert.deepEqual(await heldForWork(), ['TRIAGE_WORK_EXISTS'], 'a cancelled Work still keeps the Ticket out of Triage');
  assert.equal((await h.requests()).length, 2);
  assert.deepEqual(githubWrites(h), []);
});

test('Jira: a Card in a done status category is not triaged; an open one is queued without needing a route', async t => {
  const h = await harness(t, {
    jira: { cards: [triageCard('81017', 'PAG-42', { components: [] }), triageCard('81018', 'PAG-43', { statusCategory: 'done' })] },
    sources: [jiraSource({ triage })],
  });
  await h.start();
  const requests = await h.requests();
  assert.deepEqual(
    requests.map(request => [request.ticket.tracker === 'jira' && request.ticket.key, request.state]),
    [['PAG-42', 'queued']],
  );
  assert.deepEqual(requests[0]!.source, { tracker: 'jira', siteId: 'site-A', projectId: '10010' });
  assert.deepEqual(holds((await h.seen()).find(candidate => candidate.ticket.tracker === 'jira' && candidate.ticket.key === 'PAG-43')), [
    'TRIAGE_TICKET_NOT_OPEN',
  ]);
  assert.deepEqual(writes(h.jira.methods().filter(method => method !== 'readLabelHistory')), []);
});

test('needs-triage beside another state label creates no request and no Work, comments nothing, and shows the conflict to the operator', async t => {
  const conflicting = triageIssue(1);
  applyLabel(conflicting, 'wontfix');
  const h = await harness(t, { github: { issues: [conflicting], pulls: {} }, sources: [githubSource()] });
  await h.start();
  await h.poll();
  assert.deepEqual(await h.requests(), []);
  assert.deepEqual((await h.list()).works, []);
  const [candidate] = await h.seen();
  assert.deepEqual(holds(candidate), ['TRIAGE_LABEL_CONFLICT']);
  assert.deepEqual(candidate?.outcome === 'held' && candidate.holds[0]!.labels, ['wontfix']);
  assert.equal((await h.status()).polling.triage?.[0]?.held, 1, 'status counts the Tickets waiting for a person');
  assert.deepEqual(githubWrites(h), []);
  assert.ok(!h.github.calls.some(call => call.method === 'readLabelHistory'), 'nothing more is read for a Ticket in conflict');
  assert.deepEqual(
    conflicting.labels.map(label => label.name),
    ['needs-triage', 'wontfix'],
    'no winner is chosen',
  );

  // A person leaves a single state label: the Ticket is triaged.
  removeLabel(conflicting, 'wontfix');
  await h.poll();
  assert.deepEqual(summary(await h.requests()), [['queued', 1, null]]);
});

test('a conflict suspends a queued request without a comment; removing only the conflicting label returns the SAME request to the queue', async t => {
  const issue = triageIssue(1);
  const h = await harness(t, { github: { issues: [issue, triageIssue(2)], pulls: {} }, sources: [githubSource()] });
  await h.start();
  const [request] = await h.requests();
  applyLabel(issue, 'needs-info');
  await h.poll();
  const [suspended, second] = await h.requests();
  assert.equal(suspended!.state, 'suspended');
  assert.deepEqual({ code: suspended!.suspension?.code, labels: suspended!.suspension?.labels }, { code: 'TRIAGE_LABEL_CONFLICT', labels: ['needs-info'] });
  assert.deepEqual(await h.queue(), [second!.triage_request_id], 'a suspended request is not in the queue');
  removeLabel(issue, 'needs-info');
  await h.poll();
  const [requeued] = await h.requests();
  assert.equal(requeued!.triage_request_id, request!.triage_request_id);
  assert.deepEqual([requeued!.state, requeued!.suspension, requeued!.sequence, requeued!.requestedAt], ['queued', null, 1, request!.requestedAt]);
  assert.deepEqual(
    requeued!.timeline.map(entry => entry.event),
    ['requested', 'suspended', 'requeued'],
  );
  assert.deepEqual(await h.queue(), [request!.triage_request_id, second!.triage_request_id], 'it keeps its arrival order');
  assert.equal((await h.requests()).length, 2, 'no other request was created');
  assert.deepEqual(githubWrites(h), []);
});

test('GitHub: needs-triage beside the admission label in a source with Triage suspends admission', async t => {
  const issue = remoteIssue(1);
  applyLabel(issue, 'needs-triage');
  const h = await harness(t, { github: { issues: [issue], pulls: {} }, sources: [githubSource()] });
  await h.start();
  await h.poll();
  const { works, polling } = await h.list();
  assert.deepEqual(works, []);
  const admission = polling.repositories[0]!.candidates![0]!;
  assert.deepEqual(admission.outcome === 'held' && admission.holds.map(hold => hold.code), ['ADMISSION_SUSPENDED_BY_TRIAGE']);
  assert.deepEqual(holds((await h.seen())[0]), ['TRIAGE_LABEL_CONFLICT'], 'and it is a conflict: no request either');
  assert.deepEqual(await h.requests(), []);
  assert.deepEqual(githubWrites(h), []);

  // needs-triage gone: the admission label admits on the normal discovery.
  removeLabel(issue, 'needs-triage');
  await h.poll();
  assert.equal((await h.list()).works.length, 1);
  assert.deepEqual(await h.requests(), []);
});

test('the suspension holds while the Host lacks a Triage prerequisite, and then no request is created nor abandoned', async t => {
  const issue = remoteIssue(1);
  applyLabel(issue, 'needs-triage');
  const waiting = triageIssue(2);
  const h = await harness(t, { github: { issues: [issue, waiting], pulls: {} }, sources: [githubSource()] });
  await h.start();
  const [request] = await h.requests();
  await h.stop();
  await h.start([githubSource({ triage: { ...triage, available: false } })]);
  removeLabel(waiting, 'needs-triage');
  await h.poll();
  assert.deepEqual((await h.list()).works, [], 'admission stays suspended');
  assert.deepEqual(summary(await h.requests()), [['queued', 1, null]], 'the request is neither moved nor abandoned');
  assert.equal((await h.requests())[0]!.triage_request_id, request!.triage_request_id);
  const view = (await h.list()).polling.triage![0]!;
  assert.deepEqual([view.state, view.code], ['not-available', 'TRIAGE_PREREQUISITES_MISSING']);
});

test('Jira: needs-triage beside the entry label suspends admission of the Card, and no impediment is commented', async t => {
  const item = card('81017', 'PAG-42', { components: [] });
  relabel(item, { add: ['needs-triage'] });
  const h = await harness(t, { jira: { cards: [item] }, sources: [jiraSource({ triage })] });
  await h.start();
  await h.poll();
  const { works, polling } = await h.list();
  assert.deepEqual(works, []);
  const admission = polling.sources![0]!.candidates![0]!;
  assert.deepEqual(admission.outcome === 'held' && admission.holds.map(hold => hold.code), ['ADMISSION_SUSPENDED_BY_TRIAGE']);
  assert.deepEqual(holds((await h.seen())[0]), ['TRIAGE_LABEL_CONFLICT']);
  assert.deepEqual(writes(h.jira.methods().filter(method => method !== 'readLabelHistory')), [], 'no notice on the Card (a route-less Card would get one)');
});

test('open blockers do not hold the Triage request, and its discovery never waits for them', async t => {
  const blocked = triageIssue(1, { blockedBy: [9] });
  const h = await harness(t, { github: { issues: [blocked, remoteIssue(9, { labels: [] })], pulls: {} }, sources: [githubSource()] });
  await h.start();
  assert.deepEqual(summary(await h.requests()), [['queued', 1, null]]);
  assert.deepEqual(await h.queue(), [(await h.requests())[0]!.triage_request_id]);
  assert.ok(!h.github.calls.some(call => call.method === 'readDependencyGraph'), 'blockers are context for the Triager, not a gate here');
});

test('the label seen in two reads after a terminal request creates nothing; a withdrawal and re-application in the history does', async t => {
  const issue = triageIssue(1);
  const h = await harness(t, { github: { issues: [issue], pulls: {} }, sources: [githubSource()] });
  await h.start();
  // The Ticket closes with the label on it (request abandoned) and reopens with the very same label application.
  issue.state = 'closed';
  await h.poll();
  assert.deepEqual(summary(await h.requests()), [['abandoned', 1, 'TICKET_CLOSED']]);
  issue.state = 'open';
  await h.poll();
  await h.poll();
  assert.deepEqual(summary(await h.requests()), [['abandoned', 1, 'TICKET_CLOSED']], 'two reads with the label present are not a new request');
  assert.deepEqual(holds((await h.seen())[0]), ['TRIAGE_REAPPLICATION_REQUIRED']);

  // The history cannot be read: still nothing, never a guess.
  removeLabel(issue, 'needs-triage');
  applyLabel(issue, 'needs-triage');
  h.remote.labelHistoryFailure = { code: 'GITHUB_QUERY_FAILED' };
  await h.poll();
  assert.deepEqual(holds((await h.seen())[0]), ['TRIAGE_LABEL_HISTORY_UNAVAILABLE']);
  assert.equal((await h.requests()).length, 1);

  // Withdrawn and applied again between two polls (the Control never saw the Ticket without the label): the timeline is the evidence.
  delete h.remote.labelHistoryFailure;
  await h.poll();
  const [old, fresh] = await h.requests();
  assert.deepEqual(summary([old!, fresh!]), [
    ['abandoned', 1, 'TICKET_CLOSED'],
    ['queued', 2, null],
  ]);
  assert.deepEqual(fresh!.previous, [old!.triage_request_id]);
  assert.equal(fresh!.authorization.application?.eventId, issue.labelEvents!.at(-1)!.eventId);
  await h.poll();
  assert.equal((await h.requests()).length, 2, 'and the same application is consumed once');
  assert.deepEqual(githubWrites(h), []);
});

test('Jira: the changelog is the evidence of a re-application on a Card', async t => {
  const item = triageCard('81017', 'PAG-42');
  const h = await harness(t, { jira: { cards: [item] }, sources: [jiraSource({ triage })] });
  await h.start();
  item.statusCategory = 'done';
  await h.poll();
  item.statusCategory = 'indeterminate';
  await h.poll();
  await h.poll();
  assert.deepEqual(summary(await h.requests()), [['abandoned', 1, 'TICKET_CLOSED']]);
  relabel(item, { remove: ['needs-triage'] });
  relabel(item, { add: ['needs-triage'] });
  await h.poll();
  assert.deepEqual(summary(await h.requests()), [
    ['abandoned', 1, 'TICKET_CLOSED'],
    ['queued', 2, null],
  ]);
});

test('a queued request that loses needs-triage ends abandoned; reapplying creates a new request with nothing spent', async t => {
  const issue = triageIssue(1);
  const h = await harness(t, { github: { issues: [issue], pulls: {} }, sources: [githubSource()] });
  await h.start();
  const [first] = await h.requests();
  removeLabel(issue, 'needs-triage');
  await h.poll();
  const [abandoned] = await h.requests();
  assert.deepEqual([abandoned!.state, abandoned!.end?.code], ['abandoned', 'NEEDS_TRIAGE_REMOVED']);
  assert.deepEqual(await h.queue(), []);
  await h.poll();
  assert.equal((await h.requests()).length, 1, 'no label, no request');

  applyLabel(issue, 'needs-triage');
  await h.poll();
  const [old, fresh] = await h.requests();
  assert.equal(old!.triage_request_id, first!.triage_request_id);
  assert.equal(old!.state, 'abandoned', 'the old request is never resumed');
  assert.notEqual(fresh!.triage_request_id, old!.triage_request_id);
  assert.deepEqual([fresh!.state, fresh!.ordinal, fresh!.suspension, fresh!.end], ['queued', 2, null, null]);
  assert.deepEqual(
    fresh!.timeline.map(entry => entry.event),
    ['requested'],
    'a full balance: nothing is inherited from the abandoned request',
  );
  assert.deepEqual(await h.queue(), [fresh!.triage_request_id]);
  assert.deepEqual(githubWrites(h), []);
});

test('removing the triage block of a source abandons its requests, queued, suspended or under investigation', async t => {
  const conflicting = triageIssue(2);
  const h = await harness(t, {
    github: { issues: [triageIssue(1), conflicting, triageIssue(3)], pulls: {} },
    jira: { cards: [triageCard('81017', 'PAG-42')] },
    sources: [githubSource(), jiraSource({ triage })],
  });
  await h.start();
  applyLabel(conflicting, 'wontfix');
  await h.poll();
  const before = await h.requests();
  assert.deepEqual(
    before.map(request => request.state),
    ['queued', 'suspended', 'queued', 'queued'],
  );
  await h.stop();
  // One request was already being investigated when the operator pulled the block (the investigation itself is a later ticket's).
  const store = await openStore(h.storagePath);
  const started = await transitionTriageRequest(store.session, before[2]!.triage_request_id, {
    from: ['queued'],
    to: 'investigating',
    event: 'attempt-started',
  });
  assert.equal(started.kind, 'applied');
  await store.close();

  await h.start([{ tracker: 'github', repository: 'acme/project', discover: true }, jiraSource({ triage })]);
  const after = await h.requests();
  assert.deepEqual(
    after.map(request => [request.source.tracker, request.state, request.end?.code ?? null]),
    [
      ['github', 'abandoned', 'TRIAGE_SOURCE_REMOVED'],
      ['github', 'abandoned', 'TRIAGE_SOURCE_REMOVED'],
      ['github', 'abandoned', 'TRIAGE_SOURCE_REMOVED'],
      ['jira', 'queued', null],
    ],
    'only the requests of the source that lost the block',
  );
  assert.deepEqual(await h.queue(), [after[3]!.triage_request_id]);
  await h.poll();
  assert.equal((await h.requests()).length, 4, 'and the label still on the Tickets requests nothing there any more');
  assert.deepEqual(githubWrites(h), []);
  assert.deepEqual(writes(h.jira.methods().filter(method => method !== 'readLabelHistory')), [], 'nothing is published without authorization');
});
