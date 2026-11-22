// Manual real-VM recipe of ticket 55. Not discovered by node --test. No model, GitHub, network or credentials: one guest, no NIC.
// Usage (after `npm run build`; ONE VM on the host, nothing else heavy running; a NEW root):
//   node dist/test/sandbox/disk-stop55-qualification.js <new-root> <adapter|adapter-sigkill|sigkill> <light|heavy>
// It boots the pinned guest on a NEW standalone qcow2 root disk built exactly as a preparation builds one, with the adapter's VM options
// (minus networking), writes known data to the guest root, stops the guest and then checks the qcow2 from the host:
//  - adapter:         the adapter's stop (`stopGuestCleanly` in the guest, then the SDK close of the VMM), as `systemctl stop` does;
//  - adapter-sigkill: the same guest stop, then SIGKILL of qemu instead of its close (hypothesis 1: VMM killed before it flushes qcow2);
//  - sigkill:         positive control, SIGKILL of qemu with a writer running and no guest stop (what a crash leaves).
// `heavy` adds a 1 GiB random file, 5000 small files and a background fsync writer still running when the stop begins.
// Host checks: `checkDiskFilesystem` (the Sandbox's own), then an independent full raw copy, `e2fsck -f -n` (after a journal replay of the
// copy if one is pending) and a read-back with debugfs of the marker, the big file's sha256 and the small-file count.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildRootDisk, checkDiskFilesystem, journalState } from '../../src/sandbox/filesystem.js';
import { stopGuestCleanly } from '../../src/sandbox/guest-shutdown.js';
import { guestStorageReadiness } from '../../src/sandbox/guest-storage.js';
import { loadDevelopmentGondolinSdk } from '../../src/sandbox/gondolin-sdk-runtime.js';
import type { EnvironmentRef } from '../../src/sandbox/prepare.js';
import type { BootRef } from '../../src/sandbox/lifecycle.js';

const run = promisify(execFile);
const tool = { timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } };
const assets = {
  directory: '/home/sanmoo/software-factory-test/assets35/assets',
  manifestSha256: '72e00546beba8e1c8b4b6f9d7a17de635e27fe2de79ffa85688bb2bdeebb5c12',
};
const size = 40n * 1073741824n;
const [root, mode, load] = process.argv.slice(2);
if (
  !root?.startsWith('/home/sanmoo/software-factory-test/fix55-') ||
  !['adapter', 'adapter-sigkill', 'sigkill'].includes(mode ?? '') ||
  !['light', 'heavy'].includes(load ?? '')
)
  throw new Error('USAGE: <new /home/sanmoo/software-factory-test/fix55-* root> <adapter|adapter-sigkill|sigkill> <light|heavy>');

const sha256 = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
const exitOf = async (file: string, args: string[]) => {
  try {
    const out = await run(file, args, tool);
    return { code: 0, stdout: out.stdout };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
  }
};
const debugfs = async (raw: string, request: string) => (await run('/usr/sbin/debugfs', ['-R', request, raw], tool)).stdout;

async function main() {
  const at = (label: string) => console.log(JSON.stringify({ at: new Date().toISOString(), label }));
  await mkdir(root!, { mode: 0o700 });
  const manifestBytes = await readFile(join(assets.directory, 'manifest.json'));
  if (createHash('sha256').update(manifestBytes).digest('hex') !== assets.manifestSha256) throw new Error('GUEST_ASSET_PIN_MISMATCH');
  const manifest = JSON.parse(manifestBytes.toString()) as { assets: { rootfs: string } };
  const environment = `env-${createHash('sha256').update(root!).digest('hex')}` as EnvironmentRef;
  const boot = `boot-${randomUUID()}` as BootRef;
  const runtime = join(root!, 'r');
  for (const name of ['', 't', 'c', 's', 'workspace', 'artifacts']) await mkdir(join(runtime, name), { recursive: true, mode: 0o700 });
  Object.assign(process.env, { TMPDIR: join(runtime, 't'), XDG_CACHE_HOME: join(runtime, 'c'), GONDOLIN_SESSIONS_DIR: join(runtime, 's') });
  const disk = join(root!, 'root.qcow2');
  await buildRootDisk(join(assets.directory, manifest.assets.rootfs), join(root!, 'template.ext4'), disk, size);
  at('disk built');
  const { VM, RealFSProvider } = await loadDevelopmentGondolinSdk();
  const vm = await VM.create({
    autoStart: true,
    memory: '2048M',
    cpus: 2,
    tmpfs: {},
    startTimeoutMs: 60000,
    sessionLabel: boot,
    debugLog: null,
    dns: { mode: 'synthetic' },
    allowWebSockets: false,
    sandbox: {
      vmm: 'qemu',
      qemuPath: '/usr/bin/qemu-system-x86_64',
      accel: 'kvm',
      cpu: 'host',
      imagePath: assets.directory,
      rootDiskPath: disk,
      rootDiskFormat: 'qcow2',
      rootDiskReadOnly: false,
      rootDiskDeleteOnClose: false,
      netEnabled: false,
      autoRestart: false,
      console: 'none',
      debug: false,
      virtioSocketPath: join(runtime, 'v'),
      virtioFsSocketPath: join(runtime, 'f'),
      virtioSshSocketPath: join(runtime, 'h'),
      virtioIngressSocketPath: join(runtime, 'i'),
      netSocketPath: join(runtime, 'n'),
    },
    vfs: { mounts: { '/workspace': new RealFSProvider(join(runtime, 'workspace')), '/artifacts': new RealFSProvider(join(runtime, 'artifacts')) } },
  });
  let closed = false;
  try {
    await vm.start();
    at('vm started');
    const exec = async (script: string) => {
      const result = await vm.exec(['/bin/sh', '-c', script], { signal: AbortSignal.timeout(600000) });
      if (result.exitCode !== 0) throw new Error(`guest exit ${result.exitCode}: ${result.stderr.slice(0, 400)}`);
      return result.stdout;
    };
    await exec(guestStorageReadiness(environment, boot));
    const marker = randomUUID();
    await exec(`set -eu; mkdir -p /fix55/dir; printf '%s' '${marker}' > /fix55/marker; sync`);
    let bigSha: string | undefined;
    if (load === 'heavy') {
      bigSha = (
        await exec(
          'set -eu; dd if=/dev/urandom of=/fix55/big bs=1M count=1024 2>/dev/null; mkdir -p /fix55/small; ' +
            'i=0; while [ $i -lt 5000 ]; do printf "%s" "$i" > /fix55/small/f$i; i=$((i+1)); done; sha256sum /fix55/big',
        )
      ).split(' ')[0];
      await exec('setsid sh -c "while :; do dd if=/dev/zero of=/fix55/bg bs=1M count=64 conv=fsync 2>/dev/null; done" > /dev/null 2>&1 < /dev/null &');
    } else if (mode === 'sigkill') {
      await exec('setsid sh -c "while :; do dd if=/dev/zero of=/fix55/bg bs=1M count=64 2>/dev/null; done" > /dev/null 2>&1 < /dev/null &');
    }
    at('data written');
    const pid = vm.getHostPid();
    if (!pid) throw new Error('VMM_IDENTITY_UNAVAILABLE');
    let stop: unknown = 'none';
    if (mode !== 'sigkill') {
      stop = await stopGuestCleanly((argv, options) => vm.exec(argv, options), 30);
      at(`guest stop ${JSON.stringify(stop)}`);
    }
    if (mode === 'adapter') await vm.close();
    else {
      process.kill(pid, 'SIGKILL');
      await vm.close();
    }
    closed = true;
    at('vmm ended');
    const check = await checkDiskFilesystem(root!, disk, size);
    at(`checkDiskFilesystem ${JSON.stringify(check)}`);
    const raw = join(root!, 'independent.raw');
    await run('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', disk, raw], tool);
    const journal = await journalState(raw);
    const replay = journal.needsRecovery ? (await exitOf('/usr/bin/e2fsck', ['-E', 'journal_only', '-p', raw])).code : null;
    const fsck = await exitOf('/usr/bin/e2fsck', ['-f', '-n', raw]);
    const readBack = fsck.code === 0 ? (await debugfs(raw, 'cat /fix55/marker')).trim() : null;
    let bigReadBack: string | null = null;
    let smallFiles: number | null = null;
    if (load === 'heavy' && fsck.code === 0) {
      const dumped = join(root!, 'big.dump');
      await debugfs(raw, `dump /fix55/big ${dumped}`);
      bigReadBack = await sha256(dumped);
      await rm(dumped);
      smallFiles = (await debugfs(raw, 'ls -p /fix55/small')).split('\n').filter(line => /\/f\d+\//.test(line)).length;
    }
    const result = {
      mode,
      load,
      stop,
      check,
      journalPendingAfterStop: journal.needsRecovery,
      replayExit: replay,
      e2fsckExit: fsck.code,
      e2fsckFindings:
        fsck.code === 0
          ? []
          : fsck.stdout
              .split('\n')
              .filter(line => /\?|count|checksum|unused/i.test(line))
              .slice(0, 12),
      markerReadBack: readBack === marker,
      bigSha256ReadBack: load === 'heavy' ? bigReadBack === bigSha : null,
      smallFiles,
    };
    const pass =
      mode === 'sigkill' || (check.ok && fsck.code === 0 && result.markerReadBack && (load !== 'heavy' || (result.bigSha256ReadBack && smallFiles === 5000)));
    const file = await open(join(root!, 'result.json'), 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ ...result, pass }, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rm(raw);
    console.log(JSON.stringify({ ...result, pass }));
    if (!pass) process.exitCode = 1;
  } finally {
    if (!closed) await vm.close();
    await writeFile(join(root!, 'ended'), new Date().toISOString());
  }
}

await main();
