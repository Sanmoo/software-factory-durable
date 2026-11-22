import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openControl } from '../../src/control/index.js';
import { openStore } from '../../src/control/durable/store.js';
import { works, type WorkRecord } from '../../src/control/durable/admission.js';
import type { Control, ControlInput, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, facts, ownPull, type Activation } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (S), ticket 61: real Control + Pi Durable + temporary SQLite with ticket 13's real review rounds; GitHub, Sandbox, Workers and
// credentials doubled. Two Works of the same installation publish their OWN branches inside each other's publication window (pilot 2:
// #124/#125), then the pilot's blocked record is re-evaluated by the explicit operator command. Not evidence of a real VM, worker or GitHub.
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const ticketOf = (activation: Activation) => Number(/Ticket #(\d+)/.exec(activation.prompt)![1]);

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-publication61-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Only Ticket 3 at first: Ticket 4 is labelled once Work 3's publication activation runs (so its request snapshot predates both pushes).
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  const active4 = deferred(), pushed3 = deferred(), pushed4 = deferred();
  // The Builder's direct publication of each Work (own branch at its verified commit + own draft PR); each push lands inside the OTHER
  // Work's window: 3 waits for 4's activation, both pushes land before either activation ends (discovery runs only after cessation).
  const publish = async (target: Remote, activation: Activation) => {
    const { workId, branch, head } = facts(activation.prompt);
    const ticket = ticketOf(activation);
    if (ticket === 3) await active4.promise; else active4.resolve();
    (target.refs ??= {})[branch] = head;
    target.pulls[ticket] = [ownPull(workId, branch, head, ticket === 3 ? {} : { pullRequestId: 9005, nodeId: 'PR_node5', number: 5, url: 'https://github.com/acme/project/pull/5',
      body: [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the note. Closes #4', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n') })];
    (ticket === 3 ? pushed3 : pushed4).resolve();
    await (ticket === 3 ? pushed4 : pushed3).promise;
  };
  const execution = executionDoubles(remote, [{ kind: 'implement', head: 'd'.repeat(40) }, { kind: 'publish', publish, end: 'success' },
    { kind: 'implement', head: 'e'.repeat(40) }, { kind: 'publish', publish, end: 'success' }]);
  // Two Slots: Work 3's publication activation and Work 4's implementation run at the same time.
  execution.ports.capacity = 2;
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: execution.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
      polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const work = async (ticket: number) => ((await current!.control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === ticket) as WorkView;
  const settle = async (predicate: () => Promise<boolean>, label: string) => {
    await untilHolds(label, async () => {
      if (await predicate()) return true;
      if (current!.time.isSleeping()) current!.time.advance();
      return false;
    }, 5);
  };
  const cycles = async (n: number) => { for (let i = 0; i < n; i++) { current!.time.advance(); await current!.time.sleeping(); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  /** With the owner stopped: rewrites a stored Work exactly as an earlier version of Control left it. */
  async function seed(work_id: string, change: (work: WorkRecord) => void) {
    const store = await openStore(storagePath);
    await store.session.commit(async tx => { change((await tx.doc(works, work_id, null)).work!); }, BACKGROUND_CONTEXT);
    await store.close();
  }
  const accept = (input: ControlInput) => current!.control.accept(input);
  return { remote, start, stop, work, settle, cycles, activations, seed, accept };
}

test('ticket 61: two concurrent own publications of the same installation — neither blocks; the pilot block is re-evaluated by the operator', async t => {
  const h = await harness(t);
  await h.start();
  await h.settle(async () => h.activations().length >= 2, 'Work 3 publication activation running');
  assert.equal(ticketOf(h.activations()[1]!), 3);
  h.remote.issues.push(remoteIssue(4));
  await h.settle(async () => (await h.work(3))?.publication?.state === 'published' && (await h.work(4))?.publication?.state === 'published', 'both published');
  const [three, four] = [await h.work(3), await h.work(4)];
  // Each Work's request snapshot predates BOTH pushes, so each saw the other's own branch appear inside its window.
  assert.deepEqual(three.publication!.refsBefore, { 'refs/heads/main': 'b'.repeat(40) });
  assert.deepEqual(four.publication!.refsBefore, { 'refs/heads/main': 'b'.repeat(40) });
  for (const item of [three, four]) {
    assert.deepEqual(item.impediments.map(impediment => impediment.code), [], `Work ${item.ticket.number} carries no impediment`);
    assert.ok(!item.history.some(entry => entry.event === 'publication-blocked'), `Work ${item.ticket.number} was never blocked`);
  }
  assert.equal(h.activations().length, 4, 'one implementation and one publication activation per Work');

  // The pilot record, as the earlier rule left it: Work 3 blocked by Work 4's own branch, own PR linked but not published.
  await h.stop();
  const otherRef = `refs/heads/${four.branch}`;
  const blockedStep = 'Publication is not repeated or adopted automatically (old text).';
  await h.seed(three.work_id, record => {
    const publication = record.publication!;
    Object.assign(publication, { state: 'blocked', reasons: [`UNEXPECTED_REF_CHANGE:${otherRef}`], linkedHeads: [], nextStep: blockedStep });
    record.impediments = [{ code: 'PUBLICATION_BLOCKED', scope: 'work', since: 'x', nextStep: blockedStep },
      { code: 'GUEST_EFFECT_OUT_OF_SCOPE', scope: 'work', since: 'x', nextStep: 'old text' }];
  });
  // A real change outside both publications appeared meanwhile.
  h.remote.tags = { v9: 'd'.repeat(40) };
  await h.start();
  await h.cycles(3);
  assert.equal((await h.work(3)).publication!.state, 'blocked', 'a block is settled: nothing re-evaluates it without the operator');
  const request = (request_id: string, work_id = three.work_id): ControlInput =>
    ({ request_id, operation: 'reevaluate-publication', work_id, reason: 'Work 4 published its own branch concurrently (ticket 61).', origin: 'local-cli' });
  // Refusals change nothing.
  assert.deepEqual(await h.accept(request('re-other', four.work_id)), { kind: 'durable', request_id: 're-other', operation: 'reevaluate-publication', work_id: four.work_id,
    outcome: 'not-applied', reason: 'PUBLICATION_NOT_BLOCKED', nextStep: null });
  const first = await h.accept(request('re-1'));
  assert.deepEqual(first, { kind: 'durable', request_id: 're-1', operation: 'reevaluate-publication', work_id: three.work_id, outcome: 'accepted', reason: null,
    nextStep: 'The next discovery pass re-reads the remote (complete read required) and re-applies the discovery rule to the recorded window; nothing is published again.' });
  assert.deepEqual(await h.accept(request('re-1')), first, 'same identity and content: same receipt');
  assert.equal((await h.accept(request('re-1b')) as { outcome: string }).outcome, 'already-covered', 'a pending re-evaluation is not duplicated');
  await h.settle(async () => (await h.work(3)).publication!.reevaluation?.state === 'still-blocked', 're-evaluated: still blocked');
  let shown = await h.work(3);
  assert.equal(shown.publication!.state, 'blocked');
  assert.deepEqual(shown.publication!.reasons, ['UNEXPECTED_REF_CHANGE:refs/tags/v9'], 'Work 4\'s own branch is accepted, the tag is not');
  assert.deepEqual(shown.publication!.reevaluation!.reasons, ['UNEXPECTED_REF_CHANGE:refs/tags/v9']);
  assert.deepEqual(shown.impediments.map(item => item.code), ['PUBLICATION_BLOCKED', 'GUEST_EFFECT_OUT_OF_SCOPE']);
  assert.match(shown.impediments[0]!.nextStep, /refs\/tags\/v9/);
  assert.match(shown.impediments[0]!.nextStep, new RegExp(`factory reevaluate-publication ${three.work_id} --reason`), 'the command is named where it applies');
  await h.cycles(2);
  assert.equal((await h.work(3)).publication!.reevaluation!.state, 'still-blocked', 'one re-evaluation per request: never retried by itself');

  // The real change is undone: a new explicit request accepts the pilot case and continues to the normal next state (linked: published).
  delete h.remote.tags;
  const second = await h.accept(request('re-2'));
  assert.equal((second as { outcome: string }).outcome, 'accepted');
  await h.settle(async () => (await h.work(3)).publication!.state === 'published', 're-evaluated: published');
  shown = await h.work(3);
  assert.deepEqual(shown.publication!.reasons, []);
  assert.deepEqual([shown.publication!.reevaluation!.state, shown.publication!.reevaluation!.outcome, shown.publication!.reevaluation!.request_id], ['accepted', 'linked', 're-2']);
  assert.deepEqual(shown.publication!.linkedHeads, ['d'.repeat(40)]);
  assert.deepEqual(shown.impediments, [], 'both impediments of the false positive are lifted');
  assert.equal(h.activations().length, 4, 'the publication is never repeated');
  const events = shown.history.filter(entry => entry.event.startsWith('publication-reevaluat')).map(entry => [entry.event, (entry as { detail?: string }).detail]);
  assert.deepEqual(events, [['publication-reevaluation-requested', 're-1'], ['publication-reevaluated', 're-1:still-blocked:UNEXPECTED_REF_CHANGE:refs/tags/v9'],
    ['publication-reevaluation-requested', 're-2'], ['publication-reevaluated', 're-2:accepted:linked']]);
  assert.deepEqual(await h.accept(request('re-3')), { kind: 'durable', request_id: 're-3', operation: 'reevaluate-publication', work_id: three.work_id,
    outcome: 'not-applied', reason: 'PUBLICATION_NOT_BLOCKED', nextStep: null });
});

// Acceptance finding A14 (window 11, Work efc54451 / PR #136): the publish session created the Work's own PR with the marker mistyped by one
// character. One Work, one implementation and one publication activation; the human corrects the PR body on GitHub afterwards.
test('A14: a publication blocked by its own PR with a mistyped marker is re-evaluated by the operator once the marker is corrected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-publication-a14-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const mistype = (body: string, workId: string) => body.replace(workId, `${workId.slice(0, -1)}${workId.endsWith('0') ? '1' : '0'}`);
  const execution = executionDoubles(remote, [{ kind: 'implement', head: 'd'.repeat(40) }, { kind: 'publish', end: 'success', publish: (target, activation) => {
    const { workId, branch, head } = facts(activation.prompt);
    (target.refs ??= {})[branch] = head;
    const pull = ownPull(workId, branch, head);
    target.pulls[3] = [{ ...pull, body: mistype(pull.body!, workId) }];
  } }]);
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView;
  const settle = (predicate: () => Promise<boolean>, label: string) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  await settle(async () => (await work())?.publication?.state === 'blocked', 'blocked by the unknown pull request');
  let shown = await work();
  const marker = `<!-- software-factory:work:${shown.work_id} -->`;
  assert.deepEqual(shown.publication!.reasons, ['UNKNOWN_PULL_REQUEST:4']);
  assert.deepEqual(shown.publication!.discoveries.at(-1)!.candidates.map(item => [item.own, item.reasons]), [[false, ['MARKER_ABSENT']]]);
  assert.equal(shown.publication!.attempts!.length, 1);
  assert.ok(shown.publication!.refsBefore, 'the request snapshot of the window is recorded');
  assert.equal(shown.pullRequest ?? null, null, 'nothing is adopted');
  assert.deepEqual(shown.impediments.map(item => item.code), ['PUBLICATION_BLOCKED']);
  assert.ok(shown.impediments[0]!.nextStep.endsWith(` If pull request #4 is this Work's own publication with a wrong marker, correct the marker line of its body to exactly ` +
    `\`${marker}\` and re-evaluate with \`factory reevaluate-publication ${shown.work_id} --reason <text>\`.`), shown.impediments[0]!.nextStep);
  const request = (request_id: string): ControlInput => ({ request_id, operation: 'reevaluate-publication', work_id: shown.work_id, reason: 'PR #4 is the own publication.', origin: 'local-cli' });
  // Body not corrected yet: the command adopts nothing; the block stays with this read's reasons.
  assert.equal((await control.accept(request('a14-1')) as { outcome: string }).outcome, 'accepted');
  await settle(async () => (await work()).publication!.reevaluation?.state === 'still-blocked', 're-evaluated: still blocked');
  shown = await work();
  assert.deepEqual([shown.publication!.state, shown.publication!.reasons, shown.pullRequest ?? null], ['blocked', ['UNKNOWN_PULL_REQUEST:4'], null]);
  assert.deepEqual(shown.impediments.map(item => item.code), ['PUBLICATION_BLOCKED']);
  // The human corrects the marker line: the same rule now classifies the PR as own and links it; nothing is published again.
  remote.pulls[3]![0]!.body = ownPull(shown.work_id, shown.branch!, 'd'.repeat(40)).body;
  assert.equal((await control.accept(request('a14-2')) as { outcome: string }).outcome, 'accepted');
  await settle(async () => (await work()).publication!.state === 'published', 're-evaluated: published');
  shown = await work();
  assert.deepEqual([shown.publication!.reevaluation!.state, shown.publication!.reevaluation!.outcome, shown.publication!.reasons], ['accepted', 'linked', []]);
  assert.deepEqual([shown.pullRequest, shown.publication!.linkedHeads, shown.impediments], [{ number: 4, url: 'https://github.com/acme/project/pull/4' }, ['d'.repeat(40)], []]);
  assert.equal(execution.calls.filter(call => call.kind === 'activate').length, 2, 'one implementation and one publication activation: never repeated');
});
