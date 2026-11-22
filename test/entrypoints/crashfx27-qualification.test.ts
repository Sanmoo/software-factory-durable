import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect. Every phase refuses while the issue
// is not pinned (number 0) — before any effect.
let forbidden = 0;
const deny = () => {
  forbidden++;
  throw new Error('FORBIDDEN_EFFECT');
};
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
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
      access: deny,
      readdir: deny,
      copyFile: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./crashfx27-qualification.js');

test('ticket 27 recipe: import and --plan are inert; own namespace q27-crashfx-v3; the cuts and the never-list are explicit; unpinned issue refuses every phase', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q27-crashfx-v3');
  assert.deepEqual(plan.phases, ['preflight', 'ask', 'publish', 'inspect', 'stop-environment']);
  assert.deepEqual(plan.steps, ['a-ask', 'b-discover-question', 'c-publish', 'd-discover-publication']);
  assert.equal(plan.ticket.pinned, false);
  assert.match(plan.github.accessRoot, /own namespace: credentials\/ copy of \/home\/sanmoo\/software-factory-test\/y5\/credentials\/app\.pem/);
  for (const never of [
    'merge',
    'approval',
    'ready-for-review conversion',
    'bare --force or a lease without an explicit oid',
    'branch deletion/cleanup',
    'any write by this recipe itself',
  ]) {
    assert.ok(plan.github.never.includes(never), never);
  }
  assert.ok(plan.requires.some((item: string) => /explicit operator authorization for THIS run/.test(item)));
  for (const phase of ['preflight', 'ask', 'publish', 'inspect', 'stop-environment']) await assert.rejects(recipe.main([phase]), /TICKET_NOT_PINNED/, phase);
  await assert.rejects(recipe.main(['child', 'a-ask']), /TICKET_NOT_PINNED/, 'a child step refuses too');
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0, 'the refusals happen before any effect');
});
