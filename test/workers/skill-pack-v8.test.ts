import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';

// Ticket 46 (pilot 35, 2026-11-19): a NEW pack version v8 = v7 plus the tool limits the pilot hit. A Builder gave `./gradlew test` a
// 120 s timeout (the Execution ended WORKER_INTERRUPTED) and edited Java files over the 8192-byte edit source limit. Earlier versions are
// never edited.
const v8 = builderSkillPacks['factory-skills-v8'];

test('factory-skills-v8: implement and alpine-diagnostics ask for generous build/test timeouts and bash for files over the edit/write limits', async () => {
  const pack = await loadSkillPack(v8.directory, 'factory-skills-v8');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v8', '8.0.0', '/artifacts/factory/skill-pack/factory-skills-v8']);
  for (const file of pack.manifest.files) assert.equal(createHash('sha256').update(await readFile(join(v8.directory, file.path))).digest('hex'), file.sha256, file.path);
  const flat = (text: string) => text.replace(/\s+/g, ' '); // rules may wrap across lines
  const implement = await readFile(join(v8.directory, 'skills/implement/SKILL.md'), 'utf8');
  const diagnostics = await readFile(join(v8.directory, 'skills/alpine-diagnostics/SKILL.md'), 'utf8');
  for (const text of [implement, diagnostics].map(flat)) {
    for (const rule of ['generous', '`timeout: 1800` seconds', 'first run', 'downloads',
      'never a short one such as 120', 'ends the activation, because the Factory cannot confirm that it stopped',
      'at most 8192 bytes', '`write` accepts at most 8192 characters', 'with `bash`']) assert.ok(text.includes(rule), rule);
  }
  for (const rule of ['A refusal of either is an ordinary tool error',
    // carried over from v7 (ticket 34), v6 (ticket 14), v5 (ticket 13) and v4 (ticket 11)
    'Never declare `fixed` without a change', 'PUBLISH-ONLY activation', 'Treat ONLY the findings the delivered results list',
    '`review-rounds=multi`', 'Continue in the SAME session (`continue` message)', 'call the `ask_user` tool once']) assert.ok(flat(implement).includes(rule), rule);
  assert.match(pack.prompts.find(item => item.name === 'implement')!.content, /factory-skills-v8\/skills\/implement\/SKILL\.md/);
  const files = await skillPackGuestFiles('factory-skills-v8');
  for (const text of [implement, diagnostics, ...pack.prompts.map(item => item.content)]) {
    assert.doesNotMatch(text, /factory-skills-v7\//, 'every guest path points at v8');
    for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  }
  assert.equal(await skillPackContinues('factory-skills-v8'), true);
  assert.match(await readFile(join(v8.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v8` \(8\.0\.0, ticket 46\) = `factory-skills-v7`/);
  // v7 stays byte-identical to its own manifest and without the new rules (the release picks v8: release-composition.test.ts).
  const v7 = builderSkillPacks['factory-skills-v7'];
  assert.equal((await loadSkillPack(v7.directory, 'factory-skills-v7')).id, 'factory-skills-v7');
  for (const file of ['skills/implement/SKILL.md', 'skills/alpine-diagnostics/SKILL.md'])
    assert.ok(!(await readFile(join(v7.directory, file), 'utf8')).includes('timeout: 1800'), file);
});
