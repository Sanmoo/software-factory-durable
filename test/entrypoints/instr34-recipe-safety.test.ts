import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-INSTR real-run recipe must be inert: no process, socket, filesystem or SDK effect; every real phase refuses
// before any effect while the issue is not pinned.
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
      spawnSync: deny,
      request: deny,
      open: deny,
      mkdir: deny,
      readFile: deny,
      writeFile: deny,
      access: deny,
      readdir: deny,
      copyFile: deny,
      chmod: deny,
      rm: deny,
      lstat: deny,
      stat: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./instr34-qualification.js');

test('R-INSTR recipe: import and --plan are inert; namespace q34-instr-v1 on the y5 root; issue 0 refuses every phase before any effect', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-instr-v1');
  assert.equal(plan.root, '/home/sanmoo/software-factory-test/y5');
  assert.deepEqual([plan.ticket.number, plan.ticket.pinned], [0, false], 'the supervisor pins the NEW issue in a reviewed commit');
  assert.deepEqual(Object.keys(plan.obligations), ['V-07.f']);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'cancel', 'inspect', 'stop-environment']);
  assert.ok(plan.github.never.includes('merge') && plan.github.never.includes('any GitHub write by this recipe itself'));
  assert.ok(plan.guards.some((item: string) => /SIGTERM\/SIGINT/.test(item)) && plan.guards.some((item: string) => /teardown FIRST/.test(item)));
  assert.match(plan.toleratedQuestion, /ONE per run/);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  for (const phase of recipe.phases) await assert.rejects(recipe.main([phase]), /TICKET_NOT_PINNED/, `${phase} refused before any effect`);
  assert.equal(forbidden, 0);
});
