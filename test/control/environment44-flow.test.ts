import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilHolds } from '../runner/budget.js';
import { openControl } from '../../src/control/index.js';
import type { Control, ControlInput, ListView, WorkView } from '../../src/control/types.js';
import { declaredEnvironment, declaredEnvironmentSha256, githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { recoveryDoubles } from './recovery-doubles.js';

// Ticket 44 flow level (S): real Control + Pi Durable/SQLite + Records; doubled: GitHub (the environment declaration read included), the
// file-backed Sandbox host, Builder and credentials. Not evidence of a preparation VM, a disk, a mirror or a model.
type Refusal = { status: 'failure' | 'indeterminate'; code: string; detail?: string };

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Partial<Remote>, refusals: Refusal[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-environment44-flow-'));
  const world: Remote = { pulls: {}, issues: [remoteIssue(3)], ...remote };
  const github = { ...githubDoubles(world), remote: world };
  const prepare = [...refusals];
  const doubles = recoveryDoubles(dir, [], { prepareRefusal: () => prepare.shift() });
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
    await rm(dir, { recursive: true, force: true });
  });
  await time.sleeping();
  const works = async () => ((await control.inspect({ kind: 'list' })) as ListView).works as WorkView[];
  const work = async (number = 3) => (await works()).find(item => item.ticket.number === number)!;
  const until = (predicate: () => Promise<boolean> | boolean, label: string) =>
    untilHolds(
      label,
      async () => {
        if (await predicate()) return true;
        if (time.isSleeping()) time.advance();
        return false;
      },
      5,
    );
  const accept = (input: ControlInput) => control.accept(input);
  return { github, doubles, work, works, until, accept, time };
}

test('AC2/AC3: a repository without .factory/environment.yaml never starts its Work (ENVIRONMENT_NOT_DECLARED says what to create); once merged, polling pins it and the Work starts with it', async t => {
  const h = await harness(t, { environment: { kind: 'missing', commit: 'b'.repeat(40) } });
  await h.until(async () => (await h.work())?.impediments.some(item => item.code === 'ENVIRONMENT_NOT_DECLARED') ?? false, 'not declared');
  let work = await h.work();
  const impediment = work.impediments.find(item => item.code === 'ENVIRONMENT_NOT_DECLARED')!;
  assert.match(impediment.nextStep, /\.factory\/environment\.yaml/);
  assert.match(impediment.nextStep, /schemaVersion: 1/);
  assert.match(impediment.nextStep, /no fallback to the generic guest/);
  assert.equal(work.environment?.state, 'not-declared');
  assert.ok(work.dispatch.reasons.includes('ENVIRONMENT_NOT_DECLARED'));
  // Several rounds: still not started, never prepared on a guess.
  for (let i = 0; i < 3; i++) {
    h.time.advance();
    await h.time.sleeping();
  }
  assert.equal(h.doubles.calls('prepare').length, 0, 'no preparation without a declaration');
  assert.equal((await h.work()).execution, null);
  // The operator merges the file: the next round pins it (commit + hash) and the Work starts with exactly that declaration.
  h.github.remote.environment = { kind: 'declared', commit: 'a'.repeat(40), sha256: declaredEnvironmentSha256, declaration: declaredEnvironment };
  await h.until(async () => (await h.work()).execution?.end?.outcome === 'completed', 'started with the pinned environment');
  work = await h.work();
  assert.equal(work.environment?.state, 'pinned');
  if (work.environment?.state !== 'pinned') return;
  assert.deepEqual(
    [work.environment.pin.commit, work.environment.pin.sha256, work.environment.pin.path],
    ['a'.repeat(40), declaredEnvironmentSha256, '.factory/environment.yaml'],
  );
  assert.equal(
    work.impediments.some(item => item.code.startsWith('ENVIRONMENT_')),
    false,
  );
  const prepared = h.doubles.calls('prepare')[0]!.detail as { declaration: { sha256: string; commit: string; repositoryId: number; packages: string[] } };
  assert.deepEqual(prepared.declaration, {
    sha256: declaredEnvironmentSha256,
    commit: 'a'.repeat(40),
    repositoryId: 3,
    packages: ['openjdk25-jdk=25.0.5.1_p2-r0'],
  });
  assert.deepEqual(
    work.execution!.request.environment,
    {
      base: 'c'.repeat(64),
      declarationSha256: declaredEnvironmentSha256,
      manifestSha256: 'd'.repeat(64),
      reused: false,
      packages: { 'openjdk25-jdk': '25.0.5.1_p2-r0' },
      images: [],
    },
    'environment identity recorded with the Execution',
  );
  assert.ok(
    work.history.some(
      item => item.event === 'environment-evaluated' && 'detail' in item && item.detail === `environment-pinned:${'a'.repeat(40)}:${declaredEnvironmentSha256}`,
    ),
  );
});

test('AC3/AC4: an invalid file names its error paths; the pin is read once at creation, so a later change of the file applies to later Works only', async t => {
  const h = await harness(t, {
    environment: {
      kind: 'invalid',
      commit: 'b'.repeat(40),
      sha256: '1'.repeat(64),
      errors: [
        { path: 'apk[0].version', message: 'must be an exact Alpine version' },
        { path: 'run', message: 'unknown key' },
      ],
    },
  });
  await h.until(async () => (await h.work())?.impediments.some(item => item.code === 'ENVIRONMENT_DECLARATION_INVALID') ?? false, 'invalid');
  assert.match(
    (await h.work()).impediments.find(item => item.code === 'ENVIRONMENT_DECLARATION_INVALID')!.nextStep,
    /apk\[0\]\.version: must be an exact Alpine version; run: unknown key/,
  );
  h.github.remote.environment = { kind: 'declared', commit: 'a'.repeat(40), sha256: declaredEnvironmentSha256, declaration: declaredEnvironment };
  await h.until(async () => (await h.work()).execution?.end?.outcome === 'completed', 'first Work done');
  // The file changes on the base (new hash); a NEW Work of the repository pins the new one; the first keeps its pin (never re-read).
  const changed = { schemaVersion: 1 as const, apk: [{ name: 'openjdk25-jdk', version: '25.0.6_p1-r0' }], images: [] };
  h.github.remote.environment = { kind: 'declared', commit: 'f'.repeat(40), sha256: '2'.repeat(64), declaration: changed };
  h.github.remote.issues.push(remoteIssue(4));
  await h.until(async () => (await h.work(4))?.execution?.end?.outcome === 'completed', 'second Work pinned and done');
  const first = await h.work(3),
    second = await h.work(4);
  assert.equal(first.environment?.state === 'pinned' && first.environment.pin.sha256, declaredEnvironmentSha256, 'the first Work keeps its pin');
  assert.equal(second.environment?.state === 'pinned' && second.environment.pin.sha256, '2'.repeat(64));
  const declarations = h.doubles.calls('prepare').map(item => (item.detail as { declaration: { sha256: string } }).declaration.sha256);
  assert.deepEqual(declarations, [declaredEnvironmentSha256, '2'.repeat(64)], 'each Work prepared with its own pin');
});

test('AC9: a failed environment base preparation is a visible impediment with its cause, never retried implicitly; --retry-blocked-start retries the base (set aside, prepared again)', async t => {
  const detail =
    'guest preparation exit 1 (a declared version missing from https://dl-cdn.alpinelinux.org/alpine/v3.23 ...): ERROR: unable to select packages: openjdk25-jdk-25.0.5.1_p2-r0';
  const h = await harness(t, {}, [{ status: 'failure', code: 'ENVIRONMENT_BASE_PREPARATION_FAILED', detail }]);
  await h.until(async () => (await h.work())?.impediments.some(item => item.code === 'RECOVERY_BLOCKED') ?? false, 'blocked');
  let work = await h.work();
  assert.equal(work.execution!.blockedStart!.code, 'PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED');
  assert.deepEqual(
    [work.execution!.state, work.execution!.slot.held, work.execution!.blockedStart!.cessation],
    ['released', false, 'confirmed'],
    'Slot freed at once',
  );
  const blocked = work.impediments.find(item => item.code === 'RECOVERY_BLOCKED')!.nextStep;
  assert.match(blocked, /unable to select packages: openjdk25-jdk-25\.0\.5\.1_p2-r0/, 'the cause is visible');
  assert.match(blocked, /Nothing else was installed instead/);
  assert.match(blocked, new RegExp(`factory resume ${work.work_id} --retry-blocked-start PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED`));
  for (let i = 0; i < 3; i++) {
    h.time.advance();
    await h.time.sleeping();
  }
  assert.equal(h.doubles.calls('prepare').length, 1, 'no implicit retry');
  const receipt = await h.accept({
    request_id: 'retry-env-1',
    operation: 'resume',
    work_id: work.work_id,
    retry_blocked_start: 'PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED',
    origin: 'local-cli',
  });
  assert.equal((receipt as { outcome: string }).outcome, 'accepted');
  assert.deepEqual((await h.work()).environmentRetry?.request_id, 'retry-env-1');
  await h.until(async () => (await h.work()).execution?.end?.outcome === 'completed', 'retried and started');
  const calls = h.doubles.calls('prepare').map(item => (item.detail as { retryEnvironmentBase: boolean }).retryEnvironmentBase);
  assert.deepEqual(calls, [false, true], 'only the retried preparation retries the base');
  work = await h.work();
  assert.equal(work.environmentRetry, null, 'consumed by that preparation');
});
