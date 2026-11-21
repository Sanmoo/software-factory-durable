import type { ExecutionPorts, ListView, ShowView, WorkView } from '../../src/control/index.js';
import type { CodeRepository } from '../../src/code-repository/index.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';
import { holdStorageLock, needsStop, openStorageCopy } from './question10-qualification.js';

// TEST ONLY. Ticket 25 one-shot real qualification recipe: withdrawal of authorization (label removed, then restored) DURING a real Builder
// activity, then cancellation during its command, on a NEW synthetic issue; then, controller restarted, no re-dispatch by the persistent label
// and an explicit `new` cycle (created while paused: no second VM/model). Import and `--plan` are inert. Every other phase is a REAL effect and
// needs an explicit operator grant: real GitHub (App), a real Gondolin/KVM VM and a real model. One-shot: exclusive intent tombstones precede
// effects; a consumed phase never reruns; nothing is retried. HUMAN STEPS between the waits of `run`: remove the label, restore it, request
// the cancellation (see plan().humanSteps). GitHub writes by the Factory: none (token issuance and self-revocation only); the Builder grant
// is read-only. Merge/close/reopen of an own PR are NOT exercised here (no own PR is published; see plan().notCovered).

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q25-cancel-v1`;
const revision = 'q25-cancel-v1';
const phases = ['preflight', 'run', 'new', 'inspect', 'stop-environment'] as const;
type Phase = (typeof phases)[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const repositoryId = 1256893534;
/**
 * The NEW synthetic issue the supervisor creates (after the operator's authorization) with EXACTLY this title and body, labelled
 * `ready-for-agent`. `number` is pinned here once it exists (a reviewed one-line commit); 0 = not pinned: every real phase refuses.
 */
export const syntheticTicket = {
  number: 18,
  title: '[factory-q25] Synthetic: full build summary (cancellation qualification, do not merge)',
  body: [
    'Synthetic qualification Ticket for Software Factory ticket 25 (withdrawal of authorization and cancellation). Nothing produced for it is to be merged.',
    '',
    'Task: from the repository root run the complete build with tests (`./mvnw -B verify`), wait for it to finish, and write a short summary of the result ' +
      '(modules, test counts, failures) to `docs/q25-build-summary.md`. Do not change any other file.',
    '',
    'The operator will remove and restore the `ready-for-agent` label and cancel this Work while the build runs: the expected end is a cancellation.',
  ].join('\n'),
} as const;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
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
const pollingSeconds = 30;
const waits = { startMinutes: 20, humanStepMinutes: 15, cessationMinutes: 10 } as const;
const ghTrace = `${observations}/gh-trace.jsonl`;
/** The REAL CLI against this recipe's owner socket (`<observations>/run/control.sock`), run from the composed revision's checkout (supervisor decision). */
export const cancelCommand = (workId: string) =>
  `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 node dist/src/entrypoints/cli.js cancel ${workId} ` +
  `--root ${observations} --request-id q25-cancel-1 --json`;
const cancelRequestId = 'q25-cancel-1';
const systemPrompt =
  'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. ' +
  'Never push, open pull requests, change GitHub state, request broader access or use another credential. When you need information or an ' +
  'approval you do not have, use the ask_user tool instead of working around it.';

export function plan() {
  return {
    revision,
    root,
    observations,
    phases,
    repository,
    syntheticTicket: { ...syntheticTicket, pinned: syntheticTicket.number > 0 },
    requires: [
      'ticket 25 integrated in the composed revision',
      'operator authorization of THIS run (VM, model, GitHub App reads, human steps)',
      'the supervisor created the synthetic issue with exactly the pinned title/body and the label, and pinned its number here',
      `${keySource} present`,
      'no other open issue of the repository carries `ready-for-agent` (preflight checks the listing is exactly the synthetic issue)',
      'factory-oauth first-login store under root/credentials',
    ],
    storage: 'run/new hold an exclusive flock on observations/control.lock; inspect/stop-environment read a COPY of the storage taken under that lock',
    configuration,
    guestAssets,
    skillPack: 'factory-skills-v2',
    model: {
      provider: 'openai',
      model: 'gpt-6-luna',
      api: 'openai-responses',
      auth: 'factory-oauth',
      budget: 'builder-v1',
      maxActivations: 1,
      providerRetries: 0,
      sdkRetries: 0,
    },
    github: {
      app: githubApp,
      accessRoot: `${observations} (own namespace: credentials/ holds a COPY of the App key, run/ the transient gh dirs; never y5/run)`,
      controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose:
        'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only (read-only: no push/PR possible)',
      guard:
        "gh behind this recipe's wrapper: every request traced in gh-trace.jsonl; only GET without input and DELETE /installation/token (self-revocation) pass; anything else refused (exit 97, nothing sent)",
      writes:
        'none by the Factory: no comment (postComment refused by the recipe), no label/state change, no PR/branch/ref mutation (setDraft/reopen/cleanup refused); App token issuance and self-revocation only',
    },
    humanSteps: [
      {
        when: 'run: `human-step-1-remove-label.json` appears (the Builder Execution is started)',
        who: 'operator (or the supervisor with explicit authorization)',
        action: `remove the label ready-for-agent from issue #<pinned> on GitHub (do NOT close the issue, do NOT touch anything else)`,
      },
      {
        when: 'run: `human-step-2-restore-label.json` appears (the withdrawal was recorded, the activity still running)',
        who: 'same',
        action: 're-add the label ready-for-agent to the same issue',
      },
      {
        when: 'run: `human-step-3-cancel.json` appears (the restoration was observed; the suspension is still in force)',
        who: 'operator (or the supervisor with explicit authorization)',
        action: `run, from the composed checkout, the exact command in the step file: ${cancelCommand('<work id>')} — the real CLI over this recipe's owner socket (same schema/accept path as the controller owner); expect a durable receipt {operation: cancel, outcome: accepted}. Do it while the build command still runs.`,
      },
      { when: 'between `run` and `new`', who: 'nobody', action: 'leave the label on the issue (persistent label must not re-trigger the cancelled cycle)' },
    ],
    effects: [
      'preflight: key source check, exclusive namespace + key copy; read-only GitHub: the label lists exactly the synthetic issue; issue open, title/body identical to the pinned ones, no associated pull request, native blocked_by read',
      "run: Control (new storage, polling 30 s) also serves the local operator socket <observations>/run/control.sock (serveControl, the owner's own handler) so the cancellation arrives through the real CLI; it admits the issue, reserves ONE Execution: fetch+clone, skill pack seed, Sandbox.prepare/start (1 new VM), Builder grant, Workers.activate (1 Builder). Waits for the human steps; on the CLI cancel (request id q25-cancel-1): prohibition durable, credentials withdrawn (withdraw-credential to the live worker, ONE self-revocation per known grant), then activity abort, Sandbox.stop, Slot released only after confirmed cessation. Controller stopped once the cancellation is `ceased` or after the cessation wait",
      'new: same storage, Control restarted: `pause` (durable) FIRST, then 2 polling cycles with the label still present (the cancelled cycle must stay untouched: listing outcome existing, no prepare/activate), then accept new {ticket: <repo>#<pinned>} → a cycle-2 Work with predecessor, suspended until its first authorization read, held by GLOBAL_PAUSE; nothing is prepared or activated (every Sandbox/Workers call refused by the recipe)',
      'inspect: read-only: storage copy (Works, Executions, history), gh trace summary, secret scan of the own storage, the issue as GitHub shows it now',
      "stop-environment: only when the run Execution's own boot may still run and is observed active: public Sandbox.stop of that exact boot",
    ],
    guards: [
      'one-shot intent tombstones',
      'phase guard (each phase once; run after a successful preflight; new after a run whose cancellation ceased)',
      'pinned ticket required',
      'prepare <= 1 and activate <= 1 in run, 0 in new',
      'cancel accepted only through the CLI socket with request id q25-cancel-1 (the recipe never calls accept cancel itself)',
      'tracker postComment refused',
      'CodeRepository writes refused',
      'gh guard (GET + self-revocation only)',
      'no retry',
      'no cleanup/remove',
    ],
    expected: [
      'run/withdrawal: AUTHORIZATION_WITHDRAWN recorded (codes [LABEL_NOT_PRESENT], history authorization-withdrawn) while execution.state stays started; no activity-abort, no new activation',
      'run/restoration: authorization.withdrawal.restoredObservedAt set (history authorization-restored-observed once); AUTHORIZATION_WITHDRAWN still present',
      'run/cancel: receipt accepted; credentialLifecycle withdrawn with reason cancelled BEFORE end; workerNotice withdrawn; each grant revocation attempted; execution.end {outcome stopped, code WORK_CANCELLED}; Sandbox.stop of the own boot; Slot released only with end.cessation confirmed; result cancelled, cancellation ceased, queue not pending, no pendingRecovery',
      'run/cancel GitHub: gh trace shows only GET and DELETE /installation/token; the issue keeps its label/state; nothing on GitHub was undone or changed',
      'new: after restart, cancelled Work unchanged and nothing prepared/activated in 2 cycles with the label present; new → receipt accepted with `created`; the new Work cycle 2, predecessor = cancelled Work, own budget, branch null, impediments DEPENDENCIES_NOT_EVALUATED then AUTHORIZATION_NOT_CONFIRMED cleared by the first read; dispatch held GLOBAL_PAUSE',
      'no token in storage/observations',
    ],
    notCovered: [
      "merge concurrent with cancellation, PR closed without merge and `reopen` need an own published PR: kept at flow level (cycles-commits/cycles-flow) and ticket 17's real merge-during-activity evidence by supervisor decision; a later real journey covers them",
    ],
  };
}

/** Each phase once; run after a successful preflight; new only after a run whose cancellation ceased; nothing without a pinned ticket. */
export function phaseGuard(
  phase: Phase,
  results: { preflight?: { status?: unknown } | null; run?: { cancellation?: unknown } | null },
  intents: ReadonlySet<string>,
  pinned = syntheticTicket.number > 0,
): string | null {
  if (phase !== 'inspect' && phase !== 'stop-environment' && !pinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase !== 'preflight' && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  if (phase === 'new' && results.run?.cancellation !== 'ceased') return 'RUN_CANCELLATION_NOT_CEASED';
  return null;
}

/** gh guard decision (embedded verbatim in the wrapper): GET without input, or the token self-revocation; nothing else is sent. */
export function ghAllowed(method: string | null, endpoint: string | undefined, hasInput: boolean): boolean {
  if (hasInput) return false;
  return method === 'GET' || (method === 'DELETE' && endpoint === '/installation/token');
}
export function ghGuardScript(input: { node: string; gh: string; trace: string }) {
  return `#!${input.node}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
${ghAllowed.toString()}
const args = process.argv.slice(2);
const at = args.indexOf('--method');
const method = at >= 0 ? args[at + 1] : null;
const allowed = ghAllowed(method, args.at(-1), args.includes('--input'));
appendFileSync(${JSON.stringify(input.trace)}, JSON.stringify({ at: new Date().toISOString(), method, endpoint: args.at(-1), allowed }) + '\\n');
if (!allowed) { process.stderr.write('RECIPE_GUARD_REFUSED\\n'); process.exit(97); }
const result = spawnSync(${JSON.stringify(input.gh)}, args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`;
}

/** The pinned synthetic issue exactly as specified (identity, open, label, title, body). */
export function ticketMatches(observed: {
  number: number;
  repositoryId: number;
  state: string;
  title?: string | null;
  body?: string | null;
  labels: { name: string }[];
}): string[] {
  const reasons: string[] = [];
  if (observed.number !== syntheticTicket.number || observed.repositoryId !== repositoryId) reasons.push('TICKET_IDENTITY');
  if (observed.state !== 'open') reasons.push('TICKET_NOT_OPEN');
  if (!observed.labels.some(label => label.name === repository.label)) reasons.push('LABEL_ABSENT');
  if (observed.title !== syntheticTicket.title) reasons.push('TITLE_MISMATCH');
  if ((observed.body ?? '').replaceAll('\r\n', '\n') !== syntheticTicket.body) reasons.push('BODY_MISMATCH');
  return reasons;
}

/** Verdict of `run` over the final Work and the ordered recipe events (pure; the reasons name each unmet expectation). */
export function runVerdict(work: WorkView | undefined, events: { call: string; [key: string]: unknown }[]): { status: 'success' | 'held'; reasons: string[] } {
  const reasons: string[] = [];
  if (!work) return { status: 'held', reasons: ['WORK_NOT_FOUND'] };
  const history = work.history.map(item => item.event);
  const execution = work.execution;
  if (!history.includes('authorization-withdrawn')) reasons.push('WITHDRAWAL_NOT_RECORDED');
  if (events.find(item => item.call === 'withdrawal-observed')?.executionState !== 'started') reasons.push('WITHDRAWAL_NOT_DURING_ACTIVITY');
  if (!history.includes('authorization-restored-observed')) reasons.push('RESTORATION_NOT_OBSERVED');
  if (events.find(item => item.call === 'cancel-accepted')?.executionState !== 'started') reasons.push('CANCEL_NOT_DURING_ACTIVITY');
  if (work.result !== 'cancelled') reasons.push(`RESULT_${work.result.toUpperCase()}`);
  if (work.cancellation?.state !== 'ceased') reasons.push('CANCELLATION_NOT_CEASED');
  if (execution?.credentialLifecycle.reason !== 'cancelled') reasons.push('CREDENTIALS_NOT_WITHDRAWN_BY_CANCEL');
  if (execution?.end?.outcome !== 'stopped' || execution.end.code !== 'WORK_CANCELLED') reasons.push('END_NOT_CANCELLED');
  if (execution?.end?.cessation !== 'confirmed' || execution.slot.held) reasons.push('SLOT_NOT_RELEASED_AFTER_CESSATION');
  const order = (call: string) => events.findIndex(item => item.call === call);
  if (order('deliver-withdraw-credential') < 0 || order('activity-aborted') < 0 || order('deliver-withdraw-credential') > order('activity-aborted'))
    reasons.push('WITHDRAWAL_NOT_BEFORE_ABORT');
  if (order('deliver-withdraw-credential') < 0 || order('stop') < 0 || order('deliver-withdraw-credential') > order('stop'))
    reasons.push('WITHDRAWAL_NOT_BEFORE_STOP');
  if (events.filter(item => item.call === 'activate').length !== 1) reasons.push('ACTIVATIONS_NOT_ONE');
  return { status: reasons.length ? 'held' : 'success', reasons };
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
      text => JSON.parse(text) as Record<string, unknown>,
      () => null,
    );
  return { fs, save, exists, load };
}

async function guardedGh() {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const target = `${observations}/gh-guard.mjs`;
  if (
    !(await fs.access(target).then(
      () => true,
      () => false,
    ))
  ) {
    let gh: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(':').filter(item => item.startsWith('/'))) {
      if (
        await fs.access(`${directory}/gh`, constants.X_OK).then(
          () => true,
          () => false,
        )
      ) {
        gh = `${directory}/gh`;
        break;
      }
    }
    if (!gh) throw new Error('GH_NOT_FOUND');
    await fs.writeFile(target, ghGuardScript({ node: process.execPath, gh, trace: ghTrace }), { mode: 0o700, flag: 'wx' });
  }
  return target;
}

/** Read-only tracker except a refused postComment (no Question comment is expected; any would be a write). */
function guardTracker(tracker: IssueTracker, events: unknown[]): IssueTracker {
  return {
    readInputs: (ticket, cursor) => tracker.readInputs(ticket, cursor),
    findQuestion: (ticket, questionId) => tracker.findQuestion(ticket, questionId),
    checkAccess: scope => tracker.checkAccess(scope),
    listCandidates: scope => tracker.listCandidates(scope),
    readTicket: ticket => tracker.readTicket(ticket),
    readDependencyGraph: ticket => tracker.readDependencyGraph(ticket),
    async postComment(ticket, comment) {
      events.push({
        at: new Date().toISOString(),
        call: 'postComment-refused',
        ticket: ticket.number,
        questionId: comment.kind === 'question' ? comment.questionId : null,
      });
      return { kind: 'failed', observedAt: new Date().toISOString(), code: 'RECIPE_NO_GITHUB_WRITE', nextStep: 'The q25 recipe publishes nothing.' };
    },
  };
}
/** Read-only CodeRepository: every write the Factory could attempt is refused before any request. */
function guardRepository(code: CodeRepository, events: unknown[]): CodeRepository {
  const refused = (call: string) => {
    events.push({ at: new Date().toISOString(), call: `${call}-refused` });
    throw new Error('RECIPE_NO_GITHUB_WRITE');
  };
  return {
    checkAccess: (repo, base) => code.checkAccess(repo, base),
    findPublication: correlation => code.findPublication(correlation),
    readPullRequest: query => code.readPullRequest(query),
    ...(code.readOwnMerge ? { readOwnMerge: pr => code.readOwnMerge!(pr) } : {}),
    setDraft: async () => refused('setDraft'),
    reopenPullRequest: async () => refused('reopenPullRequest'),
    cleanupBranch: async () => refused('cleanupBranch'),
  };
}

async function compose(events: unknown[]) {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  // The recipe's OWN namespace is the GitHub access root (its credentials/ copy of the App key, its run/ for transient gh dirs).
  const github = createGitHubAccess({ root: observations, ...githubApp, executable: await guardedGh() });
  return {
    github,
    tracker: guardTracker(createIssueTracker({ github, scopes: [repository], dependencyScopes: [] }), events),
    codeRepository: guardRepository(createCodeRepository({ github }), events),
    createBuilderCredentials,
    createRepositoryFetchCredentials,
  };
}

async function controlFor(phase: 'run' | 'new', events: { call: string; [key: string]: unknown }[]) {
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose(events);
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { createWorkers, skillPacks } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const pack = skillPacks['factory-skills-v2'];
  const sandbox = createSandbox({
    root,
    guestAssets,
    repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }],
  });
  const workers = createWorkers({
    root,
    knownSecrets: [],
    profile: {
      id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
      systemPrompt,
      auth: 'factory-oauth',
      providerId: 'openai',
      modelId: 'gpt-6-luna',
      api: 'openai-responses',
    },
  });
  const allowance = phase === 'run' ? 1 : 0;
  let prepared = 0,
    activated = 0;
  const event = (call: string, data: Record<string, unknown> = {}) => events.push({ at: new Date().toISOString(), call, ...data });
  const execution: ExecutionPorts = {
    configuration,
    capacity: 1,
    credentials: createBuilderCredentials({ github, repositories: [repository] }),
    builder: { skillPack: 'factory-skills-v2', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        event('prepare', { workId: input.workId });
        if (++prepared > allowance) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
        const result = await sandbox.prepare(input);
        event('prepare-result', { status: result.status });
        return result;
      },
      async start(input) {
        const result = await sandbox.start(input);
        event('start', { result });
        return result;
      },
      async stop(input) {
        event('stop', { boot: input.boot, reason: input.reason });
        const result = await sandbox.stop(input);
        event('stop-result', { result });
        return result;
      },
      observe: input => sandbox.observe(input),
    },
    workers: {
      async activate(invocation, delivery, handlers) {
        event('activate', { context: invocation.context, credentialDelivered: delivery?.credential !== undefined });
        if (++activated > allowance) throw new Error('RECIPE_ONE_SHOT_GUARD');
        invocation.signal.addEventListener('abort', () => event('activity-aborted'), { once: true });
        return workers.activate(invocation, delivery, handlers);
      },
      async deliver(worker, directive) {
        event(`deliver-${directive.kind}`);
        const result = await workers.deliver(worker, directive);
        event('deliver-result', { result });
        return result;
      },
    },
  };
  const control = await openControl({
    storagePath: `${observations}/control.sqlite`,
    // Recipe decision: root/environments holds only earlier qualification resources and, for `new`, this storage's own environment whose boot
    // ceased (checked by the phase guard); none runs for this storage.
    runtimeInventory: 'empty',
    access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] },
    polling: { intervalSeconds: pollingSeconds },
    execution,
  });
  return { control, counts: () => ({ prepared, activated }) };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(minutes: number, probe: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + minutes * 60 * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await sleep(5000);
  }
  return null;
}

async function runCancellation(save: (name: string, data: unknown) => Promise<void>) {
  const events: { call: string; [key: string]: unknown }[] = [];
  const { control } = await controlFor('run', events);
  const status = await control.inspect({ kind: 'status' });
  if (!('controller_run_id' in status)) throw new Error('INVALID_CONTROL_STATUS');
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const { serveControl } = await import('../../src/entrypoints/controller/serve.js');
  const server = await serveControl(`${observations}/run/control.sock`, control, status.controller_run_id, () => stop.abort());
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === syntheticTicket.number);
  const code = (w: WorkView | undefined, impediment: string) => w?.impediments.some(item => item.code === impediment) ?? false;
  let outcome: string = 'completed';
  try {
    const started = await waitFor(waits.startMinutes, async () => {
      const w = await work();
      return w?.execution?.state === 'started' ? w : null;
    });
    if (!started) {
      outcome = 'EXECUTION_NOT_STARTED';
      return;
    }
    await save('human-step-1-remove-label', { work_id: started.work_id, action: `remove the label ${repository.label} from issue #${syntheticTicket.number}` });
    const withdrawn = await waitFor(waits.humanStepMinutes, async () => {
      const w = await work();
      return code(w, 'AUTHORIZATION_WITHDRAWN') ? w! : null;
    });
    if (!withdrawn) {
      outcome = 'WITHDRAWAL_NOT_OBSERVED';
      return;
    }
    events.push({ at: new Date().toISOString(), call: 'withdrawal-observed', executionState: withdrawn.execution?.state ?? null });
    await save('human-step-2-restore-label', { work_id: started.work_id, action: `re-add the label ${repository.label} to issue #${syntheticTicket.number}` });
    const restored = await waitFor(waits.humanStepMinutes, async () => {
      const w = await work();
      return w?.authorization.withdrawal?.restoredObservedAt ? w : null;
    });
    if (!restored) {
      outcome = 'RESTORATION_NOT_OBSERVED';
      return;
    }
    events.push({
      at: new Date().toISOString(),
      call: 'restoration-observed',
      suspended: code(restored, 'AUTHORIZATION_WITHDRAWN'),
      executionState: restored.execution?.state ?? null,
    });
    await save('human-step-3-cancel', {
      work_id: started.work_id,
      command: cancelCommand(started.work_id),
      note: 'run from the composed checkout while the build still runs',
    });
    // The cancellation must arrive through the CLI socket: observed as the durable receipt of that request id and the Work's cancellation.
    let lastState: string | null = null;
    const cancelled = await waitFor(waits.humanStepMinutes, async () => {
      const w = await work();
      if (w?.cancellation?.request_id === cancelRequestId) return w;
      lastState = w?.execution?.state ?? null;
      return null;
    });
    if (!cancelled) {
      outcome = 'CANCEL_NOT_REQUESTED';
      return;
    }
    const receipt = await control.inspect({ kind: 'request', request_id: cancelRequestId });
    events.push({
      at: new Date().toISOString(),
      call: 'cancel-accepted',
      receipt,
      executionState: lastState,
      executionAtCommit: cancelled.cancellation?.executionId ?? null,
      via: 'cli-socket',
    });
    const ceased = await waitFor(waits.cessationMinutes, async () => {
      const w = await work();
      return w?.cancellation?.state === 'ceased' ? w : null;
    });
    if (!ceased) outcome = 'CANCELLATION_NOT_CEASED_IN_WAIT';
  } finally {
    const final = await work();
    const shown = final ? ((await control.inspect({ kind: 'show', work_id: final.work_id })) as Extract<ShowView, { kind: 'work' }>) : null;
    const finalStatus = await control.inspect({ kind: 'status' });
    stop.abort();
    const stopped = await running;
    await server.close().catch(() => {});
    await save('run-result', {
      outcome,
      ...runVerdict(final, events),
      cancellation: final?.cancellation?.state ?? null,
      final: shown,
      controlStatus: finalStatus,
      stopped,
      events,
    });
  }
}

async function runNewCycle(save: (name: string, data: unknown) => Promise<void>, cancelledWorkId: string) {
  const events: { call: string; [key: string]: unknown }[] = [];
  const { control, counts } = await controlFor('new', events);
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const list = async () => (await control.inspect({ kind: 'list' })) as ListView;
  try {
    const paused = await control.accept({ request_id: 'q25-pause-1', operation: 'pause', origin: 'local-cli' });
    const settledBefore = (await list()).works.find(item => item.work_id === cancelledWorkId);
    // Two polling cycles with the label present: the cancelled cycle must stay untouched.
    await waitFor(3, async () => ((await list()).polling.cycles >= 2 ? true : null));
    const afterCycles = await list();
    const receipt = (await control.accept({
      request_id: 'q25-new-1',
      operation: 'new',
      ticket: { repository: repository.repository, number: syntheticTicket.number },
      keepPredecessorPullRequest: false,
      origin: 'local-cli',
    })) as { created?: string | null };
    const confirmed = receipt.created
      ? await waitFor(3, async () => {
          const successor = (await list()).works.find(item => item.work_id === receipt.created);
          return successor && !successor.impediments.some(item => item.code === 'AUTHORIZATION_NOT_CONFIRMED') ? successor : null;
        })
      : null;
    const final = await list();
    await save('new-result', {
      paused,
      cancelledBefore: settledBefore,
      afterCycles: {
        cycles: afterCycles.polling.cycles,
        cancelled: afterCycles.works.find(item => item.work_id === cancelledWorkId),
        candidates: afterCycles.polling.repositories.map(item => item.candidates),
      },
      receipt,
      successorConfirmed: confirmed,
      final,
      counts: counts(),
      events,
    });
  } finally {
    stop.abort();
    await running;
  }
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  // Before ANY effect (not even a filesystem module is loaded): without the pinned synthetic issue nothing real may run.
  if (phase !== 'inspect' && phase !== 'stop-environment' && syntheticTicket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  if (phase === 'preflight') {
    // Before ANY effect (no directory, no intent, no GitHub call): the App key the namespace copies must exist.
    await requireKeySource(path => fs.access(path));
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    await fs.mkdir(`${observations}/credentials`, { mode: 0o700 });
    await fs.mkdir(`${observations}/run`, { mode: 0o700 });
  }
  const run = await load('run-result');
  const refused = phaseGuard(
    phase,
    { preflight: await load('preflight-result'), run: run ? { cancellation: run.cancellation } : null },
    new Set(
      (await Promise.all(phases.map(async item => ((await exists(`${item}-intent`)) ? `${item}-intent` : null)))).filter(
        (item): item is string => item !== null,
      ),
    ),
  );
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  // Review LOW: the App key copy happens only AFTER the preflight intent tombstone; only the final phase (inspect) removes it.
  if (phase === 'preflight') {
    const { constants } = await import('node:fs');
    await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
    await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
  }
  try {
    if (phase === 'preflight') {
      const { github, tracker, codeRepository } = await compose([]);
      const listing = await tracker.listCandidates(repository);
      const only =
        listing.kind === 'observed' &&
        listing.candidates.length === 1 &&
        listing.candidates[0]!.number === syntheticTicket.number &&
        listing.repositoryId === repositoryId;
      const issue = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${syntheticTicket.number}`));
      const value = issue.ok ? (issue.value as { number: number; state: string; title?: string; body?: string | null; labels: { name: string }[] }) : null;
      const reasons = [
        ...(only ? [] : ['LISTING_NOT_EXACTLY_THE_SYNTHETIC_ISSUE']),
        ...(value ? ticketMatches({ ...value, repositoryId: listing.kind === 'observed' ? listing.repositoryId : 0 }) : ['ISSUE_READ_FAILED']),
      ];
      const ref = only && listing.kind === 'observed' ? listing.candidates[0]! : null;
      const publication = ref ? await codeRepository.findPublication({ repo: repository, issueNumbers: [ref.number], knownBranches: [] }) : null;
      const associated = publication?.kind === 'observed' ? publication.issues[String(syntheticTicket.number)] : undefined;
      if (associated?.completeness !== 'complete' || associated.candidates.length) reasons.push('ASSOCIATED_PULL_REQUEST_OR_UNKNOWN');
      const graph = ref ? await tracker.readDependencyGraph(ref) : null;
      await save('preflight-result', {
        status: reasons.length ? 'held' : 'success',
        reasons,
        listing,
        issue: value ? { number: value.number, state: value.state, labels: value.labels.map(item => item.name) } : issue,
        associated,
        graph: graph ? { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems } : null,
      });
      if (reasons.length) throw new Error(reasons.join(',').slice(0, 128));
      return;
    }
    if (phase === 'inspect' || phase === 'stop-environment') {
      await inspectOrStop(phase, save);
      return;
    }
    const lock = await holdStorageLock(`${observations}/control.lock`);
    try {
      if (phase === 'run') {
        await runCancellation(save);
        return;
      }
      const final = (run!.final as Extract<ShowView, { kind: 'work' }> | null)?.work;
      if (!final?.execution || needsStop(final.execution)) throw new Error('RUN_EXECUTION_NOT_CEASED');
      await runNewCycle(save, final.work_id);
    } finally {
      await lock.release();
    }
  } catch (error) {
    await save(`${phase}-held`, {
      phase,
      status: 'held',
      code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN',
      note: 'Consumed; no retry.',
    }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    if (phase === 'inspect') await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

async function inspectOrStop(phase: 'inspect' | 'stop-environment', save: (name: string, data: unknown) => Promise<void>) {
  const fs = await import('node:fs/promises');
  const lock = await holdStorageLock(`${observations}/control.lock`);
  let works: WorkView[];
  try {
    const stored = await openStorageCopy(`${observations}/control.sqlite`, `${observations}/${phase}-storage-copy`);
    try {
      works = ((await stored.control.inspect({ kind: 'list' })) as ListView).works;
    } finally {
      await stored.close();
    }
  } finally {
    await lock.release();
  }
  const cancelled = works.find(item => item.cycle === 1 && item.ticket.number === syntheticTicket.number);
  if (phase === 'inspect') {
    const trace = (await fs.readFile(ghTrace, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { method: string | null; endpoint: string; allowed: boolean });
    const storage = Buffer.concat(
      await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(name => fs.readFile(`${observations}/${name}`).catch(() => Buffer.alloc(0)))),
    );
    const { tracker } = await compose([]);
    const issue = cancelled ? await tracker.readTicket(cancelled.ticket) : null;
    await save('inspect-result', {
      works,
      issue,
      gh: { requests: trace.length, refused: trace.filter(item => !item.allowed), methods: [...new Set(trace.map(item => item.method))] },
      secretScan: { ghs: storage.includes(Buffer.from('ghs_')), privateKey: storage.includes(Buffer.from('PRIVATE KEY')) },
    });
    return;
  }
  if (!cancelled?.execution || !needsStop(cancelled.execution)) throw new Error('NOTHING_TO_STOP');
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const sandbox = createSandbox({ root, guestAssets });
  const environment = cancelled.execution.dispatch.environment as never,
    boot = cancelled.execution.dispatch.boot as never;
  const before = await sandbox.observe({ environment, boot });
  const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q25 explicit stop of own boot' }) : null;
  await save('stop-environment-result', { state: cancelled.execution.state, before, result });
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify(plan(), null, 2));
    return;
  }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`,
      );
      process.exit(1);
    },
  );
}
