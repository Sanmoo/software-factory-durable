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
      spawn: deny,
      request: deny,
      open: deny,
      mkdir: deny,
      readFile: deny,
      access: deny,
      readdir: deny,
      copyFile: deny,
      writeFile: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./journey18-qualification.js');

test('ticket 18 recipe: import and --plan are inert; production composition, namespace q18-journey-v4, operator merge between run/ready and deliver', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q18-journey-v4');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'resume', 'ready', 'deliver', 'inspect', 'stop-environment']);
  assert.match(plan.composition.production, /composeProductionAccess .*composeProductionExecution/);
  assert.match(plan.composition.configuration, /readConfiguration/);
  assert.match(plan.composition.roots.github, /q18-journey-v4 .*COPY of \/home\/sanmoo\/software-factory-test\/y5\/credentials\/app\.pem/);
  assert.equal(plan.ticket.number, null, 'the synthetic issue is pinned by the supervisor after the operator authorization');
  assert.match(plan.ticket.body, /ask_user/);
  assert.match(plan.ticket.body, /`cd \/workspace\/checkout && test -f docs\/FACTORY_JOURNEY\.md/);
  assert.match(plan.expected.preflight, /restrictUpdates: true/);
  assert.match(plan.expected.run, /^question-published/);
  assert.ok(plan.expected.resume.some((line: string) => /MERGE_BLOCKED_UPDATE_RESTRICTED .*NO draft mutation/.test(line)));
  assert.ok(
    plan.expected.resume.some((line: string) => /origin github-comment, author = pinned operator/.test(line)),
    'the answer is a REAL comment',
  );
  assert.ok(plan.operatorSteps.some((line: string) => /posts, with the operator's gh account, EXACTLY run-result\.answer\.command/.test(line)));
  assert.ok(plan.github.never.includes('a local CLI answer'));
  assert.match(plan.github.guard, /access_tokens for exactly this repository/);
  assert.match(plan.github.guestPolicy, /backstop/);
  assert.ok(plan.operatorSteps.some((line: string) => /approve the own PR .*merge it with a merge commit.*then run `deliver`/.test(line)));
  for (const never of ['merge', 'approval or review', 'bypass', 'ruleset/protection change', 'implicit retry'])
    assert.ok(plan.github.never.includes(never), never);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['run', 'again']), /EXACT_PHASE_REQUIRED/);
  // Without a pinned issue every effect phase refuses before anything (no directory, intent, GitHub call or VM).
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/);
  await assert.rejects(recipe.main(['run']), /TICKET_NOT_PINNED/);
  assert.equal(forbidden, 0);
});
