import type { CheckClassification, CheckReason, CheckRequirementView, CheckResultView, ChecksEvaluation, ModalityView } from '../types.js';

// Pure rules of ticket 15 (spec §9.2): which checks GitHub requires for the own pull request's CURRENT head, and why each requirement is
// satisfied, waiting, failed, operational, uncertain or indeterminate. No I/O, clock or randomness. Never readiness (ticket 16) and never a
// repair decision (ticket 22): reasons are classified, nothing is launched.

type Known<T> = { state: 'complete'; value: T } | { state: 'unknown'; code: string; waitSeconds?: number; nextStep: string };
type Check = { context: string; integrationId: number | null };
type Run = {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
  appSlug: string | null;
  checkSuiteId: number | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
};
type Status = {
  id: number;
  context: string;
  state: string;
  creator: { id: number; login: string; type: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
};
type Parameters =
  | { kind: 'update'; updateAllowsFetchAndMerge: boolean }
  | {
      kind: 'pull_request';
      allowedMergeMethods: string[] | null;
      requiredApprovingReviewCount: number | null;
      requireCodeOwnerReview: boolean | null;
      requireLastPushApproval: boolean | null;
      requiredReviewThreadResolution: boolean | null;
      dismissStaleReviewsOnPush: boolean | null;
    }
  | { kind: 'required_deployments'; environments: string[] };
type Rule = {
  type: string;
  ruleset: { id: number | null; sourceType: string | null; source: string | null };
  statusChecks?: { strict: boolean; checks: Check[] };
  parameters?: Parameters;
  unparsed?: true;
};
/** V-09.f: classic protection settings that can block the human merge; null = no classic protection on the base (read fact). */
type ClassicSettings = { lockBranch: boolean; requiredSignatures: boolean; requiredLinearHistory: boolean; pushRestrictions: boolean };
type Classic = ({ kind: 'none'; evidence: string } | { kind: 'required'; strict: boolean; enforcement: string; checks: Check[] }) & {
  settings: ClassicSettings | null;
};
/** The source every classic-protection modality carries. */
const classicSource = { id: null, sourceType: 'ClassicProtection', source: null };
/** V-09.f (spec §9.2 traditional protection, ticket 39 principle): each enabled classic setting that can block the merge, as a base rule. */
export function classicRules(classic: Classic): Rule[] {
  const settings = classic.settings;
  if (!settings) return [];
  return [
    ...(settings.lockBranch ? ['lock_branch'] : []),
    ...(settings.requiredSignatures ? ['required_signatures'] : []),
    ...(settings.requiredLinearHistory ? ['required_linear_history'] : []),
    ...(settings.pushRestrictions ? ['restrictions'] : []),
  ].map(type => ({ type, ruleset: classicSource }));
}
/** Structural copy of the CodeRepository `readPullRequest` observation (Control consumes facts; it never imports the adapter). */
export type ChecksObservation =
  | { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; code: string; waitSeconds?: number; nextStep: string }
  | {
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      completedAt: string;
      repository: string;
      repositoryId: number;
      pullRequest: {
        pullRequestId: number;
        nodeId: string;
        number: number;
        url: string;
        state: 'open' | 'closed';
        merged: boolean;
        draft: boolean;
        headRef: string;
        headSha: string;
        headRepositoryId: number | null;
        baseRef: string;
        baseSha: string;
        mergeCommitSha: string | null;
        mergeable: boolean | null;
        mergeableState: string | null;
        author: { id: number; login: string; type: string };
      };
      baseTip: Known<string>;
      classic: Known<Classic>;
      rules: Known<Rule[]>;
      checkRuns: Known<Run[]>;
      statuses: Known<Status[]>;
      comparison: Known<{ status: string; aheadBy: number; behindBy: number }> | null;
      recheck: Known<{ headSha: string; baseRef: string; state: 'open' | 'closed'; merged: boolean }>;
      /** Requirements re-read at the end of the collection (spec §9.2 step 6). */
      final: { baseTip: Known<string>; classic: Known<Classic>; rules: Known<Rule[]> };
      limitations: string[];
    };
/** The Work's linked own PR (ticket 14), the heads the Factory linked, and the local gates the Builder declared as GitHub required checks. */
export type ChecksExpectation = {
  own: { pullRequestId: number; nodeId: string; number: number; headRef: string; base: string; authorId: number };
  repositoryId: number;
  linkedHeads: string[];
  localRequiredChecks: string[];
};

const limitations = [
  'Separate GitHub reads between observedAt and completedAt: not an atomic snapshot of GitHub, its rules and CI; the explanation is valid only as observed.',
  'Results are correlated to the current head commit; results attached to the test merge commit are not read (merge queue is not supported).',
  'A commit status cannot be attributed to a GitHub App: a required check bound to an integration that also has a homonymous status is indeterminate.',
  'A satisfied GitHub requirement (including skipped/neutral) never proves that a local gate ran; local gates are ticket 13 evidence.',
  'This explanation is neither readiness (ticket 16) nor a repair decision (ticket 22).',
];
/** Rule types that only govern creating, deleting, renaming or force-pushing a ref: a PR merge into the existing base is unaffected. */
const notMergeRelated = new Set(['creation', 'deletion', 'non_fast_forward', 'branch_name_pattern', 'tag_name_pattern']);
/** Rule types that constrain the commits/files a merge would bring: the Factory does not evaluate them against the PR, so the merge impact is unknown. */
const mergeImpactUnknown = new Set([
  'commit_message_pattern',
  'commit_author_email_pattern',
  'committer_email_pattern',
  'file_path_restriction',
  'max_file_path_length',
  'file_extension_restriction',
  'max_file_size',
]);
const linearMethods = ['squash', 'rebase'];

/**
 * Ticket 39 (spec §9.2/§9.3): how each active base rule affects the HUMAN merge of the own PR, with its source and reason. `blocking`: no
 * human without bypass can merge it (GitHub refuses, as "Restrict updates" did on 2026-11-15); the Factory never uses or recommends a bypass,
 * so the operator adjusts the protection. Required checks stay ticket 15's; review requirements are the human stage; an unknown modality,
 * unreadable parameters or an unevaluated impact are `unknown` (indeterminate), never a waiver. Rules accumulate: the allowed merge methods
 * are the intersection over every `pull_request` rule that restricts them.
 */
export function interpretBaseRules(rules: Rule[]): (ModalityView & Required<Pick<ModalityView, 'merge' | 'reason' | 'notes'>>)[] {
  let allowed: string[] | null = null;
  for (const rule of rules) {
    if (rule.unparsed || rule.parameters?.kind !== 'pull_request' || rule.parameters.allowedMergeMethods === null) continue;
    const methods: string[] = rule.parameters.allowedMergeMethods;
    allowed = allowed === null ? [...new Set(methods)] : allowed.filter(method => methods.includes(method));
  }
  return rules.map(rule => {
    const source = sourceOf(rule);
    const view = (interpretation: ModalityView['interpretation'], merge: NonNullable<ModalityView['merge']>, reason: string, notes: string[] = []) => ({
      type: rule.type,
      source,
      interpretation,
      merge,
      reason,
      notes,
    });
    const parameters = rule.parameters;
    if (rule.unparsed) return view('unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE');
    if (rule.type === 'required_status_checks' && rule.statusChecks) return view('required-checks', 'checks', 'REQUIRED_STATUS_CHECKS');
    if (rule.type === 'pull_request') {
      const notes: string[] = [];
      if (parameters?.kind === 'pull_request') {
        if (parameters.requiredApprovingReviewCount) notes.push(`APPROVALS:${parameters.requiredApprovingReviewCount}`);
        if (parameters.requireCodeOwnerReview) notes.push('CODE_OWNER_REVIEW');
        if (parameters.requireLastPushApproval) notes.push('LAST_PUSH_APPROVAL');
        if (parameters.requiredReviewThreadResolution) notes.push('REVIEW_THREAD_RESOLUTION');
        if (parameters.allowedMergeMethods !== null) {
          if (allowed !== null && !allowed.length) return view('merge-blocking', 'blocking', 'NO_ALLOWED_MERGE_METHOD', notes);
          if (allowed !== null && allowed.length < 3) notes.push(`MERGE_ONLY_BY:${allowed.join(',')}`);
        }
      }
      return view('human-stage', 'human-stage', 'HUMAN_REVIEW_STAGE', notes);
    }
    if (rule.type === 'copilot_code_review') return view('human-stage', 'human-stage', 'HUMAN_REVIEW_STAGE');
    // "Restrict updates": only bypass actors may update the base, a PR merge included. update_allows_fetch_and_merge only lets a fork branch
    // sync from its upstream; it never opens the PR merge.
    if (rule.type === 'update')
      return view(
        'merge-blocking',
        'blocking',
        'UPDATE_RESTRICTED',
        parameters?.kind === 'update' && parameters.updateAllowsFetchAndMerge ? ['UPDATE_ALLOWS_FETCH_AND_MERGE_IS_UPSTREAM_SYNC_ONLY'] : [],
      );
    // The merge goes through a queue whose merge-group checks the Factory does not read (ticket 15 limitation): no supported merge path.
    if (rule.type === 'merge_queue') return view('merge-blocking', 'blocking', 'MERGE_QUEUE_NOT_SUPPORTED');
    if (rule.type === 'required_deployments') {
      if (parameters?.kind !== 'required_deployments') return view('unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE');
      return parameters.environments.length
        ? view(
            'merge-blocking',
            'blocking',
            'DEPLOYMENTS_REQUIRED',
            parameters.environments.slice(0, 10).map(name => `ENVIRONMENT:${name}`),
          )
        : view('not-check-related', 'not-blocking', 'NO_DEPLOYMENT_ENVIRONMENT');
    }
    // V-09.f classic protection: a locked branch is read-only and push restrictions limit who may update it (a merge included), as `update`.
    if (rule.type === 'lock_branch' && rule.ruleset.sourceType === classicSource.sourceType) return view('merge-blocking', 'blocking', 'BRANCH_LOCKED');
    if (rule.type === 'restrictions' && rule.ruleset.sourceType === classicSource.sourceType) return view('merge-blocking', 'blocking', 'PUSH_RESTRICTED');
    // The Factory neither signs nor verifies the signatures of the commits a merge would bring.
    if (rule.type === 'required_signatures') return view('merge-blocking', 'blocking', 'SIGNED_COMMITS_REQUIRED');
    if (rule.type === 'required_linear_history') {
      if (allowed === null) return view('not-check-related', 'unknown', 'MERGE_METHODS_UNKNOWN');
      const linear = allowed.filter(method => linearMethods.includes(method));
      return linear.length
        ? view('not-check-related', 'not-blocking', 'LINEAR_HISTORY_METHOD_ALLOWED', [`MERGE_ONLY_BY:${linear.join(',')}`])
        : view('merge-blocking', 'blocking', 'LINEAR_HISTORY_NO_ALLOWED_METHOD');
    }
    if (notMergeRelated.has(rule.type)) return view('not-check-related', 'not-blocking', 'DOES_NOT_AFFECT_PULL_REQUEST_MERGE');
    if (mergeImpactUnknown.has(rule.type)) return view('not-check-related', 'unknown', 'MERGE_IMPACT_NOT_EVALUATED');
    // Required workflows, code scanning/quality, or any rule this version does not know: never a waiver.
    return view('unsupported', 'unknown', 'RULE_NOT_INTERPRETABLE');
  });
}
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
const sourceOf = (rule: Rule) =>
  rule.ruleset.sourceType === classicSource.sourceType
    ? 'classic'
    : `ruleset:${rule.ruleset.id ?? 'unknown'}:${rule.ruleset.sourceType ?? 'unknown'}:${rule.ruleset.source ?? 'unknown'}`;
const runView = (run: Run, superseded: number | null): CheckResultView => ({
  kind: 'check-run',
  id: run.id,
  name: run.name,
  sha: run.headSha,
  origin: run.appId === null ? 'app:unknown' : `app:${run.appId}${run.appSlug ? `(${run.appSlug})` : ''}`,
  status: run.status,
  conclusion: run.conclusion,
  classification: classifyRun(run),
  attempt: superseded === null ? null : { suite: run.checkSuiteId, superseded },
  url: run.url,
});
const statusView = (status: Status, sha: string): CheckResultView => ({
  kind: 'status',
  id: status.id,
  name: status.context,
  sha,
  origin: status.creator ? `creator:${status.creator.login}(${status.creator.type})` : 'creator:unknown',
  status: status.state,
  conclusion: null,
  classification: classifyStatus(status),
  attempt: null,
  url: status.url,
});
const completeness = (value: Known<unknown> | null) => (value === null ? 'not-read' : value.state === 'complete' ? 'complete' : `unknown:${value.code}`);

const nextSteps: Record<ChecksEvaluation['outcome'], string> = {
  satisfied: 'GitHub required checks of the current head are satisfied as observed. This is not readiness (ticket 16) and does not prove a local gate.',
  waiting: 'Waiting for CI on the current head: no Slot is used, nothing is repaired or retried; a later polling cycle reads it again.',
  failing: 'A required check of the current head failed: a repair is subject to authorization, consolidation and limits (ticket 22); nothing is launched here.',
  blocked:
    'Operational or uncertain cause, or a strict update of the branch: classified for the operator/maintenance (ticket 22); no Builder is launched by guessing.',
  indeterminate: 'Incomplete, unsupported, changed or unowned observation: never green. A later cycle reads again; the operator inspects the named reasons.',
  'not-applicable': 'The pull request is closed or merged: its own transitions apply (ticket 17); checks are not evaluated.',
};

/** Ticket 39: the operator step for base rules that block the human merge (rule, source, reason), or null. Never a bypass. */
export function mergeStep(reasons: Pick<CheckReason, 'category' | 'code' | 'subject'>[]): string | null {
  const blocking = reasons
    .filter(item => item.category === 'merge')
    .slice(0, 8)
    .map(item => `${item.subject ?? 'unknown'} (${item.code})`);
  return blocking.length
    ? `The base protection blocks a human merge of this pull request for anyone without bypass: ${blocking.join(', ')}. Operator: adjust the base ` +
        'protection (that rule of that ruleset or branch protection) so that a human can merge the pull request; the Factory does not use or recommend a bypass, never approves and never merges.'
    : null;
}

export function evaluateChecks(input: { at: string; expect: ChecksExpectation; observation: ChecksObservation }): ChecksEvaluation {
  const { expect, observation } = input;
  const reasons: CheckReason[] = [];
  const notes: string[] = [];
  const reason = (category: CheckReason['category'], code: string, subject?: string) =>
    reasons.push({ category, code, ...(subject !== undefined ? { subject } : {}) });
  const declared = [...new Set(expect.localRequiredChecks)].slice(0, 32);
  const base = (extra: Partial<ChecksEvaluation>): ChecksEvaluation => {
    const categories = new Set(reasons.map(item => item.category));
    const outcome: ChecksEvaluation['outcome'] = categories.has('closed')
      ? 'not-applicable'
      : categories.has('indeterminate') || categories.has('ownership')
        ? 'indeterminate'
        : categories.has('repair')
          ? 'failing'
          : categories.has('operational') || categories.has('uncertain') || categories.has('strict') || categories.has('merge')
            ? 'blocked'
            : categories.has('wait')
              ? 'waiting'
              : 'satisfied';
    return {
      at: input.at,
      observedAt: null,
      completedAt: null,
      outcome,
      reasons,
      pullRequest: {
        number: expect.own.number,
        url: null,
        headSha: null,
        headRef: null,
        baseRef: null,
        baseTip: null,
        mergeCommitSha: null,
        state: null,
        merged: null,
        draft: null,
      },
      conflict: 'unknown',
      strict: { required: false, sources: [], state: 'unknown', behindBy: null },
      requiredSet: 'unknown',
      requirements: [],
      optional: [],
      otherSha: [],
      modalities: [],
      completeness: {
        pullRequest: 'not-read',
        baseTip: 'not-read',
        classic: 'not-read',
        rules: 'not-read',
        checkRuns: 'not-read',
        statuses: 'not-read',
        comparison: 'not-read',
        recheck: 'not-read',
      },
      localGates: { declared, requiredByGitHub: [], notRequiredByGitHub: declared },
      notes,
      nextStep: mergeStep(reasons) ?? nextSteps[outcome],
      limitations,
      ...extra,
    };
  };
  if (observation.kind === 'unavailable') {
    reason('indeterminate', 'PULL_REQUEST_UNAVAILABLE', observation.code);
    return base({ observedAt: observation.observedAt, completeness: { ...base({}).completeness, pullRequest: `unknown:${observation.code}` } });
  }
  const pull = observation.pullRequest;
  const shown: ChecksEvaluation['pullRequest'] = {
    number: pull.number,
    url: pull.url,
    headSha: pull.headSha,
    headRef: pull.headRef,
    baseRef: pull.baseRef,
    baseTip: observation.baseTip.state === 'complete' ? observation.baseTip.value : null,
    mergeCommitSha: pull.mergeCommitSha,
    state: pull.state,
    merged: pull.merged,
    draft: pull.draft,
  };
  const reads: ChecksEvaluation['completeness'] = {
    pullRequest: 'complete',
    baseTip: completeness(observation.baseTip),
    classic: completeness(observation.classic),
    rules: completeness(observation.rules),
    checkRuns: completeness(observation.checkRuns),
    statuses: completeness(observation.statuses),
    comparison: completeness(observation.comparison),
    recheck: completeness(observation.recheck),
  };
  const conflict: ChecksEvaluation['conflict'] = pull.mergeable === true ? 'none' : pull.mergeable === false ? 'conflict' : 'unknown';
  const frame = {
    observedAt: observation.observedAt,
    completedAt: observation.completedAt,
    pullRequest: shown,
    completeness: reads,
    conflict,
    limitations: [...limitations, ...observation.limitations.slice(0, 8)],
  };
  // 1. Ownership and state (spec §9.2 step 1): a closed/merged PR follows its own transitions; another PR is never evaluated as the own one.
  if (pull.merged || pull.state === 'closed') {
    reason('closed', pull.merged ? 'PULL_REQUEST_MERGED' : 'PULL_REQUEST_CLOSED');
    return base(frame);
  }
  if (pull.pullRequestId !== expect.own.pullRequestId || pull.nodeId !== expect.own.nodeId || pull.number !== expect.own.number)
    reason('ownership', 'PULL_REQUEST_IDENTITY_MISMATCH');
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
  // V-09.f: classic settings join the active rules (the allowed merge methods still come from the rulesets that state them).
  const classicSettings = observation.classic.state === 'complete' ? classicRules(observation.classic.value) : [];
  if (observation.rules.state === 'unknown') reason('indeterminate', 'REQUIREMENTS_UNKNOWN', 'rules');
  const baseRules = [...(observation.rules.state === 'complete' ? observation.rules.value : []), ...classicSettings];
  const interpreted = interpretBaseRules(baseRules);
  baseRules.forEach((rule, index) => {
    const item = interpreted[index]!;
    modalities.push(item);
    const subject = `${rule.type}@${item.source}`;
    if (item.interpretation === 'required-checks' && rule.statusChecks) accumulate(item.source, rule.statusChecks.strict, rule.statusChecks.checks);
    // Only this rule did not match its expected shape (it may carry requirements), or its kind is unknown: never a waiver.
    else if (item.interpretation === 'unsupported') reason('indeterminate', 'RULE_NOT_INTERPRETABLE', subject);
    else if (item.merge === 'blocking') reason('merge', item.reason, subject);
    else if (item.merge === 'unknown') reason('indeterminate', item.reason, subject);
  });
  const unsupported = modalities.some(item => item.interpretation === 'unsupported');
  const requiredSet: ChecksEvaluation['requiredSet'] =
    observation.classic.state !== 'complete' || observation.rules.state !== 'complete' || unsupported
      ? 'unknown'
      : requirements.size
        ? 'non-empty'
        : 'empty-complete';
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
  const otherSha = runs
    .filter(run => run.headSha !== head)
    .sort((a, b) => a.id - b.id)
    .slice(0, 30)
    .map(run => runView(run, null));
  // An item that failed its schema is unknown alone: its name (when readable) makes that requirement indeterminate; a nameless one could be
  // any requirement's result.
  const unparsedNames = new Set([
    ...runs.filter(run => run.status === 'unparsed').map(run => run.name),
    ...statuses.filter(item => item.state === 'unparsed').map(item => item.context),
  ]);
  if (unparsedNames.has('')) reason('indeterminate', 'RESULT_UNPARSED_UNNAMED');
  const groups = new Map<string, Run[]>();
  for (const run of runs.filter(item => item.headSha === head && item.status !== 'unparsed')) {
    const key = `${run.name}\n${run.appId ?? '?'}\n${run.checkSuiteId ?? `run-${run.id}`}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const currentRuns = [...groups.values()]
    .map(group => {
      const sorted = [...group].sort((a, b) => b.id - a.id);
      return { run: sorted[0]!, superseded: sorted.length - 1 };
    })
    .sort((a, b) => a.run.id - b.run.id);
  const parsedStatuses = statuses.filter(item => item.state !== 'unparsed');
  const latestStatus = new Map<string, Status>();
  for (const status of parsedStatuses) {
    const known = latestStatus.get(status.context);
    if (!known || status.id > known.id) latestStatus.set(status.context, status);
  }
  const resultsKnown =
    observation.checkRuns.state === 'complete' && observation.statuses.state === 'complete' && !reasons.some(item => item.code === 'RESULTS_INCONSISTENT');
  if (observation.checkRuns.state === 'unknown') reason('indeterminate', 'RESULTS_UNKNOWN', 'check-runs');
  if (observation.statuses.state === 'unknown') reason('indeterminate', 'RESULTS_UNKNOWN', 'statuses');
  // The App slug of an integration, as its own check runs report it: a Bot status whose creator is `<slug>[bot]` is tied to that integration.
  const slugs = new Map<number, string>();
  for (const run of runs) if (run.appId !== null && run.appSlug) slugs.set(run.appId, run.appSlug.toLowerCase());
  const views: CheckRequirementView[] = [];
  for (const requirement of requirements.values()) {
    const named = currentRuns.filter(item => item.run.name === requirement.context);
    let matching = requirement.integrationId === null ? named : named.filter(item => item.run.appId === requirement.integrationId);
    const otherOrigin = named.filter(item => !matching.includes(item)).map(item => runView(item.run, item.superseded));
    const own: string[] = [];
    // Several current suites of the same App and name: the newest suite is the current attempt when creation times are known and distinct
    // (a failed rerun in a new suite is never covered by an older green); otherwise disagreeing suites are indistinguishable.
    let indistinct = false;
    const supersededSuites = new Map<number, number>();
    for (const app of new Set(matching.map(item => item.run.appId))) {
      const suites = matching.filter(item => item.run.appId === app);
      if (suites.length < 2) continue;
      // UTC ISO-8601 instants of the same shape order lexicographically (pure: no clock or Date parsing).
      const times = suites.map(item => item.run.startedAt ?? '');
      if (times.every(time => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(time)) && new Set(times).size === times.length) {
        const newest = suites[times.indexOf([...times].sort().at(-1)!)]!;
        supersededSuites.set(newest.run.id, suites.length - 1);
        matching = matching.filter(item => item.run.appId !== app || item === newest);
      } else if (new Set(suites.map(item => classifyRun(item.run))).size > 1) indistinct = true;
    }
    const results = matching.map(item => runView(item.run, item.superseded + (supersededSuites.get(item.run.id) ?? 0)));
    let state: CheckRequirementView['state'];
    let unverifiable = false;
    const ofContext = parsedStatuses.filter(item => item.context === requirement.context).sort((a, b) => b.id - a.id);
    if (requirement.integrationId === null) {
      if (ofContext[0]) results.push(statusView(ofContext[0], head));
    } else if (ofContext.length) {
      // Bound to an integration: only a status whose creator is tied to it counts; any source accepts the latest status (decision 1).
      const slug = slugs.get(requirement.integrationId);
      const tied = (item: Status) => slug !== undefined && item.creator?.type === 'Bot' && item.creator.login.toLowerCase() === `${slug}[bot]`;
      const counted = ofContext.find(tied);
      if (counted) {
        results.push(statusView(counted, head));
        const newer = ofContext.filter(item => item.id > counted.id);
        if (newer.length) {
          own.push('NEWER_STATUS_FROM_OTHER_ORIGIN');
          notes.push(`NEWER_STATUS_FROM_OTHER_ORIGIN:${requirement.context}`);
        }
        otherOrigin.push(...newer.map(item => statusView(item, head)));
      } else {
        const latest = ofContext[0]!;
        // A Bot creator not tied to it (slug unknown) may still be that integration: unverifiable. A User, or another known App's bot, is other origin.
        if (latest.creator?.type === 'Bot' && slug === undefined) {
          results.push(statusView(latest, head));
          unverifiable = true;
        } else otherOrigin.push(statusView(latest, head));
      }
    }
    if (!resultsKnown) {
      state = 'indeterminate';
      own.push('RESULTS_UNKNOWN');
    } else if (unparsedNames.has(requirement.context)) {
      state = 'indeterminate';
      own.push('RESULT_UNPARSED');
      reason('indeterminate', 'RESULT_UNPARSED', requirement.context);
    } else if (indistinct) {
      state = 'indeterminate';
      own.push('ATTEMPTS_INDISTINGUISHABLE');
      reason('indeterminate', 'ATTEMPTS_INDISTINGUISHABLE', requirement.context);
    } else if (unverifiable) {
      state = 'indeterminate';
      own.push('STATUS_ORIGIN_UNVERIFIABLE');
      reason('indeterminate', 'STATUS_ORIGIN_UNVERIFIABLE', requirement.context);
    } else if (!results.length) {
      state = 'waiting';
      own.push('REQUIRED_CHECK_ABSENT');
      reason('wait', 'REQUIRED_CHECK_ABSENT', requirement.context);
    } else {
      state = results
        .map(item => item.classification)
        .reduce((worst, item) => (severity[item] > severity[worst] ? item : worst), 'satisfied' as CheckClassification);
      const code = {
        satisfied: null,
        waiting: 'REQUIRED_CHECK_PENDING',
        failed: 'REQUIRED_CHECK_FAILED',
        operational: 'REQUIRED_CHECK_OPERATIONAL',
        uncertain: 'REQUIRED_CHECK_UNCERTAIN',
      }[state];
      const category = ({ waiting: 'wait', failed: 'repair', operational: 'operational', uncertain: 'uncertain' } as const)[
        state as Exclude<CheckClassification, 'satisfied'>
      ];
      if (code) {
        own.push(code);
        reason(category, code, requirement.context);
      } else if (results.some(item => item.kind === 'check-run' && item.conclusion !== 'success')) notes.push(`SATISFIED_WITHOUT_RUN:${requirement.context}`);
    }
    // Bounded view (the decision above used every result): at most 10 results and 10 other-origin results per requirement.
    views.push({
      ...requirement,
      sources: requirement.sources.slice(0, 10),
      sha: head,
      state,
      results: results.slice(0, 10),
      otherOrigin: otherOrigin.slice(0, 10),
      reasons: own,
    });
  }
  // Optional results: visible, never a repair by themselves.
  const requiredNames = new Set([...requirements.values()].map(item => item.context));
  const optional = [
    ...currentRuns.filter(item => !requiredNames.has(item.run.name)).map(item => runView(item.run, item.superseded)),
    ...[...latestStatus.values()]
      .filter(item => !requiredNames.has(item.context))
      .sort((a, b) => a.id - b.id)
      .map(item => statusView(item, head)),
  ].slice(0, 30);
  for (const item of optional) if (item.classification !== 'satisfied' && item.classification !== 'waiting') notes.push(`OPTIONAL_NOT_SATISFIED:${item.name}`);
  for (const name of unparsedNames) if (name && !requiredNames.has(name)) notes.push(`OPTIONAL_RESULT_UNPARSED:${name}`);
  // Strict: confirmed against the CURRENT base tip; loose lag is only visible.
  const comparison = observation.comparison;
  const behindBy = comparison?.state === 'complete' ? comparison.value.behindBy : null;
  let strict: ChecksEvaluation['strict'];
  if (!strictSources.length) {
    strict = { required: false, sources: [], state: 'not-required', behindBy };
    if (behindBy !== null && behindBy > 0) notes.push('LOOSE_BRANCH_BEHIND_BASE');
  } else if (behindBy === null) {
    strict = { required: true, sources: strictSources, state: 'unknown', behindBy };
    reason('indeterminate', 'STRICT_STATE_UNKNOWN');
  } else {
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
  // Requirements and the base tip recorded at the start are re-read at the end: a change invalidates this evaluation (never a trigger).
  const final = observation.final;
  // A read already unknown at the start is reported once (REQUIREMENTS_UNKNOWN); only a start-complete read lost at the end is RECHECK_UNAVAILABLE.
  const lostAtEnd = (
    [
      [observation.classic, final.classic],
      [observation.rules, final.rules],
      [observation.baseTip, final.baseTip],
    ] as [Known<unknown>, Known<unknown>][]
  ).some(([before, after]) => before.state === 'complete' && after.state === 'unknown');
  if (lostAtEnd) reason('indeterminate', 'RECHECK_UNAVAILABLE', 'requirements');
  else {
    const same = (a: Known<unknown>, b: Known<unknown>) =>
      a.state !== 'complete' || JSON.stringify(a.value) === JSON.stringify(b.state === 'complete' ? b.value : null);
    if (!same(observation.classic, final.classic) || !same(observation.rules, final.rules)) reason('indeterminate', 'REQUIREMENTS_CHANGED_DURING_COLLECTION');
    if (observation.baseTip.state === 'complete' && final.baseTip.state === 'complete' && observation.baseTip.value !== final.baseTip.value) {
      // Only strict depends on the base tip; base advancing alone is never a trigger (spec §9.3).
      if (strictSources.length) reason('indeterminate', 'BASE_TIP_CHANGED_DURING_COLLECTION');
      else notes.push('BASE_TIP_ADVANCED_DURING_COLLECTION');
    }
  }
  const requiredByGitHub = declared.filter(name => requiredNames.has(name));
  if (views.length > 100) notes.push(`REQUIREMENTS_VIEW_TRUNCATED:${views.length}`);
  return base({
    ...frame,
    strict,
    requiredSet,
    requirements: views.slice(0, 100),
    optional,
    otherSha,
    modalities: modalities.slice(0, 50),
    localGates: { declared, requiredByGitHub, notRequiredByGitHub: declared.filter(name => !requiredNames.has(name)) },
  });
}
