// A small selection policy for runner tests: the static checks, the affected tests and the two periodic checks.
import { parsePolicy, type Policy } from '../../scripts/test-runner/selection.ts';

export function fixturePolicy(overrides: Record<string, unknown> = {}): Policy {
  const raw = {
    version: 1,
    budgetSeconds: 600,
    base: 'main',
    core: [],
    sharedConfiguration: ['package.json'],
    documentation: ['**/*.md'],
    runtimeDependents: { tests: [], on: [] },
    checks: [
      { id: 'types', gate: 'Types', tier: 'fast', appliesTo: ['src/**', 'test/**'], scope: 'whole', cadence: 'change', costSeconds: 1 },
      { id: 'lint', gate: 'Lint', tier: 'fast', appliesTo: ['src/**', 'test/**'], scope: 'whole', cadence: 'change', costSeconds: 1 },
      {
        id: 'boundaries',
        gate: 'Context boundaries',
        tier: 'fast',
        appliesTo: ['src/**', 'test/**'],
        scope: 'whole',
        cadence: 'change',
        costSeconds: 1,
        gateByRule: { 'pure-rules-imports': 'Dependency rule' },
      },
      { id: 'guide-pointers', gate: 'Guide pointers', tier: 'fast', appliesTo: ['**'], scope: 'whole', cadence: 'change', costSeconds: 1 },
      {
        id: 'tests',
        gate: 'Regression suite',
        tier: 'full',
        appliesTo: ['src/**', 'test/**'],
        scope: 'affected-tests',
        cadence: 'change',
        costSeconds: 30,
        coveredBy: 'integral-pass',
      },
      {
        id: 'integral-pass',
        gate: 'Regression suite',
        tier: 'full',
        appliesTo: ['src/**', 'test/**'],
        scope: 'whole',
        cadence: 'periodic',
        cron: '30 3 * * *',
        protectionBetweenRuns: 'p',
        residualRisk: 'r',
        costSeconds: 100,
      },
      {
        id: 'random-order',
        gate: 'Regression suite',
        tier: 'full',
        appliesTo: ['src/**', 'test/**'],
        scope: 'whole',
        cadence: 'periodic',
        cron: '30 3 * * *',
        protectionBetweenRuns: 'p',
        residualRisk: 'r',
        costSeconds: 100,
      },
    ],
    ...overrides,
  };
  return parsePolicy(raw, JSON.stringify(raw));
}
