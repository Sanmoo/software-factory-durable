// TEST ONLY. Ticket 24 resource registry of the real run (spec §12.1, V-06): read-only samples of each Work's OWN systemd unit cgroup
// (adapter + QEMU/VMM + Pi workers/reviewers of that boot: one group per Work) and of the host. Measured values only: an unreadable file is
// `null`, never zero; nothing here is a reservation, a capacity proof or a ceiling. Docker `vfs` and guest storage are measured from the
// host side by the Sandbox storage observation (qcow2 allocation, workspace bytes), which the recipe records next to these samples.

export type ProcessClass = 'vmm' | 'adapter' | 'worker' | 'other';
export type BootSample = { at: string; monotonicMs: number; boot: string; unit: string; present: boolean;
  memoryCurrentBytes: number | null; memoryPeakBytes: number | null; cpuUsageUsec: number | null; io: { readBytes: number; writeBytes: number } | null;
  processes: { class: ProcessClass; count: number; rssBytes: number | null }[] };
export type HostSample = { at: string; monotonicMs: number; memTotalBytes: number | null; memAvailableBytes: number | null; loadavg: number[] | null;
  pressure: Record<'cpu' | 'memory' | 'io', string | null> };

export const unitOf = (boot: string) => `factory-sandbox-${boot}.service`;
/** The unit's ControlGroup as systemd reports it (`systemctl --user show <unit> --property=ControlGroup`): never a hard-coded slice path. */
export type CgroupResolver = (unit: string) => Promise<string | null>;
export const systemdCgroup: CgroupResolver = async unit => {
  const { unitState } = await import('../../src/platform/host/index.js');
  const state = await unitState(unit).catch(() => null);
  return acceptCgroup(state?.ControlGroup ?? '', unit);
};
/** Pure: a reported ControlGroup is used only when it is an absolute, traversal-free path ending in exactly this unit. */
export const acceptCgroup = (group: string, unit: string) => /^\/[A-Za-z0-9@._\/-]+$/.test(group) && group.endsWith(`/${unit}`) && !group.split('/').includes('..') ? group : null;

const bootPattern = /^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (text: string | null) => text !== null && /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
/** `cpu.stat` usage_usec; `io.stat` summed rbytes/wbytes over devices (cgroup v2 formats). */
export function parseCpuStat(text: string | null) { const found = text ? /^usage_usec (\d+)$/m.exec(text) : null; return found ? Number(found[1]) : null; }
export function parseIoStat(text: string | null) {
  if (text === null) return null;
  let readBytes = 0, writeBytes = 0;
  for (const line of text.split('\n')) {
    readBytes += Number(/\brbytes=(\d+)/.exec(line)?.[1] ?? 0);
    writeBytes += Number(/\bwbytes=(\d+)/.exec(line)?.[1] ?? 0);
  }
  return { readBytes, writeBytes };
}
/** Process class from comm/cmdline of a process INSIDE the Work's own unit: QEMU, the adapter entrypoint, a worker entrypoint, other. */
export function classify(comm: string, cmdline: string): ProcessClass {
  if (/^qemu-system/.test(comm.trim())) return 'vmm';
  if (/entrypoints\/adapter\.js(\0|$)/.test(cmdline)) return 'adapter';
  if (/entrypoints\/worker\.js(\0|$)/.test(cmdline)) return 'worker';
  return 'other';
}
const vmRss = (status: string | null) => { const found = status ? /^VmRSS:\s+(\d+) kB$/m.exec(status) : null; return found ? Number(found[1]) * 1024 : null; };

/** One read-only sample of a boot's own unit. Paths are injectable (tests use fixture trees); the real run uses /sys/fs/cgroup and /proc. */
export async function sampleBoot(input: { boot: string; resolve?: CgroupResolver; cgroupRoot?: string; procRoot?: string; now?: () => number }): Promise<BootSample> {
  if (!bootPattern.test(input.boot)) throw new Error('BOOT_REF_INVALID');
  const fs = await import('node:fs/promises');
  const read = (path: string) => fs.readFile(path, 'utf8').catch(() => null);
  const cgroup = await (input.resolve ?? systemdCgroup)(unitOf(input.boot));
  const group = cgroup === null ? null : `${input.cgroupRoot ?? '/sys/fs/cgroup'}${cgroup}`;
  const procs = group === null ? null : await read(`${group}/cgroup.procs`);
  const base = { at: new Date().toISOString(), monotonicMs: Math.round((input.now ?? (() => performance.now()))()), boot: input.boot, unit: unitOf(input.boot) };
  if (procs === null || group === null) return { ...base, present: false, memoryCurrentBytes: null, memoryPeakBytes: null, cpuUsageUsec: null, io: null, processes: [] };
  const classes = new Map<ProcessClass, { count: number; rssBytes: number | null }>();
  for (const pid of procs.split('\n').filter(line => /^\d+$/.test(line)).slice(0, 256)) {
    const proc = `${input.procRoot ?? '/proc'}/${pid}`;
    const kind = classify(await read(`${proc}/comm`) ?? '', await read(`${proc}/cmdline`) ?? '');
    const rss = vmRss(await read(`${proc}/status`));
    const entry = classes.get(kind) ?? { count: 0, rssBytes: 0 };
    entry.count++;
    entry.rssBytes = entry.rssBytes === null || rss === null ? null : entry.rssBytes + rss;
    classes.set(kind, entry);
  }
  return { ...base, present: true, memoryCurrentBytes: integer(await read(`${group}/memory.current`)), memoryPeakBytes: integer(await read(`${group}/memory.peak`)),
    cpuUsageUsec: parseCpuStat(await read(`${group}/cpu.stat`)), io: parseIoStat(await read(`${group}/io.stat`)),
    processes: [...classes].map(([kind, value]) => ({ class: kind, ...value })) };
}

export async function sampleHost(input: { procRoot?: string; now?: () => number } = {}): Promise<HostSample> {
  const fs = await import('node:fs/promises');
  const proc = input.procRoot ?? '/proc';
  const read = (path: string) => fs.readFile(path, 'utf8').catch(() => null);
  const meminfo = await read(`${proc}/meminfo`);
  const field = (name: string) => { const found = meminfo ? new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(meminfo) : null; return found ? Number(found[1]) * 1024 : null; };
  const load = await read(`${proc}/loadavg`);
  const pressure = async (name: 'cpu' | 'memory' | 'io') => (await read(`${proc}/pressure/${name}`))?.trim().slice(0, 256) ?? null;
  return { at: new Date().toISOString(), monotonicMs: Math.round((input.now ?? (() => performance.now()))()), memTotalBytes: field('MemTotal'), memAvailableBytes: field('MemAvailable'),
    loadavg: load ? load.trim().split(/\s+/).slice(0, 3).map(Number) : null, pressure: { cpu: await pressure('cpu'), memory: await pressure('memory'), io: await pressure('io') } };
}

const max = (values: (number | null)[]) => values.some(value => value === null) || !values.length ? null : Math.max(...values as number[]);
/**
 * Per-boot summary of the samples (pure): peak cgroup memory (and memory.peak when the kernel exposes it), CPU seconds and I/O bytes
 * between the first and last PRESENT sample, peak RSS per process class and the most workers seen at once (Builder alone = 1; with both
 * reviewers = 3). Any unreadable value in a series makes that figure `null` (unknown), never zero.
 */
export function summarize(samples: readonly BootSample[]) {
  const byBoot = new Map<string, BootSample[]>();
  for (const sample of samples) if (sample.present) byBoot.set(sample.boot, [...(byBoot.get(sample.boot) ?? []), sample]);
  return [...byBoot].map(([boot, series]) => {
    const first = series[0]!, last = series.at(-1)!;
    const rss = (kind: ProcessClass) => max(series.map(sample => sample.processes.find(item => item.class === kind)?.rssBytes ?? 0));
    const delta = (pick: (sample: BootSample) => number | null) => pick(first) === null || pick(last) === null ? null : pick(last)! - pick(first)!;
    return { boot, samples: series.length, windowMs: last.monotonicMs - first.monotonicMs,
      peakMemoryCurrentBytes: max(series.map(sample => sample.memoryCurrentBytes)), memoryPeakBytes: last.memoryPeakBytes,
      cpuSeconds: (() => { const value = delta(sample => sample.cpuUsageUsec); return value === null ? null : value / 1e6; })(),
      ioReadBytes: delta(sample => sample.io?.readBytes ?? null), ioWriteBytes: delta(sample => sample.io?.writeBytes ?? null),
      peakRssBytes: { vmm: rss('vmm'), adapter: rss('adapter'), worker: rss('worker'), other: rss('other') },
      maxWorkersAtOnce: Math.max(0, ...series.map(sample => sample.processes.find(item => item.class === 'worker')?.count ?? 0)) };
  });
}

/** Overlap of the three container windows the Builders printed (`Q24_WINDOW_START|END <key> <epoch s>`): true only when every pair is observed. */
export function containerWindows(texts: Record<string, string>) {
  const windows: Record<string, { start: number | null; end: number | null }> = {};
  for (const [key, text] of Object.entries(texts)) {
    const start = [...text.matchAll(new RegExp(`Q24_WINDOW_START ${key} (\\d{10})\\b`, 'g'))].map(item => Number(item[1]));
    const end = [...text.matchAll(new RegExp(`Q24_WINDOW_END ${key} (\\d{10})\\b`, 'g'))].map(item => Number(item[1]));
    windows[key] = { start: start.length ? Math.min(...start) : null, end: end.length ? Math.max(...end) : null };
  }
  const keys = Object.keys(windows);
  const known = keys.every(key => windows[key]!.start !== null && windows[key]!.end !== null);
  const overlapAll = known && Math.max(...keys.map(key => windows[key]!.start!)) < Math.min(...keys.map(key => windows[key]!.end!));
  return { windows, known, overlapAll };
}
