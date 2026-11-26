import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openStore } from '../../src/control/durable/store.js';
import { triageRequests } from '../../src/control/durable/triage-requests.js';
import type { ControlStatus, ListView, SourceTriage, TicketSource } from '../../src/control/types.js';
import { untilHolds } from '../runner/budget.js';
import { budgetDoubles } from './budget-doubles.js';
import { applyLabel, remoteIssue, scope, type RemoteIssue } from './doubles.js';
import { card, jiraSource, relabel } from './jira-doubles.js';
import { call, firstPrompt, hang, trackerWrites, triageWorld, unavailable, type ModelTurn } from './triage-investigation-fixture.js';

// Spec #68 §5 (ticket #76): what bounds an investigation. Real Control, real Triager session under a scripted provider, the Investigation
// Environment in process, the investigation clock moved by hand. The real crash of the controller (TR-11) is triage-crash.test.ts.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const githubSource: TicketSource = { tracker: 'github', repository: 'acme/project', discover: true, triage };
function triageIssue(number: number, overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  const issue = remoteIssue(number, { labels: [], ...overrides });
  applyLabel(issue, 'needs-triage');
  return issue;
}
const triageCard = (issueId: string, key: string) => {
  const item = card(issueId, key, { labels: [] });
  relabel(item, { add: ['needs-triage'] });
  return item;
};
const verdict = { outcome: 'needs-info', category: 'bug', text: 'Falta dizer em que versão o total ficou errado.' };
const conclude: ModelTurn = () => call('concluir_triagem', verdict);
const minutes = (count: number) => count * 60_000;
type World = Awaited<ReturnType<typeof triageWorld>>;
const githubWrites = (w: World) => trackerWrites(w.github.calls.map(item => item.method));
const events = (request: { timeline: { event: string; code?: string }[] }) =>
  request.timeline.map(entry => (entry.code ? `${entry.event} ${entry.code}` : entry.event));
/** A turn the test answers when it chooses. */
function gated(turn: ModelTurn) {
  let open!: () => void;
  const opened = new Promise<void>(resolve => (open = resolve));
  return { turn: (async body => (await opened, turn(body))) as ModelTurn, open };
}

test('TR-07: three requests of two sources and capacity 1 are investigated one at a time in global arrival order, and no Slot is consumed', async t => {
  const gates = [gated(conclude), gated(conclude), gated(conclude)];
  // The one Slot of the installation is held by a Work whose Builder is running.
  const execution = budgetDoubles([{ kind: 'hang' }]);
  const w = await triageWorld(t, {
    github: { issues: [remoteIssue(3), triageIssue(7), triageIssue(9)], pulls: {} },
    jira: { cards: [triageCard('81017', 'PAG-42')] },
    sources: [githubSource, jiraSource({ triage })],
    script: gates.map(gate => gate.turn),
    execution: execution.ports,
    // The doubles list the same issues under every repository: one executable repository keeps the Work's polling round its own.
    repositories: [scope],
  });
  await w.start();
  const slots = async () => ((await w.control().inspect({ kind: 'status' })) as ControlStatus).slots;
  const works = async () => ((await w.control().inspect({ kind: 'list' })) as ListView).works.length;
  await w.poll();
  await untilHolds('the Work to hold the Slot', async () => (await slots()).held === 1);
  const arrival = (await w.requests()).map(request => request.triage_request_id);
  assert.equal(arrival.length, 3);
  assert.deepEqual(new Set((await w.requests()).map(request => request.source.tracker)), new Set(['github', 'jira']));
  for (let turn = 0; turn < 3; turn++) {
    await untilHolds(`session ${turn + 1} to ask the model`, () => w.bodies.length === turn + 1);
    // A further polling round starts nothing while the unit is taken.
    await w.poll();
    const view = await w.view();
    assert.deepEqual(
      // A recorded Verdict is published by the next round (ticket #77): an issue's request is then `concluded`, a Card's still `publishing`.
      view.requests.map(request => (request.state === 'concluded' ? 'publishing' : request.state)),
      ['publishing', 'publishing', 'publishing'].fill('investigating', turn, turn + 1).fill('queued', turn + 1),
      `round ${turn + 1}: one investigation, in arrival order`,
    );
    assert.deepEqual(view.capacity, { configured: 1, investigating: 1, retained: 0 });
    assert.deepEqual(view.queue, arrival.slice(turn + 1));
    assert.equal(w.bodies.length, turn + 1);
    assert.deepEqual(await slots(), { capacity: 1, held: 1 }, 'the Slot stays with the Work');
    gates[turn]!.open();
    await w.settled(turn, 'publishing');
    await w.poll();
  }
  const done = await w.requests();
  assert.deepEqual(
    done.map(request => request.attempts!.length),
    [1, 1, 1],
    'never two investigations of the same Ticket',
  );
  assert.deepEqual((await w.view()).capacity, { configured: 1, investigating: 0, retained: 0 });
  assert.deepEqual([await slots(), await works()], [{ capacity: 1, held: 1 }, 1], 'no Slot and no Work came from the Triage');
});

test('TR-08 (clock): the investigation time running out ends the attempt and the request with the clock code; no second attempt starts', async t => {
  const w = await triageWorld(t, { github: { issues: [triageIssue(7)], pulls: {} }, sources: [githubSource], script: [() => hang, conclude] });
  await w.start();
  await untilHolds('the session to ask the model', () => w.bodies.length === 1);
  w.time.advance(minutes(15) - 1);
  await w.poll();
  assert.equal((await w.requests())[0]!.state, 'investigating', 'one millisecond short of the limit');
  w.time.advance(1);
  const failed = await w.settled(0, 'failed');
  assert.deepEqual([failed.end?.code, failed.attempts!.length], ['TRIAGE_INVESTIGATION_TIME_EXHAUSTED', 1]);
  assert.deepEqual(
    [failed.attempts![0]!.end?.code, failed.attempts![0]!.end?.cessation],
    ['TRIAGE_INVESTIGATION_TIME_EXHAUSTED', { cessationConfirmed: true, evidence: 'unit-inactive' }],
  );
  assert.deepEqual(events(failed).slice(-2), ['attempt-ended TRIAGE_INVESTIGATION_TIME_EXHAUSTED', 'failed TRIAGE_INVESTIGATION_TIME_EXHAUSTED']);
  await w.poll();
  assert.equal(w.bodies.length, 1, 'attempts are left, time is not: nothing else starts');
  assert.deepEqual([failed.verdict, githubWrites(w)], [undefined, []]);
});

test('TR-08 (queue and restart): the queue spends nothing, a restart of the Control gives nothing back, and the next attempt gets only the time left', async t => {
  const w = await triageWorld(t, {
    github: { issues: [triageIssue(7), triageIssue(9)], pulls: {} },
    sources: [githubSource],
    script: [() => hang, () => hang, conclude],
  });
  await w.start();
  await untilHolds('the first session to ask the model', () => w.bodies.length === 1);
  assert.match(firstPrompt(w.bodies[0]!), /## Remaining investigation time\n\n15 minutes\n/);
  // Six minutes of investigation of the first request, while the second waits in the queue.
  w.time.advance(minutes(6));
  await w.stop();
  // An hour with the Control down, both requests queued: nobody spends.
  w.time.advance(minutes(60));
  await w.start();
  await untilHolds('the second session to ask the model', () => w.bodies.length === 2);
  const [retried, waiting] = await w.requests();
  assert.deepEqual([retried!.state, retried!.attempts!.length], ['investigating', 2], 'it kept its place in the queue, ahead of the later request');
  assert.deepEqual([retried!.attempts![0]!.end?.code, retried!.attempts![0]!.end?.spentMs], ['TRIAGER_INTERRUPTED', minutes(6)]);
  assert.deepEqual(events(retried!).slice(-3, -1), ['attempt-ended TRIAGER_INTERRUPTED', 'requeued']);
  assert.deepEqual([waiting!.state, waiting!.attempts], ['queued', undefined]);
  assert.match(firstPrompt(w.bodies[1]!), /## Remaining investigation time\n\n9 minutes\n/, 'the restart did not restore the six minutes');
  w.time.advance(minutes(9) - 1);
  await w.poll();
  assert.equal((await w.requests())[0]!.state, 'investigating');
  w.time.advance(1);
  const failed = await w.settled(0, 'failed');
  assert.deepEqual(
    [failed.end?.code, failed.attempts!.map(attempt => attempt.end?.code)],
    ['TRIAGE_INVESTIGATION_TIME_EXHAUSTED', ['TRIAGER_INTERRUPTED', 'TRIAGE_INVESTIGATION_TIME_EXHAUSTED']],
  );
  // The request that only waited (more than an hour) still has its whole clock.
  await w.poll();
  const next = await w.settled(1, 'publishing');
  assert.match(firstPrompt(w.bodies[2]!), /## Remaining investigation time\n\n15 minutes\n/);
  assert.equal(next.attempts!.length, 1);
  assert.deepEqual(githubWrites(w), []);
});

test('TR-08 (triager-v1 and attempts): 48 model requests or 160 tool calls end the attempt with the model budget code; the second attempt is the last', async t => {
  const invalid = { name: 'request_clone', arguments: { repository: 'acme/elsewhere' } };
  const w = await triageWorld(t, {
    github: { issues: [triageIssue(7)], pulls: {} },
    sources: [githubSource],
    script: [
      // Attempt 1: one tool call per request; the 49th request is never sent.
      ...Array.from({ length: 48 }, (): ModelTurn => () => [invalid]),
      // Attempt 2: four tool calls per request; the 161st call (in the 41st request) is refused and closes the session.
      ...Array.from({ length: 41 }, (): ModelTurn => () => [invalid, invalid, invalid, invalid]),
      conclude,
    ],
  });
  await w.start();
  await untilHolds('the first attempt to end', async () => (await w.requests())[0]?.attempts?.[0]?.end != null);
  assert.equal(w.bodies.length, 48, 'the request past the budget never reached the provider');
  const [requeued] = await w.requests();
  assert.deepEqual(events(requeued!).slice(-2), ['attempt-ended TRIAGER_MODEL_BUDGET_EXHAUSTED', 'requeued']);
  await w.poll();
  const failed = await w.settled(0, 'failed');
  assert.equal(w.bodies.length, 48 + 41);
  assert.deepEqual(
    [failed.end?.code, failed.attempts!.map(attempt => attempt.end?.code)],
    ['TRIAGE_ATTEMPTS_EXHAUSTED', ['TRIAGER_MODEL_BUDGET_EXHAUSTED', 'TRIAGER_MODEL_BUDGET_EXHAUSTED']],
  );
  assert.deepEqual(events(failed).slice(-2), ['attempt-ended TRIAGER_MODEL_BUDGET_EXHAUSTED', 'failed TRIAGE_ATTEMPTS_EXHAUSTED']);
  await w.poll();
  assert.equal(w.bodies.length, 48 + 41, 'no third attempt');
  assert.deepEqual([failed.verdict, githubWrites(w)], [undefined, []]);
});

test('TR-09: an attempt ended with balance is retried only after its stop is confirmed, in a new session; until then its unit is retained with an Impediment', async t => {
  const w = await triageWorld(t, {
    github: { issues: [triageIssue(7), triageIssue(9)], pulls: {} },
    sources: [githubSource],
    script: [() => unavailable, conclude, conclude],
  });
  w.environment.controls.withholdStopConfirmation();
  await w.start();
  const retained = await w.settled(0, 'queued');
  const first = retained.attempts![0]!;
  assert.deepEqual(
    [first.end?.code, first.end?.cessation],
    ['TRIAGER_PROVIDER_UNAVAILABLE', { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' }],
  );
  assert.deepEqual(events(retained).slice(-3), ['attempt-ended TRIAGER_PROVIDER_UNAVAILABLE', 'capacity-retained INVESTIGATION_CGROUP_POPULATED', 'requeued']);
  const held = await w.view();
  assert.deepEqual(held.capacity, { configured: 1, investigating: 0, retained: 1 });
  assert.deepEqual(
    held.impediments.map(item => [item.code, item.ref, item.triage_request_id, 'observed' in item ? item.observed : null]),
    [['TRIAGE_CAPACITY_RETAINED', first.attempt, retained.triage_request_id, 'INVESTIGATION_CGROUP_POPULATED']],
  );
  const stops = () => w.environment.controls.calls().filter(item => item === `stop ${first.attempt}`).length;
  // Every reconciliation asks again; neither this request nor the next one starts on the retained unit.
  const before = stops();
  await w.poll();
  await w.poll();
  assert.equal(stops(), before + 2);
  // And every start of the Control.
  await w.stop();
  await w.start();
  assert.equal(stops(), before + 3);
  assert.deepEqual([w.bodies.length, w.agents.length], [1, 1], 'nothing started before the confirmation');
  assert.deepEqual(
    (await w.requests()).map(request => [request.state, request.attempts?.length ?? 0]),
    [
      ['queued', 1],
      ['queued', 0],
    ],
  );
  assert.equal((await w.view()).impediments.length, 1);
  // The environment confirms: the unit is free, the Impediment is over and the request is investigated again by a NEW session.
  w.environment.controls.releaseStopConfirmation();
  await w.poll();
  const concluded = await w.settled(0, 'publishing');
  const [released, second] = concluded.attempts!;
  assert.deepEqual(released!.end?.cessation, { cessationConfirmed: true, evidence: 'unit-inactive' });
  assert.ok(events(concluded).includes('capacity-released unit-inactive'));
  assert.notEqual(second!.attempt, first.attempt);
  assert.equal(w.agents.length, 2, 'a new agent with its own bootstrap');
  assert.notEqual(w.agents[1]!.argv.at(-1), w.agents[0]!.argv.at(-1));
  const session = JSON.parse(w.bodies[1]!) as { messages: { role: string }[] };
  assert.deepEqual(
    session.messages.map(message => message.role).filter(role => role !== 'system' && role !== 'developer'),
    ['user'],
    'the new session starts from the first prompt alone',
  );
  assert.doesNotMatch(firstPrompt(w.bodies[1]!).slice(firstPrompt(w.bodies[1]!).lastIndexOf('\nFactory activation data\n')), /attempt|tentativa/i);
  assert.deepEqual((await w.view()).impediments, []);
  assert.deepEqual(githubWrites(w), []);
});

test('TR-10 (GitHub): provider failures in every attempt end the request `failed`, seen by the operator only: nothing is written to the Ticket', async t => {
  const issue = triageIssue(7);
  const w = await triageWorld(t, { github: { issues: [issue], pulls: {} }, sources: [githubSource], script: [() => unavailable, () => unavailable, conclude] });
  await w.start();
  await w.settled(0, 'queued');
  await w.poll();
  const failed = await w.settled(0, 'failed');
  assert.deepEqual(
    [failed.end?.code, failed.attempts!.map(attempt => attempt.end?.code)],
    ['TRIAGE_ATTEMPTS_EXHAUSTED', ['TRIAGER_PROVIDER_UNAVAILABLE', 'TRIAGER_PROVIDER_UNAVAILABLE']],
  );
  await w.poll();
  assert.equal(w.bodies.length, 2);
  assert.deepEqual([failed.verdict, failed.intended], [undefined, undefined]);
  assert.deepEqual(githubWrites(w), []);
  assert.deepEqual(
    issue.labels.map(label => label.name),
    ['needs-triage'],
    'no needs-info for a failure',
  );
  assert.deepEqual((await w.view()).impediments, [], '`failed` is no Impediment');
});

test('TR-10 (Jira): the clock running out without a Verdict ends the request `failed`: nothing is written to the Card', async t => {
  const item = triageCard('81017', 'PAG-42');
  const w = await triageWorld(t, { jira: { cards: [item] }, sources: [jiraSource({ triage })], script: [() => hang] });
  await w.start();
  await untilHolds('the session to ask the model', () => w.bodies.length === 1);
  w.time.advance(minutes(15));
  const failed = await w.settled(0, 'failed');
  assert.deepEqual([failed.end?.code, failed.verdict, failed.intended], ['TRIAGE_INVESTIGATION_TIME_EXHAUSTED', undefined, undefined]);
  assert.deepEqual(trackerWrites(w.jira.methods()), []);
  assert.deepEqual(item.labels, ['needs-triage']);
  assert.deepEqual((await w.view()).impediments, []);
});

/**
 * What a killed controller leaves in the storage, written here over a stopped Control: the latest attempt of the request open again and
 * the request `investigating`, with nothing of its end. (The real SIGKILL is triage-crash.test.ts.)
 */
async function asKilled(w: World, triage_request_id: string) {
  const store = await openStore(w.storagePath);
  try {
    await store.session.commit(async tx => {
      const request = (await tx.doc(triageRequests, triage_request_id, null)).request!;
      request.attempts!.at(-1)!.end = null;
      request.state = 'investigating';
      request.timeline = request.timeline.filter(entry => entry.event === 'requested' || entry.event === 'attempt-started');
    }, BACKGROUND_CONTEXT);
  } finally {
    await store.close();
  }
}

test('TR-11 (clock): an attempt a dead Control left open is charged up to its latest recorded instant, not the time the Control was down', async t => {
  const first = gated(() => call('request_clone', { repository: 'acme/project' }));
  const w = await triageWorld(t, { github: { issues: [triageIssue(7)], pulls: {} }, sources: [githubSource], script: [first.turn, () => hang, conclude] });
  await w.start();
  await untilHolds('the session to ask the model', () => w.bodies.length === 1);
  // Two minutes in, the session asks for a clone: the one instant the attempt's record gains after its start.
  w.time.advance(minutes(2));
  first.open();
  await untilHolds('the clone to be delivered', () => w.bodies.length === 2);
  w.time.advance(minutes(3));
  const [open] = await w.requests();
  await w.stop();
  await asKilled(w, open!.triage_request_id);
  // An hour with no Control at all.
  w.time.advance(minutes(60));
  await w.start();
  const again = await w.settled(0, 'publishing');
  const [interrupted, second] = again.attempts!;
  assert.deepEqual([interrupted!.end?.code, interrupted!.end?.spentMs], ['INVESTIGATION_INTERRUPTED', minutes(2)]);
  assert.equal(Date.parse(interrupted!.clones[0]!.at) - Date.parse(interrupted!.startedAt), minutes(2), 'the clone instant is of the investigation clock');
  assert.equal(second!.end?.code, 'VERDICT_RECORDED', 'the downtime did not cost the request its second attempt');
  assert.match(firstPrompt(w.bodies[2]!), /## Remaining investigation time\n\n13 minutes\n/);
});

test('TR-11 (clock): with no instant after its start in the records, the interrupted attempt is charged up to the instant the new Control ended it', async t => {
  const w = await triageWorld(t, { github: { issues: [triageIssue(7)], pulls: {} }, sources: [githubSource], script: [() => hang, conclude] });
  await w.start();
  await untilHolds('the session to ask the model', () => w.bodies.length === 1);
  w.time.advance(minutes(5));
  const [open] = await w.requests();
  await w.stop();
  await asKilled(w, open!.triage_request_id);
  w.time.advance(minutes(60));
  await w.start();
  const failed = await w.settled(0, 'failed');
  // The records cannot tell the five minutes of investigation from the hour without a Control: the whole span is charged.
  assert.deepEqual([failed.attempts![0]!.end?.code, failed.attempts![0]!.end?.spentMs], ['INVESTIGATION_INTERRUPTED', minutes(65)]);
  assert.deepEqual([failed.end?.code, failed.attempts!.length, w.bodies.length], ['TRIAGE_INVESTIGATION_TIME_EXHAUSTED', 1, 1]);
});
