import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelReport } from '../../src/contracts/index.js';
import { channelUnrecoverableImpediment, failureCodeAfter, indeterminateEffectsLimit, mergeEffects } from '../../src/control/rules/channel-report.js';

// v2 ticket 11 (V2-21), pure rules: what Control keeps of a sandbox's channel report.
const effect = (callId: string): ChannelReport['indeterminateEffects'][number] =>
  ({ at: '2026-11-21T10:00:00.000Z', executionId: 'as-the-sandbox-said', invocationId: 'i-1', role: 'builder', tool: 'bash', callId, description: 'mvn deploy', outcome: 'orphan-ended' });
const context = { executionId: 'execution-1', boot: 'boot-1', recordedAt: '2026-11-21T10:05:00.000Z' };

test('effects are recorded once per call and boot, under the Execution Control read the report for', () => {
  const first = mergeEffects([], { indeterminateEffects: [effect('a')], unrecoverable: null }, context);
  assert.deepEqual(first, [{ ...effect('a'), executionId: 'execution-1', boot: 'boot-1', recordedAt: '2026-11-21T10:05:00.000Z' }]);
  const again = mergeEffects(first, { indeterminateEffects: [effect('a'), effect('b')], unrecoverable: null }, { ...context, recordedAt: '2026-11-21T10:09:00.000Z' });
  assert.deepEqual(again.map(item => [item.callId, item.recordedAt]), [['a', '2026-11-21T10:05:00.000Z'], ['b', '2026-11-21T10:09:00.000Z']]);
  // The same call id on another boot of the Execution is another call.
  assert.equal(mergeEffects(again, { indeterminateEffects: [effect('a')], unrecoverable: null }, { ...context, boot: 'boot-2' }).length, 3);
});

test('the record is bounded and keeps the earliest effects', () => {
  const many = { indeterminateEffects: Array.from({ length: indeterminateEffectsLimit + 5 }, (_, index) => effect(`call-${index}`)), unrecoverable: null };
  const merged = mergeEffects([], many, context);
  assert.equal(merged.length, 64);
  assert.deepEqual([merged[0]!.callId, merged.at(-1)!.callId], ['call-0', 'call-63']);
});

test('only a channel that reached its reconnection limit renames a failure and blocks the Work', () => {
  const unrecoverable = { at: '2026-11-21T10:01:00.000Z', attempts: 5 };
  assert.equal(failureCodeAfter('WORKER_INTERRUPTED', null), 'WORKER_INTERRUPTED');
  assert.equal(failureCodeAfter('WORKER_INTERRUPTED', { indeterminateEffects: [effect('a')], unrecoverable: null }), 'WORKER_INTERRUPTED');
  assert.equal(failureCodeAfter('WORKER_INTERRUPTED', { indeterminateEffects: [], unrecoverable }), 'SANDBOX_CHANNEL_UNRECOVERABLE');
  const impediment = channelUnrecoverableImpediment(unrecoverable, { workId: 'work-1', boot: 'boot-1', effects: 2 });
  assert.deepEqual([impediment.code, impediment.scope, impediment.since], ['SANDBOX_CHANNEL_UNRECOVERABLE', 'work', '2026-11-21T10:01:00.000Z']);
  assert.match(impediment.nextStep, /boot-1.*5 attempts.*2 tool call\(s\).*may have happened.*Nothing is retried automatically.*factory cancel work-1/s);
  assert.match(channelUnrecoverableImpediment(unrecoverable, { workId: 'work-1', boot: 'boot-1', effects: 0 }).nextStep, /No started tool call was left without a result/);
});
