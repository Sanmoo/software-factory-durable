import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';

// Ticket 56 (pilot 2, #125): a NEW pack version v11 = v10 plus the exact gate run. The Builder ran the documented gate green only inside compound
// commands (`git add && git commit && ./gradlew …`), which are never bound to the gate, while its last exact run had failed. The skill now says to
// run each gate exactly, alone, as the last command before the handoff. Earlier versions are never edited.
const v11 = builderSkillPacks['factory-skills-v11'];
const flat = (text: string) => text.replace(/\s+/g, ' ');

test('factory-skills-v11: run the exact gate command alone, as the last command before the handoff, never inside a compound command', async () => {
  const pack = await loadSkillPack(v11.directory, 'factory-skills-v11');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v11', '11.0.0', '/artifacts/factory/skill-pack/factory-skills-v11']);
  for (const file of pack.manifest.files)
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(v11.directory, file.path)))
        .digest('hex'),
      file.sha256,
      file.path,
    );
  const implement = flat(await readFile(join(v11.directory, 'skills/implement/SKILL.md'), 'utf8'));
  for (const rule of [
    '**Run each gate exactly, alone, last.**',
    'Run the exact documented gate command as its own `bash` call, by itself, as the last command(s) before the `handoff`',
    'never inside a compound command (`git add && git commit && <gate>`, `git status && <gate>`',
    'A gate run inside a compound command is never bound to the gate, even when it passes',
    'The `handoff` refuses a `run` gate whose last exact call failed or never happened',
  ])
    assert.ok(implement.includes(rule), rule);
});

test('factory-skills-v11: carries v10 and earlier rules, guest paths point at v11, continuation, credits; v10 stays unchanged', async () => {
  const pack = await loadSkillPack(v11.directory, 'factory-skills-v11');
  const implement = await readFile(join(v11.directory, 'skills/implement/SKILL.md'), 'utf8');
  const diagnostics = await readFile(join(v11.directory, 'skills/alpine-diagnostics/SKILL.md'), 'utf8');
  for (const rule of [
    '**The declared environment is ready.**',
    "that match the repository's existing architecture count as approved",
    '`timeout: 1800` seconds',
    'Never declare `fixed` without a change',
    'PUBLISH-ONLY activation',
    '`review-rounds=multi`',
    'Continue in the SAME session (`continue` message)',
    'declare it `not-run` with the reason AND ask the operator',
  ])
    assert.ok(flat(implement).includes(rule), rule);
  assert.ok(flat(diagnostics).includes("**The repository's declared environment is already installed.**"));
  assert.match(pack.prompts.find(item => item.name === 'implement')!.content, /factory-skills-v11\/skills\/implement\/SKILL\.md/);
  const files = await skillPackGuestFiles('factory-skills-v11');
  for (const text of [implement, diagnostics, ...pack.prompts.map(item => item.content)]) {
    assert.doesNotMatch(text, /factory-skills-v10\//, 'every guest path points at v11');
    for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  }
  assert.equal(await skillPackContinues('factory-skills-v11'), true);
  assert.match(await readFile(join(v11.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v11` \(11\.0\.0, ticket 56\) = `factory-skills-v10`/);
  const v10 = builderSkillPacks['factory-skills-v10'];
  assert.equal((await loadSkillPack(v10.directory, 'factory-skills-v10')).id, 'factory-skills-v10');
  assert.ok(!flat(await readFile(join(v10.directory, 'skills/implement/SKILL.md'), 'utf8')).includes('Run each gate exactly, alone, last'));
});
