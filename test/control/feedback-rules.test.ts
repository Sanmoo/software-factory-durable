import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { FeedbackRequest, RepairReason, ReviewFact } from '../../src/control/types.js';
import {
  commentCommand,
  feedbackSection,
  humanReasons,
  repairNextStep,
  repairPhase,
  repairReplyBody,
  repairRequestDecision,
  reviewRequests,
  undeliveredHuman,
} from '../../src/control/rules/feedback.js';
import { fingerprint, repairDecision, repairSection } from '../../src/control/rules/repair.js';
import { parseFactoryCommand } from '../../src/control/rules/questions.js';

// Pure rules of ticket 23 (level R): human triggers, their removal, the phase answer of an explicit repair and the human repair prompt.
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const operator = { id: 7, login: 'operator-one', type: 'User' };
const other = { id: 8, login: 'operator-two', type: 'User' };
const old = 'd'.repeat(40),
  current = 'e'.repeat(40);
let sequence = 100;
const review = (
  state: string,
  author: ReviewFact['author'] = operator,
  at = '2026-11-15T10:00:00Z',
  commitId: string | null = old,
  body = 'Rename the flag to `--dry`.',
): ReviewFact => ({
  reviewId: ++sequence,
  author,
  state,
  commitId,
  submittedAt: at,
  body,
  url: `https://github.com/acme/project/pull/4#pullrequestreview-${sequence}`,
});
const operators = [
  { login: 'operator-one', id: 7 },
  { login: 'operator-two', id: 8 },
];

test("AC1: only a configured human operator's CHANGES_REQUESTED is a trigger; bots, App-performed, third parties and COMMENTED reviews grant nothing", () => {
  const reviews = [
    review('CHANGES_REQUESTED'),
    review('CHANGES_REQUESTED', { id: 9, login: 'stranger', type: 'User' }),
    review('CHANGES_REQUESTED', { id: 10, login: 'ci-bot[bot]', type: 'Bot' }),
    review('COMMENTED'),
    review('CHANGES_REQUESTED', null),
  ];
  const outcome = reviewRequests({
    reviews,
    reviewComments: [
      {
        commentId: 1,
        reviewId: reviews[0]!.reviewId,
        author: operator,
        body: 'here',
        path: 'src/a.ts',
        line: 3,
        commitId: old,
        url: 'https://github.com/acme/project/pull/4#discussion_r1',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
    operators,
    digest,
  });
  assert.deepEqual(
    outcome.active.map(item => [item.feedbackId, item.origin, item.author?.login, item.version]),
    [[`review-${reviews[0]!.reviewId}`, 'github-review', 'operator-one', old]],
  );
  assert.deepEqual(outcome.active[0]!.comments, [{ path: 'src/a.ts', line: 3, body: 'here', url: 'https://github.com/acme/project/pull/4#discussion_r1' }]);
  assert.deepEqual(
    outcome.ignored.map(item => item.code),
    ['AUTHOR_NOT_OPERATOR', 'AUTHOR_IS_BOT', 'AUTHOR_UNKNOWN'],
  );
  // Reviews carry no `performed_via_github_app`: only a User whose id is PINNED in the configuration authorizes one (a login-only operator does not).
  const loginOnly = reviewRequests({ reviews: [review('CHANGES_REQUESTED')], reviewComments: [], operators: ['operator-one'], digest });
  assert.deepEqual([loginOnly.active.length, loginOnly.ignored.map(item => item.code)], [0, ['AUTHOR_NOT_PINNED_OPERATOR']]);
  const impostor = reviewRequests({
    reviews: [review('CHANGES_REQUESTED', { id: 99, login: 'operator-one', type: 'User' })],
    reviewComments: [],
    operators,
    digest,
  });
  assert.deepEqual(
    impostor.ignored.map(item => item.code),
    ['AUTHOR_NOT_OPERATOR'],
    'a reused login with another id never authorizes',
  );
  assert.deepEqual(
    reviewRequests({
      reviews: [review('CHANGES_REQUESTED', { id: 7, login: 'operator-one', type: 'Organization' })],
      reviewComments: [],
      operators,
      digest,
    }).ignored.map(item => item.code),
    ['AUTHOR_IS_BOT'],
    'author type must be User',
  );
  // `/factory repair` goes through the SAME authentication as answers: strict prefix, operator, never App-performed, unedited, after admission.
  const at = 1_000_000;
  const comment = (body: string, author = operator, viaApp: number | null = null, createdAt = at + 5, updatedAt = createdAt) =>
    commentCommand({ body, author, viaApp, createdAt, updatedAt }, { operators, admittedAt: at });
  assert.deepEqual(comment('/factory repair Rename the flag to --dry in the CLI.'), { kind: 'repair', reason: 'Rename the flag to --dry in the CLI.' });
  assert.deepEqual(comment('please /factory repair it'), { kind: 'prose' });
  assert.deepEqual(comment(' /factory repair Rename the flag to --dry.'), { kind: 'prose' });
  assert.deepEqual(comment('/factory repair Rename the flag.', { id: 9, login: 'stranger', type: 'User' }), { kind: 'ignored', code: 'AUTHOR_NOT_OPERATOR' });
  assert.deepEqual(comment('/factory repair Rename the flag.', { id: 10, login: 'helper[bot]', type: 'Bot' }), { kind: 'ignored', code: 'AUTHOR_IS_BOT' });
  assert.deepEqual(comment('/factory repair Rename the flag.', operator, 3), { kind: 'ignored', code: 'AUTHOR_VIA_APP' });
  assert.deepEqual(comment('/factory repair Rename the flag.', operator, null, at + 5, at + 9), { kind: 'ignored', code: 'COMMENT_EDITED' });
  assert.deepEqual(comment('/factory repair Rename the flag.', operator, null, at - 5), { kind: 'ignored', code: 'COMMENT_PREDATES_WORK' });
  assert.deepEqual(comment('/factory repair'), { kind: 'ignored', code: 'REPAIR_REASON_MISSING' });
  assert.deepEqual(parseFactoryCommand('/factory repairs things'), { kind: 'invalid', code: 'COMMAND_NOT_SUPPORTED' });
  assert.equal(parseFactoryCommand('/factory answer 5e55a0b0-0000-4000-8000-000000000001 yes').kind, 'answer', 'answers keep parsing');
});

test('AC3: a request on an earlier commit survives a push; a later approval by THE SAME reviewer or a dismissal removes only that trigger', () => {
  const first = review('CHANGES_REQUESTED', operator, '2026-11-15T10:00:00Z', old);
  const second = review('CHANGES_REQUESTED', other, '2026-11-15T10:01:00Z', old, 'Add a test.');
  // Nothing after: both active whatever the current head is (the head is not even an input).
  assert.deepEqual(
    reviewRequests({ reviews: [first, second], reviewComments: [], operators, digest }).active.map(item => item.version),
    [old, old],
  );
  const approvedByOther = reviewRequests({
    reviews: [first, second, review('APPROVED', other, '2026-11-15T11:00:00Z', current)],
    reviewComments: [],
    operators,
    digest,
  });
  assert.deepEqual(
    [approvedByOther.active.map(item => item.feedbackId), approvedByOther.inactive],
    [[`review-${first.reviewId}`], { [`review-${second.reviewId}`]: 'APPROVED_LATER' }],
  );
  const commented = reviewRequests({ reviews: [first, review('COMMENTED', operator, '2026-11-15T11:00:00Z', current)], reviewComments: [], operators, digest });
  assert.equal(commented.active.length, 1, 'a later comment is not an approval');
  const approvalBefore = reviewRequests({ reviews: [review('APPROVED', operator, '2026-11-15T09:00:00Z'), first], reviewComments: [], operators, digest });
  assert.equal(approvalBefore.active.length, 1, 'an EARLIER approval removes nothing');
  const dismissed = reviewRequests({ reviews: [{ ...first, state: 'DISMISSED' }, second], reviewComments: [], operators, digest });
  assert.deepEqual(
    [dismissed.active.map(item => item.feedbackId), dismissed.inactive],
    [[`review-${second.reviewId}`], { [`review-${first.reviewId}`]: 'DISMISSED' }],
  );
  // Identity of a human reason never includes the head: a push does not make it a new or a different request.
  const reason = (headSha: string): RepairReason => ({
    code: 'HUMAN_CHANGES_REQUESTED',
    subject: 'review-1',
    headSha,
    baseTip: null,
    observedAt: 'x',
    evidence: [],
  });
  assert.equal(fingerprint(reason(old)), fingerprint(reason(current)));
  assert.notEqual(
    fingerprint({ code: 'MERGE_CONFLICT', subject: 'main', headSha: old, baseTip: null }),
    fingerprint({ code: 'MERGE_CONFLICT', subject: 'main', headSha: current, baseTip: null }),
  );
});

test('AC6: an explicit repair answers by phase — accepted, deferred during activity/Question/publication, already covered, refused — and resume of a phase is computed from facts', () => {
  const base = { result: 'open', current: true, reason: 'Rename the flag to --dry in the CLI.', sha256: 'h1', unresolved: [] as string[] };
  assert.deepEqual(repairRequestDecision({ ...base, phase: 'idle-published' }), { outcome: 'accepted', during: 'idle-published' });
  for (const phase of ['activity', 'question-wait', 'publication-under-way'] as const)
    assert.deepEqual(repairRequestDecision({ ...base, phase }), { outcome: 'deferred', during: phase });
  assert.deepEqual(repairRequestDecision({ ...base, unresolved: ['h1'], phase: 'activity' }), { outcome: 'already-covered', code: 'REPAIR_ALREADY_PENDING' });
  assert.deepEqual(repairRequestDecision({ ...base, phase: 'no-own-pull-request' }), { outcome: 'not-applied', code: 'REPAIR_REQUIRES_OWN_PULL_REQUEST' });
  assert.match(
    repairNextStep('w-1', 'not-applied', 'REPAIR_REQUIRES_OWN_PULL_REQUEST')!,
    /`factory update-scope w-1 --reason <text>`/,
    'supervisor decision 4: points to update-scope',
  );
  const reply = repairReplyBody({
    workId: 'w-1',
    source: 'https://github.com/acme/project/issues/3#issuecomment-9',
    outcome: 'not-applied',
    reason: 'REPAIR_REQUIRES_OWN_PULL_REQUEST',
    nextStep: repairNextStep('w-1', 'not-applied', 'REPAIR_REQUIRES_OWN_PULL_REQUEST'),
    feedbackId: null,
  });
  assert.ok(
    reply.includes('refused: nothing changed') && reply.includes('factory update-scope w-1') && !reply.includes('/factory '),
    'Factory text only, never a command line',
  );
  assert.deepEqual(repairRequestDecision({ ...base, result: 'delivered', phase: 'idle-published' }), { outcome: 'not-applied', code: 'WORK_NOT_OPEN' });
  assert.deepEqual(repairRequestDecision({ ...base, current: false, phase: 'idle-published' }), { outcome: 'not-applied', code: 'WORK_NOT_CURRENT' });
  assert.deepEqual(repairRequestDecision({ ...base, reason: 'ok', phase: 'idle-published' }), { outcome: 'not-applied', code: 'REPAIR_REASON_NOT_CONCRETE' });
  assert.equal(repairPhase({ activeExecution: true, questionWait: false, publication: 'published', anyExecution: true }), 'activity');
  assert.equal(repairPhase({ activeExecution: false, questionWait: true, publication: 'published', anyExecution: true }), 'question-wait');
  assert.equal(repairPhase({ activeExecution: false, questionWait: false, publication: 'requested', anyExecution: true }), 'publication-under-way');
  assert.equal(repairPhase({ activeExecution: false, questionWait: false, publication: 'published', anyExecution: true }), 'idle-published');
  assert.equal(repairPhase({ activeExecution: false, questionWait: false, publication: null, anyExecution: false }), 'no-own-pull-request');
});

const request = (feedbackId: string, state: FeedbackRequest['state'], correctionId: string | null = null): FeedbackRequest => ({
  feedbackId,
  code: 'EXPLICIT_REPAIR',
  feedback: {
    feedbackId,
    origin: 'local-cli',
    author: null,
    url: null,
    version: old,
    submittedAt: 'x',
    sha256: 'h',
    content: `do ${feedbackId}`,
    comments: [],
  },
  recordedAt: 'x',
  recordedHead: old,
  state,
  correctionId,
  closedAt: null,
  outcome: null,
});

test('AC4/AC2: human reasons come from the durable records (pending and of this correction); undelivered ones of a charged correction are named', () => {
  const requests = [
    request('a', 'pending'),
    request('b', 'in-correction', 'c1'),
    request('c', 'in-correction', 'c0'),
    request('d', 'treated', 'c0'),
    request('e', 'withdrawn'),
  ];
  const reasons = humanReasons(requests, 'c1', current);
  assert.deepEqual(
    reasons.map(item => [item.subject, item.headSha, item.feedback?.content]),
    [
      ['a', old, 'do a'],
      ['b', old, 'do b'],
    ],
  );
  const executions = [
    {
      charge: { kind: 'correction' as const, correctionId: 'c1', counter: 'corrections' as const, state: 'consumed' as const, settledAt: null },
      request: { repair: { correctionId: 'c1', reasons: [reasons[1]!], headSha: old, baseTip: null } },
    },
  ];
  assert.deepEqual(
    undeliveredHuman({ correctionId: 'c1', reasons }, executions).map(item => item.subject),
    ['a'],
  );
  assert.deepEqual(undeliveredHuman({ correctionId: 'c1', reasons: [reasons[1]!] }, executions), []);
  // A fresh human request is never blocked by an old repeated impediment of the same head.
  const conflict: RepairReason = { code: 'MERGE_CONFLICT', subject: 'main', headSha: old, baseTip: null, observedAt: 'x', evidence: [] };
  const closed = [
    {
      correctionId: 'c0',
      sequence: 1,
      openedAt: 'x',
      closedAt: 'y',
      charged: true,
      outcome: 'published' as const,
      reasons: [conflict],
      head: old,
      basisExecutionId: null,
    },
  ];
  assert.deepEqual(repairDecision({ triggers: { kind: 'triggers', reasons: [conflict] }, correction: null, closed }).kind, 'repeated');
  const opened = repairDecision({ triggers: { kind: 'triggers', reasons: [conflict, reasons[0]!] }, correction: null, closed });
  assert.deepEqual([opened.kind, opened.kind === 'open' ? opened.reasons.map(item => item.code) : []], ['open', ['EXPLICIT_REPAIR']]);
  // A human-feedback correction whose reasons all disappeared before its start is withdrawn (no charge).
  const correction = { correctionId: 'c2', reason: 'r', openedAt: 'x', consumed: false, trigger: 'human-feedback' as const, reasons: [reasons[0]!] };
  assert.equal(repairDecision({ triggers: { kind: 'none', why: [], certain: true }, correction, closed: [] }).kind, 'withdraw');
});

test('AC5: the human part of the prompt carries identity/version/content as data and requires ask_user for disagreement or inability (never a silent decline)', () => {
  const [review0] = reviewRequests({
    reviews: [review('CHANGES_REQUESTED', operator, '2026-11-15T10:00:00Z', old, 'Rename ```x``` to y')],
    reviewComments: [],
    operators,
    digest,
  }).active;
  const reason: RepairReason = {
    code: 'HUMAN_CHANGES_REQUESTED',
    subject: review0!.feedbackId,
    headSha: current,
    baseTip: null,
    observedAt: 'x',
    evidence: ['e'],
    feedback: review0!,
  };
  const section = feedbackSection([reason]).join('\n');
  assert.ok(section.includes(`HUMAN_CHANGES_REQUESTED ${review0!.feedbackId}`) && section.includes(`on commit ${old}`) && section.includes(review0!.url!));
  assert.ok(section.includes('````\nRename ```x``` to y\n````'), 'operator text is fenced data');
  assert.ok(section.includes('NOT yours to') && section.includes('decline') && section.includes('use ask_user'));
  assert.ok(section.includes('already addressed by the current head or does not apply') && section.includes('never approve, dismiss or resolve reviews'));
  const prompt = repairSection({ correctionId: 'c1', base: 'main', branch: 'factory/3-x', checkout: '/workspace/checkout', reasons: [reason] }).join('\n');
  assert.ok(
    prompt.includes('HUMAN_CHANGES_REQUESTED (') &&
      prompt.includes('NEVER push in this activation') &&
      prompt.includes('Human requests from configured operators'),
  );
  assert.ok(!prompt.includes('Update your branch'), 'a human request alone never updates the base');
  // Tools named are only those of the Builder session (ask_user, handoff); no other tool is invented.
  assert.ok(!/\b(approve|merge)_\w+|gh pr review/.test(prompt));
});
