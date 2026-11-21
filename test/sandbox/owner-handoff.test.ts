import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { WorkerBootHost } from '../../src/platform/host/index.js';
import type { BootRef } from '../../src/sandbox/lifecycle.js';

// Real owner registration + Protocol; only the systemd-bound worker spawn (launchWorker) and the VM are doubled.
const actual = await import('../../src/platform/host/index.js');
const delivered: unknown[] = [];
let notify: ((event: Record<string, unknown>) => void) | undefined;
let complete: ((value: unknown) => void) | undefined;
mock.module(new URL('../../src/platform/host/index.js', import.meta.url).href, {
  namedExports: {
    ...actual,
    launchWorker: async (...args: unknown[]) => {
      notify = args[7] as typeof notify;
      return {
        started: Promise.resolve({
          receipt: { workId: 'work-12', id: '99999999-2222-4333-8444-555555555555' },
          invocation: { executionId: 'execution', invocationId: 'x' },
        }),
        completed: new Promise(resolve => {
          complete = resolve;
        }),
        async deliver(directive: unknown) {
          delivered.push(directive);
          return true;
        },
      };
    },
  },
});
const { serveOwnerRegistration } = await import('../../src/sandbox/owner-registration.js');
const { connect, protocolVersion } = await import('../../src/protocol/index.js');

const boot = 'boot-66666666-2222-4333-8444-555555555555' as const;
const environmentRef = `env-${'a'.repeat(64)}`;
const workId = 'work-12';
const profile = {
  id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const,
  systemPrompt: 'p',
  providerId: 'fixture',
  modelId: 'm',
  apiKey: 'synthetic-key',
  provider: {
    api: 'openai-completions' as const,
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [
      {
        id: 'm',
        name: 'm',
        reasoning: false,
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    ],
  },
};
const context = { workId, executionId: 'execution', invocationId: 'builder-1', role: 'builder' as const, environmentRef, bootRef: boot, phaseId: 'phase' };

test('AC3: the owner forwards the suspended Builder handoff to the host-boot channel and delivers a directive only to that launch', async t => {
  const root = await mkdtemp('/tmp/ohand-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(actual.workerRuntimeDirectory(root, boot), { recursive: true, mode: 0o700 });
  const vm = {
    exec() {
      throw new Error('no guest command in this test');
    },
  };
  const server = await serveOwnerRegistration(
    root,
    { workId, environmentRef, bootRef: boot as BootRef },
    vm as never,
    { workId, environmentRef, bootRef: boot } as unknown as WorkerBootHost,
  );
  t.after(() => server.close());
  const channel = await connect(join(actual.workerRuntimeDirectory(root, boot), 'owner'), {
    kind: 'host-boot',
    binding: { workId, environmentRef, bootRef: boot },
  });
  t.after(async () => channel.close());
  const messages = channel.messages[Symbol.asyncIterator]();
  const send = (id: string, kind: string, payload: Record<string, unknown>, replyTo: string | null = null) =>
    channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: replyTo, kind, payload: payload as never });
  await send('l1', 'launch-worker', { context, prompt: '/implement x', profile, knownSecrets: [], handoff: { baseCommit: 'a'.repeat(40) } });
  assert.deepEqual((await messages.next()).value!.payload, { status: 'requested', worker: 'builder-1' });
  assert.equal((await messages.next()).value!.kind, 'worker-started');
  notify!({ round: 1, status: 'failure', code: 'HANDOFF_CAPTURE_FAILED' });
  const handoff = (await messages.next()).value!;
  assert.deepEqual(
    [handoff.kind, handoff.reply_to, handoff.payload],
    ['worker-handoff', 'l1', { round: 1, status: 'failure', code: 'HANDOFF_CAPTURE_FAILED' }],
  );
  const directive = { kind: 'review-results', round: 1, prompt: 'results' };
  await send('d0', 'deliver-directive', { directive }, 'other-launch');
  assert.deepEqual((await messages.next()).value!.payload, { status: 'failure', code: 'DELIVERY_DENIED' }, 'not correlated to this launch');
  await send('d1', 'deliver-directive', { directive: { ...directive, kind: 'shell' } }, 'l1');
  assert.deepEqual((await messages.next()).value!.payload, { status: 'failure', code: 'DELIVERY_DENIED' }, 'only review results');
  await send('d3', 'deliver-directive', { directive: { ...directive, findings: { standards: ['bad id!'], spec: [] } } }, 'l1');
  assert.deepEqual((await messages.next()).value!.payload, { status: 'failure', code: 'DELIVERY_DENIED' }, 'listed finding ids are bounded and well formed');
  const listed = { ...directive, findings: { standards: [], spec: ['S1'] } };
  await send('d2', 'deliver-directive', { directive: listed }, 'l1');
  const result = (await messages.next()).value!;
  assert.deepEqual([result.kind, result.reply_to, result.payload], ['delivery-result', 'd2', { status: 'delivered' }]);
  assert.deepEqual(delivered, [listed], 'ticket 13: the listed finding ids reach the Builder process');
});

test('review fix 8: the owner forwards a reviewer opinion only after redaction with EVERY secret it holds, including the live Builder grant', async t => {
  const root = await mkdtemp('/tmp/ohand-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(actual.workerRuntimeDirectory(root, boot), { recursive: true, mode: 0o700 });
  const server = await serveOwnerRegistration(
    root,
    { workId, environmentRef, bootRef: boot as BootRef },
    {
      exec() {
        throw new Error('none');
      },
    } as never,
    { workId, environmentRef, bootRef: boot } as unknown as WorkerBootHost,
  );
  t.after(() => server.close());
  const connectChannel = async () => {
    const channel = await connect(join(actual.workerRuntimeDirectory(root, boot), 'owner'), {
      kind: 'host-boot',
      binding: { workId, environmentRef, bootRef: boot },
    });
    t.after(async () => channel.close());
    const messages = channel.messages[Symbol.asyncIterator]();
    const send = (id: string, kind: string, payload: Record<string, unknown>) =>
      channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: null, kind, payload: payload as never });
    return { messages, send };
  };
  const token = 'ghs_syntheticLiveBuilderGrant123456';
  const b = await connectChannel();
  await b.send('c1', 'deliver-credential', { context, token });
  assert.deepEqual((await b.messages.next()).value!.payload, { status: 'delivered' });
  const r = await connectChannel();
  const spec = { ...context, invocationId: 'spec-1', role: 'spec' as const };
  await r.send('l2', 'launch-worker', {
    context: spec,
    prompt: 'review',
    profile,
    knownSecrets: [],
    review: { round: 1, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: [], missing: [] },
  });
  assert.deepEqual((await r.messages.next()).value!.payload, { status: 'requested', worker: 'spec-1' });
  assert.equal((await r.messages.next()).value!.kind, 'worker-started');
  complete!({
    status: 'success',
    receipt: { workId, id: '99999999-2222-4333-8444-555555555555' },
    opinion: { role: 'spec', findings: [{ summary: `the guest file had ${token}` }] },
  });
  const completed = (await r.messages.next()).value!;
  assert.equal(completed.kind, 'worker-completed');
  assert.doesNotMatch(JSON.stringify(completed.payload), /ghs_synthetic/);
  assert.match(JSON.stringify(completed.payload), /█/);
});
