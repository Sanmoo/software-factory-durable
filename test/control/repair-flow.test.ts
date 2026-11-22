import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, humanPush, leasedPublish, type Activation, type Script } from './publication-doubles.js';
import { comment } from './doubles.js';
import { observedPull } from './readiness-seed.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (S) of ticket 22: real Control + Pi Durable + temporary SQLite with the REAL ticket 13 review rounds/verification, ticket 14
// publication/discovery (lease semantics on the own branch), ticket 15 checks explanation, ticket 16 readiness and the repair desk. Doubled:
// GitHub (CodeRepository/IssueTracker contracts), clock, Sandbox, Workers (scripted Builder/reviewers), credentials. Not evidence of real
// Git, GitHub, CI, VM, model or reviewers.
const first = 'd'.repeat(40);
const repaired = 'e'.repeat(40);
const advanced = '9'.repeat(40);

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[], limits: { correctionLimit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const execution = executionDoubles(remote, scripts);
  // Calendar of the persisted recovery wait (ticket 26), shifted explicitly instead of sleeping.
  let shifted = 0;
  execution.ports.calendar = { now: () => Date.now() + shifted };
  const time = manualClock();
  const control: Control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: execution.ports,
    access: {
      tracker: github.tracker,
      repository: github.repository,
      repositories: [{ ...scope, ...limits }],
      operators: ['operator-one'],
      factoryApp: async () => app,
    },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await time.sleeping();
  t.after(async () => {
    if (!stop.signal.aborted) {
      stop.abort();
      await running;
    }
  });
  const list = async () => (await control.inspect({ kind: 'list' })) as ListView;
  const work = async () => (await list()).works[0] as WorkView;
  // Ticket 40: bounded by the runner budget, never an iteration count.
  const settle = async (predicate: (work: WorkView) => boolean, label: string) => {
    let last: WorkView | undefined;
    await untilHolds(
      () => `${label}: ${JSON.stringify(last?.history.slice(-6) ?? null)}`,
      async () => {
        last = await work();
        if (predicate(last)) return true;
        if (time.isSleeping()) time.advance();
        return false;
      },
      5,
    );
  };
  const cycles = async (n: number) => {
    for (let i = 0; i < n; i++) {
      time.advance();
      await time.sleeping();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  const pause = (operation: 'pause' | 'unpause', n: number) => control.accept({ request_id: `${operation}-${n}`, operation, origin: 'local-cli' });
  const shift = (ms: number) => {
    shifted += ms;
  };
  return { github, execution, list, work, settle, cycles, activations, pause, control, shift };
}
/** The ticket 15 observation of the own PR #4 at `sha` (mergeability, base tip, rules and results as GitHub would report them). */
function observe(
  remote: Remote,
  sha: string,
  extra: Parameters<typeof observedPull>[0] = {},
  change: (observed: ReturnType<typeof observedPull>) => void = () => {},
) {
  const branch = Object.keys(remote.refs ?? {}).find(name => name.startsWith('factory/'))!;
  const observed = observedPull({ headSha: sha, recheckHead: sha, ...extra });
  observed.pullRequest = {
    ...observed.pullRequest,
    pullRequestId: 9004,
    nodeId: 'PR_node4',
    number: 4,
    url: 'https://github.com/acme/project/pull/4',
    headRef: branch,
  };
  change(observed);
  observed.final = { baseTip: observed.baseTip, classic: observed.classic, rules: observed.rules };
  (remote.pullRequests ??= {})[4] = observed;
}
const executionsOf = (work: WorkView): ExecutionView[] => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];
const events = (work: WorkView, name: string) => work.history.filter(item => item.event === name).length;
const complete = <T>(value: T) => ({ state: 'complete' as const, value });
const failingCi = (observed: ReturnType<typeof observedPull>, sha: string, conclusion: string | null = 'failure', status = 'completed') => {
  observed.classic = complete({
    kind: 'required' as const,
    strict: false,
    enforcement: 'everyone',
    checks: [{ context: 'ci', integrationId: null }],
    settings: null,
  });
  observed.checkRuns = complete(
    [
      {
        id: 31,
        name: 'ci',
        headSha: sha,
        status: 'completed',
        conclusion: 'failure',
        appId: 15368,
        appSlug: 'github-actions',
        checkSuiteId: 701,
        startedAt: '2026-11-15T10:00:00Z',
        completedAt: null,
        url: 'https://github.com/acme/project/runs/31',
      },
    ].map(item => ({ ...item, conclusion, status })),
  );
};

test('AC1/AC2/AC3/AC5/AC6/AC7: a confirmed conflict opens ONE correction charged once; the Builder continues its session with the reasons, the same PR is updated with a lease; a new failure of the NEW head respects the budget', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  // The repair's publication lands the new head; GitHub then still computes mergeability (unknown): never a trigger by itself.
  const publishRepair = (target: Remote, activation: Activation) => {
    leasedPublish(target, activation);
    observe(target, repaired, { mergeable: null, baseTip: advanced });
  };
  const h = await harness(
    t,
    remote,
    [
      { kind: 'implement', head: first },
      { kind: 'publish', publish: leasedPublish, end: 'success' },
      { kind: 'implement', head: repaired },
      { kind: 'publish', publish: publishRepair, end: 'success' },
    ],
    { correctionLimit: 1 },
  );
  await h.settle(work => work.publication?.state === 'published', 'first publication');
  const branch = (await h.work()).branch!;
  assert.equal(h.activations().length, 2);
  // The base advanced with a conflicting change: GitHub confirms the conflict on the Factory's own head.
  remote.main = advanced;
  observe(remote, first, { mergeable: false, baseTip: advanced });
  await h.settle(work => work.correction !== null || work.execution?.request.repair != null, 'correction opened');
  const opened = await h.work();
  const correction = opened.correction ?? null;
  if (correction) {
    assert.equal(correction.trigger, 'effective-impediment');
    assert.deepEqual(
      correction.reasons!.map(item => [item.code, item.subject, item.headSha, item.baseTip]),
      [['MERGE_CONFLICT', 'main', first, advanced]],
    );
  }
  await h.settle(work => work.correction === null && (work.corrections ?? []).length === 1, 'correction closed');
  const work = await h.work();
  const closed = work.corrections![0]!;
  assert.deepEqual([closed.outcome, closed.charged, closed.head, closed.sequence], ['published', true, repaired, 1]);
  // One charge for the correction (not per event, push, review or publication); the publication activation preserved it.
  assert.deepEqual([work.budget!.corrections.consumed, work.budget!.corrections.reserved], [1, null]);
  const repair = executionsOf(work).find(item => item.request.resume?.reason === 'REPAIR_REQUESTED')!;
  assert.deepEqual([repair.charge!.kind, repair.charge!.state, repair.charge!.correctionId], ['correction', 'consumed', closed.correctionId]);
  assert.deepEqual(
    repair.request.repair!.reasons.map(item => item.code),
    ['MERGE_CONFLICT'],
  );
  assert.equal(repair.request.resume!.previousExecutionId, executionsOf(work)[0]!.executionId, 'resumes the session of the published verified basis');
  const publication = executionsOf(work).at(-1)!;
  assert.deepEqual(
    [publication.request.publication?.head, publication.charge!.state, publication.charge!.correctionId],
    [repaired, 'preserved', closed.correctionId],
  );
  const [, , builder, publish] = h.activations();
  assert.equal(builder!.phaseId, 'builder-continuation', 'continue of the compatible session');
  assert.ok(
    builder!.prompt.startsWith('continue') &&
      builder!.prompt.includes(`Factory repair (correction ${closed.correctionId})`) &&
      builder!.prompt.includes('MERGE_CONFLICT (main)'),
  );
  assert.ok(builder!.prompt.includes(`FETCH_HEAD is exactly ${advanced}`) && builder!.prompt.includes('NEVER push in this activation'));
  assert.ok(builder!.prompt.includes('rebase your commits onto it by default') && !builder!.prompt.includes('merge --no-ff'), 'only own commits: rebase');
  assert.equal((builder!.handoff as { preserve?: string }).preserve, undefined);
  assert.equal((builder!.handoff as { baseCommit: string }).baseCommit, advanced, 'reviewed against the current base tip it is updated onto');
  assert.match(builder!.token, /Start/, 'the repair never holds a write grant');
  assert.equal(builder!.pushPolicy, null, 'ticket 21 push policy: no push at all in the repair activation');
  assert.equal(
    (publish!.pushPolicy as { expected?: string } | null)?.expected,
    first,
    'the only allowed push: the publication with the lease on the published head',
  );
  assert.equal(publish!.phaseId, 'builder-publication');
  assert.ok(
    publish!.prompt.includes(`--force-with-lease=refs/heads/${branch}:${first} https://github.com/acme/project.git ${repaired}:refs/heads/${branch}`),
    'lease on the published head',
  );
  assert.ok(publish!.prompt.includes('Do NOT create a pull request: #4'), 'the SAME pull request');
  assert.deepEqual([remote.refs![branch], remote.pulls[3]!.length, work.pullRequest?.number], [repaired, 1, 4]);
  assert.deepEqual([events(work, 'correction-opened'), events(work, 'repair-revalidated'), events(work, 'correction-closed')], [1, 1, 1]);
  // Unknown mergeability on the new head (and repeated polling of it) never triggers.
  await h.cycles(4);
  assert.equal(h.activations().length, 4);
  assert.equal((await h.work()).correction, null);
  // A pertinent NEW failure of the NEW head may open another correction; the budget (limit 1) is exhausted: blocked, nothing launched.
  observe(remote, repaired, { baseTip: advanced }, observed => failingCi(observed, repaired));
  await h.settle(work => work.impediments.some(item => item.code === 'CORRECTION_LIMIT_REACHED'), 'second correction blocked by the budget');
  await h.cycles(3);
  const blocked = await h.work();
  assert.equal(h.activations().length, 4, 'no implicit retry beyond the budget');
  assert.deepEqual(
    [blocked.correction!.reasons!.map(item => `${item.code}:${item.subject}@${item.headSha}`), blocked.correction!.sequence, blocked.queue.category],
    [[`REQUIRED_CHECK_FAILED:ci@${repaired}`], 2, 'repair'],
  );
  assert.deepEqual((await h.list()).queues.repair, [blocked.work_id]);
  assert.equal(blocked.budget!.corrections.consumed, 1);
});

test('AC4: reasons that disappear before the start withdraw the correction without charge — in the tracking pass and in the fresh read right before admission', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: first },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
  ]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  // Paused: no new trigger is dispatched, but tracking (checks, readiness, repair) continues.
  await h.pause('pause', 1);
  observe(remote, first, { mergeable: false, baseTip: advanced });
  await h.settle(work => work.correction !== null, 'correction opened while paused');
  assert.equal((await h.work()).queue.category, 'repair');
  observe(remote, first, { mergeable: true, baseTip: advanced });
  await h.settle(work => work.correction === null, 'withdrawn by the tracking pass');
  let work = await h.work();
  assert.deepEqual(
    work.corrections!.map(item => [item.outcome, item.charged]),
    [['withdrawn', false]],
  );
  assert.deepEqual([work.queue.category, work.queue.pending, work.budget!.corrections.consumed, work.budget!.corrections.reserved], ['normal', false, 0, null]);
  // Again (a withdrawn correction treated nothing: the same event may open one again), now withdrawn by the dispatcher's fresh read.
  observe(remote, first, { mergeable: false, baseTip: advanced });
  await h.settle(work => work.correction !== null, 'opened again');
  const before = h.github.calls.filter(call => call.method === 'readPullRequest').length;
  observe(remote, first, { mergeable: true, baseTip: advanced });
  await h.pause('unpause', 2);
  await h.settle(work => work.correction === null, 'withdrawn before admission');
  work = await h.work();
  assert.deepEqual(
    work.corrections!.map(item => [item.outcome, item.charged]),
    [
      ['withdrawn', false],
      ['withdrawn', false],
    ],
  );
  assert.ok(
    h.github.calls
      .filter(call => call.method === 'readPullRequest')
      .slice(before)
      .some(call => !(call.args as { unless?: unknown }).unless),
    'a FRESH complete read immediately before admission (the tracking pass only made light reads of the unchanged head)',
  );
  await h.cycles(3);
  assert.equal(h.activations().length, 2, 'nothing launched');
  assert.deepEqual([work.budget!.corrections.consumed, events(work, 'repair-revalidated')], [0, 0]);
});

test('AC6: a repair that leaves the same head does not spend again on the same event: blocked for the operator, lifted by a new head', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: first },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: first },
  ]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  observe(remote, first, { baseTip: advanced }, observed => failingCi(observed, first));
  await h.settle(work => (work.corrections ?? []).length === 1, 'the repair closed');
  const closed = (await h.work()).corrections![0]!;
  assert.deepEqual([closed.outcome, closed.head, closed.charged], ['published', first, true], 'nothing changed: the same head is linked again');
  await h.settle(work => work.impediments.some(item => item.code === 'REPAIR_EVENT_ALREADY_TREATED'), 'repeated event blocked');
  await h.cycles(3);
  let work = await h.work();
  assert.equal(h.activations().length, 3, 'no second repair of the same event');
  assert.deepEqual([work.correction, work.budget!.corrections.consumed, events(work, 'repair-repeated')], [null, 1, 1]);
  assert.match(work.impediments.find(item => item.code === 'REPAIR_EVENT_ALREADY_TREATED')!.nextStep, /never bypasses, approves or merges/);
  // The check passes on a rerun: the block lifts (nothing to repair).
  observe(remote, first, { baseTip: advanced });
  await h.settle(work => !work.impediments.some(item => item.code === 'REPAIR_EVENT_ALREADY_TREATED'), 'block lifted');
  work = await h.work();
  assert.equal(work.correction, null);
});

test('AC1/AC7: non-triggers on the followed PR — pending CI, unknown mergeability, loose lag, operational result, merge-blocking rule — never open a correction', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: first },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
  ]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  const required = (observed: ReturnType<typeof observedPull>, conclusion: string | null, status = 'completed') =>
    failingCi(observed, first, conclusion, status);
  const cases: [string, () => void][] = [
    ['pending CI', () => observe(remote, first, {}, observed => required(observed, null, 'in_progress'))],
    ['unknown mergeability', () => observe(remote, first, { mergeable: null })],
    [
      'loose lag (base advancing)',
      () => {
        remote.main = advanced;
        observe(remote, first, { baseTip: advanced }, observed => {
          observed.comparison = complete({ status: 'diverged', aheadBy: 1, behindBy: 3 });
        });
      },
    ],
    ['operational result', () => observe(remote, first, {}, observed => required(observed, 'action_required'))],
    [
      'merge-blocking rule',
      () =>
        observe(remote, first, {
          rules: [
            { type: 'pull_request', ruleset: { id: 1, sourceType: 'Repository', source: 'acme/project' } },
            {
              type: 'required_deployments',
              ruleset: { id: 2, sourceType: 'Repository', source: 'acme/project' },
              parameters: { kind: 'required_deployments', environments: ['prod'] },
            },
          ],
        }),
    ],
  ];
  for (const [label, apply] of cases) {
    apply();
    await h.cycles(12); // a stable explanation is fully re-read at least once in 10 intervals (ticket 15)
    const work = await h.work();
    assert.equal(work.correction, null, label);
    assert.equal(work.checks?.latest.pullRequest.headSha, first, label);
  }
  assert.equal(h.activations().length, 2);
  assert.equal((await h.work()).budget!.corrections.consumed, 0);
});

const human = '1'.repeat(40);
const updated = '2'.repeat(40),
  reconciled = '3'.repeat(40),
  merged = '4'.repeat(40);
/** Ticket 21 path: published H1 → a human commit on the branch + scope update → divergence → `incorporate` → reconciliation → published. */
async function withHumanCommit(t: { after(fn: () => Promise<void>): void }, repairScript: Script) {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const publishRepair = (target: Remote, activation: Activation) => {
    leasedPublish(target, activation);
    observe(target, merged, { mergeable: null, baseTip: advanced });
  };
  const h = await harness(t, remote, [
    { kind: 'implement', head: first },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: updated },
    { kind: 'implement', head: reconciled },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
    repairScript,
    { kind: 'publish', publish: publishRepair, end: 'success' },
  ]);
  // Ancestry as GitHub would compare it (ticket 21's Control-side check): the reconciliation rebased onto the human commit, the repair merged the base.
  remote.graph = { [reconciled]: [human], ...(repairScript.kind === 'implement' && repairScript.preserves !== false ? { [merged]: [reconciled, human] } : {}) };
  await h.settle(work => work.publication?.state === 'published', 'first publication');
  const { work_id, branch } = await h.work();
  humanPush(remote, branch!, human);
  await h.control.accept({
    request_id: 'scope-1',
    operation: 'update-scope',
    work_id,
    reason: 'Also mention the rollback owner in the smoke page (only that).',
    origin: 'local-cli',
  });
  await h.settle(work => work.publication?.state === 'diverged', 'diverged');
  const questionId = (await h.work()).publication!.divergences!.at(-1)!.questionId;
  const published = async () =>
    ((await h.control.inspect({ kind: 'question', question_id: questionId })) as unknown as { question: { publication: { state: string } } }).question
      .publication.state === 'published';
  await untilHolds('divergence Question published', async () => (await published()) || (await h.cycles(1), false));
  await h.cycles(1);
  (remote.comments ??= {})[3] = [
    ...(remote.comments?.[3] ?? []),
    comment(`/factory answer ${questionId} incorporate`, { id: 5, login: 'operator-one', type: 'User' }),
  ];
  await h.settle(work => work.publication?.state === 'published' && work.publication.verified?.head === reconciled, 'reconciled and published');
  remote.main = advanced;
  observe(remote, reconciled, { mergeable: false, baseTip: advanced });
  return { h, remote, branch: branch! };
}

test('supervisor decision 3: with human commits on the branch the conflict is repaired by MERGING the base (SHAs kept), proven by the Host capture, then leased', async t => {
  const { h, remote, branch } = await withHumanCommit(t, { kind: 'implement', head: merged, preserves: true });
  await h.settle(work => (work.corrections ?? []).length === 1, 'repair closed');
  const work = await h.work();
  assert.deepEqual([work.corrections![0]!.outcome, work.corrections![0]!.head], ['published', merged]);
  const repairActivation = h.activations().find(item => item.prompt.includes('Factory repair (correction'))!;
  assert.ok(
    repairActivation.prompt.includes('merge --no-ff FETCH_HEAD') && repairActivation.prompt.includes('NEVER rebase') && repairActivation.prompt.includes(human),
  );
  assert.ok(!repairActivation.prompt.includes('rebase your commits onto it by default'));
  assert.equal((repairActivation.handoff as { preserve?: string }).preserve, human, 'every capture proves the human tip is an ancestor');
  const repair = executionsOf(work).find(item => item.request.resume?.reason === 'REPAIR_REQUESTED')!;
  assert.deepEqual(repair.request.repair!.humanTips, [human]);
  assert.equal(remote.refs![branch], merged);
  assert.ok(
    h
      .activations()
      .at(-1)!
      .prompt.includes(`--force-with-lease=refs/heads/${branch}:${reconciled} https://github.com/acme/project.git ${merged}:refs/heads/${branch}`),
  );
});

test('supervisor decision 3: a repair whose result drops the human commit is never published (closed not-publishable, nothing pushed)', async t => {
  const { h, remote, branch } = await withHumanCommit(t, { kind: 'implement', head: merged, preserves: false });
  await h.settle(work => (work.corrections ?? []).length === 1, 'repair closed');
  const work = await h.work();
  assert.equal(work.corrections![0]!.outcome, 'not-publishable');
  assert.ok(work.publication!.reasons.includes('HUMAN_CHANGE_NOT_PRESERVED'));
  await h.cycles(3);
  assert.equal(remote.refs![branch], reconciled, 'the branch keeps the human commit; no push');
  assert.ok(!h.activations().some(item => item.phaseId === 'builder-publication' && item.prompt.includes(merged)));
});

test('supervisor decision 1: under strict the Work shows that every base advance costs a correction from the budget', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: first },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
  ]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  await h.pause('pause', 1);
  observe(remote, first, { baseTip: advanced }, observed => {
    observed.classic = complete({
      kind: 'required' as const,
      strict: true,
      enforcement: 'everyone',
      checks: [{ context: 'ci', integrationId: null }],
      settings: null,
    });
    observed.checkRuns = complete([
      {
        id: 31,
        name: 'ci',
        headSha: first,
        status: 'completed',
        conclusion: 'success',
        appId: 15368,
        appSlug: 'github-actions',
        checkSuiteId: 701,
        startedAt: '2026-11-15T10:00:00Z',
        completedAt: null,
        url: null,
      },
    ]);
    observed.comparison = complete({ status: 'diverged', aheadBy: 1, behindBy: 2 });
  });
  await h.settle(work => work.correction !== null, 'strict correction');
  const correction = (await h.work()).correction!;
  assert.deepEqual(
    correction.reasons!.map(item => item.code),
    ['STRICT_UPDATE_REQUIRED'],
  );
  assert.match(
    correction.nextStep!,
    /each advance of the base requires updating the branch again.*corrections budget \(2 of 3 left\)|corrections budget \(3 of 3 left\)/s,
  );
});

test('review HIGH/MED: an unreadable PR keeps the uncharged correction and its position, and an impeded repair never stalls the dispatch of the next Work', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(5, { blockedBy: [6] }), remoteIssue(6, { labels: [] })] };
  const h = await harness(t, remote, [
    { kind: 'implement', head: first },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: repaired },
  ]);
  await h.settle(work => work.publication?.state === 'published', 'publication of #3');
  await h.pause('pause', 1);
  observe(remote, first, { mergeable: false, baseTip: advanced });
  await h.settle(work => work.correction !== null, 'correction opened');
  const opened = (await h.work()).correction!;
  // The own PR becomes unreadable (any failed/partial read is uncertain) and #5's blocker closes: #5 becomes eligible behind the repair.
  delete remote.pullRequests![4];
  remote.issues[2] = remoteIssue(6, { labels: [], state: 'closed', stateReason: 'completed' });
  await h.cycles(12);
  assert.equal((await h.work()).correction?.correctionId, opened.correctionId, 'an uncertain read never withdraws');
  await h.pause('unpause', 2);
  await h.settle(() => h.activations().some(item => item.prompt.includes('/issues/5')), 'the next Work is dispatched');
  const work = await h.work();
  assert.deepEqual(
    [work.correction?.correctionId, work.queue.category, work.queue.pending, work.budget!.corrections.consumed],
    [opened.correctionId, 'repair', true, 0],
    'the impeded repair keeps its position, uncharged',
  );
  assert.ok(!h.activations().some(item => item.prompt.includes('Factory repair')), 'no repair admitted on an unconfirmed read');
});

test('review MED: an interrupted charged repair recovers WITH its repair request and delivers the reasons deferred since the charge', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const publishRepair = (target: Remote, activation: Activation) => {
    leasedPublish(target, activation);
    observe(target, repaired, { mergeable: null, baseTip: advanced });
  };
  const h = await harness(t, remote, [
    { kind: 'implement', head: first },
    { kind: 'publish', publish: leasedPublish, end: 'success' },
    { kind: 'implement', head: repaired, failure: 'WORKER_INTERRUPTED' },
    { kind: 'implement', head: repaired },
    { kind: 'publish', publish: publishRepair, end: 'success' },
  ]);
  await h.settle(work => work.publication?.state === 'published', 'publication');
  remote.main = advanced;
  observe(remote, first, { mergeable: false, baseTip: advanced });
  await h.settle(work => work.pendingRecovery !== null && work.correction?.consumed === true, 'repair interrupted, recovery pending');
  // A new reason after the charge: deferred, not treated.
  observe(remote, first, { mergeable: false, baseTip: advanced }, observed => failingCi(observed, first));
  await h.settle(work => (work.correction?.pendingReasons ?? []).length === 1, 'deferred reason');
  assert.deepEqual(
    (await h.work()).correction!.reasons!.map(item => item.code),
    ['MERGE_CONFLICT'],
    'the charged reasons are only what the Builder got',
  );
  h.shift(60000);
  await h.settle(work => (work.corrections ?? []).length === 1, 'recovered and closed');
  const work = await h.work();
  const recovery = executionsOf(work).find(item => item.interruption?.reason === 'OPERATIONAL_RECOVERY')!;
  assert.deepEqual(
    recovery.request.repair!.reasons.map(item => item.code),
    ['MERGE_CONFLICT', 'REQUIRED_CHECK_FAILED'],
  );
  const activation = h.activations().find(item => item.executionId === recovery.executionId)!;
  assert.equal(activation.phaseId, 'builder-recovery');
  assert.ok(
    activation.prompt.includes('Factory repair (correction') &&
      activation.prompt.includes('REQUIRED_CHECK_FAILED (ci)') &&
      activation.prompt.includes(`FETCH_HEAD is exactly ${advanced}`),
  );
  assert.equal((activation.handoff as { baseCommit: string }).baseCommit, advanced, 'the recovery is still reviewed against the base tip');
  assert.deepEqual(
    [work.corrections![0]!.outcome, work.corrections![0]!.reasons.length, work.budget!.corrections.consumed, work.budget!.recoveries.consumed],
    ['published', 2, 1, 1],
  );
});
