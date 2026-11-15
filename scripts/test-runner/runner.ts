import { budgetExceeded, budgetsMs, formatReport, planLanes, shuffle,
  type FileResult, type LaneResult, type Manifest, type RunSummary, type StepResult, type Tier } from './lib.ts';
import type { MachineLock } from './lock.ts';

export interface RunOptions { tier: Tier; filters: readonly string[]; seed?: number; budgetMs?: number }
export interface FileRun { sandboxRoot?: string; randomSeed?: number }

/** Every effect the orchestration needs; real implementations live in steps.ts, tests inject doubles. */
export interface Steps {
  cpus: number;
  now(): number;
  log(line: string): void;
  loadAverage(): readonly number[];
  checkDependencies(): Promise<string[]>;
  loadManifest(): Promise<Manifest>;
  acquireLock(tier: Tier): Promise<MachineLock>;
  staticAnalysis(tier: Tier, signal: AbortSignal): Promise<StepResult[]>;
  listTests(): Promise<string[]>;
  loadTimings(): Promise<Record<string, number>>;
  saveTimings(timings: Record<string, number>): Promise<void>;
  sandboxRoot(): Promise<{ path: string; cleanup(): Promise<void> }>;
  runFile(file: string, run: FileRun, signal: AbortSignal): Promise<FileResult>;
}

export interface Outcome { exitCode: number; report: string }

async function lane(name: string, files: readonly string[], concurrency: number, run: FileRun, steps: Steps, signal: AbortSignal): Promise<LaneResult> {
  const started = steps.now(), results: FileResult[] = [], queue = [...files];
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

/** Preconditions (deps, manifest) → lock (ci/full) → budget clock → static → lanes → report. */
export async function runTier(options: RunOptions, steps: Steps): Promise<Outcome> {
  const { tier } = options;
  const precondition = (message: string): Outcome => { steps.log(message); return { exitCode: 2, report: message }; };
  const problems = await steps.checkDependencies();
  if (problems.length) return precondition(`DEPENDENCIES_MISMATCH: node_modules does not match package-lock.json; run \`npm ci\`.\n  ${problems.join('\n  ')}`);
  let manifest: Manifest;
  try { manifest = await steps.loadManifest(); } catch (error) { return precondition((error as Error).message); }

  const lock = tier === 'fast' ? undefined : await steps.acquireLock(tier);
  try {
    const budgetMs = options.budgetMs ?? budgetsMs[tier];
    const started = steps.now(), load = steps.loadAverage();
    const controller = new AbortController();
    const timer = budgetMs === undefined ? undefined : setTimeout(() => controller.abort(), budgetMs);
    const summary: RunSummary = { tier, lockWaitMs: lock?.waitedMs ?? 0, totalMs: 0, budgetMs, load: { start: load, end: load },
      static: [], lanes: [], quarantined: [], skippedSlow: [], filtered: options.filters.length > 0, failures: [] };
    let sandbox: { path: string; cleanup(): Promise<void> } | undefined;
    try {
      summary.static = await steps.staticAnalysis(tier, controller.signal);
      for (const step of summary.static) if (!step.ok) {
        summary.failures.push(`static ${step.name} failed`);
        if (step.output) steps.log(step.output.trimEnd());
      }
      if (!summary.failures.length && !controller.signal.aborted) {
        const timings = await steps.loadTimings();
        const listed = await steps.listTests();
        const files = options.filters.length ? listed.filter(file => options.filters.some(filter => file.includes(filter))) : listed;
        const plan = planLanes(tier, files, manifest, steps.cpus, timings);
        summary.quarantined = plan.quarantined;
        summary.skippedSlow = plan.skippedSlow;
        const run: FileRun = {};
        if (tier === 'full') { sandbox = await steps.sandboxRoot(); run.sandboxRoot = sandbox.path; }
        summary.lanes.push(await lane('parallel', plan.parallel, plan.concurrency, run, steps, controller.signal));
        summary.lanes.push(await lane('serial', plan.serial, 1, run, steps, controller.signal));
        if (tier === 'full') {
          const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
          summary.seed = seed;
          const random = { ...run, randomSeed: seed };
          summary.lanes.push(await lane('random-parallel', shuffle(plan.parallel, seed), plan.concurrency, random, steps, controller.signal));
          summary.lanes.push(await lane('random-serial', shuffle(plan.serial, seed), 1, random, steps, controller.signal));
        }
        for (const result of summary.lanes.flatMap(item => item.files)) {
          timings[result.file] = result.ms;
          if (!result.ok) summary.failures.push(`${result.file} failed`);
        }
        if (!summary.filtered && !controller.signal.aborted) await steps.saveTimings(timings);
      }
    } finally {
      if (timer) clearTimeout(timer);
      await sandbox?.cleanup();
    }
    summary.totalMs = steps.now() - started;
    summary.load.end = steps.loadAverage();
    const exceeded = budgetExceeded(tier, summary.totalMs, budgetMs)
      ?? (controller.signal.aborted ? budgetExceeded(tier, Math.max(summary.totalMs, (budgetMs ?? 0) + 1), budgetMs) : undefined);
    if (exceeded) summary.failures.unshift(exceeded);
    const report = formatReport(summary);
    steps.log(report);
    return { exitCode: summary.failures.length ? 1 : 0, report };
  } finally { lock?.release(); }
}
