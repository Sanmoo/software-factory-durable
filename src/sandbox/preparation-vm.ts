import type { VM as GondolinVM } from '@earendil-works/gondolin';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { BlockList } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { unitState } from '../platform/host/index.js';
import { configurationSchema } from './configuration.js';
import { inspectGuestAssets } from './guest-assets.js';
import { stopGuestCleanly } from './guest-shutdown.js';
import { loadDevelopmentGondolinSdk } from './gondolin-sdk-runtime.js';
import { bootRuntimePaths, durableJson } from './start.js';
import type { PreparationVm, PreparationVmInput, PreparationVmResult } from './environment-base.js';
import type { BootRef } from './lifecycle.js';

const run = promisify(execFile);
const outputLimit = 256 * 1024;
const requestName = 'vm-request.json';
const resultName = 'vm-result.json';

const requestSchema = z.strictObject({ version: z.literal(1), boot: z.string().regex(/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  unit: z.string().regex(/^factory-environment-preparation-[a-f0-9-]{36}\.service$/), disk: z.string().min(1).max(4096),
  guestAssets: z.strictObject({ directory: z.string().min(1).max(4096), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  configuration: configurationSchema, allowedHosts: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/)).min(1).max(64),
  script: z.string().min(1).max(65536), timeoutSeconds: z.number().int().positive().max(86400) });
const resultSchema = z.strictObject({ version: z.literal(1), boot: z.string(), status: z.enum(['completed', 'failed']), exitCode: z.number().int().nullable(),
  code: z.string().max(96).nullable(), output: z.string().max(outputLimit), guestStop: z.enum(['clean', 'forced']).nullable() });

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('PRIVATE_DIRECTORY_REQUIRED');
}
async function privateJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 2 * outputLimit) throw new Error('UNSAFE_RECORD');
    return schema.parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}

type Runner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<unknown>;

/**
 * Ticket 44 production port: ONE preparation VM per call, supervised like a Work boot (spec §7.3: one systemd main process owns exactly one
 * VM; never the controller process). The request (disk, assets, allowlist, fixed script) is written to the base directory, the adapter
 * entrypoint runs it in a transient `systemd-run --wait` unit bounded by `RuntimeMaxSec`, and cessation is confirmed by the manager (unit no
 * longer active) before the result is read. `runner`/`state` are injectable for tests only.
 */
export function createPreparationVm(options: { root: string; runner?: Runner; state?: (unit: string) => Promise<Record<string, string>> }): PreparationVm {
  const runner: Runner = options.runner ?? ((file, args, runOptions) => run(file, args, runOptions));
  const state = options.state ?? unitState;
  return {
    async active(directory: string): Promise<boolean> {
      let request: z.infer<typeof requestSchema>;
      try { request = await privateJson(join(directory, requestName), requestSchema); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      const observed = await state(request.unit);
      return !['inactive', 'failed', ''].includes(observed.ActiveState ?? '');
    },
    async run(input: PreparationVmInput): Promise<PreparationVmResult> {
      const canonicalRoot = await realpath(options.root);
      const boot = `boot-${randomUUID()}` as BootRef;
      const unit = `factory-environment-preparation-${boot.slice(5)}.service`;
      const runtime = bootRuntimePaths(canonicalRoot, boot);
      const parent = dirname(runtime.directory);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await privateDirectory(parent);
      await mkdir(runtime.directory, { mode: 0o700 });
      for (const path of [runtime.temporary, runtime.cache, runtime.sessions]) await mkdir(path, { mode: 0o700 });
      await durableJson(join(input.directory, requestName), { version: 1, boot, unit, disk: input.disk, guestAssets: input.guestAssets, configuration: input.configuration,
        allowedHosts: input.allowedHosts, script: input.script, timeoutSeconds: input.timeoutSeconds });
      const uid = process.getuid?.();
      let launched = true;
      try {
        await runner('systemd-run', ['--user', `--unit=${unit}`, '--slice=app.slice', '--wait', '--collect', '--quiet',
          '--service-type=exec', '--property=Restart=no', '--property=KillMode=mixed', '--property=SendSIGKILL=yes',
          `--property=RuntimeMaxSec=${input.timeoutSeconds + input.configuration.shutdownGraceSeconds + 60}s`,
          `--property=TimeoutStopSec=${input.configuration.shutdownGraceSeconds}s`, '--property=UMask=0077',
          '--property=StandardOutput=null', '--property=StandardError=null',
          '/usr/bin/env', '-i', `PATH=${dirname(process.execPath)}:/usr/bin:/bin`, 'LANG=C', 'LC_ALL=C',
          `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
          `TMPDIR=${runtime.temporary}`, `XDG_CACHE_HOME=${runtime.cache}`, `GONDOLIN_SESSIONS_DIR=${runtime.sessions}`, 'NODE_DISABLE_COMPILE_CACHE=1',
          process.execPath, fileURLToPath(new URL('../entrypoints/adapter.js', import.meta.url)), 'prepare-environment', canonicalRoot, input.directory],
        { timeout: (input.timeoutSeconds + input.configuration.shutdownGraceSeconds + 120) * 1000, maxBuffer: 65536 });
      } catch { launched = false; /* Nonzero unit result or a lost wait: decided below from the manager and the result record. */ }
      let observed: Record<string, string>;
      try { observed = await state(unit); } catch { return { status: 'failed', code: 'PREPARATION_UNIT_UNOBSERVABLE', detail: unit, cessation: 'unconfirmed' }; }
      if (observed.ActiveState !== undefined && !['inactive', 'failed', ''].includes(observed.ActiveState)) {
        return { status: 'failed', code: 'PREPARATION_UNIT_STILL_ACTIVE', detail: unit, cessation: 'unconfirmed' };
      }
      let result: z.infer<typeof resultSchema>;
      try { result = await privateJson(join(input.directory, resultName), resultSchema); }
      catch { return { status: 'failed', code: launched ? 'PREPARATION_RESULT_MISSING' : 'PREPARATION_UNIT_FAILED', detail: 'the preparation VM left no result record', cessation: 'confirmed' }; }
      if (result.boot !== boot) return { status: 'failed', code: 'PREPARATION_RESULT_UNCORRELATED', detail: '', cessation: 'confirmed' };
      if (result.status === 'failed' || result.exitCode === null) return { status: 'failed', code: result.code ?? 'PREPARATION_VM_FAILED', detail: '', cessation: 'confirmed' };
      // A guest that did not leave its root read-only may have unsynced writes: the host's filesystem check of the disk decides afterwards.
      return { status: 'completed', exitCode: result.exitCode, output: result.output, cessation: 'confirmed' };
    },
  };
}

/**
 * Ticket 44, inside the transient unit only (adapter entrypoint `prepare-environment`): boot the candidate base disk with the release guest
 * assets, HTTP(S) egress restricted to the request's allowlist (plus the built-in private-range guard and the host-interface exclusion of
 * every boot), run the FIXED preparation script once with its deadline, stop the guest cleanly (ticket 47) and close the VM. Never on the host.
 */
export async function runEnvironmentPreparation(root: string, directory: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const bases = join(canonicalRoot, 'environment-bases');
  if (dirname(directory) !== bases || !/^base-[a-f0-9]{64}$/.test(directory.slice(bases.length + 1))) throw new Error('INVALID_PREPARATION_DIRECTORY');
  await privateDirectory(directory);
  const request = await privateJson(join(directory, requestName), requestSchema);
  if (dirname(request.disk) !== directory) throw new Error('INVALID_PREPARATION_DISK');
  const runtime = bootRuntimePaths(canonicalRoot, request.boot as BootRef);
  if (process.env.TMPDIR !== runtime.temporary || process.env.XDG_CACHE_HOME !== runtime.cache || process.env.GONDOLIN_SESSIONS_DIR !== runtime.sessions) {
    throw new Error('PREPARATION_RUNTIME_MISMATCH');
  }
  const state = await unitState(request.unit);
  if (state.MainPID !== String(process.pid)) throw new Error('PREPARATION_SUPERVISION_MISMATCH');
  let vm: GondolinVM | undefined;
  let output = '';
  let exitCode: number | null = null;
  let code: string | null = null;
  let guestStop: 'clean' | 'forced' | null = null;
  try {
    if ((await inspectGuestAssets(request.guestAssets)).some(check => check.status !== 'ok')) throw new Error('GUEST_ASSETS_INVALID');
    const { VM, createHttpHooks } = await loadDevelopmentGondolinSdk();
    const mitmCertDir = join(runtime.directory, 'mitm-ca');
    await mkdir(mitmCertDir, { mode: 0o700 });
    const hostAddresses = new BlockList();
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) hostAddresses.addAddress(address.address, address.family === 'IPv6' ? 'ipv6' : 'ipv4');
    }
    // Ticket 44: ONLY the Alpine mirror and the declared images' registries (explicit list; never the Work boots' general public mediation).
    const { httpHooks } = createHttpHooks({ allowedHosts: request.allowedHosts,
      isIpAllowed: info => !hostAddresses.check(info.ip, info.family === 6 ? 'ipv6' : 'ipv4') });
    vm = await VM.create({ autoStart: true, memory: `${request.configuration.memoryMiB}M`, cpus: request.configuration.vcpus,
      tmpfs: {}, startTimeoutMs: 30000, sessionLabel: request.boot, debugLog: null, httpHooks, dns: { mode: 'synthetic' }, allowWebSockets: false,
      sandbox: { vmm: 'qemu', qemuPath: '/usr/bin/qemu-system-x86_64', accel: 'kvm', cpu: 'host', imagePath: request.guestAssets.directory,
        rootDiskPath: request.disk, rootDiskFormat: 'qcow2', rootDiskReadOnly: false, rootDiskDeleteOnClose: false, netEnabled: true, mitmCertDir,
        autoRestart: false, console: 'none', debug: false, ...runtime.sockets } });
    await vm.start();
    try {
      const executed = await vm.exec(['/bin/sh', '-c', request.script], { signal: AbortSignal.timeout(request.timeoutSeconds * 1000), stdout: 'buffer', stderr: 'buffer' });
      exitCode = executed.exitCode;
      output = `${executed.stdout}${executed.stderr}`.slice(-outputLimit);
    } catch { code = 'PREPARATION_SCRIPT_TIMEOUT_OR_LOST'; }
    guestStop = (await stopGuestCleanly((argv, options) => vm!.exec(argv, options), request.configuration.shutdownGraceSeconds)).result;
  } catch (error) {
    code ??= error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'PREPARATION_VM_FAILED';
  } finally {
    try { await vm?.close(); } catch { code ??= 'PREPARATION_VM_CLOSE_FAILED'; }
  }
  const temporary = join(directory, `${resultName}.${request.boot}`);
  await durableJson(temporary, { version: 1, boot: request.boot, status: code === null && exitCode !== null ? 'completed' : 'failed', exitCode, code, output: output.slice(-48000), guestStop });
  await rename(temporary, join(directory, resultName));
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
