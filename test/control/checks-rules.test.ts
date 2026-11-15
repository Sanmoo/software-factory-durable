import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateChecks, type ChecksExpectation, type ChecksObservation } from '../../src/control/rules/checks.js';

// Ticket 15 pure rules (S, controlled data): which checks GitHub requires for the own PR's current head and why each one is satisfied,
// waiting, failed, operational, uncertain or indeterminate. No I/O; not evidence of the real GitHub boundary.
const head = 'd'.repeat(40), tip = 'b'.repeat(40), old = 'c'.repeat(40);
const expect: ChecksExpectation = { own: { pullRequestId: 9007, nodeId: 'PR_node7', number: 7, headRef: 'factory/3-abcdef12', base: 'main', authorId: 41898282 },
  repositoryId: 3, linkedHeads: [head], localRequiredChecks: [] };
type Observed = Extract<ChecksObservation, { kind: 'observed' }>;
type RunFact = Extract<Observed['checkRuns'], { state: 'complete' }>['value'][number];
const run = (id: number, name: string, extra: Partial<RunFact> = {}): RunFact => ({
  id, name, headSha: head, status: 'completed', conclusion: 'success', appId: 15368, appSlug: 'github-actions', checkSuiteId: 500,
  startedAt: `2026-11-14T10:${String(id).padStart(2, '0')}:00Z`, completedAt: null, url: null, ...extra });
const status = (id: number, context: string, state: string, creatorType = 'Bot') => ({ id, context, state, creator: { id: 77, login: 'ci[bot]', type: creatorType },
  createdAt: null, updatedAt: null, url: null });
const complete = <T>(value: T) => ({ state: 'complete' as const, value });
const unknown = (code: string) => ({ state: 'unknown' as const, code, nextStep: 'synthetic' });
function observation(overrides: Partial<Observed> = {}, pull: Partial<Observed['pullRequest']> = {}): Observed {
  const start = observationAt(overrides, pull);
  return { ...start, final: overrides.final ?? { baseTip: start.baseTip, classic: start.classic, rules: start.rules } };
}
function observationAt(overrides: Partial<Observed>, pull: Partial<Observed['pullRequest']>): Omit<Observed, 'final'> {
  return { kind: 'observed', source: 'github-rest', observedAt: '2026-11-14T12:00:00.000Z', completedAt: '2026-11-14T12:00:03.000Z', repository: 'acme/project', repositoryId: 3,
    pullRequest: { pullRequestId: 9007, nodeId: 'PR_node7', number: 7, url: 'https://github.com/acme/project/pull/7', state: 'open', merged: false, draft: true,
      headRef: 'factory/3-abcdef12', headSha: head, headRepositoryId: 3, baseRef: 'main', baseSha: 'a'.repeat(40), mergeCommitSha: 'e'.repeat(40), mergeable: true,
      mergeableState: 'clean', author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, ...pull },
    baseTip: complete(tip), classic: complete({ kind: 'none' as const, evidence: 'BRANCH_NOT_PROTECTED' as const }), rules: complete([]),
    checkRuns: complete([]), statuses: complete([]), comparison: complete({ status: 'ahead', aheadBy: 1, behindBy: 0 }),
    recheck: complete({ headSha: head, baseRef: 'main', state: 'open' as const, merged: false }), limitations: ['synthetic'], ...overrides };
}
const evaluate = (observed: ChecksObservation, extra: Partial<ChecksExpectation> = {}) => evaluateChecks({ at: '2026-11-14T12:00:05.000Z', expect: { ...expect, ...extra }, observation: observed });
const codes = (evaluation: ReturnType<typeof evaluate>) => evaluation.reasons.map(reason => `${reason.category}:${reason.code}${reason.subject ? `:${reason.subject}` : ''}`);
const classic = (strict: boolean, checks: { context: string; integrationId: number | null }[]) => complete({ kind: 'required' as const, strict, enforcement: 'everyone', checks });
const ruleset = (id: number, strict: boolean, checks: { context: string; integrationId: number | null }[], sourceType = 'Organization') =>
  ({ type: 'required_status_checks', ruleset: { id, sourceType, source: 'acme' }, statusChecks: { strict, checks } });

test('AC2: classic protection and every active ruleset accumulate requirements by context+integration with strict/loose per source', () => {
  const evaluation = evaluate(observation({ classic: classic(true, [{ context: 'build', integrationId: 15368 }, { context: 'legacy', integrationId: null }]),
    rules: complete([ruleset(11, false, [{ context: 'build', integrationId: 15368 }, { context: 'lint', integrationId: 15368 }]),
      ruleset(12, false, [{ context: 'build', integrationId: 999 }], 'Repository')]),
    checkRuns: complete([run(1, 'build'), run(2, 'lint'), run(3, 'legacy'), run(4, 'build', { appId: 999, checkSuiteId: 600 })]) }));
  assert.deepEqual(evaluation.requirements.map(item => [item.context, item.integrationId, item.sources, item.strict, item.state]), [
    ['build', 15368, ['classic', 'ruleset:11:Organization:acme'], true, 'satisfied'],
    ['legacy', null, ['classic'], true, 'satisfied'],
    ['lint', 15368, ['ruleset:11:Organization:acme'], false, 'satisfied'],
    ['build', 999, ['ruleset:12:Repository:acme'], false, 'satisfied']]);
  assert.deepEqual(evaluation.strict, { required: true, sources: ['classic'], state: 'up-to-date', behindBy: 0 });
  assert.deepEqual([evaluation.outcome, evaluation.requiredSet], ['satisfied', 'non-empty']);
  assert.ok(evaluation.requirements.every(item => item.sha === head), 'every requirement is correlated to the current head');
});

test('AC2/AC6: an unknown requirement source, a non-interpretable modality or an empty set without a complete authorized read is never an empty set', () => {
  const hidden = evaluate(observation({ rules: unknown('GITHUB_NOT_FOUND_OR_HIDDEN') }));
  assert.deepEqual([hidden.outcome, hidden.requiredSet, codes(hidden)], ['indeterminate', 'unknown', ['indeterminate:REQUIREMENTS_UNKNOWN:rules']]);
  const denied = evaluate(observation({ classic: unknown('GITHUB_ACCESS_DENIED') }));
  assert.deepEqual([denied.outcome, denied.requiredSet, codes(denied)], ['indeterminate', 'unknown', ['indeterminate:REQUIREMENTS_UNKNOWN:classic']]);
  const modalities = evaluate(observation({ rules: complete([
    { type: 'workflows', ruleset: { id: 12, sourceType: 'Repository', source: 'acme/project' } },
    { type: 'merge_queue', ruleset: { id: 13, sourceType: 'Organization', source: 'acme' } },
    { type: 'brand_new_rule', ruleset: { id: 14, sourceType: 'Repository', source: 'acme/project' } },
    { type: 'pull_request', ruleset: { id: 12, sourceType: 'Repository', source: 'acme/project' } }]) }));
  assert.equal(modalities.outcome, 'indeterminate');
  assert.deepEqual(codes(modalities), ['indeterminate:RULE_NOT_INTERPRETABLE:workflows@ruleset:12:Repository:acme/project',
    'indeterminate:RULE_NOT_INTERPRETABLE:merge_queue@ruleset:13:Organization:acme', 'indeterminate:RULE_NOT_INTERPRETABLE:brand_new_rule@ruleset:14:Repository:acme/project']);
  assert.deepEqual(modalities.modalities.find(item => item.type === 'pull_request'), { type: 'pull_request', source: 'ruleset:12:Repository:acme/project', interpretation: 'human-stage' },
    'a required human review stays visible but does not block the Factory preparation');
  const empty = evaluate(observation());
  assert.deepEqual([empty.outcome, empty.requiredSet, empty.reasons], ['satisfied', 'empty-complete', []]);
  assert.ok(empty.notes.includes('REQUIRED_SET_EMPTY_FROM_COMPLETE_AUTHORIZED_READS'));
  const emptyButResultsUnknown = evaluate(observation({ statuses: unknown('GITHUB_QUERY_FAILED') }));
  assert.deepEqual(codes(emptyButResultsUnknown), ['indeterminate:RESULTS_UNKNOWN:statuses'], 'a failed result read is never green');
});

test('AC3: the current attempt of the current head and of the required origin decides; a pending/failed rerun is never covered by an older green', () => {
  const required = { classic: classic(false, [{ context: 'build', integrationId: 15368 }]) };
  const rerun = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build'), run(2, 'build', { status: 'queued', conclusion: null })]) }));
  assert.deepEqual([rerun.outcome, rerun.requirements[0]!.state, rerun.requirements[0]!.results.map(item => [item.id, item.attempt?.superseded])], ['waiting', 'waiting', [[2, 1]]]);
  const failedRerun = evaluate(observation({ ...required, checkRuns: complete([run(2, 'build', { conclusion: 'failure' }), run(1, 'build')]) }));
  assert.deepEqual([failedRerun.outcome, codes(failedRerun)], ['failing', ['repair:REQUIRED_CHECK_FAILED:build']]);
  const otherSha = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build', { headSha: old })]) }));
  assert.deepEqual([otherSha.outcome, codes(otherSha)], ['waiting', ['wait:REQUIRED_CHECK_ABSENT:build']], 'a green result of another commit is never borrowed');
  assert.deepEqual(otherSha.otherSha.map(item => item.id), [1]);
  const otherOrigin = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build', { appId: 999, checkSuiteId: 600 })]) }));
  assert.deepEqual([otherOrigin.outcome, otherOrigin.requirements[0]!.otherOrigin.map(item => item.id)], ['waiting', [1]], 'another App\'s green does not satisfy');
  const newSuite = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build'), run(2, 'build', { checkSuiteId: 501, conclusion: 'failure' })]) }));
  assert.deepEqual([newSuite.outcome, codes(newSuite), newSuite.requirements[0]!.results.map(item => [item.id, item.attempt?.superseded])],
    ['failing', ['repair:REQUIRED_CHECK_FAILED:build'], [[2, 1]]], 'a failed rerun in a newer suite is never covered by the older green');
  const sameTime = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build'), run(2, 'build', { checkSuiteId: 501, conclusion: 'failure', startedAt: run(1, 'build').startedAt })]) }));
  assert.deepEqual(codes(sameTime), ['indeterminate:ATTEMPTS_INDISTINGUISHABLE:build'], 'suites not ordered by creation time are never resolved favourably');
  const unknownTime = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build', { startedAt: null }), run(2, 'build', { checkSuiteId: 501, conclusion: 'failure' })]) }));
  assert.deepEqual(codes(unknownTime), ['indeterminate:ATTEMPTS_INDISTINGUISHABLE:build']);
});

test('AC3: a required context published both as check-run and as commit status needs BOTH; a status of an App-bound requirement has an unverifiable origin', () => {
  const any = { classic: classic(false, [{ context: 'ci', integrationId: null }]) };
  const onlyRun = evaluate(observation({ ...any, checkRuns: complete([run(1, 'ci')]), statuses: complete([status(9, 'ci', 'failure'), status(8, 'ci', 'success')]) }));
  assert.deepEqual([onlyRun.outcome, onlyRun.requirements[0]!.results.map(item => [item.kind, item.classification])],
    ['failing', [['check-run', 'satisfied'], ['status', 'failed']]], 'the latest status (id 9) is current; an older success never covers it');
  const pending = evaluate(observation({ ...any, checkRuns: complete([run(1, 'ci')]), statuses: complete([status(9, 'ci', 'pending')]) }));
  assert.equal(pending.outcome, 'waiting');
  const both = evaluate(observation({ ...any, checkRuns: complete([run(1, 'ci')]), statuses: complete([status(9, 'ci', 'success')]) }));
  assert.equal(both.outcome, 'satisfied');
  const bound = { classic: classic(false, [{ context: 'ci', integrationId: 15368 }]) };
  const unverifiable = evaluate(observation({ ...bound, checkRuns: complete([run(1, 'ci', { appSlug: null })]), statuses: complete([status(9, 'ci', 'success')]) }));
  assert.deepEqual(codes(unverifiable), ['indeterminate:STATUS_ORIGIN_UNVERIFIABLE:ci'], 'a Bot creator that cannot be tied to the integration');
  const otherApp = evaluate(observation({ ...bound, checkRuns: complete([run(1, 'ci')]), statuses: complete([status(9, 'ci', 'failure')]) }));
  assert.deepEqual([otherApp.outcome, otherApp.requirements[0]!.otherOrigin.map(item => item.origin)], ['satisfied', ['creator:ci[bot](Bot)']],
    'the integration slug is known from its check runs: another bot is provably another origin');
  const tiedStatus = (id: number, state: string) => ({ ...status(id, 'ci', state), creator: { id: 41898283, login: 'github-actions[bot]', type: 'Bot' } });
  const tied = evaluate(observation({ ...bound, checkRuns: complete([run(1, 'ci')]), statuses: complete([status(10, 'ci', 'success'), tiedStatus(9, 'failure')]) }));
  assert.deepEqual([tied.outcome, tied.requirements[0]!.results.map(item => [item.kind, item.id, item.classification]), tied.requirements[0]!.reasons],
    ['failing', [['check-run', 1, 'satisfied'], ['status', 9, 'failed']], ['NEWER_STATUS_FROM_OTHER_ORIGIN', 'REQUIRED_CHECK_FAILED']],
    'the integration-bound status counts even when a newer status of another origin hides it, with an explicit reason');
  assert.ok(tied.notes.includes('NEWER_STATUS_FROM_OTHER_ORIGIN:ci'));
  const human = evaluate(observation({ ...bound, checkRuns: complete([run(1, 'ci')]), statuses: complete([status(9, 'ci', 'failure', 'User')]) }));
  assert.deepEqual([human.outcome, human.requirements[0]!.otherOrigin.map(item => item.kind)], ['satisfied', ['status']], 'a user status is never the required App');
});

test('AC4: check-run success/skipped/neutral and status success are distinct semantics; a required absent/pending result is a wait, never green or a defect', () => {
  const required = { classic: classic(false, [{ context: 'a', integrationId: null }, { context: 'b', integrationId: null }, { context: 'c', integrationId: null }]) };
  const satisfied = evaluate(observation({ ...required, checkRuns: complete([run(1, 'a', { conclusion: 'skipped' }), run(2, 'b', { conclusion: 'neutral' })]),
    statuses: complete([status(3, 'c', 'success')]) }), { localRequiredChecks: ['a', 'not-required'] });
  assert.deepEqual([satisfied.outcome, satisfied.requirements.map(item => item.state)], ['satisfied', ['satisfied', 'satisfied', 'satisfied']]);
  assert.deepEqual(satisfied.notes.filter(note => note.startsWith('SATISFIED_WITHOUT_RUN')), ['SATISFIED_WITHOUT_RUN:a', 'SATISFIED_WITHOUT_RUN:b'],
    'GitHub may be satisfied but skipped/neutral never proves a local gate ran');
  assert.deepEqual(satisfied.localGates, { declared: ['a', 'not-required'], requiredByGitHub: ['a'], notRequiredByGitHub: ['not-required'] });
  const statusNeutral = evaluate(observation({ classic: classic(false, [{ context: 'c', integrationId: null }]), statuses: complete([status(3, 'c', 'neutral')]) }));
  assert.equal(statusNeutral.requirements[0]!.state, 'uncertain', 'check-run conclusions are never applied to commit statuses');
  const waiting = evaluate(observation({ ...required, checkRuns: complete([run(1, 'a', { status: 'in_progress', conclusion: null })]), statuses: complete([status(3, 'b', 'pending')]) }));
  assert.deepEqual([waiting.outcome, codes(waiting)], ['waiting', ['wait:REQUIRED_CHECK_PENDING:a', 'wait:REQUIRED_CHECK_PENDING:b', 'wait:REQUIRED_CHECK_ABSENT:c']]);
  assert.match(waiting.nextStep, /no Slot/);
});

test('AC5: pertinent failure, operational cause and uncertain cause get their own reasons; optional and old results stay visible without repair', () => {
  const required = { classic: classic(false, ['f', 'o', 'u', 't'].map(context => ({ context, integrationId: null }))) };
  const evaluation = evaluate(observation({ ...required, checkRuns: complete([run(1, 'f', { conclusion: 'failure' }), run(2, 'o', { conclusion: 'action_required' }),
    run(3, 'u', { conclusion: 'cancelled' }), run(4, 't', { conclusion: 'timed_out' }), run(5, 'optional', { conclusion: 'failure' })]),
    statuses: complete([status(6, 'old-ci', 'error')]) }));
  assert.equal(evaluation.outcome, 'failing');
  assert.deepEqual(codes(evaluation), ['repair:REQUIRED_CHECK_FAILED:f', 'operational:REQUIRED_CHECK_OPERATIONAL:o', 'uncertain:REQUIRED_CHECK_UNCERTAIN:u',
    'uncertain:REQUIRED_CHECK_UNCERTAIN:t'], 'independent reasons; one never erases another');
  assert.deepEqual(evaluation.optional.map(item => [item.name, item.classification]), [['optional', 'failed'], ['old-ci', 'uncertain']]);
  assert.ok(evaluation.notes.includes('OPTIONAL_NOT_SATISFIED:optional'));
  const blocked = evaluate(observation({ classic: classic(false, [{ context: 'o', integrationId: null }]), checkRuns: complete([run(2, 'o', { conclusion: 'stale' })]) }));
  assert.deepEqual([blocked.outcome, codes(blocked)], ['blocked', ['operational:REQUIRED_CHECK_OPERATIONAL:o']]);
  const notLinked = evaluate(observation({ classic: classic(false, [{ context: 'f', integrationId: null }]), checkRuns: complete([run(1, 'f')]) }), { linkedHeads: [old] });
  assert.deepEqual([notLinked.outcome, codes(notLinked)], ['indeterminate', ['ownership:HEAD_NOT_LINKED_BY_FACTORY']],
    'checks of a head the Factory did not link are explained but never taken as its own content');
});

test('AC7: instant, completeness and limitations are explicit; a change during the collection, a closed PR or another PR invalidates the evaluation', () => {
  const evaluation = evaluate(observation({ checkRuns: unknown('INCOMPLETE_GITHUB_QUERY') }));
  assert.deepEqual([evaluation.at, evaluation.observedAt, evaluation.completedAt], ['2026-11-14T12:00:05.000Z', '2026-11-14T12:00:00.000Z', '2026-11-14T12:00:03.000Z']);
  assert.deepEqual(evaluation.completeness, { pullRequest: 'complete', baseTip: 'complete', classic: 'complete', rules: 'complete', checkRuns: 'unknown:INCOMPLETE_GITHUB_QUERY',
    statuses: 'complete', comparison: 'complete', recheck: 'complete' });
  assert.ok(evaluation.limitations.some(item => /not an atomic snapshot/.test(item)));
  const moved = evaluate(observation({ recheck: complete({ headSha: 'f'.repeat(40), baseRef: 'main', state: 'open' as const, merged: false }) }));
  assert.deepEqual(codes(moved), ['indeterminate:HEAD_CHANGED_DURING_COLLECTION']);
  const lost = evaluate(observation({ recheck: unknown('GITHUB_QUERY_FAILED') }));
  assert.deepEqual(codes(lost), ['indeterminate:RECHECK_UNAVAILABLE']);
  const unavailable = evaluate({ kind: 'unavailable', source: 'github-rest', observedAt: 'x', repository: 'acme/project', code: 'GITHUB_RATE_LIMITED', waitSeconds: 30, nextStep: 's' });
  assert.deepEqual([unavailable.outcome, codes(unavailable), unavailable.requirements], ['indeterminate', ['indeterminate:PULL_REQUEST_UNAVAILABLE:GITHUB_RATE_LIMITED'], []]);
  const merged = evaluate(observation({}, { state: 'closed', merged: true }));
  assert.deepEqual([merged.outcome, codes(merged)], ['not-applicable', ['closed:PULL_REQUEST_MERGED']]);
  const other = evaluate(observation({ recheck: complete({ headSha: head, baseRef: 'develop', state: 'open' as const, merged: false }) },
    { nodeId: 'PR_other', author: { id: 5, login: 'human', type: 'User' }, baseRef: 'develop' }));
  assert.deepEqual(codes(other), ['ownership:PULL_REQUEST_IDENTITY_MISMATCH', 'ownership:AUTHOR_NOT_FACTORY_APP', 'ownership:BASE_NOT_WORK_BASE']);
});

test('AC2/AC1: strict is confirmed against the base tip, loose lag is only visible; mergeability is tri-state', () => {
  const strict = { classic: classic(true, [{ context: 'build', integrationId: null }]), checkRuns: complete([run(1, 'build')]) };
  const behind = evaluate(observation({ ...strict, comparison: complete({ status: 'diverged', aheadBy: 1, behindBy: 3 }) }));
  assert.deepEqual([behind.outcome, codes(behind), behind.strict.state], ['blocked', ['strict:STRICT_BRANCH_BEHIND_BASE'], 'behind']);
  const strictUnknown = evaluate(observation({ ...strict, comparison: unknown('GITHUB_TRANSPORT_UNAVAILABLE') }));
  assert.deepEqual(codes(strictUnknown), ['indeterminate:STRICT_STATE_UNKNOWN']);
  const loose = evaluate(observation({ classic: classic(false, [{ context: 'build', integrationId: null }]), checkRuns: complete([run(1, 'build')]),
    comparison: complete({ status: 'diverged', aheadBy: 1, behindBy: 3 }) }));
  assert.deepEqual([loose.outcome, loose.strict.state, loose.notes.includes('LOOSE_BRANCH_BEHIND_BASE')], ['satisfied', 'not-required', true]);
  assert.deepEqual(['none', 'conflict', 'unknown'], [evaluate(observation()).conflict, evaluate(observation({}, { mergeable: false, mergeableState: 'dirty' })).conflict,
    evaluate(observation({}, { mergeable: null, mergeableState: 'unknown' })).conflict]);
});

test('AC1/AC3: reordered pages give the same explanation; a result duplicated across pages is counted once, a duplicate that changed is inconsistent', () => {
  const required = { classic: classic(false, [{ context: 'build', integrationId: 15368 }]) };
  const runs = [run(1, 'build'), run(2, 'build', { status: 'in_progress', conclusion: null }), run(3, 'lint')];
  const ordered = evaluate(observation({ ...required, checkRuns: complete(runs) }));
  const shuffled = evaluate(observation({ ...required, checkRuns: complete([runs[2]!, runs[1]!, runs[0]!, runs[1]!]) }));
  assert.deepEqual(shuffled, ordered);
  assert.deepEqual(ordered.requirements[0]!.results.map(item => [item.id, item.attempt?.superseded]), [[2, 1]]);
  const changed = evaluate(observation({ ...required, checkRuns: complete([...runs, run(2, 'build')]) }));
  assert.deepEqual(codes(changed), ['indeterminate:RESULTS_INCONSISTENT:check-runs'], 'a result that changed between pages is never resolved favourably');
  const statuses = evaluate(observation({ classic: classic(false, [{ context: 'ci', integrationId: null }]), statuses: complete([status(4, 'ci', 'success'), status(4, 'ci', 'failure')]) }));
  assert.deepEqual(codes(statuses), ['indeterminate:RESULTS_INCONSISTENT:statuses']);
});

test('review LOW: an unparsed item makes only its requirement indeterminate; a nameless one or an unparsed rule is never ignored', () => {
  const required = { classic: classic(false, [{ context: 'build', integrationId: null }, { context: 'lint', integrationId: null }]) };
  const unparsed = (id: number, name: string) => run(id, name, { status: 'unparsed', conclusion: null, appId: null, appSlug: null, checkSuiteId: null });
  const one = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build'), unparsed(2, 'lint'), unparsed(3, 'optional')]) }));
  assert.deepEqual([one.requirements.map(item => item.state), codes(one)], [['satisfied', 'indeterminate'], ['indeterminate:RESULT_UNPARSED:lint']]);
  assert.ok(one.notes.includes('OPTIONAL_RESULT_UNPARSED:optional'));
  const nameless = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build'), run(2, 'lint'), unparsed(0, '')]) }));
  assert.deepEqual(codes(nameless), ['indeterminate:RESULT_UNPARSED_UNNAMED']);
  const status = evaluate(observation({ ...required, checkRuns: complete([run(1, 'build'), run(2, 'lint')]),
    statuses: complete([{ id: 0, context: 'lint', state: 'unparsed', creator: null, createdAt: null, updatedAt: null, url: null }]) }));
  assert.deepEqual(codes(status), ['indeterminate:RESULT_UNPARSED:lint']);
  const rule = evaluate(observation({ rules: complete([{ type: 'required_status_checks', ruleset: { id: 11, sourceType: 'Repository', source: 'acme/project' }, unparsed: true as const }]) }));
  assert.deepEqual([rule.requiredSet, codes(rule)], ['unknown', ['indeterminate:RULE_NOT_INTERPRETABLE:required_status_checks@ruleset:11:Repository:acme/project']]);
});

test('spec §9.2 step 6: a requirement or (strict) base-tip change between the start and the end of the collection invalidates the evaluation', () => {
  const required = classic(false, [{ context: 'build', integrationId: null }]);
  const runs = complete([run(1, 'build')]);
  const changed = evaluate(observation({ classic: required, checkRuns: runs, final: { baseTip: complete(tip), classic: classic(false, [{ context: 'other', integrationId: null }]), rules: complete([]) } }));
  assert.deepEqual(codes(changed), ['indeterminate:REQUIREMENTS_CHANGED_DURING_COLLECTION']);
  const lost = evaluate(observation({ classic: required, checkRuns: runs, final: { baseTip: complete(tip), classic: required, rules: unknown('GITHUB_QUERY_FAILED') } }));
  assert.deepEqual(codes(lost), ['indeterminate:RECHECK_UNAVAILABLE:requirements']);
  const advanced = evaluate(observation({ classic: required, checkRuns: runs, final: { baseTip: complete('9'.repeat(40)), classic: required, rules: complete([]) } }));
  assert.deepEqual([advanced.outcome, advanced.notes.includes('BASE_TIP_ADVANCED_DURING_COLLECTION')], ['satisfied', true], 'loose: base advancing is only visible');
  const strict = classic(true, [{ context: 'build', integrationId: null }]);
  const strictAdvanced = evaluate(observation({ classic: strict, checkRuns: runs, final: { baseTip: complete('9'.repeat(40)), classic: strict, rules: complete([]) } }));
  assert.deepEqual(codes(strictAdvanced), ['indeterminate:BASE_TIP_CHANGED_DURING_COLLECTION']);
});
