import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-LONG real-run recipe must be inert: no process, socket, filesystem, HTTP server or SDK effect. Every phase
// refuses while the issue is not pinned (number 0) — before any effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', 'node:http', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    access: deny, readdir: deny, copyFile: deny }, defaultExport: deny });
}
const recipe = await import('./long34-qualification.js');

test('R-LONG recipe: import and --plan are inert; own namespace; no timeout, production renewal, no clock injection; unpinned issue refuses every phase', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-long-v1');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.equal(plan.ticket.pinned, false);
  assert.equal(plan.repository.timeoutSeconds, undefined, 'no timeout configured');
  assert.match(plan.renewal.policy, /production default/);
  assert.equal(plan.hostClock.injected, false);
  assert.match(plan.hostClock.reason, /host-wide/);
  assert.match(plan.model, /no OAuth\/model request/);
  assert.match(plan.github.writes, /DELETE \/installation\/token/);
  assert.ok(plan.requires.some((item: string) => /explicit operator authorization for THIS run/.test(item)));
  for (const phase of ['preflight', 'run', 'inspect', 'stop-environment']) await assert.rejects(recipe.main([phase]), /TICKET_NOT_PINNED/, phase);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0, 'the refusals happen before any effect');
});
