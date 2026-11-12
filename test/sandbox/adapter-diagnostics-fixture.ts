// Preload for a local entrypoint test. Every SDK export is doubled, and the
// process-spawn boundary additionally forbids any real SDK VMM as a fail-safe.
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, open, readFile, readlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

const [root, environment, boot] = process.argv.slice(2);
if (!root || !environment || !boot) throw new Error('FIXTURE_ARGUMENTS_REQUIRED');
const path = join(root, 'environments', environment, boot);
const directory = join(root, 'environments', environment);
const unit = `factory-sandbox-${boot}.service`;
const uid = process.getuid?.();
const group = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', shutdownGraceSeconds: 1 };
const workId = 'producer-ordering-work';
if (environment !== `env-${createHash('sha256').update(workId).digest('hex')}`) throw new Error('FIXTURE_IDENTITY_MISMATCH');
const json = (name: string, value: unknown) => writeFile(name, JSON.stringify(value), { mode: 0o600 });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const assets = join(root, 'assets');
await mkdir(assets, { mode: 0o700 });
for (const name of ['kernel', 'initramfs', 'rootfs']) await writeFile(join(assets, name), name, { mode: 0o600 });
const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' },
  assets: { kernel: 'kernel', initramfs: 'initramfs', rootfs: 'rootfs' },
  checksums: { kernel: sha('kernel'), initramfs: sha('initramfs'), rootfs: sha('rootfs') } });
await writeFile(join(assets, 'manifest.json'), manifest, { mode: 0o600 });
await mkdir(path, { recursive: true, mode: 0o700 });
await json(join(directory, 'owner.json'), { version: 1, workId, environment, configuration,
  guestAssets: { directory: assets, manifestSha256: sha(manifest) } });
await json(join(directory, 'ready.json'), { environment });
await json(join(path, 'identity.json'), { version: 1, environment, boot, unit, configuration,
  hostBoot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() });
const tag = Buffer.from(boot.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
const runtime = join(root, 'r', tag);
await mkdir(runtime, { recursive: true, mode: 0o700 });
for (const name of ['t', 'c', 's']) await mkdir(join(runtime, name), { mode: 0o700 });
await json(join(runtime, 'owner.json'), { version: 1, environment, boot });
process.env.TMPDIR = join(runtime, 't');
process.env.XDG_CACHE_HOME = join(runtime, 'c');
process.env.GONDOLIN_SESSIONS_DIR = join(runtime, 's');
const bin = join(root, 'bin');
await mkdir(bin, { mode: 0o700 });
await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== '--user' || args[1] !== 'show' || args[2] !== ${JSON.stringify(unit)} || args.length !== 4) process.exit(77);
process.stdout.write('LoadState=loaded\\nActiveState=active\\nInvocationID=${'a'.repeat(32)}\\nControlGroup=${group}\\nMainPID=' + process.ppid + '\\nResult=success\\n');
`, { mode: 0o700 });
process.env.PATH = bin; // No real manager fallback.
cp.spawn = () => { throw new Error('REAL_PROCESS_SPAWN_FORBIDDEN_IN_FIXTURE'); };
const originalRead = fs.promises.readFile;
fs.promises.readFile = (async (...args: Parameters<typeof originalRead>) => {
  if (args[0] === '/proc/self/cgroup' || args[0] === `/proc/${process.pid}/cgroup`) return `0::${group}\n`;
  return originalRead(...args);
}) as typeof originalRead;
syncBuiltinESMExports();

const audit = (event: string) => fs.appendFileSync(join(root, 'audit'), `${event}\n`);
const originalTermListeners = new Set(process.listeners('SIGTERM'));
type Logger = ((component: string, message: string) => void) | null;
let logger: Logger = null;
let lateLogger: Logger = null;
let execCalls = 0;
const mode = process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE;
mock.module('@earendil-works/gondolin', { namedExports: {
  VM: { async create(options: { debugLog: Logger; sandbox: { console: string; debug: readonly string[] | boolean } }) {
    logger = options.debugLog;
    lateLogger = logger;
    if (options.sandbox.console !== 'none' || options.sandbox.debug !== false || options.debugLog !== null) {
      throw new Error('PRODUCTION_CONSOLE_MUST_BE_DISABLED');
    }
    return {
    setDebugLog(next: Logger) { logger = next; },
    async start() {
      logger?.('protocol', 'PRIVATE_TOKEN_CANARY');
      logger?.('qemu', 'stdout: [    0.000000] Linux version PRIVATE_TOKEN_CANARY');
      logger?.('qemu', 'stdout: [init] /dev entries:');
      if (mode === 'markers-success' || mode?.startsWith('shutdown-')) return;
      const listeners = process.listeners('SIGTERM').filter(listener => !originalTermListeners.has(listener));
      if (listeners.length !== 1) throw new Error('EXPECTED_ONE_ADAPTER_STOP_LISTENER');
      // Invoke only the newly registered adapter callback; no OS signal or broad emit.
      if (process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE !== 'without-stop') listeners[0]!('SIGTERM');
      throw Object.assign(new Error('PRIVATE_TOKEN_CANARY'), {
        code: process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE === 'unknown-error' ? 'PRIVATE_CODE_CANARY' : 'vm_start_timeout',
      });
    },
    async close() { audit('close'); },
    id: '77777777-2222-4333-8444-555555555555',
    getHostPid() { return process.pid; }, // External VM double, never a real VMM.
    async exec(argv: string[], options: { signal: AbortSignal; stdout?: string; stderr?: string }) {
      if (options.stdout !== 'ignore' || options.stderr !== 'ignore') throw new Error('UNUSED_GUEST_OUTPUT_MUST_BE_IGNORED');
      if (mode?.startsWith('shutdown-')) {
        if (++execCalls === 1) { audit('profile-ready'); return { exitCode: 0 }; }
        audit('guest-finalize');
        if (options.stdout !== 'ignore' || options.stderr !== 'ignore') throw new Error('FINALIZATION_OUTPUT_MUST_BE_IGNORED');
        if (mode === 'shutdown-nonzero') { audit('guest-nonzero'); return { exitCode: 1 }; }
        if (mode === 'shutdown-exec-fails') { audit('guest-exec-failed'); throw new Error('PRIVATE_TOKEN_CANARY'); }
        if (mode === 'shutdown-timeout') {
          if (options.signal.aborted) throw new Error('FINALIZATION_SIGNAL_ALREADY_ABORTED');
          // Keep only this new test child alive: AbortSignal timers are unref'ed.
          await new Promise<never>((_resolve, reject) => {
            const pending = setInterval(() => {}, 100);
            options.signal.addEventListener('abort', () => {
              clearInterval(pending); audit('guest-timeout'); reject(options.signal.reason);
            }, { once: true });
          });
        }
        fs.writeFileSync(join(root, 'guest-finalization-command'), argv[2]!);
        // Frozen Alpine guest has dockerd directly, not OpenRC/rc-service.
        if (argv[2]!.includes('rc-service')) { audit('guest-command-missing'); return { exitCode: 127 }; }
        audit('guest-finalize-ok');
        return { exitCode: 0 };
      }
      if (mode !== 'markers-success') throw new Error('GUEST_EXEC_MUST_NOT_RUN');
      if (++execCalls === 1) {
        audit('guest-exec');
        lateLogger?.('qemu', 'stdout: [init] starting sandboxd');
        const listeners = process.listeners('SIGTERM').filter(listener => !originalTermListeners.has(listener));
        if (listeners.length !== 1) throw new Error('EXPECTED_ONE_ADAPTER_STOP_LISTENER');
        listeners[0]!('SIGTERM'); // Only the new callback, never an OS signal.
      }
      return { exitCode: 0 };
    },
  }; } },
  RealFSProvider: class {},
} });

const probe = await open(join(root, 'probe'), 'wx', 0o600);
const prototype = Object.getPrototypeOf(probe) as FileHandle;
const originalWrite = prototype.writeFile;
const originalSync = prototype.sync;
await probe.close();
let publishing = false;
let markerPublishing = false;
let operationalPublishing = false;
let syncedPublishing = false;
mock.method(prototype, 'writeFile', async function(this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
  const target = await readlink(`/proc/self/fd/${this.fd}`);
  if (mode?.startsWith('shutdown-') && target === join(path, 'operational.json')) operationalPublishing = true;
  if (mode?.startsWith('shutdown-') && target === join(path, 'guest-synced.json')) {
    syncedPublishing = true;
    audit('synced-begin');
    await new Promise<void>(resolve => { setImmediate(resolve); });
    if (mode === 'shutdown-write-fails') { syncedPublishing = false; audit('synced-failed'); throw new Error('INJECTED_SYNCED_WRITE_FAILURE'); }
  }
  if (target === join(path, 'boot-markers.json') && mode?.startsWith('markers-')) {
    markerPublishing = true;
    audit('markers-begin');
    await new Promise<void>(resolve => { setImmediate(resolve); });
    if (mode === 'markers-write-fails') { audit('markers-failed'); throw new Error('INJECTED_MARKER_WRITE_FAILURE'); }
    await originalWrite.apply(this, args);
    audit('markers-written');
    return;
  }
  if (target !== join(path, 'failure.json')) return originalWrite.apply(this, args);
  publishing = true;
  audit('failure-begin');
  await new Promise<void>(resolve => { setImmediate(resolve); });
  if (process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE === 'write-fails') {
    audit('failure-failed');
    throw new Error('INJECTED_DIAGNOSTIC_WRITE_FAILURE');
  }
  await originalWrite.apply(this, args);
  audit('failure-written');
});
mock.method(prototype, 'sync', async function(this: FileHandle) {
  const target = await readlink(`/proc/self/fd/${this.fd}`);
  await originalSync.call(this);
  if (operationalPublishing && target === path) {
    operationalPublishing = false;
    setImmediate(() => {
      const listeners = process.listeners('SIGTERM').filter(listener => !originalTermListeners.has(listener));
      if (listeners.length !== 1) throw new Error('EXPECTED_ONE_ADAPTER_STOP_LISTENER');
      audit('stop-request');
      listeners[0]!('SIGTERM'); // Only this new callback, no OS signal.
      if (mode === 'shutdown-concurrent') listeners[0]!('SIGTERM');
    });
  }
  if (syncedPublishing && target === path) { audit('synced-durable'); syncedPublishing = false; }
  if (mode?.startsWith('markers-') && target === join(path, 'boot-markers.json')) audit('markers-file-synced');
  if (markerPublishing && !publishing && target === path) { audit('markers-durable'); markerPublishing = false; }
  if (publishing && target === join(path, 'failure.json')) audit('failure-file-synced');
  if (publishing && target === path) audit('failure-durable');
});
