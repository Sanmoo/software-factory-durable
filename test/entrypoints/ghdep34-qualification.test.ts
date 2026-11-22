import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the R-GH-DEP real-run recipe must be inert: no process, socket, filesystem or SDK effect; every phase refuses before
// any effect while the five issue numbers are not pinned.
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
      realpath: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./ghdep34-qualification.js');

test('R-GH-DEP recipe: import and --plan are inert; cross-repository setup by the operator, q25 copy with the environment removed in place, no VM/model', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q34-ghdep-v1');
  assert.deepEqual(plan.phases, ['preflight', 'cleanup-forget', 'unconfigured', 'configured', 'inspect']);
  assert.equal(plan.model, 'none');
  assert.match(plan.vm, /^none/);
  assert.ok(Object.values(plan.issues).every(item => (item as { pinned: boolean }).pinned === false));
  assert.equal(plan.configurationEntry, 'dependencyRepositories:\n  - {repository: Sanmoo/factory-dependency-fixture, installationId: 177599217}\n');
  const repositories = plan.humanSteps.repositories.apply as string[];
  assert.ok(repositories.some(line => line.startsWith('gh repo create Sanmoo/factory-dependency-fixture --public')));
  assert.ok(repositories.some(line => line.startsWith('gh repo create Sanmoo/factory-dependency-hidden --private')));
  assert.ok(
    repositories[0]!.startsWith("gh auth status 2>&1 | grep -i 'token scopes' | grep -q delete_repo"),
    'teardown needs delete_repo: checked first, scopes only',
  );
  assert.ok(!repositories[0]!.includes('--show-token') && !repositories[0]!.includes('auth token'), 'never prints the token');
  assert.ok(plan.humanSteps.installation.apply.at(-1).includes('--probe-installation'));
  const relations = (plan.humanSteps.issues.apply as string[]).filter(line => line.includes('/dependencies/blocked_by'));
  assert.equal(relations.length, 3);
  assert.ok(relations.every(line => line.startsWith('gh api --method POST repos/Sanmoo/java-springboot-event-sourcing/issues/$A')));
  assert.ok(plan.humanSteps['close-blockers'].restore[0].startsWith('gh issue reopen 18'));
  assert.match(plan.q25.storagePolicy, /^COPY/);
  assert.match(plan.q25.environmentPolicy, /^IN PLACE/);
  assert.match(plan.github.guard, /GET-only guard/);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/, 'refused before any effect while the issues are not pinned');
  assert.equal(forbidden, 0);
});
