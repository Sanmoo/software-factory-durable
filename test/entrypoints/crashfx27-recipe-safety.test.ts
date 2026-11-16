import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuestionView, WorkView } from '../../src/control/index.js';
import { activationGuard, assess, keySource, phaseGuard, postDecision, pushObserved, requireKeySource } from './crashfx27-qualification.js';
import { configuredRemote } from './humanchanges21-qualification.js';

// Recipe safety of the ticket 27 real run, on controlled data only (never the real root, GitHub, VM or model).

test('phase guard: unpinned issue refuses; each phase once and only after the previous one succeeded', () => {
  assert.equal(phaseGuard('preflight', {}, new Set(), false), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('preflight', {}, new Set(), true), null);
  assert.equal(phaseGuard('preflight', {}, new Set(['preflight-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('ask', { preflight: { status: 'held' } }, new Set(['preflight-intent']), true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('publish', { preflight: { status: 'success' }, ask: { status: 'held' } }, new Set(), true), 'ASK_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('publish', { preflight: { status: 'success' }, ask: { status: 'success' } }, new Set(), true), null);
  assert.equal(phaseGuard('inspect', {}, new Set(), true), 'PREFLIGHT_SUCCESS_REQUIRED');
});

test('exactly ONE real Question POST (a-ask, then the cut); every later POST is refused before sending', () => {
  assert.equal(postDecision('a-ask', 0), 'send-then-cut');
  assert.equal(postDecision('a-ask', 1), 'refuse');
  for (const step of ['b-discover-question', 'c-publish', 'd-discover-publication'] as const) assert.equal(postDecision(step, 0), 'refuse', step);
});

test('activation guard: the step sequence of Builder phaseIds; reviewers only for the c-publish implementation and distinct rounds', () => {
  const builder = (phaseId: string, executionId = 'e1') => ({ role: 'builder', executionId, phaseId });
  const a = activationGuard('a-ask');
  assert.equal(a({ role: 'standards', executionId: 'e1', phaseId: 'review' }, { round: 1 }), false, 'no reviewer in a-ask');
  assert.equal(a(builder('builder-initial')), true);
  assert.equal(a(builder('builder-initial')), false, 'one Builder only');
  assert.equal(activationGuard('b-discover-question')(builder('builder-recovery')), false, 'b starts nothing');
  const c = activationGuard('c-publish', 2);
  assert.equal(c(builder('builder-publication')), false, 'the implementation comes first');
  assert.equal(c(builder('builder-recovery', 'e2')), true);
  assert.equal(c({ role: 'spec', executionId: 'e2', phaseId: 'r' }, { round: 1 }), true);
  assert.equal(c({ role: 'spec', executionId: 'e2', phaseId: 'r' }, { round: 1 }), false, 'a round is reviewed once');
  assert.equal(c({ role: 'spec', executionId: 'other', phaseId: 'r' }, { round: 2 }), false, 'only the implementation Execution');
  assert.equal(c(builder('builder-publication', 'e3')), true);
  assert.equal(c(builder('builder-publication', 'e4')), false, 'one publication activation');
  const d = activationGuard('d-discover-publication');
  assert.equal(d(builder('builder-recovery')), false, 'd never re-implements');
  assert.equal(d(builder('builder-publication')), true);
  assert.equal(d(builder('builder-publication')), false, 'at most ONE PR-only continuation');
});

test('cut B fires only when the own branch holds exactly the verified head', () => {
  const head = 'b'.repeat(40);
  assert.equal(pushObserved(head, { state: 'present', sha: head }), true);
  assert.equal(pushObserved(head, { state: 'present', sha: 'c'.repeat(40) }), false);
  assert.equal(pushObserved(head, { state: 'absent' }), false);
  assert.equal(pushObserved(head, { state: 'unknown' }), false);
  assert.equal(pushObserved(head, undefined), false);
});

const qid = '0b9c6a52-3d3e-4c8f-9a51-000000000277';
const head = 'b'.repeat(40);
const push = `git -C /workspace/checkout push --force-with-lease=refs/heads/factory/9-abc: ${configuredRemote} ${head}:refs/heads/factory/9-abc`;
const execution = (extra: Record<string, unknown>) => ({ executionId: 'e', request: {}, recovery: [{ cessation: { result: 'confirmed' } }], ...extra });
function world(overrides: { posts?: number; reposts?: number; comments?: number | null; pulls?: number | null; pushes?: string[]; cutB?: boolean; postKind?: string;
  census?: boolean; answers?: number; askSettledLive?: boolean; askCessation?: 'confirmed' | 'unconfirmed' } = {}) {
  const question = { questionId: qid, state: 'answered', answer: { origin: { kind: 'github-comment' } },
    publication: { state: 'published', attempts: [{ outcome: 'attempting' }, { outcome: 'discovered' }], comment: { commentId: 77 } } } as unknown as QuestionView;
  const work = { questions: [qid], history: Array.from({ length: overrides.answers ?? 1 }, () => ({ event: 'question-answered', questionId: qid })), publication: { state: 'published', branch: 'factory/9-abc', verified: { head }, pullRequest: { headSha: head }, attempts: [{ head, expectedRemote: { state: 'absent' } }] },
    previousExecutions: [execution({ executionId: 'e1', end: { outcome: 'question', questionId: qid, cessation: overrides.askCessation ?? 'confirmed' },
      ...(overrides.askSettledLive ? { recovery: [] } : {}) }), execution({ executionId: 'e2', end: { outcome: 'completed' } })],
    execution: execution({ executionId: 'e3', request: { publication: { head } }, end: { outcome: 'failure' } }) } as unknown as WorkView;
  const events = [{ at: 't', step: 'a-ask' as const, call: 'post-returned', kind: overrides.postKind ?? 'published', commentId: 77 },
    ...(overrides.cutB === false ? [] : [{ at: 't', step: 'c-publish' as const, call: 'push-observed' }]),
    ...Array.from({ length: overrides.reposts ?? 0 }, () => ({ at: 't', step: 'b-discover-question' as const, call: 'post-refused' }))];
  return assess({ work, question, events, exits: { 'a-ask': 'signal:SIGKILL', 'b-discover-question': 'exit:0', 'c-publish': overrides.cutB === false ? 'exit:0' : 'signal:SIGKILL',
    'd-discover-publication': 'exit:0' }, pushCensusComplete: overrides.census ?? true, pushes: overrides.pushes ?? [push],
  remote: { questionComments: overrides.comments === undefined ? 1 : overrides.comments, ownPullRequests: overrides.pulls === undefined ? 1 : overrides.pulls, branchTip: head } });
}

test('AC8 verdict: passed only with every check; a duplicate/repetition is FAILED; a missed cut or incomplete read is INCONCLUSIVE, never passed', () => {
  assert.equal(world().status, 'passed', JSON.stringify(world().checks));
  assert.deepEqual([world({ comments: 2 }).status, world({ comments: 2 }).failures], ['failed', ['singleQuestionComment']], 'a duplicate Question comment');
  assert.deepEqual(world({ pulls: 2 }).failures, ['singleOwnPullRequest'], 'a second PR');
  assert.deepEqual(world({ reposts: 1 }).failures, ['questionNeverReposted'], 'a repost attempt (even refused) fails the run');
  const twice = world({ pushes: [push, push] });
  assert.deepEqual(twice.failures, ['atMostOnePushOfHead'], 'the verified head pushed twice');
  assert.deepEqual(world({ pushes: ['git push --force origin x'] }).failures, ['explicitLeases']);
  assert.deepEqual([world({ cutB: false }).status, world({ cutB: false }).inconclusive], ['inconclusive', ['CUT_B_NOT_REACHED']]);
  assert.deepEqual([world({ comments: null }).status, world({ comments: null }).inconclusive], ['inconclusive', ['REMOTE_READ_INCOMPLETE']], 'an unreadable listing proves nothing');
  assert.deepEqual([world({ postKind: 'unknown' }).status, world({ postKind: 'unknown' }).inconclusive], ['inconclusive', ['CUT_A_ENVIRONMENT_FAULT']], 'a GitHub fault at cut A');
  assert.deepEqual([world({ census: false }).status, world({ census: false }).inconclusive], ['inconclusive', ['PUSH_CENSUS_INCOMPLETE']], 'a capped census may undercount');
  // Real run v2: the ask Execution ended (question) and its cessation was confirmed LIVE before cut A, so the boot had nothing to reconcile.
  assert.equal(world({ askSettledLive: true }).status, 'passed', 'a settled ask Execution needs no boot reconciliation record');
  assert.deepEqual([world({ askSettledLive: true, askCessation: 'unconfirmed' }).status, world({ askSettledLive: true, askCessation: 'unconfirmed' }).checks.questionExecutionSettled],
    ['failed', false], 'an unconfirmed cessation of the ask Execution never passes');
  assert.deepEqual([world({ answers: 2 }).status, world({ answers: 2 }).checks.singleAnswerAccepted], ['failed', false], 'two accepted answers');
});

test('a missing App key source fails loudly with its path before any effect', async () => {
  const asked: string[] = [];
  await assert.rejects(requireKeySource(async path => { asked.push(path); throw new Error('ENOENT'); }),
    (error: Error) => error.message.startsWith('APP_KEY_SOURCE_MISSING: /home/sanmoo/software-factory-test/y5/credentials/app.pem is absent') && /nothing was created/.test(error.message));
  assert.deepEqual(asked, [keySource]);
  await requireKeySource(async () => undefined);
});
