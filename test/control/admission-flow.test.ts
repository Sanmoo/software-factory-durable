import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, ShowView, ControlStatus, PollingOptions } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, foreignPull, ticket, scope, type Remote } from './doubles.js';

// Flow level (Q11): real Control + Pi Durable + temporary SQLite; only GitHub (tracker/code repository) and the clock are doubled.
async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, polling: Partial<PollingOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start(before?: (control: Control) => Promise<unknown>) {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty',
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope] },
      polling: { intervalSeconds: 60, clock: time.clock, ...polling } });
    await before?.(control);
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    return current;
  }
  async function stop() {
    current!.stop.abort();
    assert.deepEqual(await current!.running, { kind: 'clean' });
  }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const list = async () => await current!.control.inspect({ kind: 'list' }) as ListView;
  const status = async () => await current!.control.inspect({ kind: 'status' }) as ControlStatus;
  return { github, start, stop, list, status, storagePath, control: () => current!.control, time: () => current!.time };
}

test('AC1/AC2: an eligible Ticket is admitted once with qualified identity; repeated polling does not duplicate', async t => {
  const remote: Remote = { issues: [remoteIssue(1)], pulls: {} };
  const h = await harness(t, remote);
  const { time } = await h.start();
  assert.equal(await time.sleeping(), 60000);
  const first = await h.list();
  assert.equal(first.works.length, 1);
  const work = first.works[0]!;
  assert.deepEqual(work.ticket, ticket(1));
  assert.deepEqual(work.repository, { repository: 'acme/project', repositoryId: 3, base: 'main' });
  assert.equal(work.result, 'open');
  assert.equal(work.authorization.state, 'authorized');
  assert.deepEqual(work.authorization.basis, { repositoryConfigured: true, issueState: 'open', label: { id: 55, name: 'ready-for-agent' } });
  assert.deepEqual(work.queue, { category: 'normal', sequence: 1, pending: true });
  for (let cycle = 0; cycle < 3; cycle++) { time.advance(); await time.sleeping(); }
  const again = await h.list();
  assert.deepEqual(again.works.map(w => [w.work_id, w.queue.sequence]), [[work.work_id, 1]]);
  assert.equal(again.polling.repositories[0]!.candidates![0]!.outcome, 'existing');
  // Re-reads only happen for unindexed candidates.
  assert.equal(h.github.calls.filter(c => c.method === 'readTicket').length, 1);
  assert.equal(h.github.calls.filter(c => c.method === 'listCandidates').length, 4);
});

test('AC1: unconfigured repository, closed issue, missing label, pull request and identity drift never authorize entry', async t => {
  const remote: Remote = { pulls: {}, issues: [
    remoteIssue(2, { pullRequest: true }), remoteIssue(3, { reread: { issueId: 99999 } }), remoteIssue(4),
  ], extraListed: [ticket(5, { repository: 'acme/other', repositoryId: 4, url: 'https://github.com/acme/other/issues/5' })] };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  // Between listing and re-read the issue closes and another loses its label: the re-read decides.
  remote.issues[2] = remoteIssue(4, { state: 'closed' });
  remote.issues.push(remoteIssue(6, { labels: [] }));
  const holds = (await h.list()).polling.repositories[0]!.candidates!.map(c => [c.ticket.number, c.outcome === 'held' ? c.holds.map(x => x.code) : c.outcome]);
  assert.deepEqual(holds, [[2, ['TICKET_IS_PULL_REQUEST']], [3, ['TICKET_IDENTITY_MISMATCH']], [4, 'admitted'], [5, ['REPOSITORY_NOT_CONFIGURED']]]);
  time.advance(); await time.sleeping();
  const list = await h.list();
  assert.deepEqual(list.works.map(w => w.ticket.number), [4], 'closing after admission does not create or remove Works');
  assert.equal(list.polling.repositories[0]!.candidates!.some(c => c.ticket.number === 6), false, 'unlabelled issue is not even a candidate');
  remote.extraListed = [ticket(8)];
  remote.issues.push(remoteIssue(8, { state: 'closed' }));
  time.advance(); await time.sleeping();
  const closed = (await h.list()).polling.repositories[0]!.candidates!.find(c => c.ticket.number === 8)!;
  assert.deepEqual(closed.outcome === 'held' && closed.holds.map(x => x.code), ['TICKET_NOT_OPEN']);
  remote.extraListed = [ticket(9)];
  remote.issues.push(remoteIssue(9, { labels: [{ id: 1, name: 'other' }] }));
  time.advance(); await time.sleeping();
  const unlabelled = (await h.list()).polling.repositories[0]!.candidates!.find(c => c.ticket.number === 9)!;
  assert.deepEqual(unlabelled.outcome === 'held' && unlabelled.holds.map(x => x.code), ['LABEL_NOT_PRESENT']);
  assert.deepEqual((await h.list()).works.map(w => w.ticket.number), [4]);
});

test('AC2: restart over the same storage preserves the index, Work identity and admission sequence', async t => {
  const remote: Remote = { issues: [remoteIssue(1)], pulls: {} };
  const h = await harness(t, remote);
  let { time } = await h.start();
  await time.sleeping();
  const [before] = (await h.list()).works;
  await h.stop();
  remote.issues.push(remoteIssue(2));
  ({ time } = await h.start());
  await time.sleeping();
  const after = await h.list();
  assert.deepEqual(after.works.map(w => [w.work_id, w.ticket.issueId, w.queue.sequence]), [[before!.work_id, 7001, 1], [after.works[1]!.work_id, 7002, 2]]);
  assert.deepEqual(after.queues.normal, after.works.map(w => w.work_id));
  assert.equal((await h.status()).works.total, 2);
});

test('AC3: an associated pull request not recognised as own blocks admission and is reported with reason and next step', async t => {
  const remote: Remote = { issues: [remoteIssue(1), remoteIssue(2)], pulls: { 1: [foreignPull(41, { state: 'closed', merged: true })] }, };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  const list = await h.list();
  assert.deepEqual(list.works.map(w => w.ticket.number), [2]);
  const held = list.polling.repositories[0]!.candidates!.find(c => c.ticket.number === 1)!;
  assert.equal(held.outcome, 'held');
  if (held.outcome !== 'held') return;
  assert.equal(held.holds[0]!.code, 'FOREIGN_PULL_REQUEST');
  assert.deepEqual(held.holds[0]!.pullRequests, [{ pullRequestId: 9041, number: 41, url: 'https://github.com/acme/project/pull/41', state: 'closed', merged: true, association: ['closing-reference'] }]);
  assert.match(held.holds[0]!.nextStep, /neither adopted nor admitted/);
  assert.doesNotMatch(held.holds[0]!.nextStep, /close it/, 'a closed/merged foreign PR keeps blocking; closing is not a remedy');
  assert.match(held.holds[0]!.nextStep, /closed or merged/);
  // Unknown publication state is not absence either.
  remote.pulls = {};
  remote.publicationFailure = { code: 'GITHUB_QUERY_FAILED' };
  time.advance(); await time.sleeping();
  const unknown = (await h.list()).polling.repositories[0]!.candidates!.find(c => c.ticket.number === 1)!;
  assert.deepEqual(unknown.outcome === 'held' && unknown.holds.map(x => [x.code, x.observedCode]), [['PUBLICATION_UNKNOWN', 'GITHUB_QUERY_FAILED']]);
  assert.equal((await h.list()).works.length, 1);
  delete remote.publicationFailure;
  time.advance(); await time.sleeping();
  assert.deepEqual((await h.list()).works.map(w => w.ticket.number), [2, 1], 'operator resolution on GitHub lets the next poll admit');
});

test('AC4: list/show/status keep result, authorization, queue and impediments distinct; failures never prove absence', async t => {
  const remote: Remote = { issues: [remoteIssue(1)], pulls: {} };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  const [work] = (await h.list()).works;
  const shown = await h.control().inspect({ kind: 'show', work_id: work!.work_id }) as ShowView;
  assert.equal(shown.kind, 'work');
  if (shown.kind !== 'work') return;
  assert.deepEqual(Object.keys(shown.work).filter(k => ['result', 'authorization', 'queue', 'impediments', 'dispatch', 'execution', 'pullRequest'].includes(k)).sort(),
    ['authorization', 'dispatch', 'execution', 'impediments', 'pullRequest', 'queue', 'result']);
  assert.deepEqual(shown.work.impediments, [], 'the admission placeholder is replaced by the real evaluation of the same round');
  assert.deepEqual([shown.work.dependencies.latest?.conclusion, shown.work.dependencies.latest?.completeness], ['satisfied', 'complete']);
  assert.equal(shown.work.execution, null);
  assert.equal(shown.lastPolled?.outcome, 'admitted');
  assert.deepEqual(await h.control().inspect({ kind: 'show', work_id: '00000000-0000-4000-8000-000000000000' }),
    { kind: 'work-not-found', work_id: '00000000-0000-4000-8000-000000000000', nextStep: 'No Work with this identity in the controller authority; use `factory list`.' });
  remote.listFailure = { code: 'GITHUB_RATE_LIMITED', waitSeconds: 300 };
  time.advance();
  assert.equal(await time.sleeping(), 300000, 'service-indicated wait prevails over the interval');
  const failed = await h.list();
  const repo = failed.polling.repositories[0]!;
  assert.deepEqual([repo.state, repo.completeness, repo.candidates, repo.absenceProven, repo.code, repo.waitSeconds], ['unavailable', 'incomplete', null, false, 'GITHUB_RATE_LIMITED', 300]);
  assert.deepEqual(failed.works.map(w => w.work_id), [work!.work_id], 'failed listing neither removes nor suspends the existing Work');
  assert.equal(failed.works[0]!.authorization.state, 'authorized');
  const status = await h.status();
  assert.equal(status.dispatch, 'closed');
  assert.deepEqual(status.queues, { normal: 1, repair: 0 });
  assert.equal('candidates' in status.polling.repositories[0]!, false);
});

test('AC5: default 60 s cadence is configurable; failures back off; a slow query never overlaps the next one', async t => {
  const remote: Remote = { issues: [], pulls: {}, listFailure: { code: 'GITHUB_QUERY_FAILED' } };
  const h = await harness(t, remote, { intervalSeconds: 5 });
  const { time } = await h.start();
  const delays = [];
  for (let i = 0; i < 4; i++) { delays.push(await time.sleeping()); time.advance(); }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000]);
  delete remote.listFailure;
  assert.equal(await time.sleeping(), 5000, 'success restores the configured interval');
  let release!: () => void;
  remote.hang = new Promise<void>(resolve => { release = resolve; });
  const calls = h.github.calls.length;
  time.advance();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(time.isSleeping(), false);
  assert.equal(h.github.calls.length, calls + 1, 'one in-flight query, no new trigger while it is pending');
  assert.equal((await h.status()).polling.state, 'polling');
  release();
  assert.equal(await time.sleeping(), 5000);
  assert.equal(h.github.concurrency(), 1);
});

test('AC5: global pause stops new admissions but not tracking; unpause admits by the next poll', async t => {
  const remote: Remote = { issues: [remoteIssue(1)], pulls: {} };
  const h = await harness(t, remote);
  const { time, control } = await h.start(control => control.accept({ request_id: 'pause-1', operation: 'pause', origin: 'local-cli' }));
  await time.sleeping();
  remote.issues.push(remoteIssue(2));
  time.advance(); await time.sleeping();
  const paused = await h.list();
  assert.equal(paused.paused, true);
  assert.equal(paused.works.length, 0);
  assert.deepEqual(paused.polling.repositories[0]!.candidates!.map(c => [c.ticket.number, c.outcome === 'held' && c.holds.map(x => x.code)]),
    [[1, ['GLOBAL_PAUSE']], [2, ['GLOBAL_PAUSE']]]);
  assert.equal(h.github.calls.filter(c => c.method === 'listCandidates').length, 2, 'tracking continues while paused');
  assert.equal(h.github.calls.filter(c => c.method !== 'listCandidates').length, 0, 'no admission reads while paused');
  await control.accept({ request_id: 'unpause-1', operation: 'unpause', origin: 'local-cli' });
  time.advance(); await time.sleeping();
  assert.deepEqual((await h.list()).works.map(w => w.ticket.number).sort(), [1, 2]);
});

test('AC6/AC7: only read operations are used and dispatch stays held behind the execution barrier', async t => {
  const remote: Remote = { issues: [remoteIssue(1)], pulls: {} };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  assert.deepEqual([...new Set(h.github.calls.map(c => c.method))].sort(), ['findPublication', 'listCandidates', 'readDependencyGraph', 'readTicket']);
  const [work] = (await h.list()).works;
  assert.deepEqual(work!.dispatch, { state: 'held', reasons: ['EXECUTION_NOT_ENABLED'] });
  assert.equal((await h.status()).dispatch, 'closed');
  await h.stop();
  const database = await readFile(h.storagePath);
  assert.equal(database.includes(Buffer.from('ready-for-agent')), true, 'admission evidence is durable');
});

test('AC5: one findPublication per repository cycle is shared by every authorized candidate; per-Ticket incomplete holds', async t => {
  const remote: Remote = { issues: [remoteIssue(1), remoteIssue(2), remoteIssue(3), remoteIssue(4, { labels: [] })], pulls: { 2: [foreignPull(42)] },
    incompleteAssociation: { 3: { code: 'ASSOCIATION_UNIDENTIFIED' } } };
  const h = await harness(t, remote);
  const { time } = await h.start();
  await time.sleeping();
  const publications = h.github.calls.filter(c => c.method === 'findPublication');
  assert.equal(publications.length, 1);
  assert.deepEqual((publications[0]!.args as { issueNumbers: number[] }).issueNumbers, [1, 2, 3]);
  const view = await h.list();
  assert.deepEqual(view.works.map(w => w.ticket.number), [1]);
  assert.deepEqual(view.polling.repositories[0]!.candidates!.map(c => [c.ticket.number, c.outcome === 'held' ? c.holds.map(x => [x.code, x.observedCode ?? null]) : c.outcome]),
    [[1, 'admitted'], [2, [['FOREIGN_PULL_REQUEST', null]]], [3, [['PUBLICATION_UNKNOWN', 'ASSOCIATION_UNIDENTIFIED']]]]);
  time.advance(); await time.sleeping();
  const second = h.github.calls.filter(c => c.method === 'findPublication');
  assert.equal(second.length, 2);
  assert.deepEqual((second[1]!.args as { issueNumbers: number[] }).issueNumbers, [2, 3], 'indexed Ticket 1 is not re-evaluated');
});

test('AC5: unexpected per-candidate evaluation failures feed the same bounded backoff', async t => {
  const remote: Remote = { issues: [remoteIssue(1)], pulls: {}, readThrows: true };
  const h = await harness(t, remote);
  const { time } = await h.start();
  const delays = [];
  for (let i = 0; i < 2; i++) { delays.push(await time.sleeping()); time.advance(); }
  delays.push(await time.sleeping());
  assert.deepEqual(delays, [60000, 120000, 240000]);
  const held = (await h.list()).polling.repositories[0]!.candidates![0]!;
  assert.deepEqual(held.outcome === 'held' && held.holds.map(x => [x.code, x.observedCode]), [['TICKET_READ_UNAVAILABLE', 'POLLING_QUERY_FAILED']]);
  delete remote.readThrows;
  time.advance();
  assert.equal(await time.sleeping(), 60000, 'success restores the configured interval');
  assert.equal((await h.list()).works.length, 1);
});
