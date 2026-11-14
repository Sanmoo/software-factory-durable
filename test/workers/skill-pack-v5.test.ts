import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { createRecords } from '../../src/records/index.js';

// Ticket 13: a NEW pack version v5 = ticket 11's v4 + repeated rounds with treatments of listed findings and Host-evidenced gates
// (v1-v4 are never edited). The version id is mechanical: renumbering the pack changes this file's ids only.
const v4 = builderSkillPacks['factory-skills-v4'];
const v5 = builderSkillPacks['factory-skills-v5'];

test('AC1-AC3: factory-skills-v5 is a separately versioned, fully hashed pack whose implement skill hands off again with treatments and gates', async () => {
  const pack = await loadSkillPack(v5.directory, 'factory-skills-v5');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v5', '5.0.0', '/artifacts/factory/skill-pack/factory-skills-v5']);
  for (const file of pack.manifest.files) assert.equal(createHash('sha256').update(await readFile(join(v5.directory, file.path))).digest('hex'), file.sha256, file.path);
  const implement = await readFile(join(v5.directory, 'skills/implement/SKILL.md'), 'utf8');
  for (const rule of ['contains `reviews=factory-handoff`', '`review-rounds=multi`', 'the gates with\n`bash` as your LAST commands', 'ALWAYS runs in `/workspace`', 'never only in the declared cwd', 'even if you also declare it as a gate',
    'content snapshot ONLY from its own record of your `bash` calls', 'a requirement non-adoption needs\n   the operator\'s ANSWERED question as its `authorization`',
    'never copy or edit output as evidence', 'declare it\n`not-run` with the reason AND ask the operator (`ask_user`)', 'A waiver never satisfies a GitHub required check',
    'Treat EVERY finding of a round', 'internal disagreement needs no arbitration by itself', 'A finding that\n   states a REQUIREMENT (Spec axis) that you do not adopt, a waiver, or an approval required by a skill',
    'NOT an approval and NOT zero findings', 'Call `handoff` again with `treatments` for every finding', 'a commit of exactly the reviewed content does not',
    'Treat ONLY the findings the delivered results list', 'never invent a placeholder treatment', 'HANDOFF_TREATMENT_UNKNOWN_FINDING',
    'HANDOFF_ROUND_LIMIT', 'captures the proposal once more after you finish', 'Preserve the request BEFORE implementing', 'Do **not** push',
    'Never configure, copy or reuse a human\'s name or email for commits',
    // carried over from v4 (ticket 11): continuation, recovery, authorized scope, instruction precedence
    'Continue in the SAME session (`continue` message)', 'Do NOT restart `/implement`', 'Resume in a NEW session (recovery instruction)',
    'authorizes **only the concrete change it states**', 'never waive the Factory policy, the reviews/handoff, the tests/gates or your limits']) assert.ok(implement.includes(rule), rule);
  assert.equal(pack.manifest.capabilities?.continuation, true, 'v5 keeps the continuation protocol');
  assert.equal(await skillPackContinues('factory-skills-v5'), true);
  const prompt = pack.prompts.find(item => item.name === 'implement')!.content;
  assert.match(prompt, /\/artifacts\/factory\/skill-pack\/factory-skills-v5\/skills\/implement\/SKILL\.md/);
  assert.match(prompt, /`review-rounds=multi` you hand off again/);
  assert.match(await readFile(join(v5.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v5` \(5\.0\.0, ticket 13\) = `factory-skills-v4` plus repeated review rounds/);
  assert.ok((await skillPackGuestFiles('factory-skills-v5')).every(path => path.startsWith('/artifacts/factory/skill-pack/factory-skills-v5/')));
  // v4 stays exactly the ticket 11 pack; v5 keeps its continuation capability.
  const old = await loadSkillPack(v4.directory, 'factory-skills-v4');
  assert.equal(old.version, '4.0.0');
  assert.doesNotMatch(await readFile(join(v4.directory, 'skills/implement/SKILL.md'), 'utf8'), /review-rounds=multi/);
  await assert.rejects(loadSkillPack(v4.directory, 'factory-skills-v5'), /WORKER_SKILL_PACK_DRIFT/, 'a pack is loaded only as the version it declares');
});

test('AC1: the SDK expands /implement from v5 at its own guest paths, offers the multi-round handoff tool and the start receipt names v5', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-pack-v5-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = join(dir, 'profile'); await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'records'), { mode: 0o700 });
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'BLOCKED: offline fixture' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const records = await createRecords({ root: join(dir, 'records') });
  const context = { workId: 'work-13', executionId: 'exec-13', invocationId: 'builder-13', role: 'builder' as const, environmentRef: 'env-13', bootRef: 'boot-13', phaseId: 'p' };
  const profile = { id: sdkProfile.id, directory, systemPrompt: 'Factory Builder policy.', providerId: 'fixture', modelId: 'm', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid', models: [{ id: 'm', name: 'm', reasoning: false, input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }] } };
  const events: unknown[] = [];
  const result = await createWorkerSession({ profile, records, sandbox: { async executeTool() { return { status: 'failure' as const, code: 'NOT_USED' }; } },
    onHandoff: async event => { events.push(event); return { kind: 'review-results', round: event.round, prompt: 'x', end: true }; } }).activate({ context, signal: new AbortController().signal,
    skillPack: 'factory-skills-v5', handoff: { baseCommit: 'a'.repeat(40), rounds: { first: 1, max: 4 } },
    prompt: '/implement https://github.com/acme/project/issues/3 repository=acme/project reviews=factory-handoff review-rounds=multi' });
  assert.equal(result.status, 'completed');
  assert.match(bodies[0]!, /factory-skills-v5\/skills\/implement\/SKILL\.md/);
  assert.match(bodies[0]!, /review-rounds=multi/);
  assert.match(bodies[0]!, /"name":"handoff"[\s\S]*"gates"[\s\S]*"treatments"|"name":"handoff"[\s\S]*"treatments"[\s\S]*"gates"/);
  assert.equal(bodies.length, 1, 'the closing capture is the Host\'s: no further model request');
  assert.deepEqual((events as { round: number; closing?: boolean; status: string }[]).map(event => [event.round, event.closing, event.status]), [[1, true, 'failure']],
    'the closing capture runs even without a handoff; its failure is reported, never a guessed capture');
  const receipt = JSON.parse(await readFile(join(dir, 'records', 'work-13', 'evidence', result.receipt.id, 'output'), 'utf8')).event;
  assert.deepEqual(receipt.skillPack, { id: 'factory-skills-v5', version: '5.0.0', manifestSha256: (await loadSkillPack(v5.directory, 'factory-skills-v5')).manifestSha256 });
});
