import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkers } from '../../src/workers/index.js';
import { listen, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { workerRuntimeDirectory } from '../../src/platform/host/index.js';

// Real Workers facade + Protocol against a scripted owner endpoint (the real owner side is covered by test/sandbox/owner-credential).
const boot = 'boot-77777777-2222-4333-8444-555555555555';
const environmentRef = `env-${'b'.repeat(64)}`;
const workId = 'work-09';
const token = 'ghs_syntheticFacadeToken000111222';
const profile = { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const, systemPrompt: 'p', auth: 'factory-oauth' as const, providerId: 'openai' as const,
  modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };

async function owner(t: { after(fn: () => Promise<void>): void }, credentialReply: Record<string, string>, startedInvocation?: Record<string, string>) {
  const root = await mkdtemp('/tmp/acred-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environments', environmentRef);
  await mkdir(environment, { recursive: true, mode: 0o700 });
  await writeFile(join(environment, 'owner.json'), JSON.stringify({ workId, environment: environmentRef }), { mode: 0o600 });
  await writeFile(join(environment, 'current.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const runtime = workerRuntimeDirectory(root, boot);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'owner.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const received: Envelope[] = [];
  const launched: { send?: (kind: string, payload: Record<string, unknown>) => Promise<void> } = {};
  const server = await listen(join(runtime, 'owner'), { async message(request, channel) {
    received.push(request);
    const reply = (kind: string, payload: Record<string, string>) => channel.send({ protocol_version: protocolVersion, controller_run_id: null,
      message_id: request.message_id, reply_to: request.message_id, kind, payload });
    if (request.kind === 'deliver-credential') await reply('credential-result', credentialReply);
    else if (request.kind === 'withdraw-credential') await reply('credential-result', { status: 'withdrawn' });
    else {
      launched.send = (kind, payload) => channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: request.message_id,
        reply_to: request.message_id, kind, payload: payload as never });
      await reply('worker-launch-result', { status: 'requested', worker: (request.payload.context as Record<string, string>).invocationId! });
      if (startedInvocation) await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: request.message_id, reply_to: request.message_id,
        kind: 'worker-started', payload: { receipt: { workId, id: '99999999-2222-4333-8444-555555555555' }, invocation: startedInvocation } });
    }
  } }, { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } });
  t.after(() => server.close());
  return { root, received, launched };
}
const invocation = (role: 'builder' | 'spec' = 'builder') => ({ context: { workId, executionId: 'execution', invocationId: 'builder-1', role, environmentRef, bootRef: boot, phaseId: 'phase' },
  prompt: '/implement https://github.com/acme/project/issues/3', signal: new AbortController().signal,
  ...(role === 'builder' ? { skillPack: 'factory-skills-v1' as const, modelBudget: 'builder-v1' as const, copyOutput: true } : {}) });

test('AC5: activate delivers the credential in the host handshake BEFORE the launch, and never inside the launch payload', async t => {
  const o = await owner(t, { status: 'delivered' });
  const handle = await createWorkers({ root: o.root, profile, knownSecrets: [] }).activate(invocation(), { credential: { token } });
  handle.close();
  assert.deepEqual(o.received.map(message => message.kind), ['deliver-credential', 'launch-worker']);
  assert.equal(o.received[0]!.payload.token, token);
  assert.doesNotMatch(JSON.stringify(o.received[1]!.payload), /ghs_synthetic/);
  assert.equal(o.received[1]!.payload.skillPack, 'factory-skills-v1');
  assert.equal(o.received[1]!.payload.modelBudget, 'builder-v1');
  assert.doesNotMatch(JSON.stringify(invocation()), /ghs_synthetic/, 'the invocation (serializable) never carries the credential');
});

test('AC5: a refused delivery stops before any launch; a reviewer cannot be given the Builder credential', async t => {
  const o = await owner(t, { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' });
  const workers = createWorkers({ root: o.root, profile, knownSecrets: [] });
  await assert.rejects(workers.activate(invocation(), { credential: { token } }), /CREDENTIAL_DELIVERY_FAILED/);
  assert.deepEqual(o.received.map(message => message.kind), ['deliver-credential']);
  await assert.rejects(workers.activate({ ...invocation('spec'), context: { ...invocation('spec').context, invocationId: 'spec-1' } }, { credential: { token } }), /WORKER_LAUNCH_INVALID/);
  assert.equal(o.received.length, 1);
});

test('review 8: the start observation must name THIS Execution/invocation; another one is uncertain, never a start', async t => {
  const good = await owner(t, { status: 'delivered' }, { executionId: 'execution', invocationId: 'builder-1' });
  const handle = await createWorkers({ root: good.root, profile, knownSecrets: [] }).activate(invocation(), { credential: { token } });
  assert.deepEqual(await handle.started, { receipt: { workId, id: '99999999-2222-4333-8444-555555555555' }, invocation: { executionId: 'execution', invocationId: 'builder-1' } });
  handle.close();
  const bad = await owner(t, { status: 'delivered' }, { executionId: 'execution', invocationId: 'builder-2' });
  const other = await createWorkers({ root: bad.root, profile, knownSecrets: [] }).activate(invocation(), { credential: { token } });
  await assert.rejects(other.started, /WORKER_EXECUTION_UNCERTAIN/);
  other.close();
});

test('ticket 20 AC2: Workers.deliver hands a renewed credential to the RUNNING Builder over its host channel; start/completion frames stay intact', async t => {
  const o = await owner(t, { status: 'delivered' });
  const workers = createWorkers({ root: o.root, profile, knownSecrets: [] });
  const handle = await workers.activate(invocation(), { credential: { token } });
  const renewed = 'ghs_syntheticFacadeRenewal333444555';
  // The renewal reply and the worker's start frame can interleave on the channel; each reaches its own waiter.
  const delivery = workers.deliver(handle.worker, { kind: 'credential', credential: { token: renewed } });
  await o.launched.send!('worker-started', { receipt: { workId, id: '99999999-2222-4333-8444-555555555555' }, invocation: { executionId: 'execution', invocationId: 'builder-1' } });
  assert.deepEqual(await delivery, { status: 'delivered' });
  assert.equal((await handle.started).invocation.invocationId, 'builder-1');
  assert.deepEqual(o.received.map(message => message.kind), ['deliver-credential', 'launch-worker', 'deliver-credential']);
  assert.equal(o.received[2]!.payload.token, renewed);
  assert.equal((o.received[2]!.payload.context as Record<string, string>).invocationId, 'builder-1');
  assert.deepEqual(await workers.deliver(handle.worker, { kind: 'withdraw-credential' }), { status: 'withdrawn' });
  assert.equal(o.received[3]!.kind, 'withdraw-credential');
  assert.doesNotMatch(JSON.stringify(o.received[3]!.payload), /ghs_synthetic/);
  await o.launched.send!('worker-completed', { status: 'success', receipt: { workId, id: '99999999-2222-4333-8444-555555555555' } });
  assert.equal((await handle.completed).status, 'success');
  handle.close();
  assert.deepEqual(await workers.deliver(handle.worker, { kind: 'credential', credential: { token: renewed } }), { status: 'failure', code: 'WORKER_NOT_CURRENT' },
    'no delivery to a closed worker');
  assert.equal(o.received.length, 4);
});

test('ticket 20 AC3: Workers.deliver never sends a credential to a reviewer or an unknown worker', async t => {
  const o = await owner(t, { status: 'delivered' });
  const workers = createWorkers({ root: o.root, profile, knownSecrets: [] });
  const reviewer = await workers.activate({ ...invocation('spec'), context: { ...invocation('spec').context, invocationId: 'spec-1' } });
  assert.deepEqual(await workers.deliver(reviewer.worker, { kind: 'credential', credential: { token } }), { status: 'failure', code: 'CREDENTIAL_ROLE_DENIED' });
  assert.deepEqual(await workers.deliver('builder-unknown', { kind: 'credential', credential: { token } }), { status: 'failure', code: 'WORKER_NOT_CURRENT' });
  assert.ok(o.received.every(message => message.kind !== 'deliver-credential'), 'nothing secret was sent');
  reviewer.close();
});
