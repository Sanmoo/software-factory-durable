import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny }, defaultExport: deny });
}
const recipe = await import('./builder09-qualification.js');

test('AC8 recipe: import and --plan are inert and declare the fixed bounds of the one-shot real Builder run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.deepEqual([plan.model.maxRequests, plan.model.providerRetries, plan.model.sdkRetries, plan.model.providerBillingHardCap], [60, 0, 0, false]);
  assert.match(plan.github.builderPurpose, /builder-start \{metadata:read, contents:read, issues:read\}/);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.deepEqual([plan.configuration.memoryMiB, plan.configuration.vcpus, plan.configuration.diskGiB], [4096, 2, 40]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main([]), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
