import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 30 LOCAL recipe must be inert: no process, socket, filesystem or SDK effect.
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
      request: deny,
      open: deny,
      mkdir: deny,
      readFile: deny,
      access: deny,
      readdir: deny,
      copyFile: deny,
      stat: deny,
      lstat: deny,
      realpath: deny,
      chmod: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./retention30-qualification.js');

test('recipe: import and --plan are inert; own namespace, COPY of q17-delivery-v4, local only, verdict declared; remote selections refused', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'sweep', 'inspect']);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q30-retention-v3');
  assert.equal(plan.source.storage, '/home/sanmoo/software-factory-test/y5/q17-delivery-v4/authority');
  assert.match(plan.network, /^none:/);
  assert.match(plan.effects[0], /COPY of q17-delivery-v4\/authority.*format-1 copy is migrated.*PRIVATE copy/);
  assert.match(plan.effects[1], /labelled synthetic session copy/);
  assert.match(plan.effects[2], /NEVER confirmed/);
  assert.ok(plan.verdict.some((item: string) => /protected is NOT met/.test(item)));
  assert.deepEqual(plan.localSelection, ['logs', 'sessions', 'environment']);
  assert.throws(() => recipe.localOnly(['logs', 'remote-branch']), /RECIPE_REMOTE_SELECTION_REFUSED/);
  assert.throws(() => recipe.localOnly([]), /RECIPE_REMOTE_SELECTION_REFUSED/);
  assert.deepEqual(recipe.localOnly(['logs']), ['logs']);
  await assert.rejects(recipe.main(['run']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
