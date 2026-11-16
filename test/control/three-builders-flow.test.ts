import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ListView } from '../../src/control/types.js';
import type { Invocation } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { recoveryDoubles, updateHost, type RecoveryScript } from './recovery-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (Q11), ticket 24: real Control + Pi Durable/SQLite + Records + the Workers receipt facet; doubled Sandbox host (file-backed boots),
// Builder, credentials and GitHub. Proves the Control side of three simultaneous Builders: every free Slot is filled in one dispatch pass, no
// global/repository mutex, own environment/boot/branch per Work, failure isolation, uncertain capacity kept, and FIFO positions kept while
// impeded Works are skipped. NOT evidence of real VMs, Docker, workers or the model (that is the ticket 24 real run).

/** The Builder script by Ticket number (read from the activation prompt: the Work record may not be listed yet when the first pass activates). */
type Script = (ticket: number | undefined, invocation: Invocation) => RecoveryScript | undefined;
const ticketOf = (invocation: Invocation) => { const found = /\/issues\/(\d+)\b/.exec(invocation.prompt); return found ? Number(found[1]) : undefined; };
async function harness(t: { after(fn: () => Promise<void>): void }, options: { issues: number[]; capacity: number; script?: Script; reviews?: boolean;
  onActivate?: (invocation: Invocation, ticket: number | undefined) => void; wrap?: (github: ReturnType<typeof githubDoubles>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-three-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: options.issues.map(number => remoteIssue(number)) };
  const github = githubDoubles(remote);
  options.wrap?.(github);
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  const doubles = recoveryDoubles(dir, [], { capacity: options.capacity, ...(options.reviews ? { reviews: true } : {}),
    script: invocation => options.script?.(ticketOf(invocation), invocation),
    onActivate: invocation => options.onActivate?.(invocation, ticketOf(invocation)) });
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: doubles.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  current = { control, stop, running: control.run(stop.signal), time };
  t.after(async () => { if (!current!.stop.signal.aborted) { current!.stop.abort(); await current!.running; } });
  const list = async () => await current!.control.inspect({ kind: 'list' }) as ListView;
  const work = async (number: number) => (await list()).works.find(item => item.ticket.number === number)!;
  const status = async () => await current!.control.inspect({ kind: 'status' }) as ControlStatus;
  // Polls without advancing the polling clock: the dispatch pass under test is exactly the one of the cycle that just ran.
  const state = async () => JSON.stringify((await list()).works.map(item => [item.ticket.number, item.execution?.state, item.execution?.held?.code ?? null,
    item.execution?.slot.held, item.execution?.end?.outcome ?? null, item.impediments.map(impediment => impediment.code)]));
  let last = '';
  // Polls without advancing the polling clock (the dispatch pass under test is the one of the cycle that just ran); bounded by the runner budget.
  const until = (predicate: () => Promise<boolean> | boolean, label: string) =>
    untilHolds(() => `${label} not reached: ${last}`, async () => { const ok = await predicate(); if (!ok) last = await state(); return ok; }, 5);
  const admitted = async () => { await current!.time.sleeping(); };
  const cycle = async () => { current!.time.advance(); await current!.time.sleeping(); };
  return { dir, github, doubles, list, work, status, until, admitted, cycle, stop: async () => { current!.stop.abort(); return current!.running; } };
}
const builders = (h: Awaited<ReturnType<typeof harness>>) => h.doubles.calls('activate');
const hang: Script = () => ({ kind: 'hang' });

test('AC1/AC2: one dispatch pass fills every free Slot (FIFO), three Builders run at once in their own environment, boot and branch — two (here all) in the same repository, no global mutex', async t => {
  const h = await harness(t, { issues: [3, 4, 5, 6], capacity: 3, script: hang });
  await h.admitted();
  // The SAME polling cycle reserved three Executions (no Slot waits for a later cycle); the fourth Work keeps its FIFO position.
  await h.until(async () => builders(h).length === 3, 'three Builders activated');
  await h.until(async () => (await h.list()).works.filter(item => item.execution?.state === 'started').length === 3, 'three Builders started');
  const view = await h.list();
  assert.deepEqual(view.slots, { capacity: 3, held: 3 });
  const running = [3, 4, 5].map(number => view.works.find(item => item.ticket.number === number)!);
  assert.ok(running.every(item => item.execution?.state === 'started' && item.execution.slot.held), 'all three started and none ended: no mutex serialised them');
  assert.equal(new Set(running.map(item => item.execution!.dispatch.environment)).size, 3, 'own environment per Work');
  assert.equal(new Set(running.map(item => item.execution!.dispatch.boot)).size, 3, 'own boot (VM) per Work');
  assert.equal(new Set(running.map(item => item.execution!.request.branch)).size, 3, 'own branch per Work');
  assert.ok(running.every(item => item.repository.repository === 'acme/project'), 'the same repository');
  // Ticket 24 decision 4: the three boots of ONE dispatch pass carry the same pass identity (the Sandbox sums their guest memory).
  const passes = h.doubles.calls('start').map(item => (item.detail as { pass: string | null }).pass);
  assert.equal(passes.length, 3);
  assert.ok(passes[0] && passes.every(pass => pass === passes[0]), JSON.stringify(passes));
  const fourth = view.works.find(item => item.ticket.number === 6)!;
  assert.deepEqual([fourth.execution, fourth.queue.pending, view.queues.normal.at(-1)], [null, true, fourth.work_id]);
  assert.deepEqual(view.queues.normal, [fourth.work_id], 'the three running Works left the queue');
  // The admission order is the FIFO order of the dispatch (sequence ascending).
  const sequences = [3, 4, 5, 6].map(number => view.works.find(item => item.ticket.number === number)!.queue.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
  // Another cycle with no free Slot launches nothing.
  await h.cycle();
  assert.equal(builders(h).length, 3);
  // One Builder ends: ONLY its Slot is freed (after its own cessation) and the queued Work takes it; the others keep running untouched.
  h.doubles.finishExecution(running[1]!.execution!.executionId);
  await h.until(async () => (await h.work(4)).execution?.slot.held === false, 'Work #4 released');
  await h.cycle();
  await h.until(async () => builders(h).length === 4 && (await h.work(6)).execution?.state === 'started', 'queued Work dispatched into the freed Slot');
  assert.deepEqual([(await h.work(3)).execution!.state, (await h.work(5)).execution!.state, (await h.work(6)).execution!.state], ['started', 'started', 'started']);
  const later = h.doubles.calls('start').map(item => (item.detail as { pass: string | null }).pass);
  assert.ok(later[3] && later[3] !== passes[0], 'a later pass has its own identity');
  const stops = h.doubles.calls('stop').map(item => (item.detail as { boot: string }).boot);
  assert.deepEqual(stops, [running[1]!.execution!.dispatch.boot], 'only the ended Work\'s own boot was stopped');
});

test('AC6: one Work\'s worker failure and unconfirmed cessation never stop the others, keep its Slot (capacity is not freed by guess) and never get a substitute writer', async t => {
  const h = await harness(t, { issues: [3, 4, 5, 6], capacity: 3,
    script: ticket => ticket === 4 ? { kind: 'fail', code: 'WORKER_ADAPTER_FAILED' } : { kind: 'hang' },
    // Work #4's VMM/adapter cannot be confirmed stopped (its unit never reports cessation).
    onActivate(invocation, ticket) { if (ticket === 4) updateHost(h.dir, state => { state.stuck.push(invocation.context.bootRef); }); } });
  await h.admitted();
  await h.until(async () => (await h.work(4)).execution?.end?.outcome === 'failure', 'Work #4 ended');
  const failed = await h.work(4);
  assert.deepEqual([failed.execution!.state, failed.execution!.end!.cessation, failed.execution!.slot.held], ['ended', 'unconfirmed', true]);
  await h.until(async () => (await h.work(3)).execution?.state === 'started' && (await h.work(5)).execution?.state === 'started', 'the others started');
  for (let i = 0; i < 3; i++) await h.cycle();
  const view = await h.list();
  assert.deepEqual(view.slots, { capacity: 3, held: 3 }, 'the uncertain Slot still counts');
  assert.deepEqual([(await h.work(3)).execution?.state, (await h.work(5)).execution?.state], ['started', 'started'],
    `the others keep running: ${JSON.stringify(view.works.map(item => [item.ticket.number, item.execution?.state, item.execution?.end ?? null]))}`);
  assert.equal((await h.work(6)).execution, null, 'no Work takes the uncertain Slot');
  assert.equal(builders(h).filter(item => (item.detail as { executionId: string }).executionId === failed.execution!.executionId).length, 1);
  assert.equal((await h.work(4)).execution!.executionId, failed.execution!.executionId, 'no substitute Execution (no second writer) for #4');
  // An independent Work ending normally frees ITS Slot: the queued Work proceeds while #4 stays held.
  h.doubles.finishExecution((await h.work(3)).execution!.executionId);
  await h.until(async () => (await h.work(3)).execution?.slot.held === false, 'Work #3 released');
  await h.cycle();
  await h.until(async () => (await h.work(6)).execution?.state === 'started', 'Work #6 started');
  assert.deepEqual([(await h.work(4)).execution!.end!.cessation, (await h.work(4)).execution!.slot.held], ['unconfirmed', true]);
  // The held Slot stays durable evidence of unsettled activity (ticket 33's rule). NOTE (open question, ticket 24 evidence): `run()` still
  // reports this administrative stop as `clean`, because only activities interrupted BY the stop are counted; not changed here.
  assert.deepEqual((await h.status()).slots, { capacity: 3, held: 3 });
});

test('AC2: a Work refused by its own revalidation in the dispatch pass is skipped in that pass without losing its position; the independents behind it start', async t => {
  let reads = 0;
  const h = await harness(t, { issues: [3, 4], capacity: 1, script: hang, wrap: github => {
    // The polling read admits #3; its dispatch revalidation right after it observes the label removed (a withdrawal between the two reads).
    const read = github.tracker.readTicket.bind(github.tracker);
    github.tracker.readTicket = async ref => {
      const observed = await read(ref);
      return ref.number === 3 && ++reads > 1 && observed.kind === 'observed' ? { ...observed, labels: [] } : observed;
    };
  } });
  await h.admitted();
  await h.until(async () => (await h.work(4)).execution?.state === 'started', '#4 started');
  const [three, four] = [await h.work(3), await h.work(4)];
  assert.equal(four.execution?.state, 'started', 'the independent Work behind the refused head started in the SAME pass');
  assert.deepEqual([three.execution, three.queue.pending, three.queue.category], [null, true, 'normal']);
  assert.ok(three.queue.sequence < four.queue.sequence, '#3 keeps its earlier FIFO position');
  assert.deepEqual((await h.list()).queues.normal, [three.work_id]);
});

test('AC3: a Question frees the Slot after cessation (the queued Work starts); reviewers of another Work share that Work\'s Slot', async t => {
  const h = await harness(t, { issues: [3, 4, 5], capacity: 2, reviews: true,
    script: ticket => ticket === 3 ? { kind: 'ask', questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000024', question: 'Which flavour?' }
      : ticket === 4 ? { kind: 'handoff' } : { kind: 'hang' } });
  await h.admitted();
  // #4 hands off: both reviewers run on its boot; #3 asks and ends.
  await h.until(async () => h.doubles.calls('activate-reviewer').length === 2, 'reviewers of #4 active');
  await h.until(async () => (await h.work(3)).execution?.end?.outcome === 'question' && (await h.work(3)).execution?.slot.held === false, '#3 waits for its answer');
  const reviewerBoots = h.doubles.calls('activate-reviewer').map(item => (item.detail as { boot: string }).boot);
  assert.deepEqual(new Set(reviewerBoots), new Set([(await h.work(4)).execution!.dispatch.boot]), 'reviewers run on the Builder\'s own boot');
  await h.cycle();
  await h.until(async () => (await h.work(5)).execution?.state === 'started', 'the queued Work took the Slot freed by the Question');
  // Two Builders + two reviewers active, two Slots held: reviewers consume no Slot; the waiting Work holds none.
  assert.deepEqual((await h.list()).slots, { capacity: 2, held: 2 });
  assert.ok((await h.work(3)).impediments.some(item => item.code === 'QUESTION_PENDING'));
});

test('review LOW: a dispatch pass stops after a bounded number of refused revalidations (GitHub reads per pass are capped); the rest waits for the next pass', async t => {
  const dispatchReads = new Map<number, number>();
  const h = await harness(t, { issues: [3, 4, 5, 6, 7, 8], capacity: 1, script: hang, wrap: github => {
    const read = github.tracker.readTicket.bind(github.tracker);
    github.tracker.readTicket = async ref => {
      // Only the dispatcher's own revalidation read (synchronous caller frame), not polling or the cycle desk.
      const revalidation = /revalidateAuthorization/.test(new Error().stack ?? '');
      const observed = await read(ref);
      if (!revalidation) return observed;
      dispatchReads.set(ref.number, (dispatchReads.get(ref.number) ?? 0) + 1);
      // #3..#7: the revalidation read is transiently unavailable (never a durable withdrawal, ticket 25); #8 stays authorized.
      return ref.number < 8 ? { kind: 'unavailable' as const, source: 'github-rest' as const, observedAt: new Date().toISOString(), repository: ref.repository,
        completeness: 'incomplete' as const, code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'synthetic transient' } : observed;
    };
  } });
  await h.admitted();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal([...dispatchReads.values()].reduce((sum, value) => sum + value, 0), 4, `four refused revalidations, then the pass ends (${JSON.stringify([...dispatchReads])})`);
  assert.equal(dispatchReads.has(7), false);
  assert.equal((await h.work(8)).execution, null, 'deferred, keeping its position');
});
