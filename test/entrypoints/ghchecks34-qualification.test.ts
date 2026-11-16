import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-GH-CHECKS real-run recipe must be inert: no process, socket, filesystem or SDK effect; every phase refuses
// before any effect while the two issues are not pinned.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, spawnSync: deny, request: deny, open: deny, mkdir: deny,
    readFile: deny, writeFile: deny, access: deny, readdir: deny, copyFile: deny, chmod: deny, rm: deny, lstat: deny }, defaultExport: deny });
}
const recipe = await import('./ghchecks34-qualification.js');

test('R-GH-CHECKS recipe: import and --plan are inert; own namespace, two pinned NEW issues, a real required check, every setting change with its restore', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-ghchecks-v1');
  assert.deepEqual(plan.phases, ['preflight', 'waiver', 'run', 'failing', 'strict', 'human-draft', 'rerun', 'contexts', 'classic', 'homonym', 'inspect', 'stop-environment']);
  assert.deepEqual([plan.tickets.waiver.pinned, plan.tickets.checks.pinned], [false, false], 'the supervisor pins both NEW issues in a reviewed commit before any phase');
  assert.match(plan.tickets.waiver.body, /## Waiver/);
  assert.match(plan.tickets.waiver.body, /requiredCheck: factory-gate/);
  assert.match(plan.tickets.checks.body, /docs\/FACTORY_CHECKS\.md/);
  assert.doesNotMatch(plan.tickets.checks.body, /Checked-by/, 'the Ticket never asks for the line the check requires: the first Factory head fails');
  assert.match(plan.requiredCheck.script.content, /Checked-by: factory-gate/);
  assert.match(plan.requiredCheck.workflow.content, /path: base[\s\S]*sh \.\.\/base\/ci\/factory-gate\.sh/, 'the script always comes from the base');
  assert.equal(plan.repository.correctionLimit, 2);
  assert.deepEqual([plan.model.providerRetries, plan.model.sdkRetries], [0, 0]);
  assert.deepEqual(plan.model.builderActivations['human-draft'], []);
  for (const [name, step] of Object.entries(plan.humanSteps) as [string, { apply: string[]; restore: string[]; note: string }][]) {
    const changesSettings = step.apply.some(line => /rulesets|branches\/main\/protection/.test(line));
    if (changesSettings) assert.ok(step.restore.length > 0, `${name}: a ruleset/protection change always has its restore`);
    assert.ok(step.restore.length > 0 || step.note.length > 0, `${name}: an empty restore says why`);
    assert.ok(!step.apply.some(line => /--force\b|--admin\b/.test(line.split('#')[0]!)), `${name}: never forced, never an admin bypass`);
  }
  assert.ok(plan.humanSteps.setup.restore.some((line: string) => line.includes('rulesets/26435808') && line.endsWith('rulesets/before.json --silent')));
  assert.ok(plan.humanSteps.classic.restore[0].includes('--method DELETE repos/Sanmoo/java-springboot-event-sourcing/branches/main/protection'));
  for (const never of ['merge of the Factory PR', 'approval', 'bypass', 'change of base protection, rulesets, workflows or required checks by the Factory or by this recipe']) {
    assert.ok(plan.github.never.includes(never), never);
  }
  assert.match(plan.classicSettings, /lock_branch, required_signatures, required_linear_history, restrictions/);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/, 'refused before any effect while the issues are not pinned');
  assert.equal(forbidden, 0);
});
