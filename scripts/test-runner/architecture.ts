// dependency-cruiser's JSON result, read once: the violations its rules report and the import graph validation by
// change uses to find a change's dependents. Its JSON reporter exits zero even with violations, so the violations
// decide the step's outcome, never the exit code.
import type { Graph } from './selection.ts';

export interface Violation { rule: string; from: string; to: string }
interface CruiseModule {
  source: string;
  dependencies: { module?: string; resolved: string; couldNotResolve: boolean; coreModule: boolean; followable: boolean; dependencyTypes?: string[] }[];
}
interface Cruise { modules: CruiseModule[]; summary: { violations: { rule: { name: string }; from: string; to: string }[]; error: number } }

export function readCruise(output: string): { violations: Violation[]; graph: Graph } {
  const cruise = JSON.parse(output) as Cruise;
  if (!Array.isArray(cruise.modules) || !Array.isArray(cruise.summary?.violations)) throw new Error('not a dependency-cruiser JSON result');
  const edges = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const module of cruise.modules) {
    if (module.source.startsWith('node_modules/')) continue;
    const imports = module.dependencies.filter(dep => !dep.coreModule && !dep.couldNotResolve && !dep.resolved.startsWith('node_modules/'))
      .map(dep => dep.resolved);
    edges.set(module.source, [...new Set(imports)].sort());
    if (module.dependencies.some(dep => dep.couldNotResolve)) unresolved.push(module.source);
  }
  const violations = cruise.summary.violations.map(item => ({ rule: item.rule.name, from: item.from, to: item.to }));
  return { violations, graph: { edges, unresolved: unresolved.sort() } };
}

/** Node built-ins and packages through which a module performs I/O (the Unit tests level performs none). */
const ioBuiltin = /^(node:)?(fs|fs\/promises|child_process|net|http|https|http2|dgram|tls|worker_threads|cluster|sqlite|dns|readline|inspector)$/;
const ioPackage = /^node_modules\/@earendil-works\/(pi-durable|gondolin|chord|pi-coding-agent)\//;

/**
 * The declared unit tests that reach runtime I/O, directly or through a project module they load. Type-only imports load
 * nothing at runtime and do not count; an import the graph cannot resolve counts as I/O, since nothing shows it is pure.
 */
export function impureUnits(output: string, units: readonly string[]): { rule: string; location: string }[] {
  const cruise = JSON.parse(output) as Cruise;
  const modules = new Map(cruise.modules.map(module => [module.source, module]));
  const reason = new Map<string, string | null>();
  const leak = (file: string, trail: Set<string>): string | null => {
    if (reason.has(file)) return reason.get(file)!;
    const module = modules.get(file);
    if (!module || trail.has(file)) return null;
    trail.add(file);
    let found: string | null = null;
    for (const dep of module.dependencies.filter(item => !(item.dependencyTypes ?? []).includes('type-only'))) {
      const name = dep.module ?? dep.resolved;
      if (dep.couldNotResolve) found = `imports the unresolvable ${name}`;
      else if (dep.coreModule && ioBuiltin.test(name)) found = `imports ${name}`;
      else if (ioPackage.test(dep.resolved)) found = `imports ${dep.resolved.split('/').slice(1, 3).join('/')}`;
      else if (!dep.coreModule && !dep.resolved.startsWith('node_modules/')) {
        const inner = leak(dep.resolved, trail);
        if (inner) found = inner.includes(' → ') || /^(src|test)\//.test(inner) ? `${dep.resolved} → ${inner}` : `${dep.resolved} ${inner}`;
      }
      if (found) break;
    }
    reason.set(file, found);
    return found;
  };
  return units.flatMap(file => {
    if (!modules.has(file)) return [{ rule: 'unit-not-found', location: file }];
    const found = leak(file, new Set());
    if (!found) return [];
    return [{ rule: 'unit-performs-io', location: found.includes(' → ') || /^(src|test)\//.test(found) ? `${file} → ${found}` : `${file} ${found}` }];
  });
}
