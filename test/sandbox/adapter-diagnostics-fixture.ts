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
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };
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
  if (args[0] === '/proc/self/cgroup') return `0::${group}\n`;
  return originalRead(...args);
}) as typeof originalRead;
syncBuiltinESMExports();

const audit = (event: string) => fs.appendFileSync(join(root, 'audit'), `${event}\n`);
const originalTermListeners = new Set(process.listeners('SIGTERM'));
mock.module('@earendil-works/gondolin', { namedExports: {
  VM: { async create() { return {
    async start() {
      const listeners = process.listeners('SIGTERM').filter(listener => !originalTermListeners.has(listener));
      if (listeners.length !== 1) throw new Error('EXPECTED_ONE_ADAPTER_STOP_LISTENER');
      // Invoke only the newly registered adapter callback; no OS signal or broad emit.
      if (process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE !== 'without-stop') listeners[0]!('SIGTERM');
      throw Object.assign(new Error('PRIVATE_TOKEN_CANARY'), {
        code: process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE === 'unknown-error' ? 'PRIVATE_CODE_CANARY' : 'vm_start_timeout',
      });
    },
    async close() { audit('close'); },
    async exec() { throw new Error('GUEST_EXEC_MUST_NOT_RUN'); },
  }; } },
  RealFSProvider: class {},
} });

const probe = await open(join(root, 'probe'), 'wx', 0o600);
const prototype = Object.getPrototypeOf(probe) as FileHandle;
const originalWrite = prototype.writeFile;
const originalSync = prototype.sync;
await probe.close();
let publishing = false;
mock.method(prototype, 'writeFile', async function(this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
  const target = await readlink(`/proc/self/fd/${this.fd}`);
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
  if (publishing && target === join(path, 'failure.json')) audit('failure-file-synced');
  if (publishing && target === path) audit('failure-durable');
});
