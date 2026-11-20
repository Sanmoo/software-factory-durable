import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { WorkerCompletion } from '../../src/workers/index.js';

// Import and --plan of the ticket 28 real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, access: deny, readdir: deny }, defaultExport: deny });
}
const recipe = await import('./review28-qualification.js');

test('AC7 recipe: import and --plan are inert and declare the fixed bounds and the two provocations of the one-shot real run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q28-partial-v2');
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'inspect-2', 'stop-environment']);
  assert.deepEqual([plan.model.builder.maxRequests, plan.model.reviewers.maxRequestsEach, plan.model.reviewers.maxActivations, plan.model.reviewers.retries,
    plan.model.maxRequestsTotal, plan.model.providerRetries, plan.model.sdkRetries], [60, 24, { standards: 4, spec: 5 }, { standards: 0, spec: 1 }, 276, 0, 0]);
  assert.equal(plan.model.reviewers.controlRetryCapPerRolePerRound, 2, 'the provoked single Spec retry stays within the operator cap');
  assert.equal(plan.provocations.length, 2);
  assert.match(plan.provocations[0], /^spec r1a1: Host deadlineMs 20000/);
  assert.match(plan.provocations[1], /^standards r1a1: its completion reaches Control without the opinion/);
  assert.equal(plan.github.reviewerCredentials, 'none');
  assert.match(plan.guards[0], /WORKER_LAUNCH_INVALID: never-started, reservation released, not retried\); more than 2 stop the run/, 'a guard refusal never cascades into free retries');
  assert.match(plan.effects.find((item: string) => item.startsWith('inspect:')), /private copy of the Work's Records/, 'inspect never opens the live Records');
  assert.match(plan.github.writes, /^none/);
  assert.deepEqual(plan.expectedTicket, { number: 6, repositoryId: 1256893534 });
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('AC7 recipe guard: one Builder; Standards never retried; Spec retried at most once and only in round 1', () => {
  const guard = recipe.activationGuard();
  const context = (role: string, executionId = 'e1') => ({ role, executionId });
  assert.equal(guard(context('spec'), { round: 1, attempt: 1 }), false, 'no reviewer before the Builder');
  assert.equal(guard(context('builder')), true);
  assert.equal(guard(context('builder')), false, 'never a second Builder');
  assert.equal(guard(context('spec', 'e2'), { round: 1, attempt: 1 }), false, 'never another Execution');
  assert.equal(guard(context('standards'), { round: 1, attempt: 1 }), true);
  assert.equal(guard(context('standards'), { round: 1, attempt: 2 }), false, 'a lost notification is never rerun');
  assert.equal(guard(context('spec'), { round: 1, attempt: 1 }), true);
  assert.equal(guard(context('spec'), { round: 1, attempt: 1 }), false, 'distinct (round, attempt)');
  assert.equal(guard(context('spec'), { round: 1, attempt: 2 }), true, 'the one provoked retry');
  assert.equal(guard(context('spec'), { round: 1, attempt: 3 }), false);
  assert.equal(guard(context('spec'), { round: 2, attempt: 2 }), false);
  for (const round of [2, 3, 4]) assert.equal(guard(context('spec'), { round, attempt: 1 }), true);
  assert.equal(guard(context('spec'), { round: 5, attempt: 1 }), false, 'bounded');
});

test('AC7 recipe provocations: exactly one invocation each, on round 1 attempt 1', () => {
  const provoke = recipe.provocation(1);
  assert.equal(provoke.deadline({ role: 'spec' }, { round: 1, attempt: 1 }), 20000);
  assert.equal(provoke.deadline({ role: 'spec' }, { round: 1, attempt: 2 }), undefined, 'the retry runs without the provoked deadline');
  assert.equal(provoke.deadline({ role: 'standards' }, { round: 1, attempt: 1 }), undefined);
  assert.equal(provoke.deadline({ role: 'builder' }), undefined);
  const success = { status: 'success', receipt: { workId: 'w', id: 'r' }, opinion: { conclusion: 'clean' } } as unknown as WorkerCompletion;
  assert.deepEqual(provoke.dropOpinion({ role: 'standards' }, { round: 1, attempt: 1 }, success), { status: 'success', receipt: { workId: 'w', id: 'r' } });
  assert.equal(provoke.dropOpinion({ role: 'standards' }, { round: 2, attempt: 1 }, success), success);
  assert.equal(provoke.dropOpinion({ role: 'spec' }, { round: 1, attempt: 1 }, success), success);
});

// Synthetic Control views (shapes of ExecutionView) for the recipe oracle; no effect.
type Reviewer = Record<string, unknown>;
const opinion = (conclusion: string, extra: Record<string, unknown> = {}) => ({ conclusion, code: null, findings: [], hostChecks: { downgraded: [] }, ...extra });
const reviewer = (extra: Reviewer = {}): Reviewer => ({ state: 'ended', opinion: opinion('clean'), failure: null, cessation: 'completion-observed', source: 'notification', ...extra });
const view = (rounds: Record<string, Reviewer>[], extra: Record<string, unknown> = {}) => ({ state: 'ended', slot: { held: false }, dispatch: { phase: 'stopped' }, end: { cessation: 'confirmed' },
  review: { rounds: rounds.map((reviewers, index) => ({ round: index + 1, kind: 'review', reviewers })) }, ...extra });
const expected = () => [{
  standards: reviewer({ source: 'records-discovery' }),
  spec: reviewer({ attempt: 2, attempts: [{ attempt: 1, state: 'ended', opinion: { conclusion: 'cancelled', code: 'REVIEWER_INTERRUPTED' }, failure: null, cessation: 'completion-observed' }],
    charge: null, retry: { waitSeconds: 5 } }),
}, { standards: reviewer(), spec: reviewer() }];
const budget = { recoveries: { consumed: 0, reserved: null } };

test('AC7 recipe oracle: the expected partial recovery passes; a Standards `incomplete` (absent named context) is a limitation, never the provoked failure or a retried role', () => {
  const ok = recipe.verdict(view(expected()) as never, budget);
  assert.equal(ok.passed, true, JSON.stringify(ok.checks.filter(item => !item.ok)));
  // Ticket 14 v7: Standards concludes `incomplete` in EVERY round (missing GLOSSARY.md/docs/adr read as failures). Still a real opinion.
  const rounds = expected();
  const incomplete = { opinion: opinion('incomplete', { hostChecks: { downgraded: ['SOURCE_UNREADABLE'] } }) };
  rounds[0]!.standards = reviewer({ source: 'records-discovery', ...incomplete });
  rounds[1]!.standards = reviewer(incomplete);
  const limited = recipe.verdict(view(rounds) as never, budget);
  assert.equal(limited.passed, true, 'an incomplete opinion neither fails the lost-notification check nor counts as a retry');
  assert.deepEqual(limited.limitations, [{ round: 1, role: 'standards', downgraded: ['SOURCE_UNREADABLE'] }, { round: 2, role: 'standards', downgraded: ['SOURCE_UNREADABLE'] }]);
  assert.deepEqual(limited.retriedRoles, ['r1/spec']);
  assert.equal(limited.checks.find(item => item.name === 'provoked-spec-failure')!.observed, 'cancelled:REVIEWER_INTERRUPTED');
});

test('AC7 recipe oracle: a retried Standards, an incomplete Spec a1 taken for the provocation, or a stuck reservation fail the verdict', () => {
  const retriedStandards = expected();
  retriedStandards[0]!.standards = reviewer({ attempt: 2, attempts: [{ attempt: 1, opinion: opinion('incomplete') }] });
  const a = recipe.verdict(view(retriedStandards) as never, budget);
  assert.equal(a.passed, false);
  assert.deepEqual(a.retriedRoles, ['r1/standards', 'r1/spec']);
  // An `incomplete` first Spec attempt is a real opinion: Control never retries it, so it can never be the provoked failure.
  const incompleteSpec = expected();
  incompleteSpec[0]!.spec = reviewer({ opinion: opinion('incomplete') });
  const b = recipe.verdict(view(incompleteSpec) as never, { recoveries: { consumed: 0, reserved: null } });
  assert.equal(b.checks.find(item => item.name === 'provoked-spec-failure')!.ok, false);
  assert.equal(b.passed, false);
  const c = recipe.verdict(view(expected()) as never, { recoveries: { consumed: 0, reserved: 'spec-x-r1a2' } });
  assert.equal(c.checks.find(item => item.name === 'budget')!.ok, false);
  // Ticket 57: a reviewer retry that still charged the Work's recoveries fails the verdict.
  const charged = expected();
  charged[0]!.spec = { ...charged[0]!.spec, charge: { state: 'consumed' } };
  const e = recipe.verdict(view(charged) as never, { recoveries: { consumed: 1, reserved: null } });
  assert.deepEqual([e.checks.find(item => item.name === 'spec-retried-once')!.ok, e.checks.find(item => item.name === 'budget')!.ok], [false, false]);
  const d = recipe.verdict(view(expected(), { state: 'held', held: { code: 'REVIEWER_CESSATION_UNCONFIRMED' } }) as never, budget);
  assert.equal(d.checks.find(item => item.name === 'execution-ended')!.observed, 'held:REVIEWER_CESSATION_UNCONFIRMED');
});

test('AC7 recipe preflight: an open (or any) pull request associated with the recipe Ticket holds BEFORE any effect; never adopted', () => {
  const pr5 = { pullRequestId: 55, number: 5, url: 'https://github.com/Sanmoo/java-springboot-event-sourcing/pull/5', state: 'open' as const, merged: false,
    headRef: 'factory/3-abcdef12', headRepositoryId: 1256893534, association: ['closing-reference'] };
  const held = recipe.publicationPrecondition({ kind: 'observed', repositoryId: 1256893534, issues: { '6': { completeness: 'complete', candidates: [pr5] } } } as never);
  assert.deepEqual(held, { ok: false, code: 'TICKET_HAS_ASSOCIATED_PULL_REQUEST', pullRequests: [{ number: 5, state: 'open', merged: false, headRef: 'factory/3-abcdef12' }] },
    'a fresh Control storage would hold it FOREIGN_PULL_REQUEST: the run could never start an Execution');
  assert.deepEqual(recipe.publicationPrecondition({ kind: 'observed', repositoryId: 1256893534, issues: { '6': { completeness: 'complete', candidates: [] } } } as never), { ok: true });
  assert.equal(recipe.publicationPrecondition({ kind: 'observed', repositoryId: 1256893534, issues: { '6': { completeness: 'incomplete', code: 'X', nextStep: 'n' } } } as never).ok, false,
    'an incomplete observation never proves absence');
  assert.equal(recipe.publicationPrecondition({ kind: 'unavailable', code: 'GITHUB_UNAVAILABLE', nextStep: 'n' } as never).ok, false);
});

test('AC7 recipe preflight: the label may also list #3, ONLY if it would be held (an associated PR); any other admissible Ticket holds the run', () => {
  const pr = (number: number) => ({ pullRequestId: number, number, url: `u${number}`, state: 'open' as const, merged: false, headRef: 'factory/3-x', headRepositoryId: 1, association: ['closing-reference'] });
  const publication = (issues: Record<string, unknown>) => ({ kind: 'observed', repositoryId: 1256893534, issues }) as never;
  assert.deepEqual(recipe.candidatesPrecondition([3, 6], publication({ '3': { completeness: 'complete', candidates: [pr(5)] }, '6': { completeness: 'complete', candidates: [] } })),
    { ok: true, held: [3] });
  assert.deepEqual(recipe.candidatesPrecondition([6], publication({ '6': { completeness: 'complete', candidates: [] } })), { ok: true, held: [] });
  assert.deepEqual(recipe.candidatesPrecondition([3, 6], publication({ '3': { completeness: 'complete', candidates: [] }, '6': { completeness: 'complete', candidates: [] } })),
    { ok: false, code: 'OTHER_TICKET_ADMISSIBLE:3' }, 'an admissible #3 could take the only Slot');
  assert.deepEqual(recipe.candidatesPrecondition([3, 6], publication({ '3': { completeness: 'incomplete', code: 'X', nextStep: 'n' }, '6': { completeness: 'complete', candidates: [] } })),
    { ok: false, code: 'OTHER_TICKET_ADMISSIBLE:3' }, 'unknown is never held-for-sure');
  assert.deepEqual(recipe.candidatesPrecondition([3], publication({})), { ok: false, code: 'RECIPE_TICKET_NOT_LISTED' });
  assert.deepEqual(recipe.candidatesPrecondition([6, 6], publication({})), { ok: false, code: 'RECIPE_TICKET_NOT_LISTED' });
});

test('AC7 recipe preflight: the Ticket body and title must be exactly the planned ones (read-only issue read)', () => {
  const plan = recipe.plan();
  assert.deepEqual(recipe.ticketPrecondition({ title: plan.ticket.title, body: plan.ticket.body.replaceAll('\n', '\r\n') + '\n' }), { ok: true });
  assert.deepEqual(recipe.ticketPrecondition({ title: 'Other', body: plan.ticket.body }), { ok: false, code: 'TICKET_TITLE_MISMATCH' });
  assert.deepEqual(recipe.ticketPrecondition({ title: plan.ticket.title, body: `${plan.ticket.body}\nextra` }), { ok: false, code: 'TICKET_BODY_MISMATCH' });
  assert.deepEqual(recipe.ticketPrecondition({ title: plan.ticket.title, body: null }), { ok: false, code: 'TICKET_BODY_MISMATCH' });
});

test('AC7 recipe inspect-2: one-shot; needs the recorded run; refused once its tombstone exists (the original storage is never opened)', () => {
  const recorded = (...names: string[]) => new Set(names);
  assert.equal(recipe.phaseGuard('inspect-2', recorded('preflight-result', 'run-result', 'inspect-intent', 'inspect-held')), null, 'a held inspect does not block inspect-2');
  assert.equal(recipe.phaseGuard('inspect-2', recorded('preflight-result', 'run-result', 'inspect-2-intent')), 'PHASE_ALREADY_RAN');
  assert.equal(recipe.phaseGuard('inspect-2', recorded('preflight-result')), 'RUN_RESULT_REQUIRED');
  assert.equal(recipe.phaseGuard('inspect', recorded('preflight-result', 'run-result', 'inspect-intent')), 'PHASE_ALREADY_RAN');
  assert.equal(recipe.phaseGuard('run', recorded()), 'PREFLIGHT_REQUIRED');
  assert.equal(recipe.phaseGuard('run', recorded('preflight-result')), null);
});
