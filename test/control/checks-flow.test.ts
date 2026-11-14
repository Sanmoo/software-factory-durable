import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/control/durable/store.js';
import { admitTicket, initialize, readWork } from '../../src/control/durable/admission.js';
import { heldSlots, initializeSlots } from '../../src/control/durable/execution.js';
import { checksTarget, createChecksTracker, recordChecks } from '../../src/control/durable/checks.js';
import { evaluateChecks } from '../../src/control/rules/checks.js';
import type { PullRequestObservation } from '../../src/code-repository/index.js';
import { githubDoubles, scope, ticket, type Remote } from './doubles.js';
import { ownHead, seedPublished } from './checks-seed.js';

// Ticket 15 flow level (S): real Pi Durable/SQLite commits and the real tracker; GitHub is doubled at the CodeRepository contract.
// Not evidence of the real GitHub boundary (see test/entrypoints/github-checks-*.test.ts and the real-run recipe).
const complete = <T>(value: T) => ({ state: 'complete' as const, value });
function observed(runs: { id: number; name: string; status?: string; conclusion?: string | null }[], extra: Partial<Extract<PullRequestObservation, { kind: 'observed' }>> = {}): PullRequestObservation {
  return { kind: 'observed', source: 'github-rest', observedAt: new Date().toISOString(), completedAt: new Date().toISOString(), repository: 'acme/project', repositoryId: 3,
    pullRequest: { pullRequestId: 9007, nodeId: 'PR_node7', number: 7, url: 'https://github.com/acme/project/pull/7', state: 'open', merged: false, draft: true,
      headRef: 'factory/3-abcdef12', headSha: ownHead, headRepositoryId: 3, baseRef: 'main', baseSha: 'a'.repeat(40), mergeCommitSha: null, mergeable: true, mergeableState: 'clean',
      author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' } },
    baseTip: complete('b'.repeat(40)), classic: complete({ kind: 'required', strict: false, enforcement: 'everyone', checks: [{ context: 'build', integrationId: 15368 }] }),
    rules: complete([]), checkRuns: complete(runs.map(run => ({ headSha: ownHead, status: 'completed', conclusion: 'success', appId: 15368, appSlug: 'github-actions', checkSuiteId: 500,
      startedAt: null, completedAt: null, url: null, ...run }))), statuses: complete([]), comparison: complete({ status: 'ahead', aheadBy: 1, behindBy: 0 }),
    recheck: complete({ headSha: ownHead, baseRef: 'main', state: 'open', merged: false }), limitations: [], ...extra };
}

async function world(t: { after(fn: () => Promise<void>): void }, remote: Partial<Remote> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-checks-flow-'));
  const opened = await openStore(join(dir, 'c.sqlite'));
  t.after(async () => { await opened.close(); await rm(dir, { recursive: true, force: true }); });
  const { session } = opened;
  await initialize(session); await initializeSlots(session);
  const admit = async (number: number) => {
    const result = await admitTicket(session, { ticket: ticket(number), repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
      observedAt: new Date().toISOString(), label: { id: 55, name: 'ready-for-agent' }, publication: { observedAt: new Date().toISOString(), limitations: [] } });
    assert.equal(result.kind, 'admitted');
    return result.work_id;
  };
  const github = githubDoubles({ issues: [], pulls: {}, ...remote });
  const busy = new Set<string>();
  const { readWorks } = await import('../../src/control/durable/admission.js');
  const tracker = createChecksTracker({ session, access: { tracker: github.tracker, repository: github.repository, repositories: [scope] },
    readWorks: () => readWorks(session), busy: id => busy.has(id), perPass: 2 });
  const reads = () => github.calls.filter(call => call.method === 'readPullRequest');
  return { session, admit, github, tracker, busy, reads, remote: github };
}

test('AC4/AC7 storage-real: a waiting explanation is durable, uses no Slot, queue or impediment, and identical re-reads add no history', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observed([{ id: 1, name: 'build' }, { id: 2, name: 'build', status: 'queued', conclusion: null }]) } };
  const h = await world(t, remote);
  const id = await h.admit(3);
  await seedPublished(h.session, id, { requiredChecks: ['build'] });
  const before = (await readWork(h.session, id))!;
  await h.tracker.pass(new AbortController().signal);
  const after = (await readWork(h.session, id))!;
  const latest = after.checks!.latest;
  assert.deepEqual([latest.outcome, latest.reasons, latest.pullRequest.headSha], ['waiting', [{ category: 'wait', code: 'REQUIRED_CHECK_PENDING', subject: 'build' }], ownHead]);
  assert.deepEqual(latest.localGates, { declared: ['build'], requiredByGitHub: ['build'], notRequiredByGitHub: [] }, 'ticket 13 declared checks are correlated, not certified');
  assert.deepEqual([after.queue, after.impediments, await heldSlots(h.session)], [before.queue, before.impediments, 0], 'a CI wait is not a Slot, a queue entry or a defect');
  assert.deepEqual(after.history.filter(item => item.event === 'checks-evaluated').map(item => item.detail), [`waiting@${ownHead}:REQUIRED_CHECK_PENDING:build`]);
  await h.tracker.pass(new AbortController().signal);
  const again = (await readWork(h.session, id))!;
  assert.equal(again.history.filter(item => item.event === 'checks-evaluated').length, 1, 'an identical explanation is refreshed, not appended');
  assert.deepEqual(again.checks!.history, []);
  remote.pullRequests![7] = observed([{ id: 1, name: 'build' }, { id: 2, name: 'build', conclusion: 'failure' }]);
  await h.tracker.pass(new AbortController().signal);
  const failed = (await readWork(h.session, id))!;
  assert.deepEqual([failed.checks!.latest.outcome, failed.checks!.history.map(item => [item.outcome, item.reasons])],
    ['failing', [['waiting', ['wait:REQUIRED_CHECK_PENDING:build']]]], 'the earlier explanation stays visible as history');
  assert.deepEqual([failed.queue, failed.impediments], [before.queue, before.impediments], 'a failure is classified for ticket 22, never launched here');
  assert.equal(h.reads().length, 3);
});

test('AC1: only a linked own PR of an open, idle Work is read; an unavailable or throwing read is explained as indeterminate, never green', async t => {
  const h = await world(t);
  const unpublished = await h.admit(1);
  const running = await h.admit(2);
  const requested = await h.admit(4);
  await seedPublished(h.session, running);
  await seedPublished(h.session, requested, { state: 'requested' });
  h.busy.add(running);
  await h.tracker.pass(new AbortController().signal);
  assert.equal(h.reads().length, 0, 'not published, requested-only, or an activity of the Work running: nothing is read');
  assert.equal(checksTarget((await readWork(h.session, unpublished))!), null);
  h.busy.clear();
  await h.tracker.pass(new AbortController().signal);
  assert.deepEqual((await readWork(h.session, running))!.checks!.latest.reasons, [{ category: 'indeterminate', code: 'PULL_REQUEST_UNAVAILABLE', subject: 'GITHUB_NOT_FOUND_OR_HIDDEN' }]);
  h.github.repository.readPullRequest = async () => { throw new Error('synthetic adapter failure'); };
  await h.tracker.pass(new AbortController().signal);
  const thrown = (await readWork(h.session, running))!.checks!.latest;
  assert.deepEqual([thrown.outcome, thrown.reasons.map(item => item.subject)], ['indeterminate', ['PULL_REQUEST_QUERY_FAILED']]);
});

test('AC7: an explanation is recorded only for the PR still linked to the current Work; reads are bounded per pass and rotate', async t => {
  const h = await world(t, { pullRequests: { 7: observed([{ id: 1, name: 'build' }]) } });
  const ids = [await h.admit(1), await h.admit(2), await h.admit(3)];
  for (const id of ids) await seedPublished(h.session, id);
  const work = (await readWork(h.session, ids[0]!))!;
  const target = checksTarget(work)!;
  const evaluation = evaluateChecks({ at: new Date().toISOString(), expect: target.expect, observation: observed([{ id: 1, name: 'build' }]) });
  assert.equal(await recordChecks(h.session, ids[0]!, { ...target, nodeId: 'PR_relinked' }, evaluation), 'stale', 'the own PR changed between read and commit');
  assert.equal((await readWork(h.session, ids[0]!))!.checks ?? null, null);
  await h.tracker.pass(new AbortController().signal);
  assert.equal(h.reads().length, 2, 'at most perPass reads per tick');
  await h.tracker.pass(new AbortController().signal);
  const third = (await readWork(h.session, ids[2]!))!;
  assert.equal(third.checks?.latest.outcome, 'satisfied', 'the Work not read in the previous pass is read first');
  const stopped = new AbortController(); stopped.abort();
  const count = h.reads().length;
  await h.tracker.pass(stopped.signal);
  assert.equal(h.reads().length, count, 'no read after the owner stops');
});
