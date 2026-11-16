import type { ExecutionView, WorkView } from '../../src/control/index.js';
import { readBounded, sessionCommands, snapshotStorage } from './publication14-qualification.js';
import { keySource, pushViolations, requireKeySource, resolveOperator } from './humanchanges21-qualification.js';

// TEST ONLY. Ticket 22 one-shot real qualification recipe: an EFFECTIVE impediment of the Factory's own PR (a confirmed merge conflict) is
// repaired ONCE, charged to the corrections budget, on the SAME PR; a mere base advance triggers nothing. Import and `--plan` are inert.
// Every other phase is a REAL effect and needs an explicit operator grant: real GitHub (App), a real Gondolin/KVM VM and the real model.
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.
// GitHub WRITES by the Factory side: the Builder (guest, direct, its own `builder-publish` grant) pushes ONLY its own branch, ALWAYS with
// `--force-with-lease=refs/heads/<branch>:<exact expected oid>` (empty only at creation), and creates/edits ONE draft PR. The HUMAN steps
// (two small PRs of the operator merged into main) are made by the operator with the operator's own account — never the App, never this
// recipe. The Factory never merges, approves, marks ready, bypasses or changes base protection/rules.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q22-repair-v1`;
const revision = 'q22-repair-v1';
const phases = ['preflight', 'run', 'advance', 'conflict', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent',
  /** One correction is enough for this scenario; a second effective impediment would be blocked by the budget, never retried. */
  correctionLimit: 1 };
/**
 * The NEW synthetic issue the supervisor creates after the operator's authorization (title/body below, label `ready-for-agent`, no other
 * open issue with that label). `number` MUST be pinned in a reviewed commit before preflight: 0 refuses every phase (TICKET_NOT_PINNED).
 */
export const ticket = { number: 31, repositoryId: 1256893534, title: 'Factory qualification: repair a merge conflict of the Factory pull request' } as const;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const operatorLogin = 'Sanmoo';
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const deadlines = { run: 80, advance: 40, conflict: 100 } as const;
/** How long a phase waits for a HUMAN step (the merge into main) once it asked for it; then the phase is held (consumed, no retry). */
const humanStepMinutes = 30;
/** Polling cycles observed after the human step (advance) or after the closed correction (conflict) to show that nothing else triggers. */
const quietCycles = 3;
const rounds = { max: 4 } as const;
const pollingSeconds = 120;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. Never push, open pull requests or change GitHub state, EXCEPT inside a publication activation the Factory requests ' +
    '(a Factory publication instruction): then follow it and the pr skill exactly (your own branch, the verified commit, the explicit lease, ONE draft pull ' +
    'request) and never merge, approve, mark ready or touch anything else. Never rewrite or drop commits you did not make. Report blockers instead of working around them.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const skillPack = 'factory-skills-v6' as const;
/** Proposed body of the NEW issue (documentation only; one documented gate that also holds after the conflict is resolved). */
export const ticketBody = [
  'Add a short documentation page `docs/FACTORY_REPAIR.md`. This exact upper-case file name was decided by the operator.',
  '', 'Required content:',
  '1. A `# Factory repair` title and one paragraph explaining that this file exists only to exercise how the Software Factory repairs its own pull request.',
  '2. A `## Steps` section with a numbered list of exactly three steps: publish, conflict, repair.',
  '', 'If the base branch already contains this file when you work on it, keep every line it already has and add the required content to it.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Do not create or edit other files. Commit the change on your branch.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && test -f docs/FACTORY_REPAIR.md && grep -q \'^## Steps\' docs/FACTORY_REPAIR.md`'].join('\n');
/**
 * The HUMAN steps: the operator's own small PRs merged into main with the operator's account (the Factory never merges). Step 1 touches
 * ANOTHER file (base merely advances: no trigger); step 2 adds the SAME path with other content (add/add: GitHub confirms a conflict).
 */
export const humanSteps = {
  1: { phase: 'advance', file: 'docs/FACTORY_REPAIR_BASE_NOTE.md', lines: ['# Base note', '', 'Added on main by the operator (ticket 22 qualification, step 1): the base merely advances.'],
    expect: 'no correction, no Builder activation, no budget consumed' },
  2: { phase: 'conflict', file: 'docs/FACTORY_REPAIR.md', lines: ['# Factory repair (base)', '', 'Added on main by the operator (ticket 22 qualification, step 2): conflicts with the Factory branch.'],
    expect: 'GitHub reports the Factory PR as not mergeable (conflict) -> ONE correction -> repair -> leased update of the SAME PR' },
} as const;
export const humanCommands = (step: 1 | 2, expectedMain: string) => {
  const branch = `q22-human-${step}`;
  return [
    `git clone --quiet https://github.com/${repository.repository}.git /tmp/${branch} && cd /tmp/${branch}`,
    `test "$(git rev-parse origin/${repository.base})" = "${expectedMain}"   # the base tip the phase expects; stop if it differs`,
    `git switch --quiet -c ${branch} origin/${repository.base}`,
    `printf '%s\\n' ${humanSteps[step].lines.map(line => `'${line}'`).join(' ')} > ${humanSteps[step].file}`,
    `git add ${humanSteps[step].file} && git commit --quiet -m 'docs: ticket 22 qualification human step ${step}'`,
    `git push --quiet origin ${branch}   # the operator's OWN branch with the operator's credentials; never a Factory branch, never --force`,
    `gh pr create --repo ${repository.repository} --base ${repository.base} --head ${branch} --title 'q22 human step ${step}' --body 'Operator step of the ticket 22 qualification.'`,
    `gh pr merge ${branch} --repo ${repository.repository} --squash --delete-branch   # the OPERATOR merges the operator's own PR (see repositorySetup: own bypass or the temporary relaxation; never the App)`];
};

export function plan() {
  return { revision, root, observations, phases, repository, ticket: { ...ticket, body: ticketBody, label: repository.label, pinned: ticket.number > 0 }, operators: [operatorLogin],
    configuration, guestAssets, skillPack, humanSteps,
    keyLifecycle: `each GitHub phase copies ${keySource} O_EXCL into the namespace only AFTER its phase guard and intent tombstone, and removes the copy in its finally`,
    requires: ['tickets 21 and 22 integrated in the composed revision', `${keySource} present (copied O_EXCL into the namespace; missing = loud refusal before any effect)`,
      'the supervisor created the NEW issue (title/body above, label ready-for-agent) and pinned its number in a reviewed commit', 'no other open issue carries the label',
      'main protected with NO bypass for the App (as in tickets 14/16/17/21): pull requests required',
      'the OPERATOR can merge the operator\'s own two small PRs into main (see repositorySetup)', 'operator first-login store under root/credentials (model OAuth)'],
    repositorySetup: ['No required check, workflow or new rule is needed: the effective impediment is a merge conflict the operator induces by merging, through a PR of the ' +
      'operator\'s own account, a commit to main that adds the same file the Factory adds.',
      'Ruleset 26435808 on main has `pull_request` (1 approval) and, when re-enabled as in ticket 39, `update` (Restrict updates): either blocks the operator\'s own merges. ' +
        'With the operator\'s authorization, EITHER the operator merges the two human-step PRs with the operator\'s own bypass (never the App, which has none), OR the supervisor ' +
        'disables `update` and sets approvals to 0 only for the two human merges and restores both right after step 2 is observed (record before/after). The App keeps NO bypass.',
      'While `update` is active the Factory PR is merge-blocked (ticket 39, operator only): that is never repaired; the conflict is repaired independently.',
      'Not covered here (would need the operator to add a required status check, e.g. a trivial workflow + a ruleset requiring it): REQUIRED_CHECK_FAILED and STRICT_UPDATE_REQUIRED ' +
        'on the real boundary; they are covered at rule/flow level only.'],
    model: { provider: 'openai', model: 'gpt-6-luna', auth: 'factory-oauth', providerRetries: 0, sdkRetries: 0,
      builderActivations: { run: ['implementation', 'publication'], advance: [], conflict: ['repair (continue or replacement session)', 'publication (leased update)'] },
      reviewersPerImplementation: `standards + spec, at most ${rounds.max} rounds each (run and the repair)` },
    github: { app: githubApp, accessRoot: `${observations} (own namespace: credentials/ copy of ${keySource}, run/); never y5/run`,
      writes: ['Builder (guest, direct, builder-publish): run — 1 push creating refs/heads/factory/<n>-<work8> with --force-with-lease=<ref>: (absent) and 1 draft PR (marker, Closes #<n>)',
        'Builder: conflict — 1 push of the repaired head with --force-with-lease=refs/heads/<branch>:<published head H1> and 1 PR description edit of the SAME PR',
        'App: access_tokens issuance POSTs and DELETE /installation/token revocations', 'controller: none (no comment, label, draft/ready conversion: setDraft is stubbed as not sent)'],
      human: ['step 1 (during advance): the operator merges a PR of the operator\'s own branch adding docs/FACTORY_REPAIR_BASE_NOTE.md into main',
        'step 2 (during conflict): the operator merges a PR of the operator\'s own branch adding docs/FACTORY_REPAIR.md (other content) into main'],
      humanCommands: 'written into human-step-<k>-requested.json with the exact expected main tip (clone, verify tip, own branch, commit, push own branch, gh pr create, gh pr merge)',
      never: ['merge of the Factory PR', 'approval', 'ready-for-review conversion', 'bare --force or a lease without an explicit oid', 'push to main or any other branch',
        'rewrite of the base', 'change of base protection, rulesets, workflows or required checks', 'labels/assignees', 'closing the issue or the PR', 'branch deletion/cleanup',
        'any write by this recipe itself'] },
    effects: [
      'preflight: key source check BEFORE any effect; exclusive namespace with its own GitHub access root; read-only: operator id pinned, label lists exactly the pinned issue, no ' +
        'associated PR, no factory/<n>- branch, main requires PRs without App bypass, App bot identity, every branch/tag tip (main tip B0)',
      'run: new storage; implementation (reviews, verification) -> discovery absent -> ONE publication activation -> own draft PR linked (published head H1)',
      `advance: same storage, new owner; human step 1 (main B0 -> B1, another file) is waited for, then ${quietCycles} polling cycles with the checks explanation of H1 re-read: ` +
        'no correction, no activation, budget untouched (a base advancing is never a trigger; loose lag only visible)',
      'conflict: same storage, new owner; human step 2 (main B1 -> B2, same file) -> GitHub reports mergeable=false -> repair desk opens ONE correction (MERGE_CONFLICT, ' +
        'repair sequence 1) -> fresh re-read immediately before admission -> repair Execution (continue/replacement session; base update onto exactly B2; gates; reviews against B2) ' +
        `-> discovery: update with lease H1 -> publication activation -> linked H2 on the SAME PR -> correction closed (published), no CI wait; ${quietCycles} more cycles: no second correction`,
      'inspect: storage copy; read-only GitHub: own PR (same number, head H2, mergeable), branch tip, compare B2...H2 (H2 contains B2), file content at H2; session bash push commands',
      'stop-environment: own boot of the last recorded Execution when it may still run'],
    guards: ['one-shot intent tombstones and phase order', 'per-phase Builder sequence (phaseIds); advance refuses ANY activation', 'reviewers only for the implementation/repair Execution of the phase',
      'builder-publish only while Control requested the publication (<= 2 per publication activation)', 'prepare <= Builder activations of the phase', 'no retry, no remove/cleanup',
      `human steps wait at most ${humanStepMinutes} min, then the phase is held`],
    expected: [
      'run: published, head H1 = verified head; attempts [{H1, expectedRemote absent}]; budget corrections {limit 1, consumed 0}',
      'advance: main tip B1 observed; work.correction null, corrections [], no activation, budget corrections consumed 0; checks explanation of H1 with notes ⊇ LOOSE_BRANCH_BEHIND_BASE ' +
        '(or conflict none); history without correction-opened',
      'conflict: correction reasons [MERGE_CONFLICT main @H1 base-tip B2]; repair Execution request.resume.reason REPAIR_REQUESTED, request.repair.correctionId = that correction, ' +
        'charge {correction, consumed}; prompt contains "Factory repair (correction" and "FETCH_HEAD is exactly B2"; handoff.baseCommit B2; builder-start grant only; publication prompt ' +
        '--force-with-lease=refs/heads/<branch>:H1 origin H2; linked head H2 on the SAME PR number; corrections [{outcome published, charged true, head H2}]; budget corrections consumed 1; ' +
        `correction-opened 1, repair-revalidated 1, correction-closed 1; after ${quietCycles} cycles still one correction and no new activation`,
      'inspect: B2 is an ancestor of H2 (compare ahead/identical), docs/FACTORY_REPAIR.md at H2 keeps the operator line and has ## Steps; every session push names its exact lease; ' +
        'no token in storage/receipts/sessions/observations'],
  };
}

/** Phase order: each phase once and only after the previous one SUCCEEDED (a held phase is consumed and never followed). */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, pinned = ticket.number > 0): string | null {
  if (!pinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  const before: Partial<Record<Phase, Phase>> = { run: 'preflight', advance: 'run', conflict: 'advance' };
  const previous = before[phase];
  if (previous && results[previous]?.status !== 'success') return `${previous.toUpperCase()}_SUCCESS_REQUIRED`;
  if ((phase === 'inspect' || phase === 'stop-environment') && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  return null;
}

type BuilderKind = 'implementation' | 'publication';
type ControlPhase = 'run' | 'advance' | 'conflict';
const implementationPhases: Record<ControlPhase, readonly string[]> = { run: ['builder-initial'], advance: [], conflict: ['builder-continuation', 'builder-recovery'] };
export const builderSequence: Record<ControlPhase, readonly BuilderKind[]> = { run: ['implementation', 'publication'], advance: [], conflict: ['implementation', 'publication'] };
/** Activation guard of one phase: the exact Builder sequence, then reviewers only for that phase's implementation Execution (distinct rounds). */
export function activationGuard(phase: ControlPhase, maxRounds: number = rounds.max) {
  const sequence = builderSequence[phase];
  let next = 0;
  let implementation: { workId: string; executionId: string } | undefined;
  const seen: Record<string, Set<number>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; workId: string; executionId: string; phaseId: string }, review?: { round: number }) => {
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
/** Grant guard: builder-start for the implementation/repair; builder-publish only in phases with a publication, while Control requested it. */
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
/** The human merge the phase waits for: the base tip moved away from `expected`. */
export function baseMoved(expected: string, tip: string | undefined): { kind: 'waiting' } | { kind: 'observed'; sha: string } {
  return tip && tip !== expected && /^[0-9a-f]{40}$/.test(tip) ? { kind: 'observed', sha: tip } : { kind: 'waiting' };
}

/** Whether a Control phase reached its end (or a state that ends it early); `success` says whether it is the expected end. */
export function settled(phase: ControlPhase, work: WorkView | undefined, facts: { activations: number; humanObserved: boolean; quietCyclesDone: boolean }):
  { done: boolean; success: boolean } {
  const state = work?.publication?.state ?? '';
  const stuck = ['blocked', 'not-publishable', 'base-changed', 'diverged'].includes(state) || work?.execution?.state === 'held' ||
    (work?.impediments ?? []).some(item => item.code === 'REPAIR_EVENT_ALREADY_TREATED' || item.code === 'CORRECTION_LIMIT_REACHED');
  if (phase === 'run') return state === 'published' ? { done: true, success: true } : { done: stuck, success: false };
  const corrections = work?.corrections ?? [];
  if (phase === 'advance') {
    const untouched = !work?.correction && corrections.length === 0 && facts.activations === 0 && (work?.budget?.corrections.consumed ?? 0) === 0;
    if (!untouched || stuck) return { done: true, success: false };
    return { done: facts.humanObserved && facts.quietCyclesDone, success: facts.humanObserved && facts.quietCyclesDone };
  }
  const closed = corrections.length === 1 && corrections[0]!.outcome === 'published' && corrections[0]!.charged && !work?.correction && state === 'published';
  if (stuck || corrections.length > 1 || (corrections.length === 1 && corrections[0]!.outcome !== 'published')) return { done: true, success: false };
  if (closed && facts.quietCyclesDone) return { done: true, success: (work?.budget?.corrections.consumed ?? 0) === 1 && facts.activations === 2 };
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

async function runControl(phase: ControlPhase, save: (name: string, data: unknown) => Promise<void>, operators: { login: string; id: number }[], baseBefore: string) {
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
  let prepared = 0;
  let activations = 0;
  let control!: Awaited<ReturnType<typeof openControl>>;
  const shown = async () => workOf(await control.inspect({ kind: 'list' }));
  control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty',
    access: { tracker, repositories: [repository], dependencyRepositories: [], operators, factoryApp: () => github.appIdentity(repository),
      repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base),
        async readPullRequest(query) { const result = await codeRepository.readPullRequest(query); log({ call: 'read-pull-request', unless: Boolean(query.unless), kind: result.kind,
          ...(result.kind === 'observed' ? { head: result.pullRequest.headSha, mergeable: result.pullRequest.mergeable, mergeableState: result.pullRequest.mergeableState } : {}) }); return result; },
        // The Factory PR stays draft in this recipe: no readiness conversion is ever sent (the update path of the same PR requires draft).
        setDraft: async () => ({ kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_NO_READINESS', nextStep: 'This recipe never converts draft/ready; nothing was sent.', revocation: 'not-issued' }),
        async findPublication(correlation) {
          const result = await codeRepository.findPublication(correlation);
          log({ call: 'find-publication', knownBranches: correlation.knownBranches, kind: result.kind, ...(result.kind === 'observed' ? { branches: result.branches } : { code: result.code }) });
          return result;
        } } }, polling: { intervalSeconds: pollingSeconds },
    execution: { configuration, capacity: 1, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 }, reviews: { reviewer, rounds },
      credentials: { async issue(context) {
        const work = await shown();
        const running = Boolean(work?.execution?.request.publication) && work?.execution?.executionId === context.executionId && work.execution.state !== 'ended';
        const allowed = work?.ticket.number === ticket.number && grants(context.purpose, { publicationState: work.publication?.state ?? null, publicationActivation: running });
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
          if (work?.work_id !== input.workId || work.ticket.number !== ticket.number || ++prepared > builderSequence[phase].length) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
          const result = await sandbox.prepare(input);
          log({ call: 'prepare-result', result });
          return result;
        },
        async start(input) { const result = await sandbox.start(input); log({ call: 'start', result }); return result; },
        async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
        async observeProposal(input) { const result = await sandbox.observeProposal(input); log({ call: 'observe-proposal', round: input.round, result }); return result; },
      },
      workers: { async deliver(worker, directive) { const result = await workers.deliver(worker, directive); log({ call: 'deliver', kind: directive.kind, result }); return result; },
        async observe(input) { const result = await workers.observe(input); log({ call: 'observe-session', state: result.session.state }); return result; },
        async activate(invocation, delivery, activationEvents) {
          log({ call: 'activate', context: invocation.context, promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160), review: invocation.review ?? null, handoff: invocation.handoff ?? null,
            repairSection: invocation.prompt.includes('Factory repair (correction') });
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
  let human: { sha: string } | null = phase === 'run' ? { sha: baseBefore } : null;
  let requested = false;
  let quietFrom: number | null = null;
  const step = phase === 'advance' ? 1 : 2;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 15000));
    if (phase !== 'run' && !human) {
      if (!requested) {
        requested = true;
        await save(`human-step-${step}-requested`, { step, expectedMain: baseBefore, file: humanSteps[step].file, commands: humanCommands(step, baseBefore), expect: humanSteps[step].expect,
          at: new Date().toISOString(), note: 'Operator: run these with YOUR OWN credentials now; the phase is waiting. The Factory PR is never merged by anyone in this step.' });
      }
      const read = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [], refs: true });
      const tip = read.kind === 'observed' && read.refs?.state === 'complete' ? read.refs.refs[`refs/heads/${repository.base}`] : undefined;
      const seen = baseMoved(baseBefore, tip);
      if (seen.kind === 'observed') { human = seen; await save(`human-step-${step}-observed`, { step, sha: seen.sha, at: new Date().toISOString() }); }
      else if (Date.now() > startedAt + humanStepMinutes * 60 * 1000) throw new Error('RECIPE_HUMAN_STEP_TIMEOUT');
      continue;
    }
    const work = await shown();
    // Quiet window: advance starts it at the human step; conflict at the closure of the correction.
    if (quietFrom === null && (phase === 'advance' || (work?.corrections ?? []).length > 0)) quietFrom = Date.now();
    outcome = settled(phase, work, { activations, humanObserved: human !== null, quietCyclesDone: quietFrom !== null && Date.now() - quietFrom >= quietCycles * pollingSeconds * 1000 });
    if (outcome.done) break;
  }
  const final = await control.inspect({ kind: 'list' });
  stop.abort();
  const result = await running;
  await save(`${phase}-result`, { status: outcome.success ? 'success' : 'held', outcome: result, final, human, events, deadlineReached: Date.now() >= deadline });
  if (!outcome.success) throw new Error('PHASE_NOT_AS_EXPECTED');
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (ticket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  if (phase === 'preflight') {
    await requireKeySource(path => fs.access(path)); // before ANY effect
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    await fs.mkdir(`${observations}/credentials`, { mode: 0o700 }); await fs.mkdir(`${observations}/run`, { mode: 0o700 });
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  // The namespace's key copy exists only while ONE consumed phase runs: copied after the guard and the intent tombstone, removed in `finally`.
  const usesGitHub = phase !== 'stop-environment';
  try {
    if (usesGitHub) {
      await requireKeySource(path => fs.access(path));
      const { constants } = await import('node:fs');
      await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
      await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
    }
    if (phase === 'preflight') {
      const { github, tracker, codeRepository } = await compose();
      const owner = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}`));
      if (!owner.ok) { await save('preflight-held', { owner }); throw new Error('PRECONDITION_HELD'); }
      const operator = resolveOperator(owner.value, operatorLogin);
      const listing = await tracker.listCandidates(repository);
      if (listing.kind !== 'observed' || listing.candidates.length !== 1 || listing.candidates[0]!.number !== ticket.number || listing.repositoryId !== ticket.repositoryId) {
        await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD');
      }
      const issue = await tracker.readTicket(listing.candidates[0]!);
      const raw = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${ticket.number}`));
      const title = raw.ok && raw.value && typeof raw.value === 'object' ? (raw.value as { title?: unknown }).title : undefined;
      const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [], refs: true, base: repository.base });
      const associated = publication.kind === 'observed' ? publication.issues[String(ticket.number)] : undefined;
      const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
      const factoryBranches = refs ? Object.keys(refs).filter(ref => ref.startsWith(`refs/heads/factory/${ticket.number}-`)) : null;
      const app = await github.appIdentity(repository);
      if (publication.kind !== 'observed' || associated?.completeness !== 'complete' || associated.candidates.length || !refs || factoryBranches?.length ||
        !refs[`refs/heads/${repository.base}`] || publication.baseProtection?.state !== 'pull-request-required' || !app || issue.kind !== 'observed' || title !== ticket.title ||
        refs['refs/heads/q22-human-1'] || refs['refs/heads/q22-human-2']) {
        await save('preflight-held', { publication, factoryBranches, app, issue, title }); throw new Error('PRECONDITION_HELD');
      }
      await save('preflight-result', { status: 'success', operators: [operator], issue, base: { state: 'present', sha: refs[`refs/heads/${repository.base}`] }, refs,
        baseProtection: publication.baseProtection, app, associatedPullRequests: 0 });
      return;
    }
    const preflight = await load('preflight-result');
    const operators = preflight?.operators as { login: string; id: number }[] | undefined;
    if (!Array.isArray(operators) || operators.length !== 1) throw new Error('OPERATOR_IDENTITY_UNRESOLVED');
    if (phase === 'run' || phase === 'advance' || phase === 'conflict') {
      // The base tip each human step starts from: B0 (preflight) for advance, B1 (the observed step 1) for conflict.
      const base = phase === 'conflict' ? (await load('human-step-1-observed') as { sha?: string } | null)?.sha : (preflight?.base as { sha?: string } | undefined)?.sha;
      if (!base) throw new Error('BASE_TIP_UNKNOWN');
      await runControl(phase, save, operators, base);
      return;
    }
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
      const { github, tracker, codeRepository } = await compose();
      const head = work.publication?.pullRequest?.headSha ?? null;
      const conflictBase = (await load('human-step-2-observed') as { sha?: string } | null)?.sha ?? null;
      const compare = conflictBase && head ? await github.read(repository, 'publication-read', session => session.get(`/repos/${repository.repository}/compare/${conflictBase}...${head}`)) : null;
      const contents = head ? await github.read(repository, 'publication-read', session => session.get(`/repos/${repository.repository}/contents/docs/FACTORY_REPAIR.md?ref=${head}`)) : null;
      const pull = work.publication?.pullRequest ? await codeRepository.readPullRequest({ repo: repository, number: work.publication.pullRequest.number }) : null;
      const issue = await tracker.readTicket(work.ticket);
      await save('inspect-result', { work: { work_id: work.work_id, branch: work.branch, pullRequest: work.pullRequest, publication: work.publication, impediments: work.impediments,
        budget: work.budget, correction: work.correction, corrections: work.corrections ?? [], queue: work.queue, checks: work.checks ?? null,
        history: work.history.filter(item => item.event.startsWith('publication') || item.event.startsWith('repair') || item.event.startsWith('correction') || item.event.startsWith('budget')) },
      executions: [...work.previousExecutions, work.execution].map((item: ExecutionView) => ({ executionId: item.executionId, phase: item.dispatch.phase, request: item.request,
        credential: item.credential, charge: item.charge, end: item.end, held: item.held, finalCapture: item.review?.rounds.at(-1)?.handoff.summary ?? null,
        verification: item.review?.verification ?? null })),
      compareConflictBaseToHead: compare, fileAtHead: contents, pull, pushViolations: pushViolations(pushes, [...work.previousExecutions, work.execution].flatMap((item: ExecutionView) => item.request.publication ? [{
        branch: item.request.publication.branch, head: item.request.publication.head,
        expected: item.request.publication.expectedRemote.state === 'present' ? item.request.publication.expectedRemote.sha : null }] : [])), sessions, issue, preflight });
      return;
    }
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q22 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
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
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
