import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { admitTicket, indexedWork, ownCycles, readWork, readWorks, works } from '../../src/control/durable/admission.js';
import { acceptCancel, acceptNewCycle, acceptReopen, acceptResume, createCycleDesk } from '../../src/control/durable/cycles.js';
import { createDeliveryDesk } from '../../src/control/durable/delivery-desk.js';
import { acceptScopeUpdate } from '../../src/control/durable/scope.js';
import { settleInterruption } from '../../src/control/durable/recovery.js';
import { evaluatePublication, recordDiscovery } from '../../src/control/durable/publication.js';
import { slots } from '../../src/control/durable/execution.js';
import type { CodeRepository, PullRequestReopen } from '../../src/code-repository/index.js';
import type { AccessDependencies } from '../../src/control/types.js';
import { githubDoubles, remoteIssue, scope, ticket, type Remote } from './doubles.js';
import { deliveryRepository, merged, ownFacts, seedPublishedWork, store } from './delivery-fixture.js';

// Ticket 25 storage-real commits and desks (Pi Durable + SQLite). Doubled: GitHub (tracker reads, own PR reads, the reopen mutation). The
// reopen/merge/closure semantics are exercised here at the commit/desk level; the live interruption is in cycles-flow.test.ts. Not GitHub evidence.
async function harness(t: { after(fn: () => Promise<void> | void): void }, options: { active?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-cycles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { session } = await store(t, root);
  const work_id = await seedPublishedWork(session, options);
  if (options.active)
    await session.commit(async tx => {
      (await tx.doc(slots)).held['e-1'] = work_id;
    }, BACKGROUND_CONTEXT);
  const remote: Remote = { issues: [remoteIssue(3)], pulls: {} };
  const github = githubDoubles(remote);
  const pr = { pull: ownFacts() as ReturnType<typeof ownFacts> | 'unavailable', branch: {} as Record<string, string> };
  const delivery = deliveryRepository(pr);
  const reopens: { outcome: PullRequestReopen['kind'] | 'applied-but-closed'; calls: string[]; during?: () => Promise<unknown> } = {
    outcome: 'applied',
    calls: [],
  };
  const repository: CodeRepository = {
    ...delivery.repository,
    async reopenPullRequest(target, effect) {
      reopens.calls.push(`${target.number}:${effect.effectId}`);
      await reopens.during?.();
      if (reopens.outcome === 'applied' && pr.pull !== 'unavailable') pr.pull = { ...pr.pull, state: 'open' };
      return reopens.outcome === 'applied' || reopens.outcome === 'applied-but-closed'
        ? { kind: 'applied', observedAt: new Date().toISOString(), revocation: 'revoked' }
        : { kind: 'unknown', observedAt: new Date().toISOString(), code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'synthetic', revocation: 'revoked' };
    },
  };
  const access: AccessDependencies = { tracker: github.tracker, repository, repositories: [scope] };
  const interrupts: string[] = [];
  const deliveryDesk = createDeliveryDesk({
    session,
    repository,
    repositories: [scope],
    running: () => false,
    interrupt: async id => {
      interrupts.push(id);
    },
    readWorks: () => readWorks(session),
    stopped: () => false,
  });
  const cycles = createCycleDesk({ session, access, readWorks: () => readWorks(session), stopped: () => false });
  const cmd = <T extends string>(operation: T, request_id: string, id = work_id) => ({ request_id, operation, work_id: id, origin: 'local-cli' as const });
  const newDeps = { configured: () => scope, tracker: github.tracker };
  return {
    session,
    work_id,
    remote,
    newDeps,
    github,
    pr,
    delivery,
    reopens,
    deliveryDesk,
    cycles,
    interrupts,
    cmd,
    work: async (id = work_id) => (await readWork(session, id))!,
  };
}

test('AC2/AC3: cancel persists the prohibition first (result, impediment, memory); a later confirmed merge still delivers and keeps the cancellation history', async t => {
  const h = await harness(t, { active: true });
  const receipt = await acceptCancel(h.session, h.cmd('cancel', 'cancel-1'));
  assert.deepEqual(receipt, {
    kind: 'durable',
    request_id: 'cancel-1',
    operation: 'cancel',
    work_id: h.work_id,
    outcome: 'accepted',
    reason: null,
    created: null,
  });
  let work = await h.work();
  assert.equal(work.result, 'cancelled');
  assert.deepEqual([work.cancellation?.state, work.cancellation?.executionId], ['stopping', 'e-1'], 'the Slot holder is still active: not ceased');
  assert.ok(work.impediments.some(item => item.code === 'WORK_CANCELLED'));
  assert.equal(work.queue.pending, false);
  assert.equal(((await ownCycles(h.session, [ticket(3).issueId]))[ticket(3).issueId] as { applicable: { result: string } }).applicable.result, 'cancelled');
  // Same identity and content: same receipt; other content: conflict; a second cancel is already satisfied.
  assert.deepEqual(await acceptCancel(h.session, h.cmd('cancel', 'cancel-1')), receipt);
  assert.deepEqual(await acceptCancel(h.session, { ...h.cmd('cancel', 'cancel-1'), work_id: '00000000-0000-4000-8000-000000000000' }), {
    kind: 'refused',
    code: 'REQUEST_ID_CONFLICT',
  });
  assert.deepEqual((await acceptCancel(h.session, h.cmd('cancel', 'cancel-3'))) as { outcome: string; reason: string }, {
    kind: 'durable',
    request_id: 'cancel-3',
    operation: 'cancel',
    work_id: h.work_id,
    outcome: 'already-satisfied',
    reason: 'ALREADY_CANCELLED',
    created: null,
  });
  // Commands after cancellation never revive it.
  assert.equal(((await acceptResume(h.session, h.cmd('resume', 'resume-1'))) as { reason: string }).reason, 'WORK_CANCELLED');
  assert.equal(
    (
      (await acceptScopeUpdate(h.session, {
        request_id: 'scope-1',
        operation: 'update-scope',
        work_id: h.work_id,
        reason: 'Also docs.',
        origin: 'local-cli',
      })) as { outcome: string }
    ).outcome,
    'not-applied',
  );
  // A human merges the own PR while the cancellation is stopping: delivery prevails, the cancellation stays as history.
  h.pr.pull = merged();
  await h.deliveryDesk.cycle();
  work = await h.work();
  assert.equal(work.result, 'delivered');
  assert.equal(work.delivery?.merge?.duringActivity, 'e-1');
  assert.equal(work.cancellation?.request_id, 'cancel-1');
  const events = work.history.map(item => item.event);
  assert.ok(events.indexOf('cancel-requested') < events.indexOf('delivery-confirmed'));
  assert.match((work.history.find(item => item.event === 'delivery-confirmed') as { detail: string }).detail, /cancel-requested:cancel-1/);
  assert.deepEqual(h.interrupts, [h.work_id], 'the still running activity is interrupted (no new action)');
  assert.equal(((await acceptCancel(h.session, h.cmd('cancel', 'cancel-4'))) as { reason: string }).reason, 'WORK_DELIVERED');
});

test('AC2/AC7: boot reconciliation of a cancelled Work releases the Slot only with confirmed cessation, never requeues or opens a recovery', async t => {
  const h = await harness(t, { active: true });
  await acceptCancel(h.session, h.cmd('cancel', 'cancel-1'));
  const kept = await settleInterruption(h.session, {
    work_id: h.work_id,
    executionId: 'e-1',
    cessation: { result: 'unconfirmed', basis: 'observe-failed', environment: null, boot: null },
    observation: null,
    trigger: 'boot',
    controllerRunId: 'run-1',
  });
  assert.equal(kept, 'kept');
  assert.equal((await h.work()).cancellation?.state, 'stopping', 'uncertain cessation keeps the Slot and the cancellation stopping');
  assert.equal(
    (
      (await acceptNewCycle(
        h.session,
        { request_id: 'new-1', operation: 'new', ticket: { repository: 'acme/project', number: 3 }, keepPredecessorPullRequest: true, origin: 'local-cli' },
        h.newDeps,
      )) as { reason: string }
    ).reason,
    'PREDECESSOR_CESSATION_UNCONFIRMED',
  );
  await settleInterruption(h.session, {
    work_id: h.work_id,
    executionId: 'e-1',
    cessation: { result: 'confirmed', basis: 'sandbox-stop', environment: null, boot: null },
    observation: null,
    trigger: 'boot',
    controllerRunId: 'run-2',
  });
  const work = await h.work();
  assert.deepEqual([work.cancellation?.state, work.execution?.slot.held, work.queue.pending, work.pendingRecovery], ['ceased', false, false, null]);
  assert.ok(work.history.some(item => item.event === 'cancellation-ceased'));
});

test('AC4/AC5: own PR closed without merge stays current/undelivered; resume refused; reopen is one observed effect that grants nothing; resume then confirmed by a read', async t => {
  const h = await harness(t);
  const before = await h.work();
  h.pr.pull = ownFacts({ state: 'closed' });
  await h.deliveryDesk.cycle();
  let work = await h.work();
  assert.equal(work.result, 'closed-unmerged');
  assert.equal(await indexedWork(h.session, ticket(3)), h.work_id, 'the cycle stays current');
  assert.deepEqual(work.budget, before.budget, 'counters kept');
  assert.equal(((await acceptResume(h.session, h.cmd('resume', 'resume-1'))) as { reason: string }).reason, 'PULL_REQUEST_CLOSED_REOPEN_REQUIRED');
  await h.cycles.cycle();
  await h.deliveryDesk.cycle();
  assert.equal((await h.work()).result, 'closed-unmerged', 'polling never reopens or resumes');
  assert.equal(h.reopens.calls.length, 0);
  // reopen: an unknown outcome observed still closed is settled not-applied and never resent implicitly.
  h.reopens.outcome = 'unknown';
  assert.equal(((await acceptReopen(h.session, h.cmd('reopen', 'reopen-1'))) as { outcome: string }).outcome, 'accepted');
  assert.equal(((await acceptReopen(h.session, h.cmd('reopen', 'reopen-2'))) as { reason: string }).reason, 'REOPEN_PENDING');
  await h.cycles.cycle();
  await h.cycles.cycle();
  work = await h.work();
  assert.equal(h.reopens.calls.length, 1, 'sent once');
  assert.equal(work.closure?.reopen?.state, 'not-applied');
  assert.equal(work.result, 'closed-unmerged');
  // A new explicit reopen: applied and confirmed by the independent observation.
  h.reopens.outcome = 'applied';
  assert.equal(((await acceptReopen(h.session, h.cmd('reopen', 'reopen-3'))) as { outcome: string }).outcome, 'accepted');
  await h.cycles.cycle();
  work = await h.work();
  assert.equal(h.reopens.calls.length, 2);
  assert.deepEqual([work.result, work.closure?.reopen?.state], ['open', 'confirmed']);
  assert.deepEqual(
    work.impediments.map(item => item.code),
    ['RESUME_REQUIRED'],
    'reopen grants no resume',
  );
  assert.deepEqual(work.budget, before.budget, 'no budget granted');
  assert.equal(((await acceptReopen(h.session, h.cmd('reopen', 'reopen-4'))) as { reason: string }).reason, 'PULL_REQUEST_NOT_CLOSED_UNMERGED');
  // resume lifts ONLY that suspension, pending the next complete authorization read.
  assert.equal(((await acceptResume(h.session, h.cmd('resume', 'resume-2'))) as { outcome: string }).outcome, 'accepted');
  assert.deepEqual(
    (await h.work()).impediments.map(item => item.code),
    ['AUTHORIZATION_RESUME_PENDING'],
  );
  await h.cycles.cycle();
  work = await h.work();
  assert.deepEqual(work.impediments, []);
  assert.ok(work.history.some(item => item.event === 'resume-confirmed'));
});

test('AC1/AC7: label removal / issue closure suspend durably; restoring them is only observed; resume removes only that suspension and needs a confirming read', async t => {
  const h = await harness(t);
  // Another impediment that resume must never remove.
  await h.session.commit(async tx => {
    (await tx.doc(works, h.work_id, null)).work!.impediments.push({ code: 'EXECUTION_TIMEOUT', scope: 'work', nextStep: 'x' });
  }, BACKGROUND_CONTEXT);
  h.remote.issues[0]!.labels = [];
  await h.cycles.cycle();
  let work = await h.work();
  assert.equal(work.authorization.state, 'withdrawn');
  assert.deepEqual(work.authorization.withdrawal?.codes, ['LABEL_NOT_PRESENT']);
  assert.deepEqual(
    work.impediments.map(item => item.code),
    ['EXECUTION_TIMEOUT', 'AUTHORIZATION_WITHDRAWN'],
  );
  // An unavailable read concludes nothing (neither withdrawal nor restoration).
  h.remote.readFailure = { code: 'GITHUB_QUERY_FAILED' };
  h.remote.issues[0]!.labels = [{ id: 55, name: 'ready-for-agent' }];
  await h.cycles.cycle();
  assert.equal((await h.work()).authorization.withdrawal?.restoredObservedAt, null);
  delete h.remote.readFailure;
  await h.cycles.cycle();
  await h.cycles.cycle();
  work = await h.work();
  assert.ok(work.authorization.withdrawal?.restoredObservedAt, 'restoration observed');
  assert.ok(
    work.impediments.some(item => item.code === 'AUTHORIZATION_WITHDRAWN'),
    'but the suspension stays',
  );
  assert.equal(work.history.filter(item => item.event === 'authorization-restored-observed').length, 1, 'observed once');
  // resume while the issue is closed again: the confirming read re-suspends it.
  assert.equal(((await acceptResume(h.session, h.cmd('resume', 'resume-1'))) as { outcome: string }).outcome, 'accepted');
  assert.equal(((await acceptResume(h.session, h.cmd('resume', 'resume-1b'))) as { reason: string }).reason, 'RESUME_PENDING_AUTHORIZATION_READ');
  h.remote.issues[0]!.state = 'closed';
  await h.cycles.cycle();
  work = await h.work();
  assert.deepEqual(
    work.impediments.map(item => item.code),
    ['EXECUTION_TIMEOUT', 'AUTHORIZATION_WITHDRAWN'],
  );
  assert.ok(work.history.some(item => item.event === 'resume-not-confirmed'));
  h.remote.issues[0]!.state = 'open';
  await acceptResume(h.session, h.cmd('resume', 'resume-2'));
  await h.cycles.cycle();
  assert.deepEqual(
    (await h.work()).impediments.map(item => item.code),
    ['EXECUTION_TIMEOUT'],
    'resolving one impediment never removes the others',
  );
});

test('AC6/AC7: new only after delivery or a ceased cancellation, with predecessor and own resources; an open predecessor PR needs an explicit decision; polling never re-admits', async t => {
  const h = await harness(t);
  const newCycle = (request_id: string, keep: boolean) =>
    acceptNewCycle(
      h.session,
      { request_id, operation: 'new', ticket: { repository: 'ACME/project', number: 3 }, keepPredecessorPullRequest: keep, origin: 'local-cli' },
      h.newDeps,
    ) as Promise<{ outcome: string; reason: string | null; created: string | null }>;
  assert.equal((await newCycle('new-0', false)).reason, 'CYCLE_STILL_CURRENT');
  assert.equal(
    (
      (await acceptNewCycle(
        h.session,
        { request_id: 'new-x', operation: 'new', ticket: { repository: 'acme/project', number: 99 }, keepPredecessorPullRequest: false, origin: 'local-cli' },
        h.newDeps,
      )) as { reason: string }
    ).reason,
    'TICKET_NOT_KNOWN',
  );
  await acceptCancel(h.session, h.cmd('cancel', 'cancel-1'));
  assert.equal((await h.work()).cancellation?.state, 'ceased', 'nothing was running: ceased at once');
  assert.equal((await newCycle('new-1', false)).reason, 'PREDECESSOR_PULL_REQUEST_OPEN', 'the own PR may still be open: explicit decision required');
  // Supervisor decision: `new` re-reads the Ticket when accepted and refuses unless it currently authorizes work (label + open issue).
  h.remote.issues[0]!.labels = [];
  assert.equal((await newCycle('new-1a', true)).reason, 'TICKET_NOT_AUTHORIZED');
  h.remote.issues[0]!.labels = [{ id: 55, name: 'ready-for-agent' }];
  h.remote.issues[0]!.state = 'closed';
  assert.equal((await newCycle('new-1b', true)).reason, 'TICKET_NOT_AUTHORIZED');
  h.remote.issues[0]!.state = 'open';
  h.remote.readFailure = { code: 'GITHUB_QUERY_FAILED' };
  assert.equal((await newCycle('new-1c', true)).reason, 'AUTHORIZATION_READ_UNAVAILABLE', 'an unavailable read never authorizes');
  delete h.remote.readFailure;
  assert.equal((await readWorks(h.session)).length, 1, 'nothing created by the refusals');
  const created = await newCycle('new-2', true);
  assert.equal(created.outcome, 'accepted');
  const successor = (await readWork(h.session, created.created!))!;
  assert.deepEqual([successor.cycle, successor.predecessor, successor.result, successor.queue.sequence], [2, h.work_id, 'open', 2]);
  // Ticket 44: a new cycle is a new Work: its environment declaration is read (and pinned) by the next polling round, never inherited.
  assert.deepEqual(
    successor.impediments.map(item => item.code),
    ['DEPENDENCIES_NOT_EVALUATED', 'ENVIRONMENT_NOT_EVALUATED'],
    'authorization confirmed by the fresh read at acceptance',
  );
  assert.equal(successor.environment?.state, 'not-evaluated');
  assert.equal(successor.authorization.state, 'authorized');
  assert.deepEqual(await newCycle('new-2', true), created, 'same identity and content: same receipt, no second read decision');
  assert.deepEqual(
    [successor.execution, successor.branch, successor.publication ?? null, successor.pullRequest],
    [null, null, null, null],
    'own resources, nothing adopted',
  );
  assert.equal(successor.budget?.corrections.consumed, 0);
  assert.equal(await indexedWork(h.session, ticket(3)), successor.work_id);
  const predecessor = await h.work();
  assert.deepEqual(
    [predecessor.result, predecessor.publication?.pullRequest?.state, predecessor.history.at(-1)?.event],
    ['cancelled', 'open', 'successor-created'],
    'the predecessor PR is neither closed nor adopted',
  );
  // Persistent label + polling: the index points at the current cycle; nothing is admitted again.
  const again = await admitTicket(h.session, {
    ticket: ticket(3),
    repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
    observedAt: 'now',
    label: { id: 55, name: 'ready-for-agent' },
    publication: { observedAt: 'now', limitations: [] },
  });
  assert.deepEqual(again, { kind: 'existing', work_id: successor.work_id });
  assert.equal((await readWorks(h.session)).length, 2);
  assert.equal((await newCycle('new-3', true)).reason, 'CYCLE_STILL_CURRENT', 'one current cycle per Ticket');
});

test('review HIGH/MED-HIGH: a kept predecessor PR merged after `new` delivers THAT predecessor; reads always advance lastReadAt; a closed predecessor PR stops being read', async t => {
  const h = await harness(t);
  await acceptCancel(h.session, h.cmd('cancel', 'cancel-1'));
  const created = (await acceptNewCycle(
    h.session,
    { request_id: 'new-1', operation: 'new', ticket: { repository: 'acme/project', number: 3 }, keepPredecessorPullRequest: true, origin: 'local-cli' },
    h.newDeps,
  )) as { created: string };
  await h.deliveryDesk.cycle();
  assert.ok((await h.work()).delivery?.lastReadAt, 'the read is recorded even though the predecessor is not current');
  h.pr.pull = merged();
  await h.deliveryDesk.cycle();
  const predecessor = await h.work();
  assert.equal(predecessor.result, 'delivered', 'merge always wins for the Work that owns the PR');
  assert.equal(await indexedWork(h.session, ticket(3)), created.created, 'the successor stays the current cycle');
  assert.equal((await readWork(h.session, created.created))!.result, 'open');
  // A second predecessor whose own PR was observed closed is no longer read.
  const h2 = await harness(t);
  await acceptCancel(h2.session, h2.cmd('cancel', 'cancel-2'));
  h2.pr.pull = ownFacts({ state: 'closed' });
  await h2.deliveryDesk.cycle();
  await acceptNewCycle(
    h2.session,
    { request_id: 'new-2', operation: 'new', ticket: { repository: 'acme/project', number: 3 }, keepPredecessorPullRequest: false, origin: 'local-cli' },
    h2.newDeps,
  );
  const reads = h2.delivery.calls.length;
  await h2.deliveryDesk.cycle();
  await h2.deliveryDesk.cycle();
  assert.equal(h2.delivery.calls.length, reads, 'closed predecessor PR: not read again');
});

test('review MED: a reopen APPLIED by GitHub but read closed by a lagging observation stays attempted (uncertain), never not-applied; a later open read confirms', async t => {
  const h = await harness(t);
  h.pr.pull = ownFacts({ state: 'closed' });
  await h.deliveryDesk.cycle();
  h.reopens.outcome = 'applied-but-closed';
  await acceptReopen(h.session, h.cmd('reopen', 'reopen-1'));
  await h.cycles.cycle();
  await h.cycles.cycle();
  assert.equal((await h.work()).closure?.reopen?.state, 'attempted');
  assert.equal(h.reopens.calls.length, 1, 'never resent');
  h.pr.pull = ownFacts({ state: 'open' });
  await h.cycles.cycle();
  assert.deepEqual([(await h.work()).closure?.reopen?.state, (await h.work()).result], ['confirmed', 'open']);
});

test('review LOW-MED: cancel before the reopen is sent settles it not applied (nothing sent); cancel after it was sent reconciles the observation without reviving the cycle', async t => {
  const h = await harness(t);
  h.pr.pull = ownFacts({ state: 'closed' });
  await h.deliveryDesk.cycle();
  await acceptReopen(h.session, h.cmd('reopen', 'reopen-1'));
  await acceptCancel(h.session, h.cmd('cancel', 'cancel-1'));
  await h.cycles.cycle();
  assert.equal(h.reopens.calls.length, 0);
  assert.deepEqual([(await h.work()).closure?.reopen?.state, (await h.work()).result], ['not-applied', 'cancelled']);
  const h2 = await harness(t);
  h2.pr.pull = ownFacts({ state: 'closed' });
  await h2.deliveryDesk.cycle();
  await acceptReopen(h2.session, h2.cmd('reopen', 'reopen-2'));
  h2.reopens.during = () => acceptCancel(h2.session, h2.cmd('cancel', 'cancel-2'));
  await h2.cycles.cycle();
  const work = await h2.work();
  assert.equal(h2.reopens.calls.length, 1);
  assert.deepEqual(
    [work.closure?.reopen?.state, work.result],
    ['confirmed', 'cancelled'],
    'the sent effect is reconciled; cancel still prevails over the cycle',
  );
});

test('review LOW: RESUME_PENDING clears only with a Ticket read that STARTED after the resume commit', async t => {
  const h = await harness(t);
  h.remote.issues[0]!.labels = [];
  await h.cycles.cycle();
  h.remote.issues[0]!.labels = [{ id: 55, name: 'ready-for-agent' }];
  let release!: () => void;
  h.remote.hang = new Promise<void>(resolve => {
    release = resolve;
  });
  const reading = h.cycles.cycle();
  await new Promise(resolve => setTimeout(resolve, 20));
  await acceptResume(h.session, h.cmd('resume', 'resume-1'));
  release();
  await reading;
  delete h.remote.hang;
  assert.ok(
    (await h.work()).impediments.some(item => item.code === 'AUTHORIZATION_RESUME_PENDING'),
    'a read begun before the resume never confirms it',
  );
  await h.cycles.cycle();
  assert.deepEqual((await h.work()).impediments, []);
});

test('review LOW: a request id reused by another operation is a conflict, in both directions', async t => {
  const h = await harness(t);
  await acceptCancel(h.session, h.cmd('cancel', 'shared-1'));
  assert.deepEqual(await acceptResume(h.session, h.cmd('resume', 'shared-1')), { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual(
    await acceptScopeUpdate(h.session, { request_id: 'shared-1', operation: 'update-scope', work_id: h.work_id, reason: 'Docs.', origin: 'local-cli' }),
    { kind: 'refused', code: 'REQUEST_ID_CONFLICT' },
  );
  await acceptScopeUpdate(h.session, { request_id: 'shared-2', operation: 'update-scope', work_id: h.work_id, reason: 'Docs.', origin: 'local-cli' });
  assert.deepEqual(await acceptCancel(h.session, h.cmd('cancel', 'shared-2')), { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
});

test('review MED/LOW-MED: a cancelled or closed-unmerged Work only reconciles an ATTEMPTED publication (never evaluates or requests one)', async t => {
  for (const close of ['cancel', 'closed-unmerged'] as const) {
    const h = await harness(t);
    await h.session.commit(async tx => {
      const work = (await tx.doc(works, h.work_id, null)).work!;
      work.publication = {
        ...work.publication!,
        state: 'awaiting-discovery',
        attempts: [{ executionId: 'e-1', head: work.publication!.verified!.head, at: 'x' }],
      };
    }, BACKGROUND_CONTEXT);
    if (close === 'cancel') await acceptCancel(h.session, h.cmd('cancel', 'cancel-1'));
    else
      await h.session.commit(async tx => {
        (await tx.doc(works, h.work_id, null)).work!.result = 'closed-unmerged';
      }, BACKGROUND_CONTEXT);
    assert.equal(await evaluatePublication(h.session, h.work_id, 'e-1'), 'stale', `${close}: no new basis evaluated`);
    const recorded = await recordDiscovery(h.session, h.work_id, {
      basisExecutionId: 'e-1',
      executionId: 'e-1',
      trigger: 'after-publication',
      observedAt: 'x',
      ticketNumber: 3,
      branch: { state: 'absent' },
      decision: { outcome: 'absent', expectedRemote: { state: 'absent' }, update: null, refs: {}, reasons: [], candidates: [] },
    });
    assert.notEqual(recorded, 'stale', `${close}: the attempted effect is reconciled`);
    const work = await h.work();
    assert.deepEqual([work.publication?.state, work.queue.pending], ['not-publishable', false], `${close}: nothing requested`);
  }
});
