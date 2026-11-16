import type { ExecutionView, ListView, QuestionView, WorkView } from '../../src/control/index.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';
import { resolveOperator } from './humanchanges21-qualification.js';
import { snapshotStorage } from './publication14-qualification.js';

// TEST ONLY. Ticket 34 pre-pilot group R-CRASH-A (V-07.b, V-12.c, V-12.d): the controller is SIGKILLed at the remaining crash cuts WITH REAL
// AGENTS and the next owner reconciles instead of repeating. Same mechanism as crashfx27: each step is ONE controller child launched like the
// production owner (`flock --exclusive --nonblock --no-fork <lock> node …`) on the SAME storage of its line; events are appended durably.
// Import and `--plan` are inert. Every other phase is a REAL effect needing an explicit operator grant: real GitHub (App), real Gondolin/KVM
// VMs, the real model, SIGKILL of Factory processes and ONE cgroup freeze of the Factory's own sandbox unit on the host.
//   cache line (Ticket C, its own storage; no VM boot, no model):
//     c1-cache-cut          SIGKILL inside the host Git cache preparation: right after the fetch credential was self-revoked (fetch done, clone
//                           not done, cache state `mutating`).
//     c2-cache-reconcile    the new owner's boot reconciliation of the interrupted cache (repair-free); the Execution is reconciled as not
//                           started; the next preparation meets the incomplete checkout and is HELD (never adopted, never repaired); clean stop.
//   main line (Ticket M, real Builder + Standards/Spec reviewers, ONE environment):
//     s1-sources-cut        the Builder preserves the request; once spec/v1/ticket.json exists and spec/v1/sources.json does NOT, the orchestrator
//                           freezes the survivor unit (systemctl --user freeze) and SIGKILLs the controller: interrupted BEFORE sources complete.
//     s2-sources-recovery   boot reconciliation stops the frozen survivor (systemd thaws a unit before stopping it), ONE operational recovery
//                           completes the preservation without overwriting it and asks the Ticket's Question; SIGKILL right after the Question
//                           is published and the ask Execution ended (crash-left storage). The operator then answers while the controller is down.
//     t1-tool-cut           the answer is accepted by the BOOTING owner; the answered Execution runs the documented gate (declared 240 s); the
//                           orchestrator SIGKILLs the controller once the gate's start marker exists and its end marker does not.
//     h1-handoff-cut        boot reconciliation stops the survivor (the gate never finishes), ONE operational recovery, gate, handoff; SIGKILL
//                           as soon as the FIRST reviewer completes with an opinion (preserved in Records, the other reviewer still running).
//     f1-final              boot reconciliation, ONE operational recovery, the preserved opinion carried (unchanged proposal), only the missing
//                           reviewer runs; the implementation Execution ends; clean stop BEFORE any publication activation.
// D-05: real session loss is not required (accepted as proven); this recipe does not provoke it.
// GitHub WRITES: controller — ONE Question comment on Ticket M (s2). The operator's answer is a HUMAN step. Never a push, PR, merge, approval,
// ready conversion, label/assignee change, branch deletion or any write by this recipe itself (builder-publish is refused).
// Phases and child steps are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q34-crash-a-v1`;
/**
 * The recipe's OWN Factory root (environments, host Git cache, Records, worker runtime, model OAuth store): never the shared y5 root, so a cache
 * cut or a failed reconciliation can only affect this recipe. It cannot live inside the namespace: worker sockets under <root>/r/<boot>/s/ must
 * stay within 107 bytes, which leaves at most 38 bytes for the root (y5 itself is 37). The operator creates it (setup + login) before preflight.
 */
export const factoryRoot = '/home/sanmoo/software-factory-test/c34';
/** The shared host Git cache other recipes use; this recipe never reads or writes it. */
export const sharedCache = `${root}/cache`;
const setupEntries = ['releases', 'assets', 'credentials', 'data', 'environments', 'run', 'config.yaml'];
const revision = 'q34-crash-a-v1';
export const phases = ['preflight', 'cache', 'sources', 'tool', 'inspect', 'stop-environment'] as const;
export type Phase = typeof phases[number];
export const steps = ['c1-cache-cut', 'c2-cache-reconcile', 's1-sources-cut', 's2-sources-recovery', 't1-tool-cut', 'h1-handoff-cut', 'f1-final'] as const;
export type Step = typeof steps[number];
export type Line = 'cache' | 'main';
export const lineOf = (step: Step): Line => step.startsWith('c') ? 'cache' : 'main';
const phaseSteps: Record<'cache' | 'sources' | 'tool', readonly Step[]> = { cache: ['c1-cache-cut', 'c2-cache-reconcile'], sources: ['s1-sources-cut', 's2-sources-recovery'],
  tool: ['t1-tool-cut', 'h1-handoff-cut', 'f1-final'] };
/** Three operational recoveries are caused on purpose (sources, tool, handoff); one more absorbs a reviewer retry. Explicit, not a grant. */
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent', recoveryLimit: 4 };
/**
 * The TWO new synthetic issues the supervisor creates after the operator's authorization (titles/bodies below, label `ready-for-agent`, no
 * other open issue with that label). Both numbers MUST be pinned in a reviewed commit before preflight: 0 refuses every phase.
 */
export const tickets = {
  main: { number: 0, repositoryId: 1256893534, title: 'Factory qualification: crash cuts with real agents' },
  cache: { number: 0, repositoryId: 1256893534, title: 'Factory qualification: crash while preparing the host Git cache' },
} as const;
export const pinned = (numbers: { main: number; cache: number } = { main: tickets.main.number, cache: tickets.cache.number }) =>
  numbers.main > 0 && numbers.cache > 0 && numbers.main !== numbers.cache;
export const gateMarkers = { started: '.q34a-gate-started', ended: '.q34a-gate-ended' } as const;
export const mainBody = [
  'Add a short documentation page whose file name the OPERATOR decides.',
  '', 'Before creating or editing any file, use the ask_user tool ONCE to ask the operator which of these two names to use: `docs/FACTORY_CRASH_A.md` or ' +
    '`docs/FACTORY_CRASH_B.md`. Do not choose it yourself and do not create either file before the answer.',
  '', 'After the answer, create ONLY the chosen file with a `# Factory crash qualification` title and one paragraph saying it exists to exercise how the Software ' +
    'Factory recovers from controller crashes. Commit it on your branch.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace`, a tool timeout of at least 600 seconds, and put the ' +
    'directory change inside the command; it must exit 0). The gate deliberately waits 240 seconds after writing its start marker: this qualification interrupts ' +
    'the Factory while it runs. Run it exactly as written:',
  `\`cd /workspace/checkout && printf 'started\\n' > /workspace/${gateMarkers.started} && sleep 240 && ls docs/FACTORY_CRASH_A.md docs/FACTORY_CRASH_B.md 2>/dev/null | grep -c . | grep -qx 1 && printf 'ended\\n' > /workspace/${gateMarkers.ended}\``].join('\n');
export const cacheBody = ['This issue exists only so the Software Factory qualification can interrupt the controller while it prepares its host Git cache.',
  '', 'No Builder is ever activated for it and nothing is to be implemented.'].join('\n');
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const operatorLogin = 'Sanmoo';
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const stepDeadlineMinutes: Record<Step, number> = { 'c1-cache-cut': 20, 'c2-cache-reconcile': 20, 's1-sources-cut': 30, 's2-sources-recovery': 40, 't1-tool-cut': 40,
  'h1-handoff-cut': 75, 'f1-final': 75 };
const rounds = { max: 4 } as const;
const pollingSeconds = 60;
const cutPollMs = 250;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const skillPack = 'factory-skills-v6' as const;
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. When you need information or an approval you do not have, use the ask_user tool instead of working around it. Never push, ' +
    'open pull requests or change GitHub state.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final message is ' +
    'ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const node = '/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node';
/** Preserved files hashed at the sources cut; none of them may change afterwards (versions are never overwritten). */
export const preservedFiles = ['spec/v1/ticket.json', 'spec/v1/sources.json', 'instructions/v1/AGENTS.md', 'instructions/v1/sources.json'] as const;

export function plan() {
  return { revision, root, observations, phases, steps, repository, tickets: { main: { ...tickets.main, body: mainBody }, cache: { ...tickets.cache, body: cacheBody }, label: repository.label, pinned: pinned() },
    operators: [operatorLogin], factoryRoot, cacheRoot: `${factoryRoot}/cache/git`, sharedCache,
    operator: { beforePreflight: [`node dist/src/entrypoints/cli.js setup --root ${factoryRoot}`, `node dist/src/entrypoints/cli.js login --root ${factoryRoot}   # model OAuth store of THIS root`],
      afterInspect: `remove ${factoryRoot} once the evidence is kept (its cache and environments belong to this recipe only)` },
    configuration, guestAssets, skillPack, pollingSeconds, gateMarkers, storages: { cache: `${observations}/cache-line/control.sqlite`, main: `${observations}/control.sqlite` },
    requires: [`${root}/${githubApp.privateKeyFile} present`, 'the supervisor created the TWO new issues (titles/bodies above, label ready-for-agent) and pinned both numbers in a reviewed commit',
      'no other open issue carries the label', 'main protected with NO bypass for the App', `a NEW Factory root ${factoryRoot} (operator: setup + login, nothing else in it; its own host Git cache, never ${sharedCache})`,
      'systemd user manager with the cgroup v2 freezer (systemctl --user freeze)', 'explicit operator authorization for THIS run, including host fault injection (SIGKILL, unit freeze); one-shot'],
    model: { provider: 'openai', model: 'gpt-6-luna', auth: 'factory-oauth', providerRetries: 0, sdkRetries: 0, cacheLine: 'none (no Builder is ever activated for Ticket C)',
      builderActivations: { 's1-sources-cut': ['initial'], 's2-sources-recovery': ['operational recovery (asks)'], 't1-tool-cut': ['answered resume'], 'h1-handoff-cut': ['operational recovery'], 'f1-final': ['operational recovery'] },
      reviewers: `standards + spec in h1 (first round only, cut on the first opinion) and f1 (at most ${rounds.max} rounds, one retry per role)` },
    github: { app: githubApp, accessRoot: `${observations} (own namespace: credentials/ copy of ${root}/${githubApp.privateKeyFile}, run/); never y5/run`,
      writes: ['controller: ONE Question comment on Ticket M (s2); every other POST is refused by the recipe guard before sending',
        'App: access_tokens issuance POSTs and DELETE /installation/token revocations (the fetch credential of c1 is revoked BEFORE the cut)'],
      human: ['between the sources and tool phases (controller stopped): on Ticket M, from the operator account, ONE comment `/factory answer <question-id> docs/FACTORY_CRASH_A.md` (question id in sources-result.json)'],
      never: ['push', 'pull request', 'merge', 'approval', 'ready-for-review conversion', 'labels/assignees', 'closing an issue', 'branch deletion/cleanup', 'any write by this recipe itself'] },
    hostEffects: ['SIGKILL of the recipe\'s own controller children (5 cuts)', 'ONE `systemctl --user freeze factory-sandbox-<boot>.service` of the s1 survivor (its own unit; the next owner stops it)',
      `the recipe's OWN host Git cache (${factoryRoot}/cache/git) left \`mutating\` by c1 and reconciled by c2; the shared ${sharedCache} is never touched`],
    effects: [
      'preflight: key source check BEFORE any effect; exclusive namespace; read-only: operator id, the label lists exactly the two pinned issues, no associated PR, no factory/<n>- branch, base protection, App bot identity, cache idle, environments ceased',
      'cache: c1 (SIGKILL after the fetch credential revocation returned, cache `mutating`) then c2 (boot reconciliation of the cache; preparation held, never adopted; clean stop)',
      'sources: s1 (freeze + SIGKILL before spec sources.json) then s2 (survivor stopped, recovery completes the preservation and asks; SIGKILL after the Question is published)',
      'tool: t1 (answer accepted at boot; SIGKILL during the documented gate) then h1 (recovery; SIGKILL at the first reviewer opinion) then f1 (recovery, carried opinion, clean stop)',
      'inspect: storage copies of both lines; preserved artifacts read confined; read-only GitHub: Question comments, PRs of Ticket M; cache state; verdict; secret-shape scan',
      'stop-environment: own boot of the last recorded main Execution when it may still run'],
    guards: ['one-shot intent tombstones per phase AND per child step, phase order', 'per step: Builder phaseIds and reviewer activations allowed', 'postComment: exactly ONE real POST (s2), every other refused',
      'builder-publish always refused', 'prepare at most once per step and only for its line\'s Ticket', 'each line\'s owner sees only its own Ticket', 'no retry, no remove/cleanup'],
    expected: [
      'c1: SIGKILL after `fetch-revoked` with the cache state `mutating`; c2: cache reconciliation `reconciled` (or `kept` with the operator action), the c1 Execution reconciled not-started, the next preparation held PREPARE_CHECKOUT_PREPARATION_INCOMPLETE, no Builder, exit 0',
      's1: SIGKILL with spec/v1/ticket.json present and spec/v1/sources.json absent (frozen survivor); s2: sources.json still absent when the survivor was stopped; the s1 Execution failure CONTROLLER_CRASH, cessation confirmed, operational recovery; the files hashed at the cut unchanged; a complete preservation afterwards',
      's2: ONE Question comment; SIGKILL after it was published and the ask Execution ended; t1: the answer accepted once while the booting owner\'s dispatch was still closed',
      't1: SIGKILL with the gate start marker present and its end marker absent; h1: the end marker still absent after the survivor stop (never finished, never replayed blindly)',
      'h1: SIGKILL right after the first reviewer opinion; f1: that opinion carried into the recovery round (source carried, never re-run) and only the other role reviewed; implementation Execution ends, exit 0',
      'channel loss (s1, t1, h1 each sever a live real worker\'s host channel): the next owner stops THAT boot with confirmed cessation before any new activation (never adopted)',
      'budget: recoveries consumed = confirmed recovery starts, reserved null; no PR; no token anywhere',
      'verdict: `passed` only if every check holds; `inconclusive` when a cut was not reached as designed; `failed` on a duplicate comment, an overwritten preserved file, a re-run carried opinion, an adopted preparation or a PR'],
  };
}

/** Phase order: each phase once and only after the previous one SUCCEEDED (a held phase is consumed and never followed). */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, isPinned = pinned()): string | null {
  if (!isPinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  const before: Partial<Record<Phase, Phase>> = { cache: 'preflight', sources: 'cache', tool: 'sources' };
  const previous = before[phase];
  if (previous && results[previous]?.status !== 'success') return `${previous.toUpperCase()}_SUCCESS_REQUIRED`;
  if ((phase === 'inspect' || phase === 'stop-environment') && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  return null;
}

/** Which Question POSTs a step may send: ONE in s2 (the recovery Builder asks), none anywhere else. */
export function postDecision(step: Step, postedBefore: number): 'send' | 'refuse' {
  return step === 's2-sources-recovery' && postedBefore === 0 ? 'send' : 'refuse';
}

/** Builder phaseIds allowed per step (one Builder activation each); reviewers per step. Publication is never allowed. */
export const builderPhases: Record<Step, readonly string[]> = { 'c1-cache-cut': [], 'c2-cache-reconcile': [], 's1-sources-cut': ['builder-initial'],
  's2-sources-recovery': ['builder-recovery', 'builder-continuation'], 't1-tool-cut': ['builder-recovery', 'builder-continuation'], 'h1-handoff-cut': ['builder-recovery', 'builder-continuation'],
  'f1-final': ['builder-recovery', 'builder-continuation'] };
export function activationGuard(step: Step, maxRounds: number = rounds.max) {
  let builder: string | null = null;
  const seen: Record<string, Set<string>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; executionId: string; phaseId: string }, review?: { round: number; attempt?: number }) => {
    if (context.role === 'builder') {
      if (builder !== null || !builderPhases[step].includes(context.phaseId)) return false;
      builder = context.executionId;
      return true;
    }
    const used = seen[context.role];
    if (!used || !builder || context.executionId !== builder || !review) return false;
    const attempt = review.attempt ?? 1;
    if (step === 'h1-handoff-cut' && (used.size > 0 || attempt !== 1)) return false; // the first round only: the cut comes with its first opinion
    if (step !== 'h1-handoff-cut' && step !== 'f1-final') return false;
    const key = `${review.round}/${attempt}`;
    if (used.has(key) || used.size >= maxRounds + 1 || attempt > 2) return false;
    used.add(key);
    return true;
  };
}

/** Sources cut (pure): the request preservation started (ticket.json) and is NOT complete (no sources.json) at the same observation. */
export function sourcesCutProof(observed: { ticketJson: boolean; sourcesJson: boolean }): boolean { return observed.ticketJson && !observed.sourcesJson; }
/** Tool cut (pure): the documented gate started and has not finished. */
export function gateCutProof(markers: { started: Buffer | null; ended: Buffer | null }): boolean { return markers.started?.toString('utf8') === 'started\n' && markers.ended === null; }

type Event = { at: string; step: Step; call: string } & Record<string, unknown>;
type ExecutionLike = Pick<ExecutionView, 'executionId' | 'state' | 'end' | 'held' | 'recovery' | 'review'> & { request?: { publication?: unknown } };
export type CrashInput = {
  events: Event[]; exits: Partial<Record<Step, string>>;
  cache: { work: { executions: ExecutionLike[] } | undefined };
  main: { executions: ExecutionLike[]; question: QuestionView | undefined; answers: number; budget: { consumed: number; reserved: string | null } | null } | undefined;
  /** sha256 of each preserved file observed at the sources cut, and now (null = absent). */
  preservedAtCut: Record<string, string | null>; preservedNow: Record<string, string | null>;
  /** Some spec/vN/sources.json and instructions/vN/sources.json now present with `complete: true`. */
  preservationComplete: boolean;
  remote: { questionComments: number | null; pullRequests: number | null };
};
export type Assessment = { status: 'passed' | 'failed' | 'inconclusive'; checks: Record<string, boolean>; inconclusive: string[]; failures: string[] };
/** The verdict of the run from the stored Works, the child events/exits, the preserved artifacts and read-only GitHub observations. */
export function assess(input: CrashInput): Assessment {
  const at = (step: Step, call: string) => input.events.filter(item => item.step === step && item.call === call);
  const cut = (step: Step, name: string) => at(step, 'cut').some(item => item.cut === name) && input.exits[step] === 'signal:SIGKILL';
  const crashed = (execution: ExecutionLike | undefined) => execution?.end?.outcome === 'failure' && execution.end.code === 'CONTROLLER_CRASH' && execution.end.cessation === 'confirmed' &&
    (execution.recovery ?? []).some(item => item.cessation.result === 'confirmed' && item.decision === 'operational-recovery');
  const executions = input.main?.executions ?? [];
  const executionOf = (step: Step) => { const id = at(step, 'activate').find(item => (item.context as { role?: string } | undefined)?.role === 'builder')?.context as { executionId?: string } | undefined;
    return executions.find(item => item.executionId === id?.executionId); };
  const sourcesAtRecovery = at('s2-sources-recovery', 'sources-at-recovery')[0] as (Event & { sourcesJson?: boolean }) | undefined;
  const toolProof = at('h1-handoff-cut', 'tool-cut-proof')[0] as (Event & { proven?: boolean }) | undefined;
  const opinionCut = at('h1-handoff-cut', 'cut').find(item => item.cut === 'after-first-opinion') as (Event & { role?: string }) | undefined;
  const final = executionOf('f1-final');
  const firstFinalRound = final?.review?.rounds.find(round => (round.kind ?? 'review') === 'review');
  const cutRole = opinionCut?.role === 'standards' || opinionCut?.role === 'spec' ? opinionCut.role : null;
  const carried = cutRole ? firstFinalRound?.reviewers[cutRole].source === 'carried' : false;
  const rerunCutRole = cutRole && firstFinalRound ? at('f1-final', 'activate').some(item => (item.context as { role?: string }).role === cutRole &&
    (item.review as { round?: number } | null)?.round === firstFinalRound.round) : false;
  const cacheExecutions = input.cache.work?.executions ?? [];
  const cacheReconciliation = (at('c2-cache-reconcile', 'inventory')[0]?.caches as { outcome?: string }[] | undefined) ?? [];
  const answerAtBoot = at('t1-tool-cut', 'answer-observed')[0] as (Event & { dispatch?: string }) | undefined;
  // Channel loss: every cut with a live real worker severs its host channel; the next owner stops THAT boot (confirmed) before any activation.
  const bootOf = (step: Step) => (at(step, 'start')[0]?.result as { boot?: string } | undefined)?.boot;
  const stoppedBeforeActivate = (previous: Step, next: Step) => {
    const boot = bootOf(previous);
    const later = input.events.filter(item => item.step === next);
    const stopped = later.findIndex(item => item.call === 'stop' && (item.input as { boot?: string } | undefined)?.boot === boot && (item.result as { cessationConfirmed?: boolean } | undefined)?.cessationConfirmed === true);
    const activated = later.findIndex(item => item.call === 'activate');
    return boot !== undefined && stopped >= 0 && activated > stopped;
  };
  const changed = Object.entries(input.preservedAtCut).filter(([path, hash]) => hash !== null && input.preservedNow[path] !== hash).map(([path]) => path);
  const checks = {
    cacheCut: cut('c1-cache-cut', 'cache-mutating'),
    cacheReconciled: cacheReconciliation.some(item => item.outcome === 'reconciled'),
    cachePreparationHeldNotAdopted: cacheExecutions.some(item => item.state === 'held' && item.held?.code === 'PREPARE_CHECKOUT_PREPARATION_INCOMPLETE') &&
      at('c1-cache-cut', 'activate').length + at('c2-cache-reconcile', 'activate').length === 0 && input.exits['c2-cache-reconcile'] === 'exit:0',
    sourcesCut: cut('s1-sources-cut', 'before-sources-complete') || (input.exits['s1-sources-cut'] === 'signal:SIGKILL' && at('s1-sources-cut', 'cut-observed').length === 1),
    sourcesInterrupted: sourcesAtRecovery?.sourcesJson === false,
    channelLossReconciled: stoppedBeforeActivate('s1-sources-cut', 's2-sources-recovery') && stoppedBeforeActivate('t1-tool-cut', 'h1-handoff-cut') &&
      stoppedBeforeActivate('h1-handoff-cut', 'f1-final'),
    sourcesRecoveryReconciled: crashed(executionOf('s1-sources-cut')),
    preservedNeverOverwritten: changed.length === 0 && Object.values(input.preservedAtCut).some(hash => hash !== null),
    preservationCompleted: input.preservationComplete,
    questionCut: cut('s2-sources-recovery', 'after-question-published'),
    singleQuestionComment: input.remote.questionComments === 1,
    answerAcceptedOnce: input.main?.question?.state === 'answered' && input.main.question.answer?.origin.kind === 'github-comment' && input.main.answers === 1,
    answerDuringBoot: answerAtBoot?.dispatch === 'closed',
    toolCut: input.exits['t1-tool-cut'] === 'signal:SIGKILL' && at('t1-tool-cut', 'cut-observed').length === 1,
    toolCutReconciled: crashed(executionOf('t1-tool-cut')),
    toolNeverFinishedNorReplayedBlindly: toolProof?.proven === true,
    handoffCut: cut('h1-handoff-cut', 'after-first-opinion'),
    handoffReconciled: crashed(executionOf('h1-handoff-cut')),
    opinionCarriedNotRerun: carried && !rerunCutRole,
    finalCompleted: final?.end?.outcome === 'completed' && final.end.cessation === 'confirmed' && input.exits['f1-final'] === 'exit:0',
    noPublication: input.remote.pullRequests === 0 && executions.every(item => !item.request?.publication),
    budget: input.main?.budget !== null && input.main?.budget !== undefined && input.main.budget.reserved === null && input.main.budget.consumed >= 3,
  };
  const failures = [
    ...(input.remote.questionComments !== null && input.remote.questionComments > 1 ? ['singleQuestionComment'] : []),
    ...(changed.length ? ['preservedNeverOverwritten'] : []),
    ...(rerunCutRole && carried ? ['opinionCarriedNotRerun'] : []),
    ...(cacheExecutions.some(item => item.state === 'ended' && item.end?.outcome === 'completed') ? ['cachePreparationHeldNotAdopted'] : []),
    ...(input.remote.pullRequests !== null && input.remote.pullRequests > 0 ? ['noPublication'] : []),
    ...((input.main?.answers ?? 0) > 1 ? ['answerAcceptedOnce'] : []),
    ...(toolProof && toolProof.proven === false && checks.toolCut ? ['toolNeverFinishedNorReplayedBlindly'] : []),
  ];
  const inconclusive = [...(!checks.cacheCut ? ['CACHE_CUT_NOT_REACHED'] : []), ...(!checks.sourcesCut ? ['SOURCES_CUT_NOT_REACHED'] : []),
    ...(checks.sourcesCut && !checks.sourcesInterrupted ? ['SOURCES_COMPLETED_BY_SURVIVOR'] : []), ...(!checks.questionCut ? ['QUESTION_CUT_NOT_REACHED'] : []),
    ...(!checks.answerDuringBoot ? ['ANSWER_NOT_OBSERVED_DURING_BOOT'] : []), ...(!checks.toolCut ? ['TOOL_CUT_NOT_REACHED'] : []),
    ...(!checks.handoffCut ? ['HANDOFF_CUT_NOT_REACHED'] : []), ...(checks.handoffCut && !carried ? ['HANDOFF_PROPOSAL_CHANGED'] : []),
    ...(input.remote.questionComments === null || input.remote.pullRequests === null ? ['REMOTE_READ_INCOMPLETE'] : [])];
  const status = failures.length ? 'failed' : inconclusive.length ? 'inconclusive' : Object.values(checks).every(Boolean) ? 'passed' : 'failed';
  return { status, checks, inconclusive, failures: [...new Set(failures)] };
}

export const keySource = `${root}/${githubApp.privateKeyFile}`;
const storageDirectory = (line: Line) => line === 'cache' ? `${observations}/cache-line` : observations;
const ticketOf = (line: Line) => tickets[line];

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(text)) throw new Error('OBSERVATION_SECRET_SHAPE');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const load = (name: string) => fs.readFile(`${observations}/${name}.json`, 'utf8').then(text => JSON.parse(text) as { status?: unknown } & Record<string, unknown>, () => null);
  const events = async (): Promise<Event[]> => {
    const all: Event[] = [];
    for (const step of steps) for (const line of (await fs.readFile(`${observations}/${step}-events.jsonl`, 'utf8').catch(() => '')).split('\n')) if (line) all.push(JSON.parse(line) as Event);
    return all;
  };
  return { fs, save, exists, load, events };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}
const workOf = (list: unknown, line: Line): WorkView | undefined => (list as { kind?: string; works?: WorkView[] }).kind === 'list'
  ? (list as { works: WorkView[] }).works.find(item => item.ticket.number === ticketOf(line).number && item.ticket.repositoryId === ticketOf(line).repositoryId) : undefined;
const sha256 = async (data: Buffer | null) => data === null ? null : (await import('node:crypto')).createHash('sha256').update(data).digest('hex');
/** Confined, no-follow, bounded reads of the preserved files of an environment's /artifacts (never host git, never a guest command). */
async function preserved(environment: string) {
  const { readConfined } = await import('../../src/sandbox/index.js');
  const artifacts = `${factoryRoot}/environments/${environment}/artifacts`;
  const hashes: Record<string, string | null> = {};
  for (const file of preservedFiles) hashes[file] = await sha256(await readConfined(artifacts, file, 4 * 1024 * 1024).catch(() => null));
  return hashes;
}
async function gateMarkersOf(environment: string) {
  const { readConfined } = await import('../../src/sandbox/index.js');
  const workspace = `${factoryRoot}/environments/${environment}/workspace`;
  return { started: await readConfined(workspace, gateMarkers.started, 64).catch(() => null), ended: await readConfined(workspace, gateMarkers.ended, 64).catch(() => null) };
}
const environmentPattern = /^env-[a-f0-9]{64}$/;
const bootPattern = /^boot-[a-f0-9-]{36}$/;

/** One controller child (production-like owner under flock). Events are appended durably so a SIGKILL never loses what happened before it. */
async function child(step: Step) {
  if (!pinned()) throw new Error('TICKET_NOT_PINNED');
  const line = lineOf(step);
  const ticket = ticketOf(line);
  const directory = storageDirectory(line);
  const { fs } = await io();
  const { appendFileSync } = await import('node:fs');
  const log = (event: Record<string, unknown>) => {
    const text = JSON.stringify({ at: new Date().toISOString(), step, ...event });
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(text)) throw new Error('OBSERVATION_SECRET_SHAPE');
    appendFileSync(`${observations}/${step}-events.jsonl`, `${text}\n`, { mode: 0o600 });
  };
  // Only the orchestrator launches a step: its intent tombstone must exist, and a step runs once (exclusive start marker).
  if (!(await fs.access(`${observations}/${step}-intent.json`).then(() => true, () => false))) throw new Error('STEP_INTENT_REQUIRED');
  const marker = await fs.open(`${observations}/${step}-child-started.json`, 'wx', 0o600);
  try { await marker.writeFile(JSON.stringify({ step, pid: process.pid, at: new Date().toISOString() })); await marker.sync(); } finally { await marker.close(); }
  const { verifyControllerLock } = await import('../../src/platform/host/index.js');
  await verifyControllerLock(`${directory}/control.lock`);
  const preflight = JSON.parse(await fs.readFile(`${observations}/preflight-result.json`, 'utf8')) as { operators: { login: string; id: number }[]; preexisting: string[] };
  const { createSandbox, inventoryRuntime, reconcileInterruptedCaches } = await import('../../src/sandbox/index.js');
  const caches = await reconcileInterruptedCaches(factoryRoot);
  const listed = await inventoryRuntime(factoryRoot);
  const inventory = { kind: 'listed' as const, observedAt: new Date().toISOString(), environments: listed.environments.filter(item => !preflight.preexisting.includes(item.environment)),
    cache: listed.cache.filter(item => item.repositoryId === ticket.repositoryId), unknown: listed.unknown };
  log({ call: 'inventory', caches, inventory });
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
  const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const pack = builderSkillPacks[skillPack];
  const kill = (cut: string, detail: Record<string, unknown> = {}) => { log({ call: 'cut', cut, ...detail }); process.kill(process.pid, 'SIGKILL'); };
  const fetchCredentials = createRepositoryFetchCredentials({ github, repositories: [repository] });
  const cacheState = async () => JSON.parse(await fs.readFile(`${factoryRoot}/cache/git/${ticket.repositoryId}.state.json`, 'utf8').catch(() => '{}')) as { state?: string };
  // Cut c1: the fetch credential is self-revoked FIRST (no live token is left behind), then the controller dies with the cache `mutating`.
  const repositoryFetch: typeof fetchCredentials = { fetch: scope => fetchCredentials.fetch(scope), async revoke(grant) {
    const result = await fetchCredentials.revoke(grant);
    log({ call: 'fetch-revoked', kind: result.kind });
    if (step === 'c1-cache-cut') {
      const state = await cacheState();
      if (state.state === 'mutating') kill('cache-mutating', { state: state.state });
      log({ call: 'cache-cut-missed', state: state.state ?? null });
    }
    return result;
  } };
  const sandbox = createSandbox({ root: factoryRoot, guestAssets, repositoryFetch, artifactSeeds: [{ name: pack.seedName, directory: pack.directory }] });
  const workers = createWorkers({ root: factoryRoot, knownSecrets: [], profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
    profiles: { builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model }, standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
      spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model } } });
  const builderCredentials = createBuilderCredentials({ github, repositories: [repository] });
  const guard = activationGuard(step);
  let posted = 0, prepared = 0, firstBuilder = true, opinionCut = false;
  let control!: Awaited<ReturnType<typeof openControl>>;
  const shown = async () => workOf(await control.inspect({ kind: 'list' }), line);
  // Every method bound explicitly to the real tracker; each line's owner sees ONLY its own Ticket in the label listing.
  const guardedTracker: IssueTracker = { checkAccess: scope => tracker.checkAccess(scope), async listCandidates(scope) {
    const result = await tracker.listCandidates(scope);
    return result.kind === 'observed' ? { ...result, candidates: result.candidates.filter(item => item.number === ticket.number) } : result;
  }, readTicket: t => tracker.readTicket(t), readDependencyGraph: t => tracker.readDependencyGraph(t), readInputs: (t, cursor) => tracker.readInputs(t, cursor),
  findQuestion: async (t, id) => { const result = await tracker.findQuestion(t, id); log({ call: 'find-question', questionId: id, kind: result.kind }); return result; },
  async postComment(t, comment, effect) {
    const questionId = comment.kind === 'question' ? comment.questionId : null;
    const decision = t.number === tickets.main.number && t.repositoryId === tickets.main.repositoryId && comment.kind === 'question' ? postDecision(step, posted) : 'refuse';
    if (decision === 'refuse') {
      log({ call: 'post-refused', questionId, effectId: effect.effectId });
      return { kind: 'failed', observedAt: new Date().toISOString(), code: 'RECIPE_REPOST_GUARD', nextStep: 'The recipe allows ONE Question POST (s2); nothing was sent.' };
    }
    posted++;
    log({ call: 'post-intent', questionId, effectId: effect.effectId });
    const result = await tracker.postComment(t, comment, effect);
    log({ call: 'post-returned', questionId, kind: result.kind, commentId: result.kind === 'published' ? result.commentId : null });
    return result;
  } };
  control = await openControl({ storagePath: `${directory}/control.sqlite`, runtimeInventory: inventory,
    access: { tracker: guardedTracker, repositories: [repository], dependencyRepositories: [], operators: preflight.operators, factoryApp: () => github.appIdentity(repository),
      repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base), readPullRequest: query => codeRepository.readPullRequest(query),
        setDraft: async () => ({ kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_NO_READINESS', nextStep: 'This recipe never converts draft/ready; nothing was sent.', revocation: 'not-issued' }),
        findPublication: correlation => codeRepository.findPublication(correlation) } }, polling: { intervalSeconds: pollingSeconds },
    execution: { configuration, capacity: 1, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
      ...(line === 'main' ? { reviews: { reviewer, rounds, partialRecovery: true } } : {}),
      credentials: { async issue(context) {
        const allowed = line === 'main' && (await shown())?.ticket.number === tickets.main.number && context.purpose !== 'builder-publish';
        log({ call: 'issue', purpose: context.purpose ?? 'builder-start', allowed });
        if (!allowed) throw Object.assign(new Error('RECIPE_GRANT_GUARD'), { outcome: 'known-rejected' });
        const grant = await builderCredentials.issue(context);
        log({ call: 'issued', metadata: grant.metadata });
        return grant;
      }, async revoke(grant) { const result = await builderCredentials.revoke(grant); log({ call: 'revoked', purpose: grant.metadata.purpose, kind: result.kind }); return result; } },
      sandbox: {
        async prepare(input) {
          log({ call: 'prepare', workId: input.workId });
          const work = await shown();
          if (work?.work_id !== input.workId || ++prepared > 1) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
          const result = await sandbox.prepare(input);
          log({ call: 'prepare-result', result });
          return result;
        },
        async start(input) {
          // The cache line never boots a VM: a known refusal before any boot (the Work is then held, nothing started).
          if (line === 'cache') { log({ call: 'start-refused' }); return { status: 'failure', code: 'RECIPE_NO_BOOT' }; }
          const result = await sandbox.start(input); log({ call: 'start', result }); return result;
        },
        async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
        async observe(input) { const result = await sandbox.observe(input); const { storage: _storage, ...lifecycle } = result; log({ call: 'observe', input, result: lifecycle }); return result; },
        async observeProposal(input) { const result = await sandbox.observeProposal(input); log({ call: 'observe-proposal', round: input.round, result }); return result; },
        async verifyPreservedSource(input) { return sandbox.verifyPreservedSource(input); },
      },
      workers: { async deliver(worker, directive) { const result = await workers.deliver(worker, directive); log({ call: 'deliver', kind: directive.kind, result }); return result; },
        async observe(input) { const result = await workers.observe(input); log({ call: 'observe-session', state: result.session.state }); return result; },
        async observeStart(input) { const result = await workers.observeStart(input); log({ call: 'observe-start', input, result }); return result; },
        async observeQuestion(input) { const result = await workers.observeQuestion(input); log({ call: 'observe-question', input, kind: result.kind }); return result; },
        async observeOpinion(input) { const result = await workers.observeOpinion(input); log({ call: 'observe-opinion', input, kind: result.kind }); return result; },
        async activate(invocation, delivery, activationEvents) {
          const { context } = invocation;
          log({ call: 'activate', context, promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160), review: invocation.review ?? null });
          // Proofs read on the host (confined) at the first Builder activation of a step, i.e. after the boot reconciliation stopped the survivor.
          if (context.role === 'builder' && firstBuilder) {
            firstBuilder = false;
            const environment = String(context.environmentRef);
            if (step === 's2-sources-recovery' && environmentPattern.test(environment)) {
              const hashes = await preserved(environment);
              log({ call: 'sources-at-recovery', sourcesJson: hashes['spec/v1/sources.json'] !== null, ticketJson: hashes['spec/v1/ticket.json'] !== null, hashes });
            }
            if (step === 'h1-handoff-cut' && environmentPattern.test(environment)) {
              const markers = await gateMarkersOf(environment);
              log({ call: 'tool-cut-proof', started: markers.started !== null, ended: markers.ended !== null, proven: gateCutProof(markers) });
            }
          }
          // A refusal known to precede any launch (proven non-start for the Control), never an uncertain start.
          if (!guard(context, invocation.review)) throw new Error('WORKER_LAUNCH_INVALID');
          const handle = await workers.activate(invocation, delivery, activationEvents);
          const role = context.role;
          const completed = handle.completed.then(done => {
            log({ call: 'completed', role, phaseId: context.phaseId, review: invocation.review ?? null, status: done.status });
            // Cut h1: the FIRST reviewer opinion is preserved in Records and never reaches Control (the other reviewer still runs).
            if (step === 'h1-handoff-cut' && role !== 'builder' && done.status === 'success' && (done as { opinion?: unknown }).opinion && !opinionCut) {
              opinionCut = true;
              kill('after-first-opinion', { role, round: invocation.review?.round ?? null });
              return new Promise<never>(() => {});
            }
            return done;
          }, error => { log({ call: 'completion-uncertain', role }); throw error; });
          return { ...handle, completed };
        } } } });
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  const opening = await control.inspect({ kind: 'status' }) as { dispatch: string; dispatchReason: string | null };
  log({ call: 'boot-status', dispatch: opening.dispatch, dispatchReason: opening.dispatchReason });
  const running = control.run(stop.signal);
  const deadline = Date.now() + stepDeadlineMinutes[step] * 60 * 1000;
  const initial = (await shown())?.execution?.executionId ?? null;
  let done = false, answered = false;
  while (Date.now() < deadline && !done) {
    await new Promise(resolve => setTimeout(resolve, step === 't1-tool-cut' && !answered ? 500 : 2000));
    const work = await shown();
    const execution = work?.execution;
    const question = work?.questions?.[0] ? (await control.inspect({ kind: 'question', question_id: work.questions[0] }) as { question?: QuestionView }).question : undefined;
    if (step === 't1-tool-cut' && !answered && question?.state === 'answered') {
      answered = true;
      const status = await control.inspect({ kind: 'status' }) as { dispatch: string; dispatchReason: string | null };
      log({ call: 'answer-observed', dispatch: status.dispatch, dispatchReason: status.dispatchReason, executionState: execution?.state ?? null });
    }
    if (line === 'cache') done = execution?.state === 'held' || (step === 'c1-cache-cut' && execution?.state === 'ended');
    if (step === 's2-sources-recovery' && question?.publication.state === 'published' && execution?.state === 'ended' && execution.end?.outcome === 'question' && execution.slot.held === false) {
      kill('after-question-published', { questionId: question.questionId });
    }
    if (step === 'f1-final' && execution && execution.executionId !== initial && ((execution.state === 'ended' && execution.dispatch.phase === 'stopped') || execution.state === 'released')) done = true;
    if (execution?.request.publication) done = true; // never a publication activation in this recipe
    if (line === 'main' && execution?.state === 'held') done = true;
  }
  const finalWork = await shown();
  log({ call: 'final', list: await control.inspect({ kind: 'list' }), deadlineReached: Date.now() >= deadline, workId: finalWork?.work_id ?? null });
  stop.abort();
  const outcome = await running;
  log({ call: 'outcome', outcome });
  process.exit(outcome.kind === 'clean' ? 0 : 1);
}

/** The orchestrator's own host-side watcher for a cut it performs (s1, t1): environment/boot from the child's durable events. */
type Watch = (kill: () => void, live: () => boolean) => Promise<void>;
async function runChild(step: Step, watch?: Watch) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { save } = await io();
  await save(`${step}-intent`, { revision, step, at: new Date().toISOString() });
  const owner = spawn('flock', ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '73', `${storageDirectory(lineOf(step))}/control.lock`, node,
    fileURLToPath(import.meta.url), 'child', step], { stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1',
      HOME: process.env.HOME ?? '', XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus` } });
  let exited = false;
  const timer = setTimeout(() => owner.kill('SIGTERM'), (stepDeadlineMinutes[step] + 5) * 60 * 1000);
  const result = new Promise<string>(resolve => owner.once('exit', (code, signal) => { exited = true; resolve(signal ? `signal:${signal}` : `exit:${code}`); }));
  if (watch) void watch(() => owner.kill('SIGKILL'), () => !exited);
  const exit = await result;
  clearTimeout(timer);
  return exit;
}

async function stepEvents(step: Step): Promise<Event[]> {
  const fs = await import('node:fs/promises');
  return (await fs.readFile(`${observations}/${step}-events.jsonl`, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Event);
}
const fromEvents = async (step: Step) => {
  const events = await stepEvents(step);
  const environment = (events.find(item => item.call === 'prepare-result')?.result as { environment?: string } | undefined)?.environment;
  const boot = (events.find(item => item.call === 'start')?.result as { boot?: string } | undefined)?.boot;
  return { environment: environment && environmentPattern.test(environment) ? environment : null, boot: boot && bootPattern.test(boot) ? boot : null };
};
async function systemctlUser(args: string[]) {
  const { execFile } = await import('node:child_process');
  return new Promise<number>(resolve => execFile('/usr/bin/systemctl', ['--user', ...args], { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus` }, maxBuffer: 65536, shell: false },
  error => resolve(error ? (typeof error.code === 'number' ? error.code : 1) : 0)));
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** s1: freeze the survivor unit and SIGKILL the controller once the preservation started and is not complete. */
const sourcesWatch: Watch = async (kill, live) => {
  const { save } = await io();
  while (live()) {
    await pause(cutPollMs);
    const { environment, boot } = await fromEvents('s1-sources-cut');
    if (!environment || !boot) continue;
    const before = await preserved(environment);
    const observed = { ticketJson: before['spec/v1/ticket.json'] !== null, sourcesJson: before['spec/v1/sources.json'] !== null };
    if (!observed.ticketJson && !observed.sourcesJson) continue;
    // Freeze FIRST (the Builder can no longer finish), then re-read: the cut is proven only on the frozen state.
    const freeze = sourcesCutProof(observed) ? await systemctlUser(['freeze', `factory-sandbox-${boot}.service`]) : null;
    const hashes = await preserved(environment);
    const proven = freeze === 0 && sourcesCutProof({ ticketJson: hashes['spec/v1/ticket.json'] !== null, sourcesJson: hashes['spec/v1/sources.json'] !== null });
    await save('s1-cut', { at: new Date().toISOString(), environment, boot, freeze, proven, hashes, code: proven ? null : observed.sourcesJson ? 'SOURCES_ALREADY_COMPLETE' : 'FREEZE_FAILED' });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(`${observations}/s1-sources-cut-events.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), step: 's1-sources-cut', call: proven ? 'cut-observed' : 'cut-missed', by: 'orchestrator' })}\n`, { mode: 0o600 });
    kill();
    return;
  }
};
/** t1: SIGKILL the controller once the documented gate's start marker exists and its end marker does not. */
const toolWatch: Watch = async (kill, live) => {
  const { save } = await io();
  while (live()) {
    await pause(cutPollMs);
    const { environment } = await fromEvents('t1-tool-cut');
    if (!environment) continue;
    const markers = await gateMarkersOf(environment);
    if (!markers.started) continue;
    const proven = gateCutProof(markers);
    await save('t1-cut', { at: new Date().toISOString(), environment, proven, started: true, ended: markers.ended !== null });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(`${observations}/t1-tool-cut-events.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), step: 't1-tool-cut', call: proven ? 'cut-observed' : 'cut-missed', by: 'orchestrator' })}\n`, { mode: 0o600 });
    kill();
    return;
  }
};
const expectedExit: Record<Step, string> = { 'c1-cache-cut': 'signal:SIGKILL', 'c2-cache-reconcile': 'exit:0', 's1-sources-cut': 'signal:SIGKILL', 's2-sources-recovery': 'signal:SIGKILL',
  't1-tool-cut': 'signal:SIGKILL', 'h1-handoff-cut': 'signal:SIGKILL', 'f1-final': 'exit:0' };
const watches: Partial<Record<Step, Watch>> = { 's1-sources-cut': sourcesWatch, 't1-tool-cut': toolWatch };

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (!pinned()) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load, events } = await io();
  if (phase === 'preflight') {
    const { requireKeySource } = await import('./crashfx27-qualification.js');
    await requireKeySource(path => fs.access(path)); // before ANY effect
    // The own Factory root: exactly the setup layout, nothing prepared or cached yet, its model OAuth store present (existence only, never read).
    const entries = await fs.readdir(factoryRoot).catch(() => null);
    const fresh = entries !== null && await fs.realpath(factoryRoot) === factoryRoot && entries.every(name => setupEntries.includes(name)) &&
      (await fs.readdir(`${factoryRoot}/environments`).catch(() => ['?'])).length === 0 && await fs.access(`${factoryRoot}/credentials/chatgpt.json`).then(() => true, () => false);
    if (!fresh) throw new Error(`FACTORY_ROOT_NOT_FRESH: ${factoryRoot} must hold only the setup layout and its login store (nothing was created).`);
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    const { constants } = await import('node:fs');
    for (const name of ['credentials', 'run', 'cache-line']) await fs.mkdir(`${observations}/${name}`, { mode: 0o700 });
    await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
    await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { github, tracker, codeRepository } = await compose();
      const owner = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}`));
      if (!owner.ok) { await save('preflight-held', { owner }); throw new Error('PRECONDITION_HELD'); }
      const operator = resolveOperator(owner.value, operatorLogin);
      const listing = await tracker.listCandidates(repository);
      const numbers = [tickets.main.number, tickets.cache.number].sort((a, b) => a - b);
      if (listing.kind !== 'observed' || listing.repositoryId !== tickets.main.repositoryId || JSON.stringify(listing.candidates.map(item => item.number).sort((a, b) => a - b)) !== JSON.stringify(numbers)) {
        await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD');
      }
      const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: numbers, knownBranches: [], refs: true, base: repository.base });
      const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
      const clean = publication.kind === 'observed' && numbers.every(number => { const issue = publication.issues[String(number)]; return issue?.completeness === 'complete' && !issue.candidates.length; });
      const factoryBranches = refs ? Object.keys(refs).filter(ref => numbers.some(number => ref.startsWith(`refs/heads/factory/${number}-`))) : null;
      const app = await github.appIdentity(repository);
      const { createSandbox, inventoryRuntime } = await import('../../src/sandbox/index.js');
      const listed = await inventoryRuntime(factoryRoot);
      const sandbox = createSandbox({ root: factoryRoot, guestAssets });
      const observed = [];
      for (const item of listed.environments) {
        const { storage: _storage, ...lifecycle } = await sandbox.observe({ environment: item.environment as never });
        observed.push({ environment: item.environment, condition: lifecycle.condition, cessationConfirmed: lifecycle.cessationConfirmed });
      }
      const cache = listed.cache.filter(item => item.repositoryId === tickets.main.repositoryId);
      const freezer = await fs.access(`/sys/fs/cgroup/user.slice/user-${process.getuid?.()}.slice/cgroup.freeze`).then(() => true, () => false);
      if (!clean || !refs || factoryBranches?.length || publication.kind !== 'observed' || publication.baseProtection?.state !== 'pull-request-required' || !app || listed.unknown.length ||
        !observed.every(item => item.cessationConfirmed || item.condition === 'removed') || cache.some(item => item.state !== 'idle') || !freezer) {
        await save('preflight-held', { publication, factoryBranches, app, observed, unknown: listed.unknown, cache, freezer }); throw new Error('PRECONDITION_HELD');
      }
      await save('preflight-result', { status: 'success', operators: [operator], base: { state: 'present', sha: refs[`refs/heads/${repository.base}`] }, app,
        preexisting: listed.environments.map(item => item.environment), observed, cache });
      for (const line of ['cache', 'main'] as const) { const lock = await fs.open(`${storageDirectory(line)}/control.lock`, 'wx', 0o600); await lock.close(); }
      return;
    }
    if (phase === 'cache' || phase === 'sources' || phase === 'tool') {
      const exits: Partial<Record<Step, string>> = {};
      for (const step of phaseSteps[phase]) {
        exits[step] = await runChild(step, watches[step]);
        if (exits[step] !== expectedExit[step]) {
          await save(`${phase}-result`, { status: 'held', exits, reason: `${step.toUpperCase()}_EXIT_${exits[step]}`, events: (await events()).filter(item => phaseSteps[phase].includes(item.step) && item.call === 'cut') });
          throw new Error('CUT_NOT_REACHED');
        }
        const cutMissed = (await stepEvents(step)).some(item => item.call === 'cut-missed' || item.call === 'cache-cut-missed');
        if (cutMissed) { await save(`${phase}-result`, { status: 'held', exits, reason: `${step.toUpperCase()}_CUT_MISSED` }); throw new Error('CUT_NOT_REACHED'); }
      }
      const last = phaseSteps[phase].at(-1)!;
      const final = [...await stepEvents(last)].reverse().find(item => item.call === 'final' || item.call === 'cut');
      const questionId = phase === 'sources' ? ((await stepEvents('s2-sources-recovery')).find(item => item.call === 'cut' && item.cut === 'after-question-published') as { questionId?: string } | undefined)?.questionId ?? null : null;
      await save(`${phase}-result`, { status: 'success', exits, final: final?.call ?? null, ...(phase === 'sources' ? { questionId,
        operatorNext: `Answer on Ticket M from the operator account (controller stopped): \`/factory answer ${questionId} docs/FACTORY_CRASH_A.md\`.` } : {}) });
      return;
    }
    // inspect / stop-environment: private COPIES of both storages (the originals are never written).
    const { openControl } = await import('../../src/control/index.js');
    const read = async (line: Line) => {
      const copy = await snapshotStorage(storageDirectory(line), `${observations}/${phase}-${line}-storage-copy`);
      const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
      try {
        const list = await stored.inspect({ kind: 'list' }) as ListView;
        const work = workOf(list, line);
        const question = work?.questions?.[0] ? (await stored.inspect({ kind: 'question', question_id: work.questions[0] }) as { question?: QuestionView }).question : undefined;
        const shown = work ? await stored.inspect({ kind: 'show', work_id: work.work_id }) as { work?: { budget?: { recoveries: { consumed: number; reserved: string | null } } | null } } : null;
        return { work, question, budget: shown?.work?.budget?.recoveries ?? null };
      } finally { const halt = new AbortController(); halt.abort(); await stored.run(halt.signal); }
    };
    const main = await read('main');
    const work = main.work;
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    if (phase === 'inspect') {
      const cacheLine = await read('cache');
      const executionsOf = (item: WorkView | undefined) => item ? [...item.previousExecutions, ...(item.execution ? [item.execution] : [])] : [];
      const environment = work.execution.dispatch.environment;
      const cut = await load('s1-cut') as { hashes?: Record<string, string | null> } | null;
      const { readConfined } = await import('../../src/sandbox/index.js');
      const artifacts = `${factoryRoot}/environments/${environment}/artifacts`;
      let preservationComplete = false;
      const versions: Record<string, unknown> = {};
      for (const kind of ['spec', 'instructions']) {
        for (const version of ['v1', 'v2', 'v3', 'v4']) {
          const text = await readConfined(artifacts, `${kind}/${version}/sources.json`, 4 * 1024 * 1024).catch(() => null);
          if (!text) continue;
          const parsed = (() => { try { return JSON.parse(text.toString('utf8')) as { complete?: unknown }; } catch { return null; } })();
          versions[`${kind}/${version}`] = { complete: parsed?.complete ?? null };
        }
      }
      preservationComplete = ['spec', 'instructions'].every(kind => Object.entries(versions).some(([key, value]) => key.startsWith(`${kind}/`) && (value as { complete: unknown }).complete === true));
      const { github, codeRepository } = await compose();
      const comments = await github.read(repository, 'tracker-read', session => session.list(`/repos/${repository.repository}/issues/${tickets.main.number}/comments`, { maxPages: 10 }));
      const markerPrefix = main.question ? `<!-- software-factory:question:${main.question.questionId} -->` : null;
      const questionComments = comments.ok && Array.isArray(comments.value) && markerPrefix
        ? (comments.value as { body?: unknown }[]).filter(item => typeof item.body === 'string' && item.body.startsWith(`${markerPrefix}\n`)).length : null;
      const remote = await codeRepository.findPublication({ repo: repository, issueNumbers: [tickets.main.number, tickets.cache.number], knownBranches: [] });
      const associated = remote.kind === 'observed' ? [tickets.main.number, tickets.cache.number].map(number => remote.issues[String(number)]) : [];
      const pulls = associated.length === 2 ? associated.reduce<number | null>((sum, issue) => sum === null || issue?.completeness !== 'complete' ? null : sum + issue.candidates.length, 0) : null;
      const exits: Partial<Record<Step, string>> = {};
      for (const name of ['cache', 'sources', 'tool'] as const) Object.assign(exits, ((await load(`${name}-result`)) as { exits?: Partial<Record<Step, string>> } | null)?.exits ?? {});
      const verdict = assess({ events: await events(), exits, cache: { work: cacheLine.work ? { executions: executionsOf(cacheLine.work) } : undefined },
        main: { executions: executionsOf(work), question: main.question, budget: main.budget,
          answers: work.history.filter(item => item.event === 'question-answered' && 'questionId' in item && item.questionId === main.question?.questionId).length },
        preservedAtCut: cut?.hashes ?? {}, preservedNow: await preserved(environment), preservationComplete, remote: { questionComments, pullRequests: pulls } });
      const cacheState = await fs.readFile(`${factoryRoot}/cache/git/${tickets.main.repositoryId}.state.json`, 'utf8').then(text => JSON.parse(text) as unknown, () => null);
      await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }); // before the scan: any hit is then a real leak
      const { secretScan } = await import('./credential20-qualification.js');
      await save('inspect-result', { verdict, versions, cacheState, questionComments, pullRequests: pulls,
        reviewSpecVersions: executionsOf(work).flatMap(item => (item.review?.rounds ?? []).map(round => ({ executionId: item.executionId, round: round.round, spec: round.versions.spec,
          reviewers: { standards: round.reviewers.standards.source ?? null, spec: round.reviewers.spec.source ?? null } }))),
        executions: { main: executionsOf(work).map(item => ({ executionId: item.executionId, state: item.state, end: item.end, held: item.held, recovery: item.recovery ?? [], charge: item.charge })),
          cache: executionsOf(cacheLine.work).map(item => ({ executionId: item.executionId, state: item.state, end: item.end, held: item.held, recovery: item.recovery ?? [] })) },
        secretShapes: await secretScan([observations, `${factoryRoot}/${work.work_id}`]) });
      return;
    }
    const { needsStop } = await import('./builder09-qualification.js');
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root: factoryRoot, guestAssets });
    const environment = work.execution.dispatch.environment as never;
    const before = await sandbox.observe({ environment });
    const result = before.condition === 'active' && before.boot ? await sandbox.stop({ environment, boot: before.boot, reason: 'q34-crash-a explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before: { condition: before.condition, boot: before.boot ?? null }, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    if (phase === 'inspect') await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length === 2 && args[0] === 'child' && steps.includes(args[1] as Step)) { await child(args[1] as Step); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => { if (process.argv[2] !== 'child') process.exit(0); }, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') || message.startsWith('FACTORY_ROOT_NOT_FRESH') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
