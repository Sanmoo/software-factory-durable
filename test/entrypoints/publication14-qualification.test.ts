import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny, readdir: deny }, defaultExport: deny });
}
const recipe = await import('./publication14-qualification.js');

test('AC7 recipe: import and --plan are inert and declare the exact GitHub effects and bounds of the one-shot publication run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q14-publication-v6');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'discover', 'inspect', 'stop-environment']);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.equal(plan.github.writes.filter((item: string) => item.startsWith('Builder')).length, 2, 'one push and one draft PR');
  for (const never of ['merge', 'approval', 'ready-for-review conversion', 'push to main or any other branch']) assert.ok(plan.github.never.includes(never), never);
  assert.match(plan.requires, /factory-skills-v5 and factory-skills-v6/);
  assert.ok(plan.effects[0].includes('no `factory/3-` branch') && plan.effects[0].includes('NO bypass for the App'));
  assert.match(plan.github.appIdentity, /GET \/app/);
  assert.deepEqual([plan.model.providerRetries, plan.model.sdkRetries], [0, 0]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('AC7 recipe guards: one implementation Builder, its reviewers, then ONE publication Builder of another Execution; publish grants only on request', () => {
  const guard = recipe.activationGuard(2);
  const c = (role: string, executionId = 'e1', phaseId = 'builder-initial', workId = 'w') => ({ role, workId, executionId, phaseId });
  assert.equal(guard(c('builder', 'e1', 'builder-publication')), false, 'no publication first');
  assert.equal(guard(c('builder')), true);
  assert.equal(guard(c('standards'), { round: 1 }), true);
  assert.equal(guard(c('standards'), { round: 1 }), false, 'no reviewer retry of a round');
  assert.equal(guard(c('spec', 'e2'), { round: 1 }), false);
  assert.equal(guard(c('builder', 'e2')), false, 'a second implementation is refused');
  assert.equal(guard(c('builder', 'e2', 'builder-publication', 'other')), false, 'other Work');
  assert.equal(guard(c('builder', 'e2', 'builder-publication')), true);
  assert.equal(guard(c('builder', 'e3', 'builder-publication')), false, 'one publication only');
  assert.equal(guard(c('spec'), { round: 2 }), false, 'no reviewer after the publication started');
  const grants = recipe.grantGuard(2);
  const lifecycle = (publicationState: string | null, publicationActivation = false) => ({ publicationState, publicationActivation });
  assert.equal(grants(undefined, lifecycle(null)), true);
  assert.equal(grants('builder-publish', lifecycle(null)), false, 'never before Control requested it');
  assert.equal(grants('builder-publish', lifecycle('awaiting-discovery')), false, 'not after the activation ended');
  assert.equal(grants('builder-publish', lifecycle('requested')), true);
  // Review MED 5: the renewal of the RUNNING publication activation (attempt already recorded, awaiting-discovery) is its own lifecycle.
  assert.equal(grants('builder-publish', lifecycle('awaiting-discovery', true)), true);
  assert.equal(grants('builder-publish', lifecycle('awaiting-discovery', true)), false, 'bounded');
  assert.equal(grants('admin', lifecycle('requested')), false);
  const lost = recipe.lostResult();
  assert.equal(lost.refuses(['factory/3-x']), false);
  lost.provoke();
  assert.deepEqual([lost.refuses(['factory/3-x']), lost.refuses([])], [true, false], 'only own-branch discovery reads fail; admission reads stay');
});

test('AC5 recipe inspect: bash command texts are kept from the native JSONL, with tokens never copied', () => {
  const jsonl = [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash',
    arguments: { command: 'git push --force-with-lease=refs/heads/factory/3-x: origin d:refs/heads/factory/3-x # ghs_abcdefghijklmnopqrstuvwx' } }] } }), 'junk'].join('\n');
  assert.deepEqual(recipe.sessionCommands(jsonl), [{ name: 'bash', command: 'git push --force-with-lease=refs/heads/factory/3-x: origin d:refs/heads/factory/3-x # [TOKEN-PATTERN]' }]);
});
