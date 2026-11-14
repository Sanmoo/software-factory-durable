import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles, skillPackIds } from '../../src/workers/skill-pack.js';

// Ticket 11: a NEW pack version v4 = v3 plus continue/recovery context, authorized scope changes and instruction precedence.
// Earlier versions are never edited in place (each keeps its own hashes).
const v4 = builderSkillPacks['factory-skills-v4'];

test('AC1/AC2/AC4/AC5/AC6: factory-skills-v4 is a fully hashed new version whose implement skill continues, recovers and only adopts authorized scope', async () => {
  const pack = await loadSkillPack(v4.directory, 'factory-skills-v4');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v4', '4.0.0', '/artifacts/factory/skill-pack/factory-skills-v4']);
  for (const file of pack.manifest.files) assert.equal(createHash('sha256').update(await readFile(join(v4.directory, file.path))).digest('hex'), file.sha256, file.path);
  const implement = await readFile(join(v4.directory, 'skills/implement/SKILL.md'), 'utf8');
  for (const rule of [
    // AC1 continue in the same session, never restarting implement
    'Continue in the SAME session (`continue` message)', 'Do NOT restart `/implement`', 'check the effect of your last tool call',
    // AC2 replacement with reason and recoverable context
    'Resume in a NEW session (recovery instruction)', '`SESSION_LOST`', 'recoverable context',
    // AC3/AC4 concrete authorization, new complete version before implementing, later edits are no trigger
    'authorizes **only the concrete change it states**', 'Before implementing it, preserve a NEW version `vN+1`', '"notAdopted"', 'is **not** a request, a trigger or a reason to repair',
    'Never edit an earlier version',
    // AC5 preserved copies survive the origin; incomplete capture -> new version; private inaccessible source -> blocker, never wider access
    'stays valid if its origin later disappears', 'NOT ready: never complete or repair it in\n   place', 'never a reason to widen access',
    // AC6 precedence by path, conflict -> question, modified instructions never waive policy/gates/limits
    '"precedence"', 'A conflict without a clear resolution is a question (`ask_user`)', 'never waive the Factory policy, the reviews/handoff, the tests/gates or your limits',
    // carried over from v3
    'call the `ask_user` tool once', 'Do **not** push', 'Never configure, copy or reuse a human\'s name or email for commits', 'contains `reviews=factory-handoff`',
  ]) assert.ok(implement.includes(rule), rule);
  const prompt = pack.prompts.find(item => item.name === 'implement')!.content;
  assert.match(prompt, /\/artifacts\/factory\/skill-pack\/factory-skills-v4\/skills\/implement\/SKILL\.md/);
  assert.match(prompt, /Later edits of the Ticket or its links are not authorizations/);
  assert.match(await readFile(join(v4.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v4` \(4\.0\.0, ticket 11\) = `factory-skills-v3` plus context continuation and authorized scope/);
  // Every path the v4 texts cite is a seeded file the Builder may read (pack-read authority of ticket 10).
  const files = await skillPackGuestFiles('factory-skills-v4');
  for (const text of [implement, prompt]) for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  // finding 2: the pack itself declares which session protocols it defines; no Control/Host list of versions decides it.
  assert.deepEqual(pack.manifest.capabilities, { continuation: true });
  assert.equal(await skillPackContinues('factory-skills-v4'), true);
  for (const older of skillPackIds.filter(id => id !== 'factory-skills-v4')) {
    assert.equal((await loadSkillPack(builderSkillPacks[older].directory, older)).manifest.capabilities?.continuation, undefined, older);
    assert.equal(await skillPackContinues(older), false, older);
  }
  // Renumbering/adding a version is a data change: the registry, the Host schema enum and the loader all derive from the same list.
  assert.deepEqual([...skillPackIds], [...(await import('../../src/contracts/index.js')).factorySkillPackIds]);
  // The earlier versions stay byte-identical to their own manifests.
  for (const id of ['factory-skills-v1', 'factory-skills-v2', 'factory-skills-v3'] as const) {
    const old = await loadSkillPack(builderSkillPacks[id].directory, id);
    assert.equal(old.id, id);
    assert.doesNotMatch(await readFile(join(builderSkillPacks[id].directory, 'skills/implement/SKILL.md'), 'utf8'), /Continue in the SAME session/);
  }
  await assert.rejects(loadSkillPack(builderSkillPacks['factory-skills-v3'].directory, 'factory-skills-v4'), /WORKER_SKILL_PACK_DRIFT/);
});
