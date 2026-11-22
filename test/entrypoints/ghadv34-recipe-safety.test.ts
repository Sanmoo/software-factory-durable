import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-GH-ADV real-run recipe must be inert: no process, socket, filesystem or SDK effect; every real phase refuses
// before any effect while the three issues are not pinned.
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
      chmod: deny,
      rm: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./ghadv34-qualification.js');

test('R-GH-ADV recipe: import and --plan are inert; fresh namespace q34-ghadv-v5; unpinned issues refuse every phase before any effect', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-ghadv-v5');
  assert.match(plan.github.accessRoot, /^\/home\/sanmoo\/software-factory-test\/y5\/q34-ghadv-v5 \(own namespace/);
  assert.deepEqual(
    [plan.tickets.A.number, plan.tickets.B.number, plan.tickets.C.number, plan.pinned],
    [0, 0, 0, false],
    'the supervisor pins the three NEW issues in a reviewed commit',
  );
  assert.deepEqual(Object.keys(plan.obligations).sort(), ['V-04.b', 'V-04.d', 'V-04.e', 'V-10.f', 'V-10.g', 'V-11.c', 'V-13.g']);
  for (const phases of Object.values(plan.obligations) as string[][]) for (const phase of phases) assert.ok(plan.phases.includes(phase), phase);
  for (const change of plan.github.repositoryChanges) assert.ok(change.restore.length > 0, `every repository change names its restore: ${change.change}`);
  assert.ok(
    plan.github.repositoryChanges.some((item: { change: string; restore: string }) => /ruleset 26435808/.test(item.change) && /EXIT trap/.test(item.restore)),
  );
  assert.ok(
    plan.limits.some((item: string) => /no second HUMAN GitHub account/.test(item)),
    'the missing second human account is a recorded limit',
  );
  assert.ok(plan.github.never.includes('merge by the Factory') && plan.github.never.includes('App bypass'));
  assert.equal(plan.sentinelOperator, 'q34-ghadv-sentinel-operator');
  assert.equal(plan.phaseSpec.strangers.operators, 'sentinel');
  assert.equal(plan.phaseSpec.withdraw.builders, 0);
  for (const phase of ['merge-repair', 'close'] as const) assert.equal(plan.phaseSpec[phase].publication, false, `${phase}: no publication`);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['run', 'again']), /EXACT_PHASE_REQUIRED/);
  for (const phase of recipe.phases) await assert.rejects(recipe.main([phase]), /TICKET_NOT_PINNED/, `${phase} refused before any effect`);
  assert.equal(forbidden, 0);
});
