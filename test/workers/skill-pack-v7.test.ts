import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';

// Ticket 34 (R-CAND v6, 2026-11-17): a NEW pack version v7 = v6 plus the treatment of a finding the reviewed content already satisfies.
// Real run qcand34-v6: Spec raised a requirement finding against content that already contained the requested change; the Builder declared
// it `fixed` without changing anything and the verification correctly refused it (FIX_NOT_REVIEWED). Earlier versions are never edited.
const v7 = builderSkillPacks['factory-skills-v7'];

test('factory-skills-v7: a finding the reviewed content already satisfies is not-adopted with a justification (a requirement one asks first), never fixed without a change', async () => {
  const pack = await loadSkillPack(v7.directory, 'factory-skills-v7');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v7', '7.0.0', '/artifacts/factory/skill-pack/factory-skills-v7']);
  for (const file of pack.manifest.files) assert.equal(createHash('sha256').update(await readFile(join(v7.directory, file.path))).digest('hex'), file.sha256, file.path);
  const implement = await readFile(join(v7.directory, 'skills/implement/SKILL.md'), 'utf8');
  const flat = implement.replace(/\s+/g, ' '); // rules may wrap across lines
  for (const rule of ['`fixed` means you changed the content after that round', 'already satisfies the finding',
    'is `not-adopted` with a justification and evidence', 'a REQUIREMENT finding of that kind is still a question for the operator first',
    'Never declare `fixed` without a change',
    // carried over from v6 (ticket 14), v5 (ticket 13) and v4 (ticket 11)
    'PUBLISH-ONLY activation', 'Treat ONLY the findings the delivered results list', '`review-rounds=multi`',
    'Continue in the SAME session (`continue` message)', 'call the `ask_user` tool once']) assert.ok(flat.includes(rule), rule);
  assert.match(pack.prompts.find(item => item.name === 'implement')!.content, /factory-skills-v7\/skills\/implement\/SKILL\.md/);
  const files = await skillPackGuestFiles('factory-skills-v7');
  for (const text of [implement, ...pack.prompts.map(item => item.content)]) {
    assert.doesNotMatch(text, /factory-skills-v6\//, 'every guest path points at v7');
    for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  }
  assert.equal(await skillPackContinues('factory-skills-v7'), true);
  assert.match(await readFile(join(v7.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v7` \(7\.0\.0, ticket 34\) = `factory-skills-v6`/);
  // v6 stays byte-identical to its own manifest and without the new rule (the release picks v7: release-composition.test.ts).
  const v6 = builderSkillPacks['factory-skills-v6'];
  assert.equal((await loadSkillPack(v6.directory, 'factory-skills-v6')).id, 'factory-skills-v6');
  assert.ok(!(await readFile(join(v6.directory, 'skills/implement/SKILL.md'), 'utf8')).includes('Never declare `fixed` without a change'));
});
