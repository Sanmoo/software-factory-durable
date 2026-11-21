import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attribute, failingGates } from '../../scripts/test-runner/proof-attribution.ts';

const report = (...failures: string[]) => [...failures.map(line => `FAILURE: ${line}`), failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'].join('\n');

test("a red run is a proof only for the gate it names, at the violation's location", () => {
  const run = { exitCode: 1, report: report('quality gate Dependency rule (boundaries): pure-rules-imports at src/control/rules/budget.ts → node:fs') };
  assert.deepEqual(attribute(run, 'Dependency rule', 'src/control/rules/budget.ts').proved, true);
  assert.match(attribute(run, 'Context boundaries', 'src/control/rules/budget.ts').reason, /are Dependency rule, not only Context boundaries/);
  assert.match(attribute(run, 'Dependency rule', 'src/other.ts').reason, /not at the violation's location/);
});

test('another failing gate, an unattributed failure, a green run or a crash proves nothing', () => {
  const two = { exitCode: 1, report: report('quality gate Types (types): TS2345 at src/a.ts:1', 'quality gate Lint (lint): x at src/a.ts:2') };
  assert.equal(attribute(two, 'Types', 'src/a.ts').proved, false);
  const test = { exitCode: 1, report: report('test/a.test.ts failed') };
  assert.deepEqual(failingGates(test.report), ['unattributed']);
  assert.equal(attribute(test, 'Types', 'src/a.ts').proved, false);
  assert.match(attribute({ exitCode: 0, report: report() }, 'Types', 'src/a.ts').reason, /stayed green/);
  assert.match(attribute({ exitCode: 2, report: 'DEPENDENCIES_MISMATCH: run npm ci' }, 'Types', 'src/a.ts').reason, /did not complete a report/);
  assert.match(attribute({ exitCode: null, report: '' }, 'Types', 'src/a.ts').reason, /did not complete a report/);
});
