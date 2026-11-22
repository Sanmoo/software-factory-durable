import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parsePolicy } from '../../scripts/test-runner/selection.ts';

const text = readFileSync('scripts/test-runner/policy.json', 'utf8');
const policy = parsePolicy(JSON.parse(text), text);
const gateFloor = ['Format', 'Lint', 'Types', 'Unit tests', 'Integration tests', 'E2E tests', 'Mutation', 'Context boundaries', 'Dependency rule',
  'Static metrics', 'Dependency vulnerabilities', 'Secrets', 'Avoided terms', 'Guide pointers'];

test('the versioned policy is valid and every finding is attributed to a quality gate of the Gate Floor (the periodic passes over both levels: the regression suite)', () => {
  for (const check of policy.checks) {
    for (const gate of [check.gate, ...Object.values(check.gateByRule ?? {})])
      assert.ok(gateFloor.includes(gate) || (gate === 'Regression suite' && check.cadence === 'periodic' && check.level === undefined), `${check.id}: ${gate}`);
  }
  const levels = policy.checks.filter(check => check.scope === 'affected-tests').map(check => [check.id, check.gate, check.level, check.tier]);
  assert.deepEqual(levels, [['unit-tests', 'Unit tests', 'unit', 'fast'], ['integration-tests', 'Integration tests', 'integration', 'full']]);
  assert.deepEqual(policy.core, ['src/control/**', 'src/workers/**'], 'the core contexts approved in the adoption interview');
});

/** `OnCalendar=*-*-* HH:MM:SS` as the cron `M H * * *` it fires on. */
function timerCron(unit: string): string {
  const match = /^OnCalendar=\*-\*-\* (\d{2}):(\d{2}):00$/m.exec(unit);
  assert.ok(match, 'the timer fires daily at a fixed minute');
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

test('every periodic check\'s recorded cadence is the schedule the versioned timer actually runs', () => {
  const schedule = timerCron(readFileSync('scripts/test-runner/systemd/software-factory-nightly-tests.timer', 'utf8'));
  const periodic = policy.checks.filter(check => check.cadence === 'periodic');
  assert.ok(periodic.length > 0);
  for (const check of periodic) assert.equal(check.cron, schedule, check.id);
  assert.match(readFileSync('scripts/test-runner/systemd/software-factory-nightly-tests.service', 'utf8'), /^Environment=SF_NIGHTLY_BRANCH=main$/m,
    'integral validation covers the integrated line');
  assert.match(readFileSync('scripts/test-runner/nightly', 'utf8'), /exec scripts\/test-runner\/run full /, 'the timer calls integral validation');
});
