import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { untilHolds } from '../runner/budget.js';
import { openStore } from '../../src/control/durable/store.js';
import { works } from '../../src/control/durable/admission.js';
import type { ExecutionView } from '../../src/control/types.js';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlInput, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { recoveryDoubles, updateHost, type RecoveryScript } from './recovery-doubles.js';

// Ticket 41 flow level (S): real Control + Pi Durable/SQLite + REAL Records (question facet) with the file-backed host double (same harness
// as effects27-flow). The first owner is interrupted after the Builder preserved a PARTIAL ask_user record; the next boot blocks the recovery
// (ticket 27, RECOVERY_BLOCKED). The operator's explicit override is then accepted through the public Control `accept` path. Doubled:
// Sandbox host, Builder, credentials, GitHub. Not evidence of a VM, worker, model or GitHub.
const qid = '0b9c6a52-3d3e-4c8f-9a51-000000000041';
const blockedScript: RecoveryScript = { kind: 'ask-preserved', questionId: qid, question: 'Which port should the lost request use?', partial: true };

async function harness(t: { after(fn: () => Promise<void>): void }, options: { recoveryLimit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-override41-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock>; doubles: ReturnType<typeof recoveryDoubles> } | undefined;
  async function start(scripts: RecoveryScript[]) {
    const doubles = recoveryDoubles(dir, scripts);
    const time = manualClock();
    const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: doubles.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, recoveryLimit: options.recoveryLimit }], operators: ['operator-one'] },
      polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time, doubles };
    await time.sleeping();
    return current;
  }
  async function halt() { if (current && !current.stop.signal.aborted) { current.stop.abort(); return current.running; } return null; }
  t.after(async () => { await halt(); });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView;
  const show = async (work_id: string) => await current!.control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  // Bounded by the runner budget (ticket 40), never a counted loop.
  const until = (predicate: () => Promise<boolean> | boolean, label: string) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (current!.time.isSleeping()) current!.time.advance();
    return false;
  }, 5);
  /** Builder preserves a partial request, the owner stops with cessation unconfirmed; the next owner reconciles it into RECOVERY_BLOCKED. */
  async function blocked() {
    await start([blockedScript]);
    await until(async () => (await work())?.execution?.state === 'started' && current!.doubles.calls('question-preserved').length === 1, 'partial request preserved');
    const boot = (await work()).execution!.dispatch.boot!;
    updateHost(dir, state => { state.stuck.push(boot); });
    assert.deepEqual(await halt(), { kind: 'uncertain' });
    updateHost(dir, state => { state.stuck = []; });
    await start([]);
    const found = await work();
    assert.ok(found.impediments.some(item => item.code === 'RECOVERY_BLOCKED'), 'ticket 27 block');
    return found;
  }
  const accept = (input: ControlInput) => current!.control.accept(input);
  const override = (work_id: string, reference: string, request_id: string) =>
    accept({ request_id, operation: 'resume', work_id, override_blocked_recovery: reference, origin: 'local-cli' });
  /** With the owner stopped: edits the stored Execution exactly as a later reconciliation/upgrade could have left it (new objects, never in place). */
  async function seed(work_id: string, change: (execution: ExecutionView) => ExecutionView) {
    const store = await openStore(join(dir, 'control.sqlite'));
    await store.session.commit(async tx => { const record = (await tx.doc(works, work_id, null)).work!; record.execution = change(record.execution!); }, BACKGROUND_CONTEXT);
    await store.close();
  }
  return { dir, start, halt, work, show, until, blocked, accept, override, seed, current: () => current! };
}

test('AC1-AC4: the exact blocked reference is shown; only it is accepted; the decision is audited and the Work returns through ONE operational recovery', async t => {
  const h = await harness(t);
  const work = await h.blocked();
  const blocked = work.execution!.blockedRequest!;
  assert.equal(blocked.reference, `request:${work.execution!.invocationId}:QUESTION_RECORD_INCOMPLETE`);
  assert.deepEqual([blocked.code, blocked.override], ['QUESTION_RECORD_INCOMPLETE', null]);
  const shown = await h.show(work.work_id);
  const action = shown.work.limits.actions.find(item => item.code === 'RECOVERY_BLOCKED')!;
  assert.ok(action.nextStep.includes(`--override-blocked-recovery ${blocked.reference}`), 'show tells the exact command');
  assert.equal(shown.work.execution!.blockedRequest!.reference, blocked.reference);

  // Refusals with a reason; nothing changes.
  const other = `request:${work.execution!.invocationId}:QUESTION_RECORD_MULTIPLE`;
  assert.deepEqual(await h.override(work.work_id, other, 'o41-wrong'), { kind: 'durable', request_id: 'o41-wrong', operation: 'resume', work_id: work.work_id,
    outcome: 'not-applied', reason: 'BLOCKED_REFERENCE_MISMATCH', created: null });
  const unknown = await h.override('11111111-2222-4333-8444-555555555555', blocked.reference, 'o41-unknown');
  assert.deepEqual(['outcome' in unknown && unknown.outcome, 'reason' in unknown && unknown.reason], ['not-applied', 'WORK_NOT_FOUND']);
  const plain = await h.accept({ request_id: 'o41-plain', operation: 'resume', work_id: work.work_id, origin: 'local-cli' });
  assert.equal('reason' in plain && plain.reason, 'NOTHING_TO_RESUME', 'a plain resume never lifts a recovery block');
  assert.deepEqual([(await h.work()).pendingRecovery, (await h.work()).impediments.some(item => item.code === 'RECOVERY_BLOCKED')], [null, true]);

  // Acceptance: one commit, deduplicated by request identity.
  const receipt = await h.override(work.work_id, blocked.reference, 'o41-accept');
  assert.deepEqual(receipt, { kind: 'durable', request_id: 'o41-accept', operation: 'resume', work_id: work.work_id, outcome: 'accepted', reason: null, created: null });
  assert.deepEqual(await h.override(work.work_id, blocked.reference, 'o41-accept'), receipt, 'replay returns the recorded receipt');
  const conflict = await h.accept({ request_id: 'o41-accept', operation: 'resume', work_id: work.work_id, override_blocked_recovery: other, origin: 'local-cli' });
  assert.deepEqual(conflict, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  const second = await h.override(work.work_id, blocked.reference, 'o41-again');
  assert.deepEqual(['outcome' in second && second.outcome, 'reason' in second && second.reason], ['already-satisfied', 'BLOCKED_RECOVERY_ALREADY_OVERRIDDEN']);

  let after = await h.work();
  const decision = after.execution!.blockedRequest!.override!;
  assert.deepEqual([decision.request_id, decision.operator, decision.reference, decision.recoveryRequest], ['o41-accept', { kind: 'local-administrator' }, blocked.reference, 'requested']);
  assert.ok(Number.isFinite(Date.parse(decision.at)));
  assert.equal(after.impediments.some(item => item.code === 'RECOVERY_BLOCKED'), false, 'only that block is lifted');
  assert.deepEqual([after.pendingRecovery!.waitSeconds, after.pendingRecovery!.reason, after.queue.pending], [5, `operator-override:${blocked.reference}`, true]);
  assert.deepEqual(after.history.filter(item => item.event === 'blocked-recovery-overridden').map(item => 'detail' in item ? item.detail : null), [`o41-accept:${blocked.reference}`], 'one audited decision');
  assert.equal(after.questions.length, 0, 'nothing of the lost request is invented');
  assert.equal(h.current().doubles.calls('activate').length, 1, 'accepting launches nothing; the persisted wait still runs');

  h.current().doubles.jumpCalendar(60000);
  await h.until(async () => h.current().doubles.calls('activate').length === 2 && (await h.work()).execution?.end?.outcome === 'completed', 'recovery ran');
  after = await h.work();
  assert.deepEqual([after.execution!.interruption, after.execution!.charge!.kind, after.budget!.recoveries.consumed, after.pendingRecovery],
    [{ previousExecutionId: work.execution!.executionId, reason: 'OPERATIONAL_RECOVERY', code: 'QUESTION_RECORD_INCOMPLETE' }, 'recovery', 1, null]);
  const prompt = h.current().doubles.prompts.at(-1)!.prompt;
  assert.ok(prompt.includes('OPERATIONAL_RECOVERY:QUESTION_RECORD_INCOMPLETE') && !prompt.includes('Which port'), 'the recovery instruction never carries the lost request');
  assert.equal(after.questions.length, 0);
});

test('AC4: with the recoveries budget exhausted the override shows the usual impediment and nothing starts until an explicit grant', async t => {
  const h = await harness(t, { recoveryLimit: 0 });
  const work = await h.blocked();
  const receipt = await h.override(work.work_id, work.execution!.blockedRequest!.reference, 'o41-exhausted');
  assert.equal('outcome' in receipt && receipt.outcome, 'accepted');
  let after = await h.work();
  assert.ok(after.impediments.some(item => item.code === 'RECOVERY_LIMIT_REACHED'), 'usual exhaustion impediment');
  h.current().doubles.jumpCalendar(60000);
  await h.until(async () => (await h.work()).dispatch.reasons.includes('RECOVERY_LIMIT_REACHED'), 'held by exhaustion');
  assert.equal(h.current().doubles.calls('activate').length, 1, 'no implicit retry');
  const grant = await h.accept({ request_id: 'o41-grant', operation: 'grant', work_id: work.work_id, counter: 'recoveries', amount: 1, origin: 'local-cli' });
  assert.equal('outcome' in grant && grant.outcome, 'accepted');
  await h.until(async () => h.current().doubles.calls('activate').length === 2 && (await h.work()).execution?.end?.outcome === 'completed', 'recovery after the grant');
  after = await h.work();
  assert.deepEqual([after.budget!.recoveries.consumed, after.execution!.charge!.kind], [1, 'recovery']);
});

test('AC5: a controller that stops right after the commit leaves a recoverable state; the replayed command is never accepted twice', async t => {
  const h = await harness(t);
  const work = await h.blocked();
  const reference = work.execution!.blockedRequest!.reference;
  const receipt = await h.override(work.work_id, reference, 'o41-crash');
  // The ACK may be lost with the controller: a new owner opens the same storage (the persisted wait has not elapsed).
  await h.halt();
  await h.start([]);
  assert.deepEqual(await h.override(work.work_id, reference, 'o41-crash'), receipt, 'same request identity: the recorded receipt');
  const after = await h.work();
  assert.deepEqual([after.history.filter(item => item.event === 'blocked-recovery-overridden').length, after.history.filter(item => item.event === 'recovery-requested').length,
    after.pendingRecovery!.waitSeconds, after.impediments.some(item => item.code === 'RECOVERY_BLOCKED')], [1, 1, 5, false]);
  assert.equal(h.current().doubles.calls('activate').length, 1);
});

test('review MED 1: a later reconciliation that did NOT resolve the request (restart between block and override) never makes the override impossible', async t => {
  const h = await harness(t);
  const work = await h.blocked();
  const reference = work.execution!.blockedRequest!.reference;
  await h.halt();
  await h.seed(work.work_id, execution => ({ ...execution, recovery: [...execution.recovery!, { ...execution.recovery!.at(-1)!, at: new Date(Date.now() + 1000).toISOString(),
    decision: 'settled', code: null, question: 'absent' }] }));
  await h.start([]);
  const receipt = await h.override(work.work_id, reference, 'o41-after-restart');
  assert.deepEqual(['outcome' in receipt && receipt.outcome, 'reason' in receipt && receipt.reason], ['accepted', null]);
});

test('review MED 1: a later reconciliation that RECORDED that request resolves it: the override is refused (nothing to continue without)', async t => {
  const h = await harness(t);
  const work = await h.blocked();
  await h.halt();
  await h.seed(work.work_id, execution => ({ ...execution, recovery: [...execution.recovery!, { ...execution.recovery!.at(-1)!, at: new Date(Date.now() + 1000).toISOString(),
    decision: 'settled', code: null, question: `recorded:${qid}` }] }));
  await h.start([]);
  const receipt = await h.override(work.work_id, work.execution!.blockedRequest!.reference, 'o41-resolved');
  assert.deepEqual(['outcome' in receipt && receipt.outcome, 'reason' in receipt && receipt.reason], ['not-applied', 'REQUEST_RESOLVED_BY_RECORDS']);
});

test('review MED 2: settling an overridden Execution again never re-blocks it; its pending recovery proceeds', async t => {
  const h = await harness(t);
  const work = await h.blocked();
  const reference = work.execution!.blockedRequest!.reference;
  assert.equal('outcome' in (await h.override(work.work_id, reference, 'o41-resettle')) && 'accepted', 'accepted');
  await h.halt();
  // The stored end lost its confirmed cessation: the next boot reconciles this Execution again (ticket 26).
  await h.seed(work.work_id, execution => ({ ...execution, end: { ...execution.end!, cessation: 'unconfirmed' } }));
  await h.start([]);
  let after = await h.work();
  assert.deepEqual([after.execution!.recovery!.at(-1)!.decision, after.execution!.blockedRequest!.override!.request_id, after.impediments.some(item => item.code === 'RECOVERY_BLOCKED')],
    ['operational-recovery', 'o41-resettle', false]);
  assert.ok(after.pendingRecovery, 'the recovery the operator opened is kept');
  h.current().doubles.jumpCalendar(60000);
  await h.until(async () => h.current().doubles.calls('activate').length === 2 && (await h.work()).execution?.end?.outcome === 'completed', 'recovery ran');
  after = await h.work();
  assert.deepEqual([after.budget!.recoveries.consumed, after.execution!.interruption!.reason], [1, 'OPERATIONAL_RECOVERY']);
});
