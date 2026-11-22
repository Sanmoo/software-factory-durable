import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, ShowView, TicketSource, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, ticket, type Remote } from './doubles.js';
import { blockedBy, card, jiraDoubles, jiraSource, refOf, site, type JiraRemote } from './jira-doubles.js';

// Jira ticket 04 (spec §3 step 5): a Jira candidate is re-read by ID and decided with the CURRENT configuration immediately before the
// admission commit; only its single revalidated destination receives the Work, once (index + pause inside the commit), across polls and
// restarts. Real Control + Pi Durable + SQLite; GitHub and Jira are doubles recording every call.
const other = { ...scope, repository: 'acme/other' };
async function harness(t: { after(fn: () => Promise<void>): void }, jira: JiraRemote, options: { github?: Remote; sources?: TicketSource[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-jira-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(options.github ?? { issues: [], pulls: {} });
  const doubles = jiraDoubles(jira);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start(before?: (control: Control) => Promise<unknown>) {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty',
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope, other], sources: options.sources ?? [jiraSource()], trackers: { jira: doubles.tracker } },
      polling: { intervalSeconds: 60, clock: time.clock } });
    await before?.(control);
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
    return current;
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const list = async () => await current!.control.inspect({ kind: 'list' }) as ListView;
  const show = async (work_id: string) => await current!.control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  const poll = async () => { current!.time.advance(); await current!.time.sleeping(); };
  const jiraCandidates = async () => (await list()).polling.sources?.[0]?.candidates ?? null;
  return { github, jira: doubles, start, stop, list, show, poll, jiraCandidates };
}
const writes = (methods: string[]) => methods.filter(method => method.startsWith('unexpected:') || /post|publish|upsert/i.test(method));
const holdCodes = (candidate: { outcome: string; holds?: { code: string }[] } | undefined) => candidate?.outcome === 'held' ? candidate.holds!.map(hold => hold.code) : candidate?.outcome;

test('an eligible Card is admitted once, in ONE commit, to its single revalidated destination; polls and restart never duplicate it', async t => {
  const jira: JiraRemote = { cards: [card('81017', 'PAG-42', { links: [blockedBy('911', '70202', 'OPS-9')] }), card('70202', 'OPS-9', { projectId: '20020', labels: [], statusCategory: 'done' })] };
  const h = await harness(t, jira);
  await h.start();
  const [work, ...rest] = (await h.list()).works;
  assert.equal(rest.length, 0);
  assert.deepEqual(work!.ticket, { tracker: 'jira', siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' });
  assert.deepEqual(work!.repository, { repository: 'acme/project', repositoryId: 3, base: 'main' });
  assert.equal(work!.authorization.source, 'jira-rest');
  assert.deepEqual(work!.authorization.source === 'jira-rest' && { ...work!.authorization.basis, blockers: work!.authorization.basis.blockers.blockers },
    { sourceConfigured: true, siteId: 'site-A', projectId: '10010', label: { name: 'factory-ready' }, route: { componentIds: ['10022'], repository: 'acme/project' },
      blockers: [{ issueId: '70202', key: 'OPS-9', statusCategory: 'done' }] });
  assert.deepEqual([work!.queue, work!.history[0]?.event, work!.history[0]?.origin], [{ category: 'normal', sequence: 1, pending: true }, 'admitted', 'jira-polling']);
  // Blockers were evaluated just before the commit: no GitHub-style DEPENDENCIES_NOT_EVALUATED (spec 07: never copied to Jira).
  assert.ok(!work!.impediments.some(item => item.code === 'DEPENDENCIES_NOT_EVALUATED'));
  assert.deepEqual(holdCodes((await h.jiraCandidates())?.[0]), 'admitted');
  await h.poll();
  await h.stop();
  await h.start();
  await h.poll();
  const again = await h.list();
  assert.deepEqual(again.works.map(item => item.work_id), [work!.work_id]);
  assert.deepEqual(holdCodes((await h.jiraCandidates())?.[0]), 'existing');
  assert.deepEqual(writes(h.jira.methods()), []);
  // Positive control: the double is connected (the Card was really listed and re-read by ID).
  assert.ok(h.jira.methods().includes('listCandidates') && h.jira.methods().includes('readTicket'));
});

test('edits between listing and admission: label removed, second destination, partial components, blocker not Done => no Work, no dispatch', async t => {
  // Last column: impediment notices on the Card (ticket 05) — only a known impediment of a Card still marked is told, once; never without intent.
  const cases: [string, (item: ReturnType<typeof card>) => void, string[], number][] = [
    ['label removed', item => { item.labels = []; }, ['LABEL_NOT_PRESENT'], 0],
    ['second destination', item => { item.components = ['10022', '10021']; }, ['JIRA_ROUTE_DIVERGENT'], 1],
    ['partial components', item => { item.components = null; }, ['JIRA_COMPONENTS_UNVERIFIABLE'], 0],
    ['no route', item => { item.components = ['10099']; }, ['JIRA_ROUTE_NONE'], 1],
    ['blocker open', item => { item.links = [blockedBy('911', '70202', 'OPS-9')]; }, ['JIRA_BLOCKER_NOT_DONE'], 1],
  ];
  for (const [name, edit, codes, notices] of cases) {
    const listed = card('81017', 'PAG-42');
    const jira: JiraRemote = { cards: [listed, card('70202', 'OPS-9', { statusCategory: 'indeterminate' })], listed: [refOf(listed)], afterListing: () => edit(listed) };
    const h = await harness(t, jira);
    await h.start();
    const list = await h.list();
    assert.equal(list.works.length, 0, name);
    assert.deepEqual(holdCodes((await h.jiraCandidates())?.[0]), codes, name);
    assert.deepEqual(writes(h.jira.methods()), Array(notices).fill('publishComment'), name);
    // The notice never names the neighbour (it may be in a restricted project).
    assert.ok(!JSON.stringify(h.jira.comments).includes('OPS-9'), name);
    await h.stop();
  }
});

test('the single route swapped since discovery: the Work goes to the revalidated destination only', async t => {
  const listed = card('81017', 'PAG-42');
  const h = await harness(t, { cards: [listed], afterListing: () => { listed.components = ['10021', '10077']; } });
  await h.start();
  assert.deepEqual((await h.list()).works.map(item => item.repository.repository), ['acme/other']);
});

test('a pause committed before admission holds the Card; unpausing admits it on the next poll', async t => {
  const h = await harness(t, { cards: [card('81017', 'PAG-42')] });
  const { control } = await h.start(control => control.accept({ request_id: 'pause-1', operation: 'pause', origin: 'local-cli' }));
  assert.equal((await h.list()).works.length, 0);
  assert.deepEqual(holdCodes((await h.jiraCandidates())?.[0]), ['GLOBAL_PAUSE']);
  await control.accept({ request_id: 'unpause-1', operation: 'unpause', origin: 'local-cli' });
  await h.poll();
  assert.equal((await h.list()).works.length, 1);
});

test('a key change (PAG-42 -> FIN-18) updates the presentation of the SAME Work, never its destination; the old key is never searched', async t => {
  const item = card('81017', 'PAG-42');
  const h = await harness(t, { cards: [item] });
  await h.start();
  const [work] = (await h.list()).works;
  item.key = 'FIN-18';
  item.components = ['10021'];
  await h.poll();
  const after = await h.list();
  assert.deepEqual(after.works.map(entry => entry.work_id), [work!.work_id]);
  const shown = await h.show(work!.work_id);
  assert.deepEqual([shown.work.ticket.tracker === 'jira' && shown.work.ticket.key, shown.work.ticket.url, shown.work.repository.repository],
    ['FIN-18', 'https://equipe.atlassian.net/browse/FIN-18', 'acme/project']);
  // The latest poll of its ORIGIN source names the Card under its current key.
  assert.deepEqual([shown.lastPolled?.outcome, shown.lastPolled?.ticket.tracker === 'jira' && shown.lastPolled.ticket.key], ['existing', 'FIN-18']);
  const changed = shown.work.history.filter((entry: WorkView['history'][number]) => entry.event === 'ticket-presentation-changed');
  assert.deepEqual(changed.map(entry => 'detail' in entry ? entry.detail : null), ['PAG-42 -> FIN-18']);
  // Reads are by ID only (the listing is by project/label): nothing ever looks the old key up.
  assert.ok(!JSON.stringify(h.jira.calls.filter(call => call.method !== 'listCandidates')).includes('PAG-42'));
});

test('coexistence: GitHub #42 and Jira PAG-42 for the same destination are two Works with distinct keys', async t => {
  const github: Remote = { issues: [remoteIssue(42)], pulls: {} };
  const h = await harness(t, { cards: [card('42', 'PAG-42')] }, { github, sources: [{ tracker: 'github', repository: 'acme/project', discover: true }, jiraSource()] });
  await h.start();
  const works = (await h.list()).works;
  assert.deepEqual(works.map(item => [item.ticket.tracker, item.repository.repository]).sort(), [['github', 'acme/project'], ['jira', 'acme/project']]);
  assert.deepEqual(works.find(item => item.ticket.tracker === 'github')!.ticket, ticket(42));
});

test('a Jira source with discovery off admits nothing and does not even list', async t => {
  const h = await harness(t, { cards: [card('81017', 'PAG-42')] }, { sources: [jiraSource({ discover: false })] });
  await h.start();
  assert.equal((await h.list()).works.length, 0);
  assert.deepEqual(h.jira.methods(), []);
  assert.deepEqual((await h.list()).polling.sources?.map(source => [source.siteId, source.discover, source.candidates]), [[site.siteId, false, null]]);
});

test('an unavailable listing admits nothing and says absence is not concluded; a rate-limited listing waits as Jira asked', async t => {
  const h = await harness(t, { cards: [card('81017', 'PAG-42')], listFailure: { code: 'JIRA_RATE_LIMITED', waitSeconds: 300 } });
  await h.start();
  const source = (await h.list()).polling.sources![0]!;
  assert.equal((await h.list()).works.length, 0);
  assert.deepEqual([source.state, source.code, source.waitSeconds, source.candidates, source.absenceProven], ['unavailable', 'JIRA_RATE_LIMITED', 300, null, false]);
  assert.ok(source.nextPollInSeconds! >= 300);
  assert.match(source.nextStep!, /absence of Cards or labels is not concluded/);
});
