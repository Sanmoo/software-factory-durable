import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlStatus, ExecutionPorts, ListView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';

// Ticket 25 flow level: real Control (poller, cycle desk, dispatcher, Pi Durable + SQLite). Doubled: GitHub, clock, Sandbox lifecycle, Workers
// and credentials. Each activation hangs until the test completes it, or until its activity signal aborts. Not evidence of real GitHub/VM.
const environment = `env-${'c'.repeat(64)}`;
function ports(calls: string[], options: { stopConfirmed: () => boolean; startGate?: () => Promise<void> }) {
  const pending: { complete: () => void }[] = [];
  const execution: ExecutionPorts = {
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' }, capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push('prepare');
        return { status: 'success', environment: environment as never, seeds: [],
          checkout: { path: '/workspace/checkout', repository: 'acme/project', repositoryId: 3, base: 'main', branch: input.checkout.branch, baseCommit: 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git', reused: pending.length > 0, preparedAt: new Date().toISOString() } };
      },
      async start() { calls.push('start'); await options.startGate?.(); return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never }; },
      async stop() {
        calls.push('stop');
        return options.stopConfirmed() ? { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }
          : { status: 'indeterminate', cessationConfirmed: false, code: 'STOP_UNCONFIRMED' } as never;
      },
    },
    credentials: {
      async issue() { calls.push('issue'); return { delivery: { token: 'ghs_syntheticDelivery0123456789' }, metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project',
        repositoryId: 3, installationId: 2, permissions: { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } }; },
      async revoke() { calls.push('revoke'); return { kind: 'revoked', code: 'X', nextStep: 'x' }; },
    },
    workers: {
      async activate(invocation) {
        calls.push('activate');
        const receipt = { workId: invocation.context.workId, id: `99999999-2222-4333-8444-5555555555${String(pending.length + 10)}` };
        const started = Promise.resolve({ receipt, invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
        let complete!: () => void;
        const completed = new Promise<{ status: 'success'; receipt: typeof receipt }>(resolve => { complete = () => resolve({ status: 'success', receipt }); });
        pending.push({ complete });
        invocation.signal.addEventListener('abort', () => calls.push('activity-aborted'), { once: true });
        return { worker: invocation.context.invocationId, started, completed, close() { calls.push('close'); } };
      },
      async deliver(_worker, directive) { calls.push(`deliver-${directive.kind}`); return { status: directive.kind === 'credential' ? 'delivered' : 'withdrawn' }; },
    },
  };
  return { execution, complete: () => pending.at(-1)!.complete() };
}

async function harness(t: { after(fn: () => Promise<void> | void): void }, remote: Remote, options: { stopConfirmed?: () => boolean; startGate?: () => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-cycles-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, 'control.sqlite');
  const github = githubDoubles(remote);
  const calls: string[] = [];
  const { execution, complete } = ports(calls, { stopConfirmed: options.stopConfirmed ?? (() => true), ...(options.startGate ? { startGate: options.startGate } : {}) });
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  const start = async () => {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty', execution, access: { tracker: github.tracker, repository: github.repository, repositories: [scope] },
      polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  };
  const stop = async () => { current!.stop.abort(); return current!.running; };
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0]!;
  const until = async (predicate: () => Promise<boolean>, what = 'condition') => {
    for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail(`${what} not reached`); };
  const cycle = async () => { current!.time.advance(); await current!.time.sleeping(); };
  const accept = async (input: Parameters<Control['accept']>[0]) => (await current!.control.accept(input)) as { outcome: string; reason: string | null };
  return { github, calls, start, stop, work, until, cycle, accept, complete, control: () => current!.control };
}

test('AC1/AC7 (flow): label removed during an activity suspends next activations without cutting it; restored label is not enough; resume + confirming read is', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote);
  await h.start();
  await h.until(async () => (await h.work())?.execution?.state === 'started', 'first activity started');
  const work_id = (await h.work()).work_id;
  remote.issues[0]!.labels = [];
  await h.cycle();
  let work = await h.work();
  assert.ok(work.impediments.some(item => item.code === 'AUTHORIZATION_WITHDRAWN'), 'withdrawal recorded durably');
  assert.equal(work.execution?.state, 'started', 'the authorized activity is not cut');
  assert.equal(h.calls.includes('activity-aborted'), false);
  h.complete();
  await h.until(async () => (await h.work()).execution?.slot.held === false, 'activity concluded and ceased');
  // A scope update would resume the Work, but the suspension holds it.
  assert.equal((await h.accept({ request_id: 'scope-1', operation: 'update-scope', work_id, reason: 'Also cover the empty case.', origin: 'local-cli' })).outcome, 'accepted');
  remote.issues[0]!.labels = [{ id: 55, name: 'ready-for-agent' }];
  await h.cycle(); await h.cycle();
  assert.equal(h.calls.filter(call => call === 'activate').length, 1, 'restoring the label never resumes by itself');
  work = await h.work();
  assert.deepEqual(work.dispatch.reasons.filter(code => code.startsWith('AUTHORIZATION')), ['AUTHORIZATION_WITHDRAWN']);
  assert.equal((await h.accept({ request_id: 'resume-1', operation: 'resume', work_id, origin: 'local-cli' })).outcome, 'accepted');
  await h.cycle();
  await h.until(async () => h.calls.filter(call => call === 'activate').length === 2, 'resumed after the confirming read');
  assert.equal((await h.accept({ request_id: 'resume-2', operation: 'resume', work_id, origin: 'local-cli' })).reason, 'EXECUTION_ACTIVE', 'resume informs the activity, never a second Builder');
});

test('AC2/AC3/AC7 (flow): cancel during a command withdraws credentials first, then stops; Slot after confirmed cessation; nothing on GitHub undone; nothing revives it', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  let confirmed = false;
  const h = await harness(t, remote, { stopConfirmed: () => confirmed });
  await h.start();
  await h.until(async () => (await h.work())?.execution?.state === 'started', 'activity started');
  const work_id = (await h.work()).work_id;
  const before = h.calls.length;
  assert.equal((await h.accept({ request_id: 'cancel-1', operation: 'cancel', work_id, origin: 'local-cli' })).outcome, 'accepted');
  await h.until(async () => h.calls.slice(before).includes('stop'), 'stop requested');
  const after = h.calls.slice(before);
  assert.ok(after.indexOf('deliver-withdraw-credential') < after.indexOf('activity-aborted') && after.indexOf('revoke') < after.indexOf('activity-aborted'),
    `credentials withdrawn and revoked before the interruption: ${after.join(',')}`);
  let work = await h.work();
  assert.deepEqual([work.result, work.execution?.end?.outcome, work.execution?.end?.code, work.execution?.credentialLifecycle.reason], ['cancelled', 'stopped', 'WORK_CANCELLED', 'cancelled']);
  // Cessation not confirmed: the Slot stays held and the cancellation is still stopping.
  assert.deepEqual([work.execution?.slot.held, work.cancellation?.state], [true, 'stopping']);
  assert.equal(((await h.control().inspect({ kind: 'status' })) as ControlStatus).slots.held, 1);
  await h.stop();
  // Restart: boot reconciliation confirms cessation (stop now confirmed): Slot released, nothing requeued, no recovery.
  confirmed = true;
  await h.start();
  await h.until(async () => (await h.work()).cancellation?.state === 'ceased', 'cessation confirmed after restart');
  work = await h.work();
  assert.deepEqual([work.execution?.slot.held, work.queue.pending, work.pendingRecovery], [false, false, null]);
  // Persistent label, polling, late commands and restart never start anything again.
  await h.cycle(); await h.cycle();
  assert.equal(h.calls.filter(call => call === 'activate').length, 1);
  assert.equal((await h.accept({ request_id: 'resume-1', operation: 'resume', work_id, origin: 'local-cli' })).reason, 'WORK_CANCELLED');
  assert.equal((await h.accept({ request_id: 'scope-1', operation: 'update-scope', work_id, reason: 'More.', origin: 'local-cli' })).outcome, 'not-applied');
  const status = await h.control().inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([status.works.open, status.works.cancelled, status.delivery.delivered, status.slots.held], [0, 1, 0, 0]);
  // GitHub was only read: no comment, PR or branch change by the cancellation.
  assert.deepEqual([...new Set(h.github.calls.map(call => call.method))].filter(method => !['listCandidates', 'readTicket', 'readDependencyGraph', 'readInputs', 'findPublication'].includes(method)), []);
  // An explicit new cycle (no own PR existed): own Work with predecessor; the label already present does not start the old one.
  const created = await h.accept({ request_id: 'new-1', operation: 'new', ticket: { repository: 'acme/project', number: 3 }, keepPredecessorPullRequest: false, origin: 'local-cli' }) as unknown as { created: string };
  assert.ok(created.created);
  await h.cycle();
  await h.until(async () => h.calls.filter(call => call === 'activate').length === 2, 'the new cycle is dispatched');
  const list = (await h.control().inspect({ kind: 'list' })) as ListView;
  const successor = list.works.find(item => item.work_id === created.created)!;
  assert.deepEqual([successor.cycle, successor.predecessor], [2, work_id]);
  assert.notEqual(successor.execution?.request.branch, work.execution?.request.branch, 'own branch');
});

test('review MED (flow): cancel BEFORE activation stops the own boot and releases the Slot only after confirmed cessation; no credential, no Builder', async t => {
  for (const confirmed of [true, false]) {
    const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const h = await harness(t, remote, { stopConfirmed: () => confirmed, startGate: () => gate });
    await h.start();
    await h.until(async () => h.calls.includes('start'), 'boot requested');
    const work_id = (await h.work()).work_id;
    assert.equal((await h.accept({ request_id: 'cancel-1', operation: 'cancel', work_id, origin: 'local-cli' })).outcome, 'accepted');
    open();
    await h.until(async () => h.calls.includes('stop'), 'own boot stopped');
    await h.until(async () => (await h.work()).execution?.state !== 'reserved' || (await h.work()).execution?.held !== null, 'settled');
    const work = await h.work();
    assert.deepEqual([h.calls.includes('issue'), h.calls.includes('activate')], [false, false]);
    assert.deepEqual([work.execution?.slot.held, work.cancellation?.state], confirmed ? [false, 'ceased'] : [true, 'stopping'], `stop confirmed=${confirmed}`);
    await h.stop();
  }
});
