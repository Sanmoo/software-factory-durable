import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ListView, WorkView } from '../../src/control/types.js';
import type { OwnPullRequestObservation, PullRequestCandidate } from '../../src/code-repository/index.js';
import { githubDoubles, manualClock, scope, type Remote } from './doubles.js';
import { card, jiraDoubles, jiraSource, type JiraRemote } from './jira-doubles.js';
import { app, executionDoubles, facts, ownPull, type Activation } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Jira ticket 09 (spec §5 "Percurso normal" / "Percurso interrompido"), flow level: real Control + Pi Durable + temporary SQLite. A Jira Work
// publishes its own PR; GitHub then confirms the merge. Delivery is committed from GitHub alone (dequeued, cycle memory, link intent `delivered`,
// delivery notice intent); the Card's link and notice follow when Jira answers, each confirmed on its own. Doubled: GitHub, Jira, clock,
// execution boundaries. Not evidence of a real Jira or GitHub.
const cardUrl = 'https://equipe.atlassian.net/browse/PAG-42';
const prUrl = 'https://github.com/acme/project/pull/4';
const notice = `[Software Factory · Entrega T-1] O PR foi integrado a main: ${prUrl}`;
const jiraBody = (workId: string) => [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the note.', `Jira Card PAG-42: ${cardUrl}`, '## Validation', 'Gate t1 passed.',
  '## Risk', 'Low.'].join('\n');
const publishJira = (overrides: Partial<PullRequestCandidate> = {}) => (remote: Remote, activation: Activation) => {
  const { workId, branch, head } = facts(activation.prompt);
  (remote.refs ??= {})[branch] = head;
  remote.pulls[0] = [...(remote.pulls[0] ?? []), ownPull(workId, branch, head, { association: ['known-branch'], body: jiraBody(workId), ...overrides })];
};

async function harness(t: { after(fn: () => Promise<void>): void }, jira: Partial<JiraRemote> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-jira-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [] };
  const github = githubDoubles(remote);
  const jiraRemote: JiraRemote = { cards: [card('81017', 'PAG-42')], ...jira };
  const doubles = jiraDoubles(jiraRemote);
  const storagePath = join(dir, 'control.sqlite');
  const execution = executionDoubles(remote, [{ kind: 'implement', head: 'd'.repeat(40) }, { kind: 'publish', publish: publishJira(), end: 'success' }]);
  // Ticket 17's narrow delivery read of the linked own PR; `merged` on the synthetic pull makes GitHub report a confirmed merge.
  const readOwnMerge = async (pr: { number: number }): Promise<OwnPullRequestObservation> => {
    const pull = Object.values(remote.pulls).flat().find(item => item.number === pr.number)!;
    return { kind: 'observed', source: 'github-rest', observedAt: new Date().toISOString(), repositoryId: 3, pullRequest: { pullRequestId: pull.pullRequestId, nodeId: pull.nodeId,
      number: pull.number, url: pull.url, state: pull.state, draft: pull.draft, merged: pull.merged, mergedAt: pull.merged ? '2026-11-20T12:00:00Z' : null,
      mergeCommitSha: pull.merged ? 'b'.repeat(40) : null, headRef: pull.headRef, headSha: pull.headSha, headRepositoryId: 3, baseRef: pull.baseRef, baseRepositoryId: 3,
      reported: { mergeCommitSha: pull.merged ? 'value' : 'null', merged: 'value' } } };
  };
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: execution.ports,
      access: { tracker: github.tracker, repository: { ...github.repository, readOwnMerge }, repositories: [scope], sources: [jiraSource()], trackers: { jira: doubles.tracker },
        operators: ['operator-one'], factoryApp: async () => app },
      polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView;
  const status = async () => (await current!.control.inspect({ kind: 'status' })) as ControlStatus;
  const settle = async (predicate: () => Promise<boolean>, label: string) => {
    await untilHolds(label, async () => {
      if (await predicate()) return true;
      if (current!.time.isSleeping()) current!.time.advance();
      return false;
    }, 5);
  };
  const cycles = async (n: number) => { for (let i = 0; i < n; i++) { current!.time.advance(); await current!.time.sleeping(); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const merge = () => { const pull = remote.pulls[0]![0]!; pull.state = 'closed'; pull.merged = true; };
  const posts = () => doubles.calls.filter(call => call.method === 'publishComment').map(call => (call.args as { lines: string[] }).lines.join('\n'));
  const upserts = () => doubles.calls.filter(call => call.method === 'upsertRemoteLink').map(call => call.args as { issueId: string; globalId: string; url: string; title: string });
  const deliveryNotices = async () => ((await status()).jiraNotices?.unpublished ?? []).filter(item => item.purpose.kind === 'delivery');
  const accept = (input: Parameters<Control['accept']>[0]) => current!.control.accept(input);
  return { remote, jiraRemote, jira: doubles, start, stop, accept, work, status, settle, cycles, merge, posts, upserts, deliveryNotices };
}

/** Never a Jira write other than the comment and the remote link (the doubles model no transition/assignee/resolution: any call is `unexpected:`). */
const onlyAllowedWrites = (methods: string[]) => assert.deepEqual(methods.filter(method => method.startsWith('unexpected:')), []);

test('normal path: the confirmed merge delivers the Jira Work; the link becomes Entregue and the delivery notice is published once', async t => {
  const h = await harness(t);
  await h.start();
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'own PR linked');
  const { work_id } = await h.work();
  h.merge();
  await h.settle(async () => (await h.work()).result === 'delivered' && h.posts().length === 1 && (await h.status()).jiraLinks?.pending.length === 0 &&
    h.upserts().at(-1)?.title === 'Trabalho T-1 · Entregue', 'delivered, linked and told');
  const work = await h.work();
  assert.equal(work.queue.pending, false);
  assert.deepEqual(h.jira.links['81017'], { [`software-factory:work:${work_id}`]: { url: prUrl, title: 'Trabalho T-1 · Entregue', id: '20001' } });
  assert.deepEqual(h.posts(), [notice]);
  assert.deepEqual(h.jira.comments['81017']!.map(item => item.text), [notice]);
  await h.cycles(3);
  assert.equal(h.posts().length, 1, 'never told twice');
  assert.equal(work.history.filter(item => item.event === 'delivery-confirmed').length, 1);
  onlyAllowedWrites(h.jira.methods());
});

test('interrupted path: merged while Jira is down, delivery is committed alone; after a restart the link and the notice are settled separately (lost POST answer reconciled, one POST)', async t => {
  const h = await harness(t);
  await h.start();
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'own PR linked');
  const { work_id } = await h.work();
  h.jiraRemote.down = true;
  h.jiraRemote.listFailure = { code: 'JIRA_UNAVAILABLE' };
  h.merge();
  await h.settle(async () => (await h.work()).result === 'delivered', 'delivered from GitHub alone');
  await h.cycles(2);
  const [work, status] = [await h.work(), await h.status()];
  assert.equal(work.queue.pending, false);
  assert.deepEqual(status.jiraLinks!.pending.map(item => [item.globalId, item.desired, item.state, item.title]),
    [[`software-factory:work:${work_id}`, 'delivered', 'pending', 'Trabalho T-1 · Entregue']]);
  const pending = await h.deliveryNotices();
  assert.deepEqual(pending.map(item => [item.logicalRef, item.state === 'published']), [[`delivery:${work_id}`, false]]);
  assert.ok(pending[0]!.diagnostic, 'the pending notice carries its local diagnostic');
  assert.deepEqual(h.jira.comments['81017'] ?? [], [], 'nothing reached the Card');
  assert.ok(h.posts().length <= 1, 'an outage POST of unknown outcome is not repeated while the Card cannot be read');
  // Leaving the queue and cleanup never erase the pending effects: forget is refused while they are unsettled.
  const forget = await h.accept({ request_id: 'forget-1', operation: 'forget-plan', work_id, origin: 'local-cli' });
  const refusals = JSON.stringify(forget);
  assert.match(refusals, new RegExp(`EFFECT_UNSETTLED:jira-link:${work_id}`));
  assert.match(refusals, /EFFECT_UNSETTLED:jira-notice:/);
  await h.stop();
  const before = h.posts().length;
  // Jira back: the POST is accepted but its answer is lost; the next pass reconciles it from the Card's comments (no second POST).
  h.jiraRemote.down = false;
  delete h.jiraRemote.listFailure;
  h.jiraRemote.commentOutcomes = ['lost'];
  await h.start();
  await h.settle(async () => (await h.status()).jiraLinks?.pending.length === 0 && (await h.deliveryNotices()).length === 0, 'link and notice settled after restart');
  await h.cycles(2);
  assert.equal(h.posts().length - before, 1, 'one POST: the lost answer was reconciled, never re-sent blindly');
  assert.deepEqual(h.jira.comments['81017']!.map(item => item.text), [notice]);
  assert.deepEqual(h.jira.links['81017'], { [`software-factory:work:${work_id}`]: { url: prUrl, title: 'Trabalho T-1 · Entregue', id: '20001' } });
  assert.ok(h.upserts().every(item => item.globalId === `software-factory:work:${work_id}`), 'always the same globalId');
  const after = await h.work();
  assert.equal(after.result, 'delivered');
  assert.equal(after.history.filter(item => item.event === 'delivery-confirmed').length, 1, 'never delivered twice');
  onlyAllowedWrites(h.jira.methods());
});

test('two copies of the notice: ambiguity is shown, nothing is re-sent, the Work stays Delivered (never reopened)', async t => {
  const h = await harness(t, { commentOutcomes: ['twice'] });
  await h.start();
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'own PR linked');
  h.merge();
  await h.settle(async () => (await h.deliveryNotices()).some(item => item.diagnostic?.code === 'JIRA_COMMENT_MULTIPLE'), 'ambiguity diagnosed');
  await h.cycles(3);
  assert.equal(h.posts().length, 1, 'no blind re-POST');
  assert.equal(h.jira.comments['81017']!.length, 2);
  const work = await h.work();
  assert.equal(work.result, 'delivered');
  assert.equal(work.queue.pending, false);
  assert.equal(work.history.filter(item => item.event === 'delivery-confirmed').length, 1);
  assert.equal((await h.status()).jiraLinks?.pending.length, 0, 'the link is confirmed independently of the comment');
  onlyAllowedWrites(h.jira.methods());
});

test('closed without merge: no delivery, no notice; only the link title changes', async t => {
  const h = await harness(t);
  await h.start();
  await h.settle(async () => (await h.status()).jiraLinks?.confirmed === 1, 'own PR linked');
  h.remote.pulls[0]![0]!.state = 'closed';
  await h.settle(async () => (await h.work()).result === 'closed-unmerged' && h.upserts().at(-1)?.title === 'Trabalho T-1 · PR fechado sem merge', 'closure linked');
  await h.cycles(3);
  assert.notEqual((await h.work()).result, 'delivered');
  assert.deepEqual(h.posts(), [], 'no delivery notice without a confirmed merge');
  // Positive control: the same doubles do record a POST when a merge is confirmed (first test).
  onlyAllowedWrites(h.jira.methods());
});
