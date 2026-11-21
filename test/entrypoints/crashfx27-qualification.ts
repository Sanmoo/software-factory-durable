import type { ExecutionView, ListView, QuestionView, WorkView } from '../../src/control/index.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';
import { pushViolations, resolveOperator } from './humanchanges21-qualification.js';
import { readBounded, sessionCommands, snapshotStorage } from './publication14-qualification.js';

// TEST ONLY. Ticket 27 one-shot real qualification recipe: the controller is SIGKILLed at the riskiest REAL external-effect cuts and the next
// owner DISCOVERS the effect instead of repeating it. Import and `--plan` are inert. Every other phase is a REAL effect and needs an explicit
// operator grant: real GitHub (App), a real Gondolin/KVM VM and the real model. Phases and child steps are one-shot: an exclusive intent
// tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically. Each controller child is launched like the
// production owner (`flock --exclusive --nonblock --no-fork <lock> node …`) on the SAME storage:
//   a-ask                  the Builder asks; the controller POSTs the Question comment and is SIGKILLed RIGHT AFTER the real POST returned,
//                          BEFORE its result commit (cut A: "after send, before confirm"). The VM/worker survive under systemd.
//   b-discover-question    boot reconciliation stops the survivor (not adopted); the crash-left attempt is DISCOVERED by marker (never
//                          reposted: every POST is refused by the recipe guard); clean stop once linked. Then the operator answers.
//   c-publish              the answer is accepted; recovery implementation + reviews + ONE publication activation; the child polls the own
//                          branch read-only and SIGKILLs itself once the Builder's push of the verified head is OBSERVED on GitHub, before
//                          any discovery (cut B: "after push, before discovery"; the PR may or may not exist yet, the VM survives).
//   d-discover-publication boot reconciliation stops the survivor; the discovery LINKS the own PR (or runs ONE PR-only continuation that never
//                          pushes, or blocks); clean stop.
// GitHub WRITES: controller — ONE Question comment on the pinned issue (a-ask); Builder (guest, direct, its own builder-publish grant) — ONE push of
// its own branch with an explicit lease and ONE draft PR (c-publish, or the PR-only continuation of d). The operator's answer is a HUMAN step with
// the operator's own account. Never a merge, approval, ready conversion, bare --force, base rewrite, cleanup, or any write by this recipe itself.

const root = '/home/sanmoo/software-factory-test/y5';
// v1 held at preflight (ticket 24 environments unreadable before ec5ff1d); v2 consumed by the real run (oracle fixed afterwards).
const observations = `${root}/q27-crashfx-v3`;
const revision = 'q27-crashfx-v3';
const phases = ['preflight', 'ask', 'publish', 'inspect', 'stop-environment'] as const;
type Phase = (typeof phases)[number];
const steps = ['a-ask', 'b-discover-question', 'c-publish', 'd-discover-publication'] as const;
export type Step = (typeof steps)[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
/**
 * The NEW synthetic issue the supervisor creates after the operator's authorization (title/body below, label `ready-for-agent`, no other open
 * issue with that label). `number` MUST be pinned in a reviewed commit before preflight: 0 refuses every phase (TICKET_NOT_PINNED).
 */
export const ticket = { number: 0, repositoryId: 1256893534, title: 'Factory qualification: external effects survive controller crashes' } as const;
export const ticketBody = [
  'Add a short documentation page whose file name the OPERATOR decides.',
  '',
  'Before creating or editing any file, use the ask_user tool ONCE to ask the operator which of these two names to use: `docs/FACTORY_CRASH_A.md` or ' +
    '`docs/FACTORY_CRASH_B.md`. Do not choose it yourself and do not create either file before the answer.',
  '',
  'After the answer, create ONLY the chosen file with a `# Factory crash qualification` title and one paragraph saying it exists to exercise how the Software ' +
    'Factory recovers external effects after a controller crash. Commit it on your branch.',
  '',
  'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed.',
  '',
  'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && ls docs/FACTORY_CRASH_A.md docs/FACTORY_CRASH_B.md 2>/dev/null | grep -c . | grep -qx 1`',
].join('\n');
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const operatorLogin = 'Sanmoo';
const configuration = {
  schemaVersion: 1,
  profile: 'gondolin-qemu-alpine-dev-v1',
  memoryMiB: 4096,
  vcpus: 2,
  diskGiB: 40,
  shutdownGraceSeconds: 30,
  minFreeSpaceGiB: 4,
} as const;
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
} as const;
const stepDeadlineMinutes: Record<Step, number> = { 'a-ask': 40, 'b-discover-question': 15, 'c-publish': 90, 'd-discover-publication': 40 };
const rounds = { max: 4 } as const;
const pollingSeconds = 60;
/** c-publish: own-branch read-only polls while the publication activation runs (each one `publication-read` grant). */
const pushPollSeconds = 10;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const skillPack = 'factory-skills-v6' as const;
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const prompts = {
  builder:
    'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. When you need information or an approval you do not have, use the ask_user tool instead of working around it. Never push, ' +
    'open pull requests or change GitHub state, EXCEPT inside a publication activation the Factory requests (a Factory publication instruction): then follow it ' +
    'and the pr skill exactly (your own branch, the verified commit, the explicit lease, ONE draft pull request), inspect before repeating anything, and never ' +
    'merge, approve, mark ready or touch anything else.',
  standards:
    'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec:
    'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final message is ' +
    'ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const node = '/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node';

export function plan() {
  return {
    revision,
    root,
    observations,
    phases,
    steps,
    repository,
    ticket: { ...ticket, body: ticketBody, label: repository.label, pinned: ticket.number > 0 },
    operators: [operatorLogin],
    configuration,
    guestAssets,
    skillPack,
    pollingSeconds,
    requires: [
      'ticket 27 integrated in the composed revision',
      `${root}/${githubApp.privateKeyFile} present`,
      'the supervisor created the NEW issue (title/body above, label ready-for-agent) and pinned its number in a reviewed commit',
      'no other open issue carries the label',
      'main protected with NO bypass for the App (as in tickets 14/16/17/21)',
      'operator first-login store under root/credentials (model OAuth)',
      'explicit operator authorization for THIS run (one-shot; a consumed namespace is never reused)',
    ],
    model: {
      provider: 'openai',
      model: 'gpt-6-luna',
      auth: 'factory-oauth',
      providerRetries: 0,
      sdkRetries: 0,
      builderActivations: {
        'a-ask': ['implementation (asks)'],
        'b-discover-question': [],
        'c-publish': ['recovery implementation (after the answer)', 'publication'],
        'd-discover-publication': ['at most ONE PR-only publication continuation (never a push)'],
      },
      reviewersPerImplementation: `standards + spec, at most ${rounds.max} rounds each (c-publish only)`,
    },
    github: {
      app: githubApp,
      accessRoot: `${observations} (own namespace: credentials/ copy of ${root}/${githubApp.privateKeyFile}, run/); never y5/run`,
      writes: [
        'controller: ONE Question comment on the pinned issue (a-ask); every later POST is refused by the recipe guard before sending (known failure, nothing sent)',
        'Builder (guest, direct, builder-publish): ONE push of refs/heads/factory/<n>-<work8> with --force-with-lease=<ref>: (absent) and ONE draft PR (c-publish), or only the PR in d',
        'App: access_tokens issuance POSTs and DELETE /installation/token revocations',
      ],
      reads: `c-publish polls the own branch every ${pushPollSeconds} s (findPublication, publication-read grant) ONLY while the publication activation runs`,
      human: [
        'between ask and publish (controller stopped): on the issue, from the operator account, ONE comment `/factory answer <question-id> docs/FACTORY_CRASH_A.md` (question id in ask-result.json)',
      ],
      never: [
        'merge',
        'approval',
        'ready-for-review conversion',
        'bare --force or a lease without an explicit oid',
        'push to main or any other branch',
        'rewrite of the base',
        'labels/assignees',
        'closing the issue or the PR',
        'branch deletion/cleanup',
        'any write by this recipe itself',
      ],
    },
    effects: [
      'preflight: key source check BEFORE any effect; exclusive namespace with its own GitHub access root; read-only: operator id pinned, label lists exactly the pinned issue, no associated PR, ' +
        'no factory/<n>- branch, main requires PRs without App bypass, App bot identity',
      'ask: a-ask (SIGKILL right after the real Question POST returned, before the result commit) then b-discover-question (new owner: survivor stopped, attempt discovered by marker, no POST)',
      'publish: c-publish (answer accepted at boot; recovery + reviews + publication; SIGKILL once the pushed verified head is observed on the own branch) then d-discover-publication',
      'inspect: storage copy; read-only GitHub: issue comments with the Question marker, PRs of the own branch, branch tip; sessions push commands; verdict',
      'stop-environment: own boot of the last recorded Execution when it may still run',
    ],
    guards: [
      'one-shot intent tombstones per phase AND per child step, phase order',
      'per step Builder activations/phaseIds and reviewers only in c-publish',
      'postComment: exactly ONE real POST (a-ask), every other refused',
      'builder-publish only while Control requested the publication (<= 2 per publication activation)',
      'prepare <= Builder activations of the step',
      'no retry, no remove/cleanup',
    ],
    expected: [
      'a-ask: child killed by SIGKILL after `post-returned` (comment id recorded in the events file); Question publication left `attempting` in storage',
      'b-discover-question: the ask Execution ended question with cessation confirmed (live before the cut, or by the boot reconciliation of a survivor: then every recovery record confirms it); Question attempts [attempting, discovered] with the SAME comment id; zero POSTs in b; clean exit 0',
      'c-publish: answer accepted once (operator id); push-observed at the verified head; child killed by SIGKILL',
      'd-discover-publication: interrupted publication Execution settled (cessation confirmed); publication `published` linking ONE own draft PR at the verified head (directly, or after ONE PR-only continuation that never pushes); clean exit 0',
      'inspect: exactly ONE comment with the Question marker; exactly ONE own PR for the branch; branch tip = verified head; every session push names its exact lease and at most ONE push command of the head; no token in storage/sessions/observations',
      'verdict: `passed` only if every check holds; `inconclusive` when a cut was not reached as designed (nothing proven either way); `failed` when a duplicate or a repetition is observed',
    ],
  };
}

/** Phase order: each phase once and only after the previous one SUCCEEDED (a held phase is consumed and never followed). */
export function phaseGuard(
  phase: Phase,
  results: Partial<Record<Phase, { status?: unknown } | null>>,
  intents: ReadonlySet<string>,
  pinned = ticket.number > 0,
): string | null {
  if (!pinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  const before: Partial<Record<Phase, Phase>> = { ask: 'preflight', publish: 'ask' };
  const previous = before[phase];
  if (previous && results[previous]?.status !== 'success') return `${previous.toUpperCase()}_SUCCESS_REQUIRED`;
  if ((phase === 'inspect' || phase === 'stop-environment') && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  return null;
}

/** Which Question POSTs a step may send: ONE in a-ask (then the cut), none afterwards (a repost is refused before sending and recorded). */
export function postDecision(step: Step, postedBefore: number): 'send-then-cut' | 'refuse' {
  return step === 'a-ask' && postedBefore === 0 ? 'send-then-cut' : 'refuse';
}

/** Builder phaseIds allowed per step, in order; reviewers only for the c-publish implementation. */
export const builderSequence: Record<Step, readonly (readonly string[])[]> = {
  'a-ask': [['builder-initial']],
  'b-discover-question': [],
  'c-publish': [['builder-recovery', 'builder-continuation'], ['builder-publication']],
  'd-discover-publication': [['builder-publication']],
};
export function activationGuard(step: Step, maxRounds: number = rounds.max) {
  const sequence = builderSequence[step];
  let next = 0;
  let implementation: string | null = null;
  const seen: Record<string, Set<number>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; executionId: string; phaseId: string }, review?: { round: number }) => {
    if (context.role === 'builder') {
      const allowed = sequence[next];
      if (!allowed || !allowed.includes(context.phaseId)) return false;
      if (context.phaseId !== 'builder-publication') implementation = context.executionId;
      next++;
      return true;
    }
    const used = seen[context.role];
    if (
      step !== 'c-publish' ||
      !used ||
      !implementation ||
      context.executionId !== implementation ||
      !review ||
      used.has(review.round) ||
      used.size >= maxRounds
    )
      return false;
    used.add(review.round);
    return true;
  };
}

/** Cut B: the own branch holds exactly the verified head the publication activation pushes (read-only observation). */
export function pushObserved(head: string, tip: { state: string; sha?: string } | undefined): boolean {
  return tip?.state === 'present' && tip.sha === head;
}

type Event = { at: string; step: Step; call: string } & Record<string, unknown>;
export type Assessment = { status: 'passed' | 'failed' | 'inconclusive'; checks: Record<string, boolean>; inconclusive: string[]; failures: string[] };
/** The verdict of the run from the stored Work/Question, the child events/exits and the read-only GitHub observations (no secret involved). */
export function assess(input: {
  work: WorkView | undefined;
  question: QuestionView | undefined;
  events: Event[];
  exits: Partial<Record<Step, string>>;
  remote: { questionComments: number | null; ownPullRequests: number | null; branchTip: string | null };
  pushes: string[];
  /** False when the session census was capped or a session file skipped (oversized/unreadable): the push count may undercount. */
  pushCensusComplete: boolean;
}): Assessment {
  const at = (step: Step, call: string) => input.events.filter(item => item.step === step && item.call === call);
  const posted = at('a-ask', 'post-returned')[0] as (Event & { commentId?: number | null; kind?: string }) | undefined;
  const all = input.work ? [...input.work.previousExecutions, ...(input.work.execution ? [input.work.execution] : [])] : [];
  const asked = all.find(item => item.end?.questionId === input.question?.questionId);
  const head = input.work?.publication?.verified?.head ?? null;
  const publication = all.find(item => item.request.publication && item.recovery?.length);
  const reached = {
    cutA: Boolean(posted) && input.exits['a-ask'] === 'signal:SIGKILL',
    cutB: at('c-publish', 'push-observed').length === 1 && input.exits['c-publish'] === 'signal:SIGKILL',
  };
  const headPushes = head ? input.pushes.filter(command => /\bgit\b[\s\S]*\bpush\b/.test(command) && command.includes(head)).length : 0;
  const checks = {
    questionCut: reached.cutA && posted?.kind === 'published',
    // The ask Execution ends `question` with CONFIRMED cessation — either live before cut A (its activation ends at the ACK, so the boot can
    // be stopped before the POST returns: real run v2) or by the boot reconciliation of a survivor (then every recovery record confirms it).
    questionExecutionSettled:
      asked?.end?.outcome === 'question' && asked.end.cessation === 'confirmed' && (asked.recovery ?? []).every(item => item.cessation.result === 'confirmed'),
    questionDiscovered:
      input.question?.publication.state === 'published' &&
      input.question.publication.attempts.some(item => item.outcome === 'discovered') &&
      input.question.publication.comment?.commentId === posted?.commentId,
    questionNeverReposted:
      at('b-discover-question', 'post-refused').length + at('c-publish', 'post-refused').length + at('d-discover-publication', 'post-refused').length === 0,
    singleQuestionComment: input.remote.questionComments === 1,
    // Exactly ONE accepted answer (from a GitHub comment); any later/duplicate answer was refused (never a second acceptance).
    singleAnswerAccepted:
      input.question?.state === 'answered' &&
      input.question.answer?.origin.kind === 'github-comment' &&
      (input.work?.history ?? []).filter(item => item.event === 'question-answered' && 'questionId' in item && item.questionId === input.question!.questionId)
        .length === 1,
    pushCut: reached.cutB,
    publicationReconciled: publication?.recovery?.[0]?.cessation.result === 'confirmed',
    publicationLinked: input.work?.publication?.state === 'published' && input.work.publication.pullRequest?.headSha === head && head !== null,
    singleOwnPullRequest: input.remote.ownPullRequests === 1,
    branchAtVerifiedHead: head !== null && input.remote.branchTip === head,
    // Ticket 21's census: every push (or ref write through gh api/curl) must be EXACTLY one the Factory requested (branch, lease, head).
    explicitLeases:
      pushViolations(
        input.pushes,
        (input.work?.publication?.attempts ?? []).map(item => ({
          branch: input.work!.publication!.branch,
          expected: item.expectedRemote?.state === 'present' ? item.expectedRemote.sha : null,
          head: item.head,
        })),
      ).length === 0,
    atMostOnePushOfHead: headPushes <= 1,
    cleanStops: input.exits['b-discover-question'] === 'exit:0' && input.exits['d-discover-publication'] === 'exit:0',
  };
  const failures = (['questionNeverReposted', 'singleQuestionComment', 'singleOwnPullRequest', 'explicitLeases', 'atMostOnePushOfHead'] as const).filter(
    key => !checks[key] && !(key.startsWith('single') && input.remote[key === 'singleQuestionComment' ? 'questionComments' : 'ownPullRequests'] === null),
  );
  // Environment faults prove nothing either way: the POST at cut A did not come back as created (GitHub error/unknown), a cut missed, a
  // truncated/failed remote listing, or a session census that may undercount the pushes.
  const inconclusive = [
    ...(!reached.cutA ? ['CUT_A_NOT_REACHED'] : []),
    ...(reached.cutA && posted?.kind !== 'published' ? ['CUT_A_ENVIRONMENT_FAULT'] : []),
    ...(!reached.cutB ? ['CUT_B_NOT_REACHED'] : []),
    ...(input.remote.questionComments === null || input.remote.ownPullRequests === null ? ['REMOTE_READ_INCOMPLETE'] : []),
    ...(!input.pushCensusComplete ? ['PUSH_CENSUS_INCOMPLETE'] : []),
  ];
  const status = failures.length ? 'failed' : inconclusive.length ? 'inconclusive' : Object.values(checks).every(Boolean) ? 'passed' : 'failed';
  return { status, checks, inconclusive, failures };
}

export const keySource = `${root}/${githubApp.privateKeyFile}`;
/** Fails loudly, with the path and what to do, when the App key the preflight copies is missing (nothing has been created yet). */
export async function requireKeySource(access: (path: string) => Promise<unknown>) {
  await access(keySource).catch(() => {
    throw new Error(
      `APP_KEY_SOURCE_MISSING: ${keySource} is absent; restore the App private key there before preflight (nothing was created, no intent, no GitHub call).`,
    );
  });
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(text)) throw new Error('OBSERVATION_SECRET_SHAPE');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const exists = (name: string) =>
    fs.access(`${observations}/${name}.json`).then(
      () => true,
      () => false,
    );
  const load = (name: string) =>
    fs.readFile(`${observations}/${name}.json`, 'utf8').then(
      text => JSON.parse(text) as { status?: unknown } & Record<string, unknown>,
      () => null,
    );
  const events = async (): Promise<Event[]> => {
    const all: Event[] = [];
    for (const step of steps)
      for (const line of (await fs.readFile(`${observations}/${step}-events.jsonl`, 'utf8').catch(() => '')).split('\n'))
        if (line) all.push(JSON.parse(line) as Event);
    return all;
  };
  return { fs, save, exists, load, events };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  // The recipe's OWN namespace is the GitHub access root (its run/ holds the transient gh dirs; never y5/run).
  const github = createGitHubAccess({ root: observations, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}
const workOf = (list: unknown): WorkView | undefined =>
  (list as { kind?: string; works?: WorkView[] }).kind === 'list' ? (list as { works: WorkView[] }).works[0] : undefined;

/** One controller child (production-like owner under flock). Events are appended durably so a SIGKILL never loses what happened before it. */
async function child(step: Step) {
  if (ticket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs } = await io();
  const { appendFileSync } = await import('node:fs');
  const log = (event: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), step, ...event });
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(line)) throw new Error('OBSERVATION_SECRET_SHAPE');
    appendFileSync(`${observations}/${step}-events.jsonl`, `${line}\n`, { mode: 0o600 });
  };
  // Only the orchestrator launches a step: its intent tombstone must exist, and a step runs once (exclusive start marker).
  if (
    !(await fs.access(`${observations}/${step}-intent.json`).then(
      () => true,
      () => false,
    ))
  )
    throw new Error('STEP_INTENT_REQUIRED');
  const marker = await fs.open(`${observations}/${step}-child-started.json`, 'wx', 0o600);
  try {
    await marker.writeFile(JSON.stringify({ step, pid: process.pid, at: new Date().toISOString() }));
    await marker.sync();
  } finally {
    await marker.close();
  }
  const { verifyControllerLock } = await import('../../src/platform/host/index.js');
  await verifyControllerLock(`${observations}/control.lock`);
  const preflight = JSON.parse(await fs.readFile(`${observations}/preflight-result.json`, 'utf8')) as {
    operators: { login: string; id: number }[];
    preexisting: string[];
  };
  const { createSandbox, inventoryRuntime, reconcileInterruptedCaches } = await import('../../src/sandbox/index.js');
  const caches = await reconcileInterruptedCaches(root);
  const listed = await inventoryRuntime(root);
  const inventory = {
    kind: 'listed' as const,
    observedAt: new Date().toISOString(),
    environments: listed.environments.filter(item => !preflight.preexisting.includes(item.environment)),
    cache: listed.cache.filter(item => item.repositoryId === ticket.repositoryId),
    unknown: listed.unknown,
  };
  log({ call: 'inventory', caches, inventory });
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
  const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const pack = builderSkillPacks[skillPack];
  const sandbox = createSandbox({
    root,
    guestAssets,
    repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }],
  });
  const workers = createWorkers({
    root,
    knownSecrets: [],
    profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
    profiles: {
      builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
      standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
      spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model },
    },
  });
  const builderCredentials = createBuilderCredentials({ github, repositories: [repository] });
  const guard = activationGuard(step);
  const kill = (cut: string, detail: Record<string, unknown>) => {
    log({ call: 'cut', cut, ...detail });
    process.kill(process.pid, 'SIGKILL');
  };
  let posted = 0,
    prepared = 0,
    publishGrants = 0;
  let control!: Awaited<ReturnType<typeof openControl>>;
  const shown = async () => workOf(await control.inspect({ kind: 'list' }));
  // Every method bound explicitly to the real tracker (never an object spread that could drop prototype methods or `this`).
  const guardedTracker: IssueTracker = {
    checkAccess: scope => tracker.checkAccess(scope),
    listCandidates: scope => tracker.listCandidates(scope),
    readTicket: t => tracker.readTicket(t),
    readDependencyGraph: t => tracker.readDependencyGraph(t),
    readInputs: (t, cursor) => tracker.readInputs(t, cursor),
    findQuestion: async (t, id) => {
      const result = await tracker.findQuestion(t, id);
      log({
        call: 'find-question',
        questionId: id,
        kind: result.kind,
        candidates: result.kind === 'observed' ? result.candidates.map(item => item.commentId) : null,
      });
      return result;
    },
    async postComment(t, comment, effect) {
      // Ticket 23: a reply comment carries no Question id (this recipe posts Questions only).
      const questionId = comment.kind === 'question' ? comment.questionId : null;
      const decision = t.number === ticket.number && t.repositoryId === ticket.repositoryId ? postDecision(step, posted) : 'refuse';
      if (decision === 'refuse') {
        log({ call: 'post-refused', questionId, effectId: effect.effectId });
        return {
          kind: 'failed',
          observedAt: new Date().toISOString(),
          code: 'RECIPE_REPOST_GUARD',
          nextStep: 'The recipe allows ONE Question POST (a-ask); nothing was sent.',
        };
      }
      posted++;
      log({ call: 'post-intent', questionId, effectId: effect.effectId });
      const result = await tracker.postComment(t, comment, effect);
      log({ call: 'post-returned', questionId, kind: result.kind, commentId: result.kind === 'published' ? result.commentId : null });
      // Cut A: the comment exists on GitHub; the result is NEVER returned to the desk (no result commit).
      kill('after-question-post', { questionId });
      return new Promise<never>(() => {});
    },
  };
  const plannedBuilders = builderSequence[step].length;
  control = await openControl({
    storagePath: `${observations}/control.sqlite`,
    runtimeInventory: inventory,
    access: {
      tracker: guardedTracker,
      repositories: [repository],
      dependencyRepositories: [],
      operators: preflight.operators,
      factoryApp: () => github.appIdentity(repository),
      repository: {
        checkAccess: (repo, base) => codeRepository.checkAccess(repo, base),
        readPullRequest: query => codeRepository.readPullRequest(query),
        setDraft: async () => ({
          kind: 'known-failure' as const,
          observedAt: new Date().toISOString(),
          code: 'RECIPE_NO_READINESS',
          nextStep: 'This recipe never converts draft/ready; nothing was sent.',
          revocation: 'not-issued',
        }),
        async findPublication(correlation) {
          const result = await codeRepository.findPublication(correlation);
          log({
            call: 'find-publication',
            knownBranches: correlation.knownBranches,
            kind: result.kind,
            ...(result.kind === 'observed' ? { branches: result.branches } : { code: result.code }),
          });
          return result;
        },
      },
    },
    polling: { intervalSeconds: pollingSeconds },
    execution: {
      configuration,
      capacity: 1,
      builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
      ...(step === 'c-publish' ? { reviews: { reviewer, rounds } } : {}),
      credentials: {
        async issue(context) {
          const work = await shown();
          const publish = context.purpose === 'builder-publish';
          const requested = Boolean(work?.execution?.request.publication) && work?.execution?.executionId === context.executionId;
          const allowed =
            work?.ticket.number === ticket.number &&
            (!publish || ((step === 'c-publish' || step === 'd-discover-publication') && requested && ++publishGrants <= 2));
          log({ call: 'issue', purpose: context.purpose ?? 'builder-start', allowed });
          if (!allowed) throw Object.assign(new Error('RECIPE_GRANT_GUARD'), { outcome: 'known-rejected' });
          const grant = await builderCredentials.issue(context);
          log({ call: 'issued', metadata: grant.metadata });
          return grant;
        },
        async revoke(grant) {
          const result = await builderCredentials.revoke(grant);
          log({ call: 'revoked', purpose: grant.metadata.purpose, kind: result.kind });
          return result;
        },
      },
      sandbox: {
        async prepare(input) {
          log({ call: 'prepare', workId: input.workId });
          const work = await shown();
          if (work?.work_id !== input.workId || work.ticket.number !== ticket.number || ++prepared > plannedBuilders)
            return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
          const result = await sandbox.prepare(input);
          log({ call: 'prepare-result', result });
          return result;
        },
        async start(input) {
          const result = await sandbox.start(input);
          log({ call: 'start', result });
          return result;
        },
        async stop(input) {
          const result = await sandbox.stop(input);
          log({ call: 'stop', input, result });
          return result;
        },
        async observe(input) {
          const result = await sandbox.observe(input);
          const { storage: _storage, ...lifecycle } = result;
          log({ call: 'observe', input, result: lifecycle });
          return result;
        },
        async observeProposal(input) {
          const result = await sandbox.observeProposal(input);
          log({ call: 'observe-proposal', round: input.round, result });
          return result;
        },
      },
      workers: {
        async deliver(worker, directive) {
          const result = await workers.deliver(worker, directive);
          log({ call: 'deliver', kind: directive.kind, result });
          return result;
        },
        async observe(input) {
          const result = await workers.observe(input);
          log({ call: 'observe-session', state: result.session.state });
          return result;
        },
        async observeStart(input) {
          const result = await workers.observeStart(input);
          log({ call: 'observe-start', input, result });
          return result;
        },
        async observeQuestion(input) {
          const result = await workers.observeQuestion(input);
          log({ call: 'observe-question', input, kind: result.kind });
          return result;
        },
        async activate(invocation, delivery, activationEvents) {
          log({
            call: 'activate',
            context: invocation.context,
            promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160),
            review: invocation.review ?? null,
          });
          // A refusal known to precede any launch (proven non-start for the Control), never an uncertain start.
          if (!guard(invocation.context, invocation.review)) throw new Error('WORKER_LAUNCH_INVALID');
          const handle = await workers.activate(invocation, delivery, activationEvents);
          const role = invocation.context.role;
          void handle.completed.then(
            done => log({ call: 'completed', role, phaseId: invocation.context.phaseId, status: done.status }),
            () => log({ call: 'completion-uncertain', role }),
          );
          return handle;
        },
      },
    },
  });
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  const running = control.run(stop.signal);
  const deadline = Date.now() + stepDeadlineMinutes[step] * 60 * 1000;
  let done = false;
  let lastPoll = 0;
  while (Date.now() < deadline && !done) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const work = await shown();
    const execution = work?.execution;
    const question = work?.questions?.[0]
      ? ((await control.inspect({ kind: 'question', question_id: work.questions[0] })) as { question?: QuestionView }).question
      : undefined;
    if (step === 'b-discover-question')
      done = question?.publication.state === 'published' || question?.publication.state === 'conflict' || question?.publication.state === 'unconfirmed';
    if (step === 'a-ask' && execution?.state === 'ended' && !question) done = true; // the Builder did not ask: inconclusive, stop
    if (step === 'c-publish' && execution?.request.publication && execution.state === 'started' && Date.now() - lastPoll >= pushPollSeconds * 1000) {
      lastPoll = Date.now();
      const read = await codeRepository
        .findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [execution.request.publication.branch] })
        .catch(() => null);
      const tip = read?.kind === 'observed' ? read.branches[execution.request.publication.branch] : undefined;
      log({ call: 'push-poll', tip: tip ?? null });
      if (pushObserved(execution.request.publication.head, tip)) {
        log({ call: 'push-observed', head: execution.request.publication.head });
        kill('after-publication-push', {});
      }
    }
    if (step === 'c-publish' && (work?.publication?.state === 'published' || work?.publication?.state === 'blocked')) done = true; // the cut was missed: inconclusive
    if (step === 'd-discover-publication')
      done =
        ['published', 'blocked', 'diverged'].includes(work?.publication?.state ?? '') &&
        (!execution || execution.state === 'ended' || execution.state === 'released');
    if (execution?.state === 'held') done = true;
  }
  const finalWork = await shown();
  const finalQuestion = finalWork?.questions?.[0]
    ? (((await control.inspect({ kind: 'question', question_id: finalWork.questions[0] })) as { question?: QuestionView }).question ?? null)
    : null;
  log({ call: 'final', list: await control.inspect({ kind: 'list' }), question: finalQuestion, deadlineReached: Date.now() >= deadline });
  stop.abort();
  const outcome = await running;
  log({ call: 'outcome', outcome });
  process.exit(outcome.kind === 'clean' ? 0 : 1);
}

async function runChild(step: Step) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { save } = await io();
  await save(`${step}-intent`, { revision, step, at: new Date().toISOString() });
  const owner = spawn(
    'flock',
    [
      '--exclusive',
      '--nonblock',
      '--no-fork',
      '--conflict-exit-code',
      '73',
      `${observations}/control.lock`,
      node,
      fileURLToPath(import.meta.url),
      'child',
      step,
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        NODE_DISABLE_COMPILE_CACHE: '1',
        HOME: process.env.HOME ?? '',
        XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
      },
    },
  );
  const timer = setTimeout(() => owner.kill('SIGTERM'), (stepDeadlineMinutes[step] + 5) * 60 * 1000);
  const result = await new Promise<string>(resolve => owner.once('exit', (code, signal) => resolve(signal ? `signal:${signal}` : `exit:${code}`)));
  clearTimeout(timer);
  return result;
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (ticket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load, events } = await io();
  if (phase === 'preflight') {
    await requireKeySource(path => fs.access(path)); // before ANY effect
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    const { constants } = await import('node:fs');
    await fs.mkdir(`${observations}/credentials`, { mode: 0o700 });
    await fs.mkdir(`${observations}/run`, { mode: 0o700 });
    await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
    await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set(
    (await Promise.all(phases.map(async item => ((await exists(`${item}-intent`)) ? `${item}-intent` : null)))).filter((item): item is string => item !== null),
  );
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { github, tracker, codeRepository } = await compose();
      const owner = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}`));
      if (!owner.ok) {
        await save('preflight-held', { owner });
        throw new Error('PRECONDITION_HELD');
      }
      const operator = resolveOperator(owner.value, operatorLogin);
      const listing = await tracker.listCandidates(repository);
      if (
        listing.kind !== 'observed' ||
        listing.candidates.length !== 1 ||
        listing.candidates[0]!.number !== ticket.number ||
        listing.repositoryId !== ticket.repositoryId
      ) {
        await save('preflight-held', { listing });
        throw new Error('PRECONDITION_HELD');
      }
      const publication = await codeRepository.findPublication({
        repo: repository,
        issueNumbers: [ticket.number],
        knownBranches: [],
        refs: true,
        base: repository.base,
      });
      const associated = publication.kind === 'observed' ? publication.issues[String(ticket.number)] : undefined;
      const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
      const factoryBranches = refs ? Object.keys(refs).filter(ref => ref.startsWith(`refs/heads/factory/${ticket.number}-`)) : null;
      const app = await github.appIdentity(repository);
      const { createSandbox, inventoryRuntime } = await import('../../src/sandbox/index.js');
      const listed = await inventoryRuntime(root);
      const sandbox = createSandbox({ root, guestAssets });
      const observed = [];
      for (const item of listed.environments) {
        const { storage: _storage, ...lifecycle } = await sandbox.observe({ environment: item.environment as never });
        observed.push({ environment: item.environment, condition: lifecycle.condition, cessationConfirmed: lifecycle.cessationConfirmed });
      }
      if (
        publication.kind !== 'observed' ||
        associated?.completeness !== 'complete' ||
        associated.candidates.length ||
        !refs ||
        factoryBranches?.length ||
        publication.baseProtection?.state !== 'pull-request-required' ||
        !app ||
        listed.unknown.length ||
        !observed.every(item => item.cessationConfirmed || item.condition === 'removed')
      ) {
        await save('preflight-held', { publication, factoryBranches, app, observed, unknown: listed.unknown });
        throw new Error('PRECONDITION_HELD');
      }
      await save('preflight-result', {
        status: 'success',
        operators: [operator],
        base: { state: 'present', sha: refs[`refs/heads/${repository.base}`] },
        app,
        preexisting: listed.environments.map(item => item.environment),
        observed,
      });
      const lock = await fs.open(`${observations}/control.lock`, 'wx', 0o600);
      await lock.close();
      return;
    }
    if (phase === 'ask' || phase === 'publish') {
      const [first, second] = phase === 'ask' ? (['a-ask', 'b-discover-question'] as const) : (['c-publish', 'd-discover-publication'] as const);
      const exits: Partial<Record<Step, string>> = {};
      exits[first] = await runChild(first);
      if (exits[first] !== 'signal:SIGKILL') {
        await save(`${phase}-result`, { status: 'held', exits, reason: `${first.toUpperCase()}_CUT_NOT_REACHED`, events: await events() });
        throw new Error('CUT_NOT_REACHED');
      }
      exits[second] = await runChild(second);
      const all = await events();
      const final = [...all].reverse().find(item => item.step === second && item.call === 'final');
      const work = workOf(final?.list);
      const questionId = work?.questions?.[0] ?? null;
      const published = (final?.question as QuestionView | null | undefined)?.publication.state === 'published';
      const ok = exits[second] === 'exit:0' && (phase === 'ask' ? Boolean(questionId) && published : work?.publication?.state === 'published');
      await save(`${phase}-result`, {
        status: ok ? 'success' : 'held',
        exits,
        questionId,
        work: work ? { work_id: work.work_id, publication: work.publication, impediments: work.impediments } : null,
        ...(phase === 'ask'
          ? { operatorNext: `Answer on the issue from the operator account (controller stopped): \`/factory answer ${questionId} docs/FACTORY_CRASH_A.md\`.` }
          : {}),
      });
      if (!ok) throw new Error('PHASE_NOT_AS_EXPECTED');
      return;
    }
    // inspect / stop-environment: a private COPY of the storage (the original is never written).
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = (await stored.inspect({ kind: 'list' })) as ListView;
    const work = workOf(list);
    const question = work?.questions?.[0]
      ? ((await stored.inspect({ kind: 'question', question_id: work.questions[0] })) as { question?: QuestionView }).question
      : undefined;
    const halt = new AbortController();
    halt.abort();
    await stored.run(halt.signal);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    if (phase === 'inspect') {
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const pushes: string[] = [];
      // The census never undercounts silently: a capped listing or a skipped (oversized/unreadable) session makes it incomplete.
      let pushCensusComplete = true;
      for (const execution of [...work.previousExecutions, work.execution]) {
        if (!execution.dispatch.boot) continue;
        const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
        const launches = (
          await fs.readdir(runtime).catch(() => {
            pushCensusComplete = false;
            return [];
          })
        )
          .filter(name => name.startsWith('w-'))
          .sort();
        if (launches.length > 12) pushCensusComplete = false;
        for (const launch of launches.slice(0, 12)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          const files = (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl'));
          if (files.length > 4) pushCensusComplete = false;
          for (const file of files.slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            if (!('text' in read)) {
              pushCensusComplete = false;
              continue;
            }
            pushes.push(...sessionCommands(read.text).flatMap(call => (call.command ? [call.command] : [])));
          }
        }
      }
      const { github, codeRepository } = await compose();
      // A listing beyond 10 pages throws INCOMPLETE_GITHUB_QUERY (never a truncated count): the count is then null → inconclusive.
      const comments = await github.read(repository, 'tracker-read', session =>
        session.list(`/repos/${repository.repository}/issues/${ticket.number}/comments`, { maxPages: 10 }),
      );
      const marker = question ? `<!-- software-factory:question:${question.questionId} -->` : null;
      const questionComments =
        comments.ok && Array.isArray(comments.value) && marker
          ? (comments.value as { body?: unknown }[]).filter(item => typeof item.body === 'string' && item.body.startsWith(`${marker}\n`)).length
          : null;
      const remote = work.branch
        ? await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [work.branch] })
        : null;
      const associated = remote?.kind === 'observed' ? remote.issues[String(ticket.number)] : undefined;
      const own = associated?.completeness === 'complete' ? associated.candidates.filter(item => item.headRef === work.branch).length : null;
      const tip = remote?.kind === 'observed' && work.branch ? remote.branches[work.branch] : undefined;
      const exits: Partial<Record<Step, string>> = {};
      for (const name of ['ask', 'publish'] as const)
        Object.assign(exits, ((await load(`${name}-result`)) as { exits?: Partial<Record<Step, string>> } | null)?.exits ?? {});
      const verdict = assess({
        work,
        question,
        events: await events(),
        exits,
        pushes,
        pushCensusComplete,
        remote: { questionComments, ownPullRequests: own, branchTip: tip?.state === 'present' ? tip.sha : null },
      });
      // Real run v2: the scan counted the namespace's own App key copy (BEGIN/END PRIVATE KEY = 2) because it ran before the removal in
      // `finally`. The last GitHub read is done: the key copy is removed BEFORE the scan, so any hit is a real leak.
      await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true });
      const { secretScan } = await import('./credential20-qualification.js');
      await save('inspect-result', {
        verdict,
        questionComments,
        ownPullRequests: own,
        branchTip: tip ?? null,
        pushes,
        question,
        work: {
          work_id: work.work_id,
          publication: work.publication,
          impediments: work.impediments,
          executions: [...work.previousExecutions, work.execution].map(item => ({
            executionId: item.executionId,
            request: { publication: item.request.publication ?? null },
            end: item.end,
            recovery: item.recovery ?? [],
          })),
        },
        secretShapes: await secretScan([observations]),
      });
      return;
    }
    const { needsStop } = await import('./builder09-qualification.js');
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never;
    const before = await sandbox.observe({ environment });
    const result =
      before.condition === 'active' && before.boot ? await sandbox.stop({ environment, boot: before.boot, reason: 'q27 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before: { condition: before.condition, boot: before.boot ?? null }, result });
  } catch (error) {
    await save(`${phase}-held`, {
      phase,
      status: 'held',
      code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN',
      note: 'Consumed; no retry.',
    }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    // The namespace's key copy is removed once the last GitHub phase ran (inspect), never earlier.
    if (phase === 'inspect') await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify(plan(), null, 2));
    return;
  }
  if (args.length === 2 && args[0] === 'child' && steps.includes(args[1] as Step)) {
    await child(args[1] as Step);
    return;
  }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(
    () => {
      if (process.argv[2] !== 'child') process.exit(0);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`,
      );
      process.exit(1);
    },
  );
}
