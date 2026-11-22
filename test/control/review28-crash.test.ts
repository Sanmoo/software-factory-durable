import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { readHost, recoveryDoubles, type RecoveryScript, type Review28 } from './recovery-doubles.js';
import { until as untilValue } from '../runner/budget.js';

// Ticket 28 crash cuts at the review handoff, composed with ticket 26: a REAL controller child (Control + Pi Durable/SQLite + Records) is
// SIGKILLed mid round with its doubled boot left active; a NEW Control reconciles on the same storage/Records (real Records discovery of the
// opinion and of start receipts). Doubled: Sandbox host (file-backed), Builder/reviewers (scripted), credentials, GitHub, clocks.
// Not evidence of a VM, systemd, worker process, model or GitHub.

async function crash(dir: string, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./recovery-crash-child.js', import.meta.url)), dir, mode], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk;
      if (output.includes('CUT')) child.kill('SIGKILL');
    });
    child.on('exit', (_code, signal) => (signal === 'SIGKILL' ? resolve() : reject(new Error(`child exited without crash: ${output}`))));
  });
}

async function reopen(t: { after(fn: () => Promise<void>): void }, dir: string, scripts: RecoveryScript[], review28: Review28) {
  const doubles = recoveryDoubles(dir, scripts, { review28 });
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  const time = manualClock();
  const control: Control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: doubles.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    stop.abort();
    await running;
  });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView;
  let jumped = false;
  const until = async (predicate: (value: WorkView) => boolean, label: string) => {
    return await untilValue(
      label,
      async () => {
        const value = await work();
        if (value && predicate(value)) return value;
        // The persisted 5 s recovery wait of ticket 26 is passed on the doubled calendar, once.
        if (!jumped && value?.pendingRecovery) {
          jumped = true;
          doubles.jumpCalendar(60000);
        }
        if (time.isSleeping()) time.advance();
        return undefined;
      },
      5,
    );
  };
  return { control, doubles, work, until };
}
const scratch = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review28-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('AC1/AC3/AC4/AC6/AC7 handoff crash: the lost Standards opinion is found in Records and carried once into the recovery round on the same proposal; only Spec is reviewed again; nothing adopted', async t => {
  const dir = await scratch(t);
  await crash(dir, 'review28-lost');
  const before = readHost(dir).log.length;
  const h = await reopen(t, dir, [{ kind: 'handoff' }], 'complete');
  const work = await h.until(
    value => value.execution?.review?.rounds[0]?.state === 'delivered' && value.previousExecutions.length === 1,
    'recovery round delivered',
  );
  const crashed = work.previousExecutions[0]!;
  const interrupted = crashed.review!.rounds[0]!;
  assert.deepEqual(
    [
      crashed.end?.code,
      crashed.end?.cessation,
      interrupted.reviewers.standards.state,
      interrupted.reviewers.standards.cessation,
      interrupted.reviewers.standards.failure?.code,
    ],
    ['CONTROLLER_CRASH', 'confirmed', 'failed', 'boot-ceased', 'EXECUTION_INTERRUPTED'],
    'ticket 26 settled the interrupted round',
  );
  const execution = work.execution!;
  assert.deepEqual(execution.interruption, { previousExecutionId: crashed.executionId, reason: 'OPERATIONAL_RECOVERY', code: 'CONTROLLER_CRASH' });
  const round = execution.review!.rounds[0]!;
  assert.equal(round.round, 2, 'the round numbers continue the Work');
  const standards = round.reviewers.standards;
  assert.deepEqual(
    [
      standards.source,
      standards.state,
      standards.opinion?.round,
      standards.opinion?.invocationId,
      standards.carried?.executionId,
      standards.carried?.round,
      standards.carried?.discovered,
    ],
    ['carried', 'ended', 1, interrupted.reviewers.standards.invocationId, crashed.executionId, 1, true],
  );
  assert.deepEqual(
    [round.reviewers.spec.source, round.reviewers.spec.opinion?.round, round.conclusion, round.applicability],
    ['notification', 2, 'clean', 'current'],
  );
  const after = readHost(dir).log.slice(before);
  assert.deepEqual(
    after.filter(item => item.kind === 'activate-reviewer').map(item => (item.detail as { role: string }).role),
    ['spec'],
    'Standards is never rerun for a lost notification',
  );
  assert.equal(
    after
      .filter(item => item.kind === 'observe-opinion')
      .filter(item => (item.detail as { invocationId: string }).invocationId === interrupted.reviewers.standards.invocationId).length,
    1,
    'located once',
  );
  assert.ok(work.history.some(item => item.event === 'opinion-carried' && 'detail' in item && /records-discovery/.test(item.detail ?? '')));
  // The substitute session: ticket 26's explicit instruction plus the preserved review state as context only (not proof of consumption).
  const prompt = h.doubles.prompts.at(-1)!.prompt;
  assert.match(prompt, /^Factory recovery instruction/);
  assert.match(
    prompt,
    /PRESERVED REVIEW STATE of the previous Execution — round 1 \(reviewing; conclusion not concluded; delivery to the previous Builder session: not-requested\)/,
  );
  assert.match(prompt, /keeps the valid opinions if the proposal is unchanged/);
  assert.equal(work.budget!.recoveries.consumed, 1, 'only the operational recovery of the Execution; carrying the opinion charges nothing');
});

test('review HIGH 1 + ticket 26/57: a crash during a reviewer retry wait — reconciliation settles the retry, with no recoveries reservation to release', async t => {
  const dir = await scratch(t);
  await crash(dir, 'review28-retry');
  const h = await reopen(t, dir, [], 'complete');
  const work = await h.until(
    value => value.previousExecutions.length === 1 || value.execution?.end?.cessation === 'confirmed',
    'interrupted Execution settled',
  );
  const crashed = work.previousExecutions[0] ?? work.execution!;
  const spec = crashed.review!.rounds[0]!.reviewers.spec;
  assert.deepEqual([spec.attempt, spec.charge, spec.attempts?.[0]?.failure?.code], [2, null, 'WORKER_INTERRUPTED']);
  assert.notEqual(spec.state, 'requested', 'the retry intent is settled by the reconciliation, never left pending');
  assert.notEqual(work.budget!.recoveries.reserved, spec.invocationId, 'never reserved (it would block every later retry and recovery)');
  assert.equal(
    work.impediments.some(item => item.code === 'RECOVERY_START_UNCERTAIN'),
    false,
  );
  assert.equal(
    work.history.some(item => item.event.startsWith('budget-') && 'detail' in item && item.detail === `recoveries:${spec.invocationId}`),
    false,
    'ticket 57: the reviewer retry neither reserved nor released a recovery',
  );
});
