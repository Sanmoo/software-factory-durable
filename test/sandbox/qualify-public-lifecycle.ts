// Manual, operator-authorized qualification. Not discovered by node --test.
// One fresh root, one start, no retry/reboot/SDK access or global cleanup.
import { open, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSandbox } from '../../src/sandbox/index.js';

const root = '/home/sanmoo/software-factory-test/t3';
const source = process.argv[2];
if (!source || !/^[a-f0-9]{40}$/.test(source)) throw new Error('EXACT_SOURCE_COMMIT_REQUIRED');
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets30/assets-final',
  manifestSha256: '960b256c7c9f22a97428edf986ad6ff83affd5253e4fb6ba0c1579a0768c5d80',
};
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1',
  memoryMiB: 2048, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 };

async function record(name: string, value: unknown) {
  const file = await open(join(root, `${name}.json`), 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  console.log(JSON.stringify({ phase: name, value }));
}

function startTicks(stat: string) {
  const value = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
  if (!value || !/^[0-9]+$/.test(value)) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
  return value;
}

async function qualify() {
  // Exclusive creation: rerunning cannot adopt this environment or create another VM.
  await mkdir(root, { mode: 0o700 });
  await record('scope', { source, operation: 'first-boot-and-public-stop', configuration, guestAssets,
    priorPreparations: [
      { root: '/home/sanmoo/software-factory-test/lc03', outcome: 'SANDBOX_RUNTIME_PATH_TOO_LONG', vmCreated: false, preserved: true },
      { root: '/home/sanmoo/software-factory-test/p3', outcome: 'SDK autoStart=false rejects before boot message', preserved: true },
      { root: '/home/sanmoo/software-factory-test/q3', outcome: 'failed after 33s without operational evidence; version-only witness rejected', preserved: true },
      { root: '/home/sanmoo/software-factory-test/r3', outcome: 'real KVM witness; vm-start/GUEST_READINESS_TIMEOUT before Docker check; already ceased before stop', preserved: true },
      { root: '/home/sanmoo/software-factory-test/s3', outcome: 'same corrected image failed SDK readiness; no operational/active-stop proof; correlated cessation confirmed', preserved: true },
    ],
    sessionSocketBytes: Buffer.byteLength(root) + 69,
    startupDiagnostics: 'Temporary cold-boot console-text markers only; no raw guest data, agents or credentials. Markers never establish readiness or cause.',
    knownRisk: 'Same pinned image as failed s3. Only console/diagnostic observation changes; no new image, timeout increase, retry or fallback.',
    expected: 'operational first boot followed by confirmed cessation; any failure remains a failure' });
  const sandbox = createSandbox({ root, guestAssets });
  const prepared = await sandbox.prepare({ workId: 'public-lifecycle-qualification-t3', configuration });
  await record('prepare', prepared);
  if (prepared.status !== 'success') { process.exitCode = 1; return; }
  const environment = prepared.environment;
  let settled = false;
  let qualifyingVmmWitness = false;
  const launching = sandbox.start({ environment, configuration }).finally(() => { settled = true; });
  // Independent read-only witness of the new unit's VMM, not authority to signal it.
  while (!settled) {
    try {
      const current = JSON.parse(await readFile(join(root, 'environments', environment, 'current.json'), 'utf8'));
      if (!/^boot-[a-f0-9-]{36}$/.test(current.boot)) throw new Error('INVALID_BOOT_WITNESS');
      const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/factory-sandbox-${current.boot}.service`;
      const pids = (await readFile(`/sys/fs/cgroup${group}/cgroup.procs`, 'utf8')).trim().split('\n');
      let captured = false;
      for (const pid of pids) {
        if (!/^[0-9]+$/.test(pid)) continue;
        const before = startTicks(await readFile(`/proc/${pid}/stat`, 'utf8'));
        const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        if (argv[0] !== '/usr/bin/qemu-system-x86_64' || argv.includes('--version') ||
            argv.includes('--help') || argv.includes('-help') || !argv.includes('-kernel') || !argv.includes('-initrd')) continue;
        // The SDK also runs qemu --version in this cgroup; that is not a VM.
        if (argv[argv.indexOf('-accel') + 1] !== 'kvm' ||
            argv[argv.indexOf('-m') + 1] !== '2048M' || argv[argv.indexOf('-smp') + 1] !== '2' ||
            !argv.some(arg => arg.includes(join(root, 'environments', environment, 'root.qcow2')))) continue;
        if ((await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim() !== `0::${group}` ||
            startTicks(await readFile(`/proc/${pid}/stat`, 'utf8')) !== before) continue;
        await record('vmm-witness', { boot: current.boot, pid: Number(pid), startTicks: before, group, argv });
        qualifyingVmmWitness = true;
        captured = true;
        break;
      }
      if (captured) break;
    } catch { /* Transient/missing evidence is not active/stopped proof. */ }
    await delay(250);
  }
  const started = await launching;
  if (!('boot' in started) || !started.boot) { await record('start', started); process.exitCode = 1; return; }
  let stopped;
  let activeBeforeStop = false;
  try {
    await record('start', started);
    const before = await sandbox.observe({ environment, boot: started.boot });
    activeBeforeStop = before.condition === 'active' && !before.cessationConfirmed;
    await record('before-stop', before);
  } finally {
    stopped = await sandbox.stop({ environment, boot: started.boot, reason: 'operator-authorized qualification' });
  }
  await record('stop', stopped);
  const after = await sandbox.observe({ environment, boot: started.boot });
  await record('after-stop', after);
  await record('result', { operationalBoot: started.status === 'success', cessationConfirmed: after.cessationConfirmed,
    qualifyingVmmWitness, activeBeforeStop,
    accepted: started.status === 'success' && activeBeforeStop && stopped.status === 'success' && after.cessationConfirmed && qualifyingVmmWitness,
    restartAttempted: false, resourcesRemoved: false });
  if (started.status !== 'success' || !activeBeforeStop || stopped.status !== 'success' || !after.cessationConfirmed || !qualifyingVmmWitness) process.exitCode = 1;
}

await qualify();
