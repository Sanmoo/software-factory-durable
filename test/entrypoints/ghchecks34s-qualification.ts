import type { ExecutionView, WorkView } from '../../src/control/index.js';
import { readBounded, sessionCommands, snapshotStorage } from './publication14-qualification.js';
import { pushViolations, resolveOperator } from './humanchanges21-qualification.js';
import { ghGuardScript } from './cancel25-qualification.js';
import { actionsAppId, baseMoved, checkName, classicBody, expectedBeforeRules, gateWorkflow, labelExact, listAll, questionsOf, rulesetBody, rulesetId, rulesetMatches,
  runIdOf, secretScan, stuckReason, tokenPattern, type Ruleset, type Variant } from './ghchecks34-qualification.js';

// TEST ONLY. Ticket 34 pre-pilot group R-GH-CHECKS-S (operator decision 2026-11-17: "partial + smaller design"). R-GH-CHECKS v2 proved V-08.f
// and the failed-check half of V-10.b/V-09.c; v3/v4 showed that a chain of two model-driven repairs does not reach the later phases reliably.
// This recipe covers what remains with NO chain of repairs:
//  - V-09.c (rerun pending, skipped/absent contexts, strict/loose, homonymous status) and V-09.f (classic + rulesets) are pure EVALUATIONS of
//    GitHub's facts: GET-only reads of an OPERATOR-prepared probe PR (no Factory Work: the classification of checks does not depend on ownership;
//    the probe's own identity is the expectation, labelled as such);
//  - V-09.e (loss of a Factory-placed ready -> back to draft; a human draft respected) and the strict half of V-10.b truly need the Factory's OWN
//    PR and its readiness conversions: ONE Work whose first head passes the (always green) required check -> mark-ready, then ONE strict repair.
// Import, `--plan` and the pure helpers are inert. Every phase is a REAL effect needing the operator's grant. Every ruleset/protection change and
// every operator PR is a HUMAN step (apply AND restore written by the recipe; run by the supervisor's driver). One-shot phases, no retry.

const root = '/home/sanmoo/software-factory-test/y5';
const revision = 'q34-ghchecks-s-v1';
const observations = `${root}/${revision}`;
export const phases = ['preflight', 'rerun', 'contexts', 'classic', 'homonym', 'run', 'strict', 'human-draft', 'inspect', 'stop-environment'] as const;
export type Phase = typeof phases[number];
type ControlPhase = 'run' | 'strict' | 'human-draft';
type ReadPhase = 'rerun' | 'contexts' | 'classic' | 'homonym';
const controlPhases: readonly Phase[] = ['run', 'strict', 'human-draft'];
const readPhases: readonly Phase[] = ['rerun', 'contexts', 'classic', 'homonym'];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent',
  /** ONE correction (the strict update); a second would be blocked by the budget, never retried. */ correctionLimit: 1 };
const repositoryId = 1256893534;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
export const keySource = `${root}/${githubApp.privateKeyFile}`;
const operatorLogin = 'Sanmoo';
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const deadlines: Record<ControlPhase, number> = { run: 90, strict: 120, 'human-draft': 30 }; // minutes
const humanStepMinutes = 30;
const readPhaseMinutes = 20;
const quietCycles = 3;
const rounds = { max: 4 } as const;
const pollingSeconds = 60;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. Never push, open pull requests or change GitHub state, EXCEPT inside a publication activation the Factory requests ' +
    '(a Factory publication instruction): then follow it and the pr skill exactly (your own branch, the verified commit, the explicit lease, ONE draft pull ' +
    'request) and never merge, approve, mark ready or touch anything else. Never rewrite or drop commits you did not make. Never change workflows, CI scripts, ' +
    'required checks or base protection. Report blockers instead of working around them.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const skillPack = 'factory-skills-v7' as const;

/** The ONE new synthetic issue, created UNLABELLED (the run phase's label step labels it). 0 refuses every phase (TICKET_NOT_PINNED). */
export const ticket = { number: 0, title: 'Factory qualification: readiness of the Factory pull request under a required check and a strict update' } as const;
const docPath = 'docs/FACTORY_CHECKS_S.md';
export const ticketBody = [
  `Add a short documentation page \`${docPath}\`. This exact upper-case file name was decided by the operator.`,
  '', 'Required content:',
  '1. A `# Factory checks` title and one paragraph explaining that this file exists only to exercise how the Software Factory treats required checks.',
  '2. A `## Steps` section with a numbered list of exactly three steps: publish, check, ready.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Do not create or edit other files. Commit the change on your branch.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  `\`cd /workspace/checkout && test -f ${docPath} && grep -q '^## Steps' ${docPath}\``].join('\n');
/** The required check is a real Actions run that always PASSES (after 2 min pending): no hidden requirement, no failure to repair here. */
export const gateScript = ['#!/bin/sh', '# factory-gate: GitHub required check of the Software Factory qualification (R-GH-CHECKS-S). Runs only in GitHub Actions; always green.',
  'set -eu', '[ "${GITHUB_ACTIONS:-}" = true ] || { echo \'factory-gate runs only in GitHub Actions\'; exit 2; }', 'echo \'factory-gate: ok\''].join('\n') + '\n';
const workflowPath = '.github/workflows/factory-gate.yml';
const scriptPath = 'ci/factory-gate.sh';
const baseNotePath = 'docs/FACTORY_CHECKS_S_BASE_NOTE.md';
const probeBranch = 'q34s-probe';
const probePath = 'docs/Q34_PROBE.md';

export type HumanStep = { name: string; phase: Phase; apply: string[]; restore: string[]; expect: string; note: string };
const api = (method: string, path: string, input?: string) => `gh api --method ${method} ${path}${input ? ` --input ${input}` : ''} --silent`;
const putRuleset = (variant: Variant) => api('PUT', `repos/${repository.repository}/rulesets/${rulesetId}`, `${observations}/rulesets/${variant}.json`);
const heredoc = (path: string, content: string) => `mkdir -p "$(dirname ${path})" && cat > ${path} <<'Q34_EOF'\n${content}Q34_EOF`;
const clone = (name: string, expectedMain: string) => [`rm -rf /tmp/q34s-${name} && git clone --quiet https://github.com/${repository.repository}.git /tmp/q34s-${name} && cd /tmp/q34s-${name}`,
  ...(expectedMain ? [`test "$(git rev-parse origin/${repository.base})" = "${expectedMain}"   # the base tip the phase expects; stop if it differs`] : [])];
/** The operator's OWN PR merged into main with the operator's account, ONLY under `relaxed` (no required check: q34 v1 lesson). */
export function operatorPr(name: string, expectedMain: string, edits: string[], message: string): string[] {
  return [...clone(name, expectedMain), `git switch --quiet -c q34s-${name} origin/${repository.base}`, ...edits, `git add -A && git commit --quiet -m '${message}'`,
    `git push --quiet origin q34s-${name}   # the operator's OWN branch (a workflow file needs the gh token's workflow scope); never forced`,
    `gh pr create --repo ${repository.repository} --base ${repository.base} --head q34s-${name} --title 'q34s ${name}' --body 'Operator step of the R-GH-CHECKS-S qualification.'`,
    `gh pr merge q34s-${name} --repo ${repository.repository} --squash --delete-branch   # the OPERATOR merges the operator's own PR (0 approvals while relaxed; never the App)`];
}
const closeFactoryPrs = () => `for n in $(gh pr list --repo ${repository.repository} --state open --json number,headRefName -q '.[]|select(.headRefName|startswith("factory/${ticket.number}-"))|.number'); do ` +
  `gh pr close "$n" --repo ${repository.repository} --comment 'q34 R-GH-CHECKS-S finished (closed by the operator; never merged).'; done`;
export function humanSteps(input: { mainTip: string; pullRequest?: number | undefined; head?: string | undefined; runId?: number | undefined }): Record<string, HumanStep> {
  const r = repository.repository;
  return {
    setup: { name: 'setup', phase: 'preflight', expect: `workflow + script on main, ruleset loose (required ${checkName}@${actionsAppId}), and the operator's open probe PR (${probeBranch})`,
      apply: [putRuleset('relaxed'), ...operatorPr('setup', input.mainTip, [heredoc(workflowPath, gateWorkflow), heredoc(scriptPath, gateScript)], 'ci: add the factory-gate required check (q34 R-GH-CHECKS-S)'),
        putRuleset('loose'), ...clone('probe', ''), `git switch --quiet -c ${probeBranch} origin/${repository.base}`,
        heredoc(probePath, '# Probe\n\nOperator probe PR of the R-GH-CHECKS-S qualification: GitHub check facts are read on it; it is never merged.\n'),
        `git add -A && git commit --quiet -m 'docs: q34s probe (never merged)' && git push --quiet origin ${probeBranch}`,
        `gh pr create --repo ${r} --base ${repository.base} --head ${probeBranch} --title 'q34s probe (never merged)' --body 'Operator probe of the R-GH-CHECKS-S qualification; closed at teardown.'`],
      restore: [putRuleset('before')], note: 'restore puts back the live ruleset read at preflight; the probe PR and the workflow are removed by the teardown' },
    rerun: { name: 'rerun', phase: 'rerun', expect: `a new attempt of ${checkName} pending on the probe head ${input.head ?? '<head>'} while the older one succeeded`,
      apply: [`gh run rerun ${input.runId ?? '<run-id>'} --repo ${r}   # re-runs the workflow run of the probe head`], restore: [], note: 'nothing to restore: the rerun completes by itself (green)' },
    contexts: { name: 'contexts', phase: 'contexts', expect: 'ruleset strict + factory-optional (skipped job) + factory-absent (never reported) + required_linear_history',
      apply: [putRuleset('contexts')], restore: [putRuleset('loose')], note: 'restore returns to loose' },
    classic: { name: 'classic', phase: 'classic', expect: `classic protection on main: required ${checkName}@${actionsAppId} strict, linear history, lock_branch, signatures`,
      apply: [`gh api repos/${r}/branches/${repository.base}/protection --silent 2>/dev/null && { echo 'classic protection already present: stop'; exit 1; } || true`,
        api('PUT', `repos/${r}/branches/${repository.base}/protection`, `${observations}/rulesets/classic.json`), api('POST', `repos/${r}/branches/${repository.base}/protection/required_signatures`)],
      restore: [api('DELETE', `repos/${r}/branches/${repository.base}/protection`)], note: 'preflight proved main had NO classic protection, so DELETE restores it exactly' },
    homonym: { name: 'homonym', phase: 'homonym', expect: `a commit status ${checkName}=failure by the operator (not GitHub Actions) on the probe head ${input.head ?? '<head>'}`,
      apply: [`gh api --method POST repos/${r}/statuses/${input.head ?? '<head>'} -f state=failure -f context=${checkName} -f description='q34s homonym status by the operator' --silent`],
      restore: [], note: 'GitHub cannot delete a commit status: it stays on the probe head (closed at teardown, never merged)' },
    label: { name: 'label', phase: 'run', expect: `#${ticket.number} carries ${repository.label} (and nothing else does)`,
      apply: [`gh issue edit ${ticket.number} --repo ${r} --add-label ${repository.label}`], restore: [`gh issue edit ${ticket.number} --repo ${r} --remove-label ${repository.label}`],
      note: 'restore at teardown only (the label authorizes the Work for every later phase)' },
    strict: { name: 'strict', phase: 'strict', expect: 'main advanced by the operator\'s own PR (merged under relaxed), then the ruleset strict: the Factory PR is behind under strict',
      apply: [putRuleset('relaxed'), ...operatorPr('advance', input.mainTip, [heredoc(baseNotePath, '# Base note\n\nAdded on main by the operator (q34s strict step).\n')], 'docs: q34s strict step'),
        putRuleset('strict')], restore: [putRuleset('loose')], note: 'the advance commit stays on main (removed by the teardown PR)' },
    'human-draft': { name: 'human-draft', phase: 'human-draft', expect: `PR #${input.pullRequest ?? '<n>'} converted back to draft by the operator`,
      apply: [`gh pr ready ${input.pullRequest ?? '<n>'} --repo ${r} --undo   # the OPERATOR's draft over the Factory's ready`], restore: [], note: 'nothing to restore: closed at teardown' },
    teardown: { name: 'teardown', phase: 'inspect', expect: 'q34s files removed from main; Factory PR and probe PR closed; the issue unlabelled and closed; ruleset as before',
      apply: [putRuleset('relaxed'), ...operatorPr('teardown', '', [`git rm --quiet --ignore-unmatch ${workflowPath} ${scriptPath} ${baseNotePath}   # the base note exists only if strict ran`],
        'ci: remove the q34s factory-gate check'), closeFactoryPrs(),
      `gh pr close ${probeBranch} --repo ${r} --delete-branch --comment 'q34s probe finished (never merged).' || true`,
      `gh issue edit ${ticket.number} --repo ${r} --remove-label ${repository.label} || true`, `gh issue close ${ticket.number} --repo ${r} --reason 'not planned' || true`, putRuleset('before')],
      restore: [putRuleset('before')], note: 'the final state is the live ruleset read at preflight, no classic protection, no q34s file on main, nothing open' },
  };
}

/** Per obligation, what it needs and how this recipe proves it (no chain of two repairs). */
export const coverage = {
  'V-09.c': 'GET-only on the operator probe PR: rerun pending vs older green (rerun), skipped job satisfying + never-reported context waiting + strict from the ruleset (contexts), ' +
    'homonymous failure status of another origin visible only (homonym); plus the Factory PR\'s first head pending -> satisfied (run). No Factory Work needed for the reads.',
  'V-09.f': 'GET-only on the probe PR with classic protection added: requirement accumulated from classic + ruleset; lock_branch/signatures merge-blocking (f4cb958). No Work needed.',
  'V-09.e': 'needs the Factory\'s OWN PR: run (mark-ready by the Factory), strict (condition lost -> convert-to-draft, then ready again), human-draft (a human draft respected).',
  'V-10.b': 'strict half only (the failed-check half is proven by q34-ghchecks-v2): ONE correction STRICT_UPDATE_REQUIRED and ONE repair (a rebase of own commits) on the SAME PR.',
};

export function plan() {
  const steps = humanSteps({ mainTip: '<main tip read at the phase>' });
  return { revision, root, observations, phases, repository: { ...repository, repositoryId }, rulesetId, actionsAppId, checkName, coverage,
    ticket: { ...ticket, body: ticketBody, labelAtCreation: false, labelledBy: 'the run phase\'s label step (it waits until the label lists exactly this issue)', pinned: ticket.number > 0 },
    probe: { branch: probeBranch, path: probePath, author: 'the operator', merged: 'never', why: 'GitHub check facts are classified identically on any PR; ownership is not part of V-09.c/V-09.f' },
    requiredCheck: { workflow: { path: workflowPath, content: gateWorkflow }, script: { path: scriptPath, content: gateScript }, why: 'always green after 2 min pending: nothing to repair' },
    humanSteps: Object.fromEntries(Object.entries(steps).map(([key, step]) => [key, { phase: step.phase, expect: step.expect, apply: step.apply, restore: step.restore, note: step.note }])),
    configuration, guestAssets, skillPack, pollingSeconds, deadlinesMinutes: deadlines, humanStepMinutes,
    model: { provider: 'openai', model: 'gpt-6-luna', auth: 'factory-oauth', providerRetries: 0, sdkRetries: 0,
      builderActivations: { run: ['implementation', 'publication'], strict: ['ONE repair (rebase onto the advanced base)', 'publication (leased update)'], 'human-draft': [] } },
    questions: 'none is scripted: any Question of the Work (read by id) holds the phase as UNSCRIPTED_QUESTION with its id, state and text',
    requires: ['the supervisor created the NEW issue unlabelled (title/body above) and pinned its number in a reviewed commit', 'no open issue carries the label',
      `ruleset ${rulesetId} in its starting state (${expectedBeforeRules.join(', ')}) and NO classic protection on main`, 'the operator runs every human step with the operator\'s own account',
      'the operator\'s gh token can push workflow files (workflow scope)', 'operator first-login store under root/credentials (model OAuth)'],
    github: { never: ['merge of the Factory PR or of the probe PR', 'approval', 'bypass', 'change of base protection, rulesets, workflows or required checks by the Factory or by this recipe', 'any retry'] },
    notCovered: ['a neutral conclusion (needs a check-run-writing App; stays S)', 'a change of head/rule/base exactly between the readiness read and its mutation (race; stays S)'],
  };
}

/** Read phases first (each after the previous one consumed), then the Factory chain run -> strict -> human-draft (each on success). */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, pinned = ticket.number > 0): string | null {
  if (!pinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase !== 'preflight' && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  const ended = (item: Phase) => intents.has(`${item}-intent`) && results[item] !== undefined && results[item] !== null;
  const consumed: Partial<Record<Phase, Phase>> = { contexts: 'rerun', classic: 'contexts', homonym: 'classic', run: 'homonym' };
  if (consumed[phase] && !ended(consumed[phase]!)) return `${consumed[phase]!.toUpperCase()}_NOT_CONSUMED`;
  const success: Partial<Record<Phase, Phase>> = { strict: 'run', 'human-draft': 'strict' };
  const previous = success[phase];
  if (previous && results[previous]?.status !== 'success') return `${previous.toUpperCase()}_SUCCESS_REQUIRED`;
  return null;
}

type BuilderKind = 'implementation' | 'publication';
export const builderSequence: Record<ControlPhase, readonly BuilderKind[]> = { run: ['implementation', 'publication'], strict: ['implementation', 'publication'], 'human-draft': [] };
const implementationPhases: Record<ControlPhase, readonly string[]> = { run: ['builder-initial'], strict: ['builder-continuation', 'builder-recovery'], 'human-draft': [] };
export function activationGuard(phase: ControlPhase, maxRounds: number = rounds.max) {
  const sequence = builderSequence[phase];
  let next = 0;
  let implementation: { workId: string; executionId: string } | undefined;
  const seen: Record<string, Set<number>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; workId: string; executionId: string; phaseId: string }, review: { round: number } | undefined, number: number) => {
    if (number !== ticket.number) return false;
    if (context.role === 'builder') {
      const kind = sequence[next];
      if (!kind) return false;
      if (kind === 'implementation') {
        if (!implementationPhases[phase].includes(context.phaseId)) return false;
        implementation = { workId: context.workId, executionId: context.executionId };
      } else if (context.phaseId !== 'builder-publication' || !implementation || context.workId !== implementation.workId || context.executionId === implementation.executionId) return false;
      next++;
      return true;
    }
    const used = seen[context.role];
    if (!used || !implementation || sequence[next - 1] !== 'implementation' || context.executionId !== implementation.executionId || !review || used.has(review.round) ||
      used.size >= maxRounds) return false;
    used.add(review.round);
    return true;
  };
}
export function grantGuard(phase: ControlPhase, max = 2) {
  let publish = 0;
  return (purpose: string | undefined, lifecycle: { publicationState: string | null; publicationActivation: boolean }) => {
    if ((purpose ?? 'builder-start') === 'builder-start') return builderSequence[phase].length > 0;
    if (purpose !== 'builder-publish' || !builderSequence[phase].includes('publication')) return false;
    const own = lifecycle.publicationState === 'requested' || (lifecycle.publicationState === 'awaiting-discovery' && lifecycle.publicationActivation);
    if (!own || publish >= max) return false;
    publish++;
    return true;
  };
}
/** Readiness mutations the phase may send, in order (draft=true converts to draft). */
export const allowedConversions: Record<ControlPhase, readonly boolean[]> = { run: [false], strict: [true, false], 'human-draft': [] };
export function conversionGuard(phase: ControlPhase) {
  let next = 0;
  return (draft: boolean) => { if (allowedConversions[phase][next] !== draft) return false; next++; return true; };
}

const pick = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((at, key) => at && typeof at === 'object' ? (at as Record<string, unknown>)[key as string] : undefined, value);
const list = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
const effectsOf = (work: unknown) => list(pick(work, 'readiness', 'effects')).concat(pick(work, 'readiness', 'effect') ? [pick(work, 'readiness', 'effect') as Record<string, unknown>] : []);
const confirmed = (work: unknown, action: string) => effectsOf(work).filter(item => item.action === action && item.state === 'confirmed').length;

type Facts = { activations: number; humanObserved: boolean; quietCyclesDone: boolean; conversions: number; refusedConversions: number };
export function settled(phase: ControlPhase, work: WorkView | undefined, facts: Facts): { done: boolean; success: boolean } {
  const stuck = stuckReason(work, facts.refusedConversions) !== null;
  const corrections = work?.corrections ?? [];
  const ready = work?.readiness?.flag.factory === 'ready' && work.readiness.flag.observed === 'ready';
  const satisfied = work?.checks?.latest.outcome === 'satisfied';
  if (phase === 'run') {
    if (stuck || corrections.length || work?.correction) return { done: true, success: false };
    const done = work?.publication?.state === 'published' && ready && satisfied && confirmed(work, 'mark-ready') === 1;
    return { done, success: done && facts.activations === 2 };
  }
  if (phase === 'human-draft') {
    const untouched = !work?.correction && corrections.length === 1 && facts.activations === 0 && facts.conversions === 0;
    if (!untouched || stuck) return { done: true, success: false };
    return { done: facts.humanObserved && facts.quietCyclesDone && Boolean(work?.readiness?.humanDraft), success: facts.humanObserved && facts.quietCyclesDone };
  }
  const last = corrections[0];
  if (stuck || corrections.length > 1 || (last && last.outcome !== 'published')) return { done: true, success: false };
  const closed = corrections.length === 1 && !work?.correction && work?.publication?.state === 'published' && last!.reasons.some(item => item.code === 'STRICT_UPDATE_REQUIRED');
  const wanted = confirmed(work, 'mark-ready') === 2 && confirmed(work, 'convert-to-draft') === 1;
  if (closed && ready && wanted && satisfied) return { done: true, success: facts.activations === 2 && facts.humanObserved };
  return { done: false, success: false };
}
/** The probe PR's own identity as the expectation of evaluateChecks (labelled: its checks are classified exactly as for any PR). */
export function probeExpectation(observation: { repositoryId: number; pullRequest: { pullRequestId: number; nodeId: string; number: number; headRef: string; headSha: string; baseRef: string;
  author: { id: number } } }) {
  const pull = observation.pullRequest;
  return { own: { pullRequestId: pull.pullRequestId, nodeId: pull.nodeId, number: pull.number, headRef: pull.headRef, base: pull.baseRef, authorId: pull.author.id },
    repositoryId: observation.repositoryId, linkedHeads: [pull.headSha], localRequiredChecks: [] as string[] };
}

type Saved = Record<string, unknown> | null;
type Check = { id: string; obligation: string; expected: string; observed: string; met: boolean };
const reasonCodes = (evaluation: unknown) => list(pick(evaluation, 'reasons')).map(item => `${item.category}:${item.code}${item.subject ? `:${item.subject}` : ''}`);
const requirement = (evaluation: unknown, context: string) => list(pick(evaluation, 'requirements')).find(item => item.context === context);
/** The verdict from the SAVED results only; every check names its obligation; a no-op fails it. */
export function verdictOf(saved: Partial<Record<'run' | 'strict' | 'humanDraft' | 'rerun' | 'contexts' | 'classic' | 'homonym' | 'inspect' | 'strictObserved', Saved>>):
  { passed: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const check = (id: string, obligation: string, expected: string, observed: unknown, met: boolean) =>
    checks.push({ id, obligation, expected, observed: typeof observed === 'string' ? observed : JSON.stringify(observed) ?? 'undefined', met });
  const work = pick(saved.inspect, 'work');
  const linked = (pick(work, 'publication', 'linkedHeads') as string[] | undefined) ?? [];
  const [h1, h2] = linked;
  const seen = list(pick(saved.run, 'events')).filter(item => item.call === 'checks' && item.head === h1).map(item => item.outcome);
  check('run.pending-then-satisfied', 'V-09.c', 'the Factory PR\'s first head: factory-gate waiting, then satisfied (current head only)', seen,
    seen.includes('waiting') && seen.lastIndexOf('satisfied') > seen.indexOf('waiting'));
  const effects = effectsOf(work).filter(item => item.state === 'confirmed').map(item => item.action);
  check('run.factory-ready', 'V-09.e', 'the Factory placed ready on its own PR (mark-ready confirmed) with satisfied checks', { status: saved.run?.status, effects },
    saved.run?.status === 'success' && effects[0] === 'mark-ready');
  const correction = list(pick(work, 'corrections'))[0];
  const reason = list(pick(correction, 'reasons'))[0];
  const advanced = pick(saved.strictObserved, 'sha');
  check('strict.repair', 'V-10.b', `ONE correction STRICT_UPDATE_REQUIRED@H1 against the advanced base ${String(advanced)}, published; H2 contains it`,
    { reason: reason ? `${reason.code}@${reason.headSha}^${reason.baseTip}` : null, outcome: pick(correction, 'outcome'), behindBy: pick(saved.inspect, 'compare', 'value', 'behind_by'), heads: linked },
    saved.strict?.status === 'success' && pick(reason, 'code') === 'STRICT_UPDATE_REQUIRED' && pick(reason, 'headSha') === h1 && pick(reason, 'baseTip') === advanced &&
      pick(correction, 'outcome') === 'published' && Boolean(h2) && pick(saved.inspect, 'compare', 'value', 'behind_by') === 0);
  check('strict.loss-back-to-draft', 'V-09.e', 'confirmed conversions: mark-ready, convert-to-draft (condition lost under strict), mark-ready (after the repair)', effects,
    JSON.stringify(effects) === JSON.stringify(['mark-ready', 'convert-to-draft', 'mark-ready']));
  const draftEvents = list(pick(saved.humanDraft, 'events'));
  check('human-draft.respected', 'V-09.e', 'human draft recorded; no conversion attempted, no correction, no activation in the quiet window',
    { humanDraft: pick(work, 'readiness', 'humanDraft'), events: draftEvents.filter(item => item.call === 'set-draft' || item.call === 'activate').length },
    saved.humanDraft?.status === 'success' && Boolean(pick(work, 'readiness', 'humanDraft')) && draftEvents.every(item => item.call !== 'set-draft' && item.call !== 'activate'));
  const rerunReads = list(pick(saved.rerun, 'reads'));
  const pendingRead = rerunReads.find(item => pick(requirement(item.evaluation, checkName), 'state') === 'waiting');
  check('rerun.pending', 'V-09.c', `${checkName} waiting during the rerun of the probe head, never covered by the older green`,
    { reads: rerunReads.map(item => pick(requirement(item.evaluation, checkName), 'state')) }, saved.rerun?.status === 'success' && pick(pendingRead, 'evaluation', 'outcome') === 'waiting');
  const contexts = pick(saved.contexts, 'evaluation');
  check('contexts.skipped-absent-strict', 'V-09.c', 'factory-optional satisfied by a skipped run; factory-absent REQUIRED_CHECK_ABSENT; strict required from the ruleset; linear history interpreted',
    { optional: pick(requirement(contexts, 'factory-optional'), 'state'), reasons: reasonCodes(contexts), strict: pick(contexts, 'strict') },
    saved.contexts?.status === 'success' && pick(requirement(contexts, 'factory-optional'), 'state') === 'satisfied' &&
      list(pick(requirement(contexts, 'factory-optional'), 'results')).some(result => result.conclusion === 'skipped') &&
      reasonCodes(contexts).some(code => code.includes('REQUIRED_CHECK_ABSENT') && code.endsWith('factory-absent')) && pick(contexts, 'strict', 'required') === true &&
      list(pick(contexts, 'modalities')).some(item => item.type === 'required_linear_history'));
  const classic = pick(saved.classic, 'evaluation');
  const sources = (pick(requirement(classic, checkName), 'sources') as string[] | undefined) ?? [];
  check('classic.accumulated', 'V-09.f', `requirement ${checkName}@${actionsAppId} accumulated from classic AND the ruleset`, sources,
    saved.classic?.status === 'success' && sources.includes('classic') && sources.some(source => source.startsWith(`ruleset:${rulesetId}`)));
  const classicModalities = list(pick(classic, 'modalities')).filter(item => item.source === 'classic').map(item => `${item.type}:${item.merge}:${item.reason}`);
  check('classic.settings-merge-blocking', 'V-09.f', 'classic lock_branch and signatures read and merge-blocking (source classic); outcome blocked, never satisfied',
    { outcome: pick(classic, 'outcome'), modalities: classicModalities }, saved.classic?.status === 'success' && pick(classic, 'outcome') === 'blocked' &&
      classicModalities.includes('lock_branch:blocking:BRANCH_LOCKED') && classicModalities.includes('required_signatures:blocking:SIGNED_COMMITS_REQUIRED'));
  const homonym = pick(saved.homonym, 'evaluation');
  check('homonym.other-origin', 'V-09.c', `the operator's ${checkName} failure status is another origin than Actions: visible only, the requirement stays satisfied`,
    { state: pick(requirement(homonym, checkName), 'state'), otherOrigin: list(pick(requirement(homonym, checkName), 'otherOrigin')).map(item => `${item.kind}:${item.status}`) },
    saved.homonym?.status === 'success' && list(pick(requirement(homonym, checkName), 'otherOrigin')).some(item => item.kind === 'status' && item.status === 'failure') &&
      pick(requirement(homonym, checkName), 'state') === 'satisfied');
  check('no-bypass', 'V-09.e/V-10.b', 'the Factory PR never merged; every push leased; only the Ticket file changed', { merged: pick(saved.inspect, 'pull', 'pullRequest', 'merged'),
    changedFiles: pick(saved.inspect, 'changedFiles'), pushViolations: pick(saved.inspect, 'pushViolations') },
  pick(saved.inspect, 'pull', 'pullRequest', 'merged') !== true && list(pick(saved.inspect, 'pushViolations')).length === 0 &&
    JSON.stringify(pick(saved.inspect, 'changedFiles')) === JSON.stringify([docPath]));
  const scan = pick(saved.inspect, 'secretScan');
  check('no-token', 'all', 'no token or private key in sessions or in the namespace', { sessions: list(pick(saved.inspect, 'sessions')).filter(item => item.tokenPattern).length, namespace: pick(scan, 'matches') },
    list(pick(saved.inspect, 'sessions')).length > 0 && list(pick(saved.inspect, 'sessions')).every(item => item.tokenPattern === false) && list(pick(scan, 'matches')).length === 0);
  return { passed: checks.every(item => item.met), checks };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const load = (name: string) => fs.readFile(`${observations}/${name}.json`, 'utf8').then(text => JSON.parse(text) as { status?: unknown } & Record<string, unknown>, () => null);
  return { fs, save, exists, load };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function guardedGh() {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const target = `${observations}/gh-guard.mjs`;
  if (!(await fs.access(target).then(() => true, () => false))) {
    let gh: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(':').filter(item => item.startsWith('/'))) {
      if (await fs.access(`${directory}/gh`, constants.X_OK).then(() => true, () => false)) { gh = `${directory}/gh`; break; }
    }
    if (!gh) throw new Error('GH_NOT_FOUND');
    await fs.writeFile(target, ghGuardScript({ node: process.execPath, gh, trace: `${observations}/gh-trace.jsonl` }), { mode: 0o700, flag: 'wx' });
  }
  return target;
}
async function compose(getOnly: boolean) {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp, ...(getOnly ? { executable: await guardedGh() } : {}) });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}
type Composed = Awaited<ReturnType<typeof compose>>;
const workOf = (view: { works: WorkView[] }) => view.works.find(item => item.ticket.number === ticket.number);
async function readRuleset(github: Composed['github']) {
  const read = await github.read(repository, 'checks-read', session => session.get(`/repos/${repository.repository}/rulesets/${rulesetId}`));
  return read.ok ? read.value as Ruleset : null;
}
async function mainTip(github: Composed['github']) {
  const read = await github.read(repository, 'checks-read', session => session.get(`/repos/${repository.repository}/branches/${repository.base}`));
  const sha = read.ok ? pick(read.value, 'commit', 'sha') : undefined;
  return typeof sha === 'string' ? sha : undefined;
}
/** The operator's open probe PR (by its branch), or null. */
async function probePull(github: Composed['github']) {
  const read = await github.read(repository, 'checks-read', session => session.get(`/repos/${repository.repository}/pulls?state=open&head=${repository.repository.split('/')[0]}:${probeBranch}`));
  const first = read.ok && Array.isArray(read.value) ? read.value[0] as { number?: number; head?: { sha?: string } } | undefined : undefined;
  return first?.number ? { number: first.number, head: first.head?.sha ?? null } : null;
}
async function humanStep(save: (name: string, data: unknown) => Promise<void>, step: HumanStep, observed: () => Promise<unknown>) {
  await save(`human-step-${step.name}-requested`, { ...step, at: new Date().toISOString(),
    note: `${step.note}. Operator: run apply now with YOUR OWN account; ALWAYS run restore afterwards (when the phase ends, even held). The phase is waiting.` });
  const until = Date.now() + humanStepMinutes * 60 * 1000;
  while (Date.now() < until) {
    const value = await observed();
    if (value) { await save(`human-step-${step.name}-observed`, { name: step.name, at: new Date().toISOString(), value }); return value; }
    await sleep(15000);
  }
  throw new Error('RECIPE_HUMAN_STEP_TIMEOUT');
}

async function runControl(phase: ControlPhase, save: (name: string, data: unknown) => Promise<void>, operators: { login: string; id: number }[],
  load: (name: string) => Promise<Record<string, unknown> | null>) {
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose(false);
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const pack = builderSkillPacks[skillPack];
  const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }] });
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
    profiles: { builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model }, standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
      spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model } } });
  const builderCredentials = createBuilderCredentials({ github, repositories: [repository] });
  const events: Record<string, unknown>[] = [];
  const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry }); };
  const guard = activationGuard(phase);
  const grants = grantGuard(phase);
  const conversions = conversionGuard(phase);
  const counts = { activations: 0, prepared: 0, conversions: 0, refusedConversions: 0 };
  const all = () => listAll(cursor => control.inspect({ kind: 'list', cursor, limit: 50 }));
  const shown = async () => workOf(await all());
  const numberOf = async (workId: string) => (await all()).works.find(item => item.work_id === workId)?.ticket.number ?? 0;
  const control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty',
    access: { tracker, repositories: [repository], dependencyRepositories: [], operators, factoryApp: () => github.appIdentity(repository),
      repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base),
        async readPullRequest(query) { const result = await codeRepository.readPullRequest(query); log({ call: 'read-pull-request', unless: Boolean(query.unless), kind: result.kind,
          ...(result.kind === 'observed' ? { head: result.pullRequest.headSha, draft: result.pullRequest.draft } : {}) }); return result; },
        async setDraft(pr, draft, effect) {
          if (!conversions(draft)) {
            counts.refusedConversions++; log({ call: 'set-draft-refused', draft });
            return { kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_CONVERSION_GUARD', nextStep: 'The recipe refused this conversion; nothing was sent.', revocation: 'not-issued' };
          }
          counts.conversions++; log({ call: 'set-draft', draft });
          const result = await codeRepository.setDraft(pr, draft, effect); log({ call: 'set-draft-result', kind: result.kind }); return result;
        },
        async findPublication(correlation) {
          const result = await codeRepository.findPublication(correlation);
          log({ call: 'find-publication', kind: result.kind, ...(result.kind === 'observed' ? { branches: result.branches } : { code: result.code }) });
          return result;
        } } }, polling: { intervalSeconds: pollingSeconds },
    execution: { configuration, capacity: 1, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 }, reviews: { reviewer, rounds },
      credentials: { async issue(context) {
        const work = await shown();
        const running = Boolean(work?.execution?.request.publication) && work?.execution?.executionId === context.executionId && work.execution.state !== 'ended';
        const allowed = work?.work_id === context.workId && grants(context.purpose, { publicationState: work.publication?.state ?? null, publicationActivation: running });
        log({ call: 'issue', purpose: context.purpose ?? 'builder-start', allowed });
        if (!allowed) throw Object.assign(new Error('RECIPE_GRANT_GUARD'), { outcome: 'known-rejected' });
        return builderCredentials.issue(context);
      }, async revoke(grant) { const result = await builderCredentials.revoke(grant); log({ call: 'revoked', purpose: grant.metadata.purpose, kind: result.kind }); return result; } },
      sandbox: {
        async prepare(input) {
          log({ call: 'prepare', workId: input.workId });
          const work = await shown();
          if (work?.work_id !== input.workId || ++counts.prepared > builderSequence[phase].length) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
          return sandbox.prepare(input);
        },
        async start(input) { const result = await sandbox.start(input); log({ call: 'start', status: result.status }); return result; },
        async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', result }); return result; },
        async observeProposal(input) { return sandbox.observeProposal(input); },
        verifyPreservedSource: input => sandbox.verifyPreservedSource(input),
      },
      workers: { deliver: (worker, directive) => workers.deliver(worker, directive), observe: input => workers.observe(input),
        async activate(invocation, delivery, activationEvents) {
          log({ call: 'activate', context: invocation.context, review: invocation.review ?? null, repairSection: invocation.prompt.includes('Factory repair (correction') });
          if (!guard(invocation.context, invocation.review, await numberOf(invocation.context.workId))) throw new Error('RECIPE_ONE_SHOT_GUARD');
          if (invocation.context.role === 'builder') counts.activations++;
          const handle = await workers.activate(invocation, delivery, activationEvents);
          void handle.completed.then(done => log({ call: 'completed', role: invocation.context.role, phaseId: invocation.context.phaseId, status: done.status }), () => log({ call: 'completion-uncertain' }));
          return handle;
        } } } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + deadlines[phase] * 60 * 1000;
  let outcome = { done: false, success: false };
  let human: unknown = null;
  let quietFrom: number | null = null;
  let lastChecks = '';
  let questions: Awaited<ReturnType<typeof questionsOf>> = [];
  let holdCode: string | null = null;
  let lastWork: WorkView | undefined;
  try {
    while (Date.now() < deadline) {
      await sleep(15000);
      if (!human && phase === 'run') {
        human = await humanStep(save, humanSteps({ mainTip: '' }).label!, async () => {
          const listing = await tracker.listCandidates(repository);
          const listed = listing.kind === 'observed' ? listing.candidates.map(item => item.number) : null;
          return labelExact(listed, [ticket.number]) ? { listed } : null;
        });
      }
      if (!human && phase === 'strict') {
        const before = await mainTip(github);
        if (!before) throw new Error('BASE_TIP_UNKNOWN');
        const ruleset = (await load('preflight-result'))?.ruleset as Ruleset;
        human = await humanStep(save, humanSteps({ mainTip: before }).strict!, async () => {
          const moved = baseMoved(before, await mainTip(github));
          return moved.kind === 'observed' && rulesetMatches(await readRuleset(github), rulesetBody(ruleset, 'strict')) ? { sha: moved.sha, before } : null;
        });
        await save('strict-observed', human);
      }
      if (!human && phase === 'human-draft') {
        const pr = (await shown())?.publication?.pullRequest?.number;
        if (!pr) throw new Error('PULL_REQUEST_UNKNOWN');
        human = await humanStep(save, humanSteps({ mainTip: '', pullRequest: pr })['human-draft']!, async () => {
          const read = await codeRepository.readPullRequest({ repo: repository, number: pr });
          return read.kind === 'observed' && read.pullRequest.draft === true ? { draft: true, head: read.pullRequest.headSha } : null;
        });
        quietFrom = Date.now();
      }
      const listed = await all();
      questions = await questionsOf(listed.works, questionId => control.inspect({ kind: 'question', question_id: questionId }));
      if (questions.length) { log({ call: 'unscripted-question', questions }); holdCode = 'UNSCRIPTED_QUESTION'; outcome = { done: true, success: false }; break; }
      const work = workOf(listed);
      lastWork = work;
      const checks = work?.checks?.latest;
      const key = checks ? `${checks.pullRequest.headSha}:${checks.outcome}` : '';
      if (checks && key !== lastChecks) { lastChecks = key; log({ call: 'checks', head: checks.pullRequest.headSha, outcome: checks.outcome, reasons: reasonCodes(checks) }); }
      outcome = settled(phase, work, { activations: counts.activations, humanObserved: human !== null, conversions: counts.conversions, refusedConversions: counts.refusedConversions,
        quietCyclesDone: quietFrom !== null && Date.now() - quietFrom >= quietCycles * pollingSeconds * 1000 });
      if (outcome.done) break;
    }
  } finally {
    const final = await all();
    stop.abort();
    const result = await running;
    if (!outcome.success && !holdCode) holdCode = stuckReason(lastWork, counts.refusedConversions) ?? (Date.now() >= deadline ? 'DEADLINE_REACHED' : 'EXPECTATION_NOT_MET');
    await save(`${phase}-result`, { status: outcome.success ? 'success' : 'held', ...(holdCode ? { holdReason: holdCode } : {}), ...(questions.length ? { questions } : {}),
      outcome: result, final, human, counts, events, deadlineReached: Date.now() >= deadline });
  }
  if (!outcome.success) throw new Error('PHASE_NOT_AS_EXPECTED');
}

/** GET-only read phase on the operator's probe PR: the human step, then real readPullRequest + Control's public evaluateChecks. */
async function runRead(phase: ReadPhase, save: (name: string, data: unknown) => Promise<void>, load: (name: string) => Promise<Record<string, unknown> | null>) {
  const { github, codeRepository } = await compose(true);
  const { evaluateChecks } = await import('../../src/control/index.js');
  const probe = await probePull(github);
  if (!probe) throw new Error('PROBE_PULL_REQUEST_UNKNOWN');
  const evaluate = async () => {
    const observation = await codeRepository.readPullRequest({ repo: repository, number: probe.number });
    if (observation.kind !== 'observed') return { observation, evaluation: null };
    return { observation, evaluation: evaluateChecks({ at: new Date().toISOString(), observation, expect: probeExpectation(observation) }) };
  };
  const ruleset = (await load('preflight-result'))?.ruleset as Ruleset;
  const until = Date.now() + readPhaseMinutes * 60 * 1000;
  const label = { probe: probe.number, note: 'evaluated with the probe PR\'s own identity as the expectation (ownership is not part of V-09.c/V-09.f)' };
  if (phase === 'rerun') {
    let first = await evaluate();
    // The probe's first run may still be pending (2 min): wait for its green before asking for the rerun.
    while (Date.now() < until && pick(first.evaluation, 'outcome') !== 'satisfied') { await sleep(15000); first = await evaluate(); }
    const current = list(pick(requirement(first.evaluation, checkName), 'results')).find(item => item.kind === 'check-run' && item.classification === 'satisfied');
    const runId = runIdOf(current?.url as string | undefined);
    const reason = pick(first.evaluation, 'outcome') !== 'satisfied' ? 'NO_GREEN_RUN_ON_PROBE' : !runId ? 'RUN_ID_UNKNOWN' : null;
    if (reason || !runId) { await save('rerun-result', { status: 'held', holdReason: reason, ...label, first }); throw new Error(reason ?? 'RUN_ID_UNKNOWN'); }
    const reads: Record<string, unknown>[] = [];
    await humanStep(save, humanSteps({ mainTip: '', head: probe.head ?? undefined, runId }).rerun!, async () => {
      const read = await evaluate();
      reads.push({ at: new Date().toISOString(), evaluation: read.evaluation });
      return pick(requirement(read.evaluation, checkName), 'state') === 'waiting' ? { waiting: true } : null;
    });
    let green = false;
    while (Date.now() < until && !green) { await sleep(15000); const read = await evaluate(); reads.push({ at: new Date().toISOString(), evaluation: read.evaluation }); green = pick(read.evaluation, 'outcome') === 'satisfied'; }
    await save('rerun-result', { status: green ? 'success' : 'held', ...(green ? {} : { holdReason: 'RERUN_NOT_SETTLED' }), ...label, runId, reads: reads.slice(-40) });
    if (!green) throw new Error('RERUN_NOT_SETTLED');
    return;
  }
  const step = humanSteps({ mainTip: '', head: probe.head ?? undefined })[phase]!;
  const observed = phase === 'contexts' ? async () => rulesetMatches(await readRuleset(github), rulesetBody(ruleset, 'contexts')) ? { ruleset: 'contexts' } : null
    : phase === 'classic' ? async () => { const read = await evaluate(); return pick(read.observation, 'classic', 'value', 'kind') === 'required' ? { classic: true } : null; }
      : async () => { const read = await evaluate(); return list(pick(requirement(read.evaluation, checkName), 'otherOrigin')).some(item => item.kind === 'status') ? { status: true } : null; };
  await humanStep(save, step, observed);
  const read = await evaluate();
  await save(`${phase}-result`, { status: read.evaluation ? 'success' : 'held', ...(read.evaluation ? {} : { holdReason: 'PULL_REQUEST_NOT_READ' }), ...label, evaluation: read.evaluation, observation: read.observation });
  if (!read.evaluation) throw new Error('PULL_REQUEST_NOT_READ');
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (ticket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  const { requireKeySource } = await import('./humanchanges21-qualification.js');
  if (phase === 'preflight') {
    await requireKeySource(path => fs.access(path)); // before ANY effect
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    for (const name of ['credentials', 'run', 'rulesets']) await fs.mkdir(`${observations}/${name}`, { mode: 0o700 });
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`) ?? await load(`${item}-held`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  const usesGitHub = phase !== 'stop-environment';
  try {
    if (usesGitHub) {
      await requireKeySource(path => fs.access(path));
      const { constants } = await import('node:fs');
      // A killed phase leaves its key copy (q34-ghchecks-v3 lesson): the namespace's own copy is removed, recorded.
      if (await fs.lstat(`${observations}/${githubApp.privateKeyFile}`).then(() => true, () => false)) {
        await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true });
        await save(`stale-key-copy-removed-${phase}`, { phase, at: new Date().toISOString() });
      }
      await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
      await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
    }
    if (phase === 'preflight') {
      const { github, tracker } = await compose(false);
      const owner = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}`));
      const ruleset = await readRuleset(github);
      const branch = await github.read(repository, 'checks-read', session => session.get(`/repos/${repository.repository}/branches/${repository.base}`));
      const classicEnabled = branch.ok ? pick(branch.value, 'protection', 'enabled') : 'unknown';
      if (!owner.ok || !ruleset || JSON.stringify(ruleset.rules.map(rule => rule.type).sort()) !== JSON.stringify([...expectedBeforeRules].sort()) || classicEnabled !== false) {
        await save('preflight-held', { status: 'held', holdReason: 'UNEXPECTED_START_STATE', ruleset, classicEnabled }); throw new Error('PRECONDITION_HELD');
      }
      const operator = resolveOperator(owner.value, operatorLogin);
      for (const variant of ['before', 'relaxed', 'loose', 'strict', 'contexts'] as const) {
        await fs.writeFile(`${observations}/rulesets/${variant}.json`, JSON.stringify(rulesetBody(ruleset, variant), null, 1), { mode: 0o600, flag: 'wx' });
      }
      await fs.writeFile(`${observations}/rulesets/classic.json`, JSON.stringify(classicBody, null, 1), { mode: 0o600, flag: 'wx' });
      const before = await mainTip(github);
      if (!before) throw new Error('BASE_TIP_UNKNOWN');
      const content = async (path: string) => { const read = await github.read(repository, 'checks-read', session => session.get(`/repos/${repository.repository}/contents/${path}?ref=${repository.base}`));
        const text = read.ok ? pick(read.value, 'content') : undefined; return typeof text === 'string' ? Buffer.from(text, 'base64').toString('utf8') : null; };
      const setup = await humanStep(save, humanSteps({ mainTip: before }).setup!, async () =>
        rulesetMatches(await readRuleset(github), rulesetBody(ruleset, 'loose')) && await content(workflowPath) === gateWorkflow && await content(scriptPath) === gateScript &&
          await probePull(github) ? { ruleset: 'loose', files: true, probe: await probePull(github) } : null);
      const raw = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${ticket.number}`));
      const value = raw.ok ? raw.value as { state?: string; title?: string; body?: string | null; labels?: { name: string }[] } : null;
      const listing = await tracker.listCandidates(repository);
      const reasons = [...(value?.state !== 'open' || value.title !== ticket.title || (value.body ?? '').replaceAll('\r\n', '\n') !== ticketBody ? ['TICKET_MISMATCH'] : []),
        ...(value?.labels?.some(label => label.name === repository.label) ? ['TICKET_ALREADY_LABELLED'] : []),
        ...(listing.kind !== 'observed' || listing.candidates.length !== 0 ? ['LABEL_LISTING_NOT_EMPTY'] : []), ...(await github.appIdentity(repository) ? [] : ['APP_IDENTITY'])];
      if (reasons.length) { await save('preflight-held', { status: 'held', holdReason: reasons.join(','), issue: value ? { state: value.state, title: value.title } : null }); throw new Error('PRECONDITION_HELD'); }
      await save('preflight-result', { status: 'success', operators: [operator], ruleset, classicEnabled, setup, base: { before } });
      return;
    }
    const preflight = await load('preflight-result');
    const operators = preflight?.operators as { login: string; id: number }[] | undefined;
    if (!Array.isArray(operators) || operators.length !== 1) throw new Error('OPERATOR_IDENTITY_UNRESOLVED');
    if (controlPhases.includes(phase)) { await runControl(phase as ControlPhase, save, operators, load); return; }
    if (readPhases.includes(phase)) { await runRead(phase as ReadPhase, save, load); return; }
    // inspect requests the teardown FIRST, from local data only (q34-ghchecks-v3 lesson).
    if (phase === 'inspect') {
      const teardown = humanSteps({ mainTip: '' }).teardown!;
      await save('human-step-teardown-requested', { ...teardown, at: new Date().toISOString(), note: `${teardown.note}. Requested before anything else is read.` });
    }
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const view = await listAll(cursor => stored.inspect({ kind: 'list', cursor, limit: 50 }));
    const stopped = new AbortController(); stopped.abort();
    await stored.run(stopped.signal);
    const work = workOf(view);
    const { needsStop } = await import('./builder09-qualification.js');
    if (phase === 'inspect') {
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const sessions: Record<string, unknown>[] = [];
      const pushes: string[] = [];
      for (const execution of work ? [...work.previousExecutions, work.execution] : []) {
        if (!execution?.dispatch.boot) continue;
        const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
        for (const launch of (await fs.readdir(runtime).catch(() => [])).filter(name => name.startsWith('w-')).sort().slice(0, 16)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            if (!('text' in read)) { sessions.push({ executionId: execution.executionId, launch, file: String(file), ...read }); continue; }
            const calls = sessionCommands(read.text);
            pushes.push(...calls.flatMap(call => call.command ? [call.command] : []));
            sessions.push({ executionId: execution.executionId, launch, file: String(file), calls: calls.length, tokenPattern: tokenPattern.test(read.text) });
          }
        }
      }
      const { github, codeRepository } = await compose(true);
      const head = work?.publication?.pullRequest?.headSha ?? null;
      const advanced = (await load('strict-observed') as { sha?: string } | null)?.sha ?? null;
      const compare = advanced && head ? await github.read(repository, 'publication-read', session => session.get(`/repos/${repository.repository}/compare/${advanced}...${head}`)) : null;
      const files = head ? await github.read(repository, 'publication-read', session => session.get(`/repos/${repository.repository}/compare/${repository.base}...${head}`)) : null;
      const pull = work?.publication?.pullRequest ? await codeRepository.readPullRequest({ repo: repository, number: work.publication.pullRequest.number }) : null;
      const executions = work ? [...work.previousExecutions, work.execution].filter((item): item is ExecutionView => Boolean(item)) : [];
      const result = { work: work ? { work_id: work.work_id, publication: work.publication, budget: work.budget, correction: work.correction, corrections: work.corrections ?? [],
        readiness: work.readiness ?? null, checks: work.checks ?? null, impediments: work.impediments,
        history: work.history.filter(item => /^(publication|repair|correction|budget|readiness|checks)/.test(item.event)) } : null,
      executions: executions.map(item => ({ executionId: item.executionId, phase: item.dispatch.phase, request: item.request, charge: item.charge, end: item.end })),
      compare, changedFiles: list(pick(files, 'value', 'files')).map(item => item.filename), pull, sessions,
      pushViolations: pushViolations(pushes, executions.flatMap(item => item.request.publication ? [{ branch: item.request.publication.branch, head: item.request.publication.head,
        expected: item.request.publication.expectedRemote.state === 'present' ? item.request.publication.expectedRemote.sha : null }] : [])) };
      await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true });
      const saved = { ...result, secretScan: await secretScan(observations) } as Saved;
      const verdict = verdictOf({ run: await load('run-result'), strict: await load('strict-result'), humanDraft: await load('human-draft-result'), rerun: await load('rerun-result'),
        contexts: await load('contexts-result'), classic: await load('classic-result'), homonym: await load('homonym-result'), strictObserved: await load('strict-observed'),
        inspect: JSON.parse(JSON.stringify(saved)) as Saved });
      await save('inspect-result', { verdict, ...saved });
      await save('verdict', verdict);
      return;
    }
    const target = work?.execution && needsStop(work.execution) ? work.execution : null;
    if (!target?.dispatch.environment) { await save('stop-environment-result', { status: 'success', stopped: null, note: 'NOTHING_TO_STOP: no recorded Execution may still run.' }); return; }
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = target.dispatch.environment as never, boot = target.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q34s explicit stop of own boot' }) : null;
    await save('stop-environment-result', { status: 'success', state: target.state, before, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', holdReason: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    if (usesGitHub) await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void import('node:fs/promises').then(fs => fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true })).finally(() => process.exit(143));
  });
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
