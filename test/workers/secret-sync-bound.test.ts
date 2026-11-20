import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { builderBudgetMaximumFactor, builderBudgetV1, qualificationRequestsV1, reviewerBudgetV1 } from '../../src/contracts/index.js';
import { createOwnerSecretReceiver, createSecretPublisher, secretChannelEndCode, secretChannelFailures, secretSyncLimit, secretSyncSetupMargin,
  sessionRequestBudget, type SecretChannelFailure } from '../../src/platform/host/index.js';
import { budgetFor } from '../../src/workers/oauth-qualification.js';

// Ticket 59 (pilot 2: two Builders ended at request 126/127, below their 150): the secret-sync bound follows the session's request budget,
// a value the owner already acknowledged is never re-sent, and a refused sync reaches Control as its own closed cause.
const context = { workId: 'work', executionId: 'exec', invocationId: 'invocation', role: 'builder' as const,
  environmentRef: 'environment', bootRef: 'boot', phaseId: 'phase' };
type End = EventEmitter & { connected: boolean; send(message: Record<string, unknown>, callback: (error: Error | null) => void): boolean };
function channel() {
  const worker = new EventEmitter() as End, owner = new EventEmitter() as End;
  worker.connected = owner.connected = true;
  const toOwner: Record<string, unknown>[] = [];
  worker.send = (message, callback) => { toOwner.push(message); setImmediate(() => { owner.emit('message', structuredClone(message)); callback(null); }); return true; };
  owner.send = (message, callback) => { setImmediate(() => { worker.emit('message', structuredClone(message)); callback(null); }); return true; };
  return { worker, owner, toOwner };
}
function session(maxRequests: number) {
  const { worker, owner, toOwner } = channel();
  const registered: string[] = [], reasons: SecretChannelFailure[] = [];
  const abort = new AbortController();
  createOwnerSecretReceiver(owner, context, abort.signal, () => true, value => { registered.push(value); }, reason => { reasons.push(reason); },
    secretSyncLimit(maxRequests));
  const publisher = createSecretPublisher(worker, context, new AbortController().signal, 1000);
  publisher.protectedStarted();
  return { publisher, toOwner, registered, reasons };
}
const denied = (promise: Promise<unknown>) => assert.rejects(promise, error => {
  assert.deepEqual(error, { code: 'SECRET_SYNC_DENIED' });
  return true;
});

test('the bound is derived from the launch budget: builder-v1, the repository maximum, reviewer-v1 and the qualification', () => {
  assert.equal(secretSyncLimit(builderBudgetV1.requests), builderBudgetV1.requests + secretSyncSetupMargin);
  const builder = { context, modelBudget: 'builder-v1' as const };
  assert.equal(sessionRequestBudget(builder), builderBudgetV1.requests);
  const maximum = builderBudgetV1.requests * builderBudgetMaximumFactor;
  assert.equal(sessionRequestBudget({ ...builder, builderBudget: { requests: maximum, tools: 1, deadlineMs: 60_000 } }), maximum);
  assert.equal(sessionRequestBudget({ context: { ...context, role: 'spec' }, modelBudget: 'reviewer-v1' }), reviewerBudgetV1.requests);
  assert.equal(sessionRequestBudget({ context }), qualificationRequestsV1);
  // Same requests the worker enforces for that policy (`budgetFor`), so the owner never refuses a request the worker's budget allows.
  assert.equal(sessionRequestBudget(builder), budgetFor('builder', 'builder-v1').requests);
  assert.equal(sessionRequestBudget({ context: { ...context, role: 'standards' }, modelBudget: 'reviewer-v1' }), budgetFor('standards', 'reviewer-v1').requests);
  assert.equal(sessionRequestBudget({ context }), budgetFor('builder', undefined).requests);
  for (const invalid of [0, -1, 1.5, Number.NaN]) assert.throws(() => secretSyncLimit(invalid), /WORKER_BUDGET_INVALID/);
});

test('a Builder session with more requests than the old 128 and an unchanged token keeps working on ONE sync', async () => {
  const s = session(builderBudgetV1.requests);
  const token = 'synthetic-access-59';
  for (let request = 1; request <= builderBudgetV1.requests * builderBudgetMaximumFactor; request++) await s.publisher.acknowledgeSecrets([token]);
  assert.equal(s.toOwner.length, 1, 'repeated identical values are never re-sent');
  assert.deepEqual(s.registered, [token]);
  assert.deepEqual(s.reasons, []);
});

test('only new values are sent: a refresh spends one sync, already acknowledged values in it are left out', async () => {
  const s = session(builderBudgetV1.requests);
  await s.publisher.acknowledgeSecrets(['synthetic-access-1', 'synthetic-refresh-1']);
  await s.publisher.acknowledgeSecrets(['synthetic-access-1']);
  await s.publisher.acknowledgeSecrets(['synthetic-access-2', 'synthetic-refresh-1', 'synthetic-access-2']);
  assert.deepEqual(s.toOwner.map(message => message.values), [['synthetic-access-1', 'synthetic-refresh-1'], ['synthetic-access-2']]);
  assert.deepEqual(s.reasons, []);
});

test('a token refresh on EVERY request of the maximum budget stays within the bound; the next new value is refused with reason limit', async () => {
  const maxRequests = builderBudgetV1.requests;
  const s = session(maxRequests);
  const limit = secretSyncLimit(maxRequests);
  for (let sync = 0; sync < limit; sync++) await s.publisher.acknowledgeSecrets([`synthetic-token-${sync}`]);
  assert.equal(s.toOwner.length, limit);
  assert.deepEqual(s.reasons, []);
  await denied(s.publisher.acknowledgeSecrets(['synthetic-token-over']));
  assert.deepEqual(s.reasons, ['limit']);
  assert.ok(!s.registered.includes('synthetic-token-over'), 'a refused sync registers nothing');
  await denied(s.publisher.acknowledgeSecrets(['synthetic-token-0']));
});

test('a known value is never trusted after the channel failed (the scope is rechecked, nothing is sent)', async () => {
  const { worker } = channel();
  const abort = new AbortController();
  const publisher = createSecretPublisher(worker, context, abort.signal, 1000);
  publisher.protectedStarted();
  const sent: Record<string, unknown>[] = [];
  worker.send = (message, callback) => {
    sent.push(message); callback(null);
    setImmediate(() => worker.emit('message', { kind: 'worker-secret-ack', version: 1, id: message.id, context }));
    return true;
  };
  await publisher.acknowledgeSecrets(['synthetic-known']);
  abort.abort();
  await denied(publisher.acknowledgeSecrets(['synthetic-known']));
  assert.equal(sent.length, 1);
});

test('the Execution end names the refused sync; channel loss stays uncertain; never a provider failure', () => {
  assert.equal(secretChannelEndCode('limit'), 'WORKER_SECRET_SYNC_LIMIT');
  assert.equal(secretChannelEndCode('not-started'), 'WORKER_SECRET_SYNC_NOT_STARTED');
  for (const reason of ['disconnect', 'abort', 'closed'] as const) assert.equal(secretChannelEndCode(reason), 'WORKER_EXECUTION_UNCERTAIN');
  // Every reason is a closed code of the worker-result/Control format; the Control classification is in test/control/recovery-rules.
  for (const reason of secretChannelFailures) {
    assert.match(secretChannelEndCode(reason), /^[A-Z_]{1,128}$/);
    assert.notEqual(secretChannelEndCode(reason), 'WORKER_PROVIDER_UNAVAILABLE');
  }
  assert.deepEqual(secretChannelFailures.filter(reason => secretChannelEndCode(reason) !== 'WORKER_EXECUTION_UNCERTAIN').map(secretChannelEndCode),
    ['WORKER_SECRET_SYNC_SCHEMA', 'WORKER_SECRET_SYNC_CONTEXT', 'WORKER_SECRET_SYNC_REPLAY', 'WORKER_SECRET_SYNC_LIMIT', 'WORKER_SECRET_SYNC_BUSY',
      'WORKER_SECRET_SYNC_NOT_STARTED', 'WORKER_SECRET_SYNC_REGISTER', 'WORKER_SECRET_SYNC_TIMEOUT', 'WORKER_SECRET_SYNC_SEND']);
});
