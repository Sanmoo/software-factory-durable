import type { ExecutionPorts, ExecutionView, ListView, QuestionView, ShowView } from '../../src/control/index.js';

// TEST ONLY. Ticket 11 one-shot real qualification recipe: inaccessible private source -> durable Question (incomplete capture), answer while
// the controller is DOWN, COMPATIBLE continuation of the same session (`continue`), a later Ticket edit that authorizes nothing, then a
// PARTIAL `update-scope` resumed with a deliberately INCOMPATIBLE Host policy (session REPLACED with its reason and recoverable context).
// Import and `--plan` are inert. Every other phase is a REAL effect and requires an explicit operator grant: real GitHub (App), a real
// Gondolin/KVM VM and a real model. Phases are one-shot (exclusive intent tombstone before effects; a consumed phase never reruns);
// nothing is retried automatically. GitHub writes: at most ONE Question comment per phase, only on Ticket #3.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q11-context-v1`;
const revision = 'q11-context-v1';
const phases = ['preflight', 'ask', 'continue', 'scope', 'inspect', 'stop-environment'] as const;
type Phase = (typeof phases)[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
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
const phaseDeadlineMs = 45 * 60 * 1000;
const skillPack = 'factory-skills-v4' as const;
/** ask/continue: the full Builder policy; scope: the SAME pack without the edit tool, a deliberate Host change that makes the session incompatible. */
const policies = {
  full: { skillPack, modelBudget: 'builder-v1' as const, copyOutput: true, editSourceMaxBytes: 8192 },
  withoutEdit: { skillPack, modelBudget: 'builder-v1' as const, copyOutput: true },
};
/** The operator's partial authorization (fixed text and request identity: the request is idempotent, never re-sent with other content). */
const scopeUpdate = {
  request_id: 'q11-scope-1',
  reason:
    'Incorporate ONLY requirement B1 of the edited Ticket (add the line "Context continuation: verified." to ' +
    'docs/factory-question.md). Do NOT adopt requirement B2 or any other later edit.',
};
const systemPrompt =
  'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. ' +
  'Never push, open pull requests, change GitHub state, request broader access or use another credential. When you need information or an ' +
  'approval you do not have, use the ask_user tool instead of working around it.';
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;

export function plan() {
  return {
    revision,
    root,
    observations,
    phases,
    repository,
    expectedTicket,
    operators: [operatorLogin],
    operatorIdentity: 'pinned at preflight to the user id GitHub reports for this login (repository owner, type User); comments then match by id only',
    storage:
      'ask/continue/scope hold an exclusive flock on observations/control.lock; inspect/stop-environment read a fresh copy of the storage taken under that lock (never write it)',
    configuration,
    guestAssets,
    skillPack,
    policies,
    scopeUpdate,
    model: {
      provider: 'openai',
      model: 'gpt-6-luna',
      api: 'openai-responses',
      auth: 'factory-oauth (operator first-login store under root/credentials)',
      budget: 'builder-v1',
      maxActivations: 3,
      perActivation: { maxRequests: 60, maxToolCalls: 120, deadlineMinutes: 30 },
      providerRetries: 0,
      sdkRetries: 0,
      providerBillingHardCap: false,
    },
    github: {
      app: githubApp,
      controllerPurposes: [
        'tracker-read',
        'association-read',
        'dependency-read',
        'repository-read',
        'repository-fetch {metadata:read, contents:read}',
        'question-publish {metadata:read, issues:write}',
      ],
      builderPurpose:
        'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only (never widened for the private source)',
      writes:
        'at most ONE POST /repos/Sanmoo/java-springboot-event-sourcing/issues/3/comments per phase (ask, continue, scope): a Question comment with its marker; no label/assignee/state change',
    },
    ticketSetup: {
      beforePreflight:
        'Issue #3 (the ONLY open issue with ready-for-agent) body: create docs/factory-question.md; the REQUIRED source is the private document ' +
        'https://github.com/Sanmoo/factory-private-spec/blob/main/SPEC.md (inaccessible to the Factory); if you cannot read a required source, ask the operator.',
      afterAsk:
        'With the controller STOPPED: (1) ONE comment on #3 from Sanmoo starting exactly with `/factory answer <question-id> The private document is gone; ' +
        'its only requirement: docs/factory-question.md contains the line "Answer: use this file."` (question id in ask-result.json); (2) EDIT the body of #3 adding ' +
        '"B1: add the line Context continuation: verified. B2: also rename the file to docs/factory-renamed.md." (a later edit that authorizes nothing)',
    },
    effects: [
      'preflight: read-only GitHub: the configured label lists exactly Ticket #3; Ticket, native blocked_by, comments and the issue body hash are read; operator id pinned',
      'ask: new storage; ONE Execution (prepare/start: 1 new VM; Builder /implement with pack v4); the Builder cannot read the private source with its repository-scoped grant, ' +
        'preserves spec/v1 with "complete": false + missing, and calls ask_user; Question + impediment + intent committed before the ACK; credentials withdrawn; stop; Slot after ' +
        'cessation; ONE comment on #3. The owner records the preserved session (host runtime path, hash, profile) with the end',
      'continue: same storage; refused unless ask ended with a Question and confirmed cessation; the answer comment (posted while the controller was down) is accepted; the issue body ' +
        'hash is recorded (the edit is observed but triggers/authorizes nothing); dispatch revalidates, prepare REUSES the environment/branch (NEW boot); Workers.observe finds the ' +
        'recorded session intact and compatible: the owner copies it and the Builder CONTINUES it with a `continue` message carrying the answer (no /implement); ends',
      'scope: same storage; refused unless continue ended completed with confirmed cessation; update-scope (fixed request id/reason, partial authorization B1 only) is accepted ' +
        'and re-queues the idle Work; dispatch with the Builder policy WITHOUT edit: the session is REPLACED (SESSION_INCOMPATIBLE: tools differ) by an explicit recovery ' +
        'instruction with the reason, recoverable context (Work, request, instructions, Git, artifacts, known effects) and the scope change; ends',
      'inspect: read-only: storage view (Works, Executions, Questions, scope updates), comments and body hash of #3, confined no-follow reads of /artifacts (spec/v1..v4 sources), ' +
        'checkout via a Factory-owned bare copy (never host git in the guest tree), start receipts, confined host reads of every Builder session JSONL (tool calls, whether the ' +
        '`continue`/recovery message is in the session and what the model did after it), and a secret scan (ghs_/PRIVATE KEY) of the own storage, of EVERY protected Records evidence ' +
        'output of the Work and of the recipe observation JSONs',
      'stop-environment: own boot of the current Execution when it may still run and is observed active: public Sandbox.stop of that exact boot',
    ],
    guards: [
      'one-shot intent tombstones',
      'per phase: prepare <= 1, activate <= 1 Builder, postComment <= 1 and only for Ticket #3',
      'no retry',
      'no remove/cleanup',
      'no push/PR (read-only Builder grant)',
      'update-scope sent once with a fixed identity and content',
    ],
    expected: [
      'ask: end.outcome question, cessation confirmed, end.session recorded (format pi-session-jsonl-v3, profile tools incl. edit); spec/v1 sources.json complete:false with the private source in missing',
      'continue: execution.request.session {mode: continue, reason: SESSION_COMPATIBLE}; activate phaseId builder-continuation with continuation.session = the ask session; prompt starts with `continue`; ' +
        'start receipt session.mode continue with that sessionId/sha256; spec/v2 records factory-question:<id>; docs/factory-question.md committed; B1/B2 NOT implemented',
      'scope: receipt outcome accepted (idle after completed); request.resume.reason SCOPE_UPDATED with scopeUpdateIds [scope-q11-scope-1]; request.session {mode: replace, reason: SESSION_INCOMPATIBLE}; ' +
        'a plan whose pack does not define the continue protocol records SESSION_CONTINUATION_UNSUPPORTED instead (never a continue); ' +
        'prompt starts with `Factory recovery instruction` and names the reason, previous executions and the scope change; scope update delivered; spec/v3 records factory-scope:scope-q11-scope-1 ' +
        'with authorized B1 and notAdopted B2; the B1 line committed; the file NOT renamed',
      'delivery vs consumption: Control records only delivery (scope update `delivered`, continuation prompt hash); consumption is evidenced only by the session JSONL (the message present and later model turns) and the commits',
      'no token in storage/receipts/sessions/observations; the Builder never pushes',
    ],
  };
}

/**
 * Completion of the CURRENT phase in this process. A phase is complete once its `<phase>-result` observation was durably saved (exclusive
 * create + fsync). After that, failures of the teardown (lock release, storage-copy close) or late asynchronous errors are recorded in
 * `<phase>-teardown.json` and never turn the completed phase into a failure; before it, every error holds the phase (no retry).
 */
export type PhaseState = { phase: string; resultSaved: boolean; teardown: { stage: string; code: string; at: string }[] };
export const newPhaseState = (phase: string): PhaseState => ({ phase, resultSaved: false, teardown: [] });
/** Bounded code of an error, never its stack/cause (no diagnostics that might carry secrets). */
const errorCode = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 128);
const noteTeardown = (state: PhaseState, stage: string, error: unknown) => {
  state.teardown.push({ stage, code: errorCode(error), at: new Date().toISOString() });
};

/** Runs the phase body, then its teardown. A teardown error is recorded; it fails the phase only when no result was saved yet. */
export async function withTeardown(state: PhaseState, body: () => Promise<void>, teardown: () => Promise<void>): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await body();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await teardown();
  } catch (error) {
    noteTeardown(state, 'teardown', error);
    if (!failed && !state.resultSaved) throw error;
  }
  if (failed) throw failure;
}

/** Exit code of a recipe process: 0 when it ended without error or after its result was durably saved; 1 otherwise (held, no retry). */
export function phaseExitCode(state: PhaseState | null, error: unknown): 0 | 1 {
  return error === undefined || state?.resultSaved === true ? 0 : 1;
}

/**
 * Late asynchronous error (uncaught exception / unhandled rejection) of a recipe process. After a complete save it is recorded and the
 * process still exits 0; before it the process fails closed with exit 1 at once.
 */
export function lateErrorDecision(state: PhaseState | null): 'record' | 'fail' {
  return state?.resultSaved === true ? 'record' : 'fail';
}

/**
 * CLI driver (the only place with process-level effects; never run on import). `deps` are the process hooks so the exit semantics are
 * testable in a child process.
 */
export async function cli(
  args: string[],
  deps: {
    run(args: string[], state: PhaseState | null): Promise<void>;
    exit(code: 0 | 1): void;
    on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): void;
    recordLate(state: PhaseState, code: string): void;
    error(text: string): void;
  },
) {
  const state = args.length === 1 && phases.includes(args[0] as Phase) ? newPhaseState(args[0]!) : null;
  const late = (error: unknown) => {
    if (lateErrorDecision(state) === 'fail') {
      deps.error('Qualification held; no retry.');
      deps.exit(1);
      return;
    }
    // The phase result is complete: record the late error next to it, never as a failure of the phase.
    try {
      deps.recordLate(state!, errorCode(error));
    } catch {
      /* recording is best effort; the saved result stands */
    }
  };
  deps.on('uncaughtException', late);
  deps.on('unhandledRejection', late);
  let failure: unknown;
  try {
    await deps.run(args, state);
  } catch (error) {
    failure = error;
  }
  const code = phaseExitCode(state, failure);
  if (code !== 0) deps.error('Qualification held; no retry.');
  deps.exit(code);
}

async function io(state: PhaseState | null = null) {
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
    // Durable (exclusive, fsync'ed and closed): from now on the phase is complete.
    if (state && name === `${state.phase}-result`) state.resultSaved = true;
  };
  const load = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8')) as Record<string, unknown>;
  const exists = (name: string) =>
    fs.access(`${observations}/${name}.json`).then(
      () => true,
      () => false,
    );
  return { fs, save, load, exists };
}

async function compose(events: unknown[]) {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const { guardTracker } = await import('./question10-qualification.js');
  const github = createGitHubAccess({ root, ...githubApp });
  const tracker = guardTracker(createIssueTracker({ github, scopes: [repository], dependencyScopes: [] }), events);
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}

/** Read-only observation of the Ticket body (hash, updatedAt, bounded excerpt): evidence that a later edit happened and authorized nothing. */
async function ticketBody(github: Awaited<ReturnType<typeof compose>>['github']) {
  const { createHash } = await import('node:crypto');
  const read = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${expectedTicket.number}`));
  if (!read.ok) return { observed: false };
  const issue = read.value as { body?: unknown; updated_at?: unknown };
  const body = typeof issue.body === 'string' ? issue.body : '';
  return { observed: true, updatedAt: issue.updated_at, sha256: createHash('sha256').update(body).digest('hex'), excerpt: body.slice(0, 4000) };
}

/** Phase preconditions on the previous phase's recorded result (fail closed). */
export function precondition(phase: 'continue' | 'scope', previous: Record<string, unknown> | null): string | null {
  const work = (previous?.final as ListView | undefined)?.works.find(item => item.ticket.number === expectedTicket.number);
  const execution = work?.execution;
  if (!execution) return `${phase.toUpperCase()}_PREVIOUS_EXECUTION_MISSING`;
  if (!(execution.state === 'ended' && execution.end?.cessation === 'confirmed')) return `${phase.toUpperCase()}_PREVIOUS_NOT_CEASED`;
  if (phase === 'continue' && execution.end?.outcome !== 'question') return 'CONTINUE_REQUIRES_QUESTION';
  if (phase === 'scope' && execution.end?.outcome !== 'completed') return 'SCOPE_REQUIRES_COMPLETED';
  return null;
}

/** The recipe's own boot may still run unless the Execution was released or ended with confirmed cessation. */
export function needsStop(execution: ExecutionView): boolean {
  if (!execution.dispatch.boot || execution.state === 'released') return false;
  return !(execution.state === 'ended' && execution.end?.cessation === 'confirmed');
}

async function runControl(phase: 'ask' | 'continue' | 'scope', save: (name: string, data: unknown) => Promise<void>, pinned: { login: string; id: number }[]) {
  const events: unknown[] = [];
  const log = (entry: Record<string, unknown>) => {
    events.push({ at: new Date().toISOString(), ...entry });
  };
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose(events);
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { createWorkers, skillPacks } = await import('../../src/workers/index.js');
  const { createHash } = await import('node:crypto');
  const { settled } = await import('./question10-qualification.js');
  const pack = skillPacks[skillPack];
  const { openControl } = await import('../../src/control/index.js');
  const sandbox = createSandbox({
    root,
    guestAssets,
    repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }],
  });
  const workers = createWorkers({
    root,
    knownSecrets: [],
    profile: { id: sdkProfileId, systemPrompt, auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses' },
  });
  const credentials = createBuilderCredentials({ github, repositories: [repository] });
  let prepared = 0,
    activated = 0;
  const holder: { control?: Awaited<ReturnType<typeof openControl>> } = {};
  const allowed = async (workId: string) => {
    const shown = await holder.control!.inspect({ kind: 'show', work_id: workId });
    return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
  };
  const execution: ExecutionPorts = {
    configuration,
    capacity: 1,
    credentials,
    builder: phase === 'scope' ? policies.withoutEdit : policies.full,
    sandbox: {
      async prepare(input) {
        log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
        if (++prepared !== 1 || !(await allowed(input.workId))) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
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
    },
    workers: {
      async activate(invocation, delivery, handlers) {
        log({
          call: 'activate',
          context: invocation.context,
          promptSha256: createHash('sha256').update(invocation.prompt).digest('hex'),
          promptHead: invocation.prompt.slice(0, 160),
          continuation: invocation.continuation ?? null,
          credentialDelivered: delivery?.credential !== undefined,
        });
        if (++activated !== 1) throw new Error('RECIPE_ONE_SHOT_GUARD');
        const handle = await workers.activate(invocation, delivery, {
          question: async question => {
            log({ call: 'question', questionId: question.questionId, sha256: question.sha256 });
            const ack = await handlers!.question!(question);
            log({ call: 'question-ack', ack });
            return ack;
          },
        });
        void handle.completed.then(
          done => log({ call: 'completed', status: done.status, session: 'session' in done ? (done.session ?? null) : null }),
          () => log({ call: 'completion-uncertain' }),
        );
        return handle;
      },
      async deliver(worker, directive) {
        log({ call: 'deliver', kind: directive.kind });
        const result = await workers.deliver(worker, directive);
        log({ call: 'deliver-result', result });
        return result;
      },
      // Q6 observe of the preserved session (confined host read of the runtime tree); logged with its result.
      async observe(input) {
        const result = await workers.observe(input);
        log({ call: 'observe', input: { executionId: input.executionId, session: input.session, next: input.next }, result });
        return result;
      },
    },
  };
  const control = (holder.control = await openControl({
    storagePath: `${observations}/control.sqlite`,
    // Recipe decision: root/environments holds only earlier qualification resources and, after `ask`, this storage's own environment whose
    // boot ceased (checked by the phase precondition); none is running for this storage.
    runtimeInventory: 'empty',
    access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [], operators: pinned },
    polling: { intervalSeconds: 30 },
    execution,
  }));
  const body = await ticketBody(github);
  let scopeReceipt: unknown = null;
  if (phase === 'scope') {
    const list = (await control.inspect({ kind: 'list' })) as ListView;
    const work = list.works.find(item => item.ticket.number === expectedTicket.number);
    if (!work) throw new Error('SCOPE_WORK_MISSING');
    // The partial authorization, sent ONCE with its fixed identity (a repeated identity returns the same durable receipt).
    scopeReceipt = await control.accept({
      request_id: scopeUpdate.request_id,
      operation: 'update-scope',
      work_id: work.work_id,
      reason: scopeUpdate.reason,
      origin: 'local-cli',
    });
    log({ call: 'update-scope', receipt: scopeReceipt });
  }
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + phaseDeadlineMs;
  const before = phase === 'ask' ? 0 : phase === 'continue' ? 1 : 2;
  const triggerDeadline = Date.now() + 5 * 60 * 1000;
  let final: ListView | undefined;
  let questions: QuestionView[] = [];
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const list = (await control.inspect({ kind: 'list' })) as ListView;
    const work = list.works.find(item => item.ticket.number === expectedTicket.number);
    questions = work ? ((await control.inspect({ kind: 'show', work_id: work.work_id })) as Extract<ShowView, { kind: 'work' }>).questions : [];
    if (activated > 0 && settled(list, questions, before)) {
      final = list;
      break;
    }
    if (phase !== 'ask' && activated === 0 && Date.now() > triggerDeadline) {
      log({ call: 'resumption-not-observed' });
      final = list;
      break;
    }
  }
  final ??= (await control.inspect({ kind: 'list' })) as ListView;
  const work = final.works.find(item => item.ticket.number === expectedTicket.number);
  const shown = work ? ((await control.inspect({ kind: 'show', work_id: work.work_id })) as Extract<ShowView, { kind: 'work' }>) : null;
  const status = await control.inspect({ kind: 'status' });
  stop.abort();
  const outcome = await running;
  const open = questions
    .filter(question => question.state === 'open')
    .map(question => ({
      questionId: question.questionId,
      comment: question.publication.comment,
      publication: question.publication.state,
      answerWith: `/factory answer ${question.questionId} <answer>`,
    }));
  await save(`${phase}-result`, {
    status: 'observed',
    outcome,
    final,
    show: shown,
    questions,
    open,
    scopeReceipt,
    ticketBody: body,
    controlStatus: status,
    events,
    deadlineReached: Date.now() >= deadline,
  });
}

export async function runPhase(phase: Phase, state: PhaseState = newPhaseState(phase)) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, load, exists } = await io(state);
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { tracker, github } = await compose([]);
      const { resolveOperator } = await import('./question10-qualification.js');
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
        listing.candidates[0]!.number !== expectedTicket.number ||
        listing.repositoryId !== expectedTicket.repositoryId
      ) {
        await save('preflight-held', { listing });
        throw new Error('PRECONDITION_HELD');
      }
      const ticket = await tracker.readTicket(listing.candidates[0]!);
      const graph = await tracker.readDependencyGraph(listing.candidates[0]!);
      const inputs = await tracker.readInputs(listing.candidates[0]!, null);
      await save('preflight-result', {
        status: 'success',
        operators: [operator],
        ticket,
        ticketBody: await ticketBody(github),
        graph: { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems },
        comments: inputs.kind === 'observed' ? { completeness: inputs.completeness, count: inputs.comments.length, cursor: inputs.cursor } : inputs,
      });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    const pinned = (await load('preflight-result')).operators as { login: string; id: number }[];
    if (!Array.isArray(pinned) || pinned.length !== 1) throw new Error('OPERATOR_IDENTITY_UNRESOLVED');
    const { holdStorageLock } = await import('./question10-qualification.js');
    const lock = await holdStorageLock(`${observations}/control.lock`);
    await withTeardown(
      state,
      async () => {
        if (phase === 'ask') {
          await runControl('ask', save, pinned);
          return;
        }
        if (phase === 'continue' || phase === 'scope') {
          const previous = phase === 'continue' ? 'ask-result' : 'continue-result';
          const refused = precondition(phase, (await exists(previous)) ? await load(previous) : null);
          if (refused) throw new Error(refused);
          await runControl(phase, save, pinned);
          return;
        }
        await inspectOrStop(phase, save);
      },
      () => lock.release(),
    );
  } catch (error) {
    // An error AFTER the complete result (e.g. while closing) is recorded, not a held phase: the evidence is already durable.
    if (state.resultSaved) noteTeardown(state, 'after-result', error);
    else {
      await save(`${phase}-held`, { phase, status: 'held', code: errorCode(error), note: 'Consumed; no retry.' }).catch(() => {});
      throw new Error('QUALIFICATION_HELD');
    }
  } finally {
    if (state.teardown.length)
      await save(`${phase}-teardown`, {
        phase,
        resultSaved: state.resultSaved,
        events: state.teardown,
        note: 'Recorded after the phase; the saved result is complete and the phase is not retried.',
      }).catch(() => {});
  }
}

/** Tool calls and the Factory resume messages of one Builder session JSONL (host runtime tree, read confined): delivery vs later model turns. */
export function sessionSummary(jsonl: string) {
  const entries: { role: string; text: string; tools: string[] }[] = [];
  for (const line of jsonl.split('\n').slice(0, 20000)) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !entry.message?.role) continue;
    const content = Array.isArray(entry.message.content) ? (entry.message.content as { type?: string; text?: string; name?: string }[]) : [];
    const text =
      typeof entry.message.content === 'string'
        ? entry.message.content
        : content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
    entries.push({
      role: entry.message.role,
      text: text.slice(0, 200),
      tools: content.flatMap(block => (block.type === 'toolCall' && typeof block.name === 'string' ? [block.name] : [])),
    });
  }
  const resumeAt = entries.findIndex(item => item.role === 'user' && /^(continue\n|Factory recovery instruction)/.test(item.text));
  return {
    messages: entries.length,
    userMessages: entries.filter(item => item.role === 'user').map(item => item.text.slice(0, 120)),
    resumeMessageIndex: resumeAt,
    toolCallsAfterResume:
      resumeAt < 0
        ? []
        : entries
            .slice(resumeAt + 1)
            .flatMap(item => item.tools)
            .slice(0, 200),
    assistantTurnsAfterResume: resumeAt < 0 ? 0 : entries.slice(resumeAt + 1).filter(item => item.role === 'assistant').length,
    toolCalls: entries.flatMap(item => item.tools).slice(0, 500),
  };
}

async function inspectOrStop(phase: 'inspect' | 'stop-environment', save: (name: string, data: unknown) => Promise<void>) {
  const fs = await import('node:fs/promises');
  const { openStorageCopy } = await import('./question10-qualification.js');
  const stored = await openStorageCopy(`${observations}/control.sqlite`, `${observations}/${phase}-storage-copy`);
  let list: ListView, shown: Extract<ShowView, { kind: 'work' }> | undefined;
  try {
    list = (await stored.control.inspect({ kind: 'list' })) as ListView;
    const found = list.works.find(item => item.execution);
    shown = found ? ((await stored.control.inspect({ kind: 'show', work_id: found.work_id })) as Extract<ShowView, { kind: 'work' }>) : undefined;
  } finally {
    await stored.close();
  }
  const work = list.works.find(item => item.execution);
  if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
  const environmentDirectory = `${root}/environments/${work.execution.dispatch.environment}`;
  if (phase === 'inspect') {
    const { readConfined } = await import('../../src/sandbox/index.js');
    const { readSessionFile, workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
    const { inspectEnvironment } = await import('./builder09-qualification.js');
    const { tracker, github } = await compose([]);
    const comments = await tracker.readInputs(work.ticket, null);
    const executions = [...work.previousExecutions, work.execution];
    const receipts: Record<string, string | null | { error: string }> = {};
    for (const execution of executions) {
      if (execution.start)
        receipts[execution.executionId] = await readConfined(root, `${work.work_id}/evidence/${execution.start.receiptId}/output`, 65536).then(
          bytes => (bytes === null ? null : bytes.toString('utf8')),
          (error: Error) => ({ error: error.message }),
        );
    }
    // Every Builder session of this storage's boots, through the confined Host session reader (private runtime tree, no-follow).
    const sessions: Record<string, unknown>[] = [];
    for (const execution of executions) {
      if (!execution.dispatch.boot) continue;
      const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
      for (const launch of (await fs.readdir(runtime).catch(() => []))
        .filter(name => /^w-[A-Za-z0-9]+$/.test(name))
        .sort()
        .slice(0, 4)) {
        for (const file of (await fs.readdir(`${runtime}/${launch}/profile/sessions`).catch(() => [])).filter(name => name.endsWith('.jsonl')).slice(0, 2)) {
          const ref = `${runtime.slice(root.length + 1)}/${launch}/profile/sessions/${file}`;
          const read = await readSessionFile(root, ref);
          sessions.push(
            read.state === 'read'
              ? {
                  executionId: execution.executionId,
                  ref,
                  sessionId: read.sessionId,
                  sha256: read.sha256,
                  bytes: read.data.length,
                  tokenPattern: /ghs_|PRIVATE KEY/.test(read.data.toString('utf8')),
                  ...sessionSummary(read.data.toString('utf8')),
                }
              : { executionId: execution.executionId, ref, ...read },
          );
        }
      }
    }
    const artifacts = `${environmentDirectory}/artifacts`;
    const confined = async (relative: string) =>
      readConfined(artifacts, relative, 1024 * 1024).then(
        bytes => (bytes === null ? { absent: true } : { text: bytes.toString('utf8').slice(0, 262144) }),
        (error: Error) => ({ error: error.message }),
      );
    const versions: Record<string, unknown> = {};
    for (const kind of ['spec', 'instructions'])
      for (const version of ['v1', 'v2', 'v3', 'v4']) versions[`${kind}/${version}`] = await confined(`${kind}/${version}/sources.json`);
    const storage = Buffer.concat(
      await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(name => fs.readFile(`${observations}/${name}`).catch(() => Buffer.alloc(0)))),
    );
    // The evidence claims "no token in storage/receipts/sessions/observations": scan each of those scopes, not just the storage.
    const scan = (bytes: Buffer) => ({ ghs: bytes.includes(Buffer.from('ghs_')), privateKey: bytes.includes(Buffer.from('PRIVATE KEY')) });
    const recordsScan = { files: 0, unreadable: 0, ghs: false, privateKey: false };
    for (const id of (await fs.readdir(`${root}/${work.work_id}/evidence`).catch(() => []))
      .filter(name => /^[0-9a-f-]{36}$/.test(name))
      .sort()
      .slice(0, 200)) {
      const bytes = await readConfined(root, `${work.work_id}/evidence/${id}/output`, 1024 * 1024).catch(() => null);
      if (bytes === null) {
        recordsScan.unreadable++;
        continue;
      }
      recordsScan.files++;
      const found = scan(bytes);
      recordsScan.ghs ||= found.ghs;
      recordsScan.privateKey ||= found.privateKey;
    }
    const observationsScan = { files: 0, unreadable: 0, ghs: false, privateKey: false };
    for (const name of (await fs.readdir(observations))
      .filter(name => name.endsWith('.json'))
      .sort()
      .slice(0, 200)) {
      const bytes = await fs.readFile(`${observations}/${name}`).catch(() => null);
      if (bytes === null) {
        observationsScan.unreadable++;
        continue;
      }
      observationsScan.files++;
      const found = scan(bytes);
      observationsScan.ghs ||= found.ghs;
      observationsScan.privateKey ||= found.privateKey;
    }
    await save('inspect-result', {
      work,
      questions: shown?.questions ?? [],
      scopeUpdates: shown?.work.scopeUpdates ?? [],
      receipts,
      sessions,
      versions,
      ticketBody: await ticketBody(github),
      comments:
        comments.kind === 'observed'
          ? comments.comments.map(item => ({
              id: item.commentId,
              author: item.author,
              viaApp: item.viaApp,
              url: item.url,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              firstLine: item.body.split('\n')[0]!.slice(0, 200),
            }))
          : comments,
      secretScan: { storage: scan(storage), records: recordsScan, observations: observationsScan },
      ...(await inspectEnvironment(environmentDirectory, observations, work.execution.request.baseCommit ?? undefined)),
    });
    return;
  }
  if (!needsStop(work.execution)) throw new Error('NOTHING_TO_STOP');
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const sandbox = createSandbox({ root, guestAssets });
  const environment = work.execution.dispatch.environment as never,
    boot = work.execution.dispatch.boot as never;
  const before = await sandbox.observe({ environment, boot });
  const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q11 explicit stop of own boot' }) : null;
  await save('stop-environment-result', { state: work.execution.state, before, result });
}

export async function main(args: string[], state: PhaseState | null = null) {
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify(plan(), null, 2));
    return;
  }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase, state ?? newPhaseState(args[0]!));
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { writeFileSync } = await import('node:fs');
  let late = 0;
  await cli(process.argv.slice(2), {
    run: main,
    exit: code => process.exit(code),
    on: (event, listener) => {
      process.on(event, listener);
    },
    error: text => console.error(text),
    // Synchronous, exclusive, best effort: a late error after the complete result is evidence too, never a reason to fail.
    recordLate: (state, code) =>
      writeFileSync(`${observations}/${state.phase}-late-${++late}.json`, JSON.stringify({ phase: state.phase, code, at: new Date().toISOString() }), {
        flag: 'wx',
        mode: 0o600,
      }),
  });
}
