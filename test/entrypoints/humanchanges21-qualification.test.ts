import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect. Guards on controlled data only.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    access: deny, readdir: deny, copyFile: deny, chmod: deny, rm: deny }, defaultExport: deny });
}
const recipe = await import('./humanchanges21-qualification.js');

test('ticket 21 recipe: import and --plan are inert; own namespace and access root, pinned NEW issue, explicit human steps and leases', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q21-human-v6');
  assert.match(plan.github.accessRoot, /^\/home\/sanmoo\/software-factory-test\/y5\/q21-human-v6 \(own namespace: credentials\/ copy of \/home\/sanmoo\/software-factory-test\/y5\/credentials\/app\.pem/);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'race', 'reconcile', 'finish', 'inspect', 'stop-environment']);
  assert.equal(plan.ticket.pinned, false, 'the supervisor pins the NEW issue number in a reviewed commit before any phase');
  assert.match(plan.ticket.body, /docs\/FACTORY_HUMAN_CHANGES\.md/);
  assert.match(plan.ticket.body, /Documentation only/);
  assert.equal(plan.github.human.length, 4, 'two human pushes and two answers, all with the operator account');
  assert.ok(plan.github.human.every((item: string) => /operator/.test(item)));
  for (const never of ['merge', 'approval', 'ready-for-review conversion', 'bare --force or a lease without an explicit oid', 'rewrite of the base', 'any write by this recipe itself']) {
    assert.ok(plan.github.never.includes(never), never);
  }
  assert.ok(plan.expected.some((item: string) => item.includes('LEASE_FAILED')) && plan.expected.some((item: string) => item.includes('--force-with-lease=refs/heads/<branch>:C2')));
  assert.deepEqual([plan.model.providerRetries, plan.model.sdkRetries], [0, 0]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/, 'refused before any effect while the issue is not pinned');
  assert.equal(forbidden, 0);
});

test('phase guard: each phase once, in order, only after the previous one succeeded; nothing before the issue is pinned', () => {
  const none = new Set<string>();
  assert.equal(recipe.phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(recipe.phaseGuard('preflight', {}, none, true), null);
  assert.equal(recipe.phaseGuard('preflight', {}, new Set(['preflight-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(recipe.phaseGuard('run', { preflight: { status: 'held' } }, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('race', { preflight: { status: 'success' } }, none, true), 'RUN_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('reconcile', { race: { status: 'held' } }, none, true), 'RACE_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('finish', { reconcile: { status: 'success' } }, none, true), null);
  // Real run q21-human-v6: inspect runs after ANY held phase (it observes, it never continues), but never while a phase is still running.
  const ok = { preflight: { status: 'success' } };
  assert.equal(recipe.phaseGuard('inspect', ok, new Set(['preflight-intent', 'run-intent', 'race-intent', 'reconcile-intent']), true, new Set(['preflight', 'run', 'race', 'reconcile'])), null);
  assert.equal(recipe.phaseGuard('inspect', ok, new Set(['preflight-intent', 'run-intent']), true, new Set(['preflight'])), 'PHASE_NOT_ENDED:run');
  assert.equal(recipe.phaseGuard('inspect', {}, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('stop-environment', {}, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
});

test('activation guard: the exact Builder sequence of each phase; reviewers only for its implementation; publish grants only where a publication belongs', () => {
  const c = (role: string, phaseId: string, executionId = 'e1', workId = 'w') => ({ role, workId, executionId, phaseId });
  const race = recipe.activationGuard('race', 2);
  assert.equal(race(c('builder', 'builder-publication')), false, 'no publication first');
  assert.equal(race(c('builder', 'builder-initial')), false, 'race starts from the scope update (continuation/recovery), never /implement');
  assert.equal(race(c('builder', 'builder-continuation')), true);
  assert.equal(race(c('standards', 'p'), { round: 3 }), true);
  assert.equal(race(c('standards', 'p'), { round: 3 }), false, 'no reviewer retry of a round');
  assert.equal(race(c('spec', 'p', 'e9'), { round: 3 }), false, 'reviewers of another Execution');
  assert.equal(race(c('builder', 'builder-publication', 'e1')), false, 'the publication is another Execution');
  assert.equal(race(c('builder', 'builder-publication', 'e2')), true);
  assert.equal(race(c('spec', 'p'), { round: 4 }), false, 'no reviewer after the publication');
  assert.equal(race(c('builder', 'builder-publication', 'e3')), false, 'nothing after the sequence');
  const reconcile = recipe.activationGuard('reconcile');
  assert.equal(reconcile(c('builder', 'builder-recovery')), false);
  assert.equal(reconcile(c('builder', 'builder-reconciliation')), true);
  assert.equal(reconcile(c('builder', 'builder-publication', 'e2')), false, 'reconcile never publishes (a new human change is expected first)');
  const grants = recipe.grantGuard('reconcile');
  assert.equal(grants('builder-start', { publicationState: 'reconciling', publicationActivation: false }), true);
  assert.equal(grants('builder-publish', { publicationState: 'requested', publicationActivation: false }), false);
  const finish = recipe.grantGuard('finish', 2);
  assert.equal(finish('builder-publish', { publicationState: 'awaiting-discovery', publicationActivation: false }), false, 'only while Control requested it');
  assert.equal(finish('builder-publish', { publicationState: 'requested', publicationActivation: false }), true);
  assert.equal(finish('builder-publish', { publicationState: 'awaiting-discovery', publicationActivation: true }), true, 'its renewal');
  assert.equal(finish('builder-publish', { publicationState: 'awaiting-discovery', publicationActivation: true }), false, 'at most 2');
});

test('human step detection: only ONE fast-forward commit on top of the expected tip is the planned human push; push commands must name their exact lease', () => {
  const expected = 'd'.repeat(40);
  assert.deepEqual(recipe.humanPushObserved(expected, { state: 'present', sha: expected }, undefined), { kind: 'waiting' });
  assert.deepEqual(recipe.humanPushObserved(expected, { state: 'present', sha: '1'.repeat(40) }, { state: 'complete', status: 'ahead', aheadBy: 1, behindBy: 0 }),
    { kind: 'observed', sha: '1'.repeat(40) });
  assert.deepEqual(recipe.humanPushObserved(expected, { state: 'present', sha: '1'.repeat(40) }, { state: 'complete', status: 'diverged', aheadBy: 1, behindBy: 1 }),
    { kind: 'unexpected', reason: 'NOT_ONE_FAST_FORWARD_COMMIT:diverged' }, 'a force-push by the human is not the planned step');
  assert.deepEqual(recipe.humanPushObserved(expected, { state: 'present', sha: '1'.repeat(40) }, { state: 'unknown' }), { kind: 'unexpected', reason: 'COMPARISON_UNKNOWN' });
  const branch = 'factory/9-0b9c6a52';
  const h2 = 'e'.repeat(40);
  const leased = (oid: string) => `git -C /workspace/checkout push --force-with-lease=refs/heads/${branch}:${oid} origin ${h2}:refs/heads/${branch}`;
  const recorded = [{ branch, expected: expected, head: h2 }, { branch, expected: null, head: h2 }];
  assert.deepEqual(recipe.pushViolations([leased(expected), `git -C /workspace/checkout push --force-with-lease=refs/heads/${branch}: origin ${h2}:refs/heads/${branch}`,
    'git ls-remote origin', 'git fetch origin', 'gh pr edit 4 --body-file x'], recorded), []);
  assert.equal(recipe.pushViolations([leased('1'.repeat(40))], recorded).length, 1, 'a recaptured oid is a violation even with an explicit lease');
  for (const command of [`git push --force origin HEAD:refs/heads/${branch}`, `git push origin +HEAD:refs/heads/${branch}`, `git push -u origin ${branch}`, `git push -f origin ${branch}`,
    `git push --force-with-lease origin HEAD:refs/heads/${branch}`, `gh api -X PATCH repos/a/b/git/refs/heads/${branch} -f sha=${h2}`]) {
    assert.equal(recipe.pushViolations([command], recorded).length, 1, command);
  }
  const script = recipe.humanCommands(1, branch, expected);
  assert.ok(script.startsWith('set -euo pipefail\n') && script.includes(`if [ "$(git rev-parse HEAD)" != "${expected}" ]; then`) && script.includes('exit 1; fi'));
  assert.ok(script.trimEnd().endsWith(`git push origin HEAD:refs/heads/${branch}`) && !/--force|\s\+HEAD/.test(script), 'a plain fast-forward push only');
});

test('controller write guard: only Question comments on the pinned issue reach the tracker', async () => {
  const sent: unknown[] = [];
  const logged: unknown[] = [];
  type Tracker = Parameters<typeof recipe.guardTracker>[0];
  const guarded = recipe.guardTracker({ async postComment(ticket: { number: number }, comment: { kind: string }) { sent.push([ticket.number, comment.kind]); return { kind: 'published' }; } } as unknown as Tracker,
    entry => logged.push(entry));
  const post = (number: number, kind: string) => guarded.postComment({ number } as never, { kind } as never, {} as never);
  // The pinned number is 0 in this revision: every comment is refused (nothing sent).
  await assert.rejects(post(3, 'question'), /RECIPE_WRITE_GUARD/);
  await assert.rejects(post(0, 'label'), /RECIPE_WRITE_GUARD/);
  assert.deepEqual(sent, []);
  assert.equal(logged.length, 2);
});

test('real-run q21-human-v1 race fix: a Work still PUBLISHED at its starting basis (scope update accepted, not dispatched yet) does not end the race phase', () => {
  const work = (state: string, basisExecutionId: string, divergences: unknown[] = []) => ({ publication: { state, basisExecutionId, divergences }, execution: { state: 'ended' } }) as never;
  const none = () => false;
  assert.deepEqual(recipe.settled('race', work('published', 'run-basis'), none, 'run-basis'), { done: false, success: false }, 'the update has not been dispatched yet');
  assert.deepEqual(recipe.settled('race', work('awaiting-discovery', 'update-basis'), none, 'run-basis'), { done: false, success: false });
  assert.deepEqual(recipe.settled('race', work('published', 'update-basis'), none, 'run-basis'), { done: true, success: false }, 'updated without any divergence: not the expected race');
  assert.deepEqual(recipe.settled('race', work('diverged', 'update-basis', [{ questionId: 'q', trigger: 'lease-failed' }]), () => true, 'run-basis'), { done: true, success: true });
  assert.deepEqual(recipe.settled('run', work('published', 'run-basis'), none, null), { done: true, success: true });
});

test('v2 review: at every phase end the boots the phase started are stopped and their cessation confirmed; anything else is unconfirmed', async () => {
  const calls: string[] = [];
  const conditions: Record<string, string[]> = { b1: ['active', 'stopped'], b2: ['stopped'], b3: ['active', 'active'] };
  const sandbox = { async observe(input: { boot: never }) { calls.push(`observe:${input.boot}`); return { condition: conditions[input.boot as string]!.shift()! }; },
    async stop(input: { boot: never }) { calls.push(`stop:${input.boot}`); return { status: 'success', cessationConfirmed: input.boot !== 'b3' }; } };
  const results = await recipe.ceaseStartedBoots(sandbox, [{ environment: 'e', boot: 'b1' }, { environment: 'e', boot: 'b2' }, { environment: 'e', boot: 'b3' }], () => {});
  assert.deepEqual(results.map(item => [item.boot, item.stopped, item.confirmed]), [['b1', true, true], ['b2', false, true], ['b3', true, false]]);
  assert.deepEqual(calls, ['observe:b1', 'stop:b1', 'observe:b1', 'observe:b2', 'observe:b3', 'stop:b3', 'observe:b3']);
  const failing = await recipe.ceaseStartedBoots({ async observe() { throw new Error('SANDBOX_UNAVAILABLE'); }, async stop() { return { status: 'success' }; } },
    [{ environment: 'e', boot: 'b4' }], () => {});
  assert.deepEqual(failing, [{ boot: 'b4', before: 'unknown', stopped: false, confirmed: false, code: 'SANDBOX_UNAVAILABLE' }]);
  assert.match(recipe.plan().guards.join(' '), /human steps wait at most 60 min/);
});

test('real run q21-human-v4: the reconcile phase allows ONE operational recovery of its reconciliation (another Execution), nothing more', () => {
  const guard = recipe.activationGuard('reconcile');
  const c = (role: string, executionId: string) => ({ role, workId: 'w', executionId, phaseId: 'builder-reconciliation' });
  assert.equal(guard(c('builder', 'r1')), true);
  assert.equal(guard(c('builder', 'r1')), false, 'not the same Execution');
  assert.equal(guard(c('builder', 'r2')), true, 'its recovery');
  assert.equal(guard(c('standards', 'r2'), { round: 5 }), true, 'reviewers of the recovery');
  assert.equal(guard(c('standards', 'r1'), { round: 6 }), false);
  assert.equal(guard(c('builder', 'r3')), false, 'one recovery only');
});
