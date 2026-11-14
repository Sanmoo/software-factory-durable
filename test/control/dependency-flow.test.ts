import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, ShowView, ControlStatus, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, foreignPull, scope, dependencyPrincipal, type Remote } from './doubles.js';

// Flow level (Q11): real Control + Pi Durable + temporary SQLite; only GitHub (tracker/code repository) and the clock are doubled.
async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-dependencies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty',
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope] }, polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    return current;
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const list = async () => await current!.control.inspect({ kind: 'list' }) as ListView;
  const byNumber = async () => Object.fromEntries((await list()).works.map(work => [work.ticket.number, work])) as Record<number, WorkView>;
  const cycle = async () => { current!.time.advance(); await current!.time.sleeping(); };
  return { github, start, stop, list, byNumber, cycle, storagePath, control: () => current!.control };
}
const reasons = (work: WorkView) => work.dependencies.latest?.reasons.map(reason => reason.code);

test('AC3/AC8: an impeded Work keeps its FIFO position without blocking independents; only closed + completed releases an external blocker', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(1, { blockedBy: [3] }), remoteIssue(2), remoteIssue(3, { labels: [] })] };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  let works = await h.byNumber();
  let list = await h.list();
  assert.deepEqual(list.queues.normal, [works[1]!.work_id, works[2]!.work_id], 'admission order is kept');
  assert.deepEqual(works[1]!.impediments.map(item => item.code), ['DEPENDENCY_PENDING']);
  assert.deepEqual(reasons(works[1]!), ['EXTERNAL_BLOCKER_OPEN']);
  assert.deepEqual(works[1]!.dispatch, { state: 'held', reasons: ['DEPENDENCY_PENDING', 'EXECUTION_NOT_ENABLED'] });
  assert.deepEqual(works[2]!.impediments, []);
  assert.deepEqual(works[2]!.dispatch, { state: 'held', reasons: ['EXECUTION_NOT_ENABLED'] });
  assert.deepEqual(list.selection, { next: works[2]!.work_id, skipped: [{ work_id: works[1]!.work_id, reasons: ['DEPENDENCY_PENDING'] }] },
    'the impeded head is skipped; the independent Work is selected (dispatch itself stays closed)');
  for (const [state, stateReason, code] of [['open', 'reopened', 'EXTERNAL_BLOCKER_OPEN'], ['closed', 'not_planned', 'EXTERNAL_BLOCKER_NOT_COMPLETED'],
    ['closed', 'duplicate', 'EXTERNAL_BLOCKER_NOT_COMPLETED'], ['closed', null, 'EXTERNAL_BLOCKER_NOT_COMPLETED']] as const) {
    remote.issues[2] = remoteIssue(3, { labels: [], state, stateReason });
    await h.cycle();
    assert.deepEqual(reasons((await h.byNumber())[1]!), [code], `${state}/${stateReason}`);
  }
  remote.issues[2] = remoteIssue(3, { labels: [], state: 'closed', stateReason: 'completed' });
  await h.cycle();
  works = await h.byNumber();
  list = await h.list();
  assert.deepEqual([works[1]!.impediments, works[1]!.dependencies.latest!.conclusion], [[], 'satisfied']);
  assert.deepEqual(works[1]!.dispatch.reasons, ['EXECUTION_NOT_ENABLED']);
  assert.equal(list.selection.next, works[1]!.work_id, 'released Work regains its original FIFO turn');
  assert.deepEqual(works[1]!.history.map(item => item.event === 'dependencies-changed' ? [item.event, item.before, item.after] : [item.event]),
    [['admitted'], ['dependencies-changed', null, 'pending'], ['dependencies-changed', 'pending', 'satisfied']], 'transitions only, not every poll');
  const status = await h.control().inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual(status.dependencies, { satisfied: 2, pending: 0, inconclusive: 0, notEvaluated: 0 });
  assert.equal(status.selection.next, works[1]!.work_id);
});

test('AC4/AC8: an own blocker closed as completed with an open pull request does not release its dependent', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(1, { blockedBy: [2] }), remoteIssue(2)] };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  // The blocker Ticket is now a Factory Work. On GitHub it is closed/completed while a pull request is still open.
  remote.issues[1] = remoteIssue(2, { state: 'closed', stateReason: 'completed' });
  remote.pulls[2] = [foreignPull(42, { state: 'open' })];
  await h.cycle();
  const works = await h.byNumber();
  const latest = works[1]!.dependencies.latest!;
  assert.equal(latest.conclusion, 'pending');
  assert.deepEqual(latest.reasons.map(reason => [reason.code, reason.issueId]), [['OWN_CYCLE_NOT_DELIVERED', 7002]]);
  assert.deepEqual(latest.blockers.map(item => [item.number, item.classification, item.work_id, item.state, item.stateReason, item.satisfied]),
    [[2, 'own', works[2]!.work_id, 'closed', 'completed', false]]);
  assert.match(works[1]!.impediments[0]!.nextStep, /OWN_CYCLE_NOT_DELIVERED/);
  // The own classification comes from the durable index: it survives a restart and never degrades to "external".
  await h.stop();
  await (await h.start()).time.sleeping();
  const after = (await h.byNumber())[1]!;
  assert.equal(after.dependencies.latest!.blockers[0]!.classification, 'own');
});

test('AC2/AC5: inconclusive evaluations (rate limit, cycle, adapter failure) hold dispatch; an earlier complete evaluation never releases', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(1, { blockedBy: [3] }), remoteIssue(3, { labels: [], state: 'closed', stateReason: 'completed' })] };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  const first = (await h.byNumber())[1]!;
  assert.deepEqual([first.dependencies.latest!.conclusion, first.dispatch.reasons], ['satisfied', ['EXECUTION_NOT_ENABLED']]);
  const firstEvaluation = first.dependencies.latest!.evaluationId;

  remote.dependencyProblems = { 1: [{ code: 'DEPENDENCY_READ_UNAVAILABLE', observedCode: 'GITHUB_RATE_LIMITED', waitSeconds: 120, issueId: 7003, nextStep: 'wait' }] };
  time.advance();
  assert.equal(await time.sleeping(), 120000, 'service-indicated wait on a dependency read prevails');
  let work = (await h.byNumber())[1]!;
  assert.deepEqual([work.dependencies.latest!.conclusion, work.dependencies.latest!.completeness], ['inconclusive', 'incomplete']);
  assert.deepEqual(work.impediments.map(item => item.code), ['DEPENDENCY_EVALUATION_INCONCLUSIVE']);
  assert.deepEqual(work.dispatch.reasons, ['DEPENDENCY_EVALUATION_INCONCLUSIVE', 'EXECUTION_NOT_ENABLED']);
  assert.deepEqual([work.dependencies.lastComplete?.evaluationId, work.dependencies.lastComplete?.conclusion], [firstEvaluation, 'satisfied'],
    'the last complete evaluation stays visible but does not release');
  assert.equal((await h.list()).selection.next, null);

  delete remote.dependencyProblems;
  remote.issues[1] = remoteIssue(3, { labels: [], state: 'closed', stateReason: 'completed', blockedBy: [1] });
  await h.cycle();
  work = (await h.byNumber())[1]!;
  assert.deepEqual([work.dependencies.latest!.conclusion, reasons(work)], ['inconclusive', ['DEPENDENCY_CYCLE']]);
  assert.deepEqual(work.dependencies.latest!.cycles.length, 1);

  remote.issues[1] = remoteIssue(3, { labels: [], state: 'closed', stateReason: 'completed' });
  remote.graphThrows = true;
  time.advance();
  assert.equal(await time.sleeping(), 60000);
  time.advance();
  assert.equal(await time.sleeping(), 120000, 'unexpected dependency read failures feed the bounded backoff');
  work = (await h.byNumber())[1]!;
  assert.deepEqual([work.dependencies.latest!.conclusion, work.dependencies.latest!.reasons[0]!.observedCode], ['inconclusive', 'POLLING_QUERY_FAILED']);
  delete remote.graphThrows;
  await h.cycle();
  assert.equal((await h.byNumber())[1]!.dependencies.latest!.conclusion, 'satisfied');
});

test('AC5: each round re-reads the graph; the record carries source/principal/scope without token, instant, completeness and reasons; a restart makes it not current', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(1, { blockedBy: [3] }), remoteIssue(3, { labels: [], state: 'closed', stateReason: 'completed' })] };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  const first = (await h.byNumber())[1]!.dependencies.latest!;
  assert.deepEqual([first.source, first.completeness, first.conclusion, first.principals], ['github-rest', 'complete', 'satisfied', [dependencyPrincipal]]);
  assert.match(first.observedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(first.evaluatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(first.limitations.length > 0);
  await h.cycle();
  const second = (await h.byNumber())[1]!.dependencies.latest!;
  assert.notEqual(second.evaluationId, first.evaluationId);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(h.github.calls.filter(call => call.method === 'readDependencyGraph').length, 2, 'one fresh graph read per pending Work per round');
  await h.stop();

  // New owner: the stored evaluation is evidence, not a current authorization, until this run re-evaluates it.
  let release!: () => void;
  remote.hang = new Promise<void>(resolve => { release = resolve; });
  const restarted = await h.start();
  try {
    const stale = (await h.byNumber())[1]!;
    assert.equal(stale.dependencies.latest!.evaluationId, second.evaluationId);
    assert.deepEqual(stale.dispatch.reasons, ['DEPENDENCIES_NOT_CURRENT', 'EXECUTION_NOT_ENABLED']);
    assert.equal((await h.list()).selection.next, null);
    const shown = await h.control().inspect({ kind: 'show', work_id: stale.work_id }) as ShowView;
    assert.equal(shown.kind === 'work' && shown.work.dispatch.reasons.includes('DEPENDENCIES_NOT_CURRENT'), true);
  } finally { delete remote.hang; release(); }
  await restarted.time.sleeping();
  const fresh = (await h.byNumber())[1]!;
  assert.deepEqual(fresh.dispatch.reasons, ['EXECUTION_NOT_ENABLED']);
  await h.stop();
  const database = await readFile(h.storagePath);
  assert.equal(database.includes(Buffer.from('dependency-read')), true, 'principal metadata is durable');
  assert.equal(database.includes(Buffer.from('synthetic-installation-secret')), false);
});
