import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ExecutionPorts, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';

// Flow level (Q11): real Control + Pi Durable + temporary SQLite. Doubled: GitHub tracker/repository, clock, and the execution boundaries
// (Sandbox lifecycle, Workers activation, Builder credentials). Not evidence of the real VM/worker/model/GitHub.
const token = 'ghs_syntheticBuilderGrant0123456789';
type Call = { kind: string; at: number; detail?: unknown };

function executionDoubles(control: () => Control, options: { prepare?: 'fail'; hangStart?: boolean; issue?: 'throw'; onBoot?: () => void; stopCessation?: boolean } = {}) {
  const calls: Call[] = [];
  const snapshots: Record<string, WorkView | undefined> = {};
  let releaseStart!: () => void;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  const firstWork = async () => ((await control().inspect({ kind: 'list' })) as ListView).works.find(work => work.execution && work.execution.state !== 'released');
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' }, capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare', at: calls.length, detail: input });
        snapshots.prepare = await firstWork();
        if (options.prepare === 'fail') return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE' };
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v1', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: false, preparedAt: new Date().toISOString() } };
      },
      async start(input) { calls.push({ kind: 'start', at: calls.length, detail: input }); options.onBoot?.(); return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never }; },
      async stop(input) { calls.push({ kind: 'stop', at: calls.length, detail: input });
        return options.stopCessation === false ? { status: 'indeterminate', code: 'X', cessationConfirmed: false } : { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
    },
    credentials: {
      async issue(context) {
        calls.push({ kind: 'issue', at: calls.length, detail: context });
        if (options.issue === 'throw') throw new Error('GITHUB_TOKEN_ISSUANCE_UNKNOWN');
        return { delivery: { token }, metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3, installationId: 2,
          permissions: { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } };
      },
      async revoke() { calls.push({ kind: 'revoke', at: calls.length }); return { kind: 'not-attempted', nextStep: 'ticket 20' }; },
    },
    workers: {
      async activate(invocation, delivery) {
        calls.push({ kind: 'activate', at: calls.length, detail: { invocation: { ...invocation, signal: undefined }, delivery } });
        snapshots.activate = await firstWork();
        const started = (options.hangStart ? startGate : Promise.resolve()).then(() => ({ receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
          invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } }));
        return { worker: invocation.context.invocationId, started, completed: started.then(() => ({ status: 'success' as const, receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' } })),
          close() { calls.push({ kind: 'close', at: calls.length }); } };
      },
    },
  };
  return { ports, calls, snapshots, releaseStart };
}

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, ports: (control: () => Control) => ReturnType<typeof executionDoubles>, runtimeInventory: 'empty' | 'unknown' = 'empty') {
  const dir = await mkdtemp(join(tmpdir(), 'factory-execution-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  const execution = ports(() => current!.control);
  async function start(inventory = runtimeInventory) {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: inventory, execution: execution.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope] }, polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    return current;
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const list = async () => await current!.control.inspect({ kind: 'list' }) as ListView;
  const byNumber = async () => Object.fromEntries((await list()).works.map(work => [work.ticket.number, work])) as Record<number, WorkView>;
  const until = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('condition not reached'); };
  const cycle = async () => { current!.time.advance(); await current!.time.sleeping(); };
  return { github, execution, start, stop, list, byNumber, until, cycle, storagePath, control: () => current!.control };
}

test('AC1/AC5/AC6: revalidated, durably reserved Execution/Slot/intent precede prepare and activate; the start receipt is consumed once; Slot after cessation', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, control => executionDoubles(control));
  const { time } = await h.start();
  await time.sleeping();
  await h.until(async () => (await h.byNumber())[3]?.execution?.slot.held === false);
  const work = (await h.byNumber())[3]!;
  const execution = work.execution!;
  const kinds = h.execution.calls.map(call => call.kind);
  assert.deepEqual(kinds, ['prepare', 'start', 'issue', 'activate', 'close', 'revoke', 'stop']);
  // Reserved durably BEFORE prepare: the Execution identity, Slot and dispatch intent were already visible in storage.
  const atPrepare = h.execution.snapshots.prepare!;
  assert.deepEqual([atPrepare.execution!.state, atPrepare.execution!.dispatch.phase, atPrepare.execution!.slot.held, atPrepare.queue.pending, atPrepare.dispatch.state],
    ['reserved', 'reserved', true, false, 'executing']);
  const atActivate = h.execution.snapshots.activate!.execution!;
  assert.deepEqual([atActivate.dispatch.phase, atActivate.start], ['activation-requested', null], 'activation intent committed before the request');
  assert.equal(atActivate.credential!.purpose, 'builder-start');
  // Dependencies re-read for the dispatch attempt AND again before activation, each evaluation tied to its own attempt.
  const graphReads = h.github.calls.filter(call => call.method === 'readDependencyGraph').length;
  assert.ok(graphReads >= 3, 'polling round + dispatch attempt + activation attempt');
  assert.notEqual(execution.admission.attemptId, execution.admission.activationAttemptId);
  assert.equal(work.dependencies.latest!.attemptId, execution.admission.activationAttemptId);
  assert.ok(h.github.calls.filter(call => call.method === 'readTicket').length >= 3, 'authorization re-read before reserving and before activating');
  assert.deepEqual([execution.state, execution.start!.receiptId, execution.end!.outcome, execution.end!.cessation, execution.slot.held], ['ended', '99999999-2222-4333-8444-555555555555', 'completed', 'confirmed', false]);
  assert.equal(execution.completion.automatic, false);
  assert.deepEqual(work.history.filter(item => item.origin === 'controller-dispatch').map(item => item.event),
    ['execution-reserved', 'execution-prepared', 'execution-booted', 'activation-requested', 'execution-started', 'execution-ended', 'slot-released']);
  // Unambiguous Ticket/repository/base/branch for the Builder; the prompt starts with /implement <ticket link>.
  const prepare = h.execution.calls.find(call => call.kind === 'prepare')!.detail as { workId: string; checkout: Record<string, unknown> };
  assert.deepEqual(prepare.checkout, { repository: 'acme/project', repositoryId: 3, installationId: 2, base: 'main', branch: execution.request.branch });
  assert.match(execution.request.branch, /^factory\/3-[0-9a-f]{8}$/);
  const activation = h.execution.calls.find(call => call.kind === 'activate')!.detail as { invocation: { prompt: string; context: Record<string, string>; skillPack: string; modelBudget: string }; delivery: { credential: { token: string } } };
  assert.match(activation.invocation.prompt, /^\/implement https:\/\/github\.com\/acme\/project\/issues\/3 repository=acme\/project base=main base-commit=a{40} branch=factory\/3-/);
  assert.deepEqual([activation.invocation.context.executionId, activation.invocation.context.invocationId, activation.invocation.context.role], [execution.executionId, execution.invocationId, 'builder']);
  assert.deepEqual([activation.invocation.skillPack, activation.invocation.modelBudget], ['factory-skills-v1', 'builder-v1']);
  assert.equal(activation.delivery.credential.token, token, 'credential travels only in the transient delivery argument');
  assert.doesNotMatch(JSON.stringify(activation.invocation), /ghs_synthetic/);
  assert.equal(execution.request.skillPack!.name, 'factory/skill-pack/factory-skills-v1');
  const status = await h.control().inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([status.dispatch, status.dispatchReason, status.slots], ['open', null, { capacity: 1, held: 0 }]);
  // No automatic retry or second Execution after the end, over further polling rounds.
  await h.cycle(); await h.cycle();
  assert.equal(h.execution.calls.filter(call => call.kind === 'prepare').length, 1);
  await h.stop();
  assert.doesNotMatch(await readFile(h.storagePath, 'latin1'), /ghs_synthetic/, 'no token in durable state');
});

test('AC1: one Slot -> a second eligible Ticket is not reserved while the first holds it; durable start confirmation happens exactly once', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(1), remoteIssue(2)] };
  const h = await harness(t, remote, control => executionDoubles(control, { hangStart: true }));
  const { time } = await h.start();
  await time.sleeping();
  await h.until(async () => h.execution.calls.some(call => call.kind === 'activate'));
  await h.cycle(); await h.cycle();
  const works = await h.byNumber();
  assert.equal(works[1]!.execution!.state, 'reserved');
  assert.equal(works[2]!.execution, null);
  assert.equal(h.execution.calls.filter(call => call.kind === 'prepare').length, 1, 'no global mutex needed: capacity is the Slot count');
  assert.deepEqual((await h.list()).slots, { capacity: 1, held: 1 });
  h.execution.releaseStart();
  await h.until(async () => (await h.byNumber())[1]!.execution!.state === 'ended');
  assert.equal((await h.byNumber())[1]!.history.filter(item => item.event === 'execution-started').length, 1);
});

test('AC1: a blocker appearing between reservation and activation releases the reserved Slot after the own boot ceased; nothing is activated', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(9, { labels: [] })] };
  const h = await harness(t, remote, control => executionDoubles(control, { onBoot: () => { remote.issues[0] = remoteIssue(3, { blockedBy: [9] }); } }));
  const { time } = await h.start();
  await time.sleeping();
  await h.until(async () => (await h.byNumber())[3]?.execution?.state === 'released');
  const work = (await h.byNumber())[3]!;
  assert.deepEqual(h.execution.calls.map(call => call.kind), ['prepare', 'start', 'stop']);
  assert.deepEqual([work.queue.pending, work.execution!.slot.held, work.execution!.held!.code], [true, false, 'ACTIVATION_REVALIDATION_REFUSED']);
  assert.deepEqual(work.impediments.map(item => item.code), ['DEPENDENCY_PENDING']);
});

test('AC1: authorization withdrawn (label removed) before dispatch -> no reservation, no effect', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, control => executionDoubles(control));
  const github = h.github;
  const read = github.tracker.readTicket;
  let reads = 0;
  github.tracker.readTicket = async ref => { reads++; const observed = await read(ref); return reads > 1 && observed.kind === 'observed' ? { ...observed, labels: [] } : observed; };
  const { time } = await h.start();
  await time.sleeping();
  assert.equal((await h.byNumber())[3]!.execution, null);
  assert.deepEqual(h.execution.calls, []);
});

test('failures hold explicitly with the Slot and are never retried; a held Slot keeps dispatch closed after restart', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const h = await harness(t, remote, control => executionDoubles(control, { prepare: 'fail' }));
  const { time } = await h.start();
  await time.sleeping();
  await h.until(async () => (await h.byNumber())[3]?.execution?.state === 'held');
  await h.cycle(); await h.cycle();
  const works = await h.byNumber();
  assert.deepEqual([works[3]!.execution!.held!.code, works[3]!.execution!.slot.held], ['PREPARE_ENVIRONMENT_PREPARATION_INCOMPLETE', true]);
  assert.equal(works[4]!.execution, null, 'the held Slot is not released by assumption');
  assert.equal(h.execution.calls.filter(call => call.kind === 'prepare').length, 1, 'no automatic retry');
  await h.stop();
  await h.start('empty');
  const status = await h.control().inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([status.dispatch, status.dispatchReason], ['closed', 'RECONCILIATION_REQUIRED']);
  const show = await h.control().inspect({ kind: 'show', work_id: works[3]!.work_id }) as ShowView;
  assert.ok(show.kind === 'work' && show.work.execution!.state === 'held');
});

test('AC5: a failed credential issuance holds before any activation (never widened, never retried)', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, control => executionDoubles(control, { issue: 'throw' }));
  const { time } = await h.start();
  await time.sleeping();
  await h.until(async () => (await h.byNumber())[3]?.execution?.state === 'held');
  assert.deepEqual(h.execution.calls.map(call => call.kind), ['prepare', 'start', 'issue']);
  assert.equal((await h.byNumber())[3]!.execution!.held!.code, 'CREDENTIAL_GITHUB_TOKEN_ISSUANCE_UNKNOWN');
});

test('without execution boundaries dispatch stays closed exactly as before (EXECUTION_NOT_ENABLED)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-execution-closed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'c.sqlite'), runtimeInventory: 'empty', access: { tracker: github.tracker, repository: github.repository, repositories: [scope] },
    polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await time.sleeping();
  const list = await control.inspect({ kind: 'list' }) as ListView;
  assert.deepEqual([list.dispatch, list.dispatchReason, list.works[0]!.dispatch], ['closed', 'EXECUTION_NOT_ENABLED', { state: 'held', reasons: ['EXECUTION_NOT_ENABLED'] }]);
  stop.abort(); await running;
});
