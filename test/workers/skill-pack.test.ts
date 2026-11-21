import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderSkillPack, loadSkillPack, skillPacks } from '../../src/workers/skill-pack.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { createRecords } from '../../src/records/index.js';
import type { ToolContext } from '../../src/sandbox/index.js';

// Real SDK session (Pi 1.5.2 v3 staging) with an offline provider fetch double; no network, no model, no VM.
const context: ToolContext = {
  workId: 'work-09',
  executionId: 'exec-09',
  invocationId: 'builder-09',
  role: 'builder',
  environmentRef: 'env-09',
  bootRef: 'boot-09',
  phaseId: 'phase-09',
};

test('AC4: the versioned Factory pack declares implement/code-review/pr/tdd/codebase-design/alpine-diagnostics with origin, credits and licenses; every file is hashed', async () => {
  const pack = await loadSkillPack();
  const manifest = pack.manifest;
  assert.deepEqual([pack.id, pack.version, builderSkillPack.id], ['factory-skills-v2', '2.0.0', 'factory-skills-v2'], 'the Builder default is v2');
  assert.deepEqual(manifest.skills.map(skill => skill.name).sort(), ['alpine-diagnostics', 'code-review', 'codebase-design', 'implement', 'pr', 'tdd']);
  assert.deepEqual(manifest.prompts.map(prompt => prompt.name).sort(), ['implement', 'pr']);
  assert.equal(manifest.skills.find(skill => skill.name === 'implement')!.modelInvocation, false, 'implement starts only explicitly via /implement');
  for (const file of manifest.files) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(builderSkillPack.directory, file.path)))
        .digest('hex'),
      file.sha256,
      file.path,
    );
    if (file.change !== 'factory-own') assert.deepEqual([file.origin.package, file.origin.license], ['mattpocock-skills', 'MIT'], file.path);
  }
  const credits = await readFile(join(builderSkillPack.directory, 'CREDITS.md'), 'utf8');
  assert.match(credits, /mattpocock-skills` 1\.3\.1/);
  assert.match(credits, /Dex Horthy/);
  assert.match(await readFile(join(builderSkillPack.directory, 'LICENSE.mattpocock-skills'), 'utf8'), /^MIT License/);
  const implement = await readFile(join(builderSkillPack.directory, 'skills/implement/SKILL.md'), 'utf8');
  for (const rule of [
    'Preserve the request BEFORE implementing',
    'Never overwrite',
    'LAST, write each `sources.json`',
    '"sha256"',
    '"revision"',
    'do not ask for broader access',
    'do not adopt an auxiliary document',
    'call the `ask_user` tool',
    'This ends the activation',
    'Do **not** push',
    '## 4. Resume after an answer',
    'Never repeat the last tool call blindly',
    'ask again with a new question',
  ])
    assert.ok(implement.includes(rule), rule);
  assert.ok(!implement.includes('BLOCKED:'), 'blockers become durable Questions (ticket 10), not a final message');
  assert.match(await readFile(join(builderSkillPack.directory, 'skills/tdd/SKILL.md'), 'utf8'), /A label is not that approval/);
  assert.match(credits, /factory-skills-v2.*derives from `factory-skills-v1` 1\.0\.0/);
  for (const name of ['prompts/implement.md', 'prompts/pr.md']) {
    assert.doesNotMatch(await readFile(join(builderSkillPack.directory, name), 'utf8'), /factory-skills-v1/, `${name} points at v2 guest paths`);
  }
});

test('versions are never overwritten: v1 stays exactly 1.0.0 (BLOCKED rule) and still loads by its own identity', async () => {
  const v1 = await loadSkillPack(skillPacks['factory-skills-v1'].directory);
  assert.deepEqual([v1.id, v1.version, v1.manifest.guestDirectory], ['factory-skills-v1', '1.0.0', '/artifacts/factory/skill-pack/factory-skills-v1']);
  const implement = await readFile(join(skillPacks['factory-skills-v1'].directory, 'skills/implement/SKILL.md'), 'utf8');
  assert.ok(implement.includes('BLOCKED:') && !implement.includes('ask_user'));
  assert.equal(
    createHash('sha256').update(implement).digest('hex'),
    'b19982a234367deee53fd9d324cfa3824314b606944f980507d74df5463f75ca',
    'v1 implement unchanged since ticket 09',
  );
});

test('AC4: any drift of the pack (changed or extra file) refuses loading', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-pack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(builderSkillPack.directory, join(dir, 'a'), { recursive: true });
  await writeFile(join(dir, 'a', 'skills', 'tdd', 'SKILL.md'), 'changed');
  await assert.rejects(loadSkillPack(join(dir, 'a')), /WORKER_SKILL_PACK_DRIFT/);
  await cp(builderSkillPack.directory, join(dir, 'b'), { recursive: true });
  await writeFile(join(dir, 'b', 'skills', 'extra.md'), 'unlisted');
  await assert.rejects(loadSkillPack(join(dir, 'b')), /WORKER_SKILL_PACK_DRIFT/);
});

test('AC4/AC6: the Builder starts with /implement resolved by the SDK from the Factory pack only; personal skills are never loaded; the receipt names the pack', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-pack-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profileDirectory = join(dir, 'profile');
  await mkdir(join(profileDirectory, 'sessions'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'records'), { mode: 0o700 });
  // A personal Pi profile that must never be discovered.
  const home = join(dir, 'home');
  await mkdir(join(home, '.pi', 'agent', 'skills', 'personal'), { recursive: true });
  await writeFile(
    join(home, '.pi', 'agent', 'skills', 'personal', 'SKILL.md'),
    '---\nname: personal-canary\ndescription: personal-canary\n---\npersonal-canary',
  );
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const chunk = (delta: unknown, finish: string | null) =>
      'data: ' +
      JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }) +
      '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'BLOCKED: offline fixture' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env.HOME = previousHome;
  });
  const records = await createRecords({ root: join(dir, 'records') });
  const profile = {
    id: sdkProfile.id,
    directory: profileDirectory,
    systemPrompt: 'Factory Builder policy.',
    providerId: 'fixture',
    modelId: 'm',
    apiKey: 'synthetic-key',
    provider: {
      api: 'openai-completions' as const,
      baseUrl: 'https://offline.invalid',
      models: [
        {
          id: 'm',
          name: 'm',
          reasoning: false,
          input: ['text' as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 1000,
        },
      ],
    },
  };
  const sandbox = {
    async executeTool() {
      return { status: 'failure' as const, code: 'NOT_USED' };
    },
  };
  const prompt = '/implement https://github.com/acme/project/issues/3 repository=acme/project base=main branch=factory/w checkout=/workspace/checkout';
  const result = await createWorkerSession({ profile, sandbox, records }).activate({
    context,
    prompt,
    signal: new AbortController().signal,
    skillPack: 'factory-skills-v2',
    copyOutput: true,
  });
  assert.equal(result.status, 'completed');
  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  assert.match(
    body,
    /Start the Factory `implement` skill now for Ticket https:\/\/github.com\/acme\/project\/issues\/3/,
    'SDK expanded the /implement template with the Ticket link',
  );
  assert.match(body, /repository=acme\/project base=main branch=factory\/w/);
  assert.ok(body.includes('/artifacts/factory/skill-pack/factory-skills-v2/skills/tdd/SKILL.md'), 'auxiliary skills listed at their known guest paths');
  assert.ok(!body.includes('skills/implement/SKILL.md</location>'), 'implement is not model-invocable, only explicit');
  assert.doesNotMatch(body, /personal-canary/);
  const receipt = JSON.parse(await readFile(join(dir, 'records', context.workId, 'evidence', result.receipt.id, 'output'), 'utf8')).event;
  assert.deepEqual(receipt.skillPack, { id: 'factory-skills-v2', version: '2.0.0', manifestSha256: (await loadSkillPack()).manifestSha256 });
  assert.equal(receipt.promptSha256, createHash('sha256').update(prompt).digest('hex'));
  assert.equal(receipt.modelBudget, null);
  await assert.rejects(
    createWorkerSession({ profile, sandbox, records }).activate({
      context: { ...context, role: 'spec', invocationId: 'spec-09' },
      prompt: 'x',
      signal: new AbortController().signal,
      skillPack: 'factory-skills-v1',
    }),
    /WORKER_POLICY_ROLE_DENIED/,
    'reviewers never receive the Builder pack',
  );
});
