import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openControl } from '../../src/control/index.js';
// Module-internal seams (Q14): the withdrawal entry used by the external-wait/cancellation flows and the durable records of an Execution.
import { withdrawActivityCredentials } from '../../src/control/durable/control.js';
import { openStore } from '../../src/control/durable/store.js';
import { readWorks } from '../../src/control/durable/admission.js';
import { reconcileLostCredentials, recordEnd, releaseAfterCessation } from '../../src/control/durable/execution.js';
import { works as workDocs } from '../../src/control/durable/admission.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Control, ControlStatus, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { lifecycleDoubles, tokenOf, type LifecycleOptions } from './credential-doubles.js';

// Flow level (Q11): real Control + Pi Durable + temporary SQLite; GitHub tracker, clock and execution boundaries doubled (synthetic tokens).
// Not evidence of real GitHub issuance/revocation, VM, worker or model.

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, options: LifecycleOptions = {}, storagePath?: string,
  repositories: (typeof scope)[] = [scope]) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-credential-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const doubles = lifecycleDoubles(options);
  const time = manualClock();
  const path = storagePath ?? join(dir, 'control.sqlite');
  const control = await openControl({ storagePath: path, runtimeInventory: 'empty', execution: doubles.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  let stopped = false;
  const halt = async () => { if (!stopped) { stopped = true; stop.abort(); assert.deepEqual(await running, { kind: 'clean' }); } };
  t.after(halt);
  const work = async (number = 3) => ((await control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === number) as WorkView | undefined;
  const until = async (predicate: () => Promise<boolean> | boolean, limit = 1000) => {
    for (let i = 0; i < limit; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('condition not reached');
  };
  return { control, github, doubles, time, work, until, halt, storagePath: path };
}
const secrets = /ghs_synthetic/;
/** A real controller child process is SIGKILLed once it prints `marker` (see credential-crash-child). */
async function crash(storagePath: string, mode: 'active' | 'revoking', marker: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./credential-crash-child.js', import.meta.url)), storagePath, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk; if (output.includes(marker)) child.kill('SIGKILL'); });
    child.on('exit', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`child exited without crash: ${output}`)));
  });
}

test('ticket 20 AC1/AC2/AC3: renewal is a new issue for the same activity, delivered before expiry, beyond the initial validity, without restart; label removal does not cut it', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  // Grants live 1.2 s and are renewed 1 s before expiry: the activity outlives the initial grant several times over.
  const h = await harness(t, remote, { lifetimeMs: () => 1200, beforeExpirySeconds: 1 });
  await h.time.sleeping();
  await h.until(async () => (await h.work())?.execution?.state === 'started');
  const startedAt = Date.now();
  const initialExpiry = Date.parse((await h.work())!.execution!.credential!.expiresAt);
  // Eligibility for a NEXT activation is withdrawn (label removed) while the activity is still authorized.
  remote.issues[0] = remoteIssue(3, { labels: [] });
  const readsBefore = h.github.calls.filter(call => call.method === 'readTicket').length;
  await h.until(() => h.doubles.calls.filter(call => call.kind === 'deliver').length >= 4 && Date.now() > initialExpiry + 300, 2000);
  const deliveries = h.doubles.calls.filter(call => call.kind === 'deliver');
  const issues = h.doubles.calls.filter(call => call.kind === 'issue');
  assert.ok(Date.now() - startedAt >= 1000, 'the Execution kept running past the initial grant expiry');
  assert.deepEqual(deliveries.slice(0, 4).map(call => [call.directive, call.token]), [2, 3, 4, 5].map(n => ['credential', tokenOf(n)]), 'each renewal is a NEW grant delivered to the running worker');
  assert.ok(issues.every(call => JSON.stringify(call.detail) === JSON.stringify(issues[0]!.detail)), 'same Work/Execution/repository context: nothing widened or requested by the model');
  assert.deepEqual(h.doubles.kinds().filter(kind => ['prepare', 'start', 'activate'].includes(kind)), ['prepare', 'start', 'activate'], 'no restart, replay or recovery to renew');
  assert.equal(h.github.calls.filter(call => call.method === 'readTicket').length, readsBefore, 'renewal does not depend on next-activation eligibility');
  const during = (await h.work())!.execution!;
  assert.equal(during.state, 'started');
  assert.ok(during.credentialRenewals.length >= 4);
  for (const renewal of during.credentialRenewals.slice(0, 4)) {
    assert.deepEqual([renewal.outcome, renewal.delivery, renewal.metadata!.purpose, renewal.revocation], ['issued', 'delivered', 'builder-start', null]);
    assert.ok(Date.parse(renewal.requestedAt) < Date.parse(during.credentialIssuance!.metadata!.expiresAt) || renewal.sequence > 1, 'the first renewal precedes the initial expiry');
  }
  assert.ok(Date.parse(during.credentialRenewals[0]!.requestedAt) < initialExpiry, 'renewed BEFORE expires_at');
  h.doubles.complete();
  await h.until(async () => (await h.work())?.execution?.slot.held === false);
  const ended = (await h.work())!.execution!;
  assert.deepEqual([ended.credentialLifecycle.state, ended.credentialLifecycle.reason], ['withdrawn', 'ended']);
  const issuedCount = h.doubles.calls.filter(call => call.kind === 'issue').length;
  const revoked = h.doubles.calls.filter(call => call.kind === 'revoke').map(call => call.token).sort();
  assert.deepEqual(revoked, Array.from({ length: issuedCount }, (_, i) => tokenOf(i + 1)).sort(), 'every known grant (initial and renewals) gets one revocation attempt at the end');
  assert.ok([ended.credentialIssuance!, ...ended.credentialRenewals].every(grant => grant.revocation === 'revoked'));
  assert.ok(h.doubles.calls.findIndex(call => call.kind === 'revoke') > h.doubles.calls.findIndex(call => call.kind === 'close'));
  await h.halt();
  assert.doesNotMatch(await readFile(h.storagePath, 'latin1'), secrets, 'no grant value in durable state');
  assert.doesNotMatch(JSON.stringify(ended), secrets);
});

for (const reason of ['external-wait', 'cancelled'] as const) {
  test(`ticket 20 AC4: ${reason} withdraws new deliveries/renewals and tries to revoke known grants; revoked, failed and unknown stay distinct`, async t => {
    const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
    const outcomes: Record<string, 'revoked' | 'failed' | 'unknown'> = { [tokenOf(1)]: 'revoked', [tokenOf(2)]: 'failed', [tokenOf(3)]: 'unknown' };
    const h = await harness(t, remote, { lifetimeMs: sequence => sequence < 3 ? 1150 : 3600000, beforeExpirySeconds: 1, revoke: token => outcomes[token] ?? 'revoked' });
    await h.time.sleeping();
    await h.until(async () => ((await h.work())?.execution?.credentialRenewals.filter(item => item.delivery === 'delivered').length ?? 0) >= 2, 2000);
    const work = (await h.work())!;
    assert.equal(await withdrawActivityCredentials(h.control, work.work_id, reason), 'withdrawn');
    const after = h.doubles.calls.length;
    const execution = (await h.work())!.execution!;
    assert.deepEqual([execution.credentialLifecycle.state, execution.credentialLifecycle.reason], ['withdrawn', reason]);
    assert.deepEqual([execution.credentialIssuance!.revocation, execution.credentialRenewals[0]!.revocation, execution.credentialRenewals[1]!.revocation],
      ['revoked', 'failed', 'unknown'], 'success, known failure and unknown outcome are recorded distinctly');
    assert.deepEqual([execution.credentialRenewals[1]!.revocationCode], ['SYNTHETIC_UNKNOWN']);
    const withdrawal = h.doubles.calls.find(call => call.directive === 'withdraw-credential');
    assert.ok(withdrawal && withdrawal.at < h.doubles.calls.findIndex(call => call.kind === 'revoke'), 'new commands lose the credential before revocation');
    assert.equal(execution.credentialLifecycle.workerNotice, 'withdrawn', 'the directive result is durable');
    // No renewal or delivery afterwards, even across the former renewal deadline; the activity itself is not restarted.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(h.doubles.calls.slice(after).filter(call => ['issue', 'deliver'].includes(call.kind)).length, 0);
    h.doubles.complete();
    await h.until(async () => (await h.work())?.execution?.slot.held === false);
    assert.equal(h.doubles.calls.filter(call => call.kind === 'revoke').length, 3, 'the end does not revoke the same grants twice');
    assert.equal((await h.work())!.execution!.credentialLifecycle.reason, reason, 'the first withdrawal reason is kept');
    assert.equal(await withdrawActivityCredentials(h.control, work.work_id, reason), 'not-active');
  });
}

test('ticket 20 AC4: a renewal racing a withdrawal is revoked without being delivered', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  let release!: () => void;
  const gate = new Promise<'ok'>(resolve => { release = () => resolve('ok'); });
  const h = await harness(t, remote, { lifetimeMs: () => 1100, beforeExpirySeconds: 1, issue: sequence => sequence === 2 ? gate : 'ok' });
  await h.time.sleeping();
  await h.until(() => h.doubles.calls.filter(call => call.kind === 'issue').length === 2, 2000);
  const work = (await h.work())!;
  const withdrawing = withdrawActivityCredentials(h.control, work.work_id, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  assert.equal(await withdrawing, 'withdrawn');
  assert.equal(h.doubles.calls.filter(call => call.kind === 'deliver' && call.directive === 'credential').length, 0, 'never delivered after the withdrawal');
  assert.deepEqual(h.doubles.calls.filter(call => call.kind === 'revoke').map(call => call.token).sort(), [tokenOf(1), tokenOf(2)]);
  const renewal = (await h.work())!.execution!.credentialRenewals[0]!;
  assert.deepEqual([renewal.outcome, renewal.delivery, renewal.revocation], ['issued', 'not-delivered', 'revoked']);
});

test('ticket 20 AC5: a failed renewal is recorded and never retried blindly; the activity is neither restarted nor recovered just to renew; revocation is not cessation', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, { lifetimeMs: () => 1100, beforeExpirySeconds: 1, issue: sequence => sequence === 2 ? 'unknown' : 'ok', stopCessation: false });
  await h.time.sleeping();
  await h.until(async () => (await h.work())?.execution?.credentialLifecycle.renewal === 'stopped', 2000);
  // Past the initial expiry: the expired grant is not renewed again, nothing is replayed, the Execution keeps its state.
  await new Promise(resolve => setTimeout(resolve, 1300));
  const execution = (await h.work())!.execution!;
  assert.deepEqual([execution.state, execution.held, execution.credentialLifecycle.renewalStop], ['started', null, 'GITHUB_TOKEN_ISSUANCE_UNKNOWN']);
  assert.deepEqual([execution.credentialRenewals.length, execution.credentialRenewals[0]!.outcome, execution.credentialRenewals[0]!.code], [1, 'unknown', 'GITHUB_TOKEN_ISSUANCE_UNKNOWN']);
  assert.deepEqual(h.doubles.kinds().filter(kind => kind !== 'close'), ['prepare', 'start', 'issue', 'activate', 'issue'], 'one renewal attempt, no repeated POST, no re-activation');
  h.doubles.complete();
  await h.until(async () => (await h.work())?.execution?.dispatch.phase === 'stopped');
  const ended = (await h.work())!.execution!;
  // The known grant was revoked, yet cessation is not confirmed: the Slot stays held (revocation/expiry never prove cessation).
  assert.deepEqual([ended.credentialIssuance!.revocation, ended.end!.cessation, ended.slot.held], ['revoked', 'unconfirmed', true]);
  assert.deepEqual((await h.control.inspect({ kind: 'status' }) as ControlStatus).slots, { capacity: 1, held: 1 });
});

test('ticket 20 AC3: owner stop withdraws and tries to revoke; a failed delivery stops renewals and revokes the undelivered grant', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, { lifetimeMs: () => 1100, beforeExpirySeconds: 1, deliver: () => 'failure' });
  await h.time.sleeping();
  await h.until(async () => (await h.work())?.execution?.credentialLifecycle.renewal === 'stopped', 2000);
  const renewal = (await h.work())!.execution!.credentialRenewals[0]!;
  assert.deepEqual([renewal.outcome, renewal.delivery, renewal.revocation, (await h.work())!.execution!.credentialLifecycle.renewalStop],
    ['issued', 'failed', 'revoked', 'CREDENTIAL_DELIVERY_UNCERTAIN']);
  await h.halt();
  assert.deepEqual(h.doubles.calls.filter(call => call.kind === 'revoke').map(call => call.token).sort(), [tokenOf(1), tokenOf(2)]);
  const store = await openStore(h.storagePath);
  try {
    const execution = (await readWorks(store.session))[0]!.execution!;
    assert.deepEqual([execution.credentialLifecycle.state, execution.credentialLifecycle.reason, execution.credentialIssuance!.revocation], ['withdrawn', 'owner-stopped', 'revoked']);
  } finally { await store.close(); }
});

test('ticket 20 AC6: after a controller crash the lost grant is recorded as an impossible revocation with its external validity risk; the installation is not blocked for that reason', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-credential-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, 'control.sqlite');
  // A real controller process holds the grant in memory and is SIGKILLed while the Builder is active (no revocation can run).
  await crash(storagePath, 'active', 'ACTIVE');
  const before = await openStore(storagePath);
  let lost;
  try { lost = (await readWorks(before.session))[0]!.execution!; } finally { await before.close(); }
  assert.deepEqual([lost.state, lost.credentialIssuance!.outcome, lost.credentialIssuance!.revocation], ['started', 'issued', null], 'the crash left a known, unrevoked grant');

  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const first = await harness(t, remote, {}, storagePath);
  await first.time.sleeping();
  const reopened = (await first.work())!.execution!;
  assert.deepEqual([reopened.credentialIssuance!.revocation, reopened.credentialIssuance!.revocationCode], ['impossible', 'VALUE_LOST_AFTER_RESTART']);
  assert.match(reopened.credentialIssuance!.risk!, new RegExp(`until ${reopened.credentialIssuance!.metadata!.expiresAt.replaceAll('.', '\\.')}`));
  assert.match(reopened.credentialIssuance!.risk!, /not proof of cessation/);
  assert.deepEqual([reopened.credentialLifecycle.state, reopened.credentialLifecycle.reason], ['withdrawn', 'controller-restart']);
  assert.equal(first.doubles.calls.filter(call => call.kind === 'revoke').length, 0, 'no secret is recovered from logs/sessions to attempt a revocation');
  assert.deepEqual((await first.work())!.impediments, [], 'no impediment from the lost grant');
  // Ticket 26: the boot reconciliation stopped the own boot (host-confirmed cessation), settled the crashed Execution as an interruption
  // (CONTROLLER_CRASH, recovery pending behind its persisted wait) and released its Slot: the lost-grant risk alone blocks nothing.
  const status = await first.control.inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([status.dispatch, status.dispatchReason], ['open', null], 'the installation is not suspended because a lost grant may remain valid');
  const settled = (await first.work())!;
  assert.deepEqual([settled.execution!.end!.outcome, settled.execution!.end!.code, settled.execution!.slot.held, settled.pendingRecovery!.waitSeconds],
    ['failure', 'CONTROLLER_CRASH', false, 5]);
  await first.until(async () => (await first.work(4))?.execution?.state === 'started');
  assert.equal((await first.work(3))!.execution!.credentialIssuance!.revocationCode, 'VALUE_LOST_AFTER_RESTART', 'the risk record is kept');
  first.doubles.complete();
  await first.until(async () => (await first.work(4))?.execution?.slot.held === false);
  await first.halt();
});

test('review 1: a withdrawal while the initial grant is being issued is seen (not not-active); the Builder is never activated with it', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  let release!: () => void;
  const gate = new Promise<'ok'>(resolve => { release = () => resolve('ok'); });
  const h = await harness(t, remote, { issue: sequence => sequence === 1 ? gate : 'ok' });
  await h.time.sleeping();
  await h.until(() => h.doubles.calls.some(call => call.kind === 'issue'));
  const work = (await h.work())!;
  const withdrawing = withdrawActivityCredentials(h.control, work.work_id, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  assert.equal(await withdrawing, 'withdrawn', 'an issuance in flight is a known activity');
  await h.until(async () => (await h.work())?.execution?.state === 'held');
  const execution = (await h.work())!.execution!;
  assert.equal(h.doubles.calls.filter(call => call.kind === 'activate').length, 0, 'never activated with a withdrawn grant');
  assert.deepEqual([execution.held!.code, execution.credentialIssuance!.revocation, execution.credentialLifecycle.reason], ['ACTIVATION_CREDENTIALS_WITHDRAWN', 'revoked', 'cancelled']);
  assert.ok(h.doubles.calls.some(call => call.kind === 'stop'), 'the own boot is stopped');
});

test('review 1/6: a withdrawal while activation is in flight reaches the worker as soon as it is attached; the directive result is durable', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  let open!: () => void;
  const activateGate = new Promise<void>(resolve => { open = resolve; });
  const h = await harness(t, remote, { activateGate, withdrawDirective: 'failure' });
  await h.time.sleeping();
  await h.until(() => h.doubles.calls.some(call => call.kind === 'activate'));
  const work = (await h.work())!;
  assert.equal(await withdrawActivityCredentials(h.control, work.work_id, 'external-wait'), 'withdrawn');
  assert.deepEqual(h.doubles.calls.filter(call => call.kind === 'revoke').map(call => call.token), [tokenOf(1)]);
  open();
  await h.until(() => h.doubles.calls.some(call => call.directive === 'withdraw-credential'));
  await h.until(async () => (await h.work())?.execution?.credentialLifecycle.workerNotice === 'CREDENTIAL_DELIVERY_UNCERTAIN');
  assert.equal(h.doubles.calls.filter(call => call.kind === 'deliver' && call.directive === 'credential').length, 0);
  h.doubles.complete();
});

test('review 2: no renewal is issued once a withdrawal began (sweep around the renewal deadline)', async t => {
  for (let offset = 0; offset < 12; offset++) {
    const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
    const h = await harness(t, remote, { lifetimeMs: () => 1040, beforeExpirySeconds: 1 });
    await h.time.sleeping();
    await h.until(async () => (await h.work())?.execution?.state === 'started');
    const work = (await h.work())!;
    await new Promise(resolve => setTimeout(resolve, offset * 5));
    const marker = h.doubles.calls.length;
    const withdrawing = withdrawActivityCredentials(h.control, work.work_id, 'cancelled');
    await withdrawing;
    // The withdrawal aborts synchronously when called: any issuance recorded after `marker` STARTED after it.
    assert.equal(h.doubles.calls.slice(marker).filter(call => call.kind === 'issue').length, 0, `offset ${offset}: no issuance starts after the withdrawal`);
    const renewals = (await h.work())!.execution!.credentialRenewals;
    assert.ok(renewals.every(renewal => renewal.delivery !== 'delivered' || renewal.revocation !== null));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(h.doubles.calls.slice(marker).filter(call => call.kind === 'issue').length, 0, 'nothing issued later');
    h.doubles.complete();
    await h.until(async () => (await h.work())?.execution?.slot.held === false);
    await h.halt();
  }
});

test('review 7: an invalid expiresAt stops renewal with a recorded reason instead of looping', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, { expiresAt: () => 'not-a-date' });
  await h.time.sleeping();
  await h.until(async () => (await h.work())?.execution?.credentialLifecycle.renewal === 'stopped');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await h.work())!.execution!.credentialLifecycle.renewalStop, 'GRANT_EXPIRY_INVALID');
  assert.equal(h.doubles.calls.filter(call => call.kind === 'issue').length, 1);
  h.doubles.complete();
});

test('review 4: a crash during the revocation request is reported as an attempted revocation with unknown outcome; reconciliation is skipped for live grants and for a run that never starts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-credential-revoking-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, 'control.sqlite');
  await crash(storagePath, 'revoking', 'REVOKING');
  // Read-only inspection: a Control whose run is already stopped makes no reconciliation write.
  const inspector = await openControl({ storagePath, runtimeInventory: 'unknown' });
  const stopped = new AbortController(); stopped.abort();
  await inspector.run(stopped.signal);
  const store = await openStore(storagePath);
  try {
    const before = (await readWorks(store.session))[0]!.execution!;
    assert.deepEqual([before.credentialIssuance!.revocation, typeof before.credentialIssuance!.revocationAttemptedAt], [null, 'string'], 'durable intent before the DELETE');
    assert.equal(await reconcileLostCredentials(store.session, () => true), 0, 'grants still live in this process are never relabelled');
    assert.equal((await readWorks(store.session))[0]!.execution!.credentialIssuance!.revocation, null);
    assert.equal(await reconcileLostCredentials(store.session, () => false), 1);
    const after = (await readWorks(store.session))[0]!.execution!.credentialIssuance!;
    assert.deepEqual([after.revocation, after.revocationCode], ['unknown', 'REVOCATION_OUTCOME_LOST_AFTER_RESTART']);
    assert.match(after.risk!, /revocation was attempted/i);
    assert.equal(await reconcileLostCredentials(store.session, () => false), 0, 'idempotent');
  } finally { await store.close(); }
});

test('review 5: pre-ticket-20 records are presented by their execution state and their not-attempted revocation carries its risk', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote);
  await h.time.sleeping();
  await h.until(async () => (await h.work())?.execution?.state === 'started');
  h.doubles.complete();
  await h.until(async () => (await h.work())?.execution?.slot.held === false);
  await h.halt();
  // Rewrite the record into its ticket 09 shape (no lifecycle/renewal fields, revocation not-attempted).
  const store = await openStore(h.storagePath);
  try {
    const id = (await readWorks(store.session))[0]!.work_id;
    await store.session.commit(async tx => {
      const document = await tx.doc(workDocs, id, null);
      const execution = document.work!.execution! as unknown as Record<string, unknown>;
      delete execution.credentialRenewals; delete execution.credentialLifecycle;
      execution.credentialIssuance = { ...(execution.credentialIssuance as object), revocation: 'not-attempted' };
      delete (execution.credentialIssuance as Record<string, unknown>).revocationCode; delete (execution.credentialIssuance as Record<string, unknown>).risk;
      delete (execution.credentialIssuance as Record<string, unknown>).revocationAttemptedAt;
    }, BACKGROUND_CONTEXT);
    const legacy = (await readWorks(store.session))[0]!.execution!;
    assert.deepEqual([legacy.credentialLifecycle.state, legacy.credentialLifecycle.reason, legacy.credentialRenewals], ['withdrawn', 'legacy-unknown', []]);
  } finally { await store.close(); }
  const reopened = await harness(t, remote, {}, h.storagePath);
  await reopened.time.sleeping();
  const grant = (await reopened.work())!.execution!.credentialIssuance!;
  assert.equal(grant.revocation, 'not-attempted');
  assert.match(grant.risk!, /not attempted.*may have remained valid/i);
});

test('review 2 (deterministic): a withdrawal that begins while the renewal intent is being committed issues nothing; the renewal is not-attempted', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  let armed: (() => void) | undefined;
  // The renewal revalidation reads the configured repositories right before its intent commit: the withdrawal starts exactly there.
  const repositories = new Proxy([scope], { get(target, key, receiver) {
    if (key === 'some' && armed) { const fire = armed; armed = undefined; fire(); }
    return Reflect.get(target, key, receiver);
  } });
  const h = await harness(t, remote, { lifetimeMs: () => 1100, beforeExpirySeconds: 1 }, undefined, repositories);
  await h.time.sleeping();
  await h.until(async () => (await h.work())?.execution?.state === 'started');
  const work = (await h.work())!;
  let withdrawing: Promise<unknown> | undefined;
  let marker = 0;
  // One microtask later: the intent commit is already queued (beginRenewal starts it synchronously), the withdrawal commit follows it.
  armed = () => queueMicrotask(() => { marker = h.doubles.calls.length; withdrawing = withdrawActivityCredentials(h.control, work.work_id, 'cancelled'); });
  await h.until(() => withdrawing !== undefined, 2000);
  await withdrawing;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.doubles.calls.slice(marker).filter(call => call.kind === 'issue').length, 0, 'no issuance after the withdrawal began');
  const renewals = (await h.work())!.execution!.credentialRenewals;
  assert.deepEqual(renewals.map(renewal => [renewal.outcome, renewal.code]), [['not-attempted', 'CREDENTIALS_WITHDRAWN']]);
  h.doubles.complete();
});
