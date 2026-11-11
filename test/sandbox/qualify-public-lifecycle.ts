// Manual, operator-authorized qualification. Not discovered by node --test.
// One fresh root, one start, no retry/reboot/SDK access or global cleanup.
import { open, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSandbox } from '../../src/sandbox/index.js';

const root = '/home/sanmoo/software-factory-test/q3';
const source = process.argv[2];
if (!source || !/^[a-f0-9]{40}$/.test(source)) throw new Error('EXACT_SOURCE_COMMIT_REQUIRED');
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/ticket03/built-assets',
  manifestSha256: '8ed20af25142e25d852deb000c12dcf26beadd802db6576f0790d440132a40e2',
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
    ],
    sessionSocketBytes: Buffer.byteLength(root) + 69,
    knownRisk: 'This exact custom image previously failed readiness with kernel 6.18.60. No asset fallback or expectation downgrade.',
    expected: 'operational first boot followed by confirmed cessation; any failure remains a failure' });
  const sandbox = createSandbox({ root, guestAssets });
  const prepared = await sandbox.prepare({ workId: 'public-lifecycle-qualification-q3', configuration });
  await record('prepare', prepared);
  if (prepared.status !== 'success') { process.exitCode = 1; return; }
  const environment = prepared.environment;
  let settled = false;
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
        if (argv[0] !== '/usr/bin/qemu-system-x86_64') continue;
        if ((await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim() !== `0::${group}` ||
            startTicks(await readFile(`/proc/${pid}/stat`, 'utf8')) !== before) continue;
        await record('vmm-witness', { boot: current.boot, pid: Number(pid), startTicks: before, group, argv });
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
  try {
    await record('start', started);
    await record('before-stop', await sandbox.observe({ environment, boot: started.boot }));
  } finally {
    stopped = await sandbox.stop({ environment, boot: started.boot, reason: 'operator-authorized qualification' });
  }
  await record('stop', stopped);
  const after = await sandbox.observe({ environment, boot: started.boot });
  await record('after-stop', after);
  await record('result', { operationalBoot: started.status === 'success', cessationConfirmed: after.cessationConfirmed,
    accepted: started.status === 'success' && stopped.status === 'success' && after.cessationConfirmed,
    restartAttempted: false, resourcesRemoved: false });
  if (started.status !== 'success' || stopped.status !== 'success' || !after.cessationConfirmed) process.exitCode = 1;
}

await qualify();
