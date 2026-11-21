import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-GH-ADV-S real-run recipe must be inert: no process, socket, filesystem or SDK effect; every real phase refuses
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
const recipe = await import('./ghadvs34-qualification.js');

test('R-GH-ADV-S recipe: import and --plan are inert; fresh namespace q34-ghadv-s-v2; ONE unpinned issue refuses every phase before any effect', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-ghadv-s-v2');
  assert.match(plan.github.accessRoot, /^\/home\/sanmoo\/software-factory-test\/y5\/q34-ghadv-s-v2 \(own namespace/);
  assert.deepEqual([plan.ticket.number, plan.ticket.pinned], [0, false], 'the supervisor pins the NEW issue in a reviewed commit');
  assert.deepEqual(Object.keys(plan.obligations).sort(), ['V-04.e', 'V-13.g'], 'V-10.g was approved by D-11 (q34-ghadv-v4)');
  assert.deepEqual(Object.keys(plan.extraEvidence), ['V-10.g'], 'its checks stay as extra evidence');
  for (const phases of Object.values(plan.obligations) as string[][]) for (const phase of phases) assert.ok(plan.phases.includes(phase), phase);
  assert.ok(plan.github.repositoryChanges.every((item: { restore: string }) => /EXIT trap/.test(item.restore)));
  assert.ok(plan.github.never.includes('merge by the Factory') && plan.github.never.includes('App bypass'));
  assert.equal(plan.phaseSpec.close.publication, false);
  assert.ok(
    plan.guards.some((item: string) => /holdReason/.test(item)),
    'every held phase names its reason',
  );
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  for (const phase of recipe.phases) await assert.rejects(recipe.main([phase]), /TICKET_NOT_PINNED/, `${phase} refused before any effect`);
  assert.equal(forbidden, 0);
});
