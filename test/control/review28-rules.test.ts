import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opinionCorrelated, verifyExecution } from '../../src/control/rules/review.js';
import { carryBasis, carryPlan, carrySource, identityChange, incorporable, notRetriedReasons, packIdentity, preservedReviewContext, retryDecision, reviewerFailure, reviewerRetryWait,
  maxReviewerRetries, reviewProfile, sameReviewProfile, undiscovered } from '../../src/control/rules/review-recovery.js';
import { pendingReviewerReservations, settleReviewerReservations } from '../../src/control/durable/review-recovery.js';
import type { WorkRecord } from '../../src/control/durable/admission.js';
import { reviewerRetriesPerRound, type ProposalHandoff, type ProposalIdentity, type ReviewOpinion } from '../../src/contracts/index.js';
import type { ExecutionView, ReviewerView, ReviewRoundView } from '../../src/control/types.js';

// Rules level (R): pure ticket 28 partial review recovery rules over canonical types. Not evidence of any real reviewer, Records or crash.
const summary = (round: number, content = '7', extra: Partial<ProposalHandoff> = {}): ProposalHandoff => ({
  version: 1, round, index: `/artifacts/review/r${round}/index.json`, indexSha256: String(round).repeat(64), head: 'b'.repeat(40), branch: 'factory/3-x',
  base: 'a'.repeat(40), mergeBase: 'a'.repeat(40), counts: { entries: 1, committed: 0, staged: 0, unstaged: 1, untracked: 0, removed: 0 },
  patches: { committed: { path: 'c', bytes: 0, sha256: 'c'.repeat(64) }, staged: { path: 's', bytes: 0, sha256: 'c'.repeat(64) }, unstaged: { path: 'u', bytes: 3, sha256: 'c'.repeat(64) } },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) }, instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/docs/a.md'], changedTruncated: false, content: { sha256: content.repeat(64), clean: false, headMatches: false }, ...extra });
const observed = (sha = 'i', index = 'x', consistent = true): ProposalIdentity => ({ status: 'observed', sha256: sha.repeat(64), indexSha256: index, entries: 1, consistent, observedAt: 'now' });
const opinion = (role: 'standards' | 'spec', round: number, extra: Partial<ReviewOpinion> = {}): ReviewOpinion => ({ version: 1, role, round, attempt: 1, invocationId: `${role}-e1-r${round}a1`,
  reference: { workId: 'w', id: '11111111-2222-4333-8444-555555555555' }, session: { file: null }, model: { providerId: 'openai', modelId: 'gpt-6-luna' },
  profile: { id: 'p', modelBudget: 'reviewer-v1' }, input: { handoffIndexSha256: String(round).repeat(64), required: [], missing: [] },
  conclusion: 'clean', code: null, coverage: { scope: 'broad', justification: 'j', examined: [] }, findings: [], limitations: [],
  hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: null, recordedAt: 'now', ...extra });
const view = (role: 'standards' | 'spec', round: number, extra: Partial<ReviewerView> = {}): ReviewerView => ({ invocationId: `${role}-e1-r${round}a1`, phaseId: `review-r${round}`,
  promptSha256: 'p', state: 'ended', requestedAt: 'now', receiptId: 'r', endedAt: 'now', opinion: opinion(role, round), failure: null, cessation: 'completion-observed',
  input: { required: [], missing: [] }, ...extra });
const profile: ReviewRoundView['versions']['profile'] = { skillPack: { name: 'factory/skill-pack/v5', manifestSha256: 'f'.repeat(64) }, builder: {}, reviewer: { modelBudget: 'reviewer-v1' } };
function round(number: number, reviewers: Partial<Record<'standards' | 'spec', Partial<ReviewerView>>> = {}, content = '7'): ReviewRoundView {
  const s = summary(number, content);
  return { round: number, attempt: 1, state: 'reviewing', kind: 'review', closing: false, exemption: null, declarations: null,
    handoff: { at: 'now', invocationId: 'b', status: 'captured', code: null, detail: null, summary: s },
    versions: { spec: s.spec, instructions: s.instructions, base: s.base, head: s.head, profile },
    identity: { before: observed(), after: null }, reviewers: { standards: view('standards', number, reviewers.standards), spec: view('spec', number, reviewers.spec) },
    applicability: null, conclusion: null, reasons: [], concludedAt: null, delivery: null };
}
const failed = (code: string, cessation: ReviewerView['cessation'] = 'completion-observed'): Partial<ReviewerView> => ({ state: 'failed', opinion: null, failure: { code }, cessation });

test('AC2/AC3: only a failure with known cessation, transient cause, unchanged proposal and a retry left in the round is re-obtained', () => {
  const failure = { ...view('spec', 1), ...failed('WORKER_INTERRUPTED') };
  assert.deepEqual(retryDecision({ reviewer: failure, before: observed(), now: observed() }), { kind: 'retry', attempt: 2, waitSeconds: 5 });
  assert.deepEqual(retryDecision({ reviewer: view('spec', 1), before: observed(), now: observed() }), { kind: 'none' }, 'a valid opinion is never re-obtained');
  assert.deepEqual(retryDecision({ reviewer: view('spec', 1, { opinion: opinion('spec', 1, { conclusion: 'incomplete' }) }), before: observed(), now: observed() }), { kind: 'none' },
    'an incomplete opinion is a real reviewer result, not a failure');
  const code = (reviewer: ReviewerView, extra: { before?: ProposalIdentity | null; now?: ProposalIdentity | null } = {}) =>
    retryDecision({ reviewer, before: extra.before === undefined ? observed() : extra.before, now: extra.now === undefined ? observed() : extra.now });
  const notRetried = (decision: ReturnType<typeof code>) => decision.kind === 'not-retried' ? decision.code : decision.kind;
  assert.equal(notRetried(code({ ...view('spec', 1), ...failed('REVIEWER_OUTCOME_UNCERTAIN', 'unconfirmed') })), 'REVIEWER_CESSATION_UNCONFIRMED');
  assert.equal(notRetried(code({ ...view('spec', 1), ...failed('REVIEWER_UNAVAILABLE', 'never-started') })), 'REVIEWER_FAILURE_NOT_TRANSIENT');
  assert.equal(notRetried(code({ ...view('spec', 1), ...failed('OPINION_NOT_CORRELATED') })), 'REVIEWER_FAILURE_NOT_TRANSIENT');
  assert.equal(notRetried(code(failure, { now: observed('j') })), 'PROPOSAL_CHANGED', 'changed content: never on the old input');
  assert.equal(notRetried(code(failure, { now: observed('i', 'y') })), 'PROPOSAL_CHANGED', 'changed index');
  assert.equal(notRetried(code(failure, { now: { status: 'unavailable', code: 'X' } })), 'PROPOSAL_IDENTITY_UNKNOWN');
  assert.equal(notRetried(code(failure, { now: observed('i', 'x', false) })), 'PROPOSAL_IDENTITY_UNKNOWN');
  // Operator decision 2026-11-15: at most 2 retries per role per round (attempt 3 is the last). Ticket 57: that is the reviewers' own limit.
  assert.deepEqual(code({ ...failure, attempt: 2 }), { kind: 'retry', attempt: 3, waitSeconds: 15 }, 'the second retry waits 15 s');
  assert.deepEqual([maxReviewerRetries, reviewerRetriesPerRound], [2, 2], 'the release value (contracts) is the one Control enforces');
  assert.equal(notRetried(code({ ...failure, attempt: 3 })), 'REVIEWER_RETRY_LIMIT');
  // A recorded failure opinion (invalid verdict, cancellation) is a failure, never zero findings.
  assert.deepEqual(reviewerFailure(view('spec', 1, { opinion: opinion('spec', 1, { conclusion: 'cancelled', code: 'REVIEWER_INTERRUPTED' }) })), { code: 'REVIEWER_INTERRUPTED' });
  assert.equal(code(view('spec', 1, { opinion: opinion('spec', 1, { conclusion: 'failure', code: 'REVIEW_VERDICT_INVALID' }) })).kind, 'retry');
  assert.deepEqual([2, 3].map(reviewerRetryWait), [5, 15], 'the persisted 5/15 s waits of spec §4.4, by the retries of this role in this round');
});

test('ticket 57: a reviewer retry is bounded by the round, never by the Work recoveries; budget and provider closures are retried explicitly', () => {
  const failure = (code: string, attempt = 1, conclusion: ReviewOpinion['conclusion'] = 'cancelled') =>
    view('spec', 1, { attempt, opinion: opinion('spec', 1, { attempt, conclusion, code }) });
  const decide = (reviewer: ReviewerView) => retryDecision({ reviewer, before: observed(), now: observed() });
  // Pilot 2 (#126): the Spec reviewer closed by its own 48-request budget. Retried within the round, whatever the Work's recoveries.
  assert.deepEqual(decide(failure('REVIEWER_BUDGET_EXHAUSTED')), { kind: 'retry', attempt: 2, waitSeconds: 5 });
  assert.deepEqual(decide(failure('REVIEWER_BUDGET_EXHAUSTED', 2)), { kind: 'retry', attempt: 3, waitSeconds: 15 });
  assert.deepEqual(decide(failure('REVIEWER_BUDGET_EXHAUSTED', 3)), { kind: 'not-retried', code: 'REVIEWER_RETRY_LIMIT' });
  // A model request that failed without a Host abort: transient, the same bounded retry, never an implicit unbounded one.
  assert.deepEqual(decide(failure('WORKER_PROVIDER_UNAVAILABLE', 1, 'failure')), { kind: 'retry', attempt: 2, waitSeconds: 5 });
  assert.deepEqual(decide(failure('WORKER_PROVIDER_UNAVAILABLE', 3, 'failure')), { kind: 'not-retried', code: 'REVIEWER_RETRY_LIMIT' });
  assert.equal(retryDecision.length, 1, 'one input object, with no recoveries counter in it');
});

test('AC1/AC2: a discovered record is incorporated only as the complete opinion of exactly that request', () => {
  const expected = { role: 'spec' as const, round: 1, attempt: 1, invocationId: 'spec-e1-r1a1', handoffIndexSha256: '1'.repeat(64) };
  assert.equal(incorporable(opinion('spec', 1), expected), true);
  assert.equal(incorporable(opinion('spec', 1, { attempt: 2 }), expected), false, 'another attempt');
  assert.equal(incorporable(opinion('standards', 1), { ...expected, invocationId: 'standards-e1-r1a1' }), false, 'another role');
  assert.equal(incorporable(opinion('spec', 1, { input: { handoffIndexSha256: '9'.repeat(64), required: [], missing: [] } }), expected), false, 'another input');
  assert.equal(incorporable(opinion('spec', 1, { invocationId: 'spec-e2-r1a1' }), expected), false, 'another Execution');
});

test('AC3/AC4: a recovery Execution carries ONLY valid opinions of the interrupted round on the SAME proposal and context; discovered ones too', () => {
  const previous = (rounds: ReviewRoundView[], cessation: 'confirmed' | 'unconfirmed' = 'confirmed') => ({ executionId: 'e1', review: { rounds },
    end: { at: 'now', outcome: 'failure' as const, code: 'CONTROLLER_CRASH', cessation }, request: {} as ExecutionView['request'] });
  // Interrupted: Standards ended with a valid opinion; Spec's outcome was never recorded (its notification was lost with the controller).
  const interrupted = round(4, { spec: { state: 'started', opinion: null, cessation: null, endedAt: null } });
  assert.equal(carrySource(previous([interrupted], 'unconfirmed')), null, 'never before the cessation of the interrupted Execution is confirmed');
  const source = carrySource(previous([round(3), interrupted]))!;
  assert.equal(source.round.round, 4, 'the last review round');
  assert.deepEqual(undiscovered(source.round), ['spec']);
  const same = { source, summary: summary(5), identity: observed(), profile };
  const plan = carryPlan({ ...same, discovered: { spec: opinion('spec', 4) } });
  assert.deepEqual(Object.keys(plan).sort(), ['spec', 'standards']);
  assert.deepEqual(plan.standards!.from, { executionId: 'e1', round: 4, attempt: 1, invocationId: 'standards-e1-r4a1', indexSha256: '4'.repeat(64), contentSha256: '7'.repeat(64), discovered: false });
  assert.equal(plan.spec!.from.discovered, true);
  assert.deepEqual(Object.keys(carryPlan(same)), ['standards'], 'nothing discovered: Spec is reviewed again, Standards kept');
  assert.deepEqual(Object.keys(carryPlan({ ...same, discovered: { spec: opinion('spec', 4, { conclusion: 'failure', code: 'REVIEW_VERDICT_INVALID' }) } })), ['standards'],
    'a discovered failure is not carried as a result');
  assert.deepEqual(Object.keys(carryPlan({ ...same, discovered: { spec: opinion('spec', 4, { attempt: 2 }) } })), ['standards'], 'never an uncorrelated record');
  // Relevant change: no equivalence is computed, BOTH reviewers give new opinions.
  assert.deepEqual(carryPlan({ ...same, summary: summary(5, '8') }), {}, 'content changed');
  assert.deepEqual(carryPlan({ ...same, summary: summary(5, '7', { spec: { version: 'v2', sources: 's', sha256: '3'.repeat(64) } }) }), {}, 'request version changed');
  assert.deepEqual(carryPlan({ ...same, summary: summary(5, '7', { base: 'e'.repeat(40) }) }), {}, 'context (base) changed');
  assert.deepEqual(carryPlan({ ...same, identity: observed('i', 'x', false) }), {}, 'inconsistent host identity');
  assert.deepEqual(carryPlan({ ...same, profile: { ...profile, reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 1024 } } }), {}, 'reviewer profile changed');
  assert.deepEqual(carryPlan({ ...same, source: null }), {});
  const failedSource = carrySource(previous([round(4, { spec: failed('WORKER_INTERRUPTED') })]))!;
  assert.deepEqual(Object.keys(carryPlan({ ...same, source: failedSource })), ['standards'], 'only the failed one is re-obtained');
});

test('AC3/AC6: a carried opinion correlates through its provenance; verification accepts it only over the very content it reviewed', () => {
  const carried = (content = '7') => {
    const value = round(5, {}, content);
    value.reviewers.spec = { ...view('spec', 4), invocationId: 'spec-e1-r4a1', source: 'carried', cessation: 'never-started',
      carried: { executionId: 'e1', round: 4, attempt: 1, invocationId: 'spec-e1-r4a1', indexSha256: '4'.repeat(64), contentSha256: '7'.repeat(64), discovered: true } };
    return { ...value, state: 'delivered' as const, closing: true, conclusion: 'clean' as const, applicability: 'current' as const,
      declarations: { treatments: [], gates: [{ id: 'g', source: 's', command: 'c', cwd: '/w', requiredCheck: null, declared: 'run' as const, outcome: 'passed' as const, code: null, exitCode: 0,
        output: null, sequence: 1, current: true, reason: null, authorization: null }] } };
  };
  assert.equal(opinionCorrelated(carried(), 'spec'), true);
  assert.equal(opinionCorrelated(carried('8'), 'spec'), false, 'carried onto other content');
  const forged = carried();
  forged.reviewers.spec = { ...forged.reviewers.spec, source: 'notification' };
  assert.equal(opinionCorrelated(forged, 'spec'), false, 'without provenance an old-round opinion never correlates');
  const verify = (value: ReviewRoundView) => verifyExecution({ at: 'now', workId: 'w', rounds: [value], question: () => null, source: () => false });
  assert.deepEqual(verify(carried()).reasons, []);
  assert.ok(verify(carried('8')).reasons.includes('SPEC_OPINION_NOT_CORRELATED'));
  assert.deepEqual(notRetriedReasons(round(1, { spec: { notRetried: { code: 'PROPOSAL_CHANGED', at: 'now' } } })), ['SPEC_NOT_RETRIED:PROPOSAL_CHANGED']);
});

test('AC6: the substitute session gets the preserved review state as context only (delivery is not consumption), bounded', () => {
  const delivered = { ...round(4, { spec: failed('WORKER_INTERRUPTED'), standards: { opinion: opinion('standards', 4, { conclusion: 'findings',
    findings: [{ id: 'H1', basis: 'heuristic', reference: 'r', location: { path: '/workspace/checkout/a.md' }, summary: 'x'.repeat(2000) }] }) } }),
  state: 'delivered' as const, conclusion: 'incomplete' as const, delivery: { requestedAt: 'now', outcome: 'delivered' as const, code: null, promptSha256: 'p' } };
  const text = preservedReviewContext([delivered])!;
  assert.match(text, /round 4 \(delivered; conclusion incomplete; delivery to the previous Builder session: delivered, not proof that it was consumed\)/);
  assert.match(text, /"role":"standards","conclusion":"findings"/);
  assert.match(text, /"role":"spec","conclusion":"failure","code":"WORKER_INTERRUPTED"/);
  assert.match(text, /treat the findings of the results it then delivers to you \(their round\), never these/);
  const unknown = preservedReviewContext([round(4, { spec: { state: 'started', opinion: null, cessation: null } })])!;
  assert.match(unknown, /"role":"spec","conclusion":"unknown","code":"OUTCOME_NOT_RECORDED"/, 'an unrecorded outcome is unknown, never clean');
  assert.ok(Buffer.byteLength(preservedReviewContext([delivered], 900)!) <= 900 + 64);
  assert.equal(preservedReviewContext([]), null);
});

test('review LOW: an INCOMPLETE opinion is never carried as valid; the role is reviewed again', () => {
  const source = carrySource({ executionId: 'e1', review: { rounds: [round(4, { standards: { opinion: opinion('standards', 4, { conclusion: 'incomplete' }) } })] },
    end: { at: 'now', outcome: 'failure', code: 'CONTROLLER_CRASH', cessation: 'confirmed' }, request: {} as ExecutionView['request'] });
  assert.deepEqual(Object.keys(carryPlan({ source, summary: summary(5), identity: observed(), profile })), ['spec']);
  assert.deepEqual(Object.keys(carryPlan({ source, summary: summary(5), identity: observed(), profile, discovered: {} })), ['spec']);
});

test('review HIGH 2: the carry compares a normalized pack identity, with the PRODUCTION shapes (seed object from prepare, key order, prefix)', () => {
  // Production: request.skillPack is the prepared seed {name: 'factory/skill-pack/<id>', manifestSha256}; the policy carries the bare id string.
  const request = { skillPack: { manifestSha256: 'f'.repeat(64), name: 'factory/skill-pack/factory-skills-v5' }, policies: { skillPack: 'factory-skills-v5' as const } };
  const recorded = reviewProfile(request as ExecutionView['request'], { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 });
  const reparsed = JSON.parse(JSON.stringify({ reviewer: { imageSourceMaxBytes: 5242880, modelBudget: 'reviewer-v1' }, builder: {}, skillPack: { manifestSha256: 'f'.repeat(64), name: 'factory/skill-pack/factory-skills-v5' } }));
  assert.equal(sameReviewProfile(recorded, reparsed), true, 'key order never matters');
  assert.equal(sameReviewProfile(recorded, reviewProfile(request as ExecutionView['request'], { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 })), true);
  assert.deepEqual(packIdentity('factory-skills-v5'), { name: 'factory-skills-v5', manifestSha256: null });
  assert.deepEqual(packIdentity(request.skillPack), { name: 'factory-skills-v5', manifestSha256: 'f'.repeat(64) });
  assert.equal(sameReviewProfile(recorded, { ...recorded, skillPack: 'factory-skills-v5' }), false, 'a bare id cannot demonstrate the same manifest');
  assert.equal(sameReviewProfile(recorded, { ...recorded, skillPack: { name: 'factory/skill-pack/factory-skills-v5', manifestSha256: 'e'.repeat(64) } }), false);
  assert.equal(sameReviewProfile(recorded, { ...recorded, reviewer: { modelBudget: 'reviewer-v1' } }), false);
  // End to end through carryPlan with the recorded production profile.
  const interrupted = { ...round(4), versions: { ...round(4).versions, profile: recorded } };
  const source = carrySource({ executionId: 'e1', review: { rounds: [interrupted] }, end: { at: 'now', outcome: 'failure', code: 'CONTROLLER_CRASH', cessation: 'confirmed' },
    request: {} as ExecutionView['request'] });
  assert.deepEqual(Object.keys(carryPlan({ source, summary: summary(5), identity: observed(), profile: reparsed })).sort(), ['spec', 'standards']);
  assert.deepEqual([identityChange(observed(), observed()), identityChange(observed(), observed('j')), identityChange(null, observed())], [null, 'PROPOSAL_CHANGED', 'PROPOSAL_IDENTITY_UNKNOWN']);
});

test('review HIGH 1 (records before ticket 57): reconciliation settles an outstanding retry reservation — receipt consumes once, proven absence releases, uncertainty keeps', () => {
  const make = () => {
    const value = round(1, { spec: { state: 'started', attempt: 2, invocationId: 'spec-e1-r1a2', opinion: null, cessation: null, charge: { counter: 'recoveries', state: 'reserved', settledAt: null } } });
    const execution = { executionId: 'e1', review: { rounds: [value] } } as unknown as ExecutionView;
    const work = { budget: { recoveries: { limit: 3, granted: 0, consumed: 0, reserved: 'spec-e1-r1a2' } }, history: [] } as unknown as WorkRecord;
    return { execution, work, reviewer: value.reviewers.spec };
  };
  const consumed = make();
  assert.deepEqual(pendingReviewerReservations(consumed.execution), [{ round: 1, role: 'spec', invocationId: 'spec-e1-r1a2' }]);
  assert.deepEqual(settleReviewerReservations(consumed.work, consumed.execution, { cessation: 'confirmed', receipt: () => ({ kind: 'receipt', id: 'r9' }) }),
    [{ invocationId: 'spec-e1-r1a2', outcome: 'consumed' }]);
  assert.deepEqual([consumed.work.budget!.recoveries.consumed, consumed.work.budget!.recoveries.reserved, consumed.reviewer.charge?.state, consumed.reviewer.receiptId], [1, null, 'consumed', 'r']);
  assert.deepEqual(settleReviewerReservations(consumed.work, consumed.execution, { cessation: 'confirmed', receipt: () => ({ kind: 'receipt', id: 'r9' }) }), [], 'consumed once');
  const released = make();
  settleReviewerReservations(released.work, released.execution, { cessation: 'confirmed', receipt: () => ({ kind: 'absent' }) });
  assert.deepEqual([released.work.budget!.recoveries.consumed, released.work.budget!.recoveries.reserved, released.reviewer.charge?.state], [0, null, 'released']);
  for (const input of [{ cessation: 'confirmed' as const, receipt: () => ({ kind: 'uncertain' as const, code: 'X' }) }, { cessation: 'unconfirmed' as const, receipt: () => ({ kind: 'absent' as const }) }]) {
    const kept = make();
    assert.deepEqual(settleReviewerReservations(kept.work, kept.execution, input), [{ invocationId: 'spec-e1-r1a2', outcome: 'kept' }]);
    assert.deepEqual([kept.work.budget!.recoveries.reserved, kept.reviewer.charge?.state], ['spec-e1-r1a2', 'reserved'], 'never settled by guess');
  }
});

test('ticket 26 composition: a reviewer recorded interrupted with the boot (failed/boot-ceased, no opinion) is an unrecorded outcome — looked up in Records, carried if found', () => {
  const settled = round(4, { standards: { state: 'failed', opinion: null, failure: { code: 'EXECUTION_INTERRUPTED' }, cessation: 'boot-ceased' } });
  assert.deepEqual(undiscovered(settled), ['standards']);
  const source = carrySource({ executionId: 'e1', review: { rounds: [settled] }, end: { at: 'now', outcome: 'failure', code: 'CONTROLLER_CRASH', cessation: 'confirmed' },
    request: {} as ExecutionView['request'] });
  const plan = carryPlan({ source, summary: summary(5), identity: observed(), profile, discovered: { standards: opinion('standards', 4) } });
  assert.deepEqual([Object.keys(plan).sort(), plan.standards?.from.discovered], [['spec', 'standards'], true]);
  assert.deepEqual(undiscovered(round(4, { spec: { state: 'failed', opinion: null, failure: { code: 'WORKER_INTERRUPTED' }, cessation: 'completion-observed' } })), [],
    'a recorded failure is an outcome, not a lost notification');
});

test('operator decision 2026-11-15: opinions are carried ONLY after an operational recovery; after an administrative stop both review again', () => {
  assert.equal(carryBasis({ previousExecutionId: 'e1', reason: 'OPERATIONAL_RECOVERY', code: 'CONTROLLER_CRASH' }), 'e1');
  assert.equal(carryBasis({ previousExecutionId: 'e1', reason: 'ADMINISTRATIVE_STOP', code: 'ADMINISTRATIVE_STOP' }), null);
  assert.equal(carryBasis(null), null);
  assert.equal(carryBasis(undefined), null);
});
