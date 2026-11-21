import assert from 'node:assert/strict';
import { test } from 'node:test';
import { impureUnits, readCruise } from '../../scripts/test-runner/architecture.ts';
import { gateOf, parsePolicy } from '../../scripts/test-runner/selection.ts';

const dep = (resolved: string, extra: Record<string, boolean> = {}) => ({ resolved, couldNotResolve: false, coreModule: false, followable: true, ...extra });

test('the graph keeps project modules and their project imports; unresolvable imports are recorded, not dropped', () => {
  const { graph, violations } = readCruise(
    JSON.stringify({
      modules: [
        { source: 'src/a.ts', dependencies: [dep('src/b.ts'), dep('node:fs', { coreModule: true }), dep('node_modules/yaml/dist/index.js')] },
        { source: 'src/b.ts', dependencies: [dep('#factory-pi', { couldNotResolve: true })] },
        { source: 'node_modules/yaml/dist/index.js', dependencies: [] },
      ],
      summary: { violations: [{ rule: { name: 'zone:records' }, from: 'src/records/x.ts', to: 'src/control/y.ts' }], error: 1 },
    }),
  );
  assert.deepEqual(
    [...graph.edges],
    [
      ['src/a.ts', ['src/b.ts']],
      ['src/b.ts', []],
    ],
  );
  assert.deepEqual(graph.unresolved, ['src/b.ts']);
  assert.deepEqual(violations, [{ rule: 'zone:records', from: 'src/records/x.ts', to: 'src/control/y.ts' }]);
});

test('a non-cruise document is refused rather than read as an empty graph', () => {
  assert.throws(() => readCruise('{"modules": "x"}'), /not a dependency-cruiser JSON result/);
});

test('findings are attributed to their quality gate by rule prefix, longest prefix first', () => {
  const policy = parsePolicy(
    {
      version: 1,
      budgetSeconds: 1,
      base: 'main',
      core: [],
      sharedConfiguration: [],
      documentation: [],
      runtimeDependents: { tests: [], on: [] },
      checks: [
        {
          id: 'boundaries',
          gate: 'Context boundaries',
          tier: 'fast',
          appliesTo: ['**'],
          scope: 'whole',
          cadence: 'change',
          costSeconds: 1,
          gateByRule: { 'pure-rules': 'Dependency rule', 'no-cycles': 'Static metrics' },
        },
      ],
    },
    '',
  );
  const check = policy.checks[0]!;
  assert.equal(gateOf(check, 'pure-rules-imports'), 'Dependency rule');
  assert.equal(gateOf(check, 'no-cycles'), 'Static metrics');
  assert.equal(gateOf(check, 'zone:control'), 'Context boundaries');
});

test('a declared unit test may reach no runtime I/O: direct or transitive, type-only imports excepted', () => {
  const io = (module: string) => ({ module, resolved: module, couldNotResolve: false, coreModule: true, followable: false, dependencyTypes: ['core'] });
  const local = (resolved: string, types = ['local', 'import']) => ({ ...dep(resolved), module: resolved, dependencyTypes: types });
  const output = JSON.stringify({
    modules: [
      { source: 'test/pure.test.ts', dependencies: [local('src/rules.ts'), local('src/store.ts', ['local', 'type-only'])] },
      { source: 'test/leaky.test.ts', dependencies: [local('src/rules.ts'), local('src/store.ts')] },
      { source: 'test/direct.test.ts', dependencies: [io('node:child_process')] },
      { source: 'src/rules.ts', dependencies: [] },
      { source: 'src/store.ts', dependencies: [io('node:fs')] },
    ],
    summary: { violations: [], error: 0 },
  });
  assert.deepEqual(impureUnits(output, ['test/pure.test.ts', 'test/leaky.test.ts', 'test/direct.test.ts', 'test/missing.test.ts']), [
    { rule: 'unit-performs-io', location: 'test/leaky.test.ts → src/store.ts imports node:fs' },
    { rule: 'unit-performs-io', location: 'test/direct.test.ts imports node:child_process' },
    { rule: 'unit-not-found', location: 'test/missing.test.ts' },
  ]);
});
