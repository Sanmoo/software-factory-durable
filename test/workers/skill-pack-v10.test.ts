import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';

// Ticket 44 (operator decision 2026-11-19): a NEW pack version v10 = v9 plus the per-repository environment. The environment declared in
// `.factory/environment.yaml` is installed before the Builder starts: the skills say it is ready, never to be reinstalled or swapped; extras
// the Ticket needs may be installed and are recorded. Earlier versions are never edited.
const v10 = builderSkillPacks['factory-skills-v10'];
const flat = (text: string) => text.replace(/\s+/g, ' ');

test('factory-skills-v10: the declared environment is ready; never reinstalled or swapped; extras are installed only when needed and recorded', async () => {
  const pack = await loadSkillPack(v10.directory, 'factory-skills-v10');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v10', '10.0.0', '/artifacts/factory/skill-pack/factory-skills-v10']);
  for (const file of pack.manifest.files) assert.equal(createHash('sha256').update(await readFile(join(v10.directory, file.path))).digest('hex'), file.sha256, file.path);
  const implement = flat(await readFile(join(v10.directory, 'skills/implement/SKILL.md'), 'utf8'));
  const diagnostics = flat(await readFile(join(v10.directory, 'skills/alpine-diagnostics/SKILL.md'), 'utf8'));
  for (const rule of ['**The declared environment is ready.**', '`.factory/environment.yaml`', 'the Factory installed exactly that into this guest before you started',
    'do not reinstall, upgrade, downgrade or replace a declared package, version, runtime or image', 'do not switch to another stack',
    'you may install it as an extra', 'record it in your final message (package, exact version and why)', 'stop and report it as a blocker instead of changing it'])
    assert.ok(implement.includes(rule), rule);
  for (const rule of ['**The repository\'s declared environment is already installed.**', 'nothing in it needs installing',
    'never swap the declared stack for another one', 'Install an EXTRA with `apk add <pkg>` only when the Ticket\'s build needs something the declaration does not provide',
    'and record it (package, exact version from `apk info -v`, and why)']) assert.ok(diagnostics.includes(rule), rule);
});

test('factory-skills-v10: carries v9 and earlier rules, guest paths point at v10, continuation, credits; v9 stays unchanged', async () => {
  const pack = await loadSkillPack(v10.directory, 'factory-skills-v10');
  const implement = await readFile(join(v10.directory, 'skills/implement/SKILL.md'), 'utf8');
  const tdd = await readFile(join(v10.directory, 'skills/tdd/SKILL.md'), 'utf8');
  const diagnostics = await readFile(join(v10.directory, 'skills/alpine-diagnostics/SKILL.md'), 'utf8');
  for (const rule of ['that match the repository\'s existing architecture count as approved', 'never ask any of them again, not even reworded',
    'never `updatedAt` or another timestamp', '`timeout: 1800` seconds', 'at most 8192 bytes', 'Never declare `fixed` without a change', 'PUBLISH-ONLY activation',
    '`review-rounds=multi`', 'Continue in the SAME session (`continue` message)', 'call the `ask_user` tool once']) assert.ok(flat(implement).includes(rule), rule);
  assert.ok(flat(tdd).includes('Those seams count as approved: do not ask about them'));
  assert.ok(flat(diagnostics).includes('`timeout: 1800` seconds'));
  assert.match(pack.prompts.find(item => item.name === 'implement')!.content, /factory-skills-v10\/skills\/implement\/SKILL\.md/);
  const files = await skillPackGuestFiles('factory-skills-v10');
  for (const text of [implement, diagnostics, ...pack.prompts.map(item => item.content)]) {
    assert.doesNotMatch(text, /factory-skills-v9\//, 'every guest path points at v10');
    for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  }
  assert.equal(await skillPackContinues('factory-skills-v10'), true);
  assert.match(await readFile(join(v10.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v10` \(10\.0\.0, ticket 44\) = `factory-skills-v9`/);
  const v9 = builderSkillPacks['factory-skills-v9'];
  assert.equal((await loadSkillPack(v9.directory, 'factory-skills-v9')).id, 'factory-skills-v9');
  assert.ok(!flat(await readFile(join(v9.directory, 'skills/implement/SKILL.md'), 'utf8')).includes('The declared environment is ready'));
});
