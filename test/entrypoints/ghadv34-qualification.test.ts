import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListView, QuestionView, WorkView } from '../../src/control/index.js';
import * as recipe from './ghadv34-qualification.js';

// Rules of the R-GH-ADV real-run recipe on controlled data only (no GitHub, VM, model or real root). Distinct test numbers are pinned in
// THIS process only; the recipe module itself ships unpinned (see ghadv34-recipe-safety.test.ts).
Object.assign(recipe.tickets.A, { number: 101 }); Object.assign(recipe.tickets.B, { number: 102 }); Object.assign(recipe.tickets.C, { number: 103 });
const sha = (c: string) => c.repeat(40);
const none = new Set<string>();

test('pinned: three distinct positive numbers; phase guard: strict order, one shot, inspect only once nothing still runs', () => {
  assert.equal(recipe.pinned([0, 102, 103]), false);
  assert.equal(recipe.pinned([102, 102, 103]), false);
  assert.equal(recipe.pinned(), true);
  assert.equal(recipe.phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(recipe.phaseGuard('preflight', {}, none, true), null);
  assert.equal(recipe.phaseGuard('foreign', { preflight: { status: 'held' } }, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('human-commit', { resume: { status: 'held' } }, none, true), 'RESUME_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('merge-repair', { conflict: { status: 'success' } }, none, true), null);
  assert.equal(recipe.phaseGuard('cancel-merge', { close: { status: 'success' } }, new Set(['cancel-merge-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(recipe.phaseGuard('inspect', { preflight: { status: 'success' } }, new Set(['ask-intent']), true), 'PHASE_NOT_ENDED:ask');
  assert.equal(recipe.phaseGuard('inspect', { preflight: { status: 'success' } }, new Set(['ask-intent']), true, new Set(['ask'])), null);
  assert.deepEqual(recipe.phases.slice(0, 2), ['preflight', 'foreign']);
  assert.deepEqual(recipe.phases.slice(-2), ['inspect', 'stop-environment']);
});

test('activation and grant guards: per-phase Builder budget for the phase Work only; no publication where none is expected; reviewers for the latest implementation', () => {
  const ctx = (role: string, phaseId: string, executionId = 'e1', workId = 'w') => ({ role, workId, executionId, phaseId });
  const withdraw = recipe.activationGuard('withdraw', () => 'w');
  assert.equal(withdraw(ctx('builder', 'builder-recovery')), false, 'withdraw/strangers launch nothing');
  const merge = recipe.activationGuard('merge-repair', () => 'w', 2);
  assert.equal(merge(ctx('builder', 'builder-continuation', 'e1', 'other')), false, 'another Work is refused');
  assert.equal(merge(ctx('builder', 'builder-continuation')), true);
  assert.equal(merge(ctx('spec', 'p'), { round: 1 }), true);
  assert.equal(merge(ctx('spec', 'p'), { round: 1 }), false, 'distinct rounds');
  assert.equal(merge(ctx('standards', 'p', 'e9'), { round: 1 }), false, 'reviewers only for the implementation Execution');
  assert.equal(merge(ctx('builder', 'builder-publication', 'e2')), false, 'merged during the repair: no publication may follow');
  const conflict = recipe.activationGuard('conflict', () => 'w');
  assert.equal(conflict(ctx('builder', 'builder-continuation')), true);
  assert.equal(conflict(ctx('builder', 'builder-publication', 'e2')), true);
  assert.equal(conflict(ctx('standards', 'p', 'e2'), { round: 1 }), false, 'never a review of a publication activation');
  assert.equal(conflict(ctx('builder', 'builder-recovery', 'e3')), true, 'one operational recovery');
  assert.equal(conflict(ctx('builder', 'builder-recovery', 'e4')), false, 'budget exhausted');
  const grants = recipe.grantGuard('close');
  assert.equal(grants('builder-start', { publicationState: 'published', publicationActivation: false, executionId: 'e' }), true);
  assert.equal(grants('builder-publish', { publicationState: 'requested', publicationActivation: true, executionId: 'e' }), false, 'no publication in close');
  const publish = recipe.grantGuard('resume', 1);
  assert.equal(publish('builder-publish', { publicationState: 'published', publicationActivation: false, executionId: 'p' }), false);
  assert.equal(publish('builder-publish', { publicationState: 'requested', publicationActivation: true, executionId: 'p' }), true);
  assert.equal(publish('builder-publish', { publicationState: 'requested', publicationActivation: true, executionId: 'p' }), false);
  assert.equal(recipe.grantGuard('strangers')('builder-start', { publicationState: null, publicationActivation: false, executionId: 'e' }), false);
});

const question = (extra: Partial<QuestionView> = {}) => ({ questionId: '11111111-1111-4111-8111-111111111111', workId: 'w', recordedFrom: 'worker-notification', state: 'open',
  publication: { state: 'published' }, ignored: [], answer: null,
  content: { question: 'Which word must the `## Choice` section of docs/FACTORY_ADVERSE.md contain: alpha or beta?', context: '' }, ...extra }) as unknown as QuestionView;
const work = (extra: Record<string, unknown> = {}) => ({ work_id: 'w', ticket: { number: 102 }, result: 'open', impediments: [], previousExecutions: [], execution: null, correction: null,
  corrections: [], authorization: { withdrawal: null }, feedback: { ignored: [], requests: [] }, publication: null, ...extra }) as unknown as WorkView;
const facts = (extra: Partial<recipe.Facts> = {}): recipe.Facts => ({ work: work(), questions: [question()], list: null, activations: 0, prepares: 0, seen: {}, observed: new Set(), ...extra });
const request = (reason: string, state: string, correctionId: string | null, feedbackId = 'f1') => ({ feedbackId, code: 'EXPLICIT_REPAIR', state, correctionId,
  feedback: { content: `/factory repair ${reason}` } });
const listWith = (holds: unknown[]) => ({ polling: { repositories: [{ candidates: [{ ticket: { number: 101 }, outcome: 'held', holds }] }] } }) as unknown as ListView;

test('human steps: requested only when ready, observed only through what the Factory itself recorded', () => {
  const rules = recipe.humanStepRules;
  const foreign = listWith([{ code: 'FOREIGN_PULL_REQUEST', pullRequests: [{ number: 7 }] }]);
  assert.equal(rules[1]!.observed(facts({ list: listWith([{ code: 'LABEL_NOT_PRESENT' }]) })), false);
  assert.equal(rules[1]!.observed(facts({ list: foreign })), true);
  assert.equal(rules[3]!.ready(facts()), true);
  assert.equal(rules[3]!.observed(facts({ questions: [question({ ignored: [{ at: '', origin: 'c', code: 'AUTHOR_IS_BOT' }] })] })), false, 'the bot repair must be ignored too');
  assert.equal(rules[3]!.observed(facts({ questions: [question({ ignored: [{ at: '', origin: 'c', code: 'AUTHOR_IS_BOT' }] })],
    work: work({ feedback: { ignored: [{ code: 'AUTHOR_IS_BOT' }], requests: [] } }) })), true);
  assert.equal(rules[4]!.ready(facts()), false, 'after the bot');
  assert.equal(rules[5]!.observed(facts({ work: work({ impediments: [{ code: 'AUTHORIZATION_WITHDRAWN' }], authorization: { withdrawal: { codes: ['LABEL_NOT_PRESENT'] } } }) })), false,
    'a closed issue, not a removed label');
  assert.equal(rules[5]!.observed(facts({ work: work({ impediments: [{ code: 'AUTHORIZATION_WITHDRAWN' }], authorization: { withdrawal: { codes: ['TICKET_NOT_OPEN'] } } }) })), true);
  assert.equal(rules[7]!.observed(facts({ questions: [question({ state: 'answered' })] })), false, 'accepted while STILL withdrawn');
  assert.equal(rules[8]!.observed(facts({ questions: [question({ ignored: [{ at: '', origin: 'c', code: 'QUESTION_ALREADY_ANSWERED' }] })] })), true);
  for (const [step, reason] of [[15, recipe.repairReasons.mergeDuring], [18, recipe.repairReasons.close], [20, recipe.repairReasons.cancel]] as const) {
    const recorded = (state: string, correctionId: string | null) => ({ requests: [request(reason, state, correctionId)], ignored: [] });
    const at = (correctionId: string, extra: Record<string, unknown> = {}) => ({ state: 'started', request: { repair: { correctionId }, ...extra }, slot: { held: true } });
    const previous = new Set([step - 1]);
    assert.equal(rules[step]!.ready(facts({ work: work({ feedback: recorded('pending', null), execution: at('c-old') }), observed: previous })), false,
      `step ${step}: request only recorded, another repair running: not yet`);
    assert.equal(rules[step]!.ready(facts({ work: work({ feedback: recorded('in-correction', 'c1'), execution: at('c-old') }), observed: previous })), false,
      `step ${step}: the running repair is not the request's correction`);
    assert.equal(rules[step]!.ready(facts({ work: work({ feedback: recorded('in-correction', 'c1'), execution: at('c1', { publication: {} }) }), observed: previous })), false,
      `step ${step}: never during a publication activation`);
    assert.equal(rules[step]!.ready(facts({ work: work({ feedback: recorded('in-correction', 'c1'), execution: at('c1') }), observed: previous })), true, `step ${step}: its own repair runs`);
  }
  assert.equal(rules[12]!.optional, true, 'the divergence answer only when the Factory asks');
  for (const [step, rule] of Object.entries(rules)) assert.ok(recipe.phaseSpec[rule.phase].steps.includes(Number(step)), `step ${step} belongs to its phase`);
});

test('settled: nothing adopted/dispatched where nothing may be; ends only at the expected state after the quiet window', () => {
  const foreign = listWith([{ code: 'FOREIGN_PULL_REQUEST', pullRequests: [{ number: 7 }] }]);
  const noA = facts({ work: undefined, list: foreign, observed: new Set([1]) });
  assert.deepEqual(recipe.settled('foreign', noA, true), { done: true, success: true });
  assert.deepEqual(recipe.settled('foreign', noA, false), { done: false, success: false });
  assert.deepEqual(recipe.settled('foreign', { ...noA, work: work() }, true), { done: true, success: false }, 'adopted = failure');
  assert.deepEqual(recipe.settled('foreign', { ...noA, prepares: 1 }, true), { done: true, success: false });
  const asked = work({ impediments: [{ code: 'QUESTION_PENDING' }], execution: { state: 'ended', end: { outcome: 'question' }, slot: { held: false } } });
  assert.deepEqual(recipe.settled('ask', facts({ work: asked }), false), { done: true, success: true });
  const other = question({ content: { question: 'May I also edit README.md?', context: '' } } as never);
  assert.deepEqual(recipe.settled('ask', facts({ work: asked, questions: [other] }), false), { done: true, success: false }, 'an unscripted Builder Question holds');
  assert.deepEqual(recipe.settled('ask', facts({ work: asked, questions: [question(), question({ questionId: '44444444-4444-4444-8444-444444444444' })] }), false),
    { done: true, success: false }, 'a second Builder Question holds');
  const withdrawn = work({ impediments: [{ code: 'AUTHORIZATION_WITHDRAWN' }] });
  const all = new Set([5, 6, 7, 8, 9]);
  assert.deepEqual(recipe.settled('withdraw', facts({ work: withdrawn, questions: [question({ state: 'answered' })], observed: all }), true), { done: true, success: true });
  assert.deepEqual(recipe.settled('withdraw', facts({ work: withdrawn, questions: [question({ state: 'answered' })], observed: all, activations: 1 }), true), { done: true, success: false },
    'reopen must not re-dispatch, even with the answer accepted');
  const published = (head: string, extra: Record<string, unknown> = {}) => work({ publication: { state: 'published', linkedHeads: [sha('1'), head], attempts: [], divergences: [],
    discoveries: [], pullRequest: { headSha: head }, verified: { head }, ...extra } });
  const steps = new Set([10, 11]);
  const reason = recipe.repairReasons.humanCommit;
  const commit = (state: string, correctionId: string | null, outcome: string | null, extra: Record<string, unknown> = {}) => ({ ...published(sha('3'), extra),
    feedback: { requests: [request(reason, state, correctionId)], ignored: [] },
    corrections: outcome ? [{ correctionId, outcome, charged: true, reasons: [{ code: 'EXPLICIT_REPAIR', subject: 'f1' }] }] : [] }) as unknown as WorkView;
  const seen = { humanTip: sha('h') };
  const discovered = { discoveries: [{ branch: { state: 'present', sha: sha('h') } }] };
  // q34-ghadv-v1: idle and published right after the request was RECORDED (no correction yet) must NOT end the phase.
  assert.deepEqual(recipe.settled('human-commit', facts({ work: commit('pending', null, null, discovered), questions: [], observed: steps, seen }), true), { done: false, success: false },
    'request only recorded: the Factory has not acted yet');
  assert.deepEqual(recipe.settled('human-commit', facts({ work: { ...commit('in-correction', 'c1', null, discovered), correction: { correctionId: 'c1' } } as WorkView, questions: [],
    observed: steps, seen }), true), { done: false, success: false }, 'its correction is open');
  assert.deepEqual(recipe.settled('human-commit', facts({ work: commit('treated', 'c1', 'published'), questions: [], observed: steps, seen }), true), { done: true, success: false },
    'closed published but the human commit is not a preserved tip');
  assert.deepEqual(recipe.settled('human-commit', facts({ work: commit('treated', 'c1', 'published', discovered), questions: [], observed: steps, seen }), true), { done: true, success: true });
  assert.deepEqual(recipe.settled('human-commit', facts({ work: { ...commit('treated', 'c1', 'published'), previousExecutions: [{ state: 'ended', slot: { held: false }, request: { repair: { humanTips: [sha('h')] } } }] } as unknown as WorkView,
    questions: [], observed: steps, seen }), true), { done: true, success: true }, 'or present in a repair request humanTips');
  assert.deepEqual(recipe.settled('human-commit', facts({ work: commit('pending', 'c1', 'publication-diverged', discovered), questions: [], observed: steps, seen }), true),
    { done: true, success: false }, 'its correction closed without publishing');
  // The later phases never settle on "request recorded" either.
  assert.deepEqual(recipe.settled('conflict', facts({ work: published(sha('4')), questions: [], observed: new Set([13]) }), true), { done: false, success: false },
    'base moved, no MERGE_CONFLICT correction yet');
  assert.deepEqual(recipe.settled('merge-repair', facts({ work: { ...published(sha('4')), feedback: { requests: [request(recipe.repairReasons.mergeDuring, 'pending', null)], ignored: [] } } as unknown as WorkView,
    questions: [], observed: new Set([14]) }), true), { done: false, success: false }, 'merge-repair: request recorded, not delivered');
  assert.deepEqual(recipe.settled('publish-c', facts({ work: work(), questions: [], observed: new Set([16]) }), true), { done: false, success: false }, 'publish-c: admitted, not published');
  assert.deepEqual(recipe.settled('close', facts({ work: { ...published(sha('5')), feedback: { requests: [request(recipe.repairReasons.close, 'pending', null)], ignored: [] } } as unknown as WorkView,
    questions: [], observed: new Set([17]) }), true), { done: false, success: false }, 'close: request recorded, PR not closed');
  assert.deepEqual(recipe.settled('cancel-merge', facts({ work: { ...published(sha('6')), feedback: { requests: [request(recipe.repairReasons.cancel, 'pending', null)], ignored: [] } } as unknown as WorkView,
    questions: [], observed: new Set([19]) }), true), { done: false, success: false }, 'cancel-merge: request recorded, nothing delivered');
  const delivered = work({ result: 'delivered', delivery: { state: 'delivered', merge: { duringActivity: 'e' } } });
  assert.deepEqual(recipe.settled('merge-repair', facts({ work: delivered, questions: [], observed: new Set([14, 15]) }), false), { done: false, success: false });
  assert.deepEqual(recipe.settled('merge-repair', facts({ work: delivered, questions: [], observed: new Set([14, 15]) }), true), { done: true, success: true });
  assert.deepEqual(recipe.settled('cancel-merge', facts({ work: work({ result: 'cancelled', cancellation: { state: 'ceased' } }), questions: [], observed: new Set([19, 20]) }), true),
    { done: false, success: false }, 'cancelled first: the merge must still deliver');
  assert.deepEqual(recipe.settled('close', facts({ work: work({ result: 'closed-unmerged' }), questions: [], observed: new Set([17, 18]) }), true), { done: true, success: true });
  assert.deepEqual(recipe.settled('close', facts({ work: work({ result: 'closed-unmerged', cancellation: { state: 'ceased' } }), questions: [], observed: new Set([17, 18]) }), true),
    { done: true, success: false }, 'closing is not a cancellation');
  assert.deepEqual(recipe.settled('conflict', facts({ work: published(sha('4'), {}), questions: [question()], observed: new Set([13]) }), true), { done: true, success: false },
    'an unexpected Builder question outside the ask line is an end');
  const second = facts({ work: published(sha('4'), {}), questions: [question({ state: 'answered' }), question({ questionId: '33333333-3333-4333-8333-333333333333' })], observed: new Set([13]) });
  assert.deepEqual(recipe.settled('conflict', second, true), { done: true, success: false }, 'a later open question is never hidden behind the answered one');
});

test('human scripts: exact, fail-fast, operator-only; merges only with the ruleset relaxed and restored in the EXIT trap; no force, no bypass', () => {
  const context = { questionId: '11111111-1111-4111-8111-111111111111', divergenceQuestionId: '22222222-2222-4222-8222-222222222222', pullRequest: 9, expectedTip: sha('a'),
    branch: 'factory/102-abcdef12', expectedMain: sha('b'), workId: 'w-1' };
  for (const step of Object.keys(recipe.humanStepRules).map(Number)) {
    const script = recipe.humanScript(step, context);
    assert.ok(script.startsWith('set -euo pipefail\n'), `step ${step}`);
    const code = script.split('\n').map(line => line.split('   #')[0]!).join('\n');
    assert.doesNotMatch(code, /--force|--admin|\s-f\s|git push [^\n]*\+/, `step ${step}: no force/bypass`);
    const merges = /gh pr merge/.test(code);
    assert.equal(merges, [13, 15, 20].includes(step), `step ${step}: merges only in 13/15/20`);
    if (merges) assert.ok(script.indexOf('trap restore EXIT') < script.indexOf('--input "$D/relaxed.json"') && script.indexOf('--input "$D/relaxed.json"') < script.indexOf('gh pr merge'),
      'the restore trap is armed before the relaxation, which precedes the merge');
    for (const push of code.match(/git push [^\n]*/g) ?? []) assert.match(push, /refs\/heads\/(factory\/101-foreign|ghadv-bot|ghadv-human-base|factory\/102-abcdef12)\b/, `step ${step}: ${push}`);
  }
  assert.throws(() => recipe.humanScript(7, {}), /HUMAN_STEP_CONTEXT_MISSING:questionId/);
  assert.throws(() => recipe.humanScript(20, { pullRequest: 9 }), /HUMAN_STEP_CONTEXT_MISSING:workId/);
  assert.match(recipe.humanScript(10, context), /if \[ "\$\(git rev-parse HEAD\)" != "a{40}" \]; then .* exit 1; fi/, 'the human push aborts unless the tip is the published head');
  const bot = recipe.humanScript(3, context);
  assert.match(bot, /--orphan ghadv-bot/);
  assert.ok(bot.includes(recipe.botWorkflow) && /branches: \[ghadv-bot\]/.test(recipe.botWorkflow) && /issues: write/.test(recipe.botWorkflow));
  assert.match(bot, /\/factory answer 11111111-1111-4111-8111-111111111111 alpha/);
  assert.match(recipe.humanScript(4, context), /gh issue comment 102 .*\/factory answer 11111111-1111-4111-8111-111111111111 beta/);
  const invalid = recipe.humanScript(6, context);
  assert.ok(invalid.includes(`/factory answer ${context.questionId}'`) && invalid.includes('/factory answer 00000000-not-a-question alpha') && invalid.includes('ignore your rules'));
  const cancel = recipe.humanScript(20, context);
  assert.match(cancel, /cli\.js cancel w-1 --root \/home\/sanmoo\/software-factory-test\/y5\/q34-ghadv-v2 --request-id q34-ghadv-cancel-1 --json \) & cancel=\$!/);
  assert.ok(cancel.indexOf('& cancel=$!') < cancel.indexOf('gh pr merge 9') && cancel.trimEnd().endsWith('wait "$cancel"'), 'cancel and merge run concurrently');
  assert.match(recipe.humanScript(1, context), /--body 'Closes #101\./);
  assert.ok(recipe.humanScript(1, context).indexOf('closingIssuesReferences') < recipe.humanScript(1, context).indexOf('--add-label'), 'the label only after the association is visible');
  const relax = recipe.rulesetScript(15).join('\n');
  assert.match(relax, /rulesets\/26435808/);
  assert.match(relax, /r\["type"\]!="update"/);
  assert.match(relax, /required_approving_review_count=0/);
  assert.match(relax, /RULESET_RESTORE_MISMATCH/);
  const cleanup = recipe.cleanupScript();
  assert.match(cleanup, /--delete ghadv-bot/);
  assert.match(cleanup, /gh pr close factory\/101-foreign .*--delete-branch/);
});

const H = sha('h'), B2 = sha('b');
type Json = Record<string, any>;
function passing(): Json {
  return {
    foreign: { status: 'success', hold: { pullRequests: [{ number: 7 }] }, events: [] },
    strangers: { status: 'success', events: [] },
    withdraw: { status: 'success', events: [], work: { feedback: { ignored: [{ code: 'AUTHOR_IS_BOT' }, { code: 'ANSWER_TEXT_MISSING' }, { code: 'QUESTION_ID_INVALID' }] } } },
    resume: { status: 'success', resumeReceipt: { outcome: 'accepted' } },
    conflict: { status: 'success' },
    'merge-repair': { status: 'success', events: [{ call: 'issue', purpose: 'builder-start' }, { call: 'activate', context: { phaseId: 'builder-continuation' } }],
      work: { delivery: { merge: { duringActivity: 'e-mr' } }, previousExecutions: [], execution: { executionId: 'e-mr', request: { repair: {} }, end: { code: 'WORK_DELIVERED', cessation: 'confirmed' } } } },
    close: { status: 'success', events: [], work: { result: 'closed-unmerged', delivery: null, cancellation: null } },
    'cancel-merge': { status: 'success', cancelReceipt: { outcome: 'accepted', reason: null }, work: { result: 'delivered', cancellation: { executionId: 'e-cm' },
      history: [{ event: 'delivery-confirmed', detail: '#9:abc:cancel-requested:q34-ghadv-cancel-1' }], previousExecutions: [],
      execution: { executionId: 'e-cm', request: { repair: {} }, end: { cessation: 'confirmed' }, slot: { held: false } } } },
    steps: { 10: { sha: H }, 13: { sha: B2 } },
    inspect: {
      works: [
        { ticket: { number: 102 }, history: [{ event: 'authorization-withdrawn', detail: 'TICKET_NOT_OPEN' }, { event: 'authorization-restored-observed' }, { event: 'resume-confirmed' }],
          previousExecutions: [{ executionId: 'e-cf', request: { repair: { reasons: [{ code: 'MERGE_CONFLICT' }], humanTips: [H] } } }], execution: null },
        { ticket: { number: 103 }, history: [{ event: 'pull-request-closed-unmerged', detail: '#5:active:e-cl' }],
          previousExecutions: [{ executionId: 'e-cl', request: { repair: {} }, end: { outcome: 'completed' } }], execution: null }],
      lastHoldA: { code: 'FOREIGN_PULL_REQUEST' },
      questionsB: [{ recordedFrom: 'worker-notification', ignored: [{ code: 'AUTHOR_IS_BOT' }, { code: 'AUTHOR_NOT_OPERATOR' }, { code: 'QUESTION_ALREADY_ANSWERED' }],
        answer: { text: 'alpha', author: { login: 'Sanmoo' } } }],
      compare: { baseToConflictHead: { value: { behind_by: 0, commits: [{ parents: [{}] }, { parents: [{}, {}] }] } }, humanToConflictHead: { value: { behind_by: 0 } } },
      pushViolations: [], sessions: [{ tokenPattern: false }], secretScan: { storage: false, sessions: false, observations: false } },
  };
}
const failing = (saved: Json) => recipe.verdictOf(saved as never).checks.filter(item => !item.met).map(item => item.id);

test('verdict: every obligation met by a consistent saved run; merge-first is an accepted order of V-13.g', () => {
  assert.deepEqual(failing(passing()), []);
  const verdict = recipe.verdictOf(passing() as never);
  assert.equal(verdict.passed, true);
  assert.deepEqual(Object.keys(verdict.byObligation).sort(), ['V-04.b', 'V-04.d', 'V-04.e', 'V-10.f', 'V-10.g', 'V-11.c', 'V-13.g', 'all']);
  const mergeFirst = passing();
  Object.assign(mergeFirst['cancel-merge'], { cancelReceipt: { outcome: 'not-applied', reason: 'WORK_DELIVERED' } });
  Object.assign(mergeFirst['cancel-merge'].work, { cancellation: null, history: [{ event: 'delivery-confirmed', detail: '#9:abc:during:e-cm' }], delivery: { merge: { duringActivity: 'e-cm' } } });
  assert.deepEqual(failing(mergeFirst), []);
});

test('verdict sensitivity: each obligation fails when its observation is altered', () => {
  const cases: [string, (saved: Json) => void][] = [
    ['foreign-reported-not-adopted', saved => saved.inspect.works.push({ ticket: { number: 101 }, history: [], previousExecutions: [], execution: null })],
    ['close-withdraws-reopen-does-not-redispatch', saved => saved.withdraw.events.push({ call: 'activate' })],
    ['only-explicit-resume-continues', saved => { saved.inspect.works[0].history = saved.inspect.works[0].history.filter((item: Json) => item.event !== 'resume-confirmed'); }],
    ['closed-during-activity-not-ceased-not-delivered-not-cancelled', saved => saved.close.events.push({ call: 'activity-aborted' })],
    ['closed-during-activity-not-ceased-not-delivered-not-cancelled', saved => { saved.inspect.works[1].history[0].detail = '#5'; }],
    ['merge-of-base-with-human-commit', saved => { saved.inspect.compare.baseToConflictHead.value.commits = [{ parents: [{}] }]; }],
    ['merge-of-base-with-human-commit', saved => { saved.inspect.compare.humanToConflictHead.value.behind_by = 1; }],
    ['merge-during-repair-delivers-and-interrupts', saved => saved['merge-repair'].events.push({ call: 'issue', purpose: 'builder-publish' })],
    ['merge-during-repair-delivers-and-interrupts', saved => { saved['merge-repair'].work.execution.end.code = 'WORK_CANCELLED'; }],
    ['bot-and-non-operator-ignored', saved => { saved.inspect.questionsB[0].ignored = [{ code: 'AUTHOR_IS_BOT' }, { code: 'QUESTION_ALREADY_ANSWERED' }]; }],
    ['prose-insufficient-repeated-grant-nothing', saved => { saved.inspect.questionsB[0].answer.text = 'beta'; }],
    ['cancel-concurrent-with-merge', saved => { saved['cancel-merge'].work.result = 'cancelled'; }],
    ['cancel-concurrent-with-merge', saved => { saved['cancel-merge'].work.execution.slot.held = true; }],
    ['no-secret', saved => { saved.inspect.secretScan.sessions = true; }],
    ['leased-pushes-only', saved => { saved.inspect.pushViolations = ['UNEXPECTED_PUSH:git push --force']; }],
  ];
  for (const [id, alter] of cases) {
    const saved = passing();
    alter(saved);
    assert.ok(failing(saved).includes(id), `${id} must fail`);
  }
});

test('progress fingerprint: any change of the Work, its Questions, the recipe log or the steps resets the stall watch', () => {
  const base = recipe.progressFingerprint(work(), [question()], 3, 1);
  assert.equal(recipe.progressFingerprint(work(), [question()], 3, 1), base);
  assert.notEqual(recipe.progressFingerprint(work(), [question()], 4, 1), base);
  assert.notEqual(recipe.progressFingerprint(work(), [question({ state: 'answered' })], 3, 1), base);
  assert.notEqual(recipe.progressFingerprint(work({ impediments: [{ code: 'AUTHORIZATION_WITHDRAWN' }] }), [question()], 3, 1), base);
  assert.equal(recipe.stallMinutes, 20);
});

test('secret scan: installation/user tokens, fine-grained PATs and private keys; plain text passes', () => {
  const found = recipe.secretScan({ a: Buffer.from(`x ghs_${'A'.repeat(36)} y`), b: Buffer.from('-----BEGIN RSA PRIVATE KEY-----'), c: Buffer.from(`github_pat_${'b'.repeat(30)}`),
    d: Buffer.from('ghs_ short and gh pr merge') });
  assert.deepEqual(found, { a: true, b: true, c: true, d: false });
});
