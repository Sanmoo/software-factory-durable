import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuestionView, WorkView } from '../../src/control/index.js';
import { abortsBeforeEnd, specRepairAnswer } from './ghadv34-qualification.js';
import * as recipe from './ghadvs34-qualification.js';

// Rules of the R-GH-ADV-S real-run recipe on controlled data only (no GitHub, VM, model or real root). A test number is pinned in THIS process
// only; the recipe module itself ships unpinned (see ghadvs34-recipe-safety.test.ts).
Object.assign(recipe.ticket, { number: 120 });
const sha = (c: string) => c.repeat(40);
const bare = (end: { done: boolean; success: boolean; reason?: string }) => ({ done: end.done, success: end.success });
const none = new Set<string>();

test('pinned and phase guard: ONE Ticket, strict order publish-c -> close -> cancel-merge, one shot, inspect once nothing runs', () => {
  assert.equal(recipe.pinned(0), false);
  assert.equal(recipe.pinned(), true);
  assert.deepEqual([...recipe.phases], ['preflight', 'publish-c', 'close', 'cancel-merge', 'inspect', 'stop-environment']);
  assert.equal(recipe.phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(recipe.phaseGuard('publish-c', { preflight: { status: 'held' } }, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('cancel-merge', { close: { status: 'held' } }, none, true), 'CLOSE_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('close', { 'publish-c': { status: 'success' } }, new Set(['close-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(recipe.phaseGuard('inspect', { preflight: { status: 'success' } }, new Set(['close-intent']), true), 'PHASE_NOT_ENDED:close');
  assert.equal(recipe.phaseGuard('inspect', { preflight: { status: 'success' } }, new Set(['close-intent']), true, new Set(['close'])), null);
  assert.equal(recipe.pollingSeconds, 30, 'the delivery is read while a short repair still runs');
});

test('activation and grant guards: close never publishes; the resumed repair after the tolerated answer fits the budget', () => {
  const ctx = (role: string, phaseId: string, executionId = 'e1', workId = 'w') => ({ role, workId, executionId, phaseId });
  const close = recipe.activationGuard('close', () => 'w');
  assert.equal(close(ctx('builder', 'builder-continuation')), true);
  assert.equal(close(ctx('builder', 'builder-publication', 'e2')), false, 'no publication after the PR was closed');
  assert.equal(close(ctx('builder', 'builder-recovery', 'e3')), true, 'the question-resumed repair');
  assert.equal(close(ctx('builder', 'builder-recovery', 'e4')), false, 'budget exhausted');
  assert.equal(close(ctx('spec', 'p', 'e3'), { round: 2 }), true);
  assert.equal(close(ctx('builder', 'builder-continuation', 'e5', 'other')), false, 'another Work');
  assert.equal(recipe.grantGuard('close')('builder-publish', { publicationState: 'requested', publicationActivation: true, executionId: 'p' }), false);
  const merge = recipe.grantGuard('cancel-merge', 1);
  assert.equal(merge('builder-publish', { publicationState: 'requested', publicationActivation: true, executionId: 'p' }), true);
  assert.equal(merge('builder-publish', { publicationState: 'requested', publicationActivation: true, executionId: 'p' }), false);
});

const v4Close =
  'Please resolve the conflict between the Ticket and the authorized repair request for docs/FACTORY_CLOSE.md. The Ticket requires exactly three numbered ' +
  'steps and only the specified short content, while repair request repair-github-comment-6964906809 requires adding `Repair: requested before the pull request was closed.` ' +
  "at the end of the same file. Should the repair line be retained despite the Ticket's content constraint, or should the Ticket constraint take precedence and the line be removed?";
const question = (extra: Partial<QuestionView> = {}) =>
  ({
    questionId: '88888888-8888-4888-8888-888888888888',
    workId: 'w',
    recordedFrom: 'worker-notification',
    state: 'open',
    publication: { state: 'published' },
    ignored: [],
    answer: null,
    content: { question: v4Close, context: '' },
    ...extra,
  }) as unknown as QuestionView;
const request = (reason: string, state: string, correctionId: string | null) => ({
  feedbackId: 'f1',
  code: 'EXPLICIT_REPAIR',
  state,
  correctionId,
  feedback: { content: `/factory repair ${reason}` },
});
const work = (extra: Record<string, unknown> = {}) =>
  ({
    work_id: 'w',
    ticket: { number: 120 },
    result: 'open',
    impediments: [],
    previousExecutions: [],
    execution: null,
    correction: null,
    corrections: [],
    feedback: { ignored: [], requests: [] },
    publication: { state: 'published', pullRequest: { headSha: sha('1') } },
    ...extra,
  }) as unknown as WorkView;
const facts = (extra: Partial<recipe.Facts> = {}): recipe.Facts => ({
  work: work(),
  questions: [],
  activations: 0,
  prepares: 0,
  observed: new Set(),
  ...extra,
});

test('human steps: the close and the cancel+merge wait for the repair Execution of THEIR request; nothing settles on a merely recorded request', () => {
  const rules = recipe.humanStepRules;
  for (const [step, reason] of [
    [3, recipe.repairReasons.close],
    [5, recipe.repairReasons.cancel],
  ] as const) {
    const at = (correctionId: string, extra: Record<string, unknown> = {}) => ({
      state: 'started',
      request: { repair: { correctionId }, ...extra },
      slot: { held: true },
    });
    const recorded = (state: string, correctionId: string | null) => ({ requests: [request(reason, state, correctionId)], ignored: [] });
    const previous = new Set([step - 1]);
    assert.equal(
      rules[step]!.ready(facts({ work: work({ feedback: recorded('pending', null), execution: at('c0') }), observed: previous })),
      false,
      `${step}: only recorded`,
    );
    assert.equal(
      rules[step]!.ready(facts({ work: work({ feedback: recorded('in-correction', 'c1'), execution: at('c1', { publication: {} }) }), observed: previous })),
      false,
      `${step}: never during a publication activation`,
    );
    assert.equal(
      rules[step]!.ready(facts({ work: work({ feedback: recorded('in-correction', 'c1'), execution: at('c1') }), observed: previous })),
      true,
      `${step}: its own repair runs`,
    );
  }
  assert.deepEqual(
    bare(
      recipe.settled(
        'close',
        facts({ work: work({ feedback: { requests: [request(recipe.repairReasons.close, 'pending', null)], ignored: [] } }), observed: new Set([2]) }),
        true,
      ),
    ),
    { done: false, success: false },
  );
  assert.deepEqual(
    bare(
      recipe.settled(
        'cancel-merge',
        facts({ work: work({ feedback: { requests: [request(recipe.repairReasons.cancel, 'pending', null)], ignored: [] } }), observed: new Set([4]) }),
        true,
      ),
    ),
    { done: false, success: false },
  );
  assert.deepEqual(bare(recipe.settled('publish-c', facts({ work: work({ publication: null }), observed: new Set([1]) }), true)), {
    done: false,
    success: false,
  });
  for (const [step, rule] of Object.entries(rules))
    for (const phase of rule.phases) assert.ok(recipe.phaseSpec[phase].steps.includes(Number(step)), `${step} in ${phase}`);
});

test('settled: close ends only closed-unmerged after the quiet window; cancel-merge only delivered; every held end names its reason', () => {
  assert.deepEqual(recipe.settled('close', facts({ work: work({ result: 'closed-unmerged' }), observed: new Set([2, 3]) }), true), {
    done: true,
    success: true,
  });
  assert.deepEqual(bare(recipe.settled('close', facts({ work: work({ result: 'closed-unmerged' }), observed: new Set([2, 3]) }), false)), {
    done: false,
    success: false,
  });
  assert.equal(
    recipe.settled('close', facts({ work: work({ result: 'closed-unmerged', cancellation: { state: 'ceased' } }), observed: new Set([2, 3]) }), true).reason,
    'CLOSE_RECORDED_AS_CANCELLATION',
  );
  assert.deepEqual(
    bare(recipe.settled('cancel-merge', facts({ work: work({ result: 'cancelled', cancellation: { state: 'ceased' } }), observed: new Set([4, 5]) }), true)),
    { done: false, success: false },
    'cancelled first: the merge must still deliver',
  );
  const delivered = work({ result: 'delivered', delivery: { state: 'delivered', merge: { mergedAt: '2026-11-18T00:00:00Z' } } });
  assert.deepEqual(recipe.settled('cancel-merge', facts({ work: delivered, observed: new Set([4, 5]) }), true), { done: true, success: true });
  assert.equal(
    recipe.settled('close', facts({ work: work({ execution: { state: 'held', held: { code: 'X' }, slot: { held: false } } }) }), true).reason,
    'EXECUTION_HELD:X',
  );
  assert.equal(recipe.holdReasonOf({ done: false, success: false }, true), 'DEADLINE_REACHED');
  assert.equal(recipe.holdReasonOf({ done: false, success: false }, false), 'ENDED_WITHOUT_SETTLING');
  assert.equal(recipe.holdReasonOf({ done: true, success: true }, false), null);
});

test('the ONE tolerated Spec-vs-repair Question: answered once per run in close/cancel-merge; any other or a second one holds, with its id', () => {
  const asked = facts({ questions: [question()], observed: new Set([2]) });
  assert.deepEqual(bare(recipe.settled('close', asked, true)), { done: false, success: false }, 'waits for step 6');
  assert.equal(recipe.humanStepRules[6]!.ready(asked), true);
  assert.deepEqual(recipe.settled('close', { ...asked, specRepairUsed: true }, true), {
    done: true,
    success: false,
    reason: 'UNSCRIPTED_QUESTION:88888888-8888-4888-8888-888888888888',
  });
  assert.equal(recipe.humanStepRules[6]!.ready({ ...asked, specRepairUsed: true }), false);
  assert.deepEqual(bare(recipe.settled('close', { ...asked, observed: new Set([2, 6]) }, true)), { done: true, success: false }, 'a second one');
  const other = question({ content: { question: 'May I also edit README.md?', context: '' } } as never);
  assert.equal(recipe.settled('cancel-merge', facts({ questions: [other] }), true).reason, 'UNSCRIPTED_QUESTION:88888888-8888-4888-8888-888888888888');
  assert.equal(
    recipe.settled('publish-c', facts({ questions: [question()] }), true).reason,
    'UNSCRIPTED_QUESTION:88888888-8888-4888-8888-888888888888',
    'not tolerated in publish-c',
  );
  assert.equal(
    recipe.humanStepRules[6]!.observed(
      facts({ questions: [question({ state: 'answered', answer: { text: specRepairAnswer('repair-github-comment-1') } } as never)] }),
    ),
    true,
  );
  assert.equal(recipe.humanStepRules[6]!.observed(facts({ questions: [question({ state: 'answered', answer: { text: 'beta' } } as never)] })), false);
  assert.ok(recipe.ticket.body.includes(recipe.repairsInScope), 'the Ticket puts repairs in scope');
});

test('human scripts: exact, fail-fast, operator-only; the ONE merge relaxes the ruleset inside an EXIT trap; cancel launched first, merge right after', () => {
  const context = { pullRequest: 9, workId: 'w-1', specQuestionId: '88888888-8888-4888-8888-888888888888', repairRef: 'repair-github-comment-6964906809' };
  for (const step of Object.keys(recipe.humanStepRules).map(Number)) {
    const script = recipe.humanScript(step, context);
    assert.ok(script.startsWith('set -euo pipefail\n'), `step ${step}`);
    const code = script
      .split('\n')
      .map(line => line.split('   #')[0]!)
      .join('\n');
    assert.doesNotMatch(code, /--force|--admin|git push/, `step ${step}: no push, force or bypass`);
    assert.equal(/gh pr merge/.test(code), step === 5, `step ${step}`);
  }
  const both = recipe.humanScript(5, context);
  assert.ok(
    both.indexOf('trap restore EXIT') < both.indexOf('--input "$D/relaxed.json"') && both.indexOf('--input "$D/relaxed.json"') < both.indexOf('gh pr merge'),
  );
  assert.ok(both.indexOf('& cancel=$!') < both.indexOf('gh pr merge 9') && both.trimEnd().endsWith('wait "$cancel"'), 'cancel first, merge concurrently');
  assert.match(both, /cli\.js cancel w-1 --root \/home\/sanmoo\/software-factory-test\/y5\/q34-ghadv-s-v2 --request-id q34-ghadv-s-cancel-1 --json/);
  assert.match(recipe.humanScript(3, context), /^gh pr close 9 --repo /m);
  assert.doesNotMatch(recipe.humanScript(3, context).split('   #')[0]!, /delete-branch/);
  assert.match(
    recipe.humanScript(6, context),
    /gh issue comment 120 .*'\/factory answer 88888888-8888-4888-8888-888888888888 Keep the line the operator'\\''s repair request repair-github-comment-6964906809 added/,
  );
  assert.throws(() => recipe.humanScript(5, { pullRequest: 9 }), /HUMAN_STEP_CONTEXT_MISSING:workId/);
  assert.match(recipe.cleanupScript(), /--remove-label ready-for-agent/);
});

type Json = Record<string, any>;
const T0 = '2026-11-18T10:00:00.000Z',
  T1 = '2026-11-18T10:01:00.000Z',
  T2 = '2026-11-18T10:02:00.000Z';
function passing(): Json {
  return {
    close: {
      status: 'success',
      events: [{ call: 'activate', context: { phaseId: 'builder-continuation' } }],
      work: { result: 'closed-unmerged', delivery: null, cancellation: null },
    },
    'cancel-merge': {
      status: 'success',
      cancelReceipt: { outcome: 'accepted', reason: null },
      events: [],
      work: {
        result: 'delivered',
        cancellation: { executionId: 'e-cm' },
        delivery: { merge: { mergedAt: T1, duringActivity: null } },
        history: [{ event: 'delivery-confirmed', detail: '#9:abc:cancel-requested:q34-ghadv-s-cancel-1' }],
        previousExecutions: [],
        execution: { executionId: 'e-cm', request: { repair: {} }, start: { confirmedAt: T0 }, end: { at: T2, cessation: 'confirmed' }, slot: { held: false } },
      },
    },
    inspect: {
      works: [
        {
          ticket: { number: 120 },
          history: [{ event: 'pull-request-closed-unmerged', detail: '#9:active:e-cl' }],
          previousExecutions: [{ executionId: 'e-cl', request: { repair: {} }, end: { outcome: 'completed' } }],
          execution: null,
        },
      ],
      pushViolations: [],
      sessions: [{ tokenPattern: false }],
      secretScan: { storage: false, sessions: false, observations: false },
    },
  };
}
const failing = (saved: Json) =>
  recipe
    .verdictOf(saved as never)
    .checks.filter(item => !item.met)
    .map(item => item.id);

test('verdict: V-04.e, V-10.g and V-13.g met by a consistent saved run; merge-first is an accepted order', () => {
  assert.deepEqual(failing(passing()), []);
  assert.deepEqual(Object.keys(recipe.verdictOf(passing() as never).byObligation).sort(), ['V-04.e', 'V-10.g', 'V-13.g', 'all']);
  const mergeFirst = passing();
  Object.assign(mergeFirst['cancel-merge'], { cancelReceipt: { outcome: 'not-applied', reason: 'WORK_DELIVERED' } });
  Object.assign(mergeFirst['cancel-merge'].work, { cancellation: null, delivery: { merge: { mergedAt: T1, duringActivity: 'e-cm' } }, history: [] });
  assert.deepEqual(failing(mergeFirst), []);
});

test('q34-ghadv-s-v2 (D-12): the owner-shutdown aborts AFTER the repair completed are not an interruption; an abort before its end still fails', () => {
  const v2 = passing();
  const repair = v2.inspect.works[0].previousExecutions[0];
  repair.executionId = '0b523339-f7ef-40b2-9163-e6c144f6626e';
  repair.end = { at: '2026-11-18T09:00:20.996Z', outcome: 'completed', cessation: 'confirmed' };
  v2.inspect.works[0].history[0].detail = '#121:active:0b523339-f7ef-40b2-9163-e6c144f6626e';
  for (const role of ['builder', 'standards', 'spec'])
    v2.close.events.push({ at: '2026-11-18T09:02:05.324Z', call: 'activity-aborted', role, executionId: repair.executionId });
  assert.ok(!failing(v2).includes('closed-during-repair-not-ceased-not-delivered-not-cancelled'), 'the v2 run meets V-04.e');
  assert.equal(abortsBeforeEnd(v2.close.events, repair), 0);
  v2.close.events.push({ at: '2026-11-18T09:00:10.000Z', call: 'activity-aborted', role: 'builder', executionId: repair.executionId });
  assert.equal(abortsBeforeEnd(v2.close.events, repair), 1);
  assert.ok(failing(v2).includes('closed-during-repair-not-ceased-not-delivered-not-cancelled'), 'an abort before the end is an interruption');
  assert.equal(abortsBeforeEnd([{ call: 'activity-aborted' }], repair), 1, 'an abort without a time counts');
  assert.equal(abortsBeforeEnd([{ call: 'activity-aborted', at: '2026-11-18T09:00:10.000Z', executionId: 'other' }], repair), 0, 'another Execution');
});

test('verdict sensitivity: each obligation fails when its observation is altered', () => {
  const cases: [string, (saved: Json) => void][] = [
    ['closed-during-repair-not-ceased-not-delivered-not-cancelled', saved => saved.close.events.push({ call: 'activity-aborted' })],
    [
      'closed-during-repair-not-ceased-not-delivered-not-cancelled',
      saved => {
        saved.inspect.works[0].history[0].detail = '#9';
      },
    ],
    [
      'pull-request-ended-during-repair',
      saved => {
        saved['cancel-merge'].work.delivery.merge.mergedAt = '2026-11-18T10:05:00.000Z';
      },
    ],
    ['pull-request-ended-during-repair', saved => saved['cancel-merge'].events.push({ call: 'activate', at: T2, context: { phaseId: 'builder-publication' } })],
    [
      'cancel-concurrent-with-merge',
      saved => {
        saved['cancel-merge'].work.result = 'cancelled';
      },
    ],
    [
      'cancel-concurrent-with-merge',
      saved => {
        saved['cancel-merge'].work.execution.slot.held = true;
      },
    ],
    [
      'cancel-concurrent-with-merge',
      saved => {
        saved['cancel-merge'].work.history = [];
      },
    ],
    [
      'no-secret',
      saved => {
        saved.inspect.secretScan.storage = true;
      },
    ],
    [
      'leased-pushes-only',
      saved => {
        saved.inspect.pushViolations = ['UNEXPECTED_PUSH:x'];
      },
    ],
  ];
  for (const [id, alter] of cases) {
    const saved = passing();
    alter(saved);
    assert.ok(failing(saved).includes(id), `${id} must fail`);
  }
});
