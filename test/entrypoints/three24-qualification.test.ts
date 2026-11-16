import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import type { WorkView } from '../../src/control/index.js';

// Import and --plan of the ticket 24 real-run recipe must be inert: no process, socket, filesystem or SDK effect. Guards on controlled data only.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny, readFile: deny,
    access: deny, readdir: deny, copyFile: deny, chmod: deny, rm: deny }, defaultExport: deny });
}
const recipe = await import('./three24-qualification.js');

test('ticket 24 recipe: import and --plan are inert; own namespace and key copy, three NEW issues in one repository, capacity 3, read-only GitHub', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q24-three-v2');
  assert.match(plan.github.accessRoot, /^\/home\/sanmoo\/software-factory-test\/y5\/q24-three-v2 \(own namespace: credentials\/ copy of \/home\/sanmoo\/software-factory-test\/y5\/credentials\/app\.pem/);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.equal(plan.pinned, false, 'the supervisor pins the three NEW issue numbers in a reviewed commit before any phase');
  assert.deepEqual([plan.suite.command, plan.suite.pinned], ['cd /workspace/checkout && ./gradlew test', true], 'the supervisor-pinned real suite (README: ./gradlew test)');
  assert.equal(plan.tickets.length, 3);
  assert.equal(plan.capacity, 3);
  assert.deepEqual([plan.configuration.memoryMiB, plan.configuration.vcpus, plan.configuration.minFreeMemoryMiB], [2048, 2, 1024]);
  assert.deepEqual([plan.hostRequirements.minMemAvailableMiB, plan.hostRequirements.minStorageGiB, plan.hostRequirements.minCpus], [9216, 132, 6]);
  assert.ok(plan.github.writes.every((item: string) => !/push|pull request creation|PATCH/.test(item)));
  // The three gates collide on a shared daemon/host by construction: same name, published port and volume; each checks its own key.
  for (const item of plan.tickets) {
    assert.match(item.body, /--name q24-fixed -p 18080:8080 -v q24-shared:\/data/);
    assert.match(item.body, new RegExp(`Q24_WINDOW_START ${item.key} `));
    assert.doesNotMatch(item.body, /prune|--privileged|DOCKER_HOST|TESTCONTAINERS_RYUK_DISABLED/);
    assert.doesNotMatch(item.body, /mvnw/, 'v1 finding: the repository is Gradle-based; no Maven wrapper is ever assumed');
    assert.ok(item.body.includes('`cd /workspace/checkout && ./gradlew test`') && item.body.includes('--name q24-fixed'), 'real suite AND the collision fixture');
  }
  assert.ok(plan.decisions.some((item: string) => /different repositories in parallel" stays proven locally only/.test(item)));
  assert.ok(plan.expected.some((item: string) => /OOM .* never retried/.test(item)));
  assert.equal(new Set(plan.tickets.map((item: { title: string }) => item.title)).size, 3);
  assert.deepEqual([plan.model.providerRetries, plan.model.sdkRetries], [0, 0]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['preflight']), /TICKETS_NOT_PINNED/, 'refused before any effect while the issues are not pinned');
  assert.equal(forbidden, 0);
});

test('phase guard and host precondition: order, one shot, unknown host facts never pass', () => {
  const none = new Set<string>();
  const numbers = [{ number: 7 }, { number: 8 }, { number: 9 }];
  assert.equal(recipe.phaseGuard('preflight', {}, none), 'TICKETS_NOT_PINNED');
  assert.equal(recipe.phaseGuard('preflight', {}, none, [{ number: 7 }, { number: 7 }, { number: 9 }], 'suite'), 'TICKETS_NOT_PINNED', 'three DISTINCT issues');
  assert.equal(recipe.phaseGuard('preflight', {}, none, numbers, 'suite'), null);
  assert.equal(recipe.phaseGuard('preflight', {}, new Set(['preflight-intent']), numbers, 'suite'), 'PHASE_ALREADY_RAN');
  assert.equal(recipe.phaseGuard('run', { preflight: { status: 'held' } }, none, numbers, 'suite'), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(recipe.phaseGuard('run', { preflight: { status: 'success' } }, none, numbers, 'suite'), null);
  assert.equal(recipe.phaseGuard('inspect', { preflight: { status: 'success' } }, none, numbers, 'suite'), 'RUN_REQUIRED');
  assert.equal(recipe.phaseGuard('stop-environment', { preflight: { status: 'success' } }, new Set(['run-intent']), numbers, 'suite'), null);
  const gib = 1073741824;
  const ok = { memAvailableBytes: 10 * gib, storageAvailableBytes: 500 * gib, cpus: 8, kvm: true, systemdUser: 'running', activeUnits: [] as string[], qemuProcesses: 0 };
  assert.deepEqual(recipe.hostPrecondition(ok), { ok: true, reasons: [] });
  assert.deepEqual(recipe.hostPrecondition({ ...ok, systemdUser: 'degraded' }).ok, true);
  assert.deepEqual(recipe.hostPrecondition({ memAvailableBytes: null, storageAvailableBytes: null, cpus: 4, kvm: false, systemdUser: null, activeUnits: null, qemuProcesses: null }).reasons,
    ['HOST_MEMORY_BELOW_REQUIREMENT', 'HOST_STORAGE_BELOW_REQUIREMENT', 'HOST_CPUS_BELOW_REQUIREMENT', 'KVM_UNAVAILABLE', 'SYSTEMD_USER_MANAGER_UNAVAILABLE:unreachable',
      'FACTORY_UNITS_UNKNOWN', 'QEMU_PROCESSES_UNKNOWN']);
  assert.deepEqual(recipe.hostPrecondition({ ...ok, memAvailableBytes: 8 * gib }).reasons, ['HOST_MEMORY_BELOW_REQUIREMENT']);
  const unit = 'factory-sandbox-boot-11111111-2222-4333-8444-555555555555.service';
  assert.deepEqual(recipe.hostPrecondition({ ...ok, activeUnits: [unit], qemuProcesses: 1 }).reasons, [`FACTORY_UNITS_ACTIVE:${unit}`, 'QEMU_PROCESSES_ACTIVE:1'],
    'a running Factory VM is refused by name');
  assert.deepEqual(recipe.hostPrecondition({ ...ok, systemdUser: 'starting' }).reasons, ['SYSTEMD_USER_MANAGER_UNAVAILABLE:starting']);
});

test('activation guard: one implementation Builder per pinned Work (at most three), reviewers only of that Execution in distinct rounds, nothing else', () => {
  const guard = recipe.activationGuard(2);
  const c = (role: string, workId: string, executionId: string, phaseId = 'builder-initial') => ({ role, workId, executionId, phaseId });
  assert.equal(guard(c('builder', 'w1', 'e1'), false), false, 'an unpinned Work never activates');
  assert.equal(guard(c('builder', 'w1', 'e1'), true), true);
  assert.equal(guard(c('builder', 'w1', 'e9'), true), false, 'one Builder per Work');
  assert.equal(guard(c('builder', 'w2', 'e2', 'builder-publication'), true), false, 'never a publication activation');
  assert.equal(guard(c('builder', 'w2', 'e2'), true), true);
  assert.equal(guard(c('builder', 'w3', 'e3'), true), true);
  assert.equal(guard(c('builder', 'w4', 'e4'), true), false, 'never a fourth Builder');
  assert.equal(guard(c('standards', 'w1', 'e1', 'p'), true, { round: 1 }), true);
  assert.equal(guard(c('standards', 'w1', 'e1', 'p'), true, { round: 1 }), false, 'distinct rounds');
  assert.equal(guard(c('spec', 'w1', 'e2', 'p'), true, { round: 1 }), false, 'reviewers of another Execution');
  assert.equal(guard(c('spec', 'w2', 'e2', 'p'), true, { round: 1 }), true);
  assert.equal(guard(c('standards', 'w1', 'e1', 'p'), true, { round: 2 }), true);
  assert.equal(guard(c('standards', 'w1', 'e1', 'p'), true, { round: 3 }), false, 'at most the configured rounds');
});

test('run end and verdict: all three settled; success only with completed + confirmed cessation, one-pass reservation and overlapping container windows', async () => {
  const { containerWindows } = await import('./three24-measure.js');
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 15, 12, 0, seconds)).toISOString();
  const execution = (n: number, extra: Record<string, unknown> = {}) => ({ executionId: `e${n}`, state: 'ended', start: { receiptId: 'r' }, slot: { held: false, reservedAt: at(n) },
    dispatch: { environment: `env-${n}`, boot: `boot-${n}`, phase: 'stopped' }, request: { branch: `factory/${n}-x` },
    end: { at: at(600 + n), outcome: 'completed', cessation: 'confirmed' }, ...extra });
  const work = (n: number, extra: Record<string, unknown> = {}) => ({ ticket: { number: n }, execution: execution(n, extra) }) as unknown as WorkView;
  const numbers = [7, 8, 9];
  assert.deepEqual(recipe.runSettled([work(7), work(8), work(9)], numbers), { done: true, success: true, findings: [] });
  assert.deepEqual(recipe.runSettled([work(7), work(8, { state: 'started', slot: { held: true, reservedAt: at(8) } }), work(9)], numbers), { done: false, success: false, findings: [] });
  assert.deepEqual(recipe.runSettled([work(7), work(8, { end: { at: at(1), outcome: 'failure', cessation: 'confirmed' } }), work(9)], numbers), { done: true, success: false, findings: [] });
  assert.deepEqual(recipe.runSettled([work(7), work(8, { state: 'ended', slot: { held: true, reservedAt: at(8) }, end: { at: at(1), outcome: 'failure', cessation: 'unconfirmed' } }), work(9)], numbers),
    { done: false, success: false, findings: [] }, 'an uncertain Slot is never settled');
  assert.equal(recipe.threeStarted([work(7), work(8)], numbers), false);
  assert.equal(recipe.threeStarted([work(7), work(8), work(9)], numbers), true);
  const overlapping = containerWindows({ A: 'Q24_WINDOW_START A 1763208000 ... Q24_WINDOW_END A 1763208100', B: 'Q24_WINDOW_START B 1763208050\nQ24_WINDOW_END B 1763208160',
    C: 'Q24_WINDOW_START C 1763208090 Q24_WINDOW_END C 1763208170' });
  const evidence = { passes: { 'env-7': 'p1', 'env-8': 'p1', 'env-9': 'p1' }, summary: [7, 8, 9].map(n => ({ boot: `boot-${n}`, samples: 4 })) };
  const passed = recipe.verdict([work(7), work(8), work(9)], overlapping, evidence, numbers);
  assert.equal(passed.passed, true, JSON.stringify(passed.checks));
  const late = recipe.verdict([work(7), work(8), work(9, { slot: { held: false, reservedAt: at(900) } })], overlapping, evidence, numbers);
  assert.equal(late.checks.find(item => item.name === 'one-pass-reservation')!.ok, false, 'a reservation after another Work ended is not the same pass');
  const twoPasses = recipe.verdict([work(7), work(8), work(9)], overlapping, { ...evidence, passes: { ...evidence.passes, 'env-9': 'p2' } }, numbers);
  assert.equal(twoPasses.checks.find(item => item.name === 'one-pass-reservation')!.ok, false, 'the pass identity is observed, not inferred from timestamps');
  const unlogged = recipe.verdict([work(7), work(8), work(9)], overlapping, { ...evidence, passes: {} }, numbers);
  assert.equal(unlogged.checks.find(item => item.name === 'one-pass-reservation')!.ok, false);
  const unmeasured = recipe.verdict([work(7), work(8), work(9)], overlapping, { ...evidence, summary: [] }, numbers);
  assert.deepEqual([unmeasured.passed, unmeasured.checks.find(item => item.name === 'resources-measured')!.ok], [false, false], 'every sample absent fails the verdict');
  const shared = recipe.verdict([work(7), work(8, { dispatch: { environment: 'env-7', boot: 'boot-8', phase: 'stopped' } }), work(9)], overlapping, evidence, numbers);
  assert.equal(shared.checks.find(item => item.name === 'own-environment-boot-branch')!.ok, false);
  const apart = containerWindows({ A: 'Q24_WINDOW_START A 1763208000 Q24_WINDOW_END A 1763208010', B: 'Q24_WINDOW_START B 1763208050 Q24_WINDOW_END B 1763208060', C: '' });
  assert.deepEqual([apart.known, apart.overlapAll], [false, false]);
  // The command text itself (in the session's tool call) never counts as an observed window: only printed epochs do.
  assert.deepEqual(containerWindows({ A: recipe.gateCommand('A') }).windows.A, { start: null, end: null });
});

test('never-started: a Work that left without a start receipt, or a start window elapsed, stops the run with that reason; boots are recovered from the start log', () => {
  const work = (n: number, execution: Record<string, unknown> | null) => ({ ticket: { number: n }, execution }) as unknown as WorkView;
  const started = { state: 'started', start: { receiptId: 'r' } };
  const numbers = [7, 8, 9];
  assert.equal(recipe.neverStarted([work(7, started), work(8, null), work(9, null)], 60_000, 25 * 60_000, numbers), null);
  assert.equal(recipe.neverStarted([work(7, started), work(8, { state: 'held', start: null, held: { code: 'START_INSUFFICIENT_MEMORY_FOR_BOOT' } }), work(9, null)], 60_000, 25 * 60_000, numbers),
    'WORK_NEVER_STARTED:8:START_INSUFFICIENT_MEMORY_FOR_BOOT');
  assert.equal(recipe.neverStarted([work(7, started), work(8, started), work(9, { state: 'reserved', start: null })], 26 * 60_000, 25 * 60_000, numbers),
    'WORK_NEVER_STARTED:9:START_WINDOW_ELAPSED');
  const boot = 'boot-11111111-2222-4333-8444-555555555555';
  assert.deepEqual(recipe.startedBoots([{ call: 'start-requested', environment: 'env-a', pass: 'p' }, { call: 'start', environment: 'env-a', result: { status: 'success', boot } },
    { call: 'start', environment: 'env-b', result: { status: 'failure', code: 'X' } }]), [{ environment: 'env-a', boot, ticket: null, executionId: null, needsStop: true }]);
});

test('v2 guards: the real suite command must be pinned; a Builder Question is a recorded finding (held), not a recipe failure to retry', () => {
  const numbers = [{ number: 7 }, { number: 8 }, { number: 9 }];
  assert.equal(recipe.phaseGuard('preflight', {}, new Set(), numbers, null), 'SUITE_COMMAND_NOT_PINNED');
  assert.equal(recipe.phaseGuard('preflight', {}, new Set(), numbers, 'cd /workspace/checkout && ./gradlew --no-daemon check'), null);
  const at = new Date(Date.UTC(2026, 10, 16, 2, 0, 0)).toISOString();
  const work = (n: number, outcome: string) => ({ ticket: { number: n }, execution: { state: 'ended', slot: { held: false }, end: { at, outcome, cessation: 'confirmed' } } }) as unknown as WorkView;
  assert.deepEqual(recipe.runSettled([work(7, 'completed'), work(8, 'completed'), work(9, 'question')], [7, 8, 9]),
    { done: true, success: false, findings: ['QUESTION_ASKED:9'] });
  assert.deepEqual(recipe.runSettled([work(7, 'completed'), work(8, 'completed'), work(9, 'completed')], [7, 8, 9]), { done: true, success: true, findings: [] });
});

test('v1 offline proof (y5/q24-three-v1, derived summary in docs/evidence): one pass, own environment/boot/branch, overlapping containers, measured units; #23 asked', async () => {
  // node:fs (sync) is not among the modules this file mocks; the summary is a reviewed repository file next to the evidence.
  const v1 = JSON.parse(readFileSync(new URL('../../../docs/evidence/24-real-q24-three-v1-summary.json', import.meta.url), 'utf8')) as {
    passes: Record<string, string>; works: WorkView[]; registry: { summary: { boot: string; samples: number; maxWorkersAtOnce: number; ioReadBytes: number | null }[] };
    sessionObservations: { windows: Record<string, number[][]> } };
  const { containerWindows } = await import('./three24-measure.js');
  const texts = Object.fromEntries(Object.entries(v1.sessionObservations.windows).map(([key, windows]) =>
    [key, windows.map(([start, end]) => `Q24_WINDOW_START ${key} ${start} Q24_WINDOW_END ${key} ${end}`).join('\n')]));
  const windows = containerWindows(texts);
  const result = recipe.verdict(v1.works, windows, { passes: v1.passes, summary: v1.registry.summary }, [21, 22, 23]);
  const by = Object.fromEntries(result.checks.map(item => [item.name, item.ok]));
  assert.deepEqual(by, { 'three-executions': true, 'own-environment-boot-branch': true, 'one-pass-reservation': true, 'resources-measured': true,
    'completed-with-cessation': false, 'containers-overlapped': true });
  assert.deepEqual(recipe.runSettled(v1.works, [21, 22, 23]), { done: true, success: false, findings: ['QUESTION_ASKED:23'] }, 'the held cause: the #23 Question');
  assert.deepEqual(v1.registry.summary.map(item => item.maxWorkersAtOnce).sort(), [1, 3, 3], 'reviewers ran inside their Builder\'s own unit (3 workers), #23 never reached review');
  assert.ok(v1.registry.summary.every(item => item.ioReadBytes === null), 'io.stat was unreadable in the user units: I/O is unknown, never zero');
});
