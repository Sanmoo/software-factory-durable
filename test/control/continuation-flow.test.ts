import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import { requestCorrection } from '../../src/control/durable/control.js';
import type { Control, ControlReceipt, ExecutionPorts, ListView, ShowView, WorkView } from '../../src/control/types.js';
import type { SessionObservation, WorkerQuestion, WorkerSessionRef } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (S): real Control + Pi Durable + temporary SQLite. Doubled: GitHub, clock and the execution boundaries (Sandbox lifecycle,
// Workers activate/observe/deliver, credentials). NOT evidence of a real session reopened by the SDK (see the I-local worker tests).
const sha = (question: string, context: string) => createHash('sha256').update(JSON.stringify({ question, context })).digest('hex');
const qid = (n: number) => `0b9c6a52-3d3e-4c8f-9a51-${String(n).padStart(12, '0')}`;
type Script = { kind: 'complete'; hold?: Promise<void> } | { kind: 'ask'; questionId: string; question: string };
const sessionRef = (n: number, profile: Partial<WorkerSessionRef['profile']> = {}): WorkerSessionRef => ({
  ref: `r/boot${n}/w-abc/profile/sessions/s${n}.jsonl`,
  sessionId: `5e55a0b0-0000-4000-8000-${String(n).padStart(12, '0')}`,
  sha256: String(n).repeat(64).slice(0, 64),
  bytes: 100 + n,
  format: 'pi-session-jsonl-v3',
  profile: {
    sdkProfile: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
    providerId: 'openai',
    modelId: 'gpt-6-luna',
    skillPack: 'factory-skills-v4',
    tools: ['ask_user', 'bash', 'edit', 'read', 'write'],
    ...profile,
  },
});

function executionDoubles(
  scripts: Script[],
  options: {
    observe?: (session: WorkerSessionRef) => SessionObservation;
    withObserve?: boolean;
    baseCommit?: () => string;
    /** `reusedOnResume: false` simulates a lost environment: the resumed prepare makes a FRESH clone at the same base/branch. */
    reusedOnResume?: boolean;
    builder?: ExecutionPorts['builder'];
    /** Whether the next `stop` confirms the own boot's cessation (default always). */
    cessation?: () => boolean;
  } = {},
) {
  const calls: { kind: string; detail?: unknown }[] = [];
  let sessions = 0;
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 },
    capacity: 1,
    builder: options.builder ?? { skillPack: 'factory-skills-v4', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare', detail: input });
        return {
          status: 'success',
          environment: `env-${'c'.repeat(64)}` as never,
          seeds: [{ name: 'factory/skill-pack/factory-skills-v4', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: {
            path: '/workspace/checkout',
            repository: input.checkout.repository,
            repositoryId: input.checkout.repositoryId,
            base: 'main',
            branch: input.checkout.branch,
            baseCommit: options.baseCommit?.() ?? 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git',
            reused: options.reusedOnResume === false ? false : calls.filter(call => call.kind === 'prepare').length > 1,
            preparedAt: new Date().toISOString(),
          },
        };
      },
      async start() {
        calls.push({ kind: 'start' });
        return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(calls.length).padStart(12, '5')}` as never };
      },
      async stop(input) {
        calls.push({ kind: 'stop', detail: input });
        return options.cessation && !options.cessation()
          ? { status: 'indeterminate', code: 'STOP_UNCONFIRMED', cessationConfirmed: false }
          : { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
    },
    credentials: {
      async issue(input) {
        calls.push({ kind: 'issue', detail: input });
        return {
          delivery: { token: 'ghs_' + 'syntheticContinuation0123' },
          metadata: {
            role: 'builder',
            purpose: 'builder-start',
            repository: 'acme/project',
            repositoryId: 3,
            installationId: 2,
            permissions: { metadata: 'read', contents: 'read', issues: 'read' },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      },
      async revoke() {
        calls.push({ kind: 'revoke' });
        return { kind: 'revoked', nextStep: 'synthetic' };
      },
    },
    workers: {
      async activate(invocation, _delivery, events) {
        const script = scripts.shift() ?? { kind: 'complete' };
        calls.push({
          kind: 'activate',
          detail: {
            prompt: invocation.prompt,
            context: invocation.context,
            continuation: invocation.continuation ?? null,
            policies: {
              skillPack: invocation.skillPack,
              modelBudget: invocation.modelBudget,
              copyOutput: invocation.copyOutput,
              editSourceMaxBytes: invocation.editSourceMaxBytes,
              handoff: invocation.handoff ?? null,
            },
          },
        });
        const receipt = { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' };
        const started = Promise.resolve({
          receipt,
          invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
        });
        // A continued activation keeps appending to (a Host copy of) the same session; a new one creates a new session.
        const session = invocation.continuation
          ? { ...invocation.continuation.session, ref: `${invocation.continuation.session.ref}.c`, sha256: 'e'.repeat(64) }
          : sessionRef(++sessions);
        const completed = started.then(async () => {
          if (script.kind === 'complete') {
            await script.hold;
            return { status: 'success' as const, receipt, session };
          }
          const question: WorkerQuestion = {
            questionId: script.questionId,
            question: script.question,
            context: '',
            sha256: sha(script.question, ''),
            reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' },
          };
          const ack = await events!.question!(question);
          return { status: 'question' as const, receipt, question: { ...question, acknowledged: ack.status === 'recorded' }, session };
        });
        return {
          worker: invocation.context.invocationId,
          started,
          completed,
          close() {
            calls.push({ kind: 'close' });
          },
        };
      },
      async deliver(worker, directive) {
        calls.push({ kind: `deliver-${directive.kind}`, detail: worker });
        return { status: directive.kind === 'credential' ? ('delivered' as const) : ('withdrawn' as const) };
      },
      ...(options.withObserve === false
        ? {}
        : {
            async observe(input) {
              calls.push({ kind: 'observe', detail: input });
              return { session: options.observe ? options.observe(input.session) : { state: 'compatible' as const, session: input.session }, limitations: [] };
            },
          }),
    },
  };
  return { ports, calls };
}

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[], options: Parameters<typeof executionDoubles>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-continuation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  const execution = executionDoubles(scripts, options);
  async function start(ports: ExecutionPorts = execution.ports) {
    const time = manualClock();
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      execution: ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
      polling: { intervalSeconds: 60, clock: time.clock },
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
    return current;
  }
  async function stop() {
    current!.stop.abort();
    assert.deepEqual(await current!.running, { kind: 'clean' });
  }
  t.after(async () => {
    if (current && !current.stop.signal.aborted) await stop();
  });
  const byNumber = async () =>
    Object.fromEntries(((await current!.control.inspect({ kind: 'list' })) as ListView).works.map(work => [work.ticket.number, work])) as Record<
      number,
      WorkView
    >;
  const show = async (work_id: string) => (await current!.control.inspect({ kind: 'show', work_id })) as Extract<ShowView, { kind: 'work' }>;
  const settle = async (predicate: () => Promise<boolean>, label = 'condition') => {
    await untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (current!.time.isSleeping()) current!.time.advance();
        return false;
      },
      5,
    );
  };
  const cycles = async (n: number) => {
    for (let i = 0; i < n; i++) {
      current!.time.advance();
      await current!.time.sleeping();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const activations = () =>
    execution.calls
      .filter(call => call.kind === 'activate')
      .map(call => call.detail as { prompt: string; context: { phaseId: string; executionId: string }; continuation: { session: WorkerSessionRef } | null });
  return { github, execution, start, stop, byNumber, show, settle, cycles, activations, storagePath, control: () => current!.control };
}
type Outcome = Extract<ControlReceipt, { operation: 'answer' | 'update-scope' }> | { kind: 'refused'; code: string };
const accept = (control: Control, input: Parameters<Control['accept']>[0]) =>
  control.accept(input) as Promise<Outcome & { outcome?: string; reason?: string | null }>;
const answer = (control: Control, request_id: string, question_id: string, text: string) =>
  accept(control, { request_id, operation: 'answer', question_id, text, origin: 'local-cli' });
const updateScope = (control: Control, request_id: string, work_id: string, reason: string) =>
  accept(control, { request_id, operation: 'update-scope', work_id, reason, origin: 'local-cli' });

test('AC1: after an answer the compatible recorded session is CONTINUED with `continue` + the answer, through the queue; implement is not restarted', async t => {
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'ask', questionId: qid(1), question: 'Which file name?' },
    { kind: 'complete' },
  ]);
  await h.start();
  await h.settle(
    async () => (await h.byNumber())[3]?.execution?.slot.held === false && (await h.byNumber())[3]!.execution!.end?.outcome === 'question',
    'question wait',
  );
  const waiting = (await h.byNumber())[3]!;
  assert.deepEqual(waiting.execution!.end!.session, sessionRef(1), 'the Host-observed session identity is recorded with the end');
  await h.cycles(3);
  assert.equal(h.activations().length, 1, 'no resumption before the answer');
  assert.equal((await answer(h.control(), 'a1', qid(1), 'Use docs/factory-question.md')).outcome, 'accepted');
  await h.settle(async () => h.activations().length === 2, 'resumed activation');
  await h.settle(async () => (await h.byNumber())[3]!.execution!.state === 'ended');
  const [first, second] = h.activations();
  assert.match(first!.prompt, /^\/implement /);
  assert.match(second!.prompt, /^continue\n/);
  assert.ok(second!.prompt.includes('Use docs/factory-question.md') && second!.prompt.includes(qid(1)));
  assert.doesNotMatch(second!.prompt, /\/implement |Factory recovery instruction/);
  assert.deepEqual(second!.continuation, { session: sessionRef(1) }, 'the Workers activation receives the recorded session to continue');
  assert.equal(second!.context.phaseId, 'builder-continuation');
  const resumed = (await h.byNumber())[3]!;
  assert.deepEqual(
    [resumed.execution!.mode, resumed.execution!.request.resume!.reason, resumed.queue.sequence, resumed.queue.category],
    ['recovery', 'QUESTION_ANSWERED', 1, 'normal'],
  );
  assert.deepEqual(
    { ...resumed.execution!.request.session!, decidedAt: undefined },
    { mode: 'continue', reason: 'SESSION_COMPATIBLE', previousExecutionId: waiting.execution!.executionId, previous: sessionRef(1), decidedAt: undefined },
  );
  const observed = h.execution.calls.filter(call => call.kind === 'observe');
  assert.equal(observed.length, 1);
  assert.deepEqual((observed[0]!.detail as { next: unknown }).next, {
    skillPack: 'factory-skills-v4',
    copyOutput: true,
    editSourceMaxBytes: 8192,
    handoff: false,
  });
  const kinds = h.execution.calls.map(call => call.kind);
  assert.ok(kinds.indexOf('observe') < kinds.lastIndexOf('issue'), 'the session decision precedes the credential of the resumed activation');
  // AC5/AC6: the resumed activation keeps exactly the Host policies and the same repository-scoped grant (no widening, nothing from the repo).
  const policies = h.execution.calls.filter(call => call.kind === 'activate').map(call => (call.detail as { policies: unknown }).policies);
  assert.deepEqual(policies[1], policies[0]);
  assert.deepEqual(policies[1], { skillPack: 'factory-skills-v4', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192, handoff: null });
  const grants = h.execution.calls.filter(call => call.kind === 'issue').map(call => call.detail as { repository: unknown; executionId: string });
  assert.equal(grants.length, 2);
  assert.deepEqual(
    grants.map(grant => grant.repository),
    [
      { repository: 'acme/project', installationId: 2, workflows: false },
      { repository: 'acme/project', installationId: 2, workflows: false },
    ],
  );
  // The Control never reads the Ticket's documents/links to resume (no collector): only tracking, authorization, dependencies and Questions.
  assert.ok(
    h.github.calls.every(call =>
      ['findQuestion', 'listCandidates', 'postComment', 'readDependencyGraph', 'readInputs', 'readTicket', 'findPublication'].includes(call.method),
    ),
  );
  // The continued session's new identity is what a further resumption would continue.
  assert.equal(resumed.execution!.end!.session!.ref, `${sessionRef(1).ref}.c`);
  await h.stop();
});

for (const [label, options, reason] of [
  ['lost', { observe: () => ({ state: 'lost', code: 'SESSION_FILE_MISSING', differences: [] }) }, 'SESSION_LOST'],
  ['altered', { observe: () => ({ state: 'altered', code: 'SESSION_HASH_MISMATCH', differences: [] }) }, 'SESSION_ALTERED'],
  [
    'incompatible (Host profile)',
    { observe: () => ({ state: 'incompatible', code: 'SESSION_PROFILE_CHANGED', differences: ['modelId'] }) },
    'SESSION_INCOMPATIBLE',
  ],
  ['not observable', { withObserve: false }, 'SESSION_OBSERVATION_NOT_COMPOSED'],
] as const)
  test(`AC2: a ${label} session is REPLACED with its recorded reason and an explicit recovery instruction with recoverable context`, async t => {
    const h = await harness(
      t,
      { pulls: {}, issues: [remoteIssue(3)] },
      [{ kind: 'ask', questionId: qid(2), question: 'Which file name?' }, { kind: 'complete' }],
      options as never,
    );
    await h.start();
    await h.settle(
      async () => (await h.byNumber())[3]?.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
      'question wait',
    );
    const waiting = (await h.byNumber())[3]!;
    assert.equal((await answer(h.control(), 'a2', qid(2), 'Use docs/x.md')).outcome, 'accepted');
    await h.settle(async () => h.activations().length === 2 && (await h.byNumber())[3]!.execution!.state === 'ended', 'replacement activation');
    const second = h.activations()[1]!;
    assert.equal(second.continuation, null, 'never a continue of a session that is not proven compatible');
    assert.equal(second.context.phaseId, 'builder-recovery');
    assert.match(second.prompt, /^Factory recovery instruction for Ticket https:\/\/github\.com\/acme\/project\/issues\/3\./);
    for (const text of [
      `reason: ${reason}`,
      `previous-execution=${waiting.execution!.executionId}`,
      `work=${waiting.work_id}`,
      '/artifacts/spec/',
      '/artifacts/instructions/',
      'base-commit=' + 'a'.repeat(40),
      `Earlier Execution ${waiting.execution!.executionId}: question`,
      `Question ${qid(2)}: answered`,
      'Use docs/x.md',
      'Which file name?',
      'factory-skills-v4/skills/implement/SKILL.md',
    ])
      assert.ok(second.prompt.includes(text), text);
    const resumed = (await h.byNumber())[3]!;
    assert.deepEqual([resumed.execution!.request.session!.mode, resumed.execution!.request.session!.reason], ['replace', reason]);
    await h.stop();
  });

test('AC2: a Host policy change between Executions makes the session incompatible (Control facts), even when the file is intact', async t => {
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'ask', questionId: qid(3), question: 'Which file name?' },
    { kind: 'complete' },
  ]);
  await h.start();
  await h.settle(
    async () => (await h.byNumber())[3]?.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
    'question wait',
  );
  await h.stop();
  // Restart with another Builder policy (edit disabled): the tool set of the previous session no longer matches.
  await h.start({ ...h.execution.ports, builder: { skillPack: 'factory-skills-v4', modelBudget: 'builder-v1', copyOutput: true } });
  assert.equal((await answer(h.control(), 'a3', qid(3), 'docs/y.md')).outcome, 'accepted');
  await h.settle(async () => h.activations().length === 2 && (await h.byNumber())[3]!.execution!.state === 'ended', 'replacement activation');
  assert.deepEqual(
    [(await h.byNumber())[3]!.execution!.request.session!.mode, (await h.byNumber())[3]!.execution!.request.session!.reason],
    ['replace', 'SESSION_INCOMPATIBLE'],
  );
  assert.match(h.activations()[1]!.prompt, /reason: SESSION_INCOMPATIBLE/);
  await h.stop();
});

test('AC2: insufficient recovery context (Git context changed) BLOCKS before any credential: no empty continue, Slot released, explicit impediment', async t => {
  let base = 'a'.repeat(40);
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'ask', questionId: qid(4), question: 'Which file name?' }], {
    baseCommit: () => base,
  });
  await h.start();
  await h.settle(
    async () => (await h.byNumber())[3]?.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
    'question wait',
  );
  const issued = h.execution.calls.filter(call => call.kind === 'issue').length;
  base = 'b'.repeat(40);
  assert.equal((await answer(h.control(), 'a4', qid(4), 'docs/z.md')).outcome, 'accepted');
  await h.settle(async () => (await h.byNumber())[3]!.impediments.some(item => item.code === 'RECOVERY_CONTEXT_INSUFFICIENT'), 'blocked');
  const blocked = (await h.byNumber())[3]!;
  assert.equal(h.activations().length, 1, 'no Builder activated');
  assert.equal(h.execution.calls.filter(call => call.kind === 'issue').length, issued, 'no credential issued for the blocked resumption');
  assert.deepEqual([blocked.execution!.state, blocked.execution!.slot.held, blocked.queue.pending, blocked.queue.sequence], ['released', false, true, 1]);
  assert.match(blocked.impediments.find(item => item.code === 'RECOVERY_CONTEXT_INSUFFICIENT')!.nextStep, /GIT_CONTEXT_CHANGED/);
  assert.ok(blocked.dispatch.reasons.includes('RECOVERY_CONTEXT_INSUFFICIENT'));
  await h.cycles(3);
  assert.equal(h.activations().length, 1, 'stays blocked; never retried automatically');
  await h.stop();
});

test('AC3/AC4: update-scope during an activity is deferred (nothing reaches the live Builder); the next activation preserves it via continue', async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'complete', hold }, { kind: 'complete' }]);
  await h.start();
  await h.settle(async () => (await h.byNumber())[3]?.execution?.state === 'started', 'started');
  const work = (await h.byNumber())[3]!;
  const receipt = await updateScope(h.control(), 's1', work.work_id, 'Also add a CHANGELOG line for the new flag; nothing else from the edited Ticket.');
  assert.deepEqual(receipt, {
    kind: 'durable',
    request_id: 's1',
    operation: 'update-scope',
    work_id: work.work_id,
    outcome: 'deferred',
    reason: null,
    scopeUpdateId: 'scope-s1',
    appliesAt: 'next-activation',
  });
  assert.deepEqual(
    await updateScope(h.control(), 's1', work.work_id, 'Also add a CHANGELOG line for the new flag; nothing else from the edited Ticket.'),
    receipt,
    'same request id: same receipt',
  );
  assert.deepEqual(await updateScope(h.control(), 's1', work.work_id, 'something else entirely, concrete'), { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.equal(
    (await updateScope(h.control(), 's2', work.work_id, 'Also add a CHANGELOG line for the new flag; nothing else from the edited Ticket.')).outcome,
    'not-applied',
  );
  await h.cycles(2);
  assert.equal(h.activations().length, 1, 'no second (parallel) Builder while the first is active');
  assert.deepEqual(
    h.execution.calls.filter(call => call.kind.startsWith('deliver')).map(call => call.kind),
    [],
    'no injection into the running Builder',
  );
  release();
  await h.settle(async () => h.activations().length === 2 && (await h.byNumber())[3]!.execution!.state === 'ended', 'next safe activation');
  const second = h.activations()[1]!;
  assert.match(second.prompt, /^continue\n/);
  assert.ok(second.prompt.includes('Authorized scope change scope-s1') && second.prompt.includes('Also add a CHANGELOG line'));
  assert.match(second.prompt, /preserve a NEW request version/);
  const resumed = await h.show(work.work_id);
  assert.deepEqual(
    [resumed.work.execution!.request.resume!.reason, resumed.work.execution!.request.resume!.questionId, resumed.work.execution!.request.scopeUpdateIds],
    ['SCOPE_UPDATED', null, ['scope-s1']],
  );
  // Delivered in the prompt; with the Execution completed and its cessation confirmed it is consumed (Control-side evidence).
  assert.deepEqual(
    resumed.work.scopeUpdates!.map(item => [item.scopeUpdateId, item.state, item.executionId, item.acceptedDuring, item.consumption]),
    [['scope-s1', 'consumed', resumed.work.execution!.executionId, 'activity', 'execution-completed']],
  );
  assert.ok(resumed.work.scopeUpdates![0]!.consumedAt);
  assert.deepEqual(
    resumed.work.history.filter(item => item.event.startsWith('scope-')).map(item => item.event),
    ['scope-update-accepted', 'scope-update-delivered', 'scope-update-consumed'],
  );
  await h.cycles(3);
  assert.equal(h.activations().length, 2, 'a delivered scope change never triggers again');
  await h.stop();
});

test('AC3/AC4: an idle completed Work resumes ONLY by a concrete update-scope; generic approvals, repeats and later Ticket edits are no trigger', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'complete' }, { kind: 'complete' }], { withObserve: false });
  await h.start();
  await h.settle(async () => (await h.byNumber())[3]?.execution?.state === 'ended' && !(await h.byNumber())[3]!.execution!.slot.held, 'completed');
  const work = (await h.byNumber())[3]!;
  assert.equal(work.queue.pending, false);
  // A later edit of the Ticket (here a re-read reporting other node data) is observed by polling but never starts or authorizes anything.
  remote.issues[0]!.labels = [
    { id: 55, name: 'ready-for-agent' },
    { id: 56, name: 'edited-later' },
  ];
  await h.cycles(3);
  assert.equal(h.activations().length, 1);
  for (const generic of ['ok', 'LGTM', 'go ahead'])
    assert.deepEqual(await updateScope(h.control(), `g-${generic.replace(/\W/g, '')}`, work.work_id, generic), {
      kind: 'durable',
      request_id: `g-${generic.replace(/\W/g, '')}`,
      operation: 'update-scope',
      work_id: work.work_id,
      outcome: 'not-applied',
      reason: 'SCOPE_REASON_NOT_CONCRETE',
      scopeUpdateId: null,
      appliesAt: null,
    });
  await h.cycles(2);
  assert.equal(h.activations().length, 1, 'a generic approval grants nothing');
  const accepted = await updateScope(h.control(), 's3', work.work_id, 'Only rename the flag to --dry-run; ignore the other edits of the Ticket.');
  assert.equal(accepted.outcome, 'accepted');
  await h.settle(async () => h.activations().length === 2 && (await h.byNumber())[3]!.execution!.state === 'ended', 'scope resumption');
  const second = h.activations()[1]!;
  assert.match(second.prompt, /^Factory recovery instruction/, 'no session observation composed: replaced');
  assert.ok(
    second.prompt.includes('Only rename the flag to --dry-run') &&
      second.prompt.includes('reason: SESSION_OBSERVATION_NOT_COMPOSED') &&
      !second.prompt.includes('Accepted answer'),
  );
  const resumed = (await h.byNumber())[3]!;
  assert.deepEqual([resumed.queue.sequence, resumed.queue.category, resumed.previousExecutions.length], [1, 'normal', 1]);
  await h.stop();
  assert.doesNotMatch(await readFile(h.storagePath, 'latin1'), /ghs_synthetic/);
});

test('AC3: update-scope during a Question wait rides with the answer; the initial Execution carries a scope change accepted before it starts', async t => {
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] }, [
    { kind: 'ask', questionId: qid(5), question: 'Which file name?' },
    { kind: 'complete' },
    { kind: 'complete' },
  ]);
  await h.start();
  await h.settle(
    async () => (await h.byNumber())[3]?.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
    'question wait',
  );
  const three = (await h.byNumber())[3]!;
  const four = (await h.byNumber())[4]!;
  // #4 waits behind the busy Slot (capacity 1) until #3's question frees it; a scope change for it arrives before its first start.
  assert.equal((await updateScope(h.control(), 's4', three.work_id, 'Also document the answer in the README section Usage.')).outcome, 'accepted');
  await h.settle(async () => h.activations().length >= 2, '#4 activated');
  const fourShown = await h.show(four.work_id);
  assert.equal((fourShown.work.scopeUpdates ?? []).length, 0, 'a scope change belongs to its own Work only');
  assert.equal((await answer(h.control(), 'a5', qid(5), 'docs/q.md')).outcome, 'accepted');
  await h.settle(async () => h.activations().length === 3 && (await h.byNumber())[3]!.execution!.state === 'ended', 'resumption with both');
  const third = h.activations()[2]!;
  assert.match(third.prompt, /^continue\n/);
  assert.ok(third.prompt.includes('docs/q.md') && third.prompt.includes('Also document the answer in the README section Usage.'));
  const shown = await h.show(three.work_id);
  assert.deepEqual(
    [shown.work.execution!.request.resume!.reason, shown.work.execution!.request.resume!.scopeUpdateIds, shown.work.scopeUpdates![0]!.acceptedDuring],
    ['QUESTION_ANSWERED', ['scope-s4'], 'question-wait'],
  );
  await h.stop();
});

test('AC3: update-scope before the first Execution is part of its /implement prompt (fenced); unknown/closed Works are not applied', async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] }, [{ kind: 'complete', hold }, { kind: 'complete' }]);
  await h.start();
  await h.settle(async () => (await h.byNumber())[3]?.execution?.state === 'started' && (await h.byNumber())[4] !== undefined, '#3 running, #4 queued');
  const four = (await h.byNumber())[4]!;
  assert.equal((await updateScope(h.control(), 's5', four.work_id, 'Limit the change to docs/; do not touch src/.')).outcome, 'accepted');
  assert.equal(
    (await updateScope(h.control(), 's6', '00000000-0000-4000-8000-000000000000', 'Limit the change to docs/; do not touch src/.')).reason,
    'WORK_NOT_FOUND',
  );
  release();
  await h.settle(async () => h.activations().length === 2, '#4 started');
  const prompt = h.activations()[1]!.prompt;
  assert.match(prompt, /^\/implement https:\/\/github\.com\/acme\/project\/issues\/4 /);
  assert.ok(prompt.includes('Authorized scope change scope-s5') && prompt.includes('```\nLimit the change to docs/; do not touch src/.\n```'));
  await h.stop();
});

test('AC3/finding 1: a delivery is not consumption — an update delivered by an Execution that ended with a Question is re-offered and consumed only by a completed one', async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'complete', hold },
    { kind: 'ask', questionId: qid(21), question: 'Which file name?' },
    { kind: 'complete' },
  ]);
  await h.start();
  await h.settle(async () => (await h.byNumber())[3]?.execution?.state === 'started', 'started');
  const work = (await h.byNumber())[3]!;
  assert.equal((await updateScope(h.control(), 's21', work.work_id, 'Also add a CHANGELOG line for the new flag only.')).outcome, 'deferred');
  release();
  // E2 delivers the update and then asks: its end is NOT completion, so the same concrete change becomes pending again.
  await h.settle(
    async () => (await h.byNumber())[3]!.execution!.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
    'question ended',
  );
  assert.match(h.activations()[1]!.prompt, /Authorized scope change scope-s21/);
  const asked = (await h.show(work.work_id)).work.scopeUpdates![0]!;
  assert.deepEqual([asked.state, asked.executionId, asked.reoffers], ['pending', null, 1]);
  assert.equal((await h.show(work.work_id)).work.history.filter(item => item.event === 'scope-update-reoffered').length, 1);
  assert.equal((await answer(h.control(), 'a21', qid(21), 'docs/reoffer.md')).outcome, 'accepted');
  await h.settle(async () => h.activations().length === 3 && (await h.byNumber())[3]!.execution!.state === 'ended', 'third activation');
  const third = h.activations()[2]!;
  assert.match(third.prompt, /^continue\n/);
  assert.ok(third.prompt.includes('Authorized scope change scope-s21') && third.prompt.includes('Also add a CHANGELOG line for the new flag only.'));
  const done = (await h.show(work.work_id)).work.scopeUpdates![0]!;
  assert.deepEqual([done.state, done.consumption, done.reoffers], ['consumed', 'execution-completed', 1]);
  await h.cycles(3);
  assert.equal(h.activations().length, 3, 'a consumed update is never re-offered nor triggers again');
  await h.stop();
});

test('AC2/finding 3: a resumed activation whose prepare made a FRESH clone (not the preserved environment) blocks instead of claiming preservation', async t => {
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'ask', questionId: qid(22), question: 'Which file name?' }], {
    reusedOnResume: false,
  });
  await h.start();
  await h.settle(
    async () => (await h.byNumber())[3]?.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
    'question wait',
  );
  const issued = h.execution.calls.filter(call => call.kind === 'issue').length;
  assert.equal((await answer(h.control(), 'a22', qid(22), 'docs/z.md')).outcome, 'accepted');
  await h.settle(async () => (await h.byNumber())[3]!.impediments.some(item => item.code === 'RECOVERY_CONTEXT_INSUFFICIENT'), 'blocked');
  const blocked = (await h.byNumber())[3]!;
  assert.equal(h.activations().length, 1, 'no Builder activated');
  assert.equal(h.execution.calls.filter(call => call.kind === 'issue').length, issued, 'no credential issued');
  const impediment = blocked.impediments.find(item => item.code === 'RECOVERY_CONTEXT_INSUFFICIENT')!;
  assert.match(impediment.nextStep, /PREVIOUS_ENVIRONMENT_NOT_REUSED/);
  assert.deepEqual([blocked.execution!.state, blocked.execution!.slot.held, blocked.queue.pending], ['released', false, true]);
  await h.cycles(3);
  assert.equal(h.activations().length, 1, 'never retried automatically');
  await h.stop();
});

test('AC4/finding 4: an over-large initial prompt blocks explicitly (PROMPT_TOO_LARGE) instead of being truncated or sent', async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] }, [{ kind: 'complete', hold }, { kind: 'complete' }]);
  await h.start();
  await h.settle(async () => (await h.byNumber())[3]?.execution?.state === 'started' && (await h.byNumber())[4] !== undefined, '#3 running, #4 queued');
  const four = (await h.byNumber())[4]!;
  for (let n = 0; n < 8; n++) {
    assert.equal((await updateScope(h.control(), `big-${n}`, four.work_id, `Concrete change number ${n}: ${'€'.repeat(1900)}`)).outcome, 'accepted');
  }
  release();
  await h.settle(async () => (await h.byNumber())[4]!.impediments.some(item => item.code === 'PROMPT_TOO_LARGE'), 'blocked too large');
  const blocked = (await h.byNumber())[4]!;
  assert.equal(h.activations().length, 1, 'the over-large initial prompt never reached a Builder');
  assert.deepEqual([blocked.execution!.state, blocked.execution!.slot.held, blocked.queue.pending], ['released', false, true]);
  assert.match(blocked.impediments.find(item => item.code === 'PROMPT_TOO_LARGE')!.nextStep, /PROMPT_TOO_LARGE/);
  assert.deepEqual(
    blocked.scopeUpdates!.map(item => item.state),
    Array.from({ length: 8 }, () => 'pending'),
    'nothing was silently dropped',
  );
  await h.stop();
});

test('AC2/finding 2: a planned pack without the continue protocol replaces the session with that explicit reason', async t => {
  const h = await harness(
    t,
    { pulls: {}, issues: [remoteIssue(3)] },
    [{ kind: 'ask', questionId: qid(23), question: 'Which file name?' }, { kind: 'complete' }],
    { observe: () => ({ state: 'incompatible', code: 'SESSION_CONTINUATION_UNSUPPORTED', differences: ['continuation'] }) },
  );
  await h.start();
  await h.settle(
    async () => (await h.byNumber())[3]?.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
    'question wait',
  );
  assert.equal((await answer(h.control(), 'a23', qid(23), 'docs/u.md')).outcome, 'accepted');
  await h.settle(async () => h.activations().length === 2 && (await h.byNumber())[3]!.execution!.state === 'ended', 'replacement activation');
  const second = h.activations()[1]!;
  assert.equal(second.continuation, null);
  assert.match(second.prompt, /^Factory recovery instruction/);
  assert.ok(second.prompt.includes('reason: SESSION_CONTINUATION_UNSUPPORTED'));
  assert.deepEqual(
    [(await h.byNumber())[3]!.execution!.request.session!.mode, (await h.byNumber())[3]!.execution!.request.session!.reason],
    ['replace', 'SESSION_CONTINUATION_UNSUPPORTED'],
  );
  await h.stop();
});

// Ticket 19 composition: the budget charge of the resumed Execution (spec §4.4) and its own duration clock (spec §5.7).
test('ticket 19 x 11: a continuation of an already-consumed correction stays PRESERVED (not charged again) and has its own clock', async t => {
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [
    { kind: 'complete' },
    { kind: 'ask', questionId: qid(31), question: 'Which file name?' },
    { kind: 'complete' },
  ]);
  await h.start();
  await h.settle(async () => (await h.byNumber())[3]?.execution?.state === 'ended' && !(await h.byNumber())[3]!.execution!.slot.held, 'initial completed');
  const work = (await h.byNumber())[3]!;
  assert.equal(await requestCorrection(h.control(), work.work_id, 'Fix the failing check of the proposal.'), 'opened');
  await h.settle(
    async () => (await h.byNumber())[3]!.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
    'correction asked',
  );
  const asked = (await h.show(work.work_id)).work;
  assert.deepEqual([asked.execution!.charge!.kind, asked.execution!.charge!.state, asked.budget!.corrections.consumed], ['correction', 'consumed', 1]);
  assert.equal((await answer(h.control(), 'a31', qid(31), 'docs/fix.md')).outcome, 'accepted');
  await h.settle(async () => h.activations().length === 3 && (await h.byNumber())[3]!.execution!.state === 'ended', 'continuation ended');
  assert.match(h.activations()[2]!.prompt, /^continue\n/);
  const resumed = (await h.show(work.work_id)).work;
  const continued = resumed.execution!;
  assert.deepEqual(
    [continued.request.session!.mode, continued.charge!.kind, continued.charge!.state, continued.charge!.correctionId],
    ['continue', 'correction', 'preserved', asked.execution!.charge!.correctionId],
    'the SAME correction continues',
  );
  assert.deepEqual([resumed.budget!.corrections.consumed, resumed.budget!.corrections.reserved], [1, null], 'consumed once, never again');
  // Per-Execution clock: the continuation has its own confirmed start and measured duration, distinct from the asking Execution's.
  assert.ok(continued.timing?.startedAt && asked.execution!.timing?.startedAt);
  assert.notEqual(continued.timing!.startedAt, asked.execution!.timing!.startedAt);
  assert.equal(continued.timing!.duration?.kind, 'measured');
  assert.equal(continued.timing!.timeout, null);
  await h.stop();
});

for (const [label, options, code] of [
  ['RECOVERY_CONTEXT_INSUFFICIENT (cessation confirmed)', { reusedOnResume: false }, 'RECOVERY_CONTEXT_INSUFFICIENT'],
  [
    'RECOVERY_CONTEXT_INSUFFICIENT (cessation NOT confirmed: held)',
    { reusedOnResume: false, unconfirmedSecondStop: true },
    'RECOVERY_CONTEXT_INSUFFICIENT_CESSATION_UNCONFIRMED',
  ],
] as const)
  test(`ticket 19 x 11: ${label} is a proven non-start: the reserved correction is RELEASED, never consumed`, async t => {
    let stops = 0;
    const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'ask', questionId: qid(32), question: 'Which file name?' }], {
      reusedOnResume: options.reusedOnResume,
      cessation: () => !('unconfirmedSecondStop' in options) || ++stops < 2,
    });
    await h.start();
    await h.settle(
      async () => (await h.byNumber())[3]?.execution?.end?.outcome === 'question' && !(await h.byNumber())[3]!.execution!.slot.held,
      'question wait',
    );
    const work = (await h.byNumber())[3]!;
    // While it waits (no active Execution) a correction opens: the resumption that follows reserves it at admission.
    assert.equal(await requestCorrection(h.control(), work.work_id, 'Also fix the reported lint failure.'), 'opened');
    const issued = h.execution.calls.filter(call => call.kind === 'issue').length;
    assert.equal((await answer(h.control(), 'a32', qid(32), 'docs/r.md')).outcome, 'accepted');
    await h.settle(async () => {
      const shown = (await h.show(work.work_id)).work;
      return shown.execution?.held?.code === code || (shown.execution?.state === 'held' && shown.execution.held?.code === code);
    }, code);
    const blocked = (await h.show(work.work_id)).work;
    assert.equal(h.activations().length, 1, 'no Builder activated');
    assert.equal(h.execution.calls.filter(call => call.kind === 'issue').length, issued, 'no credential issued');
    assert.deepEqual([blocked.execution!.charge!.kind, blocked.execution!.charge!.state], ['correction', 'released']);
    assert.deepEqual([blocked.budget!.corrections.reserved, blocked.budget!.corrections.consumed], [null, 0]);
    assert.equal(blocked.correction!.consumed, false, 'the correction stays pending for an explicit decision');
    assert.ok(blocked.history.some(item => item.event === 'budget-released'));
    await h.stop();
  });

test('ticket 19 x 11: PROMPT_TOO_LARGE is a proven non-start: the reserved correction is RELEASED, never consumed', async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] }, [{ kind: 'complete', hold }, { kind: 'complete' }]);
  await h.start();
  await h.settle(async () => (await h.byNumber())[3]?.execution?.state === 'started' && (await h.byNumber())[4] !== undefined, '#3 running, #4 queued');
  const four = (await h.byNumber())[4]!;
  assert.equal(await requestCorrection(h.control(), four.work_id, 'Fix the documented defect.'), 'opened');
  for (let n = 0; n < 8; n++)
    assert.equal((await updateScope(h.control(), `big19-${n}`, four.work_id, `Concrete change number ${n}: ${'€'.repeat(1900)}`)).outcome, 'accepted');
  release();
  await h.settle(async () => (await h.byNumber())[4]!.impediments.some(item => item.code === 'PROMPT_TOO_LARGE'), 'blocked too large');
  const blocked = (await h.show(four.work_id)).work;
  assert.deepEqual(
    [blocked.execution!.charge!.kind, blocked.execution!.charge!.state, blocked.budget!.corrections.reserved, blocked.budget!.corrections.consumed],
    ['correction', 'released', null, 0],
  );
  await h.stop();
});
