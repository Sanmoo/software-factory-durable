import type { CheckClassification, CheckReason, CheckRequirementView, CheckResultView, ChecksEvaluation } from '../types.js';

// Pure rules of ticket 15 (spec §9.2): which checks GitHub requires for the own pull request's CURRENT head, and why each requirement is
// satisfied, waiting, failed, operational, uncertain or indeterminate. No I/O, clock or randomness. Never readiness (ticket 16) and never a
// repair decision (ticket 22): reasons are classified, nothing is launched.

type Known<T> = { state: 'complete'; value: T } | { state: 'unknown'; code: string; waitSeconds?: number; nextStep: string };
type Check = { context: string; integrationId: number | null };
type Run = { id: number; name: string; headSha: string; status: string; conclusion: string | null; appId: number | null; appSlug: string | null;
  checkSuiteId: number | null; startedAt: string | null; completedAt: string | null; url: string | null };
type Status = { id: number; context: string; state: string; creator: { id: number; login: string; type: string } | null; createdAt: string | null;
  updatedAt: string | null; url: string | null };
type Rule = { type: string; ruleset: { id: number | null; sourceType: string | null; source: string | null }; statusChecks?: { strict: boolean; checks: Check[] } };
/** Structural copy of the CodeRepository `readPullRequest` observation (Control consumes facts; it never imports the adapter). */
export type ChecksObservation = { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; code: string; waitSeconds?: number; nextStep: string } |
  { kind: 'observed'; source: 'github-rest'; observedAt: string; completedAt: string; repository: string; repositoryId: number;
    pullRequest: { pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean; draft: boolean; headRef: string; headSha: string;
      headRepositoryId: number | null; baseRef: string; baseSha: string; mergeCommitSha: string | null; mergeable: boolean | null; mergeableState: string | null;
      author: { id: number; login: string; type: string } };
    baseTip: Known<string>;
    classic: Known<{ kind: 'none'; evidence: string } | { kind: 'required'; strict: boolean; enforcement: string; checks: Check[] }>;
    rules: Known<Rule[]>; checkRuns: Known<Run[]>; statuses: Known<Status[]>;
    comparison: Known<{ status: string; aheadBy: number; behindBy: number }> | null;
    recheck: Known<{ headSha: string; baseRef: string; state: 'open' | 'closed'; merged: boolean }>; limitations: string[] };
/** The Work's linked own PR (ticket 14), the heads the Factory linked, and the local gates the Builder declared as GitHub required checks. */
export type ChecksExpectation = { own: { pullRequestId: number; nodeId: string; number: number; headRef: string; base: string; authorId: number };
  repositoryId: number; linkedHeads: string[]; localRequiredChecks: string[] };

const limitations = ['Separate GitHub reads between observedAt and completedAt: not an atomic snapshot of GitHub, its rules and CI; the explanation is valid only as observed.',
  'Results are correlated to the current head commit; results attached to the test merge commit are not read (merge queue is not supported).',
  'A commit status cannot be attributed to a GitHub App: a required check bound to an integration that also has a homonymous status is indeterminate.',
  'A satisfied GitHub requirement (including skipped/neutral) never proves that a local gate ran; local gates are ticket 13 evidence.',
  'This explanation is neither readiness (ticket 16) nor a repair decision (ticket 22).'];
/** Rule types that never carry check requirements; `pull_request` and `copilot_code_review` belong to the human review stage. */
const humanStage = new Set(['pull_request', 'copilot_code_review']);
const notCheckRelated = new Set(['creation', 'update', 'deletion', 'required_linear_history', 'required_signatures', 'non_fast_forward', 'commit_message_pattern',
  'commit_author_email_pattern', 'committer_email_pattern', 'branch_name_pattern', 'tag_name_pattern', 'file_path_restriction', 'max_file_path_length',
  'file_extension_restriction', 'max_file_size']);
const severity: Record<CheckClassification, number> = { satisfied: 0, waiting: 1, uncertain: 2, operational: 3, failed: 4 };
const waitingRun = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/** Check-run semantics (spec §9.2 table): success/skipped/neutral satisfy; failure is pertinent; action_required/stale are operational. */
export function classifyRun(run: Pick<Run, 'status' | 'conclusion'>): CheckClassification {
  if (run.status !== 'completed') return waitingRun.has(run.status) ? 'waiting' : 'uncertain';
  if (['success', 'skipped', 'neutral'].includes(run.conclusion ?? '')) return 'satisfied';
  if (run.conclusion === 'failure') return 'failed';
  if (run.conclusion === 'action_required' || run.conclusion === 'stale') return 'operational';
  return 'uncertain';
}
/** Commit-status semantics: only `success` satisfies; check-run conclusions are never applied to a status. */
export function classifyStatus(status: Pick<Status, 'state'>): CheckClassification {
  return status.state === 'success' ? 'satisfied' : status.state === 'pending' ? 'waiting' : status.state === 'failure' ? 'failed' : 'uncertain';
}
const sourceOf = (rule: Rule) => `ruleset:${rule.ruleset.id ?? 'unknown'}:${rule.ruleset.sourceType ?? 'unknown'}:${rule.ruleset.source ?? 'unknown'}`;
const runView = (run: Run, superseded: number | null): CheckResultView => ({ kind: 'check-run', id: run.id, name: run.name, sha: run.headSha,
  origin: run.appId === null ? 'app:unknown' : `app:${run.appId}${run.appSlug ? `(${run.appSlug})` : ''}`, status: run.status, conclusion: run.conclusion,
  classification: classifyRun(run), attempt: superseded === null ? null : { suite: run.checkSuiteId, superseded }, url: run.url });
const statusView = (status: Status, sha: string): CheckResultView => ({ kind: 'status', id: status.id, name: status.context, sha,
  origin: status.creator ? `creator:${status.creator.login}(${status.creator.type})` : 'creator:unknown', status: status.state, conclusion: null,
  classification: classifyStatus(status), attempt: null, url: status.url });
const completeness = (value: Known<unknown> | null) => value === null ? 'not-read' : value.state === 'complete' ? 'complete' : `unknown:${value.code}`;

const nextSteps: Record<ChecksEvaluation['outcome'], string> = {
  satisfied: 'GitHub required checks of the current head are satisfied as observed. This is not readiness (ticket 16) and does not prove a local gate.',
  waiting: 'Waiting for CI on the current head: no Slot is used, nothing is repaired or retried; a later polling cycle reads it again.',
  failing: 'A required check of the current head failed: a repair is subject to authorization, consolidation and limits (ticket 22); nothing is launched here.',
  blocked: 'Operational or uncertain cause, or a strict update of the branch: classified for the operator/maintenance (ticket 22); no Builder is launched by guessing.',
  indeterminate: 'Incomplete, unsupported, changed or unowned observation: never green. A later cycle reads again; the operator inspects the named reasons.',
  'not-applicable': 'The pull request is closed or merged: its own transitions apply (ticket 17); checks are not evaluated.',
};

export function evaluateChecks(input: { at: string; expect: ChecksExpectation; observation: ChecksObservation }): ChecksEvaluation {
  const { expect, observation } = input;
  const reasons: CheckReason[] = [];
  const notes: string[] = [];
  const reason = (category: CheckReason['category'], code: string, subject?: string) => reasons.push({ category, code, ...(subject !== undefined ? { subject } : {}) });
  const declared = [...new Set(expect.localRequiredChecks)].slice(0, 32);
  const base = (extra: Partial<ChecksEvaluation>): ChecksEvaluation => {
    const categories = new Set(reasons.map(item => item.category));
    const outcome: ChecksEvaluation['outcome'] = categories.has('closed') ? 'not-applicable' : categories.has('indeterminate') || categories.has('ownership') ? 'indeterminate'
      : categories.has('repair') ? 'failing' : categories.has('operational') || categories.has('uncertain') || categories.has('strict') ? 'blocked'
      : categories.has('wait') ? 'waiting' : 'satisfied';
    return { at: input.at, observedAt: null, completedAt: null, outcome, reasons, pullRequest: { number: expect.own.number, url: null, headSha: null, headRef: null, baseRef: null,
      baseTip: null, mergeCommitSha: null, state: null, merged: null, draft: null }, conflict: 'unknown',
      strict: { required: false, sources: [], state: 'unknown', behindBy: null }, requiredSet: 'unknown', requirements: [], optional: [], otherSha: [], modalities: [],
      completeness: { pullRequest: 'not-read', baseTip: 'not-read', classic: 'not-read', rules: 'not-read', checkRuns: 'not-read', statuses: 'not-read', comparison: 'not-read', recheck: 'not-read' },
      localGates: { declared, requiredByGitHub: [], notRequiredByGitHub: declared }, notes, nextStep: nextSteps[outcome], limitations, ...extra };
  };
  if (observation.kind === 'unavailable') {
    reason('indeterminate', 'PULL_REQUEST_UNAVAILABLE', observation.code);
    return base({ observedAt: observation.observedAt, completeness: { ...base({}).completeness, pullRequest: `unknown:${observation.code}` } });
  }
  const pull = observation.pullRequest;
  const shown: ChecksEvaluation['pullRequest'] = { number: pull.number, url: pull.url, headSha: pull.headSha, headRef: pull.headRef, baseRef: pull.baseRef,
    baseTip: observation.baseTip.state === 'complete' ? observation.baseTip.value : null, mergeCommitSha: pull.mergeCommitSha, state: pull.state, merged: pull.merged, draft: pull.draft };
  const reads: ChecksEvaluation['completeness'] = { pullRequest: 'complete', baseTip: completeness(observation.baseTip), classic: completeness(observation.classic),
    rules: completeness(observation.rules), checkRuns: completeness(observation.checkRuns), statuses: completeness(observation.statuses),
    comparison: completeness(observation.comparison), recheck: completeness(observation.recheck) };
  const conflict: ChecksEvaluation['conflict'] = pull.mergeable === true ? 'none' : pull.mergeable === false ? 'conflict' : 'unknown';
  const frame = { observedAt: observation.observedAt, completedAt: observation.completedAt, pullRequest: shown, completeness: reads, conflict,
    limitations: [...limitations, ...observation.limitations.slice(0, 8)] };
  // 1. Ownership and state (spec §9.2 step 1): a closed/merged PR follows its own transitions; another PR is never evaluated as the own one.
  if (pull.merged || pull.state === 'closed') { reason('closed', pull.merged ? 'PULL_REQUEST_MERGED' : 'PULL_REQUEST_CLOSED'); return base(frame); }
  if (pull.pullRequestId !== expect.own.pullRequestId || pull.nodeId !== expect.own.nodeId || pull.number !== expect.own.number) reason('ownership', 'PULL_REQUEST_IDENTITY_MISMATCH');
  if (pull.author.id !== expect.own.authorId) reason('ownership', 'AUTHOR_NOT_FACTORY_APP');
  if (pull.headRef !== expect.own.headRef) reason('ownership', 'OTHER_BRANCH');
  if (pull.headRepositoryId !== expect.repositoryId || observation.repositoryId !== expect.repositoryId) reason('ownership', 'OTHER_REPOSITORY');
  if (pull.baseRef !== expect.own.base) reason('ownership', 'BASE_NOT_WORK_BASE');
  if (!expect.linkedHeads.includes(pull.headSha)) reason('ownership', 'HEAD_NOT_LINKED_BY_FACTORY');
  // 2. Requirements: classic protection plus every active (also inherited) rule, accumulated by context + integration.
  const requirements = new Map<string, { context: string; integrationId: number | null; sources: string[]; strict: boolean }>();
  const strictSources: string[] = [];
  const accumulate = (source: string, strict: boolean, checks: Check[]) => {
    if (strict && !strictSources.includes(source)) strictSources.push(source);
    for (const check of checks) {
      const key = `${check.context}\n${check.integrationId ?? '*'}`;
      const entry = requirements.get(key) ?? { context: check.context, integrationId: check.integrationId, sources: [], strict: false };
      if (!entry.sources.includes(source)) entry.sources.push(source);
      entry.strict ||= strict;
      requirements.set(key, entry);
    }
  };
  if (observation.classic.state === 'unknown') reason('indeterminate', 'REQUIREMENTS_UNKNOWN', 'classic');
  else if (observation.classic.value.kind === 'required') accumulate('classic', observation.classic.value.strict, observation.classic.value.checks);
  const modalities: ChecksEvaluation['modalities'] = [];
  if (observation.rules.state === 'unknown') reason('indeterminate', 'REQUIREMENTS_UNKNOWN', 'rules');
  else for (const rule of observation.rules.value) {
    const source = sourceOf(rule);
    if (rule.type === 'required_status_checks' && rule.statusChecks) {
      modalities.push({ type: rule.type, source, interpretation: 'required-checks' });
      accumulate(source, rule.statusChecks.strict, rule.statusChecks.checks);
    } else if (humanStage.has(rule.type)) modalities.push({ type: rule.type, source, interpretation: 'human-stage' });
    else if (notCheckRelated.has(rule.type)) modalities.push({ type: rule.type, source, interpretation: 'not-check-related' });
    else {
      // Required workflows, merge queue, deployments, code scanning, or any rule this version does not know: never a waiver.
      modalities.push({ type: rule.type, source, interpretation: 'unsupported' });
      reason('indeterminate', 'RULE_NOT_INTERPRETABLE', `${rule.type}@${source}`);
    }
  }
  const unsupported = modalities.some(item => item.interpretation === 'unsupported');
  const requiredSet: ChecksEvaluation['requiredSet'] = observation.classic.state !== 'complete' || observation.rules.state !== 'complete' || unsupported ? 'unknown'
    : requirements.size ? 'non-empty' : 'empty-complete';
  if (requiredSet === 'empty-complete') notes.push('REQUIRED_SET_EMPTY_FROM_COMPLETE_AUTHORIZED_READS');
  // 3. Results of the current head: the latest attempt per check suite (name + App + suite), the latest status per context.
  const head = pull.headSha;
  // Pages may overlap (an item shifted between pages): an identical duplicate counts once; a duplicate that changed is inconsistent.
  const unique = <T extends { id: number }>(items: T[], subject: string): T[] => {
    const seen = new Map<number, string>();
    let inconsistent = false;
    for (const item of items) {
      const text = JSON.stringify(item);
      if (seen.has(item.id) && seen.get(item.id) !== text) inconsistent = true;
      seen.set(item.id, seen.get(item.id) ?? text);
    }
    if (inconsistent) reason('indeterminate', 'RESULTS_INCONSISTENT', subject);
    return [...seen.values()].map(text => JSON.parse(text) as T);
  };
  const runs = observation.checkRuns.state === 'complete' ? unique(observation.checkRuns.value, 'check-runs') : [];
  const statuses = observation.statuses.state === 'complete' ? unique(observation.statuses.value, 'statuses') : [];
  const otherSha = runs.filter(run => run.headSha !== head).sort((a, b) => a.id - b.id).slice(0, 30).map(run => runView(run, null));
  const groups = new Map<string, Run[]>();
  for (const run of runs.filter(item => item.headSha === head)) {
    const key = `${run.name}\n${run.appId ?? '?'}\n${run.checkSuiteId ?? `run-${run.id}`}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const currentRuns = [...groups.values()].map(group => { const sorted = [...group].sort((a, b) => b.id - a.id); return { run: sorted[0]!, superseded: sorted.length - 1 }; })
    .sort((a, b) => a.run.id - b.run.id);
  const latestStatus = new Map<string, Status>();
  for (const status of statuses) {
    const known = latestStatus.get(status.context);
    if (!known || status.id > known.id) latestStatus.set(status.context, status);
  }
  const resultsKnown = observation.checkRuns.state === 'complete' && observation.statuses.state === 'complete' &&
    !reasons.some(item => item.code === 'RESULTS_INCONSISTENT');
  if (observation.checkRuns.state === 'unknown') reason('indeterminate', 'RESULTS_UNKNOWN', 'check-runs');
  if (observation.statuses.state === 'unknown') reason('indeterminate', 'RESULTS_UNKNOWN', 'statuses');
  const views: CheckRequirementView[] = [];
  for (const requirement of requirements.values()) {
    const named = currentRuns.filter(item => item.run.name === requirement.context);
    const matching = requirement.integrationId === null ? named : named.filter(item => item.run.appId === requirement.integrationId);
    const otherOrigin = named.filter(item => !matching.includes(item)).map(item => runView(item.run, item.superseded));
    const results = matching.map(item => runView(item.run, item.superseded));
    const own: string[] = [];
    let state: CheckRequirementView['state'];
    const status = latestStatus.get(requirement.context);
    let unverifiable = false;
    if (status) {
      if (requirement.integrationId === null) results.push(statusView(status, head));
      else if (status.creator?.type === 'User') otherOrigin.push(statusView(status, head));
      else { results.push(statusView(status, head)); unverifiable = true; }
    }
    // Several current suites of the same App for the same name that disagree are indistinguishable attempts: never the most favourable.
    const byApp = new Map<string, Set<CheckClassification>>();
    for (const item of matching) byApp.set(String(item.run.appId), (byApp.get(String(item.run.appId)) ?? new Set()).add(classifyRun(item.run)));
    const indistinct = [...byApp.values()].some(classes => classes.size > 1);
    if (!resultsKnown) { state = 'indeterminate'; own.push('RESULTS_UNKNOWN'); }
    else if (indistinct) { state = 'indeterminate'; own.push('ATTEMPTS_INDISTINGUISHABLE'); reason('indeterminate', 'ATTEMPTS_INDISTINGUISHABLE', requirement.context); }
    else if (unverifiable) { state = 'indeterminate'; own.push('STATUS_ORIGIN_UNVERIFIABLE'); reason('indeterminate', 'STATUS_ORIGIN_UNVERIFIABLE', requirement.context); }
    else if (!results.length) { state = 'waiting'; own.push('REQUIRED_CHECK_ABSENT'); reason('wait', 'REQUIRED_CHECK_ABSENT', requirement.context); }
    else {
      state = results.map(item => item.classification).reduce((worst, item) => severity[item] > severity[worst] ? item : worst, 'satisfied' as CheckClassification);
      const code = { satisfied: null, waiting: 'REQUIRED_CHECK_PENDING', failed: 'REQUIRED_CHECK_FAILED', operational: 'REQUIRED_CHECK_OPERATIONAL', uncertain: 'REQUIRED_CHECK_UNCERTAIN' }[state];
      const category = ({ waiting: 'wait', failed: 'repair', operational: 'operational', uncertain: 'uncertain' } as const)[state as Exclude<CheckClassification, 'satisfied'>];
      if (code) { own.push(code); reason(category, code, requirement.context); }
      else if (results.some(item => item.kind === 'check-run' && item.conclusion !== 'success')) notes.push(`SATISFIED_WITHOUT_RUN:${requirement.context}`);
    }
    // Bounded view (the decision above used every result): at most 10 results and 10 other-origin results per requirement.
    views.push({ ...requirement, sources: requirement.sources.slice(0, 10), sha: head, state, results: results.slice(0, 10), otherOrigin: otherOrigin.slice(0, 10), reasons: own });
  }
  // Optional results: visible, never a repair by themselves.
  const requiredNames = new Set([...requirements.values()].map(item => item.context));
  const optional = [...currentRuns.filter(item => !requiredNames.has(item.run.name)).map(item => runView(item.run, item.superseded)),
    ...[...latestStatus.values()].filter(item => !requiredNames.has(item.context)).sort((a, b) => a.id - b.id).map(item => statusView(item, head))].slice(0, 30);
  for (const item of optional) if (item.classification !== 'satisfied' && item.classification !== 'waiting') notes.push(`OPTIONAL_NOT_SATISFIED:${item.name}`);
  // Strict: confirmed against the CURRENT base tip; loose lag is only visible.
  const comparison = observation.comparison;
  const behindBy = comparison?.state === 'complete' ? comparison.value.behindBy : null;
  let strict: ChecksEvaluation['strict'];
  if (!strictSources.length) {
    strict = { required: false, sources: [], state: 'not-required', behindBy };
    if (behindBy !== null && behindBy > 0) notes.push('LOOSE_BRANCH_BEHIND_BASE');
  } else if (behindBy === null) { strict = { required: true, sources: strictSources, state: 'unknown', behindBy }; reason('indeterminate', 'STRICT_STATE_UNKNOWN'); }
  else {
    strict = { required: true, sources: strictSources, state: behindBy > 0 ? 'behind' : 'up-to-date', behindBy };
    if (behindBy > 0) reason('strict', 'STRICT_BRANCH_BEHIND_BASE');
  }
  // 6. A change between the first read and the re-read invalidates this external evaluation (recomputed on a later cycle).
  const recheck = observation.recheck;
  if (recheck.state === 'unknown') reason('indeterminate', 'RECHECK_UNAVAILABLE');
  else {
    if (recheck.value.headSha !== head) reason('indeterminate', 'HEAD_CHANGED_DURING_COLLECTION');
    if (recheck.value.baseRef !== pull.baseRef) reason('indeterminate', 'BASE_CHANGED_DURING_COLLECTION');
    if (recheck.value.state !== pull.state || recheck.value.merged !== pull.merged) reason('indeterminate', 'STATE_CHANGED_DURING_COLLECTION');
  }
  const requiredByGitHub = declared.filter(name => requiredNames.has(name));
  if (views.length > 100) notes.push(`REQUIREMENTS_VIEW_TRUNCATED:${views.length}`);
  return base({ ...frame, strict, requiredSet, requirements: views.slice(0, 100), optional, otherSha, modalities: modalities.slice(0, 50),
    localGates: { declared, requiredByGitHub, notRequiredByGitHub: declared.filter(name => !requiredNames.has(name)) } });
}
