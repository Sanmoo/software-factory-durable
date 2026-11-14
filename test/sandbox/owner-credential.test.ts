import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { WorkerBootHost } from '../../src/platform/host/index.js';
import type { BootRef } from '../../src/sandbox/lifecycle.js';

// Real owner registration + Protocol + Records + tool binding; only the worker spawn (systemd-bound) and the VM are doubled.
const actual = await import('../../src/platform/host/index.js');
const launches: unknown[][] = [];
mock.module(new URL('../../src/platform/host/index.js', import.meta.url).href, { namedExports: { ...actual,
  launchWorker: async (...args: unknown[]) => { launches.push(args); return { started: new Promise(() => {}), completed: new Promise(() => {}) }; } } });
const { serveOwnerRegistration } = await import('../../src/sandbox/owner-registration.js');
const { connect, protocolVersion } = await import('../../src/protocol/index.js');
const { connectReadTools } = await import('../../src/sandbox/read-tools.js');

const boot = 'boot-66666666-2222-4333-8444-555555555555' as const;
const environmentRef = `env-${'a'.repeat(64)}`;
const workId = 'work-09';
const token = 'ghs_syntheticOwnerToken9876543210';
const profile = { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const, systemPrompt: 'p', providerId: 'fixture', modelId: 'm', apiKey: 'synthetic-key',
  provider: { api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'm', name: 'm', reasoning: false, input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] } };
const contextFor = (invocationId: string, role: 'builder' | 'standards' = 'builder') => ({ workId, executionId: 'execution', invocationId, role, environmentRef, bootRef: boot, phaseId: 'phase' });

async function owner(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp('/tmp/ocred-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = actual.workerRuntimeDirectory(root, boot);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const stdin: unknown[] = [];
  const echo = { value: token };
  const vm = { exec(argv: string[], options: { stdin?: unknown }) {
    stdin.push({ argv, stdin: options.stdin });
    const printed = echo.value;
    return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from(`echo ${printed}\n`) }; }, result: Promise.resolve({ exitCode: 0 }) };
  } };
  const host = { workId, environmentRef, bootRef: boot } as unknown as WorkerBootHost;
  const server = await serveOwnerRegistration(root, { workId, environmentRef, bootRef: boot as BootRef }, vm, host);
  t.after(() => server.close());
  const channel = await connect(join(runtime, 'owner'), { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } });
  t.after(async () => channel.close());
  const messages = channel.messages[Symbol.asyncIterator]();
  const request = async (id: string, kind: string, payload: Record<string, unknown>) => {
    await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: null, kind, payload: payload as never });
    return (await messages.next()).value!;
  };
  return { root, runtime, stdin, request, echo };
}

test('AC5: the host handshake delivers the Builder credential before launch; it is registered for filtering and bound only to that invocation', async t => {
  launches.length = 0;
  const o = await owner(t);
  const delivered = await o.request('d1', 'deliver-credential', { context: contextFor('builder-1'), token });
  assert.deepEqual([delivered.kind, delivered.payload], ['credential-result', { status: 'delivered' }]);
  const launched = await o.request('l1', 'launch-worker', { context: contextFor('builder-1'), prompt: '/implement x', profile, knownSecrets: [], copyOutput: false });
  assert.deepEqual(launched.payload, { status: 'requested', worker: 'builder-1' });
  assert.equal(launches.length, 1);
  assert.doesNotMatch(JSON.stringify(launches[0]![1]), /ghs_synthetic/, 'the worker process never receives the token (not in its bootstrap)');
  const tools = await connectReadTools(join(o.runtime, 'b1'), contextFor('builder-1'));
  t.after(async () => tools.close());
  const result = await tools.executeTool({ name: 'bash', command: 'gh issue view 3', callId: 'call-1' }, () => {});
  assert.equal(result.status, 'success');
  assert.deepEqual(o.stdin.map(entry => (entry as { stdin: unknown }).stdin), [`${token}\n`], 'the next Builder command gets the delivered credential');
  assert.ok((o.stdin[0] as { argv: string[] }).argv.every(arg => !arg.includes(token)));
  if (result.status !== 'success') return;
  const { readFile } = await import('node:fs/promises');
  assert.doesNotMatch(await readFile(join(o.root, workId, 'evidence', result.reference.id, 'output'), 'utf8'), /ghs_synthetic/, 'registered before use: guest echo filtered');
});

test('AC5: a credential for a reviewer, a replayed delivery or a mismatched launch is refused without launching', async t => {
  launches.length = 0;
  const o = await owner(t);
  assert.deepEqual((await o.request('d0', 'deliver-credential', { context: contextFor('spec-1', 'standards'), token })).payload,
    { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' }, 'reviewers never receive the Builder environment');
  assert.deepEqual((await o.request('d1', 'deliver-credential', { context: contextFor('builder-1'), token })).payload, { status: 'delivered' });
  assert.deepEqual((await o.request('d2', 'deliver-credential', { context: contextFor('builder-1'), token })).payload,
    { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' }, 'one delivery per channel');
  assert.deepEqual((await o.request('l1', 'launch-worker', { context: contextFor('builder-2'), prompt: 'x', profile, knownSecrets: [] })).payload,
    { status: 'failure', code: 'STALE_TOOL_CONTEXT' }, 'the credential is bound to the invocation it was delivered for');
  assert.equal(launches.length, 0);
});

test('ticket 20 AC2/AC3/AC4: after launch the same channel accepts a renewed credential for ITS invocation (registered before ACK) and a withdrawal', async t => {
  launches.length = 0;
  const o = await owner(t);
  assert.deepEqual((await o.request('d1', 'deliver-credential', { context: contextFor('builder-1'), token })).payload, { status: 'delivered' });
  assert.deepEqual((await o.request('l1', 'launch-worker', { context: contextFor('builder-1'), prompt: '/implement x', profile, knownSecrets: [], copyOutput: false })).payload,
    { status: 'requested', worker: 'builder-1' });
  const tools = await connectReadTools(join(o.runtime, 'b1'), contextFor('builder-1'));
  t.after(async () => tools.close());
  const renewed = 'ghs_syntheticOwnerRenewed1112223334';
  assert.deepEqual((await o.request('r0', 'deliver-credential', { context: contextFor('builder-2'), token: renewed })).payload,
    { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' }, 'a renewal is bound to the launched invocation');
  assert.deepEqual((await o.request('r1', 'deliver-credential', { context: contextFor('builder-1'), token: renewed })).payload, { status: 'delivered' });
  o.echo.value = renewed;
  const result = await tools.executeTool({ name: 'bash', command: 'gh pr list', callId: 'call-2' }, () => {});
  assert.equal(result.status, 'success');
  assert.deepEqual(o.stdin.map(entry => (entry as { stdin: unknown }).stdin), [`${renewed}\n`], 'the next command gets the renewed value');
  if (result.status !== 'success') return;
  const { readFile } = await import('node:fs/promises');
  assert.doesNotMatch(await readFile(join(o.root, workId, 'evidence', result.reference.id, 'output'), 'utf8'), /ghs_synthetic/, 'renewed value registered before use');
  assert.deepEqual((await o.request('w1', 'withdraw-credential', { context: contextFor('builder-1') })).payload, { status: 'withdrawn' });
  await tools.executeTool({ name: 'bash', command: 'true', callId: 'call-3' }, () => {});
  assert.deepEqual((o.stdin[1] as { stdin: unknown }).stdin, '', 'after withdrawal new commands receive no credential');
  assert.deepEqual((await o.request('r2', 'deliver-credential', { context: contextFor('builder-1'), token: renewed })).payload,
    { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' }, 'withdrawal is final for this activity: no later delivery');
});

test('ticket 20 AC3: a launched reviewer channel never accepts a credential, not even as a renewal', async t => {
  launches.length = 0;
  const o = await owner(t);
  assert.deepEqual((await o.request('l1', 'launch-worker', { context: contextFor('spec-1', 'standards'), prompt: 'review', profile, knownSecrets: [] })).payload,
    { status: 'requested', worker: 'spec-1' });
  assert.deepEqual((await o.request('r1', 'deliver-credential', { context: contextFor('spec-1', 'standards'), token })).payload,
    { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' });
  assert.deepEqual((await o.request('r2', 'deliver-credential', { context: contextFor('spec-1'), token })).payload,
    { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' }, 'a builder claim on a reviewer channel is refused too');
});

test('review 8: a delivery without a usable value is answered with an explicit failure', async t => {
  const o = await owner(t);
  assert.deepEqual((await o.request('e1', 'deliver-credential', { context: contextFor('builder-1'), token: '' })).payload, { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' });
  assert.deepEqual((await o.request('e2', 'withdraw-credential', { context: contextFor('builder-1') })).payload, { status: 'failure', code: 'CREDENTIAL_WITHDRAWAL_DENIED' },
    'nothing to withdraw before any delivery');
});
