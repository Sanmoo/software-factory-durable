import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { skillPackGuestFiles, skillPacks } from '../../src/workers/skill-pack.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';

// I-local: real Pi SDK session + real owner Read binding/Records/Protocol; only the provider HTTP boundary and the VM are doubled. The VM
// double reproduces the guest program's own Builder rule (exact path in the Host-selected list, no symlink resolution difference) and serves
// the real seeded pack bytes. Real-run finding (q10 ask v1): the Builder could not read /artifacts/.../factory-skills-v2/.../SKILL.md.
const context: ToolContext = { workId: 'work-pack', executionId: 'exec-pack', invocationId: 'builder-pack', role: 'builder', environmentRef: 'env-pack', bootRef: 'boot-pack', phaseId: 'p' };
type Id = keyof typeof skillPacks;

async function run(t: { after(fn: () => Promise<void>): void }, pack: Id, paths: string[]) {
  const guestCalls: string[] = [];
  const files = await skillPackGuestFiles(pack);
  const f = await nativeOwner(context, { exec(argv) {
    const [path, role, selected] = [argv[5]!, argv[6], JSON.parse(argv[7] ?? '[]') as string[]];
    guestCalls.push(path);
    const allowed = role === 'builder' && selected.includes(path);
    const local = Object.values(skillPacks).find(entry => path.startsWith(`${entry.guestDirectory}/`));
    return { async *output() { if (allowed && local) yield { stream: 'stdout' as const, data: await readFile(join(local.directory, path.slice(local.guestDirectory.length + 1))) }; },
      result: Promise.resolve({ exitCode: allowed && local ? 0 : 1 }) };
  } }, { skillPackFiles: files });
  t.after(() => f.close());
  const directory = join(f.root, 'profile');
  await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const bodies: string[] = [];
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body); bodies.push(body);
    const call = paths[requests++];
    const choices = call ? [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `read-${requests}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: call }) } }] }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'tool_calls' }] : [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
    return new Response(choices.map(choice => 'data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [choice] }) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(async () => { globalThis.fetch = originalFetch; });
  const session = createWorkerSession({ profile: { id: sdkProfile.id, directory, systemPrompt: 'Builder pack read fixture.', providerId: 'fixture', modelId: 'm', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [{ id: 'm', name: 'm', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }] } }, records: f.records,
  sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) });
  // No copyOutput: the pack is the ONLY Builder Read authority here.
  const result = await session.activate({ context, prompt: 'Read the skill.', signal: f.authority.signal, skillPack: pack });
  return { result, bodies, guestCalls, files };
}

test('real-run fix: a v2 Builder reads exactly its seeded v2 pack files (SKILL.md with section 4); other /artifacts paths stay denied', async t => {
  const v2 = '/artifacts/factory/skill-pack/factory-skills-v2/skills/implement/SKILL.md';
  const { result, bodies, guestCalls, files } = await run(t, 'factory-skills-v2', [v2, '/artifacts/factory/skill-pack/factory-skills-v1/skills/implement/SKILL.md', '/artifacts/spec/v1/ticket.json']);
  assert.equal(result.status, 'completed');
  assert.ok(files.includes(v2) && files.every(path => path.startsWith('/artifacts/factory/skill-pack/factory-skills-v2/')));
  assert.match(bodies[1]!, /## 4\. Resume after an answer/, 'the v2 SKILL.md reached the model');
  assert.match(bodies[2]!, /READ_PATH_DENIED/, 'a v2 Execution cannot read the v1 pack');
  assert.match(bodies[3]!, /READ_PATH_DENIED/, 'nothing else under /artifacts becomes readable');
  assert.deepEqual(guestCalls, [v2], 'denied paths never reach the guest');
  for (const path of ['prompts/implement.md', 'prompts/pr.md', 'skills/implement/SKILL.md']) {
    for (const line of (await readFile(join(skillPacks['factory-skills-v2'].directory, path), 'utf8')).match(/\/artifacts\/factory\/skill-pack\/[^\s`)]+/g) ?? []) {
      const referenced = line.replace(/[.,;:]$/, '');
      assert.ok(referenced.endsWith('/') ? files.some(file => file.startsWith(referenced)) : files.includes(referenced), `${path} references a readable v2 path: ${referenced}`);
    }
  }
});

test('real-run fix: a v1 Execution keeps reading its v1 pack (and only it)', async t => {
  const v1 = '/artifacts/factory/skill-pack/factory-skills-v1/skills/implement/SKILL.md';
  const { result, bodies } = await run(t, 'factory-skills-v1', [v1, '/artifacts/factory/skill-pack/factory-skills-v2/skills/implement/SKILL.md']);
  assert.equal(result.status, 'completed');
  assert.match(bodies[1]!, /BLOCKED:/, 'the v1 SKILL.md reached the model');
  assert.match(bodies[2]!, /READ_PATH_DENIED/);
});

test('real-run q23-feedback-v1: a Builder read of its preserved instructions is denied WITH the way forward (bash), never a bare code it can take for a blocker', async t => {
  const path = '/artifacts/instructions/v1/AGENTS.md';
  const { result, bodies, guestCalls } = await run(t, 'factory-skills-v2', [path, '/workspace/checkout/AGENTS.md']);
  assert.equal(result.status, 'completed');
  for (const body of [bodies[1]!, bodies[2]!]) {
    assert.match(body, /READ_PATH_DENIED/, 'the confined Builder read is unchanged: still denied');
    assert.match(body, /use bash/, 'the model is told how to read the file');
    assert.match(body, /not a missing source/, 'and that the denial is not a blocker');
  }
  assert.deepEqual(guestCalls, [], 'denied paths never reach the guest');
});
