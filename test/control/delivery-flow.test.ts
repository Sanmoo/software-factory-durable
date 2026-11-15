import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, lstat, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createDeliveryDesk } from '../../src/control/durable/delivery-desk.js';
import { recordCleanupIntent } from '../../src/control/durable/delivery.js';
import { admitExecution, beginRenewal } from '../../src/control/durable/execution.js';
import { ownCycles, readWork, readWorks } from '../../src/control/durable/admission.js';
import { scope } from './doubles.js';
import type { CodeRepository } from '../../src/code-repository/index.js';
import { deliveryRepository, environment, environmentOf, headSha, merged, ownFacts, realCleanupPorts, sandboxRoot, seedPublishedWork, store } from './delivery-fixture.js';

// Ticket 17 storage-real flows: Pi Durable + SQLite, REAL Sandbox removal / evidence export / Records preservation on synthetic
// environments. Doubled: GitHub (CodeRepository delivery operations) and the systemctl manager identity. Not evidence of real GitHub/VM.
const exists = (path: string) => lstat(path).then(() => true, () => false);

async function harness(t: { after(fn: () => Promise<void> | void): void }, options: { cessation?: 'confirmed' | 'unconfirmed'; active?: boolean } = {}) {
  const root = await sandboxRoot(t);
  const { session } = await store(t, root);
  const work_id = await seedPublishedWork(session, options);
  const own = await environment(root, work_id);
  const foreign = await environment(root, 'foreign-work', 'boot-99999999-2222-4333-8444-555555555555');
  const github = { pull: ownFacts() as ReturnType<typeof ownFacts> | 'unavailable', branch: { 'factory/3-own': headSha, main: 'c'.repeat(40), 'human/x': 'd'.repeat(40) } as Record<string, string>,
    branchOutcomes: [] as ('removed' | 'absent' | 'refused' | 'failed' | 'indeterminate')[] };
  const repository = deliveryRepository(github);
  const log: string[] = [];
  const interrupts: string[] = [];
  const running = new Set<string>();
  const desk = (cleanup = realCleanupPorts(root, log), code = repository.repository) => createDeliveryDesk({ session, repository: code, repositories: [scope], cleanup,
    running: id => running.has(id), interrupt: async id => { interrupts.push(id); }, readWorks: () => readWorks(session), stopped: () => false });
  return { root, session, work_id, own, foreign, github, repository, log, interrupts, running, desk, work: async () => (await readWork(session, work_id))! };
}

test('AC1: only a confirmed merge of the own PR identity delivers; open, closed-unmerged, foreign identity and failed reads never do', async t => {
  const h = await harness(t);
  const desk = h.desk();
  await desk.cycle();
  assert.equal((await h.work()).result, 'open');
  assert.equal((await h.work()).delivery?.observations.at(-1)?.outcome, 'open');
  h.github.pull = 'unavailable';
  await desk.cycle();
  assert.equal((await h.work()).result, 'open', 'a failed read concludes nothing');
  h.github.pull = merged({ pullRequestId: 1234, nodeId: 'PR_other' });
  await desk.cycle();
  assert.equal((await h.work()).result, 'open', 'a merged PR with another identity is not this cycle\'s delivery');
  assert.deepEqual((await h.work()).delivery?.observations.at(-1)?.reasons, ['PULL_REQUEST_ID_MISMATCH', 'PULL_REQUEST_NODE_MISMATCH']);
  h.github.pull = merged({ headSha: 'e'.repeat(40) });
  await desk.cycle();
  assert.equal((await h.work()).result, 'open', 'a merge of a head the Factory never published is not own delivery');
  assert.deepEqual((await h.work()).delivery?.observations.at(-1)?.reasons, ['HEAD_NOT_OWN_CONTENT']);
  assert.equal(h.log.length, 0, 'no cleanup without delivery');
  h.github.pull = merged();
  await desk.cycle();
  const work = await h.work();
  assert.equal(work.result, 'delivered');
  assert.deepEqual(work.delivery?.merge && { ...work.delivery.merge, confirmedAt: 'x', observedAt: 'x' }, { mergedAt: '2026-11-14T12:00:00Z', mergeCommitSha: 'b'.repeat(40),
    headSha, pullRequestId: 9042, number: 42, url: 'https://github.com/acme/project/pull/42', confirmedAt: 'x', observedAt: 'x', duringActivity: null });
  assert.deepEqual(h.repository.calls.filter(call => call.method === 'readPullRequest').map(call => (call.args as { number: number }).number), [42, 42, 42, 42, 42],
    'only the linked own PR is read; no tracker/issue state is consulted');
  assert.ok(work.history.some(item => item.event === 'delivery-confirmed'));
  // Producer of ticket 08's own-cycle merge confirmation (minimal memory + Work record).
  assert.deepEqual(await ownCycles(h.session, [7003]), { 7003: { source: 'work', applicable: { work_id: h.work_id, cycle: 1, result: 'delivered', mergeConfirmed: true }, previousCycles: [] } });
});

test('AC1: a closure without merge is recorded as not delivered and is not re-read automatically (ticket 25 decides the cycle)', async t => {
  const h = await harness(t);
  h.github.pull = ownFacts({ state: 'closed' });
  const desk = h.desk();
  await desk.cycle();
  assert.equal((await h.work()).result, 'open');
  assert.match((await h.work()).delivery!.nextStep, /closed WITHOUT merge/);
  h.github.pull = merged();
  await desk.cycle();
  assert.equal(h.repository.calls.filter(call => call.method === 'readPullRequest').length, 1);
  assert.equal((await h.work()).result, 'open');
});

test('AC1: a merge confirmed during an active Execution is delivery; the activity is interrupted and no new agent action is admitted', async t => {
  const h = await harness(t, { active: true });
  h.github.pull = merged();
  h.running.add(h.work_id);
  await h.desk().cycle();
  const work = await h.work();
  assert.equal(work.result, 'delivered');
  assert.equal(work.delivery?.merge?.duringActivity, 'e-1');
  assert.deepEqual(h.interrupts, [h.work_id]);
  assert.equal(work.cleanup?.state, 'waiting', 'cleanup waits for the activity to cease');
  assert.deepEqual(work.cleanup?.eligibility.reasons, ['ACTIVITY_RUNNING', 'SLOT_HELD:e-1', 'ACTIVITY_NOT_ENDED:e-1']);
  assert.equal(h.log.length, 0);
  assert.deepEqual((await beginRenewal(h.session, h.work_id, 'e-1', { repositoryConfigured: true })).kind, 'refused', 'no credential renewal after delivery');
  const admission = await admitExecution(h.session, { work_id: h.work_id, attemptId: 'x', capacity: 1, authorizationObservedAt: 'x',
    request: { ticket: 't', repository: 'acme/project', base: 'main', branch: 'factory/3-own', policies: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 } } });
  assert.equal(admission.kind, 'refused');
});

test('AC2/AC3/AC5: cleanup starts only after merge + confirmed cessation, preserves evidence first and removes only own resources', async t => {
  const h = await harness(t, { cessation: 'unconfirmed' });
  h.github.pull = merged();
  const desk = h.desk();
  await desk.cycle();
  assert.equal((await h.work()).cleanup?.state, 'waiting');
  assert.deepEqual((await h.work()).cleanup?.eligibility.reasons, ['CESSATION_UNCONFIRMED:e-1']);
  assert.deepEqual(h.log, [], 'nothing preserved or removed before cessation is confirmed');
  // Cessation confirmed later (e.g. the stop result reconciled): the next cycle sweeps immediately, without waiting for any retention period.
  const { releaseAfterCessation } = await import('../../src/control/durable/execution.js');
  await releaseAfterCessation(h.session, h.work_id, 'e-1', 'confirmed');
  await desk.cycle();
  const work = await h.work();
  assert.deepEqual(h.log, [`preserve:${h.own.env}`, `remove:${h.own.env}`], 'evidence preserved BEFORE removal');
  const evidence = work.cleanup!.evidence[0]!;
  assert.equal(evidence.state, 'preserved');
  const manifest = JSON.parse(await readFile(join(h.root, h.work_id, 'evidence', evidence.reference!.id, 'manifest.json'), 'utf8')) as { files: { path: string }[] };
  assert.deepEqual(manifest.files.map(file => file.path), ['files/instructions/v1/AGENTS.md', 'files/review/r1/index.json', 'files/spec/v1/ticket.json']);
  assert.equal(await readFile(join(h.root, h.work_id, 'evidence', evidence.reference!.id, 'files/review/r1/index.json'), 'utf8'), `{"round":1,"work":"${h.work_id}"}`);
  assert.deepEqual(work.cleanup!.resources.map(item => [item.kind, item.state]), [['environment', 'removed'], ['checkout', 'removed'], ['local-branch', 'removed'],
    ['temporaries', 'removed'], ['remote-branch', 'removed']]);
  assert.equal(work.cleanup!.state, 'complete');
  for (const path of ['root.qcow2', 'workspace', 'artifacts']) assert.equal(await exists(join(h.own.directory, path)), false, path);
  assert.equal(await exists(h.own.runtime), false, 'own boot runtime temporary removed');
  assert.equal(await exists(join(h.own.directory, 'owner.json')), true, 'ownership/history records are kept');
  for (const path of ['root.qcow2', 'workspace/checkout/src/a.ts', 'artifacts/review/r1/index.json']) assert.equal(await exists(join(h.foreign.directory, path)), true, `foreign ${path}`);
  assert.equal(await exists(h.foreign.runtime), true);
  assert.equal(await exists(join(h.root, 'cache', 'git', '3.git', 'HEAD')), true, 'shared bare cache protected');
  assert.deepEqual(h.github.branch, { main: 'c'.repeat(40), 'human/x': 'd'.repeat(40) }, 'only the own remote branch is deleted');
  const branchCall = h.repository.calls.find(call => call.method === 'cleanupBranch')!.args as { selection: { branch: string; base: string; expectedTip: string } };
  assert.deepEqual([branchCall.selection.branch, branchCall.selection.base, branchCall.selection.expectedTip], ['factory/3-own', 'main', headSha]);
  assert.deepEqual(work.cleanup!.protected.map(item => item.reason), ['BASE_BRANCH', 'SHARED_FACTORY_CACHE', 'NOT_OWNED', 'NO_GLOBAL_DOCKER_CLEANUP', 'RETAINED_HISTORY']);
  assert.equal(work.result, 'delivered');
  assert.ok(work.history.some(item => item.event === 'delivery-confirmed') && work.history.some(item => item.event === 'admitted'), 'history kept');
  await desk.cycle();
  assert.equal(h.log.length, 2, 'a complete cleanup is never repeated');
});

test('AC5/AC6: partial failure keeps delivery, each resource is independent, and a retry selects only the retryable ones after revalidation', async t => {
  const h = await harness(t);
  h.github.pull = merged();
  h.github.branchOutcomes = ['failed'];
  // A hard link in the workspace makes the real Sandbox refuse that subtree (shared inode), while the disk and temporaries are removed.
  await link(join(h.own.directory, 'workspace/checkout/src/a.ts'), join(h.root, 'outside-hardlink'));
  const desk = h.desk();
  await desk.cycle();
  let work = await h.work();
  assert.equal(work.result, 'delivered', 'a failed cleanup never undoes delivery');
  assert.deepEqual(work.cleanup!.resources.map(item => [item.kind, item.state]), [['environment', 'removed'], ['checkout', 'refused'], ['local-branch', 'refused'],
    ['temporaries', 'removed'], ['remote-branch', 'failed']]);
  assert.equal(work.cleanup!.state, 'pending');
  assert.match(work.cleanup!.nextStep, /pending for 3 own resource/);
  assert.equal(h.github.branch['factory/3-own'], headSha, 'a failed query is not absence: the branch is still there');
  await rm(join(h.root, 'outside-hardlink'));
  await desk.cycle();
  work = await h.work();
  assert.deepEqual(work.cleanup!.resources.map(item => [item.kind, item.state]), [['environment', 'removed'], ['checkout', 'refused'], ['local-branch', 'refused'],
    ['temporaries', 'removed'], ['remote-branch', 'removed']]);
  assert.deepEqual(work.cleanup!.resources.map(item => item.attempts.length), [1, 1, 1, 1, 2], 'only the failed resource is attempted again; refused waits for an operator');
  assert.equal(h.log.filter(entry => entry.startsWith('remove')).length, 1, 'no new Sandbox removal for refused resources');
  assert.equal(h.log.filter(entry => entry.startsWith('preserve')).length, 1, 'preserved evidence is not preserved again');
  assert.equal(work.cleanup!.state, 'pending');
  assert.match(work.cleanup!.nextStep, /2 refused\/kept: never retried automatically/);
});

test('AC5: an intent without a recorded result (crash) is indeterminate, never success, and is revalidated on the next boot sweep', async t => {
  const h = await harness(t);
  h.github.pull = merged();
  // Delivery observed with cleanup not composed (e.g. dispatch closed): eligibility recorded, nothing attempted.
  const { cleanupBranch: _withoutBranchCleanup, ...readOnly } = h.repository.repository;
  await h.desk({ remove: async () => { throw new Error('not reached'); }, preserve: async () => ({ status: 'failed', code: 'EVIDENCE_PRESERVATION_FAILED' }), retrySeconds: 86400 }, readOnly).cycle();
  assert.equal(await recordCleanupIntent(h.session, h.work_id, [`remote-branch:factory/3-own`], 'lost-effect'), 'recorded');
  // A new owner process (boot sweep) finds the intent without result.
  await h.desk().cycle();
  const work = await h.work();
  const branch = work.cleanup!.resources.find(item => item.kind === 'remote-branch')!;
  assert.deepEqual(branch.attempts.map(item => [item.effectId === 'lost-effect' ? 'lost' : 'retry', item.outcome, item.code]),
    [['lost', 'indeterminate', 'RESULT_NOT_RECORDED'], ['retry', 'removed', 'BRANCH_DELETED']]);
});

test('AC2/AC5: evidence that cannot be preserved blocks only that environment; the own remote branch is still cleaned', async t => {
  const h = await harness(t);
  h.github.pull = merged();
  await symlink('/etc/hostname', join(h.own.directory, 'artifacts/review/r1/link'));
  await h.desk().cycle();
  const work = await h.work();
  assert.deepEqual(work.cleanup!.evidence.map(item => [item.state, item.code]), [['failed', 'EVIDENCE_UNSAFE']]);
  assert.deepEqual(work.cleanup!.resources.map(item => [item.kind, item.state, item.attempts.length]), [['environment', 'pending', 0], ['checkout', 'pending', 0],
    ['local-branch', 'pending', 0], ['temporaries', 'pending', 0], ['remote-branch', 'removed', 1]]);
  assert.deepEqual(h.log, [`preserve:${h.own.env}`], 'no removal without preserved evidence');
  assert.equal(await exists(join(h.own.directory, 'root.qcow2')), true);
  assert.deepEqual(await readdir(join(h.root, h.work_id, 'evidence')), [], 'no half-preserved evidence left behind');
});

test('AC6: the retry cadence is the boot sweep and the daily sweep; a refused tip change is kept visible and never forced', async t => {
  const h = await harness(t);
  h.github.pull = merged();
  h.github.branch['factory/3-own'] = 'e'.repeat(40);
  const ports = { ...realCleanupPorts(h.root, h.log), retrySeconds: 86400 };
  const desk = h.desk(ports);
  await desk.cycle();
  await desk.cycle();
  const calls = () => h.repository.calls.filter(call => call.method === 'cleanupBranch').length;
  assert.equal(calls(), 1, 'not retried in the same owner');
  assert.deepEqual((await h.work()).cleanup!.resources.find(item => item.kind === 'remote-branch')?.state, 'refused');
  await h.desk(ports).cycle();
  assert.equal(calls(), 1, 'a refused branch is never retried automatically, not even by the boot sweep (operator decision)');
  assert.equal(h.github.branch['factory/3-own'], 'e'.repeat(40), 'a branch whose tip is not the merged own head is never deleted');
  assert.equal(environmentOf(h.work_id), h.own.env);
});

test('AC6: a failed branch cleanup is retried by the boot sweep and the daily sweep only', async t => {
  const h = await harness(t);
  h.github.pull = merged();
  h.github.branchOutcomes = ['failed', 'failed'];
  let clock = Date.now();
  const ports = { ...realCleanupPorts(h.root, h.log), retrySeconds: 86400 };
  const desk = createDeliveryDesk({ session: h.session, repository: h.repository.repository, repositories: [scope], cleanup: ports, running: () => false,
    interrupt: async () => {}, readWorks: () => readWorks(h.session), stopped: () => false, now: () => clock });
  const calls = () => h.repository.calls.filter(call => call.method === 'cleanupBranch').length;
  await desk.cycle(); await desk.cycle();
  assert.equal(calls(), 1);
  await h.desk(ports).cycle();
  assert.equal(calls(), 2, 'boot sweep');
  clock += 86400 * 1000 + 60000;
  await desk.cycle();
  assert.equal(calls(), 3, 'daily sweep');
  assert.equal((await h.work()).cleanup!.state, 'complete');
});

test('MED3/MED4: bounded reads rotate least-recently-read first, skip recorded closed-unmerged, and one Work\'s failure never stops the cycle', async t => {
  const root = await sandboxRoot(t);
  const { session } = await store(t, root);
  const ids: string[] = [];
  for (let n = 1; n <= 10; n++) ids.push(await seedPublishedWork(session, { number: 100 + n, pr: 100 + n }));
  const read: string[] = [];
  const byPr = (pr: number) => ids[pr - 101]!;
  const repository: CodeRepository = { checkAccess() { throw new Error('x'); }, findPublication() { throw new Error('x'); },
    async readPullRequest(ref) {
      read.push(byPr(ref.number));
      // Work 1: a malformed adapter answer makes its own decision throw (unexpected failure of ONE Work).
      if (ref.number === 101) return { kind: 'observed', source: 'github-rest', observedAt: 'x', repositoryId: 3, pullRequest: null as never };
      return { kind: 'observed', source: 'github-rest', observedAt: new Date().toISOString(), repositoryId: 3,
        pullRequest: ownFacts({ number: ref.number, pullRequestId: 9000 + ref.number, nodeId: `PR_own${ref.number}`, url: `https://github.com/acme/project/pull/${ref.number}`,
          ...(ref.number === 102 ? { state: 'closed' as const } : {}) }) };
    } };
  const works = () => readWorks(session);
  const desk = createDeliveryDesk({ session, repository, repositories: [scope], running: () => false, interrupt: async () => {}, readWorks: works, stopped: () => false });
  await assert.doesNotReject(desk.cycle());
  assert.equal(read.length, 8, 'bounded per cycle');
  assert.ok(desk.view().failures.some(item => item.work_id === ids[0] && item.step === 'merge-observation'), 'the failure is recorded, the others continue');
  await desk.cycle();
  const second = read.slice(8);
  assert.ok(second.includes(ids[8]!) && second.includes(ids[9]!), 'the Works not read in the first cycle are read next (no starvation)');
  assert.equal(second.includes(ids[1]!), false, 'a recorded closure without merge is not re-read');
  const throwing = createDeliveryDesk({ session, repository, repositories: [scope], running: () => false, interrupt: async () => {},
    readWorks: async () => { throw new Error('STORAGE_UNAVAILABLE'); }, stopped: () => false });
  await assert.doesNotReject(throwing.cycle(), 'never aborts the owner cycle');
  assert.deepEqual(throwing.view().failures.map(item => item.code), ['STORAGE_UNAVAILABLE']);
});
