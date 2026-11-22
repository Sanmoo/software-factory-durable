import type { ExecutionView, ListView, QuestionView, WorkView } from '../../src/control/index.js';
import { readBounded, sessionCommands, snapshotStorage } from './publication14-qualification.js';
import { keySource, pushViolations, requireKeySource, resolveOperator } from './humanchanges21-qualification.js';
import { abortsBeforeEnd, progressFingerprint, repairRefOf, repairRunningFor, requestOutcome, secretScan, specRepairAnswer, specVsRepair, stuckReason, type Settle }
  from './ghadv34-qualification.js';

// TEST ONLY. Ticket 34 pre-pilot group R-GH-ADV-S (operator decision 2026-11-18, "Partial + smaller recipe"): the part of R-GH-ADV that v1-v5
// never reached, on ONE new Ticket C only — publish -> `/factory repair` -> the operator CLOSES the own PR during that repair (V-04.e; the
// "encerrar PR durante reparo" half of V-10.g) -> the Factory reopens it and the operator's `resume` -> `/factory repair` -> `factory cancel`
// (CLI) during that repair in its VM, concurrent with the operator's MERGE of the own PR (V-13.g; the "merge durante reparo" half of V-10.g).
// No foreign PR, bot, issue close/reopen, human commit or conflict chain (R-GH-ADV v4 approved those). The operator's `/factory repair`
// requests are in scope of the Ticket, and ONE Builder Question per run asking whether to keep a repair-requested line against the Ticket/Spec
// gets a scripted answer; any other unscripted Question holds. Every held phase names its reason. Import and `--plan` are inert; every other
// phase is a REAL effect (GitHub App, Gondolin/KVM VM, real model) under the operator's grant. One-shot: an exclusive intent tombstone precedes
// every effect, a consumed phase never reruns, nothing is retried. Human steps: human-step-<k>-requested.json with the exact script, run by
// the supervisor with the OPERATOR's gh account (never the App).

const root = '/home/sanmoo/software-factory-test/y5';
/** v2: q34-ghadv-s-v1 (#119) held in publish-c on EXECUTION_HELD:START_INSUFFICIENT_MEMORY_FOR_BOOT (host busy; the product rightly refused the boot). */
const observations = `${root}/q34-ghadv-s-v2`;
const revision = 'q34-ghadv-s-v2';
export const phases = ['preflight', 'publish-c', 'close', 'cancel-merge', 'inspect', 'stop-environment'] as const;
export type Phase = typeof phases[number];
export type ControlPhase = Exclude<Phase, 'preflight' | 'inspect' | 'stop-environment'>;
const controlPhases = phases.filter((item): item is ControlPhase => item !== 'preflight' && item !== 'inspect' && item !== 'stop-environment');
const repositoryName = 'Sanmoo/java-springboot-event-sourcing';
/** close repair + cancel repair (a consolidation or the close repair's own publication never needs a third). */
const repository = { repository: repositoryName, base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent', correctionLimit: 3 };
const repositoryId = 1256893534;
const rulesetId = 26435808;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const operatorLogin = 'Sanmoo';
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
export const humanStepMinutes = 60;
const quietCycles = 3;
export const stallMinutes = 20;
const rounds = { max: 4 } as const;
/** 30 s (not 120 s): q34-ghadv-v4 merged DURING a repair but the Factory read the own PR only after the 85 s activity ended (duringActivity null). */
export const pollingSeconds = 30;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const skillPack = 'factory-skills-v7' as const;
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. Never push, open pull requests or change GitHub state, EXCEPT inside a publication activation the Factory requests ' +
    '(a Factory publication instruction): then follow it and the pr skill exactly (your own branch, the verified commit, the explicit lease, ONE draft pull ' +
    'request) and never merge, approve, mark ready or touch anything else. Never rewrite or drop commits you did not make. When you need information or an ' +
    'approval you do not have, use the ask_user tool instead of working around it.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
/** As R-CAND v9 and R-GH-ADV v5: the operator's `/factory repair` requests are part of the request, never a finding for exceeding it. */
export const repairsInScope = 'Operator `/factory repair` requests that add lines to this page are in scope of this Ticket: apply them exactly as requested; ' +
  'they never conflict with the required content above.';
/**
 * The ONE new synthetic issue the supervisor creates after the authorization, WITHOUT the label (step 1 adds it), with exactly this title and
 * body. `number` is pinned in a reviewed commit; 0 = not pinned: every real phase refuses.
 */
export const ticket = { number: 0, title: 'Factory qualification R-GH-ADV-S: own pull request closed during a repair, reopened, cancelled and merged', body: [
  'Add a short documentation page `docs/FACTORY_CLOSE_S.md`. This exact upper-case file name was decided by the operator.', '', 'Required content:',
  '1. A `# Factory close` title and one paragraph explaining that this file exists only to exercise closing, reopening, cancelling and merging a Factory pull request.',
  '2. A `## Steps` section with a numbered list of exactly three steps: publish, close, cancel.', '', repairsInScope, '',
  'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Do not create or edit other files. Commit the change on your branch.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && test -f docs/FACTORY_CLOSE_S.md && grep -q \'^## Steps\' docs/FACTORY_CLOSE_S.md`', '',
  'This Validation command is the only gate of this Ticket: no typecheck, lint or other gate applies, so do not declare any other gate.'].join('\n') };
export const pinned = (number: number = ticket.number) => Number.isSafeInteger(number) && number > 0;
/** The concrete `/factory repair` reasons (one per correction the recipe asks for). */
export const repairReasons = {
  close: 'Add a line `Repair: requested before the pull request was closed.` at the end of docs/FACTORY_CLOSE_S.md (only that line).',
  cancel: 'Add a line `Repair: requested before the cancellation.` at the end of docs/FACTORY_CLOSE_S.md (only that line).',
} as const;

/** Per Control phase: its Builder budget, which Factory writes it allows, and its human steps (6 = the tolerated answer, listed first). */
export const phaseSpec: Record<ControlPhase, { builders: number; publication: boolean; reopen: boolean; socket: boolean; deadlineMinutes: number; steps: readonly number[] }> = {
  // Implementation + publication, plus one operational recovery.
  'publish-c': { builders: 3, publication: true, reopen: false, socket: false, deadlineMinutes: 120, steps: [1] },
  // ONE repair (+1: its question-resumed continuation after the tolerated answer); the own PR is closed during it: nothing else may start.
  close: { builders: 2, publication: false, reopen: false, socket: false, deadlineMinutes: 160, steps: [6, 2, 3] },
  // Factory reopen + resume (recipe local commands), the pending publication, ONE repair (+1 resumed, +1 recovery) cancelled while merged.
  'cancel-merge': { builders: 4, publication: true, reopen: true, socket: true, deadlineMinutes: 260, steps: [6, 4, 5] },
};

/** Phase order: each phase once, only after the previous one SUCCEEDED; inspect after any ended phase once nothing still runs. */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, isPinned = pinned(),
  ended: ReadonlySet<string> = new Set()): string | null {
  if (!isPinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  const index = phases.indexOf(phase);
  if (phase !== 'inspect' && phase !== 'stop-environment' && index > 0) {
    const previous = phases[index - 1]!;
    if (results[previous]?.status !== 'success') return `${previous.toUpperCase().replaceAll('-', '_')}_SUCCESS_REQUIRED`;
  }
  if ((phase === 'inspect' || phase === 'stop-environment') && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  if (phase === 'inspect') {
    const running = controlPhases.filter(item => intents.has(`${item}-intent`) && !ended.has(item));
    if (running.length) return `PHASE_NOT_ENDED:${running.join(',')}`;
  }
  return null;
}

/** At most `builders` Builder activations of the Work; reviewers only for the latest NON-publication Builder Execution (distinct rounds). */
export function activationGuard(phase: ControlPhase, workId: () => string | null, maxRounds: number = rounds.max) {
  const spec = phaseSpec[phase];
  let builders = 0;
  let implementation: string | null = null;
  const seen = new Map<string, Set<number>>();
  return (context: { role: string; workId: string; executionId: string; phaseId: string }, review?: { round: number }) => {
    if (context.workId !== workId()) return false;
    if (context.role === 'builder') {
      if (builders >= spec.builders) return false;
      if (context.phaseId === 'builder-publication' && !spec.publication) return false;
      builders++;
      implementation = context.phaseId === 'builder-publication' ? null : context.executionId;
      for (const used of seen.values()) used.clear();
      return true;
    }
    if (context.role !== 'standards' && context.role !== 'spec') return false;
    if (!implementation || context.executionId !== implementation || !review) return false;
    const used = seen.get(context.role) ?? new Set<number>();
    seen.set(context.role, used);
    if (used.has(review.round) || used.size >= maxRounds) return false;
    used.add(review.round);
    return true;
  };
}
/** builder-start while the phase has a Builder budget; builder-publish only in publication phases, while Control requested it. */
export function grantGuard(phase: ControlPhase, max = 2) {
  const spec = phaseSpec[phase];
  const counts = new Map<string, number>();
  return (purpose: string | undefined, lifecycle: { publicationState: string | null; publicationActivation: boolean; executionId: string }) => {
    if ((purpose ?? 'builder-start') === 'builder-start') return spec.builders > 0;
    if (purpose !== 'builder-publish' || !spec.publication) return false;
    const own = lifecycle.publicationState === 'requested' || (lifecycle.publicationState === 'awaiting-discovery' && lifecycle.publicationActivation);
    const used = counts.get(lifecycle.executionId) ?? 0;
    if (!own || used >= max) return false;
    counts.set(lifecycle.executionId, used + 1);
    return true;
  };
}

// ---- Facts, human steps and ends (pure) ----

export type Facts = { work: WorkView | undefined; questions: QuestionView[]; activations: number; prepares: number; observed: ReadonlySet<number>;
  /** Whether the ONE tolerated Spec-vs-repair answer (step 6) was already requested in an EARLIER phase of this run. */ specRepairUsed?: boolean };
const active = (execution: ExecutionView | null | undefined) => Boolean(execution && (execution.slot.held || execution.state === 'reserved' || execution.state === 'started'));
const occupying = (work: WorkView | undefined) => Boolean(work && [...work.previousExecutions, ...(work.execution ? [work.execution] : [])].some(active));
const has = (work: WorkView | undefined, code: string) => (work?.impediments ?? []).some(item => item.code === code);
/** The Builder's own open Question first (a later one is never hidden), else the latest. */
export const builderQuestion = (facts: Pick<Facts, 'work' | 'questions'>) => {
  const own = facts.questions.filter(item => item.recordedFrom !== 'controller-divergence' && item.workId === facts.work?.work_id);
  return own.find(item => item.state === 'open') ?? own.at(-1) ?? null;
};
const repairRecorded = (work: WorkView | undefined, reason: string) => requestOutcome(work, reason) !== 'absent';
const idlePublished = (work: WorkView | undefined) => work?.publication?.state === 'published' && !occupying(work) && !work?.correction;

/** Whether human step k may be requested now and whether the Factory itself recorded its effect. */
export const humanStepRules: Record<number, { phases: readonly ControlPhase[]; optional?: boolean; ready(facts: Facts): boolean; observed(facts: Facts): boolean }> = {
  1: { phases: ['publish-c'], ready: () => true, observed: facts => Boolean(facts.work) },
  2: { phases: ['close'], ready: facts => idlePublished(facts.work), observed: facts => repairRecorded(facts.work, repairReasons.close) },
  3: { phases: ['close'], ready: facts => facts.observed.has(2) && repairRunningFor(facts.work, repairReasons.close), observed: facts => facts.work?.result === 'closed-unmerged' },
  4: { phases: ['cancel-merge'], ready: facts => facts.work?.closure?.reopen?.state === 'confirmed' && !has(facts.work, 'RESUME_REQUIRED') && idlePublished(facts.work) &&
    facts.work?.result === 'open', observed: facts => repairRecorded(facts.work, repairReasons.cancel) },
  5: { phases: ['cancel-merge'], ready: facts => facts.observed.has(4) && repairRunningFor(facts.work, repairReasons.cancel), observed: facts => facts.work?.delivery?.state === 'delivered' },
  // The ONE tolerated Spec-vs-repair-request Question per run: keep the line the operator's repair request added, citing the request.
  6: { phases: ['close', 'cancel-merge'], optional: true,
    ready: facts => !facts.specRepairUsed && specVsRepair(builderQuestion(facts)) && builderQuestion(facts)!.publication.state === 'published' &&
      repairRefOf(builderQuestion(facts), facts.work) !== null,
    observed: facts => facts.questions.some(item => item.recordedFrom !== 'controller-divergence' && (item.answer?.text ?? '').startsWith('Keep the line the operator\'s repair request')) },
};

/** Whether a Control phase reached its end and whether it is the expected one; a held end always names its reason. */
export function settled(phase: ControlPhase, facts: Facts, quiet: boolean): Settle {
  const { work } = facts;
  const spec = phaseSpec[phase];
  const steps = spec.steps.filter(step => !humanStepRules[step]!.optional).every(step => facts.observed.has(step));
  const wait = { done: false, success: false };
  const fail = (reason: string): Settle => ({ done: true, success: false, reason });
  const stuck = stuckReason(work);
  if (stuck) return fail(stuck);
  const question = builderQuestion(facts);
  const tolerated = specVsRepair(question) && !facts.specRepairUsed && !facts.observed.has(6) && spec.steps.includes(6);
  if (question?.state === 'open' && !tolerated) return fail(`UNSCRIPTED_QUESTION:${question.questionId}`);
  if (tolerated) return wait;
  switch (phase) {
    case 'publish-c':
      return work?.publication?.state === 'published' && !occupying(work) && steps ? { done: true, success: true } : wait;
    case 'close':
      if (work?.delivery?.state === 'delivered' || work?.cancellation) return fail(work?.cancellation ? 'CLOSE_RECORDED_AS_CANCELLATION' : 'CLOSE_RECORDED_AS_DELIVERY');
      return steps && work?.result === 'closed-unmerged' && !occupying(work) && quiet ? { done: true, success: true } : wait;
    case 'cancel-merge':
      // Cancelled first: the merge is still watched and must deliver; until then (or the deadline) the phase waits.
      if (work?.result !== 'delivered') return wait;
      return steps && !occupying(work) && quiet ? (work.delivery?.merge ? { done: true, success: true } : fail('MERGE_FACTS_MISSING')) : wait;
  }
  return wait;
}
/** The reason a phase ended held when `settled` gave none (deadline or a loop that ended otherwise). */
export const holdReasonOf = (outcome: Settle, deadlineReached: boolean) => outcome.success ? null : outcome.reason ?? (deadlineReached ? 'DEADLINE_REACHED' : 'ENDED_WITHOUT_SETTLING');

// ---- Exact human scripts ----

const R = repositoryName;
/**
 * Ruleset 26435808 relaxation around ONE operator merge (the q22 pattern): `update` removed and approvals 0, restored in the EXIT trap from
 * the exact before-image, and the restored rules/bypass compared with it (non-zero exit when they differ). The App never gets a bypass.
 */
export function rulesetScript(step: number): string[] {
  const directory = `${observations}/ruleset-step-${step}`;
  return [`D=${directory}; mkdir -m 700 "$D"`, `gh api repos/${R}/rulesets/${rulesetId} > "$D/before.json"`,
    `python3 -I - "$D" <<'PY'`, 'import json,sys', 'D=sys.argv[1]; d=json.load(open(D+"/before.json"))',
    'body=lambda rules: {"name":d["name"],"target":d["target"],"enforcement":d["enforcement"],"conditions":d["conditions"],"bypass_actors":d["bypass_actors"],"rules":rules}',
    'relaxed=[(dict(r, parameters=dict(r["parameters"], required_approving_review_count=0)) if r["type"]=="pull_request" else r) for r in d["rules"] if r["type"]!="update"]',
    'json.dump(body(relaxed),open(D+"/relaxed.json","w")); json.dump(body(d["rules"]),open(D+"/restore.json","w"))', 'PY',
    `restore() { gh api -X PUT repos/${R}/rulesets/${rulesetId} --input "$D/restore.json" > "$D/restored.json" && python3 -I -c 'import json,sys; b=json.load(open(sys.argv[1])); a=json.load(open(sys.argv[2])); ` +
      `sys.exit(0 if (b["rules"],b["bypass_actors"],b["enforcement"])==(a["rules"],a["bypass_actors"],a["enforcement"]) else "RULESET_RESTORE_MISMATCH")' "$D/before.json" "$D/restored.json" ` +
      '|| { echo "RULESET_RESTORE_FAILED: restore by hand from $D/restore.json" >&2; exit 1; }; }',
    'trap restore EXIT', `gh api -X PUT repos/${R}/rulesets/${rulesetId} --input "$D/relaxed.json" > "$D/relaxed-applied.json"`];
}
export const cancelRequestId = 'q34-ghadv-s-cancel-1';
/** The REAL CLI over this recipe's owner socket (`<observations>/run/control.sock`), as in ticket 25. */
export const cancelCommand = (workId: string) => `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 node dist/src/entrypoints/cli.js cancel ${workId} ` +
  `--root ${observations} --request-id ${cancelRequestId} --json`;
export type ScriptContext = { pullRequest?: number | null; workId?: string | null; specQuestionId?: string | null; repairRef?: string | null };
/** The exact script of human step k (`set -euo pipefail`, run by the supervisor with the OPERATOR's gh login, from the composed checkout). */
export function humanScript(step: number, context: ScriptContext): string {
  const need = <T>(value: T | null | undefined, name: string): T => { if (value === null || value === undefined || value === '') throw new Error(`HUMAN_STEP_CONTEXT_MISSING:${name}`); return value; };
  const C = ticket.number;
  const comment = (body: string) => `gh issue comment ${C} --repo ${R} --body '${body.replace(/'/g, `'\\''`)}'`;
  const lines: Record<number, () => string[]> = {
    1: () => [`gh issue edit ${C} --repo ${R} --add-label ${repository.label}`],
    2: () => [comment(`/factory repair ${repairReasons.close}`)],
    3: () => [`gh pr close ${need(context.pullRequest, 'pullRequest')} --repo ${R}   # WITHOUT merge, while the repair runs; never --delete-branch`],
    4: () => [comment(`/factory repair ${repairReasons.cancel}`)],
    // Operator flow (decision 2026-11-18): reopen -> cancel -> merge. The CLI cancel is launched first, the merge right after, concurrently.
    5: () => [...rulesetScript(5), 'cd "${FACTORY_CHECKOUT:?the composed checkout of this recipe}"',
      `( ${cancelCommand(need(context.workId, 'workId'))} ) & cancel=$!`,
      `gh pr ready ${need(context.pullRequest, 'pullRequest')} --repo ${R} && gh pr merge ${context.pullRequest} --repo ${R} --squash   # concurrent with the cancel above`,
      'wait "$cancel"'],
    6: () => [comment(`/factory answer ${need(context.specQuestionId, 'specQuestionId')} ${specRepairAnswer(need(context.repairRef, 'repairRef'))}`)],
  };
  const body = lines[step];
  if (!body) throw new Error('UNKNOWN_HUMAN_STEP');
  return ['set -euo pipefail', ...body()].join('\n');
}
/** After inspect (or any held end): the label off the issue and a read of the ruleset; the Factory's branch is kept as evidence. */
export function cleanupScript(): string {
  return ['set -euo pipefail', `gh issue edit ${ticket.number} --repo ${R} --remove-label ${repository.label} || true`,
    `gh api repos/${R}/rulesets/${rulesetId} --jq '[.rules[].type, (.rules[] | select(.type=="pull_request") | .parameters.required_approving_review_count)]'   # must show update and 1 approval again`].join('\n');
}

export function plan() {
  return { revision, root, observations, phases, repository, rulesetId, ticket: { ...ticket, label: 'added by human step 1', pinned: pinned() }, operators: [operatorLogin],
    configuration, guestAssets, skillPack, humanStepMinutes, quietCycles, pollingSeconds, stallMinutes, phaseSpec,
    keyLifecycle: `each GitHub phase copies ${keySource} O_EXCL into the namespace only AFTER its phase guard and intent tombstone, and removes the copy in its finally`,
    requires: ['the composed revision contains ticket 43 (6c4a9e0) and R-GH-ADV v5 (87e8ef6) or later', `${keySource} present`,
      'the supervisor created the ONE issue above WITHOUT the label and pinned its number in a reviewed commit', 'no open issue carries the label (preflight: the listing is empty)',
      'main protected with NO bypass for the App (pull requests required)', 'operator first-login store under root/credentials (model OAuth)',
      'the supervisor runs every human-step script with the operator gh login from the composed checkout (FACTORY_CHECKOUT exported for step 5)'],
    obligations: { 'V-04.e': ['close'], 'V-13.g': ['cancel-merge'] },
    /** V-10.g was approved by operator decision D-11 on q34-ghadv-v4; this recipe still checks it, as extra evidence only. */
    extraEvidence: { 'V-10.g': ['close', 'cancel-merge'] },
    github: { app: githubApp, accessRoot: `${observations} (own namespace: credentials/ per-phase copy of ${keySource}, run/); never y5/run`,
      factoryWrites: ['Builder (guest, builder-publish, only in publish-c and cancel-merge while Control requested it): leased pushes of the own branch and ONE draft PR',
        'controller: Question comments and replies to /factory commands on the issue, ONE reopen of the own PR (cancel-merge, pull-request-reopen grant)',
        'App: access_tokens issuance POSTs and DELETE /installation/token revocations', 'never: setDraft (stubbed, nothing sent), branch cleanup and environment cleanup (not composed)'],
      repositoryChanges: [{ step: 5, change: `ruleset ${rulesetId}: update rule removed and approvals 0 for the ONE operator merge`, restore: 'EXIT trap of the same script restores the before-image and compares it (non-zero exit on mismatch)' }],
      never: ['merge by the Factory', 'approval', 'ready-for-review conversion by the Factory', 'bare --force', 'push to main', 'App bypass', 'any GitHub write by this recipe itself'] },
    humanSteps: Object.fromEntries(Object.entries(humanStepRules).map(([step, rule]) => [step, { phases: rule.phases, optional: rule.optional ?? false }])),
    toleratedSpecRepairQuestion: 'ONE per run: a Builder Question asking whether to keep a line an operator /factory repair request added, against the Ticket/Spec, is answered by step 6 (keep it, authorized, citing the request) in close/cancel-merge; any other unscripted Question, or a second one, holds',
    effects: [
      'preflight: key check BEFORE any effect; exclusive namespace; read-only: operator id pinned, the label lists NO issue, the issue open with exact title/body and no label, no associated PR, no factory/<n>- branch, base protection pull-request-required, App identity, refs',
      'publish-c: step 1 (label) -> implementation -> publication -> own draft PR',
      'close: step 2 `/factory repair` -> repair started -> step 3 operator closes the PR without merge -> closed-unmerged recorded WITH the active repair, the activity NOT interrupted, not delivered, not cancelled, no publication after',
      `cancel-merge (CLI socket served): local reopen (Factory reopens its own PR) + resume -> pending publication -> step 4 \`/factory repair\` -> repair started -> step 5 \`factory cancel\` (CLI, request ${cancelRequestId}) launched with the operator merge right after -> delivered prevails; activity ceased, Slot released after cessation`,
      'inspect: storage copy + read-only GitHub (the PR), per-obligation verdict, session pushes, secret scan of storage/sessions/observations',
      'stop-environment: own boot of the last Execution when still active'],
    guards: ['one-shot intent tombstones and strict phase order', 'per-phase Builder budget, only for the Work; reviewers only for its latest non-publication Execution',
      'builder-publish only in publication phases while Control requested it (<= 2 per publication Execution)', 'prepare <= Builder budget', 'reopen only in cancel-merge',
      `each human step waits at most ${humanStepMinutes} min; ${stallMinutes} min without any observed change ends the phase held (RECIPE_STALLED)`,
      'every Control phase stops its own boots in finally and records cessation', 'every held phase records holdReason (result) and its reason in the held code', 'no retry, no remove/cleanup'],
    limits: ['V-10.g: "encerrar PR durante reparo" is proven by the close phase; "merge durante reparo" by the merge time GitHub reports falling inside the cancelled repair\'s activity (the Factory may confirm the delivery after that activity ceased: then duringActivity is null and recorded as such)',
      'V-13.g: the cancel is launched first and the merge right after; either order the Factory commits is accepted and recorded (cancel-first: delivery prevails; merge-first: cancel not-applied WORK_DELIVERED)',
      'Branch/environment cleanup after delivery is not composed here (ticket 17 qualified it).'],
    cleanup: 'cleanupScript(): written to cleanup-requested-after-<phase>.json by inspect and by any held phase',
  };
}

// ---- Verdict (pure, from the saved results only) ----

type Saved = Record<string, unknown> | null;
type Check = { obligation: string; id: string; expected: string; observed: string; met: boolean };
const pick = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((at, key) => at && typeof at === 'object' ? (at as Record<string, unknown>)[key as string] : undefined, value);
const list = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
const events = (phase: Saved | undefined, call: string) => list(pick(phase, 'events')).filter(item => item.call === call);
const historyOf = (work: unknown) => list(pick(work, 'history')).map(item => ({ event: String(item.event), detail: String(item.detail ?? '') }));
const executionsOf = (work: unknown) => [...list(pick(work, 'previousExecutions')), ...(pick(work, 'execution') ? [pick(work, 'execution') as Record<string, unknown>] : [])];
const repairOf = (execution: Record<string, unknown> | undefined) => Boolean(execution && pick(execution, 'request', 'repair'));
/** Every expectation of the plan per obligation, expected vs observed, from the saved phase results and the inspect reads. */
export function verdictOf(saved: Partial<Record<Phase, Saved>> & { inspect: Saved }): { passed: boolean; checks: Check[]; byObligation: Record<string, boolean> } {
  const checks: Check[] = [];
  const check = (obligation: string, id: string, expected: string, observed: unknown, met: boolean) =>
    checks.push({ obligation, id, expected, observed: (typeof observed === 'string' ? observed : JSON.stringify(observed) ?? 'undefined').slice(0, 400), met });
  const success = (phase: Phase) => saved[phase]?.status === 'success';
  const work = list(pick(saved.inspect, 'works')).find(item => pick(item, 'ticket', 'number') === ticket.number);
  // close: the own PR closed WITHOUT merge during the active repair (V-04.e; the "encerrar PR durante reparo" half of V-10.g).
  const closure = historyOf(work).find(item => item.event === 'pull-request-closed-unmerged');
  const closedActive = closure?.detail.split(':active:')[1] ?? null;
  const closedExecution = executionsOf(work).find(item => item.executionId === closedActive);
  const closeOk = success('close') && repairOf(closedExecution) && abortsBeforeEnd(events(saved.close, 'activity-aborted'), closedExecution) === 0 && pick(closedExecution, 'end', 'outcome') !== 'stopped' &&
    pick(saved.close, 'work', 'result') === 'closed-unmerged' && !pick(saved.close, 'work', 'delivery', 'merge') && !pick(saved.close, 'work', 'cancellation') &&
    events(saved.close, 'activate').every(item => pick(item, 'context', 'phaseId') !== 'builder-publication') && events(saved.close, 'issue').every(item => item.purpose !== 'builder-publish');
  check('V-04.e', 'closed-during-repair-not-ceased-not-delivered-not-cancelled', 'closed-unmerged recorded WITH the active repair Execution; that activity not aborted before its end (end not stopped); close result closed-unmerged, no delivery, no cancellation, no publication activation, no builder-publish',
    { status: saved.close?.status, closure, end: pick(closedExecution, 'end'), aborted: abortsBeforeEnd(events(saved.close, 'activity-aborted'), closedExecution), result: pick(saved.close, 'work', 'result'),
      delivery: pick(saved.close, 'work', 'delivery', 'state') ?? null, cancellation: pick(saved.close, 'work', 'cancellation') ?? null }, closeOk);
  // cancel-merge: the cancel of the repair Execution and the merge, launched together.
  const receipt = pick(saved['cancel-merge'], 'cancelReceipt');
  const finalC = pick(saved['cancel-merge'], 'work');
  const cancelled = pick(finalC, 'cancellation');
  const merge = pick(finalC, 'delivery', 'merge');
  const repair = executionsOf(finalC).find(item => item.executionId === (pick(cancelled, 'executionId') ?? pick(merge, 'duringActivity'))) ??
    executionsOf(finalC).filter(item => repairOf(item)).at(-1);
  const order = cancelled ? 'cancel-first' : pick(receipt, 'reason') === 'WORK_DELIVERED' ? 'merge-first' : 'unknown';
  const mergedAt = Date.parse(String(pick(merge, 'mergedAt') ?? ''));
  const started = Date.parse(String(pick(repair, 'start', 'confirmedAt') ?? ''));
  const ended = Date.parse(String(pick(repair, 'end', 'at') ?? ''));
  const publishedAfter = events(saved['cancel-merge'], 'activate').filter(item => pick(item, 'context', 'phaseId') === 'builder-publication' && Date.parse(String(item.at)) > mergedAt).length;
  const mergeDuring = Number.isFinite(mergedAt) && Number.isFinite(started) && Number.isFinite(ended) && started <= mergedAt && mergedAt <= ended;
  check('V-10.g', 'pull-request-ended-during-repair', 'the own PR closed during a repair (close phase, as V-04.e) AND merged at a GitHub time inside the repair activity; no publication after the merge; delivered',
    { close: closeOk, mergedAt: pick(merge, 'mergedAt'), repair: { started: pick(repair, 'start', 'confirmedAt'), ended: pick(repair, 'end', 'at') }, duringActivity: pick(merge, 'duringActivity') ?? null, publishedAfter },
    closeOk && success('cancel-merge') && repairOf(repair) && mergeDuring && publishedAfter === 0 && pick(finalC, 'result') === 'delivered');
  check('V-13.g', 'cancel-concurrent-with-merge', 'cancel via CLI during the repair (in its VM) with the merge launched right after: final result delivered; cancel-first => cancellation recorded on the repair Execution and delivery-confirmed names it; merge-first => cancel not-applied WORK_DELIVERED; the activity ceased (cessation confirmed, Slot released)',
    { status: saved['cancel-merge']?.status, order, receipt: { outcome: pick(receipt, 'outcome'), reason: pick(receipt, 'reason') }, result: pick(finalC, 'result'), end: pick(repair, 'end'),
      slot: pick(repair, 'slot', 'held') },
    success('cancel-merge') && pick(finalC, 'result') === 'delivered' && order !== 'unknown' && repairOf(repair) && pick(repair, 'end', 'cessation') === 'confirmed' &&
      pick(repair, 'slot', 'held') === false &&
      (order === 'merge-first' || (pick(cancelled, 'executionId') === pick(repair, 'executionId') &&
        historyOf(finalC).some(item => item.event === 'delivery-confirmed' && item.detail.includes(`cancel-requested:${cancelRequestId}`)))));
  check('all', 'leased-pushes-only', 'every session push is an exact recorded lease', pick(saved.inspect, 'pushViolations'), list(pick(saved.inspect, 'pushViolations')).length === 0 && list(pick(saved.inspect, 'sessions')).length > 0);
  check('all', 'no-secret', 'no token/private key in storage, sessions or observations', pick(saved.inspect, 'secretScan'),
    Object.values((pick(saved.inspect, 'secretScan') ?? { missing: true }) as Record<string, boolean>).every(item => item === false));
  const byObligation: Record<string, boolean> = {};
  for (const item of checks) byObligation[item.obligation] = (byObligation[item.obligation] ?? true) && item.met;
  return { passed: checks.every(item => item.met), checks, byObligation };
}

// ---- Effects (never reached by import, --plan or the tests) ----

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
type Save = (name: string, data: unknown) => Promise<void>;
type Load = (name: string) => Promise<({ status?: unknown } & Record<string, unknown>) | null>;

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}
/** Every Question of a Work read BY ID (`show` fits its view to one frame and may omit questions: ed4d592). */
async function questionsOf(control: { inspect(query: never): Promise<unknown> }, work: WorkView | undefined): Promise<QuestionView[]> {
  const found: QuestionView[] = [];
  for (const id of (work?.questions ?? []).slice(0, 16)) {
    const view = await control.inspect({ kind: 'question', question_id: id } as never) as { kind?: string; question?: QuestionView };
    if (view.kind === 'question' && view.question) found.push(view.question);
  }
  return found;
}

async function runControl(phase: ControlPhase, save: Save, load: Load, operator: { login: string; id: number }) {
  const spec = phaseSpec[phase];
  const number = ticket.number;
  const { github, tracker: rawTracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
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
  const eventsLog: Record<string, unknown>[] = [];
  const log = (entry: Record<string, unknown>) => { eventsLog.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry }); };
  // Controller writes: Questions and command replies on the pinned issue only; anything else refused before sending.
  const tracker: typeof rawTracker = { ...rawTracker, async postComment(ticketRef, comment, effect) {
    const allowed = ticketRef.number === number && (comment.kind === 'question' || comment.kind === 'reply');
    log({ call: 'post-comment', ticket: ticketRef.number, kind: comment.kind, allowed });
    if (!allowed) throw new Error('RECIPE_WRITE_GUARD');
    return rawTracker.postComment(ticketRef, comment, effect);
  } };
  const listView = async () => (await control.inspect({ kind: 'list' })) as ListView;
  const workIn = (view: ListView | null) => view?.works.find(item => item.ticket.number === number);
  let currentWork: string | null = null;
  const guard = activationGuard(phase, () => currentWork);
  const grants = grantGuard(phase);
  const boots: { environment: string; boot: string | null; start: 'confirmed' | 'uncertain' }[] = [];
  let prepares = 0, activations = 0;
  const repositoryPort = { ...codeRepository,
    async readPullRequest(query: Parameters<typeof codeRepository.readPullRequest>[0]) { const result = await codeRepository.readPullRequest(query);
      log({ call: 'read-pull-request', kind: result.kind, ...(result.kind === 'observed' ? { head: result.pullRequest.headSha, mergeable: result.pullRequest.mergeable } : {}) }); return result; },
    setDraft: async () => ({ kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_NO_READINESS', nextStep: 'This recipe never converts draft/ready; nothing was sent.', revocation: 'not-issued' as const }),
    async reopenPullRequest(pr: Parameters<NonNullable<typeof codeRepository.reopenPullRequest>>[0], effect: { effectId: string }) {
      const allowed = spec.reopen && pr.number === workIn(await listView().catch(() => null))?.pullRequest?.number;
      log({ call: 'reopen-pull-request', number: pr.number, allowed });
      if (!allowed || !codeRepository.reopenPullRequest) throw new Error('RECIPE_WRITE_GUARD');
      return codeRepository.reopenPullRequest(pr, effect);
    } };
  delete (repositoryPort as { cleanupBranch?: unknown }).cleanupBranch;
  const control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty',
    access: { tracker, repositories: [repository], dependencyRepositories: [], operators: [operator], factoryApp: () => github.appIdentity(repository), repository: repositoryPort as never },
    polling: { intervalSeconds: pollingSeconds },
    execution: { configuration, capacity: 1, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 }, reviews: { reviewer, rounds },
      credentials: { async issue(context) {
        const work = workIn(await listView());
        const running = Boolean(work?.execution?.request.publication) && work?.execution?.executionId === context.executionId && work.execution.state !== 'ended';
        const allowed = Boolean(work) && work!.work_id === context.workId && grants(context.purpose, { publicationState: work!.publication?.state ?? null, publicationActivation: running, executionId: context.executionId });
        log({ call: 'issue', purpose: context.purpose ?? 'builder-start', allowed });
        if (!allowed) throw Object.assign(new Error('RECIPE_GRANT_GUARD'), { outcome: 'known-rejected' });
        const grant = await builderCredentials.issue(context);
        log({ call: 'issued', metadata: grant.metadata });
        return grant;
      }, async revoke(grant) { const result = await builderCredentials.revoke(grant); log({ call: 'revoked', purpose: grant.metadata.purpose, kind: result.kind }); return result; } },
      sandbox: {
        async prepare(input) {
          log({ call: 'prepare', workId: input.workId });
          const work = workIn(await listView());
          if (!work || work.work_id !== input.workId || ++prepares > spec.builders) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
          const result = await sandbox.prepare(input); log({ call: 'prepare-result', result }); return result;
        },
        async start(input) {
          let result;
          try { result = await sandbox.start(input); } catch (error) { boots.push({ environment: String(input.environment), boot: null, start: 'uncertain' }); throw error; }
          boots.push(result.status === 'success' ? { environment: String(input.environment), boot: String(result.boot), start: 'confirmed' } : { environment: String(input.environment), boot: null, start: 'uncertain' });
          log({ call: 'start', result }); return result;
        },
        async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
        observe: input => sandbox.observe(input),
        async observeProposal(input) { const result = await sandbox.observeProposal(input); log({ call: 'observe-proposal', round: input.round, result }); return result; },
      },
      workers: { async deliver(worker, directive) { const result = await workers.deliver(worker, directive); log({ call: 'deliver', kind: directive.kind, result }); return result; },
        async observe(input) { const result = await workers.observe(input); log({ call: 'observe-session', state: result.session.state }); return result; },
        async activate(invocation, delivery, activationEvents) {
          log({ call: 'activate', context: invocation.context, promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160), review: invocation.review ?? null,
            repairSection: invocation.prompt.includes('Factory repair (correction') });
          // Every Builder activation the Factory ATTEMPTS counts (a refused one too).
          if (invocation.context.role === 'builder') activations++;
          if (!guard(invocation.context, invocation.review)) throw new Error('RECIPE_ONE_SHOT_GUARD');
          invocation.signal.addEventListener('abort', () => log({ call: 'activity-aborted', role: invocation.context.role, executionId: invocation.context.executionId }), { once: true });
          const handle = await workers.activate(invocation, delivery, activationEvents);
          const role = invocation.context.role;
          void handle.completed.then(done => log({ call: 'completed', role, phaseId: invocation.context.phaseId, status: done.status, ...(done.status === 'failure' ? { code: done.code } : {}) }),
            () => log({ call: 'completion-uncertain', role }));
          return handle;
        } } } });
  const status = await control.inspect({ kind: 'status' });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const server = spec.socket && 'controller_run_id' in status
    ? await (await import('../../src/entrypoints/controller/serve.js')).serveControl(`${observations}/run/control.sock`, control, String(status.controller_run_id), () => stop.abort()) : null;
  const deadline = Date.now() + spec.deadlineMinutes * 60 * 1000;
  const observedSteps = new Set<number>();
  let asked = null as { step: number; at: number } | null;
  let quietFrom: number | null = null;
  let outcome: Settle = { done: false, success: false };
  const extra: Record<string, unknown> = {};
  let lastPrint = '', lastChangeAt = Date.now();
  const specRepairUsed = (await load('human-step-6-requested')) !== null;
  try {
    if (phase === 'cancel-merge') {
      const work = workIn(await listView());
      if (!work) throw new Error('WORK_NOT_FOUND');
      extra.reopenReceipt = await control.accept({ request_id: `${revision}-reopen`, operation: 'reopen', work_id: work.work_id, origin: 'local-cli' });
      log({ call: 'reopen-accepted', receipt: extra.reopenReceipt });
    }
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 15000));
      const work = workIn(await listView());
      currentWork = work?.work_id ?? null;
      const questions = await questionsOf(control as never, work);
      const facts: Facts = { work, questions, activations, prepares, observed: observedSteps, specRepairUsed };
      const print = progressFingerprint(work, questions, eventsLog.length, observedSteps.size);
      if (print !== lastPrint) { lastPrint = print; lastChangeAt = Date.now(); }
      else if (Date.now() - lastChangeAt > stallMinutes * 60 * 1000) {
        await save(`${phase}-stalled`, { phase, at: new Date().toISOString(), minutes: stallMinutes, asked, work: work ?? null, questions });
        outcome = { done: true, success: false, reason: 'RECIPE_STALLED' };
        break;
      }
      // cancel-merge: the Factory's reopen confirmed -> the local resume (once).
      if (phase === 'cancel-merge' && !extra.resumeReceipt && work?.closure?.reopen?.state === 'confirmed') {
        extra.resumeReceipt = await control.accept({ request_id: `${revision}-resume`, operation: 'resume', work_id: work.work_id, origin: 'local-cli' });
        log({ call: 'resume-accepted', receipt: extra.resumeReceipt });
      }
      let timedOut: number | null = null;
      for (const step of spec.steps) {
        if (observedSteps.has(step)) continue;
        const rule = humanStepRules[step]!;
        if (asked?.step === step) {
          if (rule.observed(facts)) {
            observedSteps.add(step); asked = null;
            await save(`human-step-${step}-observed`, { step, at: new Date().toISOString() });
          } else if (Date.now() > asked.at + humanStepMinutes * 60 * 1000) timedOut = step;
          break;
        }
        if (asked || !rule.ready(facts)) { if (!rule.optional) break; continue; }
        const question = builderQuestion(facts);
        const context: ScriptContext = { pullRequest: work?.pullRequest?.number ?? null, workId: work?.work_id ?? null,
          specQuestionId: specVsRepair(question) ? question!.questionId : null, repairRef: repairRefOf(question, work) };
        asked = { step, at: Date.now() };
        await save(`human-step-${step}-requested`, { step, phase, script: humanScript(step, context), context, at: new Date().toISOString(), waitMinutes: humanStepMinutes,
          note: 'Supervisor: run this script ONCE now with the OPERATOR gh login (never the App), from the composed checkout; the phase is waiting.' });
        break;
      }
      if (timedOut !== null) { outcome = { done: true, success: false, reason: `HUMAN_STEP_${timedOut}_NOT_OBSERVED` }; break; }
      // The quiet window starts when the phase's END STATE is first reached and restarts if that state is left.
      const candidate = settled(phase, facts, true);
      if (!(candidate.done && candidate.success) || asked) quietFrom = null;
      else quietFrom ??= Date.now();
      outcome = settled(phase, facts, quietFrom !== null && Date.now() - quietFrom >= quietCycles * pollingSeconds * 1000);
      if (outcome.done) break;
    }
  } catch (error) {
    outcome = { done: true, success: false, reason: `RECIPE_ERROR:${error instanceof Error ? error.message.slice(0, 100) : 'UNKNOWN'}` };
  } finally {
    const final = await listView().catch(() => null);
    const work = workIn(final);
    const finalQuestions = await questionsOf(control as never, work).catch(() => [] as QuestionView[]);
    const cancelReceipt = phase === 'cancel-merge' ? await control.inspect({ kind: 'request', request_id: cancelRequestId }).catch(() => null) : null;
    stop.abort();
    const result = await running.catch(() => ({ kind: 'failed' as const }));
    await server?.close().catch(() => {});
    const cessation: unknown[] = [];
    for (const item of boots) {
      const observed = await sandbox.observe({ environment: item.environment as never, ...(item.boot ? { boot: item.boot as never } : {}) })
        .catch((error: unknown) => ({ condition: 'unknown', error: String(error).slice(0, 200) }));
      const boot = item.boot ?? ((observed as { boot?: unknown }).boot ? String((observed as { boot?: unknown }).boot) : null);
      const stopped = (observed as { condition?: string }).condition === 'active' && boot
        ? await sandbox.stop({ environment: item.environment as never, boot: boot as never, reason: `${revision} ${phase} finally` }).catch((error: unknown) => ({ error: String(error).slice(0, 200) })) : null;
      cessation.push({ ...item, observedBoot: boot, observed, stopped });
    }
    await save(`${phase}-cessation`, { boots: cessation, at: new Date().toISOString() }).catch(() => {});
    await save(`${phase}-result`, { status: outcome.success ? 'success' : 'held', holdReason: holdReasonOf(outcome, Date.now() >= deadline), outcome: result, work: work ?? null,
      questions: finalQuestions, cancelReceipt, ...extra, stepsObserved: [...observedSteps], counts: { prepares, activations }, events: eventsLog,
      deadlineReached: Date.now() >= deadline }).catch(() => {});
  }
  if (!outcome.success) throw new Error(`PHASE_NOT_AS_EXPECTED:${holdReasonOf(outcome, Date.now() >= deadline)}`);
}

async function preflightPhase(save: Save) {
  const { github, tracker, codeRepository } = await compose();
  const owner = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repositoryName}`));
  if (!owner.ok) { await save('preflight-held', { owner, reasons: ['OWNER_UNREADABLE'] }); throw new Error('PRECONDITION_HELD:OWNER_UNREADABLE'); }
  const operator = resolveOperator(owner.value, operatorLogin);
  const listing = await tracker.listCandidates(repository);
  const reasons: string[] = [];
  if (listing.kind !== 'observed' || listing.repositoryId !== repositoryId || listing.candidates.length !== 0) reasons.push('LABEL_LISTING_NOT_EMPTY');
  const raw = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repositoryName}/issues/${ticket.number}`));
  const value = raw.ok ? raw.value as { state?: string; title?: string; body?: string | null; labels?: { name: string }[]; pull_request?: unknown } : null;
  const issue = value ? { state: value.state, title: value.title, labels: (value.labels ?? []).map(label => label.name) } : raw;
  if (!value || value.state !== 'open' || value.title !== ticket.title || (value.body ?? '').replaceAll('\r\n', '\n') !== ticket.body || value.pull_request ||
    (value.labels ?? []).some(label => label.name === repository.label)) reasons.push('ISSUE_NOT_AS_PINNED');
  const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [], refs: true, base: repository.base });
  const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
  if (publication.kind !== 'observed' || !refs || !refs[`refs/heads/${repository.base}`]) reasons.push('REFS_UNKNOWN');
  const associated = publication.kind === 'observed' ? publication.issues[String(ticket.number)] : undefined;
  if (associated?.completeness !== 'complete' || associated.candidates.length > 0) reasons.push('ASSOCIATED_PULL_REQUEST_OR_UNKNOWN');
  const stray = refs ? Object.keys(refs).filter(ref => ref.startsWith(`refs/heads/factory/${ticket.number}-`)) : [];
  if (stray.length) reasons.push('STRAY_BRANCHES');
  if (publication.kind === 'observed' && publication.baseProtection?.state !== 'pull-request-required') reasons.push('BASE_PROTECTION_NOT_VERIFIED');
  const app = await github.appIdentity(repository);
  if (!app) reasons.push('APP_IDENTITY_UNKNOWN');
  if (reasons.length) { await save('preflight-held', { reasons, issue, listing, stray, app }); throw new Error(`PRECONDITION_HELD:${reasons.join(',')}`.slice(0, 128)); }
  await save('preflight-result', { status: 'success', operators: [operator], issue, base: { state: 'present', sha: refs![`refs/heads/${repository.base}`] }, refs,
    baseProtection: publication.kind === 'observed' ? publication.baseProtection : null, app });
}

async function inspectPhase(save: Save, load: Load) {
  const fs = await import('node:fs/promises');
  const { openControl } = await import('../../src/control/index.js');
  const copy = await snapshotStorage(observations, `${observations}/inspect-storage-copy`);
  const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
  const view = await stored.inspect({ kind: 'list' }) as ListView;
  const work = view.works.find(item => item.ticket.number === ticket.number);
  const questions = await questionsOf(stored as never, work);
  const stopped = new AbortController(); stopped.abort();
  await stored.run(stopped.signal);
  const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
  const sessions: Record<string, unknown>[] = [];
  const pushes: string[] = [];
  const sessionBytes: Buffer[] = [];
  for (const execution of work ? [...work.previousExecutions, ...(work.execution ? [work.execution] : [])] : []) {
    if (!execution.dispatch.boot) continue;
    const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
    for (const launch of (await fs.readdir(runtime).catch(() => [])).filter(name => name.startsWith('w-')).sort().slice(0, 12)) {
      const directory = `${runtime}/${launch}/profile/sessions`;
      for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
        const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
        if (!('text' in read)) { sessions.push({ executionId: execution.executionId, launch, file: String(file), ...read }); continue; }
        sessionBytes.push(Buffer.from(read.text));
        const calls = sessionCommands(read.text);
        pushes.push(...calls.flatMap(call => call.command ? [call.command] : []));
        sessions.push({ executionId: execution.executionId, launch, file: String(file), calls: calls.length, tokenPattern: secretScan({ s: Buffer.from(read.text) }).s });
      }
    }
  }
  const expectations = (work ? [...work.previousExecutions, ...(work.execution ? [work.execution] : [])] : []).flatMap((item: ExecutionView) => item.request.publication ? [{
    branch: item.request.publication.branch, head: item.request.publication.head,
    expected: item.request.publication.expectedRemote.state === 'present' ? item.request.publication.expectedRemote.sha : null }] : []);
  const { codeRepository } = await compose();
  const pull = work?.publication?.pullRequest ? await codeRepository.readPullRequest({ repo: repository, number: work.publication.pullRequest.number }) : null;
  const names = (await fs.readdir(observations)).filter(name => name.endsWith('.json'));
  const observationBytes = Buffer.concat(await Promise.all(names.map(name => fs.readFile(`${observations}/${name}`))));
  const storage = Buffer.concat(await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(name => fs.readFile(`${observations}/${name}`).catch(() => Buffer.alloc(0)))));
  const result = { works: view.works, questions, pull, pushViolations: pushViolations(pushes, expectations), sessions,
    secretScan: secretScan({ storage, sessions: Buffer.concat(sessionBytes), observations: observationBytes }) };
  const savedPhases: Partial<Record<Phase, Saved>> = {};
  for (const phase of controlPhases) savedPhases[phase] = await load(`${phase}-result`);
  const verdict = verdictOf({ ...savedPhases, inspect: JSON.parse(JSON.stringify(result)) as Saved });
  await save('inspect-result', { verdict, ...result });
}

async function stopEnvironment(save: Save) {
  const { openControl } = await import('../../src/control/index.js');
  const copy = await snapshotStorage(observations, `${observations}/stop-environment-storage-copy`);
  const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
  const view = await stored.inspect({ kind: 'list' }) as ListView;
  const stopped = new AbortController(); stopped.abort();
  await stored.run(stopped.signal);
  const { needsStop } = await import('./builder09-qualification.js');
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const sandbox = createSandbox({ root, guestAssets });
  const results: unknown[] = [];
  for (const work of view.works) {
    const execution = work.execution;
    if (!execution?.dispatch.environment || !needsStop(execution)) continue;
    const environment = execution.dispatch.environment as never, boot = execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    results.push({ work: work.work_id, state: execution.state, before, result: before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q34-ghadv-s explicit stop of own boot' }) : null });
  }
  if (!results.length) throw new Error('NOTHING_TO_STOP');
  await save('stop-environment-result', { results });
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  // Before ANY effect (no filesystem module is loaded): without the pinned issue nothing real may run.
  if (!pinned()) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  const usesGitHub = phase !== 'stop-environment';
  if (usesGitHub) await requireKeySource(path => fs.access(path)); // before ANY effect
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const ended = new Set((await Promise.all(controlPhases.map(async item => (await exists(`${item}-result`)) || (await exists(`${item}-held`)) ? item : null))).filter((item): item is ControlPhase => item !== null));
  const refused = phaseGuard(phase, results, intents, pinned(), ended);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  let copied = false;
  try {
    if (phase === 'preflight') { await fs.mkdir(`${observations}/credentials`, { mode: 0o700 }); await fs.mkdir(`${observations}/run`, { mode: 0o700 }); }
    if (usesGitHub) {
      const { constants } = await import('node:fs');
      await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
      copied = true;
      await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
    }
    if (phase === 'preflight') { await preflightPhase(save); return; }
    if (phase === 'inspect') { await inspectPhase(save, load); await save('cleanup-requested-after-inspect', { script: cleanupScript(), at: new Date().toISOString() }); return; }
    if (phase === 'stop-environment') { await stopEnvironment(save); return; }
    const operators = (await load('preflight-result'))?.operators as { login: string; id: number }[] | undefined;
    if (!Array.isArray(operators) || operators.length !== 1) throw new Error('OPERATOR_IDENTITY_UNRESOLVED');
    await runControl(phase, save, load, operators[0]!);
  } catch (error) {
    // The held record always names its reason (the phase's holdReason, or the error that ended it before settling).
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 160) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    if (phase !== 'preflight') await save(`cleanup-requested-after-${phase}`, { script: cleanupScript(), at: new Date().toISOString(), after: `${phase}-held` }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    if (copied) await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
