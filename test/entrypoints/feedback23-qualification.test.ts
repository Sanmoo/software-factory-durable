import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { WorkView } from '../../src/control/index.js';

// Import and --plan of the ticket 23 real-run recipe must be inert: no process, socket, filesystem or SDK effect. Guards on controlled data only.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    access: deny, readdir: deny, copyFile: deny, chmod: deny, rm: deny }, defaultExport: deny });
}
const recipe = await import('./feedback23-qualification.js');

test('ticket 23 recipe: import and --plan are inert; own namespace, per-phase key copy, pinned NEW issue, every human step by the operator with its exact command', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q23-feedback-v2');
  assert.match(plan.github.accessRoot, /^\/home\/sanmoo\/software-factory-test\/y5\/q23-feedback-v2 \(own namespace: credentials\/ per-phase copy of \/home\/sanmoo\/software-factory-test\/y5\/credentials\/app\.pem/);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'review', 'command', 'withdraw', 'inspect', 'stop-environment']);
  assert.equal(plan.ticket.pinned, false, 'the supervisor pins the NEW issue number in a reviewed commit before any phase');
  assert.ok(plan.humanStepMinutes >= 60, 'each human step waits at least 60 minutes');
  assert.ok(plan.github.human.every((item: string) => /the operator/.test(item)));
  assert.match(plan.github.reads[0], /feedback-read \{metadata:read, pull_requests:read, issues:read\}/);
  for (const never of ['merge of the Factory PR', 'approval or dismissal by the Factory', 'ready-for-review conversion', 'bare --force or a lease without an explicit oid',
    'change of base protection, rulesets, workflows or required checks', 'any write by this recipe itself']) assert.ok(plan.github.never.includes(never), never);
  assert.ok(plan.guards.includes('every Control phase stops its own boots in finally and records the cessation'));
  assert.deepEqual([plan.model.providerRetries, plan.model.sdkRetries, plan.model.builderActivations.withdraw], [0, 0, []]);
  // The exact human commands: the operator's own gh login; a review, a /factory comment and an approval of the OWN PR; never merge/admin/force.
  assert.equal(recipe.humanCommand(1, 12).split('   #')[0], "gh pr review 12 --repo Sanmoo/java-springboot-event-sourcing --request-changes --body 'Please add a `## Review notes` section at the end of docs/FACTORY_FEEDBACK.md with exactly one line: `Requested by an operator review.`'");
  assert.match(recipe.humanCommand(2, 12), /^gh pr comment 12 --repo \S+ --body '\/factory repair Add a line/);
  assert.match(recipe.humanCommand(5, 12), /^gh pr review 12 --repo \S+ --approve --body /);
  for (const step of [1, 2, 3, 4, 5] as const) assert.ok(!/merge|--admin|--force|dismiss/.test(recipe.humanCommand(step, 12).split('#')[0]!), `step ${step}`);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKET_NOT_PINNED/, 'refused before any effect while the issue is not pinned (issue number 0)');
  assert.equal(forbidden, 0);
});

test('phase/activation/grant guards: order, one shot, withdraw refuses every activation, command allows at most two repair+publication pairs', () => {
  const none = new Set<string>();
  assert.equal(recipe.phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(recipe.phaseGuard('review', { run: { status: 'held' } }, none, true), 'RUN_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('withdraw', { command: { status: 'success' } }, none, true), null);
  assert.equal(recipe.phaseGuard('command', { review: { status: 'success' } }, new Set(['command-intent']), true), 'PHASE_ALREADY_RAN');
  const c = (role: string, phaseId: string, executionId = 'e1') => ({ role, workId: 'w', executionId, phaseId });
  assert.equal(recipe.activationGuard('withdraw')(c('builder', 'builder-continuation')), false);
  assert.equal(recipe.grantGuard('withdraw')('builder-start', { publicationState: 'published', publicationActivation: false }), false);
  const command = recipe.activationGuard('command', 2);
  assert.equal(command(c('builder', 'builder-initial')), false, 'never /implement again');
  assert.equal(command(c('builder', 'builder-continuation')), true);
  assert.equal(command(c('spec', 'p'), { round: 3 }), true);
  assert.equal(command(c('builder', 'builder-publication', 'e2')), true);
  assert.equal(command(c('builder', 'builder-continuation', 'e3')), true, 'the continuation (or a new correction) for the during-activity review');
  assert.equal(command(c('spec', 'p', 'e3'), { round: 4 }), true);
  assert.equal(command(c('builder', 'builder-publication', 'e4')), true);
  assert.equal(command(c('builder', 'builder-continuation', 'e5')), false, 'nothing beyond two pairs');
  const grants = recipe.grantGuard('review', 2);
  assert.equal(grants('builder-publish', { publicationState: 'published', publicationActivation: false, executionId: 'p1' }), false);
  assert.equal(grants('builder-publish', { publicationState: 'requested', publicationActivation: false, executionId: 'p1' }), true);
});

const request = (code: 'HUMAN_CHANGES_REQUESTED' | 'EXPLICIT_REPAIR', state: string, origin = 'github-review', outcome: string | null = null) =>
  ({ feedbackId: `${code}-${state}`, code, state, outcome, feedback: { origin } }) as never;
const work = (extra: Partial<WorkView> & { requests?: unknown[] }) => ({ publication: { state: 'published' }, execution: null, impediments: [], correction: null, corrections: [],
  budget: { corrections: { consumed: 0 } }, feedback: { requests: extra.requests ?? [] }, ...extra }) as unknown as WorkView;

test('settled/humanObserved: review = ONE charged published correction with its request treated; withdraw = withdrawn without charge and no activation', () => {
  const closed = { correctionId: 'c', outcome: 'published', charged: true } as never;
  const facts = { activations: 2, stepsObserved: 1, quietCyclesDone: true, correctionsBefore: 0 };
  assert.deepEqual(recipe.settled('review', work({ corrections: [closed], budget: { corrections: { consumed: 1 } } as never, requests: [request('HUMAN_CHANGES_REQUESTED', 'treated')] }), facts),
    { done: true, success: true });
  assert.deepEqual(recipe.settled('review', work({ corrections: [closed], requests: [request('HUMAN_CHANGES_REQUESTED', 'treated')] }), { ...facts, quietCyclesDone: false }), { done: false, success: false });
  assert.deepEqual(recipe.settled('review', work({ corrections: [closed, closed], budget: { corrections: { consumed: 2 } } as never, requests: [request('HUMAN_CHANGES_REQUESTED', 'treated')] }),
    facts), { done: true, success: false }, 'a second correction for the same review is a failure');
  assert.deepEqual(recipe.settled('review', work({ impediments: [{ code: 'QUESTION_PENDING' }] as never }), facts), { done: true, success: false }, 'a Question ends the phase (operator)');
  const twice = { activations: 4, stepsObserved: 2, quietCyclesDone: true, correctionsBefore: 1 };
  const commandWork = work({ corrections: [closed, closed], budget: { corrections: { consumed: 2 } } as never,
    requests: [request('HUMAN_CHANGES_REQUESTED', 'treated'), request('EXPLICIT_REPAIR', 'treated', 'github-comment')] });
  assert.deepEqual(recipe.settled('command', commandWork, twice), { done: true, success: true }, 'continuation of the same correction');
  const withdrawn = { correctionId: 'w', outcome: 'withdrawn', charged: false } as never;
  const quiet = { activations: 0, stepsObserved: 2, quietCyclesDone: true, correctionsBefore: 2 };
  assert.deepEqual(recipe.settled('withdraw', work({ corrections: [closed, closed, withdrawn], budget: { corrections: { consumed: 2 } } as never }), quiet), { done: true, success: true });
  assert.deepEqual(recipe.settled('withdraw', work({ corrections: [closed, closed, withdrawn] }), { ...quiet, activations: 1 }), { done: true, success: false });
  assert.equal(recipe.humanObserved(2, work({ requests: [request('EXPLICIT_REPAIR', 'pending', 'github-comment')] }), { reviews: 0, repairs: 0 }), true);
  assert.equal(recipe.humanObserved(2, work({ requests: [request('EXPLICIT_REPAIR', 'pending', 'local-cli')] }), { reviews: 0, repairs: 0 }), false, 'only the operator comment counts');
  assert.equal(recipe.humanObserved(5, work({ requests: [request('HUMAN_CHANGES_REQUESTED', 'withdrawn', 'github-review', 'APPROVED_LATER')] }), { reviews: 0, repairs: 0 }), true);
});
