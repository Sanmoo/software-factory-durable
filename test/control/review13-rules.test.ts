import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCapture, deliveryPrompt, exemptionPrompt, planReviews, verifyExecution } from '../../src/control/rules/review.js';
import type { GateEvidence, HandoffDeclarations, ProposalHandoff, ProposalIdentity, ReviewOpinion } from '../../src/contracts/index.js';
import type { ReviewRoundView } from '../../src/control/types.js';

// Rules level (R): pure functions over canonical types. Ticket 13: when a new round is needed, and Control's end-of-Execution verification.
const summary = (round: number, content: Partial<NonNullable<ProposalHandoff['content']>> = {}, extra: Partial<ProposalHandoff> = {}): ProposalHandoff => ({
  version: 1, round, index: `/artifacts/review/r${round}/index.json`, indexSha256: String(round).repeat(64).slice(0, 64), head: 'b'.repeat(40), branch: 'factory/3-x',
  base: 'a'.repeat(40), mergeBase: 'a'.repeat(40), counts: { entries: 1, committed: 0, staged: 0, unstaged: 1, untracked: 0, removed: 0 },
  patches: { committed: { path: `/artifacts/review/r${round}/committed.patch`, bytes: 0, sha256: 'c'.repeat(64) }, staged: { path: `/artifacts/review/r${round}/staged.patch`, bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: `/artifacts/review/r${round}/unstaged.patch`, bytes: 3, sha256: 'c'.repeat(64) } },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) }, instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/docs/a.md'], changedTruncated: false, content: { sha256: '7'.repeat(64), clean: false, headMatches: false, ...content }, ...extra });
const identity = (consistent = true): ProposalIdentity => ({ status: 'observed', sha256: 'i'.repeat(64), indexSha256: 'x', entries: 1, consistent, observedAt: 'now' });
const opinion = (role: 'standards' | 'spec', round: number, findings: string[] = []): ReviewOpinion => ({ version: 1, role, round, attempt: 1, invocationId: `${role}-e-r${round}a1`,
  reference: { workId: 'w', id: '11111111-2222-4333-8444-555555555555' }, session: { file: `/run/w-${role}${round}/profile/sessions/s.jsonl` }, model: { providerId: 'openai', modelId: 'gpt-6-luna' },
  profile: { id: 'p', modelBudget: 'reviewer-v1' }, input: { handoffIndexSha256: String(round).repeat(64).slice(0, 64), required: [], missing: [] },
  conclusion: findings.length ? 'findings' : 'clean', code: null, coverage: { scope: 'broad', justification: 'j', examined: [] },
  findings: findings.map(id => ({ id, basis: role === 'spec' ? 'requirement' as const : 'heuristic' as const, reference: 'r', location: { path: '/workspace/checkout/docs/a.md' }, summary: 's' })),
  limitations: [], hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: null, recordedAt: 'now' });
const reviewer = (role: 'standards' | 'spec', round: number, value: ReviewOpinion | null) => ({ invocationId: `${role}-e-r${round}a1`, phaseId: `review-r${round}`, promptSha256: 'p',
  state: value ? 'ended' as const : 'failed' as const, requestedAt: 'now', receiptId: null, endedAt: 'now', opinion: value, failure: value ? null : { code: 'REVIEWER_UNAVAILABLE' },
  cessation: 'completion-observed' as const, input: { required: [], missing: [] } });
const gate = (id: string, outcome: GateEvidence['outcome'], extra: Partial<GateEvidence> = {}): GateEvidence => ({ id, source: 'ticket#validation', command: `run ${id}`, cwd: '/workspace/checkout',
  requiredCheck: null, declared: outcome === 'not-run' || outcome === 'waived' ? outcome : 'run', outcome, code: null, exitCode: outcome === 'passed' ? 0 : null, output: null, sequence: 1,
  current: true, reason: null, authorization: null, ...extra });
type RoundInput = { kind?: 'review' | 'exemption'; closing?: boolean; content?: string; head?: string; findings?: Partial<Record<'standards' | 'spec', string[]>>;
  conclusion?: ReviewRoundView['conclusion']; declarations?: Partial<HandoffDeclarations>; exemption?: ReviewRoundView['exemption']; clean?: boolean };
function round(number: number, input: RoundInput = {}): ReviewRoundView {
  const kind = input.kind ?? 'review';
  const s = summary(number, { sha256: (input.content ?? '7').repeat(64), clean: input.clean ?? false, headMatches: input.clean ?? false }, { head: (input.head ?? 'b').repeat(40) });
  const findings = input.findings ?? {};
  const conclusion = input.conclusion ?? (findings.standards?.length || findings.spec?.length ? 'findings' : 'clean');
  return { round: number, attempt: 1, state: 'delivered', kind, closing: input.closing ?? false, exemption: input.exemption ?? null,
    declarations: input.declarations ? { treatments: [], gates: [], ...input.declarations } : null,
    handoff: { at: 'now', invocationId: 'b', status: 'captured', code: null, detail: null, summary: s },
    versions: { spec: s.spec, instructions: s.instructions, base: s.base, head: s.head, profile: { skillPack: null, builder: {}, reviewer: {} } },
    identity: { before: identity(), after: identity() },
    reviewers: kind === 'review' ? { standards: reviewer('standards', number, opinion('standards', number, findings.standards)), spec: reviewer('spec', number, opinion('spec', number, findings.spec)) }
      : { standards: { ...reviewer('standards', number, null), state: 'not-required', failure: null }, spec: { ...reviewer('spec', number, null), state: 'not-required', failure: null } },
    applicability: 'current', conclusion, reasons: [], concludedAt: 'now', delivery: null };
}
const exempt = (number: number, kind: 'unchanged' | 'identical-commit', reviewedRound: number, input: RoundInput = {}) =>
  round(number, { ...input, kind: 'exemption', exemption: { kind, reviewedRound, head: (input.head ?? 'b').repeat(40), reviewedHead: 'b'.repeat(40), contentSha256: (input.content ?? '7').repeat(64) } });
const questions: Record<string, { workId: string; state: 'open' | 'answered' }> = { '22222222-2222-4333-8444-555555555555': { workId: 'w', state: 'answered' },
  '33333333-2222-4333-8444-555555555555': { workId: 'other', state: 'answered' } };
const verify = (rounds: ReviewRoundView[]) => verifyExecution({ at: 'now', workId: 'w', rounds, question: id => questions[id] ?? null });

test('AC4/AC5: a changed content or context needs a new round; unchanged content and a commit holding exactly the reviewed content do not', () => {
  const reviewed = [round(1)];
  assert.deepEqual(classifyCapture({ summary: summary(2, { sha256: '8'.repeat(64) }), identity: identity(), rounds: reviewed }), { kind: 'review' }, 'content changed');
  const unchanged = classifyCapture({ summary: summary(2), identity: identity(), rounds: reviewed });
  assert.deepEqual(unchanged, { kind: 'exemption', exemption: { kind: 'unchanged', reviewedRound: 1, head: 'b'.repeat(40), reviewedHead: 'b'.repeat(40), contentSha256: '7'.repeat(64) } });
  const commit = classifyCapture({ summary: summary(2, { clean: true, headMatches: true }, { head: 'd'.repeat(40) }), identity: identity(), rounds: reviewed });
  assert.equal(commit.kind === 'exemption' && commit.exemption.kind, 'identical-commit');
  assert.equal(classifyCapture({ summary: summary(2, { clean: false, headMatches: true }, { head: 'd'.repeat(40) }), identity: identity(), rounds: reviewed }).kind, 'review', 'not clean: not proven');
  assert.equal(classifyCapture({ summary: summary(2, { clean: true, headMatches: false }, { head: 'd'.repeat(40) }), identity: identity(), rounds: reviewed }).kind, 'review', 'HEAD does not hold it');
  // Context changes: request/instructions version, rebase (merge-base), unknown or inconsistent host identity, an earlier capture format.
  assert.equal(classifyCapture({ summary: summary(2, {}, { spec: { version: 'v2', sources: '/artifacts/spec/v2/sources.json', sha256: '9'.repeat(64) } }), identity: identity(), rounds: reviewed }).kind, 'review');
  assert.equal(classifyCapture({ summary: summary(2, {}, { mergeBase: 'e'.repeat(40) }), identity: identity(), rounds: reviewed }).kind, 'review');
  assert.equal(classifyCapture({ summary: summary(2), identity: identity(false), rounds: reviewed }).kind, 'review');
  assert.equal(classifyCapture({ summary: summary(2), identity: { status: 'unavailable', code: 'X' }, rounds: reviewed }).kind, 'review');
  const { content: _content, ...legacy } = summary(2);
  assert.equal(classifyCapture({ summary: legacy, identity: identity(), rounds: reviewed }).kind, 'review');
  // An old approval is never reused automatically: an incomplete or not applicable reviewed round always needs a new round.
  assert.equal(classifyCapture({ summary: summary(2), identity: identity(), rounds: [{ ...round(1), conclusion: 'incomplete' }] }).kind, 'review');
  assert.equal(classifyCapture({ summary: summary(2), identity: identity(), rounds: [{ ...round(1), applicability: 'invalidated' }] }).kind, 'review');
  assert.equal(classifyCapture({ summary: summary(1), identity: identity(), rounds: [] }).kind, 'review');
  // An exemption compares with the latest REVIEWED round, not with an intermediate exemption.
  const later = classifyCapture({ summary: summary(3, { clean: true, headMatches: true }, { head: 'd'.repeat(40) }), identity: identity(), rounds: [round(1), exempt(2, 'unchanged', 1)] });
  assert.equal(later.kind === 'exemption' && later.exemption.reviewedRound, 1);
  assert.match(exemptionPrompt({ round: 3, exemption: (later as { exemption: NonNullable<ReviewRoundView['exemption']> }).exemption, conclusion: 'clean' }), /holds exactly the content reviewed in round 1/);
});

test('AC4: a new round continues the same role\'s previous session when known; the Builder is told to hand off again with treatments and gates', () => {
  const [standards, spec] = planReviews({ executionId: 'e', round: 2, attempt: 1, handoff: summary(2), previousSessions: { standards: '/run/w-a/profile/sessions/s.jsonl', spec: null } });
  assert.equal(standards!.review.continueFrom, '/run/w-a/profile/sessions/s.jsonl');
  assert.equal('continueFrom' in spec!.review, false);
  const prompt = deliveryPrompt({ round: 1, conclusion: 'findings', applicability: 'current', reasons: [], multi: true,
    reviewers: { standards: { opinion: opinion('standards', 1, ['H1']), failure: null }, spec: { opinion: null, failure: { code: 'REVIEWER_UNAVAILABLE' } } } });
  assert.match(prompt, /call handoff again, alone, with `treatments` for EVERY finding of round 1/);
  assert.match(prompt, /ask_user/);
  assert.doesNotMatch(prompt, /Do not call handoff again/);
});

test('AC6: a fixed finding reviewed again, a non-adopted one justified, gates passed on the final content and an identical commit verify', () => {
  const rounds = [round(1, { findings: { spec: ['S1'], standards: ['H1'] } }),
    round(2, { content: '8', declarations: { treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: 'Added it.', evidence: null, authorization: null },
      { round: 1, role: 'standards', findingId: 'H1', outcome: 'not-adopted', justification: 'Heuristic; the Ticket names the file.', evidence: null,
        authorization: { kind: 'preserved-source', reference: '/artifacts/spec/v1/ticket.json#body' } }], gates: [gate('docs', 'passed')] } }),
    exempt(3, 'identical-commit', 2, { content: '8', head: 'd', clean: true, closing: true })];
  const result = verify(rounds);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.status, 'verified');
  assert.deepEqual([result.reviewedRound, result.finalRound, result.applicability.kind, result.applicability.head], [2, 3, 'identical-commit', 'd'.repeat(40)]);
  assert.deepEqual(result.treatments.map(item => [item.round, item.role, item.findingId, item.outcome]), [[1, 'standards', 'H1', 'not-adopted'], [1, 'spec', 'S1', 'fixed']]);
  assert.deepEqual(result.gates, [{ id: 'docs', outcome: 'passed', current: true, boundToFinalContent: true, requiredCheck: null }]);
});

test('AC1/AC6: untreated findings, a fix never reviewed, unknown findings and uncorrelated authorizations are explicit reasons', () => {
  const declared = (treatments: HandoffDeclarations['treatments']) => ({ treatments, gates: [gate('docs', 'passed')] });
  const fix = (findingId: string, extra: object = {}) => ({ round: 1, role: 'spec' as const, findingId, outcome: 'fixed' as const, justification: 'j', evidence: null, authorization: null, ...extra });
  const result = verify([round(1, { findings: { spec: ['S1', 'S2', 'S3'] } }),
    exempt(2, 'unchanged', 1, { declarations: declared([fix('S1'), fix('S9'), { ...fix('S3'), outcome: 'not-adopted', authorization: { kind: 'question', questionId: '33333333-2222-4333-8444-555555555555' } }]) }),
    exempt(3, 'unchanged', 1, { closing: true })]);
  assert.equal(result.status, 'not-verified');
  assert.deepEqual(result.reasons.sort(), ['AUTHORIZATION_NOT_CORRELATED:1/spec/S3', 'FINDING_UNTREATED:1/spec/S2', 'FIX_NOT_REVIEWED:1/spec/S1', 'TREATMENT_UNKNOWN_FINDING:1/spec/S9']);
});

test('AC2/AC3/AC6: failed, lost, unverified, stale, not run and unauthorized gates are distinct and never success; a waiver never satisfies a required check', () => {
  const waived = (id: string, extra: Partial<GateEvidence>) => gate(id, 'waived', { reason: 'operator decided', ...extra });
  const result = verify([round(1, { declarations: { gates: [gate('lint', 'failed', { exitCode: 2 }), gate('e2e', 'unknown', { code: 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' }),
    gate('types', 'unverified', { code: 'GATE_RESULT_NOT_FOUND' }), gate('test', 'passed', { current: false, code: 'GATE_NOT_CURRENT' }),
    gate('docs', 'not-run', { reason: 'no documented command' }), waived('perf', {}),
    waived('ci', { requiredCheck: 'ci/build', authorization: { kind: 'question', questionId: '22222222-2222-4333-8444-555555555555' } }),
    waived('bench', { authorization: { kind: 'question', questionId: '22222222-2222-4333-8444-555555555555' } })] } }),
  exempt(2, 'unchanged', 1, { closing: true })]);
  assert.deepEqual(result.reasons, ['GATE_FAILED:lint', 'GATE_RESULT_UNKNOWN:e2e', 'GATE_RESULT_UNVERIFIED:types', 'GATE_NOT_CURRENT:test', 'GATE_NOT_RUN:docs',
    'WAIVER_NOT_AUTHORIZED:perf', 'WAIVER_CANNOT_BYPASS_REQUIRED_CHECK:ci']);
  assert.deepEqual(result.requiredChecks, ['ci/build'], 'the GitHub required check stays required');
  assert.equal(result.gates.find(item => item.id === 'bench')!.outcome, 'waived', 'an authorized waiver of a local gate is distinct from success but acceptable');
});

test('AC4/AC6/AC7: content changed after the reviewed round, gates bound to other content, a missing closing capture, a failed reviewer or no gates never verify', () => {
  const gates = { gates: [gate('docs', 'passed')] };
  assert.deepEqual(verify([round(1, { declarations: gates }), round(2, { kind: 'exemption', content: '8', closing: true })]).reasons, ['REVIEW_NOT_CURRENT', 'GATES_NOT_BOUND_TO_FINAL_CONTENT']);
  assert.deepEqual(verify([round(1, { declarations: gates })]).reasons, ['CONTENT_AFTER_LAST_CAPTURE_UNKNOWN']);
  assert.deepEqual(verify([round(1, { declarations: gates, closing: true })]).reasons, [], 'a closing capture reviewed by its own round');
  const failed = round(1, { declarations: gates, closing: true, conclusion: 'incomplete' });
  failed.reviewers.spec = reviewer('spec', 1, null);
  assert.deepEqual(verify([failed]).reasons, ['SPEC_OPINION_MISSING', 'REVIEW_INCOMPLETE']);
  assert.deepEqual(verify([round(1, { closing: true })]).reasons, ['GATES_NOT_DECLARED'], 'absence of gate evidence is never success');
  assert.deepEqual(verify([]).reasons, ['NO_REVIEW_ROUND']);
  const foreign = round(1, { declarations: gates, closing: true });
  foreign.reviewers.standards.opinion = { ...foreign.reviewers.standards.opinion!, input: { ...foreign.reviewers.standards.opinion!.input, handoffIndexSha256: 'f'.repeat(64) } };
  assert.deepEqual(verify([foreign]).reasons, ['STANDARDS_OPINION_NOT_CORRELATED']);
});
