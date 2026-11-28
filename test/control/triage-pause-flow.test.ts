import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlReceipt, SourceTriage, TicketSource, TriageRequest } from '../../src/control/types.js';
import { untilHolds } from '../runner/budget.js';
import { applyLabel, remoteIssue, type RemoteIssue } from './doubles.js';
import { call, firstPrompt, hang, trackerWrites, triageWorld, type ModelTurn } from './triage-investigation-fixture.js';

// The Triage requests of a paused installation and of an installation whose release and pack changed
// between two runs of the controller. Real Control, SQLite and Triager session under a scripted provider; GitHub is the double.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const source: TicketSource = { tracker: 'github', repository: 'acme/project', discover: true, triage };
const text = 'Observado: o total ignora o cupom.\nInferido: falta a versão afetada.\nAção: informar a versão.';
function triageIssue(number: number): RemoteIssue {
  const issue = remoteIssue(number, { labels: [] });
  applyLabel(issue, 'needs-triage');
  return issue;
}
const conclude: ModelTurn = () => call('concluir_triagem', { outcome: 'needs-info', category: 'bug', text });
const minutes = (count: number) => count * 60_000;
type World = Awaited<ReturnType<typeof triageWorld>>;
const world = (t: Parameters<typeof triageWorld>[0], issues: number[], script: ModelTurn[], ports: Parameters<typeof triageWorld>[1]['ports'] = {}) =>
  triageWorld(t, { github: { issues: issues.map(triageIssue), pulls: {} }, sources: [source], script, ports });
/** A turn the test answers when it chooses. */
function gated(turn: ModelTurn) {
  let open!: () => void;
  const opened = new Promise<void>(resolve => (open = resolve));
  return { turn: (async body => (await opened, turn(body))) as ModelTurn, open };
}
async function setPaused(w: World, operation: 'pause' | 'unpause') {
  const receipt = (await w.control().accept({ request_id: `${operation}-triage`, operation, origin: 'local-cli' })) as ControlReceipt;
  assert.equal(receipt.kind, 'durable');
}
const writes = (w: World) => trackerWrites(w.github.calls.map(item => item.method));
const summary = (request: TriageRequest) => [request.state, request.attempts?.map(attempt => attempt.end?.code ?? 'open') ?? []];
const comments = (w: World, issue: number) => w.remote.comments?.[issue] ?? [];

test('paused with an investigation under way, that investigation ends with its Verdict recorded; no other starts and nothing is published until the unpause', async t => {
  const first = gated(conclude);
  const w = await world(t, [7, 9], [first.turn, conclude]);
  await w.start();
  await untilHolds('the first session to ask the model', () => w.bodies.length === 1);
  await setPaused(w, 'pause');
  await w.poll();
  assert.deepEqual((await w.requests()).map(summary), [
    ['investigating', ['open']],
    ['queued', []],
  ]);
  // The investigation under way goes on to its end while paused.
  first.open();
  const recorded = await w.settled(0, 'publishing');
  assert.deepEqual([recorded.verdict?.outcome, recorded.attempts![0]!.end?.cessation.cessationConfirmed], ['needs-info', true]);
  const reads = w.github.calls.length;
  await w.poll();
  await w.poll();
  const [waiting, queued] = await w.requests();
  assert.deepEqual(
    [summary(waiting!), summary(queued!)],
    [
      ['publishing', ['VERDICT_RECORDED']],
      ['queued', []],
    ],
  );
  assert.deepEqual([w.bodies.length, w.agents.length], [1, 1], 'the free unit of Triage capacity starts no investigation while paused');
  assert.deepEqual([writes(w), comments(w, 7)], [[], []], 'nothing is published while paused');
  assert.deepEqual(
    [waiting!.publication, waiting!.intended!.map(effect => [effect.status, effect.attempts ?? 0])],
    [
      undefined,
      [
        ['pending', 0],
        ['pending', 0],
        ['pending', 0],
      ],
    ],
    'the recorded Verdict waits as it was recorded',
  );
  assert.ok(w.github.calls.length > reads, 'the polling itself goes on while paused');
  // Unpaused: the recorded Verdict is published and the queue moves.
  await setPaused(w, 'unpause');
  await w.poll();
  const published = (await w.requests())[0]!;
  assert.deepEqual([published.state, published.end?.code], ['concluded', 'VERDICT_PUBLISHED']);
  assert.ok(comments(w, 7)[0]!.body.endsWith(text));
  assert.equal((await w.settled(1, 'publishing')).attempts!.length, 1);
});

test('paused with an investigation under way, that investigation runs until its time is exhausted; no other starts', async t => {
  const w = await world(t, [7, 9], [() => hang, conclude], { attempts: 1 });
  await w.start();
  await untilHolds('the first session to ask the model', () => w.bodies.length === 1);
  await setPaused(w, 'pause');
  w.time.advance(minutes(15) - 1);
  await w.poll();
  assert.equal((await w.requests())[0]!.state, 'investigating', 'the pause does not stop the investigation under way');
  w.time.advance(1);
  const failed = await w.settled(0, 'failed');
  assert.deepEqual([failed.end?.code, failed.attempts![0]!.end?.cessation.cessationConfirmed], ['TRIAGE_INVESTIGATION_TIME_EXHAUSTED', true]);
  await w.poll();
  assert.deepEqual(summary((await w.requests())[1]!), ['queued', []]);
  assert.deepEqual([w.bodies.length, writes(w)], [1, []]);
});

/** The next start of the Control is another release, whose Triager runs another pack. */
function changeRelease(w: World, release: string, pack: { id: string; version: string; manifestSha256: string }) {
  const { activate } = w.ports.triager;
  w.ports.release = release;
  w.ports.triager = { activate: async request => ({ ...(await activate(request)), skillPack: pack }) };
}
const nextPack = { id: 'factory-skills-next', version: '99.0.0', manifestSha256: 'e'.repeat(64) };

test('pack change: a request with an attempt left is investigated by the new release and pack with the balance it had; each attempt records the release and pack that ran it', async t => {
  const first = gated(() => 'I could not conclude.');
  const w = await world(t, [7], [first.turn, () => 'I could not conclude either.', conclude]);
  await w.start();
  await untilHolds('the first session to ask the model', () => w.bodies.length === 1);
  w.time.advance(minutes(6));
  first.open();
  const requeued = await w.settled(0, 'queued');
  await w.stop();
  changeRelease(w, 'release-next', nextPack);
  await w.start();
  const failed = await w.settled(0, 'failed');
  assert.deepEqual(
    failed.attempts!.map(attempt => [attempt.release, attempt.skillPack?.id, attempt.end?.code]),
    [
      ['release-under-test', 'factory-skills-v13', 'TRIAGER_ENDED_WITHOUT_VERDICT'],
      ['release-next', 'factory-skills-next', 'TRIAGER_ENDED_WITHOUT_VERDICT'],
    ],
  );
  assert.deepEqual(failed.attempts![0], requeued.attempts![0], 'the record of the earlier attempt is not rewritten');
  assert.deepEqual(failed.attempts![1]!.skillPack, nextPack);
  // Nothing was given back: the attempt of the earlier pack counts, and so do its six minutes.
  assert.match(firstPrompt(w.bodies[1]!), /## Remaining investigation time\n\n9 minutes\n/);
  assert.equal(failed.end?.code, 'TRIAGE_ATTEMPTS_EXHAUSTED');
  await w.poll();
  assert.equal(w.bodies.length, 2, 'no third attempt under the new pack');
});

test('pack change: a Verdict recorded under the earlier release and pack is published as it stands, without investigating again', async t => {
  const w = await world(t, [7], [conclude, conclude]);
  await w.start();
  const recorded = await w.settled(0, 'publishing');
  await w.stop();
  changeRelease(w, 'release-next', nextPack);
  await w.start();
  const [published] = await w.requests();
  assert.deepEqual([published!.state, published!.end?.code], ['concluded', 'VERDICT_PUBLISHED']);
  assert.deepEqual(published!.verdict, recorded.verdict);
  assert.deepEqual(
    published!.attempts!.map(attempt => [attempt.attempt, attempt.release, attempt.skillPack?.id]),
    [[recorded.verdict!.attempt, 'release-under-test', 'factory-skills-v13']],
  );
  assert.ok(comments(w, 7)[0]!.body.endsWith(text), 'the text recorded by the earlier pack, whole');
  assert.deepEqual([comments(w, 7).length, w.bodies.length, w.agents.length], [1, 1, 1], 'no new session');
});
