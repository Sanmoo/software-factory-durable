import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WorkView } from '../../src/control/index.js';
import { activationGuard, actionsAppId, conversionGuard, grantGuard, humanSteps, labelExact, listAll, operatorPr, phaseGuard, questionsOf, rulesetBody, rulesetMatches, runIdOf, secretScan, settled,
  tickets, verdictOf, type Ruleset } from './ghchecks34-qualification.js';

// R-GH-CHECKS recipe safety on controlled data only (never the real root, a real gh, GitHub, a VM or a model).
const live: Ruleset = { name: 'main-review', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
  rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1, allowed_merge_methods: ['merge', 'squash', 'rebase'] } }, { type: 'non_fast_forward' },
    { type: 'deletion' }, { type: 'update' }] };

test('phase guard: pinned issues, one shot, run after a CONSUMED waiver, Control phases chained on success, read phases after the previous one consumed', () => {
  const none = new Set<string>();
  const ok = { status: 'success' };
  assert.equal(phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('preflight', {}, none, true), null);
  assert.equal(phaseGuard('preflight', {}, new Set(['preflight-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('waiver', { preflight: { status: 'held' } }, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('run', { preflight: ok }, none, true), 'WAIVER_NOT_CONSUMED');
  assert.equal(phaseGuard('run', { preflight: ok, waiver: { status: 'held' } }, new Set(['waiver-intent']), true), null, 'a held waiver does not lose the repair run');
  assert.equal(phaseGuard('failing', { preflight: ok, run: { status: 'held' } }, none, true), 'RUN_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('human-draft', { preflight: ok, strict: ok }, none, true), null);
  assert.equal(phaseGuard('rerun', { preflight: ok, 'human-draft': { status: 'held' } }, none, true), 'HUMAN_DRAFT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('contexts', { preflight: ok, rerun: { status: 'held' } }, new Set(['rerun-intent']), true), null);
  assert.equal(phaseGuard('classic', { preflight: ok }, none, true), 'CONTEXTS_NOT_CONSUMED');
  assert.equal(phaseGuard('inspect', { preflight: ok }, none, true), null);
});

test('activation, grant and conversion guards: the waiver never publishes; repairs continue the session; human-draft launches and converts nothing', () => {
  const c = (role: string, phaseId: string, executionId = 'e1') => ({ role, workId: 'w', executionId, phaseId });
  const waiver = activationGuard('waiver', 7);
  assert.equal(waiver(c('builder', 'builder-initial'), undefined, 8), false, 'only the phase Ticket');
  assert.equal(waiver(c('builder', 'builder-initial'), undefined, 7), true);
  assert.equal(waiver(c('spec', 'p'), { round: 1 }, 7), true);
  assert.equal(waiver(c('builder', 'builder-publication', 'e2'), undefined, 7), false, 'no publication after a waiver');
  assert.equal(grantGuard('waiver')('builder-publish', { publicationState: 'requested', publicationActivation: true }), false);
  const failing = activationGuard('failing', 9, 2);
  assert.equal(failing(c('builder', 'builder-initial'), undefined, 9), false, 'never /implement again');
  assert.equal(failing(c('builder', 'builder-continuation'), undefined, 9), true);
  assert.equal(failing(c('builder', 'builder-publication', 'e2'), undefined, 9), true);
  assert.equal(failing(c('builder', 'builder-continuation', 'e3'), undefined, 9), false, 'no second repair');
  assert.equal(activationGuard('human-draft', 9)(c('builder', 'builder-continuation'), undefined, 9), false);
  assert.equal(grantGuard('human-draft')('builder-start', { publicationState: 'published', publicationActivation: false }), false);
  const strict = conversionGuard('strict');
  assert.deepEqual([strict(false), strict(true), strict(false), strict(false)], [false, true, true, false], 'strict: back to draft, then ready, nothing else');
  assert.equal(conversionGuard('human-draft')(false), false);
  assert.equal(conversionGuard('run')(false), false);
});

test('ruleset bodies come from the LIVE ruleset: relaxed drops update and approvals; loose/strict add the Actions-bound check; before restores it exactly', () => {
  assert.deepEqual(rulesetBody(live, 'before'), live);
  const relaxed = rulesetBody(live, 'relaxed');
  assert.deepEqual(relaxed.rules.map(rule => rule.type), ['pull_request', 'non_fast_forward', 'deletion']);
  assert.equal(relaxed.rules[0]!.parameters!.required_approving_review_count, 0);
  assert.deepEqual(relaxed.rules[0]!.parameters!.allowed_merge_methods, ['merge', 'squash', 'rebase']);
  assert.deepEqual(relaxed.bypass_actors, live.bypass_actors, 'bypass actors unchanged: the App never gains one');
  const strict = rulesetBody(live, 'strict');
  assert.deepEqual(strict.rules.at(-1), { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
    required_status_checks: [{ context: 'factory-gate', integration_id: actionsAppId }] } });
  assert.equal(rulesetBody(live, 'loose').rules.at(-1)!.parameters!.strict_required_status_checks_policy, false);
  assert.deepEqual(rulesetBody(live, 'contexts').rules.map(rule => rule.type), ['pull_request', 'non_fast_forward', 'deletion', 'required_status_checks', 'required_linear_history']);
  // GitHub echoes extra fields (do_not_enforce_on_create, ruleset ids): matching compares only what the step changes.
  const echoed = { rules: strict.rules.map(rule => rule.type === 'required_status_checks' ? { ...rule, parameters: { ...rule.parameters, do_not_enforce_on_create: false } } : { ...rule, ruleset_id: 1 }) };
  assert.equal(rulesetMatches(echoed, strict), true);
  assert.equal(rulesetMatches(echoed, rulesetBody(live, 'loose')), false, 'strict and loose differ');
  assert.equal(rulesetMatches(live, strict), false);
  assert.equal(rulesetMatches(null, strict), false);
});

test('human steps: operator PRs check the base tip, never force or bypass; every setting change names its restore; the rerun names the run of the head', () => {
  const tip = 'a'.repeat(40);
  const pr = operatorPr('advance', tip, ['echo x > y'], 'msg');
  assert.ok(pr.some(line => line.includes(`test "$(git rev-parse origin/main)" = "${tip}"`)));
  assert.ok(pr.at(-1)!.startsWith('gh pr merge q34-advance') && !pr.some(line => /--force\b|--admin\b/.test(line.split('#')[0]!)));
  const steps = humanSteps({ mainTip: tip, pullRequest: 12, head: 'b'.repeat(40), runId: 345 });
  assert.equal(steps.rerun!.apply[0]!.startsWith('gh run rerun 345 --repo Sanmoo/java-springboot-event-sourcing'), true);
  assert.ok(steps['human-draft']!.apply[0]!.startsWith('gh pr ready 12 --repo Sanmoo/java-springboot-event-sourcing --undo'));
  assert.ok(steps.strict!.apply.at(-1)!.endsWith('rulesets/strict.json --silent') && steps.strict!.restore[0]!.endsWith('rulesets/loose.json --silent'));
  assert.ok(steps.contexts!.restore[0]!.endsWith('rulesets/loose.json --silent'));
  assert.ok(steps.teardown!.apply.at(-1)!.endsWith('rulesets/before.json --silent'), 'teardown ends with the live ruleset');
  assert.ok(steps.teardown!.apply.some(line => line.startsWith('gh pr close 12')));
  assert.ok(steps.classic!.apply[0]!.includes('already present: stop'), 'classic is applied only over NO classic protection, so DELETE restores it');
  assert.equal(runIdOf('https://github.com/Sanmoo/x/actions/runs/123456/job/789'), 123456);
  assert.equal(runIdOf('https://github.com/Sanmoo/x/runs/1'), null);
});

const work = (extra: Record<string, unknown>) => ({ publication: { state: 'published', pullRequest: { number: 12 } }, execution: null, impediments: [], correction: null, corrections: [],
  budget: { corrections: { consumed: 0 } }, readiness: null, checks: null, ...extra }) as unknown as WorkView;
const facts = { activations: 2, humanObserved: true, quietCyclesDone: true, conversions: 0, refusedConversions: 0 };
test('settled: waiver needs the refused verification; failing/strict need the closed correction, satisfied checks and the expected conversions; any refused conversion holds', () => {
  const verification = { status: 'not-verified', reasons: ['WAIVER_CANNOT_BYPASS_REQUIRED_CHECK:factory-gate'], requiredChecks: ['factory-gate'] };
  const waived = work({ publication: null, execution: { state: 'ended', review: { verification } } });
  assert.deepEqual(settled('waiver', waived, { ...facts, activations: 1 }), { done: true, success: true });
  assert.deepEqual(settled('waiver', work({ publication: null, execution: { state: 'ended', review: { verification: { ...verification, reasons: ['GATE_FAILED:factory-gate'] } } } }), { ...facts, activations: 1 }),
    { done: true, success: false }, 'a gate run and failed is not the waiver proof');
  const ready = { flag: { factory: 'ready', observed: 'ready' }, effects: [{ action: 'mark-ready', state: 'confirmed' }], effect: null };
  const closed = (code: string) => ({ correctionId: code, outcome: 'published', charged: true, reasons: [{ code }] });
  const failing = work({ corrections: [closed('REQUIRED_CHECK_FAILED')], readiness: ready, checks: { latest: { outcome: 'satisfied' } } });
  assert.deepEqual(settled('failing', failing, facts), { done: true, success: true });
  assert.deepEqual(settled('failing', failing, { ...facts, refusedConversions: 1 }), { done: true, success: false });
  assert.deepEqual(settled('failing', work({ corrections: [closed('REQUIRED_CHECK_FAILED')], readiness: ready, checks: { latest: { outcome: 'waiting' } } }), facts), { done: false, success: false });
  const strict = work({ corrections: [closed('REQUIRED_CHECK_FAILED'), closed('STRICT_UPDATE_REQUIRED')], checks: { latest: { outcome: 'satisfied' } },
    readiness: { ...ready, effects: [{ action: 'mark-ready', state: 'confirmed' }, { action: 'convert-to-draft', state: 'confirmed' }], effect: { action: 'mark-ready', state: 'confirmed' } } });
  assert.deepEqual(settled('strict', strict, facts), { done: true, success: true });
  assert.deepEqual(settled('strict', strict, { ...facts, humanObserved: false }), { done: true, success: false });
  const drafted = work({ corrections: [closed('a'), closed('b')], readiness: { flag: { factory: 'ready', observed: 'draft' }, humanDraft: { observedAt: 't', headSha: null } } });
  assert.deepEqual(settled('human-draft', drafted, { ...facts, activations: 0 }), { done: true, success: true });
  assert.deepEqual(settled('human-draft', drafted, { ...facts, activations: 0, conversions: 1 }), { done: true, success: false }, 'a conversion over a human draft fails');
});

/** A complete, passing set of saved results (synthetic; tickets unpinned = 0 here). */
function passing() {
  const [h1, h2, h3, b1] = ['1', '2', '3', 'b'].map(c => c.repeat(40)) as [string, string, string, string];
  const req = (context: string, extra: Record<string, unknown>) => ({ context, ...extra });
  return {
    waiver: { status: 'success', final: { works: [{ ticket: { number: tickets.waiver.number }, publication: null,
      execution: { review: { verification: { status: 'not-verified', reasons: ['WAIVER_CANNOT_BYPASS_REQUIRED_CHECK:factory-gate'], requiredChecks: ['factory-gate'] } } } }] } },
    run: { status: 'success', events: [{ call: 'checks', head: h1, outcome: 'waiting' }] },
    failing: { status: 'success', events: [{ call: 'checks', head: h1, outcome: 'failing' }, { call: 'checks', head: h2, outcome: 'waiting' }, { call: 'checks', head: h2, outcome: 'satisfied' }] },
    strict: { status: 'success', events: [] }, strictObserved: { sha: b1 }, humanDraft: { status: 'success', events: [{ call: 'read-pull-request' }] },
    rerun: { status: 'success', reads: [{ evaluation: { outcome: 'waiting', requirements: [req('factory-gate', { state: 'waiting', results: [{ classification: 'waiting' }] })] } }] },
    contexts: { status: 'success', evaluation: { strict: { required: true }, reasons: [{ category: 'wait', code: 'REQUIRED_CHECK_ABSENT', subject: 'factory-absent' }],
      requirements: [req('factory-optional', { state: 'satisfied', results: [{ conclusion: 'skipped' }] })], modalities: [{ type: 'required_linear_history', reason: 'LINEAR_HISTORY_METHOD_ALLOWED' }] } },
    classic: { status: 'success', evaluation: { outcome: 'blocked', reasons: [], requirements: [req('factory-gate', { sources: ['classic', 'ruleset:26435808:Repository:x'] })],
      modalities: [{ type: 'lock_branch', source: 'classic', merge: 'blocking', reason: 'BRANCH_LOCKED' }, { type: 'required_signatures', source: 'classic', merge: 'blocking', reason: 'SIGNED_COMMITS_REQUIRED' },
        { type: 'required_linear_history', source: 'classic', merge: 'not-blocking', reason: 'LINEAR_HISTORY_METHOD_ALLOWED' }] } },
    homonym: { status: 'success', evaluation: { requirements: [req('factory-gate', { state: 'satisfied', results: [{ kind: 'check-run', origin: 'app:15368', classification: 'satisfied' }],
      otherOrigin: [{ kind: 'status', origin: 'creator:Sanmoo(User)', status: 'failure' }] })] } },
    inspect: { work: { publication: { linkedHeads: [h1, h2, h3] },
      corrections: [{ outcome: 'published', reasons: [{ code: 'REQUIRED_CHECK_FAILED', subject: 'factory-gate', headSha: h1, evidence: ['check_run:factory-gate:failure:https://x'] }] },
        { outcome: 'published', reasons: [{ code: 'STRICT_UPDATE_REQUIRED', subject: 'main', headSha: h2, baseTip: b1 }] }],
      readiness: { humanDraft: { observedAt: 't' }, effects: [{ action: 'mark-ready', state: 'confirmed' }, { action: 'convert-to-draft', state: 'confirmed' }], effect: { action: 'mark-ready', state: 'confirmed' } } },
    compare: { value: { behind_by: 0 } }, changedFiles: ['docs/FACTORY_CHECKS.md'], pull: { pullRequest: { merged: false } }, pushViolations: [],
    sessions: [{ tokenPattern: false }], secretScan: { matches: [] } },
  } as Record<string, Record<string, unknown>>;
}
test('verdict: met on a complete passing set; each obligation fails when its observation is altered; a no-op fails', () => {
  const failingIds = (saved: Record<string, Record<string, unknown>>) => verdictOf(saved).checks.filter(item => !item.met).map(item => item.id);
  assert.deepEqual(failingIds(passing()), []);
  assert.equal(verdictOf(passing()).checks.length, 13);
  assert.equal(verdictOf({}).passed, false, 'nothing ran: not met');
  let saved = passing();
  (saved.inspect!.changedFiles as string[]).push('ci/factory-gate.sh');
  assert.ok(failingIds(saved).includes('no-bypass'), 'a change of the CI script fails the run');
  saved = passing();
  (saved.classic!.evaluation as Record<string, unknown>).outcome = 'satisfied';
  assert.deepEqual(failingIds(saved), ['classic.settings-merge-blocking'], 'a classic lock read as green is a failure');
  saved = passing();
  (saved.classic!.evaluation as Record<string, unknown>).modalities = [];
  assert.deepEqual(failingIds(saved), ['classic.settings-merge-blocking'], 'unread classic settings are a failure');
  saved = passing();
  ((saved.inspect!.work as Record<string, unknown>).readiness as Record<string, unknown>).effects = [{ action: 'mark-ready', state: 'confirmed' }];
  assert.ok(failingIds(saved).includes('strict.loss-back-to-draft'));
  saved = passing();
  (saved.humanDraft!.events as unknown[]).push({ call: 'set-draft' });
  assert.ok(failingIds(saved).includes('human-draft.respected'));
  saved = passing();
  saved.run!.events = [];
  assert.ok(failingIds(saved).includes('failing.pending-then-result'), 'a failure never seen pending first is not the pending proof');
  saved = passing();
  saved.inspect!.secretScan = { matches: ['control.sqlite'] };
  assert.ok(failingIds(saved).includes('no-token'));
});

test('secret scan: names token-bearing files, skips credentials/ and never follows links', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q34-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'credentials')); await mkdir(join(dir, 'run'));
  await writeFile(join(dir, 'credentials', 'app.pem'), '-----BEGIN RSA PRIVATE KEY-----\n');
  await writeFile(join(dir, 'run', 'log.json'), `{"t":"ghs_${'a'.repeat(36)}"}`);
  await writeFile(join(dir, 'clean.json'), '{"ok":true}');
  assert.deepEqual(await secretScan(dir), { files: 2, skipped: [], matches: ['run/log.json'] });
});

test('every operator merge happens under the RELAXED ruleset (no required check), and the required check is put only after it (q34 v1 setup deadlock)', () => {
  const steps = humanSteps({ mainTip: 'a'.repeat(40), pullRequest: 12 });
  for (const name of ['setup', 'strict', 'teardown'] as const) {
    const apply = steps[name]!.apply;
    const merge = apply.findIndex(line => line.startsWith('gh pr merge'));
    assert.ok(merge >= 0, `${name} merges an operator PR`);
    const lastRuleset = apply.slice(0, merge).filter(line => line.includes('/rulesets/')).at(-1);
    assert.ok(lastRuleset?.endsWith('rulesets/relaxed.json --silent'), `${name}: the merge runs under relaxed (got ${lastRuleset})`);
    assert.ok(!apply.some(line => line.startsWith('gh pr checks')), `${name}: no wait on Actions timing`);
  }
  assert.ok(steps.setup!.apply.at(-1)!.endsWith('rulesets/loose.json --silent'), 'setup puts the required check only after the merge');
  assert.ok(steps.strict!.apply.at(-1)!.endsWith('rulesets/strict.json --silent'), 'strict is put only after the advance merge');
  assert.ok(steps.teardown!.apply.at(-1)!.endsWith('rulesets/before.json --silent'));
});

test('lessons of the other recipes: every list page walked, Questions read by id, the label listing exact', async () => {
  const work = (id: string, questions: string[] = []) => ({ work_id: id, questions }) as unknown as WorkView;
  const pages: Record<number, unknown> = { 0: { kind: 'list', works: [work('a')], page: { nextCursor: 1 } }, 1: { kind: 'list', works: [work('b')], page: { nextCursor: null } } };
  const walked = await listAll(async cursor => pages[cursor]);
  assert.deepEqual([walked.works.map(item => item.work_id), walked.pages, walked.complete], [['a', 'b'], 2, true], 'a Work on page 2 is seen');
  assert.equal((await listAll(async () => ({ kind: 'list', works: [], page: { nextCursor: 0 } }))).complete, false, 'a non-advancing cursor is incomplete');
  assert.equal((await listAll(async () => ({ kind: 'refused' }))).complete, false);
  const read: string[] = [];
  const found = await questionsOf([work('a', ['q1']), work('b')], async id => { read.push(id); return { kind: 'question', question: { state: 'open', content: { question: 'Which title?' } } }; });
  assert.deepEqual(read, ['q1']);
  assert.deepEqual(found, [{ workId: 'a', questionId: 'q1', state: 'open', question: 'Which title?', read: 'question' }]);
  assert.deepEqual(await questionsOf([work('a')], async () => { throw new Error('never'); }), []);
  assert.equal(labelExact([53, 52], [52, 53]), true);
  assert.equal(labelExact([52], [52, 53]), false, 'a label not yet indexed is not exact');
  assert.equal(labelExact([52, 53, 9], [52, 53]), false, 'a foreign labelled issue is not exact');
  assert.equal(labelExact(null, [52]), false);
});
