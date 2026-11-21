import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { BootUsage, BootUsageReport, EnvironmentBuildReport, EnvironmentBuilds } from '../../contracts/index.js';
import type { EnvironmentRef } from '../prepare.js';
import { isLambdaEnvironment, listLambdaBoots, serviceSeconds, type LambdaBootRecord } from './boot.js';
import { readWorkImage } from './image.js';
import { readLambdaImageBuilds, type LambdaImageBuildEntry } from './image-ledger.js';

/**
 * v2 ticket 14 (V2-32): consumption as the Lambda adapter reports it. Per boot, MicroVM-seconds between the service's own `startedAt`
 * and `terminatedAt` (GetMicrovm), read from the boot's host record by any process; per environment key, the image builds this
 * installation requested. Nothing here reads the account, and nothing is a price: the Operator checks cost by the installation tag
 * (`docs/lambda-installation.md`).
 */
export const lambdaUsageUnit = 'microvm-seconds';

/** The size of a boot as one label (what the guest sees and the quota counts first; the image's baseline after). */
export const lambdaSizeLabel = (size: LambdaBootRecord['size']) => `${size.peakMemoryMiB} MiB / ${size.peakVcpus} vCPU (baseline ${size.baselineMemoryMiB} MiB)`;

/** One boot's usage from its record. A boot the service never gave both instants for is `unknown`, never zero. */
export function lambdaBootUsage(record: LambdaBootRecord): BootUsage {
  const base = { boot: record.boot, begin: record.begin.reason, end: record.end?.reason ?? record.stop?.reason ?? null, ...(record.end?.code ? { code: record.end.code } : {}),
    size: lambdaSizeLabel(record.size), startedAt: record.startedAt ?? null };
  // The service refused to run anything (its answer was read): no MicroVM ever existed for this boot.
  if (record.phase === 'ended' && !record.microvmId) return { ...base, startedAt: null, endedAt: null, seconds: 0, state: 'not-run' };
  if (record.phase === 'ended') {
    const seconds = serviceSeconds(record.startedAt, record.end?.terminatedAt);
    return seconds === null ? { ...base, endedAt: record.end?.terminatedAt ?? null, seconds: null, state: 'unknown' }
      : { ...base, endedAt: record.end!.terminatedAt!, seconds, state: 'measured' };
  }
  // `requested` without an id: RunMicrovm was never answered, so whether a MicroVM runs is unknown. `ending`: the end was asked and the
  // service has not confirmed it to this host.
  const running = (record.phase === 'running' || record.phase === 'active') && Boolean(record.microvmId);
  return { ...base, endedAt: null, seconds: null, state: running ? 'running' : 'unknown' };
}

/** Every boot recorded for the environment, oldest first. Boots of every Execution of the Work are here: the environment is the Work's. */
export async function lambdaEnvironmentUsage(root: string, environment: EnvironmentRef): Promise<BootUsageReport> {
  if (!/^env-[a-f0-9]{64}$/.test(environment) || !await isLambdaEnvironment(root, environment)) return { status: 'unavailable', code: 'BOOT_USAGE_NOT_MEASURED' };
  try { return { status: 'reported', unit: lambdaUsageUnit, boots: (await listLambdaBoots(root, environment)).map(lambdaBootUsage) }; }
  // An unreadable boot record is not an empty history.
  catch { return { status: 'unavailable', code: 'BOOT_RECORDS_UNREADABLE' }; }
}

/** Image builds per environment key, in the order the keys were first built, with how many Works of this installation use each key. */
export async function lambdaImageBuilds(root: string): Promise<EnvironmentBuildReport> {
  let ledger: LambdaImageBuildEntry[] | null;
  try { ledger = await readLambdaImageBuilds(root); } catch { return { status: 'unavailable', code: 'ENVIRONMENT_BUILD_RECORDS_UNREADABLE' }; }
  if (ledger === null) return { status: 'unavailable', code: 'ENVIRONMENT_BUILDS_NOT_RECORDED' };
  const works = new Map<string, number>();
  const environments = await readdir(join(await realpath(root), 'lambda', 'works')).catch(() => [] as string[]);
  for (const environment of environments) {
    const image = await readWorkImage(root, environment as EnvironmentRef).catch(() => null);
    if (image) works.set(image.key, (works.get(image.key) ?? 0) + 1);
  }
  const keys = new Map<string, EnvironmentBuilds>();
  for (const entry of ledger) {
    const known = keys.get(entry.key);
    if (entry.event === 'requested') keys.set(entry.key, { key: entry.key, name: entry.name, builds: (known?.builds ?? 0) + 1, works: works.get(entry.key) ?? 0,
      last: { requestedAt: entry.at, settledAt: null, outcome: 'requested' } });
    else if (known?.last.outcome === 'requested') keys.set(entry.key, { ...known, last: { ...known.last, settledAt: entry.at, outcome: entry.event } });
  }
  return { status: 'reported', keys: [...keys.values()] };
}
