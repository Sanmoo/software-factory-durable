// Pure test-runner rules: tiers, the exceptions manifest, lane planning, budgets and the report.
// Runs directly under Node type stripping (no compilation step), so only erasable TypeScript syntax.

export type Tier = 'fast' | 'ci' | 'full';
export const tierNames: readonly Tier[] = ['fast', 'ci', 'full'];

/** Wall-clock ceilings on this machine, lock wait excluded. Load from other sessions is not an excuse. */
export const budgetsMs: Readonly<Record<Tier, number | undefined>> = Object.freeze({ fast: 180_000, ci: 600_000, full: undefined });

/** `full`: nightly only (excluded from fast and ci), for files too expensive for the per-integration gate. */
export interface ManifestEntry { slow: boolean; serial: boolean; full: boolean; quarantine?: string; reason: string }
export type Manifest = ReadonlyMap<string, ManifestEntry>;

const entryKeys = new Set(['slow', 'serial', 'full', 'quarantine', 'reason']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `test/tiers.json`: only exceptions. An unlisted file is fast and parallel. */
export function parseManifest(value: unknown, exists: (file: string) => boolean): Manifest {
  const problems: string[] = [];
  const entries = new Map<string, ManifestEntry>();
  if (!isRecord(value)) problems.push('manifest must be an object');
  else {
    if (value.schemaVersion !== 1) problems.push('schemaVersion must be 1');
    for (const key of Object.keys(value)) if (key !== 'schemaVersion' && key !== 'files') problems.push(`unknown top-level key "${key}"`);
    if (!isRecord(value.files)) problems.push('files must be an object');
    else for (const [file, raw] of Object.entries(value.files)) {
      const at = (message: string) => problems.push(`${file}: ${message}`);
      if (!/^test\/.+\.test\.ts$/.test(file)) { at('not a test/**/*.test.ts path'); continue; }
      if (!exists(file)) at('listed file does not exist');
      if (!isRecord(raw)) { at('entry must be an object'); continue; }
      for (const key of Object.keys(raw)) if (!entryKeys.has(key)) at(`unknown key "${key}"`);
      for (const flag of ['slow', 'serial', 'full'] as const) if (flag in raw && raw[flag] !== true) at(`${flag} must be true when present`);
      if ('quarantine' in raw && (typeof raw.quarantine !== 'string' || !raw.quarantine.trim())) at('quarantine must name its ticket');
      if (raw.slow !== true && raw.serial !== true && raw.full !== true && !('quarantine' in raw)) at('needs slow, serial, full or quarantine');
      if (typeof raw.reason !== 'string' || !raw.reason.trim()) at('needs a non-empty reason');
      const entry: ManifestEntry = { slow: raw.slow === true, serial: raw.serial === true, full: raw.full === true, reason: String(raw.reason ?? '') };
      if (typeof raw.quarantine === 'string') entry.quarantine = raw.quarantine;
      entries.set(file, entry);
    }
  }
  if (problems.length) throw new Error(`TIERS_MANIFEST_INVALID: test/tiers.json\n  ${problems.join('\n  ')}`);
  return entries;
}

export function concurrencyFor(tier: Tier, cpus: number): number {
  return Math.max(1, tier === 'fast' ? Math.floor(cpus / 2) : cpus);
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface LanePlan { parallel: string[]; serial: string[]; concurrency: number; quarantined: string[]; skippedSlow: string[]; skippedFull: string[] }

/** Longest known duration first; without history, slow-listed first; then by name. */
export function planLanes(tier: Tier, files: readonly string[], manifest: Manifest, cpus: number, timings: Readonly<Record<string, number>>): LanePlan {
  const plan: LanePlan = { parallel: [], serial: [], concurrency: concurrencyFor(tier, cpus), quarantined: [], skippedSlow: [], skippedFull: [] };
  const byCost = (a: string, b: string) => (timings[b] ?? -1) - (timings[a] ?? -1)
    || Number(manifest.get(b)?.slow ?? false) - Number(manifest.get(a)?.slow ?? false) || byName(a, b);
  for (const file of [...files].sort(byCost)) {
    const entry = manifest.get(file);
    if (entry?.quarantine) plan.quarantined.push(file);
    else if (tier !== 'full' && entry?.full) plan.skippedFull.push(file);
    else if (tier === 'fast' && entry?.slow) plan.skippedSlow.push(file);
    else (entry?.serial ? plan.serial : plan.parallel).push(file);
  }
  plan.serial.sort(byName);
  plan.quarantined.sort(byName);
  plan.skippedSlow.sort(byName);
  plan.skippedFull.sort(byName);
  return plan;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

export function budgetExceeded(tier: Tier, elapsedMs: number, budgetMs: number | undefined): string | undefined {
  if (budgetMs === undefined || elapsedMs <= budgetMs) return undefined;
  return `BUDGET_EXCEEDED: tier ${tier} took ${seconds(elapsedMs)} s, over its ${budgetMs / 1000} s ceiling (lock wait excluded). `
    + 'Reclassify the slow files in test/tiers.json or optimize them; load from other sessions is not an excuse.';
}

/** Deterministic Fisher-Yates (mulberry32) so a random-order failure is reproducible from its seed. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export interface Counts { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number }
export interface FileResult { file: string; ms: number; ok: boolean; counts: Counts; output?: string }
export interface StepResult { name: string; ms: number; ok: boolean; output?: string }
export interface LaneResult { name: string; concurrency: number; ms: number; files: FileResult[] }
export interface RunSummary {
  tier: Tier; lockWaitMs: number; totalMs: number; budgetMs: number | undefined;
  load: { start: readonly number[]; end: readonly number[] };
  static: StepResult[]; lanes: LaneResult[]; quarantined: string[]; skippedSlow: string[]; skippedFull?: string[];
  filtered: boolean; failures: string[]; seed?: number;
}

const emptyCounts = (): Counts => ({ tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });

/** Totals from the trailer of node:test's TAP reporter. */
export function parseTapCounts(output: string): Counts {
  const counts = emptyCounts();
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) counts[match[1] as keyof Counts] += Number(match[2]);
  return counts;
}

export function formatReport(summary: RunSummary): string {
  const all = summary.lanes.flatMap(lane => lane.files);
  const totals = all.reduce((sum, file) => {
    for (const key of Object.keys(sum) as (keyof Counts)[]) sum[key] += file.counts[key];
    return sum;
  }, emptyCounts());
  const load = (values: readonly number[]) => values.map(value => value.toFixed(2)).join(' ');
  const lines = [`== test-runner: tier ${summary.tier} ==`,
    `lock wait: ${seconds(summary.lockWaitMs)} s (not counted in the budget)`,
    `static: ${summary.static.map(step => `${step.name} ${seconds(step.ms)} s${step.ok ? '' : ' FAILED'}`).join(', ') || 'none'}`,
    ...summary.lanes.map(lane => `lane ${lane.name}: ${lane.files.length} files, N=${lane.concurrency}, ${seconds(lane.ms)} s`),
    `tests: ${totals.tests} (pass ${totals.pass}, fail ${totals.fail}, cancelled ${totals.cancelled}, skipped ${totals.skipped}, todo ${totals.todo})`,
    `total: ${seconds(summary.totalMs)} s${summary.budgetMs === undefined ? ' (no ceiling)' : ` of ${summary.budgetMs / 1000} s budget`}`,
    `load average: start ${load(summary.load.start)}, end ${load(summary.load.end)}`];
  if (summary.seed !== undefined) lines.push(`random-order seed: ${summary.seed}`);
  if (summary.skippedSlow.length) lines.push(`slow, left to ci: ${summary.skippedSlow.length} files`);
  if (summary.skippedFull?.length) lines.push(`full only, left to the nightly: ${summary.skippedFull.join(', ')}`);
  if (summary.quarantined.length) lines.push(`quarantined (not coverage): ${summary.quarantined.join(', ')}`);
  lines.push('slowest files:');
  [...all].sort((a, b) => b.ms - a.ms).slice(0, 10)
    .forEach((file, index) => lines.push(`  ${index + 1}. ${seconds(file.ms)} s ${file.file}`));
  for (const failure of summary.failures) lines.push(`FAILURE: ${failure}`);
  lines.push(summary.failures.length ? 'RESULT: FAIL' : `RESULT: PASS${summary.filtered ? ' (filtered run: convenience only, never a gate)' : ''}`);
  return lines.join('\n');
}
