import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, humanPush, publishOwn, pushAs, pushWip, type Activation, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// v2 ticket 06 (Operator decision 1A/2a; V2-05, V2-08), flow level: real Control + Pi Durable + temporary SQLite with the real review rounds
// and end-of-Execution verification. Doubled: GitHub, clock, the Sandbox (declaring NO persistent disk, or the MVP one), Workers and
// credentials. Control branches on the declared capability only. Not evidence of a real sandbox, worker or GitHub.
const main = 'b'.repeat(40), head = 'd'.repeat(40);
async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[], options: { diskless: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-inboot-publication-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const execution = executionDoubles(remote, scripts, options);
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], factoryApp: async () => app },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => untilHolds(label, async () => {
    if (predicate(await work())) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  const kinds = () => execution.calls.map(call => call.kind).filter(kind => ['prepare', 'start', 'activate', 'stop', 'issue', 'observe-checkout'].includes(kind));
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  return { execution, work, settle, kinds, activations };
}
const executionsOf = (work: WorkView): ExecutionView[] => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];
const branchOf = (activation: Activation) => /branch=(\S+)/.exec(activation.prompt)![1]!;

test('without a persistent disk a Work goes from the Ticket to its own draft PR in ONE Execution and ONE boot: verified, then published by the same boot', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const h = await harness(t, remote, [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }], { diskless: true });
  await h.settle('published', value => value?.publication?.state === 'published');
  const work = (await h.work())!;
  const executions = executionsOf(work);
  assert.equal(executions.length, 1, 'no separate publication Execution exists on this profile');
  const [execution] = executions as [ExecutionView];
  assert.deepEqual([execution.end?.outcome, execution.end?.cessation, execution.slot.held, execution.request.publishInBoot], ['completed', 'confirmed', false, true]);
  // One boot: prepared, started, the implementation Builder, the publishing Builder, and only then stopped.
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'activate', 'stop']);
  // The boot clones the commit Control read on `origin` (the base tip: the Work branch does not exist yet), on the Work branch.
  const started = h.execution.calls.find(call => call.kind === 'start')!.detail as { repository: string; commit: string; branch: string };
  assert.deepEqual(started, { repository: 'acme/project', installationId: scope.installationId, commit: main, branch: work.branch });
  assert.deepEqual([execution.request.baseCommit, execution.request.checkout, execution.request.skillPack?.name], [main, '/workspace/checkout', 'factory/skill-pack/factory-skills-v6']);
  assert.deepEqual(execution.origin, { atStart: { state: 'absent' }, startCommit: main });
  assert.equal(execution.checkout, undefined, 'no host checkout is fingerprinted');
  // The write grant is the Execution's own, issued once; the implementation Builder may publish work in progress (HEAD to its branch, no
  // force: final review, must-fix 2), the publishing one gets exactly the lease.
  assert.deepEqual(h.execution.calls.filter(call => call.kind === 'issue').map(call => call.detail), ['builder-publish']);
  assert.equal(execution.credential?.purpose, 'builder-publish');
  const [implementation, publication] = h.activations() as [Activation, Activation];
  assert.deepEqual([implementation.phaseId, implementation.pushPolicy, Boolean(implementation.handoff)],
    ['builder-initial', { branch: work.branch, head: main, expected: null, remote: 'https://github.com/acme/project.git', wip: true }, true]);
  assert.deepEqual([publication.phaseId, publication.executionId, publication.handoff, publication.editSourceMaxBytes], ['builder-publication', execution.executionId, null, undefined]);
  assert.deepEqual(publication.pushPolicy, { branch: work.branch, head, remote: 'https://github.com/acme/project.git', expected: null });
  assert.ok(publication.prompt.includes(`push --force-with-lease=refs/heads/${work.branch}: https://github.com/acme/project.git ${head}:refs/heads/${work.branch}`));
  assert.match(publication.prompt, /gh pr create --repo acme\/project --draft/);
  // The attempt was recorded before the launch, bound to this Execution; the link is Control's discovery AFTER cessation at exactly the verified head.
  assert.equal(execution.inBootPublication?.head, head);
  assert.notEqual(execution.inBootPublication?.invocationId, execution.invocationId);
  assert.equal(execution.inBootPublication?.outcome?.status, 'completed');
  assert.deepEqual(work.publication!.attempts!.map(item => [item.executionId, item.head, item.expectedRemote]), [[execution.executionId, head, { state: 'absent' }]]);
  assert.deepEqual([work.publication!.verified!.head, work.publication!.pullRequest?.headSha, work.pullRequest?.number], [head, head, 4]);
  assert.deepEqual(work.publication!.discoveries.map(item => [item.trigger, item.outcome]), [['verified', 'absent'], ['after-publication', 'linked']]);
  assert.deepEqual(work.impediments, []);
  // v2 ticket 07: the published workspace passes the preservation gate at once, before the stop; the confirmed commit is on the Work.
  assert.deepEqual(execution.preservationGate?.attempts.map(item => [item.outcome, item.commit]), [['accepted', head]]);
  assert.deepEqual([work.preservation?.commit, work.preservation?.occasion], [head, 'ci-wait']);
  const order = h.execution.calls.map(call => call.kind).filter(kind => kind === 'gate' || kind === 'stop');
  assert.deepEqual(order, ['gate', 'stop']);
});

test('the same scenario on a sandbox WITH a persistent disk keeps the MVP flow: a second, publish-only Execution on the preserved workspace', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const h = await harness(t, remote, [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }], { diskless: false });
  await h.settle('published', value => value?.publication?.state === 'published');
  const work = (await h.work())!;
  const executions = executionsOf(work);
  assert.deepEqual(executions.map(item => [item.request.resume?.reason ?? null, item.request.publishInBoot ?? null, item.credential?.purpose, item.inBootPublication ?? null, item.origin ?? null]),
    [[null, null, 'builder-start', null, null], ['PUBLICATION_REQUESTED', null, 'builder-publish', null, null]]);
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'stop', 'prepare', 'start', 'issue', 'activate', 'stop']);
  assert.deepEqual(h.execution.calls.filter(call => call.kind === 'start').map(call => call.detail), [null, null], 'the host checkout is prepared; nothing is cloned in the guest');
  // The working Builder of a sandbox that keeps its disk gets no push policy at all, as in the MVP (final review, must-fix 2).
  assert.deepEqual(h.activations().map(item => [item.phaseId, item.pushPolicy && 'wip' in (item.pushPolicy as object)]), [['builder-initial', null], ['builder-publication', false]]);
  // v2 ticket 07: a sandbox that keeps its disk has no preservation gate.
  assert.deepEqual([h.execution.calls.filter(call => call.kind === 'gate').length, work.preservation ?? null, executions.map(item => item.preservationGate ?? null)], [0, null, [null, null]]);
});

test('without a persistent disk nothing boots while `origin` cannot be read: the Slot is released and the Work starts once it is readable', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main: 'unknown' } };
  const h = await harness(t, remote, [{ kind: 'implement', head }, { kind: 'publish', publish: publishOwn(), end: 'success' }], { diskless: true });
  await h.settle('released', value => value?.execution?.state === 'released');
  const refused = (await h.work())!;
  assert.deepEqual([refused.execution!.slot.held, refused.execution!.held?.nextStep, refused.execution!.charge?.state ?? 'none'], [false, 'ORIGIN_BASE_NOT_READ', 'none']);
  assert.deepEqual(h.kinds().filter(kind => kind !== 'prepare'), [], 'no boot, no credential, no worker');
  remote.refs = { main };
  await h.settle('published', value => value?.publication?.state === 'published');
  assert.equal(h.kinds().filter(kind => kind === 'start').length, 1);
});

// Acceptance finding A6: an undecided read in the boot used to block for good, even with the verified commit on the Work branch on origin.
test('A6: an undecided discovery in the boot blocks only until the preservation gate confirms the verified commit on origin; the ordinary discovery then publishes it (PR only)', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main }, refsUnknown: true };
  // v2 ticket 07: the unpublished verified commit is refused by the preservation gate and the Builder publishes it as work in progress.
  const scripts: Script[] = [{ kind: 'implement', head }];
  const h = await harness(t, remote, scripts, { diskless: true });
  scripts.push({ kind: 'publish', publish: pushWip(h.execution.guest, head), end: 'success' }, { kind: 'publish', publish: publishOwn(), end: 'success' });
  await h.settle('ended', value => value?.execution?.end?.cessation === 'confirmed' && !value.execution.slot.held);
  let work = (await h.work())!;
  assert.equal(work.execution!.inBootPublication, undefined, 'no publication activation was launched in the boot');
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'activate', 'stop']);
  assert.deepEqual(work.execution!.preservationGate?.attempts.map(item => item.code), ['HEAD_NOT_PUBLISHED', null]);
  assert.deepEqual([work.preservation?.commit, remote.refs![work.branch!]], [head, head], 'the commit outlives the boot on the Work branch, without a PR');
  // Blocked while nothing showed the commit on origin (the true message), lifted by Control itself once its gate confirmed it there.
  const events = work.history.filter(item => item.event === 'publication-blocked' || item.event === 'publication-block-lifted').map(item => [item.event, (item as { detail?: string }).detail]);
  assert.deepEqual(events, [['publication-blocked', 'VERIFIED_COMMIT_NOT_PUBLISHED_BEFORE_STOP,REFS_UNKNOWN:GITHUB_QUERY_FAILED'], ['publication-block-lifted', `preservation-gate:${head}`]]);
  assert.deepEqual(work.impediments, []);
  // While the read stays incomplete nothing is requested: the safe read is repeated, the Work is not blocked.
  for (let cycle = 0; cycle < 3; cycle += 1) await h.settle('cycle', () => true);
  work = (await h.work())!;
  assert.deepEqual([work.publication!.state, work.publication!.reasons, executionsOf(work).length, work.impediments], ['awaiting-discovery', ['REFS_UNKNOWN:GITHUB_QUERY_FAILED'], 1, []]);
  // A complete read: ONE publish-only Execution that creates only the pull request (the branch already holds the verified commit).
  remote.refsUnknown = false;
  await h.settle('published', value => value?.publication?.state === 'published');
  work = (await h.work())!;
  assert.equal(executionsOf(work).length, 2);
  const publisher = h.activations().at(-1)!;
  assert.ok(publisher.prompt.includes('already holds the verified commit') && !publisher.prompt.includes('push --force-with-lease'), 'never a second push');
  assert.deepEqual(publisher.pushPolicy, { branch: work.branch, head, remote: 'https://github.com/acme/project.git', expected: head });
  assert.deepEqual([work.pullRequest?.number, work.publication!.linkedHeads, work.impediments], [4, [head], []]);
});

test('A6: an incomplete read in the boot with the verified commit already on the Work branch never blocks: it is published once the read is complete', async t => {
  // The acceptance case: the base protection read was denied while the discovery itself read the own branch at the verified head.
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main }, baseProtection: { state: 'unknown', code: 'GITHUB_ACCESS_DENIED' } };
  const h = await harness(t, remote, [{ kind: 'implement', head, during: (world, activation) => pushAs(world, branchOf(activation), head, app) },
    { kind: 'publish', publish: publishOwn(), end: 'success' }], { diskless: true });
  await h.settle('ended', value => value?.execution?.end?.cessation === 'confirmed' && !value.execution.slot.held);
  for (let cycle = 0; cycle < 2; cycle += 1) await h.settle('cycle', () => true);
  let work = (await h.work())!;
  assert.deepEqual([work.publication!.state, work.publication!.reasons, work.impediments], ['awaiting-discovery', ['BASE_PROTECTION_UNKNOWN:GITHUB_ACCESS_DENIED'], []]);
  assert.ok(!work.history.some(item => item.event === 'publication-blocked'), 'never blocked');
  assert.equal(executionsOf(work).length, 1);
  delete remote.baseProtection;
  await h.settle('published', value => value?.publication?.state === 'published');
  work = (await h.work())!;
  assert.deepEqual([executionsOf(work).length, work.pullRequest?.number, work.impediments], [2, 4, []]);
  assert.ok(!h.activations().at(-1)!.prompt.includes('push --force-with-lease'));
});

const wip = 'e'.repeat(40);
test('V2-07: work in progress the working Builder pushed with the Factory App identity is the Factory\'s own tip: the verified commit is published over exactly it', async t => {
  // The verified commit descends from the work in progress (the WIP push is never forced): Control's later preservation check reads that.
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main }, graph: { [head]: [wip] } };
  const h = await harness(t, remote, [{ kind: 'implement', head, during: (world, activation) => pushAs(world, branchOf(activation), wip, app) }, { kind: 'publish', publish: publishOwn(), end: 'success' }], { diskless: true });
  await h.settle('published', value => value?.publication?.state === 'published');
  const work = (await h.work())!;
  assert.deepEqual(work.publication!.discoveries.map(item => [item.trigger, item.outcome]), [['verified', 'absent'], ['after-publication', 'linked']]);
  assert.deepEqual(h.activations()[1]!.pushPolicy, { branch: work.branch, head, remote: 'https://github.com/acme/project.git', expected: wip });
  assert.deepEqual(work.impediments, []);
});

test('NEGATIVE (MVP §10.1): a tip somebody else pushed to the Work branch before any PR is still an unknown change and blocks, with or without a persistent disk', async t => {
  for (const diskless of [true, false]) {
    const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
    const scripts: Script[] = [{ kind: 'implement', head, during: (world, activation) => humanPush(world, branchOf(activation), wip) }];
    const h = await harness(t, remote, scripts, { diskless });
    if (diskless) scripts.push({ kind: 'publish', publish: () => {}, end: 'success' }, { kind: 'publish', publish: () => {}, end: 'success' });
    await h.settle('blocked', value => value?.publication?.state === 'blocked');
    assert.deepEqual((await h.work())!.publication!.reasons.filter(reason => reason === 'REMOTE_BRANCH_UNKNOWN_CHANGE'), ['REMOTE_BRANCH_UNKNOWN_CHANGE'], `diskless=${diskless}`);
  }
});
