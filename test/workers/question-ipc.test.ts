import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createOwnerSecretReceiver, createQuestionSender, createSecretPublisher, secretSyncLimit, serveQuestionRelay } from '../../src/platform/host/index.js';

// Protocol level: the private ask_user seam over a fake child channel (two linked emitters). No process, SDK or Control.
const context = { workId: 'w', executionId: 'e', invocationId: 'i', role: 'builder' as const, environmentRef: 'env', bootRef: 'boot', phaseId: 'p' };
const question = { questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000001', question: 'Which file?', context: '', sha256: 'a'.repeat(64),
  reference: { workId: 'w', id: '77777777-2222-4333-8444-555555555555' } };
function pair() {
  const worker = new EventEmitter() as EventEmitter & { connected: boolean; send(message: Record<string, unknown>, callback: (error: Error | null) => void): boolean };
  const owner = new EventEmitter() as typeof worker;
  worker.connected = owner.connected = true;
  worker.send = (message, callback) => { setImmediate(() => { owner.emit('message', structuredClone(message)); callback(null); }); return true; };
  owner.send = (message, callback) => { setImmediate(() => { worker.emit('message', structuredClone(message)); callback(null); }); return true; };
  return { worker, owner };
}

test('AC1: the owner relays one request of THIS started invocation and returns the Control ACK; a second ask is refused', async () => {
  const { worker, owner } = pair();
  const received: unknown[] = [];
  serveQuestionRelay(owner, context, new AbortController().signal, () => true, async request => { received.push(request); return { status: 'recorded' }; });
  const sender = createQuestionSender(worker, context, new AbortController().signal, 1000);
  assert.deepEqual(await sender.ask(question), { status: 'recorded' });
  assert.deepEqual(received, [question]);
  assert.deepEqual(await sender.ask({ ...question, questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000002' }), { status: 'unacknowledged' }, 'one notification per activation');
});

test('AC5: silence or channel loss is UNACKNOWLEDGED, never recorded; a refusal carries its code; before the start the owner refuses', async () => {
  const silent = pair();
  serveQuestionRelay(silent.owner, context, new AbortController().signal, () => true, () => new Promise(() => {}));
  assert.deepEqual(await createQuestionSender(silent.worker, context, new AbortController().signal, 50).ask(question), { status: 'unacknowledged' });
  const lost = pair();
  const pending = createQuestionSender(lost.worker, context, new AbortController().signal, 5000).ask(question);
  lost.worker.connected = false; lost.worker.emit('disconnect');
  assert.deepEqual(await pending, { status: 'unacknowledged' });
  const refused = pair();
  serveQuestionRelay(refused.owner, context, new AbortController().signal, () => true, async () => ({ status: 'refused', code: 'STALE_EXECUTION' }));
  assert.deepEqual(await createQuestionSender(refused.worker, context, new AbortController().signal, 1000).ask(question), { status: 'refused', code: 'STALE_EXECUTION' });
  const early = pair();
  let called = false;
  serveQuestionRelay(early.owner, context, new AbortController().signal, () => false, async () => { called = true; return { status: 'recorded' }; });
  assert.deepEqual(await createQuestionSender(early.worker, context, new AbortController().signal, 1000).ask(question), { status: 'refused', code: 'QUESTION_CONTEXT_INVALID' });
  assert.equal(called, false);
  const reviewer = pair();
  assert.deepEqual(await createQuestionSender(reviewer.worker, { ...context, role: 'spec' }, new AbortController().signal, 1000).ask(question), { status: 'unacknowledged' }, 'reviewers never ask');
});

test('the secret seams on the same channel ignore question messages instead of revoking the invocation', async () => {
  const { worker, owner } = pair();
  let ownerRevoked = false, workerRevoked = false;
  createOwnerSecretReceiver(owner, context, new AbortController().signal, () => true, () => {}, () => { ownerRevoked = true; }, secretSyncLimit(150));
  const publisher = createSecretPublisher(worker, context, new AbortController().signal, 1000, () => { workerRevoked = true; });
  publisher.protectedStarted();
  serveQuestionRelay(owner, context, new AbortController().signal, () => true, async () => ({ status: 'recorded' }));
  assert.deepEqual(await createQuestionSender(worker, context, new AbortController().signal, 1000).ask(question), { status: 'recorded' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([ownerRevoked, workerRevoked], [false, false]);
});
