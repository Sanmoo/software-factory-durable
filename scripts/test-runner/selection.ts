// Selection policy of the full Entry Point: which checks run, over which scope, in each mode.
// Pure functions of the policy, the change, the dependency graph and the test list, so equivalent changes under the
// same policy select the same checks over the same scopes. Runs under Node type stripping: erasable syntax only.
import { createHash } from 'node:crypto';

export type Mode = 'change' | 'integral';
export type Scope = 'whole' | 'affected-tests' | 'changed';
export interface Check {
  id: string;
  gate: string;
  tier: 'fast' | 'full';
  appliesTo: string[];
  scope: Scope;
  cadence: 'change' | 'periodic';
  costSeconds: number;
  cron?: string;
  protectionBetweenRuns?: string;
  residualRisk?: string;
  /** The quality gate a finding belongs to, by the reporting rule's name prefix; `gate` otherwise. */
  gateByRule?: Record<string, string>;
  /** Under integral validation this check is not run separately: the named periodic check runs its whole input. */
  coveredBy?: string;
  /** An affected-tests check bound to one test level (test/levels.json). */
  level?: Level;
}
/** The test level of a file: unit when test/levels.json declares it, integration otherwise. */
export type Level = 'unit' | 'integration';
export interface Policy {
  version: number;
  budgetSeconds: number;
  base: string;
  core: string[];
  sharedConfiguration: string[];
  documentation: string[];
  runtimeDependents: { tests: string[]; on: string[] };
  checks: Check[];
  policyVersion: string;
  raw: unknown;
}
/** Files changed relative to the base, or why the change set cannot be established. */
export type Change = { files: string[]; deleted: string[]; widened?: undefined } | { widened: string; files?: undefined; deleted?: undefined };
/** Module → the modules it imports; `unresolved` holds modules with an import the graph cannot place. */
export interface Graph {
  edges: ReadonlyMap<string, readonly string[]>;
  unresolved: readonly string[];
}
export interface IntegralRecord {
  policyVersion: string;
  commit: string;
  finishedAt: string;
  checks: Record<string, 'passed' | 'failed' | 'not run'>;
}
export interface LastIntegral {
  outcome: 'passed' | 'failed' | 'not run' | 'not recorded';
  at?: string;
  commit?: string;
  policyVersion?: string;
}
export type Entry =
  | { check: Check; decision: 'run'; scope: 'whole' | 'affected' | 'changed'; files: string[] }
  | { check: Check; decision: 'not-applicable' }
  | { check: Check; decision: 'periodic'; last: LastIntegral; blocking: boolean }
  | { check: Check; decision: 'covered'; by: string };
export interface ValidationPlan {
  mode: Mode;
  policyVersion: string;
  widened: string | undefined;
  affected: string[] | undefined;
  entries: Entry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const topKeys = new Set(['$comment', 'version', 'budgetSeconds', 'base', 'core', 'sharedConfiguration', 'documentation', 'runtimeDependents', 'checks']);
const checkKeys = new Set([
  'id',
  'gate',
  'tier',
  'appliesTo',
  'scope',
  'cadence',
  'costSeconds',
  'cron',
  'protectionBetweenRuns',
  'residualRisk',
  'gateByRule',
  'coveredBy',
  'level',
  '$comment',
]);

export function parsePolicy(value: unknown, text: string): Policy {
  const problems: string[] = [];
  if (!isRecord(value)) throw new Error('POLICY_INVALID: scripts/test-runner/policy.json\n  must be an object');
  for (const key of Object.keys(value)) if (!topKeys.has(key)) problems.push(`unknown top-level key "${key}"`);
  if (!Number.isInteger(value.version)) problems.push('version must be an integer');
  if (typeof value.budgetSeconds !== 'number' || value.budgetSeconds <= 0) problems.push('budgetSeconds must be positive');
  if (typeof value.base !== 'string' || !value.base) problems.push('base must name a branch');
  for (const key of ['core', 'sharedConfiguration', 'documentation'] as const) if (!strings(value[key])) problems.push(`${key} must be a list of globs`);
  const runtime = value.runtimeDependents;
  if (!isRecord(runtime) || !strings(runtime.tests) || !strings(runtime.on)) problems.push('runtimeDependents needs tests and on globs');
  const ids = new Set<string>();
  if (!Array.isArray(value.checks) || !value.checks.length) problems.push('checks must be a non-empty list');
  else
    for (const raw of value.checks as unknown[]) {
      if (!isRecord(raw) || typeof raw.id !== 'string') {
        problems.push('every check needs an id');
        continue;
      }
      const at = (message: string) => problems.push(`${raw.id as string}: ${message}`);
      if (ids.has(raw.id)) at('duplicate id');
      ids.add(raw.id);
      for (const key of Object.keys(raw)) if (!checkKeys.has(key)) at(`unknown key "${key}"`);
      if (typeof raw.gate !== 'string' || !raw.gate) at('needs gate');
      if (raw.tier !== 'fast' && raw.tier !== 'full') at('tier must be fast or full');
      if (!strings(raw.appliesTo) || !(raw.appliesTo as string[]).length) at('needs appliesTo globs');
      if (!['whole', 'affected-tests', 'changed'].includes(raw.scope as string)) at('scope must be whole, affected-tests or changed');
      if (raw.cadence !== 'change' && raw.cadence !== 'periodic') at('cadence must be change or periodic');
      if (typeof raw.costSeconds !== 'number' || raw.costSeconds < 0) at('needs costSeconds');
      if (raw.cadence === 'periodic' && [raw.cron, raw.protectionBetweenRuns, raw.residualRisk].some(item => typeof item !== 'string' || !item))
        at('a periodic check needs cron, protectionBetweenRuns and residualRisk');
      if ('level' in raw && raw.level !== 'unit' && raw.level !== 'integration') at('level must be unit or integration');
      if ('gateByRule' in raw && (!isRecord(raw.gateByRule) || !Object.values(raw.gateByRule).every(item => typeof item === 'string')))
        at('gateByRule maps rule prefixes to gates');
    }
  if (Array.isArray(value.checks))
    for (const raw of value.checks as Record<string, unknown>[])
      if (
        isRecord(raw) &&
        'coveredBy' in raw &&
        !(value.checks as Record<string, unknown>[]).some(other => other.id === raw.coveredBy && other.cadence === 'periodic')
      )
        problems.push(`${String(raw.id)}: coveredBy must name a periodic check`);
  if (problems.length) throw new Error(`POLICY_INVALID: scripts/test-runner/policy.json\n  ${problems.join('\n  ')}`);
  const version = `${String(value.version)}+sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  return { ...(value as unknown as Policy), policyVersion: version, raw: value };
}

/** A policy glob (`**`, `*`) as an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') pattern += '[^/]*';
    else pattern += /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${pattern}$`);
}

export const matchesAny = (file: string, globs: readonly string[]) => globs.some(glob => globToRegExp(glob).test(file));

/** Files that depend on any of `files`, transitively, from a module → imports map. */
export function dependents(files: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[] {
  const reverse = new Map<string, Set<string>>();
  for (const [module, imports] of edges)
    for (const target of imports) {
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target)!.add(module);
    }
  const seen = new Set(files),
    queue = [...files];
  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    for (const parent of reverse.get(next) ?? [])
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
  return [...seen].filter(file => !files.includes(file)).sort();
}

const code = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const inGraphRoots = (file: string) => /^(src|test|scripts)\//.test(file);

/** Why the change's impact cannot be reduced, or undefined when it can. */
export function wideningReason(change: Change, policy: Policy, graph: Graph | undefined): string | undefined {
  if (change.widened !== undefined) return `impact unknown: ${change.widened}`;
  const shared = change.files.filter(file => matchesAny(file, policy.sharedConfiguration));
  if (shared.length) return `shared configuration changed: ${shared.join(', ')}`;
  const placeable = change.files.filter(file => !matchesAny(file, policy.documentation));
  if (!placeable.length) return undefined;
  if (graph === undefined) return 'impact unknown: the dependency graph could not be built';
  const unresolved = placeable.filter(file => graph.unresolved.includes(file));
  if (unresolved.length) return `impact unknown: the graph cannot place an import in ${unresolved.join(', ')}`;
  const deleted = placeable.filter(file => code.test(file) && inGraphRoots(file) && change.deleted.includes(file));
  if (deleted.length) return `impact unknown: deleted modules have no place in the graph: ${deleted.join(', ')}`;
  const unplaced = placeable.filter(file => !change.deleted.includes(file) && !(code.test(file) && graph.edges.has(file)));
  if (unplaced.length) return `impact unknown: the graph cannot place ${unplaced.join(', ')}`;
  return undefined;
}

function lastIntegral(check: Check, integral: IntegralRecord | undefined): LastIntegral {
  const outcome = integral?.checks[check.id];
  if (integral === undefined || outcome === undefined) return { outcome: 'not recorded' };
  return { outcome, at: integral.finishedAt, commit: integral.commit, policyVersion: integral.policyVersion };
}

/** The plan of one mode. `tests` are the test files that exist in the tree; a level-bound check selects among its level's. */
export function planValidation(
  mode: Mode,
  policy: Policy,
  change: Change,
  graph: Graph | undefined,
  tests: readonly string[],
  integral: IntegralRecord | undefined,
  levelOf: (file: string) => Level = () => 'integration',
): ValidationPlan {
  const allTests = [...tests].sort();
  const testsOf = (check: Check) => (check.level ? allTests.filter(file => levelOf(file) === check.level) : allTests);
  if (mode === 'integral')
    return {
      mode,
      policyVersion: policy.policyVersion,
      widened: 'integral validation runs every check over its whole input',
      affected: undefined,
      entries: policy.checks.map((check): Entry =>
        check.coveredBy
          ? { check, decision: 'covered', by: check.coveredBy }
          : { check, decision: 'run', scope: 'whole', files: check.scope === 'affected-tests' ? testsOf(check) : [] },
      ),
    };
  const widened = wideningReason(change, policy, graph);
  const files = change.files ?? [];
  let affected: string[] | undefined;
  if (widened === undefined) {
    const set = new Set([...files, ...dependents(files, graph?.edges ?? new Map())]);
    if ([...set].some(file => matchesAny(file, policy.runtimeDependents.on)))
      for (const test of allTests) if (matchesAny(test, policy.runtimeDependents.tests)) set.add(test);
    affected = [...set].sort();
  }
  const deleted = change.deleted ?? [];
  const entries = policy.checks.map((check): Entry => {
    if (check.cadence === 'periodic') {
      const last = lastIntegral(check, integral);
      const inScope = affected === undefined || affected.some(file => matchesAny(file, check.appliesTo));
      return { check, decision: 'periodic', last, blocking: last.outcome === 'failed' && inScope };
    }
    if (affected === undefined)
      return {
        check,
        decision: 'run',
        scope: check.scope === 'changed' ? 'changed' : 'whole',
        files: check.scope === 'affected-tests' ? testsOf(check) : check.scope === 'changed' ? files.filter(file => !deleted.includes(file)).sort() : [],
      };
    if (!affected.some(file => matchesAny(file, check.appliesTo))) return { check, decision: 'not-applicable' };
    if (check.scope === 'affected-tests') {
      const own = testsOf(check);
      const selected = affected.filter(file => own.includes(file) && !deleted.includes(file));
      return selected.length ? { check, decision: 'run', scope: 'affected', files: selected } : { check, decision: 'not-applicable' };
    }
    if (check.scope === 'changed') return { check, decision: 'run', scope: 'changed', files: files.filter(file => !deleted.includes(file)).sort() };
    return { check, decision: 'run', scope: 'whole', files: [] };
  });
  return { mode, policyVersion: policy.policyVersion, widened, affected, entries };
}

/** The quality gate a finding of `rule` reported by `check` belongs to. */
export function gateOf(check: Check, rule: string): string {
  const prefix = Object.keys(check.gateByRule ?? {})
    .filter(key => rule === key || rule.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? check.gate : check.gateByRule![prefix]!;
}

/** Estimated seconds of the checks the plan runs; an affected-tests check costs its share of its level's tests. */
export function estimatedSeconds(plan: ValidationPlan, tests: readonly string[], levelOf: (file: string) => Level = () => 'integration'): number {
  return plan.entries.reduce((sum, entry) => {
    if (entry.decision !== 'run') return sum;
    const pool = entry.check.level ? tests.filter(file => levelOf(file) === entry.check.level).length : tests.length;
    if (entry.check.scope === 'affected-tests') return sum + (pool > 0 ? (entry.check.costSeconds * entry.files.length) / pool : 0);
    return sum + entry.check.costSeconds;
  }, 0);
}
