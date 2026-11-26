import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Spec #68 §13 (ticket #84): import and `--plan` of the real `triage-qualification` recipe are inert (no process, socket, filesystem or
// SDK effect), and every real phase refuses before any effect while the fixture is not pinned, also with an approved rubric in hand.
let forbidden = 0;
const deny = () => {
  forbidden++;
  throw new Error('FORBIDDEN_EFFECT');
};
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', 'node:http']) {
  mock.module(name, {
    namedExports: {
      connect: deny,
      createServer: deny,
      execFile: deny,
      execFileSync: deny,
      spawn: deny,
      request: deny,
      open: deny,
      mkdir: deny,
      readFile: deny,
      writeFile: deny,
      access: deny,
      readdir: deny,
      rename: deny,
      rm: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./triage-qualification.js');

test('triage-qualification recipe: import and --plan are inert; nothing is pinned, so every phase refuses before any effect', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.executed, false, 'the recipe ships as never executed');
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/t68/q68-triage-v1');
  assert.deepEqual([plan.pinned, plan.tenant.state, plan.fixture.repository, plan.fixture.commit], [false, 'none', '', '']);
  assert.deepEqual(
    [plan.fixture.issues.measure, plan.fixture.issues.fixed],
    [Array(9).fill(0), Array(9).fill(0)],
    'the supervisor pins two copies of the nine issues in a reviewed commit',
  );
  assert.deepEqual(plan.passes.measure.limits, { requests: 144, toolCalls: 480, investigationMinutes: 45 }, 'spec §13: the loose limits of the first pass');
  assert.deepEqual(
    plan.passes.fixed.limits,
    { requests: 0, toolCalls: 0, investigationMinutes: 0 },
    'the definitive limits are pinned only after the measurement',
  );
  assert.deepEqual(plan.phases, ['preflight', 'measure', 'fixed', 'jira-probe', 'inspect']);
  assert.deepEqual(Object.keys(plan.obligations), ['TQ-01', 'TQ-02', 'TQ-03', 'TQ-04', 'TQ-05', 'TQ-06']);
  for (const obligation of Object.values(plan.obligations) as { phases: string[]; criteria: string[] }[]) {
    for (const phase of obligation.phases) assert.ok(plan.phases.includes(phase), phase);
    for (const criterion of obligation.criteria) assert.ok(recipe.criterionIds.includes(criterion), criterion);
  }
  assert.ok(plan.obligations['TQ-06'].criteria.includes('TR-43'), 'TR-43 is observed with TQ-06');
  assert.deepEqual(Object.keys(plan.deferred), ['#78', '#77', '#75', '#79', '#72/#76'], 'what earlier tickets left to the real qualification');
  for (const never of ['a Builder, reviewer or Sandbox', 'a merge', 'needs-triage applied by the recipe']) assert.ok(plan.writes.never.includes(never), never);
  assert.match(plan.approval.jira, /inconclusive, never approved/);

  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['measure', 'again']), /EXACT_PHASE_REQUIRED/);
  const rubric = { criterionIds: recipe.criterionIds, sha256: 'a'.repeat(64) };
  for (const phase of recipe.phases) {
    await assert.rejects(recipe.main([phase]), /FIXTURE_NOT_PINNED/, `${phase} refused before any effect`);
    await assert.rejects(recipe.main([phase], { rubric }), /FIXTURE_NOT_PINNED/, `${phase} refused with an approved rubric too`);
  }
  assert.equal(forbidden, 0);
});
