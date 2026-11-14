import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkers } from '../../src/workers/index.js';
import { listen, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { workerRuntimeDirectory } from '../../src/platform/host/index.js';

// Real Workers facade + Protocol against a scripted owner endpoint (the real owner relay is covered by test/sandbox/owner-question).
const boot = 'boot-77777777-2222-4333-8444-555555555555';
const environmentRef = `env-${'b'.repeat(64)}`;
const workId = 'work-10';
const profile = { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const, systemPrompt: 'p', auth: 'factory-oauth' as const, providerId: 'openai' as const,
  modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const context = { workId, executionId: 'execution', invocationId: 'builder-1', role: 'builder' as const, environmentRef, bootRef: boot, phaseId: 'phase' };
const receipt = { workId, id: '99999999-2222-4333-8444-555555555555' };
const question = { questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000005', question: 'Q?', context: '', sha256: 'c'.repeat(64), reference: { workId, id: '77777777-2222-4333-8444-555555555555' } };

async function owner(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp('/tmp/aq-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environments', environmentRef);
  await mkdir(environment, { recursive: true, mode: 0o700 });
  await writeFile(join(environment, 'owner.json'), JSON.stringify({ workId, environment: environmentRef }), { mode: 0o600 });
  await writeFile(join(environment, 'current.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const runtime = workerRuntimeDirectory(root, boot);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'owner.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const received: Envelope[] = [];
  let ackSeen!: (envelope: Envelope) => void;
  const ack = new Promise<Envelope>(resolve => { ackSeen = resolve; });
  const server = await listen(join(runtime, 'owner'), { async message(request, channel) {
    received.push(request);
    const send = (kind: string, payload: Record<string, unknown>, id = request.message_id) => channel.send({ protocol_version: protocolVersion, controller_run_id: null,
      message_id: id, reply_to: 'l1', kind, payload: payload as never });
    if (request.kind === 'launch-worker') {
      await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: request.message_id, reply_to: request.message_id, kind: 'worker-launch-result', payload: { status: 'requested', worker: 'builder-1' } });
      const launch = request.message_id;
      const frame = (kind: string, payload: Record<string, unknown>, id = launch) => channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: launch, kind, payload: payload as never });
      void send;
      // Not awaited inside the handler: the owner endpoint processes this connection's frames in order (the ACK arrives later).
      void (async () => {
        await frame('worker-started', { receipt, invocation: { executionId: 'execution', invocationId: 'builder-1' } });
        await frame('worker-question', { context, question }, question.questionId);
        const reply = await ack;
        await frame('worker-completed', { status: 'question', receipt, question: { ...question, acknowledged: reply.payload.status === 'recorded' } });
      })();
    } else if (request.kind === 'question-ack') ackSeen(request);
  } }, { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } });
  t.after(() => server.close());
  return { root, received, ack };
}
const invocation = () => ({ context, prompt: '/implement https://github.com/acme/project/issues/3', signal: new AbortController().signal, skillPack: 'factory-skills-v1' as const, modelBudget: 'builder-v1' as const });

test('AC1: the facade hands the worker question to the Control handler and sends ITS answer as the ACK, then reports the question completion', async t => {
  const o = await owner(t);
  const seen: unknown[] = [];
  const handle = await createWorkers({ root: o.root, profile, knownSecrets: [] }).activate(invocation(), undefined, { async question(request) { seen.push(request); return { status: 'recorded' }; } });
  await handle.started;
  assert.deepEqual(await handle.completed, { status: 'question', receipt, question: { ...question, acknowledged: true } });
  assert.deepEqual(seen, [question]);
  const ack = await o.ack;
  assert.deepEqual([ack.reply_to, ack.payload], [question.questionId, { status: 'recorded' }]);
  handle.close();
});

test('AC5: without a confirmed commit there is NO recorded ACK (handler failure => no ACK; no handler => refused)', async t => {
  const o = await owner(t);
  const handle = await createWorkers({ root: o.root, profile, knownSecrets: [] }).activate(invocation());
  assert.deepEqual((await o.ack).payload, { status: 'refused', code: 'QUESTIONS_NOT_ENABLED' });
  assert.equal((await handle.completed).status, 'question');
  handle.close();
});

test('real-run fix: the launch payload carries the exact seeded file list of the Execution\'s pack version (Host-derived), v2 or v1', async t => {
  const { skillPackGuestFiles } = await import('../../src/workers/skill-pack.js');
  for (const pack of ['factory-skills-v2', 'factory-skills-v1'] as const) {
    const o = await owner(t);
    const handle = await createWorkers({ root: o.root, profile, knownSecrets: [] }).activate({ ...invocation(), skillPack: pack }, undefined, { async question() { return { status: 'recorded' }; } });
    await handle.completed.catch(() => {});
    handle.close();
    const launch = o.received.find(message => message.kind === 'launch-worker')!;
    assert.deepEqual(launch.payload.skillPackFiles, await skillPackGuestFiles(pack));
    assert.ok((launch.payload.skillPackFiles as string[]).includes(`/artifacts/factory/skill-pack/${pack}/skills/implement/SKILL.md`));
  }
});
