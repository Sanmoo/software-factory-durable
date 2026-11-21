import {
  budgetExceeded,
  budgetsMs,
  formatReport,
  planLanes,
  shuffle,
  type FileResult,
  type LaneResult,
  type Manifest,
  type RunSummary,
  type StepResult,
  type Tier,
} from './lib.ts';
import type { MachineLock } from './lock.ts';
import { estimatedSeconds, gateOf, matchesAny, planValidation, type Change, type IntegralRecord, type Policy, type ValidationPlan } from './selection.ts';

export interface RunOptions {
  tier: Tier;
  filters: readonly string[];
  seed?: number;
  budgetMs?: number;
}
/**
 * What a test file receives from its run. `deadline` (epoch ms) is the tier's budget end: a file derives any guard against a hung
 * child or condition from it instead of a fixed timeout. `shared` is a private directory of this run, removed at its end, for
 * expensive read-only preparations several files reuse (e.g. one release build).
 */
export interface FileRun {
  sandboxRoot?: string;
  randomSeed?: number;
  deadline?: number;
  shared?: string;
}

/** Every effect the orchestration needs; real implementations live in steps.ts, tests inject doubles. */
export interface Steps {
  cpus: number;
  now(): number;
  log(line: string): void;
  loadAverage(): readonly number[];
  checkDependencies(): Promise<string[]>;
  loadManifest(): Promise<Manifest>;
  loadPolicy(): Promise<Policy>;
  acquireLock(tier: Tier): Promise<MachineLock>;
  /** `only`: just these quick checks (those a documentation-only change reaches); every static check otherwise. */
  staticAnalysis(tier: Tier, signal: AbortSignal, only?: readonly string[]): Promise<StepResult[]>;
  changedSet(base: string): Promise<Change & { base: string; compared?: string }>;
  loadIntegral(): Promise<IntegralRecord | undefined>;
  saveIntegral(record: IntegralRecord): Promise<void>;
  headCommit(): Promise<string>;
  listTests(): Promise<string[]>;
  /** test/levels.json: the level of each test file (unit when declared, integration otherwise). */
  loadLevels(): Promise<(file: string) => 'unit' | 'integration'>;
  /** The Dependency vulnerabilities check (npm audit over the lockfile). */
  audit(signal: AbortSignal): Promise<StepResult>;
  loadTimings(): Promise<Record<string, number>>;
  saveTimings(timings: Record<string, number>): Promise<void>;
  sandboxRoot(): Promise<{ path: string; cleanup(): Promise<void> }>;
  runDirectory(): Promise<{ path: string; cleanup(): Promise<void> }>;
  runFile(file: string, run: FileRun, signal: AbortSignal): Promise<FileResult>;
}

export interface Outcome {
  exitCode: number;
  report: string;
}

async function lane(name: string, files: readonly string[], concurrency: number, run: FileRun, steps: Steps, signal: AbortSignal): Promise<LaneResult> {
  const started = steps.now(),
    results: FileResult[] = [],
    queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined && !signal.aborted; file = queue.shift()) {
      const result = await steps.runFile(file, run, signal);
      results.push(result);
      steps.log(`${result.ok ? 'ok  ' : 'FAIL'} ${(result.ms / 1000).toFixed(1).padStart(6)} s ${file}`);
      if (!result.ok && result.output) steps.log(result.output.trimEnd());
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return { name, concurrency, ms: steps.now() - started, files: results };
}

/** Static steps name the check they realize; a failing finding is reported under the quality gate it belongs to. */
function staticFailures(steps: readonly StepResult[], policy: Policy): string[] {
  const failures: string[] = [];
  for (const step of steps)
    if (!step.ok) {
      const check = policy.checks.find(item => item.id === step.check);
      if (!check) {
        failures.push(`static ${step.name} failed`);
        continue;
      }
      if (!step.findings?.length) failures.push(`quality gate ${check.gate} (${check.id}): ${step.name} failed without a reported finding`);
      for (const finding of step.findings ?? [])
        failures.push(`quality gate ${gateOf(check, finding.rule)} (${check.id}): ${finding.rule} at ${finding.location}`);
    }
  return failures;
}

const isDocumentation = (policy: Policy, change: Change) => change.widened === undefined && change.files.every(file => matchesAny(file, policy.documentation));

/** Preconditions (deps, manifest, policy) → lock (ci/full) → budget clock → static → [selection] → lanes → report. */
export async function runTier(options: RunOptions, steps: Steps): Promise<Outcome> {
  const { tier } = options;
  const precondition = (message: string): Outcome => {
    steps.log(message);
    return { exitCode: 2, report: message };
  };
  const problems = await steps.checkDependencies();
  if (problems.length) return precondition(`DEPENDENCIES_MISMATCH: node_modules does not match package-lock.json; run \`npm ci\`.\n  ${problems.join('\n  ')}`);
  let manifest: Manifest, policy: Policy;
  try {
    manifest = await steps.loadManifest();
  } catch (error) {
    return precondition((error as Error).message);
  }
  try {
    policy = await steps.loadPolicy();
  } catch (error) {
    return precondition((error as Error).message);
  }
  const mode = tier === 'ci' ? 'change' : tier === 'full' ? 'integral' : undefined;

  const lock = tier === 'fast' ? undefined : await steps.acquireLock(tier);
  try {
    const budgetMs = options.budgetMs ?? (mode === 'change' ? policy.budgetSeconds * 1000 : budgetsMs[tier]);
    const started = steps.now(),
      load = steps.loadAverage();
    const controller = new AbortController();
    const timer = budgetMs === undefined ? undefined : setTimeout(() => controller.abort(), budgetMs);
    const summary: RunSummary = {
      tier,
      lockWaitMs: lock?.waitedMs ?? 0,
      totalMs: 0,
      budgetMs,
      load: { start: load, end: load },
      static: [],
      lanes: [],
      quarantined: [],
      skippedSlow: [],
      filtered: options.filters.length > 0,
      failures: [],
    };
    let sandbox: { path: string; cleanup(): Promise<void> } | undefined, shared: { path: string; cleanup(): Promise<void> } | undefined;
    let plan: ValidationPlan | undefined;
    const outcomes: Record<string, 'passed' | 'failed' | 'not run'> = {};
    try {
      const change = mode === 'change' ? await steps.changedSet(policy.base) : { files: [], deleted: [] };
      const documentationOnly = mode === 'change' && isDocumentation(policy, change);
      const reached = documentationOnly
        ? policy.checks.filter(check => check.cadence === 'change' && change.files!.some(file => matchesAny(file, check.appliesTo))).map(check => check.id)
        : undefined;
      summary.static = await steps.staticAnalysis(tier, controller.signal, reached);
      for (const step of summary.static) if (!step.ok && step.output) steps.log(step.output.trimEnd());
      summary.failures.push(...staticFailures(summary.static, policy));
      for (const step of summary.static) if (step.check) outcomes[step.check] = outcomes[step.check] === 'failed' || !step.ok ? 'failed' : 'passed';
      const listed = await steps.listTests();
      const levelOf = await steps.loadLevels();
      if (mode !== undefined) {
        const graph = summary.static.find(step => step.graph)?.graph;
        plan = planValidation(mode, policy, change, graph, listed, mode === 'change' ? await steps.loadIntegral() : undefined, levelOf);
        summary.validation = {
          plan,
          base: 'base' in change ? `${change.base}${change.compared ? ` (compared ${change.compared.slice(0, 12)})` : ''}` : undefined,
          estimatedSeconds: estimatedSeconds(plan, listed, levelOf),
          outcomes,
        };
        // Dependency vulnerabilities runs before the tests when the plan selects it; its failure stops validation by change like a static one.
        if (plan.entries.some(entry => entry.check.id === 'vulnerabilities' && entry.decision === 'run') && !controller.signal.aborted) {
          const audited = await steps.audit(controller.signal);
          summary.static.push(audited);
          if (!audited.ok && audited.output) steps.log(audited.output.trimEnd());
          summary.failures.push(...staticFailures([audited], policy));
          outcomes.vulnerabilities = audited.ok ? 'passed' : 'failed';
        }
        for (const entry of plan.entries)
          if (entry.decision === 'periodic' && entry.blocking)
            summary.failures.push(
              `periodic check ${entry.check.id} (quality gate ${entry.check.gate}) failed in the last integral validation` +
                ` at ${entry.last.commit ?? '?'}; this change verifies files in its scope, so its failure requires treatment`,
            );
        if (mode === 'change' && summary.validation.estimatedSeconds > policy.budgetSeconds) {
          summary.validation.inconclusive =
            `required validation is estimated at ${Math.round(summary.validation.estimatedSeconds)} s, over the approved` +
            ` ${policy.budgetSeconds} s budget; the affected tests were not started and stay unverified. Decision needed: approve a wider budget in` +
            ' scripts/test-runner/policy.json for this change, or split it.';
        }
      }
      const proceed = !controller.signal.aborted && summary.validation?.inconclusive === undefined && (mode === 'integral' || !summary.failures.length);
      if (proceed) {
        const timings = await steps.loadTimings();
        const testEntries = (plan?.entries ?? []).filter(entry => entry.check.scope === 'affected-tests');
        const selected = mode === 'change' ? [...new Set(testEntries.flatMap(entry => (entry.decision === 'run' ? entry.files : [])))].sort() : listed;
        const files = options.filters.length ? selected.filter(file => options.filters.some(filter => file.includes(filter))) : selected;
        const lanePlan = planLanes(tier, files, manifest, steps.cpus, timings);
        summary.quarantined = lanePlan.quarantined;
        summary.skippedSlow = lanePlan.skippedSlow;
        summary.skippedFull = lanePlan.skippedFull;
        shared = await steps.runDirectory();
        const run: FileRun = { shared: shared.path, ...(budgetMs === undefined ? {} : { deadline: started + budgetMs }) };
        if (tier === 'full') {
          sandbox = await steps.sandboxRoot();
          run.sandboxRoot = sandbox.path;
        }
        const first = [
          await lane('parallel', lanePlan.parallel, lanePlan.concurrency, run, steps, controller.signal),
          await lane('serial', lanePlan.serial, 1, run, steps, controller.signal),
        ];
        summary.lanes.push(...first);
        const firstOk = first.every(item => item.files.every(file => file.ok));
        const failedFirst = new Set(first.flatMap(item => item.files.filter(file => !file.ok).map(file => file.file)));
        if (mode === 'change')
          for (const entry of testEntries)
            if (entry.decision === 'run') outcomes[entry.check.id] = entry.files.some(file => failedFirst.has(file)) ? 'failed' : 'passed';
        if (mode === 'integral') outcomes['integral-pass'] = firstOk ? 'passed' : 'failed';
        if (tier === 'full') {
          const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
          summary.seed = seed;
          const random = { ...run, randomSeed: seed };
          const second = [
            await lane('random-parallel', shuffle(lanePlan.parallel, seed), lanePlan.concurrency, random, steps, controller.signal),
            await lane('random-serial', shuffle(lanePlan.serial, seed), 1, random, steps, controller.signal),
          ];
          summary.lanes.push(...second);
          outcomes['random-order'] = second.every(item => item.files.every(file => file.ok)) ? 'passed' : 'failed';
        }
        // Each failing file is reported under the quality gate of its level (the random-order pass under its own periodic check).
        const levelCheck = (file: string) => policy.checks.find(check => check.scope === 'affected-tests' && check.level === levelOf(file));
        for (const item of summary.lanes)
          for (const result of item.files) {
            timings[result.file] = result.ms;
            if (result.ok) continue;
            const check = item.name.startsWith('random') ? policy.checks.find(entry => entry.id === 'random-order') : levelCheck(result.file);
            summary.failures.push(check ? `quality gate ${check.gate} (${check.id}): ${result.file} failed` : `${result.file} failed`);
          }
        if (!summary.filtered && !controller.signal.aborted) await steps.saveTimings(timings);
      }
    } finally {
      if (timer) clearTimeout(timer);
      await sandbox?.cleanup();
      await shared?.cleanup();
    }
    summary.totalMs = steps.now() - started;
    summary.load.end = steps.loadAverage();
    const exceeded =
      budgetExceeded(tier, summary.totalMs, budgetMs) ??
      (controller.signal.aborted ? budgetExceeded(tier, Math.max(summary.totalMs, (budgetMs ?? 0) + 1), budgetMs) : undefined);
    if (exceeded) summary.failures.unshift(exceeded);
    if (mode === 'integral' && plan && !summary.filtered) {
      for (const entry of plan.entries) if (entry.decision === 'run' && !(entry.check.id in outcomes)) outcomes[entry.check.id] = 'not run';
      await steps.saveIntegral({
        policyVersion: plan.policyVersion,
        commit: await steps.headCommit(),
        finishedAt: new Date(steps.now()).toISOString(),
        checks: outcomes,
      });
    }
    const report = formatReport(summary);
    steps.log(report);
    const exitCode = summary.failures.length ? 1 : summary.validation?.inconclusive ? 3 : 0;
    return { exitCode, report };
  } finally {
    lock?.release();
  }
}
