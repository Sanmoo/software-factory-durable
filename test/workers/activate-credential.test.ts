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

async function owner(t: { after(fn: () => Promise<void>): void }, credentialReply: Record<string, string>) {
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
  const server = await listen(join(runtime, 'owner'), { async message(request, channel) {
    received.push(request);
    const reply = (kind: string, payload: Record<string, string>) => channel.send({ protocol_version: protocolVersion, controller_run_id: null,
      message_id: request.message_id, reply_to: request.message_id, kind, payload });
    if (request.kind === 'deliver-credential') await reply('credential-result', credentialReply);
    else await reply('worker-launch-result', { status: 'requested', worker: 'builder-1' });
  } }, { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } });
  t.after(() => server.close());
  return { root, received };
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
