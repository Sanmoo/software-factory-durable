import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 17 real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny,
    readdir: deny, copyFile: deny, stat: deny, lstat: deny }, defaultExport: deny });
}
const recipe = await import('./delivery17-qualification.js');

test('AC7 recipe: import and --plan are inert; the plan declares the human merge as an operator step and the exact GitHub/host effects', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'deliver', 'retry', 'inspect']);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q17-delivery-v1');
  assert.deepEqual(plan.operatorStep.between, ['preflight', 'deliver']);
  assert.match(plan.operatorStep.who, /never the Factory/);
  assert.match(plan.github.writes[0], /at most ONE atomic conditional deletion .*own branch.*KEPT/);
  assert.ok(plan.github.never.includes('merge') && plan.github.never.includes('deleting any other branch or tag'));
  assert.match(plan.effects.join('\n'), /PROVOKED to fail \(every call in deliver/);
  await assert.rejects(recipe.main(['merge']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('AC7 recipe: EVERY branch deletion is guarded: none reaches GitHub in deliver, at most one in retry; refs diff shows only what disappeared', async () => {
  let real = 0;
  const cleanupBranch = async () => { real++; return { outcome: 'removed' as const, code: 'BRANCH_DELETED', observedAt: 'x', tip: null, revocation: 'revoked', nextStep: '', effectId: 'e' }; };
  const selection = { repo: { repository: 'a/b', installationId: 1, workflows: false }, repositoryId: 1, branch: 'factory/3-x', base: 'main', expectedTip: 'a'.repeat(40),
    pullRequest: { number: 1, pullRequestId: 1 } };
  const deliver = recipe.branchGuard(cleanupBranch, 'deliver');
  assert.equal((await deliver.cleanupBranch(selection, { effectId: 'e1' })).code, 'RECIPE_PROVOKED_FAILURE');
  assert.equal((await deliver.cleanupBranch(selection, { effectId: 'e2' })).code, 'RECIPE_PROVOKED_FAILURE', 'every call in deliver, not only the first');
  assert.equal(real, 0, 'nothing sent in deliver');
  const retry = recipe.branchGuard(cleanupBranch, 'retry');
  assert.equal((await retry.cleanupBranch(selection, { effectId: 'e3' })).outcome, 'removed');
  assert.equal((await retry.cleanupBranch(selection, { effectId: 'e4' })).code, 'RECIPE_ONE_DELETE_GUARD');
  assert.equal(real, 1, 'at most one real deletion attempt per recipe');
  assert.deepEqual(retry.calls.map(item => item.real), [true, false]);
  assert.deepEqual(recipe.refsDiff({ 'refs/heads/main': 'm', 'refs/heads/factory/3-x': 'a', 'refs/tags/v1': 't' }, { 'refs/heads/main': 'm', 'refs/tags/v1': 't' }),
    { removed: ['refs/heads/factory/3-x'], added: [], moved: [] });
  assert.equal(recipe.plan().execution.capacity, 0, 'deliver/retry never reserve a Slot or hold another Work');
  assert.equal(forbidden, 0);
});
