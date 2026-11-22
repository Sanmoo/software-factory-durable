import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';

// Ticket 53 (pilot 35, 2026-11-19): a NEW pack version v9 = v8 plus fewer avoidable Questions. Every Ticket asked to approve the TDD seams
// even when its body named the layers and test styles (#126 four times, also after the answer), and #126 asked whether the scope changed
// because the issue's `updatedAt` moved with the Factory's own Question/answer comments. Earlier versions are never edited.
const v9 = builderSkillPacks['factory-skills-v9'];
const flat = (text: string) => text.replace(/\s+/g, ' '); // rules may wrap across lines

test('factory-skills-v9: Ticket-named seams matching the repository are approved; only new or ambiguous seams are asked', async () => {
  const pack = await loadSkillPack(v9.directory, 'factory-skills-v9');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v9', '9.0.0', '/artifacts/factory/skill-pack/factory-skills-v9']);
  for (const file of pack.manifest.files)
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(v9.directory, file.path)))
        .digest('hex'),
      file.sha256,
      file.path,
    );
  const tdd = flat(await readFile(join(v9.directory, 'skills/tdd/SKILL.md'), 'utf8'));
  const implement = flat(await readFile(join(v9.directory, 'skills/implement/SKILL.md'), 'utf8'));
  for (const rule of [
    'names the layers or test styles',
    "the corresponding seams already exist in the repository's architecture",
    'Those seams count as approved: do not ask about them',
    'An answer already given in this Work',
    'an entry of `answered-questions` in the Factory state summary',
    'never ask that question again, not even reworded',
    'Ask ONLY for seams that are new',
    'or ambiguous',
    'listing the ones already agreed with their source',
    'Never choose an unagreed seam alone',
  ])
    assert.ok(tdd.includes(rule), rule);
  for (const rule of ["that match the repository's existing architecture count as approved", 'Ask only for new or ambiguous seams'])
    assert.ok(implement.includes(rule), rule);
});

test('factory-skills-v9: answers already given in the Work (the Factory state summary) are used and never asked again', async () => {
  const implement = flat(await readFile(join(v9.directory, 'skills/implement/SKILL.md'), 'utf8'));
  for (const rule of [
    '**Answers already given.** Every question this Work already got an answer to is decided',
    'each entry of `answered-questions` in the "Factory state summary"',
    'never ask any of them again, not even reworded',
    'Answers given earlier in this conversation stay decided (section 4.5): never ask them again',
  ])
    assert.ok(implement.includes(rule), rule);
});

test('factory-skills-v9: a Ticket change is its title/body against the preserved copy, never updatedAt; comments are never a scope change', async () => {
  const implement = flat(await readFile(join(v9.directory, 'skills/implement/SKILL.md'), 'utf8'));
  for (const rule of [
    'Compare only its current `title` and `body` with those of `ticket.json` in the latest complete preserved version',
    'never `updatedAt` or another timestamp',
    "including the Factory's own Question and answer comments",
    'Comments (Factory Questions, `/factory` commands and replies, answers, remarks) are never a scope change',
    'do not ask whether the scope changed',
    '`gh issue view <link> --json number,title,body,url,author,labels`',
  ])
    assert.ok(implement.includes(rule), rule);
  // The only `updatedAt` left in the pack is the rule that forbids using it: the Builder no longer fetches or records it.
  const pack = await loadSkillPack(v9.directory, 'factory-skills-v9');
  for (const file of pack.manifest.files.filter(item => item.path.endsWith('.md') && item.path !== 'CREDITS.md')) {
    const text = flat(await readFile(join(v9.directory, file.path), 'utf8'));
    assert.deepEqual(text.match(/updatedAt/g) ?? [], file.path === 'skills/implement/SKILL.md' ? ['updatedAt', 'updatedAt'] : [], file.path);
  }
});

test('factory-skills-v9: carries v8 and earlier rules, guest paths point at v9, continuation, credits; v8 stays unchanged', async () => {
  const pack = await loadSkillPack(v9.directory, 'factory-skills-v9');
  const implement = await readFile(join(v9.directory, 'skills/implement/SKILL.md'), 'utf8');
  const diagnostics = await readFile(join(v9.directory, 'skills/alpine-diagnostics/SKILL.md'), 'utf8');
  for (const rule of [
    // v8 (ticket 46), v7 (ticket 34), v6 (ticket 14), v5 (ticket 13) and v4 (ticket 11)
    '`timeout: 1800` seconds',
    'at most 8192 bytes',
    'A refusal of either is an ordinary tool error',
    'Never declare `fixed` without a change',
    'PUBLISH-ONLY activation',
    'Treat ONLY the findings the delivered results list',
    '`review-rounds=multi`',
    'Continue in the SAME session (`continue` message)',
    'call the `ask_user` tool once',
  ])
    assert.ok(flat(implement).includes(rule), rule);
  assert.ok(flat(diagnostics).includes('`timeout: 1800` seconds'));
  assert.match(pack.prompts.find(item => item.name === 'implement')!.content, /factory-skills-v9\/skills\/implement\/SKILL\.md/);
  const files = await skillPackGuestFiles('factory-skills-v9');
  for (const text of [implement, diagnostics, ...pack.prompts.map(item => item.content)]) {
    assert.doesNotMatch(text, /factory-skills-v8\//, 'every guest path points at v9');
    for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  }
  assert.equal(await skillPackContinues('factory-skills-v9'), true);
  assert.match(await readFile(join(v9.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v9` \(9\.0\.0, ticket 53\) = `factory-skills-v8`/);
  // v8 stays byte-identical to its own manifest and without the new rules (the release picks v9: release-composition.test.ts).
  const v8 = builderSkillPacks['factory-skills-v8'];
  assert.equal((await loadSkillPack(v8.directory, 'factory-skills-v8')).id, 'factory-skills-v8');
  assert.ok(!flat(await readFile(join(v8.directory, 'skills/tdd/SKILL.md'), 'utf8')).includes('count as approved'));
  assert.ok((await readFile(join(v8.directory, 'skills/implement/SKILL.md'), 'utf8')).includes('url,updatedAt,author'));
});
