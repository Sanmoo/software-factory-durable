import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuestionView } from '../../src/control/index.js';
import { activationGuard, assess, gateCutProof, gateMarkers, lineOf, mainBody, phaseGuard, pinned, postDecision, sourcesCutProof, steps,
  type CrashInput, type Step } from './crasha34-qualification.js';

// Recipe safety of the R-CRASH-A real run, on controlled data only (never the real root, GitHub, VM or model).

test('pinning: both issues, distinct, non-zero; phase order; each phase once', () => {
  assert.equal(pinned(), false, 'the committed numbers are 0');
  assert.equal(pinned({ main: 7, cache: 0 }), false);
  assert.equal(pinned({ main: 7, cache: 7 }), false, 'the two lines never share a Ticket');
  assert.equal(pinned({ main: 7, cache: 8 }), true);
  assert.equal(phaseGuard('preflight', {}, new Set(), false), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('preflight', {}, new Set(), true), null);
  assert.equal(phaseGuard('preflight', {}, new Set(['preflight-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('cache', { preflight: { status: 'held' } }, new Set(), true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('sources', { preflight: { status: 'success' }, cache: { status: 'held' } }, new Set(), true), 'CACHE_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('tool', { sources: { status: 'held' } }, new Set(), true), 'SOURCES_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('tool', { sources: { status: 'success' } }, new Set(), true), null);
  assert.equal(phaseGuard('inspect', {}, new Set(), true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.deepEqual(steps.map(lineOf), ['cache', 'cache', 'main', 'main', 'main', 'main', 'main']);
});

test('exactly ONE real Question POST (s2); every other step refuses before sending', () => {
  assert.equal(postDecision('s2-sources-recovery', 0), 'send');
  assert.equal(postDecision('s2-sources-recovery', 1), 'refuse');
  for (const step of steps.filter(item => item !== 's2-sources-recovery')) assert.equal(postDecision(step, 0), 'refuse', step);
});

test('activation guard: one Builder per step with its phaseIds, never a publication; reviewers only in h1 (first round, once per role) and f1', () => {
  const builder = (phaseId: string, executionId = 'e') => ({ role: 'builder', executionId, phaseId });
  for (const step of ['c1-cache-cut', 'c2-cache-reconcile'] as const) assert.equal(activationGuard(step)(builder('builder-initial')), false, `${step}: no Builder in the cache line`);
  for (const step of steps) assert.equal(activationGuard(step)(builder('builder-publication')), false, `${step}: never a publication`);
  const s1 = activationGuard('s1-sources-cut');
  assert.equal(s1(builder('builder-initial')), true);
  assert.equal(s1(builder('builder-initial')), false, 'one Builder only');
  assert.equal(s1({ role: 'spec', executionId: 'e', phaseId: 'r' }, { round: 1 }), false, 'no reviewer before h1');
  assert.equal(activationGuard('s2-sources-recovery')(builder('builder-initial')), false, 's2 is a recovery');
  const h1 = activationGuard('h1-handoff-cut');
  assert.equal(h1(builder('builder-recovery', 'e4')), true);
  assert.equal(h1({ role: 'standards', executionId: 'e4', phaseId: 'r' }, { round: 1, attempt: 1 }), true);
  assert.equal(h1({ role: 'standards', executionId: 'e4', phaseId: 'r' }, { round: 2, attempt: 1 }), false, 'h1 reviews its first round only');
  assert.equal(h1({ role: 'spec', executionId: 'e4', phaseId: 'r' }, { round: 1, attempt: 2 }), false, 'no retry in h1');
  assert.equal(h1({ role: 'spec', executionId: 'other', phaseId: 'r' }, { round: 1, attempt: 1 }), false, 'only the step\'s own Execution');
  const f1 = activationGuard('f1-final', 2);
  assert.equal(f1(builder('builder-continuation', 'e5')), true);
  assert.equal(f1({ role: 'spec', executionId: 'e5', phaseId: 'r' }, { round: 2, attempt: 1 }), true);
  assert.equal(f1({ role: 'spec', executionId: 'e5', phaseId: 'r' }, { round: 2, attempt: 1 }), false, 'a (round, attempt) once');
  assert.equal(f1({ role: 'spec', executionId: 'e5', phaseId: 'r' }, { round: 2, attempt: 2 }), true, 'one retry');
  assert.equal(f1({ role: 'spec', executionId: 'e5', phaseId: 'r' }, { round: 3, attempt: 1 }), true);
  assert.equal(f1({ role: 'spec', executionId: 'e5', phaseId: 'r' }, { round: 4, attempt: 1 }), false, 'bounded per role');
});

test('cut proofs: sources started and incomplete; the gate started and not finished; the Ticket declares the gate wait and its markers', () => {
  assert.equal(sourcesCutProof({ ticketJson: true, sourcesJson: false }), true);
  assert.equal(sourcesCutProof({ ticketJson: true, sourcesJson: true }), false);
  assert.equal(sourcesCutProof({ ticketJson: false, sourcesJson: false }), false);
  assert.equal(gateCutProof({ started: Buffer.from('started\n'), ended: null }), true);
  assert.equal(gateCutProof({ started: Buffer.from('started\n'), ended: Buffer.from('ended\n') }), false);
  assert.equal(gateCutProof({ started: null, ended: null }), false);
  assert.match(mainBody, /deliberately waits 240 seconds/);
  assert.ok(mainBody.includes(gateMarkers.started) && mainBody.includes(gateMarkers.ended));
});

type Ev = { step: Step; call: string } & Record<string, unknown>;
const builderActivate = (step: Step, executionId: string): Ev => ({ step, call: 'activate', context: { role: 'builder', executionId } });
const stop = (step: Step, boot: string): Ev => ({ step, call: 'stop', input: { boot }, result: { cessationConfirmed: true } });
const crashed = (executionId: string) => ({ executionId, state: 'ended', end: { outcome: 'failure', code: 'CONTROLLER_CRASH', cessation: 'confirmed' },
  recovery: [{ cessation: { result: 'confirmed' }, decision: 'operational-recovery' }] });
function world(change: (input: CrashInput, events: Ev[]) => void = () => {}) {
  const events: Ev[] = [
    { step: 'c1-cache-cut', call: 'cut', cut: 'cache-mutating' },
    { step: 'c2-cache-reconcile', call: 'inventory', caches: [{ repositoryId: 1, outcome: 'reconciled' }] },
    { step: 's1-sources-cut', call: 'start', result: { boot: 'b1' } }, builderActivate('s1-sources-cut', 'e1'), { step: 's1-sources-cut', call: 'cut-observed' },
    stop('s2-sources-recovery', 'b1'), { step: 's2-sources-recovery', call: 'sources-at-recovery', sourcesJson: false }, builderActivate('s2-sources-recovery', 'e2'),
    { step: 's2-sources-recovery', call: 'cut', cut: 'after-question-published' },
    { step: 't1-tool-cut', call: 'answer-observed', dispatch: 'closed' }, { step: 't1-tool-cut', call: 'start', result: { boot: 'b3' } }, builderActivate('t1-tool-cut', 'e3'),
    { step: 't1-tool-cut', call: 'cut-observed' },
    stop('h1-handoff-cut', 'b3'), { step: 'h1-handoff-cut', call: 'start', result: { boot: 'b4' } }, { step: 'h1-handoff-cut', call: 'tool-cut-proof', proven: true },
    builderActivate('h1-handoff-cut', 'e4'), { step: 'h1-handoff-cut', call: 'activate', context: { role: 'standards', executionId: 'e4' }, review: { round: 1 } },
    { step: 'h1-handoff-cut', call: 'cut', cut: 'after-first-opinion', role: 'standards' },
    stop('f1-final', 'b4'), builderActivate('f1-final', 'e5'), { step: 'f1-final', call: 'activate', context: { role: 'spec', executionId: 'e5' }, review: { round: 2 } },
  ];
  const input = {
    events, exits: { 'c1-cache-cut': 'signal:SIGKILL', 'c2-cache-reconcile': 'exit:0', 's1-sources-cut': 'signal:SIGKILL', 's2-sources-recovery': 'signal:SIGKILL',
      't1-tool-cut': 'signal:SIGKILL', 'h1-handoff-cut': 'signal:SIGKILL', 'f1-final': 'exit:0' },
    cache: { work: { executions: [{ executionId: 'x1', state: 'released' }, { executionId: 'x2', state: 'held', held: { code: 'PREPARE_CHECKOUT_PREPARATION_INCOMPLETE' } }] } },
    main: { executions: [crashed('e1'), { executionId: 'e2', state: 'ended', end: { outcome: 'question', cessation: 'confirmed' } }, crashed('e3'), crashed('e4'),
      { executionId: 'e5', state: 'ended', end: { outcome: 'completed', cessation: 'confirmed' }, review: { rounds: [{ round: 2, reviewers: { standards: { source: 'carried' }, spec: { source: 'notification' } } }] } }],
    question: { questionId: 'q', state: 'answered', answer: { origin: { kind: 'github-comment' } } } as unknown as QuestionView, answers: 1, budget: { consumed: 3, reserved: null } },
    preservedAtCut: { 'spec/v1/ticket.json': 'aa', 'spec/v1/sources.json': null }, preservedNow: { 'spec/v1/ticket.json': 'aa', 'spec/v1/sources.json': 'bb' },
    preservationComplete: true, remote: { questionComments: 1, pullRequests: 0 },
  } as unknown as CrashInput;
  change(input, events);
  return assess(input);
}

test('V-07.b/V-12.c/V-12.d verdict: passed only with every check; duplicates, overwrites, re-run opinions, adoption or a PR FAIL; missed cuts are INCONCLUSIVE', () => {
  assert.equal(world().status, 'passed', JSON.stringify(world().checks));
  assert.deepEqual(world(input => { input.remote.questionComments = 2; }).failures, ['singleQuestionComment']);
  assert.deepEqual(world(input => { input.preservedNow['spec/v1/ticket.json'] = 'zz'; }).failures, ['preservedNeverOverwritten'], 'a preserved version rewritten');
  assert.deepEqual(world((_, events) => { events.push({ step: 'f1-final', call: 'activate', context: { role: 'standards', executionId: 'e5' }, review: { round: 2 } }); }).failures,
    ['opinionCarriedNotRerun'], 'a carried opinion re-run');
  assert.deepEqual(world(input => { input.remote.pullRequests = 1; }).failures, ['noPublication']);
  assert.deepEqual(world(input => { (input.cache.work!.executions as unknown[]).push({ executionId: 'x3', state: 'ended', end: { outcome: 'completed' } }); }).failures,
    ['cachePreparationHeldNotAdopted'], 'an incomplete checkout adopted');
  assert.deepEqual(world(input => { input.main!.answers = 2; }).failures, ['answerAcceptedOnce']);
  const survivor = world((_, events) => { (events.find(item => item.call === 'sources-at-recovery')!).sourcesJson = true; });
  assert.deepEqual([survivor.status, survivor.inconclusive], ['inconclusive', ['SOURCES_COMPLETED_BY_SURVIVOR']], 'the survivor completed the capture: nothing proven');
  assert.deepEqual(world((_, events) => { (events.find(item => item.call === 'answer-observed')!).dispatch = 'open'; }).inconclusive, ['ANSWER_NOT_OBSERVED_DURING_BOOT']);
  const changed = world(input => { input.main!.executions[4]!.review!.rounds[0]!.reviewers.standards.source = 'notification'; });
  assert.deepEqual([changed.status, changed.inconclusive], ['inconclusive', ['HANDOFF_PROPOSAL_CHANGED']], 'a changed proposal re-reviews both roles: nothing proven about the carry');
  const missed = world(input => { input.exits['t1-tool-cut'] = 'exit:0'; });
  assert.ok(missed.inconclusive.includes('TOOL_CUT_NOT_REACHED'));
  const twoWriters = world((_, events) => { const index = events.findIndex(item => item.step === 'h1-handoff-cut' && item.call === 'stop'); events.splice(index, 1); events.push(stop('h1-handoff-cut', 'b3')); });
  assert.deepEqual([twoWriters.status, twoWriters.checks.channelLossReconciled], ['failed', false], 'an activation before the survivor stop is never passed');
  assert.deepEqual(world(input => { input.remote.pullRequests = null; }).inconclusive, ['REMOTE_READ_INCOMPLETE']);
});
