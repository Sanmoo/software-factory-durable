import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { WorkView } from '../../src/control/index.js';

// Import and --plan of the ticket 22 real-run recipe must be inert: no process, socket, filesystem or SDK effect. Guards on controlled data only.
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
const recipe = await import('./repair22-qualification.js');

test('ticket 22 recipe: import and --plan are inert; own namespace and key copy, pinned NEW issue, human merges by the operator only, no repository setup beyond 14-21', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q22-repair-v1');
  assert.match(
    plan.github.accessRoot,
    /^\/home\/sanmoo\/software-factory-test\/y5\/q22-repair-v1 \(own namespace: credentials\/ copy of \/home\/sanmoo\/software-factory-test\/y5\/credentials\/app\.pem/,
  );
  assert.deepEqual(plan.phases, ['preflight', 'run', 'advance', 'conflict', 'inspect', 'stop-environment']);
  assert.equal(plan.ticket.pinned, false, 'the supervisor pins the NEW issue number in a reviewed commit before any phase');
  assert.match(plan.ticket.body, /docs\/FACTORY_REPAIR\.md/);
  assert.equal(plan.repository.correctionLimit, 1);
  assert.match(plan.keyLifecycle, /AFTER its phase guard and intent tombstone.*removes the copy in its finally/);
  assert.equal(plan.humanSteps[2].file, 'docs/FACTORY_REPAIR.md', 'step 2 adds the SAME path: a confirmed add/add conflict');
  assert.notEqual(plan.humanSteps[1].file, plan.humanSteps[2].file, 'step 1 only advances the base');
  assert.ok(plan.github.human.every((item: string) => /operator/.test(item)));
  for (const never of [
    'merge of the Factory PR',
    'approval',
    'ready-for-review conversion',
    'bare --force or a lease without an explicit oid',
    'rewrite of the base',
    'change of base protection, rulesets, workflows or required checks',
    'any write by this recipe itself',
  ])
    assert.ok(plan.github.never.includes(never), never);
  assert.ok(plan.expected.some((item: string) => item.includes('--force-with-lease=refs/heads/<branch>:H1 origin H2')));
  assert.deepEqual([plan.model.providerRetries, plan.model.sdkRetries], [0, 0]);
  assert.deepEqual(plan.model.builderActivations.advance, [], 'advance launches nothing');
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/, 'refused before any effect while the issue is not pinned');
  assert.equal(forbidden, 0);
});

test('phase guard and activation/grant guards: order, one shot, advance refuses every activation, conflict = repair then publication', () => {
  const none = new Set<string>();
  assert.equal(recipe.phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(recipe.phaseGuard('advance', { run: { status: 'held' } }, none, true), 'RUN_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('conflict', { advance: { status: 'success' } }, none, true), null);
  assert.equal(recipe.phaseGuard('conflict', { advance: { status: 'success' } }, new Set(['conflict-intent']), true), 'PHASE_ALREADY_RAN');
  const c = (role: string, phaseId: string, executionId = 'e1') => ({ role, workId: 'w', executionId, phaseId });
  const advance = recipe.activationGuard('advance');
  assert.equal(advance(c('builder', 'builder-continuation')), false);
  assert.equal(recipe.grantGuard('advance')('builder-start', { publicationState: 'published', publicationActivation: false }), false);
  const conflict = recipe.activationGuard('conflict', 2);
  assert.equal(conflict(c('builder', 'builder-initial')), false, 'never /implement again');
  assert.equal(conflict(c('builder', 'builder-continuation')), true);
  assert.equal(conflict(c('spec', 'p'), { round: 3 }), true);
  assert.equal(conflict(c('builder', 'builder-publication', 'e2')), true);
  assert.equal(conflict(c('builder', 'builder-continuation', 'e3')), false, 'nothing after the sequence (no second repair)');
  const grants = recipe.grantGuard('conflict', 2);
  assert.equal(grants('builder-publish', { publicationState: 'published', publicationActivation: false }), false);
  assert.equal(grants('builder-publish', { publicationState: 'requested', publicationActivation: false }), true);
  assert.deepEqual(recipe.baseMoved('b'.repeat(40), 'b'.repeat(40)), { kind: 'waiting' });
  assert.deepEqual(recipe.baseMoved('b'.repeat(40), 'c'.repeat(40)), { kind: 'observed', sha: 'c'.repeat(40) });
  const commands = recipe.humanCommands(2, 'b'.repeat(40));
  assert.ok(
    commands.some(item => item.includes(`test "$(git rev-parse origin/main)" = "${'b'.repeat(40)}"`)) && commands.at(-1)!.startsWith('gh pr merge q22-human-2'),
  );
  assert.ok(
    !commands.some(item => /--force|--admin|factory\//.test(item.split('#')[0]!)),
    "the operator pushes and merges only the operator's own branch, plainly",
  );
});

test('settled: advance succeeds only with nothing triggered; conflict only with ONE published, charged correction and a quiet window', () => {
  const work = (extra: Partial<WorkView>) =>
    ({
      publication: { state: 'published' },
      execution: null,
      impediments: [],
      correction: null,
      corrections: [],
      budget: { corrections: { consumed: 0 } },
      ...extra,
    }) as unknown as WorkView;
  const quiet = { activations: 0, humanObserved: true, quietCyclesDone: true };
  assert.deepEqual(recipe.settled('advance', work({}), quiet), { done: true, success: true });
  assert.deepEqual(recipe.settled('advance', work({}), { ...quiet, quietCyclesDone: false }), { done: false, success: false });
  assert.deepEqual(
    recipe.settled('advance', work({ correction: { correctionId: 'c' } as never }), quiet),
    { done: true, success: false },
    'a base advance must not open a correction',
  );
  const closed = { correctionId: 'c', outcome: 'published', charged: true } as never;
  assert.deepEqual(
    recipe.settled('conflict', work({ corrections: [closed], budget: { corrections: { consumed: 1 } } as never }), { ...quiet, activations: 2 }),
    { done: true, success: true },
  );
  assert.deepEqual(recipe.settled('conflict', work({ corrections: [closed, closed] }), { ...quiet, activations: 2 }), { done: true, success: false });
  assert.deepEqual(recipe.settled('conflict', work({ impediments: [{ code: 'REPAIR_EVENT_ALREADY_TREATED' }] as never }), quiet), {
    done: true,
    success: false,
  });
  assert.deepEqual(recipe.settled('conflict', work({ correction: { correctionId: 'c' } as never }), quiet), { done: false, success: false });
});
