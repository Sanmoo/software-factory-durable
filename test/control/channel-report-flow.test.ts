import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilHolds } from '../runner/budget.js';
import type { ChannelReport, SandboxCapabilities } from '../../src/contracts/index.js';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { recoveryDoubles, type RecoveryScript } from './recovery-doubles.js';

// v2 ticket 11 flow level (V2-21): real Control + Pi Durable/SQLite + Records; doubled: GitHub, a TEST sandbox that declares capabilities
// and answers a channel report (file-backed host of the recovery doubles), the Builder and credentials. Not evidence of any real sandbox.
// The double prepares a host checkout, so it declares the disk it has: `channelRecovery` is independent of it, and a sandbox that
// declares no persistent disk owes Control the preservation gate (v2 ticket 07), which is not this test's subject.
const base: SandboxCapabilities = { docker: true, persistentDisk: true, bootDuration: null, egress: { mediation: 'none', publicTcp: true, udp: false, ipv6: false, privateNetwork: false } };
const effect = (callId: string, outcome: ChannelReport['indeterminateEffects'][number]['outcome'], description = 'mvn deploy') =>
  ({ at: '2026-11-21T10:00:00.000Z', executionId: 'reported-by-the-sandbox', invocationId: 'invocation-1', role: 'builder', tool: 'bash' as const, callId, description, outcome });

async function harness(t: { after(fn: () => Promise<void>): void }, scripts: RecoveryScript[], capabilities: SandboxCapabilities, report: () => ChannelReport) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-channel-report-flow-'));
  const world: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(world);
  const doubles = recoveryDoubles(dir, scripts);
  const time = manualClock();
  const asked: { environment: string; boot: string }[] = [];
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty',
    execution: { ...doubles.ports, sandbox: { ...doubles.ports.sandbox, capabilities, channelReport: async input => { asked.push(input); return report(); } } },
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; await rm(dir, { recursive: true, force: true }); });
  await time.sleeping();
  const work = async () => (((await control.inspect({ kind: 'list' })) as ListView).works as WorkView[]).find(item => item.ticket.number === 3)!;
  const until = (predicate: () => Promise<boolean> | boolean, label: string) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  return { doubles, work, until, asked, time };
}

test('V2-21: Control records the indeterminate effects the sandbox reports for the boot, on the Execution they happened in, and keeps them after its end', async t => {
  const report: ChannelReport = { indeterminateEffects: [effect('call-1', 'orphan-ended'), effect('call-2', 'orphan-ended', 'create /workspace/checkout/a.txt')], unrecoverable: null };
  const h = await harness(t, [{ kind: 'complete' }], { ...base, channelRecovery: true }, () => report);
  await h.until(async () => (await h.work())?.execution?.dispatch.phase === 'stopped', 'execution ended and its boot stopped');
  const work = await h.work();
  const execution = work.execution!;
  assert.deepEqual(execution.indeterminateEffects?.map(item => [item.callId, item.tool, item.description, item.outcome, item.boot]), [
    ['call-1', 'bash', 'mvn deploy', 'orphan-ended', execution.dispatch.boot], ['call-2', 'bash', 'create /workspace/checkout/a.txt', 'orphan-ended', execution.dispatch.boot]]);
  assert.deepEqual(h.asked.at(-1), { environment: execution.dispatch.environment, boot: execution.dispatch.boot });
  // An indeterminate result the session survived is not a failure of the Execution, and blocks nothing.
  assert.deepEqual([execution.end?.outcome, execution.end?.code], ['completed', null]);
  assert.deepEqual(work.impediments.filter(item => item.code === 'SANDBOX_CHANNEL_UNRECOVERABLE'), []);
});

test('V2-21: reconnection that reached its limit ends the Execution as a visible impediment of the Work; nothing is retried automatically', async t => {
  const report: ChannelReport = { indeterminateEffects: [effect('call-9', 'channel-unrecoverable')], unrecoverable: { at: '2026-11-21T10:01:00.000Z', attempts: 5 } };
  const h = await harness(t, [{ kind: 'fail', code: 'WORKER_INTERRUPTED' }, { kind: 'complete' }], { ...base, channelRecovery: true }, () => report);
  await h.until(async () => (await h.work())?.execution?.dispatch.phase === 'stopped', 'execution ended and its boot stopped');
  const work = await h.work();
  assert.deepEqual([work.execution!.end?.outcome, work.execution!.end?.code], ['failure', 'SANDBOX_CHANNEL_UNRECOVERABLE']);
  const impediment = work.impediments.find(item => item.code === 'SANDBOX_CHANNEL_UNRECOVERABLE');
  assert.ok(impediment, JSON.stringify(work.impediments));
  assert.equal(impediment.scope, 'work');
  assert.match(impediment.nextStep, /5 attempts/);
  assert.match(impediment.nextStep, /may still be running|may have happened/);
  assert.deepEqual(work.execution!.indeterminateEffects?.map(item => [item.callId, item.outcome]), [['call-9', 'channel-unrecoverable']]);
  // No loop: no operational recovery is opened for it and no second Execution starts.
  assert.equal(work.pendingRecovery ?? null, null);
  for (let round = 0; round < 3; round += 1) { h.time.advance(); await h.time.sleeping(); }
  const later = await h.work();
  assert.equal(h.doubles.calls('start').length, 1);
  assert.equal(later.execution!.executionId, work.execution!.executionId);
  assert.ok(later.impediments.some(item => item.code === 'SANDBOX_CHANNEL_UNRECOVERABLE'));
});

test('a sandbox that does not declare channel recovery is never asked for a report (the MVP behaviour is unchanged)', async t => {
  const h = await harness(t, [{ kind: 'complete' }], base, () => { throw new Error('never asked'); });
  await h.until(async () => (await h.work())?.execution?.dispatch.phase === 'stopped', 'execution ended and its boot stopped');
  assert.deepEqual(h.asked, []);
  assert.equal((await h.work()).execution!.indeterminateEffects, undefined);
});
