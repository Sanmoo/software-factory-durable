import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-GH-CHECKS-S real-run recipe must be inert; every phase refuses before any effect while the issue is not pinned.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, spawnSync: deny, request: deny, open: deny, mkdir: deny,
    readFile: deny, writeFile: deny, access: deny, readdir: deny, copyFile: deny, chmod: deny, rm: deny, lstat: deny }, defaultExport: deny });
}
const recipe = await import('./ghchecks34s-qualification.js');

test('R-GH-CHECKS-S recipe: inert plan; reads on an operator probe PR, ONE Factory Work with ONE repair, every setting change with its restore', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-ghchecks-s-v1');
  assert.deepEqual(plan.phases, ['preflight', 'rerun', 'contexts', 'classic', 'homonym', 'run', 'strict', 'human-draft', 'inspect', 'stop-environment']);
  assert.equal(plan.ticket.pinned, false);
  assert.equal(plan.ticket.labelAtCreation, false);
  assert.equal(plan.skillPack, 'factory-skills-v7');
  assert.equal(plan.repository.correctionLimit, 1, 'one repair, never a chain');
  assert.deepEqual(Object.keys(plan.coverage).sort(), ['V-09.c', 'V-09.e', 'V-09.f', 'V-10.b']);
  assert.match(plan.requiredCheck.script.content, /echo 'factory-gate: ok'/);
  assert.doesNotMatch(plan.requiredCheck.script.content, /Checked-by|exit 1/, 'always green: nothing to repair');
  assert.equal(plan.probe.merged, 'never');
  for (const [name, step] of Object.entries(plan.humanSteps) as [string, { apply: string[]; restore: string[]; note: string }][]) {
    if (step.apply.some(line => /rulesets|branches\/main\/protection/.test(line))) assert.ok(step.restore.length > 0, `${name}: restore`);
    assert.ok(step.restore.length > 0 || step.note.length > 0, `${name}: an empty restore says why`);
    assert.ok(!step.apply.some(line => /(^|\s)--(admin|force)(=|\s|$)/.test(line.split(' #')[0]!)), `${name}: never forced or bypassed`);
    const merge = step.apply.findIndex(line => line.startsWith('gh pr merge'));
    if (merge >= 0) assert.ok(step.apply.slice(0, merge).filter(line => line.includes('/rulesets/')).at(-1)?.endsWith('rulesets/relaxed.json --silent'), `${name}: merged under relaxed`);
  }
  assert.ok(plan.humanSteps.setup.apply.at(-1).startsWith('gh pr create --repo Sanmoo/java-springboot-event-sourcing --base main --head q34s-probe'), 'the probe PR is opened, never merged');
  assert.ok(!plan.humanSteps.setup.apply.some((line: string) => line.startsWith('gh pr merge q34s-probe')));
  assert.ok(plan.humanSteps.teardown.apply.some((line: string) => line.startsWith('gh pr close q34s-probe') && line.includes('--delete-branch')));
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/);
  assert.equal(forbidden, 0);
});
