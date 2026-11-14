import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builderSkillPacks, loadSkillPack, skillPackContinues, skillPackGuestFiles } from '../../src/workers/skill-pack.js';

// Ticket 14: a NEW pack version v6 = v4 plus direct publication only inside a Factory-requested publication activation. Earlier versions
// are never edited in place (each keeps its own hashes).
const v6 = builderSkillPacks['factory-skills-v6'];

test('AC1/AC3: factory-skills-v6 publishes only on request, with unchanged content, the explicit lease and one draft PR; /pr alone publishes nothing', async () => {
  const pack = await loadSkillPack(v6.directory, 'factory-skills-v6');
  assert.deepEqual([pack.id, pack.version, pack.manifest.guestDirectory], ['factory-skills-v6', '6.0.0', '/artifacts/factory/skill-pack/factory-skills-v6']);
  for (const file of pack.manifest.files) assert.equal(createHash('sha256').update(await readFile(join(v6.directory, file.path))).digest('hex'), file.sha256, file.path);
  const implement = await readFile(join(v6.directory, 'skills/implement/SKILL.md'), 'utf8');
  const pr = await readFile(join(v6.directory, 'skills/pr/SKILL.md'), 'utf8');
  for (const rule of ['Do **not** push, open a pull request or change GitHub state while implementing', 'Publication requested by the Factory',
    'HEAD must stay the verified commit', '--force-with-lease=refs/heads/<branch>:<expected>', 'Never recapture a new expectation, never a plain force push',
    'create ONE draft pull request', 'Never merge, approve, mark it\n   ready', 'Opening it does not finish the Ticket', 'your final message is not evidence',
    // carried over from v4
    'Continue in the SAME session (`continue` message)', 'call the `ask_user` tool once']) assert.ok(implement.includes(rule), rule);
  for (const rule of ['<!-- software-factory:work:<work-id> -->', '## Summary', '## Validation', '## Risk', 'Closes #<ticket-number>',
    'Never put transcripts, long command output, review rounds or full reviewer opinions in the body', 'Never present a local path',
    '## Factory publication', 'gh pr create --repo <repo> --draft', 'if a pull request exists, do not create another', 'publish ONLY inside a publication activation requested by the Factory'])
    assert.ok(pr.includes(rule), rule);
  assert.doesNotMatch(pr, /## Evidence|## Merge Danger|not enabled in this Factory version/);
  const prompt = pack.prompts.find(item => item.name === 'pr')!.content;
  assert.match(prompt, /Loading this prompt or the skill publishes nothing/);
  assert.match(pack.prompts.find(item => item.name === 'implement')!.content, /factory-skills-v6\/skills\/implement\/SKILL\.md/);
  const files = await skillPackGuestFiles('factory-skills-v6');
  for (const text of [implement, pr, prompt]) for (const cited of text.match(/\/artifacts\/factory\/skill-pack\/[A-Za-z0-9._/-]+\.md/g) ?? []) assert.ok(files.includes(cited), cited);
  assert.equal(await skillPackContinues('factory-skills-v6'), true, 'the publish message continues the same session');
  // v4 stays byte-identical to its own manifest and still says publication is not enabled.
  const v4 = builderSkillPacks['factory-skills-v4'];
  assert.equal((await loadSkillPack(v4.directory, 'factory-skills-v4')).id, 'factory-skills-v4');
  assert.match(await readFile(join(v4.directory, 'skills/pr/SKILL.md'), 'utf8'), /publication \(push\/pull request\) is not enabled/);
});
