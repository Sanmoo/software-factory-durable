import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderSkillPacks, loadSkillPack } from '../../src/workers/skill-pack.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { createRecords } from '../../src/records/index.js';
import { plan } from '../entrypoints/review12-qualification.js';

// Ticket 12: a NEW pack version v3 = ticket 10 ask_user text + handoff (v1 is never overwritten) whose implement skill ends with the review handoff when reviews are enabled.
const v1 = builderSkillPacks['factory-skills-v1'];
const v3 = builderSkillPacks['factory-skills-v3'];

test('AC3: factory-skills-v3 is a separately versioned, fully hashed pack whose implement skill/prompt hands off for review instead of finishing', async () => {
  const pack = await loadSkillPack(v3.directory, 'factory-skills-v3');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v3', '3.0.0', '/artifacts/factory/skill-pack/factory-skills-v3']);
  for (const file of pack.manifest.files)
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(v3.directory, file.path)))
        .digest('hex'),
      file.sha256,
      file.path,
    );
  const implement = await readFile(join(v3.directory, 'skills/implement/SKILL.md'), 'utf8');
  for (const rule of [
    'contains `reviews=factory-handoff`',
    'calling the\n`handoff` tool, NOT by a final message',
    'exactly\n   once, alone in its turn',
    'Wait. The effective review results',
    'Treat every finding: fix it',
    'NOT an approval and NOT zero findings',
    'Do not call `handoff` again',
    '`fixed` or `not adopted: <justification>`',
    'Preserve the request BEFORE implementing',
    'call the `ask_user` tool once',
    'Resume after an answer',
    'do not hand off: call `ask_user`',
    'Do **not** push',
    "Never configure, copy or reuse a human's name or email for commits",
  ])
    assert.ok(implement.includes(rule), rule);
  const prompt = pack.prompts.find(item => item.name === 'implement')!.content;
  assert.match(prompt, /\/artifacts\/factory\/skill-pack\/factory-skills-v3\/skills\/implement\/SKILL\.md/);
  assert.match(prompt, /`reviews=factory-handoff`, you finish the implementation by calling the `handoff` tool/);
  assert.match(
    await readFile(join(v3.directory, 'CREDITS.md'), 'utf8'),
    /mattpocock-skills` 1\.3\.1[\s\S]*`factory-skills-v3` \(3\.0\.0, ticket 12\) = `factory-skills-v2` plus the review handoff/,
  );
  // v1 stays exactly the ticket 09 pack.
  const old = await loadSkillPack(v1.directory, 'factory-skills-v1');
  assert.equal(old.version, '1.0.0');
  assert.doesNotMatch(await readFile(join(v1.directory, 'skills/implement/SKILL.md'), 'utf8'), /handoff/);
  await assert.rejects(loadSkillPack(v1.directory, 'factory-skills-v3'), /WORKER_SKILL_PACK_DRIFT/, 'a pack is loaded only as the version it declares');
  assert.equal(plan().model.builder.skillPack, 'factory-skills-v3', 'the ticket 12 recipe uses v3');
});

test('AC3: the SDK expands /implement from v3 at its own guest paths and the start receipt names v3', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-pack-v3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = join(dir, 'profile');
  await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'records'), { mode: 0o700 });
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const chunk = (delta: unknown, finish: string | null) =>
      'data: ' +
      JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }) +
      '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'BLOCKED: offline fixture' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  const records = await createRecords({ root: join(dir, 'records') });
  const context = {
    workId: 'work-12',
    executionId: 'exec-12',
    invocationId: 'builder-12',
    role: 'builder' as const,
    environmentRef: 'env-12',
    bootRef: 'boot-12',
    phaseId: 'p',
  };
  const profile = {
    id: sdkProfile.id,
    directory,
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
  const result = await createWorkerSession({
    profile,
    records,
    sandbox: {
      async executeTool() {
        return { status: 'failure' as const, code: 'NOT_USED' };
      },
    },
    onHandoff: async () => ({ kind: 'review-results', round: 1, prompt: 'x' }),
  }).activate({
    context,
    signal: new AbortController().signal,
    skillPack: 'factory-skills-v3',
    handoff: { baseCommit: 'a'.repeat(40) },
    prompt: '/implement https://github.com/acme/project/issues/3 repository=acme/project reviews=factory-handoff',
  });
  assert.equal(result.status, 'completed');
  assert.match(bodies[0]!, /factory-skills-v3\/skills\/implement\/SKILL\.md/);
  assert.match(bodies[0]!, /reviews=factory-handoff/);
  assert.match(bodies[0]!, /"name":"handoff"/);
  assert.doesNotMatch(bodies[0]!, /factory-skills-v1/);
  const receipt = JSON.parse(await readFile(join(dir, 'records', 'work-12', 'evidence', result.receipt.id, 'output'), 'utf8')).event;
  assert.deepEqual(receipt.skillPack, {
    id: 'factory-skills-v3',
    version: '3.0.0',
    manifestSha256: (await loadSkillPack(v3.directory, 'factory-skills-v3')).manifestSha256,
  });
});
