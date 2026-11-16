import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, ShowView, WorkView } from '../../src/control/types.js';
import type { QuestionObservation } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { recoveryDoubles, updateHost, type RecoveryScript } from './recovery-doubles.js';

// Ticket 27 flow level (S): real Control + Pi Durable/SQLite + REAL Records (question facet) with the file-backed host double. The first owner
// stops with its boot's cessation UNCONFIRMED (stuck unit), so the next boot reconciles the interruption (ticket 26) — or an administrative stop
// while the start receipt is awaited reconciles it at once. Doubled: Sandbox host, Builder, credentials, GitHub. No SIGKILL here (see
// effects27-crash for the real kill); not evidence of a VM, worker, model or GitHub.
const qid = (n: number) => `0b9c6a52-3d3e-4c8f-9a51-${String(n).padStart(12, '0')}`;

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-effects27-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock>; doubles: ReturnType<typeof recoveryDoubles> } | undefined;
  async function start(scripts: RecoveryScript[], observeQuestion?: (input: { workId: string; executionId: string; invocationId: string }) => Promise<QuestionObservation>) {
    const doubles = recoveryDoubles(dir, scripts);
    if (observeQuestion) doubles.ports.workers.observeQuestion = observeQuestion;
    const time = manualClock();
    const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: doubles.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time, doubles };
    await time.sleeping();
    return current;
  }
  async function halt() { if (current && !current.stop.signal.aborted) { current.stop.abort(); return current.running; } return null; }
  t.after(async () => { await halt(); });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView;
  const show = async (work_id: string) => await current!.control.inspect({ kind: 'show', work_id }) as Extract<ShowView, { kind: 'work' }>;
  const until = async (predicate: () => Promise<boolean> | boolean, label: string) => {
    for (let i = 0; i < 1500; i++) {
      if (await predicate()) return;
      if (current!.time.isSleeping()) current!.time.advance();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`${label} not reached`);
  };
  /** The first owner runs until `ready`, then stops with the boot's cessation unconfirmed; the next owner (unit stopped meanwhile) reconciles. */
  async function interrupted(script: RecoveryScript, ready: () => boolean, observeQuestion?: Parameters<typeof start>[1]) {
    await start([script]);
    await until(async () => (await work())?.execution?.state === 'started' && ready(), 'cut reached');
    const boot = (await work()).execution!.dispatch.boot!;
    updateHost(dir, state => { state.stuck.push(boot); });
    assert.deepEqual(await halt(), { kind: 'uncertain' });
    updateHost(dir, state => { state.stuck = []; });
    await start([], observeQuestion);
    return await work();
  }
  return { dir, start, halt, work, show, until, interrupted, current: () => current! };
}

test('review MED 2 (AC5): a preserved request whose content is lost (partial record) maps to RECOVERY_BLOCKED; nothing invented, no recovery, no new activation', async t => {
  const h = await harness(t);
  const work = await h.interrupted({ kind: 'ask-preserved', questionId: qid(1), question: 'Which port?', partial: true },
    () => h.current().doubles.calls('question-preserved').length === 1);
  const execution = work.execution!;
  assert.deepEqual([execution.end!.outcome, execution.end!.code, execution.recovery!.at(-1)!.decision, execution.recovery!.at(-1)!.question],
    ['failure', 'QUESTION_RECORD_INCOMPLETE', 'blocked', 'found:QUESTION_RECORD_INCOMPLETE']);
  assert.ok(work.impediments.some(item => item.code === 'RECOVERY_BLOCKED'), 'blocked for an explicit decision');
  assert.deepEqual([work.questions.length, work.pendingRecovery], [0, null], 'no Question invented; no operational recovery');
  assert.equal(h.current().doubles.calls('activate').length, 1, 'only the interrupted activation: nothing started by this boot');
});

test('review MED 1: a TRANSIENT Records failure when nothing was asked keeps the ordinary recovery (bounded retries, noted), never a QUESTION_* block', async t => {
  const h = await harness(t);
  let reads = 0;
  const unavailable = async (): Promise<QuestionObservation> => { reads++; return { kind: 'uncertain', code: 'RECORDS_UNAVAILABLE' }; };
  const work = await h.interrupted({ kind: 'hang' }, () => true, unavailable);
  const execution = work.execution!;
  assert.equal(reads, 3, 'retried a bounded number of times');
  assert.deepEqual([execution.end!.outcome, execution.end!.code, execution.recovery!.at(-1)!.decision, execution.recovery!.at(-1)!.question],
    ['failure', 'ADMINISTRATIVE_STOP_CESSATION_UNCONFIRMED', 'operational-recovery', 'unresolved:RECORDS_UNAVAILABLE']);
  assert.equal(work.impediments.some(item => item.code === 'RECOVERY_BLOCKED'), false);
  assert.ok(work.pendingRecovery, 'the routine operational recovery is requested');
});

test('review MED 3: a request the Control REFUSED live is never re-recorded from Records at boot; the refusal is durable and honored', async t => {
  const h = await harness(t);
  const work = await h.interrupted({ kind: 'ask-preserved', questionId: qid(3), question: 'Which port?', notifyInvalid: true },
    () => h.current().doubles.calls('question-ack').length === 1);
  const execution = work.execution!;
  assert.deepEqual(execution.questionRefusals?.map(item => [item.questionId, item.code]), [[qid(3), 'QUESTION_REQUEST_INVALID']]);
  assert.equal(work.questions.length, 0, 'not recorded from Records');
  assert.deepEqual([execution.end!.outcome, execution.recovery!.at(-1)!.question], ['failure', 'refused-live:QUESTION_REQUEST_INVALID']);
  assert.ok(work.history.some(item => item.event === 'question-refused'));
});

test('review MED 4: an administrative stop that reconciles a preserved Question records it (records-recovery) and KEEPS the stop intent', async t => {
  const h = await harness(t);
  await h.start([{ kind: 'ask-preserved', questionId: qid(4), question: 'Which port?', loseNotification: true }]);
  await h.until(() => h.current().doubles.calls('question-preserved').length === 1, 'preserved');
  assert.deepEqual(await h.halt(), { kind: 'clean' });
  await h.start([]);
  const work = await h.work();
  const stopped = work.execution!;
  assert.deepEqual([stopped.end!.outcome, stopped.end!.code, stopped.end!.questionId, stopped.recovery!.at(-1)!.trigger, stopped.recovery!.at(-1)!.decision],
    ['stopped', 'ADMINISTRATIVE_STOP', qid(4), 'administrative-stop', 'administrative-continuation']);
  const [question] = (await h.show(work.work_id)).questions;
  assert.deepEqual([question!.questionId, question!.recordedFrom], [qid(4), 'records-recovery']);
  assert.ok(work.history.some(item => item.event === 'question-recorded' && item.origin === 'records-recovery'), 'history says where it came from');
});
