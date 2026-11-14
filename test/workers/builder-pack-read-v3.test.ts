import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { createWorkers, builderSkillPacks } from '../../src/workers/index.js';
import { listen, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { workerRuntimeDirectory } from '../../src/platform/host/index.js';
import { loadSkillPack } from '../../src/workers/skill-pack.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';

// Ticket 12 (v3 pack) counterpart of builder-pack-read (ticket 10); real-run q12-review-v3 regression: the Builder could not read its own seeded skill pack (READ_PATH_DENIED) and stopped.
// I-local: native SDK loop, real owner transport/Records/confined guest read program; doubled the VM exec and the provider HTTP.
const context: ToolContext = { workId: 'work-12', executionId: 'execution-12', invocationId: 'builder-12', role: 'builder', environmentRef: 'environment-12', bootRef: 'boot-12', phaseId: 'builder-initial' };
const v3 = '/artifacts/factory/skill-pack/factory-skills-v3/skills/implement/SKILL.md';
const v1 = '/artifacts/factory/skill-pack/factory-skills-v1/skills/implement/SKILL.md';

test('real-run v3 fix: the Builder reads exactly the seeded files of ITS pack version (read-only, confined); another version or path stays denied', { timeout: 15000 }, async t => {
  const pack = await loadSkillPack(builderSkillPacks['factory-skills-v3'].directory, 'factory-skills-v3');
  const files = [`${pack.manifest.guestDirectory}/manifest.json`, ...pack.manifest.files.map(file => `${pack.manifest.guestDirectory}/${file.path}`)];
  const reads: string[] = [];
  const f = await nativeOwner(context, { exec(argv) {
    reads.push(argv[5]!);
    assert.deepEqual([argv[6], JSON.parse(argv[7]!)], ['builder', [v3]], 'guest program gets exactly this path, Builder mode (target must equal path)');
    return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from('# implement v3\n') }; }, result: Promise.resolve({ exitCode: 0 }) };
  } }, { skillPackFiles: files });
  t.after(() => f.close());
  const bodies: string[] = [];
  const steps = [{ name: 'read', arguments: { path: v3 } }, { name: 'read', arguments: { path: v1 } }, { name: 'read', arguments: { path: '/workspace/checkout/README.md' } }];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const step = steps[bodies.length - 1];
    const choices = step ? [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${bodies.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'tool_calls' }] : [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
    const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [choice] }) + '\n\n').join('');
    return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const directory = join(f.root, 'profile'); await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const profile = { id: sdkProfile.id, directory, systemPrompt: 'Builder fixture.', providerId: 'fixture', modelId: 'm', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid', models: [{ id: 'm', name: 'm', reasoning: false, input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }] } };
  const result = await createWorkerSession({ profile, records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) })
    .activate({ context, prompt: 'Implement.', signal: f.authority.signal, skillPack: 'factory-skills-v3' });
  assert.equal(result.status, 'completed');
  assert.match(bodies[0]!, /"name":"read"/, 'the Builder has the read tool for its pack even without copy output');
  assert.match(bodies[1]!, /# implement v3/);
  assert.match(bodies[2]!, /READ_PATH_DENIED/, 'another pack version is not readable');
  assert.match(bodies[3]!, /READ_PATH_DENIED/, 'no general Builder read of the workspace');
  assert.deepEqual(reads, [v3], 'denied paths never reached the guest');
});

test('real-run v3 fix: the Host facade sends the verified pack file list only for a Builder with that pack', async t => {
  const root = await mkdtemp('/tmp/bpack-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const boot = 'boot-77777777-2222-4333-8444-555555555555', environmentRef = `env-${'b'.repeat(64)}`;
  const environment = join(root, 'environments', environmentRef);
  await mkdir(environment, { recursive: true, mode: 0o700 });
  await writeFile(join(environment, 'owner.json'), JSON.stringify({ workId: 'work-12', environment: environmentRef }), { mode: 0o600 });
  await writeFile(join(environment, 'current.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const runtime = workerRuntimeDirectory(root, boot);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'owner.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const received: Envelope[] = [];
  const server = await listen(join(runtime, 'owner'), { async message(request, channel) {
    received.push(request);
    await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: request.message_id, reply_to: request.message_id, kind: 'worker-launch-result',
      payload: { status: 'failure', code: 'WORKER_LAUNCH_INVALID' } });
  } }, { kind: 'host-boot', binding: { workId: 'work-12', environmentRef, bootRef: boot } });
  t.after(() => server.close());
  const oauth = { id: sdkProfile.id, systemPrompt: 'b', auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
  await assert.rejects(createWorkers({ root, profile: oauth, knownSecrets: [] }).activate({ context: { ...context, environmentRef, bootRef: boot }, prompt: 'x',
    signal: new AbortController().signal, skillPack: 'factory-skills-v3' }), /WORKER_LAUNCH_INVALID/);
  const files = received[0]!.payload.skillPackFiles as string[];
  assert.ok(files.includes(v3) && files.includes('/artifacts/factory/skill-pack/factory-skills-v3/manifest.json'));
  assert.ok(files.every(path => path.startsWith('/artifacts/factory/skill-pack/factory-skills-v3/')));
});
