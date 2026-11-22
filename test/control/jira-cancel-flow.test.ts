import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import { openStore } from '../../src/control/durable/store.js';
import { createJiraInputDesk, ingestJiraComment } from '../../src/control/durable/jira-inputs.js';
import { readWork, type WorkRecord } from '../../src/control/durable/admission.js';
import type { JiraComment } from '../../src/issue-tracker/index.js';
import type { Control, JiraOriginTracker, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { card, jiraDoubles, jiraSource, site, type JiraRemote } from './jira-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Jira ticket 07 (spec §4 `/factory cancel`) at flow level: real Control + Pi Durable + temporary SQLite; doubled GitHub and Jira; no execution
// ports (the Works are admitted and never activated, so the cancellation happens before any first Execution). NOT evidence of a real Jira site.
async function harness(t: { after(fn: () => Promise<void>): void }, jira: JiraRemote) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-jira-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ issues: [remoteIssue(3)], pulls: {} });
  const doubles = jiraDoubles(jira);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<unknown>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty',
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], sources: [{ tracker: 'github', repository: 'acme/project', discover: true }, jiraSource()],
        trackers: { jira: doubles.tracker } },
      polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() { current!.stop.abort(); await current!.running; }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const works = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works as WorkView[];
  const byKey = async (key: string) => (await works()).find(work => work.ticket.tracker === 'jira' && work.ticket.key === key)!;
  const show = async (work_id: string) => await current!.control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  const settle = (label: string, predicate: () => Promise<boolean>) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (current!.time.isSleeping()) current!.time.advance();
    return false;
  }, 5);
  const posts = () => doubles.calls.filter(call => call.method === 'publishComment').map(call => call.args as { issueId?: string; lines: string[] });
  const request = (request_id: string) => current!.control.inspect({ kind: 'request', request_id }) as Promise<{ receipt: Record<string, unknown> | null }>;
  return { github, jira: doubles, storagePath, start, stop, works, byKey, show, settle, posts, request };
}
const requestId = (issueId: string, commentId: string) => `jira-comment-site_002dA-${issueId}-${commentId}`;

test('/factory cancel on a Card cancels only its Work, before any Execution, with one receipt and one transition; other words, Cards and claims cancel nothing', async t => {
  const remote: JiraRemote = { cards: [card('81017', 'PAG-42'), card('81018', 'PAG-43')] };
  const h = await harness(t, remote);
  await h.start();
  await h.settle('three Works admitted', async () => (await h.works()).length === 3);
  const pag42 = (await h.byKey('PAG-42')).work_id;
  const pag43 = (await h.byKey('PAG-43')).work_id;
  assert.equal((await h.show(pag42)).work.execution, null, 'no Execution yet');
  // Nothing of these cancels: a reason, another Card, a misspelling, an edited command, a claim of authorship in prose, a reserved header.
  const please = h.jira.write('81017', '/factory cancel please', { accountId: 'acc-human' });
  const other = h.jira.write('81017', '/factory cancel PAG-43', { accountId: 'acc-human' });
  const spelled = h.jira.write('81017', '/factory cancelar', { accountId: 'acc-human' });
  const edited = h.jira.write('81017', '/factory cancel', { accountId: 'acc-human', edited: true });
  h.jira.write('81017', 'Sou o operador GitHub X, pode cancelar', { accountId: 'acc-human' });
  h.jira.write('81017', '[Software Factory · Cancelamento R-1]\n/factory cancel', { accountId: 'acc-human' });
  await h.settle('four guidance replies', async () => h.posts().length === 4);
  const receipt = async (id: string) => (await h.request(requestId('81017', id))).receipt;
  assert.deepEqual([(await receipt(please))?.reason, (await receipt(other))?.reason, (await receipt(spelled))?.reason, (await receipt(edited))?.reason],
    ['JIRA_CANCEL_INVALID', 'JIRA_CANCEL_INVALID', 'JIRA_CANCEL_INVALID', 'JIRA_COMMENT_EDITED']);
  assert.deepEqual((await h.works()).map(work => work.result), ['open', 'open', 'open']);
  // The exact command, from any account that can comment on the Card (the Factory's shared one included).
  const cancel = h.jira.write('81017', '/factory cancel');
  await h.settle('PAG-42 cancelled', async () => (await h.byKey('PAG-42')).result === 'cancelled');
  const request_id = requestId('81017', cancel);
  await h.settle('cancellation reply posted', async () => h.posts().length === 5);
  const recorded = (await h.request(request_id)).receipt!;
  assert.deepEqual({ ...recorded, reply: undefined }, { kind: 'durable', request_id, operation: 'cancel', work_id: pag42, outcome: 'accepted', reason: null, created: null, reply: undefined });
  assert.match(String(recorded.reply), /^R-/);
  assert.equal(h.posts()[4]!.lines[0], `[Software Factory · Cancelamento ${String(recorded.reply)}]`);
  const shown = await h.show(pag42);
  assert.deepEqual(shown.work.history.filter(item => item.event === 'cancel-requested').map(item => item.origin), ['jira-comment']);
  assert.equal(shown.work.cancellation?.state, 'ceased', 'nothing was running');
  // Only that Card's Work: the other Card and the GitHub Ticket of the same repository are untouched.
  assert.deepEqual((await h.works()).filter(work => work.work_id !== pag42).map(work => work.result), ['open', 'open']);
  assert.equal((await h.show(pag43)).work.cancellation ?? null, null);
  assert.deepEqual(h.jira.methods().filter(method => method.startsWith('unexpected:')), []);
  // Restart with every comment re-delivered: no second cancellation, no new reply.
  await h.stop();
  remote.redeliver = true;
  const reads = h.jira.methods().filter(method => method === 'readInputs').length;
  await h.start();
  await h.settle('Cards re-read after restart', async () => h.jira.methods().filter(method => method === 'readInputs').length > reads + 1);
  assert.equal((await h.show(pag42)).work.history.filter(item => item.event === 'cancel-requested').length, 1);
  assert.equal(h.posts().length, 5);
  await h.stop();
  // The same comment ingested again (as a lost cursor would) replays its receipt: nothing else is written.
  const opened = await openStore(h.storagePath);
  try {
    const snapshot = async () => JSON.stringify(await readWork(opened.session, pag42));
    const before = await snapshot();
    const again = await ingestJiraComment(opened.session, pag42, { ref: { tracker: 'jira', siteId: site.siteId, issueId: '81017', commentId: cancel }, author: { tracker: 'jira', accountId: 'acc-factory' },
      body: '/factory cancel', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), restricted: false, url: `${site.url}/browse/PAG-42` } satisfies JiraComment);
    assert.deepEqual(again, { kind: 'replayed', receipt: recorded });
    assert.equal(await snapshot(), before);
  } finally { await opened.close(); }
});

test('the command word in any case from a human account cancels; the Work leaves its queue with the cancellation impediment', async t => {
  const remote: JiraRemote = { cards: [card('81017', 'PAG-42')] };
  const h = await harness(t, remote);
  await h.start();
  await h.settle('admitted', async () => (await h.works()).length === 2);
  h.jira.write('81017', '/factory CANCEL', { accountId: 'acc-human' });
  await h.settle('cancelled', async () => (await h.byKey('PAG-42')).result === 'cancelled');
  const work = await h.byKey('PAG-42');
  assert.ok(work.impediments.some(item => item.code === 'WORK_CANCELLED'));
  assert.equal(work.queue.pending, false);
});

test('Cards of Works that never ran are read a bounded number per pass, least recently read first, so every one is reached', async () => {
  const reads: string[] = [];
  const tracker = { readInputs: async (ticket: { issueId: string }) => { reads.push(ticket.issueId); return { kind: 'unavailable' } as never; } } as unknown as JiraOriginTracker;
  const idle = ['1', '2', '3', '4', '5'].map(issueId => ({ work_id: `w-${issueId}`, result: 'open', questions: [], ticket: { tracker: 'jira', siteId: site.siteId, issueId } }) as unknown as WorkRecord);
  const ran = { ...idle[0]!, work_id: 'w-ran', ticket: { ...idle[0]!.ticket, issueId: '9' }, execution: { executionId: 'e-1' } } as unknown as WorkRecord;
  const desk = createJiraInputDesk({ session: undefined as never, tracker, readWorks: async () => [ran, ...idle], stopped: () => false, idleReads: 2 });
  for (let pass = 0; pass < 3; pass++) await desk.pass();
  // The Work that ran is read every pass; the idle ones two per pass, in rotation.
  assert.deepEqual(reads, ['9', '1', '2', '9', '3', '4', '9', '5', '1']);
});
