import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptCgroup, classify, parseCpuStat, parseIoStat, sampleBoot, sampleHost, summarize } from './three24-measure.js';

// Ticket 24 resource registry on FIXTURE cgroup/proc trees (the real run reads /sys/fs/cgroup and /proc read-only). Unknown is never zero.
const boot = 'boot-11111111-2222-4333-8444-555555555555';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-measure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A slice path systemd reports (not app.slice): the sampler must follow it, never assume one.
  const cgroup = `/user.slice/user-1000.slice/user@1000.service/factory.slice/factory-sandbox-${boot}.service`;
  const group = join(dir, 'cgroup', cgroup);
  await mkdir(group, { recursive: true });
  const proc = join(dir, 'proc');
  const pids = {
    10: ['qemu-system-x86', 'qemu-system-x86_64\0-m\0'],
    11: ['node', '/node\0/r/dist/src/entrypoints/adapter.js\0'],
    12: ['node', '/node\0/r/dist/src/entrypoints/worker.js\0'],
    13: ['node', '/node\0/r/dist/src/entrypoints/worker.js\0'],
  } as const;
  for (const [pid, [comm, cmdline]] of Object.entries(pids)) {
    await mkdir(join(proc, pid), { recursive: true });
    await writeFile(join(proc, pid, 'comm'), `${comm}\n`);
    await writeFile(join(proc, pid, 'cmdline'), cmdline);
    await writeFile(join(proc, pid, 'status'), `Name:\t${comm}\nVmRSS:\t  ${Number(pid) * 1000} kB\n`);
  }
  const write = async (cpu: number, memory: number, io: string) => {
    await writeFile(join(group, 'cgroup.procs'), Object.keys(pids).join('\n') + '\n');
    await writeFile(join(group, 'memory.current'), `${memory}\n`);
    await writeFile(join(group, 'memory.peak'), `${memory + 5}\n`);
    await writeFile(join(group, 'cpu.stat'), `usage_usec ${cpu}\nuser_usec 1\nsystem_usec 2\n`);
    await writeFile(join(group, 'io.stat'), io);
  };
  await mkdir(join(proc, 'pressure'), { recursive: true });
  await writeFile(join(proc, 'meminfo'), 'MemTotal:       16000000 kB\nMemAvailable:    9000000 kB\n');
  await writeFile(join(proc, 'loadavg'), '1.50 2.25 3.00 4/900 12345\n');
  await writeFile(join(proc, 'pressure', 'memory'), 'some avg10=0.00 avg60=0.10 avg300=0.20 total=10\n');
  return {
    cgroupRoot: join(dir, 'cgroup'),
    procRoot: proc,
    write,
    group,
    resolve: async (unit: string) => (unit === `factory-sandbox-${boot}.service` ? cgroup : null),
  };
}

test('parsers: cpu.stat usage, io.stat summed over devices, process classes inside the own unit', () => {
  assert.equal(parseCpuStat('usage_usec 1500000\nuser_usec 1\n'), 1500000);
  assert.equal(parseCpuStat(null), null);
  assert.deepEqual(parseIoStat('259:0 rbytes=100 wbytes=10 rios=1\n8:0 rbytes=5 wbytes=7\n'), { readBytes: 105, writeBytes: 17 });
  assert.equal(parseIoStat(null), null);
  assert.equal(classify('qemu-system-x86\n', ''), 'vmm');
  assert.equal(classify('node', '/n\0/x/entrypoints/adapter.js\0root'), 'adapter');
  assert.equal(classify('node', '/n\0/x/entrypoints/worker.js'), 'worker');
  assert.equal(classify('sh', '/bin/sh'), 'other');
  const unit = 'factory-sandbox-boot-11111111-2222-4333-8444-555555555555.service';
  assert.equal(acceptCgroup(`/user.slice/x.slice/${unit}`, unit), `/user.slice/x.slice/${unit}`);
  for (const bad of ['', `relative/${unit}`, `/a/../${unit}`, '/user.slice/other.service', `/a b/${unit}`]) assert.equal(acceptCgroup(bad, unit), null, bad);
});

test('boot samples and summary: peak memory, CPU seconds and I/O between samples, RSS per class, workers at once; absent unit and unknown values are never zero', async t => {
  const f = await fixture(t);
  let now = 1000;
  await f.write(1_000_000, 500, '8:0 rbytes=100 wbytes=50\n');
  const first = await sampleBoot({ boot, resolve: f.resolve, cgroupRoot: f.cgroupRoot, procRoot: f.procRoot, now: () => now });
  assert.deepEqual(first.processes.map(item => [item.class, item.count]).sort(), [
    ['adapter', 1],
    ['vmm', 1],
    ['worker', 2],
  ]);
  assert.equal(first.processes.find(item => item.class === 'worker')!.rssBytes, (12 + 13) * 1000 * 1024);
  now = 16000;
  await f.write(4_000_000, 900, '8:0 rbytes=1100 wbytes=250\n');
  const second = await sampleBoot({ boot, resolve: f.resolve, cgroupRoot: f.cgroupRoot, procRoot: f.procRoot, now: () => now });
  const [summary] = summarize([first, second]);
  assert.deepEqual(
    [
      summary!.samples,
      summary!.windowMs,
      summary!.peakMemoryCurrentBytes,
      summary!.memoryPeakBytes,
      summary!.cpuSeconds,
      summary!.ioReadBytes,
      summary!.ioWriteBytes,
      summary!.maxWorkersAtOnce,
    ],
    [2, 15000, 900, 905, 3, 1000, 200, 2],
  );
  assert.equal(summary!.peakRssBytes.vmm, 10 * 1000 * 1024);
  // Unreadable memory in one sample: the peak is unknown (null), never the other sample's value or zero.
  await rm(join(f.group, 'memory.current'));
  const third = await sampleBoot({ boot, resolve: f.resolve, cgroupRoot: f.cgroupRoot, procRoot: f.procRoot, now: () => now });
  assert.equal(third.memoryCurrentBytes, null);
  assert.equal(summarize([first, third])[0]!.peakMemoryCurrentBytes, null);
  const absent = await sampleBoot({ boot: 'boot-99999999-2222-4333-8444-555555555555', resolve: f.resolve, cgroupRoot: f.cgroupRoot, procRoot: f.procRoot });
  assert.deepEqual([absent.present, absent.memoryCurrentBytes, absent.processes], [false, null, []]);
  assert.deepEqual(summarize([absent]), [], 'an absent unit contributes no figure');
  await assert.rejects(sampleBoot({ boot: '../../etc', resolve: f.resolve, cgroupRoot: f.cgroupRoot }), /BOOT_REF_INVALID/);
});

test('host sample: meminfo, loadavg and pressure; missing files are null', async t => {
  const f = await fixture(t);
  const host = await sampleHost({ procRoot: f.procRoot, now: () => 7 });
  assert.deepEqual([host.memTotalBytes, host.memAvailableBytes, host.loadavg, host.monotonicMs], [16000000 * 1024, 9000000 * 1024, [1.5, 2.25, 3], 7]);
  assert.match(host.pressure.memory!, /^some avg10=/);
  assert.deepEqual([host.pressure.cpu, host.pressure.io], [null, null]);
  const empty = await sampleHost({ procRoot: join(f.procRoot, 'absent') });
  assert.deepEqual([empty.memTotalBytes, empty.memAvailableBytes, empty.loadavg], [null, null, null]);
});
