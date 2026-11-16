import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateChecks, interpretBaseRules } from '../../src/control/rules/checks.js';
import { evaluateReadiness, readinessAction, readinessNextStep, type ReadinessFacts } from '../../src/control/rules/readiness.js';
import type { BranchRule } from '../../src/code-repository/index.js';
import type { ChecksEvaluation, ReadinessEvaluation } from '../../src/control/types.js';
import { basisExecution, head, observedPull, readyPublication } from './readiness-seed.js';

// Ticket 39 rules (R): base rules that block the human merge of the own PR for anyone without bypass are an explained readiness impediment
// (rule, source, operator next step: adjust the protection; never a bypass), distinct from rules that do not affect the merge; an unknown
// modality stays indeterminate. Controlled data only; the real payload shape is exercised by test/entrypoints/github-mergeblock-reads.test.ts.
const workId = '11111111-2222-4333-8444-555555555555';
const at = '2026-11-15T12:00:00.000Z';
const expect = { own: { pullRequestId: 9007, nodeId: 'PR_node7', number: 7, headRef: 'factory/3-abcdef12', base: 'main', authorId: 41898282 }, repositoryId: 3,
  linkedHeads: [head], localRequiredChecks: [] };
const real = { id: 26435808, sourceType: 'Repository', source: 'Sanmoo/java-springboot-event-sourcing' };
const src = 'ruleset:26435808:Repository:Sanmoo/java-springboot-event-sourcing';
const rule = (type: string, parameters?: BranchRule['parameters'], ruleset = real): BranchRule => ({ type, ruleset, ...(parameters ? { parameters } : {}) });
const pullRequest = (allowedMergeMethods: string[] | null, extra: Partial<Extract<NonNullable<BranchRule['parameters']>, { kind: 'pull_request' }>> = {}) => rule('pull_request', {
  kind: 'pull_request', allowedMergeMethods, requiredApprovingReviewCount: 1, requireCodeOwnerReview: false, requireLastPushApproval: false, requiredReviewThreadResolution: false,
  dismissStaleReviewsOnPush: false, ...extra });
/** Ruleset 26435808 of Sanmoo/java-springboot-event-sourcing main as the q16/q17 runs read it (types/ids/source) with the parameters the operator recorded. */
const ruleset26435808 = [pullRequest(['merge', 'squash', 'rebase']), rule('non_fast_forward'), rule('deletion'), rule('update', { kind: 'update', updateAllowsFetchAndMerge: false })];
const checksOf = (rules: BranchRule[], pull: Parameters<typeof observedPull>[0] = {}): ChecksEvaluation => evaluateChecks({ at, expect, observation: observedPull({ ...pull, rules }) });
const codes = (evaluation: ChecksEvaluation) => evaluation.reasons.map(reason => `${reason.category}:${reason.code}${reason.subject ? `:${reason.subject}` : ''}`);
const row = (items: ReturnType<typeof interpretBaseRules>) => items.map(item => [item.type, item.interpretation, item.merge, item.reason]);
function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return { result: 'open', current: true, publication: readyPublication(workId), execution: basisExecution(), previousExecutions: [], impediments: [],
    dependencies: { latest: { evaluationId: 'd', attemptId: 'p', source: 'github-rest', observedAt: at, evaluatedAt: at, principals: [], completeness: 'complete', conclusion: 'satisfied',
      blockers: [], cycles: [], shared: [], reasons: [], limitations: [] }, lastComplete: null }, queue: { pending: false }, correction: null, pendingRecovery: null, ...overrides };
}
const readiness = (checks: ChecksEvaluation) => evaluateReadiness({ at, source: 'recheck', facts: facts(), checks, installation: 'settled', dependencyAttempt: 'p' });
const reasonsOf = (evaluation: ReadinessEvaluation) => evaluation.reasons.map(item => `${item.area}:${item.certainty}:${item.code}${item.subject ? `:${item.subject}` : ''}`);

test('AC1: the real ruleset 26435808 — update (Restrict updates) blocks the merge; pull_request is the human stage; non_fast_forward and deletion do not affect the merge', () => {
  assert.deepEqual(row(interpretBaseRules(ruleset26435808)), [
    ['pull_request', 'human-stage', 'human-stage', 'HUMAN_REVIEW_STAGE'],
    ['non_fast_forward', 'not-check-related', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE'],
    ['deletion', 'not-check-related', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE'],
    ['update', 'merge-blocking', 'blocking', 'UPDATE_RESTRICTED']]);
  assert.ok(interpretBaseRules(ruleset26435808).every(item => item.source === src), 'every rule carries its source');
  const checks = checksOf(ruleset26435808);
  assert.deepEqual([checks.outcome, checks.requiredSet, codes(checks)], ['blocked', 'empty-complete', [`merge:UPDATE_RESTRICTED:update@${src}`]]);
  assert.match(checks.nextStep, new RegExp(`update@${src}`));
  assert.match(checks.nextStep, /adjust the base protection/);
  // Without the update rule (the operator's temporary state during ticket 17) the same ruleset is merge-compatible.
  assert.deepEqual([checksOf(ruleset26435808.slice(0, 3)).outcome, checksOf(ruleset26435808.slice(0, 3)).reasons], ['satisfied', []]);
});

test('AC1: each merge-affecting modality with its parameter conditions, source and reason', () => {
  const other = { id: 9, sourceType: 'Organization', source: 'acme' };
  const table = interpretBaseRules([
    rule('update', { kind: 'update', updateAllowsFetchAndMerge: true }, other),
    rule('merge_queue', undefined, other),
    rule('required_deployments', { kind: 'required_deployments', environments: ['production'] }, other),
    rule('required_deployments', { kind: 'required_deployments', environments: [] }, other),
    rule('required_signatures', undefined, other),
    rule('creation', undefined, other), rule('branch_name_pattern', undefined, other), rule('tag_name_pattern', undefined, other),
    rule('copilot_code_review', undefined, other)]);
  assert.deepEqual(row(table), [
    ['update', 'merge-blocking', 'blocking', 'UPDATE_RESTRICTED'],
    ['merge_queue', 'merge-blocking', 'blocking', 'MERGE_QUEUE_NOT_SUPPORTED'],
    ['required_deployments', 'merge-blocking', 'blocking', 'DEPLOYMENTS_REQUIRED'],
    ['required_deployments', 'not-check-related', 'not-blocking', 'NO_DEPLOYMENT_ENVIRONMENT'],
    ['required_signatures', 'merge-blocking', 'blocking', 'SIGNED_COMMITS_REQUIRED'],
    ['creation', 'not-check-related', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE'],
    ['branch_name_pattern', 'not-check-related', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE'],
    ['tag_name_pattern', 'not-check-related', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE'],
    ['copilot_code_review', 'human-stage', 'human-stage', 'HUMAN_REVIEW_STAGE']], 'update_allows_fetch_and_merge only lets a fork sync from upstream: the PR merge stays blocked');
  assert.ok(table[0]!.notes.includes('UPDATE_ALLOWS_FETCH_AND_MERGE_IS_UPSTREAM_SYNC_ONLY'));
  // Linear history versus the allowed merge methods (intersection over every pull_request rule).
  const linear = rule('required_linear_history');
  assert.deepEqual(row(interpretBaseRules([pullRequest(['merge', 'squash']), linear])).at(-1), ['required_linear_history', 'not-check-related', 'not-blocking', 'LINEAR_HISTORY_METHOD_ALLOWED']);
  assert.ok(interpretBaseRules([pullRequest(['merge', 'squash']), linear]).at(-1)!.notes.includes('MERGE_ONLY_BY:squash'));
  assert.deepEqual(row(interpretBaseRules([pullRequest(['merge']), linear])).at(-1), ['required_linear_history', 'merge-blocking', 'blocking', 'LINEAR_HISTORY_NO_ALLOWED_METHOD']);
  assert.deepEqual(row(interpretBaseRules([pullRequest(['merge', 'squash']), pullRequest(['merge', 'rebase'], {}), linear])).at(-1),
    ['required_linear_history', 'merge-blocking', 'blocking', 'LINEAR_HISTORY_NO_ALLOWED_METHOD'], 'rules accumulate: only merge is allowed by both');
  assert.deepEqual(row(interpretBaseRules([pullRequest(null), linear])).at(-1), ['required_linear_history', 'not-check-related', 'unknown', 'MERGE_METHODS_UNKNOWN'],
    'without allowed methods in the rules, the repository merge settings (not read) decide: unknown, never ready');
  assert.deepEqual(row(interpretBaseRules([pullRequest(['squash']), pullRequest(['rebase'])])), [['pull_request', 'merge-blocking', 'blocking', 'NO_ALLOWED_MERGE_METHOD'],
    ['pull_request', 'merge-blocking', 'blocking', 'NO_ALLOWED_MERGE_METHOD']]);
  // Requirements a human satisfies in review stay the human stage (approvals, code owners, last-push approval, conversation resolution).
  const human = interpretBaseRules([pullRequest(['squash'], { requireCodeOwnerReview: true, requireLastPushApproval: true, requiredReviewThreadResolution: true, requiredApprovingReviewCount: 2 })])[0]!;
  assert.deepEqual([human.merge, human.notes], ['human-stage', ['APPROVALS:2', 'CODE_OWNER_REVIEW', 'LAST_PUSH_APPROVAL', 'REVIEW_THREAD_RESOLUTION', 'MERGE_ONLY_BY:squash']]);
  const evaluation = checksOf([rule('required_signatures'), rule('merge_queue'), rule('deletion')]);
  assert.deepEqual([evaluation.outcome, codes(evaluation)], ['blocked', [`merge:SIGNED_COMMITS_REQUIRED:required_signatures@${src}`, `merge:MERGE_QUEUE_NOT_SUPPORTED:merge_queue@${src}`]]);
});

test('AC1: an unknown modality, a rule whose merge impact is not evaluated, or unreadable parameters stay indeterminate (never ready, never a waiver)', () => {
  const table = interpretBaseRules([rule('brand_new_rule'), rule('workflows'), rule('code_scanning'), rule('commit_message_pattern'), rule('max_file_size'),
    { type: 'pull_request', ruleset: real, unparsed: true }]);
  assert.deepEqual(row(table), [['brand_new_rule', 'unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE'], ['workflows', 'unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE'],
    ['code_scanning', 'unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE'], ['commit_message_pattern', 'not-check-related', 'unknown', 'MERGE_IMPACT_NOT_EVALUATED'],
    ['max_file_size', 'not-check-related', 'unknown', 'MERGE_IMPACT_NOT_EVALUATED'], ['pull_request', 'unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE']]);
  const evaluation = checksOf([rule('commit_message_pattern')]);
  assert.deepEqual([evaluation.outcome, evaluation.requiredSet, codes(evaluation)], ['indeterminate', 'empty-complete', [`indeterminate:MERGE_IMPACT_NOT_EVALUATED:commit_message_pattern@${src}`]]);
  const ready = readiness(evaluation);
  assert.deepEqual([ready.decision, reasonsOf(ready)], ['unknown', [`checks:uncertain:CHECKS_MERGE_IMPACT_NOT_EVALUATED:commit_message_pattern@${src}`]]);
});

test('AC2: a merge-blocking rule is a confirmed readiness impediment with rule and source; the next step says adjust the protection and never suggests a bypass', () => {
  const evaluation = readiness(checksOf(ruleset26435808));
  assert.deepEqual([evaluation.decision, reasonsOf(evaluation)], ['not-ready', [`merge:confirmed:MERGE_BLOCKED_UPDATE_RESTRICTED:update@${src}`]]);
  const view = { internal: evaluation.decision, humanDraft: null, effect: null, latest: evaluation };
  const step = readinessNextStep(view, []);
  assert.match(step, new RegExp(`update@${src} \\(UPDATE_RESTRICTED\\)`));
  assert.match(step, /Operator: adjust the base protection/);
  assert.doesNotMatch(step, /(use|add|grant|request|enable)\w* (a |the )?bypass|bypass (list|actor|permission)/i, 'no bypass is suggested');
  assert.match(step, /never approves and never merges/);
  // Draft (Factory's publication): nothing is converted to ready.
  const action = readinessAction({ evaluation, view: { flag: { factory: 'draft', origin: 'publication', at, observed: 'draft', observedAt: at }, humanDraft: null, authorization: null, effects: [] }, observed: 'draft' });
  assert.equal(action.action, 'none');
});

test('AC3: a merge block appearing after a Factory-placed ready is a confirmed loss (back to draft); over a human ready it only withdraws internal readiness', () => {
  const evaluation = readiness(checksOf(ruleset26435808, { draft: false }));
  const flag = (factory: 'draft' | 'ready') => ({ flag: { factory, origin: factory === 'ready' ? 'readiness-effect' as const : 'publication' as const, at, observed: 'ready' as const, observedAt: at },
    humanDraft: null, authorization: null, effects: [] });
  assert.equal(readinessAction({ evaluation, view: flag('ready'), observed: 'ready' }).action, 'convert-to-draft');
  assert.deepEqual(readinessAction({ evaluation, view: flag('draft'), observed: 'ready' }), { action: 'none', blocked: [], notes: ['READY_FLAG_NOT_PLACED_BY_FACTORY'], authorization: null });
});

test('AC4: the aggregated mergeable_state blocked is neither a conflict nor a failed check: the decision comes from the rules read', () => {
  const pending = checksOf([pullRequest(['merge', 'squash', 'rebase'])], { mergeableState: 'blocked', mergeable: true });
  assert.deepEqual([pending.outcome, pending.conflict, pending.reasons], ['satisfied', 'none', []], 'a pending human approval is what makes GitHub say blocked');
  assert.deepEqual([readiness(pending).decision, readiness(pending).reasons], ['ready', []]);
  const blocked = readiness(checksOf(ruleset26435808, { mergeableState: 'blocked', mergeable: true }));
  assert.deepEqual(reasonsOf(blocked), [`merge:confirmed:MERGE_BLOCKED_UPDATE_RESTRICTED:update@${src}`], 'only the rule, never MERGE_CONFLICT or a checks failure');
});

// V-09.f (spec §9.2 "proteção tradicional", ticket 39 principle): classic branch protection settings that block the human merge are base
// rules like their ruleset counterparts; read facts only (never assumed absent), with the source `classic`.
const complete = <T>(value: T) => ({ state: 'complete' as const, value });
const settings = (extra: Partial<{ lockBranch: boolean; requiredSignatures: boolean; requiredLinearHistory: boolean; pushRestrictions: boolean }>) =>
  ({ lockBranch: false, requiredSignatures: false, requiredLinearHistory: false, pushRestrictions: false, ...extra });
const withClassic = (classicSettings: ReturnType<typeof settings> | null, rules: BranchRule[] = [pullRequest(['merge', 'squash', 'rebase'])]) => {
  const base = observedPull({ rules });
  const classic = complete({ kind: 'none' as const, evidence: 'STATUS_CHECKS_NOT_ENFORCED' as const, settings: classicSettings });
  return evaluateChecks({ at, expect, observation: { ...base, classic, final: { ...base.final, classic } } });
};
test('V-09.f: classic lock_branch, required signatures and push restrictions block the merge (source classic); readiness never ready', () => {
  const locked = withClassic(settings({ lockBranch: true, requiredSignatures: true, pushRestrictions: true }));
  assert.deepEqual(codes(locked).filter(code => code.startsWith('merge:')), ['merge:BRANCH_LOCKED:lock_branch@classic',
    'merge:SIGNED_COMMITS_REQUIRED:required_signatures@classic', 'merge:PUSH_RESTRICTED:restrictions@classic']);
  assert.equal(locked.outcome, 'blocked');
  assert.deepEqual(locked.modalities.filter(item => item.source === 'classic').map(item => [item.type, item.merge, item.reason]),
    [['lock_branch', 'blocking', 'BRANCH_LOCKED'], ['required_signatures', 'blocking', 'SIGNED_COMMITS_REQUIRED'], ['restrictions', 'blocking', 'PUSH_RESTRICTED']]);
  const verdict = readiness(locked);
  assert.equal(verdict.decision, 'not-ready');
  assert.ok(reasonsOf(verdict).includes('merge:confirmed:MERGE_BLOCKED_BRANCH_LOCKED:lock_branch@classic'));
});
test('V-09.f: classic linear history follows the allowed merge methods (rulesets); unknown methods are indeterminate, never green', () => {
  const allowed = withClassic(settings({ requiredLinearHistory: true }), [pullRequest(['merge', 'squash'])]);
  assert.deepEqual(allowed.modalities.filter(item => item.source === 'classic').map(item => [item.type, item.merge, item.reason]),
    [['required_linear_history', 'not-blocking', 'LINEAR_HISTORY_METHOD_ALLOWED']]);
  assert.equal(allowed.outcome, 'satisfied');
  const mergeOnly = withClassic(settings({ requiredLinearHistory: true }), [pullRequest(['merge'])]);
  assert.ok(codes(mergeOnly).includes('merge:LINEAR_HISTORY_NO_ALLOWED_METHOD:required_linear_history@classic'));
  const unknownMethods = withClassic(settings({ requiredLinearHistory: true }), [rule('pull_request')]);
  assert.ok(codes(unknownMethods).includes('indeterminate:MERGE_METHODS_UNKNOWN:required_linear_history@classic'));
  assert.equal(unknownMethods.outcome, 'indeterminate');
});
test('V-09.f: without classic protection (null settings) nothing classic is added; a classic read that failed stays indeterminate', () => {
  const none = withClassic(null);
  assert.deepEqual(none.modalities.filter(item => item.source === 'classic'), []);
  assert.equal(none.outcome, 'satisfied');
  const quiet = withClassic(settings({}));
  assert.deepEqual(quiet.modalities.filter(item => item.source === 'classic'), [], 'classic protection with no merge-blocking setting adds nothing');
});
