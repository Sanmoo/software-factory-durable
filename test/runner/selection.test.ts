import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dependents,
  estimatedSeconds,
  matchesAny,
  parsePolicy,
  planValidation,
  type Change,
  type Graph,
  type IntegralRecord,
  type Policy,
} from '../../scripts/test-runner/selection.ts';

const policy: Policy = parsePolicy(
  {
    version: 1,
    budgetSeconds: 100,
    base: 'main',
    core: ['src/control'],
    sharedConfiguration: ['package.json', 'tsconfig.json', 'scripts/test-runner/**'],
    documentation: ['**/*.md'],
    runtimeDependents: { tests: ['test/entrypoints/**'], on: ['src/**'] },
    checks: [
      { id: 'types', gate: 'Types', tier: 'fast', appliesTo: ['**/*.ts'], scope: 'whole', cadence: 'change', costSeconds: 10 },
      { id: 'pointers', gate: 'Guide pointers', tier: 'fast', appliesTo: ['**'], scope: 'whole', cadence: 'change', costSeconds: 1 },
      { id: 'tests', gate: 'Tests', tier: 'full', appliesTo: ['src/**', 'test/**'], scope: 'affected-tests', cadence: 'change', costSeconds: 60 },
      {
        id: 'random-order',
        gate: 'Tests',
        tier: 'full',
        appliesTo: ['src/**', 'test/**'],
        scope: 'whole',
        cadence: 'periodic',
        cron: '30 3 * * *',
        protectionBetweenRuns: 'p',
        residualRisk: 'r',
        costSeconds: 200,
      },
    ],
  },
  'policy text',
);

const graph = (edges: Record<string, string[]>): Graph => ({ edges: new Map(Object.entries(edges)), unresolved: [] });
const g = graph({
  'src/control/rules/a.ts': [],
  'src/control/b.ts': ['src/control/rules/a.ts'],
  'test/control/b.test.ts': ['src/control/b.ts'],
  'test/other.test.ts': [],
  'test/entrypoints/cli.test.ts': [],
});
const change = (files: string[], deleted: string[] = []): Change => ({ files, deleted });
const tests = ['test/control/b.test.ts', 'test/other.test.ts', 'test/entrypoints/cli.test.ts'];

test('globs: ** spans directories, * stays within one', () => {
  assert.ok(matchesAny('src/control/rules/a.ts', ['src/**']));
  assert.ok(matchesAny('README.md', ['**/*.md']));
  assert.ok(!matchesAny('src/control/a.ts', ['src/*.ts']));
});

test('dependents are transitive over the reverse graph', () => {
  assert.deepEqual(dependents(['src/control/rules/a.ts'], g.edges), ['src/control/b.ts', 'test/control/b.test.ts']);
});

test('a change selects its dependents without widening, plus runtime dependents, and nothing else', () => {
  const plan = planValidation('change', policy, change(['src/control/rules/a.ts']), g, tests, undefined);
  assert.equal(plan.widened, undefined);
  const run = plan.entries.find(entry => entry.check.id === 'tests');
  assert.deepEqual(run?.decision === 'run' && run.files, ['test/control/b.test.ts', 'test/entrypoints/cli.test.ts']);
});

test('a documentation-only change makes code checks not applicable but keeps Guide pointers', () => {
  const plan = planValidation('change', policy, change(['docs/guide.md']), g, tests, undefined);
  assert.equal(plan.widened, undefined);
  assert.deepEqual(
    plan.entries.map(entry => [entry.check.id, entry.decision]),
    [
      ['types', 'not-applicable'],
      ['pointers', 'run'],
      ['tests', 'not-applicable'],
      ['random-order', 'periodic'],
    ],
  );
});

test('shared configuration widens every check to its whole input, but a periodic check stays periodic', () => {
  const plan = planValidation('change', policy, change(['tsconfig.json']), g, tests, undefined);
  assert.match(plan.widened ?? '', /shared configuration changed: tsconfig.json/);
  const run = plan.entries.find(entry => entry.check.id === 'tests');
  assert.deepEqual(run?.decision === 'run' && run.files, [...tests].sort());
  assert.equal(plan.entries.find(entry => entry.check.id === 'random-order')?.decision, 'periodic');
});

test('missing impact information widens: unplaced file, unresolved import, deleted module, unknown base', () => {
  assert.match(planValidation('change', policy, change(['src/sandbox/guest.sh']), g, tests, undefined).widened ?? '', /cannot place src\/sandbox\/guest.sh/);
  assert.match(
    planValidation('change', policy, change(['src/control/b.ts']), { ...g, unresolved: ['src/control/b.ts'] }, tests, undefined).widened ?? '',
    /cannot place an import/,
  );
  assert.match(planValidation('change', policy, change(['src/control/gone.ts'], ['src/control/gone.ts']), g, tests, undefined).widened ?? '', /deleted/);
  assert.match(planValidation('change', policy, { widened: 'base main does not resolve' }, g, tests, undefined).widened ?? '', /base main does not resolve/);
  assert.match(planValidation('change', policy, change(['src/control/b.ts']), undefined, tests, undefined).widened ?? '', /graph could not be built/);
});

test('a deleted file is never handed to a check, while its dependents still run', () => {
  const plan = planValidation(
    'change',
    policy,
    change(['test/other.test.ts'], ['test/other.test.ts']),
    g,
    tests.filter(t => t !== 'test/other.test.ts'),
    undefined,
  );
  const run = plan.entries.find(entry => entry.check.id === 'tests');
  assert.ok(run?.decision === 'not-applicable' || (run?.decision === 'run' && !run.files.includes('test/other.test.ts')));
});

test('integral validation runs every check, periodic ones included, over the whole input', () => {
  const plan = planValidation('integral', policy, change([]), g, tests, undefined);
  assert.ok(plan.entries.every(entry => entry.decision === 'run'));
  const run = plan.entries.find(entry => entry.check.id === 'tests');
  assert.deepEqual(run?.decision === 'run' && run.files, [...tests].sort());
});

test('a failed periodic check blocks a change that verifies files in its scope, and reports its last result', () => {
  const integral: IntegralRecord = { policyVersion: 'v', commit: 'c', finishedAt: 't', checks: { 'random-order': 'failed' } };
  const blocked = planValidation('change', policy, change(['src/control/rules/a.ts']), g, tests, integral);
  const entry = blocked.entries.find(item => item.check.id === 'random-order');
  assert.ok(entry?.decision === 'periodic' && entry.blocking && entry.last.outcome === 'failed');
  const independent = planValidation('change', policy, change(['docs/guide.md']), g, tests, integral);
  const other = independent.entries.find(item => item.check.id === 'random-order');
  assert.ok(other?.decision === 'periodic' && !other.blocking && other.last.outcome === 'failed');
});

test('estimated cost scales an affected-tests check by the share of tests it selects; over budget is reported', () => {
  const plan = planValidation('change', policy, change(['src/control/rules/a.ts']), g, tests, undefined);
  assert.equal(estimatedSeconds(plan, tests), 10 + 1 + (60 * 2) / 3);
  const wide = planValidation('change', { ...policy, budgetSeconds: 50 }, change(['package.json']), g, tests, undefined);
  assert.ok(estimatedSeconds(wide, tests) > 50);
});

test('equivalent changes under the same policy give the same plan; the plan records the policy version', () => {
  const a = planValidation('change', policy, change(['src/control/rules/a.ts', 'docs/x.md']), g, tests, undefined);
  const b = planValidation('change', policy, change(['docs/x.md', 'src/control/rules/a.ts']), g, tests, undefined);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  assert.match(a.policyVersion, /^1\+sha256:[0-9a-f]{12}$/);
});

test('the policy is validated: unknown keys, a periodic check without cron or risk, or a missing gate fail', () => {
  assert.throws(() => parsePolicy({ ...JSON.parse(JSON.stringify(policy.raw)), extra: 1 }, 'x'), /unknown top-level key "extra"/);
  const periodic = JSON.parse(JSON.stringify(policy.raw));
  delete periodic.checks[3].cron;
  assert.throws(() => parsePolicy(periodic, 'x'), /random-order: a periodic check needs cron, protectionBetweenRuns and residualRisk/);
  const gateless = JSON.parse(JSON.stringify(policy.raw));
  delete gateless.checks[0].gate;
  assert.throws(() => parsePolicy(gateless, 'x'), /types: needs gate/);
});

test('a level-bound tests check selects only the affected tests of its level', () => {
  const raw = JSON.parse(JSON.stringify(policy.raw));
  raw.checks.splice(
    2,
    1,
    {
      id: 'unit-tests',
      gate: 'Unit tests',
      tier: 'fast',
      level: 'unit',
      appliesTo: ['src/**', 'test/**'],
      scope: 'affected-tests',
      cadence: 'change',
      costSeconds: 6,
    },
    {
      id: 'integration-tests',
      gate: 'Integration tests',
      tier: 'full',
      level: 'integration',
      appliesTo: ['src/**', 'test/**'],
      scope: 'affected-tests',
      cadence: 'change',
      costSeconds: 60,
    },
  );
  const leveled = parsePolicy(raw, 'x');
  const levelOf = (file: string) => (file === 'test/control/b.test.ts' ? 'unit' : 'integration');
  const plan = planValidation('change', leveled, change(['src/control/rules/a.ts']), g, tests, undefined, levelOf);
  const files = (id: string) => {
    const entry = plan.entries.find(item => item.check.id === id);
    return entry?.decision === 'run' ? entry.files : entry?.decision;
  };
  assert.deepEqual(files('unit-tests'), ['test/control/b.test.ts']);
  assert.deepEqual(files('integration-tests'), ['test/entrypoints/cli.test.ts']);
  assert.throws(() => parsePolicy({ ...raw, checks: [{ ...raw.checks[2], level: 'e2e' }] }, 'x'), /level must be unit or integration/);
});
