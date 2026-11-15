import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseManifest, parseTapCounts, type FileResult } from '../../scripts/test-runner/lib.ts';
import { runTier, type FileRun, type Steps } from '../../scripts/test-runner/runner.ts';
import { childEnvironment, composeStatic, execute, fileEnvironment } from '../../scripts/test-runner/steps.ts';

const counts = { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };

function fakeSteps(overrides: Partial<Steps> = {}) {
  const events: string[] = [];
  const runs: FileRun[] = [];
  let clock = 0;
  const steps: Steps = {
    cpus: 8,
    now: () => clock,
    log: () => {},
    loadAverage: () => [1, 1, 1],
    checkDependencies: async () => { events.push('deps'); return []; },
    loadManifest: async () => { events.push('manifest'); return parseManifest({ schemaVersion: 1, files: {
      'test/slow.test.ts': { slow: true, reason: 'r' }, 'test/serial.test.ts': { serial: true, reason: 'r' } } }, () => true); },
    acquireLock: async tier => { events.push(`lock ${tier}`); return { waitedMs: 5000, release: () => events.push('release') }; },
    staticAnalysis: async tier => { events.push(`static ${tier}`); clock += 1000; return [{ name: 'tsc', ms: 1000, ok: true }]; },
    listTests: async () => ['test/a.test.ts', 'test/slow.test.ts', 'test/serial.test.ts'],
    loadTimings: async () => ({}),
    saveTimings: async () => { events.push('timings'); },
    sandboxRoot: async () => { events.push('sandbox'); return { path: '/private/r', cleanup: async () => { events.push('sandbox cleanup'); } } },
    runDirectory: async () => { events.push('shared'); return { path: '/private/run', cleanup: async () => { events.push('shared cleanup'); } } },
    runFile: async (file, run): Promise<FileResult> => {
      runs.push({ ...run });
      events.push(`run ${file}${run.sandboxRoot ? ` sandbox=${run.sandboxRoot}` : ''}${run.randomSeed === undefined ? '' : ` seed=${run.randomSeed}`}`);
      clock += 10;
      return { file, ms: 10, ok: true, counts };
    },
    ...overrides,
  };
  return { steps, events, runs, advance: (ms: number) => { clock += ms; } };
}

test('fast: no lock, slow excluded, parallel lane then serial lane', async () => {
  const { steps, events } = fakeSteps();
  const outcome = await runTier({ tier: 'fast', filters: [] }, steps);
  assert.equal(outcome.exitCode, 0, outcome.report);
  assert.deepEqual(events, ['deps', 'manifest', 'static fast', 'shared', 'run test/a.test.ts', 'run test/serial.test.ts', 'timings', 'shared cleanup']);
  assert.match(outcome.report, /lock wait: 0\.0 s/);
  assert.match(outcome.report, /slow, left to ci: 1 files/);
});

test('ci: preconditions first, then the machine lock before any work, everything included, lock released', async () => {
  const { steps, events } = fakeSteps();
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 0, outcome.report);
  assert.deepEqual(events, ['deps', 'manifest', 'lock ci', 'static ci', 'shared', 'run test/slow.test.ts', 'run test/a.test.ts', 'run test/serial.test.ts', 'timings', 'shared cleanup', 'release']);
  assert.match(outcome.report, /lock wait: 5\.0 s \(not counted in the budget\)/);
  assert.match(outcome.report, /total: 1\.0 s of 600 s budget/, 'lock wait is not part of the measured time');
});

test('full: private sandbox root for every file and a second pass in seeded random order', async () => {
  const { steps, events } = fakeSteps();
  const outcome = await runTier({ tier: 'full', filters: [], seed: 7 }, steps);
  assert.equal(outcome.exitCode, 0, outcome.report);
  const runs = events.filter(event => event.startsWith('run '));
  assert.equal(runs.length, 6);
  assert.ok(runs.every(event => event.includes('sandbox=/private/r')));
  assert.equal(runs.filter(event => event.endsWith('seed=7')).length, 3);
  assert.deepEqual(events.slice(0, 6), ['deps', 'manifest', 'lock full', 'static full', 'shared', 'sandbox']);
  assert.deepEqual(events.slice(-3), ['sandbox cleanup', 'shared cleanup', 'release']);
  assert.match(outcome.report, /random-order seed: 7/);
  assert.match(outcome.report, /\(no ceiling\)/);
});

test('every file gets the tier deadline (budget end, lock wait excluded) and the run\'s shared directory; full has no deadline', async () => {
  const ci = fakeSteps();
  ci.advance(42_000); // the budget clock starts after the lock
  assert.equal((await runTier({ tier: 'ci', filters: [] }, ci.steps)).exitCode, 0);
  assert.deepEqual(new Set(ci.runs.map(run => JSON.stringify(run))), new Set([JSON.stringify({ shared: '/private/run', deadline: 42_000 + 600_000 })]));
  const full = fakeSteps();
  await runTier({ tier: 'full', filters: [], seed: 1 }, full.steps);
  assert.ok(full.runs.every(run => run.deadline === undefined && run.shared === '/private/run'));
  assert.deepEqual(fileEnvironment({ PATH: '/bin' }, { deadline: 123, shared: '/private/run', sandboxRoot: '/s' }),
    { PATH: '/bin', FACTORY_TEST_DEADLINE: '123', FACTORY_TEST_RUN_DIRECTORY: '/private/run', FACTORY_SANDBOX_TEST_ROOT: '/s' });
  assert.deepEqual(fileEnvironment({ PATH: '/bin' }, {}), { PATH: '/bin' });
});

test('mismatched node_modules or a manifest citing a missing file fails early, before lock or compile', async () => {
  const deps = fakeSteps({ checkDependencies: async () => ['node_modules/@earendil-works/gondolin: missing (lockfile 0.14.0)'] });
  const outcome = await runTier({ tier: 'ci', filters: [] }, deps.steps);
  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.report, /^DEPENDENCIES_MISMATCH: .*npm ci.*\n {2}node_modules\/@earendil-works\/gondolin: missing/);
  assert.deepEqual(deps.events, []);
  const manifest = fakeSteps({ loadManifest: async () => parseManifest({ schemaVersion: 1, files: { 'test/gone.test.ts': { slow: true, reason: 'r' } } }, () => false) });
  const refused = await runTier({ tier: 'ci', filters: [] }, manifest.steps);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.report, /TIERS_MANIFEST_INVALID[\s\S]*test\/gone\.test\.ts: listed file does not exist/);
  assert.deepEqual(manifest.events, ['deps']);
});

test('static failure stops before tests and fails the gate', async () => {
  const { steps, events } = fakeSteps({ staticAnalysis: async () => [{ name: 'eslint', ms: 1, ok: false, output: 'x' }] });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 1);
  assert.ok(!events.some(event => event.startsWith('run ')));
  assert.match(outcome.report, /FAILURE: static eslint failed/);
});

test('a failing file fails the gate without retry', async () => {
  const { steps, events } = fakeSteps({ runFile: async file => ({ file, ms: 1, ok: file !== 'test/a.test.ts', counts }) });
  const runs: string[] = [];
  const outcome = await runTier({ tier: 'fast', filters: [] }, { ...steps, runFile: async (file, run, signal) => { runs.push(file); return steps.runFile(file, run, signal); } });
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(runs, ['test/a.test.ts', 'test/serial.test.ts'], 'each file exactly once');
  assert.match(outcome.report, /FAILURE: test\/a\.test\.ts failed/);
  assert.ok(events.includes('timings'));
});

test('budget overrun during the run aborts the running files and exits non-zero with an explicit message', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const fake = fakeSteps();
  const aborted: string[] = [];
  const outcome = runTier({ tier: 'fast', filters: [] }, { ...fake.steps, runFile: (file, _run, signal) => new Promise(resolve => {
    started();
    signal.addEventListener('abort', () => { aborted.push(file); fake.advance(180_001); resolve({ file, ms: 180_000, ok: false, counts }); });
  }) });
  await running;
  mock.timers.tick(180_000);
  const result = await outcome;
  assert.equal(result.exitCode, 1);
  assert.deepEqual(aborted, ['test/a.test.ts']);
  assert.match(result.report, /FAILURE: BUDGET_EXCEEDED: tier fast took 181\.0 s, over its 180 s ceiling \(lock wait excluded\)/);
  assert.ok(!fake.events.includes('timings'), 'an aborted run does not overwrite the timing history');
});

test('budget overrun detected at the end (no abort) still fails the gate', async () => {
  const fake = fakeSteps();
  const outcome = await runTier({ tier: 'ci', filters: [] }, { ...fake.steps,
    staticAnalysis: async () => { fake.advance(600_500); return [{ name: 'tsc', ms: 600_500, ok: true }]; } });
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.report, /BUDGET_EXCEEDED: tier ci took 600\.5 s/);
});

test('a filtered run is reported as convenience only and keeps the timing history', async () => {
  const { steps, events } = fakeSteps();
  const outcome = await runTier({ tier: 'fast', filters: ['a.test'] }, steps);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(events.filter(event => event.startsWith('run ')), ['run test/a.test.ts']);
  assert.ok(!events.includes('timings'));
  assert.match(outcome.report, /never a gate/);
});

test('TAP trailer counts and the child Node environment', () => {
  assert.deepEqual(parseTapCounts('ok 1 - x\n# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'),
    { tests: 3, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.deepEqual(childEnvironment({ PATH: '/bin', NODE_OPTIONS: '--x', NODE_COMPILE_CACHE: '/c', FACTORY_SANDBOX_TEST_ROOT: '/home/u/software-factory-test', FACTORY_TEST_ROOT: '/r',
    FACTORY_TEST_DEADLINE: '1', FACTORY_TEST_RUN_DIRECTORY: '/enclosing' }),
    { PATH: '/bin', NODE_DISABLE_COMPILE_CACHE: '1' });
});

test('a finished test process leaves nothing behind: leaked processes in its group are killed so its pipes close', async () => {
  const leak = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    console.log('leaked ' + c.pid); c.unref(); process.exit(3);`;
  const exit = await execute(process.execPath, ['-e', leak], process.cwd(), process.env, new AbortController().signal);
  assert.equal(exit.code, 3);
  const pid = Number(/leaked (\d+)/.exec(exit.output)?.[1]);
  assert.ok(pid > 0, exit.output);
  // Its death is what closed the pipes. The kernel closes a dying process's files before it becomes a zombie, so right after the close it
  // may still be scheduled (state R/D) on its exit path; that path is marked by PF_EXITING (0x4) in the stat flags, set before the files
  // close. So: gone, a zombie, or exiting; never a live process that merely closed its pipes.
  let observed = 'gone';
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ');
    observed = ['Z', 'X'].includes(fields[0]!) || (Number(fields[6]) & 0x4) ? 'dead' : `alive (state ${fields[0]}, flags ${fields[6]})`;
  } catch { /* gone */ }
  assert.ok(observed === 'gone' || observed === 'dead', `the leaked grandchild was killed with its group: ${observed}`);
});

test('static stage: without the staged SDK depcruise waits for compile (prepare-sdk); with it, all three run together', async () => {
  for (const staged of [false, true]) {
    const events: string[] = [];
    let finishCompile = () => {};
    const compiled = new Promise<void>(resolve => { finishCompile = resolve; });
    const result = composeStatic({ staged,
      compile: async () => { events.push('compile start'); await compiled; events.push('compile end'); return [{ name: 'tsc', ms: 1, ok: true }]; },
      lint: async () => { events.push('lint'); return { name: 'eslint', ms: 1, ok: true }; },
      depcruise: async () => { events.push('depcruise'); return [{ name: 'depcruise', ms: 1, ok: true }]; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.includes('depcruise'), staged, `staged=${staged}: depcruise before compile ends`);
    finishCompile();
    assert.deepEqual((await result).map(step => step.name), ['tsc', 'eslint', 'depcruise']);
    if (!staged) assert.ok(events.indexOf('depcruise') > events.indexOf('compile end'));
  }
});
