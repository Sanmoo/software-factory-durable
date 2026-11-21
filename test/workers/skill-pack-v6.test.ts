import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';

// Ticket 14: a NEW pack version v6 = v5 (ticket 13) plus direct publication only inside a Factory-requested publish-only activation. Earlier versions
// are never edited in place (each keeps its own hashes).
const v6 = builderSkillPacks['factory-skills-v6'];

test('AC1/AC3: factory-skills-v6 publishes only on request, with unchanged content, the explicit lease and one draft PR; /pr alone publishes nothing', async () => {
  const pack = await loadSkillPack(v6.directory, 'factory-skills-v6');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v6', '6.0.0', '/artifacts/factory/skill-pack/factory-skills-v6']);
  for (const file of pack.manifest.files)
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(v6.directory, file.path)))
        .digest('hex'),
      file.sha256,
      file.path,
    );
  const implement = await readFile(join(v6.directory, 'skills/implement/SKILL.md'), 'utf8');
  const pr = await readFile(join(v6.directory, 'skills/pr/SKILL.md'), 'utf8');
  for (const rule of [
    'Do **not** push, open a pull request or change GitHub state while implementing',
    'Publication requested by the Factory',
    'HEAD must stay the verified commit',
    '--force-with-lease=refs/heads/<branch>:<expected>',
    'Never recapture a new expectation, never a plain force\n   push',
    'create ONE draft pull request',
    'Never merge, approve, mark it ready',
    'Opening it does not finish the Ticket',
    'your final message is not evidence',
    'PUBLISH-ONLY activation',
    'without the `handoff` and `edit` tools',
    'never another branch or a tag',
    // carried over from v5 (ticket 13) and v4 (ticket 11)
    'Treat ONLY the findings the delivered results list',
    '`review-rounds=multi`',
    'Continue in the SAME session (`continue` message)',
    'call the `ask_user` tool once',
  ])
    assert.ok(implement.includes(rule), rule);
  for (const rule of [
    '<!-- software-factory:work:<work-id> -->',
    '## Summary',
    '## Validation',
    '## Risk',
    'Closes #<ticket-number>',
    'Never put transcripts, long command output, review rounds or full reviewer opinions in the body',
    'Never present a local path',
    '## Factory publication',
    'gh pr create --repo <repo> --draft',
    'if a pull request exists, do not create another',
    'publish ONLY inside a publication activation requested by the Factory',
  ])
    assert.ok(pr.includes(rule), rule);
  assert.doesNotMatch(pr, /## Evidence|## Merge Danger|not enabled in this Factory version/);
  const prompt = pack.prompts.find(item => item.name === 'pr')!.content;
  assert.match(prompt, /Loading this prompt or the skill publishes nothing/);
  assert.match(pack.prompts.find(item => item.name === 'implement')!.content, /factory-skills-v6\/skills\/implement\/SKILL\.md/);
  const files = await skillPackGuestFiles('factory-skills-v6');
  for (const text of [implement, pr, prompt])
    for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  assert.equal(await skillPackContinues('factory-skills-v6'), true, 'the publish message continues the same session');
  // v4 and v5 stay byte-identical to their own manifests and still say publication is not enabled.
  for (const id of ['factory-skills-v4', 'factory-skills-v5'] as const) {
    const older = builderSkillPacks[id];
    assert.equal((await loadSkillPack(older.directory, id)).id, id);
    assert.match(await readFile(join(older.directory, 'skills/pr/SKILL.md'), 'utf8'), /publication \(push\/pull request\) is not enabled/);
  }
  assert.match(await readFile(join(v6.directory, 'CREDITS.md'), 'utf8'), /`factory-skills-v6` \(6\.0\.0, ticket 14\) = `factory-skills-v5`/);
});
