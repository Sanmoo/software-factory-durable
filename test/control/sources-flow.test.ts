import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ListView, TicketSource } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';

// Jira ticket 01 (spec §1): a source's `discover` gates NEW admissions only; v1 (no sources) keeps every repository discovering.
async function poll(t: { after(fn: () => Promise<void>): void }, sources: TicketSource[] | undefined) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-sources-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { issues: [remoteIssue(1)], pulls: {} };
  const github = githubDoubles(remote);
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty',
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], ...(sources ? { sources } : {}) },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await time.sleeping();
  const list = await control.inspect({ kind: 'list' }) as ListView;
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
  return { list, calls: github.calls.map(call => call.method) };
}

test('a GitHub source with discovery off lists but admits nothing, without re-reading the candidate', async t => {
  const { list, calls } = await poll(t, [{ tracker: 'github', repository: 'ACME/project', discover: false }]);
  assert.equal(list.works.length, 0);
  const candidate = list.polling.repositories[0]!.candidates![0]!;
  assert.equal(candidate.outcome, 'held');
  assert.deepEqual(candidate.outcome === 'held' && candidate.holds.map(hold => hold.code), ['SOURCE_DISCOVERY_DISABLED']);
  assert.deepEqual(calls.filter(method => method === 'readTicket'), []);
});

test('positive controls: discovery on (v2) or no sources at all (v1) admit the same candidate', async t => {
  for (const sources of [[{ tracker: 'github' as const, repository: 'acme/project', discover: true }], undefined]) {
    const { list } = await poll(t, sources);
    assert.equal(list.works.length, 1, JSON.stringify(sources));
  }
});

test('a repository that is only a Jira route destination is not a GitHub source', async t => {
  const { list } = await poll(t, [{ tracker: 'jira', siteId: 'site-A', url: 'https://equipe.atlassian.net', projectId: '10010', label: 'factory-ready', discover: false,
    routes: [{ componentId: '10022', repository: 'acme/project' }] }]);
  assert.equal(list.works.length, 0);
});
