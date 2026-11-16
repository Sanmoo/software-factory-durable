import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateChecks } from '../../src/control/rules/checks.js';
import { evaluateReadiness, humanFlag, internalReadiness, readinessAction, sameBasis, type ReadinessFacts } from '../../src/control/rules/readiness.js';
import type { ChecksEvaluation, ReadinessEvaluation, ReadinessView } from '../../src/control/types.js';
import { basisExecution, head, observedPull, readyPublication } from './readiness-seed.js';

// Ticket 16 rules (R): internal readiness from current evidence only, independent reasons, and the conversion that applies to the observed flag.
const workId = '11111111-2222-4333-8444-555555555555';
const at = '2026-11-15T12:00:00.000Z';
const expect = { own: { pullRequestId: 9007, nodeId: 'PR_node7', number: 7, headRef: 'factory/3-abcdef12', base: 'main', authorId: 41898282 }, repositoryId: 3,
  linkedHeads: [head], localRequiredChecks: [] };
const checksOf = (observation: Parameters<typeof observedPull>[0] = {}): ChecksEvaluation => evaluateChecks({ at, expect, observation: observedPull(observation) });
function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return { result: 'open', current: true, publication: readyPublication(workId), execution: basisExecution(), previousExecutions: [], impediments: [],
    dependencies: { latest: { evaluationId: 'd', attemptId: 'p', source: 'github-rest', observedAt: at, evaluatedAt: at, principals: [], completeness: 'complete', conclusion: 'satisfied',
      blockers: [], cycles: [], shared: [], reasons: [], limitations: [] }, lastComplete: null }, queue: { pending: false }, correction: null, pendingRecovery: null, ...overrides };
}
const evaluate = (input: { facts?: Partial<ReadinessFacts>; checks?: ChecksEvaluation | null; installation?: 'settled' | 'reconciliation-required'; source?: 'recorded' | 'recheck';
  dependencyAttempt?: string | null } = {}) =>
  evaluateReadiness({ at, source: input.source ?? 'recheck', facts: facts(input.facts), checks: input.checks === undefined ? checksOf() : input.checks, installation: input.installation ?? 'settled',
    dependencyAttempt: input.dependencyAttempt === undefined ? 'p' : input.dependencyAttempt });
const codes = (evaluation: ReadinessEvaluation) => evaluation.reasons.map(item => `${item.certainty}:${item.code}${item.subject ? `:${item.subject}` : ''}`);
const view = (overrides: Partial<ReadinessView> = {}): Pick<ReadinessView, 'flag' | 'humanDraft' | 'authorization' | 'effects'> => ({
  flag: { factory: 'draft', origin: 'publication', at, observed: 'draft', observedAt: at }, humanDraft: null, authorization: null, effects: [], ...overrides });

test('AC1/AC6: ready only with every condition current; a pending human review (pull_request rule, mergeable_state blocked) does not block it', () => {
  const ready = evaluate();
  assert.deepEqual([ready.decision, ready.reasons], ['ready', []]);
  assert.equal(ready.basis.headSha, head);
  assert.ok(ready.notes.some(note => /never performed by the Factory/.test(note)), 'approval/merge stay human and are never read as a blocker');
  assert.equal(checksOf().modalities[0]!.interpretation, 'human-stage');
});

test('AC1: every unmet condition is an independent reason; resolving one never hides the others', () => {
  const waiting = evaluateChecks({ at, expect, observation: { ...observedPull({ mergeable: false }), classic: { state: 'complete', value: { kind: 'required', strict: false, enforcement: 'everyone',
    checks: [{ context: 'build', integrationId: null }], settings: null } }, final: { ...observedPull().final, classic: { state: 'complete', value: { kind: 'required', strict: false, enforcement: 'everyone',
    checks: [{ context: 'build', integrationId: null }], settings: null } } } } });
  const blocked = evaluate({ checks: waiting, facts: { impediments: [{ code: 'QUESTION_PENDING', scope: 'work', nextStep: 'x', questionId: 'q1' }], queue: { pending: true },
    correction: { consumed: false }, dependencies: { latest: { ...facts().dependencies.latest!, conclusion: 'pending' }, lastComplete: null }, scopeUpdates: [{ state: 'pending' }] } });
  assert.equal(blocked.decision, 'not-ready');
  assert.deepEqual(codes(blocked), ['confirmed:CHECKS_REQUIRED_CHECK_ABSENT:build', 'confirmed:MERGE_CONFLICT', 'confirmed:QUESTION_PENDING:q1', 'confirmed:DEPENDENCIES_PENDING',
    'confirmed:ACTIVITY_PENDING', 'confirmed:CORRECTION_OPEN', 'confirmed:SCOPE_UPDATE_NOT_CONSUMED']);
  const answered = evaluate({ checks: waiting, facts: { queue: { pending: true } } });
  assert.deepEqual(codes(answered), ['confirmed:CHECKS_REQUIRED_CHECK_ABSENT:build', 'confirmed:MERGE_CONFLICT', 'confirmed:ACTIVITY_PENDING'], 'removing the Question left the others');
  const unsettled = evaluate({ facts: { execution: { ...basisExecution(), state: 'started', end: null } } });
  assert.ok(codes(unsettled).includes('confirmed:ACTIVITY_UNSETTLED:seeded-execution'));
});

test('AC7 no borrowed green: checks of another head, another PR, an unverified basis or a non-published PR never make it ready', () => {
  const otherHead = evaluate({ checks: evaluateChecks({ at, expect: { ...expect, linkedHeads: [head, 'e'.repeat(40)] }, observation: observedPull({ headSha: 'e'.repeat(40) }) }) });
  assert.deepEqual([otherHead.decision, codes(otherHead)], ['not-ready', [`confirmed:HEAD_NOT_VERIFIED_CONTENT:${'e'.repeat(40)}`]], 'green checks of a head the reviews never saw');
  const otherPull = evaluate({ checks: { ...checksOf(), pullRequest: { ...checksOf().pullRequest, number: 8 } } });
  assert.deepEqual(codes(otherPull), ['uncertain:CHECKS_OF_ANOTHER_PULL_REQUEST']);
  const notVerified = evaluate({ facts: { execution: { ...basisExecution(), review: { ...basisExecution().review!, verification: { ...basisExecution().review!.verification!, status: 'not-verified', reasons: ['GATE_FAILED'] } } } } });
  assert.deepEqual(codes(notVerified), ['confirmed:CONTENT_NOT_VERIFIED:REVIEW_NOT_VERIFIED', 'confirmed:CONTENT_NOT_VERIFIED:VERIFICATION:GATE_FAILED']);
  const missing = evaluate({ facts: { execution: null } });
  assert.deepEqual(codes(missing), ['confirmed:VERIFIED_BASIS_NOT_FOUND']);
  const requested = evaluate({ facts: { publication: { ...readyPublication(workId), state: 'requested' } } });
  assert.deepEqual(codes(requested), ['confirmed:OWN_PULL_REQUEST_NOT_PUBLISHED:requested']);
  const nonconformant = evaluate({ facts: { publication: { ...readyPublication(workId), description: { conformant: false, reasons: ['X'] } } } });
  assert.deepEqual(codes(nonconformant), ['confirmed:DESCRIPTION_NOT_CONFORMANT']);
  const unknownOwner = evaluate({ checks: evaluateChecks({ at, expect, observation: { ...observedPull(), pullRequest: { ...observedPull().pullRequest, author: { id: 5, login: 'x', type: 'User' } } } }) });
  assert.deepEqual(codes(unknownOwner), ['confirmed:CHECKS_AUTHOR_NOT_FACTORY_APP']);
  assert.deepEqual(codes(evaluate({ checks: null })), ['uncertain:CHECKS_NOT_EVALUATED']);
});

test('AC4: transient/incomplete evidence is unknown (internal confirmation withdrawn) and never flips the flag', () => {
  const unavailable = evaluateChecks({ at, expect, observation: { kind: 'unavailable', source: 'github-rest', observedAt: at, repository: 'acme/project', code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'x' } });
  const transient = evaluate({ checks: unavailable, source: 'recorded' });
  assert.equal(transient.decision, 'unknown');
  assert.deepEqual(codes(transient), ['uncertain:CHECKS_PULL_REQUEST_UNAVAILABLE:GITHUB_TRANSPORT_UNAVAILABLE', 'uncertain:MERGEABILITY_UNKNOWN']);
  assert.deepEqual(codes(evaluate({ checks: checksOf({ mergeable: null }) })), ['uncertain:MERGEABILITY_UNKNOWN'], 'mergeability still computing is not a conflict');
  assert.deepEqual(codes(evaluate({ installation: 'reconciliation-required' })), ['uncertain:INSTALLATION_RECONCILIATION_REQUIRED']);
  assert.deepEqual(codes(evaluate({ checks: checksOf({ recheckHead: 'e'.repeat(40) }) })), ['uncertain:CHECKS_HEAD_CHANGED_DURING_COLLECTION'], 'a push during the collection');
  const placed = view({ flag: { factory: 'ready', origin: 'readiness-effect', at, observed: 'ready', observedAt: at } });
  assert.deepEqual(readinessAction({ evaluation: transient, view: placed, observed: 'ready' }), { action: 'none', blocked: [], notes: [], authorization: null }, 'no oscillation on a network failure');
  assert.equal(internalReadiness({ internal: 'ready', latest: evaluate() }, transient), 'unknown');
});

test('AC4/AC5: confirmed loss restores draft only over the Factory\'s own ready; ready restores the Factory\'s draft; a human ready is never reverted', () => {
  const lost = evaluate({ checks: checksOf({ mergeable: false }) });
  const placed = view({ flag: { factory: 'ready', origin: 'readiness-effect', at, observed: 'ready', observedAt: at } });
  assert.deepEqual(readinessAction({ evaluation: lost, view: placed, observed: 'ready' }).action, 'convert-to-draft');
  assert.deepEqual(readinessAction({ evaluation: lost, view: view(), observed: 'ready' }), { action: 'none', blocked: [], notes: ['READY_FLAG_NOT_PLACED_BY_FACTORY'], authorization: null });
  assert.deepEqual(humanFlag(view(), 'ready'), { humanDraft: false, humanReady: true });
  assert.equal(readinessAction({ evaluation: evaluate(), view: view(), observed: 'draft' }).action, 'mark-ready', 'the draft the Factory published');
  assert.equal(readinessAction({ evaluation: evaluate(), view: view({ flag: { factory: 'draft', origin: 'readiness-effect', at, observed: 'draft', observedAt: at } }), observed: 'draft' }).action,
    'mark-ready', 'a draft the Factory placed for its own reasons is restored after a complete evaluation');
  assert.equal(readinessAction({ evaluation: evaluate(), view: placed, observed: 'ready' }).action, 'none', 'nothing to do when ready is already set');
  const closed = evaluate({ checks: checksOf({ state: 'closed' }) });
  assert.deepEqual([closed.decision, readinessAction({ evaluation: closed, view: placed, observed: 'ready' }).action], ['not-ready', 'none'], 'a closed PR follows its own transitions');
});

test('AC5: an unexpected human draft is respected until the operator authorizes ONE restoration', () => {
  assert.deepEqual(humanFlag(view({ flag: { factory: 'ready', origin: 'readiness-effect', at, observed: 'ready', observedAt: at } }), 'draft'), { humanDraft: true, humanReady: false });
  const human = view({ humanDraft: { observedAt: at, headSha: head } });
  assert.deepEqual(readinessAction({ evaluation: evaluate(), view: human, observed: 'draft' }).blocked, ['HUMAN_DRAFT_AUTHORIZATION_REQUIRED']);
  const authorized = view({ humanDraft: { observedAt: at, headSha: head }, authorization: { request_id: 'op-1', at, reason: 'restore', purpose: 'human-draft', binding: { kind: 'human-draft', pullRequest: 7, headSha: head, observedAt: at } } });
  assert.deepEqual(readinessAction({ evaluation: evaluate(), view: authorized, observed: 'draft' }), { action: 'mark-ready', blocked: [], notes: [], authorization: 'op-1' });
  const notReady = evaluate({ checks: checksOf({ mergeable: false }) });
  assert.equal(readinessAction({ evaluation: notReady, view: authorized, observed: 'draft' }).action, 'none', 'an authorization never replaces the evaluation');
});

test('AC3: a conversion that was not applied is never repeated implicitly for the same basis', () => {
  const ready = evaluate();
  const failed = { effectId: 'e1', action: 'mark-ready' as const, reason: 'READY', basis: ready.basis, intendedAt: at, state: 'not-applied' as const, authorization: null,
    attempt: { at, outcome: 'known-failure' as const, code: 'GITHUB_ACCESS_DENIED', revocation: 'revoked' }, observation: { at, draft: true, headSha: head, code: null }, settledAt: at };
  assert.deepEqual(readinessAction({ evaluation: ready, view: view({ effects: [failed] }), observed: 'draft' }).blocked, ['CONVERSION_NOT_APPLIED_AUTHORIZATION_REQUIRED']);
  const repeat = view({ effects: [failed], authorization: { request_id: 'op-2', at, reason: 'retry', purpose: 'repeat-conversion', binding: { kind: 'not-applied', effectId: 'e1' } } });
  assert.deepEqual(readinessAction({ evaluation: ready, view: repeat, observed: 'draft' }), { action: 'mark-ready', blocked: [], notes: [], authorization: 'op-2' });
  const moved = { ...ready, basis: { ...ready.basis, requirements: 'other' } };
  assert.equal(readinessAction({ evaluation: moved, view: view({ effects: [failed] }), observed: 'draft' }).action, 'mark-ready', 'a new basis is a new evaluation');
});

test('AC2: identity/head/base/requirements changes invalidate a basis; the base tip advancing alone does not (only under strict)', () => {
  const basis = evaluate().basis;
  assert.ok(sameBasis(basis, evaluate({ checks: checksOf({ baseTip: 'f'.repeat(40) }) }).basis), 'base advanced: no recalculation trigger, no review/rebase');
  assert.ok(!sameBasis(basis, { ...basis, headSha: 'e'.repeat(40) }));
  assert.ok(!sameBasis(basis, { ...basis, baseRef: 'develop' }));
  assert.ok(!sameBasis(basis, { ...basis, nodeId: 'PR_other' }));
  const added = evaluate({ checks: checksOf({ rules: [{ type: 'pull_request', ruleset: { id: 1, sourceType: 'Repository', source: 'acme/project' } },
    { type: 'required_status_checks', ruleset: { id: 2, sourceType: 'Repository', source: 'acme/project' }, statusChecks: { strict: true, checks: [{ context: 'ci', integrationId: null }] } }] }) });
  assert.ok(!sameBasis(basis, added.basis), 'a new required check');
  assert.ok(!sameBasis(added.basis, { ...added.basis, baseTip: 'f'.repeat(40) }), 'strict: the base tip is part of the basis');
  assert.equal(internalReadiness(null, evaluate({ source: 'recorded' })), 'unknown', 'a recorded evaluation alone never confirms readiness');
  assert.equal(internalReadiness(null, evaluate()), 'ready');
  assert.equal(internalReadiness({ internal: 'ready', latest: evaluate() }, evaluate({ source: 'recorded' })), 'ready', 'kept for the same basis');
});

test('review MED 3: an authorization answers ONE occurrence (that human draft, that not-applied conversion); another occurrence needs a new one', () => {
  const stale = view({ humanDraft: { observedAt: '2026-11-15T13:00:00.000Z', headSha: head },
    authorization: { request_id: 'op-1', at, reason: 'restore', purpose: 'human-draft', binding: { kind: 'human-draft', pullRequest: 7, headSha: head, observedAt: at } } });
  assert.deepEqual(readinessAction({ evaluation: evaluate(), view: stale, observed: 'draft' }).blocked, ['HUMAN_DRAFT_AUTHORIZATION_REQUIRED'], 'a later human draft is another occurrence');
  const ready = evaluate();
  const failed = (effectId: string) => ({ effectId, action: 'mark-ready' as const, reason: 'READY', basis: ready.basis, intendedAt: at, state: 'not-applied' as const, authorization: null,
    attempt: null, observation: { at, draft: true, headSha: head, code: null }, settledAt: at });
  const other = view({ effects: [failed('e2')], authorization: { request_id: 'op-2', at, reason: 'retry', purpose: 'repeat-conversion', binding: { kind: 'not-applied', effectId: 'e1' } } });
  assert.deepEqual(readinessAction({ evaluation: ready, view: other, observed: 'draft' }).blocked, ['CONVERSION_NOT_APPLIED_AUTHORIZATION_REQUIRED']);
});

test('review MED 5: dependencies must come from the fresh read of this evaluation; a stale conclusion is uncertain', () => {
  assert.deepEqual(codes(evaluate({ dependencyAttempt: 'fresh-round' })), ['uncertain:DEPENDENCIES_NOT_CURRENT']);
  assert.deepEqual(codes(evaluate({ dependencyAttempt: 'p' })), []);
  assert.deepEqual(codes(evaluate({ source: 'recorded', dependencyAttempt: null })), [], 'a recorded evaluation never converts nor confirms by itself');
});

test('review MED 6: strict + base advanced withdraws internal readiness but never converts a ready PR to draft by itself', () => {
  const strict = { ...observedPull({ rules: [{ type: 'required_status_checks', ruleset: { id: 2, sourceType: 'Repository', source: 'acme/project' }, statusChecks: { strict: true, checks: [] } }] }),
    comparison: { state: 'complete' as const, value: { status: 'diverged', aheadBy: 1, behindBy: 3 } } };
  const behind = evaluate({ checks: evaluateChecks({ at, expect, observation: strict }) });
  assert.deepEqual([behind.decision, codes(behind)], ['unknown', ['uncertain:CHECKS_STRICT_BRANCH_BEHIND_BASE']]);
  const placed = view({ flag: { factory: 'ready', origin: 'readiness-effect', at, observed: 'ready', observedAt: at } });
  assert.equal(readinessAction({ evaluation: behind, view: placed, observed: 'ready' }).action, 'none');
  assert.equal(internalReadiness({ internal: 'ready', latest: evaluate() }, behind), 'unknown');
});

test('review LOW: disputed ownership blocks every mutation, also back to draft; a conversion that provably never left is re-evaluated once', () => {
  const disputed = evaluate({ checks: evaluateChecks({ at, expect, observation: { ...observedPull({ draft: false }), pullRequest: { ...observedPull({ draft: false }).pullRequest, author: { id: 5, login: 'x', type: 'User' } } } }) });
  const placed = view({ flag: { factory: 'ready', origin: 'readiness-effect', at, observed: 'ready', observedAt: at } });
  assert.deepEqual(readinessAction({ evaluation: disputed, view: placed, observed: 'ready' }), { action: 'none', blocked: ['OWNERSHIP_DISPUTED'], notes: [], authorization: null });
  const ready = evaluate();
  const unsent = (effectId: string) => ({ effectId, action: 'mark-ready' as const, reason: 'READY', basis: ready.basis, intendedAt: at, state: 'not-applied' as const, authorization: null,
    attempt: null, observation: { at, draft: true, headSha: head, code: null }, settledAt: at, neverSent: true });
  assert.equal(readinessAction({ evaluation: ready, view: view({ effects: [unsent('u1')] }), observed: 'draft' }).action, 'mark-ready', 'never sent: one automatic re-evaluation');
  assert.deepEqual(readinessAction({ evaluation: ready, view: view({ effects: [unsent('u1'), unsent('u2')] }), observed: 'draft' }).blocked, ['CONVERSION_NOT_APPLIED_AUTHORIZATION_REQUIRED'], 'only once');
});
