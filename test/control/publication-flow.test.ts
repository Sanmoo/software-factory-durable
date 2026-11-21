import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, facts, humanPush, ownPull, publishOwn, type Activation, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (S): real Control + Pi Durable + temporary SQLite, with ticket 13's REAL review rounds and end-of-Execution verification.
// Doubled: GitHub (IssueTracker/CodeRepository), clock, Sandbox lifecycle/identity, Workers (a scripted Builder emitting captures, scripted
// reviewers) and credentials. Not evidence of a real VM, worker, model, reviewer, gate or GitHub.
async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[], options: { reviews?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-publication-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  const execution = executionDoubles(remote, scripts, options);
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      execution: execution.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
      polling: { intervalSeconds: 60, clock: time.clock },
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() {
    current!.stop.abort();
    assert.deepEqual(await current!.running, { kind: 'clean' });
  }
  t.after(async () => {
    if (current && !current.stop.signal.aborted) await stop();
  });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView;
  /** Waits WITHOUT advancing the clock (no new cycle/tick happens meanwhile). */
  const until = async (predicate: () => Promise<boolean>, label: string) => {
    await untilHolds(label, predicate, 5);
  };
  /** Advances polling cycles (each followed by the dispatcher tick) until the predicate holds. */
  const settle = async (predicate: () => Promise<boolean>, label: string) => {
    await untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (current!.time.isSleeping()) current!.time.advance();
        return false;
      },
      5,
    );
  };
  const cycles = async (n: number) => {
    for (let i = 0; i < n; i++) {
      current!.time.advance();
      await current!.time.sleeping();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  /** Runs the implementation Execution (real ticket 13 rounds) to its confirmed end WITHOUT a further tick; optionally stops the owner. */
  async function implemented(options: { stop?: boolean } = {}) {
    await start();
    await until(async () => (await work())?.execution?.end?.cessation === 'confirmed' && (await work()).execution!.slot.held === false, 'implementation ended');
    const { work_id, branch } = await work();
    if (options.stop) await stop();
    return { work_id, branch: branch! };
  }
  return { github, execution, start, stop, work, settle, cycles, activations, implemented, control: () => current!.control };
}
const publicationOf = (work: WorkView) => work.publication!;
const executionsOf = (work: WorkView): ExecutionView[] => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];

test('AC1/AC2/AC4/AC5 + review HIGH 1: after a REAL verified review, absence requests ONE publish-only activation (no handoff/edit, new session, publish grant)', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishOwn(), end: 'success' },
  ]);
  const { work_id: workId } = await h.implemented();
  assert.equal((await h.work()).execution!.review!.verification!.status, 'verified', 'ticket 13 verification produced by the real rounds');
  await h.settle(async () => publicationOf(await h.work())?.state === 'published', 'published');
  const work = await h.work();
  const publication = publicationOf(work);
  const [implementation, publish] = h.activations();
  assert.deepEqual(
    h.execution.calls.filter(call => call.kind === 'issue').map(call => call.detail),
    ['builder-start', 'builder-publish'],
  );
  assert.match(implementation!.token, /Start/);
  assert.ok(implementation!.handoff, 'the implementation hands off for reviews');
  assert.match(publish!.token, /Publish/);
  assert.equal(publish!.phaseId, 'builder-publication');
  // Review HIGH 1: publish-only — never the handoff (no review rounds), never the edit tool, never the implementation session.
  assert.deepEqual([publish!.handoff, publish!.editSourceMaxBytes, publish!.continuation], [null, undefined, null]);
  assert.match(publish!.prompt, /^Factory publication instruction \(publish-only session, reason: PUBLISH_ONLY_SESSION\)/);
  assert.equal(h.execution.calls.filter(call => call.kind.startsWith('activate-')).length, 2, 'reviewers ran only for the implementation');
  assert.ok(
    publish!.prompt.includes(`--force-with-lease=refs/heads/${work.branch}: https://github.com/acme/project.git ${'d'.repeat(40)}:refs/heads/${work.branch}`),
  );
  assert.deepEqual(
    [publication.branch, publication.base, publication.marker, publication.verified!.head],
    [work.branch, 'main', `<!-- software-factory:work:${workId} -->`, 'd'.repeat(40)],
  );
  assert.deepEqual(publication.expectedRemote, { state: 'absent' });
  assert.deepEqual(publication.refsBefore, { 'refs/heads/main': 'b'.repeat(40) }, 'the refs snapshot of the request is preserved');
  assert.deepEqual(executionsOf(work)[1]!.request.publication, {
    basisExecutionId: publication.basisExecutionId,
    head: 'd'.repeat(40),
    branch: work.branch,
    base: 'main',
    marker: publication.marker,
    expectedRemote: { state: 'absent' },
    pullRequest: null,
  });
  assert.equal(executionsOf(work)[1]!.request.policies.editSourceMaxBytes, undefined, 'the recorded publication policies are publish-only');
  assert.deepEqual(
    publication.attempts!.map(item => item.head),
    ['d'.repeat(40)],
  );
  assert.deepEqual(work.pullRequest, { number: 4, url: 'https://github.com/acme/project/pull/4' });
  assert.deepEqual(publication.description, { conformant: true, reasons: [] });
  assert.equal(work.result, 'open');
  assert.equal(h.github.calls.filter(call => call.method === 'postComment').length, 0);
  await h.cycles(3);
  assert.equal(h.activations().length, 2, 'no further activation after the link');
  const reads = h.github.calls
    .filter(call => call.method === 'findPublication')
    .map(call => call.args as { knownBranches: string[]; refs?: boolean; base?: string })
    .filter(read => read.knownBranches.length);
  assert.ok(reads.length >= 2 && reads.every(read => read.knownBranches[0] === work.branch && read.refs === true && read.base === 'main'));
});

test('AC2: content that is not verified (failed gate), not committed, or without reviews is never published; no write grant is issued', async t => {
  for (const [script, reason, reviews] of [
    [{ kind: 'implement', head: 'd'.repeat(40), gate: 'failed' }, 'REVIEW_NOT_VERIFIED', true],
    [{ kind: 'implement', head: 'd'.repeat(40), committed: false }, 'VERIFIED_CONTENT_NOT_COMMITTED', true],
    [{ kind: 'implement', head: 'd'.repeat(40) }, 'REVIEWS_NOT_RECORDED', false],
  ] as const) {
    const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ ...script }], { reviews });
    await h.start();
    await h.settle(async () => publicationOf(await h.work())?.state === 'not-publishable', `${reason}: not publishable`);
    await h.cycles(2);
    assert.ok(publicationOf(await h.work()).reasons.includes(reason), reason);
    assert.equal(h.activations().length, 1);
    assert.equal(
      h.github.calls.filter(call => call.method === 'findPublication' && (call.args as { knownBranches: string[] }).knownBranches.length).length,
      0,
      'not even discovered',
    );
    assert.ok(!h.execution.calls.some(call => call.kind === 'issue' && call.detail === 'builder-publish'));
    await h.stop();
  }
});

test('AC6: after cessation with a LOST result (worker failure + owner restart) the own publication is discovered and linked, never repeated', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishOwn(), end: 'failure' },
  ]);
  await h.implemented();
  await h.settle(
    async () => Boolean((await h.work()).execution?.request.publication) && (await h.work()).execution!.end?.cessation === 'confirmed',
    'publication ended',
  );
  assert.equal(publicationOf(await h.work()).state, 'awaiting-discovery');
  await h.stop();
  await h.start();
  await h.settle(async () => publicationOf(await h.work()).state === 'published', 'linked after restart');
  await h.cycles(2);
  assert.equal(h.activations().length, 2, 'the push/PR were never repeated');
});

test('ticket 27 AC7/AC4: lost result + owner restart while a human pushed on top of the Factory push: the preserved expectation diverges; no recapture, no new write', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const human = '1'.repeat(40);
  // The Builder's push and PR landed, then (before any discovery) the human pushed on the same branch; the Builder's result is lost.
  const pushedThenHuman = (remote: Remote, activation: Activation) => {
    publishOwn()(remote, activation);
    humanPush(remote, facts(activation.prompt).branch, human);
  };
  const h = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: pushedThenHuman, end: 'failure' },
  ]);
  const { branch } = await h.implemented();
  await h.settle(
    async () => Boolean((await h.work()).execution?.request.publication) && (await h.work()).execution!.end?.cessation === 'confirmed',
    'publication ended',
  );
  await h.stop();
  await h.start();
  await h.settle(async () => publicationOf(await h.work()).state === 'diverged', 'diverged after the restart');
  await h.cycles(3);
  const publication = publicationOf(await h.work());
  const divergence = publication.divergences!.at(-1)!;
  assert.equal(divergence.current, human, 'the human tip is the concrete divergence asked about');
  assert.deepEqual(
    publication.attempts!.map(item => [item.head, item.expectedRemote]),
    [['d'.repeat(40), { state: 'absent' }]],
    'the expectation the push used is the preserved one; the tip read after the restart never becomes a new lease',
  );
  assert.equal(h.activations().length, 2, 'no new write (push/PR) without a concrete reconciliation');
  assert.equal(remote.refs![branch], human, 'the human change is kept');
  assert.ok((await h.work()).impediments.some(item => item.code === 'HUMAN_CHANGE_RECONCILIATION'));
});

test('ticket 27 AC2: a publication activation interrupted after its push/PR (operational recovery pending) is DISCOVERED and linked; no recovery Builder repeats it', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishOwn(), end: 'failure' },
  ]);
  let offset = 0;
  h.execution.ports.calendar = { now: () => Date.now() + offset };
  await h.implemented();
  await h.settle(async () => (await h.work())?.publication?.state === 'published', 'linked after the interrupted publication');
  offset = 3600000; // any persisted recovery wait has passed
  await h.cycles(4);
  const work = await h.work();
  assert.equal(h.activations().length, 2, 'the push/PR are discovered, never repeated by a recovery activation');
  assert.deepEqual([work.queue.pending, work.pendingRecovery], [false, null], 'the publication outcome settles the interrupted publication activation');
});

test('review HIGH 2: a lost start receipt is still an attempt (marked at the activation commit): never a second publication activation', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishOwn(), end: 'receipt-lost' },
  ]);
  await h.implemented();
  await h.settle(async () => Boolean((await h.work()).execution?.request.publication) && (await h.work()).execution!.held !== null, 'publication held');
  await h.cycles(4);
  const work = await h.work();
  assert.equal(publicationOf(work).state, 'awaiting-discovery', 'never `requested` again');
  assert.deepEqual(publicationOf(work).attempts!.length, 1);
  assert.equal(h.activations().filter(item => item.phaseId === 'builder-publication').length, 1);
  assert.equal(work.execution!.start, null, 'no receipt was confirmed');
});

test('AC6: an attempt whose effect is not found, several own candidates or an incomplete read never repeat the publication', async t => {
  const nothing = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: () => {}, end: 'success' },
  ]);
  await nothing.implemented();
  await nothing.settle(async () => publicationOf(await nothing.work())?.state === 'blocked', 'blocked');
  await nothing.cycles(3);
  assert.deepEqual(publicationOf(await nothing.work()).reasons, ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_ABSENT']);
  assert.ok((await nothing.work()).impediments.some(item => item.code === 'PUBLICATION_BLOCKED'));
  assert.equal(nothing.activations().length, 2);
  await nothing.stop();
  const twice = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'implement', head: 'd'.repeat(40) },
    {
      kind: 'publish',
      publish: (remote, activation) => {
        publishOwn()(remote, activation);
        publishOwn({ number: 5, pullRequestId: 9005, url: 'https://github.com/acme/project/pull/5' })(remote, activation);
      },
      end: 'success',
    },
  ]);
  await twice.implemented();
  await twice.settle(async () => publicationOf(await twice.work())?.state === 'blocked', 'blocked');
  assert.deepEqual(publicationOf(await twice.work()).reasons, ['MULTIPLE_OWN_PULL_REQUESTS:4,5']);
  assert.equal((await twice.work()).pullRequest, null);
  await twice.stop();
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const partial = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishOwn(), end: 'success' },
  ]);
  await partial.implemented({ stop: true });
  remote.publicationFailure = { code: 'GITHUB_QUERY_FAILED' };
  await partial.start();
  await partial.settle(async () => (publicationOf(await partial.work())?.discoveries.length ?? 0) > 0, 'discovered');
  await partial.cycles(3);
  assert.equal(publicationOf(await partial.work()).state, 'awaiting-discovery');
  assert.deepEqual(
    publicationOf(await partial.work()).discoveries.map(item => item.outcome),
    ['incomplete'],
    'identical incomplete reads are recorded once',
  );
  assert.equal(partial.activations().length, 1);
  delete remote.publicationFailure;
  await partial.settle(async () => publicationOf(await partial.work()).state === 'published', 'published after a complete read');
});

test('AC4 + review LOW: an unknown associated PR is held (never adopted, re-read, operator path); an unknown change of the own branch blocks', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'implement', head: 'd'.repeat(40) }]);
  const implemented = await h.implemented({ stop: true });
  remote.pulls[3] = [
    ownPull(implemented.work_id, 'human/x', 'e'.repeat(40), {
      number: 7,
      pullRequestId: 9007,
      url: 'https://github.com/acme/project/pull/7',
      body: 'Closes #3',
      author: { id: 10, login: 'someone', type: 'User' },
      association: ['closing-reference'],
      state: 'closed',
    }),
  ];
  await h.start();
  await h.settle(async () => (publicationOf(await h.work())?.discoveries.length ?? 0) > 0, 'discovered');
  await h.cycles(2);
  const held = publicationOf(await h.work());
  assert.deepEqual([held.state, held.reasons, held.discoveries.at(-1)!.outcome], ['awaiting-discovery', ['UNKNOWN_PULL_REQUEST:7'], 'held']);
  assert.match(held.nextStep!, /remove the association/);
  assert.ok(!(await h.work()).impediments.some(item => item.code === 'PUBLICATION_BLOCKED'), 'no permanent block before any attempt');
  assert.equal(h.activations().length, 1, 'nothing requested');
  remote.pulls[3] = []; // the operator removed the association: the next read proceeds
  await h.settle(async () => publicationOf(await h.work()).state === 'requested' || h.activations().length === 2, 'requested after the operator path');
  await h.stop();
  const other: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const g = await harness(t, other, [{ kind: 'implement', head: 'd'.repeat(40) }]);
  const second = await g.implemented({ stop: true });
  other.refs = { [second.branch]: 'e'.repeat(40) };
  await g.start();
  await g.settle(async () => publicationOf(await g.work())?.state === 'blocked', 'blocked');
  assert.deepEqual(publicationOf(await g.work()).reasons, ['REMOTE_BRANCH_UNKNOWN_CHANGE']);
  assert.equal(g.activations().length, 1);
});

test('review MED 4: an unprotected base refuses publication; any other ref changed during the publication window blocks', async t => {
  const unprotected: Remote = {
    pulls: {},
    issues: [remoteIssue(3)],
    baseProtection: { state: 'not-required', reason: 'NO_PULL_REQUEST_RULE_WITHOUT_APP_BYPASS' },
  };
  const h = await harness(t, unprotected, [{ kind: 'implement', head: 'd'.repeat(40) }]);
  await h.implemented();
  await h.settle(async () => publicationOf(await h.work())?.state === 'blocked', 'blocked');
  assert.deepEqual(publicationOf(await h.work()).reasons, ['BASE_PROTECTION_NOT_VERIFIED:NO_PULL_REQUEST_RULE_WITHOUT_APP_BYPASS']);
  assert.ok(!h.execution.calls.some(call => call.kind === 'issue' && call.detail === 'builder-publish'));
  await h.stop();
  const tagged = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'implement', head: 'd'.repeat(40) },
    {
      kind: 'publish',
      publish: (remote, activation) => {
        publishOwn()(remote, activation);
        remote.tags = { v9: 'd'.repeat(40) };
      },
      end: 'success',
    },
  ]);
  await tagged.implemented();
  await tagged.settle(async () => publicationOf(await tagged.work())?.state === 'blocked', 'blocked');
  assert.deepEqual(
    publicationOf(await tagged.work()).reasons,
    ['UNEXPECTED_REF_CHANGE:refs/tags/v9'],
    'Contents W is repository-wide: the push of a tag is detected',
  );
  assert.equal((await tagged.work()).pullRequest?.number, 4, 'the own PR is linked, but not as published');
  // Ticket 18 backstop: an effect of the publish-only guest outside its scope is a distinct impediment (GitHub permissions cannot separate them).
  assert.deepEqual(
    (await tagged.work()).impediments.map(item => item.code),
    ['PUBLICATION_BLOCKED', 'GUEST_EFFECT_OUT_OF_SCOPE'],
  );
  assert.match((await tagged.work()).impediments[1]!.nextStep, /UNEXPECTED_REF_CHANGE:refs\/tags\/v9/);
  await tagged.stop();
  const readied = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishOwn({ draft: false }), end: 'success' },
  ]);
  await readied.implemented();
  await readied.settle(async () => publicationOf(await readied.work())?.state === 'blocked', 'blocked');
  assert.deepEqual(
    (await readied.work()).impediments.map(item => item.code),
    ['PUBLICATION_BLOCKED', 'GUEST_EFFECT_OUT_OF_SCOPE'],
    'a non-draft own PR right after the guest published',
  );
});

test('review MED 6: a later verified basis updates the SAME own PR once (lease on its linked head); the published head is never re-published', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: publishOwn(), end: 'success' },
    { kind: 'implement', head: 'e'.repeat(40) },
    { kind: 'publish', publish: publishOwn(), end: 'success' },
  ]);
  const { work_id } = await h.implemented();
  await h.settle(async () => publicationOf(await h.work())?.state === 'published', 'first publication');
  const scope = await h.control().accept({
    request_id: 'scope-1',
    operation: 'update-scope',
    work_id,
    reason: 'Also mention the rollback owner in the smoke page (only that).',
    origin: 'local-cli',
  });
  assert.equal((scope as { outcome?: string }).outcome, 'accepted');
  await h.settle(async () => publicationOf(await h.work()).verified?.head === 'e'.repeat(40) && publicationOf(await h.work()).state === 'published', 'updated');
  const update = h.activations().filter(item => item.phaseId === 'builder-publication')[1]!;
  assert.ok(
    update.prompt.includes(`--force-with-lease=refs/heads/${(await h.work()).branch}:${'d'.repeat(40)}`) &&
      update.prompt.includes('Do NOT create a pull request: #4'),
  );
  const publication = publicationOf(await h.work());
  assert.deepEqual(
    [publication.pullRequest!.number, publication.pullRequest!.headSha, publication.attempts!.map(item => item.head)],
    [4, 'e'.repeat(40), ['d'.repeat(40), 'e'.repeat(40)]],
  );
  assert.deepEqual(publication.linkedHeads, ['d'.repeat(40), 'e'.repeat(40)]);
  await h.cycles(3);
  assert.equal(h.activations().length, 4, 'nothing repeated');
});

test('real-run recovery: the push landed but `gh pr create` failed -> ONE PR-only continuation (no push) links the PR; a second failure blocks', async t => {
  const pushOnly = (remote: Remote, activation: Activation) => {
    const { branch, head } = /your branch (?<branch>\S+);.*verified commit (?<head>[0-9a-f]{40})/s.exec(activation.prompt)!.groups as {
      branch: string;
      head: string;
    };
    (remote.refs ??= {})[branch] = head; // like the real run: the push succeeded, the PR creation did not
  };
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: pushOnly, end: 'success' },
    { kind: 'publish', publish: publishOwn(), end: 'success' },
  ]);
  await h.implemented();
  await h.settle(async () => publicationOf(await h.work())?.state === 'published', 'linked after the PR-only continuation');
  const [first, second] = h.activations().filter(item => item.phaseId === 'builder-publication');
  assert.ok(first!.prompt.includes('git -C /workspace/checkout push --force-with-lease'), 'the first activation pushes');
  assert.ok(
    second!.prompt.includes('already holds the verified commit') && !second!.prompt.includes('git -C /workspace/checkout push'),
    'the continuation never pushes',
  );
  assert.ok(second!.prompt.includes('gh pr create'));
  const publication = publicationOf(await h.work());
  assert.deepEqual(
    publication.attempts!.map(item => item.expectedRemote),
    [{ state: 'absent' }, { state: 'present', sha: 'd'.repeat(40) }],
  );
  assert.ok((await h.work()).history.some(item => item.event === 'publication-requested' && item.detail.startsWith('create-pull-request-only:')));
  await h.stop();
  // The continuation fails too: never a third activation.
  const again: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const g = await harness(t, again, [
    { kind: 'implement', head: 'd'.repeat(40) },
    { kind: 'publish', publish: pushOnly, end: 'success' },
    { kind: 'publish', publish: () => {}, end: 'success' },
  ]);
  await g.implemented();
  await g.settle(async () => publicationOf(await g.work())?.state === 'blocked', 'blocked');
  await g.cycles(3);
  assert.deepEqual(publicationOf(await g.work()).reasons, ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_AT_VERIFIED_HEAD']);
  assert.equal(g.activations().filter(item => item.phaseId === 'builder-publication').length, 2);
});
