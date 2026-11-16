import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-CRASH-A real-run recipe must be inert: no process, socket, filesystem or SDK effect. Every phase and child step
// refuses while the two issues are not pinned (number 0) — before any effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', 'node:http', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    access: deny, readdir: deny, copyFile: deny }, defaultExport: deny });
}
const recipe = await import('./crasha34-qualification.js');

test('R-CRASH-A recipe: import and --plan are inert; own namespace; two lines, the cuts, host effects and never-list explicit; unpinned issues refuse every phase', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-crash-a-v2');
  assert.deepEqual(plan.phases, ['preflight', 'cache', 'sources', 'tool', 'inspect', 'stop-environment']);
  assert.deepEqual(plan.steps, ['c1-cache-cut', 'c2-cache-reconcile', 's1-sources-cut', 's2-sources-recovery', 't1-tool-cut', 'h1-handoff-cut', 'f1-final']);
  assert.equal(plan.tickets.pinned, false);
  assert.notEqual(plan.storages.cache, plan.storages.main, 'each line has its own storage');
  assert.ok(plan.hostEffects.some((item: string) => /systemctl --user freeze factory-sandbox-<boot>\.service/.test(item)));
  for (const never of ['push', 'pull request', 'merge', 'approval', 'branch deletion/cleanup', 'any write by this recipe itself']) assert.ok(plan.github.never.includes(never), never);
  assert.match(plan.model.cacheLine, /no Builder/);
  assert.ok(plan.requires.some((item: string) => /explicit operator authorization for THIS run, including host fault injection/.test(item)));
  for (const phase of ['preflight', 'cache', 'sources', 'tool', 'inspect', 'stop-environment']) await assert.rejects(recipe.main([phase]), /TICKET_NOT_PINNED/, phase);
  await assert.rejects(recipe.main(['child', 'c1-cache-cut']), /TICKET_NOT_PINNED/, 'a child step refuses too');
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0, 'the refusals happen before any effect');
});
