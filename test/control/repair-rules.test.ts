import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateChecks, type ChecksExpectation } from '../../src/control/rules/checks.js';
import { correctionClosure, correctionNextStep, fingerprint, queueOrder, repairDecision, repairPreserve, repairSection, repairTriggers, updateStrategy, updateTarget } from '../../src/control/rules/repair.js';
import { publishableContent } from '../../src/control/rules/publication.js';
import { humanTips } from '../../src/control/rules/divergence.js';
import type { ClosedCorrection, PublicationView, RepairReason, WorkCorrection } from '../../src/control/types.js';
import { basisExecution, observedPull, readyPublication } from './readiness-seed.js';

// Ticket 22 pure rules (R, controlled data): effective impediments of the own PR versus non-triggers, consolidation/withdrawal/repeated
// events, closure without waiting for CI, the repair queue order and the Builder's repair section. No I/O; not evidence of GitHub.
const head = 'd'.repeat(40), tip = 'b'.repeat(40), newer = '9'.repeat(40);
const expect: ChecksExpectation = { own: { pullRequestId: 9007, nodeId: 'PR_node7', number: 7, headRef: 'factory/3-abcdef12', base: 'main', authorId: 41898282 },
  repositoryId: 3, linkedHeads: [head], localRequiredChecks: [] };
const complete = <T>(value: T) => ({ state: 'complete' as const, value });
const publication: PublicationView = readyPublication('11111111-2222-4333-8444-555555555555');
type Observed = ReturnType<typeof observedPull>;
type RunFact = Extract<Observed['checkRuns'], { state: 'complete' }>['value'][number];
const run = (id: number, name: string, conclusion: string | null, status = 'completed', sha = head): RunFact => ({ id, name, headSha: sha, status, conclusion, appId: 15368,
  appSlug: 'github-actions', checkSuiteId: 500 + id, startedAt: '2026-11-15T10:00:00Z', completedAt: null, url: `https://github.com/acme/project/runs/${id}` });
const required = (strict: boolean, contexts: string[]) => complete({ kind: 'required' as const, strict, enforcement: 'everyone', checks: contexts.map(context => ({ context, integrationId: null })), settings: null });
function evaluation(change: (observed: Observed) => void = () => {}, extra: Parameters<typeof observedPull>[0] = {}) {
  const observed = observedPull(extra);
  change(observed);
  observed.final = { baseTip: observed.baseTip, classic: observed.classic, rules: observed.rules };
  return evaluateChecks({ at: '2026-11-15T12:00:00.000Z', expect, observation: observed });
}
const triggers = (checks: ReturnType<typeof evaluation> | null, readiness: Parameters<typeof repairTriggers>[0]['readiness'] = null) => repairTriggers({ checks, publication, readiness });
const codes = (outcome: ReturnType<typeof triggers>) => outcome.kind === 'triggers' ? outcome.reasons.map(item => `${item.code}:${item.subject ?? ''}`) : outcome.why;

test('AC1: confirmed conflict, a current required check that failed and an effective strict update are triggers, each with its evidence', () => {
  const conflict = triggers(evaluation(() => {}, { mergeable: false }));
  assert.deepEqual(codes(conflict), ['MERGE_CONFLICT:main']);
  assert.ok(conflict.kind === 'triggers' && conflict.reasons[0]!.headSha === head && conflict.reasons[0]!.baseTip === tip && conflict.reasons[0]!.evidence.includes('mergeable:false'));
  const failed = triggers(evaluation(observed => { observed.classic = required(false, ['ci']); observed.checkRuns = complete([run(1, 'ci', 'failure')]); }));
  assert.deepEqual(codes(failed), ['REQUIRED_CHECK_FAILED:ci']);
  assert.ok(failed.kind === 'triggers' && failed.reasons[0]!.evidence[0]!.includes('https://github.com/acme/project/runs/1'), 'the failing result is the evidence');
  const strict = triggers(evaluation(observed => { observed.classic = required(true, ['ci']); observed.checkRuns = complete([run(1, 'ci', 'success')]);
    observed.comparison = complete({ status: 'diverged', aheadBy: 1, behindBy: 2 }); }));
  assert.deepEqual(codes(strict), ['STRICT_UPDATE_REQUIRED:main']);
  const both = triggers(evaluation(observed => { observed.classic = required(false, ['ci', 'lint']); observed.checkRuns = complete([run(1, 'ci', 'failure'), run(2, 'lint', 'failure')]); }, { mergeable: false }));
  assert.deepEqual(codes(both), ['MERGE_CONFLICT:main', 'REQUIRED_CHECK_FAILED:ci', 'REQUIRED_CHECK_FAILED:lint'], 'independent reasons, consolidated in one outcome');
});

test('AC1: pending CI, unknown mergeability, optional/old results, loose lag (base advancing), operational causes, merge-blocking rules and human flags never trigger', () => {
  const none = (outcome: ReturnType<typeof triggers>) => { assert.equal(outcome.kind, 'none', JSON.stringify(outcome)); return outcome.kind === 'none' ? outcome.why : []; };
  none(triggers(evaluation(observed => { observed.classic = required(false, ['ci']); observed.checkRuns = complete([run(1, 'ci', null, 'in_progress')]); })));
  none(triggers(evaluation(() => {}, { mergeable: null })));
  none(triggers(evaluation(observed => { observed.checkRuns = complete([run(1, 'optional-lint', 'failure')]); })));
  none(triggers(evaluation(observed => { observed.classic = required(false, ['ci']); observed.checkRuns = complete([run(1, 'ci', 'success'), run(2, 'ci', 'failure', 'completed', 'c'.repeat(40))]); })));
  none(triggers(evaluation(observed => { observed.comparison = complete({ status: 'behind', aheadBy: 1, behindBy: 5 }); }, { baseTip: newer })));
  none(triggers(evaluation(observed => { observed.classic = required(false, ['ci']); observed.checkRuns = complete([run(1, 'ci', 'action_required')]); })));
  // Strict while CI is still pending on the head: the base moving is not (yet) an effective requirement.
  none(triggers(evaluation(observed => { observed.classic = required(true, ['ci']); observed.checkRuns = complete([run(1, 'ci', null, 'queued')]);
    observed.comparison = complete({ status: 'diverged', aheadBy: 1, behindBy: 2 }); })));
  // Ticket 39: a base rule blocking the human merge is the operator's (never repaired, never bypassed).
  none(triggers(evaluation(() => {}, { rules: [{ type: 'pull_request', ruleset: { id: 1, sourceType: 'Repository', source: 'acme/project' } },
    { type: 'required_deployments', ruleset: { id: 2, sourceType: 'Repository', source: 'acme/project' }, parameters: { kind: 'required_deployments', environments: ['prod'] } }] })));
  assert.deepEqual(none(triggers(evaluation(() => {}, { mergeable: false }), { humanDraft: { observedAt: 'x', headSha: head }, humanReady: null })), ['HUMAN_DRAFT']);
  assert.deepEqual(none(triggers(evaluation(() => {}, { mergeable: false, headSha: '7'.repeat(40), recheckHead: '7'.repeat(40) }))), ['HEAD_NOT_LINKED_BY_FACTORY'], 'a human head is ticket 21');
  assert.deepEqual(none(triggers(evaluation(() => {}, { mergeable: false, recheckHead: newer }))), ['EVALUATION_INDETERMINATE'], 'a changed head during collection decides nothing');
  assert.deepEqual(none(repairTriggers({ checks: evaluation(() => {}, { mergeable: false }), publication: { ...publication, state: 'awaiting-discovery' } })), ['OWN_PULL_REQUEST_NOT_PUBLISHED']);
  assert.deepEqual(none(triggers(null)), ['CHECKS_NOT_EVALUATED']);
});

const reason = (code: RepairReason['code'], subject: string | null, sha = head, baseTip: string | null = tip): RepairReason =>
  ({ code, subject, headSha: sha, baseTip, observedAt: '2026-11-15T12:00:00.000Z', evidence: [] });
const open = (reasons: RepairReason[], consumed = false): WorkCorrection => ({ correctionId: 'c1', reason: 'x', openedAt: 'x', consumed, trigger: 'effective-impediment', sequence: 1, reasons });
const closed = (reasons: RepairReason[]): ClosedCorrection => ({ correctionId: 'c0', sequence: 1, openedAt: 'x', closedAt: 'y', charged: true, outcome: 'published', reasons, head, basisExecutionId: 'e' });
const t = (reasons: RepairReason[]) => reasons.length ? { kind: 'triggers' as const, reasons } : { kind: 'none' as const, why: ['NO_EFFECTIVE_IMPEDIMENT'], certain: true };

test('AC2/AC3/AC4/AC6: open, consolidate (same identity), withdraw without charge, record during a charged correction, and never re-spend on a repeated event', () => {
  const conflict = reason('MERGE_CONFLICT', 'main'), ci = reason('REQUIRED_CHECK_FAILED', 'ci');
  assert.deepEqual(repairDecision({ triggers: t([conflict]), correction: null, closed: [] }), { kind: 'open', reasons: [conflict] });
  const consolidated = repairDecision({ triggers: t([conflict, ci]), correction: open([conflict]), closed: [] });
  assert.ok(consolidated.kind === 'consolidate' && consolidated.added.length === 1 && consolidated.reasons.length === 2, 'a repeated/new event folds into the same correction');
  assert.equal(repairDecision({ triggers: t([{ ...conflict, observedAt: 'later' }]), correction: open([conflict]), closed: [] }).kind, 'none', 'the same event observed again changes nothing');
  const refreshed = repairDecision({ triggers: t([reason('MERGE_CONFLICT', 'main', head, newer)]), correction: open([conflict]), closed: [] });
  assert.ok(refreshed.kind === 'consolidate' && refreshed.reasons[0]!.baseTip === newer, 'details refreshed (current base tip)');
  const dropped = repairDecision({ triggers: t([ci]), correction: open([conflict, ci]), closed: [] });
  assert.ok(dropped.kind === 'consolidate' && dropped.dropped.length === 1 && dropped.reasons.length === 1);
  assert.deepEqual(repairDecision({ triggers: t([]), correction: open([conflict]), closed: [] }), { kind: 'withdraw', dropped: [conflict] });
  assert.equal(repairDecision({ triggers: t([]), correction: { ...open([]), trigger: 'internal' }, closed: [] }).kind, 'none', 'an internal/explicit correction is not withdrawn by observation');
  const during = repairDecision({ triggers: t([conflict, ci]), correction: open([conflict], true), closed: [] });
  assert.ok(during.kind === 'defer' && during.added.length === 1, 'kept pending for the next safe activation of the charged correction');
  assert.equal(repairDecision({ triggers: t([]), correction: open([conflict], true), closed: [] }).kind, 'none', 'a charged correction is never withdrawn');
  const repeated = repairDecision({ triggers: t([conflict]), correction: null, closed: [closed([conflict])] });
  assert.deepEqual(repeated, { kind: 'repeated', reasons: [conflict], correctionIds: ['c0'] });
  assert.equal(repairDecision({ triggers: t([reason('MERGE_CONFLICT', 'main', newer)]), correction: null, closed: [closed([conflict])] }).kind, 'open', 'a new failure on a NEW head is a new correction');
  assert.equal(repairDecision({ triggers: t([conflict]), correction: null, closed: [{ ...closed([conflict]), charged: false, outcome: 'withdrawn' }] }).kind, 'open',
    'a withdrawn correction never ran: the same event may open a correction again');
  assert.notEqual(fingerprint(conflict), fingerprint(reason('MERGE_CONFLICT', 'main', newer)));
});

const execution = (id: string, outcome: string | null, extra: { correctionId?: string | null; publication?: boolean; state?: string; held?: boolean; cessation?: string } = {}) => ({
  executionId: id, state: extra.state ?? 'ended', slot: { held: extra.held ?? false }, end: outcome ? { outcome, cessation: extra.cessation ?? 'confirmed' } : null,
  charge: { correctionId: extra.correctionId === undefined ? 'c1' : extra.correctionId }, request: extra.publication ? { publication: {} } : {} });
test('AC6: a charged correction closes after its result is published (no CI wait), not publishable or settled; a question/failure/pending publication keeps it open', () => {
  const correction = open([reason('MERGE_CONFLICT', 'main')], true);
  const base = { correction, previousExecutions: [execution('e0', 'completed', { correctionId: null }), execution('r1', 'completed')], queuePending: false };
  const published = { ...publication, basisExecutionId: 'r1', verified: { ...publication.verified!, head: newer } };
  assert.deepEqual(correctionClosure({ ...base, execution: execution('p1', 'completed', { publication: true }), publication: published }),
    { kind: 'close', outcome: 'published', head: newer, basisExecutionId: 'r1' });
  assert.equal(correctionClosure({ ...base, execution: execution('p1', 'completed', { publication: true }), publication: { ...published, state: 'awaiting-discovery' } }).kind, 'open');
  assert.equal(correctionClosure({ ...base, execution: execution('p1', 'completed', { publication: true }), publication: { ...published, state: 'requested' }, queuePending: true }).kind, 'open');
  assert.deepEqual(correctionClosure({ ...base, previousExecutions: [execution('e0', 'completed', { correctionId: null })], execution: execution('r1', 'completed'),
    publication: { ...published, state: 'not-publishable', verified: null } }), { kind: 'close', outcome: 'not-publishable', head: null, basisExecutionId: 'r1' });
  assert.equal(correctionClosure({ ...base, previousExecutions: [], execution: execution('r1', 'question'), publication }).kind, 'open', 'a Question keeps the same correction/charge');
  assert.equal(correctionClosure({ ...base, previousExecutions: [], execution: execution('r1', 'completed', { held: true }), publication: published }).kind, 'open', 'no cessation');
  assert.equal(correctionClosure({ ...base, correction: open([], false), execution: execution('r1', 'completed'), publication: published }).kind, 'open', 'never charged = never closed here');
  assert.equal(correctionClosure({ ...base, execution: execution('p1', 'completed', { publication: true }), publication }).kind, 'open', 'publication of another basis');
});

test('AC3: repairs are selected before normal Works, FIFO by repair sequence, normal FIFO by admission, without reordering by events', () => {
  const work = (id: string, sequence: number, repairSequence?: number) => ({ id, queue: { category: repairSequence ? 'repair' as const : 'normal' as const, sequence, pending: true,
    ...(repairSequence ? { repairSequence } : {}) } });
  assert.deepEqual(queueOrder([work('n1', 1), work('r2', 4, 2), work('n2', 2), work('r1', 5, 1)]).map(item => item.id), ['r1', 'r2', 'n1', 'n2']);
});

test('AC5: the Builder gets every reason with its evidence, the base update target, and never a push/bypass/merge instruction', () => {
  const reasons = [{ ...reason('MERGE_CONFLICT', 'main', head, newer), evidence: ['mergeable:false'] }, { ...reason('REQUIRED_CHECK_FAILED', 'ci'), evidence: ['check-run:ci:failure:https://x/1'] }];
  assert.deepEqual(updateTarget(reasons), { tip: newer });
  assert.equal(updateTarget([reason('REQUIRED_CHECK_FAILED', 'ci')]), null, 'a failing check alone never rebases');
  const text = repairSection({ correctionId: 'c1', base: 'main', branch: 'factory/3-x', checkout: '/workspace/checkout', reasons }).join('\n');
  for (const fact of ['correction c1', 'MERGE_CONFLICT (main)', 'REQUIRED_CHECK_FAILED (ci)', 'check-run:ci:failure:https://x/1', `FETCH_HEAD is exactly ${newer}`, 'rebase', 'ask_user',
    'NEVER push in this activation']) assert.ok(text.includes(fact), fact);
  assert.ok(!/--force(?!-with-lease)/.test(text) && /Never merge, approve, mark ready/.test(text));
});

test('supervisor decision 3: with human commits on the branch the base is MERGED into it (SHAs kept; rebase mandated by AGENTS.md = ask_user); rebase only with own commits only', () => {
  const conflict = [{ ...reason('MERGE_CONFLICT', 'main', head, newer), evidence: [] }];
  const divergence = (current: string) => ({ current, kind: 'divergence', comparison: { state: 'unknown', code: 'x' } });
  const incorporated = { ...publication, divergences: [divergence('1'.repeat(40)), divergence('2'.repeat(40)), divergence('3'.repeat(40))], waived: ['2'.repeat(40)] } as unknown as PublicationView;
  assert.deepEqual(humanTips(incorporated), ['1'.repeat(40), '3'.repeat(40)], 'the tips ticket 21 requires at linking; a waived (discarded) one is not kept');
  assert.deepEqual(humanTips(publication), []);
  assert.deepEqual(updateStrategy(conflict, []), 'rebase');
  assert.deepEqual(updateStrategy(conflict, ['1'.repeat(40)]), 'merge');
  assert.equal(updateStrategy([reason('REQUIRED_CHECK_FAILED', 'ci')], ['1'.repeat(40)]), null, 'no base update at all');
  const merged = repairSection({ correctionId: 'c1', base: 'main', branch: 'factory/3-x', checkout: '/workspace/checkout', reasons: conflict, humanTips: ['1'.repeat(40)] }).join('\n');
  for (const fact of ['git -C /workspace/checkout merge --no-ff FETCH_HEAD', 'NEVER rebase', `1`.repeat(40), 'AGENTS.md', 'ask_user']) assert.ok(merged.includes(fact), fact);
  assert.ok(!/rebase your commits onto it by default/.test(merged));
  const rebased = repairSection({ correctionId: 'c1', base: 'main', branch: 'factory/3-x', checkout: '/workspace/checkout', reasons: conflict, humanTips: [] }).join('\n');
  assert.ok(rebased.includes('rebase your commits onto it by default') && !rebased.includes('merge --no-ff'));
});

test('supervisor decision 3: a repair over human commits is publishable only when the Host capture proves the human tip is an ancestor of the new head', () => {
  const tip = '1'.repeat(40);
  const repairExecution = (preserved?: { commit: string; ancestor: boolean }) => {
    const execution = basisExecution('r1', newer);
    execution.request.repair = { correctionId: 'c1', reasons: [reason('MERGE_CONFLICT', 'main')], headSha: head, baseTip: newer, humanTips: [tip] };
    if (preserved) execution.review!.rounds[0]!.handoff.summary = { ...execution.review!.rounds[0]!.handoff.summary!, preserved };
    return execution;
  };
  assert.deepEqual(publishableContent(repairExecution()).ok, false);
  assert.ok(!publishableContent(repairExecution()).ok && (publishableContent(repairExecution()) as { reasons: string[] }).reasons.includes('HUMAN_CHANGE_PRESERVATION_UNKNOWN'));
  assert.ok((publishableContent(repairExecution({ commit: tip, ancestor: false })) as { reasons: string[] }).reasons.includes('HUMAN_CHANGE_NOT_PRESERVED'));
  assert.equal(publishableContent(repairExecution({ commit: tip, ancestor: true })).ok, true);
  assert.equal(repairPreserve({ correctionId: 'c1', reasons: [], headSha: head, baseTip: null, humanTips: ['1'.repeat(40), '3'.repeat(40)] }), '3'.repeat(40), 'the latest incorporated tip');
  assert.equal(repairPreserve({ correctionId: 'c1', reasons: [], headSha: head, baseTip: null }), null);
});

test('supervisor decision 1: under strict, the next step says each base advance costs a correction from the budget', () => {
  const strict = [reason('STRICT_UPDATE_REQUIRED', 'main')];
  assert.match(correctionNextStep(strict, { limit: 3, granted: 0, consumed: 1, reserved: null }), /each advance of the base.*new correction.*corrections budget.*2 of 3 left.*factory grant/s);
  assert.doesNotMatch(correctionNextStep([reason('MERGE_CONFLICT', 'main')], { limit: 3, granted: 0, consumed: 0, reserved: null }), /each advance of the base/);
});

test('review HIGH: an uncertain or ineligible read decides NOTHING — the uncharged correction stays; only a confirmed complete read without impediment withdraws', () => {
  const conflict = reason('MERGE_CONFLICT', 'main');
  const uncertain = [triggers(null), triggers(evaluation(() => {}, { mergeable: false, recheckHead: newer })), triggers(evaluation(() => {}, { mergeable: false }), { humanDraft: { observedAt: 'x', headSha: head }, humanReady: null }),
    triggers(evaluation(() => {}, { mergeable: false, headSha: '7'.repeat(40), recheckHead: '7'.repeat(40) })), triggers(evaluation(() => {}, { state: 'closed' })),
    repairTriggers({ checks: evaluation(() => {}, { mergeable: false }), publication: { ...publication, state: 'awaiting-discovery' } })];
  for (const outcome of uncertain) {
    assert.ok(outcome.kind === 'none' && !outcome.certain, JSON.stringify(outcome));
    assert.equal(repairDecision({ triggers: outcome, correction: open([conflict]), closed: [] }).kind, 'none', 'kept with its queue position');
  }
  const resolved = triggers(evaluation(() => {}, { mergeable: true }));
  assert.ok(resolved.kind === 'none' && resolved.certain);
  assert.equal(repairDecision({ triggers: resolved, correction: open([conflict]), closed: [] }).kind, 'withdraw');
});

test('review LOW: a failed required check needs matching failed-result evidence; conflict/strict fingerprints include the base tip', () => {
  const noEvidence = evaluation(observed => { observed.classic = required(false, ['ci']); observed.checkRuns = complete([run(1, 'ci', 'failure')]); });
  noEvidence.requirements = noEvidence.requirements.map(item => ({ ...item, results: [] }));
  const outcome = triggers(noEvidence);
  assert.ok(outcome.kind === 'none' && !outcome.certain, 'a failure without evidence is uncertain, never a trigger');
  assert.notEqual(fingerprint(reason('MERGE_CONFLICT', 'main', head, tip)), fingerprint(reason('MERGE_CONFLICT', 'main', head, newer)));
  assert.notEqual(fingerprint(reason('STRICT_UPDATE_REQUIRED', 'main', head, tip)), fingerprint(reason('STRICT_UPDATE_REQUIRED', 'main', head, newer)));
  assert.equal(fingerprint(reason('REQUIRED_CHECK_FAILED', 'ci', head, tip)), fingerprint(reason('REQUIRED_CHECK_FAILED', 'ci', head, newer)), 'a check failure is the head\'s');
});

test('review MED: reasons observed after the charge are DEFERRED (pending, uncharged), never recorded as treated', () => {
  const conflict = reason('MERGE_CONFLICT', 'main'), ci = reason('REQUIRED_CHECK_FAILED', 'ci');
  assert.deepEqual(repairDecision({ triggers: t([conflict, ci]), correction: open([conflict], true), closed: [] }), { kind: 'defer', added: [ci] });
  assert.equal(repairDecision({ triggers: t([conflict, ci]), correction: { ...open([conflict], true), pendingReasons: [ci] }, closed: [] }).kind, 'none', 'already pending');
});
