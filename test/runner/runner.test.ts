import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseManifest, parseTapCounts, type FileResult } from '../../scripts/test-runner/lib.ts';
import { runTier, type FileRun, type Steps } from '../../scripts/test-runner/runner.ts';
import { childEnvironment, composeStatic, eslintFindings, execute, fileEnvironment, pointerFindings, tscFindings } from '../../scripts/test-runner/steps.ts';
import type { Change, IntegralRecord } from '../../scripts/test-runner/selection.ts';
import { fixturePolicy } from './policy-fixture.ts';

const counts = { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };

function fakeSteps(overrides: Partial<Steps> = {}) {
  const events: string[] = [];
  const runs: FileRun[] = [];
  const integrals: IntegralRecord[] = [];
  let clock = 0;
  const steps: Steps = {
    cpus: 8,
    now: () => clock,
    log: () => {},
    loadAverage: () => [1, 1, 1],
    checkDependencies: async () => {
      events.push('deps');
      return [];
    },
    loadManifest: async () => {
      events.push('manifest');
      return parseManifest(
        {
          schemaVersion: 1,
          files: {
            'test/slow.test.ts': { slow: true, reason: 'r' },
            'test/serial.test.ts': { serial: true, reason: 'r' },
          },
        },
        () => true,
      );
    },
    loadPolicy: async () => fixturePolicy(),
    changedSet: async base => ({ widened: 'fake: no repository', base }),
    loadIntegral: async () => undefined,
    saveIntegral: async record => {
      integrals.push(record);
    },
    headCommit: async () => 'abc',
    acquireLock: async tier => {
      events.push(`lock ${tier}`);
      return { waitedMs: 5000, release: () => events.push('release') };
    },
    staticAnalysis: async tier => {
      events.push(`static ${tier}`);
      clock += 1000;
      return [{ name: 'tsc', ms: 1000, ok: true }];
    },
    loadLevels: async () => () => 'integration',
    audit: async () => {
      events.push('audit');
      return { name: 'npm audit', ms: 1, ok: true, check: 'vulnerabilities', findings: [] };
    },
    listTests: async () => ['test/a.test.ts', 'test/slow.test.ts', 'test/serial.test.ts'],
    loadTimings: async () => ({}),
    saveTimings: async () => {
      events.push('timings');
    },
    sandboxRoot: async () => {
      events.push('sandbox');
      return {
        path: '/private/r',
        cleanup: async () => {
          events.push('sandbox cleanup');
        },
      };
    },
    runDirectory: async () => {
      events.push('shared');
      return {
        path: '/private/run',
        cleanup: async () => {
          events.push('shared cleanup');
        },
      };
    },
    runFile: async (file, run): Promise<FileResult> => {
      runs.push({ ...run });
      events.push(`run ${file}${run.sandboxRoot ? ` sandbox=${run.sandboxRoot}` : ''}${run.randomSeed === undefined ? '' : ` seed=${run.randomSeed}`}`);
      clock += 10;
      return { file, ms: 10, ok: true, counts };
    },
    ...overrides,
  };
  return {
    steps,
    events,
    runs,
    integrals,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const allUnit = { loadLevels: async () => () => 'unit' as const };

test('fast: no lock, slow excluded, parallel lane then serial lane', async () => {
  const { steps, events } = fakeSteps(allUnit);
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
  assert.deepEqual(events, [
    'deps',
    'manifest',
    'lock ci',
    'static ci',
    'shared',
    'run test/slow.test.ts',
    'run test/a.test.ts',
    'run test/serial.test.ts',
    'timings',
    'shared cleanup',
    'release',
  ]);
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

test("every file gets the tier deadline (budget end, lock wait excluded) and the run's shared directory; full has no deadline", async () => {
  const ci = fakeSteps();
  ci.advance(42_000); // the budget clock starts after the lock
  assert.equal((await runTier({ tier: 'ci', filters: [] }, ci.steps)).exitCode, 0);
  assert.deepEqual(new Set(ci.runs.map(run => JSON.stringify(run))), new Set([JSON.stringify({ shared: '/private/run', deadline: 42_000 + 600_000 })]));
  const full = fakeSteps();
  await runTier({ tier: 'full', filters: [], seed: 1 }, full.steps);
  assert.ok(full.runs.every(run => run.deadline === undefined && run.shared === '/private/run'));
  assert.deepEqual(fileEnvironment({ PATH: '/bin' }, { deadline: 123, shared: '/private/run', sandboxRoot: '/s' }), {
    PATH: '/bin',
    FACTORY_TEST_DEADLINE: '123',
    FACTORY_TEST_RUN_DIRECTORY: '/private/run',
    FACTORY_SANDBOX_TEST_ROOT: '/s',
  });
  assert.deepEqual(fileEnvironment({ PATH: '/bin' }, {}), { PATH: '/bin' });
});

test('mismatched node_modules or a manifest citing a missing file fails early, before lock or compile', async () => {
  const deps = fakeSteps({ checkDependencies: async () => ['node_modules/@earendil-works/gondolin: missing (lockfile 0.14.0)'] });
  const outcome = await runTier({ tier: 'ci', filters: [] }, deps.steps);
  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.report, /^DEPENDENCIES_MISMATCH: .*npm ci.*\n {2}node_modules\/@earendil-works\/gondolin: missing/);
  assert.deepEqual(deps.events, []);
  const manifest = fakeSteps({
    loadManifest: async () => parseManifest({ schemaVersion: 1, files: { 'test/gone.test.ts': { slow: true, reason: 'r' } } }, () => false),
  });
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
  const { steps, events } = fakeSteps({ ...allUnit, runFile: async file => ({ file, ms: 1, ok: file !== 'test/a.test.ts', counts }) });
  const runs: string[] = [];
  const outcome = await runTier(
    { tier: 'fast', filters: [] },
    {
      ...steps,
      runFile: async (file, run, signal) => {
        runs.push(file);
        return steps.runFile(file, run, signal);
      },
    },
  );
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(runs, ['test/a.test.ts', 'test/serial.test.ts'], 'each file exactly once');
  assert.match(outcome.report, /FAILURE: quality gate Unit tests \(unit-tests\): test\/a\.test\.ts failed/);
  assert.ok(events.includes('timings'));
});

test('budget overrun during the run aborts the running files and exits non-zero with an explicit message', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let started!: () => void;
  const running = new Promise<void>(resolve => {
    started = resolve;
  });
  const fake = fakeSteps(allUnit);
  const aborted: string[] = [];
  const outcome = runTier(
    { tier: 'fast', filters: [] },
    {
      ...fake.steps,
      runFile: (file, _run, signal) =>
        new Promise(resolve => {
          started();
          signal.addEventListener('abort', () => {
            aborted.push(file);
            fake.advance(180_001);
            resolve({ file, ms: 180_000, ok: false, counts });
          });
        }),
    },
  );
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
  const outcome = await runTier(
    { tier: 'ci', filters: [] },
    {
      ...fake.steps,
      staticAnalysis: async () => {
        fake.advance(600_500);
        return [{ name: 'tsc', ms: 600_500, ok: true }];
      },
    },
  );
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.report, /BUDGET_EXCEEDED: tier ci took 600\.5 s/);
});

test('a filtered run is reported as convenience only and keeps the timing history', async () => {
  const { steps, events } = fakeSteps();
  const outcome = await runTier({ tier: 'fast', filters: ['a.test'] }, steps);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(
    events.filter(event => event.startsWith('run ')),
    ['run test/a.test.ts'],
  );
  assert.ok(!events.includes('timings'));
  assert.match(outcome.report, /never a gate/);
});

test('TAP trailer counts and the child Node environment', () => {
  assert.deepEqual(parseTapCounts('ok 1 - x\n# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'), {
    tests: 3,
    pass: 2,
    fail: 0,
    cancelled: 0,
    skipped: 1,
    todo: 0,
  });
  assert.deepEqual(
    childEnvironment({
      PATH: '/bin',
      NODE_OPTIONS: '--x',
      NODE_COMPILE_CACHE: '/c',
      FACTORY_SANDBOX_TEST_ROOT: '/home/u/software-factory-test',
      FACTORY_TEST_ROOT: '/r',
      FACTORY_TEST_DEADLINE: '1',
      FACTORY_TEST_RUN_DIRECTORY: '/enclosing',
    }),
    { PATH: '/bin', NODE_DISABLE_COMPILE_CACHE: '1' },
  );
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
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
      .replace(/^.*\) /s, '')
      .split(' ');
    observed = ['Z', 'X'].includes(fields[0]!) || Number(fields[6]) & 0x4 ? 'dead' : `alive (state ${fields[0]}, flags ${fields[6]})`;
  } catch {
    /* gone */
  }
  assert.ok(observed === 'gone' || observed === 'dead', `the leaked grandchild was killed with its group: ${observed}`);
});

test('static stage: depcruise waits for compile (staged SDK, build output), the other checks run alongside it', async () => {
  for (const staged of [false, true]) {
    const events: string[] = [];
    let finishCompile = () => {};
    const compiled = new Promise<void>(resolve => {
      finishCompile = resolve;
    });
    const result = composeStatic({
      staged,
      compile: async () => {
        events.push('compile start');
        await compiled;
        events.push('compile end');
        return [{ name: 'tsc', ms: 1, ok: true }];
      },
      lint: async () => {
        events.push('lint');
        return { name: 'eslint', ms: 1, ok: true };
      },
      depcruise: async () => {
        events.push('depcruise');
        return [{ name: 'depcruise', ms: 1, ok: true }];
      },
      pointers: async () => {
        events.push('pointers');
        return { name: 'guide-pointers', ms: 1, ok: true };
      },
      avoided: async () => {
        events.push('avoided');
        return { name: 'avoided-terms', ms: 1, ok: true };
      },
      suppressions: async () => {
        events.push('suppressions');
        return { name: 'lint-suppressions', ms: 1, ok: true };
      },
      format: async () => {
        events.push('format');
        return { name: 'prettier', ms: 1, ok: true };
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!events.includes('depcruise') && events.includes('lint') && events.includes('pointers'), `staged=${staged}`);
    finishCompile();
    assert.deepEqual(
      (await result).map(step => step.name),
      ['tsc', 'eslint', 'depcruise', 'guide-pointers', 'avoided-terms', 'lint-suppressions', 'prettier'],
    );
    assert.ok(events.indexOf('depcruise') > events.indexOf('compile end'));
  }
});

const graphOf = (edges: Record<string, string[]>) => ({ edges: new Map(Object.entries(edges)), unresolved: [] });
const changed = (files: string[]): Change & { base: string } => ({ files, deleted: [], base: 'main' });

test('validation by change runs the affected tests only and says the result covers that scope, not the application', async () => {
  const { steps, events } = fakeSteps({
    changedSet: async () => changed(['test/a.test.ts']),
    staticAnalysis: async () => [
      { name: 'depcruise', ms: 1, ok: true, check: 'boundaries', graph: graphOf({ 'test/a.test.ts': [], 'test/slow.test.ts': [], 'test/serial.test.ts': [] }) },
    ],
  });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 0, outcome.report);
  assert.deepEqual(
    events.filter(event => event.startsWith('run ')),
    ['run test/a.test.ts'],
  );
  assert.match(outcome.report, /mode: validation by change, policy 1\+sha256:[0-9a-f]{12}, base main/);
  assert.match(outcome.report, /ran integration-tests \[Integration tests\]: passed \(affected, 1 files\)/);
  assert.match(outcome.report, /not applicable unit-tests \[Unit tests\]/);
  assert.match(
    outcome.report,
    /periodic integral-pass \[Regression suite\]: left to integral validation \(30 3 \* \* \*\); last integral result: not recorded/,
  );
  assert.match(outcome.report, /RESULT: PASS \(validation by change: the 1 affected files only, not the whole application\)/);
});

test('a documentation-only change runs only the documentation checks and reports the rest as not applicable', async () => {
  const parts: string[] = [];
  const { steps, events } = fakeSteps({
    changedSet: async () => changed(['docs/x.md']),
    staticAnalysis: async (_tier, _signal, part) => {
      parts.push(part ?? 'all');
      return [{ name: 'guide-pointers', ms: 1, ok: true, check: 'guide-pointers' }];
    },
  });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 0, outcome.report);
  assert.deepEqual(parts, ['documentation']);
  assert.ok(!events.some(event => event.startsWith('run ')));
  assert.match(outcome.report, /not applicable types \[Types\]: no affected input/);
  assert.match(outcome.report, /ran guide-pointers \[Guide pointers\]: passed/);
});

test('required validation over the approved budget is inconclusive: non-zero, the unverified scope named, no test started', async () => {
  const { steps, events } = fakeSteps({ loadPolicy: async () => fixturePolicy({ budgetSeconds: 10 }) });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 3);
  assert.ok(!events.some(event => event.startsWith('run ')));
  assert.match(outcome.report, /INCONCLUSIVE: required validation is estimated at \d+ s, over the approved 10 s budget/);
  assert.match(outcome.report, /Decision needed/);
  assert.match(outcome.report, /RESULT: INCONCLUSIVE/);
});

test('a periodic check that failed in the last integral run blocks a change in its scope', async () => {
  const { steps } = fakeSteps({
    loadIntegral: async () => ({ policyVersion: 'v', commit: 'deadbeefcafe0', finishedAt: '2026-11-21T03:30:00Z', checks: { 'random-order': 'failed' } }),
  });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 1);
  assert.match(
    outcome.report,
    /FAILURE: periodic check random-order \(quality gate Regression suite\) failed in the last integral validation at deadbeefcafe0/,
  );
  assert.match(outcome.report, /last integral result: failed at deadbeefcafe on 2026-11-21T03:30:00Z — BLOCKS this change/);
});

test('a static finding is reported under its quality gate with its location', async () => {
  const { steps } = fakeSteps({
    staticAnalysis: async () => [
      { name: 'depcruise', ms: 1, ok: false, check: 'boundaries', findings: [{ rule: 'pure-rules-imports', location: 'src/control/rules/x.ts → node:fs' }] },
    ],
  });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.report, /FAILURE: quality gate Dependency rule \(boundaries\): pure-rules-imports at src\/control\/rules\/x\.ts → node:fs/);
});

test('integral validation runs every check even after one fails, and records each outcome for validation by change', async () => {
  const { steps, events, integrals } = fakeSteps({
    staticAnalysis: async () => [
      { name: 'tsc', ms: 1, ok: false, check: 'types', findings: [{ rule: 'TS2345', location: 'src/a.ts:1' }] },
      { name: 'eslint', ms: 1, ok: true, check: 'lint' },
    ],
  });
  const outcome = await runTier({ tier: 'full', filters: [], seed: 3 }, steps);
  assert.equal(outcome.exitCode, 1);
  assert.equal(events.filter(event => event.startsWith('run ')).length, 6, 'the tests and the random-order pass still ran');
  assert.deepEqual(
    integrals.map(record => [record.commit, record.checks]),
    [['abc', { types: 'failed', lint: 'passed', 'integral-pass': 'passed', 'random-order': 'passed', boundaries: 'not run', 'guide-pointers': 'not run' }]],
  );
  assert.match(outcome.report, /covered unit-tests \[Unit tests\]: by integral-pass/);
  assert.match(outcome.report, /covered integration-tests \[Integration tests\]: by integral-pass/);
  assert.match(outcome.report, /FAILURE: quality gate Types \(types\): TS2345 at src\/a\.ts:1/);
});

test('finding parsers: tsc lines, ESLint JSON with the pure-rules marker, the documentary checker JSON', () => {
  assert.deepEqual(tscFindings('src/a.ts(3,7): error TS2345: Argument of type'), [{ rule: 'TS2345', location: 'src/a.ts:3' }]);
  assert.deepEqual(
    eslintFindings(
      JSON.stringify([
        {
          filePath: '/r/src/control/rules/x.ts',
          messages: [
            { ruleId: 'no-restricted-syntax', message: 'Pure Control rules use injected data/time, not ambient clocks or I/O.', line: 4 },
            { ruleId: 'no-unused-vars', message: 'x', line: 5 },
          ],
        },
      ]),
      '/r',
    ),
    [
      { rule: 'no-restricted-syntax:pure-rules', location: 'src/control/rules/x.ts:4' },
      { rule: 'no-unused-vars', location: 'src/control/rules/x.ts:5' },
    ],
  );
  assert.equal(eslintFindings('not json', '/r'), undefined);
  assert.deepEqual(pointerFindings('{"ok": false, "findings": [{"code": "BROKEN_LINK", "path": "AGENTS.md", "target": "docs/x.md"}]}'), [
    { rule: 'BROKEN_LINK', location: 'AGENTS.md → docs/x.md' },
  ]);
});

const aUnit = { loadLevels: async () => (file: string) => (file === 'test/a.test.ts' ? ('unit' as const) : ('integration' as const)) };

test('fast runs the unit-level tests only; a filter (never a gate) may still reach any level', async () => {
  const unit = fakeSteps(aUnit);
  assert.equal((await runTier({ tier: 'fast', filters: [] }, unit.steps)).exitCode, 0);
  assert.deepEqual(
    unit.events.filter(event => event.startsWith('run ')),
    ['run test/a.test.ts'],
  );
  const filtered = fakeSteps(aUnit);
  await runTier({ tier: 'fast', filters: ['serial'] }, filtered.steps);
  assert.deepEqual(
    filtered.events.filter(event => event.startsWith('run ')),
    ['run test/serial.test.ts'],
  );
});

test("a failing test file is reported under the quality gate of its level; ci records each level's outcome", async () => {
  const { steps } = fakeSteps({ ...aUnit, runFile: async file => ({ file, ms: 1, ok: false, counts }) });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.report, /FAILURE: quality gate Unit tests \(unit-tests\): test\/a\.test\.ts failed/);
  assert.match(outcome.report, /FAILURE: quality gate Integration tests \(integration-tests\): test\/serial\.test\.ts failed/);
  assert.match(outcome.report, /ran unit-tests \[Unit tests\]: failed/);
  const integrationGreen = fakeSteps({ ...aUnit, runFile: async file => ({ file, ms: 1, ok: file !== 'test/a.test.ts', counts }) });
  const report = (await runTier({ tier: 'ci', filters: [] }, integrationGreen.steps)).report;
  assert.match(report, /ran unit-tests \[Unit tests\]: failed/);
  assert.match(report, /ran integration-tests \[Integration tests\]: passed/);
  assert.doesNotMatch(report, /quality gate Integration tests/);
});

test('an unreadable test/levels.json is a precondition failure, before lock or compile', async () => {
  const { steps, events } = fakeSteps({
    loadLevels: async () => {
      throw new Error('LEVELS_INVALID: test/levels.json needs schemaVersion 1');
    },
  });
  const outcome = await runTier({ tier: 'ci', filters: [] }, steps);
  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.report, /LEVELS_INVALID/);
  assert.deepEqual(events, ['deps', 'manifest']);
});
