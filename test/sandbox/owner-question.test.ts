import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { WorkerBootHost } from '../../src/platform/host/index.js';
import type { BootRef } from '../../src/sandbox/lifecycle.js';

// Real owner registration + Protocol; only the systemd-bound worker spawn (launchWorker) and the VM are doubled.
const actual = await import('../../src/platform/host/index.js');
const relays: { question(question: unknown): Promise<unknown> }[] = [];
mock.module(new URL('../../src/platform/host/index.js', import.meta.url).href, { namedExports: { ...actual,
  launchWorker: async (...args: unknown[]) => { relays.push(args[6] as never); return { started: new Promise(() => {}), completed: new Promise(() => {}) }; } } });
const { serveOwnerRegistration } = await import('../../src/sandbox/owner-registration.js');
const { connect, protocolVersion } = await import('../../src/protocol/index.js');

const boot = 'boot-66666666-2222-4333-8444-555555555555' as const;
const environmentRef = `env-${'a'.repeat(64)}`;
const workId = 'work-10';
const profile = { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const, systemPrompt: 'p', providerId: 'fixture', modelId: 'm', apiKey: 'synthetic-key',
  provider: { api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'm', name: 'm', reasoning: false, input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] } };
const context = { workId, executionId: 'execution', invocationId: 'builder-1', role: 'builder', environmentRef, bootRef: boot, phaseId: 'phase' };
const question = { questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000003', question: 'Q?', context: '', sha256: 'b'.repeat(64), reference: { workId, id: '77777777-2222-4333-8444-555555555555' } };

test('AC1: the owner relays the worker question on the SAME host-boot channel and resolves only with the Control ACK; channel loss rejects', async t => {
  relays.length = 0;
  const root = await mkdtemp('/tmp/oq-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(actual.workerRuntimeDirectory(root, boot), { recursive: true, mode: 0o700 });
  const vm = { exec() { return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) }; } };
  const server = await serveOwnerRegistration(root, { workId, environmentRef, bootRef: boot as BootRef }, vm, { workId, environmentRef, bootRef: boot } as unknown as WorkerBootHost);
  t.after(() => server.close());
  const channel = await connect(join(actual.workerRuntimeDirectory(root, boot), 'owner'), { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } });
  const messages = channel.messages[Symbol.asyncIterator]();
  await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'l1', reply_to: null, kind: 'launch-worker',
    payload: { context, prompt: '/implement x', profile, knownSecrets: [] } });
  assert.equal((await messages.next()).value!.kind, 'worker-launch-result');
  const relayed = relays[0]!.question(question);
  const frame = (await messages.next()).value!;
  assert.deepEqual([frame.kind, frame.message_id, frame.reply_to], ['worker-question', question.questionId, 'l1']);
  assert.deepEqual(frame.payload, { context, question });
  // An ACK for another question or with an invalid payload is ignored; the matching ACK resolves.
  await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'a0', reply_to: 'other', kind: 'question-ack', payload: { status: 'recorded' } });
  await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'a1', reply_to: question.questionId, kind: 'question-ack', payload: { status: 'recorded' } });
  assert.deepEqual(await relayed, { status: 'recorded' });
  const second = relays[0]!.question({ ...question, questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000004' });
  await messages.next();
  channel.close();
  await assert.rejects(second, /QUESTION_RELAY_CLOSED/);
});
