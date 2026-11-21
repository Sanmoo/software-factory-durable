import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, publishOwn, type Activation, type Script } from './publication-doubles.js';
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
  // The write grant is the Execution's own, issued once; the implementation Builder gets no push policy, the publishing one exactly the lease.
  assert.deepEqual(h.execution.calls.filter(call => call.kind === 'issue').map(call => call.detail), ['builder-publish']);
  assert.equal(execution.credential?.purpose, 'builder-publish');
  const [implementation, publication] = h.activations() as [Activation, Activation];
  assert.deepEqual([implementation.phaseId, implementation.pushPolicy, Boolean(implementation.handoff)], ['builder-initial', null, true]);
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

test('without a persistent disk an undecided discovery in the boot blocks the publication explicitly instead of queuing one that could not find the commit', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main }, refsUnknown: true };
  const h = await harness(t, remote, [{ kind: 'implement', head }], { diskless: true });
  await h.settle('ended', value => value?.execution?.end?.cessation === 'confirmed' && !value.execution.slot.held);
  const work = (await h.work())!;
  assert.deepEqual([work.publication!.state, work.publication!.reasons], ['blocked', ['VERIFIED_COMMIT_NOT_PUBLISHED_BEFORE_STOP', 'REFS_UNKNOWN:GITHUB_QUERY_FAILED']]);
  assert.deepEqual(work.impediments.map(item => item.code), ['PUBLICATION_BLOCKED']);
  assert.equal(work.execution!.inBootPublication, undefined, 'no publication activation was launched');
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'issue', 'activate', 'stop']);
  // Nothing is queued afterwards: the commit died with the boot.
  remote.refsUnknown = false;
  for (let cycle = 0; cycle < 3; cycle += 1) await h.settle('cycle', () => true);
  assert.equal(executionsOf((await h.work())!).length, 1);
});
