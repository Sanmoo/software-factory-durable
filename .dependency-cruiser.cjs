// Static dependency analysis only; no application module is loaded by this gate.
const zones = ['contracts', 'protocol', 'records', 'platform/github', 'platform/host',
  'issue-tracker', 'code-repository', 'sandbox', 'workers', 'control'];

const allowed = {
  contracts: [], protocol: ['contracts'], records: ['contracts'],
  'platform/github': ['contracts', 'records'], 'platform/host': ['contracts', 'records'],
  'issue-tracker': ['contracts', 'records', 'platform/github'],
  'code-repository': ['contracts', 'records', 'platform/github'],
  sandbox: ['contracts', 'protocol', 'records', 'platform/host'],
  workers: ['contracts', 'protocol', 'records', 'platform/host', 'sandbox'],
  control: ['contracts', 'issue-tracker', 'code-repository', 'sandbox', 'workers', 'records'],
};

const classified = `^(src|test)/(${zones.join('|')})/|^src/entrypoints/(cli|setup|doctor|configuration|release|release-build)\\.ts$|^src/entrypoints/(controller|worker|adapter)(\\.ts$|/)|^test/(entrypoints|architecture)/|^(\\.dependency-cruiser\\.cjs|eslint\\.config\\.mjs)$`;

const compositions = {
  cli: ['contracts', 'protocol', 'records', 'sandbox', 'control', 'workers'],
  controller: zones,
  worker: ['contracts', 'workers', 'protocol', 'records'],
  adapter: ['contracts', 'sandbox', 'protocol', 'records'],
};
const entrypoint = role => role === 'cli' ? '^src/entrypoints/(cli|setup|doctor|configuration|release|release-build)\\.ts$'
  : `^src/entrypoints/${role}(\\.ts$|/)`;

module.exports = {
  forbidden: [
    { name: 'neutral-contracts', severity: 'error', from: { path: '^src/contracts/' }, to: { pathNot: '^src/contracts/' } },
    { name: 'pure-rules-imports', severity: 'error', from: { path: '^src/control/rules/' },
      to: { pathNot: '^src/(contracts/|control/(rules/|types\\.ts$))' } },
    ...Object.entries(compositions).map(([role, destinations]) => ({ name: `composition:${role}`, severity: 'error',
      from: { path: entrypoint(role) },
      to: { path: '^src/', pathNot: `^src/(${destinations.join('|')})/|${entrypoint(role)}${role === 'controller' ? '|^src/entrypoints/(configuration|release)\\.ts$' : ''}` } })),
    { name: 'cli-workers-setup-only', severity: 'error', from: { path: '^src/entrypoints/(cli|doctor|configuration|release|release-build)\\.ts$' },
      to: { path: '^src/workers/' } },
    { name: 'cli-control-types-only', severity: 'error', from: { path: entrypoint('cli') },
      to: { path: '^src/control/', dependencyTypesNot: ['type-only'] } },
    { name: 'control-contracts-only', severity: 'error',
      from: { path: '^src/control/' },
      to: { path: '^src/(issue-tracker|code-repository|sandbox|workers|records)/', dependencyTypesNot: ['type-only'] } },
    { name: 'worker-sandbox-types-only', severity: 'error', from: { path: '^src/workers/' },
      to: { path: '^src/sandbox/', dependencyTypesNot: ['type-only'] } },
    { name: 'classified-source', severity: 'error', from: { pathNot: classified, orphan: true }, to: {} },
    { name: 'classified-source-origin', severity: 'error', from: { pathNot: classified }, to: {} },
    { name: 'classified-source-target', severity: 'error', from: {}, to: { path: '^(?!node_modules/).+\\.(?:[cm]?[jt]s|[jt]sx)$', pathNot: classified } },
    ...[
      ['sqlite', '^src/control/durable/', '(^|/)(node:sqlite|sqlite3|better-sqlite3)(/|$)'],
      ['durable', '^src/control/durable/', '(^|/)@earendil-works/pi-durable(/|$)'],
      ['coding-agent', '^src/workers/', '(^|/)@(mariozechner|earendil-works)/pi-coding-agent(/|$)'],
      ['gondolin', '^src/sandbox/', '(^|/)(@earendil-works/)?gondolin(/|$)'],
      ['github', '^src/(platform/github|issue-tracker|code-repository)/', '(^|/)(@octokit/|octokit(/|$))'],
    ].map(([sdk, owner, dependency]) => ({ name: `sdk:${sdk}-owner`, severity: 'error',
      from: { pathNot: owner }, to: { path: dependency } })),
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    ...zones.map(zone => ({ name: `zone:${zone}`, severity: 'error',
      from: { path: `^(src|test)/${zone}/` },
      to: { path: '^src/', pathNot: `^src/(${[zone, ...allowed[zone]].join('|')})/` } })),
    ...zones.map(zone => ({ name: `public-entry:${zone}`, severity: 'error',
      from: { pathNot: `^(src|test)/${zone}/` },
      to: { path: `^src/${zone}/`, pathNot: `^src/${zone}/index\\.ts$` } })),
    { name: 'unresolved-import', severity: 'error', from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.git|\\.worktrees|\\.scratch)(/|$)' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'node', 'default'] },
  },
};
