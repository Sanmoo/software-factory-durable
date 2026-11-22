import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkView } from '../../src/control/index.js';
import { activationGuard, conversionGuard, grantGuard, phaseGuard, probeExpectation, settled, ticket, verdictOf } from './ghchecks34s-qualification.js';

// R-GH-CHECKS-S recipe safety on controlled data only.
test('phase guard: reads first (each after the previous one consumed), then run -> strict -> human-draft on success', () => {
  const none = new Set<string>();
  const ok = { status: 'success' };
  assert.equal(phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('rerun', { preflight: ok }, none, true), null);
  assert.equal(phaseGuard('contexts', { preflight: ok }, none, true), 'RERUN_NOT_CONSUMED');
  assert.equal(
    phaseGuard('contexts', { preflight: ok, rerun: { status: 'held' } }, new Set(['rerun-intent']), true),
    null,
    'a held read does not stop the others',
  );
  assert.equal(phaseGuard('run', { preflight: ok, homonym: ok }, new Set(['homonym-intent']), true), null);
  assert.equal(phaseGuard('run', { preflight: ok }, none, true), 'HOMONYM_NOT_CONSUMED');
  assert.equal(phaseGuard('strict', { preflight: ok, run: { status: 'held' } }, none, true), 'RUN_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('human-draft', { preflight: ok, strict: ok }, none, true), null);
  assert.equal(phaseGuard('run', { preflight: ok, homonym: ok }, new Set(['homonym-intent', 'run-intent']), true), 'PHASE_ALREADY_RAN');
});

test('guards: run = implementation then publication; strict = ONE repair then publication, never a second; human-draft launches and converts nothing', () => {
  const c = (role: string, phaseId: string, executionId: string) => ({ role, workId: 'w', executionId, phaseId });
  const n = ticket.number;
  const run = activationGuard('run');
  assert.equal(run(c('builder', 'builder-initial', 'e1'), undefined, n), true);
  assert.equal(run(c('builder', 'builder-publication', 'e2'), undefined, n), true);
  assert.equal(run(c('builder', 'builder-continuation', 'e3'), undefined, n), false, 'no repair in run');
  const strict = activationGuard('strict');
  assert.equal(strict(c('builder', 'builder-initial', 'e1'), undefined, n), false);
  assert.equal(strict(c('builder', 'builder-continuation', 'e1'), undefined, n), true);
  assert.equal(strict(c('builder', 'builder-publication', 'e2'), undefined, n), true);
  assert.equal(strict(c('builder', 'builder-continuation', 'e3'), undefined, n), false, 'no second repair');
  assert.equal(activationGuard('human-draft')(c('builder', 'builder-continuation', 'e1'), undefined, n), false);
  assert.equal(grantGuard('human-draft')('builder-start', { publicationState: 'published', publicationActivation: false }), false);
  const runConversions = conversionGuard('run');
  assert.deepEqual([runConversions(true), runConversions(false), runConversions(false)], [false, true, false], 'run: one mark-ready only');
  const strictConversions = conversionGuard('strict');
  assert.deepEqual([strictConversions(true), strictConversions(false), strictConversions(false)], [true, true, false]);
});

const work = (extra: Record<string, unknown>) =>
  ({
    publication: { state: 'published' },
    execution: null,
    impediments: [],
    correction: null,
    corrections: [],
    readiness: null,
    checks: null,
    ...extra,
  }) as unknown as WorkView;
const facts = { activations: 2, humanObserved: true, quietCyclesDone: true, conversions: 0, refusedConversions: 0 };
const ready = (effects: string[]) => ({
  flag: { factory: 'ready', observed: 'ready' },
  effects: effects.map(action => ({ action, state: 'confirmed' })),
  effect: null,
});
test("settled: run ends at the Factory's ready with satisfied checks and no correction; strict at ONE published strict correction and ready again", () => {
  assert.deepEqual(settled('run', work({ readiness: ready(['mark-ready']), checks: { latest: { outcome: 'satisfied' } } }), facts), {
    done: true,
    success: true,
  });
  assert.deepEqual(settled('run', work({ readiness: ready([]), checks: { latest: { outcome: 'waiting' } } }), facts), { done: false, success: false });
  assert.deepEqual(
    settled('run', work({ corrections: [{ outcome: 'published' }] }), facts),
    { done: true, success: false },
    'a correction in run is not this design',
  );
  const strict = work({
    corrections: [{ outcome: 'published', reasons: [{ code: 'STRICT_UPDATE_REQUIRED' }] }],
    readiness: ready(['mark-ready', 'convert-to-draft', 'mark-ready']),
    checks: { latest: { outcome: 'satisfied' } },
  });
  assert.deepEqual(settled('strict', strict, facts), { done: true, success: true });
  assert.deepEqual(settled('strict', strict, { ...facts, humanObserved: false }), { done: true, success: false });
  assert.deepEqual(settled('strict', work({ publication: { state: 'not-publishable', reasons: ['X'] } }), facts), { done: true, success: false });
  const drafted = work({
    corrections: [{ outcome: 'published' }],
    readiness: { flag: { factory: 'ready', observed: 'draft' }, humanDraft: { observedAt: 't' } },
  });
  assert.deepEqual(settled('human-draft', drafted, { ...facts, activations: 0 }), { done: true, success: true });
  assert.deepEqual(settled('human-draft', drafted, { ...facts, activations: 0, conversions: 1 }), { done: true, success: false });
});

test('the probe PR is evaluated with its own identity: no ownership reason can mask a check fact', () => {
  const expect = probeExpectation({
    repositoryId: 3,
    pullRequest: { pullRequestId: 9, nodeId: 'PR_n', number: 101, headRef: 'q34s-probe', headSha: 'a'.repeat(40), baseRef: 'main', author: { id: 7 } },
  });
  assert.deepEqual(expect, {
    own: { pullRequestId: 9, nodeId: 'PR_n', number: 101, headRef: 'q34s-probe', base: 'main', authorId: 7 },
    repositoryId: 3,
    linkedHeads: ['a'.repeat(40)],
    localRequiredChecks: [],
  });
});

function passing() {
  const [h1, h2, b1] = ['1', '2', 'b'].map(c => c.repeat(40)) as [string, string, string];
  const req = (context: string, extra: Record<string, unknown>) => ({ context, ...extra });
  return {
    run: {
      status: 'success',
      events: [
        { call: 'checks', head: h1, outcome: 'waiting' },
        { call: 'checks', head: h1, outcome: 'satisfied' },
      ],
    },
    strict: { status: 'success' },
    strictObserved: { sha: b1 },
    humanDraft: { status: 'success', events: [] },
    rerun: { status: 'success', reads: [{ evaluation: { outcome: 'waiting', requirements: [req('factory-gate', { state: 'waiting' })] } }] },
    contexts: {
      status: 'success',
      evaluation: {
        strict: { required: true },
        reasons: [{ category: 'wait', code: 'REQUIRED_CHECK_ABSENT', subject: 'factory-absent' }],
        requirements: [req('factory-optional', { state: 'satisfied', results: [{ conclusion: 'skipped' }] })],
        modalities: [{ type: 'required_linear_history' }],
      },
    },
    classic: {
      status: 'success',
      evaluation: {
        outcome: 'blocked',
        requirements: [req('factory-gate', { sources: ['classic', 'ruleset:26435808:Repository:x'] })],
        modalities: [
          { type: 'lock_branch', source: 'classic', merge: 'blocking', reason: 'BRANCH_LOCKED' },
          { type: 'required_signatures', source: 'classic', merge: 'blocking', reason: 'SIGNED_COMMITS_REQUIRED' },
        ],
      },
    },
    homonym: {
      status: 'success',
      evaluation: { requirements: [req('factory-gate', { state: 'satisfied', otherOrigin: [{ kind: 'status', status: 'failure' }] })] },
    },
    inspect: {
      work: {
        publication: { linkedHeads: [h1, h2] },
        corrections: [{ outcome: 'published', reasons: [{ code: 'STRICT_UPDATE_REQUIRED', headSha: h1, baseTip: b1 }] }],
        readiness: {
          humanDraft: { observedAt: 't' },
          effects: [
            { action: 'mark-ready', state: 'confirmed' },
            { action: 'convert-to-draft', state: 'confirmed' },
          ],
          effect: { action: 'mark-ready', state: 'confirmed' },
        },
      },
      compare: { value: { behind_by: 0 } },
      changedFiles: ['docs/FACTORY_CHECKS_S.md'],
      pull: { pullRequest: { merged: false } },
      pushViolations: [],
      sessions: [{ tokenPattern: false }],
      secretScan: { matches: [] },
    },
  } as Record<string, Record<string, unknown>>;
}
test('verdict: met on a complete passing set (12 checks); sensitive per obligation; a no-op fails', () => {
  const failing = (saved: Record<string, Record<string, unknown>>) =>
    verdictOf(saved)
      .checks.filter(item => !item.met)
      .map(item => item.id);
  assert.deepEqual(failing(passing()), []);
  assert.equal(verdictOf(passing()).checks.length, 12);
  assert.equal(verdictOf({}).passed, false);
  let saved = passing();
  (saved.classic!.evaluation as Record<string, unknown>).outcome = 'satisfied';
  assert.deepEqual(failing(saved), ['classic.settings-merge-blocking']);
  saved = passing();
  ((saved.inspect!.work as Record<string, unknown>).readiness as Record<string, unknown>).effects = [{ action: 'mark-ready', state: 'confirmed' }];
  assert.ok(failing(saved).includes('strict.loss-back-to-draft'));
  saved = passing();
  saved.run!.events = [{ call: 'checks', head: '1'.repeat(40), outcome: 'satisfied' }];
  assert.deepEqual(failing(saved), ['run.pending-then-satisfied']);
  saved = passing();
  (saved.inspect!.changedFiles as string[]).push('ci/factory-gate.sh');
  assert.deepEqual(failing(saved), ['no-bypass']);
});
