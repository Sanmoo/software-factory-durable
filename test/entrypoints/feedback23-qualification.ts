import type { GitHubTicketRef } from '../../src/issue-tracker/index.js';
import type { ExecutionView, WorkView } from '../../src/control/index.js';
import { readBounded, sessionCommands, snapshotStorage } from './publication14-qualification.js';
import { keySource, pushViolations, requireKeySource, resolveOperator } from './humanchanges21-qualification.js';

// TEST ONLY. Ticket 23 one-shot real qualification recipe: HUMAN feedback of the Factory's own PR — an operator's REQUEST_CHANGES review and
// an explicit `/factory repair` comment — is recorded with identity/origin/version/content, folded into ONE correction charged once, repaired
// on the SAME PR (leased update); a review still CHANGES_REQUESTED after the push is treated (never lost, never re-charged); feedback during
// the repair accumulates without interrupting it; an approval before the start withdraws the trigger without charge. Import and `--plan` are
// inert. Every other phase is a REAL effect and needs an explicit operator grant: real GitHub (App), a real Gondolin/KVM VM and the real model.
// Phases are one-shot: an exclusive intent tombstone precedes every effect (the namespace directory is created exclusively first, then the
// tombstone, then the key copy); a consumed phase never reruns; nothing is retried automatically. The App key is copied O_EXCL into the
// namespace for ONE phase and removed in that phase's `finally`. Every Control phase stops its own boots in `finally` and records cessation.
// HUMAN steps (reviews, the comment, the approval) are made by the operator with the operator's own account — never the App, never this
// recipe. The Factory never merges, approves, dismisses, marks ready, bypasses or changes base protection/rules.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q23-feedback-v3`;
const revision = 'q23-feedback-v3';
const phases = ['preflight', 'run', 'review', 'command', 'withdraw', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
type ControlPhase = 'run' | 'review' | 'command' | 'withdraw';
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent',
  /** review (1) + command (1, or 2 when the during-activity review lands after the closure) — a fourth would be blocked by the budget, never retried. */
  correctionLimit: 3 };
/**
 * The NEW synthetic issue the supervisor creates after the operator's authorization (title/body below, label `ready-for-agent`, no other
 * open issue with that label). `number` MUST be pinned in a reviewed commit before preflight: 0 refuses every phase (TICKET_NOT_PINNED).
 */
export const ticket = { number: 0, repositoryId: 1256893534, title: 'Factory qualification: treat human review feedback on the Factory pull request' } as const;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const operatorLogin = 'Sanmoo';
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
/** Phase deadlines (minutes), human waits included. */
const deadlines = { run: 80, review: 160, command: 220, withdraw: 160 } as const;
/** How long a phase waits for EACH human step once it asked for it (>= 60 min); then the phase is held (consumed, no retry). */
export const humanStepMinutes = 60;
/** Polling cycles observed after the phase's end state to show that nothing else triggers (no second charge, no re-trigger after the push). */
const quietCycles = 3;
const rounds = { max: 4 } as const;
const pollingSeconds = 120;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. Never push, open pull requests or change GitHub state, EXCEPT inside a publication activation the Factory requests ' +
    '(a Factory publication instruction): then follow it and the pr skill exactly (your own branch, the verified commit, the explicit lease, ONE draft pull ' +
    'request) and never merge, approve, dismiss, mark ready or touch anything else. Never rewrite or drop commits you did not make. Report blockers instead of working around them.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const skillPack = 'factory-skills-v6' as const;
/** Proposed body of the NEW issue (documentation only; one documented gate that keeps holding after every requested change). */
export const ticketBody = [
  'Add a short documentation page `docs/FACTORY_FEEDBACK.md`. This exact upper-case file name was decided by the operator.',
  '', 'Required content:',
  '1. A `# Factory feedback` title and one paragraph explaining that this file exists only to exercise how the Software Factory treats human review feedback.',
  '2. A `## Steps` section with a numbered list of exactly three steps: publish, review, repair.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Do not create or edit other files. Commit the change on your branch.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && test -f docs/FACTORY_FEEDBACK.md && grep -q \'^## Steps\' docs/FACTORY_FEEDBACK.md`'].join('\n');
/** The HUMAN steps, each with the exact command the operator runs with the operator's OWN credentials (recorded when the phase asks for it). */
export const humanSteps = {
  1: { phase: 'review', action: 'REQUEST_CHANGES review on the Factory draft PR',
    body: 'Please add a `## Review notes` section at the end of docs/FACTORY_FEEDBACK.md with exactly one line: `Requested by an operator review.`',
    expect: 'recorded HUMAN_CHANGES_REQUESTED -> ONE correction -> repair (continue) -> leased update of the SAME PR -> treated; the review stays CHANGES_REQUESTED on GitHub (older commit) and is NOT re-triggered' },
  2: { phase: 'command', action: '`/factory repair` comment on the Factory PR',
    body: '/factory repair Add a line `Repaired by explicit request.` right below the title of docs/FACTORY_FEEDBACK.md.',
    expect: 'recorded EXPLICIT_REPAIR (github-comment) -> ONE correction -> repair -> leased update -> treated' },
  3: { phase: 'command', action: 'a SECOND REQUEST_CHANGES review WHILE the step-2 repair runs (asked when its Execution started)',
    body: 'Please also add `See also: docs/FACTORY_FEEDBACK.md#steps` as the last line of the `## Steps` section.',
    expect: 'recorded during the activity; nothing reaches the running Builder; folded into the SAME correction (continuation, charge preserved) when committed before its closure, otherwise ONE new correction' },
  4: { phase: 'withdraw', action: 'REQUEST_CHANGES review while the Factory is PAUSED',
    body: 'Please rename the title to `# Factory feedback (withdrawn)`.', expect: 'recorded -> ONE pending correction (paused: not started)' },
  5: { phase: 'withdraw', action: 'APPROVE review of the Factory PR (same operator), after step 4 was recorded',
    body: 'Approving: the previous request is no longer needed.', expect: 'the step-4 request is withdrawn -> the correction is withdrawn without charge; nothing is launched; no merge readiness is claimed' },
} as const;
export function humanCommand(step: keyof typeof humanSteps, pullRequest: number): string {
  const body = humanSteps[step].body.replace(/'/g, `'\\''`);
  const verb = step === 2 ? 'comment' : 'review';
  const flag = step === 2 ? '' : step === 5 ? ' --approve' : ' --request-changes';
  return `gh pr ${verb} ${pullRequest} --repo ${repository.repository}${flag} --body '${body}'   # with YOUR OWN gh login (operator ${operatorLogin}); never the App`;
}

export function plan() {
  return { revision, root, observations, phases, repository, ticket: { ...ticket, body: ticketBody, label: repository.label, pinned: ticket.number > 0 }, operators: [operatorLogin],
    configuration, guestAssets, skillPack, humanSteps, humanStepMinutes,
    requires: ['tickets 21, 22 and 23 integrated in the composed revision', `${keySource} present (copied O_EXCL into the namespace per phase; missing = loud refusal before any effect)`,
      'the supervisor created the NEW issue (title/body above, label ready-for-agent) and pinned its number in a reviewed commit', 'no other open issue carries the label',
      'main protected with NO bypass for the App (as in tickets 14/16/17/21/22): pull requests required', 'the App installation has Pull requests: read and Issues: read (feedback-read)',
      'operator first-login store under root/credentials (model OAuth)', `the operator is available to run the ${Object.keys(humanSteps).length} human commands (each phase waits >= ${humanStepMinutes} min per step)`],
    repositorySetup: ['No required check, workflow or rule change is needed: every trigger is a human review or comment of the operator on the Factory PR.',
      'The operator\'s APPROVE (step 5) may satisfy the ruleset approval count: nobody merges in this recipe (merge is human and out of scope); the Factory never reads approval as readiness.'],
    model: { provider: 'openai', model: 'gpt-6-luna', auth: 'factory-oauth', providerRetries: 0, sdkRetries: 0,
      builderActivations: { run: ['implementation', 'publication'], review: ['repair (continue or replacement)', 'publication (leased update)'],
        command: ['repair', 'publication', 'optional: continuation of the SAME correction or ONE new correction for step 3', 'publication'], withdraw: [] },
      reviewersPerImplementation: `standards + spec, at most ${rounds.max} rounds each` },
    github: { app: githubApp, accessRoot: `${observations} (own namespace: credentials/ per-phase copy of ${keySource}, run/); never y5/run`,
      reads: ['controller feedback-read {metadata:read, pull_requests:read, issues:read}: GET pulls/<n>/reviews, pulls/<n>/comments, issues/<n>/comments of the own PR'],
      writes: ['Builder (guest, direct, builder-publish): run — 1 push creating refs/heads/factory/<n>-<work8> with --force-with-lease=<ref>: (absent) and 1 draft PR (marker, Closes #<n>)',
        'Builder: review/command — each repair: 1 push of the repaired head with --force-with-lease=refs/heads/<branch>:<published head> and at most 1 PR description edit of the SAME PR',
        'App: access_tokens issuance POSTs and DELETE /installation/token revocations', 'controller: none (no comment, review, label or draft/ready conversion: setDraft is stubbed as not sent)'],
      human: Object.entries(humanSteps).map(([step, item]) => `step ${step} (${item.phase}): the operator — ${item.action}`),
      humanCommands: 'written into human-step-<k>-requested.json with the exact `gh pr review|comment` command for the own PR number, when the phase asks for it',
      never: ['merge of the Factory PR', 'approval or dismissal by the Factory', 'ready-for-review conversion', 'bare --force or a lease without an explicit oid', 'push to main or any other branch',
        'rewrite of the base', 'change of base protection, rulesets, workflows or required checks', 'labels/assignees', 'closing the issue or the PR', 'branch deletion/cleanup',
        'any write by this recipe itself'] },
    effects: [
      'preflight: key source check BEFORE any effect; exclusive namespace with its own GitHub access root; read-only: operator id pinned, label lists exactly the pinned issue, no ' +
        'associated PR, no factory/<n>- branch, main requires PRs without App bypass, App bot identity, every branch/tag tip',
      'run: new storage; implementation (reviews, verification) -> discovery absent -> ONE publication activation -> own draft PR linked (published head H1)',
      'review: same storage, new owner; human step 1 -> feedback desk records it -> repair desk opens ONE correction (HUMAN_CHANGES_REQUESTED) -> fresh PR+feedback re-read ' +
        `before admission -> repair (continue) -> leased update H1->H2 of the SAME PR -> closed published, request treated; ${quietCycles} quiet cycles: the review is still ` +
        'CHANGES_REQUESTED on H1 and nothing re-triggers',
      'command: same storage; human step 2 (comment) -> ONE correction (EXPLICIT_REPAIR) -> repair Execution; when it STARTED, human step 3 (second review) is requested -> recorded ' +
        `during the activity (no interruption) -> same correction continued with preserved charge, or one new correction after closure; ${quietCycles} quiet cycles`,
      'withdraw: same storage; the recipe PAUSES the installation (local command), human step 4 -> ONE pending correction; human step 5 (approve) -> withdrawn without charge; ' +
        `unpause; ${quietCycles} quiet cycles: no activation, corrections consumed unchanged`,
      'inspect: storage copy; read-only GitHub: own PR (same number, last head), its reviews/comments (feedback-read, recorded verbatim for a fixture), file at the head; session pushes',
      'stop-environment: own boot of the last recorded Execution when it may still run'],
    guards: ['one-shot intent tombstones and phase order', 'per-phase Builder sequence (phaseIds); withdraw refuses ANY activation', 'reviewers only for the implementation/repair Execution in progress',
      'builder-publish only while Control requested the publication (<= 2 per publication activation)', 'prepare <= Builder activations of the phase', 'no retry, no remove/cleanup',
      `each human step waits at most ${humanStepMinutes} min, then the phase is held`, 'every Control phase stops its own boots in finally and records the cessation'],
    expected: [
      'run: published, head H1 = verified head; budget corrections {limit 3, consumed 0}; feedback requests []',
      'review: feedback.requests [{code HUMAN_CHANGES_REQUESTED, feedback.origin github-review, author operator id, version H1, content = step-1 body, state treated}]; corrections ' +
        '[{outcome published, charged true, head H2}]; repair Execution REPAIR_REQUESTED with request.repair.reasons[0].feedback = that request; prompt contains "Human requests from configured ' +
        'operators" and "use ask_user"; publication prompt --force-with-lease=refs/heads/<branch>:H1 origin H2; SAME PR number; consumed 1; after the quiet cycles no correction and no new activation',
      'command: an EXPLICIT_REPAIR request (github-comment, comment id/url, operator) and the step-3 HUMAN_CHANGES_REQUESTED, both treated; every correction charged once (consumed = closed ' +
        'charged corrections); a continuation (history repair-continued, charge preserved) when step 3 entered before the closure; no Execution interrupted by feedback',
      'withdraw: the step-4 request withdrawn (APPROVED_LATER), corrections gains [{outcome withdrawn, charged false}], consumed unchanged, no activation; readiness never claims human approval',
      'inspect: the final head contains every requested line; every session push names its exact lease; no token in storage/receipts/sessions/observations'],
  };
}

/** Phase order: each phase once and only after the previous one SUCCEEDED (a held phase is consumed and never followed). */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, pinned = ticket.number > 0): string | null {
  if (!pinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  const before: Partial<Record<Phase, Phase>> = { run: 'preflight', review: 'run', command: 'review', withdraw: 'command' };
  const previous = before[phase];
  if (previous && results[previous]?.status !== 'success') return `${previous.toUpperCase()}_SUCCESS_REQUIRED`;
  if ((phase === 'inspect' || phase === 'stop-environment') && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  return null;
}

type BuilderKind = 'implementation' | 'publication';
const implementationPhases: Record<ControlPhase, readonly string[]> = { run: ['builder-initial'], review: ['builder-continuation', 'builder-recovery'],
  command: ['builder-continuation', 'builder-recovery'], withdraw: [] };
/** The Builder sequence each phase may run (command: a second repair pair is optional — continuation or a new correction for step 3). */
export const builderSequence: Record<ControlPhase, readonly BuilderKind[]> = { run: ['implementation', 'publication'], review: ['implementation', 'publication'],
  command: ['implementation', 'publication', 'implementation', 'publication'], withdraw: [] };
/** Activation guard of one phase: the exact Builder sequence, then reviewers only for the implementation Execution in progress (distinct rounds). */
export function activationGuard(phase: ControlPhase, maxRounds: number = rounds.max, resumes = 1) {
  const sequence = builderSequence[phase];
  let next = 0;
  // Real run q23-feedback-v3: a Builder that asked (human request disagreement, AC5) resumes after the operator's answer: ONE extra
  // implementation activation (question-resumed) is allowed in place of the expected one, at most `resumes` per phase.
  let extra = resumes;
  let implementation: { workId: string; executionId: string } | undefined;
  let seen: Record<string, Set<number>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; workId: string; executionId: string; phaseId: string }, review?: { round: number }) => {
    if (context.role === 'builder') {
      const kind = sequence[next];
      const resumed = kind !== 'implementation' && sequence[next - 1] === 'implementation' && extra > 0 && implementationPhases[phase].includes(context.phaseId) &&
        implementation !== undefined && context.executionId !== implementation.executionId;
      if (resumed) {
        extra--;
        implementation = { workId: context.workId, executionId: context.executionId };
        seen = { standards: new Set(), spec: new Set() };
        return true;
      }
      if (!kind) return false;
      if (kind === 'implementation') {
        if (!implementationPhases[phase].includes(context.phaseId)) return false;
        implementation = { workId: context.workId, executionId: context.executionId };
        seen = { standards: new Set(), spec: new Set() };
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
/** Grant guard: builder-start for an implementation/repair; builder-publish only in phases with a publication, while Control requested it. */
export function grantGuard(phase: ControlPhase, max = 2) {
  let publish = 0;
  let lastPublication: string | null = null;
  return (purpose: string | undefined, lifecycle: { publicationState: string | null; publicationActivation: boolean; executionId?: string }) => {
    if ((purpose ?? 'builder-start') === 'builder-start') return builderSequence[phase].length > 0;
    if (purpose !== 'builder-publish' || !builderSequence[phase].includes('publication')) return false;
    const own = lifecycle.publicationState === 'requested' || (lifecycle.publicationState === 'awaiting-discovery' && lifecycle.publicationActivation);
    if (lifecycle.executionId && lifecycle.executionId !== lastPublication) { lastPublication = lifecycle.executionId; publish = 0; }
    if (!own || publish >= max) return false;
    publish++;
    return true;
  };
}

type Request = NonNullable<WorkView['feedback']>['requests'][number];
const requestsOf = (work: WorkView | undefined, code: Request['code']) => (work?.feedback?.requests ?? []).filter(item => item.code === code);
/** The human steps of a phase, observed through what the Factory itself recorded (never a parallel reader deciding for it). */
export function humanObserved(step: keyof typeof humanSteps, work: WorkView | undefined, before: { reviews: number; repairs: number }): boolean {
  if (step === 1 || step === 3 || step === 4) return requestsOf(work, 'HUMAN_CHANGES_REQUESTED').length > before.reviews;
  if (step === 2) return requestsOf(work, 'EXPLICIT_REPAIR').some(item => item.feedback.origin === 'github-comment') && requestsOf(work, 'EXPLICIT_REPAIR').length > before.repairs;
  return (work?.feedback?.requests ?? []).some(item => item.state === 'withdrawn' && item.outcome === 'APPROVED_LATER');
}
const charged = (work: WorkView | undefined) => (work?.corrections ?? []).filter(item => item.charged);

/** Whether a Control phase reached its end (or a state that ends it early); `success` says whether it is the expected end. */
/** Real run q23-feedback-v3: the open Question the BUILDER asked (AC5: disagreement/inability on a human request), if any. */
export const builderQuestion = (work: WorkView | undefined) => (work?.impediments ?? []).find(item => item.code === 'QUESTION_PENDING' && item.questionId)?.questionId ?? null;
export function settled(phase: ControlPhase, work: WorkView | undefined, facts: { activations: number; stepsObserved: number; quietCyclesDone: boolean; correctionsBefore: number;
  /** Builder Questions answered by the operator in this phase (each adds one question-resumed activation). */ resumes?: number }):
  { done: boolean; success: boolean } {
  const state = work?.publication?.state ?? '';
  const stuck = ['blocked', 'not-publishable', 'base-changed', 'diverged'].includes(state) || work?.execution?.state === 'held' ||
    (work?.impediments ?? []).some(item => item.code === 'REPAIR_EVENT_ALREADY_TREATED' || item.code === 'CORRECTION_LIMIT_REACHED');
  if (phase === 'run') return state === 'published' ? { done: true, success: true } : { done: stuck, success: false };
  if (stuck) return { done: true, success: false };
  // A Question the Builder asked waits for the operator's answer (surfaced, never auto-answered): not an end.
  if (builderQuestion(work)) return { done: false, success: false };
  const resumes = facts.resumes ?? 0;
  const corrections = (work?.corrections ?? []).slice(facts.correctionsBefore);
  const requests = work?.feedback?.requests ?? [];
  const consumed = work?.budget?.corrections.consumed ?? 0;
  if (phase === 'withdraw') {
    if (facts.activations > 0 || corrections.some(item => item.charged)) return { done: true, success: false };
    const withdrawn = corrections.length === 1 && corrections[0]!.outcome === 'withdrawn' && !work?.correction;
    return withdrawn && facts.stepsObserved === 2 && facts.quietCyclesDone ? { done: true, success: consumed === charged(work).length } : { done: false, success: false };
  }
  const wanted = phase === 'review' ? 1 : 2;
  const allTreated = requests.length > 0 && requests.every(item => item.state === 'treated' || item.state === 'withdrawn');
  const closed = !work?.correction && corrections.length >= 1 && corrections.every(item => item.outcome === 'published' && item.charged) && state === 'published';
  if (corrections.some(item => item.outcome !== 'published')) return { done: true, success: false };
  if (closed && allTreated && facts.stepsObserved >= wanted && facts.quietCyclesDone) {
    // command: a continuation of the same correction or ONE new correction — either way two repair+publication pairs.
    const expected = phase === 'review' ? corrections.length === 1 && facts.activations === 2 + resumes : corrections.length <= 2 && facts.activations === 4 + resumes;
    return { done: true, success: expected && consumed === charged(work).length };
  }
  return { done: false, success: false };
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

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}
const workOf = (list: unknown): WorkView | undefined => (list as { kind?: string; works?: WorkView[] }).kind === 'list' ? (list as { works: WorkView[] }).works[0] : undefined;
/** The human steps each Control phase asks for, in order (step 3 only once the step-2 repair Execution STARTED). */
const stepsOf: Record<ControlPhase, (keyof typeof humanSteps)[]> = { run: [], review: [1], command: [2, 3], withdraw: [4, 5] };

async function runControl(phase: ControlPhase, save: (name: string, data: unknown) => Promise<void>, operators: { login: string; id: number }[]) {
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
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
  const events: unknown[] = [];
  const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry }); };
  const guard = activationGuard(phase);
  const grants = grantGuard(phase);
  // Every start this phase attempted: a confirmed boot, or an environment whose start is UNCERTAIN (failure/throw: a boot may still exist).
  const boots: { environment: string; boot: string | null; start: 'confirmed' | 'uncertain' }[] = [];
  let prepared = 0;
  let activations = 0;
  const shown = async () => workOf(await control.inspect({ kind: 'list' }));
  const control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty',
    access: { tracker, repositories: [repository], dependencyRepositories: [], operators, factoryApp: () => github.appIdentity(repository),
      repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base),
        async readPullRequest(query) { const result = await codeRepository.readPullRequest(query); log({ call: 'read-pull-request', unless: Boolean(query.unless), kind: result.kind,
          ...(result.kind === 'observed' ? { head: result.pullRequest.headSha, mergeable: result.pullRequest.mergeable } : {}) }); return result; },
        // Ticket 23: the real feedback read (logged as facts; the payloads go to the phase result for a later verbatim fixture).
        async readFeedback(query) { const result = await codeRepository.readFeedback!(query); log({ call: 'read-feedback', kind: result.kind,
          ...(result.kind === 'observed' ? { reviews: result.reviews.map(item => [item.reviewId, item.state, item.author?.login ?? null, item.commitId]), comments: result.comments.length }
            : { code: result.code }) }); return result; },
        // The Factory PR stays draft in this recipe: no readiness conversion is ever sent (the update path of the same PR requires draft).
        setDraft: async () => ({ kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_NO_READINESS', nextStep: 'This recipe never converts draft/ready; nothing was sent.', revocation: 'not-issued' }),
        async findPublication(correlation) {
          const result = await codeRepository.findPublication(correlation);
          log({ call: 'find-publication', knownBranches: correlation.knownBranches, kind: result.kind });
          return result;
        } } }, polling: { intervalSeconds: pollingSeconds },
    execution: { configuration, capacity: 1, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 }, reviews: { reviewer, rounds },
      credentials: { async issue(context) {
        const work = await shown();
        const running = Boolean(work?.execution?.request.publication) && work?.execution?.executionId === context.executionId && work.execution.state !== 'ended';
        const allowed = work?.ticket.number === ticket.number && grants(context.purpose, { publicationState: work.publication?.state ?? null, publicationActivation: running, executionId: context.executionId });
        log({ call: 'issue', purpose: context.purpose ?? 'builder-start', allowed });
        if (!allowed) throw Object.assign(new Error('RECIPE_GRANT_GUARD'), { outcome: 'known-rejected' });
        const grant = await builderCredentials.issue(context);
        log({ call: 'issued', metadata: grant.metadata });
        return grant;
      }, async revoke(grant) { const result = await builderCredentials.revoke(grant); log({ call: 'revoked', purpose: grant.metadata.purpose, kind: result.kind }); return result; } },
      sandbox: {
        async prepare(input) {
          log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
          const work = await shown();
          if (work?.work_id !== input.workId || work.ticket.number !== ticket.number || ++prepared > builderSequence[phase].length + 1) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
          const result = await sandbox.prepare(input);
          log({ call: 'prepare-result', result });
          return result;
        },
        async start(input) {
          let result;
          try { result = await sandbox.start(input); } catch (error) { boots.push({ environment: String(input.environment), boot: null, start: 'uncertain' }); throw error; }
          boots.push(result.status === 'success' ? { environment: String(input.environment), boot: String(result.boot), start: 'confirmed' }
            : { environment: String(input.environment), boot: null, start: 'uncertain' });
          log({ call: 'start', result });
          return result;
        },
        async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
        async observeProposal(input) { const result = await sandbox.observeProposal(input); log({ call: 'observe-proposal', round: input.round, result }); return result; },
      },
      workers: { async deliver(worker, directive) { const result = await workers.deliver(worker, directive); log({ call: 'deliver', kind: directive.kind, result }); return result; },
        async observe(input) { const result = await workers.observe(input); log({ call: 'observe-session', state: result.session.state }); return result; },
        async activate(invocation, delivery, activationEvents) {
          log({ call: 'activate', context: invocation.context, promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160), review: invocation.review ?? null, handoff: invocation.handoff ?? null,
            repairSection: invocation.prompt.includes('Factory repair (correction'), humanSection: invocation.prompt.includes('Human requests from configured operators') });
          if (!guard(invocation.context, invocation.review)) throw new Error('RECIPE_ONE_SHOT_GUARD');
          if (invocation.context.role === 'builder') activations++;
          const handle = await workers.activate(invocation, delivery, activationEvents);
          const role = invocation.context.role;
          void handle.completed.then(done => log({ call: 'completed', role, phaseId: invocation.context.phaseId, status: done.status, ...(done.status === 'failure' ? { code: done.code } : {}) }),
            () => log({ call: 'completion-uncertain', role }));
          return handle;
        } } } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const startedAt = Date.now();
  const deadline = startedAt + deadlines[phase] * 60 * 1000;
  let outcome = { done: false, success: false };
  const initial = await shown();
  const before = { reviews: requestsOf(initial, 'HUMAN_CHANGES_REQUESTED').length, repairs: requestsOf(initial, 'EXPLICIT_REPAIR').length };
  const correctionsBefore = (initial?.corrections ?? []).length;
  const steps = stepsOf[phase];
  let observed = 0;
  let asked: { step: number; at: number } | null = null;
  let quietFrom: number | null = null;
  const surfaced = new Map<string, number>();
  try {
    if (phase === 'withdraw') {
      const paused = await control.accept({ request_id: `${revision}-withdraw-pause`, operation: 'pause', origin: 'local-cli' });
      log({ call: 'pause', paused });
    }
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 15000));
      const work = await shown();
      // Real run q23-feedback-v3: surface a Builder Question once (exact id/text and the operator's answer command) and wait, bounded.
      const asking = builderQuestion(work);
      if (asking && !surfaced.has(asking)) {
        const shownQuestion = await control.inspect({ kind: 'question', question_id: asking }) as { kind: string; question?: { publication: { state: string }; content: { question: string; context: string } } };
        if (shownQuestion.kind === 'question' && shownQuestion.question?.publication.state === 'published') {
          surfaced.set(asking, Date.now());
          await save(`operator-question-requested-${surfaced.size}`, { questionId: asking, question: shownQuestion.question.content.question, context: shownQuestion.question.content.context,
            command: `gh issue comment ${ticket.number} --repo ${repository.repository} --body '/factory answer ${asking} <your answer>'   # operator account; never the App`,
            at: new Date().toISOString(), waitMinutes: humanStepMinutes });
        }
      }
      if (asking && surfaced.has(asking) && Date.now() > surfaced.get(asking)! + humanStepMinutes * 60 * 1000) throw new Error('RECIPE_OPERATOR_ANSWER_TIMEOUT');
      const step = steps[observed];
      if (step !== undefined) {
        // Step 3 is asked only once the step-2 repair Execution has STARTED (feedback DURING the activity); step 5 once step 4 opened a correction.
        const ready = step === 3 ? Boolean(work?.execution?.request.repair && work.execution.state === 'started') : step === 5 ? Boolean(work?.correction) : true;
        if (!asked && ready) {
          asked = { step, at: Date.now() };
          await save(`human-step-${step}-requested`, { step, action: humanSteps[step].action, command: humanCommand(step, work?.pullRequest?.number ?? 0), expect: humanSteps[step].expect,
            pullRequest: work?.pullRequest ?? null, at: new Date().toISOString(), waitMinutes: humanStepMinutes,
            note: 'Operator: run this with YOUR OWN gh login now; the phase is waiting. Nobody merges in this step.' });
        }
        if (asked && humanObserved(step, work, before)) {
          await save(`human-step-${step}-observed`, { step, at: new Date().toISOString(), requests: work?.feedback?.requests ?? [] });
          observed++; asked = null;
          if (step === 3 || step === 4) before.reviews++;
          if (step === 2) before.repairs++;
        } else if (asked && Date.now() > asked.at + humanStepMinutes * 60 * 1000) throw new Error(`RECIPE_HUMAN_STEP_${asked.step}_TIMEOUT`);
        if (observed < steps.length) continue;
      }
      if (phase === 'withdraw' && observed === steps.length && quietFrom === null) {
        const unpaused = await control.accept({ request_id: `${revision}-withdraw-unpause`, operation: 'unpause', origin: 'local-cli' });
        log({ call: 'unpause', unpaused });
      }
      if (quietFrom === null && (phase === 'withdraw' ? observed === steps.length : !work?.correction && (work?.corrections ?? []).length > correctionsBefore)) quietFrom = Date.now();
      outcome = settled(phase, work, { activations, stepsObserved: observed, correctionsBefore, resumes: [...surfaced.keys()].filter(id => id !== builderQuestion(work)).length,
        quietCyclesDone: quietFrom !== null && Date.now() - quietFrom >= quietCycles * pollingSeconds * 1000 });
      if (outcome.done) break;
    }
  } finally {
    // Withdraw: the installation is never left paused by this recipe, whatever happened above (recorded).
    if (phase === 'withdraw') {
      const unpaused = await control.accept({ request_id: `${revision}-withdraw-unpause`, operation: 'unpause', origin: 'local-cli' }).catch((error: unknown) => ({ error: String(error).slice(0, 200) }));
      log({ call: 'unpause-finally', unpaused });
      await save('withdraw-unpause', { unpaused, at: new Date().toISOString() }).catch(() => {});
    }
    const final = await control.inspect({ kind: 'list' }).catch(() => null);
    stop.abort();
    const result = await running.catch(() => ({ kind: 'failed' as const }));
    // Every boot this phase started is observed (and stopped when still active) and its cessation recorded, whatever happened above.
    const cessation: unknown[] = [];
    for (const item of boots) {
      // An uncertain start is observed by its environment: the boot the environment published (if any) is the one stopped.
      const seen = await sandbox.observe({ environment: item.environment as never, ...(item.boot ? { boot: item.boot as never } : {}) })
        .catch((error: unknown) => ({ condition: 'unknown', error: String(error).slice(0, 200) }));
      const boot = item.boot ?? ((seen as { boot?: unknown }).boot ? String((seen as { boot?: unknown }).boot) : null);
      const stopped = (seen as { condition?: string }).condition === 'active' && boot
        ? await sandbox.stop({ environment: item.environment as never, boot: boot as never, reason: `${revision} ${phase} finally` }).catch((error: unknown) => ({ error: String(error).slice(0, 200) })) : null;
      cessation.push({ ...item, observedBoot: boot, observed: seen, stopped, unresolved: (seen as { condition?: string }).condition === 'active' && !boot });
    }
    await save(`${phase}-cessation`, { boots: cessation, at: new Date().toISOString() }).catch(() => {});
    await save(`${phase}-result`, { status: outcome.success ? 'success' : 'held', outcome: result, final, events, deadlineReached: Date.now() >= deadline, stepsObserved: observed }).catch(() => {});
  }
  if (!outcome.success) throw new Error('PHASE_NOT_AS_EXPECTED');
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (ticket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  const github = ['preflight', 'run', 'review', 'command', 'withdraw', 'inspect'].includes(phase);
  if (github) await requireKeySource(path => fs.access(path)); // before ANY effect
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  // The tombstone precedes every other effect of the phase (directories, key copy, GitHub, VM, model).
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  let copied = false;
  try {
    if (phase === 'preflight') { await fs.mkdir(`${observations}/credentials`, { mode: 0o700 }); await fs.mkdir(`${observations}/run`, { mode: 0o700 }); }
    if (github) {
      const { constants } = await import('node:fs');
      await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
      copied = true;
      await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
    }
    if (phase === 'preflight') {
      const { github: access, tracker, codeRepository } = await compose();
      const owner = await access.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}`));
      if (!owner.ok) { await save('preflight-held', { owner }); throw new Error('PRECONDITION_HELD'); }
      const operator = resolveOperator(owner.value, operatorLogin);
      const listing = await tracker.listCandidates(repository);
      if (listing.kind !== 'observed' || listing.candidates.length !== 1 || listing.candidates[0]!.number !== ticket.number || listing.repositoryId !== ticket.repositoryId) {
        await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD');
      }
      const issue = await tracker.readTicket(listing.candidates[0]!);
      const raw = await access.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${ticket.number}`));
      const title = raw.ok && raw.value && typeof raw.value === 'object' ? (raw.value as { title?: unknown }).title : undefined;
      const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [], refs: true, base: repository.base });
      const associated = publication.kind === 'observed' ? publication.issues[String(ticket.number)] : undefined;
      const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
      const factoryBranches = refs ? Object.keys(refs).filter(ref => ref.startsWith(`refs/heads/factory/${ticket.number}-`)) : null;
      const app = await access.appIdentity(repository);
      if (publication.kind !== 'observed' || associated?.completeness !== 'complete' || associated.candidates.length || !refs || factoryBranches?.length ||
        !refs[`refs/heads/${repository.base}`] || publication.baseProtection?.state !== 'pull-request-required' || !app || issue.kind !== 'observed' || title !== ticket.title) {
        await save('preflight-held', { publication, factoryBranches, app, issue, title }); throw new Error('PRECONDITION_HELD');
      }
      await save('preflight-result', { status: 'success', operators: [operator], issue, base: { state: 'present', sha: refs[`refs/heads/${repository.base}`] }, refs,
        baseProtection: publication.baseProtection, app, associatedPullRequests: 0 });
      return;
    }
    const preflight = await load('preflight-result');
    const operators = preflight?.operators as { login: string; id: number }[] | undefined;
    if (!Array.isArray(operators) || operators.length !== 1) throw new Error('OPERATOR_IDENTITY_UNRESOLVED');
    if (phase === 'run' || phase === 'review' || phase === 'command' || phase === 'withdraw') { await runControl(phase, save, operators); return; }
    // inspect / stop-environment: a private COPY of the storage (the original is never written).
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const stopped = new AbortController(); stopped.abort();
    await stored.run(stopped.signal);
    const work = workOf(list);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    const { needsStop } = await import('./builder09-qualification.js');
    if (phase === 'inspect') {
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const sessions: Record<string, unknown>[] = [];
      const pushes: string[] = [];
      for (const execution of [...work.previousExecutions, work.execution]) {
        if (!execution.dispatch.boot) continue;
        const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
        for (const launch of (await fs.readdir(runtime).catch(() => [])).filter(name => name.startsWith('w-')).sort().slice(0, 12)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            if (!('text' in read)) { sessions.push({ executionId: execution.executionId, launch, file: String(file), ...read }); continue; }
            const calls = sessionCommands(read.text);
            pushes.push(...calls.flatMap(call => call.command ? [call.command] : []));
            sessions.push({ executionId: execution.executionId, launch, file: String(file), calls, tokenPattern: /gh[pousr]_[A-Za-z0-9_]{20,}|PRIVATE KEY/.test(read.text) });
          }
        }
      }
      const { github: access, tracker, codeRepository } = await compose();
      const head = work.publication?.pullRequest?.headSha ?? null;
      const contents = head ? await access.read(repository, 'publication-read', session => session.get(`/repos/${repository.repository}/contents/docs/FACTORY_FEEDBACK.md?ref=${head}`)) : null;
      const pull = work.publication?.pullRequest ? await codeRepository.readPullRequest({ repo: repository, number: work.publication.pullRequest.number }) : null;
      const feedback = work.publication?.pullRequest ? await codeRepository.readFeedback!({ repo: repository, number: work.publication.pullRequest.number }) : null;
      const issue = await tracker.readTicket(work.ticket as GitHubTicketRef);
      await save('inspect-result', { work: { work_id: work.work_id, branch: work.branch, pullRequest: work.pullRequest, publication: work.publication, impediments: work.impediments,
        budget: work.budget, correction: work.correction, corrections: work.corrections ?? [], feedback: work.feedback ?? null, queue: work.queue, readiness: work.readiness ?? null,
        history: work.history.filter(item => /^(publication|repair|correction|budget|feedback|resume)/.test(item.event)) },
      executions: [...work.previousExecutions, work.execution].map((item: ExecutionView) => ({ executionId: item.executionId, phase: item.dispatch.phase, request: item.request,
        credential: item.credential, charge: item.charge, end: item.end, held: item.held, finalCapture: item.review?.rounds.at(-1)?.handoff.summary ?? null })),
      fileAtHead: contents, pull, feedback, pushViolations: pushViolations(pushes, [...work.previousExecutions, work.execution].flatMap((item: ExecutionView) => item.request.publication ? [{
        branch: item.request.publication.branch, head: item.request.publication.head,
        expected: item.request.publication.expectedRemote.state === 'present' ? item.request.publication.expectedRemote.sha : null }] : [])), sessions, issue, preflight });
      return;
    }
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q23 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    // The namespace's key copy lives only for this phase.
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

type SavedPhase = { status?: unknown; final?: { works?: WorkView[] }; events?: { call?: string; context?: { role?: string } }[] } | null;
type Check = { id: string; passed: boolean; observed: string };
/**
 * Real run q23-feedback-v3, re-scored OFFLINE from the saved review/command results (no GitHub, no storage write): what the run proved up to
 * the Builder's Question in the command phase. The phase ended HELD because the v2 oracle treated a Builder Question as an end (fixed: it now
 * waits for the operator's answer); the Question itself came from a product gap (fixed: reviewers receive the accepted operator requests).
 */
export function verdictV2(saved: { review: SavedPhase; command: SavedPhase; issue: number }): { proven: Check[]; notProven: string[] } {
  const review = saved.review?.final?.works?.[0];
  const command = saved.command?.final?.works?.[0];
  const check = (id: string, passed: boolean, observed: string): Check => ({ id, passed, observed: observed.slice(0, 300) });
  const first = (review?.corrections ?? [])[0];
  const requests = command?.feedback?.requests ?? [];
  const started = (command?.history ?? []).map(item => item.event).lastIndexOf('execution-started');
  const recorded = (command?.history ?? []).map(item => item.event).lastIndexOf('feedback-recorded');
  const ended = (command?.history ?? []).map(item => item.event).lastIndexOf('execution-ended');
  const builders = (saved.command?.events ?? []).filter(item => item.call === 'activate' && item.context?.role === 'builder').length;
  const second = command?.correction ?? null;
  const reply = command?.feedback?.replies?.[0];
  return {
    proven: [
      check('review-one-correction', saved.review?.status === 'success' && (review?.corrections ?? []).length === 1 && first?.outcome === 'published' && first.charged === true &&
        first.reasons.every(item => item.code === 'HUMAN_CHANGES_REQUESTED'), `${review?.corrections?.length ?? 0}:${first?.outcome}:${first?.charged}`),
      check('review-request-treated-not-recharged', (review?.feedback?.requests ?? []).length === 1 && review?.feedback?.requests[0]?.state === 'treated' &&
        review?.budget?.corrections.consumed === 1, `${review?.feedback?.requests.map(item => item.state).join(',')}:consumed ${review?.budget?.corrections.consumed}`),
      check('command-explicit-repair-recorded', requests.some(item => item.code === 'EXPLICIT_REPAIR' && item.feedback.origin === 'github-comment' && item.feedback.author?.login === operatorLogin),
        requests.map(item => `${item.code}:${item.state}`).join(',')),
      check('command-reply-published-on-ticket', reply?.publication.state === 'published' && Boolean(reply.publication.comment?.url.includes(`/issues/${saved.issue}#issuecomment-`)),
        `${reply?.publication.state}:${reply?.publication.comment?.url ?? ''}`),
      check('command-correction-human-feedback-charged-once', second?.trigger === 'human-feedback' && second.consumed === true && command?.budget?.corrections.consumed === 2,
        `${second?.trigger}:${second?.consumed}:consumed ${command?.budget?.corrections.consumed}`),
      check('command-review-during-activity-recorded-not-injected', started >= 0 && started < recorded && recorded < ended && builders === 1 &&
        requests.some(item => item.code === 'HUMAN_CHANGES_REQUESTED' && item.state === 'pending'), `started ${started} < recorded ${recorded} < ended ${ended}; builders ${builders}`),
    ],
    notProven: ['continuation of the SAME correction for the during-activity review (the phase ended at the Builder Question)', 'withdraw: steps 4/5 (pause, request, approval -> withdrawn without charge)'],
  };
}

type SavedInspect = { executions?: ExecutionView[]; fileAtHead?: { ok?: boolean; value?: { content?: string } } | null; pushViolations?: string[];
  sessions?: { tokenPattern?: boolean }[]; feedback?: { kind?: string; reviews?: { reviewId: number; state: string }[] } | null; work?: { readiness?: { stages?: { humanReview?: string } } | null } } | null;
/**
 * Real run q23-feedback-v3, scored OFFLINE from the saved phase results only (no GitHub, no storage write), against every acceptance criterion
 * the real boundary can show. Each check names what it saw.
 */
export function verdictV3(saved: { review: SavedPhase; command: SavedPhase; withdraw: SavedPhase; inspect: SavedInspect; issue: number;
  bodies: Record<1 | 2 | 3 | 4, string> }): { passed: boolean; checks: Check[] } {
  const check = (id: string, passed: boolean, observed: string): Check => ({ id, passed, observed: observed.slice(0, 300) });
  const final = (phase: SavedPhase) => phase?.final?.works?.[0];
  const review = final(saved.review), command = final(saved.command), withdraw = final(saved.withdraw);
  const builders = (phase: SavedPhase) => (phase?.events ?? []).filter(item => item.call === 'activate' && item.context?.role === 'builder').length;
  const requests = withdraw?.feedback?.requests ?? [];
  const byBody = (body: string) => requests.find(item => body.includes(item.feedback.content.replace(/^\/factory repair\s+/, '')) || item.feedback.content === body.replace(/^\/factory repair\s+/, ''));
  const [r1, r2, r3, r4] = ([1, 2, 3, 4] as const).map(step => byBody(saved.bodies[step]));
  const corrections = withdraw?.corrections ?? [];
  const history = command?.history ?? [];
  const index = (event: string, detail?: string) => history.findIndex(item => item.event === event && (!detail || ('detail' in item && String(item.detail).includes(detail))));
  const executions = saved.inspect?.executions ?? [];
  const continuation = executions.find(item => item.request.resume?.reason === 'REPAIR_REQUESTED' && item.charge?.state === 'preserved');
  const file = saved.inspect?.fileAtHead?.value?.content ? Buffer.from(saved.inspect.fileAtHead.value.content, 'base64').toString('utf8') : '';
  const all = [saved.review, saved.command, saved.withdraw];
  const checks = [
    check('phases-success', all.every(item => item?.status === 'success'), all.map(item => String(item?.status)).join(',')),
    check('AC1-only-operator-requests', requests.length === 4 && requests.every(item => item.feedback.author?.login === operatorLogin && item.feedback.author.id !== null) &&
      r2?.feedback.origin === 'github-comment', requests.map(item => `${item.feedbackId}:${item.feedback.origin}:${item.feedback.author?.login}`).join(',')),
    check('AC2-identity-origin-version-content', [r1, r2, r3, r4].every(item => item && item.feedback.url && /^[0-9a-f]{40}$/.test(item.feedback.version ?? '') && item.feedback.content.length > 0 &&
      item.feedback.sha256.length === 64), [r1, r2, r3, r4].map(item => `${item?.feedbackId}@${item?.feedback.version?.slice(0, 8)}`).join(',')),
    check('AC3-review-survives-push-treated-once', (review?.corrections ?? []).length === 1 && r1?.state === 'treated' &&
      corrections.filter(item => item.reasons.some(reason => reason.subject === r1.feedbackId)).length === 1, `r1 ${r1?.state}; corrections with r1: ${corrections.filter(item => item.reasons.some(reason => reason.subject === r1?.feedbackId)).length}`),
    check('AC3-approval-withdraws-only-its-trigger', r4?.state === 'withdrawn' && r4.outcome === 'APPROVED_LATER' && [r1, r2, r3].every(item => item?.state === 'treated') &&
      saved.inspect?.work?.readiness?.stages?.humanReview === 'human-stage', `r4 ${r4?.state}:${r4?.outcome}; others ${[r1, r2, r3].map(item => item?.state).join(',')}`),
    check('AC4-during-activity-same-correction-preserved-charge', Boolean(r3 && r2 && r3.correctionId === r2.correctionId) && index('repair-continued') > index('feedback-recorded', 'review:') &&
      continuation?.charge?.correctionId === r2?.correctionId && (continuation?.request.repair?.reasons ?? []).some(item => item.subject === r3?.feedbackId),
      `r2/r3 correction ${r2?.correctionId?.slice(0, 8)}/${r3?.correctionId?.slice(0, 8)}; continuation ${continuation?.executionId.slice(0, 8)} ${continuation?.charge?.state}`),
    check('AC4-no-injection-one-builder-at-a-time', builders(saved.command) === 4 && builders(saved.withdraw) === 0, `command ${builders(saved.command)}, withdraw ${builders(saved.withdraw)}`),
    check('AC5-requests-addressed-no-question', file.includes('Requested by an operator review.') && file.includes('Repaired by explicit request.') &&
      file.includes('See also: docs/FACTORY_FEEDBACK.md#steps') && !file.includes('(withdrawn)') && !(withdraw?.impediments ?? []).some(item => item.code === 'QUESTION_PENDING'),
      file.split('\n').filter(line => /Requested|Repaired|See also|withdrawn/.test(line)).join(' | ')),
    check('AC6-comment-command-answered-on-ticket', (withdraw?.feedback?.replies ?? []).some(item => item.publication.state === 'published' &&
      Boolean(item.publication.comment?.url.includes(`/issues/${saved.issue}#issuecomment-`)) && item.body.includes('accepted')), (withdraw?.feedback?.replies ?? []).map(item => item.publication.comment?.url ?? '').join(',')),
    check('AC7-consolidation-charged-without-duplicate', withdraw?.budget?.corrections.consumed === 2 && corrections.length === 3 && corrections.filter(item => item.charged).length === 2 &&
      corrections[2]?.outcome === 'withdrawn' && corrections[2].charged === false, `consumed ${withdraw?.budget?.corrections.consumed}; ${corrections.map(item => `${item.outcome}:${item.charged}`).join(',')}`),
    check('leased-pushes-no-token', (saved.inspect?.pushViolations ?? []).length === 0 && (saved.inspect?.sessions ?? []).every(item => item.tokenPattern === false),
      `violations ${(saved.inspect?.pushViolations ?? []).length}`),
  ];
  return { passed: checks.every(item => item.passed), checks };
}
