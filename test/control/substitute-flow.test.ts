import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ControlReceipt, ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import type { ChannelReport } from '../../src/contracts/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { app, executionDoubles, publishOwn, pushWip, sessionRef, type Activation, type GuestWorkspace, type Script } from './publication-doubles.js';
import { untilHolds } from '../runner/budget.js';

// v2 ticket 13 (V2-10, V2-18, V2-19: MANDATORY gate of the spec, the continuity proof failed it: P2), flow level: real Control + Pi Durable
// + temporary SQLite. Doubled: GitHub (with the listing of loss marker refs), the clocks, a Sandbox that declares NO persistent disk,
// reports the end of its environment, a channel report and its boots, the Workers (a SCRIPTED Builder) and credentials. What it shows is
// what CONTROL does: the queue, the budget unit, the package it hands to the new session, the gate before the end of that session's
// activation and the Question. A scripted Builder proves nothing about a model's conduct (dublê não comprova fronteira substituída).
const main = 'b'.repeat(40),
  lost = 'c'.repeat(40),
  done = 'e'.repeat(40),
  head = 'd'.repeat(40);
const questionId = '11111111-2222-4333-8444-000000000013';
async function harness(
  t: { after(fn: () => Promise<void>): void },
  scripts: (guest: GuestWorkspace) => Script[],
  options: { recoveryLimit?: number; /** The sandbox cannot read the channel record of any boot. */ reportUnreadable?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-substitute-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)], refs: { main } };
  const github = githubDoubles(remote);
  const queue: Script[] = [];
  const execution = executionDoubles(remote, queue, { diskless: true });
  queue.push(...scripts(execution.guest));
  const watched: { boot: string; end(reason: string): void }[] = [];
  const reports: { environment: string; boot: string }[] = [];
  const time = manualClock();
  let calendar = 0;
  const boots: string[] = [];
  const start = execution.ports.sandbox.start;
  const control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: {
      ...execution.ports,
      calendar: { now: () => Date.now() + calendar },
      sandbox: {
        ...execution.ports.sandbox,
        capabilities: { ...execution.ports.sandbox.capabilities!, environmentWatch: true, channelRecovery: true },
        start: async input => {
          const started = await start(input);
          if (started.status === 'success') boots.push(started.boot);
          return started;
        },
        awaitEnvironmentEnd: input =>
          new Promise(resolve => {
            watched.push({ boot: input.boot, end: reason => resolve({ reason, terminatedAt: '2026-11-21T10:00:00.000Z' }) });
            input.signal.addEventListener('abort', () => resolve(null), { once: true });
          }),
        // The call in flight when the first environment died: recorded by the sandbox, reported per boot.
        channelReport: async (input): Promise<ChannelReport> => {
          reports.push(input);
          if (options.reportUnreadable) throw new Error('unreadable line');
          return {
            unrecoverable: null,
            indeterminateEffects:
              input.boot !== boots[0]
                ? []
                : [
                    {
                      at: '2026-11-21T09:59:00.000Z',
                      executionId: 'as-the-sandbox-wrote-it',
                      invocationId: 'invocation-1',
                      role: 'builder',
                      tool: 'bash',
                      callId: 'call-7',
                      description: 'mvn deploy -DskipTests',
                      outcome: 'environment-ended',
                    },
                  ],
          };
        },
        usage: async () => ({
          status: 'reported',
          unit: 'MicroVM-seconds',
          boots: boots.map((boot, index) =>
            index === boots.length - 1
              ? { boot, begin: 'start', end: null, size: 's', startedAt: null, endedAt: null, seconds: null, state: 'running' as const }
              : {
                  boot,
                  begin: 'start',
                  end: index === 0 ? 'loss' : 'end',
                  size: 's',
                  startedAt: null,
                  endedAt: null,
                  seconds: 120,
                  state: 'measured' as const,
                },
          ),
        }),
      },
    },
    access: {
      tracker: github.tracker,
      repository: {
        ...github.repository,
        readLostMarkers: async selection => ({
          state: 'complete',
          observedAt: '2026-11-21T10:00:01.000Z',
          markers: [{ ref: `refs/factory/lost/${selection.workId}/${boots[0]}`, boot: boots[0]!, sha: lost }],
        }),
      },
      repositories: [{ ...scope, ...(options.recoveryLimit === undefined ? {} : { recoveryLimit: options.recoveryLimit }) }],
      operators: ['operator-one'],
      factoryApp: async () => app,
    },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    if (!stop.signal.aborted) {
      stop.abort();
      await running;
    }
  });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) =>
    untilHolds(
      label,
      async () => {
        if (predicate(await work())) return true;
        // The persisted recovery wait runs on the calendar: jumped, never slept.
        if (time.isSleeping()) {
          calendar += 60000;
          time.advance();
        }
        return false;
      },
      5,
    );
  const executions = (value: WorkView | undefined) => [...(value?.previousExecutions ?? []), ...(value?.execution ? [value.execution] : [])] as ExecutionView[];
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation);
  const recoveries = async () => {
    const value = await work();
    const shown = await control.inspect({ kind: 'show', work_id: value!.work_id });
    return 'work' in shown ? shown.work.budget?.recoveries : undefined;
  };
  const answer = async (text: string) => {
    const receipt = (await control.accept({
      request_id: 'answer-13',
      operation: 'answer',
      question_id: questionId,
      text,
      origin: 'local-cli',
    })) as ControlReceipt;
    assert.equal('outcome' in receipt && receipt.outcome, 'accepted', JSON.stringify(receipt));
  };
  const kinds = () => execution.calls.map(call => call.kind).filter(kind => ['prepare', 'start', 'activate', 'gate', 'stop'].includes(kind));
  return { remote, work, settle, watched, reports, executions, activations, recoveries, answer, kinds, boots, guest: execution.guest, calls: execution.calls };
}
/** The first environment dies under a Builder with a call in flight and an unpushed commit. */
async function lose(h: Awaited<ReturnType<typeof harness>>) {
  await h.settle('started', value => value?.execution?.state === 'started' && h.watched.length === 1);
  const first = (await h.work())!.execution!;
  h.watched[0]!.end('MicroVM exceeded maximum lifetime.');
  await h.settle('loss recorded', value => value?.losses?.length === 1);
  return first;
}

test('MANDATORY (V2-17..V2-19): loss with a recorded uncertain effect: the substitute comes back through the queue on one operational recovery with the package, concludes, is made to publish by the gate, asks about the effect, and the answer moves the Work forward', async t => {
  const h = await harness(t, guest => [
    { kind: 'hang', head: lost },
    // The substitute: it concludes what does not depend on the uncertain deploy (a commit it has NOT pushed) and asks about the deploy.
    {
      kind: 'ask',
      head: done,
      question:
        'The Factory recorded bash call call-7 (mvn deploy -DskipTests) of boot 1 as environment-ended. Was the artifact deployed? May I repeat the deploy or take it as done?',
      questionId,
    },
    // The gate returns the unpublished commit to it; it publishes.
    { kind: 'publish', publish: pushWip(guest, done), end: 'success' },
    // After the answer: the rest, reviewed, and the publication.
    { kind: 'implement', head },
    { kind: 'publish', publish: publishOwn(), end: 'success' },
  ]);
  const first = await lose(h);
  const lostWork = (await h.work())!;
  assert.equal(lostWork.queue.pending, true, 'after the loss the Work is back in the queue');
  assert.deepEqual([first.dispatch.boot, lostWork.losses![0]!.boot, lostWork.losses![0]!.marker.state], [h.boots[0], h.boots[0], 'present']);

  await h.settle(
    'substitute asked',
    value => value?.execution?.executionId !== first.executionId && value?.execution?.end?.outcome === 'question' && !value.execution.slot.held,
  );
  const asked = (await h.work())!;
  const substitute = asked.execution!;
  // V2-10: a NEW Execution, through the queue, on exactly one operational recovery; a new boot cloned from origin.
  assert.deepEqual(
    [
      substitute.interruption?.reason,
      substitute.interruption?.code,
      substitute.interruption?.previousExecutionId,
      substitute.charge?.kind,
      substitute.charge?.state,
    ],
    ['OPERATIONAL_RECOVERY', 'SANDBOX_ENVIRONMENT_ENDED', first.executionId, 'recovery', 'consumed'],
  );
  assert.equal((await h.recoveries())?.consumed, 1);
  assert.notEqual(substitute.dispatch.boot, first.dispatch.boot);
  // V2-18: the package. A new session (nothing continued), the notice first, then the explicit recovery instruction from Control's records.
  const [, package_, correction] = h.activations() as [Activation, Activation, Activation];
  assert.deepEqual([package_.phaseId, package_.continuation, package_.executionId], ['builder-recovery', null, substitute.executionId]);
  assert.ok(package_.prompt.startsWith('Factory notice (new boot): this environment was RECREATED'), package_.prompt.slice(0, 120));
  assert.ok(package_.prompt.includes('Factory substitute-session package (recovery after a LOSS) for Ticket https://github.com/acme/project/issues/3.'));
  assert.ok(package_.prompt.includes(`work=${asked.work_id} execution=${substitute.executionId} lost-execution=${first.executionId}`));
  assert.ok(
    package_.prompt.includes(
      `LOSS declared by the Factory: the environment of boot ${h.boots[0]} (Execution ${first.executionId}) ended on its own at 2026-11-21T10:00:00.000Z (reported: MicroVM exceeded maximum lifetime.)`,
    ),
  );
  assert.ok(package_.prompt.includes('Last confirmed commit: none.'));
  assert.ok(package_.prompt.includes(`- ${h.boots[0]}: began as start, ended as loss (120 MicroVM-seconds)`));
  assert.ok(package_.prompt.includes(`- ${h.boots[1]}: began as start, not ended (this environment)`));
  assert.ok(package_.prompt.includes(`Loss marker ref: refs/factory/lost/${asked.work_id}/${h.boots[0]} at ${lost}`));
  assert.ok(package_.prompt.includes(`- bash (call call-7, boot ${h.boots[0]}, environment-ended, Execution ${first.executionId}): mvn deploy -DskipTests`));
  assert.match(
    package_.prompt,
    /Accumulated consumption of this Work \(it does not restart with a loss\): 2 Execution\(s\), \d+ s of measured Execution time; at least 120 MicroVM-seconds over the boots; operational recoveries consumed 1 of 3 /,
  );
  assert.match(package_.prompt, /1\. NEVER repeat an effect of uncertain result listed above/);
  assert.match(package_.prompt, /3\. If the rest depends on it, ask with ask_user/);
  // No transcript, no summary, no reference to the old session's file.
  assert.equal(package_.prompt.includes(sessionRef(1).ref), false);
  assert.equal(package_.prompt.includes(sessionRef(1).sessionId), false);
  assert.doesNotMatch(package_.prompt, /were preserved/);
  // The effect was read from the sandbox's report of the LOST boot and is on the lost Execution, in Control's record.
  assert.ok(h.reports.some(item => item.boot === h.boots[0]));
  assert.deepEqual(
    h
      .executions(asked)
      .find(item => item.executionId === first.executionId)!
      .indeterminateEffects?.map(item => [item.callId, item.outcome]),
    [['call-7', 'environment-ended']],
  );
  // V2-19.4 by mechanism: the gate precedes the end of the substitute's activation. It refused the unpublished commit, returned it to the
  // Builder in the same boot, and only the published commit let the Execution end with its Question.
  assert.equal(substitute.preservationGate?.occasion, 'substitute-end');
  assert.deepEqual(
    substitute.preservationGate?.attempts.map(item => [item.outcome, item.code, item.commit ?? null]),
    [
      ['refused', 'HEAD_NOT_PUBLISHED', null],
      ['accepted', null, done],
    ],
  );
  assert.equal(correction.phaseId, 'builder-preservation');
  assert.match(correction.prompt, /your activation ended and the environment is about to be shut down/);
  assert.deepEqual([asked.preservation?.commit, asked.preservation?.occasion, h.remote.refs![asked.branch!]], [done, 'substitute-end', done]);
  // V2-19.3: the Question is an ordinary one, recorded and pending; nothing else blocks the Work.
  assert.deepEqual(
    asked.impediments.map(item => item.code),
    ['QUESTION_PENDING'],
  );
  assert.deepEqual(h.kinds(), ['prepare', 'start', 'activate', 'stop', 'prepare', 'start', 'activate', 'gate', 'activate', 'gate', 'stop']);

  // The answer moves the Work forward: the SAME substitute session continues in a new boot from the published commit, and publishes.
  await h.answer('It was deployed: take it as done, do not repeat it.');
  await h.settle('published', value => value?.publication?.state === 'published');
  const finished = (await h.work())!;
  const continued = h.activations()[3]!;
  assert.deepEqual([continued.phaseId, (continued.continuation as { session: unknown }).session], ['builder-continuation', sessionRef(3)]);
  assert.ok(continued.prompt.includes('It was deployed: take it as done, do not repeat it.'));
  assert.ok(continued.prompt.includes(`Starting commit: ${done}`));
  assert.equal((await h.recoveries())?.consumed, 1, 'the resume after the answer consumes no operational recovery');
  assert.deepEqual(finished.impediments, []);
  assert.equal(finished.losses!.length, 1);
});

test('V2-10: without an operational recovery left, the loss follows the budget rule of the MVP: the Work is blocked by the exhausted counter and no substitute starts', async t => {
  const h = await harness(t, () => [{ kind: 'hang', head: lost }], { recoveryLimit: 0 });
  await lose(h);
  await h.settle('blocked by the budget', value => value?.impediments.some(item => item.code === 'RECOVERY_LIMIT_REACHED'));
  const work = (await h.work())!;
  assert.equal(h.activations().length, 1, 'no substitute was activated');
  assert.equal(h.kinds().filter(kind => kind === 'start').length, 1);
  assert.equal(work.losses!.length, 1);
});

test('final review, standards 4: a channel record that cannot be read never becomes "no uncertain effect": the package says it is unread and that earlier effects are to be taken as uncertain', async t => {
  const h = await harness(
    t,
    () => [
      { kind: 'hang', head: lost },
      { kind: 'hang', head: lost },
    ],
    { reportUnreadable: true },
  );
  const first = await lose(h);
  await h.settle('substitute started', value => value?.execution?.executionId !== first.executionId && value?.execution?.state === 'started');
  const prompt = h.activations().at(-1)!.prompt;
  assert.ok(
    prompt.includes('The Factory could NOT read its record of tool calls of uncertain result for the lost environment (CHANNEL_REPORT_UNREADABLE)'),
    prompt,
  );
  assert.equal(prompt.includes('recorded NO tool call of uncertain result'), false);
  assert.ok(prompt.includes('1. NEVER repeat an effect of uncertain result'));
  // Visible to the Operator too, on the Work's history.
  assert.ok((await h.work())!.history.some(item => item.event === 'channel-report-unread' && item.executionId === first.executionId));
});
