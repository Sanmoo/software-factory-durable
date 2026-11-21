// dependency-cruiser's JSON result, read once: the violations its rules report and the import graph validation by
// change uses to find a change's dependents. Its JSON reporter exits zero even with violations, so the violations
// decide the step's outcome, never the exit code.
import type { Graph } from './selection.ts';

export interface Violation {
  rule: string;
  from: string;
  to: string;
}
interface CruiseModule {
  source: string;
  dependencies: { resolved: string; couldNotResolve: boolean; coreModule: boolean; followable: boolean }[];
}
interface Cruise {
  modules: CruiseModule[];
  summary: { violations: { rule: { name: string }; from: string; to: string }[]; error: number };
}

export function readCruise(output: string): { violations: Violation[]; graph: Graph } {
  const cruise = JSON.parse(output) as Cruise;
  if (!Array.isArray(cruise.modules) || !Array.isArray(cruise.summary?.violations)) throw new Error('not a dependency-cruiser JSON result');
  const edges = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const module of cruise.modules) {
    if (module.source.startsWith('node_modules/')) continue;
    const imports = module.dependencies
      .filter(dep => !dep.coreModule && !dep.couldNotResolve && !dep.resolved.startsWith('node_modules/'))
      .map(dep => dep.resolved);
    edges.set(module.source, [...new Set(imports)].sort());
    if (module.dependencies.some(dep => dep.couldNotResolve)) unresolved.push(module.source);
  }
  const violations = cruise.summary.violations.map(item => ({ rule: item.rule.name, from: item.from, to: item.to }));
  return { violations, graph: { edges, unresolved: unresolved.sort() } };
}
