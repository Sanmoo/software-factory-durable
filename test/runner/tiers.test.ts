import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetExceeded, budgetsMs, concurrencyFor, formatReport, parseManifest, planLanes, shuffle, type RunSummary } from '../../scripts/test-runner/lib.ts';

const present = (...files: string[]) => (file: string) => files.includes(file);

test('manifest lists only exceptions: slow and/or serial with a justification, quarantine with a ticket', () => {
  const manifest = parseManifest({ schemaVersion: 1, files: {
    'test/a/slow.test.ts': { slow: true, reason: 'builds a release' },
    'test/a/both.test.ts': { slow: true, serial: true, reason: 'mutates shared staging' },
    'test/a/flaky.test.ts': { quarantine: 'ticket 99', reason: 'races on load' },
  } }, present('test/a/slow.test.ts', 'test/a/both.test.ts', 'test/a/flaky.test.ts'));
  assert.deepEqual(manifest.get('test/a/slow.test.ts'), { slow: true, serial: false, full: false, reason: 'builds a release' });
  assert.deepEqual(manifest.get('test/a/both.test.ts'), { slow: true, serial: true, full: false, reason: 'mutates shared staging' });
  assert.deepEqual(manifest.get('test/a/flaky.test.ts'), { slow: false, serial: false, full: false, quarantine: 'ticket 99', reason: 'races on load' });
  assert.equal(manifest.get('test/a/unlisted.test.ts'), undefined);
});

test('manifest refuses a missing file, an entry without a flag or reason, unknown keys and non-test paths', () => {
  const problems = (value: unknown, exists = present('test/ok.test.ts')) => {
    try { parseManifest(value, exists); } catch (error) { return (error as Error).message; }
    return 'accepted';
  };
  assert.match(problems({ schemaVersion: 1, files: { 'test/gone.test.ts': { slow: true, reason: 'x' } } }),
    /TIERS_MANIFEST_INVALID[\s\S]*test\/gone\.test\.ts: listed file does not exist/);
  assert.match(problems({ schemaVersion: 1, files: { 'test/ok.test.ts': { reason: 'x' } } }), /needs slow, serial, full or quarantine/);
  assert.match(problems({ schemaVersion: 1, files: { 'test/ok.test.ts': { slow: true } } }), /needs a non-empty reason/);
  assert.match(problems({ schemaVersion: 1, files: { 'test/ok.test.ts': { slow: true, reason: 'x', fast: true } } }), /unknown key "fast"/);
  assert.match(problems({ schemaVersion: 1, files: { 'test/ok.test.ts': { slow: false, reason: 'x' } } }), /slow must be true when present/);
  assert.match(problems({ schemaVersion: 1, files: { 'src/x.ts': { slow: true, reason: 'x' } } }), /not a test\/\*\*\/\*\.test\.ts path/);
  assert.match(problems({ schemaVersion: 1, files: { 'test/ok.test.ts': { full: false, reason: 'x' } } }), /full must be true when present/);
  assert.match(problems({ schemaVersion: 2, files: {} }), /schemaVersion must be 1/);
  assert.match(problems([]), /must be an object/);
});

test('lanes: fast excludes slow, ci includes everything, serial runs after, quarantine never runs', () => {
  const manifest = parseManifest({ schemaVersion: 1, files: {
    'test/slow.test.ts': { slow: true, reason: 'r' },
    'test/serial.test.ts': { serial: true, reason: 'r' },
    'test/slow-serial.test.ts': { slow: true, serial: true, reason: 'r' },
    'test/flaky.test.ts': { quarantine: 'ticket 1', reason: 'r' },
  } }, () => true);
  const files = ['test/b.test.ts', 'test/a.test.ts', 'test/slow.test.ts', 'test/serial.test.ts', 'test/slow-serial.test.ts', 'test/flaky.test.ts'];
  const fast = planLanes('fast', files, manifest, 8, {});
  assert.deepEqual(fast.parallel, ['test/a.test.ts', 'test/b.test.ts']);
  assert.deepEqual(fast.serial, ['test/serial.test.ts']);
  assert.equal(fast.concurrency, 4);
  assert.deepEqual(fast.skippedSlow, ['test/slow-serial.test.ts', 'test/slow.test.ts']);
  assert.deepEqual(fast.quarantined, ['test/flaky.test.ts']);
  const ci = planLanes('ci', files, manifest, 8, {});
  assert.deepEqual(ci.parallel, ['test/slow.test.ts', 'test/a.test.ts', 'test/b.test.ts'], 'slow first when no timing is known');
  assert.deepEqual(ci.serial, ['test/serial.test.ts', 'test/slow-serial.test.ts']);
  assert.equal(ci.concurrency, 8);
  assert.deepEqual(ci.skippedSlow, []);
  assert.deepEqual(planLanes('full', files, manifest, 8, {}).parallel, ci.parallel);
  assert.deepEqual(planLanes('ci', files, manifest, 8, { 'test/b.test.ts': 30, 'test/a.test.ts': 2, 'test/slow.test.ts': 9 }).parallel,
    ['test/b.test.ts', 'test/slow.test.ts', 'test/a.test.ts'], 'longest known first');
});

test('lanes: a full-only file runs only in full (both passes), never in fast or ci, and the report names it', () => {
  const manifest = parseManifest({ schemaVersion: 1, files: {
    'test/nightly.test.ts': { full: true, reason: 'r' },
    'test/nightly-serial.test.ts': { full: true, serial: true, reason: 'r' },
  } }, () => true);
  const files = ['test/a.test.ts', 'test/nightly.test.ts', 'test/nightly-serial.test.ts'];
  for (const tier of ['fast', 'ci'] as const) {
    const plan = planLanes(tier, files, manifest, 8, {});
    assert.deepEqual([plan.parallel, plan.serial], [['test/a.test.ts'], []], tier);
    assert.deepEqual(plan.skippedFull, ['test/nightly-serial.test.ts', 'test/nightly.test.ts'], tier);
  }
  const full = planLanes('full', files, manifest, 8, {});
  assert.deepEqual([full.parallel.sort(), full.serial, full.skippedFull], [['test/a.test.ts', 'test/nightly.test.ts'], ['test/nightly-serial.test.ts'], []]);
  const report = formatReport({ tier: 'ci', lockWaitMs: 0, totalMs: 1, budgetMs: 600_000, load: { start: [0], end: [0] }, static: [], lanes: [],
    quarantined: [], skippedSlow: [], skippedFull: ['test/nightly.test.ts'], filtered: false, failures: [] });
  assert.match(report, /full only, left to the nightly: test\/nightly\.test\.ts/);
});

test('concurrency: fast uses at most half the cores, ci/full all of them, never zero', () => {
  assert.equal(concurrencyFor('fast', 8), 4);
  assert.equal(concurrencyFor('fast', 1), 1);
  assert.equal(concurrencyFor('fast', 3), 1);
  assert.equal(concurrencyFor('ci', 8), 8);
  assert.equal(concurrencyFor('full', 8), 8);
});

test('budgets are fixed per tier and the overrun message is explicit; full has no ceiling', () => {
  assert.equal(budgetsMs.fast, 180_000);
  assert.equal(budgetsMs.ci, undefined, 'validation by change takes the approved budget from scripts/test-runner/policy.json');
  assert.equal(budgetsMs.full, undefined);
  assert.equal(budgetExceeded('ci', 599_999, 600_000), undefined);
  assert.match(budgetExceeded('ci', 600_001, 600_000) ?? '', /^BUDGET_EXCEEDED: tier ci took 600\.0 s, over its 600 s ceiling .*test\/tiers\.json/);
  assert.equal(budgetExceeded('full', 10 ** 9, undefined), undefined);
});

test('shuffle is a seeded permutation, reproducible from the reported seed', () => {
  const files = Array.from({ length: 20 }, (_, i) => `test/f${i}.test.ts`);
  const once = shuffle(files, 42);
  assert.deepEqual(shuffle(files, 42), once);
  assert.notDeepEqual(once, files);
  assert.deepEqual([...once].sort(), [...files].sort());
  assert.notDeepEqual(shuffle(files, 43), once);
});

test('report carries static, per-lane, lock-wait timings and the 10 slowest files', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ file: `test/f${i}.test.ts`, ms: (i + 1) * 1000, ok: i !== 3,
    counts: { tests: 2, pass: i === 3 ? 1 : 2, fail: i === 3 ? 1 : 0, cancelled: 0, skipped: 0, todo: 0 } }));
  const summary: RunSummary = { tier: 'ci', lockWaitMs: 12_300, totalMs: 200_000, budgetMs: 600_000,
    load: { start: [1, 2, 3], end: [4, 5, 6] }, static: [{ name: 'tsc', ms: 9000, ok: true }, { name: 'eslint', ms: 4500, ok: true }],
    lanes: [{ name: 'parallel', concurrency: 8, ms: 150_000, files: files.slice(0, 11) }, { name: 'serial', concurrency: 1, ms: 12_000, files: files.slice(11) }],
    quarantined: ['test/q.test.ts'], skippedSlow: [], filtered: false, failures: ['test/f3.test.ts failed'] };
  const report = formatReport(summary);
  assert.match(report, /lock wait: 12\.3 s \(not counted in the budget\)/);
  assert.match(report, /static: tsc 9\.0 s, eslint 4\.5 s/);
  assert.match(report, /lane parallel: 11 files, N=8, 150\.0 s/);
  assert.match(report, /lane serial: 1 files, N=1, 12\.0 s/);
  assert.match(report, /tests: 24 \(pass 23, fail 1, cancelled 0, skipped 0, todo 0\)/);
  assert.match(report, /total: 200\.0 s of 600 s budget/);
  assert.match(report, /load average: start 1\.00 2\.00 3\.00, end 4\.00 5\.00 6\.00/);
  assert.match(report, /quarantined \(not coverage\): test\/q\.test\.ts/);
  const slowest = report.split('\n').filter(line => /^\s+\d+\. /.test(line));
  assert.equal(slowest.length, 10);
  assert.match(slowest[0]!, /1\. 12\.0 s test\/f11\.test\.ts/);
  assert.match(report, /RESULT: FAIL/);
  assert.match(formatReport({ ...summary, failures: [] }), /RESULT: PASS/);
  assert.match(formatReport({ ...summary, failures: [], filtered: true }), /RESULT: PASS \(filtered run: convenience only, never a gate\)/);
});
