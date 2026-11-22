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
      copyFile: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./readiness16-qualification.js');

test('AC7 recipe: import and --plan are inert and declare ONE mutation (mark-ready of PR #5 by the App with a fresh readiness grant), everything else GET', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q16-readiness-v1');
  assert.match(plan.source, /q14-publication-v8\/control\.sqlite \(copied, never opened in place\)/);
  assert.deepEqual(plan.phases, ['preflight', 'convert', 'inspect']);
  assert.deepEqual(plan.expectedPullRequest, {
    number: 5,
    nodeId: 'PR_kwDOSuqsXs8AAAABPTSKww',
    headRef: 'factory/3-99fe871b',
    head: 'bfdd439ceba20a424538647f41e55d5ab2d03217',
    base: 'main',
  });
  assert.equal(plan.model, 'none');
  assert.ok(plan.github.writes.some((item: string) => /exactly ONE POST graphql markPullRequestReadyForReview/.test(item)));
  for (const never of ['convertPullRequestToDraft', 'merge', 'approval or review', 'comment', 'a second mutation'])
    assert.ok(plan.github.never.includes(never), never);
  assert.match(plan.runtime, /PRIVATE runtime root/);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['convert', 'again']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
