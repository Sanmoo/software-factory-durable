import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concludeRound, deliveryPrompt, planReviews } from '../../src/control/rules/review.js';
import type { ProposalHandoff, ProposalIdentity, ReviewOpinion } from '../../src/contracts/index.js';

// Rules level (R): pure functions over canonical types.
const handoff = { version: 1, round: 1, index: '/artifacts/review/r1/index.json', indexSha256: 'e'.repeat(64), head: 'b'.repeat(40), branch: 'factory/3-x', base: 'a'.repeat(40),
  mergeBase: 'a'.repeat(40), counts: { entries: 0, committed: 0, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
  patches: { committed: { path: '/artifacts/review/r1/committed.patch', bytes: 0, sha256: 'c'.repeat(64) }, staged: { path: '/artifacts/review/r1/staged.patch', bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: '/artifacts/review/r1/unstaged.patch', bytes: 0, sha256: 'c'.repeat(64) } },
  spec: null, instructions: { version: 'v2', sources: '/artifacts/instructions/v2/sources.json', sha256: '2'.repeat(64) }, changed: [], changedTruncated: false } satisfies ProposalHandoff;
const observed = (sha: string, consistent = true): ProposalIdentity => ({ status: 'observed', sha256: sha, indexSha256: 'e', entries: 0, consistent, observedAt: 'now' });
const opinion = (role: 'spec' | 'standards', conclusion: ReviewOpinion['conclusion']) => ({ role, conclusion, code: null, coverage: null, findings: [], limitations: [],
  hostChecks: { reads: 0, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, model: { providerId: 'p', modelId: 'm' }, reference: { workId: 'w', id: 'i' } }) as unknown as ReviewOpinion;

test('AC2/AC6: plans keep Spec on the preserved request and Standards on the preserved instructions; a missing version is declared, never a reason to omit Spec', () => {
  const [standards, spec] = planReviews({ executionId: 'x', round: 1, attempt: 1, handoff });
  assert.deepEqual([standards!.role, spec!.role], ['standards', 'spec']);
  assert.deepEqual(standards!.review.required, ['/artifacts/review/r1/index.json', '/artifacts/instructions/v2/sources.json']);
  assert.deepEqual([spec!.review.required, spec!.review.missing], [['/artifacts/review/r1/index.json'], ['spec-version']]);
  assert.match(spec!.prompt, /NONE: no complete preserved request/);
  assert.match(standards!.prompt, /basis "rule"/); assert.match(standards!.prompt, /"heuristic", never presented as a violation/);
  for (const plan of [standards!, spec!]) {
    assert.match(plan.prompt, /\/artifacts\/review\/r1\/staged\.patch/); assert.match(plan.prompt, /beyond the hunks/); assert.match(plan.prompt, /no prose before or after/);
  }
});

test('AC6 review fix 1: non-empty patches and the changed files (bounded) are required inputs, so an unresolved truncation prevents a clean conclusion', () => {
  const changed = Array.from({ length: 20 }, (_, i) => `/workspace/checkout/f${i}.ts`);
  const withContent = { ...handoff, patches: { ...handoff.patches, committed: { ...handoff.patches.committed, bytes: 900000 } }, changed, changedTruncated: true };
  const [standards] = planReviews({ executionId: 'x', round: 1, attempt: 1, handoff: withContent });
  assert.deepEqual(standards!.review.required, ['/artifacts/review/r1/index.json', '/artifacts/instructions/v2/sources.json', '/artifacts/review/r1/committed.patch', ...changed]);
  assert.ok(standards!.review.required.length <= 32);
  assert.match(standards!.prompt, /read every required input completely/);
});

test('AC6/AC7: only two clean opinions over an unchanged, consistent identity make a clean round', () => {
  const both = (a: ReviewOpinion['conclusion'], b: ReviewOpinion['conclusion']) => ({ standards: opinion('standards', a), spec: opinion('spec', b) });
  assert.deepEqual(concludeRound({ opinions: both('clean', 'clean'), before: observed('1'), after: observed('1') }), { applicability: 'current', conclusion: 'clean', reasons: [] });
  assert.equal(concludeRound({ opinions: both('clean', 'findings'), before: observed('1'), after: observed('1') }).conclusion, 'findings');
  assert.deepEqual(concludeRound({ opinions: both('clean', 'clean'), before: observed('1'), after: observed('2') }).reasons, ['PROPOSAL_CHANGED_DURING_REVIEW']);
  assert.deepEqual(concludeRound({ opinions: both('clean', 'clean'), before: observed('1', false), after: observed('1', false) }).reasons, ['PROPOSAL_IDENTITY_INCONSISTENT']);
  assert.deepEqual(concludeRound({ opinions: both('clean', 'clean'), before: observed('1'), after: { status: 'unavailable', code: 'X' } }).applicability, 'unknown');
  assert.deepEqual(concludeRound({ opinions: { standards: opinion('standards', 'clean') }, before: observed('1'), after: observed('1') }).reasons, ['SPEC_OPINION_MISSING']);
  assert.deepEqual(concludeRound({ opinions: both('cancelled', 'failure'), before: observed('1'), after: observed('1') }).reasons, ['STANDARDS_CANCELLED', 'SPEC_FAILURE']);
});

test('AC5: the delivered results are bounded and say failures are not approvals', () => {
  const huge = { ...opinion('spec', 'findings'), findings: Array.from({ length: 40 }, (_, i) => ({ id: `F${i}`, basis: 'requirement' as const, reference: 'r'.repeat(500),
    location: { path: '/workspace/x' }, summary: 's'.repeat(800) })) } as ReviewOpinion;
  const prompt = deliveryPrompt({ round: 1, conclusion: 'findings', applicability: 'current', reasons: [], reviewers: { standards: { opinion: null, failure: { code: 'REVIEWER_UNAVAILABLE' } }, spec: { opinion: huge, failure: null } } }, 20000);
  assert.ok(Buffer.byteLength(JSON.stringify(prompt)) <= 20000, 'bounded as encoded in the protocol frame');
  assert.match(prompt, /REVIEWER_UNAVAILABLE/); assert.match(prompt, /NOT zero findings and NOT an approval/); assert.match(prompt, /F39/);
});

test('ticket 14 real run v7: the reviewer prompt says that named-but-nonexistent context is NOT a limitation; only required inputs or existing unreadable files are', async () => {
  const { planReviews } = await import('../../src/control/rules/review.js');
  const handoff = { version: 1 as const, round: 1, index: '/artifacts/review/r1/index.json', indexSha256: 'a'.repeat(64), head: 'b'.repeat(40), branch: 'factory/3-x', base: 'c'.repeat(40),
    mergeBase: 'c'.repeat(40), counts: { entries: 1, committed: 1, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
    patches: { committed: { path: '/artifacts/review/r1/committed.patch', bytes: 1, sha256: 'd'.repeat(64) }, staged: { path: '/artifacts/review/r1/staged.patch', bytes: 0, sha256: 'd'.repeat(64) },
      unstaged: { path: '/artifacts/review/r1/unstaged.patch', bytes: 0, sha256: 'd'.repeat(64) } },
    spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) }, instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
    changed: [], changedTruncated: false };
  for (const plan of planReviews({ executionId: 'e', round: 1, attempt: 1, handoff })) {
    assert.match(plan.prompt, /READ_NOT_FOUND/);
    assert.match(plan.prompt, /does not exist is NOT a limitation/);
    assert.match(plan.prompt, /Only a REQUIRED input that is missing, or an EXISTING file that cannot be read/);
  }
});

test('ticket 51: a downgrade for an unreadable source names the failed reads (path and offset) in the delivered results', () => {
  const failing = { ...opinion('spec', 'incomplete'), hostChecks: { reads: 4, requiredNotFullyRead: [], downgraded: ['SOURCE_UNREADABLE'],
    failedReads: [{ path: '/workspace/checkout/src/Lock.java', code: 'GUEST_READ_FAILED', offset: 401 }] } } as ReviewOpinion;
  const prompt = deliveryPrompt({ round: 1, conclusion: 'incomplete', applicability: 'current', reasons: ['SPEC_INCOMPLETE'],
    reviewers: { standards: { opinion: opinion('standards', 'clean'), failure: null }, spec: { opinion: failing, failure: null } } });
  const [standards, spec] = JSON.parse(prompt.slice(prompt.indexOf('['))) as { hostFailedReads?: unknown }[];
  assert.deepEqual([standards!.hostFailedReads, spec!.hostFailedReads], [undefined, [{ path: '/workspace/checkout/src/Lock.java', code: 'GUEST_READ_FAILED', offset: 401 }]]);
});
