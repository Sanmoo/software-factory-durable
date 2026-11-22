import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectMemory, parseMeminfo, parseSandboxUnits } from '../../src/platform/host/index.js';
import { bootMemoryAllows, capacityDiagnostic, createBootLedger, memoryFloorMiB } from '../../src/sandbox/index.js';
import { validateConfiguration } from '../../src/sandbox/configuration.js';

// Ticket 24 rules: free-memory precondition of a boot and the doctor's capacity view. Pure (the host observation is data), plus the
// /proc/meminfo parser on fixture text. No VM, systemd or real host pressure.
const mib = 1048576;
const configuration = (extra: Record<string, unknown> = {}) => {
  const validated = validateConfiguration({ schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048, vcpus: 2, ...extra });
  assert.ok(validated.valid);
  return validated.effective;
};

test('meminfo: MemTotal/MemAvailable in bytes; missing or malformed is unavailable, never zero', async t => {
  const text = 'MemTotal:       16075812 kB\nMemFree:         4045364 kB\nMemAvailable:    8251232 kB\nBuffers:            1024 kB\n';
  assert.deepEqual(parseMeminfo(text), { totalBytes: String(16075812 * 1024), availableBytes: String(8251232 * 1024) });
  assert.equal(parseMeminfo('MemTotal:       16075812 kB\nMemFree: 1 kB\n'), undefined, 'kernels without MemAvailable are not guessed from MemFree');
  assert.equal(parseMeminfo('MemTotal: 12 MB\nMemAvailable: 3 MB\n'), undefined);
  const dir = await mkdtemp(join(tmpdir(), 'factory-meminfo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'meminfo'), text);
  assert.deepEqual(await inspectMemory(join(dir, 'meminfo')), parseMeminfo(text));
  assert.equal(await inspectMemory(join(dir, 'absent')), undefined);
});

test('boot precondition: MemAvailable >= guest memory + floor (default 1024 MiB, optional and absent from the effective configuration)', () => {
  const effective = configuration();
  assert.equal('minFreeMemoryMiB' in effective, false, 'an unset floor never changes the environment identity of prepared environments');
  assert.equal(memoryFloorMiB(effective), 1024);
  assert.equal(bootMemoryAllows({ availableBytes: String(3072 * mib), configuration: effective }), true);
  assert.equal(bootMemoryAllows({ availableBytes: String(3072 * mib - 1), configuration: effective }), false);
  assert.equal(bootMemoryAllows({ availableBytes: undefined, configuration: effective }), false, 'unobservable memory never admits a boot');
  assert.equal(bootMemoryAllows({ availableBytes: 'x', configuration: effective }), false);
  const explicit = configuration({ minFreeMemoryMiB: 256 });
  assert.equal(bootMemoryAllows({ availableBytes: String(2304 * mib), configuration: explicit }), true);
  assert.equal(validateConfiguration({ schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', minFreeMemoryMiB: 0 }).valid, false);
});

test('capacity diagnostic: virtual totals versus the observed host; one boot below its preconditions blocks, all Slots at full size is only unverified', () => {
  const effective = configuration();
  const gib = 1073741824;
  const roomy = {
    memory: { totalBytes: String(16 * gib), availableBytes: String(12 * gib) },
    storage: { availableBytes: String(500 * gib) },
    cpus: 8,
    runningGuests: 0,
  };
  const all = capacityDiagnostic({ concurrency: 3, configuration: effective, host: roomy });
  assert.equal(all.status, 'unverified', 'configured capacity is never reported as proven');
  assert.match(all.message, /concurrency 3 Slot\(s\) x guest 2048 MiB \/ 2 vCPU \/ 40 GiB virtual disk/);
  assert.match(all.message, /virtual totals 6442450944 B memory, 6 vCPU/);
  assert.match(all.message, /covers every free Slot at its full virtual size/);
  assert.match(all.message, /not reserved/);
  assert.match(all.nextStep, /measured authorized run/);
  const tight = capacityDiagnostic({
    concurrency: 3,
    configuration: effective,
    host: { ...roomy, memory: { totalBytes: String(16 * gib), availableBytes: String(5 * gib) } },
  });
  assert.equal(tight.status, 'unverified', 'one boot still fits: memory is allocated on demand');
  assert.match(tight.message, /does NOT cover every free Slot/);
  const below = capacityDiagnostic({
    concurrency: 1,
    configuration: effective,
    host: { ...roomy, memory: { totalBytes: String(4 * gib), availableBytes: String(2 * gib) } },
  });
  assert.equal(below.status, 'blocked');
  assert.match(below.nextStep, /never retried/);
  assert.equal(
    capacityDiagnostic({ concurrency: 1, configuration: effective, host: { ...roomy, storage: { availableBytes: String(43 * gib) } } }).status,
    'blocked',
    'a boot needs its virtual disk plus the free-space floor',
  );
  const unknown = capacityDiagnostic({
    concurrency: 1,
    configuration: effective,
    host: { memory: undefined, storage: roomy.storage, cpus: 8, runningGuests: 0 },
  });
  assert.equal(unknown.status, 'unverified', 'unreadable meminfo is unknown, never blocked');
  assert.match(unknown.message, /host memory unknown/);
  assert.equal(capacityDiagnostic({ concurrency: 1, configuration: effective, host: { ...roomy, runningGuests: null } }).status, 'unverified');
});

test("review: the Factory's own running guests occupy Slots and are already inside MemAvailable — healthy running capacity is never blocked", () => {
  const effective = configuration();
  const gib = 1073741824;
  const low = { memory: { totalBytes: String(16 * gib), availableBytes: String(2 * gib) }, storage: { availableBytes: String(500 * gib) }, cpus: 8 };
  const full = capacityDiagnostic({ concurrency: 3, configuration: effective, host: { ...low, runningGuests: 3 } });
  assert.equal(full.status, 'unverified');
  assert.match(full.message, /own running guests 3 \(free Slots 0\)/);
  assert.equal(
    capacityDiagnostic({ concurrency: 3, configuration: effective, host: { ...low, runningGuests: 2 } }).status,
    'blocked',
    'a free Slot whose boot cannot fit now',
  );
  assert.deepEqual(
    parseSandboxUnits(
      [
        'factory-sandbox-boot-11111111-2222-4333-8444-555555555555.service loaded active running Factory sandbox',
        'factory-sandbox-boot-21111111-2222-4333-8444-555555555555.service loaded inactive dead x',
        'other.service loaded active running y',
        '',
      ].join('\n'),
    ),
    ['factory-sandbox-boot-11111111-2222-4333-8444-555555555555.service'],
  );
});

test('decision 4 (review): a boot counts in the ledger only while it is LAUNCHING, across passes; once observed running (or failed) it is dropped, so its memory is never subtracted twice', async () => {
  const effective = configuration();
  let available = (2 * 2048 + 1024) * mib - 1; // one guest + floor fits, two do not
  const ledger = createBootLedger(async () => String(available));
  // Two simultaneous launches (same pass or not): exactly one is admitted.
  const [first, second] = await Promise.all([ledger.admit(effective), ledger.admit(effective)]);
  assert.deepEqual([first !== null, second !== null].sort(), [false, true]);
  assert.deepEqual(ledger.launching(), [2048]);
  // A boot of a LATER pass while the first still launches: still counted (no overcommit across passes).
  assert.equal(await ledger.admit(effective), null);
  // The first boot becomes operational: it is dropped; its RAM is now (partly) visible in MemAvailable, never counted twice.
  (first ?? second)!();
  assert.deepEqual(ledger.launching(), []);
  // Three boots minutes apart, each running before the next: each judged on its own guest against the current observation.
  available = (2048 + 1024) * mib;
  for (let i = 0; i < 3; i++) {
    const release = await ledger.admit(effective);
    assert.ok(release, `boot ${i + 1}`);
    release();
  }
  // Releasing twice is harmless and never drops another launching boot.
  const a = await createBootLedger(async () => String(10 * 2048 * mib)).admit(effective);
  a!();
  a!();
  const shared = createBootLedger(async () => String(10 * 2048 * mib));
  const x = await shared.admit(effective),
    y = await shared.admit(effective);
  x!();
  x!();
  assert.deepEqual(shared.launching(), [2048], 'an unfinished boot is never evicted');
  y!();
  assert.equal(await createBootLedger(async () => undefined).admit(effective), null, 'unobservable memory never admits');
  assert.equal(bootMemoryAllows({ availableBytes: String((2048 + 2048 + 1024) * mib), configuration: effective, launchingMiB: 2048 }), true);
  assert.equal(bootMemoryAllows({ availableBytes: String((2048 + 2048 + 1024) * mib - 1), configuration: effective, launchingMiB: 2048 }), false);
});
