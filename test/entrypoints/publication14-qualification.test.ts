import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect.
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
    },
    defaultExport: deny,
  });
}
const recipe = await import('./publication14-qualification.js');

test('AC7 recipe: import and --plan are inert and declare the exact GitHub effects and bounds of the one-shot publication run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q14-publication-v8');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'discover', 'inspect', 'stop-environment']);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.equal(plan.github.writes.filter((item: string) => item.startsWith('Builder')).length, 2, 'one push and one draft PR');
  assert.ok(
    plan.github.writes.some((item: string) =>
      item.startsWith('discover (only in the PR-only recovery): at most 1 draft pull request creation by the Builder, never a push'),
    ),
  );
  for (const never of ['merge', 'approval', 'ready-for-review conversion', 'push to main or any other branch'])
    assert.ok(plan.github.never.includes(never), never);
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
  const jsonl = [
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'bash',
            arguments: { command: 'git push --force-with-lease=refs/heads/factory/3-x: origin d:refs/heads/factory/3-x # ghs_abcdefghijklmnopqrstuvwx' },
          },
        ],
      },
    }),
    'junk',
  ].join('\n');
  assert.deepEqual(recipe.sessionCommands(jsonl), [
    { name: 'bash', command: 'git push --force-with-lease=refs/heads/factory/3-x: origin d:refs/heads/factory/3-x # [TOKEN-PATTERN]' },
  ]);
});

test('real-run fix recipe: the v6 leftover branch is tolerated only at its exact tip; the discover phase allows ONE PR-only continuation only', () => {
  const leftover = 'refs/heads/factory/3-28c75e5a';
  assert.deepEqual(recipe.unexpectedFactoryBranches({ 'refs/heads/main': 'b'.repeat(40), [leftover]: '8c0495962444a3cd9331d83529c10d6eead6422e' }), []);
  assert.deepEqual(recipe.unexpectedFactoryBranches({ [leftover]: 'e'.repeat(40) }), [leftover], 'another tip of the leftover is not tolerated');
  assert.deepEqual(recipe.unexpectedFactoryBranches({ 'refs/heads/factory/3-0b9c6a52': 'e'.repeat(40) }), ['refs/heads/factory/3-0b9c6a52']);
  const head = 'd'.repeat(40);
  const guard = recipe.recoveryGuard();
  assert.equal(
    guard.prepare({ state: 'requested', expectedRemote: { state: 'absent' }, verified: { head } }),
    false,
    'a pushing request is never allowed in discover',
  );
  assert.equal(guard.issue('builder-publish', { state: 'requested', expectedRemote: { state: 'absent' }, verified: { head } }, false), false);
  assert.equal(guard.activate({ role: 'builder', phaseId: 'builder-publication' }), false, 'not before its own prepare');
  const prOnly = { state: 'requested', expectedRemote: { state: 'present', sha: head }, verified: { head } };
  assert.equal(guard.prepare(prOnly), true);
  assert.equal(guard.prepare(prOnly), false, 'once');
  assert.equal(guard.issue('builder-start', prOnly, false), false);
  assert.equal(guard.issue('builder-publish', prOnly, false), true);
  assert.equal(guard.activate({ role: 'standards', phaseId: 'review-r1' }), false);
  assert.equal(guard.activate({ role: 'builder', phaseId: 'builder-publication' }), true);
  assert.equal(guard.activate({ role: 'builder', phaseId: 'builder-publication' }), false, 'once');
  assert.equal(guard.issue('builder-publish', { ...prOnly, state: 'awaiting-discovery' }, true), true, 'its renewal');
  assert.equal(guard.issue('builder-publish', { ...prOnly, state: 'awaiting-discovery' }, true), false, 'bounded');
});
